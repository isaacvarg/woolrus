import path from "node:path";
import { defineConfig } from "vitest/config";

// Route handlers import through the `@/` alias, as tsconfig.json declares it. tsconfig keeps JSX
// for Next (`jsx: preserve`), so component tests compile it here with React's automatic runtime.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  oxc: { jsx: { runtime: "automatic" } },
});
