import { describe, it, expect } from "vitest";
import { tool, type Tool, type UIMessageStreamWriter } from "ai";
import { defineTool, isToolProvider, ToolProvider, TOOL_PROVIDER_BRAND, type IToolProvider } from "../tool-provider";
import { getActiveWriter, runWithWriter } from "../utils";
import { z } from "zod";
import { type TestCtx, testCtx } from "./helpers";

describe("defineTool", () => {
  it("creates a ToolProvider", () => {
    const define = defineTool<TestCtx>();
    const myTool = define({
      description: "test tool",
      input: z.object({ query: z.string() }),
      execute: async ({ query }, ctx) => `${ctx.userId}:${query}`,
    });

    expect(myTool).toBeInstanceOf(ToolProvider);
  });

  it("createTool returns a tool with injected context", async () => {
    const define = defineTool<TestCtx>();
    const myTool = define({
      description: "search",
      input: z.object({ query: z.string() }),
      execute: async ({ query }, ctx) => `result for ${ctx.userId}: ${query}`,
    });

    const tool = myTool.createTool(testCtx);
    expect(tool.description).toBe("search");

    const result = await tool.execute!({ query: "hello" }, {} as never);
    expect(result).toBe("result for user-1: hello");
  });

  it("forwards the input schema via the v6 `inputSchema` key (not `parameters`)", () => {
    const define = defineTool<TestCtx>();
    const inputSchema = z.object({ query: z.string() });
    const myTool = define({
      description: "search",
      input: inputSchema,
      execute: async () => "ok",
    });

    const tool = myTool.createTool(testCtx) as unknown as Record<string, unknown>;
    expect(tool.inputSchema).toBe(inputSchema);
    expect(tool.parameters).toBeUndefined();
  });
});

describe("isToolProvider", () => {
  it("returns true for ToolProvider instances", () => {
    const define = defineTool<TestCtx>();
    const provider = define({
      description: "test",
      input: z.object({ x: z.string() }),
      execute: async () => "ok",
    });

    expect(isToolProvider(provider)).toBe(true);
  });

  it("returns false for plain objects with createTool method (no brand)", () => {
    const fake = { createTool: () => ({}) };
    expect(isToolProvider(fake)).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(isToolProvider(null)).toBe(false);
    expect(isToolProvider(undefined)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isToolProvider(42)).toBe(false);
    expect(isToolProvider("string")).toBe(false);
    expect(isToolProvider(true)).toBe(false);
  });

  it("returns true for objects with the brand symbol", () => {
    const branded = { [TOOL_PROVIDER_BRAND]: true, createTool: () => ({}) };
    expect(isToolProvider(branded)).toBe(true);
  });
});

describe("getActiveWriter (public API for custom IToolProvider)", () => {
  it("returns undefined when not inside a streaming context", () => {
    expect(getActiveWriter()).toBeUndefined();
  });

  it("custom IToolProvider can reach the workflow writer from inside Tool.execute", async () => {
    // The built-in ToolProvider does this internally. This test demonstrates
    // that a user-implemented IToolProvider (one that does NOT use defineTool/
    // ToolProvider) can do the same via the public getActiveWriter export.
    let seenWriter: UIMessageStreamWriter | undefined;
    const customProvider: IToolProvider<TestCtx> = {
      [TOOL_PROVIDER_BRAND]: true,
      createTool(_ctx): Tool {
        return tool({
          description: "custom",
          inputSchema: z.object({ q: z.string() }),
          // CRITICAL: getActiveWriter() inside execute, not inside createTool.
          // createTool runs at agent setup; execute runs at tool invocation
          // when the workflow has actually entered streaming mode.
          execute: async () => {
            seenWriter = getActiveWriter();
            return "ok";
          },
        }) as unknown as Tool;
      },
    };

    const fakeWriter = { write: () => {}, merge: () => {} } as unknown as UIMessageStreamWriter;
    await runWithWriter(fakeWriter, async () => {
      const t = customProvider.createTool(testCtx);
      await t.execute!({ q: "x" }, {} as never);
    });

    expect(seenWriter).toBe(fakeWriter);
  });
});
