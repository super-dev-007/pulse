# Pulse — Notes

**Live:** https://pulse-cyan-phi.vercel.app · **Repo:** https://github.com/super-dev-007/pulse

**Try it:** open the live URL in two windows (normal + incognito), set a different location in each (DevTools → Sensors), then *Drop onto the globe* → tap the other dot → accept → chat → *Start video* → both tap **Reveal me**.

## How I worked
- One branch + PR per phase ([#1](https://github.com/super-dev-007/pulse/pull/1) run · [#2](https://github.com/super-dev-007/pulse/pull/2) secure · [#3](https://github.com/super-dev-007/pulse/pull/3) good · [#4](https://github.com/super-dev-007/pulse/pull/4) better), merged with merge commits so each step stays visible. Commit messages explain *why*, not just what.
- Order: **1 → 3 → 2 → 4**. Security changes the API the UI sits on, so the redesign was built on the final API.
- For server bugs: reproduce with a test, fix, keep the test. **37 Playwright tests**: API/state-machine/security, two-browser E2Es (fake camera, five video calls in one chat), and a pixel-level Mutual Reveal test. `npm run test:e2e`. The browser tests also pass against the live deployment (`E2E_BASE_URL=https://pulse-cyan-phi.vercel.app`).
- Once the real map was available, the two-browser test caught three more connection races (a quick call-back killed by the previous call's hang-up, out-of-order signals, silently ignored taps). A screenshot review of the whole journey caught five visual issues. All are fixed in #4.
- **Final review pass:** two independent reviewers (server / client) audited everything A to Z. Their verified findings are fixed in [#6](https://github.com/super-dev-007/pulse/pull/6), each with a test where it can be reproduced. Then I re-ran the browser tests against production, which caught serverless-specific hangs, fixed in [#7](https://github.com/super-dev-007/pulse/pull/7) — see below.

## Phase 1 — Make it run
**How I found them:** I traced one connection end to end (presence → request/accept → SDP/ICE through the mailbox → data channel), then reproduced each server bug as an API test. I also re-introduced bug 1 to confirm its test fails on the original code.

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Dots stay "for ages" (README example) | Heartbeat `updateMany({ where: {} })` refreshed **every** row | Heartbeat the caller only |
| 2 | Chat never arrives | Sent `{t:"msg"}`, receiver only accepts `{t:"chat"}` | Send `chat` |
| 3 | Connections flaky or failing | Queued ICE flushed *before* `setRemoteDescription`; signals applied concurrently; outgoing signals raced | Flush after; serialize both directions |
| 4 | After one chat, both users stuck "busy" | `end` never cleared `busy` | Free on `end` |
| 5 | A late `end`/auto-decline frees someone mid-call | Busy toggled for any two ids | Track `partnerId`; `end` frees only its own pair |
| 6 | Closing the tab leaves the partner in a dead chat | Leave never notified anyone | Leave/reaper release the partner and dismiss pending prompts |
| 7 | Dropped link or a handshake that never completes hangs forever | No data-channel close handling | Close/failure → `end`; 25s connect timeout |
| 8 | A backgrounded user vanishes for the rest of the session | Heartbeat can't recreate a reaped row | Detect it and re-join (later: resume, see Phase 3) |
| 9 | Missing env shows a blank map | Fake hard-coded Mapbox fallback token | Removed (setup hint now shows) |
| 10 | A failed `/api/join` still enters the map, invisible | `join()` ignored the HTTP status | Error + retry on the landing page |

## Phase 2 — Make it good
**Idea:** *a living globe at night.* Every person is a light seen from orbit; the app is one continuous scene, not a stack of screens.
- **Landing → map is one shot.** The globe (projection, atmosphere, stars) turns behind the landing page; *Drop onto the globe* flies the camera down to you. A live "N people on the globe" count (cached `/api/stats`) and four plain privacy promises.
- **It feels alive:** a real-time day/night shadow (solar ephemeris); every dot has **its own heartbeat** (rhythm derived from its id, so nothing pulses in lockstep); a ripple when someone arrives; busy people dim to a steady ember.
- **Strangers, but human:** each session gets a handle + colour orb ("Amber Fox"), deterministic from the public id and gone with the session. Hover a dot: *Amber Fox · ~840 km away · ☾ ≈3:12 AM there*.
- **Privacy you can see:** your marker shows the circle others may see you within; the "You" popover explains what is and isn't shared.
- **Flow:** an outgoing card whose ring runs out with the 30s timeout; a ringing incoming card (Enter/Esc, chime, blinking tab title in background); a chat side panel on desktop and bottom sheet on mobile, with openers, a typing indicator, grouped bubbles; full-bleed video with a draggable self-view, mic/camera toggles and a timer; an empty-globe state with *Copy link* (a lone reviewer knows what to do).
- **Details:** toasts name the person instead of "Stranger"; everything keyboard/screen-reader reachable; safe-area insets; `prefers-reduced-motion` respected; tap targets ≥ 44px.
- **Trade-offs:** CSS-only motion (no animation library); DOM markers allow rich per-dot animation but I'd move to a GPU symbol layer + clustering past a few hundred users.

## Phase 3 — Make it secure
Reviewed as an attacker who can see the map and call the API directly. Ranked by impact × ease; every fix has tests.

| Rank | Issue | Fix |
|---|---|---|
| 1 Critical | **No auth.** The public session id was the only credential → read anyone's mailbox (steal SDP/ICE incl. IPs, hijack calls), kick anyone, forge senders, move dots | Server-issued public id + 256-bit secret token (only SHA-256 stored); sender always derived from the token; poll → `POST` + Bearer header (no ids in URLs/logs) |
| 2 Critical | **Next 16.2.7**: 3 unauthenticated RCE advisories + SSRF/DoS | Next 16.3.8 (newest 16.3 patch, covers all; skipped the day-old 16.4.1) |
| 3 High | **No signaling state machine**: forged accepts lock strangers as busy; WebRTC payloads to anyone | Server tracks pending requests + partners; only legal moves; compare-and-set accept; payloads validated + re-serialised |
| 4 High | **No abuse limits**: fake-dot floods, request spam, mailbox growth | Postgres-backed rate limits (serverless shares no memory): 30 joins/min/IP, 10 requests + 300 signals/min/session; 1 pending request; 60s cooldown after a decline (looks like "busy"); mailbox cap 100 |
| 5 Medium | **No security headers**: clickjacking into accepting a call/camera; no XSS backstop | Per-request **nonce CSP** (no `unsafe-inline` scripts), `frame-ancestors 'none'`, Permissions-Policy, HSTS, etc. Zero CSP violations on dev + prod builds |
| 6 Medium | **Location averaging**: each re-join drew a fresh offset → average back to the real spot | Stale sessions hidden at 15s but kept 2 min; returning resumes the same dot |
| 7 Medium | **Untrusted P2P input**: huge/unknown/flooding data-channel messages | Size, type and rate bounds |
| 8 Low | Stray `allowedDevOrigins` (someone's ngrok host) | Removed |

**Accepted risks:** your IP is visible to the person you connect with (inherent to P2P; hiding it needs a TURN relay — the brief says STUN-only) · the Mapbox token is public by design (restrict it to the domain in Mapbox) · IP limits trust `x-forwarded-for` (set by Vercel) · bots on many IPs can still add dots (would add Turnstile/proof-of-work) · remaining npm advisories sit under the Prisma CLI, not the app bundle.

## Phase 4 — Make it better: Mutual Reveal
**What:** video calls start **frosted** — colour and shape, no face. Clear video appears only when **both** people tap *Reveal me*; either can frost again at any time, which re-frosts **both** feeds. You can only see someone clearly while they can see you.

**Why:** the defining harm of stranger video chat is the first second — unwanted exposure, or being seen before you're ready. Pulse stores nothing and never sees the media, so server-side moderation is impossible *by design*. Safety has to live in the protocol and on the devices. Mutual Reveal turns consent into a mechanic: nothing happens to you that you didn't opt into, and nobody gets to watch without being watched.

**How (two layers, so it holds even against a modified client):**
- **Sender side:** the camera goes out through a canvas pipeline (each frame shrunk to ~28 px wide, scaled back up). Until both reveal, the clear image never leaves your device; reveal swaps tracks with `RTCRtpSender.replaceTrack` (instant, no renegotiation).
- **Receiver side:** the remote video is also blurred locally until both reveal, so a peer who hacks their client to send clear video early still shows nothing. On reveal the frost melts away over ~1s.
- Consent travels peer-to-peer over the data channel (`reveal-on`/`reveal-off`), not through the server.
- **Tested on the wire:** the browser test measures fine detail in the *received* frames (no CSS involved): frosted with 0 or 1 reveals, clear with 2, frosted again after either frosts.

**Plus Block:** "never again, this session" — ends whatever is going on, hides you from each other's maps, and auto-declines their requests exactly like a busy user (so it can't be probed). It lives as long as either session.

**Next, with more time:** on-device nudity detection that auto-frosts an incoming feed even after reveal (still no server); a TURN relay so peers don't learn each other's IP; voice-first reveal stages; distinct-reporter counts that rate-limit abusive sessions; viewport-scoped polling + clustering for scale.

## Final review pass (#6)
- **Camera leak (high):** the call ending while the permission prompt was open left the camera on with nothing to stop it, and a double-click opened two cameras. Camera opens are now de-duplicated, and a late one is released.
- **Consent carried over:** a failed camera start could leave the other side's "ready to reveal" set for the next call in that chat. Every exit from video now resets consent.
- **Races without transactions:** accept → leave could strand someone busy with a ghost. Pairing is now two compare-and-sets with undo, and each poll self-heals the caller's links.
- **Fairer requests:** an automatic "busy" reply no longer triggers the 60s cooldown; two people tapping each other at once now connect; requests expire server-side (35s) so a lost withdraw can't lock anyone out.
- **Privacy:** IP keys are HMAC'd (a plain hash of IPv4 is reversible); offsets use crypto randomness; a returning session past its grace period is refused; cleanup also runs from the landing page plus a daily Vercel cron, so nothing lingers when there's no traffic.
- **Stuck video requests:** both asking at once is a yes from both sides; unanswered requests time out and can be cancelled.
- **Accessibility and overlaps:** the incoming-call dialog stole focus every poll (Enter could accept instead of block); it now focuses once and traps Tab. Plus fixes for the popover hidden under the chat, sticky hover cards on touch, and the globe not draggable behind the bottom cards.

**Production resilience (#7), found by testing the live deployment:**
- **Requests that never answered.** A join got no response for minutes, and connections stalled on "Connecting…". Vercel freezes instances between requests, and a pooled Postgres connection can die while frozen. The pg pool now has connect/query timeouts, keep-alive and a short idle lifetime, and the client has deadlines on join/poll, so a dead connection fails fast and the retry succeeds.
- **People on the map don't wait for tiles.** Dots appear at Mapbox's `style.load`, not `load`, so a few failed tile requests can't leave the globe empty.

## Assumptions & trade-offs
- **Polling, not WebSockets** (brief: Vercel serverless). Per-poll DB work trimmed: cleanup is swept per instance at most every 10s.
- **Mailbox delivery is at-most-once:** a poll response lost in transit loses its signals; the request/connect/video timeouts recover. Proper fix: ack-based delivery.
- **Repeated video calls in one chat** grow the session description by ~7 KB each (`removeTrack` leaves idle slots), allowed up to 128 KB (~16 calls). Stopping transceivers keeps it flat, but measured over polled signaling it broke the 3rd call's media, so I kept the reliable path. Next: reuse transceivers via `replaceTrack`.
- **Cron:** Vercel Hobby runs it daily. Set `CRON_SECRET` in Vercel to lock the endpoint; without it, it's public but rate-limited and harmless.
- **2-minute grace** keeps a stale session's *offset* position (never the raw location) so a returning tab resumes; a clean leave deletes immediately.
- **Dynamic rendering** of the single page so the CSP can carry a nonce; cost is negligible for one page.
- Kept **Mapbox** as specified. Schema changes ship as Prisma migrations; `npx prisma db push` still works on a fresh database.

## Run it
`npm install` · copy `.env.example` → `.env` (Postgres URL + Mapbox token) · `npx prisma db push` · `npm run dev` · tests: `npm run test:e2e` (`PW_CHANNEL=chrome` to use an installed Chrome, `E2E_BASE_URL=<url>` to target a deployment).
