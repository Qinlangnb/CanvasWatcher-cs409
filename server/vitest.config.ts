import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // Test files share one database, which every test empties first.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
