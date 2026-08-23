import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const systemChrome = existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3001",
    trace: "retain-on-failure",
    launchOptions: systemChrome ? { executablePath: systemChrome } : undefined,
  },
  webServer: {
    command: "npm run build && npm run start",
    url: "http://127.0.0.1:3001/api/health",
    reuseExistingServer: !process.env.CI,
  },
});
