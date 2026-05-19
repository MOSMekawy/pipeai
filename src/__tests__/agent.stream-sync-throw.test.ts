import { describe, it, expect, vi } from "vitest";

// Mock the `ai` module BEFORE importing Agent so that `streamText` is replaced
// with a function that throws synchronously at call time. The sibling test
// file `agent.test.ts` exercises the async/`onError`-config path; this file
// exists to exercise the synchronous try/catch around the `streamText(...)`
// call itself (agent.ts: streamWithOptions). Without that try/catch, a
// synchronous throw would bypass the agent's `onError` entirely.
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: () => {
      throw new Error("synchronous streamText failure");
    },
  };
});

import { Agent } from "../agent";
import { createMockModel, testCtx, type TestCtx } from "./helpers";

describe("Agent.stream — synchronous streamText throw", () => {
  it("invokes onError and re-throws when streamText throws synchronously at the call site", async () => {
    const onError = vi.fn();
    const agent = new Agent<TestCtx, string>({
      id: "sync-throw",
      model: createMockModel("unused"),
      prompt: (_ctx, input) => input,
      onError,
    });

    await expect(agent.stream(testCtx, "go")).rejects.toThrow(
      /synchronous streamText failure/,
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
        ctx: testCtx,
        input: "go",
      }),
    );
  });

  it("re-throws even when no onError handler is configured", async () => {
    const agent = new Agent<TestCtx, string>({
      id: "sync-throw-no-handler",
      model: createMockModel("unused"),
      prompt: (_ctx, input) => input,
    });

    await expect(agent.stream(testCtx, "go")).rejects.toThrow(
      /synchronous streamText failure/,
    );
  });
});
