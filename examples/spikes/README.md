# Spikes

Recorded results of small experiments run alongside major changes. Each spike answers ONE question with reproducible code, captures the result, and either documents a confirmed behavior or feeds back into the design.

## F0 spikes (release 0.4.0)

The F0 plan ([../../../../c:/Users/Fancy/.claude/plans/okey-plan-F0.md](../../../../c:/Users/Fancy/.claude/plans/okey-plan-F0.md)) called out two AI SDK v6 behaviors that we couldn't verify from reading docs alone:

### 1. Stream close vs output-resolve ordering

**Question:** When a workflow's `stream()` reaches a gate suspension, the implementation closes the stream cleanly AND resolves the `output` Promise with `{ status: "suspended", ... }`. Is the order between (a) stream close and (b) output-Promise resolution deterministic across AI SDK v6 versions?

**Status:** NOT YET RUN. Deferred pending F1 lock-in — F1's `onCheckpoint` spike (below) covers similar ground and any AI SDK behavior change would surface there first.

**Why it matters:** README documentation about "stream closes BEFORE output resolves" (or vice versa) would become a falsehood if the AI SDK changes the internal flush order. The plan accepts this as observed-not-promised for now and pins the peer-dep to `~6.0.116` (tilde, patch-only) as defense.

**Repro skeleton:**

```ts
// examples/spikes/stream-close-vs-output-resolve.ts
import { Workflow } from "pipeai";
import { Agent } from "../../src/agent";
// ... build a pipeline with a gate after one step
const { stream, output } = pipeline.stream(ctx);
let streamClosedAt: number | null = null;
let outputResolvedAt: number | null = null;
const reader = stream.getReader();
output.then(() => { outputResolvedAt = performance.now(); });
const readLoop = (async () => {
  while (!(await reader.read()).done) {}
  streamClosedAt = performance.now();
})();
await Promise.all([output, readLoop]);
console.log({ streamClosedAt, outputResolvedAt, delta: outputResolvedAt! - streamClosedAt! });
```

Run across `ai@~6.0.116` patch versions. Expected: deterministic ordering OR a small jitter (< 1ms) we document as "best-effort." If the ordering inverts under some version, F1's stream-mode docs need a sibling caveat.

### 2. AI SDK v6 onCheckpoint throw surfacing

**Question:** F1 ships `onCheckpoint(snapshot, { signal })`. If `onCheckpoint` throws inside the stream-mode execute callback, does AI SDK v6 surface that thrown error through `WorkflowStreamOptions.onError`, or only via the `output` Promise rejection?

**Status:** NOT YET RUN. Must run BEFORE F1 lock-in. If `onError` IS invoked for `onCheckpoint` throws, the F0 contract "onError NOT invoked for suspension" needs a sibling caveat: "onError NOT invoked for suspension, but IS invoked for `onCheckpoint` failures."

**Why it matters:** F1's `output` rejection contract assumes the throw flows ONLY through the Promise. If AI SDK v6 ALSO fires `onError`, double-handling becomes possible (user sees both an `onError` invocation AND a rejected `output`). The current F0 docs would mislead.

**Repro skeleton:** to be drafted alongside F1.

## How to use this directory

Spikes are short, focused, and don't run in CI. They live here so future plan authors can find the rationale behind contract decisions without spelunking through chat logs or commit messages. When a spike answers its question, either:

1. **Convert into a test** if the behavior is now a stable contract worth asserting.
2. **Convert into README docs** if it's user-visible behavior.
3. **Leave as-is** if it's purely informational and the answer might shift across upstream versions.
