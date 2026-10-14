import { prisma } from "@/lib/prisma";

type Gone = { id: string; outgoingTo: string | null };

// These users have left (or gone stale). End everything they were part of,
// for the other side, so nobody waits on a ghost until a timeout:
// - their partner is freed and told (`end`);
// - anyone with a pending request *to* them is told they're gone;
// - whoever they had requested gets the prompt dismissed.
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
