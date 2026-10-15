import { allow, clientKey, tooManyRequests } from "@/lib/rate-limit";
import { sweepExpired } from "@/lib/sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/cron/sweep — a daily safety net (vercel.json). Expired data is
// normally swept as a side effect of traffic; with nobody around, an
// abandoned session (tab killed, no leave beacon) would otherwise linger
// until the next visitor. When CRON_SECRET is set (Vercel sends it as a
// Bearer token), only the cron may call this; without it the sweep is
// harmless and idempotent, so it's just rate-limited.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (request.headers.get("authorization") !== `Bearer ${secret}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  } else if (!(await allow(`sweep:${clientKey(request)}`, 6, 60_000))) {
    return tooManyRequests(60);
  }
  await sweepExpired();
  return Response.json({ ok: true });
}
