import { prisma } from "@/lib/prisma";

// Users in `goneIds` have left (or gone stale). Free whoever was connected to
// them and drop an `end` in those partners' mailboxes so their chat closes on
// the next poll, instead of hanging until WebRTC notices the peer is gone.
export async function releasePartners(goneIds: string[]): Promise<void> {
  if (goneIds.length === 0) return;

  const partners = await prisma.presence.findMany({
    where: { partnerId: { in: goneIds } },
    select: { id: true, partnerId: true },
  });
  if (partners.length === 0) return;

  await prisma.presence.updateMany({
    where: { id: { in: partners.map((p) => p.id) } },
    data: { busy: false, partnerId: null },
  });
  await prisma.signal.createMany({
    data: partners.map((p) => ({
      fromId: p.partnerId!,
      toId: p.id,
      type: "end",
      payload: null,
    })),
  });
}
