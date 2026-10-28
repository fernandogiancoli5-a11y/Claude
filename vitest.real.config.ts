import { defineConfig } from "vitest/config";

// REAL-PROVIDER tests: call a paid model API. Opt-in only:
//   GROQ_API_KEY=... PAIRLOOM_REAL_PROVIDER_TEST=1 npm run test:real
export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.real.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    fileParallelism: false,
  },
});
