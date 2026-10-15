import { prisma } from "@/lib/prisma";
import { STALE_MS } from "@/lib/presence";
import { maybeSweep } from "@/lib/sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/stats — how many people are on the map right now, for the landing
// page (before you have a session). Just a number; CDN-cached for a few
// seconds so it can't be used to hammer the database. Visitors to the landing
// page also help sweep expired data when nobody is polling.
export async function GET() {
  const now = Date.now();
  await maybeSweep(now);
  const online = await prisma.presence.count({
    where: { lastSeen: { gte: new Date(now - STALE_MS) } },
  });
  return Response.json(
    { online },
    { headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=30" } },
  );
}
