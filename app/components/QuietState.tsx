"use client";

import { useState } from "react";
import { Check, Link2, MousePointerClick } from "lucide-react";

// Shown while you're idle on the map: an empty globe gets a friendly way to
// bring someone in; a populated one gets a nudge toward the dots.
export default function QuietState({ alone }: { alone: boolean }) {
  const [copied, setCopied] = useState(false);

  if (!alone) {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-8">
        <p className="glass flex animate-rise items-center gap-2 rounded-full px-4 py-2.5 text-sm text-white/75">
          <MousePointerClick className="h-4 w-4 text-glow" />
          Tap a glowing dot to say hello
        </p>
      </div>
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-10 flex justify-center px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-8">
      <div className="glass w-full max-w-sm animate-sheet rounded-3xl p-5">
        <p className="font-display text-2xl text-white">It&rsquo;s quiet out here.</p>
        <p className="mt-1.5 text-sm leading-relaxed text-white/55">
          You&rsquo;re the only light on the globe right now. Send the link to a
          friend — or open Pulse in a second window — and watch a new dot
          appear.
        </p>
        <button
          onClick={copy}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/15"
        >
          {copied ? <Check className="h-4 w-4 text-mint" /> : <Link2 className="h-4 w-4" />}
          {copied ? "Link copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}
