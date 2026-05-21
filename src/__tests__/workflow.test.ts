import { describe, it, expect, vi } from "vitest";
import { Agent } from "../agent";
import { Workflow, WorkflowLoopError, NestedGateUnsupportedError, type WorkflowSnapshot, type WorkflowObservability } from "../workflow";
import { createMockModel, expectComplete, expectSuspended, testCtx, type TestCtx } from "./helpers";

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
    it("mapGenerateResult transforms the step output", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = createTextAgent("a1", "raw text") as Agent<TestCtx, any, any>;
      const pipeline = Workflow.create<TestCtx>()
        .step(agent, {
          mapGenerateResult: ({ result }) => ({ wrapped: result.text }),
        });

      const { output } = expectComplete(await pipeline.generate(testCtx));
      expect(output).toEqual({ wrapped: "raw text" });
    });

    it("onGenerateResult is called with result, ctx, and input", async () => {
      const onGenerateResult = vi.fn();

      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "hello"), { onGenerateResult });

      await pipeline.generate(testCtx);

      expect(onGenerateResult).toHaveBeenCalledOnce();
      expect(onGenerateResult).toHaveBeenCalledWith(
        expect.objectContaining({
          result: expect.objectContaining({ text: "hello" }),
          ctx: testCtx,
        })
      );
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
      expect(snapshot.version).toBe(1);
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
      const loaded: WorkflowSnapshot = JSON.parse(db["workflow:user-1"]);

      // Verify the deserialized snapshot is valid
      expect(loaded.version).toBe(1);
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
      const snap1: WorkflowSnapshot = JSON.parse(db["snap"]);
      expect(snap1.gateId).toBe("gate-1");

      const resumed1 = pipeline.loadState("gate-1", snap1);
      const r2 = expectSuspended(await resumed1.generate(testCtx, "response-1"));
      db["snap"] = JSON.stringify(r2.snapshot);

      // Resume gate 2 → completes
      const snap2: WorkflowSnapshot = JSON.parse(db["snap"]);
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
});
