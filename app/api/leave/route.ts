import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { releasePartners } from "@/lib/presence-server";
import { bearerToken, findSession, isSessionId, isToken } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/leave — body { token, peerId? }. Removes the presence row and any
// pending signals to/from this user, and ends any conversation they were in
// for the other side. `peerId` is the user they had a *pending* request with
// (sent or received), which the server doesn't track. Called via
// navigator.sendBeacon on tab close, which can't set headers — so the token
// rides in the (possibly text/plain) body; parse defensively.
export async function POST(request: NextRequest) {
  let token: unknown;
  let peerId: unknown;
  try {
    const text = await request.text();
    const body = text ? JSON.parse(text) : null;
    token = body?.token;
    peerId = body?.peerId;
  } catch {
    token = undefined;
  }

  const me = await findSession(isToken(token) ? token : bearerToken(request));
  // Unknown or already-reaped session: nothing to do (leave is idempotent).
  if (!me) return Response.json({ ok: true });
  const id = me.id;

  // Independent cleanup deletes — no atomicity needed (and interactive
  // transactions are unreliable over a PgBouncer pooler).
  await prisma.signal.deleteMany({
    where: { OR: [{ toId: id }, { fromId: id }] },
  });
  await prisma.presence.deleteMany({ where: { id } });

  // Tell the other side — must run after the cleanup above, which would
  // delete these `end`s.
  await releasePartners([id]);
  if (isSessionId(peerId) && peerId !== id) {
    await prisma.signal.create({
      data: { fromId: id, toId: peerId, type: "end", payload: null },
    });
  }

  return Response.json({ ok: true });
}
