import type { ModelMessage, ToolSet } from "ai";
import type { ZodType } from "zod";
import type { AgentLike, GenerateTextResult, StreamTextResult, OutputType } from "./agent";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The subset of the AI SDK v7 `Agent` interface that {@link fromSdkAgent}
 * drives — an `id` plus the single-object `generate` / `stream` calls. A
 * `ToolLoopAgent` (and any value implementing the SDK `Agent` interface)
 * satisfies it. Kept structural to avoid coupling to the SDK's call-options
 * generics, which don't unify cleanly with `any`.
 */
export interface SdkAgentLike {
  // The SDK types `ToolLoopAgent.id` as `string | undefined` (it is optional in
  // the settings and auto-generated). `fromSdkAgent` requires a concrete id at
  // runtime and falls back to `options.id`, throwing if neither is present.
  readonly id?: string;
  generate(options: any): Promise<any>;
  stream(options: any): Promise<any>;
}

/**
 * The call input a {@link FromSdkAgentOptions.mapInput} produces for a wrapped
 * SDK agent: a `prompt` XOR `messages`. Extra SDK call params (e.g. `options`
 * when the agent declares typed call options) may be included.
 */
export type SdkAgentInput =
  (
    | { prompt: string | ModelMessage[]; messages?: never }
    | { messages: ModelMessage[]; prompt?: never }
  )
  & { options?: unknown };

export interface FromSdkAgentOptions<TContext, TInput, TOutput> {
  /** Turn pipeai's positional `(ctx, input)` into the SDK agent's `{ prompt | messages }` call. */
  mapInput: (ctx: TContext, input: TInput) => SdkAgentInput;
  /** Set `true` when the wrapped agent was constructed with a structured `output`. Default `false`. */
  hasOutput?: boolean;
  /** Optional Zod guard applied to the structured output after the SDK parses it. */
  validateOutput?: ZodType<TOutput>;
  /** Step id; defaults to the wrapped agent's own `id`. */
  id?: string;
}

/**
 * Adapt a Vercel AI SDK v7 agent (a `ToolLoopAgent`, or any value implementing
 * the SDK `Agent` interface) for use as a `Workflow.step(...)` target.
 *
 * pipeai calls agents positionally as `(ctx, input)`; an SDK agent takes one
 * `{ prompt | messages }` object and fixes its model / tools / `runtimeContext`
 * at construction. `mapInput` bridges the two.
 *
 * **Limitation:** because the SDK agent's `runtimeContext` and tools are fixed
 * at construction, pipeai's per-call `ctx` is available only inside `mapInput`
 * (to build the prompt) — it cannot drive the agent's tools per call the way a
 * native pipeai {@link Agent} with tool-providers can.
 */
export function fromSdkAgent<TContext, TInput = void, TOutput = void>(
  agent: SdkAgentLike,
  options: FromSdkAgentOptions<TContext, TInput, TOutput>,
): AgentLike<TContext, TInput, TOutput> {
  const id = options.id ?? agent.id;
  if (!id) {
    throw new Error("fromSdkAgent: the wrapped agent has no `id`; pass `options.id` explicitly.");
  }

  const buildCall = (ctx: TContext, input: TInput, callOpts?: { abortSignal?: AbortSignal }) => ({
    ...options.mapInput(ctx, input),
    ...(callOpts?.abortSignal ? { abortSignal: callOpts.abortSignal } : {}),
  });

  return {
    id,
    hasOutput: options.hasOutput ?? false,
    validateOutput: options.validateOutput,
    generate: (ctx: TContext, input?: TInput, callOpts?: { abortSignal?: AbortSignal }) =>
      agent.generate(buildCall(ctx, input as TInput, callOpts)) as Promise<GenerateTextResult<ToolSet, OutputType<TOutput>>>,
    stream: (ctx: TContext, input?: TInput, callOpts?: { abortSignal?: AbortSignal }) =>
      agent.stream(buildCall(ctx, input as TInput, callOpts)) as Promise<StreamTextResult<ToolSet, OutputType<TOutput>>>,
    // AgentLike's `generate`/`stream` use a variadic conditional signature that
    // doesn't simplify against a plain (ctx, input?, opts?) arrow; the runtime
    // calls are sound, so we assert the shape here.
  } as AgentLike<TContext, TInput, TOutput>;
}
