import { test, expect } from "@playwright/test";

test("pages carry a nonce-based CSP and the hardening headers", async ({
  request,
}) => {
  const res = await request.get("/");
  const headers = res.headers();
  const csp = headers["content-security-policy"];

  expect(csp).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/=]+'/);
  expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["permissions-policy"]).toContain("camera=(self)");

  // A fresh nonce per request.
  const again = (await request.get("/")).headers()["content-security-policy"];
  expect(again).not.toBe(csp);
});

test("API responses are hardened too", async ({ request }) => {
  const res = await request.post("/api/poll");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
});

test("the app boots under its CSP without violations", async ({ browser }) => {
  const context = await browser.newContext({
    geolocation: { latitude: 52.52, longitude: 13.405 },
    permissions: ["geolocation"],
  });
  const page = await context.newPage();
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/Content Security Policy|Refused to/i.test(msg.text())) {
      violations.push(msg.text());
    }
  });

  await page.goto("/");
  // Clicking only works once React has hydrated, i.e. once its scripts ran.
  await page.getByRole("button", { name: "Enter Pulse" }).click();
  await expect(page.getByText(/online/)).toBeVisible();
  expect(violations).toEqual([]);

  await context.close();
});
