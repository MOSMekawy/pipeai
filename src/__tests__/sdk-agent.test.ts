import { describe, it, expect, vi } from "vitest";
import { ToolLoopAgent, Output, tool, isStepCount } from "ai";
import { z } from "zod";
import { Agent } from "../agent";
import { Workflow } from "../workflow";
import { fromSdkAgent } from "../sdk-agent";
import { createMockModel, createToolCallingMockModel, expectComplete, testCtx, type TestCtx } from "./helpers";

describe("fromSdkAgent", () => {
  it("runs a v7 ToolLoopAgent as a workflow step (generate mode)", async () => {
    const sdkAgent = new ToolLoopAgent({
      id: "echo",
      model: createMockModel("hello from sdk agent"),
      instructions: "echo the input",
    });

    const step = fromSdkAgent<TestCtx, string, string>(sdkAgent, {
      mapInput: (_ctx, input) => ({ prompt: input }),
    });

    const pipeline = Workflow.create<TestCtx, string>().step(step);
    const { output } = expectComplete(await pipeline.generate(testCtx, "go"));
    expect(output).toBe("hello from sdk agent");
  });

  it("defaults the step id to the wrapped agent's id", () => {
    const sdkAgent = new ToolLoopAgent({ id: "my-sdk-agent", model: createMockModel("x"), instructions: "x" });
    const step = fromSdkAgent<TestCtx, string, string>(sdkAgent, { mapInput: (_c, i) => ({ prompt: i }) });
    expect(step.id).toBe("my-sdk-agent");
  });

  it("threads pipeai ctx into mapInput", async () => {
    const sdkAgent = new ToolLoopAgent({ id: "ctx-agent", model: createMockModel("ok"), instructions: "x" });
    const seen: string[] = [];
    const step = fromSdkAgent<TestCtx, string, string>(sdkAgent, {
      mapInput: (ctx, input) => { seen.push(ctx.userId); return { prompt: input }; },
    });
    await Workflow.create<TestCtx, string>().step(step).generate(testCtx, "go");
    expect(seen).toEqual(["user-1"]);
  });

  it("runs a v7 ToolLoopAgent as a workflow step (stream mode)", async () => {
    const sdkAgent = new ToolLoopAgent({
      id: "echo-stream",
      model: createMockModel("streamed out"),
      instructions: "echo the input",
    });
    const step = fromSdkAgent<TestCtx, string, string>(sdkAgent, { mapInput: (_c, i) => ({ prompt: i }) });

    const { output, stream } = Workflow.create<TestCtx, string>().step(step).stream(testCtx, "go");
    const reader = stream.getReader();
    while (!(await reader.read()).done) { /* drain the UI message stream */ }

    expect(expectComplete(await output).output).toBe("streamed out");
  });

  it("extracts structured output when hasOutput is set", async () => {
    const sdkAgent = new ToolLoopAgent({
      id: "structured",
      model: createMockModel('{"answer":"hi"}'),
      instructions: "x",
      output: Output.object({ schema: z.object({ answer: z.string() }) }),
    });
    const step = fromSdkAgent<TestCtx, string, { answer: string }>(sdkAgent, {
      mapInput: (_c, i) => ({ prompt: i }),
      hasOutput: true,
    });
    const { output } = expectComplete(await Workflow.create<TestCtx, string>().step(step).generate(testCtx, "go"));
    expect(output).toEqual({ answer: "hi" });
  });

  it("applies validateOutput to the structured output and rejects on mismatch", async () => {
    // Model emits JSON that satisfies the SDK `output` schema but fails the
    // stricter `validateOutput` guard — the Zod throw must reject the run.
    const sdkAgent = new ToolLoopAgent({
      id: "validated",
      model: createMockModel('{"answer":"hi"}'),
      instructions: "x",
      output: Output.object({ schema: z.object({ answer: z.string() }) }),
    });
    const step = fromSdkAgent<TestCtx, string, { answer: string }>(sdkAgent, {
      mapInput: (_c, i) => ({ prompt: i }),
      hasOutput: true,
      validateOutput: z.object({ answer: z.string().min(10) }),
    });
    await expect(
      Workflow.create<TestCtx, string>().step(step).generate(testCtx, "go"),
    ).rejects.toThrow(/at least 10|>=\s*10|too[_ ]small/i);
  });

  it("supports messages-form mapInput", async () => {
    const sdkAgent = new ToolLoopAgent({ id: "msg-agent", model: createMockModel("from messages"), instructions: "x" });
    const step = fromSdkAgent<TestCtx, string, string>(sdkAgent, {
      mapInput: (_c, input) => ({ messages: [{ role: "user", content: input }] }),
    });
    const { output } = expectComplete(await Workflow.create<TestCtx, string>().step(step).generate(testCtx, "hi"));
    expect(output).toBe("from messages");
  });

  it("throws when neither the wrapped agent nor options provides an id", () => {
    // A bare SdkAgentLike with no `id` — exercises the only runtime error the
    // adapter raises, without depending on ToolLoopAgent's id auto-generation.
    const idless = { generate: async () => ({}), stream: async () => ({}) };
    expect(() =>
      fromSdkAgent<TestCtx, string, string>(idless, { mapInput: (_c, i) => ({ prompt: i }) }),
    ).toThrow(/has no `id`/);
  });
});

describe("tool approval passthrough", () => {
  it("forwards `toolApproval` to the SDK so a denied tool is not executed", async () => {
    const execSpy = vi.fn(async () => "should not run");
    const agent = new Agent<TestCtx, string>({
      id: "approver",
      model: createToolCallingMockModel({ toolName: "danger", toolInput: { x: 1 } }),
      prompt: (_ctx, input) => input,
      // `stopWhen` bounds the loop so the denied tool-call doesn't re-emit forever.
      stopWhen: isStepCount(2),
      tools: {
        danger: tool({
          description: "dangerous",
          inputSchema: z.object({ x: z.number() }),
          execute: execSpy,
        }),
      },
      // Not a managed key — flows through pipeai's passthrough to generateText.
      toolApproval: { danger: "denied" },
    });

    await agent.generate(testCtx, "go");
    // Without the passthrough reaching the SDK the tool would execute; the
    // `denied` policy means execute must never be called.
    expect(execSpy).not.toHaveBeenCalled();
  });
});
