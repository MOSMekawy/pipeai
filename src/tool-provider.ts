import { tool, type Tool, type ToolExecutionOptions, type FlexibleSchema, type UIMessageStreamWriter } from "ai";
import { getActiveWriter } from "./utils";

export const TOOL_PROVIDER_BRAND = Symbol.for("agent-workflow.ToolProvider");

export type ToolExecuteOptions = ToolExecutionOptions & {
  writer?: UIMessageStreamWriter;
};

export type ToolProviderConfig<TContext, TInput, TOutput> = {
  description?: string;
  input: FlexibleSchema<TInput>;
  output?: FlexibleSchema<unknown>;
  providerOptions?: unknown;
  execute: (input: TInput, ctx: Readonly<TContext>, options: ToolExecuteOptions) => Promise<TOutput>;
};

export interface IToolProvider<TContext> {
  readonly [TOOL_PROVIDER_BRAND]: true;
  createTool(context: Readonly<TContext>): Tool;
}

export class ToolProvider<
  TContext,
  TInput = unknown,
  TOutput = unknown,
> implements IToolProvider<TContext> {
  readonly [TOOL_PROVIDER_BRAND] = true as const;
  private readonly config: ToolProviderConfig<TContext, TInput, TOutput>;

  constructor(config: ToolProviderConfig<TContext, TInput, TOutput>) {
    this.config = config;
  }

  createTool(context: Readonly<TContext>): Tool {
    const { execute, input: inputSchema, ...toolDef } = this.config;
    return tool({
      ...toolDef,
      inputSchema,
      execute: (input: TInput, options?: ToolExecutionOptions) => execute(input, context, { ...options, writer: getActiveWriter() } as ToolExecuteOptions),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }
}

export function defineTool<TContext>() {
  return <TInput, TOutput>(
    config: ToolProviderConfig<TContext, TInput, TOutput>
  ): ToolProvider<TContext, TInput, TOutput> => new ToolProvider(config);
}

export function isToolProvider<TContext>(obj: unknown): obj is IToolProvider<TContext> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    TOOL_PROVIDER_BRAND in obj
  );
}
