import { describe, it, expect } from "vitest";
import { Workflow } from "../workflow";
import { Agent } from "../agent";
import { expectComplete, testCtx, type TestCtx } from "./helpers";

/**
 * Raw workflow-engine speed.
 *
 * These tests measure the orchestration overhead of the run loop itself —
 * per-step dispatch, skip-policy checks, observability bracketing (no-op fast
 * path), error reconciliation, and the concurrent dispatch loop — NOT the agent
 * / model cost. Agents are zero-cost stubs that return an instant result
 * WITHOUT going through the AI SDK (`generateText`/`streamText` would otherwise
 * dominate and mask the engine).
 *
 * The real signal is the `console.log` output (ms/run, runs/sec). The
 * assertions are deliberately generous smoke guards: they only trip on a
 * catastrophic (10-100x) regression, never on normal CI variance.
 */

// ── Tunables ─────────────────────────────────────────────────────────
const DEEP_RUNS = 2000;
const DEEP_WARMUP = 200;
const DEEP_CEILING_MS_PER_RUN = 10;   // smoke guard, not a benchmark target

const WIDE_ITEMS = 2000;
const WIDE_RUNS = 5;
const WIDE_WARMUP = 2;
const WIDE_CEILING_MS_PER_ITEM = 2;   // smoke guard, not a benchmark target

// ── Zero-cost agent stub ─────────────────────────────────────────────
// Satisfies only the surface the engine's generate path touches:
//   AgentStep.runAgent reads `agent.hasOutput` + `agent.validateOutput`, calls
//   `agent.generate(ctx, input, opts)`, then `extractOutput` reads `.text`
//   (hasOutput === false → no structured-output await). No AI SDK involved.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fastAgent(id: string, text = "ok"): Agent<TestCtx, any, any> {
  return {
    id,
    description: "",
    hasOutput: false,
    validateOutput: undefined,
    generate: async () => ({ text }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as Agent<TestCtx, any, any>;
}

// ── Timing harness ───────────────────────────────────────────────────
async function timed(
  label: string,
  warmup: number,
  iterations: number,
  fn: () => Promise<unknown>,
): Promise<{ totalMs: number; perOpMs: number }> {
  for (let i = 0; i < warmup; i++) await fn();   // let V8 optimize before timing
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const totalMs = performance.now() - start;
  const perOpMs = totalMs / iterations;
  // eslint-disable-next-line no-console
  console.log(
    `[perf] ${label}: ${iterations} runs in ${totalMs.toFixed(1)}ms ` +
    `→ ${perOpMs.toFixed(4)} ms/run, ${Math.round(1000 / perOpMs).toLocaleString()} runs/sec`,
  );
  return { totalMs, perOpMs };
}

describe("perf: raw workflow speed", () => {
  it("deep — sequential variety pipeline (per-step dispatch)", async () => {
    // One straight-through run touches every combinator: agent → transform →
    // predicate branch (scans past a non-match to the default) → nested
    // workflow → gate (condition false → passthrough, no suspend) → repeat
    // (3 iterations). Built ONCE; only generate() is timed.
    const nested = Workflow.create<TestCtx, unknown>()
      .step("n-transform", ({ input }) => input)
      .step(fastAgent("n-agent", "nested-out"));

    const pipeline = Workflow.create<TestCtx>()
      .step(fastAgent("a", "ok"))
      .step("transform", ({ input }) => `${input}!`)
      .branch([
        { when: () => false, agent: fastAgent("never", "x") },
        { agent: fastAgent("default-branch", "branched") },   // default (no `when`)
      ])
      .step(nested)
      .gate("g", { condition: () => false })                  // passthrough, never suspends
      .repeat(fastAgent("loop", "looped"), {
        until: ({ iterations }) => iterations >= 3,
        maxIterations: 5,
      });

    // Sanity: the pipeline completes (no suspend / error) before we measure.
    expect(expectComplete(await pipeline.generate(testCtx)).output).toBe("looped");

    const { perOpMs } = await timed("deep variety pipeline", DEEP_WARMUP, DEEP_RUNS, async () => {
      const out = expectComplete(await pipeline.generate(testCtx)).output;
      if (out !== "looped") throw new Error(`unexpected output: ${String(out)}`);
    });

    expect(perOpMs).toBeLessThan(DEEP_CEILING_MS_PER_RUN);
  });

  it("wide — concurrent foreach fan-out (dispatch loop)", async () => {
    // Default (unbounded) concurrency: every item is launched in one tick over
    // the semaphore, then settles. Each item runs a small multi-step path
    // (transform → agent) so the per-unit nested execution is exercised too.
    const items = Array.from({ length: WIDE_ITEMS }, (_, i) => i);

    const pipeline = Workflow.create<TestCtx, number[]>()
      .foreach((path) =>
        path
          .step("double", ({ input }) => (input as number) * 2)
          .step(fastAgent("tag", "t")),
      );

    // Sanity: all items map through.
    const first = expectComplete(await pipeline.generate(testCtx, items)).output as unknown[];
    expect(first).toHaveLength(WIDE_ITEMS);
    expect(first.every((v) => v === "t")).toBe(true);

    const { totalMs } = await timed(
      `wide foreach (${WIDE_ITEMS} items/run)`,
      WIDE_WARMUP,
      WIDE_RUNS,
      async () => {
        const out = expectComplete(await pipeline.generate(testCtx, items)).output as unknown[];
        if (out.length !== WIDE_ITEMS) throw new Error(`unexpected length: ${out.length}`);
      },
    );

    const perItemMs = totalMs / (WIDE_RUNS * WIDE_ITEMS);
    const totalItems = WIDE_RUNS * WIDE_ITEMS;
    // eslint-disable-next-line no-console
    console.log(
      `[perf] wide foreach: ${totalItems.toLocaleString()} items in ${totalMs.toFixed(1)}ms ` +
      `→ ${perItemMs.toFixed(5)} ms/item, ${Math.round(1000 / perItemMs).toLocaleString()} items/sec`,
    );

    expect(perItemMs).toBeLessThan(WIDE_CEILING_MS_PER_ITEM);
  });
});
