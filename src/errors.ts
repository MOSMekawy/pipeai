// Workflow error classes and reserved synthetic step ids. A leaf module (no
// internal imports) so step subclasses and the runtime can reach these without
// a value-level cycle through ./workflow.

export class WorkflowBranchError extends Error {
  constructor(
    public readonly branchType: "predicate" | "select",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowBranchError";
  }
}

export class WorkflowLoopError extends Error {
  constructor(
    public readonly iterations: number,
    public readonly maxIterations: number,
  ) {
    super(`Loop exceeded maximum iterations (${maxIterations})`);
    this.name = "WorkflowLoopError";
  }
}

/**
 * Synthetic step id reported when `onCheckpoint` itself throws. Reserved
 * via the construction-time `(type, id)` walk — user step ids may not
 * contain the `::pipeai::` namespace.
 */
export const CHECKPOINT_STEP_ID = "::pipeai::onCheckpoint" as const;

/**
 * Synthetic step id carried by the pending-error a cancellation promotes
 * (surfaced to `.catch()` / observability). Lives in the reserved
 * `::pipeai::` namespace so it can't be confused with a user step literally
 * named "abort".
 */
export const ABORT_STEP_ID = "::pipeai::abort" as const;

/**
 * Synthetic step id used when a gate-resume's response validation / merge
 * throws before the pipeline re-enters `execute()`. Reserved-namespaced for
 * the same reason as {@link ABORT_STEP_ID}.
 */
export const GATE_RESUME_STEP_ID = "::pipeai::gate:resume" as const;
