import type { RuntimeState, PendingError } from "../runtime";
import type { ConditionalStepOptions } from "../types";
import type { SealedWorkflow } from "../workflow";

/**
 * Disambiguates observability events for `type: "step"` nodes. Keeps a single
 * `type: "step"` node kind rather than splitting branch/foreach/repeat/
 * parallel/nested into their own run-loop variants.
 */
export type StepCategory = "step" | "nested" | "branch" | "foreach" | "repeat" | "parallel";

/**
 * Base class for a single workflow step node. The run loop in `workflow.ts`
 * consumes `ReadonlyArray<Step>` directly — every combinator on `Workflow`
 * constructs one of the subclasses in this directory.
 *
 * ## Execution model (the "fat step")
 *
 * The run loop does two things: ask {@link shouldSkip} whether the node runs
 * at all (skipped nodes fire no observability hooks), then call
 * {@link execute}. Everything else is the step's own business — a kind's
 * `execute` runs its work (applying the body-level `when` / `otherwise`
 * decision via {@link applyConditionalSkip}) and captures any thrown error
 * onto `state.pendingError`, exactly the way it writes its result to
 * `state.output`. Errors accumulate on the state; they do not escape.
 *
 * The base {@link execute} is a no-op so kinds with no body of their own need
 * not override it. {@link errorSource} tags which precedence bucket a captured
 * error lands in.
 */
export abstract class Step {
  /** Run-loop dispatch discriminant. */
  abstract readonly type: "step" | "gate" | "catch" | "finally";
  /** Identifier, unique per `type`; surfaced in observability and snapshots. */
  abstract readonly id: string;

  /**
   * Observability event subtype for `type: "step"` nodes (agent / transform =
   * `"step"`; nested / branch / foreach / repeat / parallel override).
   * `undefined` on gate / catch / finally nodes, whose `type` IS the event type.
   */
  readonly category?: StepCategory;

  /**
   * The sealed sub-workflow attached to this node, when it has one (`nested`,
   * and workflow-target `foreach` / `repeat`). Consumed by the recursive
   * `stepShapeHash` walk and the resume path-walk in `loadState`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly nestedWorkflow?: SealedWorkflow<any, any, any, any>;

  /**
   * Precedence source tag a kind writes to `state.pendingError` when it
   * captures a thrown body error. Defaults to `"step"`; kinds with a distinct
   * error-precedence bucket (e.g. `finally`, `catch`, `gate`) override it.
   */
  protected readonly errorSource: PendingError["source"] = "step";

  /**
   * The step's body, invoked by the run loop only after {@link shouldSkip}
   * returned `false`. Each kind overrides it to do its work and capture errors
   * onto state. `state.output` is the input on entry and becomes the output on
   * exit; `state.writer` is present in stream mode. The base implementation is
   * a no-op so kinds that carry no body of their own need not override it.
   */
  async execute(_state: RuntimeState): Promise<void> {
    // No-op default; subclasses override.
  }

  /**
   * Run-policy gate, called by the run loop before {@link execute}: return
   * `true` when this step should be skipped silently (no hooks, no output
   * change). The default is the "normal" policy — skip while the flow is
   * suspended or already in error. Overridden by kinds with inverted policies:
   * `catch` runs only when there's an error, `finally` always runs.
   */
  shouldSkip(state: RuntimeState): boolean {
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
