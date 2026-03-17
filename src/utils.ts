import { AsyncLocalStorage } from "node:async_hooks";
import type { UIMessageStreamWriter } from "ai";

// ── Stream writer context ────────────────────────────────────────────
// Invisible to the user. The workflow sets the writer before agent execution;
// tools and sub-agents read it automatically via getActiveWriter().

const writerStorage = new AsyncLocalStorage<UIMessageStreamWriter>();

export function runWithWriter<T>(writer: UIMessageStreamWriter, fn: () => T): T {
  return writerStorage.run(writer, fn);
}

export function getActiveWriter(): UIMessageStreamWriter | undefined {
  return writerStorage.getStore();
}

// ── Common types ─────────────────────────────────────────────────────

export type MaybePromise<T> = T | Promise<T>;

/**
 * A value that can be static or derived from context and input.
 * Used for agent config fields that may need runtime resolution.
 *
 * Functions may return a Promise for async resolution; static values are always sync.
 */
export type Resolvable<TCtx, TInput, TValue> =
  | TValue
  | ((ctx: Readonly<TCtx>, input: TInput) => TValue | Promise<TValue>);

export function resolveValue<TCtx, TInput, TValue>(
  value: Resolvable<TCtx, TInput, TValue>,
  ctx: TCtx,
  input: TInput
): TValue | Promise<TValue>;
export function resolveValue<TCtx, TInput, TValue>(
  value: Resolvable<TCtx, TInput, TValue> | undefined,
  ctx: TCtx,
  input: TInput
): TValue | Promise<TValue> | undefined {
  if (typeof value === "function") {
    return (value as (ctx: TCtx, input: TInput) => TValue | Promise<TValue>)(ctx, input);
  }
  return value;
}

/**
 * Extract structured output from an AI SDK result, falling back to text.
 * Works for both generate (sync .output/.text) and stream (async .output/.text) results.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function extractOutput(result: any, hasStructuredOutput: boolean): Promise<unknown> {
  if (hasStructuredOutput) {
    const output = await result.output;
    if (output !== undefined) return output;
  }
  return await result.text;
}
