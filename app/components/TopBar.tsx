"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldCheck, Volume2, VolumeX } from "lucide-react";
import Wordmark from "./Wordmark";
import Orb from "./Orb";
import { handleFor } from "@/lib/identity";

export default function TopBar({
  myId,
  online,
  soundOn,
  onToggleSound,
}: {
  myId: string;
  online: number;
  soundOn: boolean;
  onToggleSound: () => void;
}) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-start justify-between gap-3 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5 sm:pt-5">
      <div className="glass pointer-events-auto flex animate-rise items-center gap-3 rounded-full py-2 pr-4 pl-3">
        <Wordmark size="sm" />
        <span className="h-4 w-px bg-white/15" />
        <span className="flex items-center gap-2 text-sm text-white/80 tabular-nums">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-mint" />
          </span>
          {online.toLocaleString("en-US")} online
        </span>
      </div>

      <div
        ref={popRef}
        className="pointer-events-auto relative flex animate-rise items-center gap-1"
      >
        <button
          onClick={onToggleSound}
          aria-label={soundOn ? "Mute sounds" : "Turn sounds on"}
          className="glass grid h-11 w-11 place-items-center rounded-full text-white/70 transition hover:text-white"
        >
          {soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
        </button>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="glass flex h-11 items-center gap-2 rounded-full pr-4 pl-1.5 text-sm text-white/85 transition hover:text-white"
        >
          <Orb id={myId} size={30} />
          <span className="hidden sm:inline">You&rsquo;re {handleFor(myId)}</span>
          <span className="sm:hidden">You</span>
        </button>

        {open && (
          <div className="glass absolute top-14 right-0 w-72 animate-pop rounded-3xl p-5 text-sm">
            <div className="flex items-center gap-3">
              <Orb id={myId} size={44} />
              <div>
                <p className="font-semibold text-white">{handleFor(myId)}</p>
                <p className="text-xs text-white/50">
                  A name for this session only
                </p>
              </div>
            </div>
            <ul className="mt-4 space-y-2.5 text-white/65">
              {[
                "Others see your dot at a random spot 1–3 km from you — zoom in on yourself to see the circle.",
                "Messages and video go straight between browsers. Pulse never sees them.",
                "Close the tab and you vanish: no history, no account.",
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-mint" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
