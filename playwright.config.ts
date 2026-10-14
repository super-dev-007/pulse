import { defineConfig, devices } from "@playwright/test";

// E2E + API tests against a running Pulse (local dev server by default, or a
// deployment via E2E_BASE_URL). PW_CHANNEL=chrome uses an installed Chrome
// instead of Playwright's bundled Chromium.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "e2e",
  // Tests share one database and its global stale-reaper; keep them serial.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.PW_CHANNEL,
        launchOptions: {
          args: [
            // Fake camera/mic and auto-accept the permission prompt.
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            // Mapbox GL needs WebGL; allow the software renderer in headless.
            "--enable-unsafe-swiftshader",
          ],
        },
      },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
