import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    name: "@renx/agent",
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      all: false,
      include: ["src/**/*.ts"],
      exclude: ["**/node_modules/**", "**/dist/**", "src/**/*.test.ts"],
    },
  },
});
