import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  MAX_PEERS,
  SESSION_GRACE_MS,
  SIGNAL_TTL_MS,
  STALE_MS,
} from "@/lib/presence";
import { deleteSessions, endConversations } from "@/lib/presence-server";
import { bearerToken, hashToken, isNotFound, unauthorized } from "@/lib/session";
import type { PollResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/poll — Authorization: Bearer <token>. The single endpoint that
// drives the live map. It (1) heartbeats the caller, (2) reaps stale presence
// + orphan signals, (3) returns the filtered online peers, and (4) drains this
// user's mailbox. POST because it has side effects; the token travels in a
// header so it never lands in URLs or access logs.
export async function POST(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) return unauthorized();

  const now = Date.now();
  const staleCutoff = new Date(now - STALE_MS);

  // 1) Heartbeat the caller only — this also authenticates the token, and
  // revives a session that went stale within its grace period. No row means
  // it was away longer than that (or never existed): 401, and the client
  // re-joins.
  let id: string;
  try {
    ({ id } = await prisma.presence.update({
      where: { tokenHash: hashToken(token) },
      data: { lastSeen: new Date(now) },
      select: { id: true },
    }));
  } catch (err) {
    if (isNotFound(err)) return unauthorized();
    throw err;
  }

  // 2) Stale sessions are hidden from the map right away (see the peers
  // query), and whatever they were part of ends now, so nobody waits on
  // them. The row itself survives SESSION_GRACE_MS so a returning tab keeps
  // its dot (see lib/presence.ts); after that it's deleted.
  const wentStale = await prisma.presence.findMany({
    where: {
      lastSeen: { lt: staleCutoff },
      OR: [{ partnerId: { not: null } }, { outgoingTo: { not: null } }],
    },
    select: { id: true, outgoingTo: true },
  });
  if (wentStale.length > 0) {
    await prisma.presence.updateMany({
      where: { id: { in: wentStale.map((s) => s.id) } },
      data: { busy: false, partnerId: null, outgoingTo: null },
    });
    await endConversations(wentStale);
  }
  const expired = await prisma.presence.findMany({
    where: { lastSeen: { lt: new Date(now - SESSION_GRACE_MS) } },
    select: { id: true, outgoingTo: true },
  });
  if (expired.length > 0) {
    await deleteSessions(expired.map((s) => s.id));
    await endConversations(expired);
  }
  await sweep(now);

  // 3) Online peers, excluding self (capped, freshest first).
  const peers = await prisma.presence.findMany({
    where: {
      id: { not: id },
      lastSeen: { gte: staleCutoff },
    },
    select: { id: true, lat: true, lng: true, busy: true },
    orderBy: { lastSeen: "desc" },
    take: MAX_PEERS,
  });

  // 4) Drain this user's mailbox: read, then delete exactly what we read so a
  // concurrently-inserted signal is never lost.
  const inbox = await prisma.signal.findMany({
    where: { toId: id },
    orderBy: { createdAt: "asc" },
  });
  if (inbox.length > 0) {
    await prisma.signal.deleteMany({
      where: { id: { in: inbox.map((s) => s.id) } },
    });
  }

  const response: PollResponse = {
    peers: peers.map((p) => ({
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      busy: p.busy,
    })),
    signals: inbox.map((s) => ({
      id: s.id,
      fromId: s.fromId,
      toId: s.toId,
      type: s.type as PollResponse["signals"][number]["type"],
      payload: s.payload,
      createdAt: s.createdAt.toISOString(),
    })),
  };

  return Response.json(response);
}

// Expire orphaned signals, finished cooldowns and rate-limit windows. It
// doesn't need to run on every poll, so each instance does it at most every
// few seconds instead of adding three deletes to the hottest endpoint.
const SWEEP_EVERY_MS = 10_000;
let lastSweep = 0;

async function sweep(now: number) {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  await prisma.signal.deleteMany({
    where: { createdAt: { lt: new Date(now - SIGNAL_TTL_MS) } },
  });
  await prisma.block.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
  await prisma.rateLimit.deleteMany({ where: { resetAt: { lt: new Date(now) } } });
}
