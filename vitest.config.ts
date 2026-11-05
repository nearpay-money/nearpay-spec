import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@nearpay/spec": fileURLToPath(new URL("./src/public-entry.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    coverage: { provider: "v8", include: ["src/**/*.ts"], reporter: ["text", "json-summary"] },
  },
});
