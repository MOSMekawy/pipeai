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
