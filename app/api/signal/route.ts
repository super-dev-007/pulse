import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  DECLINE_COOLDOWN_MS,
  MAILBOX_CAP,
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

type Me = { id: string; partnerId: string | null; outgoingTo: string | null };

// POST /api/signal — Authorization: Bearer <token>, body { toId, type, payload? }
// Drops one message into the recipient's mailbox — but only if it's a legal
// move in the connection state machine. The sender is always the token's
// session, never an id from the body.
//
//   request              idle sender → online, free recipient (pending)
//   accept / decline     only answers a request the recipient sent *you*
//   offer / answer / ice only between connected partners
//   end                  hang up your partner, or withdraw your own request
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
  if (me.outgoingTo) {
    // One pending request at a time — no fanning out to the whole map.
    return Response.json({ error: "request already pending" }, { status: 409 });
  }
  if (!(await allow(`request:${me.id}`, REQUESTS_PER_MIN, 60_000))) {
    return tooManyRequests(60);
  }

  const now = Date.now();
  const target = await prisma.presence.findUnique({
    where: { id: toId },
    select: { busy: true, lastSeen: true },
  });
  const blocked = await prisma.block.findFirst({
    where: { blockerId: toId, blockedId: me.id, expiresAt: { gt: new Date(now) } },
    select: { expiresAt: true },
  });
  const online = !!target && target.lastSeen.getTime() >= now - STALE_MS;
  if (!online || target.busy || blocked) {
    // Offline, already talking to someone, or recently said no to us: decline
    // on their behalf. Deliberately indistinguishable, so a cooldown (or a
    // block) can't be detected and nobody gets re-prompted.
    await deliver(toId, me.id, "decline");
    return ok({ autoDeclined: true });
  }
  await prisma.presence.update({
    where: { id: me.id },
    data: { outgoingTo: toId },
  });
  await deliver(me.id, toId, "request");
  return ok();
}

async function handleAccept(me: Me, toId: string) {
  // Claim the requester with a compare-and-set: it only succeeds if they're
  // still waiting on *us* and haven't connected elsewhere in the meantime.
  const claimed =
    me.partnerId === null &&
    (
      await prisma.presence.updateMany({
        where: { id: toId, outgoingTo: me.id, partnerId: null },
        data: { busy: true, partnerId: me.id, outgoingTo: null },
      })
    ).count === 1;
  if (!claimed) {
    // The request was withdrawn, or they left / connected elsewhere: tell the
    // accepter so they don't sit in "Connecting…".
    await deliver(toId, me.id, "end");
    return ok({ ended: true });
  }
  await prisma.presence.update({
    where: { id: me.id },
    data: { busy: true, partnerId: toId, outgoingTo: null },
  });
  await deliver(me.id, toId, "accept");
  return ok();
}

async function handleDecline(me: Me, toId: string) {
  const { count } = await prisma.presence.updateMany({
    where: { id: toId, outgoingTo: me.id },
    data: { outgoingTo: null },
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
    await prisma.presence.update({
      where: { id: me.id },
      data: { outgoingTo: null },
    });
  } else {
    return ok({ dropped: true }); // nothing between us to end
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
