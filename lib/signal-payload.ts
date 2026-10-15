import type { SignalType } from "@/lib/types";

// Each video call in one chat adds ~7 KB of (idle) media sections to the
// session description (see PeerSession.stopVideo); 128 KB allows ~16 calls.
const MAX_SDP = 128 * 1024;
const MAX_CANDIDATE = 1024;

// Returns the canonical payload to store (null for control signals), or
// undefined when the payload isn't valid for this signal type. Only the known
// fields are re-serialised, so a client can't push arbitrary JSON (or
// oversized blobs) at a peer through the mailbox.
export function normalizePayload(
  type: SignalType,
  payload: unknown,
): string | null | undefined {
  if (
    type === "request" ||
    type === "accept" ||
    type === "decline" ||
    type === "end"
  ) {
    return payload === undefined || payload === null ? null : undefined;
  }

  if (typeof payload !== "string" || payload.length > MAX_SDP + 1024) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;

  if (type === "offer" || type === "answer") {
    if (d.type !== type || typeof d.sdp !== "string" || d.sdp.length > MAX_SDP) {
      return undefined;
    }
    return JSON.stringify({ type: d.type, sdp: d.sdp });
  }

  // ice
  if (typeof d.candidate !== "string" || d.candidate.length > MAX_CANDIDATE) {
    return undefined;
  }
  return JSON.stringify({
    candidate: d.candidate,
    sdpMid:
      typeof d.sdpMid === "string" && d.sdpMid.length <= 64 ? d.sdpMid : null,
    sdpMLineIndex: Number.isInteger(d.sdpMLineIndex) ? d.sdpMLineIndex : null,
    usernameFragment:
      typeof d.usernameFragment === "string" && d.usernameFragment.length <= 256
        ? d.usernameFragment
        : null,
  });
}
