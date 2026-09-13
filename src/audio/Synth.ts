/**
 * Procedural SFX library. Every sound is synthesized from oscillators, noise buffers,
 * envelopes and filters — no audio files. Sounds are keyed by id (see SOUNDS).
 */
import { MINIGUN_SPINDOWN_TIME, MINIGUN_SPINUP_TIME } from '@/shared';

type OscType = OscillatorType;

interface ToneOpts {
  type?: OscType;
  f0: number;            // start frequency
  f1?: number;           // end frequency (exponential sweep)
  t0: number;            // start time (AudioContext time)
  dur: number;
  gain: number;
  attack?: number;
  decayCurve?: 'exp' | 'lin';
  detune?: number;
  vibratoHz?: number;
  vibratoDepth?: number; // cents
  lp?: number;           // optional lowpass cutoff
  /**
   * 2026-09-11: flat sustain instead of the decay — attack → hold at `gain` → linear fade over the last `release` s.
   * For spin-ups / hums and the ★ periodic one-shots, so overlapping hits read as one continuous sound.
   */
  release?: number;
}

interface NoiseOpts {
  t0: number;
  dur: number;
  gain: number;
  attack?: number;
  filter?: { type: BiquadFilterType; f0: number; f1?: number; q?: number };
  decayCurve?: 'exp' | 'lin';
  /** 2026-09-11: see `ToneOpts.release`. */
  release?: number;
}

export type SoundFn = (s: Synth, dest: AudioNode, t: number, pitch: number) => number; // returns duration

export class Synth {
  readonly ctx: AudioContext;
  private noiseBuf: AudioBuffer;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /* ── primitives ──────────────────────────────────────────────────────── */
  tone(dest: AudioNode, o: ToneOpts): void {
    const c = this.ctx;
    const osc = c.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(Math.max(1, o.f0), o.t0);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), o.t0 + o.dur);
    if (o.detune) osc.detune.value = o.detune;
    let node: AudioNode = osc;
    if (o.vibratoHz) {
      const lfo = c.createOscillator(); lfo.frequency.value = o.vibratoHz;
      const lg = c.createGain(); lg.gain.value = o.vibratoDepth ?? 30;
      lfo.connect(lg).connect(osc.detune);
      lfo.start(o.t0); lfo.stop(o.t0 + o.dur + 0.05);
    }
    if (o.lp) {
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp;
      node.connect(f); node = f;
    }
    const g = c.createGain();
    this.env(g.gain, o.t0, o.dur, o.gain, o.attack ?? 0.004, o.decayCurve ?? 'exp', o.release);
    node.connect(g).connect(dest);
    osc.start(o.t0); osc.stop(o.t0 + o.dur + 0.05);
  }

  noise(dest: AudioNode, o: NoiseOpts): void {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    src.loopStart = Math.random() * 1.5;
    let node: AudioNode = src;
    if (o.filter) {
      const f = c.createBiquadFilter();
      f.type = o.filter.type; f.Q.value = o.filter.q ?? 1;
      f.frequency.setValueAtTime(o.filter.f0, o.t0);
      if (o.filter.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(10, o.filter.f1), o.t0 + o.dur);
      node.connect(f); node = f;
    }
    const g = c.createGain();
    this.env(g.gain, o.t0, o.dur, o.gain, o.attack ?? 0.003, o.decayCurve ?? 'exp', o.release);
    node.connect(g).connect(dest);
    src.start(o.t0, src.loopStart); src.stop(o.t0 + o.dur + 0.05);
  }

  /** Short metallic click: bandpassed noise burst + a brief square ping. Used for bolts, latches, servos. */
  click(dest: AudioNode, t0: number, f: number, gain: number, dur = 0.03): void {
    this.noise(dest, { t0, dur, gain, filter: { type: 'bandpass', f0: f, q: 2.5 } });
    this.tone(dest, { type: 'square', f0: f * 0.9, f1: f * 0.6, t0, dur: dur * 1.4, gain: gain * 0.35, lp: f * 2.2 });
  }

  /** Reverberant tail: several staggered, darkening noise layers with a linear decay. */
  tail(dest: AudioNode, t0: number, dur: number, gain: number, f0: number, f1: number): void {
    const layers = 3;
    for (let i = 0; i < layers; i++) {
      const dt = i * 0.035;
      const g = gain * (1 - i * 0.28);
      this.noise(dest, { t0: t0 + dt, dur: dur - dt, gain: g, attack: 0.01 + i * 0.02, filter: { type: 'lowpass', f0: f0 / (1 + i * 0.4), f1, q: 0.5 }, decayCurve: 'lin' });
    }
  }

  private env(p: AudioParam, t0: number, dur: number, peak: number, attack: number, curve: 'exp' | 'lin', release?: number): void {
    const a = Math.min(attack, dur * 0.5);
    p.setValueAtTime(0.0001, t0);
    p.linearRampToValueAtTime(peak, t0 + a);
    if (release !== undefined) {
      // hold the peak, then a linear fade over the last `release` seconds (never before the attack has finished)
      p.setValueAtTime(peak, t0 + Math.max(a, dur - Math.max(0.005, release)));
      p.linearRampToValueAtTime(0.0001, t0 + dur);
      return;
    }
    if (curve === 'exp') p.exponentialRampToValueAtTime(0.0001, t0 + dur);
    else p.linearRampToValueAtTime(0.0001, t0 + dur);
  }

  /** Multi-stage gain envelope (for long sounds). points: [timeOffset, value] */
  envelope(dest: AudioNode, t0: number, points: Array<[number, number]>): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    for (const [dt, v] of points) g.gain.linearRampToValueAtTime(Math.max(0.0001, v), t0 + dt);
    g.connect(dest);
    return g;
  }
}

const r = (a: number, b: number) => a + Math.random() * (b - a);

/* ── the library ────────────────────────────────────────────────────────── */
export const SOUNDS: Record<string, SoundFn> = {
  /* weapons */
  shot_rifle: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.09, gain: 0.7, filter: { type: 'bandpass', f0: 1800 * p, f1: 500 * p, q: 0.7 } });
    s.noise(d, { t0: t, dur: 0.03, gain: 0.5, filter: { type: 'highpass', f0: 3500 } });
    s.tone(d, { type: 'sine', f0: 170 * p, f1: 55 * p, t0: t, dur: 0.13, gain: 0.8 });
    s.tone(d, { type: 'triangle', f0: 900 * p, f1: 200 * p, t0: t, dur: 0.05, gain: 0.25 });
    return 0.15;
  },
  shot_pistol: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.06, gain: 0.6, filter: { type: 'bandpass', f0: 2400 * p, f1: 800 * p, q: 0.8 } });
    s.tone(d, { type: 'sine', f0: 230 * p, f1: 80 * p, t0: t, dur: 0.1, gain: 0.7 });
    s.tone(d, { type: 'square', f0: 1400 * p, f1: 400 * p, t0: t, dur: 0.03, gain: 0.15 });
    return 0.12;
  },
  shot_shotgun: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.22, gain: 1.0, filter: { type: 'lowpass', f0: 2200 * p, f1: 300 * p, q: 0.5 } });
    s.noise(d, { t0: t, dur: 0.05, gain: 0.6, filter: { type: 'highpass', f0: 2500 } });
    s.tone(d, { type: 'sine', f0: 95 * p, f1: 35 * p, t0: t, dur: 0.28, gain: 1.0 });
    return 0.3;
  },
  shot_energy: (s, d, t, p) => {
    s.tone(d, { type: 'sawtooth', f0: 950 * p, f1: 280 * p, t0: t, dur: 0.16, gain: 0.35, lp: 3000 });
    s.tone(d, { type: 'sine', f0: 1500 * p, f1: 420 * p, t0: t, dur: 0.12, gain: 0.35 });
    s.noise(d, { t0: t, dur: 0.05, gain: 0.25, filter: { type: 'highpass', f0: 4000 } });
    return 0.18;
  },
  dry_fire: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.012, gain: 0.35, filter: { type: 'highpass', f0: 3000 } });
    s.tone(d, { type: 'square', f0: 1300 * p, f1: 900 * p, t0: t, dur: 0.02, gain: 0.12 });
    return 0.04;
  },
  reload_start: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.02, gain: 0.3, filter: { type: 'highpass', f0: 1500 } });
    s.tone(d, { type: 'square', f0: 420 * p, f1: 300 * p, t0: t, dur: 0.04, gain: 0.12, lp: 2500 });
    s.noise(d, { t0: t + 0.12, dur: 0.05, gain: 0.2, filter: { type: 'bandpass', f0: 900, q: 2 } });
    return 0.2;
  },
  reload_end: (s, d, t, p) => {
    s.tone(d, { type: 'square', f0: 950 * p, f1: 620 * p, t0: t, dur: 0.05, gain: 0.14, lp: 3200 });
    s.noise(d, { t0: t, dur: 0.035, gain: 0.35, filter: { type: 'bandpass', f0: 2200, q: 1.5 } });
    s.tone(d, { type: 'triangle', f0: 240 * p, f1: 180 * p, t0: t + 0.03, dur: 0.06, gain: 0.2 });
    return 0.1;
  },
  hit_flesh: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.09, gain: 0.5, filter: { type: 'lowpass', f0: 600 * p, f1: 150, q: 0.8 } });
    s.tone(d, { type: 'sine', f0: 140 * p, f1: 60, t0: t, dur: 0.1, gain: 0.45 });
    return 0.1;
  },
  hit_terrain: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.05, gain: 0.35, filter: { type: 'bandpass', f0: 3200 * p, f1: 1200, q: 1.2 } });
    s.tone(d, { type: 'sine', f0: 700 * p, f1: 300, t0: t, dur: 0.03, gain: 0.12 });
    return 0.06;
  },
  grenade_throw: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.32, gain: 0.25, attack: 0.08, filter: { type: 'bandpass', f0: 400 * p, f1: 1400 * p, q: 1.5 }, decayCurve: 'lin' });
    return 0.32;
  },
  explosion: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.9, gain: 1.2, filter: { type: 'lowpass', f0: 1600 * p, f1: 60, q: 0.6 } });
    s.noise(d, { t0: t, dur: 0.12, gain: 0.8, filter: { type: 'highpass', f0: 1200 } });
    s.tone(d, { type: 'sine', f0: 70 * p, f1: 18, t0: t, dur: 0.7, gain: 1.2 });
    s.tone(d, { type: 'triangle', f0: 180 * p, f1: 40, t0: t, dur: 0.25, gain: 0.5 });
    return 1.0;
  },
  /* world / items */
  crate_open: (s, d, t, p) => {
    s.tone(d, { type: 'sawtooth', f0: 190 * p, f1: 130 * p, t0: t, dur: 0.28, gain: 0.12, lp: 900, vibratoHz: 18, vibratoDepth: 40 });
    s.noise(d, { t0: t, dur: 0.03, gain: 0.25, filter: { type: 'highpass', f0: 2000 } });
    s.tone(d, { type: 'square', f0: 620 * p, f1: 500 * p, t0: t + 0.26, dur: 0.05, gain: 0.1, lp: 2500 });
    return 0.35;
  },
  ui_pickup: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 660 * p, t0: t, dur: 0.07, gain: 0.18 });
    s.tone(d, { type: 'sine', f0: 990 * p, t0: t + 0.06, dur: 0.09, gain: 0.18 });
    return 0.16;
  },
  ui_drop: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 520 * p, f1: 400 * p, t0: t, dur: 0.08, gain: 0.18 });
    s.noise(d, { t0: t, dur: 0.02, gain: 0.12, filter: { type: 'highpass', f0: 2500 } });
    return 0.1;
  },
  ui_rotate: (s, d, t, p) => { s.tone(d, { type: 'triangle', f0: 1250 * p, f1: 1400 * p, t0: t, dur: 0.035, gain: 0.12 }); return 0.04; },
  ui_error: (s, d, t, p) => {
    s.tone(d, { type: 'square', f0: 220 * p, t0: t, dur: 0.1, gain: 0.1, lp: 1800 });
    s.tone(d, { type: 'square', f0: 196 * p, t0: t + 0.12, dur: 0.14, gain: 0.1, lp: 1800 });
    return 0.28;
  },
  ui_equip: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 520 * p, f1: 780 * p, t0: t, dur: 0.12, gain: 0.16 });
    s.noise(d, { t0: t, dur: 0.03, gain: 0.15, filter: { type: 'bandpass', f0: 1800, q: 2 } });
    return 0.14;
  },
  ui_click: (s, d, t, p) => { s.tone(d, { type: 'sine', f0: 1500 * p, f1: 1000 * p, t0: t, dur: 0.025, gain: 0.14 }); return 0.03; },
  ui_open: (s, d, t, p) => { s.tone(d, { type: 'sine', f0: 320 * p, f1: 720 * p, t0: t, dur: 0.14, gain: 0.14 }); return 0.14; },
  ui_close: (s, d, t, p) => { s.tone(d, { type: 'sine', f0: 720 * p, f1: 320 * p, t0: t, dur: 0.14, gain: 0.14 }); return 0.14; },
  /* player */
  stim: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.3, gain: 0.15, attack: 0.02, filter: { type: 'highpass', f0: 2000 * p } });
    s.tone(d, { type: 'sine', f0: 300 * p, f1: 640 * p, t0: t + 0.05, dur: 0.3, gain: 0.14, attack: 0.05 });
    s.tone(d, { type: 'sine', f0: 900 * p, t0: t + 0.3, dur: 0.12, gain: 0.1 });
    return 0.45;
  },
  player_hurt: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.16, gain: 0.45, filter: { type: 'lowpass', f0: 500 * p, f1: 120 } });
    s.tone(d, { type: 'sine', f0: 190 * p, f1: 85, t0: t, dur: 0.18, gain: 0.5 });
    s.tone(d, { type: 'sawtooth', f0: 260 * p, f1: 160, t0: t, dur: 0.08, gain: 0.08, lp: 1200 });
    return 0.2;
  },
  player_death: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 220 * p, f1: 38, t0: t, dur: 1.3, gain: 0.6, attack: 0.02 });
    s.noise(d, { t0: t, dur: 1.1, gain: 0.35, filter: { type: 'lowpass', f0: 1200, f1: 80 } });
    s.tone(d, { type: 'sawtooth', f0: 110 * p, f1: 30, t0: t + 0.1, dur: 1.0, gain: 0.12, lp: 500 });
    return 1.4;
  },
  footstep: (s, d, t, p) => {
    const q = p * r(0.85, 1.15);
    s.noise(d, { t0: t, dur: 0.07, gain: 0.22, filter: { type: 'lowpass', f0: 650 * q, f1: 200, q: 0.7 } });
    s.tone(d, { type: 'sine', f0: 110 * q, f1: 60, t0: t, dur: 0.05, gain: 0.12 });
    return 0.08;
  },
  /** 2026-09-11 — one ladder rung: a short, subtle metallic clank (hand / boot on a steel rung) + a soft body thud. */
  ladder_step: (s, d, t, p) => {
    const q = p * r(0.9, 1.12);
    s.noise(d, { t0: t, dur: 0.025, gain: 0.1, filter: { type: 'bandpass', f0: 2600 * q, q: 3 } });
    s.tone(d, { type: 'triangle', f0: 1180 * q, f1: 1040 * q, t0: t, dur: 0.09, gain: 0.05 });
    s.tone(d, { type: 'sine', f0: 2470 * q, t0: t, dur: 0.06, gain: 0.02 });
    s.tone(d, { type: 'sine', f0: 150 * q, f1: 80, t0: t, dur: 0.05, gain: 0.08 });
    return 0.1;
  },
  /**
   * 2026-09-11 — a window pane shattering (~0.6 s): a bright broadband crack, a short glassy ring, then a tinkling
   * tail of staggered high-passed shard bursts. `world/` plays it when a building window is shot or hit.
   */
  glass_break: (s, d, t, p) => {
    const q = p * r(0.92, 1.08);
    // crack: sharp transient across the top end + a low knock of the frame
    s.noise(d, { t0: t, dur: 0.05, gain: 0.55, filter: { type: 'highpass', f0: 2200 * q, q: 0.7 } });
    s.noise(d, { t0: t, dur: 0.09, gain: 0.3, filter: { type: 'bandpass', f0: 4800 * q, f1: 2600 * q, q: 1.4 } });
    s.tone(d, { type: 'sine', f0: 190 * q, f1: 90, t0: t, dur: 0.06, gain: 0.18 });
    // pane ring: two inharmonic partials decaying fast
    s.tone(d, { type: 'sine', f0: 3150 * q, f1: 2980 * q, t0: t, dur: 0.22, gain: 0.05 });
    s.tone(d, { type: 'sine', f0: 4630 * q, t0: t + 0.005, dur: 0.16, gain: 0.035 });
    // tinkle: shards landing — short high bandpassed bursts at jittered times, getting quieter
    for (let i = 0; i < 9; i++) {
      const at = t + 0.06 + i * 0.055 + r(-0.02, 0.02);
      const g = 0.16 * (1 - i / 10);
      const f = r(5200, 8400) * q;
      s.noise(d, { t0: at, dur: 0.018 + r(0, 0.02), gain: g, filter: { type: 'bandpass', f0: f, q: 6 } });
      if (i % 3 === 0) s.tone(d, { type: 'sine', f0: f * 0.6, t0: at, dur: 0.05, gain: g * 0.18 });
    }
    s.noise(d, { t0: t + 0.04, dur: 0.55, gain: 0.07, attack: 0.02, filter: { type: 'highpass', f0: 6000 * q, q: 0.5 }, decayCurve: 'lin' });
    return 0.62;
  },
  /* bugs */
  bug_screech: (s, d, t, p) => {
    const q = p * r(0.85, 1.2);
    s.tone(d, { type: 'sawtooth', f0: 850 * q, f1: 1500 * q, t0: t, dur: 0.18, gain: 0.16, attack: 0.02, lp: 4000, vibratoHz: 28, vibratoDepth: 90 });
    s.tone(d, { type: 'sawtooth', f0: 1500 * q, f1: 650 * q, t0: t + 0.16, dur: 0.28, gain: 0.16, lp: 3500, vibratoHz: 22, vibratoDepth: 120 });
    s.noise(d, { t0: t, dur: 0.4, gain: 0.08, filter: { type: 'bandpass', f0: 2500 * q, q: 3 } });
    return 0.45;
  },
  bug_attack: (s, d, t, p) => {
    const q = p * r(0.9, 1.1);
    s.tone(d, { type: 'sawtooth', f0: 320 * q, f1: 110 * q, t0: t, dur: 0.22, gain: 0.25, lp: 1800 });
    s.noise(d, { t0: t + 0.03, dur: 0.1, gain: 0.3, filter: { type: 'bandpass', f0: 900 * q, f1: 300, q: 1.2 } });
    return 0.25;
  },
  bug_death: (s, d, t, p) => {
    const q = p * r(0.85, 1.15);
    s.tone(d, { type: 'sawtooth', f0: 720 * q, f1: 140 * q, t0: t, dur: 0.5, gain: 0.2, lp: 2800, vibratoHz: 16, vibratoDepth: 200 });
    s.noise(d, { t0: t + 0.05, dur: 0.35, gain: 0.35, filter: { type: 'lowpass', f0: 500 * q, f1: 120, q: 0.8 } });
    s.tone(d, { type: 'sine', f0: 120 * q, f1: 45, t0: t + 0.1, dur: 0.3, gain: 0.3 });
    return 0.55;
  },
  bug_step: (s, d, t, p) => { s.noise(d, { t0: t, dur: 0.03, gain: 0.1, filter: { type: 'lowpass', f0: 900 * p, q: 0.8 } }); return 0.03; },
  /* extraction / ship */
  extract_activate: (s, d, t, p) => {
    s.tone(d, { type: 'square', f0: 240 * p, f1: 260 * p, t0: t, dur: 0.08, gain: 0.08, lp: 2000 });
    s.tone(d, { type: 'sine', f0: 230 * p, f1: 900 * p, t0: t + 0.1, dur: 0.6, gain: 0.18, attack: 0.05 });
    s.tone(d, { type: 'sine', f0: 880 * p, t0: t + 0.7, dur: 0.12, gain: 0.16 });
    s.tone(d, { type: 'sine', f0: 1320 * p, t0: t + 0.82, dur: 0.25, gain: 0.16 });
    s.noise(d, { t0: t + 0.1, dur: 0.6, gain: 0.05, filter: { type: 'bandpass', f0: 600, f1: 2400, q: 4 } });
    return 1.1;
  },
  countdown_beep: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 1000 * p, t0: t, dur: 0.09, gain: 0.2, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 2000 * p, t0: t, dur: 0.05, gain: 0.05 });
    return 0.1;
  },
  ship_approach: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 4.5, gain: 0.35, attack: 1.4, filter: { type: 'lowpass', f0: 250 * p, f1: 1800 * p, q: 0.7 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 38 * p, f1: 95 * p, t0: t, dur: 4.5, gain: 0.2, attack: 1.2, lp: 400, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 60 * p, f1: 140 * p, t0: t + 0.5, dur: 4.0, gain: 0.18, attack: 1.0, decayCurve: 'lin' });
    return 4.6;
  },
  ship_land: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 55 * p, f1: 22, t0: t, dur: 0.9, gain: 1.1 });
    s.noise(d, { t0: t, dur: 0.7, gain: 0.7, filter: { type: 'lowpass', f0: 900, f1: 90 } });
    s.tone(d, { type: 'square', f0: 180 * p, f1: 120 * p, t0: t + 0.15, dur: 0.3, gain: 0.08, lp: 900 });
    s.noise(d, { t0: t + 0.3, dur: 1.2, gain: 0.12, attack: 0.2, filter: { type: 'highpass', f0: 3000 }, decayCurve: 'lin' });
    return 1.5;
  },
  ship_liftoff: (s, d, t, p) => {
    s.tone(d, { type: 'sawtooth', f0: 34 * p, f1: 120 * p, t0: t, dur: 6.5, gain: 0.35, attack: 1.5, lp: 600, decayCurve: 'lin' });
    s.noise(d, { t0: t, dur: 6.5, gain: 0.5, attack: 2.0, filter: { type: 'lowpass', f0: 300, f1: 3200, q: 0.6 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 48 * p, f1: 160 * p, t0: t + 1.0, dur: 5.5, gain: 0.3, attack: 1.5, decayCurve: 'lin' });
    return 6.6;
  },
  door_close: (s, d, t, p) => {
    s.tone(d, { type: 'sawtooth', f0: 130 * p, f1: 85 * p, t0: t, dur: 1.2, gain: 0.12, attack: 0.1, lp: 700, decayCurve: 'lin' });
    s.noise(d, { t0: t, dur: 1.2, gain: 0.08, attack: 0.1, filter: { type: 'bandpass', f0: 500, q: 2 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 90 * p, f1: 40, t0: t + 1.2, dur: 0.4, gain: 0.6 });
    s.noise(d, { t0: t + 1.2, dur: 0.08, gain: 0.35, filter: { type: 'bandpass', f0: 1800, q: 1.5 } });
    return 1.7;
  },
  hellpod_fall: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 3.2, gain: 0.45, attack: 0.6, filter: { type: 'bandpass', f0: 3200 * p, f1: 500 * p, q: 0.9 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 140 * p, f1: 55 * p, t0: t, dur: 3.2, gain: 0.12, attack: 0.8, lp: 500, decayCurve: 'lin' });
    return 3.3;
  },
  hellpod_impact: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 65 * p, f1: 24, t0: t, dur: 0.7, gain: 1.1 });
    s.noise(d, { t0: t, dur: 0.5, gain: 0.8, filter: { type: 'lowpass', f0: 1400, f1: 100 } });
    s.noise(d, { t0: t + 0.1, dur: 0.9, gain: 0.15, filter: { type: 'bandpass', f0: 2500, f1: 800, q: 1 }, decayCurve: 'lin' });
    s.tone(d, { type: 'square', f0: 220 * p, f1: 140 * p, t0: t + 0.05, dur: 0.2, gain: 0.08, lp: 1000 });
    return 1.0;
  },
  wave_alarm: (s, d, t, p) => {
    for (let i = 0; i < 4; i++) {
      const f = (i % 2 === 0 ? 440 : 554) * p;
      s.tone(d, { type: 'square', f0: f, t0: t + i * 0.16, dur: 0.15, gain: 0.09, lp: 2200, decayCurve: 'lin' });
    }
    return 0.7;
  },
  /* ids emitted by other systems (player / weapons / enemies) */
  player_land: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.12, gain: 0.35, filter: { type: 'lowpass', f0: 700 * p, f1: 150, q: 0.7 } });
    s.tone(d, { type: 'sine', f0: 120 * p, f1: 50, t0: t, dur: 0.14, gain: 0.35 });
    return 0.15;
  },
  player_jump: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.1, gain: 0.15, attack: 0.02, filter: { type: 'bandpass', f0: 500 * p, f1: 900 * p, q: 1 } });
    return 0.1;
  },
  ui_deny: (s, d, t, p) => {
    s.tone(d, { type: 'square', f0: 240 * p, f1: 200 * p, t0: t, dur: 0.09, gain: 0.1, lp: 1600 });
    return 0.1;
  },
  interact: (s, d, t, p) => {
    s.tone(d, { type: 'square', f0: 700 * p, f1: 900 * p, t0: t, dur: 0.05, gain: 0.08, lp: 3000 });
    s.noise(d, { t0: t, dur: 0.02, gain: 0.15, filter: { type: 'highpass', f0: 2500 } });
    return 0.06;
  },
  hellpod_open: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.5, gain: 0.3, attack: 0.05, filter: { type: 'highpass', f0: 1800 * p }, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 90 * p, f1: 60 * p, t0: t, dur: 0.6, gain: 0.12, attack: 0.05, lp: 500, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 80 * p, f1: 40, t0: t + 0.55, dur: 0.3, gain: 0.5 });
    s.noise(d, { t0: t + 0.55, dur: 0.06, gain: 0.3, filter: { type: 'bandpass', f0: 1500, q: 1.5 } });
    return 0.9;
  },
  grenade_bounce: (s, d, t, p) => {
    s.tone(d, { type: 'square', f0: 900 * p, f1: 500 * p, t0: t, dur: 0.05, gain: 0.12, lp: 3000 });
    s.noise(d, { t0: t, dur: 0.04, gain: 0.2, filter: { type: 'bandpass', f0: 2500 * p, q: 1.5 } });
    return 0.06;
  },
  acid_splash: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.35, gain: 0.35, filter: { type: 'bandpass', f0: 1400 * p, f1: 300, q: 0.9 } });
    s.tone(d, { type: 'sine', f0: 400 * p, f1: 90, t0: t, dur: 0.25, gain: 0.2 });
    s.noise(d, { t0: t + 0.05, dur: 0.6, gain: 0.08, filter: { type: 'highpass', f0: 3000 }, decayCurve: 'lin' });
    return 0.65;
  },
  bug_hit: (s, d, t, p) => {
    const q = p * r(0.9, 1.1);
    s.noise(d, { t0: t, dur: 0.07, gain: 0.35, filter: { type: 'lowpass', f0: 800 * q, f1: 200, q: 0.8 } });
    s.tone(d, { type: 'sawtooth', f0: 500 * q, f1: 200 * q, t0: t, dur: 0.06, gain: 0.08, lp: 1500 });
    return 0.08;
  },
  mission_complete: (s, d, t, p) => {
    const notes = [523, 659, 784, 1046];
    notes.forEach((f, i) => s.tone(d, { type: 'sine', f0: f * p, t0: t + i * 0.13, dur: 0.5, gain: 0.14, attack: 0.02 }));
    s.tone(d, { type: 'triangle', f0: 261 * p, t0: t, dur: 1.0, gain: 0.08, attack: 0.1 });
    return 1.1;
  },

  /* ── weapons (SMG / sniper) ─────────────────────────────────────────────── */
  /** Snappy, light report with a very short tail — tuned for ~14 rounds/s. */
  shot_smg: (s, d, t, p) => {
    const q = p * r(0.97, 1.03);
    s.noise(d, { t0: t, dur: 0.055, gain: 0.55, filter: { type: 'bandpass', f0: 2600 * q, f1: 700 * q, q: 0.9 } });
    s.noise(d, { t0: t, dur: 0.018, gain: 0.4, filter: { type: 'highpass', f0: 4500 } });
    s.tone(d, { type: 'sine', f0: 210 * q, f1: 70 * q, t0: t, dur: 0.08, gain: 0.55 });
    s.tone(d, { type: 'square', f0: 1200 * q, f1: 380 * q, t0: t, dur: 0.025, gain: 0.12, lp: 3500 });
    return 0.09;
  },
  /** Heavy crack: sharp transient + low-frequency boom + ~0.8 s reverberant tail. Louder than the rifle. */
  shot_sniper: (s, d, t, p) => {
    // transient crack
    s.noise(d, { t0: t, dur: 0.035, gain: 1.0, filter: { type: 'highpass', f0: 2800 * p } });
    s.noise(d, { t0: t, dur: 0.14, gain: 0.9, filter: { type: 'bandpass', f0: 1500 * p, f1: 280 * p, q: 0.6 } });
    s.tone(d, { type: 'triangle', f0: 1100 * p, f1: 180 * p, t0: t, dur: 0.06, gain: 0.35 });
    // low boom
    s.tone(d, { type: 'sine', f0: 120 * p, f1: 32 * p, t0: t, dur: 0.42, gain: 1.15 });
    s.tone(d, { type: 'sawtooth', f0: 90 * p, f1: 40 * p, t0: t + 0.01, dur: 0.25, gain: 0.18, lp: 400 });
    // reverberant tail (darkens as it decays)
    s.tail(d, t + 0.04, 0.8, 0.28, 2200 * p, 180);
    s.tone(d, { type: 'sine', f0: 60 * p, f1: 30, t0: t + 0.1, dur: 0.7, gain: 0.25, attack: 0.05, decayCurve: 'lin' });
    return 0.9;
  },
  /** Mechanical two-click bolt action (~0.35 s): bolt back (rasp + click), bolt forward (click + lock). */
  bolt_cycle: (s, d, t, p) => {
    // bolt lift + pull back
    s.click(d, t, 2400 * p, 0.32, 0.025);
    s.noise(d, { t0: t + 0.02, dur: 0.1, gain: 0.12, attack: 0.02, filter: { type: 'bandpass', f0: 1400 * p, f1: 900 * p, q: 3 }, decayCurve: 'lin' });
    s.tone(d, { type: 'triangle', f0: 320 * p, f1: 260 * p, t0: t + 0.02, dur: 0.08, gain: 0.08, lp: 1500 });
    // bolt forward + lock
    s.noise(d, { t0: t + 0.19, dur: 0.08, gain: 0.1, attack: 0.02, filter: { type: 'bandpass', f0: 900 * p, f1: 1500 * p, q: 3 }, decayCurve: 'lin' });
    s.click(d, t + 0.27, 3100 * p, 0.38, 0.03);
    s.tone(d, { type: 'sine', f0: 210 * p, f1: 150 * p, t0: t + 0.27, dur: 0.07, gain: 0.2 });
    return 0.36;
  },

  /* ── player movement / stance ──────────────────────────────────────────── */
  /** Cloth whoosh (~0.4 s) — the landing thud is the separate `player_land`. */
  dive: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.4, gain: 0.34, attack: 0.07, filter: { type: 'bandpass', f0: 500 * p, f1: 1500 * p, q: 1.2 }, decayCurve: 'lin' });
    s.noise(d, { t0: t + 0.03, dur: 0.3, gain: 0.12, attack: 0.05, filter: { type: 'highpass', f0: 2500 * p }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 160 * p, f1: 90 * p, t0: t, dur: 0.22, gain: 0.1, attack: 0.04 });
    return 0.42;
  },
  /** Heavy exhale + low chest thump. */
  stamina_depleted: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 95 * p, f1: 42, t0: t, dur: 0.22, gain: 0.45 });
    s.noise(d, { t0: t + 0.02, dur: 0.45, gain: 0.2, attack: 0.06, filter: { type: 'bandpass', f0: 900 * p, f1: 350 * p, q: 0.8 }, decayCurve: 'lin' });
    s.noise(d, { t0: t + 0.02, dur: 0.3, gain: 0.08, attack: 0.04, filter: { type: 'lowpass', f0: 400 * p, f1: 150, q: 0.7 } });
    return 0.5;
  },
  /** Brief cloth / gear rustle; the caller lowers the pitch for prone. */
  stance_change: (s, d, t, p) => {
    const q = p * r(0.95, 1.05);
    s.noise(d, { t0: t, dur: 0.16, gain: 0.2, attack: 0.02, filter: { type: 'bandpass', f0: 1100 * q, f1: 600 * q, q: 1.1 }, decayCurve: 'lin' });
    s.noise(d, { t0: t + 0.05, dur: 0.1, gain: 0.08, filter: { type: 'highpass', f0: 3000 * q } });
    s.click(d, t + 0.09, 1900 * q, 0.06, 0.02);
    s.tone(d, { type: 'sine', f0: 130 * q, f1: 80 * q, t0: t, dur: 0.1, gain: 0.08 });
    return 0.2;
  },

  /* ── UI: ping / map / scope ────────────────────────────────────────────── */
  /** Short two-tone chirp; pitch varies per ping kind (enemy higher / urgent). */
  ping: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 880 * p, t0: t, dur: 0.06, gain: 0.16, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 1320 * p, t0: t + 0.06, dur: 0.1, gain: 0.16 });
    s.tone(d, { type: 'triangle', f0: 2640 * p, t0: t + 0.06, dur: 0.05, gain: 0.03 });
    s.noise(d, { t0: t, dur: 0.015, gain: 0.08, filter: { type: 'highpass', f0: 4000 } });
    return 0.18;
  },
  map_open: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.16, gain: 0.1, attack: 0.03, filter: { type: 'bandpass', f0: 600 * p, f1: 2400 * p, q: 1.5 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 440 * p, f1: 880 * p, t0: t + 0.02, dur: 0.12, gain: 0.1 });
    s.tone(d, { type: 'sine', f0: 1320 * p, t0: t + 0.13, dur: 0.05, gain: 0.07 });
    return 0.2;
  },
  map_close: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.14, gain: 0.1, attack: 0.02, filter: { type: 'bandpass', f0: 2400 * p, f1: 500 * p, q: 1.5 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 880 * p, f1: 440 * p, t0: t, dur: 0.12, gain: 0.1 });
    s.tone(d, { type: 'sine', f0: 1600 * p, f1: 1100 * p, t0: t + 0.1, dur: 0.03, gain: 0.08 });
    return 0.16;
  },
  /** Soft lens/servo tick when the scope comes up. */
  scope_in: (s, d, t, p) => {
    s.tone(d, { type: 'sawtooth', f0: 600 * p, f1: 1400 * p, t0: t, dur: 0.11, gain: 0.05, attack: 0.02, lp: 2200, decayCurve: 'lin' });
    s.click(d, t + 0.1, 2800 * p, 0.12, 0.02);
    s.tone(d, { type: 'sine', f0: 1900 * p, t0: t + 0.1, dur: 0.05, gain: 0.05 });
    return 0.16;
  },
  /** Reverse servo + duller tick when the scope drops. */
  scope_out: (s, d, t, p) => {
    s.tone(d, { type: 'sawtooth', f0: 1400 * p, f1: 600 * p, t0: t, dur: 0.1, gain: 0.05, attack: 0.02, lp: 2200, decayCurve: 'lin' });
    s.click(d, t + 0.08, 1800 * p, 0.1, 0.02);
    return 0.14;
  },

  /* ── ship hub ─────────────────────────────────────────────────────────── */
  /** Docking thruster swell (~2.6 s): filtered noise opening up + low saw/sine rumble, dies back down. */
  hub_dock_thrusters: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 2.6, gain: 0.32, attack: 0.9, filter: { type: 'lowpass', f0: 200 * p, f1: 1400 * p, q: 0.8 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 40 * p, f1: 70 * p, t0: t, dur: 2.6, gain: 0.16, attack: 0.8, lp: 350, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 58 * p, f1: 90 * p, t0: t + 0.3, dur: 2.2, gain: 0.14, attack: 0.7, decayCurve: 'lin' });
    s.noise(d, { t0: t + 0.4, dur: 1.8, gain: 0.06, attack: 0.5, filter: { type: 'highpass', f0: 2500 }, decayCurve: 'lin' });
    return 2.7;
  },
  /** Metallic docking-clamp thunk: low impact + ringing plate + two small rattles. */
  hub_dock_clamp: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 80 * p, f1: 32, t0: t, dur: 0.5, gain: 0.8 });
    s.noise(d, { t0: t, dur: 0.12, gain: 0.5, filter: { type: 'lowpass', f0: 1200, f1: 150 } });
    s.click(d, t, 2100 * p, 0.35, 0.03);
    s.tone(d, { type: 'triangle', f0: 620 * p, f1: 590 * p, t0: t + 0.01, dur: 0.55, gain: 0.07, lp: 2500, vibratoHz: 6, vibratoDepth: 12 });
    s.tone(d, { type: 'sine', f0: 1480 * p, f1: 1420 * p, t0: t + 0.01, dur: 0.4, gain: 0.04 });
    s.click(d, t + 0.14, 1500 * p, 0.12, 0.02);
    s.click(d, t + 0.21, 1800 * p, 0.08, 0.02);
    return 0.7;
  },
  /** Launch pod door: pneumatic hiss (~0.4 s) then a lock clunk. */
  pod_door: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.45, gain: 0.22, attack: 0.04, filter: { type: 'bandpass', f0: 2200 * p, f1: 900 * p, q: 0.9 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 110 * p, f1: 70 * p, t0: t, dur: 0.45, gain: 0.06, attack: 0.05, lp: 500, decayCurve: 'lin' });
    s.click(d, t + 0.42, 2400 * p, 0.3, 0.03);
    s.tone(d, { type: 'sine', f0: 140 * p, f1: 70, t0: t + 0.42, dur: 0.18, gain: 0.35 });
    return 0.65;
  },
  /** Launch rumble at countdown 0: sub thump + rising roar (~2.4 s). */
  launch_rumble: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 60 * p, f1: 24, t0: t, dur: 0.6, gain: 0.9 });
    s.noise(d, { t0: t, dur: 2.4, gain: 0.45, attack: 0.3, filter: { type: 'lowpass', f0: 300 * p, f1: 2200 * p, q: 0.6 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 36 * p, f1: 110 * p, t0: t, dur: 2.4, gain: 0.25, attack: 0.4, lp: 500, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 50 * p, f1: 130 * p, t0: t + 0.3, dur: 2.0, gain: 0.2, attack: 0.5, decayCurve: 'lin' });
    return 2.5;
  },

  /* ── chat ─────────────────────────────────────────────────────────────── */
  /** Soft two-note blip for an incoming text line. */
  chat_blip: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 1180 * p, f1: 1250 * p, t0: t, dur: 0.05, gain: 0.1, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 1570 * p, t0: t + 0.055, dur: 0.09, gain: 0.09 });
    return 0.15;
  },
  /** Radio-style request: two short tones then a held higher note, faint static underneath. */
  chat_request: (s, d, t, p) => {
    s.tone(d, { type: 'triangle', f0: 740 * p, t0: t, dur: 0.07, gain: 0.09, lp: 3000, decayCurve: 'lin' });
    s.tone(d, { type: 'triangle', f0: 740 * p, t0: t + 0.09, dur: 0.07, gain: 0.09, lp: 3000, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 988 * p, t0: t + 0.19, dur: 0.16, gain: 0.1 });
    s.noise(d, { t0: t, dur: 0.3, gain: 0.02, filter: { type: 'bandpass', f0: 2500, q: 3 }, decayCurve: 'lin' });
    return 0.36;
  },
  /** Subtle tick when the chat input opens (rising) / closes (falling). */
  chat_open: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 900 * p, f1: 1300 * p, t0: t, dur: 0.035, gain: 0.08 });
    s.noise(d, { t0: t, dur: 0.012, gain: 0.05, filter: { type: 'highpass', f0: 4000 } });
    return 0.05;
  },
  chat_close: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 1300 * p, f1: 900 * p, t0: t, dur: 0.035, gain: 0.07 });
    s.noise(d, { t0: t, dur: 0.01, gain: 0.04, filter: { type: 'highpass', f0: 4000 } });
    return 0.05;
  },

  /* ── pings v2 ─────────────────────────────────────────────────────────── */
  /** Attack ping: urgent two-tone rising figure, played twice. */
  ping_attack: (s, d, t, p) => {
    for (let i = 0; i < 2; i++) {
      const o = i * 0.16;
      s.tone(d, { type: 'square', f0: 660 * p, f1: 990 * p, t0: t + o, dur: 0.07, gain: 0.07, lp: 3500, decayCurve: 'lin' });
      s.tone(d, { type: 'sine', f0: 1320 * p, t0: t + o + 0.07, dur: 0.08, gain: 0.14 });
    }
    s.noise(d, { t0: t, dur: 0.015, gain: 0.08, filter: { type: 'highpass', f0: 4000 } });
    return 0.34;
  },
  /** Caution ping: descending warning tone with a low square undertone. */
  ping_caution: (s, d, t, p) => {
    s.tone(d, { type: 'triangle', f0: 880 * p, f1: 440 * p, t0: t, dur: 0.22, gain: 0.14, attack: 0.01, lp: 3000, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 440 * p, f1: 330 * p, t0: t + 0.2, dur: 0.18, gain: 0.12 });
    s.tone(d, { type: 'square', f0: 220 * p, t0: t + 0.2, dur: 0.15, gain: 0.03, lp: 1500 });
    return 0.4;
  },
  /** Item ping: light glassy bell (stacked high sines). */
  ping_item: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 1760 * p, t0: t, dur: 0.16, gain: 0.1 });
    s.tone(d, { type: 'sine', f0: 2640 * p, t0: t + 0.03, dur: 0.22, gain: 0.06 });
    s.tone(d, { type: 'triangle', f0: 3520 * p, t0: t, dur: 0.06, gain: 0.03 });
    s.tone(d, { type: 'sine', f0: 2217 * p, t0: t + 0.09, dur: 0.2, gain: 0.07 });
    return 0.32;
  },

  /* ── drop / pickups ───────────────────────────────────────────────────── */
  /** Short toss whoosh when an item is dropped. */
  item_toss: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.26, gain: 0.22, attack: 0.03, filter: { type: 'bandpass', f0: 700 * p, f1: 1800 * p, q: 1.3 }, decayCurve: 'lin' });
    s.noise(d, { t0: t, dur: 0.15, gain: 0.08, attack: 0.02, filter: { type: 'highpass', f0: 3000 } });
    return 0.28;
  },
  /** Soft landing tick for a pickup appearing in the world. */
  pickup_land: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.05, gain: 0.2, filter: { type: 'lowpass', f0: 1200 * p, f1: 300, q: 0.8 } });
    s.click(d, t, 1600 * p, 0.08, 0.02);
    s.tone(d, { type: 'sine', f0: 200 * p, f1: 110, t0: t, dur: 0.06, gain: 0.12 });
    return 0.08;
  },
  /** Three-note pickup chime (G5 D6 G6). */
  pickup_chime: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 784 * p, t0: t, dur: 0.08, gain: 0.14 });
    s.tone(d, { type: 'sine', f0: 1175 * p, t0: t + 0.06, dur: 0.1, gain: 0.14 });
    s.tone(d, { type: 'sine', f0: 1568 * p, t0: t + 0.12, dur: 0.18, gain: 0.12 });
    s.noise(d, { t0: t, dur: 0.02, gain: 0.06, filter: { type: 'highpass', f0: 3500 } });
    return 0.32;
  },
  /** Alias played by `pickups/` via `audio:play {id:'pickup'}` on a local take — same synth as `pickup_chime`. */
  pickup: (s, d, t, p) => SOUNDS.pickup_chime(s, d, t, p),

  /* ── net / reconnection ───────────────────────────────────────────────── */
  /** Single low warning tone (connection dropped). */
  net_warning: (s, d, t, p) => {
    s.tone(d, { type: 'square', f0: 196 * p, f1: 185 * p, t0: t, dur: 0.35, gain: 0.08, attack: 0.02, lp: 1200, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 98 * p, t0: t, dur: 0.4, gain: 0.14, attack: 0.02 });
    s.noise(d, { t0: t, dur: 0.4, gain: 0.03, filter: { type: 'bandpass', f0: 1800, q: 2 }, decayCurve: 'lin' });
    return 0.45;
  },
  /** Confirmation chime (session resumed). */
  net_resumed: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 587 * p, t0: t, dur: 0.1, gain: 0.13 });
    s.tone(d, { type: 'sine', f0: 880 * p, t0: t + 0.09, dur: 0.25, gain: 0.13 });
    s.tone(d, { type: 'triangle', f0: 1760 * p, t0: t + 0.09, dur: 0.12, gain: 0.03 });
    return 0.36;
  },
  /** Radio "signal acquired": static burst → three rising blips → held note. */
  net_matched: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.2, gain: 0.08, attack: 0.01, filter: { type: 'bandpass', f0: 1800 * p, f1: 3000 * p, q: 1.5 }, decayCurve: 'lin' });
    const notes = [880, 1109, 1480];
    notes.forEach((f, i) => s.tone(d, { type: 'square', f0: f * p, t0: t + 0.18 + i * 0.09, dur: 0.07, gain: 0.05, lp: 4000, decayCurve: 'lin' }));
    s.tone(d, { type: 'sine', f0: 1480 * p, t0: t + 0.45, dur: 0.22, gain: 0.1 });
    return 0.7;
  },

  /* ══ tactical kit ═════════════════════════════════════════════════════════ */

  /* ── melee / movement ─────────────────────────────────────────────────── */
  /** Weapon swing: air whoosh rising then cut. */
  melee_swing: (s, d, t, p) => {
    const q = p * r(0.95, 1.06);
    s.noise(d, { t0: t, dur: 0.22, gain: 0.3, attack: 0.05, filter: { type: 'bandpass', f0: 420 * q, f1: 2200 * q, q: 1.4 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 150 * q, f1: 320 * q, t0: t, dur: 0.16, gain: 0.08, attack: 0.04 });
    return 0.24;
  },
  /** Stock/blade impact: dull thud + bone crack + short metallic ring. */
  melee_hit: (s, d, t, p) => {
    const q = p * r(0.92, 1.08);
    s.tone(d, { type: 'sine', f0: 150 * q, f1: 48, t0: t, dur: 0.2, gain: 0.85 });
    s.noise(d, { t0: t, dur: 0.11, gain: 0.6, filter: { type: 'lowpass', f0: 900 * q, f1: 180, q: 0.8 } });
    s.click(d, t + 0.01, 1900 * q, 0.18, 0.03);
    s.tone(d, { type: 'triangle', f0: 420 * q, f1: 250 * q, t0: t + 0.02, dur: 0.12, gain: 0.1, lp: 2200 });
    return 0.24;
  },
  /** Combat roll: cloth tumble with two ground contacts. */
  roll: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.45, gain: 0.3, attack: 0.05, filter: { type: 'bandpass', f0: 620 * p, f1: 900 * p, q: 1.1 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 120 * p, f1: 55, t0: t + 0.05, dur: 0.1, gain: 0.35 });
    s.tone(d, { type: 'sine', f0: 105 * p, f1: 48, t0: t + 0.26, dur: 0.12, gain: 0.28 });
    s.noise(d, { t0: t + 0.26, dur: 0.1, gain: 0.16, filter: { type: 'lowpass', f0: 700 * p, f1: 200, q: 0.7 } });
    return 0.5;
  },
  /** Jump pad: springy launch (fast rising sine + air pop). */
  jumppad: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 180 * p, f1: 1200 * p, t0: t, dur: 0.22, gain: 0.3 });
    s.tone(d, { type: 'triangle', f0: 90 * p, f1: 620 * p, t0: t, dur: 0.28, gain: 0.16, lp: 2600 });
    s.noise(d, { t0: t, dur: 0.18, gain: 0.25, attack: 0.02, filter: { type: 'bandpass', f0: 900 * p, f1: 2600 * p, q: 1.2 }, decayCurve: 'lin' });
    return 0.32;
  },

  /* ── implants: grapple / dash / barrier / overcharge / scan / AT ───────── */
  /** Grapple launch: pneumatic thump + wire zip. */
  grapple_fire: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.06, gain: 0.5, filter: { type: 'bandpass', f0: 1600 * p, f1: 600 * p, q: 0.9 } });
    s.tone(d, { type: 'square', f0: 320 * p, f1: 140 * p, t0: t, dur: 0.07, gain: 0.12, lp: 2200 });
    s.noise(d, { t0: t + 0.03, dur: 0.35, gain: 0.16, attack: 0.03, filter: { type: 'bandpass', f0: 2600 * p, f1: 900 * p, q: 4 }, decayCurve: 'lin' });
    return 0.4;
  },
  /** Grapple anchor: metallic clank + latch + short ring. */
  grapple_attach: (s, d, t, p) => {
    s.click(d, t, 2600 * p, 0.4, 0.035);
    s.tone(d, { type: 'sine', f0: 190 * p, f1: 80, t0: t, dur: 0.16, gain: 0.4 });
    s.tone(d, { type: 'triangle', f0: 1450 * p, f1: 1380 * p, t0: t + 0.01, dur: 0.3, gain: 0.06 });
    s.click(d, t + 0.09, 1700 * p, 0.14, 0.02);
    return 0.34;
  },
  /** Wire retract: servo whir that falls away. */
  grapple_release: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.26, gain: 0.14, attack: 0.02, filter: { type: 'bandpass', f0: 2200 * p, f1: 700 * p, q: 3 }, decayCurve: 'lin' });
    s.click(d, t + 0.24, 1500 * p, 0.14, 0.02);
    return 0.3;
  },
  /** Blink dash: electric zap + air displacement. */
  dash: (s, d, t, p) => {
    s.tone(d, { type: 'sawtooth', f0: 260 * p, f1: 1500 * p, t0: t, dur: 0.14, gain: 0.16, lp: 4000 });
    s.noise(d, { t0: t, dur: 0.2, gain: 0.32, attack: 0.01, filter: { type: 'highpass', f0: 1400 * p }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 900 * p, f1: 200 * p, t0: t + 0.04, dur: 0.16, gain: 0.14 });
    return 0.24;
  },
  /** Barrier unfolds: mechanical clack then an energy field settling in. */
  barrier_deploy: (s, d, t, p) => {
    s.click(d, t, 1500 * p, 0.3, 0.04);
    s.tone(d, { type: 'sawtooth', f0: 120 * p, f1: 300 * p, t0: t + 0.03, dur: 0.5, gain: 0.12, attack: 0.06, lp: 1400, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 420 * p, f1: 660 * p, t0: t + 0.05, dur: 0.45, gain: 0.12, attack: 0.08 });
    s.noise(d, { t0: t + 0.05, dur: 0.5, gain: 0.06, attack: 0.1, filter: { type: 'bandpass', f0: 2200, q: 3 }, decayCurve: 'lin' });
    return 0.6;
  },
  /** Round stopped by the shield: bright energy ping + splash. */
  barrier_hit: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 1500 * p, f1: 900 * p, t0: t, dur: 0.12, gain: 0.16 });
    s.tone(d, { type: 'triangle', f0: 2400 * p, t0: t, dur: 0.07, gain: 0.06 });
    s.noise(d, { t0: t, dur: 0.09, gain: 0.2, filter: { type: 'bandpass', f0: 3200 * p, f1: 1200, q: 1.4 } });
    return 0.14;
  },
  /** Shield collapses: descending shatter. */
  barrier_break: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.5, gain: 0.4, filter: { type: 'bandpass', f0: 3400 * p, f1: 500, q: 0.8 } });
    s.tone(d, { type: 'sawtooth', f0: 700 * p, f1: 90 * p, t0: t, dur: 0.42, gain: 0.16, lp: 2600 });
    s.tone(d, { type: 'sine', f0: 200 * p, f1: 55, t0: t, dur: 0.5, gain: 0.4 });
    for (let i = 0; i < 3; i++) s.click(d, t + 0.08 + i * 0.07, (2600 - i * 500) * p, 0.1, 0.02);
    return 0.6;
  },
  /** Overcharge beam: shimmering sustained tone with tremolo. */
  overcharge_beam: (s, d, t, p) => {
    s.tone(d, { type: 'sawtooth', f0: 330 * p, f1: 392 * p, t0: t, dur: 0.9, gain: 0.08, attack: 0.12, lp: 2400, decayCurve: 'lin', vibratoHz: 11, vibratoDepth: 25 });
    s.tone(d, { type: 'sine', f0: 660 * p, t0: t + 0.05, dur: 0.85, gain: 0.08, attack: 0.15, decayCurve: 'lin', vibratoHz: 7, vibratoDepth: 18 });
    s.tone(d, { type: 'sine', f0: 1320 * p, t0: t + 0.1, dur: 0.7, gain: 0.03, attack: 0.2, decayCurve: 'lin' });
    return 1.0;
  },
  /**
   * Recon sonar: sharp ping with a long ringing decay + expanding noise wash.
   * 2026-09-11: longer and roomier (≈1.5 s) because 로든's scan drone uses the same id as a **warning** — two fading
   * echoes of the ping, a low descending undertone under it and a faint reverberant tail. The implant / rooftop scan
   * keep the same head, so they still read as the same sonar.
   */
  scan_pulse: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 1400 * p, f1: 900 * p, t0: t, dur: 0.7, gain: 0.16 });
    s.tone(d, { type: 'sine', f0: 2100 * p, t0: t, dur: 0.25, gain: 0.05 });
    s.noise(d, { t0: t + 0.02, dur: 0.6, gain: 0.06, attack: 0.05, filter: { type: 'bandpass', f0: 900 * p, f1: 3600 * p, q: 2.5 }, decayCurve: 'lin' });
    // warning undertone
    s.tone(d, { type: 'triangle', f0: 330 * p, f1: 220 * p, t0: t, dur: 0.95, gain: 0.06, attack: 0.02, lp: 1400 });
    // echoes (the room answers)
    s.tone(d, { type: 'sine', f0: 1400 * p, f1: 900 * p, t0: t + 0.34, dur: 0.6, gain: 0.06 });
    s.tone(d, { type: 'sine', f0: 1400 * p, f1: 900 * p, t0: t + 0.68, dur: 0.6, gain: 0.025 });
    s.tail(d, t + 0.05, 1.35, 0.035, 3000 * p, 400);
    return 1.45;
  },
  /** Anti-tank launch: heavy back-blast whoosh. */
  rocket_fire: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.6, gain: 0.7, filter: { type: 'lowpass', f0: 2600 * p, f1: 400, q: 0.7 } });
    s.tone(d, { type: 'sawtooth', f0: 150 * p, f1: 42 * p, t0: t, dur: 0.5, gain: 0.35, lp: 900 });
    s.noise(d, { t0: t + 0.05, dur: 0.9, gain: 0.16, attack: 0.1, filter: { type: 'bandpass', f0: 1800, f1: 500, q: 0.9 }, decayCurve: 'lin' });
    return 0.95;
  },
  /** Anti-tank detonation: bigger and longer than the grenade blast. */
  rocket_explode: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 1.4, gain: 1.3, filter: { type: 'lowpass', f0: 1800 * p, f1: 45, q: 0.6 } });
    s.noise(d, { t0: t, dur: 0.16, gain: 0.9, filter: { type: 'highpass', f0: 1400 } });
    s.tone(d, { type: 'sine', f0: 58 * p, f1: 15, t0: t, dur: 1.1, gain: 1.3 });
    s.tone(d, { type: 'triangle', f0: 160 * p, f1: 32, t0: t, dur: 0.35, gain: 0.5 });
    s.tail(d, t + 0.1, 1.2, 0.3, 1600 * p, 120);
    return 1.6;
  },

  /* ── gadgets ──────────────────────────────────────────────────────────── */
  /** Something bolted to the ground (turret, barricade, jump pad). */
  gadget_place: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 130 * p, f1: 55, t0: t, dur: 0.24, gain: 0.5 });
    s.noise(d, { t0: t, dur: 0.12, gain: 0.3, filter: { type: 'lowpass', f0: 1400 * p, f1: 260, q: 0.8 } });
    s.click(d, t + 0.1, 1700 * p, 0.2, 0.03);
    s.tone(d, { type: 'sawtooth', f0: 220 * p, f1: 150 * p, t0: t + 0.12, dur: 0.22, gain: 0.06, lp: 1200 });
    return 0.4;
  },
  /** Dome shield unfolding: airy swell into a steady field. */
  dome_deploy: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.7, gain: 0.22, attack: 0.12, filter: { type: 'bandpass', f0: 500 * p, f1: 2600 * p, q: 1 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 220 * p, f1: 440 * p, t0: t, dur: 0.75, gain: 0.16, attack: 0.16 });
    s.tone(d, { type: 'triangle', f0: 660 * p, t0: t + 0.25, dur: 0.5, gain: 0.05, attack: 0.15 });
    return 0.85;
  },
  /** Smoke canister: long pressurised hiss. */
  smoke_hiss: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 1.6, gain: 0.3, attack: 0.06, filter: { type: 'bandpass', f0: 3000 * p, f1: 1400 * p, q: 0.7 }, decayCurve: 'lin' });
    s.noise(d, { t0: t, dur: 0.12, gain: 0.3, filter: { type: 'highpass', f0: 2200 } });
    return 1.7;
  },
  /** Lure beacon: three insistent beeps. */
  lure_beep: (s, d, t, p) => {
    for (let i = 0; i < 3; i++) {
      s.tone(d, { type: 'square', f0: 720 * p, t0: t + i * 0.2, dur: 0.09, gain: 0.09, lp: 2600, decayCurve: 'lin' });
      s.tone(d, { type: 'sine', f0: 1440 * p, t0: t + i * 0.2, dur: 0.06, gain: 0.04 });
    }
    return 0.6;
  },
  /** Mine arming: two rising beeps then a lock click. */
  mine_arm: (s, d, t, p) => {
    s.tone(d, { type: 'square', f0: 880 * p, t0: t, dur: 0.06, gain: 0.07, lp: 3000, decayCurve: 'lin' });
    s.tone(d, { type: 'square', f0: 1174 * p, t0: t + 0.18, dur: 0.06, gain: 0.07, lp: 3000, decayCurve: 'lin' });
    s.click(d, t + 0.36, 2400 * p, 0.2, 0.03);
    return 0.45;
  },
  /** Mine blast: sharper and tighter than a grenade. */
  mine_explode: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.08, gain: 1.0, filter: { type: 'highpass', f0: 1800 } });
    s.noise(d, { t0: t, dur: 0.7, gain: 1.1, filter: { type: 'lowpass', f0: 2400 * p, f1: 70, q: 0.6 } });
    s.tone(d, { type: 'sine', f0: 90 * p, f1: 22, t0: t, dur: 0.55, gain: 1.1 });
    s.tone(d, { type: 'triangle', f0: 260 * p, f1: 60, t0: t, dur: 0.18, gain: 0.4 });
    return 0.8;
  },
  /** Incendiary ignition: fuel whoomph + crackle. */
  fire_ignite: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.5, gain: 0.5, attack: 0.03, filter: { type: 'lowpass', f0: 1800 * p, f1: 400, q: 0.7 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 120 * p, f1: 60, t0: t, dur: 0.35, gain: 0.4 });
    for (let i = 0; i < 6; i++) {
      s.noise(d, { t0: t + 0.15 + i * 0.11 + r(0, 0.05), dur: 0.05, gain: 0.1, filter: { type: 'bandpass', f0: r(1400, 3600), q: 3 } });
    }
    return 0.9;
  },
  /** Turret burst: compact servo-driven shot. */
  turret_shot: (s, d, t, p) => {
    const q = p * r(0.97, 1.04);
    s.noise(d, { t0: t, dur: 0.05, gain: 0.45, filter: { type: 'bandpass', f0: 2200 * q, f1: 800 * q, q: 1 } });
    s.tone(d, { type: 'square', f0: 900 * q, f1: 300 * q, t0: t, dur: 0.03, gain: 0.1, lp: 3000 });
    s.tone(d, { type: 'sine', f0: 180 * q, f1: 70, t0: t, dur: 0.07, gain: 0.4 });
    return 0.08;
  },
  /** Deployable destroyed: metal crunch with debris. */
  gadget_break: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.35, gain: 0.45, filter: { type: 'bandpass', f0: 1400 * p, f1: 300, q: 0.7 } });
    s.tone(d, { type: 'sine', f0: 140 * p, f1: 42, t0: t, dur: 0.35, gain: 0.5 });
    for (let i = 0; i < 4; i++) s.click(d, t + 0.1 + i * 0.06 + r(0, 0.03), r(900, 2400) * p, 0.1, 0.02);
    return 0.45;
  },
  /** Defibrillator: capacitor whine then the discharge thump. */
  defib: (s, d, t, p) => {
    s.tone(d, { type: 'sawtooth', f0: 500 * p, f1: 1800 * p, t0: t, dur: 0.55, gain: 0.05, attack: 0.2, lp: 3000, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 90 * p, f1: 40, t0: t + 0.58, dur: 0.3, gain: 0.9 });
    s.noise(d, { t0: t + 0.58, dur: 0.12, gain: 0.5, filter: { type: 'bandpass', f0: 1800, f1: 500, q: 0.9 } });
    s.tone(d, { type: 'square', f0: 1600 * p, t0: t + 0.58, dur: 0.04, gain: 0.06, lp: 4000 });
    return 0.95;
  },

  /* ── survival: downed / revive / grit / cloak ─────────────────────────── */
  /** Going down: falling groan under a slow heartbeat. */
  downed: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 180 * p, f1: 42, t0: t, dur: 1.0, gain: 0.5, attack: 0.03 });
    s.noise(d, { t0: t, dur: 0.8, gain: 0.25, filter: { type: 'lowpass', f0: 700, f1: 90 } });
    s.tone(d, { type: 'sine', f0: 58, t0: t + 0.5, dur: 0.16, gain: 0.6 });
    s.tone(d, { type: 'sine', f0: 52, t0: t + 0.78, dur: 0.2, gain: 0.45 });
    return 1.1;
  },
  /** Back on your feet: warm rising chord. */
  revive: (s, d, t, p) => {
    const notes = [392, 523, 659, 784];
    notes.forEach((f, i) => s.tone(d, { type: 'sine', f0: f * p, t0: t + i * 0.07, dur: 0.5, gain: 0.12, attack: 0.03 }));
    s.noise(d, { t0: t, dur: 0.3, gain: 0.1, attack: 0.05, filter: { type: 'highpass', f0: 2400 }, decayCurve: 'lin' });
    return 0.8;
  },
  /** 인내 save: heartbeat thump + defiant rising tone. */
  grit_save: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 62, t0: t, dur: 0.2, gain: 0.8 });
    s.tone(d, { type: 'sine', f0: 56, t0: t + 0.24, dur: 0.22, gain: 0.6 });
    s.tone(d, { type: 'triangle', f0: 300 * p, f1: 520 * p, t0: t + 0.05, dur: 0.5, gain: 0.12, attack: 0.06, lp: 2600 });
    return 0.6;
  },
  /** Cloak engages: phasing shimmer down. */
  cloak_on: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 1600 * p, f1: 420 * p, t0: t, dur: 0.5, gain: 0.1, vibratoHz: 14, vibratoDepth: 60 });
    s.noise(d, { t0: t, dur: 0.45, gain: 0.1, attack: 0.04, filter: { type: 'bandpass', f0: 3200 * p, f1: 900 * p, q: 2.5 }, decayCurve: 'lin' });
    return 0.55;
  },
  /** Cloak drops: reverse shimmer with a click. */
  cloak_off: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 420 * p, f1: 1500 * p, t0: t, dur: 0.32, gain: 0.09, vibratoHz: 14, vibratoDepth: 60 });
    s.click(d, t + 0.3, 2600 * p, 0.12, 0.02);
    return 0.38;
  },

  /* ── gathering / crafting / gear upkeep / progression ──────────────────── */
  /** Herb harvest: leafy rustle + soft snap. */
  gather: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.3, gain: 0.22, attack: 0.03, filter: { type: 'bandpass', f0: 2600 * p, f1: 1400 * p, q: 1.4 }, decayCurve: 'lin' });
    s.click(d, t + 0.18, 1200 * p, 0.12, 0.025);
    s.tone(d, { type: 'sine', f0: 660 * p, t0: t + 0.24, dur: 0.1, gain: 0.08 });
    return 0.38;
  },
  /** Field crafting loop tick (played once per craft start). */
  craft_start: (s, d, t, p) => {
    for (let i = 0; i < 3; i++) s.click(d, t + i * 0.14, 1500 * p, 0.12, 0.025);
    s.tone(d, { type: 'sawtooth', f0: 180 * p, f1: 210 * p, t0: t, dur: 0.42, gain: 0.05, attack: 0.05, lp: 1200, decayCurve: 'lin' });
    return 0.45;
  },
  /** Craft finished: two-note confirm with a workbench clink. */
  craft_done: (s, d, t, p) => {
    s.click(d, t, 2200 * p, 0.16, 0.03);
    s.tone(d, { type: 'sine', f0: 784 * p, t0: t + 0.02, dur: 0.1, gain: 0.14 });
    s.tone(d, { type: 'sine', f0: 1046 * p, t0: t + 0.11, dur: 0.22, gain: 0.14 });
    return 0.36;
  },
  /** Repair complete: wrench clink + rising confirm. */
  repair_done: (s, d, t, p) => {
    s.click(d, t, 1800 * p, 0.2, 0.03);
    s.click(d, t + 0.09, 2400 * p, 0.16, 0.025);
    s.tone(d, { type: 'sine', f0: 587 * p, f1: 880 * p, t0: t + 0.14, dur: 0.24, gain: 0.13 });
    return 0.4;
  },
  /** Gear broke: metal snap then rattling debris. */
  durability_break: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.06, gain: 0.5, filter: { type: 'highpass', f0: 2600 } });
    s.tone(d, { type: 'square', f0: 620 * p, f1: 150 * p, t0: t, dur: 0.12, gain: 0.12, lp: 2400 });
    s.tone(d, { type: 'sine', f0: 160 * p, f1: 55, t0: t, dur: 0.3, gain: 0.4 });
    for (let i = 0; i < 3; i++) s.click(d, t + 0.12 + i * 0.08 + r(0, 0.04), r(800, 2000) * p, 0.09, 0.02);
    return 0.45;
  },
  /** Level up: rising fanfare with a shimmering tail. */
  level_up: (s, d, t, p) => {
    const notes = [523, 659, 784, 1046, 1318];
    notes.forEach((f, i) => s.tone(d, { type: 'sine', f0: f * p, t0: t + i * 0.1, dur: 0.55, gain: 0.13, attack: 0.02 }));
    s.tone(d, { type: 'triangle', f0: 261 * p, t0: t, dur: 1.1, gain: 0.07, attack: 0.08 });
    s.noise(d, { t0: t + 0.4, dur: 0.7, gain: 0.05, attack: 0.15, filter: { type: 'highpass', f0: 4000 }, decayCurve: 'lin' });
    return 1.3;
  },
  /** Skill tick up: quiet two-note chime. */
  skill_up: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 1046 * p, t0: t, dur: 0.07, gain: 0.09 });
    s.tone(d, { type: 'sine', f0: 1568 * p, t0: t + 0.07, dur: 0.16, gain: 0.08 });
    return 0.25;
  },

  /* ── appended (2026-09-09): 레이드 플레이 개선 — 의사소통 · 구조물 · 전차 · 재해 · 로그 강하 ────────── */

  /** 의사소통 휠이 열린다: 아주 짧고 부드러운 틱. */
  comms_wheel: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 880 * p, f1: 1180 * p, t0: t, dur: 0.06, gain: 0.05 });
    return 0.08;
  },
  /** 한 마디를 보냈다: 무전 클릭 + 상승 블립 (분대 전원이 듣는다). */
  comms_send: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.035, gain: 0.14, filter: { type: 'bandpass', f0: 2400 * p, q: 3 } });
    s.tone(d, { type: 'square', f0: 660 * p, f1: 990 * p, t0: t + 0.03, dur: 0.09, gain: 0.07, lp: 2600 });
    s.noise(d, { t0: t + 0.13, dur: 0.03, gain: 0.08, filter: { type: 'bandpass', f0: 1800 * p, q: 3 } });
    return 0.2;
  },
  /** 키카드 인식 → 잠금 해제: 삑 두 번 + 빗장이 빠지는 둔탁한 클렁크. */
  keycard_use: (s, d, t, p) => {
    s.tone(d, { type: 'square', f0: 1320 * p, t0: t, dur: 0.05, gain: 0.07, lp: 3000 });
    s.tone(d, { type: 'square', f0: 1760 * p, t0: t + 0.08, dur: 0.06, gain: 0.07, lp: 3000 });
    s.tone(d, { type: 'sine', f0: 150 * p, f1: 60 * p, t0: t + 0.22, dur: 0.22, gain: 0.3 });
    s.noise(d, { t0: t + 0.22, dur: 0.16, gain: 0.2, filter: { type: 'lowpass', f0: 900 * p, f1: 200, q: 0.8 } });
    return 0.5;
  },
  /** 키카드가 없다: 낮은 거부 버저 두 번. */
  keycard_deny: (s, d, t, p) => {
    s.tone(d, { type: 'square', f0: 220 * p, t0: t, dur: 0.09, gain: 0.09, lp: 1200, decayCurve: 'lin' });
    s.tone(d, { type: 'square', f0: 185 * p, t0: t + 0.13, dur: 0.12, gain: 0.09, lp: 1200, decayCurve: 'lin' });
    return 0.3;
  },
  /** 전차 시동: 릴레이가 딸깍 물리고 모터가 감기며 올라온다. */
  tram_start: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.05, gain: 0.22, filter: { type: 'bandpass', f0: 1400 * p, q: 2 } });
    s.tone(d, { type: 'sawtooth', f0: 42 * p, f1: 130 * p, t0: t + 0.08, dur: 1.1, gain: 0.26, attack: 0.12, lp: 700 });
    s.noise(d, { t0: t + 0.1, dur: 1.2, gain: 0.1, attack: 0.25, filter: { type: 'lowpass', f0: 500 * p, f1: 1400 * p, q: 0.7 }, decayCurve: 'lin' });
    return 1.3;
  },
  /** 전차 정차: 제동 쉭 + 완충기 클렁크. */
  tram_dock: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.55, gain: 0.2, filter: { type: 'highpass', f0: 2600 * p, f1: 1200 * p, q: 0.8 } });
    s.tone(d, { type: 'sine', f0: 110 * p, f1: 48 * p, t0: t + 0.35, dur: 0.3, gain: 0.28 });
    return 0.7;
  },
  /** 재해 예고: 함선에서 오는 낮은 2음 경보. `wave_alarm` 보다 무겁고 느리다. */
  hazard_warn: (s, d, t, p) => {
    for (let i = 0; i < 3; i++) {
      s.tone(d, { type: 'square', f0: 196 * p, f1: 147 * p, t0: t + i * 0.42, dur: 0.34, gain: 0.1, lp: 1400, decayCurve: 'lin' });
    }
    s.noise(d, { t0: t, dur: 1.4, gain: 0.05, attack: 0.4, filter: { type: 'lowpass', f0: 400 * p, q: 0.7 }, decayCurve: 'lin' });
    return 1.4;
  },
  /** 피해 구역에 들어갔다: 귀를 덮는 저역 러시 (나올 때는 이 소리를 쓰지 않는다). */
  hazard_inside: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 1.1, gain: 0.3, attack: 0.25, filter: { type: 'lowpass', f0: 260 * p, f1: 700 * p, q: 0.6 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 70 * p, f1: 44 * p, t0: t, dur: 0.9, gain: 0.2, attack: 0.2 });
    return 1.2;
  },
  /** 로그 강하 경보: 하늘에서 뭔가 떨어진다 — 날카로운 3음 + 대기를 가르는 소리. */
  rogue_drop_alarm: (s, d, t, p) => {
    for (let i = 0; i < 3; i++) {
      s.tone(d, { type: 'square', f0: 740 * p, t0: t + i * 0.13, dur: 0.09, gain: 0.09, lp: 3000, decayCurve: 'lin' });
    }
    s.noise(d, { t0: t + 0.45, dur: 1.0, gain: 0.16, attack: 0.5, filter: { type: 'bandpass', f0: 700 * p, f1: 2600 * p, q: 1.2 }, decayCurve: 'lin' });
    return 1.5;
  },
  /**
   * 적 강하 포드가 대기를 찢고 내려오는 굉음 (2026-09-10). `hellpod_fall` 과 **같은 어휘**(위에서 아래로 쓸리는
   * 밴드패스 노이즈 + 내려가는 saw)를 쓰되 셋이 다르다: ① 더 길고(4.2 s) 더 어둡게 끝나며(260 Hz),
   * ② saw 가 **둘로 디튠**돼 맥놀이가 생겨 아군 포드의 매끈한 한 줄과 갈린다, ③ 마지막 1 초에 금속이 우는
   * 상승음이 붙는다(적 포드의 역추진). 아군 헬포드와 헷갈리면 안 되는 소리라 음색과 피치를 둘 다 비틀었다.
   */
  rogue_pod_fall: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 4.2, gain: 0.5, attack: 1.3, filter: { type: 'bandpass', f0: 2600 * p, f1: 260 * p, q: 0.7 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 190 * p, f1: 46 * p, t0: t, dur: 4.2, gain: 0.15, attack: 1.5, lp: 430, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 190 * p, f1: 46 * p, t0: t, dur: 4.2, gain: 0.11, attack: 1.5, detune: 27, lp: 430, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 34 * p, f1: 22 * p, t0: t + 0.6, dur: 3.6, gain: 0.3, attack: 1.6, decayCurve: 'lin' });
    s.tone(d, { type: 'square', f0: 330 * p, f1: 880 * p, t0: t + 3.2, dur: 1.0, gain: 0.05, attack: 0.4, lp: 2600, decayCurve: 'lin' });
    return 4.3;
  },
  /**
   * 적 강하 포드의 착지 충격 (2026-09-10). `hellpod_impact` 보다 낮고 무겁게 꽂히고, 아군 포드에는 없는
   * **파편 클릭 3개**와 해치가 열리는 저역 클렁크가 붙는다.
   */
  rogue_pod_impact: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 56 * p, f1: 19, t0: t, dur: 0.9, gain: 1.15 });
    s.noise(d, { t0: t, dur: 0.55, gain: 0.85, filter: { type: 'lowpass', f0: 1100, f1: 80 } });
    s.click(d, t + 0.04, 1800 * p, 0.3, 0.05);
    s.click(d, t + 0.13, 1300 * p, 0.22, 0.06);
    s.click(d, t + 0.25, 2200 * p, 0.16, 0.04);
    s.noise(d, { t0: t + 0.12, dur: 1.2, gain: 0.14, filter: { type: 'bandpass', f0: 2200, f1: 600, q: 1 }, decayCurve: 'lin' });
    s.tone(d, { type: 'square', f0: 170 * p, f1: 96 * p, t0: t + 0.06, dur: 0.3, gain: 0.07, lp: 900 });
    return 1.3;
  },

  /* ══ appended (2026-09-11): 드론 · 원격 지뢰 · 네임드 로그 ═══════════════════════════════════════════
   * ★ = periodic: the owner re-sends it every 0.1–0.6 s. Those are short hits with a soft attack and a held body
   * + linear release (`release`) and a little pitch jitter, so overlapping hits blur into one continuous sound
   * instead of pulsing or phasing. How far each one carries is `AudioSystem`'s `RANGED_SOUNDS`, not the synth.
   */

  /* ── drones ─────────────────────────────────────────────────────────────── */
  /** Drone set down / launched: mechanical landing thud + servo whir + two-note power-on beep. */
  drone_deploy: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 140 * p, f1: 55, t0: t, dur: 0.18, gain: 0.45 });
    s.noise(d, { t0: t, dur: 0.1, gain: 0.3, filter: { type: 'lowpass', f0: 1200 * p, f1: 250, q: 0.8 } });
    s.click(d, t + 0.03, 1900 * p, 0.18, 0.025);
    s.noise(d, { t0: t + 0.12, dur: 0.22, gain: 0.1, attack: 0.04, filter: { type: 'bandpass', f0: 900 * p, f1: 2600 * p, q: 3 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 1320 * p, t0: t + 0.36, dur: 0.07, gain: 0.1 });
    s.tone(d, { type: 'sine', f0: 1760 * p, t0: t + 0.44, dur: 0.12, gain: 0.1 });
    return 0.58;
  },
  /** Local: took control — a burst of static resolving into rising digital chips and a held lock tone. */
  drone_link_on: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.08, gain: 0.06, filter: { type: 'bandpass', f0: 2800 * p, q: 1.2 }, decayCurve: 'lin' });
    const notes = [660, 880, 1175, 1568];
    notes.forEach((f, i) => s.tone(d, { type: 'square', f0: f * p, t0: t + 0.05 + i * 0.055, dur: 0.045, gain: 0.045, lp: 4200, decayCurve: 'lin' }));
    s.tone(d, { type: 'sine', f0: 2093 * p, t0: t + 0.28, dur: 0.14, gain: 0.08 });
    return 0.44;
  },
  /** Local: link dropped — falling chips and a low closing blip, static dies away. */
  drone_link_off: (s, d, t, p) => {
    const notes = [1568, 1175, 880, 660];
    notes.forEach((f, i) => s.tone(d, { type: 'square', f0: f * p, t0: t + i * 0.05, dur: 0.045, gain: 0.045, lp: 4200, decayCurve: 'lin' }));
    s.tone(d, { type: 'sine', f0: 330 * p, f1: 220 * p, t0: t + 0.21, dur: 0.12, gain: 0.09 });
    s.noise(d, { t0: t + 0.18, dur: 0.18, gain: 0.05, filter: { type: 'bandpass', f0: 2400 * p, f1: 900 * p, q: 1 }, decayCurve: 'lin' });
    return 0.38;
  },
  /** ★ Local: link at >90 % range — a short broken-radio static burst (hiss + crackles + mains buzz). */
  drone_static: (s, d, t, p) => {
    const q = p * r(0.9, 1.1);
    s.noise(d, { t0: t, dur: 0.24, gain: 0.1, attack: 0.02, release: 0.12, filter: { type: 'bandpass', f0: 2400 * q, q: 0.6 } });
    for (let i = 0; i < 4; i++) {
      s.noise(d, { t0: t + r(0, 0.2), dur: r(0.008, 0.025), gain: r(0.06, 0.14), filter: { type: 'highpass', f0: r(2500, 5500) } });
    }
    s.tone(d, { type: 'sawtooth', f0: 100 * q, t0: t, dur: 0.24, gain: 0.02, attack: 0.02, release: 0.1, lp: 900 });
    return 0.26;
  },
  /** ★ Ground drone walking: a tiny, soft motor tick (deliberately near-silent). */
  drone_move: (s, d, t, p) => {
    const q = p * r(0.94, 1.06);
    s.tone(d, { type: 'square', f0: 180 * q, f1: 160 * q, t0: t, dur: 0.12, gain: 0.035, attack: 0.015, release: 0.07, lp: 700 });
    s.noise(d, { t0: t, dur: 0.05, gain: 0.03, filter: { type: 'bandpass', f0: 1800 * q, q: 4 } });
    return 0.13;
  },
  /** ★ Ground drone sprinting: sharp motor whine (two detuned saws) + wheel/gravel noise. Carries. */
  drone_sprint: (s, d, t, p) => {
    const q = p * r(0.98, 1.02);
    s.tone(d, { type: 'sawtooth', f0: 720 * q, f1: 780 * q, t0: t, dur: 0.32, gain: 0.06, attack: 0.04, release: 0.16, lp: 3200 });
    s.tone(d, { type: 'sawtooth', f0: 724 * q, f1: 786 * q, t0: t, dur: 0.32, gain: 0.04, attack: 0.04, release: 0.16, lp: 3200, detune: 9 });
    s.noise(d, { t0: t, dur: 0.32, gain: 0.13, attack: 0.03, release: 0.16, filter: { type: 'bandpass', f0: 1100 * q, q: 0.9 } });
    s.noise(d, { t0: t, dur: 0.3, gain: 0.08, attack: 0.03, release: 0.15, filter: { type: 'lowpass', f0: 600 * q, q: 0.7 } });
    return 0.33;
  },
  /** Ground drone jump: spring-servo thump + short air push. */
  drone_jump: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 160 * p, f1: 70, t0: t, dur: 0.12, gain: 0.4 });
    s.click(d, t, 1400 * p, 0.14, 0.025);
    s.noise(d, { t0: t + 0.02, dur: 0.16, gain: 0.12, attack: 0.03, filter: { type: 'bandpass', f0: 600 * p, f1: 1600 * p, q: 1.2 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 260 * p, f1: 480 * p, t0: t + 0.02, dur: 0.1, gain: 0.03, lp: 1500 });
    return 0.22;
  },
  /** Ground drone landing: dull body thud + a light chassis rattle. */
  drone_land: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 110 * p, f1: 45, t0: t, dur: 0.16, gain: 0.5 });
    s.noise(d, { t0: t, dur: 0.1, gain: 0.3, filter: { type: 'lowpass', f0: 800 * p, f1: 150, q: 0.8 } });
    s.click(d, t + 0.04, 2200 * p, 0.08, 0.02);
    s.click(d, t + 0.09, 1700 * p, 0.05, 0.02);
    return 0.2;
  },
  /** ★ Air drone rotors: quadcopter buzz — beating saws with a blade-chop vibrato + air wash. `pitch` = rotor speed. */
  drone_rotor: (s, d, t, p) => {
    const q = p * r(0.985, 1.015);
    s.tone(d, { type: 'sawtooth', f0: 190 * q, t0: t, dur: 0.34, gain: 0.05, attack: 0.07, release: 0.16, lp: 1600, vibratoHz: 26, vibratoDepth: 22 });
    s.tone(d, { type: 'sawtooth', f0: 197 * q, t0: t, dur: 0.34, gain: 0.04, attack: 0.07, release: 0.16, lp: 1600, vibratoHz: 31, vibratoDepth: 18 });
    s.tone(d, { type: 'square', f0: 380 * q, t0: t, dur: 0.34, gain: 0.015, attack: 0.07, release: 0.16, lp: 1200 });
    s.noise(d, { t0: t, dur: 0.34, gain: 0.07, attack: 0.07, release: 0.16, filter: { type: 'bandpass', f0: 900 * q, q: 1.2 } });
    return 0.35;
  },
  /** Drone hit: bright metal ping + spark crackle + a small electric zap. */
  drone_hit: (s, d, t, p) => {
    const q = p * r(0.94, 1.06);
    s.click(d, t, 2600 * q, 0.22, 0.03);
    s.tone(d, { type: 'triangle', f0: 2100 * q, f1: 1900 * q, t0: t, dur: 0.22, gain: 0.08 });
    s.tone(d, { type: 'sine', f0: 3300 * q, t0: t, dur: 0.12, gain: 0.04 });
    s.tone(d, { type: 'sawtooth', f0: 1200 * q, f1: 400 * q, t0: t + 0.02, dur: 0.06, gain: 0.04, lp: 3500 });
    for (let i = 0; i < 4; i++) {
      s.noise(d, { t0: t + r(0.03, 0.2), dur: r(0.008, 0.02), gain: r(0.05, 0.1), filter: { type: 'highpass', f0: r(3000, 6000) } });
    }
    return 0.3;
  },
  /** Drone destroyed: small blast + a crackling electrical discharge + debris. */
  drone_destroyed: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.06, gain: 0.5, filter: { type: 'highpass', f0: 1800 } });
    s.noise(d, { t0: t, dur: 0.55, gain: 0.75, filter: { type: 'lowpass', f0: 2000 * p, f1: 80, q: 0.6 } });
    s.tone(d, { type: 'sine', f0: 110 * p, f1: 30, t0: t, dur: 0.4, gain: 0.8 });
    s.tone(d, { type: 'sawtooth', f0: 1800 * p, f1: 120 * p, t0: t + 0.03, dur: 0.35, gain: 0.07, lp: 4000, vibratoHz: 30, vibratoDepth: 150 });
    for (let i = 0; i < 6; i++) {
      s.noise(d, { t0: t + 0.1 + i * 0.1 + r(-0.03, 0.03), dur: r(0.01, 0.03), gain: 0.1 * (1 - i / 8), filter: { type: 'bandpass', f0: r(2500, 6000), q: 3 } });
    }
    for (let i = 0; i < 3; i++) s.click(d, t + 0.18 + i * 0.09 + r(0, 0.04), r(900, 2200) * p, 0.08, 0.02);
    return 0.85;
  },
  /** Drone recovered: folding servo + latch clicks + two-note confirm. */
  drone_recover: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.3, gain: 0.12, attack: 0.03, filter: { type: 'bandpass', f0: 2400 * p, f1: 800 * p, q: 3 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 300 * p, f1: 180 * p, t0: t, dur: 0.28, gain: 0.05, attack: 0.03, lp: 1000, decayCurve: 'lin' });
    s.click(d, t + 0.1, 1800 * p, 0.12, 0.02);
    s.click(d, t + 0.3, 2400 * p, 0.16, 0.025);
    s.tone(d, { type: 'sine', f0: 988 * p, t0: t + 0.36, dur: 0.08, gain: 0.1 });
    s.tone(d, { type: 'sine', f0: 1318 * p, t0: t + 0.45, dur: 0.14, gain: 0.1 });
    return 0.6;
  },

  /* ── remote mine (C4) ───────────────────────────────────────────────────── */
  /** C4 stuck down: a squelchy putty press + small thud, then the casing click. */
  c4_place: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.14, gain: 0.2, attack: 0.02, filter: { type: 'bandpass', f0: 500 * p, f1: 1400 * p, q: 3 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 180 * p, f1: 90, t0: t, dur: 0.08, gain: 0.25 });
    s.noise(d, { t0: t + 0.1, dur: 0.06, gain: 0.06, filter: { type: 'bandpass', f0: 900 * p, f1: 500 * p, q: 4 } });
    s.click(d, t + 0.2, 2800 * p, 0.2, 0.025);
    return 0.3;
  },
  /** C4 armed: two short, identical high beeps (not the rising `mine_arm` figure). */
  c4_arm: (s, d, t, p) => {
    for (let i = 0; i < 2; i++) {
      s.tone(d, { type: 'square', f0: 1760 * p, t0: t + i * 0.12, dur: 0.05, gain: 0.07, lp: 4000, decayCurve: 'lin' });
      s.tone(d, { type: 'sine', f0: 3520 * p, t0: t + i * 0.12, dur: 0.035, gain: 0.02 });
    }
    return 0.2;
  },
  /** ★ Armed C4 idling: one small, clean beep (near only). */
  c4_beep: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 2093 * p, t0: t, dur: 0.06, gain: 0.06 });
    s.tone(d, { type: 'triangle', f0: 4186 * p, t0: t, dur: 0.03, gain: 0.015 });
    return 0.07;
  },
  /** Local: detonator pressed — button click-click + a short radio squelch. */
  c4_detonator_click: (s, d, t, p) => {
    s.click(d, t, 3000 * p, 0.28, 0.02);
    s.click(d, t + 0.05, 1800 * p, 0.14, 0.02);
    s.tone(d, { type: 'square', f0: 1200 * p, f1: 900 * p, t0: t + 0.07, dur: 0.04, gain: 0.04, lp: 3000 });
    s.noise(d, { t0: t + 0.07, dur: 0.18, gain: 0.12, filter: { type: 'bandpass', f0: 2200 * p, q: 1.2 }, decayCurve: 'lin' });
    return 0.3;
  },

  /* ── named rogues ───────────────────────────────────────────────────────── */
  /** ★ 로든's scan drone in flight: low, ominous beating hum + a faint uneasy high whine. Carries far. */
  scan_drone_hum: (s, d, t, p) => {
    const q = p * r(0.99, 1.01);
    s.tone(d, { type: 'sawtooth', f0: 62 * q, t0: t, dur: 0.66, gain: 0.1, attack: 0.14, release: 0.3, lp: 420 });
    s.tone(d, { type: 'sawtooth', f0: 63.4 * q, t0: t, dur: 0.66, gain: 0.08, attack: 0.14, release: 0.3, lp: 420 });
    s.tone(d, { type: 'sine', f0: 124 * q, t0: t, dur: 0.66, gain: 0.07, attack: 0.14, release: 0.3, vibratoHz: 5, vibratoDepth: 40 });
    s.noise(d, { t0: t, dur: 0.66, gain: 0.05, attack: 0.14, release: 0.3, filter: { type: 'bandpass', f0: 300 * q, q: 2 } });
    s.tone(d, { type: 'sine', f0: 1480 * q, t0: t, dur: 0.66, gain: 0.012, attack: 0.2, release: 0.3, vibratoHz: 3, vibratoDepth: 35 });
    return 0.68;
  },
  /**
   * 로든's scope glint (the shot follows): a thin, high tension tone rising slightly under a glassy sparkle, with an
   * E6 body under it so it stays audible at distance (`RANGED_SOUNDS` gives it a volume floor).
   */
  sniper_glint: (s, d, t, p) => {
    s.tone(d, { type: 'triangle', f0: 2637 * p, t0: t, dur: 0.18, gain: 0.06 });
    s.tone(d, { type: 'sine', f0: 3950 * p, f1: 4200 * p, t0: t, dur: 0.85, gain: 0.07, attack: 0.15, decayCurve: 'lin', vibratoHz: 9, vibratoDepth: 15 });
    s.tone(d, { type: 'sine', f0: 1318 * p, f1: 1397 * p, t0: t, dur: 0.85, gain: 0.05, attack: 0.2, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 6270 * p, t0: t + 0.02, dur: 0.25, gain: 0.035 });
    s.tone(d, { type: 'sine', f0: 5274 * p, t0: t + 0.08, dur: 0.3, gain: 0.03 });
    s.noise(d, { t0: t, dur: 0.5, gain: 0.03, attack: 0.1, filter: { type: 'highpass', f0: 7000 }, decayCurve: 'lin' });
    return 0.9;
  },
  /** 로든's anti-materiel shot: huge crack + sub boom, a long darkening tail and two slap-back echoes rolling off. */
  sniper_shot: (s, d, t, p) => {
    // crack
    s.noise(d, { t0: t, dur: 0.04, gain: 1.1, filter: { type: 'highpass', f0: 2600 * p } });
    s.noise(d, { t0: t, dur: 0.18, gain: 1.0, filter: { type: 'bandpass', f0: 1300 * p, f1: 250 * p, q: 0.6 } });
    s.tone(d, { type: 'triangle', f0: 900 * p, f1: 150 * p, t0: t, dur: 0.07, gain: 0.4 });
    // boom
    s.tone(d, { type: 'sine', f0: 95 * p, f1: 26 * p, t0: t, dur: 0.6, gain: 1.3 });
    s.tone(d, { type: 'sawtooth', f0: 70 * p, f1: 32 * p, t0: t + 0.01, dur: 0.35, gain: 0.2, lp: 380 });
    // tail + echoes
    s.tail(d, t + 0.05, 1.2, 0.3, 1800 * p, 150);
    s.noise(d, { t0: t + 0.45, dur: 0.5, gain: 0.22, filter: { type: 'lowpass', f0: 900 * p, f1: 120, q: 0.6 } });
    s.tone(d, { type: 'sine', f0: 70 * p, f1: 30, t0: t + 0.45, dur: 0.4, gain: 0.25 });
    s.noise(d, { t0: t + 1.0, dur: 0.8, gain: 0.1, filter: { type: 'lowpass', f0: 600 * p, f1: 100, q: 0.6 } });
    s.noise(d, { t0: t + 0.2, dur: 1.8, gain: 0.12, attack: 0.3, filter: { type: 'lowpass', f0: 300 * p, q: 0.6 }, decayCurve: 'lin' });
    return 2.1;
  },
  /** 타길라's hammer swing: slow, heavy air cut (lower and longer than `melee_swing`). */
  hammer_swing: (s, d, t, p) => {
    const q = p * r(0.95, 1.05);
    s.noise(d, { t0: t, dur: 0.42, gain: 0.4, attack: 0.14, filter: { type: 'bandpass', f0: 220 * q, f1: 900 * q, q: 1.1 }, decayCurve: 'lin' });
    s.noise(d, { t0: t + 0.05, dur: 0.32, gain: 0.15, attack: 0.1, filter: { type: 'lowpass', f0: 500 * q, q: 0.7 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 70 * q, f1: 110 * q, t0: t, dur: 0.35, gain: 0.18, attack: 0.12 });
    return 0.45;
  },
  /** 타길라's hammer impact: crushing sub thump + metal head clank + ground debris. */
  hammer_impact: (s, d, t, p) => {
    const q = p * r(0.95, 1.05);
    s.tone(d, { type: 'sine', f0: 85 * q, f1: 24, t0: t, dur: 0.6, gain: 1.2 });
    s.noise(d, { t0: t, dur: 0.45, gain: 0.9, filter: { type: 'lowpass', f0: 1400 * q, f1: 70, q: 0.6 } });
    s.click(d, t, 1200 * q, 0.35, 0.05);
    s.tone(d, { type: 'triangle', f0: 300 * q, f1: 90, t0: t, dur: 0.2, gain: 0.3 });
    s.noise(d, { t0: t + 0.08, dur: 0.5, gain: 0.12, filter: { type: 'bandpass', f0: 1800, f1: 500, q: 1 }, decayCurve: 'lin' });
    for (let i = 0; i < 3; i++) s.click(d, t + 0.12 + i * 0.08 + r(0, 0.04), r(700, 1800) * q, 0.08, 0.02);
    return 0.75;
  },
  /** Heavy's minigun spinning up over `MINIGUN_SPINUP_TIME`: rising motor whine + barrel whirr + quickening clatter. */
  minigun_spinup: (s, d, t, p) => {
    const dur = Math.max(0.4, Math.min(2.5, MINIGUN_SPINUP_TIME));
    s.tone(d, { type: 'sawtooth', f0: 90 * p, f1: 620 * p, t0: t, dur, gain: 0.08, attack: dur * 0.7, release: 0.08, lp: 2600 });
    s.tone(d, { type: 'sawtooth', f0: 92 * p, f1: 628 * p, t0: t, dur, gain: 0.05, attack: dur * 0.7, release: 0.08, lp: 2600 });
    s.tone(d, { type: 'square', f0: 45 * p, f1: 310 * p, t0: t, dur, gain: 0.05, attack: dur * 0.5, release: 0.08, lp: 900 });
    s.noise(d, { t0: t, dur, gain: 0.09, attack: dur * 0.7, release: 0.08, filter: { type: 'bandpass', f0: 400 * p, f1: 2400 * p, q: 2.5 } });
    // clatter: gaps shrink as the barrels speed up
    let at = 0.02, gap = dur * 0.2;
    while (at < dur - 0.03) {
      s.click(d, t + at, 1500 * p, 0.05 + 0.07 * (at / dur), 0.015);
      at += gap; gap = Math.max(0.03, gap * 0.72);
    }
    return dur + 0.02;
  },
  /**
   * ★ Heavy's minigun firing (one ≈0.1 s chunk): three micro-reports inside it so the stream reads as a brrrt,
   * over a held motor whine + barrel body. Carries far.
   */
  minigun_fire: (s, d, t, p) => {
    const q = p * r(0.97, 1.03);
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.033 + r(0, 0.006);
      s.noise(d, { t0: at, dur: 0.035, gain: 0.38, filter: { type: 'bandpass', f0: 2000 * q, f1: 600 * q, q: 0.9 } });
      s.tone(d, { type: 'sine', f0: 160 * q, f1: 60 * q, t0: at, dur: 0.05, gain: 0.3 });
    }
    s.noise(d, { t0: t, dur: 0.02, gain: 0.25, filter: { type: 'highpass', f0: 4200 } });
    s.noise(d, { t0: t, dur: 0.14, gain: 0.16, attack: 0.01, release: 0.05, filter: { type: 'lowpass', f0: 900 * q, q: 0.7 } });
    s.tone(d, { type: 'sawtooth', f0: 620 * q, t0: t, dur: 0.14, gain: 0.03, attack: 0.01, release: 0.05, lp: 2600 });
    return 0.15;
  },
  /** Heavy's minigun winding down over `MINIGUN_SPINDOWN_TIME`: falling whine + slowing clatter. */
  minigun_spindown: (s, d, t, p) => {
    const dur = Math.max(0.4, Math.min(3, MINIGUN_SPINDOWN_TIME));
    s.tone(d, { type: 'sawtooth', f0: 620 * p, f1: 70 * p, t0: t, dur, gain: 0.08, attack: 0.01, lp: 2600, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 628 * p, f1: 72 * p, t0: t, dur, gain: 0.05, attack: 0.01, lp: 2600, decayCurve: 'lin' });
    s.tone(d, { type: 'square', f0: 310 * p, f1: 45 * p, t0: t, dur: dur * 0.8, gain: 0.04, attack: 0.01, lp: 900, decayCurve: 'lin' });
    s.noise(d, { t0: t, dur, gain: 0.09, attack: 0.01, filter: { type: 'bandpass', f0: 2400 * p, f1: 300 * p, q: 2.5 }, decayCurve: 'lin' });
    let at = 0.03, gap = 0.03;
    while (at < dur - 0.03) {
      s.click(d, t + at, 1500 * p, 0.12 * (1 - at / dur) + 0.02, 0.015);
      at += gap; gap = gap * 1.35;
    }
    return dur + 0.02;
  },

  /* ══ appended (2026-09-11): C 항목 배치 — 실드 충전 · 전차 · 재질별 발소리 ═══════════════════════════════════ */

  /**
   * C-21: 실드 충전기 사용 완료 (`player/` 가 부른다, 위치 없음). 올라가는 saw 충전음(400 → 1600 Hz, 로우패스가 함께
   * 열린다) + 끝에 맺히는 사인 2음 화음 + 하이패스 노이즈 반짝임 + 마지막 딸깍 (≈0.6 s). `stim`(회복)과 같은 "쓰고
   * 나면 오르는" 어휘지만 금속 · 전기 쪽이라 헷갈리지 않는다.
   */
  shield_charge: (s, d, t, p) => {
    s.tone(d, { type: 'sawtooth', f0: 400 * p, f1: 1600 * p, t0: t, dur: 0.42, gain: 0.08, attack: 0.08, lp: 2400, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 404 * p, f1: 1616 * p, t0: t, dur: 0.42, gain: 0.05, attack: 0.08, lp: 2400, detune: 11, decayCurve: 'lin' });
    s.noise(d, { t0: t + 0.05, dur: 0.45, gain: 0.07, attack: 0.2, filter: { type: 'highpass', f0: 5200 * p, q: 0.6 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 1175 * p, t0: t + 0.36, dur: 0.24, gain: 0.1 });
    s.tone(d, { type: 'sine', f0: 1760 * p, t0: t + 0.38, dur: 0.22, gain: 0.08 });
    s.click(d, t + 0.4, 3200 * p, 0.12, 0.02);
    return 0.62;
  },

  /** C-39: 전차 호출 수락 — 승강장 안내 차임 (딩-동 두 음 + 은은한 잔향). 부른 사람의 콘솔에서 난다. */
  tram_call: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 988 * p, t0: t, dur: 0.7, gain: 0.14, attack: 0.006 });
    s.tone(d, { type: 'triangle', f0: 1976 * p, t0: t, dur: 0.3, gain: 0.03 });
    s.tone(d, { type: 'sine', f0: 784 * p, t0: t + 0.32, dur: 0.95, gain: 0.14, attack: 0.006 });
    s.tone(d, { type: 'triangle', f0: 1568 * p, t0: t + 0.32, dur: 0.4, gain: 0.03 });
    s.noise(d, { t0: t + 0.02, dur: 1.1, gain: 0.02, attack: 0.1, filter: { type: 'bandpass', f0: 1400 * p, q: 0.8 }, decayCurve: 'lin' });
    return 1.3;
  },

  /** C-39: 전차 호출 거부 — 승강장 안내의 낮은 역차임 두 음 (`keycard_deny` 버저와 다르다). */
  tram_deny: (s, d, t, p) => {
    s.tone(d, { type: 'triangle', f0: 392 * p, t0: t, dur: 0.22, gain: 0.12, lp: 1600 });
    s.tone(d, { type: 'triangle', f0: 294 * p, t0: t + 0.2, dur: 0.34, gain: 0.12, lp: 1400 });
    s.tone(d, { type: 'square', f0: 147 * p, t0: t + 0.2, dur: 0.3, gain: 0.03, lp: 700, decayCurve: 'lin' });
    return 0.56;
  },

  /**
   * C-18 · C-39: 달리는 전차에 치였다 — 금속 차체가 몸을 들이받는 둔탁한 충격(서브 쿵 + 로우패스 노이즈) + 차체의
   * 금속 클렁크와 짧은 울림 + 레일의 쇳소리 긁힘. 옛 `tram_dock` pitch 0.7 대용을 대신한다.
   */
  tram_hit: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 120 * p, f1: 34, t0: t, dur: 0.45, gain: 0.95 });
    s.noise(d, { t0: t, dur: 0.3, gain: 0.7, filter: { type: 'lowpass', f0: 1800 * p, f1: 120, q: 0.6 } });
    s.click(d, t + 0.005, 1100 * p, 0.35, 0.05);
    s.tone(d, { type: 'triangle', f0: 620 * p, f1: 540 * p, t0: t + 0.01, dur: 0.38, gain: 0.08 });
    s.tone(d, { type: 'sine', f0: 1390 * p, t0: t + 0.01, dur: 0.22, gain: 0.035 });
    s.noise(d, { t0: t + 0.05, dur: 0.5, gain: 0.08, attack: 0.02, filter: { type: 'bandpass', f0: 3600 * p, f1: 1800 * p, q: 4 }, decayCurve: 'lin' });
    return 0.6;
  },

  /*
   * C-22: 재질별 발소리 11종 (`SurfaceMaterial` 이름 그대로 `footstep_<mat>`). 전부 ≈0.05–0.13 s 의 한 걸음이고 크기의
   * 밑값은 기존 `footstep` 과 비슷하게 맞췄다 — 재질마다 체감 크기를 다시 맞추는 배수는 `data/tables.csv` 의
   * `FOOTSTEP_MATERIAL_GAIN` 이다(`AudioSystem`). `footstep_dirt` 는 옛 `footstep` 그 자체다(= 폴백 음색이 바뀌지 않는다).
   * 피치 `p` 로 무게를 낸다: 적(`enemies/model.stepSound`)은 낮은 피치로 같은 소리를 쓴다.
   */
  footstep_dirt: (s, d, t, p) => SOUNDS.footstep(s, d, t, p),
  /** 모래: 사각거리는 넓은 대역 노이즈 + 아주 작은 몸 무게. */
  footstep_sand: (s, d, t, p) => {
    const q = p * r(0.88, 1.12);
    s.noise(d, { t0: t, dur: 0.11, gain: 0.13, attack: 0.012, filter: { type: 'bandpass', f0: 2600 * q, f1: 1500 * q, q: 0.6 } });
    s.noise(d, { t0: t, dur: 0.06, gain: 0.12, filter: { type: 'lowpass', f0: 500 * q, f1: 180, q: 0.7 } });
    s.tone(d, { type: 'sine', f0: 95 * q, f1: 55, t0: t, dur: 0.04, gain: 0.06 });
    return 0.12;
  },
  /**
   * 눈: 뽀드득 — 짧은 크런치 알갱이 셋이 몇 ms 씩 어긋나 겹친다 + 눌리는 낮은 몸.
   *
   * **2026-09-12 — 고역을 눌러 다시 튜닝했다** (사용자 불만 "툰드라 발걸음이 거슬린다"). 옛 판은 `highpass` 알갱이
   * 4겹이었는데, 하이패스는 **위가 열려 있어** 흰 노이즈의 8–16 kHz 가 그대로 나간다 — 거기에 기본 attack 0.003 s 의
   * 트랜지언트가 한 걸음에 4번 찍히니, 매 걸음 듣는 로컬 발소리로는 몇 분 만에 귀가 아팠다. 편하다고 평가받은
   * `footstep_sand` 를 기준으로 세 가지를 옮겨 왔다:
   *  ① **위를 닫는다** — `highpass` → `bandpass`(q 0.8). 모래처럼 중심이 아래로 쓸려 내려가고(1300–1900 → 700–1000 Hz)
   *     양쪽 스커트가 6 dB/oct 로 떨어지므로 10 kHz 성분이 중심 대비 ~12 dB 죽는다. 중심도 옛 1800–3200 Hz 에서
   *     1300–1900 Hz 로 내려 **귀가 가장 예민한 3–5 kHz 대를 비운다**.
   *  ② **어택을 완만하게** — 알갱이 attack 0.003(기본) → 0.007 s, 몸통 0.01 → 0.012 s(모래와 같은 값). 클릭이 사라진다.
   *  ③ **꼬리를 짧게** — 알갱이 4 → 3겹, 간격 0.018 → 0.016 s 라 밝은 성분이 0.09 s 가 아니라 ~0.07 s 에서 끝난다.
   * 알갱이 gain 은 0.1 → 0.055 (−5 dB). 대신 대역이 좁아진 만큼 빠진 무게를 몸통에서 되돌린다(0.1 → 0.12,
   * lowpass 700 → 620 Hz). 저역 몸통 · 사인은 거의 그대로라 **여전히 "눈을 밟는" 소리**로 들린다.
   */
  footstep_snow: (s, d, t, p) => {
    const q = p * r(0.9, 1.1);
    for (let i = 0; i < 3; i++) {
      s.noise(d, {
        t0: t + i * 0.016 + r(0, 0.005), dur: 0.026 + r(0, 0.01), gain: 0.055 * (1 - i * 0.22), attack: 0.007,
        filter: { type: 'bandpass', f0: r(1300, 1900) * q, f1: r(700, 1000) * q, q: 0.8 },
      });
    }
    s.noise(d, { t0: t, dur: 0.09, gain: 0.12, attack: 0.012, filter: { type: 'lowpass', f0: 620 * q, f1: 220, q: 0.6 } });
    s.tone(d, { type: 'sine', f0: 90 * q, f1: 55, t0: t, dur: 0.05, gain: 0.07 });
    return 0.1;
  },
  /** 진흙: 철벅 — 밴드패스가 열렸다 닫히는 젖은 노이즈 + 무거운 저음 + 끝의 작은 빨림. */
  footstep_mud: (s, d, t, p) => {
    const q = p * r(0.88, 1.1);
    s.noise(d, { t0: t, dur: 0.1, gain: 0.2, attack: 0.008, filter: { type: 'bandpass', f0: 320 * q, f1: 900 * q, q: 1.6 } });
    s.tone(d, { type: 'sine', f0: 85 * q, f1: 48, t0: t, dur: 0.07, gain: 0.14 });
    s.noise(d, { t0: t + 0.07, dur: 0.05, gain: 0.06, filter: { type: 'bandpass', f0: 1300 * q, f1: 600 * q, q: 3 } });
    return 0.13;
  },
  /** 이끼: 푹신하게 먹히는 걸음 — 어두운 로우패스 노이즈만, 고역이 거의 없다. */
  footstep_moss: (s, d, t, p) => {
    const q = p * r(0.88, 1.12);
    s.noise(d, { t0: t, dur: 0.09, gain: 0.2, attack: 0.012, filter: { type: 'lowpass', f0: 420 * q, f1: 150, q: 0.6 } });
    s.tone(d, { type: 'sine', f0: 100 * q, f1: 58, t0: t, dur: 0.06, gain: 0.1 });
    return 0.1;
  },
  /** 화산재: 바삭하게 부서지는 마른 걸음 — 중역 노이즈 + 작은 크래클 둘. */
  footstep_ash: (s, d, t, p) => {
    const q = p * r(0.9, 1.1);
    s.noise(d, { t0: t, dur: 0.08, gain: 0.14, attack: 0.006, filter: { type: 'bandpass', f0: 1200 * q, f1: 700 * q, q: 0.8 } });
    s.noise(d, { t0: t + r(0.01, 0.03), dur: 0.012, gain: 0.08, filter: { type: 'highpass', f0: 3800 * q } });
    s.noise(d, { t0: t + r(0.035, 0.06), dur: 0.01, gain: 0.06, filter: { type: 'highpass', f0: 4400 * q } });
    s.tone(d, { type: 'sine', f0: 105 * q, f1: 60, t0: t, dur: 0.045, gain: 0.08 });
    return 0.09;
  },
  /** 바위: 단단한 짧은 타격 + 자갈 틱 — 흙보다 밝고 짧다. */
  footstep_rock: (s, d, t, p) => {
    const q = p * r(0.9, 1.1);
    s.noise(d, { t0: t, dur: 0.035, gain: 0.2, filter: { type: 'bandpass', f0: 1500 * q, f1: 900 * q, q: 1.2 } });
    s.tone(d, { type: 'sine', f0: 180 * q, f1: 90, t0: t, dur: 0.04, gain: 0.12 });
    s.noise(d, { t0: t + r(0.02, 0.05), dur: 0.01, gain: 0.05, filter: { type: 'bandpass', f0: r(3000, 4500) * q, q: 3 } });
    return 0.07;
  },
  /** 크리스탈: 단단한 타격 위에 비조화 유리 울림 둘이 짧게 맺힌다. */
  footstep_crystal: (s, d, t, p) => {
    const q = p * r(0.94, 1.06);
    s.noise(d, { t0: t, dur: 0.03, gain: 0.16, filter: { type: 'bandpass', f0: 2200 * q, q: 1.4 } });
    s.tone(d, { type: 'sine', f0: 170 * q, f1: 90, t0: t, dur: 0.035, gain: 0.09 });
    s.tone(d, { type: 'sine', f0: 2460 * q * r(0.97, 1.03), t0: t, dur: 0.13, gain: 0.025 });
    s.tone(d, { type: 'sine', f0: 3710 * q * r(0.97, 1.03), t0: t + 0.004, dur: 0.09, gain: 0.018 });
    return 0.13;
  },
  /** 유기물 · 점액: 끈적하게 눌리는 걸음 — 좁은 밴드패스가 아래로 쓸리고 짧게 떨린다. */
  footstep_organic: (s, d, t, p) => {
    const q = p * r(0.88, 1.12);
    s.noise(d, { t0: t, dur: 0.1, gain: 0.17, attack: 0.01, filter: { type: 'bandpass', f0: 650 * q, f1: 260 * q, q: 2.2 } });
    s.tone(d, { type: 'sine', f0: 78 * q, f1: 46, t0: t, dur: 0.07, gain: 0.12, vibratoHz: 30, vibratoDepth: 60 });
    return 0.11;
  },
  /** 금속: 갑판 · 선로 · 전차 · 상자 — 딸깍 금속 트랜지언트 + 판이 짧게 우는 소리 + 낮은 몸 쿵. */
  footstep_metal: (s, d, t, p) => {
    const q = p * r(0.92, 1.08);
    s.click(d, t, 1900 * q, 0.1, 0.022);
    s.noise(d, { t0: t, dur: 0.05, gain: 0.1, filter: { type: 'bandpass', f0: 900 * q, f1: 600 * q, q: 1.5 } });
    s.tone(d, { type: 'triangle', f0: 760 * q, f1: 700 * q, t0: t, dur: 0.1, gain: 0.03 });
    s.tone(d, { type: 'sine', f0: 130 * q, f1: 70, t0: t, dur: 0.05, gain: 0.12 });
    return 0.11;
  },
  /** 콘크리트: 평평하고 건조한 타격 — 중역 노이즈 + 짧은 저음 + 고역 틱 (반향 없음). */
  footstep_concrete: (s, d, t, p) => {
    const q = p * r(0.9, 1.1);
    s.noise(d, { t0: t, dur: 0.045, gain: 0.18, filter: { type: 'bandpass', f0: 1100 * q, f1: 700 * q, q: 0.9 } });
    s.tone(d, { type: 'sine', f0: 145 * q, f1: 72, t0: t, dur: 0.04, gain: 0.12 });
    s.noise(d, { t0: t, dur: 0.012, gain: 0.08, filter: { type: 'highpass', f0: 3400 * q } });
    return 0.07;
  },

  /* ══ appended (2026-09-12): 헬스장 (A-3a) · 서재 매체 가구 (A-3e) — 전부 housing/ · hub/ 가 `audio:play` 로 부른다 ════════
   * 함선 안 UI 성격의 소리라 `RANGED_SOUNDS` 에 넣지 않는다 — 위치 없이 오면 늘 같은 크기, 위치와 오면 기본 패너(가까이서만). */

  /** 운동 시작 — 호루라기 대신 짧은 준비 신호: 오르는 삼각파 두 음 + 기구를 잡는 딸깍. */
  gym_start: (s, d, t, p) => {
    s.click(d, t, 1600 * p, 0.08, 0.02);
    s.tone(d, { type: 'triangle', f0: 587 * p, t0: t + 0.03, dur: 0.14, gain: 0.12, lp: 3000 });
    s.tone(d, { type: 'triangle', f0: 880 * p, t0: t + 0.16, dur: 0.24, gain: 0.13, lp: 3200 });
    s.tone(d, { type: 'sine', f0: 1760 * p, t0: t + 0.16, dur: 0.16, gain: 0.025 });
    return 0.42;
  },
  /** 판정 완벽 — 밝은 두 음 차임 + 고역 반짝임. `gym_good` 보다 높고 길다. */
  gym_perfect: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 1319 * p, t0: t, dur: 0.22, gain: 0.13, attack: 0.004 });
    s.tone(d, { type: 'sine', f0: 1976 * p, t0: t + 0.05, dur: 0.3, gain: 0.11, attack: 0.004 });
    s.tone(d, { type: 'triangle', f0: 3951 * p, t0: t + 0.05, dur: 0.12, gain: 0.02 });
    s.noise(d, { t0: t + 0.03, dur: 0.18, gain: 0.03, filter: { type: 'highpass', f0: 6000 * p, q: 0.6 } });
    return 0.38;
  },
  /** 판정 좋음 — 가운데 높이의 짧은 한 음 (차분한 확인). */
  gym_good: (s, d, t, p) => {
    s.tone(d, { type: 'triangle', f0: 880 * p, t0: t, dur: 0.18, gain: 0.12, lp: 2600 });
    s.tone(d, { type: 'sine', f0: 1320 * p, t0: t, dur: 0.1, gain: 0.03 });
    return 0.22;
  },
  /** 판정 실패 — 낮게 꺾이는 둔한 음 + 짧은 저역 쿵 (`ui_error` 버저보다 부드럽다). */
  gym_miss: (s, d, t, p) => {
    s.tone(d, { type: 'triangle', f0: 262 * p, f1: 175 * p, t0: t, dur: 0.24, gain: 0.13, lp: 1200 });
    s.noise(d, { t0: t, dur: 0.1, gain: 0.08, filter: { type: 'lowpass', f0: 500 * p, f1: 160, q: 0.7 } });
    return 0.28;
  },
  /** 세션 끝 — 원반을 거치대에 내려놓는 금속 쿵 + 오르는 네 음 아르페지오. */
  gym_finish: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 110 * p, f1: 50, t0: t, dur: 0.22, gain: 0.3 });
    s.click(d, t + 0.005, 1200 * p, 0.14, 0.04);
    s.tone(d, { type: 'triangle', f0: 540 * p, f1: 520 * p, t0: t + 0.01, dur: 0.3, gain: 0.03 });
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      s.tone(d, { type: 'sine', f0: f * p, t0: t + 0.18 + i * 0.1, dur: i === 3 ? 0.6 : 0.2, gain: 0.11 });
      s.tone(d, { type: 'triangle', f0: f * 2 * p, t0: t + 0.18 + i * 0.1, dur: 0.12, gain: 0.02 });
    });
    return 0.95;
  },
  /** 호흡 — 부드러운 날숨: 아래로 쓸리는 밴드패스 노이즈, 어택이 느리고 선형으로 사라진다 (클릭 없음). */
  gym_breath: (s, d, t, p) => {
    const q = p * r(0.95, 1.05);
    s.noise(d, { t0: t, dur: 0.46, gain: 0.09, attack: 0.07, filter: { type: 'bandpass', f0: 1300 * q, f1: 520 * q, q: 0.9 }, decayCurve: 'lin' });
    s.noise(d, { t0: t, dur: 0.36, gain: 0.05, attack: 0.05, filter: { type: 'lowpass', f0: 420 * q, f1: 200, q: 0.5 }, decayCurve: 'lin' });
    return 0.5;
  },
  /** 페달 — 가벼운 기계 틱: 체인 딸깍 + 크랭크의 아주 작은 몸. */
  gym_pedal: (s, d, t, p) => {
    const q = p * r(0.94, 1.06);
    s.click(d, t, 2600 * q, 0.05, 0.012);
    s.tone(d, { type: 'sine', f0: 160 * q, f1: 110, t0: t, dur: 0.035, gain: 0.04 });
    return 0.06;
  },
  /** 흔들의자 삐걱 — 나무 스틱-슬립: 좁은 밴드패스 알갱이가 점점 벌어지며 이어지고 그 밑에 낮은 나무 몸통이 운다. */
  chair_creak: (s, d, t, p) => {
    const q = p * r(0.9, 1.1);
    let at = 0, gap = 0.014;
    for (let i = 0; i < 16 && at < 0.42; i++) {
      s.noise(d, { t0: t + at, dur: 0.012, gain: 0.07 * (0.6 + 0.4 * Math.sin((i / 15) * Math.PI)), filter: { type: 'bandpass', f0: r(620, 780) * q, q: 9 } });
      at += gap; gap *= 1.09;
    }
    s.tone(d, { type: 'sawtooth', f0: 190 * q, f1: 150 * q, t0: t, dur: 0.44, gain: 0.025, attack: 0.05, lp: 700, vibratoHz: 24, vibratoDepth: 70, decayCurve: 'lin' });
    return 0.48;
  },
  /** TV 켜기 — 스위치 딸깍 + 브라운관 퍽 + 짧은 잡음 + 가늘게 사라지는 고음. */
  tv_on: (s, d, t, p) => {
    s.click(d, t, 2200 * p, 0.08, 0.02);
    s.tone(d, { type: 'sine', f0: 90 * p, f1: 45, t0: t + 0.02, dur: 0.18, gain: 0.18 });
    s.noise(d, { t0: t + 0.03, dur: 0.32, gain: 0.05, attack: 0.02, filter: { type: 'bandpass', f0: 3200 * p, f1: 1800 * p, q: 0.7 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 4200 * p, t0: t + 0.05, dur: 0.45, gain: 0.012, attack: 0.04, decayCurve: 'lin' });
    return 0.52;
  },
  /** TV 끄기 — 스위치 딸깍 + 화면이 점으로 줄어드는 하강 블립 + 꼬리 잡음. */
  tv_off: (s, d, t, p) => {
    s.click(d, t, 2000 * p, 0.07, 0.02);
    s.tone(d, { type: 'sine', f0: 1400 * p, f1: 90 * p, t0: t + 0.01, dur: 0.2, gain: 0.07 });
    s.noise(d, { t0: t + 0.01, dur: 0.12, gain: 0.03, filter: { type: 'highpass', f0: 2600 * p, q: 0.6 } });
    return 0.3;
  },
  /** 레코드 켜기 — 스위치 딸깍 + 바늘이 닿는 작은 쿵 + 따뜻한 바닥 음 + 잠깐의 치직임. */
  record_on: (s, d, t, p) => {
    s.click(d, t, 1500 * p, 0.08, 0.02);
    s.tone(d, { type: 'sine', f0: 140 * p, f1: 70, t0: t + 0.12, dur: 0.1, gain: 0.1 });
    s.tone(d, { type: 'triangle', f0: 196 * p, t0: t + 0.16, dur: 0.5, gain: 0.03, attack: 0.08, lp: 900, decayCurve: 'lin' });
    for (let i = 0; i < 7; i++) {
      s.noise(d, { t0: t + 0.14 + r(0, 0.5), dur: 0.006, gain: r(0.02, 0.05), filter: { type: 'highpass', f0: r(3000, 5000) * p } });
    }
    s.noise(d, { t0: t + 0.14, dur: 0.5, gain: 0.012, attack: 0.05, filter: { type: 'bandpass', f0: 2400 * p, q: 0.5 }, decayCurve: 'lin' });
    return 0.72;
  },
  /** 레코드 끄기 — 스위치 딸깍 + 플래터가 느려지며 내려가는 음. */
  record_off: (s, d, t, p) => {
    s.click(d, t, 1400 * p, 0.08, 0.02);
    s.tone(d, { type: 'triangle', f0: 330 * p, f1: 100 * p, t0: t + 0.02, dur: 0.5, gain: 0.05, lp: 800, decayCurve: 'lin' });
    s.noise(d, { t0: t + 0.02, dur: 0.3, gain: 0.01, filter: { type: 'bandpass', f0: 2000 * p, f1: 900 * p, q: 0.5 }, decayCurve: 'lin' });
    return 0.55;
  },

  /* ── 준비 소리 (2026-09-12) — 임플란트와 함선 호출이 서로 다르게 들린다 ─────────────────────── */
  /**
   * 전술 임플란트 준비 — 짧고 높은 전자음: 위로 튕기는 사각파 칩 하나 + 맑은 사인 핑 + 아주 옅은 배음. ≈0.16 s.
   * (id 는 implants/ 가 오래전부터 보내던 것인데 정의가 없어 한 번도 울리지 않았다. 이제 audio/ 가 `implant:ready` 를 듣는다.)
   */
  implant_ready: (s, d, t, p) => {
    s.tone(d, { type: 'square', f0: 1568 * p, f1: 2093 * p, t0: t, dur: 0.045, gain: 0.06, lp: 5200 });
    s.tone(d, { type: 'sine', f0: 2637 * p, t0: t + 0.038, dur: 0.12, gain: 0.13, attack: 0.003 });
    s.tone(d, { type: 'sine', f0: 5274 * p, t0: t + 0.038, dur: 0.05, gain: 0.02 });
    return 0.17;
  },
  /**
   * 함선 호출 준비 — 무전 톤 두 음 차임: 스퀠치가 열리는 잡음 + 딸깍, 좁은 대역의 두 음(G5 → D6, 뒤 음이 길다),
   * 스퀠치가 닫히는 짧은 잡음. 임플란트의 높은 핑과 달리 낮고 둥글다. ≈0.56 s.
   */
  stratagem_ready: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.07, gain: 0.07, filter: { type: 'bandpass', f0: 2400 * p, q: 1.2 } });
    s.click(d, t, 1800 * p, 0.035, 0.015);
    [784, 1175].forEach((f, i) => {
      const t0 = t + 0.06 + i * 0.17;
      s.tone(d, { type: 'triangle', f0: f * p, t0, dur: i ? 0.34 : 0.16, gain: 0.13, attack: 0.006, lp: 3200 });
      s.tone(d, { type: 'square', f0: f * 0.5 * p, t0, dur: i ? 0.22 : 0.12, gain: 0.016, lp: 1400 });
    });
    s.noise(d, { t0: t + 0.48, dur: 0.06, gain: 0.035, filter: { type: 'bandpass', f0: 2000 * p, q: 1.5 } });
    return 0.56;
  },

  /* ── 안드로이드 (2026-09-13) — 연구소 · 전진기지의 백색 로봇. 살이 아니라 외피 · 서보 · 전원이다 ────────── */
  /**
   * 피격: 속이 빈 외피를 친 금속음 — 날카로운 클릭 + 900 Hz 대의 짧은 공명(두 배음이 살짝 어긋나 "통" 소리) +
   * 둔한 저음 한 번 + 튀는 스파크 틱. `hit_flesh` 자리에 온다(`enemies/model.hurtSound`). ≈0.26 s.
   */
  android_hit: (s, d, t, p) => {
    const q = p * r(0.93, 1.07);
    s.click(d, t, 2300 * q, 0.2, 0.025);
    s.tone(d, { type: 'triangle', f0: 920 * q, f1: 860 * q, t0: t, dur: 0.24, gain: 0.09 });
    s.tone(d, { type: 'sine', f0: 1370 * q, f1: 1310 * q, t0: t, dur: 0.16, gain: 0.05 });
    s.tone(d, { type: 'sine', f0: 190 * q, f1: 90, t0: t, dur: 0.08, gain: 0.3 });
    s.noise(d, { t0: t, dur: 0.05, gain: 0.22, filter: { type: 'bandpass', f0: 2600 * q, f1: 1400 * q, q: 1.2 } });
    for (let i = 0; i < 2; i++) {
      s.noise(d, { t0: t + r(0.03, 0.14), dur: r(0.006, 0.014), gain: r(0.05, 0.09), filter: { type: 'highpass', f0: r(3500, 6500) } });
    }
    return 0.26;
  },
  /**
   * 사망 = 전원 차단: 전기 지직 한 번 → 서보 모터가 느려지며 1 kHz 에서 40 Hz 로 가라앉는 톱니파(로우패스) +
   * 꺼져 가는 사인 험 + 몸이 땅에 부딪는 금속 쿵 두 번(외피 · 팔다리). ≈1.3 s.
   */
  android_death: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.12, gain: 0.28, filter: { type: 'bandpass', f0: 3200 * p, q: 2 } });
    s.tone(d, { type: 'sawtooth', f0: 1000 * p, f1: 40 * p, t0: t + 0.02, dur: 1.05, gain: 0.1, lp: 1800, vibratoHz: 22, vibratoDepth: 30 });
    s.tone(d, { type: 'sine', f0: 240 * p, f1: 55 * p, t0: t, dur: 0.95, gain: 0.22 });
    for (let i = 0; i < 4; i++) s.click(d, t + 0.05 + i * 0.07 + r(0, 0.03), r(1800, 3600) * p, 0.07 * (1 - i / 5), 0.015);
    s.tone(d, { type: 'sine', f0: 150 * p, f1: 50, t0: t + 0.78, dur: 0.18, gain: 0.5 });
    s.noise(d, { t0: t + 0.78, dur: 0.14, gain: 0.3, filter: { type: 'lowpass', f0: 1400 * p, f1: 200, q: 0.7 } });
    s.tone(d, { type: 'triangle', f0: 640 * p, f1: 600 * p, t0: t + 0.78, dur: 0.3, gain: 0.05 });
    s.click(d, t + 0.97, 1200 * p, 0.12, 0.03);
    return 1.3;
  },
  /** 한 걸음의 서보: 좁은 대역의 짧은 모터 윙(위로 살짝 휜다) + 작은 금속 틱. 재질 발소리 위에 겹친다. ≈0.1 s. */
  android_step: (s, d, t, p) => {
    const q = p * r(0.94, 1.06);
    s.tone(d, { type: 'sawtooth', f0: 520 * q, f1: 700 * q, t0: t, dur: 0.08, gain: 0.03, attack: 0.01, lp: 1600 });
    s.noise(d, { t0: t, dur: 0.07, gain: 0.04, filter: { type: 'bandpass', f0: 1800 * q, f1: 2400 * q, q: 4 } });
    s.click(d, t + 0.05, 2600 * q, 0.05, 0.012);
    return 0.1;
  },
  /** 전소(불타며 몸부림) = 비명 대신 오작동: 끊기는 사각파 경고음 3개 + 전기 잡음. ≈0.5 s. */
  android_glitch: (s, d, t, p) => {
    for (let i = 0; i < 3; i++) {
      const f = [1480, 1110, 1660][i] * p;
      s.tone(d, { type: 'square', f0: f, f1: f * 0.94, t0: t + i * 0.12 + r(0, 0.02), dur: 0.07, gain: 0.05, lp: 3200 });
    }
    s.noise(d, { t0: t, dur: 0.45, gain: 0.12, filter: { type: 'bandpass', f0: 2800 * p, f1: 1200 * p, q: 1.5 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 90 * p, t0: t, dur: 0.4, gain: 0.05, lp: 700, vibratoHz: 40, vibratoDepth: 20 });
    return 0.5;
  },

  /* ══ appended (2026-09-13): 버그 굴착 스폰 · 지하벌레 — `enemies/` 가 위치와 함께 `audio:play` 로 부른다 ══════════════
   * 거리 곡선은 `AudioSystem.RANGED_SOUNDS` (전조 땅울림 · 분출 · 포효는 멀리서도 들려야 공정해서 floor 를 갖는다).
   */
  /** 버그 한 마리가 흙을 헤치고 올라온다: 짧은 흙 무너짐 알갱이 + 낮은 쿵 + 긁는 소리. 일부러 작다. ≈0.55 s. */
  burrow_emerge: (s, d, t, p) => {
    const q = p * r(0.92, 1.08);
    s.tone(d, { type: 'sine', f0: 95 * q, f1: 42 * q, t0: t, dur: 0.28, gain: 0.3 });
    for (let i = 0; i < 5; i++) {
      s.noise(d, { t0: t + i * 0.06 + r(0, 0.03), dur: 0.09, gain: 0.07, attack: 0.006, filter: { type: 'bandpass', f0: r(380, 900) * q, q: 1.4 } });
    }
    s.noise(d, { t0: t + 0.05, dur: 0.45, gain: 0.08, attack: 0.05, filter: { type: 'lowpass', f0: 700 * q, f1: 180, q: 0.7 }, decayCurve: 'lin' });
    s.noise(d, { t0: t + 0.12, dur: 0.3, gain: 0.03, attack: 0.08, filter: { type: 'bandpass', f0: 1600 * q, f1: 2600 * q, q: 3 } });
    return 0.58;
  },
  /** 지하벌레 전조 땅울림: 서브 저음이 5초 동안 부풀고, 갈리는 흙 · 암반 균열이 점점 잦아진다. ≈5.3 s. */
  sandworm_rumble: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 26 * p, f1: 42 * p, t0: t, dur: 5.3, gain: 0.55, attack: 4.2, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 38 * p, f1: 55 * p, t0: t + 0.5, dur: 4.8, gain: 0.08, attack: 3.8, lp: 160, vibratoHz: 7, vibratoDepth: 30, decayCurve: 'lin' });
    s.noise(d, { t0: t, dur: 5.3, gain: 0.35, attack: 4.4, filter: { type: 'lowpass', f0: 110, f1: 420, q: 0.8 }, decayCurve: 'lin' });
    s.noise(d, { t0: t + 1.2, dur: 4.1, gain: 0.08, attack: 3.2, filter: { type: 'bandpass', f0: 700 * p, f1: 1300 * p, q: 1.2 }, decayCurve: 'lin' });
    for (let i = 0; i < 9; i++) {
      const at = t + 1 + 4 * Math.sqrt((i + r(0, 0.6)) / 9);
      s.noise(d, { t0: at, dur: 0.12, gain: 0.05 + 0.05 * (i / 9), filter: { type: 'bandpass', f0: r(900, 2200) * p, q: 2 } });
      s.tone(d, { type: 'sine', f0: r(60, 90) * p, f1: 35 * p, t0: at, dur: 0.2, gain: 0.08 + 0.1 * (i / 9) });
    }
    return 5.4;
  },
  /** 분출: 대지가 찢어지는 서브 충격 + 흙 · 암반 폭발 + 쏟아지는 파편 + 긴 꼬리. ≈2.4 s. */
  sandworm_erupt: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 72 * p, f1: 18, t0: t, dur: 1.6, gain: 1.2 });
    s.noise(d, { t0: t, dur: 1.1, gain: 1.0, filter: { type: 'lowpass', f0: 2400, f1: 90, q: 0.6 } });
    s.noise(d, { t0: t + 0.02, dur: 0.35, gain: 0.35, filter: { type: 'bandpass', f0: 1400 * p, f1: 300, q: 0.9 } });
    for (let i = 0; i < 12; i++) s.click(d, t + 0.15 + r(0, 1.2), r(700, 2400) * p, r(0.06, 0.16), r(0.03, 0.07));
    s.tail(d, t + 0.1, 2.3, 0.22, 900, 60);
    return 2.5;
  },
  /** 지하벌레 포효: 디튠 saw 둘이 내려앉는 목울림 + 거친 대역 잡음 + 쉭쉭대는 고역. ≈2.4 s. */
  sandworm_roar: (s, d, t, p) => {
    const t0 = t + 0.18;
    s.tone(d, { type: 'sawtooth', f0: 110 * p, f1: 58 * p, t0, dur: 2.2, gain: 0.16, attack: 0.25, lp: 900, vibratoHz: 11, vibratoDepth: 45, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 116 * p, f1: 61 * p, t0, dur: 2.1, gain: 0.12, attack: 0.3, lp: 700, detune: 18, vibratoHz: 6, vibratoDepth: 30, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 55 * p, f1: 30 * p, t0, dur: 2.2, gain: 0.35, attack: 0.3, decayCurve: 'lin' });
    s.noise(d, { t0, dur: 2.1, gain: 0.22, attack: 0.3, filter: { type: 'bandpass', f0: 480 * p, f1: 260 * p, q: 1.1 }, decayCurve: 'lin' });
    s.noise(d, { t0: t0 + 0.1, dur: 1.6, gain: 0.06, attack: 0.4, filter: { type: 'highpass', f0: 3200, q: 0.7 }, decayCurve: 'lin' });
    return 2.5;
  },
  /** 입에서 무언가를 뱉는다: 목구멍이 꿀렁이는 젖은 소리 → 퍽 하고 튀어나감. 독극물은 피치를 올려 부른다. ≈0.7 s. */
  sandworm_spit: (s, d, t, p) => {
    for (let i = 0; i < 4; i++) {
      s.noise(d, { t0: t + i * 0.07, dur: 0.1, gain: 0.12, attack: 0.02, filter: { type: 'bandpass', f0: (320 + i * 110) * p, q: 3.5 } });
    }
    s.tone(d, { type: 'sine', f0: 160 * p, f1: 60 * p, t0: t + 0.3, dur: 0.22, gain: 0.45 });
    s.noise(d, { t0: t + 0.3, dur: 0.35, gain: 0.3, filter: { type: 'bandpass', f0: 900 * p, f1: 2400 * p, q: 1.1 } });
    s.noise(d, { t0: t + 0.34, dur: 0.3, gain: 0.08, filter: { type: 'highpass', f0: 2600, q: 0.6 }, decayCurve: 'lin' });
    return 0.72;
  },
  /** 지하벌레 사망: 길게 꺼지는 목울림 + 굴로 무너져 내리는 흙더미. ≈3.2 s. */
  sandworm_death: (s, d, t, p) => {
    s.tone(d, { type: 'sawtooth', f0: 96 * p, f1: 32 * p, t0: t, dur: 2.4, gain: 0.14, attack: 0.1, lp: 650, vibratoHz: 5, vibratoDepth: 60, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 48 * p, f1: 20, t0: t + 0.2, dur: 2.8, gain: 0.5, attack: 0.3, decayCurve: 'lin' });
    s.noise(d, { t0: t + 0.6, dur: 2.4, gain: 0.45, attack: 0.5, filter: { type: 'lowpass', f0: 900, f1: 90, q: 0.7 }, decayCurve: 'lin' });
    for (let i = 0; i < 8; i++) s.click(d, t + 0.8 + r(0, 1.8), r(500, 1500) * p, r(0.05, 0.12), 0.05);
    return 3.3;
  },

  /* ══ appended (2026-09-13): 요리 미니게임 — `housing/ui/cook/CookScreen` · `parts/Cooking` 이 `audio:play {id}` 로 부른다 ════════
   * 조리대 앞 UI 소리라 `RANGED_SOUNDS` 에 넣지 않는다 (위치 없이 오면 늘 같은 크기 — 헬스장 `gym_*` 와 같은 규약). 입력마다 · 누르는 동안
   * 주기적으로 불리는 것(`cook_chop` · `cook_mince` · `cook_stir` · `cook_toss`)은 짧고 작게, 무작위 피치로 반복감이 덜하게 만들었다. */

  /** 조리 시작 — 가스레인지 점화 딸깍 두 번 + 불꽃이 붙는 부드러운 훅 + 오르는 두 음. ≈0.55 s. */
  cook_start: (s, d, t, p) => {
    s.click(d, t, 2400 * p, 0.07, 0.015);
    s.click(d, t + 0.07, 2600 * p, 0.06, 0.015);
    s.noise(d, { t0: t + 0.1, dur: 0.32, gain: 0.07, attack: 0.03, filter: { type: 'bandpass', f0: 500 * p, f1: 900 * p, q: 0.8 }, decayCurve: 'lin' });
    s.tone(d, { type: 'triangle', f0: 523 * p, t0: t + 0.14, dur: 0.14, gain: 0.1, lp: 2800 });
    s.tone(d, { type: 'triangle', f0: 784 * p, t0: t + 0.27, dur: 0.26, gain: 0.11, lp: 3000 });
    return 0.56;
  },
  /** 썰기 — 나무 도마에 칼이 닿는 탁: 짧은 중역 노크 + 나무 몸통 + 칼날의 아주 짧은 고역. ≈0.09 s. */
  cook_chop: (s, d, t, p) => {
    const q = p * r(0.93, 1.07);
    s.noise(d, { t0: t, dur: 0.035, gain: 0.2, filter: { type: 'bandpass', f0: 1150 * q, f1: 700 * q, q: 1.6 } });
    s.tone(d, { type: 'sine', f0: 240 * q, f1: 150 * q, t0: t, dur: 0.07, gain: 0.16 });
    s.tone(d, { type: 'triangle', f0: 620 * q, f1: 560 * q, t0: t, dur: 0.04, gain: 0.03 });
    s.noise(d, { t0: t, dur: 0.008, gain: 0.05, filter: { type: 'highpass', f0: 5200 * q } });
    return 0.09;
  },
  /** 다지기 — 썰기보다 더 짧고 가볍고 높은 탁 (연타해도 뭉개지지 않게). ≈0.05 s. */
  cook_mince: (s, d, t, p) => {
    const q = p * r(0.9, 1.12);
    s.noise(d, { t0: t, dur: 0.022, gain: 0.15, filter: { type: 'bandpass', f0: 1500 * q, f1: 1000 * q, q: 1.8 } });
    s.tone(d, { type: 'sine', f0: 300 * q, f1: 200 * q, t0: t, dur: 0.04, gain: 0.1 });
    return 0.05;
  },
  /** 굽기 시작 — 재료가 달군 철판에 닿는 치익 → 지글지글 (밴드패스 노이즈 + 무작위 기름 튀는 틱). ≈1.2 s. */
  cook_sizzle: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.18, gain: 0.16, attack: 0.004, filter: { type: 'highpass', f0: 2600 * p, q: 0.6 } });
    s.noise(d, { t0: t + 0.05, dur: 1.15, gain: 0.08, attack: 0.05, filter: { type: 'bandpass', f0: 4200 * p, f1: 3000 * p, q: 0.7 }, decayCurve: 'lin' });
    for (let i = 0; i < 14; i++) {
      s.noise(d, { t0: t + 0.08 + r(0, 1.05), dur: r(0.004, 0.01), gain: r(0.03, 0.08), filter: { type: 'bandpass', f0: r(3000, 7000) * p, q: 3 } });
    }
    return 1.22;
  },
  /** 뒤집기 — 뒤집개가 철판을 긁는 짧은 쇳소리 + 조각이 떨어지는 작은 철썩 + 다시 치익. ≈0.4 s. */
  cook_flip: (s, d, t, p) => {
    const q = p * r(0.95, 1.05);
    s.noise(d, { t0: t, dur: 0.07, gain: 0.08, filter: { type: 'bandpass', f0: 2200 * q, f1: 3200 * q, q: 3 } });
    s.tone(d, { type: 'triangle', f0: 1480 * q, f1: 1380 * q, t0: t, dur: 0.06, gain: 0.025 });
    s.tone(d, { type: 'sine', f0: 170 * q, f1: 90, t0: t + 0.12, dur: 0.06, gain: 0.12 });
    s.noise(d, { t0: t + 0.12, dur: 0.05, gain: 0.1, filter: { type: 'lowpass', f0: 1400 * q, q: 0.7 } });
    s.noise(d, { t0: t + 0.14, dur: 0.26, gain: 0.07, attack: 0.01, filter: { type: 'highpass', f0: 3000 * q, q: 0.6 }, decayCurve: 'lin' });
    return 0.42;
  },
  /** 꺼내기 — 조각을 들어 올리는 짧은 긁힘 + 접시에 놓는 도자기 딸깍. ≈0.3 s. */
  cook_remove: (s, d, t, p) => {
    const q = p * r(0.95, 1.05);
    s.noise(d, { t0: t, dur: 0.06, gain: 0.06, filter: { type: 'bandpass', f0: 2600 * q, f1: 1800 * q, q: 2.5 } });
    s.click(d, t + 0.14, 3200 * q, 0.06, 0.012);
    s.tone(d, { type: 'sine', f0: 2100 * q, t0: t + 0.14, dur: 0.12, gain: 0.03 });
    s.tone(d, { type: 'sine', f0: 3150 * q, t0: t + 0.14, dur: 0.08, gain: 0.015 });
    return 0.3;
  },
  /** 탔다 — 치익 하고 꺼지는 연기 + 낮게 꺾이는 둔한 음 (실패음보다 불쾌하지 않게). ≈0.6 s. */
  cook_burn: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.5, gain: 0.1, attack: 0.02, filter: { type: 'bandpass', f0: 1800 * p, f1: 500 * p, q: 0.8 }, decayCurve: 'lin' });
    s.tone(d, { type: 'triangle', f0: 233 * p, f1: 147 * p, t0: t + 0.05, dur: 0.4, gain: 0.1, lp: 1000 });
    s.tone(d, { type: 'sine', f0: 90 * p, f1: 55, t0: t + 0.05, dur: 0.2, gain: 0.1 });
    return 0.6;
  },
  /** 볶기 — 팬을 튕기는 금속 덜컹 + 재료가 떨어지며 지글. ≈0.3 s. */
  cook_toss: (s, d, t, p) => {
    const q = p * r(0.94, 1.06);
    s.click(d, t, 1700 * q, 0.07, 0.02);
    s.tone(d, { type: 'triangle', f0: 880 * q, f1: 820 * q, t0: t, dur: 0.12, gain: 0.03 });
    s.tone(d, { type: 'sine', f0: 140 * q, f1: 80, t0: t, dur: 0.05, gain: 0.1 });
    s.noise(d, { t0: t + 0.08, dur: 0.22, gain: 0.07, attack: 0.01, filter: { type: 'bandpass', f0: 3800 * q, f1: 2800 * q, q: 0.7 }, decayCurve: 'lin' });
    return 0.3;
  },
  /** 젓기 — 국자가 냄비 바닥을 긁는 짧은 소리 (누르는 동안 주기적으로 불린다 — 일부러 작다). ≈0.22 s. */
  cook_stir: (s, d, t, p) => {
    const q = p * r(0.9, 1.1);
    s.noise(d, { t0: t, dur: 0.2, gain: 0.05, attack: 0.04, filter: { type: 'bandpass', f0: 900 * q, f1: 1400 * q, q: 2.2 }, decayCurve: 'lin' });
    s.tone(d, { type: 'sine', f0: 180 * q, f1: 150 * q, t0: t + 0.02, dur: 0.16, gain: 0.03, attack: 0.03, decayCurve: 'lin' });
    s.noise(d, { t0: t + 0.06, dur: 0.012, gain: 0.02, filter: { type: 'bandpass', f0: 600 * q, q: 4 } });
    return 0.22;
  },
  /** 붓기 — 졸졸: 좁은 밴드패스 알갱이(물방울 공명)가 흔들리며 이어지고 그 밑에 부드러운 흐름 잡음. ≈0.7 s. */
  cook_pour: (s, d, t, p) => {
    s.noise(d, { t0: t, dur: 0.66, gain: 0.05, attack: 0.06, filter: { type: 'bandpass', f0: 1100 * p, f1: 800 * p, q: 1.2 }, decayCurve: 'lin' });
    for (let i = 0; i < 12; i++) {
      const at = t + 0.03 + i * 0.05 + r(0, 0.02);
      const f = r(500, 1100) * p;
      s.tone(d, { type: 'sine', f0: f, f1: f * r(1.3, 1.8), t0: at, dur: 0.035, gain: r(0.02, 0.045), attack: 0.004 });
    }
    return 0.7;
  },
  /** 판정 완벽 — 주방 타이머 같은 맑은 벨 두 음 (헬스장 `gym_perfect` 보다 둥글다). ≈0.36 s. */
  cook_perfect: (s, d, t, p) => {
    s.tone(d, { type: 'sine', f0: 1568 * p, t0: t, dur: 0.2, gain: 0.12, attack: 0.003 });
    s.tone(d, { type: 'sine', f0: 2349 * p, t0: t + 0.06, dur: 0.3, gain: 0.1, attack: 0.003 });
    s.tone(d, { type: 'sine', f0: 4698 * p, t0: t + 0.06, dur: 0.1, gain: 0.015 });
    return 0.36;
  },
  /** 판정 좋음 — 가운데 높이의 짧은 나무 블록 톡. ≈0.16 s. */
  cook_good: (s, d, t, p) => {
    s.tone(d, { type: 'triangle', f0: 988 * p, t0: t, dur: 0.12, gain: 0.1, lp: 2600 });
    s.noise(d, { t0: t, dur: 0.02, gain: 0.05, filter: { type: 'bandpass', f0: 2000 * p, q: 3 } });
    return 0.16;
  },
  /** 판정 실패 — 낮게 꺾이는 둔한 음 (버저가 아니라 「앗」). ≈0.26 s. */
  cook_miss: (s, d, t, p) => {
    s.tone(d, { type: 'triangle', f0: 247 * p, f1: 165 * p, t0: t, dur: 0.22, gain: 0.11, lp: 1100 });
    s.noise(d, { t0: t, dur: 0.08, gain: 0.05, filter: { type: 'lowpass', f0: 600 * p, f1: 200, q: 0.7 } });
    return 0.26;
  },
  /** 단계 끝 — 다음 단계로 넘어가는 가벼운 세 음 계단. ≈0.42 s. */
  cook_step: (s, d, t, p) => {
    [659, 784, 988].forEach((f, i) => {
      s.tone(d, { type: 'triangle', f0: f * p, t0: t + i * 0.08, dur: i === 2 ? 0.22 : 0.1, gain: 0.09, lp: 3000 });
    });
    return 0.42;
  },
  /** 자동 처리 — 기계가 도는 윙: 스핀업 → 유지 → 스핀다운하는 톱니파 + 모터 잡음 + 끝의 딸깍. ≈1.1 s. */
  cook_auto: (s, d, t, p) => {
    s.tone(d, { type: 'sawtooth', f0: 90 * p, f1: 240 * p, t0: t, dur: 0.35, gain: 0.04, attack: 0.08, lp: 1200 });
    s.tone(d, { type: 'sawtooth', f0: 240 * p, t0: t + 0.3, dur: 0.5, gain: 0.04, lp: 1400, vibratoHz: 18, vibratoDepth: 12, decayCurve: 'lin' });
    s.tone(d, { type: 'sawtooth', f0: 240 * p, f1: 80 * p, t0: t + 0.75, dur: 0.3, gain: 0.03, lp: 1000 });
    s.noise(d, { t0: t + 0.05, dur: 0.95, gain: 0.04, attack: 0.1, filter: { type: 'bandpass', f0: 1600 * p, q: 1.1 }, decayCurve: 'lin' });
    s.click(d, t + 1.02, 2000 * p, 0.06, 0.015);
    return 1.1;
  },
  /** 요리 완성 — 접시를 내려놓는 도자기 딸깍 + 벨 + 오르는 네 음 아르페지오. ≈1.0 s. */
  cook_finish: (s, d, t, p) => {
    s.click(d, t, 3000 * p, 0.07, 0.015);
    s.tone(d, { type: 'sine', f0: 2093 * p, t0: t, dur: 0.18, gain: 0.04 });
    const notes = [587, 740, 880, 1175];
    notes.forEach((f, i) => {
      s.tone(d, { type: 'sine', f0: f * p, t0: t + 0.14 + i * 0.1, dur: i === 3 ? 0.6 : 0.2, gain: 0.1 });
      s.tone(d, { type: 'triangle', f0: f * 2 * p, t0: t + 0.14 + i * 0.1, dur: 0.1, gain: 0.018 });
    });
    return 1.0;
  },
};

export const SOUND_IDS = Object.keys(SOUNDS);
