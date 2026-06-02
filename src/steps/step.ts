import type { RuntimeState, ConditionalStepOptions, PendingError } from "../workflow";

/**
 * Internal base for a single workflow step node.
 *
 * Background: the run loop in `workflow.ts` consumes a `StepNode` — a
 * structural discriminated union keyed on `type`
 * (`"step" | "gate" | "catch" | "finally"`). Historically every combinator on
 * `Workflow` hand-built one of those object literals inline, so the builder
 * class knew the construction details of every step kind. We are migrating that
 * per-kind knowledge into focused `Step` subclasses.
 *
 * ## Execution model (the "fat step")
 *
 * The run loop does one thing: call {@link execute}. Everything else is the
 * step's own business — a kind's `execute` decides whether to skip (via
 * {@link shouldSkip} / {@link applyConditionalSkip}), runs its work, and
 * captures any thrown error onto `state.pendingError`, exactly the way it
 * writes its result to `state.output`. Errors accumulate on the state; they do
 * not escape.
 *
 * The base {@link execute} is a no-op so kinds with no body of their own need
 * not override it. {@link errorSource} tags which precedence bucket a captured
 * error lands in.
 */
export abstract class Step {
  /** Run-loop dispatch discriminant. Mirrors `StepNode["type"]`. */
  abstract readonly type: "step" | "gate" | "catch" | "finally";
  /** Identifier, unique per `type`; surfaced in observability and snapshots. */
  abstract readonly id: string;

  // Note: `type: "step"` subclasses (agent / transform / nested / branch /
  // foreach / repeat / parallel) also carry a `readonly category` that the run
  // loop reads (`getObservabilityType`) to type observability events. It is not
  // declared on this base — the `StepNode` union in `workflow.ts` redeclares the
  // node shape, so `category` is part of that structural contract rather than
  // this class. Subclasses add it directly.

  /**
   * Precedence source tag a kind writes to `state.pendingError` when it
   * captures a thrown body error. Defaults to `"step"`; kinds with a distinct
   * error-precedence bucket (e.g. `finally`, `catch`, `gate`) override it.
   */
  protected readonly errorSource: PendingError["source"] = "step";

  /**
   * The step's body — the only method the run loop invokes. Each kind overrides
   * it to do its work, run its own skip checks, and capture errors onto state.
   * `state.output` is the input on entry and becomes the output on exit;
   * `state.writer` is present in stream mode. The base implementation is a
   * no-op so kinds that carry no body of their own need not override it.
   */
  async execute(_state: RuntimeState): Promise<void> {
    // No-op default; subclasses override.
  }

  /**
   * Run-policy gate: return `true` when this step should be skipped silently
   * (no output change). The default is the "normal" policy — skip while the
   * flow is suspended or already in error. Overridden by kinds with inverted
   * policies: `catch` runs only when there's an error, `finally` always runs.
   */
  protected shouldSkip(state: RuntimeState): boolean {
    return !!state.suspension || !!state.pendingError;
  }

  /**
   * Apply `when` / `otherwise` conditional-skip options. Returns `true` when
   * the body should be skipped — i.e. `when` returned false. On skip,
   * `otherwise` (if present) produces the output; without it the input passes
   * through unchanged. Distinct from {@link shouldSkip}: this is the body-level
   * `when` / `otherwise` decision a kind applies after the policy gate passes.
   */
  protected async applyConditionalSkip(
    state: RuntimeState,
    options: ConditionalStepOptions<unknown, unknown, unknown> | undefined,
  ): Promise<boolean> {
    if (!options?.when) return false;
    // `when` / `otherwise` expect `{ ctx: Readonly<unknown>; input: unknown }`;
    // `Readonly<unknown>` resolves to `{}`, which raw `unknown` is not
    // assignable to — so build the params once with an assertion. The values
    // are the live ctx/output; only the static type is coerced.
    const params = { ctx: state.ctx, input: state.output } as { ctx: Readonly<unknown>; input: unknown };
    if (await options.when(params)) return false;
    if (options.otherwise) {
      state.output = await options.otherwise(params);
    }
    // No `otherwise` → passthrough: leave state.output unchanged.
    return true;
  }
}
