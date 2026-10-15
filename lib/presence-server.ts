import { prisma } from "@/lib/prisma";
import { REQUEST_TTL_MS, STALE_MS } from "@/lib/presence";

type Gone = { id: string; outgoingTo: string | null };

// Remove what's left of these sessions: presence rows, mailbox messages to or
// from them, blocks either way, and their rate-limit counters.
export async function deleteSessions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // Independent deletes — no atomicity needed (and interactive transactions
  // are unreliable over a PgBouncer pooler).
  await prisma.signal.deleteMany({
    where: { OR: [{ toId: { in: ids } }, { fromId: { in: ids } }] },
  });
  await prisma.block.deleteMany({
    where: { OR: [{ blockerId: { in: ids } }, { blockedId: { in: ids } }] },
  });
  await prisma.rateLimit.deleteMany({
    where: {
      key: { in: ids.flatMap((id) => [`signal:${id}`, `request:${id}`, `block:${id}`]) },
    },
  });
  await prisma.presence.deleteMany({ where: { id: { in: ids } } });
}

// These users have left (or gone stale). End everything they were part of,
// for the other side, so nobody waits on a ghost until a timeout:
// - their partner is freed and told (`end`);
// - anyone with a pending request *to* them is told they're gone;
// - whoever they had requested gets the prompt dismissed.
// Run after deleteSessions, which would otherwise delete these `end`s.
export async function endConversations(gone: Gone[]): Promise<void> {
  if (gone.length === 0) return;
  const goneIds = gone.map((g) => g.id);

  const partners = await prisma.presence.findMany({
    where: { partnerId: { in: goneIds } },
    select: { id: true, partnerId: true },
  });
  if (partners.length > 0) {
    await prisma.presence.updateMany({
      where: { id: { in: partners.map((p) => p.id) } },
      data: { busy: false, partnerId: null },
    });
  }

  const requesters = await prisma.presence.findMany({
    where: { outgoingTo: { in: goneIds } },
    select: { id: true, outgoingTo: true },
  });
  if (requesters.length > 0) {
    await prisma.presence.updateMany({
      where: { id: { in: requesters.map((r) => r.id) } },
      data: { outgoingTo: null, outgoingAt: null },
    });
  }

  const notices = [
    ...partners.map((p) => ({ fromId: p.partnerId!, toId: p.id })),
    ...requesters.map((r) => ({ fromId: r.outgoingTo!, toId: r.id })),
    ...gone
      .filter((g) => g.outgoingTo && !goneIds.includes(g.outgoingTo))
      .map((g) => ({ fromId: g.id, toId: g.outgoingTo! })),
  ];
  if (notices.length > 0) {
    await prisma.signal.createMany({
      data: notices.map((n) => ({ ...n, type: "end", payload: null })),
    });
  }
}

type Links = {
  id: string;
  partnerId: string | null;
  outgoingTo: string | null;
  outgoingAt: Date | null;
};

// Repair the caller's own links when the other end is gone. Without
// transactions, a leave or reap racing an accept can strand one side — e.g.
// paired to a user whose row was just deleted — and nothing else would ever
// free it. Costs a lookup only while in a conversation or a request.
export async function healLinks(me: Links, now: number): Promise<void> {
  const staleCutoff = now - STALE_MS;

  if (me.partnerId) {
    const partner = await prisma.presence.findUnique({
      where: { id: me.partnerId },
      select: { lastSeen: true },
    });
    if (!partner || partner.lastSeen.getTime() < staleCutoff) {
      const { count } = await prisma.presence.updateMany({
        where: { id: me.id, partnerId: me.partnerId },
        data: { busy: false, partnerId: null },
      });
      // Close the chat on our side too.
      if (count > 0) await notify(me.partnerId, me.id);
    }
  }

  if (me.outgoingTo) {
    const target = await prisma.presence.findUnique({
      where: { id: me.outgoingTo },
      select: { lastSeen: true },
    });
    const expired =
      !me.outgoingAt || me.outgoingAt.getTime() < now - REQUEST_TTL_MS;
    if (!target || target.lastSeen.getTime() < staleCutoff || expired) {
      const { count } = await prisma.presence.updateMany({
        where: { id: me.id, outgoingTo: me.outgoingTo },
        data: { outgoingTo: null, outgoingAt: null },
      });
      if (count > 0) {
        await notify(me.outgoingTo, me.id); // "no longer available"
        if (target) await notify(me.id, me.outgoingTo); // dismiss their prompt
      }
    }
  }
}

function notify(fromId: string, toId: string) {
  return prisma.signal.create({ data: { fromId, toId, type: "end", payload: null } });
}
