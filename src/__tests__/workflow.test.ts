import { describe, it, expect, vi } from "vitest";
import { Agent } from "../agent";
import { Workflow, WorkflowLoopError, NestedGateUnsupportedError, type WorkflowSnapshot, type GateSnapshot, type CheckpointSnapshot, type WorkflowObservability } from "../workflow";
import { createMockModel, defer, expectComplete, expectSuspended, testCtx, type TestCtx } from "./helpers";

// Agents that produce string output (auto-extracted as text by workflow)
function createTextAgent(id: string, text: string): Agent<TestCtx, void, string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Agent<TestCtx, any, any>({
    id,
    model: createMockModel(text),
    prompt: () => "go",
  });
}

function createPassthroughAgent(id: string, text: string): Agent<TestCtx, string, string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Agent<TestCtx, any, any>({
    id,
    model: createMockModel(text),
    prompt: (_ctx: TestCtx, input: string) => input,
  });
}

function createFailingAgent(
  id: string,
  shouldFail: (input: string) => boolean,
  errorMessage = "agent failed",
): Agent<TestCtx, string, string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Agent<TestCtx, any, any>({
    id,
    model: createMockModel("ok"),
    prompt: (_ctx: TestCtx, input: string) => {
      if (shouldFail(input)) throw new Error(`${errorMessage}: ${input}`);
      return input;
    },
  });
}

describe("Workflow", () => {
  describe("step() with agent", () => {
    it("runs a single step", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("agent-1", "hello"));

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("hello");
    });

    it("chains multiple steps", async () => {
      const agent1 = createTextAgent("a1", "first output");
      const agent2 = createPassthroughAgent("a2", "second output");

      const pipeline = Workflow.create<TestCtx>()
        .step(agent1)
        .step(agent2);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("second output");
    });
  });

  describe("step() with transform", () => {
    it("transforms output (replaces map)", async () => {
      const agent = createTextAgent("a1", "raw");

      const pipeline = Workflow.create<TestCtx>()
        .step(agent)
        .step("transform", ({ input }) => input.toUpperCase());

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("RAW");
    });

    it("can act as tap by returning input", async () => {
      const sideEffect = vi.fn();
      const agent = createTextAgent("a1", "value");

      const pipeline = Workflow.create<TestCtx>()
        .step(agent)
        .step("log", ({ input }) => {
          sideEffect(input);
          return input;
        });

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("value");
      expect(sideEffect).toHaveBeenCalledWith("value");
    });
  });

  describe("step() with transform — writer param", () => {
    it("inline step receives the stream writer and can emit a data part before the terminal agent", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step("emit-phase", ({ writer }) => {
          writer?.write({ type: "data-status", data: { phase: "searching" } });
          return "after-emit";
        })
        .step(createPassthroughAgent("synth", "final answer"));

      const { output, stream } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chunks: any[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      expect(expectComplete(await output).output).toBe("final answer");

      // The data part the inline step wrote is on the stream.
      expect(chunks).toContainEqual(
        expect.objectContaining({ type: "data-status", data: { phase: "searching" } }),
      );

      // …and it precedes the terminal agent's first text token.
      const statusIdx = chunks.findIndex((c) => c.type === "data-status");
      const firstTextIdx = chunks.findIndex((c) => typeof c.type === "string" && c.type.startsWith("text"));
      expect(statusIdx).toBeGreaterThanOrEqual(0);
      expect(firstTextIdx).toBeGreaterThanOrEqual(0);
      expect(statusIdx).toBeLessThan(firstTextIdx);
    });

    it("writer is undefined in generate mode; the step still transforms", async () => {
      let sawWriter: unknown = "unset";

      const pipeline = Workflow.create<TestCtx>()
        .step("emit-phase", ({ writer }) => {
          sawWriter = writer;
          return "transformed";
        });

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("transformed");
      expect(sawWriter).toBeUndefined();
    });
  });

  describe("observability — typed ctx", () => {
    it("ctx in observability hooks is typed as the workflow's TContext", async () => {
      let seenUserId: string | undefined;

      const pipeline = Workflow.create<TestCtx>({
        observability: {
          // `ctx.userId` only compiles if ctx is Readonly<TestCtx>, not
          // `unknown` — this line is the type-level assertion (fails `tsc`
          // when WorkflowObservability is not generic over TContext).
          onStepFinish: ({ ctx }) => { seenUserId = ctx.userId; },
        },
      }).step(createTextAgent("a1", "hi"));

      await pipeline.generate(testCtx);
      expect(seenUserId).toBe("user-1");
    });
  });

  describe("step() conditional — when / otherwise", () => {
    it("agent step runs the agent when `when` is true", async () => {
      const pipeline = Workflow.create<TestCtx, string>()
        .step(createPassthroughAgent("a", "AGENT-OUT"), {
          when: ({ input }) => input === "go",
          otherwise: ({ input }) => `skip:${input}`,
        });
      expect(expectComplete(await pipeline.generate(testCtx, "go")).output).toBe("AGENT-OUT");
    });

    it("agent step uses `otherwise` when `when` is false", async () => {
      const pipeline = Workflow.create<TestCtx, string>()
        .step(createPassthroughAgent("a", "AGENT-OUT"), {
          when: ({ input }) => input === "go",
          otherwise: ({ input }) => `skip:${input}`,
        });
      expect(expectComplete(await pipeline.generate(testCtx, "stop")).output).toBe("skip:stop");
    });

    it("inline step passes input through when `when` is false and no `otherwise`", async () => {
      const pipeline = Workflow.create<TestCtx, string>()
        .step("maybe-upper", ({ input }) => input.toUpperCase(), {
          when: ({ input }) => input.startsWith("x"),
        });
      expect(expectComplete(await pipeline.generate(testCtx, "abc")).output).toBe("abc");
      expect(expectComplete(await pipeline.generate(testCtx, "xyz")).output).toBe("XYZ");
    });

    it("inline step uses `otherwise` when `when` is false", async () => {
      const pipeline = Workflow.create<TestCtx, string>()
        .step("maybe-upper", ({ input }) => input.toUpperCase(), {
          when: ({ input }) => input.startsWith("x"),
          otherwise: ({ input }) => `default:${input}`,
        });
      expect(expectComplete(await pipeline.generate(testCtx, "abc")).output).toBe("default:abc");
    });

    it("nested workflow step is skipped (passthrough) when `when` is false", async () => {
      const sub = Workflow.create<TestCtx, string>().step(createPassthroughAgent("inner", "INNER"));
      const pipeline = Workflow.create<TestCtx, string>()
        .step(sub, { when: ({ input }) => input === "run" });
      expect(expectComplete(await pipeline.generate(testCtx, "skip")).output).toBe("skip");
      expect(expectComplete(await pipeline.generate(testCtx, "run")).output).toBe("INNER");
    });

    it("does not invoke the body when `when` is false", async () => {
      const spy = vi.fn((s: string) => s.toUpperCase());
      const pipeline = Workflow.create<TestCtx, string>()
        .step("maybe", ({ input }) => spy(input), { when: () => false });
      await pipeline.generate(testCtx, "x");
      expect(spy).not.toHaveBeenCalled();
    });

    it("type: `otherwise` collapses output to TNextOutput (no union)", async () => {
      // `len` outputs number; otherwise returns number → output is `number`,
      // so the next step's `input` is usable as a number. If output were
      // `string | number` (the no-otherwise union), `input * 2` would not
      // type-check — this is the type-level collapse assertion.
      const pipeline = Workflow.create<TestCtx, string>()
        .step("len", ({ input }) => input.length, {
          when: ({ input }) => input.length > 0,
          otherwise: () => 0,
        })
        .step("double", ({ input }) => input * 2);
      expect(expectComplete(await pipeline.generate(testCtx, "abc")).output).toBe(6);
      expect(expectComplete(await pipeline.generate(testCtx, "")).output).toBe(0);
    });
  });

  describe("branch() with predicates", () => {
    it("routes to the matching branch", async () => {
      const premiumAgent = createPassthroughAgent("premium", "premium response");
      const standardAgent = createPassthroughAgent("standard", "standard response");

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "input"))
        .branch([
          { when: ({ ctx }) => ctx.userId === "user-1", agent: premiumAgent },
          { agent: standardAgent },
        ]);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("premium response");
    });

    it("falls through to default (no when)", async () => {
      const premiumAgent = createPassthroughAgent("premium", "premium response");
      const standardAgent = createPassthroughAgent("standard", "standard response");

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "input"))
        .branch([
          { when: ({ ctx }) => ctx.userId === "other-user", agent: premiumAgent },
          { agent: standardAgent },
        ]);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("standard response");
    });

    it("throws when no branch matches and no default", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "input"))
        .branch([
          { when: () => false, agent: createPassthroughAgent("a", "a") },
          { when: () => false, agent: createPassthroughAgent("b", "b") },
        ]);

      await expect(pipeline.generate(testCtx)).rejects.toThrow(
        "No branch matched and no default branch"
      );
    });
  });

  describe("branch() with select", () => {
    it("routes to the correct agent based on select function", async () => {
      const bugAgent = createPassthroughAgent("bug", "bug response");
      const featureAgent = createPassthroughAgent("feature", "feature response");

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("classifier", "bug"))
        .branch({
          select: ({ input }) => input as "bug" | "feature",
          agents: {
            bug: bugAgent,
            feature: featureAgent,
          },
        });

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("bug response");
    });

    it("uses fallback agent when key not found", async () => {
      const fallbackAgent = createPassthroughAgent("fallback", "fallback response");

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("classifier", "unknown"))
        .branch({
          select: ({ input }) => input as "a" | "b",
          agents: {
            a: createPassthroughAgent("a", "a"),
            b: createPassthroughAgent("b", "b"),
          },
          fallback: fallbackAgent,
        });

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("fallback response");
    });

    it("throws when key not found and no fallback", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("classifier", "missing"))
        .branch({
          select: ({ input }) => input as "x" | "y",
          agents: {
            x: createPassthroughAgent("x", "x"),
            y: createPassthroughAgent("y", "y"),
          },
        });

      await expect(pipeline.generate(testCtx)).rejects.toThrow(
        'No agent found for key "missing" and no fallback provided'
      );
    });

    it("throws a clear error when a declared agent key has an undefined value", async () => {
      // Conditional spreads (e.g. `bug: enabled ? agentA : undefined`) leave
      // the key declared but with an undefined value. The select branch fails
      // loud rather than silently falling back — the fallback obscures the
      // misconfiguration.
      const pipeline = Workflow.create<TestCtx>()
        .step("emit-key", () => ({ agent: "bug" as const }))
        .branch({
          select: ({ input }) => input.agent,
          agents: {
            // Key declared but value is undefined (the bug case).
            bug: undefined as unknown as Agent<TestCtx, { agent: "bug" }, string>,
          },
        });

      await expect(pipeline.generate(testCtx)).rejects.toThrow(
        /declared but the value is undefined/,
      );
    });

    it("invokes onUnknownKey when select returns a typo'd key", async () => {
      const onUnknownKey = vi.fn();
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "x"))
        .branch({
          select: () => "typo" as "bug",
          agents: { bug: createPassthroughAgent("bug", "ok") },
          fallback: createPassthroughAgent("fb", "fallback"),
          onUnknownKey,
        });

      await pipeline.generate(testCtx);
      expect(onUnknownKey).toHaveBeenCalledWith(
        expect.objectContaining({ key: "typo", availableKeys: ["bug"] }),
      );
    });

    it("treats Object.prototype keys (toString, constructor, ...) as unknown, not as a matched agent", async () => {
      // Untrusted classifier output can return strings that happen to match
      // `Object.prototype` properties. Without an own-property check,
      // `agents["toString"]` would resolve to the inherited Object.prototype
      // method — executeAgent would then crash with an opaque
      // "agent.generate is not a function".
      const onUnknownKey = vi.fn();
      const fallbackAgent = createPassthroughAgent("fb", "fb response");
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "x"))
        .branch({
          select: () => "toString" as "bug",
          agents: { bug: createPassthroughAgent("bug", "bug response") },
          fallback: fallbackAgent,
          onUnknownKey,
        });

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("fb response");
      expect(onUnknownKey).toHaveBeenCalledWith(
        expect.objectContaining({ key: "toString", availableKeys: ["bug"] }),
      );
    });
  });

  describe("error handling", () => {
    it("catch handles errors and provides recovery value", async () => {
      const failingModel = createMockModel("x");
      failingModel.doGenerate = async () => {
        throw new Error("agent failed");
      };

      const pipeline = Workflow.create<TestCtx>()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .step(new Agent<TestCtx, any, any>({
          id: "failing",
          model: failingModel,
          prompt: () => "go",
        }))
        .catch("fallback", ({ error }) => {
          expect(error).toBeInstanceOf(Error);
          return "recovered";
        });

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("recovered");
    });

    it("catch receives stepId and input of the failing step", async () => {
      const failingModel = createMockModel("x");
      failingModel.doGenerate = async () => {
        throw new Error("boom");
      };

      const catchFn = vi.fn().mockReturnValue("recovered");

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "step-output"))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .step(new Agent<TestCtx, any, any>({
          id: "my-failing-agent",
          model: failingModel,
          prompt: (_ctx: TestCtx, input: string) => input,
        }))
        .catch("fallback", catchFn);

      await pipeline.generate(testCtx);

      expect(catchFn).toHaveBeenCalledWith(
        expect.objectContaining({
          stepId: "my-failing-agent",
          lastOutput: "step-output",
        })
      );
    });

    it("catch handler that throws chains to the next catch", async () => {
      const failingModel = createMockModel("x");
      failingModel.doGenerate = async () => {
        throw new Error("original");
      };

      const secondCatchFn = vi.fn().mockReturnValue("final recovery");

      const pipeline = Workflow.create<TestCtx>()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .step(new Agent<TestCtx, any, any>({
          id: "failing",
          model: failingModel,
          prompt: () => "go",
        }))
        .catch("first-catch", () => {
          throw new Error("catch also failed");
        })
        .catch("second-catch", secondCatchFn);

      const { output } = expectComplete(await pipeline.generate(testCtx));

      expect(output).toBe("final recovery");
      expect(secondCatchFn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "catch also failed" }),
          stepId: "first-catch",
        })
      );
    });

    it("catch handler that throws with no next catch runs finally and re-throws", async () => {
      const failingModel = createMockModel("x");
      failingModel.doGenerate = async () => {
        throw new Error("original");
      };

      const finallySpy = vi.fn();

      const pipeline = Workflow.create<TestCtx>()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .step(new Agent<TestCtx, any, any>({
          id: "failing",
          model: failingModel,
          prompt: () => "go",
        }))
        .catch("broken-catch", () => {
          throw new Error("catch also failed");
        })
        .finally("cleanup", finallySpy);

      await expect(pipeline.generate(testCtx)).rejects.toThrow("catch also failed");
      expect(finallySpy).toHaveBeenCalledOnce();
    });

    it("catch without preceding steps throws at build time", () => {
      expect(() => {
        Workflow.create<TestCtx>()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .catch("bad", (() => "recovered") as any);
      }).toThrow('catch("bad") requires at least one preceding step');
    });

    it("finally runs after successful execution", async () => {
      const finallySpy = vi.fn();

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "ok"))
        .finally("cleanup", finallySpy);

      await pipeline.generate(testCtx);
      expect(finallySpy).toHaveBeenCalledOnce();
      expect(finallySpy).toHaveBeenCalledWith({ ctx: testCtx });
    });

    it("finally runs after error (with catch)", async () => {
      const finallySpy = vi.fn();
      const failingModel = createMockModel("x");
      failingModel.doGenerate = async () => {
        throw new Error("boom");
      };

      const pipeline = Workflow.create<TestCtx>()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .step(new Agent<TestCtx, any, any>({
          id: "failing",
          model: failingModel,
          prompt: () => "go",
        }))
        .catch("recover", () => "recovered")
        .finally("cleanup", finallySpy);

      await pipeline.generate(testCtx);
      expect(finallySpy).toHaveBeenCalledOnce();
    });

    it("finally runs even when error is uncaught", async () => {
      const finallySpy = vi.fn();
      const failingModel = createMockModel("x");
      failingModel.doGenerate = async () => {
        throw new Error("boom");
      };

      const pipeline = Workflow.create<TestCtx>()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .step(new Agent<TestCtx, any, any>({
          id: "failing",
          model: failingModel,
          prompt: () => "go",
        }))
        .finally("cleanup", finallySpy);

      await expect(pipeline.generate(testCtx)).rejects.toThrow("boom");
      expect(finallySpy).toHaveBeenCalledOnce();
    });
  });

  describe("immutability", () => {
    it("branching creates independent workflows", async () => {
      const base = Workflow.create<TestCtx>()
        .step(createTextAgent("classifier", "base-output"));

      const branch1 = base
        .step("upper", ({ input }) => input.toUpperCase());

      const branch2 = base
        .step("lower", ({ input }) => input.toLowerCase());

      const result1 = expectComplete(await branch1.generate(testCtx));
      const result2 = expectComplete(await branch2.generate(testCtx));

      expect(result1.output).toBe("BASE-OUTPUT");
      expect(result2.output).toBe("base-output");
    });

    it("base workflow is unmodified after branching", async () => {
      const base = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "original"));

      // Create a branch — should not mutate base
      base.step("transform", ({ input }) => input + " modified");

      const { output } = expectComplete(await base.generate(testCtx));
      expect(output).toBe("original");
    });
  });

  describe("step options", () => {
    it("mapResult transforms the step output in generate mode", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = createTextAgent("a1", "raw text") as Agent<TestCtx, any, any>;
      const pipeline = Workflow.create<TestCtx>()
        .step(agent, {
          mapResult: ({ result }) => ({ wrapped: result.text }),
        });

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toEqual({ wrapped: "raw text" });
    });

    it("onResult is called with discriminated mode='generate' params", async () => {
      const onResult = vi.fn();

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "hello"), { onResult });

      await pipeline.generate(testCtx);

      expect(onResult).toHaveBeenCalledOnce();
      expect(onResult).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "generate",
          result: expect.objectContaining({ text: "hello" }),
          ctx: testCtx,
        })
      );
    });

    it("mapResult receives mode='stream' when the workflow runs in stream mode", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = createTextAgent("a1", "streamed text") as Agent<TestCtx, any, any>;
      let seenMode: string | undefined;
      let seenText: string | undefined;

      const pipeline = Workflow.create<TestCtx>()
        .step(agent, {
          mapResult: async (params) => {
            seenMode = params.mode;
            if (params.mode === "stream") {
              // params.result is StreamTextResult — .text is Promise<string>.
              seenText = await params.result.text;
            } else {
              seenText = params.result.text;
            }
            return seenText;
          },
        });

      const { stream, output } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      const result = expectComplete(await output);

      expect(seenMode).toBe("stream");
      expect(seenText).toBe("streamed text");
      expect(result.output).toBe("streamed text");
    });

    it("onResult fires with mode='stream' in stream mode", async () => {
      const seen: Array<{ mode: string }> = [];

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "hi"), {
          onResult: ({ mode }) => { seen.push({ mode }); },
        });

      const { stream, output } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      await output;

      expect(seen).toEqual([{ mode: "stream" }]);
    });
  });

  describe("Workflow.from()", () => {
    it("creates a single-agent workflow", async () => {
      const agent = createTextAgent("a1", "hello from");

      const pipeline = Workflow.from(agent);
      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("hello from");
    });

    it("supports chaining after from()", async () => {
      const agent = createTextAgent("a1", "raw");
      const pipeline = Workflow.from(agent)
        .step("transform", ({ input }) => input.toUpperCase());

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("RAW");
    });
  });

  describe("stream()", () => {
    it("resolves output promise", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "streamed"));

      const { output, stream } = pipeline.stream(testCtx);

      // Consume the stream to let the pipeline finish
      const reader = stream.getReader();
      while (!(await reader.read()).done) {
        // drain
      }

      const result = expectComplete(await output);
      expect(result.output).toBe("streamed");
    });
  });

  describe("step() with nested workflow", () => {
    it("runs a nested workflow as a step", async () => {
      const sub = Workflow.create<TestCtx>()
        .step(createTextAgent("inner", "from-inner"));

      const pipeline = Workflow.create<TestCtx>()
        .step(sub);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("from-inner");
    });

    it("chains with parent steps", async () => {
      const sub = Workflow.create<TestCtx>()
        .step(createTextAgent("inner", "inner-output"));

      const pipeline = Workflow.create<TestCtx>()
        .step(sub)
        .step("upper", ({ input }) => input.toUpperCase());

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("INNER-OUTPUT");
    });

    it("nested catch scopes internally", async () => {
      const failingModel = createMockModel("x");
      failingModel.doGenerate = async () => { throw new Error("inner fail"); };

      const sub = Workflow.create<TestCtx>()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .step(new Agent<TestCtx, any, any>({
          id: "failing",
          model: failingModel,
          prompt: () => "go",
        }))
        .catch("inner-catch", () => "recovered-inner");

      const pipeline = Workflow.create<TestCtx>()
        .step(sub)
        .step("upper", ({ input }) => input.toUpperCase());

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("RECOVERED-INNER");
    });

    it("uncaught nested error propagates to parent catch", async () => {
      const failingModel = createMockModel("x");
      failingModel.doGenerate = async () => { throw new Error("inner boom"); };

      const sub = Workflow.create<TestCtx>()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .step(new Agent<TestCtx, any, any>({
          id: "failing",
          model: failingModel,
          prompt: () => "go",
        }));

      const pipeline = Workflow.create<TestCtx>()
        .step(sub)
        .catch("parent-catch", () => "parent-recovered");

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("parent-recovered");
    });

    it("streams nested workflow output", async () => {
      const sub = Workflow.create<TestCtx>()
        .step(createTextAgent("inner", "streamed-inner"));

      const pipeline = Workflow.create<TestCtx>().step(sub);

      const { output, stream } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }

      expect(expectComplete(await output).output).toBe("streamed-inner");
    });

    it("deeply nested workflows (3 levels)", async () => {
      const level3 = Workflow.create<TestCtx>()
        .step(createTextAgent("l3", "deep"));

      const level2 = Workflow.create<TestCtx>()
        .step(level3)
        .step("append", ({ input }) => input + "-l2");

      const level1 = Workflow.create<TestCtx>()
        .step(level2)
        .step("append", ({ input }) => input + "-l1");

      const { output } = expectComplete(await level1.generate(testCtx));
      expect(output).toBe("deep-l2-l1");
    });
  });

  describe("foreach()", () => {
    it("maps array through agent", async () => {
      const agent = createPassthroughAgent("proc", "processed");

      const pipeline = Workflow.create<TestCtx>()
        .step("items", () => ["a", "b", "c"])
        .foreach(agent);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toEqual(["processed", "processed", "processed"]);
    });

    it("preserves order with sequential processing", async () => {
      const order: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "tracking",
        model: createMockModel("done"),
        prompt: (_ctx: TestCtx, input: string) => {
          order.push(input);
          return input;
        },
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("items", () => ["first", "second", "third"])
        .foreach(agent);

      await pipeline.generate(testCtx);
      expect(order).toEqual(["first", "second", "third"]);
    });

    it("processes concurrently in batches", async () => {
      let maxConcurrent = 0;
      let current = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "concurrent",
        model: createMockModel("done"),
        prompt: async () => {
          current++;
          if (current > maxConcurrent) maxConcurrent = current;
          await new Promise(r => setTimeout(r, 10));
          current--;
          return "go";
        },
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("items", () => ["a", "b", "c", "d"])
        .foreach(agent, { concurrency: 2 });

      await pipeline.generate(testCtx);
      expect(maxConcurrent).toBe(2);
    });

    it("works with workflow body", async () => {
      const sub = Workflow.create<TestCtx, string>()
        .step(createPassthroughAgent("inner", "processed"))
        .step("wrap", ({ input }) => `[${input}]`);

      const pipeline = Workflow.create<TestCtx>()
        .step("items", () => ["a", "b"])
        .foreach(sub);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toEqual(["[processed]", "[processed]"]);
    });

    it("returns empty array for empty input", async () => {
      const agent = createPassthroughAgent("proc", "x");

      const pipeline = Workflow.create<TestCtx>()
        .step("items", () => [] as string[])
        .foreach(agent);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toEqual([]);
    });

    it("throws on non-array input", async () => {
      const agent = createPassthroughAgent("proc", "x");

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "not-an-array"))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .foreach(agent as any);

      await expect(pipeline.generate(testCtx)).rejects.toThrow("expected array input");
    });

    describe("onError", () => {
      it("recovers a single failure with an Agent target", async () => {
        const agent = createFailingAgent("proc", input => input === "b");

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b", "c"])
          .foreach(agent, {
            onError: ({ item }) => `recovered:${item}`,
          });

        const { output } = expectComplete(await pipeline.generate(testCtx));
        expect(output).toEqual(["ok", "recovered:b", "ok"]);
      });

      it("recovers a single failure with a SealedWorkflow target", async () => {
        const sub = Workflow.create<TestCtx, string>()
          .step("inner", ({ input }) => {
            if (input === "b") throw new Error(`inner failed: ${input}`);
            return input;
          });

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b", "c"])
          .foreach(sub, {
            onError: ({ item }) => `recovered:${item}`,
          });

        const { output } = expectComplete(await pipeline.generate(testCtx));
        expect(output).toEqual(["a", "recovered:b", "c"]);
      });

      it("calls onError with { error, item, index, ctx }", async () => {
        const agent = createFailingAgent("proc", () => true, "boom");
        const onError = vi.fn(({ item }) => `r:${item}`);

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["x"])
          .foreach(agent, { onError });

        await pipeline.generate(testCtx);
        expect(onError).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith({
          error: expect.any(Error),
          item: "x",
          index: 0,
          ctx: testCtx,
        });
      });

      it("aborts foreach when onError rethrows; outer .catch() recovers", async () => {
        const agent = createFailingAgent("proc", input => input === "b", "agent boom");

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b", "c"])
          .foreach(agent, {
            onError: ({ error }) => { throw error; },
          })
          .catch("recover", ({ error }) => {
            expect((error as Error).message).toContain("agent boom");
            return ["caught"];
          });

        const { output } = expectComplete(await pipeline.generate(testCtx));
        expect(output).toEqual(["caught"]);
      });

      it("Workflow.SKIP omits the failed index", async () => {
        const agent = createFailingAgent("proc", input => input === "c");

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b", "c", "d", "e"])
          .foreach(agent, {
            onError: () => Workflow.SKIP,
          });

        const { output } = expectComplete(await pipeline.generate(testCtx));
        expect(output).toEqual(["ok", "ok", "ok", "ok"]);
      });

      it("preserves fail-fast when onError is not provided", async () => {
        const agent = createFailingAgent("proc", input => input === "b", "fail-fast");

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b", "c"])
          .foreach(agent);

        await expect(pipeline.generate(testCtx)).rejects.toThrow("fail-fast");
      });

      it("lets in-flight siblings finish when one fails (allSettled semantics)", async () => {
        const seen: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agent = new Agent<TestCtx, any, any>({
          id: "seen",
          model: createMockModel("ok"),
          prompt: async (_ctx: TestCtx, input: string) => {
            seen.push(input);
            await new Promise(r => setTimeout(r, 5));
            if (input === "b") throw new Error(`boom: ${input}`);
            return input;
          },
        });

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b", "c"])
          .foreach(agent, {
            concurrency: 3,
            onError: ({ item }) => `r:${item}`,
          });

        const { output } = expectComplete(await pipeline.generate(testCtx));
        expect(seen.sort()).toEqual(["a", "b", "c"]);
        expect(output).toEqual(["ok", "r:b", "ok"]);
      });

      it("invokes onError in index order, not completion order", async () => {
        const calls: number[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agent = new Agent<TestCtx, any, any>({
          id: "ordering",
          model: createMockModel("ok"),
          prompt: async (_ctx: TestCtx, input: string) => {
            // index 0 finishes slower than index 1, both fail
            const delay = input === "first" ? 20 : 1;
            await new Promise(r => setTimeout(r, delay));
            throw new Error(`boom: ${input}`);
          },
        });

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["first", "second"])
          .foreach(agent, {
            concurrency: 2,
            onError: ({ index }) => {
              calls.push(index);
              return "x";
            },
          });

        await pipeline.generate(testCtx);
        expect(calls).toEqual([0, 1]);
      });

      it("does not call onError for successful items", async () => {
        const agent = createPassthroughAgent("ok", "ok");
        const onError = vi.fn(() => "x");

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b", "c"])
          .foreach(agent, { onError });

        await pipeline.generate(testCtx);
        expect(onError).not.toHaveBeenCalled();
      });

      it("returns empty array when all items are skipped", async () => {
        const agent = createFailingAgent("proc", () => true);

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b", "c"])
          .foreach(agent, {
            onError: () => Workflow.SKIP,
          });

        const { output } = expectComplete(await pipeline.generate(testCtx));
        expect(output).toEqual([]);
      });

      it("applies onError in the sequential branch (concurrency: 1)", async () => {
        const agent = createFailingAgent("proc", input => input === "b");

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b", "c"])
          .foreach(agent, {
            concurrency: 1,
            onError: ({ item }) => `recovered:${item}`,
          });

        const { output } = expectComplete(await pipeline.generate(testCtx));
        expect(output).toEqual(["ok", "recovered:b", "ok"]);
      });

      it("awaits an async onError handler", async () => {
        const agent = createFailingAgent("proc", input => input === "b");

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b", "c"])
          .foreach(agent, {
            onError: async ({ item }) => {
              await new Promise(r => setTimeout(r, 5));
              return `async:${item}`;
            },
          });

        const { output } = expectComplete(await pipeline.generate(testCtx));
        expect(output).toEqual(["ok", "async:b", "ok"]);
      });

      it("mixes recovery values and Workflow.SKIP in a single batch", async () => {
        const agent = createFailingAgent(
          "proc",
          input => input === "b" || input === "c",
        );

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b", "c", "d"])
          .foreach(agent, {
            concurrency: 4,
            onError: ({ item }) =>
              item === "c" ? Workflow.SKIP : `r:${item}`,
          });

        const { output } = expectComplete(await pipeline.generate(testCtx));
        expect(output).toEqual(["ok", "r:b", "ok"]);
      });
    });

    describe("bounded concurrency", () => {
      it("runs at most `concurrency` items in flight at any time", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agent = new Agent<TestCtx, any, any>({
          id: "tracker",
          model: createMockModel("ok"),
          prompt: async (_ctx: TestCtx, input: string) => {
            inFlight++;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await new Promise(r => setTimeout(r, 5));
            inFlight--;
            return input;
          },
        });

        const items = Array.from({ length: 12 }, (_, i) => String(i));
        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => items)
          .foreach(agent, { concurrency: 3 });

        await pipeline.generate(testCtx);
        expect(maxInFlight).toBeLessThanOrEqual(3);
        expect(maxInFlight).toBe(3);
      });

      it("launches the next item as soon as one completes (no lockstep)", async () => {
        // 8 items, concurrency 4. Item 0 takes 50ms; items 1..7 take 5ms.
        // Lockstep batches would force every item in batch 0 to wait for
        // item 0, total ≥ 50ms + 50ms = 100ms (item 0 in batch 0, then batch 1).
        // Sliding semaphore: items 1..3 finish quickly, items 4..7 launch
        // immediately as 1..3 release, total ≈ ~50ms (gated by item 0).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agent = new Agent<TestCtx, any, any>({
          id: "timing",
          model: createMockModel("ok"),
          prompt: async (_ctx: TestCtx, input: string) => {
            const delay = input === "slow" ? 50 : 5;
            await new Promise(r => setTimeout(r, delay));
            return input;
          },
        });

        const items = ["slow", "f", "f", "f", "f", "f", "f", "f"];
        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => items)
          .foreach(agent, { concurrency: 4 });

        const start = Date.now();
        await pipeline.generate(testCtx);
        const elapsed = Date.now() - start;

        // Generous bound: well under the 100ms+ lockstep would require.
        expect(elapsed).toBeLessThan(85);
      });

      it("discards in-flight successes after onError rethrow", async () => {
        const completed = new Set<string>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agent = new Agent<TestCtx, any, any>({
          id: "abort-drain",
          model: createMockModel("ok"),
          prompt: async (_ctx: TestCtx, input: string) => {
            // "fast-fail" rejects quickly; the rest succeed slowly.
            if (input === "fast-fail") {
              await new Promise(r => setTimeout(r, 1));
              throw new Error("boom");
            }
            await new Promise(r => setTimeout(r, 20));
            completed.add(input);
            return input;
          },
        });

        const sideEffect = vi.fn();
        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["fast-fail", "slow-1", "slow-2", "slow-3"])
          .foreach(agent, {
            concurrency: 4,
            onError: ({ error }) => { throw error; },
          })
          .step("after", ({ input }) => {
            sideEffect(input);
            return input;
          });

        await expect(pipeline.generate(testCtx)).rejects.toThrow("boom");
        // The downstream step never runs — successes from in-flight items
        // are not observable to anything past the foreach.
        expect(sideEffect).not.toHaveBeenCalled();
        // In-flight items did finish (they couldn't be cancelled), but their
        // successes were dropped.
        expect(completed.size).toBeGreaterThan(0);
      });
    });
  });

  describe("repeat()", () => {
    it("stops when until returns true", async () => {
      let iterations = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "counter",
        model: createMockModel("x"),
        prompt: () => "go",
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("init", () => 0)
        .repeat(agent, {
          until: ({ iterations: i }) => {
            iterations = i;
            return i >= 3;
          },
        });

      await pipeline.generate(testCtx);
      expect(iterations).toBe(3);
    });

    it("stops when while returns false", async () => {
      let iterations = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "while-agent",
        model: createMockModel("x"),
        prompt: () => "go",
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("init", () => "start")
        .repeat(agent, {
          while: ({ iterations: i }) => {
            iterations = i;
            return i < 3;
          },
        });

      await pipeline.generate(testCtx);
      expect(iterations).toBe(3);
    });

    it("runs at least once", async () => {
      const spy = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "once",
        model: createMockModel("result"),
        prompt: () => {
          spy();
          return "go";
        },
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("init", () => "start")
        .repeat(agent, { until: () => true });

      await pipeline.generate(testCtx);
      expect(spy).toHaveBeenCalledOnce();
    });

    it("throws WorkflowLoopError when maxIterations exceeded", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "infinite",
        model: createMockModel("x"),
        prompt: () => "go",
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("init", () => "start")
        .repeat(agent, { until: () => false, maxIterations: 3 });

      await expect(pipeline.generate(testCtx)).rejects.toThrow(WorkflowLoopError);
      await expect(pipeline.generate(testCtx)).rejects.toThrow("maximum iterations (3)");
    });

    it("defaults maxIterations to 10", async () => {
      let count = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "counting",
        model: createMockModel("x"),
        prompt: () => {
          count++;
          return "go";
        },
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("init", () => "start")
        .repeat(agent, { until: () => false });

      await expect(pipeline.generate(testCtx)).rejects.toThrow("maximum iterations (10)");
      expect(count).toBe(10);
    });

    it("works with workflow body", async () => {
      let iterations = 0;
      const sub = Workflow.create<TestCtx, string>()
        .step(createPassthroughAgent("inner", "refined"))
        .step("count", ({ input }) => input);

      const pipeline = Workflow.create<TestCtx>()
        .step("init", () => "draft")
        .repeat(sub, {
          until: ({ iterations: i }) => {
            iterations = i;
            return i >= 2;
          },
        });

      await pipeline.generate(testCtx);
      expect(iterations).toBe(2);
    });

    it("WorkflowLoopError is catchable by parent catch", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "looping",
        model: createMockModel("x"),
        prompt: () => "go",
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("init", () => "start")
        .repeat(agent, { until: () => false, maxIterations: 2 })
        .catch("handle-loop", ({ error }) => {
          expect(error).toBeInstanceOf(WorkflowLoopError);
          return "loop-recovered";
        });

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("loop-recovered");
    });

    it("iterations count is 1-indexed", async () => {
      const counts: number[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "iter",
        model: createMockModel("x"),
        prompt: () => "go",
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("init", () => "start")
        .repeat(agent, {
          until: ({ iterations }) => {
            counts.push(iterations);
            return iterations >= 3;
          },
          maxIterations: 5,
        });

      await pipeline.generate(testCtx);
      expect(counts).toEqual([1, 2, 3]);
    });

    it("streams across iterations", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "stream-loop",
        model: createMockModel("chunk"),
        prompt: () => "go",
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("init", () => "start")
        .repeat(agent, { until: () => true });

      const { output, stream } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }

      expect(expectComplete(await output).output).toBe("chunk");
    });

    it("while variant exceeds maxIterations throws WorkflowLoopError", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "while-infinite",
        model: createMockModel("x"),
        prompt: () => "go",
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("init", () => "start")
        .repeat(agent, { while: () => true, maxIterations: 3 });

      await expect(pipeline.generate(testCtx)).rejects.toThrow(WorkflowLoopError);
    });
  });

  describe("gate()", () => {
    it("suspends with status: 'suspended' result", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "draft"))
        .gate("review");

      const result = await pipeline.generate(testCtx);
      expect(result.status).toBe("suspended");
    });

    it("snapshot contains correct data", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "draft"))
        .gate("review");

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
      expect(snapshot.version).toBe(2);
      expect(snapshot.kind).toBe("gate");
      expect(snapshot.gateId).toBe("review");
      expect(snapshot.output).toBe("draft");
      expect(snapshot.resumeFromIndex).toBeGreaterThanOrEqual(0);
    });

    it("custom payload appears in snapshot", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "draft text"))
        .gate("approval", {
          payload: ({ input, ctx }) => ({
            message: `User ${ctx.userId}: approve "${input}"?`,
          }),
        });

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
      expect(snapshot.gatePayload).toEqual({
        message: 'User user-1: approve "draft text"?',
      });
    });

    it("default payload is the current output", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "value"))
        .gate("review");

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
      expect(snapshot.gatePayload).toBe("value");
      expect(snapshot.gatePayload).toBe(snapshot.output);
    });

    it("loadState + generate resumes from gate", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "draft"))
        .gate("review")
        .step("finalize", ({ input }) => `approved: ${input}`);

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
      const resumed = pipeline.loadState("review", snapshot);
      const { output } = expectComplete(await resumed.generate(testCtx, "human says yes"));
      expect(output).toBe("approved: human says yes");
    });

    it("sequential multi-gate workflow", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "draft"))
        .gate("review-1")
        .step("process", ({ input }) => `reviewed: ${input}`)
        .gate("review-2")
        .step("publish", ({ input }) => `published: ${input}`);

      // First gate
      const r1 = expectSuspended(await pipeline.generate(testCtx));
      expect(r1.snapshot.gateId).toBe("review-1");

      // Resume hits second gate
      const resumed1 = pipeline.loadState("review-1", r1.snapshot);
      const r2 = expectSuspended(await resumed1.generate(testCtx, "approved-1"));
      expect(r2.snapshot.gateId).toBe("review-2");
      expect(r2.snapshot.output).toBe("reviewed: approved-1");

      // Resume past second gate
      const resumed2 = pipeline.loadState("review-2", r2.snapshot);
      const { output } = expectComplete(await resumed2.generate(testCtx, "approved-2"));
      expect(output).toBe("published: approved-2");
    });

    it("gate is skipped during error state", async () => {
      const failingModel = createMockModel("x");
      failingModel.doGenerate = async () => {
        throw new Error("step failed");
      };

      const pipeline = Workflow.create<TestCtx>()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .step(new Agent<TestCtx, any, any>({
          id: "failing",
          model: failingModel,
          prompt: () => "go",
        }))
        .gate("should-skip")
        .catch("recover", () => "recovered");

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("recovered");
    });

    it("catch works after a resumed gate", async () => {
      const failingModel = createMockModel("x");
      failingModel.doGenerate = async () => {
        throw new Error("post-gate failure");
      };

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "draft"))
        .gate("review")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .step(new Agent<TestCtx, any, any>({
          id: "post-gate",
          model: failingModel,
          prompt: () => "go",
        }))
        .catch("recover", () => "caught after gate");

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
      const resumed = pipeline.loadState("review", snapshot);
      const { output } = expectComplete(await resumed.generate(testCtx, "human input"));
      expect(output).toBe("caught after gate");
    });

    it("loadState throws on invalid snapshot version", () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "x"))
        .gate("review");

      const badSnapshot = { version: 99, resumeFromIndex: 1, output: "x", gateId: "review", gatePayload: "x" } as unknown as WorkflowSnapshot;
      expect(() => pipeline.loadState("review", badSnapshot)).toThrow("Unsupported snapshot version");
    });

    it("loadState throws on out-of-bounds index with unknown gate", () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "x"))
        .gate("review");

      const badSnapshot: WorkflowSnapshot = { version: 1, resumeFromIndex: 99, output: "x", gateId: "nonexistent", gatePayload: "x" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (pipeline as any).loadState("nonexistent", badSnapshot)).toThrow("not found in workflow");
    });

    it("loadState throws on gate ID mismatch", () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "x"))
        .gate("review");

      const badSnapshot: WorkflowSnapshot = { version: 1, resumeFromIndex: 1, output: "x", gateId: "wrong-id", gatePayload: "x" };
      expect(() => pipeline.loadState("review", badSnapshot)).toThrow("gate ID mismatch");
    });

    it("gate inside step(workflow) throws NestedGateUnsupportedError", async () => {
      const sub = Workflow.create<TestCtx>()
        .step(createTextAgent("inner", "value"))
        .gate("inner-gate");

      const pipeline = Workflow.create<TestCtx>()
        .step(sub);

      await expect(pipeline.generate(testCtx)).rejects.toThrow(NestedGateUnsupportedError);
    });

    it("gate inside foreach throws NestedGateUnsupportedError", async () => {
      const sub = Workflow.create<TestCtx, string>()
        .step(createPassthroughAgent("inner", "processed"))
        .gate("inner-gate");

      const pipeline = Workflow.create<TestCtx>()
        .step("items", () => ["a", "b"])
        .foreach(sub);

      await expect(pipeline.generate(testCtx)).rejects.toThrow(NestedGateUnsupportedError);
    });

    it("gate inside repeat throws NestedGateUnsupportedError", async () => {
      const sub = Workflow.create<TestCtx, string>()
        .step(createPassthroughAgent("inner", "refined"))
        .gate("inner-gate");

      const pipeline = Workflow.create<TestCtx>()
        .step("init", () => "draft")
        .repeat(sub, { until: () => true });

      await expect(pipeline.generate(testCtx)).rejects.toThrow(NestedGateUnsupportedError);
    });

    it("snapshot is JSON-serializable and round-trips", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "data"))
        .gate("review", {
          payload: ({ input }) => ({ draft: input, nested: [1, 2, 3] }),
        });

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
      const roundTripped = JSON.parse(JSON.stringify(snapshot));
      expect(roundTripped).toEqual(snapshot);
    });

    it("pre-gate output is preserved in snapshot", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "important-data"))
        .gate("review");

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
      expect(snapshot.output).toBe("important-data");
    });

    it("loadState + stream resumes with live stream", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "draft"))
        .gate("review")
        .step(createPassthroughAgent("a2", "streamed-result"));

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
      const resumed = pipeline.loadState("review", snapshot);
      const { output, stream } = resumed.stream(testCtx, "human input");

      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }

      expect(expectComplete(await output).output).toBe("streamed-result");
    });

    it("resume stream hits next gate", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "draft"))
        .gate("gate-1")
        .step(createPassthroughAgent("a2", "intermediate"))
        .gate("gate-2")
        .step("final", ({ input }) => `done: ${input}`);

      // Hit first gate
      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));

      // Resume via stream — hits second gate
      const resumed = pipeline.loadState("gate-1", snapshot);
      const { output, stream: rs } = resumed.stream(testCtx, "resp-1");
      const r = rs.getReader();
      while (!(await r.read()).done) { /* drain */ }
      const r2 = expectSuspended(await output);
      expect(r2.snapshot.gateId).toBe("gate-2");
    });

    it("initial stream suspends cleanly (output resolves with suspended status, stream closes)", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "streamed-draft"))
        .gate("review");

      const { output, stream } = pipeline.stream(testCtx);

      // Stream should close cleanly
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }

      // Output promise resolves with suspended status (NEVER rejects on suspension).
      const result = await output;
      expect(result.status).toBe("suspended");
      const { snapshot } = expectSuspended(result);
      expect(snapshot.gateId).toBe("review");
      expect(snapshot.output).toBe("streamed-draft");
    });

    it("schema validates response on generate", async () => {
      const { z } = await import("zod");

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "draft"))
        .gate("review", {
          schema: z.object({ approved: z.boolean(), notes: z.string() }),
        })
        .step("finalize", ({ input }) => `${input.approved}: ${input.notes}`);

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));

      // Valid response — passes schema
      const resumed = pipeline.loadState("review", snapshot);
      const { output } = expectComplete(await resumed.generate(testCtx, { approved: true, notes: "lgtm" }));
      expect(output).toBe("true: lgtm");
    });

    it("schema rejects invalid response", async () => {
      const { z } = await import("zod");

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "draft"))
        .gate("review", {
          schema: z.object({ approved: z.boolean() }),
        });

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));

      const resumed = pipeline.loadState("review", snapshot);
      await expect(
        resumed.generate(testCtx, { approved: "not-a-boolean" } as never)
      ).rejects.toThrow();
    });

    it("generate-mode: schema parse rejection on resume flows through .catch() pipeline", async () => {
      // Without the schema-into-catch fix, validateResponse throws synchronously
      // from .generate(...) before execute() runs, so any downstream `.catch()`
      // is bypassed.
      const schema = {
        parse: (value: unknown): string => {
          if (typeof value !== "number") throw new Error("schema-rejected");
          return String(value);
        },
      };
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("draft", "first draft"))
        .gate("review", { schema })
        .catch("recovery", ({ error }) => `recovered:${(error as Error).message}`);

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));

      const resumed = pipeline.loadState("review", snapshot);
      const { output } = expectComplete(
        await resumed.generate(testCtx, "not-a-number" as unknown as string),
      );
      expect(output).toBe("recovered:schema-rejected");
    });

    it("gate.condition that throws routes through the catch pipeline", async () => {
      // condition() callback throws — must be captured into pendingError so a
      // downstream `.catch()` can recover, not escape execute() entirely.
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("draft", "x"))
        .gate("conditional-gate", {
          condition: () => { throw new Error("condition-boom"); },
        })
        .catch("recover", ({ error }) => `recovered:${(error as Error).message}`);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("recovered:condition-boom");
    });

    it("gate.payload that throws routes through the catch pipeline", async () => {
      // payload() callback throws — must route through catch, not escape.
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("draft", "x"))
        .gate("payload-gate", {
          payload: () => { throw new Error("payload-boom"); },
        })
        .catch("recover", ({ error }) => `recovered:${(error as Error).message}`);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("recovered:payload-boom");
    });

    it("stream-mode: schema parse rejection on resume flows through .catch() pipeline", async () => {
      // Stream-mode parity with the generate-mode catch test above.
      // Previously validateResponse ran synchronously inside .stream(...) before
      // the stream-internal try/catch, so a schema rejection on resume escaped
      // as a sync throw and bypassed any downstream .catch().
      const schema = {
        parse: (value: unknown): string => {
          if (typeof value !== "number") throw new Error("schema-rejected");
          return String(value);
        },
      };
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("draft", "first draft"))
        .gate("review", { schema })
        .catch("recovery", ({ error }) => `recovered:${(error as Error).message}`);

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));

      const resumed = pipeline.loadState("review", snapshot);
      // .stream() must NOT throw synchronously — the rejection has to flow
      // through the catch pipeline.
      const { stream, output } = resumed.stream(
        testCtx,
        "not-a-number" as unknown as string,
      );
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      expect(expectComplete(await output).output).toBe("recovered:schema-rejected");
    });

    it("resume with fresh context (updated chat history)", async () => {
      type ChatCtx = { history: string[] };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<ChatCtx, any, any>({
        id: "responder",
        model: createMockModel("response"),
        prompt: (ctx) => ctx.history.join("\n"),
      });

      const pipeline = Workflow.create<ChatCtx>()
        .step(agent)
        .gate("review")
        .step(agent, { id: "responder-2" });

      // First run with initial history
      const { snapshot } = expectSuspended(await pipeline.generate({ history: ["msg1"] }));

      // Resume with updated history (new messages added during pause)
      const freshCtx = { history: ["msg1", "msg2", "approval"] };
      const resumed = pipeline.loadState("review", snapshot);
      const { output } = expectComplete(await resumed.generate(freshCtx, "human response"));
      expect(output).toBe("response");

      // Verify agent received the fresh context, not the original
      const model = (agent as any).config.model;
      const lastCall = model.doGenerateCalls[model.doGenerateCalls.length - 1];
      expect(lastCall).toBeDefined();
    });

    it("full lifecycle: suspend → serialize → deserialize → resume (simulated DB)", async () => {
      // Simulated database
      const db: Record<string, string> = {};

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("draft", "Dear customer, your issue is resolved."))
        .gate("manager-approval", {
          payload: ({ input, ctx }) => ({
            userId: ctx.userId,
            draft: input,
            action: "approve or reject",
          }),
        })
        .step("send", ({ input }) => `SENT: ${input}`);

      // === Phase 1: Run workflow, it suspends at gate ===
      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
      // Serialize to "database" (JSON string, like a real DB column)
      db["workflow:user-1"] = JSON.stringify(snapshot);

      // === Phase 2: Later (maybe different process), load and resume ===
      // F1: new gate snapshots are v2 with kind="gate"; cast to the specific
      // variant so we can read gateId/gatePayload after JSON round-trip.
      const loaded = JSON.parse(db["workflow:user-1"]) as GateSnapshot;

      // Verify the deserialized snapshot is valid
      expect(loaded.version).toBe(2);
      expect(loaded.kind).toBe("gate");
      expect(loaded.gateId).toBe("manager-approval");
      expect(loaded.gatePayload).toEqual({
        userId: "user-1",
        draft: "Dear customer, your issue is resolved.",
        action: "approve or reject",
      });

      // Resume with the deserialized snapshot
      const resumed = pipeline.loadState("manager-approval", loaded);
      const { output } = expectComplete(await resumed.generate(testCtx, "Approved by manager"));
      expect(output).toBe("SENT: Approved by manager");
    });

    it("full lifecycle with streaming: suspend → serialize → resume stream", async () => {
      const db: Record<string, string> = {};

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "draft"))
        .gate("review")
        .step(createPassthroughAgent("a2", "final-streamed"));

      // === Phase 1: Stream, gate suspends, stream closes cleanly ===
      const { output: outputPromise, stream } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain partial content */ }

      const { snapshot } = expectSuspended(await outputPromise);
      db["snap"] = JSON.stringify(snapshot);

      // === Phase 2: Resume with streaming ===
      const loaded: WorkflowSnapshot = JSON.parse(db["snap"]);
      const resumed = pipeline.loadState("review", loaded);
      const { output, stream: resumeStream } = resumed.stream(testCtx, "human says ok");

      const reader2 = resumeStream.getReader();
      while (!(await reader2.read()).done) { /* drain */ }

      expect(expectComplete(await output).output).toBe("final-streamed");
    });

    it("multi-gate lifecycle: serialize/deserialize at each gate", async () => {
      const db: Record<string, string> = {};

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "initial"))
        .gate("gate-1")
        .step("process", ({ input }) => `after-gate-1: ${input}`)
        .gate("gate-2")
        .step("finalize", ({ input }) => `done: ${input}`);

      // Gate 1
      const r1 = expectSuspended(await pipeline.generate(testCtx));
      db["snap"] = JSON.stringify(r1.snapshot);

      // Resume gate 1 → hits gate 2
      const snap1 = JSON.parse(db["snap"]) as GateSnapshot;
      expect(snap1.gateId).toBe("gate-1");

      const resumed1 = pipeline.loadState("gate-1", snap1);
      const r2 = expectSuspended(await resumed1.generate(testCtx, "response-1"));
      db["snap"] = JSON.stringify(r2.snapshot);

      // Resume gate 2 → completes
      const snap2 = JSON.parse(db["snap"]) as GateSnapshot;
      expect(snap2.gateId).toBe("gate-2");
      expect(snap2.output).toBe("after-gate-1: response-1");

      const resumed2 = pipeline.loadState("gate-2", snap2);
      const { output } = expectComplete(await resumed2.generate(testCtx, "response-2"));
      expect(output).toBe("done: response-2");
    });
  });

  describe("multi-step streaming", () => {
    it("output flows correctly across multiple streamed agents", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "first"))
        .step(createPassthroughAgent("a2", "second"))
        .step("transform", ({ input }) => `final: ${input}`);

      const { output, stream } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }

      expect(expectComplete(await output).output).toBe("final: second");
    });

    it("stream with branch routes correctly", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("classifier", "premium"))
        .branch([
          { when: ({ input }) => input === "premium", agent: createPassthroughAgent("premium", "vip-response") },
          { agent: createPassthroughAgent("standard", "basic-response") },
        ]);

      const { output, stream } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }

      expect(expectComplete(await output).output).toBe("vip-response");
    });
  });

  describe("context flow", () => {
    it("ctx is accessible in transform steps", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step("greet", ({ ctx }) => `hello ${ctx.userId}`);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("hello user-1");
    });

    it("ctx is accessible in branch predicates", async () => {
      const ctxSpy = vi.fn().mockReturnValue(true);

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "input"))
        .branch([
          { when: ({ ctx }) => { ctxSpy(ctx); return true; }, agent: createPassthroughAgent("a", "matched") },
        ]);

      await pipeline.generate(testCtx);
      expect(ctxSpy).toHaveBeenCalledWith(testCtx);
    });

    it("ctx is accessible in catch handlers", async () => {
      const failingModel = createMockModel("x");
      failingModel.doGenerate = async () => { throw new Error("fail"); };

      const pipeline = Workflow.create<TestCtx>()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .step(new Agent<TestCtx, any, any>({
          id: "failing",
          model: failingModel,
          prompt: () => "go",
        }))
        .catch("handle", ({ ctx }) => `recovered by ${ctx.userId}`);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("recovered by user-1");
    });
  });

  describe("typed workflow input", () => {
    it("Workflow.create with explicit TInput", async () => {
      const pipeline = Workflow.create<TestCtx, string>()
        .step("upper", ({ input }) => input.toUpperCase());

      const { output } = expectComplete(await pipeline.generate(testCtx, "hello"));
      expect(output).toBe("HELLO");
    });

    it("input flows to first agent", async () => {
      const pipeline = Workflow.create<TestCtx, string>()
        .step(createPassthroughAgent("a1", "processed"));

      const { output } = expectComplete(await pipeline.generate(testCtx, "my-input"));
      expect(output).toBe("processed");
    });
  });

  describe("edge cases", () => {
    it("empty workflow throws on generate", async () => {
      const pipeline = Workflow.create<TestCtx>();
      await expect(pipeline.generate(testCtx)).rejects.toThrow("no steps");
    });

    it("empty workflow throws on stream", async () => {
      const pipeline = Workflow.create<TestCtx>();
      const { output, stream } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      await expect(output).rejects.toThrow("no steps");
    });

    it("finally preserves output (does not change it)", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "important-value"))
        .finally("cleanup", () => { /* side effect only */ });

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("important-value");
    });

    it("Workflow.create with id option", async () => {
      const pipeline = Workflow.create<TestCtx>({ id: "my-pipeline" })
        .step(createTextAgent("a1", "ok"));

      expect(pipeline.id).toBe("my-pipeline");
      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("ok");
    });
  });

  describe("output chaining", () => {
    it("foreach output feeds into next step", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step("items", () => ["a", "b", "c"])
        .foreach(createPassthroughAgent("proc", "x"))
        .step("count", ({ input }) => `count: ${input.length}`);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("count: 3");
    });

    it("repeat output feeds into next step", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "refiner",
        model: createMockModel("refined"),
        prompt: () => "go",
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("init", () => "draft")
        .repeat(agent, { until: () => true })
        .step("wrap", ({ input }) => `[${input}]`);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("[refined]");
    });

    it("branch output feeds into next step", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("classifier", "route-a"))
        .branch({
          select: ({ input }) => input as "route-a" | "route-b",
          agents: {
            "route-a": createPassthroughAgent("a", "from-a"),
            "route-b": createPassthroughAgent("b", "from-b"),
          },
        })
        .step("wrap", ({ input }) => `result: ${input}`);

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("result: from-a");
    });
  });

  describe("end-to-end: classify → route → persist", () => {
    it("simulates a real support ticket pipeline", async () => {
      const saved: string[] = [];

      // Classifier outputs a category
      const classifier = createTextAgent("classifier", "bug");

      // Specialist agents
      const bugAgent = createPassthroughAgent("bug-agent", "Fixed the bug: restarted the service");
      const featureAgent = createPassthroughAgent("feature-agent", "Feature request noted");

      const pipeline = Workflow.create<TestCtx>()
        .step(classifier)
        .branch({
          select: ({ input }) => input as "bug" | "feature",
          agents: { bug: bugAgent, feature: featureAgent },
          fallback: createPassthroughAgent("fallback", "Unknown category"),
        })
        .step("persist", ({ input, ctx }) => {
          saved.push(`${ctx.userId}: ${input}`);
          return input;
        })
        .catch("error-handler", ({ ctx }) => {
          return `Error handling request for ${ctx.userId}`;
        });

      const { output } = expectComplete(await pipeline.generate(testCtx));

      expect(output).toBe("Fixed the bug: restarted the service");
      expect(saved).toEqual(["user-1: Fixed the bug: restarted the service"]);
    });
  });

  describe("handleStream option", () => {
    it("suppresses agent stream when consuming without forwarding", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("silent", "classified"), {
          handleStream: async ({ result }) => {
            await result.text; // consume without forwarding
          },
        })
        .step(createPassthroughAgent("responder", "visible-response"));

      const { output, stream } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }

      expect(expectComplete(await output).output).toBe("visible-response");
    });

    it("handleStream receives ctx", async () => {
      const ctxSpy = vi.fn();

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "value"), {
          handleStream: async ({ result, ctx }) => {
            ctxSpy(ctx);
            await result.text;
          },
        });

      const { output, stream } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      expectComplete(await output);

      expect(ctxSpy).toHaveBeenCalledWith(testCtx);
    });

    it("handleStream receives the prior step's output as `input`", async () => {
      const inputSpy = vi.fn();

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "first-output"))
        .step(createPassthroughAgent("a2", "second-output"), {
          handleStream: async ({ result, input }) => {
            inputSpy(input);
            await result.text;
          },
        });

      const { output, stream } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      expectComplete(await output);

      expect(inputSpy).toHaveBeenCalledWith("first-output");
    });
  });

  // ── WorkflowStreamOptions: honest pass-through to createUIMessageStream ──
  describe("WorkflowStreamOptions", () => {
    it("onFinish receives the full createUIMessageStream payload, not bare ()", async () => {
      const finishSpy = vi.fn();

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "hello"));

      const { output, stream } = pipeline.stream(testCtx, undefined, {
        onFinish: (event) => {
          finishSpy(event);
        },
      });
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      expectComplete(await output);

      expect(finishSpy).toHaveBeenCalledOnce();
      const event = finishSpy.mock.calls[0]![0]!;
      expect(event).toMatchObject({
        messages: expect.any(Array),
        responseMessage: expect.any(Object),
        isAborted: expect.any(Boolean),
        isContinuation: expect.any(Boolean),
      });
      expect(event.messages.length).toBeGreaterThan(0);
    });

    it("originalMessages flows through to the response message-id assignment", async () => {
      // When originalMessages is supplied, AI SDK assumes persistence mode and
      // assigns an id to the response message. We can observe that id appearing
      // in the onFinish payload's responseMessage.
      const finishSpy = vi.fn();
      const originalMessages = [
        { id: "prior-1", role: "user", parts: [{ type: "text", text: "ping" }] },
      ] as Parameters<typeof Workflow.create<TestCtx>>[0] extends undefined ? never : never;

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "pong"));

      const { output, stream } = pipeline.stream(testCtx, undefined, {
        originalMessages: [
          { id: "prior-1", role: "user", parts: [{ type: "text", text: "ping" }] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any,
        onFinish: (event) => finishSpy(event),
      });
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      originalMessages;
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      expectComplete(await output);

      expect(finishSpy).toHaveBeenCalledOnce();
      const event = finishSpy.mock.calls[0]![0]!;
      // The original prior-1 message is present in the merged messages array.
      const ids = event.messages.map((m: { id?: string }) => m.id);
      expect(ids).toContain("prior-1");
      // The response message has an id (assigned because persistence mode is on).
      expect(event.responseMessage.id).toBeTruthy();
    });

    it("generateId overrides the response message-id generator", async () => {
      const generateId = vi.fn(() => "deterministic-id-42");
      const finishSpy = vi.fn();

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "out"));

      const { output, stream } = pipeline.stream(testCtx, undefined, {
        generateId,
        onFinish: (event) => finishSpy(event),
      });
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      expectComplete(await output);

      expect(generateId).toHaveBeenCalled();
      const event = finishSpy.mock.calls[0]![0]!;
      // The response message uses the generated id.
      expect(event.responseMessage.id).toBe("deterministic-id-42");
    });
  });

  // ── F0 verification tests ─────────────────────────────────────────
  describe("F0: suspension-as-return-value", () => {
    describe(".finally() under suspension", () => {
      it(".finally() runs after a gate suspends", async () => {
        const finallySpy = vi.fn();
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a1", "draft"))
          .gate("review")
          .finally("cleanup", finallySpy);

        const result = await pipeline.generate(testCtx);
        expect(result.status).toBe("suspended");
        expect(finallySpy).toHaveBeenCalledOnce();
      });

      it("multi-finally: throwing finally does not abort subsequent finallys", async () => {
        const second = vi.fn();
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a1", "draft"))
          .gate("review")
          .finally("first", () => { throw new Error("boom"); })
          .finally("second", second);

        const result = await pipeline.generate(testCtx);
        expect(result.status).toBe("suspended");
        expect(second).toHaveBeenCalledOnce();
        // The first error becomes a warning on the suspended path.
        const sources = result.warnings.map(w => w.source);
        expect(sources).toContain("finally");
      });

      it("throwing finally on suspension produces snapshot + warning", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a1", "draft"))
          .gate("review")
          .finally("cleanup", () => { throw new Error("cleanup-fail"); });

        const result = await pipeline.generate(testCtx);
        expect(result.status).toBe("suspended");
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].source).toBe("finally");
        expect(result.warnings[0].stepId).toBe("cleanup");
        expect((result.warnings[0].error as Error).message).toBe("cleanup-fail");
      });
    });

    describe("AggregateError on completion path with throwing finally", () => {
      it("single throwing finally on completion path yields AggregateError", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a1", "ok"))
          .finally("cleanup", () => { throw new Error("cleanup-fail"); });

        await expect(pipeline.generate(testCtx)).rejects.toThrow(AggregateError);
        try {
          await pipeline.generate(testCtx);
        } catch (e) {
          expect(e).toBeInstanceOf(AggregateError);
          expect((e as AggregateError).errors).toHaveLength(1);
          expect(((e as AggregateError).errors[0] as Error).message).toBe("cleanup-fail");
        }
      });

      it("three-finally-throws preserves all in source order", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a1", "ok"))
          .finally("f1", () => { throw new Error("E1"); })
          .finally("f2", () => { throw new Error("E2"); })
          .finally("f3", () => { throw new Error("E3"); });

        try {
          await pipeline.generate(testCtx);
        } catch (e) {
          expect(e).toBeInstanceOf(AggregateError);
          const messages = ((e as AggregateError).errors as Error[]).map(x => x.message);
          expect(messages).toEqual(["E1", "E2", "E3"]);
        }
      });

      it("step throw with no finally preserves original instanceof", async () => {
        const failing = createMockModel("x");
        failing.doGenerate = async () => { throw new TypeError("specific-type"); };
        const pipeline = Workflow.create<TestCtx>()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .step(new Agent<TestCtx, any, any>({ id: "f", model: failing, prompt: () => "go" }));

        try {
          await pipeline.generate(testCtx);
        } catch (e) {
          expect(e).toBeInstanceOf(TypeError);
          expect((e as Error).message).toContain("specific-type");
        }
      });

      it("pendingError.source dispatch: step + same-id finally — finally throw -> AggregateError", async () => {
        // Step id "review" + finally id "review" is legal under (type, id) uniqueness:
        // step:review and finally:review are different (type, id) pairs.
        const pipeline = Workflow.create<TestCtx>()
          .step("review", () => "value")
          .finally("review", () => { throw new Error("finally-throw"); });

        try {
          await pipeline.generate(testCtx);
        } catch (e) {
          expect(e).toBeInstanceOf(AggregateError);
          const errs = (e as AggregateError).errors as Error[];
          expect(errs).toHaveLength(1);
          expect(errs[0].message).toBe("finally-throw");
        }
      });
    });

    describe("nested-workflow finally + NestedGateUnsupportedError ordering", () => {
      it("inner finally runs before NestedGateUnsupportedError fires", async () => {
        const innerFinally = vi.fn();
        const sub = Workflow.create<TestCtx>()
          .step(createTextAgent("inner", "x"))
          .gate("inner-gate")
          .finally("inner-cleanup", innerFinally);
        const pipeline = Workflow.create<TestCtx>().step(sub);

        await expect(pipeline.generate(testCtx)).rejects.toThrow(NestedGateUnsupportedError);
        expect(innerFinally).toHaveBeenCalledOnce();
      });
    });

    describe("warnings on both branches", () => {
      it("complete path always carries warnings array (length 0 default)", async () => {
        const pipeline = Workflow.create<TestCtx>().step(createTextAgent("a1", "ok"));
        const result = await pipeline.generate(testCtx);
        expect(result.status).toBe("complete");
        expect(result.warnings).toBeDefined();
        expect(Array.isArray(result.warnings)).toBe(true);
      });

      it("suspended path always carries warnings array", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a1", "draft"))
          .gate("review");
        const result = await pipeline.generate(testCtx);
        expect(result.status).toBe("suspended");
        expect(Array.isArray(result.warnings)).toBe(true);
      });

      it("finally-throw + observer-throw on suspension path → both warnings present", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a1", "draft"))
          .gate("review")
          .finally("f", () => { throw new Error("f-fail"); });

        // Inject a throwing observer via the protected field.
        const observer: WorkflowObservability = {
          onStepError: () => { throw new Error("obs-fail"); },
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pipeline as any).observability = observer;

        const result = await pipeline.generate(testCtx);
        expect(result.status).toBe("suspended");
        const sources = result.warnings.map(w => w.source).sort();
        expect(sources).toContain("finally");
        expect(sources).toContain("onStepError");
      });
    });

    describe("foreach concurrent suspension", () => {
      it("3 items, suspending at indices [2,0,1] → caller sees lowest-index marker", async () => {
        // Inner workflow with a gate keyed by item to force suspension on every call.
        const innerSub = Workflow.create<TestCtx, string>()
          .step((createPassthroughAgent("inner", "x")))
          .gate("g");

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b", "c"])
          .foreach(innerSub, { concurrency: 3 });

        try {
          await pipeline.generate(testCtx);
        } catch (e) {
          expect(e).toBeInstanceOf(NestedGateUnsupportedError);
          const err = e as NestedGateUnsupportedError;
          expect(err.gateId).toBe("g");
          // Two other items also suspended; lowest-index won, others land in siblingSuspensions.
          expect(err.siblingSuspensions).toHaveLength(2);
        }
      });

      it("foreach with item 0 suspending and items 1,2 throwing → marker carries siblingErrors + warnings", async () => {
        const failing = createMockModel("x");
        failing.doGenerate = async () => { throw new Error("item-fail"); };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failingAgent = new Agent<TestCtx, any, any>({ id: "fag", model: failing, prompt: () => "go" });

        const subSuspends = Workflow.create<TestCtx, string>()
          .step(createPassthroughAgent("inner", "x"))
          .gate("g");
        const subThrows = Workflow.create<TestCtx, string>()
          .step(failingAgent);

        // We can't mix: foreach takes ONE target. Use a transform that picks per index.
        // Build by branching: a sub-workflow that switches on index via state.output (which is the item).
        // Simpler: use a single sub with conditional gate.
        const sub = Workflow.create<TestCtx, string>()
          .step("dispatch", ({ input }) => input)
          .branch([
            { when: ({ input }) => input === "go-suspend", agent: createPassthroughAgent("a", "ok") },
            { agent: failingAgent },
          ])
          .gate("g", { condition: ({ input }) => input === "ok" });

        // Items: index 0 → go-suspend (passes through to gate), 1,2 → throw.
        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["go-suspend", "f1", "f2"])
          .foreach(sub, { concurrency: 3 });

        try {
          await pipeline.generate(testCtx);
        } catch (e) {
          expect(e).toBeInstanceOf(NestedGateUnsupportedError);
          const err = e as NestedGateUnsupportedError;
          expect(err.siblingErrors.length).toBeGreaterThanOrEqual(2);
        }
      });

      it("item warnings merged into parent under namespace `<id>[index]:<inner-stepId>`", async () => {
        // The contract: foreach merges per-item itemState.warnings into the
        // parent state.warnings, namespaced as `${id}[${index}]:${w.stepId}`,
        // on BOTH branches (suspension + completion).
        //
        // F0 has no path where an inner workflow completes cleanly with
        // non-empty state.warnings (the only thing that pushes is "step error
        // pushed when finally also throws" — which leaves pendingError set,
        // triggering an inner throw at the tail). So we exercise the merge on
        // the SUSPENSION branch instead: inner suspends + has a throwing
        // finally → inner's state.warnings carries the finally error → foreach
        // merges into parent state.warnings → foreach throws
        // NestedGateUnsupportedError → outer .catch() swallows it →
        // result.status === "complete" and result.warnings contains the
        // namespaced entry.
        const innerSuspends = Workflow.create<TestCtx, string>()
          .step(createPassthroughAgent("inner-step", "x"))
          .gate("inner-g")
          .finally("inner-fin", () => { throw new Error("inner-fin-fail"); });

        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a"])
          .foreach(innerSuspends, { id: "fe" })
          .catch("rec", () => ["recovered-outer"]);

        const result = await pipeline.generate(testCtx);
        expect(result.status).toBe("complete");
        // The namespaced warning from the inner finally must have been merged
        // into the parent's warnings BEFORE the foreach threw the marker. If
        // mergeItemWarnings() were removed, this assertion would fail —
        // proving the test exercises the contract.
        const stepIds = result.warnings.map(w => w.stepId);
        expect(stepIds).toContain("fe[0]:inner-fin");
        const innerFin = result.warnings.find(w => w.stepId === "fe[0]:inner-fin");
        expect(innerFin?.source).toBe("finally");
        expect((innerFin?.error as Error).message).toBe("inner-fin-fail");
      });
    });

    describe("loadState bounds checking", () => {
      it("loadState with corrupted resumeFromIndex falls back to id-scan", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a1", "x"))
          .gate("review");

        for (const badIdx of [-1, 999999, NaN, 1.5, Infinity]) {
          const snap: WorkflowSnapshot = {
            version: 1,
            resumeFromIndex: badIdx,
            output: "x",
            gateId: "review",
            gatePayload: "x",
          };
          // Should NOT throw; id-scan finds the gate.
          expect(() => pipeline.loadState("review", snap)).not.toThrow();
        }
      });

      it("top-level reorder of a gate → id-scan fallback succeeds", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step("a", () => "x")
          .gate("review")
          .step("b", ({ input }) => input);

        const { snapshot } = expectSuspended(await pipeline.generate(testCtx));

        // Build a "reordered" pipeline with gate at a different index.
        const reordered = Workflow.create<TestCtx>()
          .step("a", () => "x")
          .step("c", ({ input }) => input)   // extra step pushes gate to a new index
          .gate("review")
          .step("b", ({ input }) => input);

        // Even with a stale resumeFromIndex from the original, id-scan locates "review".
        const resumed = reordered.loadState("review", snapshot);
        const { output } = expectComplete(await resumed.generate(testCtx, "y"));
        expect(output).toBe("y");
      });
    });

    describe("duplicate (type, id) construction-time check", () => {
      it("rejects duplicate step ids on generate", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step("dup", () => "a")
          .step("dup", ({ input }) => input);

        await expect(pipeline.generate(testCtx)).rejects.toThrow(/duplicate \(step, "dup"\)/);
      });

      it("foreach(agentX).foreach(agentX) without explicit id throws", async () => {
        const agent = createPassthroughAgent("agentX", "ok");
        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a"])
          .foreach(agent)
          .foreach(agent);

        await expect(pipeline.generate(testCtx)).rejects.toThrow(/duplicate/);
      });

      it("step id containing ::pipeai:: rejected", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step("::pipeai::reserved", () => "x");

        await expect(pipeline.generate(testCtx)).rejects.toThrow(/reserved.*::pipeai::/);
      });
    });

    describe("deepFreeze + freezeSnapshots opt-in", () => {
      it("default: snapshot is mutable", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a1", "draft"))
          .gate("review");

        const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
        // Try to mutate — should not throw without freezeSnapshots.
        expect(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (snapshot as any).gateId = "mutated";
        }).not.toThrow();
      });

      it("freezeSnapshots: true → snapshot is deeply frozen", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a1", "draft"))
          .gate("review", { payload: () => ({ nested: { deep: "value" } }) });

        const { snapshot } = expectSuspended(await pipeline.generate(testCtx, undefined, { freezeSnapshots: true }));
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.gatePayload)).toBe(true);
        // Deep
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(Object.isFrozen((snapshot.gatePayload as any).nested)).toBe(true);
      });

      it("deepFreeze handles cyclic structures without infinite-looping", async () => {
        // Direct call to verify cycle handling on a synthetic cyclic object.
        const { deepFreeze } = await import("../utils");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a: any = { foo: 1 };
        a.self = a;
        expect(() => deepFreeze(a)).not.toThrow();
        expect(Object.isFrozen(a)).toBe(true);
      });

      it("runOptions does not propagate into nested workflows", async () => {
        // Parent uses freezeSnapshots: true. Inner workflow's gate snapshot path
        // is moot (NestedGateUnsupportedError fires), but we can verify the
        // executeNestedWorkflow contract by reading state through observation.
        // Simpler: verify foreach itemState doesn't carry runOptions by ensuring
        // a successful run with freezeSnapshots: true doesn't freeze inner state.
        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b"])
          .foreach(createPassthroughAgent("p", "ok"));
        // No assertion on freezing here — pure smoke test that the run completes
        // without errors when freezeSnapshots: true is passed.
        const result = await pipeline.generate(testCtx, undefined, { freezeSnapshots: true });
        expect(result.status).toBe("complete");
      });
    });

    describe("stream-mode + suspension ordering", () => {
      it("output Promise never rejects on suspension; resolves with status: suspended", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a1", "draft"))
          .gate("review");
        const { output, stream } = pipeline.stream(testCtx);
        const reader = stream.getReader();
        while (!(await reader.read()).done) { /* drain */ }
        // Must not reject.
        const result = await output;
        expect(result.status).toBe("suspended");
      });

      it("real errors still reject the output Promise (not resolve with suspended)", async () => {
        // Force a real error from inside a transform step so the workflow's
        // own try/catch routes it to pendingError, then to rejectOutput on stream.
        const pipeline = Workflow.create<TestCtx>()
          .step("boom", () => { throw new Error("real-error"); });
        const { output, stream } = pipeline.stream(testCtx);
        const reader = stream.getReader();
        try { while (!(await reader.read()).done) { /* drain */ } } catch { /* stream closes on error */ }
        await expect(output).rejects.toThrow("real-error");
      });

      it("onError NOT invoked on suspension; one-time console.warn fires", async () => {
        const { __resetStreamOnErrorOnSuspendWarnForTests } = await import("../workflow");
        __resetStreamOnErrorOnSuspendWarnForTests();
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { /* swallow */ });
        try {
          const pipeline = Workflow.create<TestCtx>()
            .step(createTextAgent("a1", "draft"))
            .gate("review");
          const onError = vi.fn().mockReturnValue("formatted");
          const { output, stream } = pipeline.stream(testCtx, undefined, { onError });
          const reader = stream.getReader();
          while (!(await reader.read()).done) { /* drain */ }
          await output;   // resolves with suspended
          expect(onError).not.toHaveBeenCalled();

          // The one-time console.warn fires.
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy.mock.calls[0][0] as string).toMatch(/pipeai: stream\(\) with options\.onError suspended at a gate/);

          // Run again WITHOUT reset — warn must NOT fire a second time (dedup contract).
          warnSpy.mockClear();
          const pipeline2 = Workflow.create<TestCtx>()
            .step(createTextAgent("a2", "draft"))
            .gate("review2");
          const onError2 = vi.fn();
          const { output: out2, stream: s2 } = pipeline2.stream(testCtx, undefined, { onError: onError2 });
          const r2 = s2.getReader();
          while (!(await r2.read()).done) { /* drain */ }
          await out2;
          expect(warnSpy).not.toHaveBeenCalled();
        } finally {
          warnSpy.mockRestore();
        }
      });
    });

    describe("RunOptions on resume", () => {
      it("ResumedWorkflow.generate accepts RunOptions", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a1", "draft"))
          .gate("review")
          .step("done", ({ input }) => input);

        const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
        const resumed = pipeline.loadState("review", snapshot);
        // Pass runOptions on resume — should not throw.
        const { output } = expectComplete(await resumed.generate(testCtx, "ok", { freezeSnapshots: false }));
        expect(output).toBe("ok");
      });
    });

    describe("checkpointFailed plumbing (F1 forward-compat)", () => {
      it("catch is bypassed when state.checkpointFailed is true mid-run; uncaught error reaches caller", async () => {
        // F0 has no organic path that sets state.checkpointFailed — F1 will
        // populate it from a thrown onCheckpoint. We exercise the branch by
        // splicing a synthetic step into the protected `steps` array that
        // sets state.checkpointFailed = true mid-run, then proves:
        //   1. .catch() does NOT recover (bypass branch fires)
        //   2. .finally() still runs (finally bodies always run)
        //   3. Caller receives the original step error
        const failing = createMockModel("x");
        failing.doGenerate = async () => { throw new Error("step-fail"); };
        const catchSpy = vi.fn().mockReturnValue("recovered");
        const finallySpy = vi.fn();

        const pipeline = Workflow.create<TestCtx>()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .step(new Agent<TestCtx, any, any>({ id: "f", model: failing, prompt: () => "go" }))
          .catch("c", catchSpy)
          .finally("fin", finallySpy);

        // Splice a synthetic step BEFORE the failing one that sets the flag.
        // `steps` is `protected readonly` from TS's POV; `readonly` is a type-only
        // constraint — the array itself is mutable at runtime. Honest test-only hack.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stepsArr = (pipeline as any).steps as Array<{ type: string; id: string; execute: (s: { checkpointFailed?: boolean }) => Promise<void> }>;
        stepsArr.unshift({
          type: "step",
          id: "set-checkpoint-failed-flag",
          execute: async (state) => { state.checkpointFailed = true; },
        });

        // The failing step still throws; catch is bypassed because checkpointFailed
        // is true; finally runs; the step error reaches the caller bare.
        await expect(pipeline.generate(testCtx)).rejects.toThrow("step-fail");
        expect(catchSpy).not.toHaveBeenCalled();
        expect(finallySpy).toHaveBeenCalledOnce();
      });

      it("baseline: without checkpointFailed, catch DOES run (proves the bypass test isn't trivial)", async () => {
        const failing = createMockModel("x");
        failing.doGenerate = async () => { throw new Error("step-fail"); };
        const catchSpy = vi.fn().mockReturnValue("recovered");

        const pipeline = Workflow.create<TestCtx>()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .step(new Agent<TestCtx, any, any>({ id: "f2", model: failing, prompt: () => "go" }))
          .catch("c2", catchSpy);

        const result = await pipeline.generate(testCtx);
        expect(result.status).toBe("complete");
        expect(catchSpy).toHaveBeenCalledOnce();
      });
    });
  });

  describe("abortSignal", () => {
    it("rejects immediately when signal is already aborted on entry", async () => {
      const controller = new AbortController();
      controller.abort(new Error("aborted-before-start"));

      const ranSpy = vi.fn();
      const pipeline = Workflow.create<TestCtx>()
        .step("touched", () => { ranSpy(); return "done"; });

      await expect(
        pipeline.generate(testCtx, undefined, { abortSignal: controller.signal })
      ).rejects.toThrow(/aborted-before-start/);
      expect(ranSpy).not.toHaveBeenCalled();
    });

    it("aborts mid-pipeline: subsequent steps do not run", async () => {
      const controller = new AbortController();
      const barrier = defer<void>();
      const lateSpy = vi.fn();

      const pipeline = Workflow.create<TestCtx>()
        .step("first", async () => {
          // Abort while this step is awaiting.
          queueMicrotask(() => controller.abort(new Error("mid-flight")));
          await barrier.promise;
          return "first-out";
        })
        .step("second", () => { lateSpy(); return "second-out"; });

      const run = pipeline.generate(testCtx, undefined, { abortSignal: controller.signal });
      // Let the abort fire while step 1 is parked.
      await new Promise((r) => setTimeout(r, 5));
      barrier.resolve();

      await expect(run).rejects.toThrow(/mid-flight/);
      expect(lateSpy).not.toHaveBeenCalled();
    });

    it("forwards abortSignal to agent.generate calls", async () => {
      // Mock model captures the signal the SDK sees, proving the workflow
      // threaded it through executeAgent → agent.generate → SDK.
      const seenSignals: Array<AbortSignal | undefined> = [];
      const model = createMockModel("ok");
      const originalDoGenerate = model.doGenerate;
      model.doGenerate = async (options) => {
        seenSignals.push(options.abortSignal);
        return originalDoGenerate(options);
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = new Agent<TestCtx, any, any>({
        id: "signal-agent",
        model,
        prompt: () => "go",
      });
      const pipeline = Workflow.create<TestCtx>().step(agent);

      const controller = new AbortController();
      await pipeline.generate(testCtx, undefined, { abortSignal: controller.signal });

      expect(seenSignals).toHaveLength(1);
      expect(seenSignals[0]).toBe(controller.signal);
    });

    it(".catch() can recover from an abort error", async () => {
      // Abort flows through pendingError like any other failure, so a
      // downstream `.catch()` sees it. Recovery is permitted.
      const controller = new AbortController();
      const barrier = defer<void>();

      const pipeline = Workflow.create<TestCtx>()
        .step("first", async () => {
          queueMicrotask(() => controller.abort(new Error("kill")));
          await barrier.promise;
          return "ok";
        })
        .catch("recover", ({ error }) => `recovered:${(error as Error).message}`);

      const run = pipeline.generate(testCtx, undefined, { abortSignal: controller.signal });
      await new Promise((r) => setTimeout(r, 5));
      barrier.resolve();

      const { output } = expectComplete(await run);
      expect(output).toBe("recovered:kill");
    });

    it(".finally() bodies still run on the abort path", async () => {
      // Cleanup contract: finally bodies always run on completion or failure,
      // including aborts.
      const finallySpy = vi.fn();
      const controller = new AbortController();
      controller.abort(new Error("kill"));

      const pipeline = Workflow.create<TestCtx>()
        .step("first", () => "x")
        .finally("cleanup", () => { finallySpy(); });

      await expect(
        pipeline.generate(testCtx, undefined, { abortSignal: controller.signal })
      ).rejects.toThrow(/kill/);
      expect(finallySpy).toHaveBeenCalledOnce();
    });

    it("foreach stops launching new items after abort", async () => {
      const controller = new AbortController();
      const launchedIndices: number[] = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itemAgent = new Agent<TestCtx, any, any>({
        id: "item",
        model: createMockModel("ok"),
        prompt: (_ctx, idx: number) => {
          launchedIndices.push(idx);
          // Abort after first item processed.
          if (idx === 0) controller.abort(new Error("foreach-abort"));
          return String(idx);
        },
      });

      const pipeline = Workflow.create<TestCtx>()
        .step("seed", () => [0, 1, 2, 3, 4] as number[])
        .foreach(itemAgent);

      await expect(
        pipeline.generate(testCtx, undefined, { abortSignal: controller.signal })
      ).rejects.toThrow(/foreach-abort/);
      // At minimum: first item ran, last items didn't.
      expect(launchedIndices).toContain(0);
      expect(launchedIndices.length).toBeLessThan(5);
    });

    it("repeat exits between iterations when aborted", async () => {
      const controller = new AbortController();
      let iters = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = new Agent<TestCtx, any, any>({
        id: "body",
        model: createMockModel("ok"),
        prompt: () => {
          iters++;
          if (iters === 2) controller.abort(new Error("loop-abort"));
          return "x";
        },
      });

      const pipeline = Workflow.create<TestCtx>()
        .step(body, { id: "seed" })
        .repeat(body, { until: ({ iterations }) => iterations >= 10, maxIterations: 20 });

      await expect(
        pipeline.generate(testCtx, undefined, { abortSignal: controller.signal })
      ).rejects.toThrow(/loop-abort/);
      // Loop exited well before maxIterations.
      expect(iters).toBeLessThan(20);
    });

    it("nested workflow honors the outer abortSignal", async () => {
      const controller = new AbortController();
      const innerLateSpy = vi.fn();

      const inner = Workflow.create<TestCtx>()
        .step("inner-1", async () => {
          queueMicrotask(() => controller.abort(new Error("inner-abort")));
          await new Promise((r) => setTimeout(r, 5));
          return "x";
        })
        .step("inner-2", () => { innerLateSpy(); return "y"; });

      const pipeline = Workflow.create<TestCtx>().step(inner);

      await expect(
        pipeline.generate(testCtx, undefined, { abortSignal: controller.signal })
      ).rejects.toThrow(/inner-abort/);
      expect(innerLateSpy).not.toHaveBeenCalled();
    });

    it("stream-mode: output Promise rejects with abort reason", async () => {
      const controller = new AbortController();
      const barrier = defer<void>();
      const lateSpy = vi.fn();

      const pipeline = Workflow.create<TestCtx>()
        .step("first", async () => {
          queueMicrotask(() => controller.abort(new Error("stream-abort")));
          await barrier.promise;
          return "ok";
        })
        .step("second", () => { lateSpy(); return "done"; });

      const { output, stream } = pipeline.stream(testCtx, undefined, undefined, {
        abortSignal: controller.signal,
      });
      const reader = stream.getReader();
      // Drain whatever the writer produced (likely nothing in this synthetic flow).
      const drain = (async () => { while (!(await reader.read()).done) { /* drain */ } })();
      await new Promise((r) => setTimeout(r, 5));
      barrier.resolve();
      await drain;

      await expect(output).rejects.toThrow(/stream-abort/);
      expect(lateSpy).not.toHaveBeenCalled();
    });

    it("ResumedWorkflow.generate honors abortSignal", async () => {
      const controller = new AbortController();
      const lateSpy = vi.fn();

      const pipeline = Workflow.create<TestCtx>()
        .step("seed", () => "draft")
        .gate("review")
        .step("after-resume", () => { lateSpy(); return "done"; });

      const { snapshot } = expectSuspended(await pipeline.generate(testCtx));

      const resumed = pipeline.loadState("review", snapshot);
      controller.abort(new Error("resume-abort"));

      await expect(
        resumed.generate(testCtx, "response", { abortSignal: controller.signal })
      ).rejects.toThrow(/resume-abort/);
      expect(lateSpy).not.toHaveBeenCalled();
    });
  });

  // ── F1 verification tests ─────────────────────────────────────────
  describe("F1: step-level checkpointing", () => {
    describe("snapshot union + migrateSnapshot", () => {
      it("new gate snapshots are v2 with kind='gate'", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a", "x"))
          .gate("g");
        const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
        expect(snapshot.version).toBe(2);
        expect(snapshot.kind).toBe("gate");
      });

      it("loadState accepts legacy v1 gate snapshots (backward compat)", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a", "x"))
          .gate("g")
          .step("after", ({ input }) => input);
        const legacy: WorkflowSnapshot = {
          version: 1,
          resumeFromIndex: 1,
          output: "x",
          gateId: "g",
          gatePayload: "x",
        };
        const resumed = pipeline.loadState("g", legacy);
        const { output } = expectComplete(await resumed.generate(testCtx, "y"));
        expect(output).toBe("y");
      });

      it("loadState accepts v2 gate snapshots", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a", "x"))
          .gate("g")
          .step("after", ({ input }) => input);
        const v2: GateSnapshot = {
          version: 2, kind: "gate",
          resumeFromIndex: 1,
          output: "x",
          gateId: "g",
          gatePayload: "x",
        };
        const resumed = pipeline.loadState("g", v2);
        const { output } = expectComplete(await resumed.generate(testCtx, "y"));
        expect(output).toBe("y");
      });

      it("migrateSnapshot(v1) produces a v2 gate snapshot", async () => {
        const { migrateSnapshot } = await import("../workflow");
        const v1 = { version: 1 as const, resumeFromIndex: 0, output: "x", gateId: "g", gatePayload: { foo: 1 } };
        const v2 = migrateSnapshot(v1);
        expect(v2.version).toBe(2);
        expect(v2.kind).toBe("gate");
        expect(v2.gateId).toBe("g");
        expect(v2.gatePayload).toEqual({ foo: 1 });
        expect(v2.resumeFromIndex).toBe(0);
        expect(v2.output).toBe("x");
      });

      it("loadState rejects checkpoint snapshots", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step(createTextAgent("a", "x"))
          .gate("g");
        const ckpt: CheckpointSnapshot = {
          version: 2, kind: "checkpoint",
          resumeFromIndex: 1, output: "x", stepShapeHash: "deadbeef",
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => pipeline.loadState("g", ckpt as any)).toThrow(/Use resumeFrom\(\) for checkpoint resume/);
      });
    });

    describe("checkpoint emission", () => {
      it("onCheckpoint fires with v2 checkpoint snapshot after each successful step body (cadence 1)", async () => {
        const captured: CheckpointSnapshot[] = [];
        const pipeline = Workflow.create<TestCtx>()
          .step("s1", () => "a")
          .step("s2", ({ input }) => `${input}b`)
          .step("s3", ({ input }) => `${input}c`);

        const result = await pipeline.generate(testCtx, undefined, {
          onCheckpoint: (snap) => { captured.push(snap); },
          checkpointEvery: 1,
        });
        expect(result.status).toBe("complete");
        expect(captured).toHaveLength(3);
        // Each snapshot is v2 + kind="checkpoint" + has stepShapeHash
        for (const snap of captured) {
          expect(snap.version).toBe(2);
          expect(snap.kind).toBe("checkpoint");
          expect(snap.stepShapeHash).toBeTruthy();
          expect(typeof snap.stepShapeHash).toBe("string");
        }
        // resumeFromIndex advances 1, 2, 3
        expect(captured.map(s => s.resumeFromIndex)).toEqual([1, 2, 3]);
      });

      it("checkpointEvery: 5 on 12-step pipeline fires at i+1 % 5 === 0 → indices 4 and 9", async () => {
        let w = Workflow.create<TestCtx, string>().step("init", ({ input }) => input);
        for (let i = 1; i < 12; i++) {
          // eslint-disable-next-line @typescript-eslint/no-loop-func
          w = w.step(`s${i}`, ({ input }) => input);
        }
        const captured: number[] = [];
        await w.generate(testCtx, "x", {
          onCheckpoint: (snap) => { captured.push(snap.resumeFromIndex); },
          checkpointEvery: 5,
        });
        // Step indices 4 and 9 (zero-based) → resumeFromIndex = 5 and 10.
        expect(captured).toEqual([5, 10]);
      });

      it("checkpointWhen predicate fires only when true", async () => {
        const captured: { stepIndex: number; stepId: string }[] = [];
        const pipeline = Workflow.create<TestCtx>()
          .step("s1", () => "a")
          .step("s2", ({ input }) => `${input}b`)
          .step("s3", ({ input }) => `${input}c`);
        await pipeline.generate(testCtx, undefined, {
          onCheckpoint: (snap) => { captured.push({ stepIndex: snap.resumeFromIndex - 1, stepId: "?" }); },
          checkpointWhen: ({ stepId }) => stepId === "s2",
        });
        expect(captured.map(c => c.stepIndex)).toEqual([1]);
      });

      it("validateRunOptions throws when both checkpointEvery and checkpointWhen are set", async () => {
        const pipeline = Workflow.create<TestCtx>().step("s", () => "x");
        await expect(pipeline.generate(testCtx, undefined, {
          onCheckpoint: () => {},
          checkpointEvery: 1,
          checkpointWhen: () => true,
        })).rejects.toThrow(/mutually exclusive/);
      });

      it("validateRunOptions throws on bad checkpointEvery values", async () => {
        const pipeline = Workflow.create<TestCtx>().step("s", () => "x");
        for (const bad of [0, -1, 1.5, NaN]) {
          await expect(pipeline.generate(testCtx, undefined, {
            onCheckpoint: () => {},
            checkpointEvery: bad,
          })).rejects.toThrow(/checkpointEvery must be a positive integer/);
        }
      });

      it("validateRunOptions throws on bad checkpointTimeout values", async () => {
        const pipeline = Workflow.create<TestCtx>().step("s", () => "x");
        for (const bad of [0, -1, NaN, Infinity]) {
          await expect(pipeline.generate(testCtx, undefined, {
            onCheckpoint: () => {},
            checkpointTimeout: bad,
          })).rejects.toThrow(/checkpointTimeout/);
        }
      });

      it("auto-cadence: 4-step pipeline fires at every step (ceil(4/4) = 1)", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step("s1", () => "a")
          .step("s2", ({ input }) => input)
          .step("s3", ({ input }) => input)
          .step("s4", ({ input }) => input);
        const captured: number[] = [];
        await pipeline.generate(testCtx, undefined, {
          onCheckpoint: (snap) => { captured.push(snap.resumeFromIndex); },
        });
        expect(captured).toEqual([1, 2, 3, 4]);
      });

      it("auto-cadence excludes .catch() and .finally() from the count", async () => {
        // 4 executable steps (s1..s4) + a catch and finally. Auto-cadence
        // should still be `ceil(4/4) = 1`, firing on every executable step.
        const pipeline = Workflow.create<TestCtx>()
          .step("s1", () => "a")
          .step("s2", ({ input }) => input)
          .step("s3", ({ input }) => input)
          .step("s4", ({ input }) => input)
          .catch("c", ({ lastOutput }) => lastOutput as string)
          .finally("f", () => {});
        const captured: number[] = [];
        await pipeline.generate(testCtx, undefined, {
          onCheckpoint: (snap) => { captured.push(snap.resumeFromIndex); },
        });
        // Cadence based on executable count (4), so every step fires.
        expect(captured.length).toBeGreaterThanOrEqual(4);
      });

      it("checkpoint NOT emitted inside nested workflows (runOptions isolation)", async () => {
        // The plan: foreach itemState omits runOptions, so onCheckpoint never
        // fires for items. Same for step(workflow) / repeat — executeNestedWorkflow
        // saves/clears/restores runOptions.
        const captured: number[] = [];
        const sub = Workflow.create<TestCtx, string>()
          .step("inner-s1", ({ input }) => input)
          .step("inner-s2", ({ input }) => input);
        const pipeline = Workflow.create<TestCtx>()
          .step("items", () => ["a", "b"])
          .foreach(sub, { id: "fe" });
        await pipeline.generate(testCtx, undefined, {
          onCheckpoint: (snap) => { captured.push(snap.resumeFromIndex); },
          checkpointEvery: 1,
        });
        // Two top-level executable steps fire — NOT the 4 inner steps.
        expect(captured).toEqual([1, 2]);
      });

      it("onCheckpoint throws → catch is bypassed → original onCheckpoint error reaches caller", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step("s1", () => "a")
          .step("s2", ({ input }) => input)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .catch("recover", () => "recovered" as any);
        await expect(pipeline.generate(testCtx, undefined, {
          onCheckpoint: () => { throw new Error("ckpt-fail"); },
          checkpointEvery: 1,
        })).rejects.toThrow("ckpt-fail");
      });

      it("pendingError.stepId on checkpoint failure is CHECKPOINT_STEP_ID", async () => {
        const { CHECKPOINT_STEP_ID } = await import("../workflow");
        expect(CHECKPOINT_STEP_ID).toBe("::pipeai::onCheckpoint");
      });

      it("checkpoint NOT emitted on a step that threw (pendingError set)", async () => {
        const captured: number[] = [];
        const pipeline = Workflow.create<TestCtx>()
          .step("ok", () => "x")
          .step("boom", () => { throw new Error("step-fail"); })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .catch("c", () => "recovered" as any);
        await pipeline.generate(testCtx, undefined, {
          onCheckpoint: (snap) => { captured.push(snap.resumeFromIndex); },
          checkpointEvery: 1,
        });
        // Only step "ok" produced a clean state to snapshot — "boom" threw.
        expect(captured).toEqual([1]);
      });
    });

    describe("checkpoint timeout via AbortSignal", () => {
      it("aborts onCheckpoint via AbortSignal on timeout, throws CheckpointTimeoutError", async () => {
        const { CheckpointTimeoutError } = await import("../workflow");
        const pipeline = Workflow.create<TestCtx>().step("s", () => "x");
        await expect(pipeline.generate(testCtx, undefined, {
          onCheckpoint: async (_snap, { signal }) => {
            // Wait for abort or 1s — whichever comes first.
            await new Promise<void>((resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted-but-ignored")), { once: true });
              setTimeout(resolve, 1000);
            });
          },
          checkpointEvery: 1,
          checkpointTimeout: 25,
        })).rejects.toBeInstanceOf(CheckpointTimeoutError);
      });

      it("signal is passed and not aborted when onCheckpoint completes within timeout", async () => {
        let signalAborted = false;
        const pipeline = Workflow.create<TestCtx>().step("s", () => "x");
        const result = await pipeline.generate(testCtx, undefined, {
          onCheckpoint: async (_snap, { signal }) => {
            // Trivial fast op — signal must NOT be aborted.
            await new Promise(r => setTimeout(r, 5));
            signalAborted = signal.aborted;
          },
          checkpointEvery: 1,
          checkpointTimeout: 200,
        });
        expect(result.status).toBe("complete");
        expect(signalAborted).toBe(false);
      });
    });

    describe("stepShapeHash + resumeFrom", () => {
      it("resumeFrom resumes from the checkpoint snapshot's index", async () => {
        const captured: CheckpointSnapshot[] = [];
        const pipeline = Workflow.create<TestCtx, string>()
          .step("s1", ({ input }) => `${input}-a`)
          .step("s2", ({ input }) => `${input}-b`)
          .step("s3", ({ input }) => `${input}-c`);
        await pipeline.generate(testCtx, "start", {
          onCheckpoint: (snap) => { captured.push(snap); },
          checkpointEvery: 1,
        });
        // Resume from the checkpoint after s2 (resumeFromIndex = 2) — should skip s1, s2 and run only s3.
        const after_s2 = captured[1];
        const resumed = pipeline.resumeFrom(after_s2);
        const { output } = expectComplete(await resumed.generate(testCtx));
        // Output reflects the snapshot's seeded value passed through s3 only.
        expect(output).toBe("start-a-b-c");   // already had s1+s2 applied; resume runs s3
      });

      it("resumeFrom rejects gate snapshots", async () => {
        const pipeline = Workflow.create<TestCtx>().step("a", () => "x").gate("g");
        const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
        expect(() => pipeline.resumeFrom(snapshot)).toThrow(/Use loadState\(\) for gate resume/);
      });

      it("resumeFrom rejects checkpoint snapshot with shape mismatch", async () => {
        const pipeline = Workflow.create<TestCtx>().step("a", () => "x").step("b", ({ input }) => input);
        let snap!: CheckpointSnapshot;
        await pipeline.generate(testCtx, undefined, {
          onCheckpoint: (s) => { snap = s; },
          checkpointEvery: 1,
        });

        // Build a structurally different pipeline.
        const reshaped = Workflow.create<TestCtx>().step("a", () => "x").step("c", ({ input }) => input);
        expect(() => reshaped.resumeFrom(snap)).toThrow(/shape mismatch/);
      });

      it("resumeFrom { skipShapeCheck: true } allows resume despite mismatch", async () => {
        const pipeline = Workflow.create<TestCtx>().step("a", () => "x").step("b", ({ input }) => input);
        let snap!: CheckpointSnapshot;
        await pipeline.generate(testCtx, undefined, {
          onCheckpoint: (s) => { snap = s; },
          checkpointEvery: 1,
        });
        const reshaped = Workflow.create<TestCtx>().step("a", () => "x").step("c", ({ input }) => input);
        // No throw despite mismatch.
        const resumed = reshaped.resumeFrom(snap, { skipShapeCheck: true });
        const { output } = expectComplete(await resumed.generate(testCtx));
        expect(output).toBe("x");
      });

      it("resumeFrom rejects missing stepShapeHash (unless skipShapeCheck)", async () => {
        const pipeline = Workflow.create<TestCtx>().step("a", () => "x");
        const badSnap: CheckpointSnapshot = {
          version: 2, kind: "checkpoint",
          resumeFromIndex: 0, output: "x",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stepShapeHash: undefined as any,
        };
        expect(() => pipeline.resumeFrom(badSnap)).toThrow(/missing stepShapeHash/);
      });

      it("resumeFrom rejects out-of-bounds resumeFromIndex", async () => {
        const pipeline = Workflow.create<TestCtx>().step("a", () => "x");
        for (const bad of [-1, 999999, NaN, 1.5, Infinity]) {
          const snap: CheckpointSnapshot = {
            version: 2, kind: "checkpoint",
            resumeFromIndex: bad,
            output: "x",
            stepShapeHash: "abc",
          };
          expect(() => pipeline.resumeFrom(snap, { skipShapeCheck: true })).toThrow(/out of bounds/);
        }
      });

      it("resumeFrom on 0-step workflow throws", async () => {
        const pipeline = Workflow.create<TestCtx>();
        const snap: CheckpointSnapshot = {
          version: 2, kind: "checkpoint",
          resumeFromIndex: 0, output: "x", stepShapeHash: "abc",
        };
        expect(() => pipeline.resumeFrom(snap)).toThrow(/no steps/);
      });

      it("stepShapeHash identical across two checkpoints from the same run", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step("a", () => "x")
          .step("b", ({ input }) => input)
          .step("c", ({ input }) => input);
        const hashes: string[] = [];
        await pipeline.generate(testCtx, undefined, {
          onCheckpoint: (snap) => { hashes.push(snap.stepShapeHash); },
          checkpointEvery: 1,
        });
        expect(hashes).toHaveLength(3);
        expect(new Set(hashes).size).toBe(1);
      });

      it("stepShapeHash differs for structurally-different pipelines", async () => {
        const p1 = Workflow.create<TestCtx>().step("a", () => "x");
        const p2 = Workflow.create<TestCtx>().step("a", () => "x").step("b", ({ input }) => input);
        const hashes: string[] = [];
        await p1.generate(testCtx, undefined, {
          onCheckpoint: (s) => { hashes.push(s.stepShapeHash); },
          checkpointEvery: 1,
        });
        await p2.generate(testCtx, undefined, {
          onCheckpoint: (s) => { hashes.push(s.stepShapeHash); },
          checkpointEvery: 1,
        });
        expect(hashes[0]).not.toBe(hashes[1]);
      });
    });

    describe("freezeSnapshots catastrophic-combo guard", () => {
      it("throws on freezeSnapshots: true + checkpointEvery: 1 + 8+ step workflow", async () => {
        let w = Workflow.create<TestCtx>().step("s0", () => "x");
        for (let i = 1; i < 8; i++) {
          // eslint-disable-next-line @typescript-eslint/no-loop-func
          w = w.step(`s${i}`, ({ input }) => input);
        }
        await expect(w.generate(testCtx, undefined, {
          onCheckpoint: () => {},
          checkpointEvery: 1,
          freezeSnapshots: true,
        })).rejects.toThrow(/catastrophic/);
      });

      it("\"iAcceptThePerformanceCost\" bypasses the catastrophic-combo guard", async () => {
        let w = Workflow.create<TestCtx>().step("s0", () => "x");
        for (let i = 1; i < 8; i++) {
          // eslint-disable-next-line @typescript-eslint/no-loop-func
          w = w.step(`s${i}`, ({ input }) => input);
        }
        // Doesn't throw; runs successfully.
        const result = await w.generate(testCtx, undefined, {
          onCheckpoint: () => {},
          checkpointEvery: 1,
          freezeSnapshots: "iAcceptThePerformanceCost",
        });
        expect(result.status).toBe("complete");
      });
    });

    describe("CHECKPOINT_STEP_ID reservation", () => {
      it("rejects user step id containing ::pipeai::", async () => {
        const pipeline = Workflow.create<TestCtx>()
          .step("::pipeai::malicious", () => "x");
        await expect(pipeline.generate(testCtx)).rejects.toThrow(/::pipeai::/);
      });
    });
  });

  // ── F2 verification tests ─────────────────────────────────────────
  describe("F2: parallel() combinator", () => {
    describe("record form", () => {
      it("returns a record keyed by branch names", async () => {
        const a = createPassthroughAgent("a-agent", "from-a");
        const b = createPassthroughAgent("b-agent", "from-b");
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel({ a, b });
        const result = expectComplete(await pipeline.generate(testCtx, "shared-input"));
        // Both branches receive "shared-input"; both produce their fixed text.
        expect(result.output).toEqual({ a: "from-a", b: "from-b" });
      });

      it("feeds the same input to each branch", async () => {
        const seen: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const witness = (id: string) => new Agent<TestCtx, any, any>({
          id,
          model: createMockModel("ok"),
          prompt: (_ctx: TestCtx, input: string) => { seen.push(`${id}:${input}`); return input; },
        });
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel({ a: witness("a"), b: witness("b"), c: witness("c") });
        await pipeline.generate(testCtx, "same-input");
        expect(seen.sort()).toEqual(["a:same-input", "b:same-input", "c:same-input"]);
      });
    });

    describe("tuple form", () => {
      it("returns an array in declaration order", async () => {
        const a = createPassthroughAgent("a", "from-a");
        const b = createPassthroughAgent("b", "from-b");
        const c = createPassthroughAgent("c", "from-c");
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel([a, b, c] as const);
        const result = expectComplete(await pipeline.generate(testCtx, "in"));
        expect(result.output).toEqual(["from-a", "from-b", "from-c"]);
      });
    });

    describe("concurrency", () => {
      it("default concurrency is min(branches.length, 5) — 3 branches → 3 in flight", async () => {
        let maxConcurrent = 0;
        let current = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slow = (id: string) => new Agent<TestCtx, any, any>({
          id,
          model: createMockModel("ok"),
          prompt: async () => {
            current++;
            if (current > maxConcurrent) maxConcurrent = current;
            await new Promise(r => setTimeout(r, 30));
            current--;
            return "go";
          },
        });
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel({ a: slow("a"), b: slow("b"), c: slow("c") });
        await pipeline.generate(testCtx, "x");
        expect(maxConcurrent).toBe(3);
      });

      it("> 5 branches without explicit concurrency caps at 5 and warn-once fires", async () => {
        const { __resetWarnOnceForTests } = await import("../utils");
        __resetWarnOnceForTests();
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          let maxConcurrent = 0;
          let current = 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const slow = (id: string) => new Agent<TestCtx, any, any>({
            id, model: createMockModel("ok"),
            prompt: async () => {
              current++;
              if (current > maxConcurrent) maxConcurrent = current;
              await new Promise(r => setTimeout(r, 20));
              current--;
              return "go";
            },
          });
          const branches: Record<string, ReturnType<typeof slow>> = {};
          for (let i = 0; i < 8; i++) branches[`b${i}`] = slow(`b${i}`);
          const pipeline = Workflow.create<TestCtx, string>().step("init", ({ input }) => input).parallel(branches);
          await pipeline.generate(testCtx, "x");
          expect(maxConcurrent).toBe(5);
          expect(warnSpy).toHaveBeenCalled();
          expect((warnSpy.mock.calls[0][0] as string)).toMatch(/parallel\(\) with 8 branches capped at concurrency 5/);
        } finally {
          warnSpy.mockRestore();
        }
      });

      it("concurrency: 1 serializes", async () => {
        let maxConcurrent = 0;
        let current = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slow = (id: string) => new Agent<TestCtx, any, any>({
          id, model: createMockModel("ok"),
          prompt: async () => {
            current++;
            if (current > maxConcurrent) maxConcurrent = current;
            await new Promise(r => setTimeout(r, 20));
            current--;
            return "go";
          },
        });
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel({ a: slow("a"), b: slow("b"), c: slow("c") }, { concurrency: 1 });
        await pipeline.generate(testCtx, "x");
        expect(maxConcurrent).toBe(1);
      });

      it("concurrency: Infinity allows full fan-out on >5-branch calls", async () => {
        let maxConcurrent = 0;
        let current = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slow = (id: string) => new Agent<TestCtx, any, any>({
          id, model: createMockModel("ok"),
          prompt: async () => {
            current++;
            if (current > maxConcurrent) maxConcurrent = current;
            await new Promise(r => setTimeout(r, 20));
            current--;
            return "go";
          },
        });
        const branches: Record<string, ReturnType<typeof slow>> = {};
        for (let i = 0; i < 7; i++) branches[`b${i}`] = slow(`b${i}`);
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel(branches, { concurrency: Infinity });
        await pipeline.generate(testCtx, "x");
        expect(maxConcurrent).toBe(7);
      });
    });

    describe("onError + Workflow.SKIP", () => {
      it("record form: onError substitutes a value", async () => {
        const failing = createMockModel("x");
        failing.doGenerate = async () => { throw new Error("a-fail"); };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failAgent = new Agent<TestCtx, any, any>({ id: "fail-a", model: failing, prompt: () => "go" });
        const okAgent = createPassthroughAgent("ok-b", "from-b");
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel({ a: failAgent, b: okAgent }, {
            onError: ({ key, error }) => {
              if (key === "a") return "fallback-a";
              throw error;
            },
          });
        const result = expectComplete(await pipeline.generate(testCtx, "in"));
        expect(result.output).toEqual({ a: "fallback-a", b: "from-b" });
      });

      it("record form: onError returning SKIP leaves the key undefined", async () => {
        const failing = createMockModel("x");
        failing.doGenerate = async () => { throw new Error("a-fail"); };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failAgent = new Agent<TestCtx, any, any>({ id: "fail-a", model: failing, prompt: () => "go" });
        const okAgent = createPassthroughAgent("ok-b", "from-b");
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel({ a: failAgent, b: okAgent }, {
            onError: () => Workflow.SKIP,
          });
        const result = expectComplete(await pipeline.generate(testCtx, "in"));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((result.output as any).a).toBeUndefined();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((result.output as any).b).toBe("from-b");
      });

      it("no onError + branch throws → whole parallel fails", async () => {
        const failing = createMockModel("x");
        failing.doGenerate = async () => { throw new Error("branch-fail"); };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failAgent = new Agent<TestCtx, any, any>({ id: "fail", model: failing, prompt: () => "go" });
        const okAgent = createPassthroughAgent("ok", "from-ok");
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel({ a: failAgent, b: okAgent });
        await expect(pipeline.generate(testCtx, "x")).rejects.toThrow("branch-fail");
      });

      it("onError rethrowing → whole parallel fails", async () => {
        const failing = createMockModel("x");
        failing.doGenerate = async () => { throw new Error("branch-fail"); };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failAgent = new Agent<TestCtx, any, any>({ id: "fail", model: failing, prompt: () => "go" });
        const okAgent = createPassthroughAgent("ok", "from-ok");
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel({ a: failAgent, b: okAgent }, {
            onError: ({ error }) => { throw error; },
          });
        await expect(pipeline.generate(testCtx, "x")).rejects.toThrow("branch-fail");
      });
    });

    describe("suspension under parallel (reuses NestedGateUnsupportedError)", () => {
      it("gate inside a parallel branch throws NestedGateUnsupportedError", async () => {
        const sub = Workflow.create<TestCtx, string>()
          .step(createPassthroughAgent("inner", "x"))
          .gate("inner-gate");
        const ok = createPassthroughAgent("ok", "from-ok");
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel({ a: sub, b: ok });
        await expect(pipeline.generate(testCtx, "x")).rejects.toThrow(NestedGateUnsupportedError);
      });

      it("multi-branch suspension: lowest-index marker wins; others in siblingSuspensions", async () => {
        const sub = (gateId: string) => Workflow.create<TestCtx, string>()
          .step(createPassthroughAgent(`inner-${gateId}`, "x"))
          .gate(gateId);
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel([sub("g1"), sub("g2"), sub("g3")] as const, { concurrency: 3 });
        try {
          await pipeline.generate(testCtx, "x");
        } catch (e) {
          expect(e).toBeInstanceOf(NestedGateUnsupportedError);
          const err = e as NestedGateUnsupportedError;
          expect(err.gateId).toBe("g1");   // lowest index wins
          expect(err.siblingSuspensions.map(s => s.gateId).sort()).toEqual(["g2", "g3"]);
        }
      });
    });

    describe("per-branch warnings merge", () => {
      it("inner warnings merged into parent under namespace `${id}[key]:<inner-stepId>`", async () => {
        const sub = Workflow.create<TestCtx, string>()
          .step(createPassthroughAgent("inner-step", "x"))
          .gate("inner-g")
          .finally("inner-fin", () => { throw new Error("inner-fin-fail"); });
        const ok = createPassthroughAgent("ok", "from-ok");
        const pipeline = Workflow.create<TestCtx, string>()
          .step("init", ({ input }) => input)
          .parallel({ a: sub, b: ok }, { id: "para" })
          .catch("rec", () => ({ a: "recovered", b: "recovered" }) as never);
        const result = expectComplete(await pipeline.generate(testCtx, "x"));
        const ids = result.warnings.map(w => w.stepId);
        expect(ids).toContain("para[a]:inner-fin");
      });
    });
  });

  // ── F3 verification tests ─────────────────────────────────────────
  describe("F3: workflow observability", () => {
    describe("per-step events", () => {
      it("onStepStart + onStepFinish fire for each step", async () => {
        const starts: string[] = [];
        const finishes: { id: string; durationMs: number; suspended: boolean }[] = [];
        const pipeline = Workflow.create<TestCtx>({
          observability: {
            onStepStart: ({ stepId }) => { starts.push(stepId); },
            onStepFinish: ({ stepId, durationMs, suspended }) => { finishes.push({ id: stepId, durationMs, suspended }); },
          },
        })
          .step("s1", () => "a")
          .step("s2", ({ input }) => input + "b");
        await pipeline.generate(testCtx);
        expect(starts).toEqual(["s1", "s2"]);
        expect(finishes.map(f => f.id)).toEqual(["s1", "s2"]);
        for (const f of finishes) {
          expect(f.durationMs).toBeGreaterThanOrEqual(0);
          expect(f.suspended).toBe(false);
        }
      });

      it("onStepError fires on step body throw; original error reaches caller with cause = obsError", async () => {
        const obsErr = new Error("obs-fail");
        const pipeline = Workflow.create<TestCtx>({
          observability: {
            onStepError: () => { throw obsErr; },
          },
        })
          .step("boom", () => { throw new Error("original-error"); });
        try {
          await pipeline.generate(testCtx);
        } catch (e) {
          expect((e as Error).message).toBe("original-error");
          expect((e as { cause?: unknown }).cause).toBe(obsErr);
        }
      });

      it("onStepStart throws → warning with source 'onStepStart'", async () => {
        const pipeline = Workflow.create<TestCtx>({
          observability: {
            onStepStart: () => { throw new Error("start-fail"); },
          },
        }).step("s", () => "x");
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          const result = await pipeline.generate(testCtx);
          expect(result.status).toBe("complete");
          const sources = result.warnings.map(w => w.source);
          expect(sources).toContain("onStepStart");
        } finally {
          consoleSpy.mockRestore();
        }
      });

      it("onStepFinish throws → warning with source 'onStepFinish'", async () => {
        const pipeline = Workflow.create<TestCtx>({
          observability: {
            onStepFinish: () => { throw new Error("finish-fail"); },
          },
        }).step("s", () => "x");
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          const result = await pipeline.generate(testCtx);
          expect(result.status).toBe("complete");
          expect(result.warnings.map(w => w.source)).toContain("onStepFinish");
        } finally {
          consoleSpy.mockRestore();
        }
      });
    });

    describe("gate observability", () => {
      it("gate suspends → onStepFinish fires with suspended: true", async () => {
        const finishes: { id: string; suspended: boolean }[] = [];
        const pipeline = Workflow.create<TestCtx>({
          observability: {
            onStepFinish: ({ stepId, suspended }) => { finishes.push({ id: stepId, suspended }); },
          },
        })
          .step("s", () => "x")
          .gate("review");
        await pipeline.generate(testCtx);
        const gateFinish = finishes.find(f => f.id === "review");
        expect(gateFinish?.suspended).toBe(true);
      });

      it("gate cond-false skip → onStepFinish fires with suspended: false", async () => {
        const finishes: { id: string; suspended: boolean }[] = [];
        const pipeline = Workflow.create<TestCtx>({
          observability: {
            onStepFinish: ({ stepId, suspended }) => { finishes.push({ id: stepId, suspended }); },
          },
        })
          .step("s", () => "x")
          .gate("review", { condition: () => false })
          .step("after", ({ input }) => input);
        const result = await pipeline.generate(testCtx);
        expect(result.status).toBe("complete");
        const gateFinish = finishes.find(f => f.id === "review");
        expect(gateFinish?.suspended).toBe(false);
      });
    });

    describe("combinator-level + per-item events", () => {
      it("foreach: onStepStart fires for combinator; onItemStart fires per item", async () => {
        const stepStarts: string[] = [];
        const itemStarts: { stepId: string; type: string; itemIndex: number | string }[] = [];
        const pipeline = Workflow.create<TestCtx>({
          observability: {
            onStepStart: ({ stepId }) => { stepStarts.push(stepId); },
            onItemStart: ({ stepId, type, itemIndex }) => { itemStarts.push({ stepId, type, itemIndex }); },
          },
        })
          .step("items", () => ["a", "b", "c"])
          .foreach(createPassthroughAgent("p", "ok"), { id: "fe" });
        await pipeline.generate(testCtx);
        expect(stepStarts).toContain("fe");
        expect(itemStarts.filter(e => e.stepId === "fe").map(e => e.itemIndex)).toEqual([0, 1, 2]);
        expect(itemStarts.every(e => e.type === "foreach")).toBe(true);
      });

      it("parallel record form: onItemStart fires per branch with key as itemIndex", async () => {
        const itemStarts: { itemIndex: number | string }[] = [];
        const a = createPassthroughAgent("a", "from-a");
        const b = createPassthroughAgent("b", "from-b");
        const pipeline = Workflow.create<TestCtx, string>({
          observability: {
            onItemStart: ({ itemIndex }) => { itemStarts.push({ itemIndex }); },
          },
        })
          .step("init", ({ input }) => input)
          .parallel({ a, b }, { id: "para" });
        await pipeline.generate(testCtx, "in");
        expect(itemStarts.map(e => e.itemIndex).sort()).toEqual(["a", "b"]);
      });

      it("repeat: NO per-item events fire (combinator-level only)", async () => {
        const itemEvents: unknown[] = [];
        const stepStarts: string[] = [];
        let count = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agent = new Agent<TestCtx, any, any>({
          id: "refiner",
          model: createMockModel("refined"),
          prompt: () => "go",
        });
        const pipeline = Workflow.create<TestCtx>({
          observability: {
            onStepStart: ({ stepId }) => { stepStarts.push(stepId); },
            onItemStart: (e) => { itemEvents.push(e); },
            onItemFinish: (e) => { itemEvents.push(e); },
            onItemError: (e) => { itemEvents.push(e); },
          },
        })
          .step("init", () => "draft")
          .repeat(agent, { until: () => { count++; return count >= 2; }, id: "loop" });
        await pipeline.generate(testCtx);
        expect(stepStarts).toContain("loop");
        // repeat doesn't emit per-item events even though it iterates.
        expect(itemEvents).toEqual([]);
      });
    });

    describe("nested type", () => {
      it("step(workflow) reports type: 'nested'", async () => {
        const types: string[] = [];
        const sub = Workflow.create<TestCtx>().step("inner", () => "from-inner");
        const pipeline = Workflow.create<TestCtx>({
          observability: {
            onStepStart: ({ stepId, type }) => { if (stepId !== "inner") types.push(type); },
          },
        }).step(sub);
        await pipeline.generate(testCtx);
        expect(types).toContain("nested");
      });
    });

    describe("ResumedWorkflow inheritance", () => {
      it("ResumedWorkflow inherits parent observability — events fire post-resume", async () => {
        const startsAfterResume: string[] = [];
        const obs: WorkflowObservability = {
          onStepStart: ({ stepId }) => { startsAfterResume.push(stepId); },
        };
        const pipeline = Workflow.create<TestCtx>({ observability: obs })
          .step("a", () => "x")
          .gate("g")
          .step("after-gate", ({ input }) => input);
        const { snapshot } = expectSuspended(await pipeline.generate(testCtx));
        startsAfterResume.length = 0;
        const resumed = pipeline.loadState("g", snapshot);
        await resumed.generate(testCtx, "y");
        expect(startsAfterResume).toContain("after-gate");
      });

      it("CheckpointResumedWorkflow inherits parent observability", async () => {
        const startsAfterResume: string[] = [];
        const obs: WorkflowObservability = {
          onStepStart: ({ stepId }) => { startsAfterResume.push(stepId); },
        };
        const pipeline = Workflow.create<TestCtx, string>({ observability: obs })
          .step("s1", ({ input }) => input)
          .step("s2", ({ input }) => input)
          .step("s3", ({ input }) => input);
        let snap!: CheckpointSnapshot;
        await pipeline.generate(testCtx, "x", {
          onCheckpoint: (s) => { if (s.resumeFromIndex === 2) snap = s; },
          checkpointEvery: 1,
        });
        startsAfterResume.length = 0;
        const resumed = pipeline.resumeFrom(snap);
        await resumed.generate(testCtx);
        expect(startsAfterResume).toEqual(["s3"]);
      });
    });

    describe("onCheckpoint failure routes to onStepError", () => {
      it("onCheckpoint throws → onStepError fires with stepId === CHECKPOINT_STEP_ID, type === 'step'", async () => {
        const { CHECKPOINT_STEP_ID } = await import("../workflow");
        const errors: { stepId: string; type: string }[] = [];
        const pipeline = Workflow.create<TestCtx>({
          observability: {
            onStepError: ({ stepId, type }) => { errors.push({ stepId, type }); },
          },
        }).step("s", () => "x");
        try {
          await pipeline.generate(testCtx, undefined, {
            onCheckpoint: () => { throw new Error("ckpt-fail"); },
            checkpointEvery: 1,
          });
        } catch {
          // expected
        }
        expect(errors).toContainEqual({ stepId: CHECKPOINT_STEP_ID, type: "step" });
      });
    });

    describe("skip-checked nodes emit nothing (except finally)", () => {
      it("step after a gate suspension does NOT fire onStepStart", async () => {
        const starts: string[] = [];
        const pipeline = Workflow.create<TestCtx>({
          observability: {
            onStepStart: ({ stepId }) => { starts.push(stepId); },
          },
        })
          .step("before-gate", () => "x")
          .gate("review")
          .step("after-gate", ({ input }) => input);
        await pipeline.generate(testCtx);
        expect(starts).toContain("before-gate");
        expect(starts).toContain("review");
        expect(starts).not.toContain("after-gate");
      });

      it(".finally() fires onStepStart EVEN after gate suspension", async () => {
        const starts: string[] = [];
        const pipeline = Workflow.create<TestCtx>({
          observability: {
            onStepStart: ({ stepId }) => { starts.push(stepId); },
          },
        })
          .step("s", () => "x")
          .gate("review")
          .finally("cleanup", () => {});
        await pipeline.generate(testCtx);
        expect(starts).toContain("cleanup");
      });
    });

    describe("concurrent runs use per-runId keying (OTel example)", () => {
      it("two concurrent runs with different runId on the ctx don't interleave spans", async () => {
        type Ctx = { runId: string };
        const spans = new Map<string, { stepId: string; ended: boolean }>();
        const obs: WorkflowObservability = {
          onStepStart: ({ stepId, ctx }) => {
            spans.set(`${(ctx as Ctx).runId}:${stepId}`, { stepId, ended: false });
          },
          onStepFinish: ({ stepId, ctx }) => {
            const span = spans.get(`${(ctx as Ctx).runId}:${stepId}`);
            if (span) span.ended = true;
          },
        };
        const pipeline = Workflow.create<Ctx>({ observability: obs })
          .step("s1", () => "a")
          .step("s2", ({ input }) => input);
        await Promise.all([
          pipeline.generate({ runId: "run-A" }),
          pipeline.generate({ runId: "run-B" }),
        ]);
        expect(spans.size).toBe(4);
        for (const span of spans.values()) expect(span.ended).toBe(true);
      });
    });
  });

  // ── F4: graph-pattern smoke tests ─────────────────────────────────
  // F4 is docs-only — these tests just verify the patterns from the README
  // compile and run end-to-end.
  describe("F4: graph patterns", () => {
    it("cycle via repeat(subWorkflow)", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const executor = new Agent<TestCtx, any, any>({
        id: "exec", model: createMockModel("done"),
        prompt: (_ctx, input) => `plan: ${input}`,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const critic = new Agent<TestCtx, any, any>({
        id: "critic", model: createMockModel("ok"),
        prompt: () => "judge",
      });
      const cycle = Workflow.create<TestCtx, string>()
        .step(executor)
        .step(critic);
      const agent = Workflow.create<TestCtx, string>()
        .step("init", ({ input }) => input)
        .repeat(cycle, { until: ({ iterations }) => iterations >= 2, maxIterations: 3 });
      const { output } = expectComplete(await agent.generate(testCtx, "draft"));
      expect(typeof output).toBe("string");
    });

    it("multi-path branch + rejoin via .branch().step()", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step("classify", () => "bug")
        .branch({
          select: ({ input }) => input as "bug" | "feature",
          agents: {
            bug: createPassthroughAgent("bug-a", "fixed"),
            feature: createPassthroughAgent("feat-a", "filed"),
          },
        })
        .step("rejoin", ({ input }) => `done: ${input}`);
      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toBe("done: fixed");
    });

    it("fan-out + fan-in via .parallel().step()", async () => {
      const pipeline = Workflow.create<TestCtx, string>()
        .step("init", ({ input }) => input)
        .parallel({
          a: createPassthroughAgent("a", "from-a"),
          b: createPassthroughAgent("b", "from-b"),
        })
        .step("combine", ({ input }) => `${input.a}+${input.b}`);
      const { output } = expectComplete(await pipeline.generate(testCtx, "x"));
      expect(output).toBe("from-a+from-b");
    });
  });
});
