import { expect, type Browser, type Page } from "@playwright/test";

// Shared steps for the two-browser tests.

export const LISBON = { latitude: 38.7223, longitude: -9.1393 };
export const PORTO = { latitude: 41.1579, longitude: -8.6291 };

export const needsMap = () =>
  !process.env.E2E_BASE_URL && !process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// A fresh, isolated user who has entered Pulse at `geolocation`.
// `checkerboard` swaps the camera's picture for a fine black/white grid —
// all hard edges, so a clear feed and a frosted one are easy to tell apart
// (Chrome's built-in fake camera is too flat to measure). Mic and the app's
// whole camera → frost → WebRTC path are untouched.
export async function enter(
  browser: Browser,
  geolocation: typeof LISBON,
  { checkerboard = false } = {},
) {
  const context = await browser.newContext({
    geolocation,
    permissions: ["geolocation", "camera", "microphone"],
  });
  if (checkerboard) await context.addInitScript(checkerboardCamera);
  const page = await context.newPage();
  await page.goto("/");
  // The server assigns the public session id on join; grab it to find this
  // user's dot on the other user's map.
  const joined = page.waitForResponse(/\/api\/join$/);
  await page.getByRole("button", { name: "Drop onto the globe" }).click();
  const { id } = (await (await joined).json()) as { id: string };
  // Markers only render once the map has fully loaded (style + tiles), which
  // can take a while with two software-rendered globes on one machine.
  await expect(page.locator('[data-map-ready="true"]')).toBeAttached({
    timeout: 45_000,
  });
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

// Runs in the page before any app code: the camera keeps Chrome's fake mic
// but its picture becomes an 8px checkerboard.
function checkerboardCamera() {
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await original(constraints);
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d")!;
    const draw = () => {
      for (let y = 0; y < 480; y += 8) {
        for (let x = 0; x < 640; x += 8) {
          ctx.fillStyle = ((x + y) / 8) % 2 ? "#fff" : "#000";
          ctx.fillRect(x, y, 8, 8);
        }
      }
    };
    draw();
    setInterval(draw, 100); // keep frames flowing
    for (const t of stream.getVideoTracks()) {
      stream.removeTrack(t);
      t.stop();
    }
    stream.addTrack(canvas.captureStream(15).getVideoTracks()[0]);
    return stream;
  };
}

// How much fine detail a video's frames carry: mean luma difference between
// horizontally neighbouring pixels in a 160×120 patch at native resolution,
// read straight from the element (no CSS applied). Frosting leaves only soft
// gradients; a clear checkerboard is all edges.
// Video 0 is the remote feed (what we *receive*), 1 our own clear camera.
export const remoteDetail = (page: Page) => videoDetail(page, 0);
export const localDetail = (page: Page) => videoDetail(page, 1);

function videoDetail(page: Page, index: number) {
  return page.evaluate((index) => {
    const video = document.querySelectorAll("video")[index];
    if (!video || !video.videoWidth) return 0;
    const w = 160;
    const h = 120;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0);
    const x0 = Math.max(0, Math.floor((video.videoWidth - w) / 2));
    const y0 = Math.max(0, Math.floor((video.videoHeight - h) / 2));
    const { data } = ctx.getImageData(x0, y0, w, h);
    const luma = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    let sum = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        const i = (y * w + x) * 4;
        sum += Math.abs(luma(i) - luma(i - 4));
      }
    }
    return sum / (h * (w - 1));
  }, index);
}
