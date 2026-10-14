// "Pulse" in the display serif, led by an ECG line that keeps beating.
export default function Wordmark({ size = "md" }: { size?: "sm" | "md" }) {
  const small = size === "sm";
  return (
    <span className="inline-flex items-center gap-1.5 select-none">
      <svg
        viewBox="0 0 48 24"
        className={small ? "h-4 w-8" : "h-6 w-12"}
        aria-hidden
      >
        {[0.35, 1].map((opacity) => (
          <path
            key={opacity}
            className={opacity === 1 ? "ecg-path" : undefined}
            d="M1 12h11l4-8 6 16 5-12 3 4h17"
            fill="none"
            stroke="var(--color-pulse)"
            strokeOpacity={opacity}
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
      <span
        className={`font-display italic leading-none tracking-tight text-white ${
          small ? "text-xl" : "text-3xl"
        }`}
      >
        Pulse
      </span>
    </span>
  );
}
