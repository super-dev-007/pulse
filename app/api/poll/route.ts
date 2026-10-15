import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { MAX_PEERS, SESSION_GRACE_MS, STALE_MS } from "@/lib/presence";
import { deleteSessions, endConversations, healLinks } from "@/lib/presence-server";
import { bearerToken, hashToken, unauthorized } from "@/lib/session";
import { maybeSweep } from "@/lib/sweep";
import type { PollResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/poll — Authorization: Bearer <token>. The single endpoint that
// drives the live map. It (1) heartbeats the caller, (2) ends whatever stale
// users were part of and sweeps expired data, (3) returns the filtered online
// peers, and (4) drains this user's mailbox. POST because it has side
// effects; the token travels in a header so it never lands in URLs or logs.
export async function POST(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) return unauthorized();

  const now = Date.now();
  const staleCutoff = new Date(now - STALE_MS);

  // 1) Authenticate and heartbeat the caller. A session that went stale but
  // is back within its grace period resumes (same dot); one away longer is
  // over even if no sweep has deleted it yet: clean it up, 401, re-join.
  const me = await prisma.presence.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, lastSeen: true, partnerId: true, outgoingTo: true, outgoingAt: true },
  });
  if (!me) return unauthorized();
  if (me.lastSeen.getTime() < now - SESSION_GRACE_MS) {
    await deleteSessions([me.id]);
    await endConversations([me]);
    return unauthorized();
  }
  await prisma.presence.updateMany({
    where: { id: me.id },
    data: { lastSeen: new Date(now) },
  });
  const id = me.id;
  await healLinks(me, now);

  // 2) Stale sessions are hidden from the map right away (see the peers
  // query), and whatever they were part of ends now, so nobody waits on
  // them. The row itself survives SESSION_GRACE_MS so a returning tab keeps
  // its dot (see lib/presence.ts); the sweep deletes it after that.
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
      data: { busy: false, partnerId: null, outgoingTo: null, outgoingAt: null },
    });
    await endConversations(wentStale);
  }
  await maybeSweep(now);

  // 3) Online peers, excluding self and anyone on either side of a block
  // (capped, freshest first).
  const blocks = await prisma.block.findMany({
    where: {
      hidden: true,
      expiresAt: { gt: new Date(now) },
      OR: [{ blockerId: id }, { blockedId: id }],
    },
    select: { blockerId: true, blockedId: true },
  });
  const hidden = blocks.map((b) => (b.blockerId === id ? b.blockedId : b.blockerId));
  const peers = await prisma.presence.findMany({
    where: {
      id: { notIn: [id, ...hidden] },
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
