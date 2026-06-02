import { deepFreeze, type MaybePromise } from "../utils";
import type { RuntimeState, GateSnapshot, SchemaWithParse } from "../workflow";
import { resolveFreezeSnapshots } from "../workflow";
import { Step } from "./step";

/**
 * Gate step — `Workflow.gate(id, options?)`.
 *
 * Human-in-the-loop suspension point. With the standard run policy
 * ({@link shouldSkip}) it runs only when neither suspended nor in error. An
 * optional `condition` can short-circuit the gate (returns false → no
 * suspension, passthrough). Otherwise it snapshots the run — `resumeFromIndex`
 * comes from `state.stepIndex`, set by the run loop — parks it on
 * `state.suspension`, and (when freezing) deep-freezes the snapshot. A throwing
 * `condition`/`payload` is captured onto `state.pendingError` (`source: "gate"`)
 * so it routes through `.catch()` like any other step error.
 *
 * `schema` / `merge` are public because `SealedWorkflow.loadState` reads them
 * off the node during gate resume (response validation + merge).
 */
export class GateStep extends Step {
  readonly type = "gate" as const;
  readonly id: string;
  protected readonly errorSource = "gate" as const;

  /** Read by `loadState` to validate the resumed gate response. */
  readonly schema?: SchemaWithParse;
  /** Read by `loadState` to merge the response with the suspended output. */
  readonly merge?: (params: { priorOutput: unknown; response: unknown }) => MaybePromise<unknown>;

  private readonly payload: (state: RuntimeState) => MaybePromise<unknown>;
  private readonly condition?: (state: RuntimeState) => MaybePromise<boolean>;

  constructor(
    id: string,
    payload: (state: RuntimeState) => MaybePromise<unknown>,
    schema: SchemaWithParse | undefined,
    condition: ((state: RuntimeState) => MaybePromise<boolean>) | undefined,
    merge: ((params: { priorOutput: unknown; response: unknown }) => MaybePromise<unknown>) | undefined,
  ) {
    super();
    this.id = id;
    this.payload = payload;
    this.schema = schema;
    this.condition = condition;
    this.merge = merge;
  }

  override async execute(state: RuntimeState): Promise<void> {
    if (this.shouldSkip(state)) return;
    try {
      // A false condition short-circuits the gate: no suspension, passthrough.
      if (this.condition && !(await this.condition(state))) return;
      const snapshot: GateSnapshot = {
        version: 2,
        kind: "gate",
        resumeFromIndex: state.stepIndex ?? -1,
        output: state.output,
        gateId: this.id,
        gatePayload: await this.payload(state),
      };
      state.suspension = snapshot;
      if (resolveFreezeSnapshots(state)) deepFreeze(snapshot);
    } catch (error) {
      state.pendingError = { error, stepId: this.id, source: this.errorSource };
    }
  }
}
