import { test, expect, type Page } from "@playwright/test";
import { LISBON, PORTO, connect, enter, needsMap, remoteVideoWidth } from "./helpers";

// Video over the life of one conversation: repeated calls (each one used to
// grow the session description until the 5th was rejected), and both people
// asking for video at the same moment.

test.skip(needsMap(), "needs NEXT_PUBLIC_MAPBOX_TOKEN to render the map");

async function expectFrames(pages: Page[]) {
  for (const p of pages) {
    await expect
      .poll(() => remoteVideoWidth(p), { timeout: 30_000 })
      .toBeGreaterThan(0);
  }
}

test("five video calls in one chat, then both asking at once", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const a = await enter(browser, LISBON);
  const b = await enter(browser, PORTO);
  // Surface the app's own warnings (negotiation failures etc.) on failure.
  const logs: string[] = [];
  for (const [who, p] of [["a", a.page], ["b", b.page]] as const) {
    p.on("console", (m) => {
      if (m.type() !== "log") logs.push(`${who} ${m.type()}: ${m.text()}`);
    });
  }
  await connect(a.page, b.page, b.id);
  const both = [a.page, b.page];

  try {
    for (let call = 1; call <= 5; call++) {
      await test.step(`video call ${call}`, async () => {
        await a.page.getByRole("button", { name: "Start video" }).click();
        await b.page.getByRole("button", { name: "Accept" }).click();
        await expectFrames(both);
        await a.page.getByRole("button", { name: "End video" }).click();
        for (const p of both) {
          await expect(p.getByRole("button", { name: "End video" })).toBeHidden();
        }
      });
    }

    // Both tap "Start video" at (nearly) the same moment. When the requests
    // cross, that's a yes from both sides; if one lands first it's an
    // ordinary ask the other accepts. Either way: video — never two stuck
    // requests.
    await test.step("both ask at once", async () => {
      await Promise.all(
        both.map((p) =>
          p.evaluate(() =>
            document
              .querySelector<HTMLButtonElement>('button[aria-label="Start video"]')
              ?.click(),
          ),
        ),
      );
      await a.page.waitForTimeout(1_000);
      for (const p of both) {
        const accept = p.getByRole("button", { name: "Accept" });
        if (await accept.isVisible()) await accept.click();
      }
      await expectFrames(both);
      for (const p of both) {
        await expect(p.getByText(/to turn on video/)).toBeHidden();
      }
    });
  } catch (err) {
    // What each page's <video> elements actually hold when frames don't come.
    for (const [who, p] of [["a", a.page], ["b", b.page]] as const) {
      const state = await p
        .evaluate(() =>
          [...document.querySelectorAll("video")].map((v) => {
            const s = v.srcObject as MediaStream | null;
            return {
              w: v.videoWidth,
              rs: v.readyState,
              tracks: s?.getTracks().map((t) => `${t.kind}:${t.readyState}${t.muted ? ":muted" : ""}`),
            };
          }),
        )
        .catch((e) => String(e));
      logs.push(`${who} videos: ${JSON.stringify(state)}`);
    }
    throw err;
  } finally {
    await testInfo.attach("browser-console", { body: logs.join("\n") || "(none)" });
    if (testInfo.status !== testInfo.expectedStatus || logs.length) console.log(logs.join("\n"));
  }

  await a.context.close();
  await b.context.close();
});
