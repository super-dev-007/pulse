import { test, expect, type Page } from "@playwright/test";
import { LISBON, PORTO, connect, enter, needsMap, remoteDetail, startVideo } from "./helpers";

// Mutual Reveal, measured on the wire: what each side *receives* stays
// frosted until both have revealed, and goes frosted again the moment either
// one changes their mind.

test.skip(needsMap(), "needs NEXT_PUBLIC_MAPBOX_TOKEN to render the map");

const FROSTED_MAX = 1.5; // mean neighbour-pixel luma difference

async function settledDetail(page: Page) {
  // Give replaceTrack + the encoder a moment to switch sources.
  await page.waitForTimeout(1_500);
  return remoteDetail(page);
}

test("video stays frosted until both reveal, and either can frost again", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const a = await enter(browser, LISBON);
  const b = await enter(browser, PORTO);
  await connect(a.page, b.page, b.id);
  await startVideo(a.page, b.page);

  const stage = (p: Page) => p.locator("[data-revealed]");

  // 1) Nobody has revealed: both receive frosted frames.
  for (const p of [a.page, b.page]) {
    await expect(stage(p)).toHaveAttribute("data-revealed", "false");
    expect(await settledDetail(p)).toBeLessThan(FROSTED_MAX);
  }

  // 2) Only a reveals: still frosted both ways (no one-sided exposure).
  await a.page.getByRole("button", { name: "Reveal me" }).first().click();
  await expect(b.page.getByText(/is ready to reveal/)).toBeVisible();
  for (const p of [a.page, b.page]) {
    await expect(stage(p)).toHaveAttribute("data-revealed", "false");
    expect(await settledDetail(p)).toBeLessThan(FROSTED_MAX);
  }

  // 3) b reveals too: both now receive clear video.
  await b.page.getByRole("button", { name: "Reveal me" }).first().click();
  for (const p of [a.page, b.page]) {
    await expect(stage(p)).toHaveAttribute("data-revealed", "true");
    await expect.poll(() => remoteDetail(p), { timeout: 15_000 }).toBeGreaterThan(FROSTED_MAX * 2);
  }

  // 4) a frosts again: both go back to frosted, instantly and mutually.
  await a.page.getByRole("button", { name: "Frost me" }).click();
  for (const p of [a.page, b.page]) {
    await expect(stage(p)).toHaveAttribute("data-revealed", "false");
    await expect.poll(() => remoteDetail(p), { timeout: 15_000 }).toBeLessThan(FROSTED_MAX);
  }

  await a.context.close();
  await b.context.close();
});
