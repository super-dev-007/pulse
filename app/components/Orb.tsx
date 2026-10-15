import { orbFor } from "@/lib/identity";

// A stranger's "face": a soft gradient orb derived from their session id.
export default function Orb({
  id,
  size = 40,
  live = false,
}: {
  id: string;
  size?: number;
  live?: boolean;
}) {
  const { from, to } = orbFor(id);
  return (
    <span
      aria-hidden
      className="relative inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 30% 28%, #fff8, transparent 38%), radial-gradient(circle at 35% 35%, ${from}, ${to})`,
        boxShadow: `0 0 ${size / 1.6}px -${size / 8}px ${from}`,
      }}
    >
      {live && (
        <span className="absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-night bg-mint" />
      )}
    </span>
  );
}
