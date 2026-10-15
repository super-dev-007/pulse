import { test, expect, type Page } from "@playwright/test";
import { LISBON, PORTO, connect, enter, needsMap, remoteDetail, startVideo } from "./helpers";

// Mutual Reveal, measured on the wire: what each side *receives* stays
// frosted until both have revealed, and goes frosted again the moment either
// one changes their mind. Both cameras show a fine checkerboard; measured,
// a clear feed scores ~30 and a frosted one ~0.

test.skip(needsMap(), "needs NEXT_PUBLIC_MAPBOX_TOKEN to render the map");

const FROSTED_BELOW = 3;
const CLEAR_ABOVE = 15;

const stage = (p: Page) => p.locator("[data-revealed]");

async function expectReceived(pages: Page[], revealed: boolean) {
  for (const p of pages) {
    await expect(stage(p)).toHaveAttribute("data-revealed", String(revealed));
    const detail = expect.poll(() => remoteDetail(p), { timeout: 15_000 });
    if (revealed) await detail.toBeGreaterThan(CLEAR_ABOVE);
    else await detail.toBeLessThan(FROSTED_BELOW);
  }
}

test("video stays frosted until both reveal, and either can frost again", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const a = await enter(browser, LISBON, { checkerboard: true });
  const b = await enter(browser, PORTO, { checkerboard: true });
  await connect(a.page, b.page, b.id);
  await startVideo(a.page, b.page);
  const both = [a.page, b.page];

  // 1) Nobody has revealed: both receive frosted frames.
  await expectReceived(both, false);

  // 2) Only a reveals: still frosted both ways — no one-sided exposure.
  await a.page.getByRole("button", { name: "Reveal me" }).first().click();
  await expect(b.page.getByText(/is ready to reveal/)).toBeVisible();
  await b.page.waitForTimeout(1_500); // would a leak show up? give it time
  await expectReceived(both, false);

  // 3) b reveals too: both now receive clear video.
  await b.page.getByRole("button", { name: "Reveal me" }).first().click();
  await expectReceived(both, true);

  // 4) a frosts again: both go back to frosted, instantly and mutually.
  await a.page.getByRole("button", { name: "Frost me", exact: true }).click();
  await expectReceived(both, false);

  await a.context.close();
  await b.context.close();
});
