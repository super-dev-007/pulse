import { prisma } from "@/lib/prisma";
import { SESSION_GRACE_MS, SIGNAL_TTL_MS } from "@/lib/presence";
import { deleteSessions, endConversations } from "@/lib/presence-server";

// Housekeeping: delete sessions past their grace period (ending whatever they
// were part of), orphaned signals, finished cooldowns/blocks and old
// rate-limit windows.
export async function sweepExpired(now = Date.now()): Promise<void> {
  const expired = await prisma.presence.findMany({
    where: { lastSeen: { lt: new Date(now - SESSION_GRACE_MS) } },
    select: { id: true, outgoingTo: true },
  });
  if (expired.length > 0) {
    await deleteSessions(expired.map((s) => s.id));
    await endConversations(expired);
  }
  await prisma.signal.deleteMany({
    where: { createdAt: { lt: new Date(now - SIGNAL_TTL_MS) } },
  });
  await prisma.block.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
  await prisma.rateLimit.deleteMany({ where: { resetAt: { lt: new Date(now) } } });
}

// The same, at most every few seconds per instance — cheap enough to hang
// off busy endpoints (poll, the landing page's stats) without adding work to
// every request. A daily cron (vercel.json) covers the case of no traffic.
const SWEEP_EVERY_MS = 10_000;
let lastSweep = 0;

export async function maybeSweep(now = Date.now()): Promise<void> {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  await sweepExpired(now);
}
