import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    isolate: true,
    // The setup's afterEach must run after file/harness cleanup to catch
    // boundary attempts even when source or cleanup code swallows errors.
    sequence: { hooks: "stack" },
  },
});
