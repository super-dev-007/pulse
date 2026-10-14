import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { applyPrivacyOffset, isValidLatLng } from "@/lib/geo";
import { hashToken, newSessionToken } from "@/lib/session";
import type { JoinResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/join — body { lat, lng } (raw coords).
// Starts a session: returns a public `id` (what others see) and a secret
// `token` (the credential for every other call). Applies a 1–3 km privacy
// offset; raw coordinates are never stored.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { lat, lng } = (body ?? {}) as Record<string, unknown>;

  if (!isValidLatLng(lat, lng)) {
    return Response.json({ error: "invalid coordinates" }, { status: 400 });
  }

  const offset = applyPrivacyOffset(lat as number, lng as number);
  const id = randomUUID();
  const token = newSessionToken();

  await prisma.presence.create({
    data: {
      id,
      tokenHash: hashToken(token),
      lat: offset.lat,
      lng: offset.lng,
      busy: false,
      lastSeen: new Date(),
    },
  });

  const response: JoinResponse = { id, token, lat: offset.lat, lng: offset.lng };
  return Response.json(response);
}
