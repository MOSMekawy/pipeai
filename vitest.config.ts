import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the canonical suite under src/. Without this, vitest's default glob
    // walks into `.worktrees/feat-*/src/__tests__/**` and runs stale copies of
    // the tests from other branches — slow, noisy, and capable of masking a
    // regression in src/ behind a green run of obsolete code.
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"],
  },
});
