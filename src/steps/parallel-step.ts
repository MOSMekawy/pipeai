import type { UIMessageStreamWriter } from "ai";
import type { MaybePromise } from "../utils";
import type { Agent } from "../agent";
import type { RuntimeState, WorkflowObservability, AgentStepHooks, ParallelTarget } from "../workflow";
import { SealedWorkflow, Workflow, fireHook, hasItemHooks } from "../workflow";
import { Step } from "./step";
import { AgentStep } from "./agent-step";
import { Semaphore } from "./semaphore";
import { reconcileUnits, type UnitFailure } from "./concurrent";

/* eslint-disable @typescript-eslint/no-explicit-any */
type ParallelBranches = Record<string, ParallelTarget<any, any>> | ReadonlyArray<ParallelTarget<any, any>>;
type ParallelOpts = {
  id?: string;
  concurrency?: number;
  onError?: (params: { error: unknown; key?: string; index?: number; ctx: any }) => unknown | Promise<unknown>;
  handleStream?: (params: { result: any; writer: UIMessageStreamWriter; ctx: any; input: any; itemIndex: number | string }) => MaybePromise<void>;
};
type Entry = { key: string | number; index: number; target: ParallelTarget<any, any> };

/**
 * Parallel step — `Workflow.parallel(branches, options?)`.
 *
 * Feeds the same input to every branch (record or tuple form) with a worker-pool
 * dispatch (default concurrency: unbounded). The dispatch loop is inlined here
 * over a {@link Semaphore}; the post-settle warning-merge + abort precedence is
 * shared with `foreach` via {@link reconcileUnits}. Per-branch observability and
 * `onError` recovery (`Workflow.SKIP` leaves the slot `undefined`) are handled
 * inline. Self-contained: any thrown error is parked on `state.pendingError`.
 */
export class ParallelStep extends Step {
  readonly type = "step" as const;
  readonly category = "parallel" as const;
  readonly id: string;

  private readonly entries: Entry[];
  private readonly isTuple: boolean;
  private readonly branchCount: number;
  private readonly concurrency: number;
  private readonly onError?: ParallelOpts["onError"];
  private readonly handleStream?: ParallelOpts["handleStream"];
  private readonly observability?: WorkflowObservability;

  constructor(branches: ParallelBranches, options: ParallelOpts | undefined, observability: WorkflowObservability | undefined) {
    super();
    this.isTuple = Array.isArray(branches);
    this.entries = this.isTuple
      ? (branches as ReadonlyArray<ParallelTarget<any, any>>).map((target, i) => ({ key: i, index: i, target }))
      : Object.entries(branches as Record<string, ParallelTarget<any, any>>).map(([k, t], i) => ({ key: k, index: i, target: t }));
    this.branchCount = this.entries.length;

    const requestedConcurrency = options?.concurrency;
    if (
      requestedConcurrency !== undefined &&
      !((Number.isInteger(requestedConcurrency) && requestedConcurrency >= 1) || requestedConcurrency === Infinity)
    ) {
      throw new Error(`parallel: concurrency must be a positive integer or Infinity, got ${requestedConcurrency}`);
    }
    // Default: unbounded (full fan-out, clamped only by branch count).
    this.concurrency = requestedConcurrency ?? Infinity;
    this.onError = options?.onError;
    this.handleStream = options?.handleStream;
    this.observability = observability;
    this.id = options?.id ?? (this.isTuple ? "parallel:tuple" : "parallel:record");
  }

  override async execute(state: RuntimeState): Promise<void> {
    if (this.shouldSkip(state)) return;
    try {
      const input = state.output;
      const results: Record<string | number, unknown> = (this.isTuple ? new Array(this.branchCount) : {}) as Record<string | number, unknown>;
      const branchStates: (RuntimeState | undefined)[] = new Array(this.branchCount);
      const wantItemHooks = hasItemHooks(this.observability);

      const executeBranch = async ({ key, index, target }: Entry) => {
        const isWorkflowBranch = target instanceof SealedWorkflow;
        // Agent branches inherit stream mode + writer only when handleStream is
        // supplied (else generate); workflow branches always inherit.
        const inheritStreaming = isWorkflowBranch || this.handleStream !== undefined;
        const branchState: RuntimeState = {
          ctx: state.ctx,
          output: input,
          mode: inheritStreaming ? state.mode : "generate",
          writer: inheritStreaming ? state.writer : undefined,
          abortSignal: state.abortSignal,
        };
        branchStates[index] = branchState;
        const branchStart = wantItemHooks ? performance.now() : 0;
        // itemIndex is the key for record form, numeric index for tuple form.
        const itemIndex: string | number = this.isTuple ? index : (key as string);
        if (wantItemHooks) {
          await fireHook(this.observability, state, "onItemStart", {
            stepId: this.id, type: "parallel", itemIndex, ctx: state.ctx, input,
          });
        }
        try {
          if (isWorkflowBranch) {
            await (target as SealedWorkflow<any, any, any, any>).executeAsNested(branchState);
          } else {
            await AgentStep.runAgent(
              branchState,
              target as Agent<any, any, any>,
              state.ctx,
              this.handleStream ? ({ handleStream: this.handleStream } as AgentStepHooks<any, any, any>) : undefined,
              itemIndex,
            );
          }
          results[key] = branchState.output;
          if (wantItemHooks) {
            await fireHook(this.observability, state, "onItemFinish", {
              stepId: this.id, type: "parallel", itemIndex, ctx: state.ctx, output: branchState.output,
              durationMs: performance.now() - branchStart,
            });
          }
        } catch (error) {
          if (wantItemHooks) {
            await fireHook(this.observability, state, "onItemError", {
              stepId: this.id, type: "parallel", itemIndex, ctx: state.ctx, error,
              durationMs: performance.now() - branchStart,
            });
          }
          throw error;
        }
      };

      // Bounded dispatch: a Semaphore gates the loop, acquiring a permit BEFORE
      // launching each branch so only K are ever in flight (`Infinity` → full
      // fan-out). Units self-evict from `inflight` on settle, so the set retains
      // O(K) promises, not O(N). Per-branch key is the record key / tuple index.
      const keyAt = (i: number) => this.entries[i].key;
      const sem = new Semaphore(this.concurrency);
      const failures: UnitFailure[] = [];
      const inflight = new Set<Promise<void>>();
      for (let i = 0; i < this.branchCount; i++) {
        if (state.abortSignal?.aborted) break;
        await sem.acquire();
        if (state.abortSignal?.aborted) { sem.release(); break; }
        const index = i;
        const unit = (async () => {
          try { await executeBranch(this.entries[index]); }
          catch (error) { failures.push({ key: keyAt(index), index, error }); }
          finally { sem.release(); }
        })();
        inflight.add(unit);
        void unit.finally(() => inflight.delete(unit));
      }

      await Promise.all(inflight);
      failures.sort((a, b) => a.index - b.index);

      // Reconcile (warning-merge + abort + nested-gate). Throws on abort /
      // nested gate — caught by the outer try below.
      const nonGateFailures = reconcileUnits(state, this.id, failures, this.branchCount, keyAt, branchStates, state.abortSignal);

      // No suspension — handle non-gate failures via onError or rethrow.
      for (const { key, index, error } of nonGateFailures) {
        if (!this.onError) throw error;
        const recovered = await this.onError({
          error,
          key: this.isTuple ? undefined : (key as string),
          index: this.isTuple ? index : undefined,
          ctx: state.ctx,
        });
        if (recovered === Workflow.SKIP) {
          // Both forms: the slot stays `undefined` in place (no index shift).
          results[key] = undefined;
        } else {
          results[key] = recovered;
        }
      }

      state.output = results;
    } catch (error) {
      state.pendingError = { error, stepId: this.id, source: this.errorSource };
    }
  }
}
