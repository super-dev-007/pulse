import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";
import type { PollResponse, SignalType } from "../lib/types";

// API-level checks for the coordination server: presence, busy/partner state
// and mailbox delivery. No browser or Mapbox needed.

function user(request: APIRequestContext, lat = 38.72, lng = -9.14) {
  const id = randomUUID();
  return {
    id,
    async join() {
      const res = await request.post("/api/join", { data: { id, lat, lng } });
      expect(res.ok()).toBeTruthy();
    },
    async poll(): Promise<PollResponse> {
      const res = await request.get(`/api/poll?id=${encodeURIComponent(id)}`);
      expect(res.ok()).toBeTruthy();
      return res.json();
    },
    async signal(toId: string, type: SignalType, payload?: string) {
      const res = await request.post("/api/signal", {
        data: { fromId: id, toId, type, payload },
      });
      expect(res.ok()).toBeTruthy();
    },
    // Same shape navigator.sendBeacon produces: a text/plain JSON body.
    async leave(peerId?: string) {
      const res = await request.post("/api/leave", {
        headers: { "content-type": "text/plain;charset=UTF-8" },
        data: JSON.stringify({ id, peerId }),
      });
      expect(res.ok()).toBeTruthy();
    },
  };
}

type User = ReturnType<typeof user>;

const peerOf = (r: PollResponse, u: User) => r.peers.find((p) => p.id === u.id);
const signalsFrom = (r: PollResponse, u: User) =>
  r.signals.filter((s) => s.fromId === u.id).map((s) => s.type);

async function connect(a: User, b: User) {
  await a.signal(b.id, "request");
  expect(signalsFrom(await b.poll(), a)).toEqual(["request"]);
  await b.signal(a.id, "accept");
  expect(signalsFrom(await a.poll(), b)).toEqual(["accept"]);
}

test("online users see each other and a silent user drops off the map", async ({
  request,
}) => {
  test.setTimeout(45_000);
  const [a, b, silent] = [user(request), user(request), user(request)];
  await Promise.all([a.join(), b.join(), silent.join()]);

  const first = await a.poll();
  expect(peerOf(first, b)).toBeTruthy();
  expect(peerOf(first, silent)).toBeTruthy();
  expect(peerOf(first, a)).toBeUndefined(); // never yourself

  // a and b keep polling past the 15s stale window; `silent` doesn't.
  const until = Date.now() + 17_000;
  while (Date.now() < until) {
    await Promise.all([a.poll(), b.poll()]);
    await new Promise((r) => setTimeout(r, 1_500));
  }

  const later = await a.poll();
  expect(peerOf(later, b)).toBeTruthy();
  expect(peerOf(later, silent)).toBeUndefined();

  // The reaped user is told to re-join, and re-joining restores the dot.
  expect((await silent.poll()).present).toBe(false);
  await silent.join();
  expect((await silent.poll()).present).toBe(true);
  expect(peerOf(await a.poll(), silent)).toBeTruthy();
});

test("accepting pairs both users and ending frees them", async ({ request }) => {
  const [a, b, observer] = [user(request), user(request), user(request)];
  await Promise.all([a.join(), b.join(), observer.join()]);

  await connect(a, b);
  let seen = await observer.poll();
  expect(peerOf(seen, a)?.busy).toBe(true);
  expect(peerOf(seen, b)?.busy).toBe(true);

  await a.signal(b.id, "end");
  expect(signalsFrom(await b.poll(), a)).toEqual(["end"]);
  seen = await observer.poll();
  expect(peerOf(seen, a)?.busy).toBe(false);
  expect(peerOf(seen, b)?.busy).toBe(false);
});

test("a stray end cannot free someone who is mid-conversation", async ({
  request,
}) => {
  const [a, b, stranger] = [user(request), user(request), user(request)];
  await Promise.all([a.join(), b.join(), stranger.join()]);
  await connect(a, b);

  // e.g. a request `stranger` sent earlier and then cancelled.
  await stranger.signal(a.id, "end");
  // ...or a busy client auto-declining a request that slipped through.
  await a.signal(stranger.id, "decline");

  const seen = await stranger.poll();
  expect(peerOf(seen, a)?.busy).toBe(true);
  expect(peerOf(seen, b)?.busy).toBe(true);
});

test("leaving ends the conversation for the partner", async ({ request }) => {
  const [a, b, observer] = [user(request), user(request), user(request)];
  await Promise.all([a.join(), b.join(), observer.join()]);
  await connect(a, b);

  await a.leave();

  expect(signalsFrom(await b.poll(), a)).toEqual(["end"]);
  const seen = await observer.poll();
  expect(peerOf(seen, a)).toBeUndefined();
  expect(peerOf(seen, b)?.busy).toBe(false);
});

test("a pending request is dismissed when the requester leaves", async ({
  request,
}) => {
  const [a, b] = [user(request), user(request)];
  await Promise.all([a.join(), b.join()]);

  await a.signal(b.id, "request");
  expect(signalsFrom(await b.poll(), a)).toEqual(["request"]); // b sees the prompt
  await a.leave(b.id);
  expect(signalsFrom(await b.poll(), a)).toEqual(["end"]); // prompt dismissed
});

test("accepting a request from someone who left tells the accepter", async ({
  request,
}) => {
  const [a, b, observer] = [user(request), user(request), user(request)];
  await Promise.all([a.join(), b.join(), observer.join()]);

  await a.signal(b.id, "request");
  await b.poll();
  await a.leave(); // gone before b answers
  await b.signal(a.id, "accept");

  expect(signalsFrom(await b.poll(), a)).toEqual(["end"]);
  expect(peerOf(await observer.poll(), b)?.busy).toBe(false);
});

test("requests to a busy user are auto-declined", async ({ request }) => {
  const [a, b, c] = [user(request), user(request), user(request)];
  await Promise.all([a.join(), b.join(), c.join()]);
  await connect(a, b);

  await c.signal(a.id, "request");
  expect(signalsFrom(await c.poll(), a)).toEqual(["decline"]);
  expect(signalsFrom(await a.poll(), c)).toEqual([]); // never reached a
});
