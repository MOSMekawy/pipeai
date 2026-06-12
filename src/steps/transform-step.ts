import type { UIMessageStreamWriter } from "ai";
import type { MaybePromise } from "../utils";
import type { RuntimeState } from "../runtime";
import type { ConditionalStepOptions } from "../types";
import { Step } from "./step";

/** The inline transform body produced by `Workflow.step(id, fn, options?)`. */
type TransformFn = (params: {
  ctx: unknown;
  input: unknown;
  writer?: UIMessageStreamWriter;
}) => MaybePromise<unknown>;

/**
 * Inline transform step — `Workflow.step(id, fn, options?)`.
 *
 * Runs `fn` with the current `ctx` / `input` (and the stream `writer` in stream
 * mode), assigning its result to `state.output`. Self-contained: it captures
 * any thrown error onto `state.pendingError`, mirroring how it writes its
 * result to `state.output`.
 *
 * Generics live at the `Workflow.step` API boundary; internally the body and
 * options are erased to `unknown` (the run loop only sees `RuntimeState`).
 */
export class TransformStep extends Step {
  readonly type = "step" as const;
  readonly id: string;
  private readonly fn: TransformFn;
  private readonly options?: ConditionalStepOptions<unknown, unknown, unknown>;

  constructor(
    id: string,
    fn: TransformFn,
    options?: ConditionalStepOptions<unknown, unknown, unknown>,
  ) {
    super();
    this.id = id;
    this.fn = fn;
    this.options = options;
  }

  override async execute(state: RuntimeState): Promise<void> {
    try {
      // Inside the try so a throwing `when` / `otherwise` routes through
      // `.catch()` like any other body failure.
      if (await this.applyConditionalSkip(state, this.options)) return;
      state.output = await this.fn({
        ctx: state.ctx,
        input: state.output,
        // Present in stream mode (undefined in generate mode), letting the
        // inline step emit UIMessageChunk parts onto the workflow's stream.
        writer: state.writer,
      });
    } catch (error) {
      state.pendingError = { error, stepId: this.id, source: this.errorSource };
    }
  }
}
