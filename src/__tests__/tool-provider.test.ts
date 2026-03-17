import { describe, it, expect } from "vitest";
import { defineTool, isToolProvider, ToolProvider, TOOL_PROVIDER_BRAND } from "../tool-provider";
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
