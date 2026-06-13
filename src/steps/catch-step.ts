import type { MaybePromise } from "../utils";
import type { RuntimeState } from "../runtime";
import { Step } from "./step";

/**
 * Catch step — `Workflow.catch(id, fn)`.
 *
 * The pipeline's recovery handler. Inverted run policy ({@link shouldSkip}): it
 * runs ONLY when there is a `state.pendingError` to handle, and is bypassed on
 * suspension and on checkpoint failure (which propagates to the caller bare).
 * On success the handler's return becomes the new output and the pending error
 * is cleared.
 *
 * If the handler itself throws, the error is NOT captured — it bubbles straight
 * out of the run. A throwing recovery handler is non-recoverable: it does not
 * chain to a later `.catch()`, and it is not aggregated. (Contrast a regular
 * step, whose error is parked on `state.pendingError` for `.catch()` to handle.)
 */
export class CatchStep extends Step {
  readonly type = "catch" as const;
  readonly id: string;
  protected override readonly errorSource = "catch" as const;

  private readonly catchFn: (params: { error: unknown; ctx: unknown; lastOutput: unknown; stepId: string }) => MaybePromise<unknown>;

  constructor(
    id: string,
    catchFn: (params: { error: unknown; ctx: unknown; lastOutput: unknown; stepId: string }) => MaybePromise<unknown>,
  ) {
    super();
    this.id = id;
    this.catchFn = catchFn;
  }

  // Runs only on a pending error; skipped on suspension and checkpoint failure.
  override shouldSkip(state: RuntimeState): boolean {
    return !!state.suspension || !state.pendingError || !!state.checkpointFailed;
  }

  override async execute(state: RuntimeState): Promise<void> {
    // The run loop's shouldSkip gate guarantees pendingError is set here.
    const handled = state.pendingError!;
    // A throw here is intentionally NOT caught — it bubbles out of the run.
    state.output = await this.catchFn({
      error: handled.error,
      ctx: state.ctx,
      lastOutput: state.output,
      stepId: handled.stepId,
    });
    state.pendingError = undefined;
  }
}
