import {
  generateText,
  streamText,
  tool,
  Output,
  type GenerateTextResult as AIGenerateTextResult,
  type StreamTextResult as AIStreamTextResult,
  type ModelMessage,
  type LanguageModel,
  type Tool,
  type ToolSet,
  type StopCondition,
  type ToolChoice,
  type OnStepFinishEvent,
  type OnFinishEvent,
} from "ai";

// Extract the Output interface type from the Output.object return type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OutputType<T = any> = ReturnType<typeof Output.object<T>>;
import type { ZodType } from "zod";
import { isToolProvider, TOOL_PROVIDER_BRAND, type IToolProvider } from "./tool-provider";
import { extractOutput, resolveValue, type MaybePromise, type Resolvable } from "./utils";

// Tools config accepts both AI SDK tools and context-aware ToolProviders
type AgentToolSet<TContext> = Record<string, Tool | IToolProvider<TContext>>;

// ── Result type aliases ─────────────────────────────────────────────

export type GenerateTextResult<TOOLS extends ToolSet = ToolSet, OUTPUT extends OutputType = OutputType> = AIGenerateTextResult<TOOLS, OUTPUT>;
export type StreamTextResult<TOOLS extends ToolSet = ToolSet, OUTPUT extends OutputType = OutputType> = AIStreamTextResult<TOOLS, OUTPUT>;

// ── AI SDK passthrough types ────────────────────────────────────────

// Extract options types from both AI SDK entry points
type StreamTextOptions = Parameters<typeof streamText>[0];
type GenerateTextOptions = Parameters<typeof generateText>[0];

// Keys we replace with resolvable or context-enriched versions
type ManagedKeys =
  | 'model' | 'system' | 'prompt' | 'messages'
  | 'tools' | 'activeTools' | 'toolChoice' | 'stopWhen'
  | 'output' | 'onFinish' | 'onStepFinish' | 'onError';

// Combine options from both streamText and generateText.
// Each side contributes its unique props; shared props merge naturally.
// Stream-only props (onChunk, onAbort) are ignored by generateText.
// Generate-only props (experimental_include.responseBody) are ignored by streamText.
type AIPassthroughOptions =
  Omit<StreamTextOptions, ManagedKeys> &
  Omit<GenerateTextOptions, ManagedKeys>;

// ── Resolved config (output of resolveConfig / resolveConfigAsync) ──

interface ResolvedAgentConfig {
  model: LanguageModel;
  prompt: string | undefined;
  system: string | undefined;
  messages: ModelMessage[] | undefined;
  tools: Record<string, Tool>;
  activeTools: string[] | undefined;
  toolChoice: ToolChoice<ToolSet> | undefined;
  stopWhen: StopCondition<ToolSet> | Array<StopCondition<ToolSet>> | undefined;
}

// ── Agent Configuration ─────────────────────────────────────────────

export interface AgentConfig<
  TContext,
  TInput = void,
  TOutput = void,
> extends AIPassthroughOptions {
  // ── Custom (not in AI SDK) ──
  id: string;
  description?: string;
  input?: ZodType<TInput>;
  output?: OutputType<TOutput>;

  // ── Resolvable (our versions of AI SDK properties) ──
  model: Resolvable<TContext, TInput, LanguageModel>;
  system?: Resolvable<TContext, TInput, string>;
  prompt?: Resolvable<TContext, TInput, string>;
  messages?: Resolvable<TContext, TInput, ModelMessage[]>;
  tools?: Resolvable<TContext, TInput, AgentToolSet<TContext>>;
  activeTools?: Resolvable<TContext, TInput, string[]>;
  toolChoice?: Resolvable<TContext, TInput, ToolChoice<ToolSet>>;
  stopWhen?: Resolvable<TContext, TInput, StopCondition<ToolSet> | Array<StopCondition<ToolSet>>>;

  // ── Context-enriched callbacks (replace AI SDK versions) ──
  onStepFinish?: (params: { result: OnStepFinishEvent; ctx: Readonly<TContext>; input: TInput }) => MaybePromise<void>;
  onFinish?: (params: { result: OnFinishEvent; ctx: Readonly<TContext>; input: TInput }) => MaybePromise<void>;
  onError?: (params: { error: unknown; ctx: Readonly<TContext>; input: TInput }) => MaybePromise<void>;
}

// ── Agent ───────────────────────────────────────────────────────────

export class Agent<
  TContext,
  TInput = void,
  TOutput = void,
> {
  readonly id: string;
  readonly description: string;
  readonly hasOutput: boolean;
  private readonly config: AgentConfig<TContext, TInput, TOutput>;
  private readonly _hasDynamicConfig: boolean;
  private readonly _resolvedStaticTools: Record<string, Tool> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _passthrough: Record<string, any>;
  private readonly _onStepFinish: AgentConfig<TContext, TInput, TOutput>['onStepFinish'];
  private readonly _onFinish: AgentConfig<TContext, TInput, TOutput>['onFinish'];

  constructor(config: AgentConfig<TContext, TInput, TOutput>) {
    this.id = config.id;
    this.description = config.description ?? "";
    this.hasOutput = config.output !== undefined;
    this.config = config;
    this._hasDynamicConfig = [
      config.model, config.system, config.prompt,
      config.messages, config.tools, config.activeTools,
      config.toolChoice, config.stopWhen,
    ].some(v => typeof v === "function");

    // Cache tools when config is static and contains no ToolProviders.
    // Avoids re-iterating the tools map on every generate()/stream() call.
    if (!this._hasDynamicConfig) {
      const rawTools = (config.tools as AgentToolSet<TContext> | undefined) ?? {};
      const hasProvider = Object.values(rawTools).some(v => isToolProvider(v));
      if (!hasProvider) {
        this._resolvedStaticTools = rawTools as Record<string, Tool>;
      }
    }

    // Pre-compute the passthrough (AI SDK options we don't manage) once,
    // rather than destructuring on every generate()/stream() call.
    const {
      id: _id, description: _desc, input: _inputSchema, output: _output,
      model: _m, system: _s, prompt: _p, messages: _msg,
      tools: _t, activeTools: _at, toolChoice: _tc, stopWhen: _sw,
      onStepFinish, onFinish, onError: _onError,
      ...passthrough
    } = config;
    this._passthrough = passthrough;
    this._onStepFinish = onStepFinish;
    this._onFinish = onFinish;
  }

  async generate(ctx: TContext, ...args: TInput extends void ? [input?: TInput] : [input: TInput]): Promise<GenerateTextResult> {
    const input = args[0] as TInput;
    const resolved = await this.resolveConfig(ctx, input);
    const options = this.buildCallOptions(resolved, ctx, input);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await generateText(options as any);
    } catch (error: unknown) {
      if (this.config.onError) {
        await this.config.onError({ error, ctx, input });
      }
      throw error;
    }
  }

  async stream(ctx: TContext, ...args: TInput extends void ? [input?: TInput] : [input: TInput]): Promise<StreamTextResult> {
    const input = args[0] as TInput;
    const resolved = await this.resolveConfig(ctx, input);
    const options = this.buildCallOptions(resolved, ctx, input);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return streamText({
      ...options,
      onError: this.config.onError
        ? ({ error }: { error: unknown }) => this.config.onError!({ error, ctx, input })
        : undefined,
    } as any);
  }

  asTool(ctx: TContext, options?: {
    mapOutput?: (result: GenerateTextResult) => MaybePromise<TOutput>;
  }): Tool {
    return this.createToolInstance(ctx, options);
  }

  asToolProvider(options?: {
    mapOutput?: (result: GenerateTextResult) => MaybePromise<TOutput>;
  }): IToolProvider<TContext> {
    if (!this.config.input) {
      throw new Error(`Agent "${this.id}": asToolProvider() requires an input schema`);
    }

    return {
      [TOOL_PROVIDER_BRAND]: true as const,
      createTool: (ctx: Readonly<TContext>) => this.createToolInstance(ctx as TContext, options),
    };
  }

  private createToolInstance(ctx: TContext, options?: {
    mapOutput?: (result: GenerateTextResult) => MaybePromise<TOutput>;
  }): Tool {
    if (!this.config.input) {
      throw new Error(`Agent "${this.id}": asTool() requires an input schema`);
    }

    return tool({
      description: this.description,
      parameters: this.config.input,
      execute: async (toolInput: TInput) => {
        const result = await (this.generate as (ctx: TContext, input: TInput) => Promise<GenerateTextResult>)(ctx, toolInput);
        if (options?.mapOutput) return options.mapOutput(result);
        return extractOutput(result, this.hasOutput);
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildCallOptions(resolved: ResolvedAgentConfig, ctx: TContext, input: TInput): Record<string, any> {
    return {
      ...this._passthrough,
      model: resolved.model,
      tools: resolved.tools,
      activeTools: resolved.activeTools,
      toolChoice: resolved.toolChoice,
      stopWhen: resolved.stopWhen,
      ...(resolved.messages
        ? { messages: resolved.messages }
        : { prompt: resolved.prompt ?? "" }),
      ...(resolved.system ? { system: resolved.system } : {}),
      ...(this.config.output ? { output: this.config.output } : {}),
      onStepFinish: this._onStepFinish
        ? (event: OnStepFinishEvent) => this._onStepFinish!({ result: event, ctx, input })
        : undefined,
      onFinish: this._onFinish
        ? (event: OnFinishEvent) => this._onFinish!({ result: event, ctx, input })
        : undefined,
    };
  }

  private resolveConfig(ctx: TContext, input: TInput): ResolvedAgentConfig | Promise<ResolvedAgentConfig> {
    if (!this._hasDynamicConfig) {
      return {
        model: this.config.model as LanguageModel,
        prompt: this.config.prompt as string | undefined,
        system: this.config.system as string | undefined,
        messages: this.config.messages as ModelMessage[] | undefined,
        tools: this._resolvedStaticTools ?? this.resolveTools(
          (this.config.tools as AgentToolSet<TContext> | undefined) ?? {}, ctx
        ),
        activeTools: this.config.activeTools as string[] | undefined,
        toolChoice: this.config.toolChoice as ToolChoice<ToolSet> | undefined,
        stopWhen: this.config.stopWhen as StopCondition<ToolSet> | Array<StopCondition<ToolSet>> | undefined,
      };
    }
    return this.resolveConfigAsync(ctx, input);
  }

  private async resolveConfigAsync(ctx: TContext, input: TInput): Promise<ResolvedAgentConfig> {
    const [model, prompt, system, messages, rawTools, activeTools, toolChoice, stopWhen] = await Promise.all([
      resolveValue(this.config.model, ctx, input),
      resolveValue(this.config.prompt, ctx, input),
      resolveValue(this.config.system, ctx, input),
      resolveValue(this.config.messages, ctx, input),
      resolveValue(this.config.tools, ctx, input),
      resolveValue(this.config.activeTools, ctx, input),
      resolveValue(this.config.toolChoice, ctx, input),
      resolveValue(this.config.stopWhen, ctx, input),
    ]);
    const tools = this.resolveTools(rawTools ?? {}, ctx);
    return { model, prompt, system, messages, tools, activeTools, toolChoice, stopWhen };
  }

  private resolveTools(
    tools: AgentToolSet<TContext>,
    ctx: TContext
  ): Record<string, Tool> {
    const entries = Object.entries(tools);
    if (entries.length === 0) return tools as Record<string, Tool>;
    let hasProvider = false;
    const resolved: Record<string, Tool> = {};
    for (const [key, toolOrProvider] of entries) {
      if (isToolProvider<TContext>(toolOrProvider)) {
        hasProvider = true;
        resolved[key] = toolOrProvider.createTool(ctx as Readonly<TContext>);
      } else {
        resolved[key] = toolOrProvider as Tool;
      }
    }
    return hasProvider ? resolved : (tools as Record<string, Tool>);
  }
}
