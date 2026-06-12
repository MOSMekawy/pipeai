import type { UIMessageStreamWriter } from "ai";
import { SKIP, type MaybePromise } from "../utils";
import type { Agent } from "../agent";
import type { RuntimeState } from "../runtime";
import type { WorkflowObservability } from "../types";
import { SealedWorkflow } from "../workflow";
import { Step } from "./step";
import { dispatchUnits, validateConcurrency } from "./concurrent";

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
 * Maps each item of the array input through an agent or sub-workflow via the
 * shared worker-pool dispatch ({@link dispatchUnits} — default concurrency:
 * unbounded), which also handles per-item observability and the post-settle
 * warning-merge + abort precedence. This step owns only what is foreach-shaped:
 * array validation, `onError` recovery (`Workflow.SKIP` omits the item,
 * shortening the output array), and result assembly. Captures its observability
 * at construction so per-item events fire on the owning workflow's hooks.
 * Self-contained: any thrown error is parked on `state.pendingError`.
 */
export class ForeachStep extends Step {
  readonly type = "step" as const;
  override readonly category = "foreach" as const;
  override readonly nestedWorkflow?: SealedWorkflow<any, any, any, any>;
  readonly id: string;

  private readonly target: ForeachTarget;
  private readonly concurrency: number;
  private readonly onError?: ForeachOptions["onError"];
  private readonly handleStream?: ForeachOptions["handleStream"];
  private readonly isWorkflow: boolean;
  private readonly observability?: WorkflowObservability;

  constructor(target: ForeachTarget, options: ForeachOptions | undefined, observability: WorkflowObservability | undefined) {
    super();
    this.target = target;
    this.concurrency = validateConcurrency("foreach", options?.concurrency);
    this.onError = options?.onError;
    this.handleStream = options?.handleStream;
    this.observability = observability;
    this.isWorkflow = target instanceof SealedWorkflow;
    const defaultId = this.isWorkflow
      ? ((target as SealedWorkflow<any, any, any, any>).id ?? "foreach")
      : `foreach:${(target as Agent<any, any, any>).id}`;
    this.id = options?.id ?? defaultId;
    this.nestedWorkflow = this.isWorkflow ? (target as SealedWorkflow<any, any, any, any>) : undefined;
  }

  override async execute(state: RuntimeState): Promise<void> {
    try {
      const items = state.output;
      if (!Array.isArray(items)) {
        throw new Error(`foreach "${this.id}": expected array input, got ${typeof items}`);
      }

      const results: unknown[] = new Array(items.length);
      // foreach's per-unit key IS its index. Throws on abort — caught below.
      const failures = await dispatchUnits({
        state,
        stepId: this.id,
        kind: "foreach",
        units: items.map((item, i) => ({ key: i, input: item, target: this.target, isWorkflow: this.isWorkflow })),
        concurrency: this.concurrency,
        observability: this.observability,
        handleStream: this.handleStream,
        onUnitSuccess: (index, output) => { results[index] = output; },
      });

      // No suspension — run onError per existing semantics in index order.
      const skipped = new Set<number>();
      for (const { index, error } of failures) {
        if (!this.onError) throw error;
        const recovered = await this.onError({ error, item: items[index], index, ctx: state.ctx });
        if (recovered === SKIP) {
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
