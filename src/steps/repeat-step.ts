import type { Agent } from "../agent";
import type { RuntimeState, LoopPredicate, SealedWorkflow } from "../workflow";
import { WorkflowLoopError } from "../workflow";
import { AgentStep } from "./agent-step";
import { Step } from "./step";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Repeat step — `Workflow.repeat(target, options)`.
 *
 * Do-while loop: runs `target` (agent or sub-workflow) against the current
 * output, then evaluates the resolved `predicate` (from `until` / `while`).
 * Stops when the predicate is satisfied or `maxIterations` is hit (the latter
 * throws `WorkflowLoopError`). Cooperative cancellation is checked between
 * iterations. Self-contained: any thrown error — loop-limit, abort, or a body
 * failure — is captured onto `state.pendingError`.
 *
 * `nestedWorkflow` is public (for workflow targets) so the recursive
 * `stepShapeHash` walk can descend into the body's shape.
 */
export class RepeatStep extends Step {
  readonly type = "step" as const;
  readonly category = "repeat" as const;
  readonly id: string;
  readonly nestedWorkflow?: SealedWorkflow<any, any, any, any>;

  private readonly target: Agent<any, any, any> | SealedWorkflow<any, any, any, any>;
  private readonly predicate: LoopPredicate<any, any>;
  private readonly maxIterations: number;
  private readonly isWorkflow: boolean;

  constructor(
    id: string,
    target: Agent<any, any, any> | SealedWorkflow<any, any, any, any>,
    predicate: LoopPredicate<any, any>,
    maxIterations: number,
    isWorkflow: boolean,
  ) {
    super();
    this.id = id;
    this.target = target;
    this.predicate = predicate;
    this.maxIterations = maxIterations;
    this.isWorkflow = isWorkflow;
    this.nestedWorkflow = isWorkflow ? (target as SealedWorkflow<any, any, any, any>) : undefined;
  }

  override async execute(state: RuntimeState): Promise<void> {
    if (this.shouldSkip(state)) return;
    try {
      // Predicate/runAgent params are erased to `any` at this boundary; the
      // generics live at the `Workflow.repeat` API surface.
      const ctx = state.ctx as any;
      for (let i = 1; i <= this.maxIterations; i++) {
        // Cancellation checkpoint between iterations. The agent body's runAgent
        // forwards the signal so an in-flight call cancels too, but this covers
        // sub-workflow bodies where the signal wouldn't otherwise propagate.
        if (state.abortSignal?.aborted) {
          throw state.abortSignal.reason ?? new Error("Workflow aborted");
        }

        if (this.isWorkflow) {
          await (this.target as SealedWorkflow<any, any, any, any>).executeAsNested(state);
        } else {
          await AgentStep.runAgent(state, this.target as Agent<any, any, any>, ctx);
        }

        const done = await this.predicate({ output: state.output, ctx, iterations: i });
        if (done) return;
      }

      throw new WorkflowLoopError(this.maxIterations, this.maxIterations);
    } catch (error) {
      state.pendingError = { error, stepId: this.id, source: this.errorSource };
    }
  }
}
