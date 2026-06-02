import type { RuntimeState, BranchCase, BranchSelect } from "../workflow";
import { WorkflowBranchError } from "../workflow";
import { Step } from "./step";
import { AgentStep } from "./agent-step";

/**
 * Predicate branch — `Workflow.branch(cases)`.
 *
 * Walks the cases in order, routing to the first whose `when` matches (a case
 * without `when` is the default). Throws `WorkflowBranchError` when nothing
 * matches and there is no default. Self-contained: captures any thrown error
 * (no-match, predicate throw, or the routed agent) onto `state.pendingError`.
 */
export class PredicateBranchStep extends Step {
  readonly type = "step" as const;
  readonly category = "branch" as const;
  readonly id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly cases: BranchCase<any, any, any>[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(id: string, cases: BranchCase<any, any, any>[]) {
    super();
    this.id = id;
    this.cases = cases;
  }

  override async execute(state: RuntimeState): Promise<void> {
    if (this.shouldSkip(state)) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = state.ctx as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const input = state.output as any;

      for (let caseIndex = 0; caseIndex < this.cases.length; caseIndex++) {
        const branchCase = this.cases[caseIndex];
        if (branchCase.when) {
          const match = await branchCase.when({ ctx, input });
          if (!match) continue;
        }
        // Matched (or no `when` = default). itemIndex = matched case index.
        await AgentStep.runAgent(state, branchCase.agent, ctx, branchCase, caseIndex);
        return;
      }

      // Render the input defensively — JSON.stringify throws on cyclic /
      // BigInt / function-valued inputs, which would mask the real branch
      // mismatch with a serialization error.
      let inputRepr: string;
      try {
        inputRepr = JSON.stringify(input);
        if (inputRepr === undefined) inputRepr = String(input);
      } catch {
        inputRepr = `[unserializable ${typeof input}]`;
      }
      throw new WorkflowBranchError("predicate", `No branch matched and no default branch (a case without \`when\`) was provided. Input: ${inputRepr}`);
    } catch (error) {
      state.pendingError = { error, stepId: this.id, source: this.errorSource };
    }
  }
}

/**
 * Select branch — `Workflow.branch({ select, agents, fallback?, onUnknownKey? })`.
 *
 * Routes to `agents[select(...)]`. A declared-but-`undefined` agent fails loud
 * (a misconfiguration, not an unknown key); a genuinely unknown key fires
 * `onUnknownKey`, then falls back to `fallback` or throws `WorkflowBranchError`.
 * Self-contained: captures any thrown error onto `state.pendingError`.
 */
export class SelectBranchStep extends Step {
  readonly type = "step" as const;
  readonly category = "branch" as const;
  readonly id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly config: BranchSelect<any, any, any, any>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(id: string, config: BranchSelect<any, any, any, any>) {
    super();
    this.id = id;
    this.config = config;
  }

  override async execute(state: RuntimeState): Promise<void> {
    if (this.shouldSkip(state)) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = state.ctx as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const input = state.output as any;
      const config = this.config;
      const key = await config.select({ ctx, input });

      // Distinguish "key not declared at all" from "key present but value
      // is `undefined`" (e.g. `agents: { bug: cond ? agentA : undefined }`).
      // The latter is a user-side bug — fail loud rather than silently
      // falling back, since the fallback obscures the misconfiguration.
      //
      // Use Object.prototype.hasOwnProperty.call (not `in`) so untrusted
      // classifier output like "toString"/"constructor"/"__proto__" doesn't
      // resolve to an Object.prototype method and crash runAgent with an
      // opaque "agent.generate is not a function".
      const keyDeclared = Object.prototype.hasOwnProperty.call(config.agents, key);
      if (keyDeclared && (config.agents as Record<string, unknown>)[key] === undefined) {
        throw new WorkflowBranchError(
          "select",
          `Agent for key "${key}" was declared but the value is undefined. ` +
          `This usually means a conditional spread set the value to undefined. ` +
          `Available keys: ${Object.keys(config.agents).join(", ")}`,
        );
      }
      let agent = keyDeclared ? config.agents[key] : undefined;
      if (!agent) {
        if (config.onUnknownKey) {
          config.onUnknownKey({
            key,
            availableKeys: Object.keys(config.agents),
            ctx,
          });
        }
        if (config.fallback) {
          agent = config.fallback;
        } else {
          throw new WorkflowBranchError("select", `No agent found for key "${key}" and no fallback provided. Available keys: ${Object.keys(config.agents).join(", ")}`);
        }
      }

      // itemIndex = the selected key.
      await AgentStep.runAgent(state, agent, ctx, config, key);
    } catch (error) {
      state.pendingError = { error, stepId: this.id, source: this.errorSource };
    }
  }
}
