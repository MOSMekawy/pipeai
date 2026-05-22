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

/**
 * Returns the active `UIMessageStreamWriter` if the current async context is
 * running inside a streaming workflow, or `undefined` otherwise.
 *
 * Use from inside a custom `IToolProvider`'s returned `Tool.execute` callback
 * to forward incremental output to the workflow's UI message stream:
 *
 * ```ts
 * import { getActiveWriter, type IToolProvider, TOOL_PROVIDER_BRAND } from "pipeai";
 *
 * const myProvider: IToolProvider<MyCtx> = {
 *   [TOOL_PROVIDER_BRAND]: true,
 *   createTool(ctx) {
 *     return tool({
 *       execute: async (input) => {
 *         const writer = getActiveWriter();
 *         // ...stream incremental progress to writer if present...
 *         return result;
 *       },
 *     });
 *   },
 * };
 * ```
 *
 * **Important timing note:** call this from *inside* the `Tool.execute`
 * callback, not from inside `createTool` itself. `createTool` runs during
 * agent setup (before the workflow has set the writer); `Tool.execute` runs
 * during tool invocation (when the writer is live).
 */
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
 * Minimal counting semaphore. Up to `permits` callers can hold a permit
 * concurrently; further `acquire()` calls queue FIFO until one is released.
 */
export class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore: permits must be a positive integer, got ${permits}`);
    }
    this.available = permits;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }
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

/**
 * Recursively freeze an object graph. Cycles are tracked via a WeakSet so we
 * never recurse into the same node twice. Maps/Sets stay structurally frozen
 * but `.set()`/`.add()` still mutate them — Object.freeze doesn't cover those.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value as object)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deepFreeze((value as any)[key], seen);
  }
  return value;
}
