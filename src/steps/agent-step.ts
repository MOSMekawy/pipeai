import { toUIMessageStream, type ToolSet } from "ai";
import type { AgentLike, GenerateTextResult, StreamTextResult, OutputType } from "../agent";
import { extractOutput, runWithWriter } from "../utils";
import type { RuntimeState } from "../runtime";
import type { StepOptions, AgentStepHooks, AgentResultParams } from "../types";
import { Step } from "./step";

/**
 * Agent step — `Workflow.step(agent, options?)`.
 *
 * Runs `agent` against the current input, applying the `mapResult` /
 * `onResult` / `handleStream` hooks. Self-contained: {@link execute} captures
 * any thrown error onto `state.pendingError`, mirroring how it writes its
 * result to `state.output`.
 *
 * The raw agent invocation lives in the static {@link runAgent} so the
 * concurrent dispatch (`./concurrent`) and the branch steps can share it.
 * Generics live at the `Workflow.step` API boundary; an `AgentStep` instance
 * erases the agent and options to `any` (the run loop only sees
 * `RuntimeState`).
 */
export class AgentStep extends Step {
  readonly type = "step" as const;
  readonly id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly agent: AgentLike<any, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly options?: StepOptions<any, any, any>;

  constructor(
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: AgentLike<any, any, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: StepOptions<any, any, any>,
  ) {
    super();
    this.id = id;
    this.agent = agent;
    this.options = options;
  }

  override async execute(state: RuntimeState): Promise<void> {
    try {
      // Inside the try so a throwing `when` / `otherwise` routes through
      // `.catch()` like any other body failure.
      if (await this.applyConditionalSkip(state, this.options)) return;
      await AgentStep.runAgent(state, this.agent, state.ctx, this.options);
    } catch (error) {
      state.pendingError = { error, stepId: this.id, source: this.errorSource };
    }
  }

  /**
   * Run an agent against the current state, writing its result to
   * `state.output`. In stream mode, output extraction awaits the full stream
   * before returning — streaming benefits the client (incremental output), not
   * pipeline throughput, since each step still runs sequentially.
   *
   * Static (does not touch instance state) so the still-literal foreach /
   * parallel / branch combinators can share it. `itemIndex` identifies the
   * execution to `handleStream` inside a multi-execution combinator (numeric
   * index, record key, or matched case); `undefined` for a plain single
   * `.step(agent)`.
   */
  static async runAgent<TContext, TNextOutput>(
    state: RuntimeState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: AgentLike<TContext, any, TNextOutput>,
    ctx: TContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: AgentStepHooks<TContext, any, TNextOutput>,
    itemIndex?: number | string,
  ): Promise<void> {
    const input = state.output;
    const hasStructuredOutput = agent.hasOutput;

    const abortSignal = state.abortSignal;
    const agentCallOpts = abortSignal ? { abortSignal } : undefined;

    if (state.mode === "stream" && state.writer) {
      const writer = state.writer;
      // Run inside writer context so tools accessed via getActiveWriter() pick it up.
      await runWithWriter(writer, async () => {
        const result = await (agent.stream as (ctx: TContext, input: unknown, opts?: { abortSignal?: AbortSignal }) => Promise<StreamTextResult<ToolSet, OutputType<TNextOutput>>>)(ctx, state.output, agentCallOpts);

        if (options?.handleStream) {
          await options.handleStream({ result, writer, ctx, input, itemIndex });
        } else {
          writer.merge(toUIMessageStream({ stream: result.stream }));
        }

        const hookParams = {
          mode: "stream",
          result,
          ctx: ctx as Readonly<TContext>,
          input,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as AgentResultParams<TContext, any, TNextOutput>;

        if (options?.onResult) {
          await options.onResult(hookParams);
        }

        if (options?.mapResult) {
          state.output = await options.mapResult(hookParams);
        } else {
          state.output = await extractOutput(result, hasStructuredOutput, agent.validateOutput);
        }
      });
    } else {
      const result = await (agent.generate as (ctx: TContext, input: unknown, opts?: { abortSignal?: AbortSignal }) => Promise<GenerateTextResult<ToolSet, OutputType<TNextOutput>>>)(ctx, state.output, agentCallOpts);

      const hookParams = {
        mode: "generate",
        result,
        ctx: ctx as Readonly<TContext>,
        input,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as AgentResultParams<TContext, any, TNextOutput>;

      if (options?.onResult) {
        await options.onResult(hookParams);
      }

      if (options?.mapResult) {
        state.output = await options.mapResult(hookParams);
      } else {
        state.output = await extractOutput(result, hasStructuredOutput, agent.validateOutput);
      }
    }
  }
}
