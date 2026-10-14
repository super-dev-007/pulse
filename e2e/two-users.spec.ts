import { test, expect } from "@playwright/test";
import {
  LISBON,
  PORTO,
  connect,
  dotOf,
  enter,
  needsMap,
  startVideo,
} from "./helpers";

// The full product loop with two real browser sessions: see each other on the
// map, connect, chat both ways, video call, hang up, reconnect, and leave.
// Chrome's fake camera/mic stand in for real devices.

test.skip(needsMap(), "needs NEXT_PUBLIC_MAPBOX_TOKEN to render the map");

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
  await startVideo(a.page, b.page);

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
