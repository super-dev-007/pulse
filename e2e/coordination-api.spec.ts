import { test, expect, type APIRequestContext } from "@playwright/test";
import type { JoinResponse, PollResponse, SignalType } from "../lib/types";

// API-level checks for the coordination server: sessions, presence,
// busy/partner state and mailbox delivery. No browser or Mapbox needed.

// A random address in the 198.18.0.0/15 benchmarking range.
const randomIp = () =>
  `198.${18 + (Math.random() < 0.5 ? 0 : 1)}.${(Math.random() * 256) | 0}.${(Math.random() * 256) | 0}`;

function user(request: APIRequestContext, lat = 38.72, lng = -9.14) {
  let session: JoinResponse | null = null;
  const auth = () => ({ Authorization: `Bearer ${session!.token}` });
  // Each simulated user is its own client, so the per-IP join limit doesn't
  // couple unrelated tests (locally nothing overwrites x-forwarded-for).
  const ip = randomIp();
  return {
    get id() {
      return session!.id;
    },
    get token() {
      return session!.token;
    },
    async join() {
      const res = await request.post("/api/join", {
        data: { lat, lng },
        headers: { "x-forwarded-for": ip },
      });
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
    async leave() {
      const res = await request.post("/api/leave", {
        headers: { "content-type": "text/plain;charset=UTF-8" },
        data: JSON.stringify({ token: session!.token }),
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

    // Coming back within the grace period resumes the same session — and the
    // same dot, so repeated returns can't be averaged toward the real spot.
    expect(await silent.pollStatus()).toBe(200);
    const back = peerOf(await a.poll(), silent);
    expect(back).toBeTruthy();
    expect([back!.lat, back!.lng]).toEqual([
      peerOf(first, silent)!.lat,
      peerOf(first, silent)!.lng,
    ]);
  });

  test("a session that left is gone for good", async ({ request }) => {
    const u = user(request);
    await u.join();
    await u.leave();
    expect(await u.pollStatus()).toBe(401); // the client re-joins on 401
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
    await a.leave();
    expect(signalsFrom(await b.poll(), a)).toEqual(["end"]); // prompt dismissed
  });

  test("leaving tells whoever was waiting on a request to you", async ({
    request,
  }) => {
    const [a, b] = [user(request), user(request)];
    await Promise.all([a.join(), b.join()]);

    await a.signal(b.id, "request");
    await b.poll(); // b sees the prompt, then closes the tab
    await b.leave();
    expect(signalsFrom(await a.poll(), b)).toEqual(["end"]); // "no longer available"
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

    // One `end` from the leave (dismiss the prompt), one for the stale accept.
    const told = signalsFrom(await b.poll(), a);
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((t) => t === "end")).toBe(true);
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

test.describe("connection state machine (security)", () => {
  const OFFER = JSON.stringify({ type: "offer", sdp: "v=0\r\n" });

  test("an accept nobody asked for pairs no one", async ({ request }) => {
    const [attacker, victim, observer] = [
      user(request),
      user(request),
      user(request),
    ];
    await Promise.all([attacker.join(), victim.join(), observer.join()]);

    await attacker.signal(victim.id, "accept");

    expect(signalsFrom(await victim.poll(), attacker)).toEqual([]);
    const seen = await observer.poll();
    expect(peerOf(seen, victim)?.busy).toBe(false);
    expect(peerOf(seen, attacker)?.busy).toBe(false);
  });

  test("WebRTC payloads only flow between connected partners", async ({
    request,
  }) => {
    const [a, b, outsider] = [user(request), user(request), user(request)];
    await Promise.all([a.join(), b.join(), outsider.join()]);

    expect(await outsider.signal(b.id, "offer", OFFER)).toBe(409);
    await connect(a, b);
    expect(await outsider.signal(b.id, "offer", OFFER)).toBe(409);
    expect(signalsFrom(await b.poll(), outsider)).toEqual([]);

    expect(await a.signal(b.id, "offer", OFFER)).toBe(200);
    expect(signalsFrom(await b.poll(), a)).toEqual(["offer"]);
  });

  test("declines and ends need a relationship to be delivered", async ({
    request,
  }) => {
    const [attacker, victim] = [user(request), user(request)];
    await Promise.all([attacker.join(), victim.join()]);

    await attacker.signal(victim.id, "decline");
    await attacker.signal(victim.id, "end");
    expect(signalsFrom(await victim.poll(), attacker)).toEqual([]);
  });

  test("a withdrawn request can't be accepted", async ({ request }) => {
    const [a, b, observer] = [user(request), user(request), user(request)];
    await Promise.all([a.join(), b.join(), observer.join()]);

    await a.signal(b.id, "request");
    await b.poll();
    await a.signal(b.id, "end"); // cancel before b answers
    await b.signal(a.id, "accept");

    expect(signalsFrom(await b.poll(), a)).toContain("end");
    expect(signalsFrom(await a.poll(), b)).toEqual([]); // no accept reached a
    expect(peerOf(await observer.poll(), a)?.busy).toBe(false);
  });

  test("payloads are validated per type and re-serialised", async ({
    request,
  }) => {
    const [a, b] = [user(request), user(request)];
    await Promise.all([a.join(), b.join()]);
    await connect(a, b);

    expect(await a.signal(b.id, "offer", "not json")).toBe(400);
    expect(await a.signal(b.id, "offer", JSON.stringify({ type: "answer", sdp: "x" }))).toBe(400);
    expect(await a.signal(b.id, "end", "unexpected payload")).toBe(400);
    expect(await a.signal(b.id, "ice", JSON.stringify({ candidate: "x".repeat(5000) }))).toBe(400);

    const smuggled = JSON.stringify({ type: "offer", sdp: "v=0\r\n", extra: "<script>" });
    expect(await a.signal(b.id, "offer", smuggled)).toBe(200);
    const [offer] = (await b.poll()).signals;
    expect(JSON.parse(offer.payload!)).toEqual({ type: "offer", sdp: "v=0\r\n" });
  });
});

test.describe("abuse limits (security)", () => {
  test("joins are rate-limited per client IP", async ({ request }) => {
    const ip = randomIp();
    const join = () =>
      request.post("/api/join", {
        data: { lat: 1, lng: 1 },
        headers: { "x-forwarded-for": ip },
      });
    for (let i = 0; i < 30; i++) expect((await join()).status()).toBe(200);
    const limited = await join();
    expect(limited.status()).toBe(429);
    expect(limited.headers()["retry-after"]).toBeTruthy();
  });

  test("only one pending request at a time", async ({ request }) => {
    const [a, b, c] = [user(request), user(request), user(request)];
    await Promise.all([a.join(), b.join(), c.join()]);

    expect(await a.signal(b.id, "request")).toBe(200);
    expect(await a.signal(c.id, "request")).toBe(409);
    expect(signalsFrom(await c.poll(), a)).toEqual([]);
  });

  test("someone who declined you can't be re-asked right away", async ({
    request,
  }) => {
    const [a, b] = [user(request), user(request)];
    await Promise.all([a.join(), b.join()]);

    await a.signal(b.id, "request");
    await b.poll();
    await b.signal(a.id, "decline");
    expect(signalsFrom(await a.poll(), b)).toEqual(["decline"]);

    // Asking again is quietly auto-declined; b is never re-prompted.
    expect(await a.signal(b.id, "request")).toBe(200);
    expect(signalsFrom(await a.poll(), b)).toEqual(["decline"]);
    expect(signalsFrom(await b.poll(), a)).toEqual([]);
  });

  test("connection requests are rate-limited per session", async ({
    request,
  }) => {
    const [a, b] = [user(request), user(request)];
    await Promise.all([a.join(), b.join()]);

    for (let i = 0; i < 10; i++) {
      expect(await a.signal(b.id, "request")).toBe(200);
      expect(await a.signal(b.id, "end")).toBe(200); // withdraw, ask again...
    }
    expect(await a.signal(b.id, "request")).toBe(429);
  });

  test("a recipient's mailbox can't be flooded", async ({ request }) => {
    const [a, b] = [user(request), user(request)];
    await Promise.all([a.join(), b.join()]);
    await connect(a, b);

    const ice = JSON.stringify({ candidate: "candidate:1 1 udp 1 0.0.0.0 9 typ host", sdpMid: "0" });
    // b isn't polling, so nothing drains.
    for (let i = 0; i < 100; i++) expect(await a.signal(b.id, "ice", ice)).toBe(200);
    expect(await a.signal(b.id, "ice", ice)).toBe(429);
    // State changes still get through a full mailbox.
    expect(await a.signal(b.id, "end")).toBe(200);
  });
});

test.describe("blocking (safety)", () => {
  async function block(request: APIRequestContext, blocker: User, toId: string) {
    const res = await request.post("/api/block", {
      headers: { Authorization: `Bearer ${blocker.token}` },
      data: { toId },
    });
    expect(res.ok()).toBeTruthy();
  }

  test("blocked users vanish from each other's map and can't call", async ({
    request,
  }) => {
    const [a, b, c] = [user(request), user(request), user(request)];
    await Promise.all([a.join(), b.join(), c.join()]);

    await block(request, a, b.id);

    expect(peerOf(await a.poll(), b)).toBeUndefined();
    expect(peerOf(await b.poll(), a)).toBeUndefined();
    expect(peerOf(await c.poll(), a)).toBeTruthy(); // everyone else still sees a

    // b's request is quietly auto-declined; a is never prompted.
    expect(await b.signal(a.id, "request")).toBe(200);
    expect(signalsFrom(await b.poll(), a)).toEqual(["decline"]);
    expect(signalsFrom(await a.poll(), b)).toEqual([]);
  });

  test("blocking mid-conversation ends it for both", async ({ request }) => {
    const [a, b, observer] = [user(request), user(request), user(request)];
    await Promise.all([a.join(), b.join(), observer.join()]);
    await connect(a, b);

    await block(request, b, a.id);

    expect(signalsFrom(await a.poll(), b)).toEqual(["end"]);
    const seen = await observer.poll();
    expect(peerOf(seen, a)?.busy).toBe(false);
    expect(peerOf(seen, b)?.busy).toBe(false);
  });

  test("a decline cooldown doesn't hide anyone", async ({ request }) => {
    const [a, b] = [user(request), user(request)];
    await Promise.all([a.join(), b.join()]);

    await a.signal(b.id, "request");
    await b.poll();
    await b.signal(a.id, "decline");
    expect(peerOf(await a.poll(), b)).toBeTruthy();
  });
});
