import { prependNestedPath, type RuntimeState } from "../runtime";
import type { ConditionalStepOptions } from "../types";
import type { SealedWorkflow } from "../workflow";
import { Step } from "./step";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Nested-workflow step — `Workflow.step(workflow, options?)`.
 *
 * Runs a sealed sub-workflow against the current input via
 * {@link SealedWorkflow.executeAsNested}. A gate inside the child leaves
 * `state.suspension` set; this step propagates it up — prepending its own step
 * index to the snapshot's `nestedPath` so resume can descend back here — rather
 * than treating it as an error. Self-contained: runs its own `when`-`otherwise`
 * checks and captures any thrown error onto `state.pendingError`.
 *
 * On resume (`state.resumeDescent` set), it re-enters the child at the recorded
 * index instead of running it fresh; at the innermost level it seeds the merged
 * gate response before resuming the child from `resumeFromIndex + 1`.
 *
 * `nestedWorkflow` is set so the recursive `stepShapeHash` walk (and the
 * resume path-walk in `loadState`) can descend into the sub-workflow.
 */
export class NestedWorkflowStep extends Step {
  readonly type = "step" as const;
  override readonly category = "nested" as const;
  override readonly nestedWorkflow: SealedWorkflow<any, any, any, any>;
  readonly id: string;

  private readonly options?: ConditionalStepOptions<unknown, unknown, unknown>;

  constructor(
    id: string,
    workflow: SealedWorkflow<any, any, any, any>,
    options: ConditionalStepOptions<unknown, unknown, unknown> | undefined,
  ) {
    super();
    this.id = id;
    this.nestedWorkflow = workflow;
    this.options = options;
  }

  override async execute(state: RuntimeState): Promise<void> {
    // Resume descent: re-enter the child at the recorded index. Skips the
    // `when` / `otherwise` check — on resume the parent's pre-gate steps
    // already ran, so this step is the descent target, not a fresh run.
    const descent = state.resumeDescent;
    if (descent) {
      state.resumeDescent = undefined;   // consume this level
      const [childStart, ...rest] = descent.remaining;
      const myIndex = state.stepIndex ?? -1;
      try {
        if (rest.length === 0) {
          // Innermost level: seed the merged gate response, resume from gate+1.
          state.output = descent.seedOutput;
        } else {
          state.resumeDescent = { remaining: rest, seedOutput: descent.seedOutput };
        }
        await this.nestedWorkflow.executeAsNested(state, childStart);
        if (state.suspension) state.suspension = prependNestedPath(state.suspension, myIndex, state);
      } catch (error) {
        state.pendingError = { error, stepId: this.id, source: this.errorSource };
      }
      return;
    }

    const myIndex = state.stepIndex ?? -1;   // capture before the child overwrites stepIndex
    try {
      // Inside the try so a throwing `when` / `otherwise` routes through
      // `.catch()` like any other body failure.
      if (await this.applyConditionalSkip(state, this.options)) return;
      await this.nestedWorkflow.executeAsNested(state);
      // A gate inside the child suspended: propagate up, recording our index so
      // resume can descend back to the gate.
      if (state.suspension) state.suspension = prependNestedPath(state.suspension, myIndex, state);
    } catch (error) {
      state.pendingError = { error, stepId: this.id, source: this.errorSource };
    }
  }
}
