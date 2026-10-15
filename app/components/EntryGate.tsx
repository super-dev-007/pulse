"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Loader2, MapPinOff } from "lucide-react";
import Wordmark from "./Wordmark";

const PROMISES = [
  "No sign-up",
  "Your dot sits 1–3 km from you",
  "Chat & video go peer-to-peer",
  "Nothing is stored",
];

// The landing overlay. The globe is already turning behind it; entering
// flies the camera down to you.
export default function EntryGate({
  onReady,
}: {
  onReady: (lat: number, lng: number) => Promise<void>;
}) {
  const [status, setStatus] = useState<"idle" | "locating" | "error">("idle");
  const [error, setError] = useState<string>("");
  const online = useOnlineCount();

  function enter() {
    if (!("geolocation" in navigator)) {
      setStatus("error");
      setError("Your browser doesn't support location access.");
      return;
    }
    setStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        onReady(pos.coords.latitude, pos.coords.longitude).catch(() => {
          setStatus("error");
          setError("Couldn't reach Pulse. Please try again.");
        }),
      (err) => {
        setStatus("error");
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Pulse needs your location to place your dot — allow it in the address bar, then try again."
            : "Couldn't get your location. Please try again.",
        );
      },
      // High accuracy + maximumAge:0 forces a fresh fix (Wi-Fi/GPS scan)
      // instead of reusing the browser's cached IP-based location.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex flex-col justify-between bg-gradient-to-t from-space via-space/55 to-space/10 px-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-12 sm:py-10">
      <header className="animate-fade">
        <Wordmark />
      </header>

      <main className="pointer-events-auto max-w-2xl animate-rise">
        <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white/75 backdrop-blur">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-mint" />
          </span>
          {online === null
            ? "Live right now"
            : online === 0
              ? "The globe is quiet — be its first light"
              : online === 1
                ? "1 person on the globe right now"
                : `${online.toLocaleString("en-US")} people on the globe right now`}
        </p>

        <h1 className="font-display text-[3.4rem] leading-[0.92] tracking-tight text-white sm:text-8xl">
          Strangers, everywhere.
          <br />
          <em className="text-pulse">Right now.</em>
        </h1>
        <p className="mt-5 max-w-md text-lg leading-relaxed text-white/60">
          Every glowing dot is someone awake somewhere on Earth. Tap one, say
          hi — then let it vanish.
        </p>

        <button
          onClick={enter}
          disabled={status === "locating"}
          className="group mt-9 inline-flex items-center gap-3 rounded-full bg-pulse py-4 pr-5 pl-7 text-base font-semibold text-white glow-pulse transition hover:-translate-y-0.5 hover:bg-[#ff6189] focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none disabled:translate-y-0 disabled:opacity-80"
        >
          {status === "locating" ? (
            <>
              Finding you
              <Loader2 className="h-5 w-5 animate-spin" />
            </>
          ) : (
            <>
              Drop onto the globe
              <span className="grid h-8 w-8 place-items-center rounded-full bg-white/15 transition group-hover:translate-x-0.5">
                <ArrowRight className="h-4 w-4" />
              </span>
            </>
          )}
        </button>

        {status === "error" && (
          <p
            role="alert"
            className="mt-5 flex max-w-md animate-rise items-start gap-2.5 rounded-2xl border border-pulse/30 bg-pulse/10 px-4 py-3 text-sm text-pulse-soft"
          >
            <MapPinOff className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        )}

        <ul className="mt-9 flex flex-wrap gap-2">
          {PROMISES.map((p) => (
            <li
              key={p}
              className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/55 backdrop-blur"
            >
              {p}
            </li>
          ))}
        </ul>
      </main>

      <footer className="animate-fade text-xs text-white/30">
        Your location only places your dot. Closing the tab ends everything.
      </footer>
    </div>
  );
}

function useOnlineCount(): number | null {
  const [online, setOnline] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    const load = () =>
      fetch("/api/stats")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (active && d && typeof d.online === "number") setOnline(d.online);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return online;
}
