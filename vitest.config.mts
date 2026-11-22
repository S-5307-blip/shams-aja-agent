import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)), "server-only": fileURLToPath(new URL("./tests/server-only-stub.ts", import.meta.url)) } },
  // Database tests share one PostgreSQL database, so files run one at a time.
  test: {
    environment: "node",
    fileParallelism: false,
    globalSetup: ["./tests/global-setup.ts"],
    env: process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {},
  },
});
