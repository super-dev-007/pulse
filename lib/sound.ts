// Tiny synthesized cues (no audio files): a two-note chime for an incoming
// request, a soft blip for a new message. Browsers only allow audio after a
// user gesture, so unlockAudio() runs on the "enter" click.

let ctx: AudioContext | null = null;

export function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
  } catch {}
}

function tone(freq: number, start: number, length: number, peak: number) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + length + 0.05);
}

export function chime() {
  if (!ctx) return;
  const t = ctx.currentTime;
  tone(659, t, 0.45, 0.16);
  tone(988, t + 0.16, 0.6, 0.14);
}

export function blip() {
  if (!ctx) return;
  tone(880, ctx.currentTime, 0.18, 0.07);
}
