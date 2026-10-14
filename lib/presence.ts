// How long a presence row survives without a heartbeat (poll). After this the
// dot is treated as offline and removed — implements "dot disappears when the
// user leaves" even if their tab closed without a clean leave.
export const STALE_MS = 15_000;

// A stale session is hidden at STALE_MS but only deleted after this grace
// period. If it heartbeats again before then (a tab that was asleep in the
// background), it resumes with the *same* dot. A fresh random offset on every
// return would let an observer average the samples back toward the user's
// real location.
export const SESSION_GRACE_MS = 120_000;

// Orphan signals (mailbox messages never drained) are cleaned up after this.
export const SIGNAL_TTL_MS = 60_000;

// Client poll interval. Kept here so client + server reason about the same cadence.
export const POLL_INTERVAL_MS = 1_500;

// Abuse limits (server-side).
export const JOINS_PER_IP_PER_MIN = 30; // new sessions per client IP
export const REQUESTS_PER_MIN = 10; // connection requests per session
export const SIGNALS_PER_MIN = 300; // all signals per session (ICE comes in bursts)
export const MAILBOX_CAP = 100; // undelivered messages per recipient
export const DECLINE_COOLDOWN_MS = 60_000; // no re-asking someone who said no
export const BLOCK_MS = 24 * 60 * 60_000; // outlives any session; dies with it
export const MAX_PEERS = 1_000; // dots returned per poll
