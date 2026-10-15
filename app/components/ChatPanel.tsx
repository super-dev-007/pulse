"use client";

import { useEffect, useRef, useState } from "react";
import {
  Loader2,
  Lock,
  PhoneOff,
  SendHorizontal,
  ShieldBan,
  Video,
} from "lucide-react";
import Orb from "./Orb";
import { handleFor } from "@/lib/identity";
import { MAX_CHAT_LENGTH } from "@/lib/webrtc";

export interface ChatMessage {
  id: number;
  mine: boolean;
  text: string;
  at: number;
}

const ICEBREAKERS = [
  "What time is it where you are? 🌙",
  "What's the view from your window right now?",
  "What's your city better at than anywhere else?",
  "What song is stuck in your head today?",
  "What's the weather doing over there?",
  "What did you have for dinner?",
];

export default function ChatPanel({
  peerId,
  detail,
  messages,
  connected,
  peerTyping,
  video,
  hidden,
  onSend,
  onTyping,
  onStartVideo,
  onCancelVideo,
  onEnd,
  onBlock,
}: {
  peerId: string;
  detail: string;
  messages: ChatMessage[];
  connected: boolean;
  peerTyping: boolean;
  video: "none" | "requesting" | "incoming" | "starting" | "active";
  hidden: boolean; // under the video stage: out of the tab order
  onSend: (text: string) => void;
  onTyping: () => void;
  onStartVideo: () => void;
  onCancelVideo: () => void;
  onEnd: () => void;
  onBlock: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [confirmBlock, setConfirmBlock] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const name = handleFor(peerId);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, peerTyping]);

  useEffect(() => {
    if (connected) inputRef.current?.focus({ preventScroll: true });
  }, [connected]);

  function send(text: string) {
    const t = text.trim();
    if (!t || !connected) return;
    onSend(t);
    setDraft("");
  }

  // Three openers, picked per conversation.
  const seed = peerId.charCodeAt(0) + peerId.charCodeAt(peerId.length - 1);
  const openers = [0, 1, 2].map((i) => ICEBREAKERS[(seed + i * 2) % ICEBREAKERS.length]);

  return (
    <section
      aria-label={`Chat with ${name}`}
      inert={hidden}
      className="surface absolute inset-x-0 bottom-0 z-30 flex h-[76dvh] animate-sheet flex-col rounded-t-[28px] md:inset-x-auto md:top-24 md:right-5 md:bottom-5 md:h-auto md:w-[400px] md:rounded-[28px]"
    >
      <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-white/15 md:hidden" />

      <header className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-4">
        <Orb id={peerId} size={44} live={connected} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-white">{name}</p>
          <p className="flex items-center gap-1.5 truncate text-xs text-white/50">
            {connected ? (
              <>
                <Lock className="h-3 w-3 text-mint" />
                Live · private
              </>
            ) : (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Connecting…
              </>
            )}
          </p>
        </div>
        <button
          onClick={() => setConfirmBlock((c) => !c)}
          aria-label="Block"
          aria-expanded={confirmBlock}
          title="Block"
          className="grid h-11 w-11 place-items-center rounded-full bg-white/8 text-white/60 transition hover:bg-white/15 hover:text-white"
        >
          <ShieldBan className="h-[18px] w-[18px]" />
        </button>
        <button
          onClick={onStartVideo}
          disabled={!connected || video !== "none"}
          aria-label="Start video"
          title="Start video"
          className="grid h-11 w-11 place-items-center rounded-full bg-white/8 text-white/85 transition hover:bg-white/15 hover:text-white disabled:opacity-35"
        >
          <Video className="h-[18px] w-[18px]" />
        </button>
        <button
          onClick={onEnd}
          aria-label="End"
          title="End conversation"
          className="grid h-11 w-11 place-items-center rounded-full bg-pulse text-white transition hover:bg-[#ff6189]"
        >
          <PhoneOff className="h-[18px] w-[18px]" />
        </button>
      </header>

      {confirmBlock && (
        <div className="flex animate-rise items-center gap-3 border-b border-white/[0.06] bg-pulse/[0.07] px-5 py-3 text-sm">
          <p className="flex-1 text-white/75">
            Block {name}? You&rsquo;ll both disappear from each other&rsquo;s
            map for the rest of this session.
          </p>
          <button
            onClick={() => setConfirmBlock(false)}
            className="rounded-full px-3 py-1.5 text-white/60 transition hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={onBlock}
            className="rounded-full bg-pulse px-3.5 py-1.5 font-semibold text-white transition hover:bg-[#ff6189]"
          >
            Block
          </button>
        </div>
      )}

      {(video === "requesting" || video === "starting") && (
        <div
          role="status"
          className="flex animate-rise items-center gap-3 border-b border-white/[0.06] bg-sky/[0.06] px-5 py-3 text-sm"
        >
          <Video className="h-4 w-4 shrink-0 text-sky" />
          <p className="flex-1 text-white/75">
            {video === "requesting"
              ? `Asking ${name} to turn on video…`
              : "Starting your camera — frosted until you both reveal."}
          </p>
          {video === "requesting" && (
            <button
              onClick={onCancelVideo}
              className="rounded-full px-3 py-1.5 text-white/60 transition hover:text-white"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      <div className="flex-1 space-y-1.5 overflow-y-auto px-4 py-4">
        <div className="mx-auto mb-4 max-w-[85%] rounded-2xl bg-white/[0.04] px-4 py-3 text-center text-xs leading-relaxed text-white/45">
          {connected ? (
            <>
              You&rsquo;re talking to <span className="text-white/75">{name}</span>
              {detail && <> · {detail}</>}. Messages go straight between you — Pulse
              never sees them.
            </>
          ) : (
            <>Setting up a direct, private link…</>
          )}
        </div>

        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = prev && prev.mine === m.mine;
          return (
            <div
              key={m.id}
              className={`flex animate-rise ${m.mine ? "justify-end" : "justify-start"} ${grouped ? "" : "pt-1.5"}`}
            >
              <p
                title={new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                className={`max-w-[80%] px-4 py-2.5 text-[15px] leading-snug break-words whitespace-pre-wrap ${
                  m.mine
                    ? "rounded-[22px] rounded-br-md bg-gradient-to-br from-pulse to-[#ff6a5c] text-white"
                    : "rounded-[22px] rounded-bl-md bg-white/[0.08] text-white/90"
                }`}
              >
                {m.text}
              </p>
            </div>
          );
        })}

        {peerTyping && (
          <div className="flex animate-fade justify-start pt-1.5" aria-label={`${name} is typing`}>
            <p className="flex gap-1 rounded-[22px] rounded-bl-md bg-white/[0.08] px-4 py-3.5">
              {[0, 1, 2].map((i) => (
                <span key={i} className="typing-dot h-1.5 w-1.5 rounded-full bg-white/70" />
              ))}
            </p>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {connected && messages.length === 0 && (
        // A swipeable row on phones; wrapped on desktop, where sideways
        // scrolling with a mouse isn't obvious.
        <div className="flex gap-2 overflow-x-auto px-4 pb-3 md:flex-wrap md:overflow-visible">
          {openers.map((o) => (
            <button
              key={o}
              onClick={() => send(o)}
              className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs text-white/70 transition hover:border-pulse/50 hover:text-white"
            >
              {o}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className="flex items-center gap-2 border-t border-white/[0.06] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        <input
          ref={inputRef}
          value={draft}
          maxLength={MAX_CHAT_LENGTH}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value) onTyping();
          }}
          placeholder={connected ? "Type a message…" : "Connecting…"}
          disabled={!connected}
          aria-label="Message"
          className="h-12 flex-1 rounded-full bg-white/[0.06] px-5 text-[15px] text-white outline-none placeholder:text-white/35 focus:bg-white/[0.09] focus:ring-1 focus:ring-pulse/60 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!connected || !draft.trim()}
          aria-label="Send"
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-pulse text-white transition hover:bg-[#ff6189] disabled:bg-white/10 disabled:text-white/40"
        >
          <SendHorizontal className="h-5 w-5" />
        </button>
      </form>
    </section>
  );
}
