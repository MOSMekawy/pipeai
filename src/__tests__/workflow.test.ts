import { describe, it, expect, vi } from "vitest";
import { Agent } from "../agent";
import { Workflow, WorkflowLoopError } from "../workflow";
import { createMockModel, testCtx, type TestCtx } from "./helpers";

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

describe("Workflow", () => {
  describe("step() with agent", () => {
    it("runs a single step", async () => {
      const pipeline = Workflow.create<TestCtx>()
        .step(createTextAgent("agent-1", "hello"));

      const { output } = await pipeline.generate(testCtx);
      expect(output).toBe("hello");
    });

    it("chains multiple steps", async () => {
      const agent1 = createTextAgent("a1", "first output");
      const agent2 = createPassthroughAgent("a2", "second output");

      const pipeline = Workflow.create<TestCtx>()
        .step(agent1)
        .step(agent2);

      const { output } = await pipeline.generate(testCtx);
      expect(output).toBe("second output");
    });
  });

  describe("step() with transform", () => {
    it("transforms output (replaces map)", async () => {
      const agent = createTextAgent("a1", "raw");

      const pipeline = Workflow.create<TestCtx>()
        .step(agent)
        .step("transform", ({ input }) => input.toUpperCase());

      const { output } = await pipeline.generate(testCtx);
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

      const { output } = await pipeline.generate(testCtx);
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

      const { output } = await pipeline.generate(testCtx);
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

      const { output } = await pipeline.generate(testCtx);
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

      const { output } = await pipeline.generate(testCtx);
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

      const { output } = await pipeline.generate(testCtx);
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

      const { output } = await pipeline.generate(testCtx);
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

      const { output } = await pipeline.generate(testCtx);

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

      const result1 = await branch1.generate(testCtx);
      const result2 = await branch2.generate(testCtx);

      expect(result1.output).toBe("BASE-OUTPUT");
      expect(result2.output).toBe("base-output");
    });

    it("base workflow is unmodified after branching", async () => {
      const base = Workflow.create<TestCtx>()
        .step(createTextAgent("a1", "original"));

      // Create a branch — should not mutate base
      base.step("transform", ({ input }) => input + " modified");

      const { output } = await base.generate(testCtx);
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

      const { output } = await pipeline.generate(testCtx);
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
      const { output } = await pipeline.generate(testCtx);
      expect(output).toBe("hello from");
    });

    it("supports chaining after from()", async () => {
      const agent = createTextAgent("a1", "raw");
      const pipeline = Workflow.from(agent)
        .step("transform", ({ input }) => input.toUpperCase());

      const { output } = await pipeline.generate(testCtx);
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

      const result = await output;
      expect(result).toBe("streamed");
    });
  });

  describe("step() with nested workflow", () => {
    it("runs a nested workflow as a step", async () => {
      const sub = Workflow.create<TestCtx>()
        .step(createTextAgent("inner", "from-inner"));

      const pipeline = Workflow.create<TestCtx>()
        .step(sub);

      const { output } = await pipeline.generate(testCtx);
      expect(output).toBe("from-inner");
    });

    it("chains with parent steps", async () => {
      const sub = Workflow.create<TestCtx>()
        .step(createTextAgent("inner", "inner-output"));

      const pipeline = Workflow.create<TestCtx>()
        .step(sub)
        .step("upper", ({ input }) => input.toUpperCase());

      const { output } = await pipeline.generate(testCtx);
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

      const { output } = await pipeline.generate(testCtx);
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

      const { output } = await pipeline.generate(testCtx);
      expect(output).toBe("parent-recovered");
    });

    it("streams nested workflow output", async () => {
      const sub = Workflow.create<TestCtx>()
        .step(createTextAgent("inner", "streamed-inner"));

      const pipeline = Workflow.create<TestCtx>().step(sub);

      const { output, stream } = pipeline.stream(testCtx);
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }

      expect(await output).toBe("streamed-inner");
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

      const { output } = await level1.generate(testCtx);
      expect(output).toBe("deep-l2-l1");
    });
  });

  describe("foreach()", () => {
    it("maps array through agent", async () => {
      const agent = createPassthroughAgent("proc", "processed");

      const pipeline = Workflow.create<TestCtx>()
        .step("items", () => ["a", "b", "c"])
        .foreach(agent);

      const { output } = await pipeline.generate(testCtx);
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

      const { output } = await pipeline.generate(testCtx);
      expect(output).toEqual(["[processed]", "[processed]"]);
    });

    it("returns empty array for empty input", async () => {
      const agent = createPassthroughAgent("proc", "x");

      const pipeline = Workflow.create<TestCtx>()
        .step("items", () => [] as string[])
        .foreach(agent);

      const { output } = await pipeline.generate(testCtx);
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

      const { output } = await pipeline.generate(testCtx);
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

      expect(await output).toBe("chunk");
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
});
