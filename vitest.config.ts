import { defineConfig } from "vitest/config";

// Default suite: no network, no paid providers. Simulator and mocked-provider tests only.
// Real-provider tests live in *.real.test.ts and run via `npm run test:real`.
export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.real.test.ts"],
    environment: "node",
    testTimeout: 20000,
  },
});
