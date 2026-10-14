import { test, expect, type APIRequestContext } from "@playwright/test";
import type { JoinResponse, PollResponse, SignalType } from "../lib/types";

// API-level checks for the coordination server: sessions, presence,
// busy/partner state and mailbox delivery. No browser or Mapbox needed.

function user(request: APIRequestContext, lat = 38.72, lng = -9.14) {
  let session: JoinResponse | null = null;
  const auth = () => ({ Authorization: `Bearer ${session!.token}` });
  return {
    get id() {
      return session!.id;
    },
    get token() {
      return session!.token;
    },
    async join() {
      const res = await request.post("/api/join", { data: { lat, lng } });
      expect(res.ok()).toBeTruthy();
      session = await res.json();
    },
    async pollStatus() {
      return (await request.post("/api/poll", { headers: auth() })).status();
    },
    async poll(): Promise<PollResponse> {
      const res = await request.post("/api/poll", { headers: auth() });
      expect(res.ok()).toBeTruthy();
      return res.json();
    },
    async signal(toId: string, type: SignalType, payload?: string) {
      const res = await request.post("/api/signal", {
        headers: auth(),
        data: { toId, type, payload },
      });
      return res.status();
    },
    // Same shape navigator.sendBeacon produces: a text/plain JSON body.
    async leave(peerId?: string) {
      const res = await request.post("/api/leave", {
        headers: { "content-type": "text/plain;charset=UTF-8" },
        data: JSON.stringify({ token: session!.token, peerId }),
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
  expect(await a.signal(b.id, "request")).toBe(200);
  expect(signalsFrom(await b.poll(), a)).toEqual(["request"]);
  expect(await b.signal(a.id, "accept")).toBe(200);
  expect(signalsFrom(await a.poll(), b)).toEqual(["accept"]);
}

test.describe("presence and connections", () => {
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

    // The reaped session is rejected, and re-joining puts the user back.
    expect(await silent.pollStatus()).toBe(401);
    await silent.join();
    expect(peerOf(await a.poll(), silent)).toBeTruthy();
  });

  test("accepting pairs both users and ending frees them", async ({ request }) => {
    const [a, b, observer] = [user(request), user(request), user(request)];
    await Promise.all([a.join(), b.join(), observer.join()]);

    await connect(a, b);
    let seen = await observer.poll();
    expect(peerOf(seen, a)?.busy).toBe(true);
    expect(peerOf(seen, b)?.busy).toBe(true);

    expect(await a.signal(b.id, "end")).toBe(200);
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
});

test.describe("sessions (security)", () => {
  test("calls without a valid session token are rejected", async ({
    request,
  }) => {
    expect((await request.post("/api/poll")).status()).toBe(401);
    expect(
      (
        await request.post("/api/poll", {
          headers: { Authorization: "Bearer not-a-real-token" },
        })
      ).status(),
    ).toBe(401);
    const forged = "A".repeat(43); // well-formed, but never issued
    expect(
      (
        await request.post("/api/signal", {
          headers: { Authorization: `Bearer ${forged}` },
          data: { toId: crypto.randomUUID(), type: "request" },
        })
      ).status(),
    ).toBe(401);
  });

  test("a public id is not a credential: no reading mailboxes or kicking people", async ({
    request,
  }) => {
    const [victim, attacker] = [user(request), user(request)];
    await Promise.all([victim.join(), attacker.join()]);
    // The attacker learns the victim's id from the map, like anyone can.
    expect(peerOf(await attacker.poll(), victim)).toBeTruthy();

    // The old id-based endpoints no longer work...
    expect(
      (await request.get(`/api/poll?id=${victim.id}`)).status(),
    ).toBeGreaterThanOrEqual(400);
    await request.post("/api/leave", {
      headers: { "content-type": "text/plain;charset=UTF-8" },
      data: JSON.stringify({ id: victim.id }),
    });

    // ...so the victim is still online and in control of their session.
    expect(peerOf(await attacker.poll(), victim)).toBeTruthy();
    expect(await victim.pollStatus()).toBe(200);
  });

  test("the sender is always the token's session, never a body fromId", async ({
    request,
  }) => {
    const [victim, attacker, target] = [
      user(request),
      user(request),
      user(request),
    ];
    await Promise.all([victim.join(), attacker.join(), target.join()]);

    const res = await request.post("/api/signal", {
      headers: { Authorization: `Bearer ${attacker.token}` },
      data: { fromId: victim.id, toId: target.id, type: "request" },
    });
    expect(res.ok()).toBeTruthy();

    const inbox = await target.poll();
    expect(signalsFrom(inbox, victim)).toEqual([]);
    expect(signalsFrom(inbox, attacker)).toEqual(["request"]);
  });
});
