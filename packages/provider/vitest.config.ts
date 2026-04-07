import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@renx/provider",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
