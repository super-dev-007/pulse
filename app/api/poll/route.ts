import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { MAX_PEERS, STALE_MS, SIGNAL_TTL_MS } from "@/lib/presence";
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

  // 1) Heartbeat the caller only — this also authenticates the token. No row
  // means the session was reaped while away (e.g. a backgrounded tab whose
  // timers were throttled) or never existed: 401, and the client re-joins.
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

  // 2) Reap stale sessions. Anyone mid-conversation with (or waiting on) a
  // reaped user is released and told.
  const stale = await prisma.presence.findMany({
    where: { lastSeen: { lt: staleCutoff } },
    select: { id: true, outgoingTo: true },
  });
  if (stale.length > 0) {
    await deleteSessions(stale.map((s) => s.id));
    await endConversations(stale);
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
