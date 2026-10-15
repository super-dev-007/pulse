import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  DECLINE_COOLDOWN_MS,
  MAILBOX_CAP,
  REQUEST_TTL_MS,
  REQUESTS_PER_MIN,
  SIGNALS_PER_MIN,
  STALE_MS,
} from "@/lib/presence";
import { allow, tooManyRequests } from "@/lib/rate-limit";
import { bearerToken, findSession, isSessionId, unauthorized } from "@/lib/session";
import { normalizePayload } from "@/lib/signal-payload";
import type { SignalType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TYPES: SignalType[] = [
  "request",
  "accept",
  "decline",
  "offer",
  "answer",
  "ice",
  "end",
];

type Me = {
  id: string;
  partnerId: string | null;
  outgoingTo: string | null;
  outgoingAt: Date | null;
};

// POST /api/signal — Authorization: Bearer <token>, body { toId, type, payload? }
// Drops one message into the recipient's mailbox — but only if it's a legal
// move in the connection state machine. The sender is always the token's
// session, never an id from the body.
//
//   request              idle sender → online, free recipient (pending)
//   accept / decline     only answers a request the recipient sent *you*
//                        (decline = "no": the asker gets a cooldown)
//   offer / answer / ice only between connected partners
//   end                  hang up your partner, withdraw your own request, or
//                        "not now" to a request sent to you (no cooldown)
//
// There are no transactions (PgBouncer), so every state change is a
// compare-and-set; a write that loses a race changes nothing.
//
// Anything else is dropped, so nobody can pair, free, or push WebRTC payloads
// at people they aren't actually talking to. Busy/partner state follows the
// same moves, so a user is only ever in one connection at a time.
export async function POST(request: NextRequest) {
  const me = await findSession(bearerToken(request));
  if (!me) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { toId, type, payload } = (body ?? {}) as Record<string, unknown>;

  if (!isSessionId(toId) || toId === me.id) {
    return Response.json({ error: "invalid recipient" }, { status: 400 });
  }
  if (typeof type !== "string" || !VALID_TYPES.includes(type as SignalType)) {
    return Response.json({ error: "invalid type" }, { status: 400 });
  }
  const signalType = type as SignalType;
  const payloadStr = normalizePayload(signalType, payload);
  if (payloadStr === undefined) {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }

  // Bound how much one session can write...
  if (!(await allow(`signal:${me.id}`, SIGNALS_PER_MIN, 60_000))) {
    return tooManyRequests(60);
  }
  // ...and how much can pile up for one recipient (a live mailbox drains
  // every poll). Only for the bulk types: accept/decline/end carry state
  // changes and must always go through.
  const bulk = signalType === "request" || isRelay(signalType);
  if (bulk && (await prisma.signal.count({ where: { toId } })) >= MAILBOX_CAP) {
    return tooManyRequests(2);
  }

  switch (signalType) {
    case "request":
      return handleRequest(me, toId);
    case "accept":
      return handleAccept(me, toId);
    case "decline":
      return handleDecline(me, toId);
    case "end":
      return handleEnd(me, toId);
    default:
      // offer / answer / ice: WebRTC negotiation between partners only.
      if (me.partnerId !== toId) {
        return Response.json({ error: "not connected" }, { status: 409 });
      }
      await deliver(me.id, toId, signalType, payloadStr);
      return ok();
  }
}

async function handleRequest(me: Me, toId: string) {
  if (me.partnerId) {
    return Response.json({ error: "already connected" }, { status: 409 });
  }
  const now = Date.now();
  const live = (at: Date | null) => !!at && at.getTime() >= now - REQUEST_TTL_MS;
  if (me.outgoingTo && live(me.outgoingAt)) {
    // One pending request at a time — no fanning out to the whole map.
    return Response.json({ error: "request already pending" }, { status: 409 });
  }
  if (!(await allow(`request:${me.id}`, REQUESTS_PER_MIN, 60_000))) {
    return tooManyRequests(60);
  }

  const target = await prisma.presence.findUnique({
    where: { id: toId },
    select: { busy: true, lastSeen: true, outgoingTo: true, outgoingAt: true },
  });
  // They tapped us first and that request is still open: a mutual tap. Leave
  // their request in place — our client sees it and accepts it — rather than
  // turning each other down.
  if (target?.outgoingTo === me.id && live(target.outgoingAt)) {
    return ok({ crossing: true });
  }
  // They said no recently, or one of us blocked the other.
  const blocked = await prisma.block.findFirst({
    where: {
      expiresAt: { gt: new Date(now) },
      OR: [
        { blockerId: toId, blockedId: me.id },
        { blockerId: me.id, blockedId: toId, hidden: true },
      ],
    },
    select: { expiresAt: true },
  });
  // Mid-request themselves, or already being asked by someone else.
  const occupied =
    !!target &&
    ((!!target.outgoingTo && live(target.outgoingAt)) ||
      (await prisma.presence.count({
        where: {
          outgoingTo: toId,
          outgoingAt: { gte: new Date(now - REQUEST_TTL_MS) },
        },
      })) > 0);
  const online = !!target && target.lastSeen.getTime() >= now - STALE_MS;
  if (!online || target.busy || occupied || blocked) {
    // Offline, busy, or recently said no to us: decline on their behalf
    // (no cooldown — they never chose). Deliberately indistinguishable, so a
    // cooldown or block can't be detected, and nobody gets re-prompted.
    await deliver(toId, me.id, "decline");
    return ok({ autoDeclined: true });
  }
  // A request opens a fresh exchange between the two of us. Anything still
  // undelivered between us belongs to an earlier one — e.g. the hang-up
  // `end` from a call that just finished — and would be misread as an answer
  // to this request ("no longer around"), killing it.
  await prisma.signal.deleteMany({
    where: {
      OR: [
        { fromId: me.id, toId },
        { fromId: toId, toId: me.id },
      ],
    },
  });
  // Take our single request slot atomically, so parallel requests can't
  // fan out (an expired request may be replaced).
  const claimed = await prisma.presence.updateMany({
    where: {
      id: me.id,
      partnerId: null,
      OR: [
        { outgoingTo: null },
        { outgoingAt: null },
        { outgoingAt: { lt: new Date(now - REQUEST_TTL_MS) } },
      ],
    },
    data: { outgoingTo: toId, outgoingAt: new Date(now) },
  });
  if (claimed.count === 0) {
    return Response.json({ error: "request already pending" }, { status: 409 });
  }
  // The expired request we just replaced: dismiss its prompt over there.
  if (me.outgoingTo && me.outgoingTo !== toId) {
    await deliver(me.id, me.outgoingTo, "end");
  }
  await deliver(me.id, toId, "request");
  return ok();
}

async function handleAccept(me: Me, toId: string) {
  // Pair with two compare-and-sets: claim ourselves (we must be free), then
  // the requester (still waiting on *us*, request not expired, not connected
  // elsewhere). If the second fails, undo the first.
  const mine = await prisma.presence.updateMany({
    where: { id: me.id, partnerId: null },
    data: { busy: true, partnerId: toId, outgoingTo: null, outgoingAt: null },
  });
  if (mine.count === 0) {
    return Response.json({ error: "already connected" }, { status: 409 });
  }
  const theirs = await prisma.presence.updateMany({
    where: {
      id: toId,
      outgoingTo: me.id,
      partnerId: null,
      outgoingAt: { gte: new Date(Date.now() - REQUEST_TTL_MS) },
    },
    data: { busy: true, partnerId: me.id, outgoingTo: null, outgoingAt: null },
  });
  if (theirs.count === 0) {
    await prisma.presence.updateMany({
      where: { id: me.id, partnerId: toId },
      data: { busy: false, partnerId: null },
    });
    // The request was withdrawn or expired, or they left / connected
    // elsewhere: tell the accepter so they don't sit in "Connecting…".
    await deliver(toId, me.id, "end");
    return ok({ ended: true });
  }
  // Had we asked someone else meanwhile? That request is gone now — say so.
  if (me.outgoingTo && me.outgoingTo !== toId) {
    await deliver(me.id, me.outgoingTo, "end");
  }
  await deliver(me.id, toId, "accept");
  return ok();
}

async function handleDecline(me: Me, toId: string) {
  const { count } = await prisma.presence.updateMany({
    where: { id: toId, outgoingTo: me.id },
    data: { outgoingTo: null, outgoingAt: null },
  });
  if (count === 0) return ok({ dropped: true }); // no request to decline
  await coolDown(me.id, toId, DECLINE_COOLDOWN_MS);
  await deliver(me.id, toId, "decline");
  return ok();
}

// `blocked` may not request `blocker` for `ms`. Never shortens a longer block.
async function coolDown(blockerId: string, blockedId: string, ms: number) {
  const expiresAt = new Date(Date.now() + ms);
  const key = { blockerId_blockedId: { blockerId, blockedId } };
  const existing = await prisma.block.findUnique({ where: key });
  if (existing && existing.expiresAt >= expiresAt) return;
  await prisma.block.upsert({
    where: key,
    create: { blockerId, blockedId, expiresAt },
    update: { expiresAt },
  });
}

async function handleEnd(me: Me, toId: string) {
  if (me.partnerId === toId) {
    // Hang up: free the pair.
    await prisma.presence.updateMany({
      where: {
        OR: [
          { id: me.id, partnerId: toId },
          { id: toId, partnerId: me.id },
        ],
      },
      data: { busy: false, partnerId: null },
    });
  } else if (me.outgoingTo === toId) {
    // Withdraw our pending request (cancelled or timed out).
    await prisma.presence.updateMany({
      where: { id: me.id, outgoingTo: toId },
      data: { outgoingTo: null, outgoingAt: null },
    });
  } else {
    // "Not now" to a request sent to us while we were busy or mid-request:
    // turn it down without the cooldown an explicit decline carries.
    const { count } = await prisma.presence.updateMany({
      where: { id: toId, outgoingTo: me.id },
      data: { outgoingTo: null, outgoingAt: null },
    });
    if (count === 0) return ok({ dropped: true }); // nothing between us to end
  }
  await deliver(me.id, toId, "end");
  return ok();
}

function isRelay(type: SignalType) {
  return type === "offer" || type === "answer" || type === "ice";
}

function deliver(
  fromId: string,
  toId: string,
  type: SignalType,
  payload: string | null = null,
) {
  return prisma.signal.create({ data: { fromId, toId, type, payload } });
}

function ok(extra?: Record<string, unknown>) {
  return Response.json({ ok: true, ...extra });
}
