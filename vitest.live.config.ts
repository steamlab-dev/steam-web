import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/integration/steam-web.integration.test.ts"],
    hookTimeout: 120_000,
    maxWorkers: 1,
    fileParallelism: false,
    disableConsoleIntercept: true,
    pool: "threads",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tests": path.resolve(__dirname, "./tests"),
    },
  },
});
