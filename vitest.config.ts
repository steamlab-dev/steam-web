import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
    coverage: {
      branches: 90,
      exclude: ["src/types.ts"],
      functions: 91,
      include: ["src/**/*.ts"],
      lines: 96,
      statements: 96,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
