import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";

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
