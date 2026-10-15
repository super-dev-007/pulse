"use client";

import { useEffect, useRef } from "react";
import { Phone, PhoneOff, Video } from "lucide-react";
import Orb from "./Orb";
import { handleFor } from "@/lib/identity";

// "Someone wants to talk" / "…wants to turn on video": a ringing card that
// takes focus once when it appears and keeps Tab inside it. Enter accepts,
// Escape declines.
export default function IncomingCall({
  peerId,
  kind,
  detail,
  note,
  onAccept,
  onDecline,
  onBlock,
}: {
  peerId: string;
  kind: "chat" | "video";
  detail?: string;
  note?: string;
  onAccept: () => void;
  onDecline: () => void;
  onBlock?: () => void;
}) {
  const acceptRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The parent re-renders on every poll with fresh callbacks; read the latest
  // through a ref so this effect runs once — re-running it would yank focus
  // back to Accept every 1.5s (and Enter would accept instead of, say, block).
  const declineRef = useRef(onDecline);
  useEffect(() => {
    declineRef.current = onDecline;
  });
  useEffect(() => {
    acceptRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        declineRef.current();
        return;
      }
      const dialog = dialogRef.current;
      if (e.key !== "Tab" || !dialog) return;
      const buttons = dialog.querySelectorAll<HTMLElement>("button");
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      const inside = dialog.contains(document.activeElement);
      if (!inside || (e.shiftKey && document.activeElement === first)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const name = handleFor(peerId);
  return (
    <div className="absolute inset-0 z-40 grid animate-fade place-items-center bg-space/60 p-5 backdrop-blur-[2px]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="incoming-title"
        className="glass w-full max-w-sm animate-pop rounded-[32px] px-7 pt-9 pb-7 text-center"
      >
        <div className="ringing relative mx-auto mb-6 grid h-24 w-24 place-items-center text-pulse/70">
          <span className="ring-wave" />
          <span className="ring-wave" />
          <span className="ring-wave" />
          <Orb id={peerId} size={96} />
          {kind === "video" && (
            <span className="absolute -right-1 -bottom-1 grid h-9 w-9 place-items-center rounded-full border-4 border-night bg-pulse text-white">
              <Video className="h-4 w-4" />
            </span>
          )}
        </div>
        <h2 id="incoming-title" className="font-display text-3xl leading-tight text-white">
          {kind === "chat" ? (
            <>
              <em>{name}</em> wants to talk
            </>
          ) : (
            <>
              <em>{name}</em> wants video
            </>
          )}
        </h2>
        {detail && <p className="mt-2 text-sm text-white/55">{detail}</p>}
        {note && <p className="mt-3 text-xs leading-relaxed text-white/40">{note}</p>}
        <div className="mt-7 flex gap-3">
          <button
            onClick={onDecline}
            className="flex flex-1 items-center justify-center gap-2 rounded-full bg-white/8 py-3.5 font-medium text-white/80 transition hover:bg-white/15 hover:text-white"
          >
            <PhoneOff className="h-4 w-4" />
            Decline
          </button>
          <button
            ref={acceptRef}
            onClick={onAccept}
            className="flex flex-1 items-center justify-center gap-2 rounded-full bg-pulse py-3.5 font-semibold text-white glow-pulse transition hover:bg-[#ff6189] focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
          >
            {kind === "chat" ? <Phone className="h-4 w-4" /> : <Video className="h-4 w-4" />}
            Accept
          </button>
        </div>
        {onBlock && (
          <button
            onClick={onBlock}
            className="mt-4 text-xs text-white/40 underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Decline &amp; block {name}
          </button>
        )}
      </div>
    </div>
  );
}
