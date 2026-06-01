import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import type { WorkflowResult, GateSnapshot, WorkflowWarning } from "../workflow";

const mockUsage: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
};

const finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: "stop" };

export function createMockModel(text: string) {
  const doGenerate: LanguageModelV3GenerateResult = {
    content: [{ type: "text", text }],
    finishReason,
    usage: mockUsage,
    warnings: [],
  };

  return new MockLanguageModelV3({
    doGenerate,
    doStream: {
      stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: text },
        { type: "text-end", id: "text-1" },
        { type: "finish", finishReason, usage: mockUsage },
      ]),
    },
  });
}

// ── Signal-probe mock model ─────────────────────────────────────────
// createMockModel ignores abortSignal, so whether a caller forwards the signal
// to the model call is invisible. This model records the abortSignal it
// receives in `doGenerate` (via the `onCall` callback) and then returns
// normally — letting a test assert the signal was actually threaded into the
// model call WITHOUT having to abort (which would otherwise be masked by the
// run loop's own abort promotion).
export function createSignalProbeModel(text: string, onCall: (signal: AbortSignal | undefined) => void) {
  return new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: ((options: { abortSignal?: AbortSignal }): Promise<any> => {
      onCall(options?.abortSignal);
      return Promise.resolve({
        content: [{ type: "text", text }],
        finishReason,
        usage: mockUsage,
        warnings: [],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
    doStream: {
      stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: text },
        { type: "text-end", id: "text-1" },
        { type: "finish", finishReason, usage: mockUsage },
      ]),
    },
  });
}

export type TestCtx = {
  userId: string;
};

export const testCtx: TestCtx = { userId: "user-1" };

// ── Deferred promise barrier ────────────────────────────────────────
// Tests that coordinate concurrent state previously used `setTimeout`
// as a poor-man's barrier ("wait long enough that the other task hits
// its checkpoint"). That couples the test to wall-clock time and is
// flaky under load. `defer()` returns an externally-controllable promise
// so tests can hold tasks at a known point and release them deterministically.
export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

export function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (r?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── Tool-calling mock model ─────────────────────────────────────────
// Mock that emits a tool-call content part and reports finishReason
// "tool-calls" (instead of "stop"). Useful for asserting that callbacks
// (onFinish, onStepFinish) receive the non-"stop" finishReason intact.
//
// Note: a single tool-call response without a follow-up call typically
// makes the AI SDK stop after the first step. The mock emits only the
// tool-call step, which is enough to exercise the finishReason path
// through onFinish.
export function createToolCallingMockModel(opts: {
  toolName: string;
  toolInput: unknown;
}) {
  const toolCallId = "call-1";
  const inputJson = JSON.stringify(opts.toolInput);
  const toolCallsFinish: LanguageModelV3FinishReason = { unified: "tool-calls", raw: "tool_calls" };
  return new MockLanguageModelV3({
    doGenerate: {
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: opts.toolName,
          input: inputJson,
        },
      ],
      finishReason: toolCallsFinish,
      usage: mockUsage,
      warnings: [],
    } as unknown as LanguageModelV3GenerateResult,
    doStream: {
      stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
        {
          type: "tool-call",
          toolCallId,
          toolName: opts.toolName,
          input: inputJson,
        },
        {
          type: "finish",
          finishReason: toolCallsFinish,
          usage: mockUsage,
        },
      ]),
    },
  }) as unknown as MockLanguageModelV3;
}

// ── WorkflowResult discriminant helpers (F0) ────────────────────────

/**
 * Narrow a `WorkflowResult` to its `complete` variant for tests that expect
 * normal completion. Throws with a useful message when the workflow suspended
 * — much louder than a silent narrowing failure.
 */
export function expectComplete<T>(result: WorkflowResult<T>): { output: T; warnings: readonly WorkflowWarning[] } {
  if (result.status !== "complete") {
    throw new Error(
      `expectComplete: workflow suspended at gate "${result.snapshot.gateId}" instead of completing`
    );
  }
  return { output: result.output, warnings: result.warnings };
}

/**
 * Narrow to the `suspended` variant; returns the snapshot (always a
 * `GateSnapshot` — only gates suspend). Throws if the workflow completed
 * without suspending.
 */
export function expectSuspended<T>(result: WorkflowResult<T>): { snapshot: GateSnapshot; warnings: readonly WorkflowWarning[] } {
  if (result.status !== "suspended") {
    throw new Error(`expectSuspended: workflow completed without suspending`);
  }
  return { snapshot: result.snapshot, warnings: result.warnings };
}
