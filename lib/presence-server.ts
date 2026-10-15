import { prisma } from "@/lib/prisma";

type Gone = { id: string; outgoingTo: string | null };

// Remove what's left of these sessions: presence rows, mailbox messages to or
// from them, and blocks either way.
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
      data: { outgoingTo: null },
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
