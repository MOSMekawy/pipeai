import { deepFreeze, type MaybePromise } from "../utils";
import { resolveFreezeSnapshots, type RuntimeState } from "../runtime";
import type { GateSnapshot, SchemaWithParse } from "../types";
import { Step } from "./step";

/**
 * User-facing gate options as accepted by `Workflow.gate(id, options?)`.
 * Generics live at that API boundary; here `ctx` / `input` are erased.
 */
export interface GateStepOptions {
  payload?: (params: { ctx: Readonly<unknown>; input: unknown }) => MaybePromise<unknown>;
  schema?: SchemaWithParse;
  condition?: (params: { ctx: Readonly<unknown>; input: unknown }) => MaybePromise<boolean>;
  merge?: (params: { priorOutput: unknown; response: unknown }) => MaybePromise<unknown>;
}

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
  protected override readonly errorSource = "gate" as const;

  /** Read by `loadState` to validate the resumed gate response. */
  readonly schema?: SchemaWithParse;
  /** Read by `loadState` to merge the response with the suspended output. */
  readonly merge?: (params: { priorOutput: unknown; response: unknown }) => MaybePromise<unknown>;

  private readonly payload?: GateStepOptions["payload"];
  private readonly condition?: GateStepOptions["condition"];

  constructor(id: string, options: GateStepOptions | undefined) {
    super();
    this.id = id;
    this.payload = options?.payload;
    this.schema = options?.schema;
    this.condition = options?.condition;
    this.merge = options?.merge;
  }

  override async execute(state: RuntimeState): Promise<void> {
    try {
      const params = { ctx: state.ctx, input: state.output } as { ctx: Readonly<unknown>; input: unknown };
      // A false condition short-circuits the gate: no suspension, passthrough.
      if (this.condition && !(await this.condition(params))) return;
      const snapshot: GateSnapshot = {
        version: 2,
        kind: "gate",
        resumeFromIndex: state.stepIndex ?? -1,
        output: state.output,
        gateId: this.id,
        gatePayload: this.payload ? await this.payload(params) : state.output,
      };
      state.suspension = snapshot;
      if (resolveFreezeSnapshots(state)) deepFreeze(snapshot);
    } catch (error) {
      state.pendingError = { error, stepId: this.id, source: this.errorSource };
    }
  }
}
