import type { UIMessageStreamWriter } from "ai";
import { SKIP, type MaybePromise } from "../utils";
import type { RuntimeState } from "../runtime";
import type { ParallelTarget, WorkflowObservability } from "../types";
import { SealedWorkflow } from "../workflow";
import { Step } from "./step";
import { dispatchUnits, validateConcurrency } from "./concurrent";

/* eslint-disable @typescript-eslint/no-explicit-any */
type ParallelBranches = Record<string, ParallelTarget<any, any>> | ReadonlyArray<ParallelTarget<any, any>>;
type ParallelOpts = {
  id?: string;
  concurrency?: number;
  onError?: (params: { error: unknown; key?: string; index?: number; ctx: any }) => unknown | Promise<unknown>;
  handleStream?: (params: { result: any; writer: UIMessageStreamWriter; ctx: any; input: any; itemIndex: number | string }) => MaybePromise<void>;
};
type Entry = { key: string | number; index: number; target: ParallelTarget<any, any>; isWorkflow: boolean };

/**
 * Parallel step — `Workflow.parallel(branches, options?)`.
 *
 * Feeds the same input to every branch (record or tuple form) via the shared
 * worker-pool dispatch ({@link dispatchUnits} — default concurrency:
 * unbounded), which also handles per-branch observability and the post-settle
 * warning-merge + abort precedence. This step owns only what is
 * parallel-shaped: the record/tuple entry mapping, `onError` recovery
 * (`Workflow.SKIP` leaves the slot `undefined`), and result assembly.
 * Self-contained: any thrown error is parked on `state.pendingError`.
 */
export class ParallelStep extends Step {
  readonly type = "step" as const;
  override readonly category = "parallel" as const;
  readonly id: string;

  private readonly entries: Entry[];
  private readonly isTuple: boolean;
  private readonly concurrency: number;
  private readonly onError?: ParallelOpts["onError"];
  private readonly handleStream?: ParallelOpts["handleStream"];
  private readonly observability?: WorkflowObservability;

  constructor(branches: ParallelBranches, options: ParallelOpts | undefined, observability: WorkflowObservability | undefined) {
    super();
    this.isTuple = Array.isArray(branches);
    // The unit key is the record key / tuple index — it identifies the branch
    // in hook `itemIndex`, warning namespaces, and the result slot.
    this.entries = this.isTuple
      ? (branches as ReadonlyArray<ParallelTarget<any, any>>).map((target, i) => ({ key: i, index: i, target, isWorkflow: target instanceof SealedWorkflow }))
      : Object.entries(branches as Record<string, ParallelTarget<any, any>>).map(([k, t], i) => ({ key: k, index: i, target: t, isWorkflow: t instanceof SealedWorkflow }));
    this.concurrency = validateConcurrency("parallel", options?.concurrency);
    this.onError = options?.onError;
    this.handleStream = options?.handleStream;
    this.observability = observability;
    this.id = options?.id ?? (this.isTuple ? "parallel:tuple" : "parallel:record");
  }

  override async execute(state: RuntimeState): Promise<void> {
    try {
      const input = state.output;
      const results: Record<string | number, unknown> = (this.isTuple ? new Array(this.entries.length) : {}) as Record<string | number, unknown>;

      // Throws on abort — caught below.
      const failures = await dispatchUnits({
        state,
        stepId: this.id,
        kind: "parallel",
        units: this.entries.map((e) => ({ key: e.key, input, target: e.target, isWorkflow: e.isWorkflow })),
        concurrency: this.concurrency,
        observability: this.observability,
        handleStream: this.handleStream,
        onUnitSuccess: (index, output) => { results[this.entries[index].key] = output; },
      });

      // No suspension — handle non-gate failures via onError or rethrow.
      for (const { key, index, error } of failures) {
        if (!this.onError) throw error;
        const recovered = await this.onError({
          error,
          key: this.isTuple ? undefined : (key as string),
          index: this.isTuple ? index : undefined,
          ctx: state.ctx,
        });
        // SKIP: both forms leave the slot `undefined` in place (no index shift).
        results[key] = recovered === SKIP ? undefined : recovered;
      }

      state.output = results;
    } catch (error) {
      state.pendingError = { error, stepId: this.id, source: this.errorSource };
    }
  }
}
