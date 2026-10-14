"use client";

export interface Toast {
  id: number;
  text: string;
  tone?: "info" | "warn";
}

// Short status notes ("Request declined.") stacked under the top bar.
export default function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 top-20 z-40 flex flex-col items-center gap-2 px-4 sm:top-24"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`glass animate-pop rounded-full px-4 py-2.5 text-sm ${
            t.tone === "warn" ? "text-pulse-soft" : "text-white/90"
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
