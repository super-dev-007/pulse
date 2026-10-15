"use client";

import { useEffect, useRef, useState } from "react";
import EntryGate from "./components/EntryGate";
import WorldMap from "./components/WorldMap";
import TopBar from "./components/TopBar";
import Toasts, { type Toast } from "./components/Toasts";
import QuietState from "./components/QuietState";
import RequestCard from "./components/RequestCard";
import IncomingCall from "./components/IncomingCall";
import ChatPanel, { type ChatMessage } from "./components/ChatPanel";
import VideoPanel from "./components/VideoPanel";
import {
  block,
  join,
  leave,
  poll,
  sendSignal,
  SessionExpiredError,
  type Session,
} from "@/lib/api";
import { PeerSession, type DescType, type PeerControl } from "@/lib/webrtc";
import { POLL_INTERVAL_MS } from "@/lib/presence";
import { type PeerDot, type SignalMsg, type SignalType } from "@/lib/types";
import { handleFor } from "@/lib/identity";
import { distanceKm, formatDistance, solarTime, sunElevation } from "@/lib/sky";
import { blip, chime, unlockAudio } from "@/lib/sound";

type Conn =
  | { kind: "idle" }
  | { kind: "requesting"; peerId: string }
  | { kind: "incoming"; peerId: string }
  | { kind: "connecting"; peerId: string }
  | { kind: "connected"; peerId: string };

type VideoState = "none" | "requesting" | "incoming" | "active";

const REQUEST_TIMEOUT_MS = 30_000;
// After an accept, how long the data channel gets to open before we give up.
const CONNECT_TIMEOUT_MS = 25_000;
const TOAST_MS = 3_800;
const TYPING_SHOW_MS = 3_000;
const TYPING_SEND_EVERY_MS = 2_000;

export default function Home() {
  const [phase, setPhase] = useState<"gate" | "live">("gate");
  // Issued by the server on join: our public id + the secret token.
  const sessionRef = useRef<Session | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [peers, setPeers] = useState<PeerDot[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [peerTyping, setPeerTyping] = useState(false);
  // Mutual Reveal: has each side opted in to being seen clearly?
  const [revealMe, setRevealMe] = useState(false);
  const [revealThem, setRevealThem] = useState(false);
  // Sound preference survives reloads (the only thing we remember).
  const [soundOn, setSoundOn] = useState(() => {
    try {
      return localStorage.getItem("pulse:sound") !== "off";
    } catch {
      return true;
    }
  });
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(
    null,
  );
  const locationRef = useRef(myLocation);

  const [conn, _setConn] = useState<Conn>({ kind: "idle" });
  const connRef = useRef<Conn>(conn);
  const setConn = (c: Conn) => {
    connRef.current = c;
    _setConn(c);
  };

  const [video, _setVideo] = useState<VideoState>("none");
  const videoRef = useRef<VideoState>(video);
  const setVideo = (v: VideoState) => {
    videoRef.current = v;
    _setVideo(v);
  };

  const peerRef = useRef<PeerSession | null>(null);
  const sendQueue = useRef<Promise<unknown>>(Promise.resolve());
  const msgId = useRef(0);
  const toastId = useRef(0);
  const requestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);
  const soundRef = useRef(soundOn);
  const now = useNow(30_000);

  function notify(text: string, tone: Toast["tone"] = "info") {
    const id = toastId.current++;
    setToasts((prev) => [...prev.slice(-2), { id, text, tone }]);
    window.setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      TOAST_MS,
    );
  }

  function cue(sound: () => void) {
    if (soundRef.current) sound();
  }

  // Every signal we send goes out strictly in order — one at a time — so the
  // server sees them as we produced them: an offer before its ICE
  // candidates, and an `end` before a quick re-`request` (otherwise the
  // request can land first and be refused as "already connected").
  // Resolves to the HTTP status, or null with no session / on failure.
  function signal(
    toId: string,
    type: SignalType,
    payload?: string,
  ): Promise<number | null> {
    const session = sessionRef.current;
    if (!session) return Promise.resolve(null);
    const sent = sendQueue.current
      .then(() => sendSignal(session.token, toId, type, payload))
      .catch(() => null);
    sendQueue.current = sent;
    return sent;
  }

  function addMessage(mine: boolean, text: string) {
    setMessages((prev) => [
      ...prev,
      { id: msgId.current++, mine, text, at: Date.now() },
    ]);
  }

  function teardown(message?: string) {
    if (requestTimer.current) clearTimeout(requestTimer.current);
    if (connectTimer.current) clearTimeout(connectTimer.current);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    // Our conversation is over, so the server has freed them too: show them
    // as available now rather than on the next poll.
    const c = connRef.current;
    if (c.kind === "connecting" || c.kind === "connected") {
      setPeers((prev) =>
        prev.map((p) => (p.id === c.peerId ? { ...p, busy: false } : p)),
      );
    }
    peerRef.current?.close();
    peerRef.current = null;
    clearVideo();
    setPeerTyping(false);
    setMessages([]);
    setConn({ kind: "idle" });
    if (message) notify(message);
  }

  function startPeer(peerId: string, initiator: boolean) {
    const ps = new PeerSession(initiator, {
      onSignal: (type: DescType, payload: string) => {
        void signal(peerId, type, payload);
      },
      onChat: (text) => {
        if (typingTimer.current) clearTimeout(typingTimer.current);
        setPeerTyping(false);
        addMessage(false, text);
        cue(blip);
      },
      onControl: (ctrl) => handleControl(ctrl),
      onRemoteStream: (stream) => setRemoteStream(stream),
      onConnectionState: (state) => {
        if (state === "failed" && peerRef.current === ps) {
          dropConnection("The connection dropped.");
        }
      },
      onChannelOpen: () => {
        if (peerRef.current !== ps) return;
        if (connectTimer.current) clearTimeout(connectTimer.current);
        setConn({ kind: "connected", peerId });
      },
      onChannelClose: () => {
        if (peerRef.current === ps) {
          dropConnection(`${handleFor(peerId)} left the conversation.`);
        }
      },
    });
    peerRef.current = ps;
    connectTimer.current = setTimeout(() => {
      if (peerRef.current === ps && connRef.current.kind === "connecting") {
        dropConnection(`Couldn't reach ${handleFor(peerId)}.`);
      }
    }, CONNECT_TIMEOUT_MS);
  }

  // The link to the peer died without an `end` from them (tab killed, network
  // lost, never came up). Tell the server so the pair is freed, then reset.
  function dropConnection(message: string) {
    const c = connRef.current;
    if (c.kind === "connecting" || c.kind === "connected") {
      void signal(c.peerId, "end");
    }
    teardown(message);
  }

  function handleControl(ctrl: PeerControl) {
    const ps = peerRef.current;
    const c = connRef.current;
    const name = c.kind === "idle" ? "They" : handleFor(c.peerId);
    switch (ctrl) {
      case "typing":
        setPeerTyping(true);
        if (typingTimer.current) clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => setPeerTyping(false), TYPING_SHOW_MS);
        break;
      case "video-request":
        if (videoRef.current === "none") {
          setVideo("incoming");
          cue(chime);
        }
        break;
      case "video-accept":
        if (videoRef.current === "requesting" && ps) {
          ps.startVideo()
            .then((stream) => {
              setLocalStream(stream);
              setVideo("active");
            })
            .catch(() => {
              setVideo("none");
              ps.sendControl("video-end");
              notify("Your camera isn't available.", "warn");
            });
        }
        break;
      case "video-decline":
        if (videoRef.current === "requesting") {
          setVideo("none");
          notify(`${name} would rather just chat.`);
        }
        break;
      case "video-end":
        ps?.stopVideo();
        clearVideo();
        break;
      // Mutual Reveal: the other side opted in / frosted themselves again.
      case "reveal-on":
        // The accepter's video goes live first, so this can arrive while
        // our camera is still starting — keep it rather than drop it.
        if (videoRef.current !== "none") setRevealThem(true);
        break;
      case "reveal-off":
        setRevealThem(false);
        break;
    }
  }

  // Back to a text-only conversation (or nothing): no streams, everything
  // frosted again for next time.
  function clearVideo() {
    setLocalStream(null);
    setRemoteStream(null);
    setMicOn(true);
    setCamOn(true);
    setRevealMe(false);
    setRevealThem(false);
    setVideo("none");
  }

  function requestConnection(peerId: string) {
    const c = connRef.current;
    if (c.kind !== "idle") {
      if (c.peerId !== peerId) notify("Finish this conversation first.");
      return;
    }
    if (peers.find((p) => p.id === peerId)?.busy) {
      notify(`${handleFor(peerId)} is talking to someone right now.`);
      return;
    }
    setConn({ kind: "requesting", peerId });
    void signal(peerId, "request").then((status) => {
      const c = connRef.current;
      if (status === 429 && c.kind === "requesting" && c.peerId === peerId) {
        teardown("Easy there — try again in a minute.");
      }
    });
    requestTimer.current = setTimeout(() => {
      if (
        connRef.current.kind === "requesting" &&
        connRef.current.peerId === peerId
      ) {
        void signal(peerId, "end");
        teardown(`No answer from ${handleFor(peerId)}.`);
      }
    }, REQUEST_TIMEOUT_MS);
  }

  function cancelRequest() {
    if (connRef.current.kind === "requesting") {
      void signal(connRef.current.peerId, "end");
    }
    teardown();
  }

  function acceptIncoming() {
    if (connRef.current.kind !== "incoming") return;
    const peerId = connRef.current.peerId;
    startPeer(peerId, false);
    void signal(peerId, "accept");
    setConn({ kind: "connecting", peerId });
  }

  function declineIncoming() {
    if (connRef.current.kind !== "incoming") return;
    void signal(connRef.current.peerId, "decline");
    setConn({ kind: "idle" });
  }

  function endConnection() {
    const c = connRef.current;
    if (c.kind === "connecting" || c.kind === "connected") {
      void signal(c.peerId, "end");
    }
    teardown();
  }

  // Ends things with them (whatever stage), and the server keeps you apart
  // for the rest of the session: hidden from each other, requests refused.
  function blockPeer(peerId: string) {
    const session = sessionRef.current;
    if (!session) return;
    void block(session.token, peerId);
    teardown(`${handleFor(peerId)} is blocked — you won't see each other again.`);
  }

  function sendChat(text: string) {
    peerRef.current?.sendChat(text);
    addMessage(true, text);
    lastTypingSent.current = 0;
  }

  function sendTyping() {
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_SEND_EVERY_MS) return;
    lastTypingSent.current = now;
    peerRef.current?.sendControl("typing");
  }

  function startVideoRequest() {
    if (videoRef.current !== "none" || !peerRef.current) return;
    setVideo("requesting");
    peerRef.current.sendControl("video-request");
  }

  function acceptVideo() {
    const ps = peerRef.current;
    if (!ps) return;
    ps.startVideo()
      .then((stream) => {
        setLocalStream(stream);
        ps.sendControl("video-accept");
        setVideo("active");
      })
      .catch(() => {
        ps.sendControl("video-decline");
        setVideo("none");
        notify("Your camera isn't available.", "warn");
      });
  }

  function declineVideo() {
    peerRef.current?.sendControl("video-decline");
    setVideo("none");
  }

  function endVideo() {
    const ps = peerRef.current;
    ps?.stopVideo();
    ps?.sendControl("video-end");
    clearVideo();
  }

  // "I'm ready to be seen" — or frost me again. Clear video flows only while
  // both sides are ready (see the effect below).
  function toggleReveal() {
    const on = !revealMe;
    setRevealMe(on);
    peerRef.current?.sendControl(on ? "reveal-on" : "reveal-off");
  }

  function toggleMic() {
    const on = !micOn;
    peerRef.current?.setMicEnabled(on);
    setMicOn(on);
  }

  function toggleCam() {
    const on = !camOn;
    peerRef.current?.setCameraEnabled(on);
    setCamOn(on);
  }

  function processSignal(sig: SignalMsg) {
    const name = handleFor(sig.fromId);
    switch (sig.type) {
      case "request": {
        if (connRef.current.kind === "idle") {
          setConn({ kind: "incoming", peerId: sig.fromId });
          cue(chime);
        } else {
          void signal(sig.fromId, "decline");
        }
        break;
      }
      case "accept": {
        const c = connRef.current;
        if (c.kind === "requesting" && c.peerId === sig.fromId) {
          if (requestTimer.current) clearTimeout(requestTimer.current);
          startPeer(sig.fromId, true);
          setConn({ kind: "connecting", peerId: sig.fromId });
        } else {
          // We already gave up on this request (cancelled / timed out) but
          // they accepted anyway. Say so, or they'd sit in "Connecting…"
          // with the server holding them busy.
          void signal(sig.fromId, "end");
        }
        break;
      }
      case "decline": {
        const c = connRef.current;
        if (c.kind === "requesting" && c.peerId === sig.fromId) {
          if (requestTimer.current) clearTimeout(requestTimer.current);
          teardown(`${name} can't talk right now.`);
        }
        break;
      }
      case "offer":
      case "answer":
      case "ice": {
        const c = connRef.current;
        const peerId =
          c.kind === "connecting" || c.kind === "connected" ? c.peerId : null;
        if (peerRef.current && peerId === sig.fromId) {
          void peerRef.current.handleSignal(
            sig.type as DescType,
            sig.payload ?? "",
          );
        }
        break;
      }
      case "end": {
        const c = connRef.current;
        if (c.kind !== "idle" && c.peerId === sig.fromId) {
          if (c.kind === "incoming") setConn({ kind: "idle" });
          else if (c.kind === "requesting") teardown(`${name} is no longer around.`);
          else teardown(`${name} left the conversation.`);
        }
        break;
      }
    }
  }

  // Our session was reaped while we were away (a backgrounded tab's timers
  // get throttled past STALE_MS). Anything we were doing belonged to it, so
  // reset and come back as a fresh session.
  async function rejoin() {
    const loc = locationRef.current;
    if (!loc) return;
    teardown();
    sessionRef.current = await join(loc.lat, loc.lng);
    setMyId(sessionRef.current.id);
  }

  const processSignalRef = useRef(processSignal);
  const rejoinRef = useRef(rejoin);
  useEffect(() => {
    processSignalRef.current = processSignal;
    rejoinRef.current = rejoin;
    soundRef.current = soundOn;
  });

  useEffect(() => {
    if (phase !== "live") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const data = await poll(sessionRef.current!.token);
        if (!active) return;
        setPeers(data.peers);
        for (const s of data.signals) processSignalRef.current(s);
      } catch (err) {
        if (active && err instanceof SessionExpiredError) {
          await rejoinRef.current().catch(() => {});
        }
      }
      if (active) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== "live") return;
    const onLeave = () => {
      if (sessionRef.current) leave(sessionRef.current.token);
    };
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [phase]);

  // Send the clear camera only while both have opted in; the moment either
  // frosts again, go back to the frosted copy.
  const revealed = revealMe && revealThem;
  useEffect(() => {
    void peerRef.current?.setRevealed(revealed);
  }, [revealed]);

  // Someone's calling while the tab is in the background: blink the title.
  const ringing = conn.kind === "incoming" || video === "incoming";
  useEffect(() => {
    if (!ringing) return;
    const original = document.title;
    let on = false;
    const timer = setInterval(() => {
      on = !on;
      document.title = on ? "● Someone wants to talk — Pulse" : original;
    }, 1000);
    return () => {
      clearInterval(timer);
      document.title = original;
    };
  }, [ringing]);

  async function handleReady(lat: number, lng: number) {
    unlockAudio();
    sessionRef.current = await join(lat, lng);
    setMyId(sessionRef.current.id);
    locationRef.current = { lat, lng };
    setMyLocation({ lat, lng });
    setPhase("live");
  }

  function toggleSound() {
    const on = !soundOn;
    setSoundOn(on);
    try {
      localStorage.setItem("pulse:sound", on ? "on" : "off");
    } catch {}
  }

  // "~840 km away · ☾ ≈3:12 AM there"
  function detailFor(peerId: string): string {
    const peer = peers.find((p) => p.id === peerId);
    if (!peer) return "";
    const night = sunElevation(peer.lat, peer.lng, now) < 0;
    const parts = [
      myLocation ? formatDistance(distanceKm(myLocation, peer)) : null,
      `${night ? "☾" : "☀"} ≈${solarTime(peer.lng, now)} there`,
    ];
    return parts.filter(Boolean).join(" · ");
  }

  const live = phase === "live" && myId !== null;
  const inChat = conn.kind === "connecting" || conn.kind === "connected";

  return (
    <main className="fixed inset-0 overflow-hidden bg-space">
      <WorldMap
        peers={peers}
        me={myLocation}
        onPeerClick={requestConnection}
      />

      {phase === "gate" && <EntryGate onReady={handleReady} />}

      {live && (
        <>
          <TopBar
            myId={myId}
            online={peers.length + 1}
            soundOn={soundOn}
            onToggleSound={toggleSound}
          />
          <Toasts toasts={toasts} />

          {conn.kind === "idle" && <QuietState alone={peers.length === 0} />}

          {conn.kind === "requesting" && (
            <RequestCard
              key={conn.peerId}
              peerId={conn.peerId}
              detail={detailFor(conn.peerId)}
              timeoutMs={REQUEST_TIMEOUT_MS}
              onCancel={cancelRequest}
            />
          )}

          {conn.kind === "incoming" && (
            <IncomingCall
              kind="chat"
              peerId={conn.peerId}
              detail={detailFor(conn.peerId)}
              onAccept={acceptIncoming}
              onDecline={declineIncoming}
              onBlock={() => blockPeer(conn.peerId)}
            />
          )}

          {inChat && (
            <ChatPanel
              peerId={conn.peerId}
              detail={detailFor(conn.peerId)}
              messages={messages}
              connected={conn.kind === "connected"}
              peerTyping={peerTyping}
              videoBusy={video !== "none"}
              onSend={sendChat}
              onTyping={sendTyping}
              onStartVideo={startVideoRequest}
              onEnd={endConnection}
              onBlock={() => blockPeer(conn.peerId)}
            />
          )}

          {inChat && video === "requesting" && (
            <div className="pointer-events-none absolute inset-x-0 top-20 z-40 flex justify-center px-4 sm:top-24">
              <p className="glass animate-pop rounded-full px-4 py-2.5 text-sm text-white/85">
                Asking {handleFor(conn.peerId)} to turn on video…
              </p>
            </div>
          )}

          {inChat && video === "incoming" && (
            <IncomingCall
              kind="video"
              peerId={conn.peerId}
              note="Both cameras turn on only if you accept. You can switch yours off any time."
              onAccept={acceptVideo}
              onDecline={declineVideo}
            />
          )}

          {inChat && video === "active" && (
            <VideoPanel
              peerId={conn.peerId}
              localStream={localStream}
              remoteStream={remoteStream}
              micOn={micOn}
              camOn={camOn}
              revealMe={revealMe}
              revealThem={revealThem}
              onToggleMic={toggleMic}
              onToggleCam={toggleCam}
              onToggleReveal={toggleReveal}
              onEnd={endVideo}
            />
          )}
        </>
      )}
    </main>
  );
}

// The current time, refreshed every `ms` — for "≈3:12 AM there" labels.
function useNow(ms: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
