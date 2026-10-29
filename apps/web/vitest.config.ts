import path from "node:path";
import { defineConfig } from "vitest/config";

// Route handlers import through the `@/` alias, as tsconfig.json declares it.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
});
