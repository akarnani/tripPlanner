import { defineConfig } from "vitest/config";
import baseConfig from "./vite.config";

// Vitest reuses the Vite resolve aliases but excludes the Playwright
// suite, which lives under tests/e2e and runs against a real browser.
export default defineConfig({
  ...baseConfig,
  test: {
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"],
  },
});
