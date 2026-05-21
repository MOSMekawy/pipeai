import { AsyncLocalStorage } from "node:async_hooks";
import type { UIMessageStreamWriter } from "ai";
import type { ZodType } from "zod";

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
 * Extract structured output from an AI SDK result.
 *
 * - When `hasStructuredOutput` is `true`, awaits `result.output`. If the SDK
 *   did not produce a structured value, this throws — silent fall-back to raw
 *   text would mask schema mismatches at the call site.
 * - When `schema` is provided, the awaited output is validated through the
 *   Zod schema before being returned, catching SDK-side parse drift.
 * - When `hasStructuredOutput` is `false`, returns `result.text`.
 *
 * Works for both generate (sync .output/.text) and stream (async .output/.text) results.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function extractOutput(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any,
  hasStructuredOutput: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema?: ZodType<any>,
): Promise<unknown> {
  if (hasStructuredOutput) {
    const output = await result.output;
    if (output === undefined) {
      throw new Error(
        "Agent: structured output was declared but the model returned none. " +
        "This usually means the model produced text that did not match the declared schema, " +
        "or the underlying SDK did not parse the structured output.",
      );
    }
    if (schema) {
      return schema.parse(output);
    }
    return output;
  }
  return await result.text;
}
