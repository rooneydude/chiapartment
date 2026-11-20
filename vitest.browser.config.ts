import { defineConfig } from "vitest/config";

// The dashboard in a real browser (`npm run test:browser`). Kept apart from
// `npm test`: it needs the built site (`npm run build`) and Chromium
// (`npx playwright install chromium`, or CHROMIUM_PATH pointing at one).
export default defineConfig({
  test: {
    include: ["web/e2e/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
