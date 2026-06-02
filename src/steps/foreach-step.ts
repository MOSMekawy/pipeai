import type { UIMessageStreamWriter } from "ai";
import type { MaybePromise } from "../utils";
import type { Agent } from "../agent";
import type { RuntimeState, WorkflowObservability, AgentStepHooks } from "../workflow";
import { SealedWorkflow, Workflow, fireHook, hasItemHooks } from "../workflow";
import { Step } from "./step";
import { AgentStep } from "./agent-step";
import { Semaphore } from "./semaphore";
import { reconcileUnits, type UnitFailure } from "./concurrent";

/* eslint-disable @typescript-eslint/no-explicit-any */
type ForeachTarget = Agent<any, any, any> | SealedWorkflow<any, any, any, any>;
type ForeachOptions = {
  id?: string;
  concurrency?: number;
  onError?: (params: { error: unknown; item: any; index: number; ctx: any }) => MaybePromise<any>;
  handleStream?: (params: { result: any; writer: UIMessageStreamWriter; ctx: any; input: any; itemIndex: number }) => MaybePromise<void>;
};

/**
 * Foreach step — `Workflow.foreach(target, options?)`.
 *
 * Maps each item of the array input through an agent or sub-workflow, with a
 * worker-pool dispatch (default concurrency: unbounded). The dispatch loop is
 * inlined here over a {@link Semaphore}; the post-settle warning-merge + abort
 * precedence is shared with `parallel` via {@link reconcileUnits}. Per-item
 * observability, `onError` recovery (`Workflow.SKIP` to omit), and abort are
 * handled inline. Captures its observability at construction so per-item events
 * fire on the owning workflow's hooks. Self-contained: any thrown error is
 * parked on `state.pendingError`.
 */
export class ForeachStep extends Step {
  readonly type = "step" as const;
  readonly category = "foreach" as const;
  readonly id: string;
  readonly nestedWorkflow?: SealedWorkflow<any, any, any, any>;

  private readonly target: ForeachTarget;
  private readonly concurrency: number;
  private readonly onError?: ForeachOptions["onError"];
  private readonly handleStream?: ForeachOptions["handleStream"];
  private readonly isWorkflow: boolean;
  private readonly inheritStreaming: boolean;
  private readonly observability?: WorkflowObservability;

  constructor(target: ForeachTarget, options: ForeachOptions | undefined, observability: WorkflowObservability | undefined) {
    super();
    // Validate up front: a positive integer or `Infinity` (full fan-out,
    // clamped by item count). Rejects NaN / 0 / negatives and fractional values.
    if (
      options?.concurrency !== undefined &&
      !((Number.isInteger(options.concurrency) && options.concurrency >= 1) || options.concurrency === Infinity)
    ) {
      throw new Error(`foreach: concurrency must be a positive integer or Infinity, got ${options.concurrency}`);
    }
    this.target = target;
    this.concurrency = options?.concurrency ?? Infinity;
    this.onError = options?.onError;
    this.handleStream = options?.handleStream;
    this.observability = observability;
    this.isWorkflow = target instanceof SealedWorkflow;
    // Agent items inherit the parent's stream mode + writer ONLY when a
    // handleStream is supplied (else generate — foreach never auto-merges N
    // streams). Workflow items always inherit, streaming transitively.
    this.inheritStreaming = this.isWorkflow || this.handleStream !== undefined;
    const defaultId = this.isWorkflow
      ? ((target as SealedWorkflow<any, any, any, any>).id ?? "foreach")
      : `foreach:${(target as Agent<any, any, any>).id}`;
    this.id = options?.id ?? defaultId;
    this.nestedWorkflow = this.isWorkflow ? (target as SealedWorkflow<any, any, any, any>) : undefined;
  }

  override async execute(state: RuntimeState): Promise<void> {
    if (this.shouldSkip(state)) return;
    try {
      const items = state.output;
      if (!Array.isArray(items)) {
        throw new Error(`foreach "${this.id}": expected array input, got ${typeof items}`);
      }

      const results: unknown[] = new Array(items.length);
      const skipped = new Set<number>();
      const itemStates: (RuntimeState | undefined)[] = new Array(items.length);
      const wantItemHooks = hasItemHooks(this.observability);

      const executeItem = async (item: unknown, index: number) => {
        // itemState omits runOptions — per-run config never crosses the foreach
        // boundary; abortSignal IS propagated (cancellation is transitive).
        const itemState: RuntimeState = {
          ctx: state.ctx,
          output: item,
          mode: this.inheritStreaming ? state.mode : "generate",
          writer: this.inheritStreaming ? state.writer : undefined,
          abortSignal: state.abortSignal,
        };
        itemStates[index] = itemState;
        const itemStart = wantItemHooks ? performance.now() : 0;
        if (wantItemHooks) {
          await fireHook(this.observability, state, "onItemStart", {
            stepId: this.id, type: "foreach", itemIndex: index, ctx: state.ctx, input: item,
          });
        }
        try {
          if (this.isWorkflow) {
            await (this.target as SealedWorkflow<any, any, any, any>).executeAsNested(itemState);
          } else {
            await AgentStep.runAgent(
              itemState,
              this.target as Agent<any, any, any>,
              state.ctx,
              this.handleStream ? ({ handleStream: this.handleStream } as AgentStepHooks<any, any, any>) : undefined,
              index,
            );
          }
          results[index] = itemState.output;
          if (wantItemHooks) {
            await fireHook(this.observability, state, "onItemFinish", {
              stepId: this.id, type: "foreach", itemIndex: index, ctx: state.ctx, output: itemState.output,
              durationMs: performance.now() - itemStart,
            });
          }
        } catch (error) {
          if (wantItemHooks) {
            await fireHook(this.observability, state, "onItemError", {
              stepId: this.id, type: "foreach", itemIndex: index, ctx: state.ctx, error,
              durationMs: performance.now() - itemStart,
            });
          }
          throw error;
        }
      };

      // Bounded dispatch: a Semaphore gates the loop, acquiring a permit BEFORE
      // launching each item so only K are ever in flight (`Infinity` → full
      // fan-out). Units self-evict from `inflight` on settle, so the set retains
      // O(K) promises, not O(N). foreach's per-item key IS its index.
      const sem = new Semaphore(this.concurrency);
      const failures: UnitFailure[] = [];
      const inflight = new Set<Promise<void>>();
      for (let i = 0; i < items.length; i++) {
        if (state.abortSignal?.aborted) break;
        await sem.acquire();
        if (state.abortSignal?.aborted) { sem.release(); break; }
        const index = i;
        const unit = (async () => {
          try { await executeItem(items[index], index); }
          catch (error) { failures.push({ key: index, index, error }); }
          finally { sem.release(); }
        })();
        inflight.add(unit);
        void unit.finally(() => inflight.delete(unit));
      }
      await Promise.all(inflight);
      failures.sort((a, b) => a.index - b.index);

      // Reconcile (warning-merge + abort + nested-gate). Throws on abort /
      // nested gate — caught by the outer try below.
      const nonGateFailures = reconcileUnits(state, this.id, failures, items.length, (i) => i, itemStates, state.abortSignal);

      // No suspension — run onError per existing semantics in index order.
      for (const { index, error } of nonGateFailures) {
        if (!this.onError) throw error;
        const recovered = await this.onError({ error, item: items[index], index, ctx: state.ctx });
        if (recovered === Workflow.SKIP) {
          skipped.add(index);
        } else {
          results[index] = recovered;
        }
      }

      state.output = skipped.size === 0
        ? results
        : results.filter((_, i) => !skipped.has(i));
    } catch (error) {
      state.pendingError = { error, stepId: this.id, source: this.errorSource };
    }
  }
}
