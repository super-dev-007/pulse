import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Sessions are issued by the server as a pair:
// - `id`: public. Other users see it on the map and address signals to it.
// - `token`: secret. The only proof that a caller owns that id.
// Only a SHA-256 of the token is stored. It's 256 random bits, so a fast
// hash is enough (this is not a password that needs a slow KDF).

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, unpadded

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

// The token from an `Authorization: Bearer <token>` header.
export function bearerToken(request: Request): string | null {
  const match = request.headers.get("authorization")?.match(/^Bearer (\S+)$/);
  return match && isToken(match[1]) ? match[1] : null;
}

export async function findSession(token: string | null) {
  if (!token) return null;
  return prisma.presence.findUnique({ where: { tokenHash: hashToken(token) } });
}

export function unauthorized(): Response {
  return Response.json({ error: "unknown session" }, { status: 401 });
}

// Prisma's "record to update/delete not found".
export function isNotFound(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025"
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
