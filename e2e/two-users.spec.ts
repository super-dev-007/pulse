import { test, expect, type Browser, type Page } from "@playwright/test";

// The full product loop with two real browser sessions: see each other on the
// map, connect, chat both ways, video call, hang up, reconnect, and leave.
// Chrome's fake camera/mic stand in for real devices.

test.skip(
  !process.env.E2E_BASE_URL && !process.env.NEXT_PUBLIC_MAPBOX_TOKEN,
  "needs NEXT_PUBLIC_MAPBOX_TOKEN to render the map",
);

const LISBON = { latitude: 38.7223, longitude: -9.1393 };
const PORTO = { latitude: 41.1579, longitude: -8.6291 };

async function enter(browser: Browser, geolocation: typeof LISBON) {
  const context = await browser.newContext({
    geolocation,
    permissions: ["geolocation", "camera", "microphone"],
  });
  const page = await context.newPage();
  await page.goto("/");
  // The server assigns the public session id on join; grab it to find this
  // user's dot on the other user's map.
  const joined = page.waitForResponse(/\/api\/join$/);
  await page.getByRole("button", { name: "Drop onto the globe" }).click();
  const { id } = (await (await joined).json()) as { id: string };
  await expect(page.locator(".mapboxgl-canvas")).toBeVisible();
  return { context, page, id };
}

const dotOf = (page: Page, peerId: string) =>
  page.locator(`.peer[data-peer-id="${peerId}"]`);

async function connect(from: Page, to: Page, toId: string) {
  await dotOf(from, toId).click();
  await to.getByRole("button", { name: "Accept" }).click();
  for (const page of [from, to]) {
    await expect(page.getByPlaceholder("Type a message…")).toBeEnabled({
      timeout: 30_000,
    });
  }
}

async function remoteVideoWidth(page: Page) {
  // The first <video> is the full-screen remote feed.
  return page.evaluate(
    () => document.querySelector("video")?.videoWidth ?? 0,
  );
}

test("two strangers connect, chat, video call and part ways", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const a = await enter(browser, LISBON);
  const b = await enter(browser, PORTO);

  // Each sees the other's dot.
  await expect(dotOf(a.page, b.id)).toBeVisible();
  await expect(dotOf(b.page, a.id)).toBeVisible();

  await connect(a.page, b.page, b.id);

  // Chat, both directions.
  await a.page.getByPlaceholder("Type a message…").fill("hello from Lisbon");
  await a.page.getByRole("button", { name: "Send" }).click();
  await expect(b.page.getByText("hello from Lisbon")).toBeVisible();
  await b.page.getByPlaceholder("Type a message…").fill("olá from Porto");
  await b.page.getByRole("button", { name: "Send" }).click();
  await expect(a.page.getByText("olá from Porto")).toBeVisible();

  // Video: request, accept, and both sides actually receive frames.
  await a.page.getByRole("button", { name: "Start video" }).click();
  await b.page.getByRole("button", { name: "Accept" }).click();
  for (const page of [a.page, b.page]) {
    await expect
      .poll(() => remoteVideoWidth(page), { timeout: 30_000 })
      .toBeGreaterThan(0);
  }

  // End video → back to chat; end chat → the other side is told.
  await a.page.getByRole("button", { name: "End video" }).click();
  await expect(b.page.getByRole("button", { name: "End video" })).toBeHidden();
  await a.page.getByRole("button", { name: "End", exact: true }).click();
  await expect(b.page.getByText(/left the conversation/)).toBeVisible();

  // Both were freed, so they can connect again (other direction this time).
  await connect(b.page, a.page, a.id);

  // b closes the tab: a's chat ends and b's dot leaves a's map.
  await b.page.close({ runBeforeUnload: true });
  await expect(a.page.getByText(/left the conversation/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(dotOf(a.page, b.id)).toBeHidden({ timeout: 20_000 });

  await a.context.close();
  await b.context.close();
});
