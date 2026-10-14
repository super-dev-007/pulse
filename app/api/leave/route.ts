import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { endConversations } from "@/lib/presence-server";
import { bearerToken, findSession, isToken } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/leave — body { token }. Removes the presence row and any pending
// signals to/from this user, and ends whatever they were part of (a
// conversation, or a pending request either way) for the other side. Called
// via navigator.sendBeacon on tab close, which can't set headers — so the
// token rides in the (possibly text/plain) body; parse defensively.
export async function POST(request: NextRequest) {
  let token: unknown;
  try {
    const text = await request.text();
    token = text ? JSON.parse(text)?.token : undefined;
  } catch {
    token = undefined;
  }

  const me = await findSession(isToken(token) ? token : bearerToken(request));
  // Unknown or already-reaped session: nothing to do (leave is idempotent).
  if (!me) return Response.json({ ok: true });

  // Independent cleanup deletes — no atomicity needed (and interactive
  // transactions are unreliable over a PgBouncer pooler).
  await prisma.signal.deleteMany({
    where: { OR: [{ toId: me.id }, { fromId: me.id }] },
  });
  await prisma.presence.deleteMany({ where: { id: me.id } });

  // Tell the other side — must run after the cleanup above, which would
  // delete these `end`s.
  await endConversations([me]);

  return Response.json({ ok: true });
}
