import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { BLOCK_MS } from "@/lib/presence";
import { allow, tooManyRequests } from "@/lib/rate-limit";
import { bearerToken, findSession, isSessionId, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/block — Authorization: Bearer <token>, body { toId }.
// "Never again, this session": ends whatever is going on between the two,
// hides each from the other's map, and auto-declines their requests to you.
// The block dies with either session (no accounts, nothing to persist).
export async function POST(request: NextRequest) {
  const me = await findSession(bearerToken(request));
  if (!me) return unauthorized();

  let toId: unknown;
  try {
    toId = (await request.json())?.toId;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (!isSessionId(toId) || toId === me.id) {
    return Response.json({ error: "invalid recipient" }, { status: 400 });
  }
  if (!(await allow(`block:${me.id}`, 20, 60_000))) return tooManyRequests(60);

  const expiresAt = new Date(Date.now() + BLOCK_MS);
  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId: me.id, blockedId: toId } },
    create: { blockerId: me.id, blockedId: toId, expiresAt, hidden: true },
    update: { expiresAt, hidden: true },
  });

  // End whatever was between us: a conversation, our request, or theirs.
  if (me.partnerId === toId) {
    await prisma.presence.updateMany({
      where: {
        OR: [
          { id: me.id, partnerId: toId },
          { id: toId, partnerId: me.id },
        ],
      },
      data: { busy: false, partnerId: null },
    });
    await notify(me.id, toId, "end");
  }
  if (me.outgoingTo === toId) {
    await prisma.presence.update({
      where: { id: me.id },
      data: { outgoingTo: null },
    });
    await notify(me.id, toId, "end");
  }
  const theirs = await prisma.presence.updateMany({
    where: { id: toId, outgoingTo: me.id },
    data: { outgoingTo: null },
  });
  if (theirs.count > 0) await notify(me.id, toId, "decline");

  return Response.json({ ok: true });
}

function notify(fromId: string, toId: string, type: "end" | "decline") {
  return prisma.signal.create({ data: { fromId, toId, type, payload: null } });
}
