import { defineConfig } from "@playwright/test";
const baseURL = process.env.TOWN_E2E_BASE_URL ?? "http://localhost:5173";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions:
      process.env.TOWN_E2E_MEDIA === "true"
        ? {
            args: [
              "--use-fake-device-for-media-stream",
              "--use-fake-ui-for-media-stream",
            ],
          }
        : {},
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "firefox",
      testMatch: "**/browser-compat.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "webkit",
      testMatch: "**/browser-compat.spec.ts",
      use: { browserName: "webkit" },
    },
  ],
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: {
    command: `pnpm dev --port ${new URL(baseURL).port || 5173}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
