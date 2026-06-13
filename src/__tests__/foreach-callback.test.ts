import { describe, it, expect, vi } from "vitest";
import { Workflow } from "../workflow";
import { Agent } from "../agent";
import type { WorkflowObservability } from "../workflow";
import { createMockModel, expectComplete, testCtx, type TestCtx } from "./helpers";

describe("foreach — per-item path via builder callback", () => {
  it("runs a single-step per-item path and collects the results", async () => {
    const wf = Workflow.create<TestCtx, number[]>()
      .foreach((path) => path.step("double", ({ input }) => input * 2));

    const res = await wf.generate(testCtx, [1, 2, 3]);
    expect(expectComplete(res).output).toEqual([2, 4, 6]);
  });

  it("runs a multi-step per-item path (each item flows through the whole chain)", async () => {
    const wf = Workflow.create<TestCtx, number[]>()
      .foreach((path) =>
        path
          .step("double", ({ input }) => input * 2)
          .step("inc", ({ input }) => input + 1),
      );

    const res = await wf.generate(testCtx, [1, 2, 3]);
    expect(expectComplete(res).output).toEqual([3, 5, 7]); // (x*2)+1
  });

  it("respects concurrency on the callback form", async () => {
    let running = 0;
    let max = 0;
    const wf = Workflow.create<TestCtx, number[]>()
      .foreach(
        (path) =>
          path.step("work", async ({ input }) => {
            running++;
            max = Math.max(max, running);
            await new Promise((r) => setTimeout(r, 5));
            running--;
            return input;
          }),
        { concurrency: 2 },
      );

    const res = await wf.generate(testCtx, [1, 2, 3, 4, 5]);
    expect(expectComplete(res).output).toEqual([1, 2, 3, 4, 5]);
    expect(max).toBeLessThanOrEqual(2);
  });

  it("supports an agent inside the per-item path (transform → agent per item)", async () => {
    const agent = new Agent<TestCtx, string, string>({
      id: "tag",
      model: createMockModel("tagged"),
      prompt: (_ctx, input: string) => input,
    });

    const wf = Workflow.create<TestCtx, string[]>()
      .foreach((path) => path.step("upper", ({ input }) => input.toUpperCase()).step(agent));

    const res = await wf.generate(testCtx, ["a", "b"]);
    expect(expectComplete(res).output).toEqual(["tagged", "tagged"]);
  });

  it("forwards the parent's observability so inner-path steps fire step hooks", async () => {
    // The callback form gives the user no `create()` call of their own to attach
    // observability to, so the parent workflow's observability is forwarded into
    // the per-item path. Steps INSIDE the path therefore fire onStepStart/Finish
    // (once per item), distinct from the foreach's own per-item events.
    const onStepStart = vi.fn();
    const onStepFinish = vi.fn();
    const observability: WorkflowObservability<TestCtx> = { onStepStart, onStepFinish };

    const wf = Workflow.create<TestCtx, number[]>({ observability })
      .foreach((path) =>
        path
          .step("double", ({ input }) => input * 2)
          .step("inc", ({ input }) => input + 1),
      );

    const res = await wf.generate(testCtx, [1, 2]);
    expect(expectComplete(res).output).toEqual([3, 5]);

    // Both inner steps fired for both items: 2 steps × 2 items = 4 each.
    // (The foreach step itself also brackets start/finish on the parent — hence
    // we filter by the inner step ids rather than asserting a total count.)
    const startedIds = onStepStart.mock.calls.map((c) => c[0].stepId);
    expect(startedIds.filter((id) => id === "double")).toHaveLength(2);
    expect(startedIds.filter((id) => id === "inc")).toHaveLength(2);
    const finishedIds = onStepFinish.mock.calls.map((c) => c[0].stepId);
    expect(finishedIds.filter((id) => id === "double")).toHaveLength(2);
    expect(finishedIds.filter((id) => id === "inc")).toHaveLength(2);
  });
});
