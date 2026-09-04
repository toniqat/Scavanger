/**
 * Procedural SFX library. Every sound is synthesized from oscillators, noise buffers,
 * envelopes and filters — no audio files. Sounds are keyed by id (see SOUNDS).
 */

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
}

interface NoiseOpts {
  t0: number;
  dur: number;
  gain: number;
  attack?: number;
  filter?: { type: BiquadFilterType; f0: number; f1?: number; q?: number };
  decayCurve?: 'exp' | 'lin';
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
    this.env(g.gain, o.t0, o.dur, o.gain, o.attack ?? 0.004, o.decayCurve ?? 'exp');
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
    this.env(g.gain, o.t0, o.dur, o.gain, o.attack ?? 0.003, o.decayCurve ?? 'exp');
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

  private env(p: AudioParam, t0: number, dur: number, peak: number, attack: number, curve: 'exp' | 'lin'): void {
    p.setValueAtTime(0.0001, t0);
    p.linearRampToValueAtTime(peak, t0 + Math.min(attack, dur * 0.5));
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
};

export const SOUND_IDS = Object.keys(SOUNDS);
