import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
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
 * @internal — NOT part of the public API. Do not export from `index.ts`.
 *
 * Returns the active `UIMessageStreamWriter` if the current async context is
 * running inside a streaming workflow, or `undefined` otherwise.
 *
 * This is the internal mechanism that powers the writer hand-off to user code.
 * Consumers should reach the writer through the supported, explicit paths
 * instead of calling this directly:
 *   - `defineTool` / `ToolProvider` inject `writer` into the `execute(input,
 *     ctx, { writer })` options.
 *   - Agent `onStepFinish` / `onFinish` / `onError` callbacks receive `writer`.
 *   - Inline `Workflow.step(id, fn)` handlers receive `writer` in their params.
 *
 * **Timing note (for internal callers):** must be read from *inside* the live
 * execution callback (e.g. `Tool.execute`), not at construction/`createTool`
 * time — the writer is only set on the async context while an agent stream
 * call is in flight.
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
  // Already-frozen subtree (e.g. user-passed frozen ctx) — its children are
  // either also frozen or intentionally mutable, either way we should not recurse.
  if (Object.isFrozen(value)) return value;
  seen.add(value as object);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value as object)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deepFreeze((value as any)[key], seen);
  }
  return value;
}

// ── stepShapeHash (F1) ───────────────────────────────────────────────
//
// Recursive SHA-256 of the workflow's structural shape (index, type, id,
// nested workflow shapes). Used by checkpoint resume to detect drift —
// when the user inserts/removes/reorders a step, the hash changes and
// resume refuses to continue unless explicitly told to via
// `{ skipShapeCheck: true }`.
//
// **Agent identity is NOT in the hash.** Two checkpoints from runs that
// used different agent configs (same id) hash identically. Version agents
// by content if resume-trust matters.

/**
 * The minimal shape interface this util needs from a `SealedWorkflow`.
 * Importing the workflow class here would create a circular dependency
 * (utils.ts ← workflow.ts and workflow.ts ← utils.ts); so we accept any
 * object exposing `id` and `getStepsForShapeHash()`.
 */
export interface WorkflowShapeHashable {
  readonly id?: string;
  // Returns the StepNode[] for this workflow. Structurally typed to avoid
  // a circular import — the real type is `ReadonlyArray<StepNode>`.
  getStepsForShapeHash(): ReadonlyArray<StepNodeShape>;
}

/**
 * Structural typing for a StepNode as seen by the shape hasher. Mirrors
 * the actual `StepNode` union without importing it. Adding fields to
 * StepNode without updating this contract won't fail compilation; the
 * dispatch map in workflow.ts (typed via `Record<StepNode["type"], ...>`)
 * is the load-bearing exhaustiveness guard.
 */
export interface StepNodeShape {
  readonly type: string;
  readonly id: string;
}

export function computeStepShapeHash(
  steps: ReadonlyArray<StepNodeShape>,
  getNested: (node: StepNodeShape) => readonly WorkflowShapeHashable[],
): string {
  return createHash("sha256").update(canonicalDescriptor(steps, getNested, new WeakSet())).digest("hex");
}

/**
 * `path` tracks the current DFS stack only — added on entry, removed on exit.
 * Sibling re-visits of the same SealedWorkflow are NOT cycles (shared
 * subgraphs hash identically to two structurally-equivalent distinct
 * instances). Only ancestor re-visits (true cycles) emit the cycle marker.
 */
function canonicalDescriptor(
  steps: ReadonlyArray<StepNodeShape>,
  getNested: (node: StepNodeShape) => readonly WorkflowShapeHashable[],
  path: WeakSet<WorkflowShapeHashable>,
): string {
  return JSON.stringify(steps.map((s, i) => {
    const triple: (number | string)[] = [i, s.type, s.id];
    for (const inner of getNested(s)) {
      if (path.has(inner)) {
        triple.push(`<cycle:${inner.id ?? "anon"}>`);
        continue;
      }
      path.add(inner);
      try {
        triple.push(canonicalDescriptor(inner.getStepsForShapeHash(), getNested, path));
      } finally {
        path.delete(inner);
      }
    }
    return triple;
  }));
}

// ── warnOnce (F1) — module-level dedup helper ────────────────────────

const warnedOnceKeys = new Set<string>();
export function warnOnce(key: string, message?: string): void {
  if (warnedOnceKeys.has(key)) return;
  warnedOnceKeys.add(key);
  // eslint-disable-next-line no-console
  console.warn(message ?? key);
}

/**
 * @internal — test-only reset of the warnOnce dedup. Same shape as
 * workflow.ts's `__resetStreamOnErrorOnSuspendWarnForTests`.
 */
export function __resetWarnOnceForTests(): void {
  warnedOnceKeys.clear();
}
