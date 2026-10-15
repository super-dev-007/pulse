import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
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

const MAX_PAYLOAD = 64 * 1024; // SDP/ICE are small; cap to be safe.

// POST /api/signal — body { fromId, toId, type, payload? }
// Drops one message into the recipient's mailbox. Also manages the `busy`
// flag so a user can only be in one connection at a time.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { fromId, toId, type, payload } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (typeof fromId !== "string" || typeof toId !== "string") {
    return Response.json({ error: "invalid ids" }, { status: 400 });
  }
  if (typeof type !== "string" || !VALID_TYPES.includes(type as SignalType)) {
    return Response.json({ error: "invalid type" }, { status: 400 });
  }
  if (
    payload !== undefined &&
    payload !== null &&
    (typeof payload !== "string" || payload.length > MAX_PAYLOAD)
  ) {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }

  const signalType = type as SignalType;
  const payloadStr = typeof payload === "string" ? payload : null;

  // Enforce "one active connection at a time": if the target is already busy,
  // auto-decline the request instead of delivering it.
  if (signalType === "request") {
    const target = await prisma.presence.findUnique({
      where: { id: toId },
      select: { busy: true },
    });
    if (!target) {
      // Target went offline — tell the initiator it was declined.
      await sendDecline(toId, fromId);
      return Response.json({ ok: true, autoDeclined: true });
    }
    if (target.busy) {
      await sendDecline(toId, fromId);
      return Response.json({ ok: true, autoDeclined: true });
    }
  }

  // Busy transitions:
  // - accept: the connection is now active → pair both peers (busy).
  // - end: free the pair — but only if they're paired *with each other*, so a
  //   late `end` (say, for a cancelled request) can't free a user who has
  //   since connected to someone else.
  // - decline: nobody is busy before an accept, so it leaves busy alone.
  if (signalType === "accept") {
    // `fromId` accepted `toId`'s request. If the requester has gone (or got
    // connected elsewhere meanwhile), tell the accepter instead of pairing.
    const requester = await prisma.presence.findUnique({
      where: { id: toId },
      select: { busy: true },
    });
    if (!requester || requester.busy) {
      await prisma.signal.create({
        data: { fromId: toId, toId: fromId, type: "end", payload: null },
      });
      return Response.json({ ok: true, ended: true });
    }
    await prisma.presence.updateMany({
      where: { id: fromId },
      data: { busy: true, partnerId: toId },
    });
    await prisma.presence.updateMany({
      where: { id: toId },
      data: { busy: true, partnerId: fromId },
    });
  } else if (signalType === "end") {
    await prisma.presence.updateMany({
      where: {
        OR: [
          { id: fromId, partnerId: toId },
          { id: toId, partnerId: fromId },
        ],
      },
      data: { busy: false, partnerId: null },
    });
  }

  await prisma.signal.create({
    data: { fromId, toId, type: signalType, payload: payloadStr },
  });

  return Response.json({ ok: true });
}

// Helper: deliver an auto-decline from `target` back to `initiator`.
async function sendDecline(targetId: string, initiatorId: string) {
  await prisma.signal.create({
    data: { fromId: targetId, toId: initiatorId, type: "decline", payload: null },
  });
}
