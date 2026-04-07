import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@renx/lib",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
