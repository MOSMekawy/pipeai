import type { MaybePromise } from "../utils";
import type { RuntimeState } from "../workflow";
import { Step } from "./step";

/**
 * Finally step — `Workflow.finally(id, fn)`.
 *
 * Cleanup body that runs on every non-bubbled exit path: after success, after a
 * step error, and after suspension. {@link shouldSkip} is therefore always
 * `false`.
 *
 * A throwing body is NOT captured — it bubbles straight out of the run. This
 * means a throwing `finally` is non-recoverable: it does not aggregate with a
 * prior error, subsequent `.finally()` bodies do not run, and on suspension it
 * rejects rather than returning the snapshot. (Contrast a regular step, whose
 * error is parked on `state.pendingError` for `.catch()` to handle.)
 */
export class FinallyStep extends Step {
  readonly type = "finally" as const;
  readonly id: string;
  protected readonly errorSource = "finally" as const;

  private readonly fn: (params: { ctx: Readonly<unknown> }) => MaybePromise<void>;

  constructor(id: string, fn: (params: { ctx: Readonly<unknown> }) => MaybePromise<void>) {
    super();
    this.id = id;
    this.fn = fn;
  }

  // Always runs — cleanup must fire regardless of suspension / error state.
  protected override shouldSkip(_state: RuntimeState): boolean {
    return false;
  }

  override async execute(state: RuntimeState): Promise<void> {
    if (this.shouldSkip(state)) return;
    // A throw here is intentionally NOT caught — it bubbles out of the run.
    await this.fn({ ctx: state.ctx as Readonly<unknown> });
  }
}
