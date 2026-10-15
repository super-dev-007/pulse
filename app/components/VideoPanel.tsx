"use client";

import { useEffect, useRef, useState } from "react";
import {
  Eye,
  Mic,
  MicOff,
  PhoneOff,
  Snowflake,
  Sparkles,
  Video,
  VideoOff,
} from "lucide-react";
import Orb from "./Orb";
import { handleFor } from "@/lib/identity";

export default function VideoPanel({
  peerId,
  localStream,
  remoteStream,
  micOn,
  camOn,
  revealMe,
  revealThem,
  onToggleMic,
  onToggleCam,
  onToggleReveal,
  onEnd,
}: {
  peerId: string;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  revealMe: boolean;
  revealThem: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onToggleReveal: () => void;
  onEnd: () => void;
}) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const name = handleFor(peerId);
  // Mutual Reveal: clear video only while *both* have opted in.
  const revealed = revealMe && revealThem;

  useEffect(() => {
    if (localRef.current && localRef.current.srcObject !== localStream) {
      localRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteRef.current && remoteRef.current.srcObject !== remoteStream) {
      remoteRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  const elapsed = useCallTimer(!!remoteStream);

  return (
    <div
      data-revealed={revealed}
      className="absolute inset-0 z-50 animate-fade overflow-hidden bg-space"
    >
      {/* Remote (full screen). Their client frosts what it sends; we also
          blur what we receive, so a modified client sending clear video
          early still shows nothing until you've both revealed. */}
      <video
        ref={remoteRef}
        autoPlay
        playsInline
        className={`h-full w-full bg-night object-cover transition-[filter,transform] duration-[900ms] ease-out ${
          revealed ? "" : "scale-110 blur-[28px] saturate-150"
        }`}
      />
      {!remoteStream && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-center">
            <div className="ringing relative mx-auto mb-5 grid h-24 w-24 place-items-center text-pulse/60">
              <span className="ring-wave" />
              <span className="ring-wave" />
              <span className="ring-wave" />
              <Orb id={peerId} size={96} />
            </div>
            <p className="text-white/60">Waiting for {name}&rsquo;s camera…</p>
          </div>
        </div>
      )}

      {/* Top: who and how long */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/60 to-transparent px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-10">
        <Orb id={peerId} size={36} live />
        <div>
          <p className="font-semibold text-white">{name}</p>
          <p className="text-xs text-white/60 tabular-nums">
            {remoteStream ? elapsed : "Connecting video…"}
          </p>
        </div>
      </div>

      {remoteStream && (
        <ConsentBar
          name={name}
          revealMe={revealMe}
          revealThem={revealThem}
          onToggle={onToggleReveal}
        />
      )}

      {/* Local (picture-in-picture), draggable */}
      <DraggablePip>
        <video
          ref={localRef}
          autoPlay
          playsInline
          muted
          className={`h-full w-full -scale-x-100 object-cover transition ${camOn ? "" : "opacity-0"}`}
        />
        {!camOn && (
          <div className="absolute inset-0 grid place-items-center text-white/50">
            <VideoOff className="h-6 w-6" />
          </div>
        )}
        <span
          className={`absolute inset-x-2 bottom-2 flex items-center justify-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold tracking-wide backdrop-blur ${
            revealed ? "bg-mint/25 text-mint" : "bg-black/45 text-white/85"
          }`}
        >
          {revealed ? <Eye className="h-3 w-3" /> : <Snowflake className="h-3 w-3" />}
          {revealed ? "Visible" : "Frosted for them"}
        </span>
      </DraggablePip>

      {/* Controls */}
      <div className="absolute inset-x-0 bottom-0 flex justify-center pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="glass flex items-center gap-2 rounded-full p-2">
          <RoundButton
            label={revealMe ? "Frost me again" : "Reveal me"}
            onClick={onToggleReveal}
            active={revealMe}
          >
            {revealMe ? <Snowflake className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
          </RoundButton>
          <RoundButton
            label={micOn ? "Mute microphone" : "Unmute microphone"}
            onClick={onToggleMic}
            active={!micOn}
          >
            {micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </RoundButton>
          <RoundButton
            label={camOn ? "Turn camera off" : "Turn camera on"}
            onClick={onToggleCam}
            active={!camOn}
          >
            {camOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
          </RoundButton>
          <button
            onClick={onEnd}
            aria-label="End video"
            className="flex h-12 items-center gap-2 rounded-full bg-pulse px-5 font-semibold text-white transition hover:bg-[#ff6189]"
          >
            <PhoneOff className="h-5 w-5" />
            <span className="hidden sm:inline">End video</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// Where the reveal stands, and the one action that moves it forward.
function ConsentBar({
  name,
  revealMe,
  revealThem,
  onToggle,
}: {
  name: string;
  revealMe: boolean;
  revealThem: boolean;
  onToggle: () => void;
}) {
  if (revealMe && revealThem) {
    return (
      <div className="absolute inset-x-0 top-24 flex justify-center px-4">
        <div className="glass flex animate-pop items-center gap-3 rounded-full py-1.5 pr-1.5 pl-4 text-sm text-white/85">
          <Sparkles className="h-4 w-4 text-glow" />
          Revealed — you can see each other
          <button
            onClick={onToggle}
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20"
          >
            <Snowflake className="h-3.5 w-3.5" />
            Frost me
          </button>
        </div>
      </div>
    );
  }

  const [title, body, cta] = revealMe
    ? [
        "You're ready to be seen",
        `Waiting for ${name} — you both stay frosted until they reveal too.`,
        "Not yet",
      ]
    : revealThem
      ? [`${name} is ready to reveal`, "Your turn — or keep talking frosted.", "Reveal me"]
      : [
          "You're both frosted",
          "Faces stay hidden until you both tap Reveal. Either of you can frost again any time.",
          "Reveal me",
        ];

  return (
    <div className="absolute inset-x-0 top-24 flex justify-center px-4">
      <div className="glass flex w-full max-w-md animate-rise items-center gap-4 rounded-3xl p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-sky/15 text-sky">
          <Snowflake className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-white">{title}</p>
          <p className="text-xs leading-relaxed text-white/55">{body}</p>
        </div>
        <button
          onClick={onToggle}
          className={`shrink-0 rounded-full px-4 py-2.5 text-sm font-semibold transition ${
            revealMe
              ? "bg-white/10 text-white hover:bg-white/20"
              : `bg-pulse text-white hover:bg-[#ff6189] ${revealThem ? "glow-pulse" : ""}`
          }`}
        >
          {cta}
        </button>
      </div>
    </div>
  );
}

function RoundButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`grid h-12 w-12 place-items-center rounded-full transition ${
        active ? "bg-white text-space" : "bg-white/10 text-white hover:bg-white/20"
      }`}
    >
      {children}
    </button>
  );
}

function useCallTimer(running: boolean): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t0 = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - t0) / 1000)),
      1000,
    );
    return () => {
      clearInterval(timer);
      setSeconds(0);
    };
  }, [running]);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// The self-view, draggable anywhere on the stage (kept on screen).
function DraggablePip({ children }: { children: React.ReactNode }) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  return (
    <div
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
      }}
      onPointerMove={(e) => {
        const stage = e.currentTarget.parentElement;
        if (!drag.current || !stage) return;
        const bounds = stage.getBoundingClientRect();
        const box = e.currentTarget.getBoundingClientRect();
        // Where the box sits with no offset (it's anchored bottom-right).
        const baseLeft = box.left - offset.x;
        const baseTop = box.top - offset.y;
        const x = Math.min(
          Math.max(drag.current.ox + e.clientX - drag.current.x, bounds.left + 12 - baseLeft),
          bounds.right - 12 - box.width - baseLeft,
        );
        const y = Math.min(
          Math.max(drag.current.oy + e.clientY - drag.current.y, bounds.top + 12 - baseTop),
          bounds.bottom - 12 - box.height - baseTop,
        );
        setOffset({ x, y });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      className="absolute right-4 bottom-28 h-44 w-32 cursor-grab touch-none overflow-hidden rounded-2xl border border-white/15 bg-night shadow-2xl shadow-black/60 active:cursor-grabbing sm:h-56 sm:w-40"
    >
      {children}
    </div>
  );
}
