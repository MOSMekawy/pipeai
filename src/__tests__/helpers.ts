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

import type { WorkflowResult, GateSnapshot, WorkflowWarning } from "../workflow";

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
