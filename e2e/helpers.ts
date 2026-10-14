import { expect, type Browser, type Page } from "@playwright/test";

// Shared steps for the two-browser tests.

export const LISBON = { latitude: 38.7223, longitude: -9.1393 };
export const PORTO = { latitude: 41.1579, longitude: -8.6291 };

export const needsMap = () =>
  !process.env.E2E_BASE_URL && !process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// A fresh, isolated user who has entered Pulse at `geolocation`.
export async function enter(browser: Browser, geolocation: typeof LISBON) {
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

export const dotOf = (page: Page, peerId: string) =>
  page.locator(`.peer[data-peer-id="${peerId}"]`);

// `from` taps `to`'s dot, `to` accepts, and both chats come up.
export async function connect(from: Page, to: Page, toId: string) {
  await dotOf(from, toId).click();
  await to.getByRole("button", { name: "Accept" }).click();
  for (const page of [from, to]) {
    await expect(page.getByPlaceholder("Type a message…")).toBeEnabled({
      timeout: 30_000,
    });
  }
}

// `from` asks for video, `to` accepts, and both receive frames.
export async function startVideo(from: Page, to: Page) {
  await from.getByRole("button", { name: "Start video" }).click();
  await to.getByRole("button", { name: "Accept" }).click();
  for (const page of [from, to]) {
    await expect
      .poll(() => remoteVideoWidth(page), { timeout: 30_000 })
      .toBeGreaterThan(0);
  }
}

// The first <video> is the full-screen remote feed.
export function remoteVideoWidth(page: Page) {
  return page.evaluate(() => document.querySelector("video")?.videoWidth ?? 0);
}

// How much fine detail the *received* frames carry: mean luma difference
// between neighbouring pixels of the remote video, drawn without any CSS.
// A frosted feed is all soft gradients (near 0); a clear camera is not.
export function remoteDetail(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector("video");
    if (!video || !video.videoWidth) return 0;
    const w = 160;
    const h = 120;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const luma = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    let sum = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        const i = (y * w + x) * 4;
        sum += Math.abs(luma(i) - luma(i - 4));
      }
    }
    return sum / (h * (w - 1));
  });
}
