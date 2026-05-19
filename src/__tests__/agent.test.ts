import { describe, it, expect, vi } from "vitest";
import { Output } from "ai";
import { Agent } from "../agent";
import { defineTool } from "../tool-provider";
import { extractOutput } from "../utils";
import { z } from "zod";
import { createMockModel, testCtx, type TestCtx } from "./helpers";

describe("Agent", () => {
  describe("generate()", () => {
    it("returns text from the model", async () => {
      const agent = new Agent<TestCtx, string>({
        id: "test",
        model: createMockModel("Hello world"),
        prompt: (_ctx, input) => input,
      });

      const result = await agent.generate(testCtx, "Say hello");
      expect(result.text).toBe("Hello world");
    });

    it("resolves dynamic system and prompt", async () => {
      const model = createMockModel("response");
      const agent = new Agent<TestCtx, string>({
        id: "test",
        model: (_ctx) => model,
        system: (ctx) => `User: ${ctx.userId}`,
        prompt: (_ctx, input) => input,
      });

      const result = await agent.generate(testCtx, "test input");
      expect(result.text).toBe("response");

      // Verify the model was called (system prompt is folded into the prompt array by AI SDK)
      expect(model.doGenerateCalls).toHaveLength(1);
    });

    it("resolves async config fields in parallel", async () => {
      const order: string[] = [];

      const agent = new Agent<TestCtx, void>({
        id: "test",
        model: createMockModel("ok"),
        system: async () => {
          order.push("system-start");
          await new Promise((r) => setTimeout(r, 10));
          order.push("system-end");
          return "sys";
        },
        prompt: async () => {
          order.push("prompt-start");
          await new Promise((r) => setTimeout(r, 10));
          order.push("prompt-end");
          return "p";
        },
      });

      await agent.generate(testCtx);

      // Both should start before either ends (parallel via Promise.all)
      expect(order.indexOf("system-start")).toBeLessThan(order.indexOf("system-end"));
      expect(order.indexOf("prompt-start")).toBeLessThan(order.indexOf("prompt-end"));
      // The key assertion: both start before either finishes
      expect(order.indexOf("prompt-start")).toBeLessThan(order.indexOf("system-end"));
    });

    it("calls onStepFinish and onFinish callbacks with result key", async () => {
      const stepFinishSpy = vi.fn();
      const finishSpy = vi.fn();

      const agent = new Agent<TestCtx, string>({
        id: "test",
        model: createMockModel("done"),
        prompt: (_ctx, input) => input,
        onStepFinish: stepFinishSpy,
        onFinish: finishSpy,
      });

      await agent.generate(testCtx, "go");

      expect(stepFinishSpy).toHaveBeenCalledOnce();
      expect(stepFinishSpy).toHaveBeenCalledWith(
        expect.objectContaining({ ctx: testCtx, input: "go", result: expect.any(Object) })
      );
      expect(finishSpy).toHaveBeenCalledOnce();
      expect(finishSpy).toHaveBeenCalledWith(
        expect.objectContaining({ ctx: testCtx, input: "go", result: expect.any(Object) })
      );
    });

    it("calls onError and re-throws on failure", async () => {
      const onError = vi.fn();
      const model = createMockModel("x");
      model.doGenerate = async () => {
        throw new Error("model failure");
      };

      const agent = new Agent<TestCtx, string>({
        id: "test",
        model,
        prompt: (_ctx, input) => input,
        onError,
      });

      await expect(agent.generate(testCtx, "go")).rejects.toThrow("model failure");
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.any(Error),
          ctx: testCtx,
          input: "go",
        })
      );
    });
  });

  describe("stream()", () => {
    it("returns streamed text", async () => {
      const agent = new Agent<TestCtx, string>({
        id: "test",
        model: createMockModel("streamed"),
        prompt: (_ctx, input) => input,
      });

      const result = await agent.stream(testCtx, "go");
      const text = await result.text;
      expect(text).toBe("streamed");
    });

    it("supports textStream consumption", async () => {
      const agent = new Agent<TestCtx, string>({
        id: "test",
        model: createMockModel("chunk"),
        prompt: (_ctx, input) => input,
      });

      const result = await agent.stream(testCtx, "go");
      const chunks: string[] = [];
      for await (const chunk of result.textStream) {
        chunks.push(chunk);
      }
      expect(chunks.join("")).toBe("chunk");
    });
  });

  describe("asTool()", () => {
    it("compiles agent into a tool", async () => {
      const agent = new Agent<TestCtx, { task: string }>({
        id: "sub-agent",
        description: "A helper agent",
        input: z.object({ task: z.string() }),
        model: createMockModel("tool result"),
        prompt: (_ctx, input) => input.task,
      });

      const agentTool = agent.asTool(testCtx);
      expect(agentTool).toBeDefined();
      expect(agentTool.description).toBe("A helper agent");
    });

    it("throws without input schema", () => {
      const agent = new Agent<TestCtx, string>({
        id: "no-input",
        model: createMockModel("x"),
        prompt: (_ctx, input) => input,
      });

      expect(() => agent.asTool(testCtx)).toThrow('Agent "no-input": asTool() requires an input schema');
    });

    it("uses custom mapOutput when provided", async () => {
      const agent = new Agent<TestCtx, { task: string }, { processed: string }>({
        id: "sub",
        input: z.object({ task: z.string() }),
        model: createMockModel("raw output"),
        prompt: (_ctx, input) => input.task,
      });

      const agentTool = agent.asTool(testCtx, {
        mapOutput: (result) => ({ processed: result.text }),
      });

      const toolResult = await agentTool.execute!({ task: "test" }, {} as never);
      expect(toolResult).toEqual({ processed: "raw output" });
    });

    it("forwards abortSignal from ToolExecutionOptions to the sub-agent's generate call", async () => {
      const seenAbortSignals: Array<AbortSignal | undefined> = [];
      const model = createMockModel("ok");
      const originalDoGenerate = model.doGenerate;
      model.doGenerate = async (options) => {
        seenAbortSignals.push(options.abortSignal);
        return originalDoGenerate(options);
      };

      const subagent = new Agent<TestCtx, { task: string }>({
        id: "sub",
        model,
        input: z.object({ task: z.string() }),
        prompt: (_ctx, input) => input.task,
      });

      const controller = new AbortController();
      const agentTool = subagent.asTool(testCtx);
      await agentTool.execute!(
        { task: "go" },
        { abortSignal: controller.signal, toolCallId: "t1", messages: [] } as never,
      );

      expect(seenAbortSignals).toHaveLength(1);
      expect(seenAbortSignals[0]).toBe(controller.signal);
    });
  });

  describe("structured output", () => {
    it("throws when output schema is declared but the model returned no structured output", async () => {
      // Simulate the SDK returning `undefined` for the parsed output (e.g.,
      // the model produced text that didn't match the declared schema and the
      // SDK chose to surface it as undefined rather than throw).
      const fakeResult = {
        text: "irrelevant",
        output: Promise.resolve(undefined),
      };
      await expect(extractOutput(fakeResult, true)).rejects.toThrow(
        /structured output was declared but the model returned none/,
      );
    });

    it("validates output against the declared Zod schema at runtime", async () => {
      // Simulate the SDK returning an object that doesn't match the declared schema.
      // We do this by stubbing the result's `output` property.
      const fakeResult = {
        text: "irrelevant",
        output: Promise.resolve({ answer: 42 }), // wrong type — schema expects string
      };
      const schema = z.object({ answer: z.string() });
      // Zod v4 phrases this as "expected string, received number".
      await expect(extractOutput(fakeResult, true, schema)).rejects.toThrow(/expected string/i);
    });

    it("returns output unchanged when schema is omitted", async () => {
      const fakeResult = { output: Promise.resolve({ answer: 42 }), text: "" };
      await expect(extractOutput(fakeResult, true)).resolves.toEqual({ answer: 42 });
    });

    it("validateOutput rejects parsed output end-to-end through asTool()", async () => {
      // Build a real Agent with `output` (so the AI SDK parses structured output)
      // AND `validateOutput` (so we get a stricter post-hoc check). The model
      // returns JSON that satisfies the loose `output` schema but fails the
      // stricter `validateOutput` schema. The error must surface from
      // `asTool().execute()`, proving the validateOutput field is wired through
      // the Agent → extractOutput pipeline (agent.ts:218).
      const looseSchema = z.object({ answer: z.string() });
      const strictSchema = z.object({ answer: z.string().min(10) });

      // Mock model emits JSON text that the SDK's Output.object can parse:
      // matches looseSchema but the "answer" is only 2 chars, so strictSchema rejects it.
      const model = createMockModel('{"answer":"hi"}');

      const agent = new Agent<TestCtx, { task: string }, { answer: string }>({
        id: "structured-sub",
        description: "structured sub-agent",
        model,
        input: z.object({ task: z.string() }),
        output: Output.object({ schema: looseSchema }),
        validateOutput: strictSchema,
        prompt: (_ctx, input) => input.task,
      });

      const agentTool = agent.asTool(testCtx);
      // Zod v4 phrases this as something like "too small: expected string to have >=10 characters".
      await expect(
        agentTool.execute!({ task: "go" }, { toolCallId: "t1", messages: [] } as never),
      ).rejects.toThrow(/at least 10|>=\s*10|too[_ ]small/i);
    });
  });

  describe("stream() error handling", () => {
    // This case is handled by the `onError` config wired into streamText, not
    // by the synchronous try/catch around the `streamText(...)` call itself.
    // The sync-throw case (try/catch around the call) is covered by
    // agent.stream-sync-throw.test.ts via a module mock of `ai`.
    it("invokes onError when the model stream rejects asynchronously", async () => {
      const onError = vi.fn();
      const model = createMockModel("x");
      model.doStream = async () => {
        throw new Error("stream init failure");
      };

      const agent = new Agent<TestCtx, string>({
        id: "test",
        model,
        prompt: (_ctx, input) => input,
        onError,
      });

      await expect(agent.stream(testCtx, "go").then(r => r.text)).rejects.toThrow();
      expect(onError).toHaveBeenCalled();
    });
  });

  describe("tools resolution", () => {
    it("resolves ToolProvider instances with context", async () => {
      const define = defineTool<TestCtx>();
      const myTool = define({
        description: "test tool",
        input: z.object({ query: z.string() }),
        execute: async ({ query }, ctx) => `${ctx.userId}:${query}`,
      });

      const agent = new Agent<TestCtx, string>({
        id: "test",
        model: createMockModel("ok"),
        prompt: (_ctx, input) => input,
        tools: { myTool },
      });

      const result = await agent.generate(testCtx, "go");
      expect(result.text).toBe("ok");
    });

    it("resolves dynamic tools", async () => {
      const agent = new Agent<TestCtx, string>({
        id: "test",
        model: createMockModel("ok"),
        prompt: (_ctx, input) => input,
        tools: (ctx) => (ctx.userId === "user-1" ? {} : {}),
      });

      const result = await agent.generate(testCtx, "go");
      expect(result.text).toBe("ok");
    });

    it("asTool forwards the input schema via the v6 `inputSchema` key (not `parameters`)", () => {
      const inputSchema = z.object({ query: z.string() });
      const agent = new Agent<TestCtx, { query: string }>({
        id: "subagent",
        model: createMockModel("ok"),
        input: inputSchema,
        prompt: (_ctx, input) => input.query,
      });

      const tool = agent.asTool(testCtx) as unknown as Record<string, unknown>;
      expect(tool.inputSchema).toBe(inputSchema);
      expect(tool.parameters).toBeUndefined();
    });

    it("asToolProvider forwards the input schema via the v6 `inputSchema` key (not `parameters`)", () => {
      const inputSchema = z.object({ query: z.string() });
      const agent = new Agent<TestCtx, { query: string }>({
        id: "subagent",
        model: createMockModel("ok"),
        input: inputSchema,
        prompt: (_ctx, input) => input.query,
      });

      const provider = agent.asToolProvider();
      const tool = provider.createTool(testCtx) as unknown as Record<string, unknown>;
      expect(tool.inputSchema).toBe(inputSchema);
      expect(tool.parameters).toBeUndefined();
    });

    it("subagent tool reaches the parent model with a populated JSON schema", async () => {
      // Behavioral guard: regardless of how the wrapper is keyed, the parent model
      // must receive the subagent's input schema as a non-empty JSONSchema7. If the
      // schema is silently dropped (as it was when the wrapper used `parameters`),
      // the captured `inputSchema` here will be `{}` instead.
      const subagent = new Agent<TestCtx, { query: string }>({
        id: "subagent",
        model: createMockModel("ok"),
        input: z.object({ query: z.string() }),
        prompt: (_ctx, input) => input.query,
      });

      let capturedInputSchema: Record<string, unknown> | undefined;
      const parentModel = createMockModel("done");
      const originalDoGenerate = parentModel.doGenerate;
      parentModel.doGenerate = async (options) => {
        const fn = options.tools?.find((t) => t.type === "function");
        if (fn && fn.type === "function") {
          capturedInputSchema = fn.inputSchema as unknown as Record<string, unknown>;
        }
        return originalDoGenerate(options);
      };

      const parent = new Agent<TestCtx>({
        id: "parent",
        model: parentModel,
        prompt: () => "use the subagent",
        tools: () => ({ subagent: subagent.asTool(testCtx) }),
      });

      await parent.generate(testCtx);

      expect(capturedInputSchema).toBeDefined();
      expect(capturedInputSchema!.type).toBe("object");
      expect(capturedInputSchema!.properties).toMatchObject({ query: { type: "string" } });
    });
  });
});
