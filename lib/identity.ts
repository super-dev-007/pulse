// Anonymous, but not faceless: every session gets a friendly handle and a
// colour derived from its public id. Deterministic, so both people see the
// same name for the same session — and it's gone when the session ends.

const ADJECTIVES = [
  "Amber", "Velvet", "Quiet", "Lunar", "Copper", "Misty", "Golden", "Silver",
  "Coral", "Indigo", "Wild", "Gentle", "Electric", "Sleepy", "Bright", "Hidden",
  "Cosmic", "Rusty", "Jade", "Scarlet", "Polar", "Dusky", "Neon", "Saffron",
];

const NOUNS = [
  "Fox", "Heron", "Comet", "Otter", "Lantern", "Moth", "Falcon", "Willow",
  "Harbor", "Meadow", "Lynx", "Ember", "Orca", "Sparrow", "Nebula", "Koi",
  "Raven", "Tide", "Juniper", "Panda", "Aurora", "Cedar", "Firefly", "Pebble",
];

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function handleFor(id: string): string {
  const h = hash(id);
  return `${ADJECTIVES[h % ADJECTIVES.length]} ${NOUNS[(h >>> 8) % NOUNS.length]}`;
}

// Two hues for a soft gradient orb (the stranger's "avatar").
export function orbFor(id: string): { from: string; to: string } {
  const h = hash(id);
  const hue = h % 360;
  return {
    from: `hsl(${hue} 90% 68%)`,
    to: `hsl(${(hue + 50) % 360} 85% 52%)`,
  };
}

// Each dot beats at its own rhythm so the map never pulses in lockstep.
export function heartbeatFor(id: string): { duration: number; delay: number } {
  const h = hash(id);
  return { duration: 1.8 + (h % 900) / 1000, delay: -((h >>> 10) % 2000) / 1000 };
}
