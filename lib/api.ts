// Client-side helpers for talking to the coordination API. join() starts a
// session; every other call is authenticated with its secret token.
import type { JoinResponse, PollResponse, SignalType } from "@/lib/types";

export type Session = JoinResponse;

// The server no longer knows our session (reaped while we were away).
export class SessionExpiredError extends Error {}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Every call has a deadline: a request that never answers shouldn't leave
// the UI spinning ("Finding you…" forever) or stall the poll loop.
export async function join(lat: number, lng: number): Promise<Session> {
  const res = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lng }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`join failed: ${res.status}`);
  return res.json();
}

export async function poll(token: string): Promise<PollResponse> {
  const res = await fetch("/api/poll", {
    method: "POST",
    headers: auth(token),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) throw new SessionExpiredError();
  if (!res.ok) throw new Error(`poll failed: ${res.status}`);
  return res.json();
}

// Resolves to the HTTP status (e.g. 429 when rate-limited).
export async function sendSignal(
  token: string,
  toId: string,
  type: SignalType,
  payload?: string,
): Promise<number> {
  const res = await fetch("/api/signal", {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({ toId, type, payload }),
    // Signals are sent one at a time; a hung request mustn't block the rest.
    signal: AbortSignal.timeout(10_000),
  });
  return res.status;
}

// End things with `toId` and never see or hear from them again this session.
export async function block(token: string, toId: string): Promise<boolean> {
  const res = await fetch("/api/block", {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({ toId }),
  });
  return res.ok;
}

// Fire-and-forget leave that survives the tab closing. sendBeacon can't set
// headers, so the token rides in the body. The server knows who we were
// talking to (or had a pending request with) and tells them.
export function leave(token: string): void {
  const body = JSON.stringify({ token });
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon("/api/leave", body);
  } else {
    void fetch("/api/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
  }
}
