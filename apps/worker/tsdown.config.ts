import { defineConfig } from "tsdown";

// Bundle our workspace packages (shipped as TypeScript source) into one file; keep npm deps external.
export default defineConfig({
  entry: ["src/main.ts", "src/cli.ts"],
  platform: "node",
  format: "esm",
  outDir: "dist",
  noExternal: [/^@woolrus\//],
});
