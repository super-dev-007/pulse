"use client";

import { X } from "lucide-react";
import Orb from "./Orb";
import { handleFor } from "@/lib/identity";

// Outgoing request: who we're calling, and a ring that runs out with the
// request's timeout.
export default function RequestCard({
  peerId,
  detail,
  timeoutMs,
  onCancel,
}: {
  peerId: string;
  detail: string;
  timeoutMs: number;
  onCancel: () => void;
}) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-8">
      <div className="glass pointer-events-auto flex w-full max-w-md animate-sheet items-center gap-4 rounded-3xl p-4">
        <div className="relative grid h-[60px] w-[60px] shrink-0 place-items-center">
          <svg viewBox="0 0 60 60" className="absolute inset-0 -rotate-90">
            <circle cx="30" cy="30" r={r} fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth="3" />
            <circle
              cx="30"
              cy="30"
              r={r}
              fill="none"
              stroke="var(--color-pulse)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={c}
              style={
                {
                  "--ring": c,
                  animation: `countdown ${timeoutMs}ms linear forwards`,
                } as React.CSSProperties
              }
            />
          </svg>
          <Orb id={peerId} size={40} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-white">
            Calling {handleFor(peerId)}
            <span className="inline-flex w-5">
              <span className="typing-dot">.</span>
              <span className="typing-dot">.</span>
              <span className="typing-dot">.</span>
            </span>
          </p>
          <p className="line-clamp-2 text-sm text-white/50">{detail}</p>
        </div>
        <button
          onClick={onCancel}
          aria-label="Cancel request"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
