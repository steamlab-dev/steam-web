import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  target: "node22",
  unbundle: false,
  deps: {
    neverBundle: [/node_modules/],
  },
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  treeshake: true,
});
