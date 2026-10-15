import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";

// Fixed-window counter: returns true if this call is within `limit` calls per
// `windowMs` for `key`. Counted in Postgres (see the RateLimit model).
export async function allow(
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const now = Date.now();
  const row = await prisma.rateLimit.upsert({
    where: { key },
    create: { key, count: 1, resetAt: new Date(now + windowMs) },
    update: { count: { increment: 1 } },
  });
  if (row.resetAt.getTime() <= now) {
    // The previous window is over; this call opens a new one. (updateMany:
    // the sweep may have just deleted the expired row — that's fine.)
    await prisma.rateLimit.updateMany({
      where: { key },
      data: { count: 1, resetAt: new Date(now + windowMs) },
    });
    return true;
  }
  return row.count <= limit;
}

// A key for the calling client's IP. Raw IPs are never stored — only an
// HMAC under a server-side secret, which (unlike a plain hash of a 32-bit
// IPv4 address) can't be reversed by trying every address; it lives for one
// window. RATE_LIMIT_SECRET can be set explicitly; otherwise the database
// URL (already a server secret) keys it.
// On Vercel, x-forwarded-for is set by the platform (client-supplied values
// are overwritten); behind any other proxy make sure it does the same.
const SECRET = process.env.RATE_LIMIT_SECRET ?? process.env.DATABASE_URL ?? "pulse";

export function clientKey(request: Request): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  return createHmac("sha256", SECRET).update(ip).digest("hex").slice(0, 32);
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "too many requests" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
