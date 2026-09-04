import * as THREE from 'three';
import type { GameContext, GameSystem } from '@/shared';
import { Synth, SOUNDS } from './Synth';

const RATE_WINDOW = 0.1;       // seconds
const RATE_MAX_SAME = 8;       // max identical ids per window
const DEDUPE_WINDOW = 0.1;     // auto-hook vs explicit `audio:play` of the same id

interface Ambient {
  wind: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; lfo: OscillatorNode } | null;
  tension: { osc: OscillatorNode; osc2: OscillatorNode; trem: GainNode; lfo: OscillatorNode; gain: GainNode } | null;
  engine: { osc: OscillatorNode; osc2: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null;
}

/**
 * Procedural WebAudio SFX + ambience. Plays `audio:play {id, position, volume, pitch}` and auto-hooks
 * gameplay events that don't send their own audio. Positional sounds are spatialized with a PannerNode.
 */
export class AudioSystem implements GameSystem {
  readonly name = 'audio';
  private ctx!: GameContext;
  private ac: AudioContext | null = null;
  private synth: Synth | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private unsubs: Array<() => void> = [];
  private unlockHandlers: Array<() => void> = [];

  private recent = new Map<string, number[]>();
  private lastPlay = new Map<string, { t: number; auto: boolean }>();
  private amb: Ambient = { wind: null, tension: null, engine: null };
  private engineTarget = 0;
  private tensionTarget = 0;
  private tensionRate = 1;
  private countdownRemaining = 1;
  private countdownTotal = 1;
  private shipPresent = false;
  private liftoffTimer = -1;
  /** Last `weapon:scopeChanged.scope` — gates scope_in/out on `player:aimChanged`. */
  private lastScope = false;
  private aiming = false;

  private camPos = new THREE.Vector3();
  private camFwd = new THREE.Vector3();
  private camUp = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  masterVolume = 0.8;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // Create lazily on first gesture (autoplay policy).
    const unlock = () => this.ensureContext();
    for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
      window.addEventListener(ev, unlock, { passive: true });
      this.unlockHandlers.push(() => window.removeEventListener(ev, unlock));
    }
    this.ensureContext(); // may stay suspended until a gesture

    const b = ctx.bus;
    const auto = (id: string, position?: THREE.Vector3, volume?: number, pitch?: number) => this.play(id, position, volume, pitch, true);
    this.unsubs.push(
      b.on('audio:play', ({ id, position, volume, pitch }) => this.play(id, position, volume, pitch, false)),

      // player
      b.on('player:damaged', () => auto('player_hurt', undefined, 0.9, 0.9 + Math.random() * 0.2)),
      b.on('player:died', () => auto('player_death')),
      b.on('player:footstep', ({ position, sprinting }) => auto('footstep', position, sprinting ? 0.5 : 0.32, sprinting ? 1.05 : 1)),
      b.on('player:stimUsed', () => auto('stim')),
      b.on('player:landed', () => { auto('hellpod_impact', undefined, 1); }),
      b.on('player:dived', () => auto('dive', undefined, 0.8, 0.95 + Math.random() * 0.1)),
      b.on('player:staminaDepleted', () => auto('stamina_depleted', undefined, 0.7)),
      b.on('player:stanceChanged', ({ stance }) => auto('stance_change', undefined, 0.6, stance === 'prone' ? 0.72 : stance === 'crouch' ? 0.9 : 1.05)),
      // Scope in/out: only when the current weapon has a scope (tracked from weapon:scopeChanged).
      b.on('player:aimChanged', ({ aiming }) => {
        if (aiming === this.aiming) return;
        this.aiming = aiming;
        if (this.lastScope) auto(aiming ? 'scope_in' : 'scope_out', undefined, 0.6);
      }),

      // weapons
      b.on('weapon:scopeChanged', ({ scope }) => { this.lastScope = scope; }),
      b.on('weapon:reloadStarted', () => auto('reload_start')),
      b.on('weapon:reloadFinished', () => auto('reload_end')),
      b.on('weapon:dryFire', () => auto('dry_fire')),
      b.on('weapon:hit', ({ point, enemyId, killed }) => auto(enemyId !== null ? 'hit_flesh' : 'hit_terrain', point, killed ? 1 : 0.8, enemyId !== null && killed ? 0.8 : 1)),
      b.on('grenade:thrown', ({ position }) => auto('grenade_throw', position)),
      b.on('grenade:exploded', ({ position }) => auto('explosion', position, 1.0)),

      // enemies (EnemySystem emits its own bug_* audio:play; we only add the wave alarm)
      b.on('enemy:waveStarted', () => auto('wave_alarm')),

      // inventory / crates
      b.on('inventory:opened', () => auto('ui_open')),
      b.on('inventory:closed', () => auto('ui_close')),
      b.on('inventory:itemAdded', () => auto('ui_pickup')),
      b.on('inventory:full', () => auto('ui_error')),
      b.on('inventory:itemRotated', () => auto('ui_rotate')),
      b.on('crate:open', ({ position }) => auto('crate_open', position)),

      // pings / map / input
      b.on('ping:placed', ({ position, kind }) => {
        // enemy: higher + urgent; extraction: lower + calmer; crate slightly low; ground neutral.
        const pitch = kind === 'enemy' ? 1.35 : kind === 'extraction' ? 0.8 : kind === 'crate' ? 0.92 : 1;
        auto('ping', position, kind === 'enemy' ? 0.85 : 0.7, pitch);
      }),
      b.on('ui:mapToggled', ({ open }) => auto(open ? 'map_open' : 'map_close', undefined, 0.7)),
      b.on('input:pointerLockLost', () => auto('ui_close', undefined, 0.5)),

      // extraction
      b.on('extraction:activated', () => { this.tensionTarget = 1; this.countdownRemaining = this.countdownTotal = 1; }),
      b.on('extraction:tick', ({ remaining, total }) => { this.countdownRemaining = remaining; this.countdownTotal = total; }),
      b.on('extraction:shipIncoming', () => { this.shipPresent = true; this.engineTarget = 0.55; }),
      b.on('extraction:shipLanded', () => { this.engineTarget = 0.22; this.tensionTarget = 0.35; }),
      b.on('extraction:boarded', () => auto('ui_equip', undefined, 0.6)),
      b.on('extraction:liftoff', () => { this.engineTarget = 0.9; this.tensionTarget = 0; this.liftoffTimer = 8; }),
      b.on('extraction:doorsClosed', () => auto('door_close')),

      // flow
      b.on('game:phaseChanged', ({ phase, prev }) => {
        if (phase === 'deploying') auto('hellpod_fall');
        if (phase === 'complete') auto('mission_complete');
        if (phase === 'menu' && prev !== 'menu') auto('ui_close');
        if (phase === 'menu' || phase === 'complete' || phase === 'dead') { this.tensionTarget = 0; }
        if (phase === 'menu') { this.shipPresent = false; this.engineTarget = 0; this.liftoffTimer = -1; }
      }),
      b.on('game:newMission', () => { this.shipPresent = false; this.engineTarget = 0; this.tensionTarget = 0; this.liftoffTimer = -1; this.lastScope = false; this.aiming = false; }),
      b.on('game:paused', ({ paused }) => {
        if (!this.ac) return;
        if (paused) this.master.gain.setTargetAtTime(this.masterVolume * 0.25, this.ac.currentTime, 0.1);
        else this.master.gain.setTargetAtTime(this.masterVolume, this.ac.currentTime, 0.1);
      }),
    );
  }

  /* ── context / graph ─────────────────────────────────────────────────── */
  private ensureContext(): void {
    if (!this.ac) {
      try {
        const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
        if (!AC) return;
        this.ac = new AC();
      } catch { return; }
      const ac = this.ac;
      this.synth = new Synth(ac);
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 18; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.2;
      this.master = ac.createGain(); this.master.gain.value = this.masterVolume;
      this.sfxBus = ac.createGain(); this.sfxBus.gain.value = 1;
      this.ambBus = ac.createGain(); this.ambBus.gain.value = 1;
      this.sfxBus.connect(comp); this.ambBus.connect(comp);
      comp.connect(this.master).connect(ac.destination);
      this.buildAmbient();
    }
    if (this.ac.state === 'suspended') void this.ac.resume().catch(() => { /* wait for gesture */ });
  }

  private buildAmbient(): void {
    const ac = this.ac!, s = this.synth!;
    // Wind / planet drone: looping noise → lowpass with slow LFO → gain
    const src = ac.createBufferSource();
    src.buffer = (s as any).noiseBuf as AudioBuffer; src.loop = true;
    const filter = ac.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 380; filter.Q.value = 0.6;
    const lfo = ac.createOscillator(); lfo.frequency.value = 0.07;
    const lfoGain = ac.createGain(); lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(filter.frequency);
    const gain = ac.createGain(); gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.ambBus);
    src.start(); lfo.start();
    // sub drone
    const drone = ac.createOscillator(); drone.type = 'sine'; drone.frequency.value = 42;
    const droneG = ac.createGain(); droneG.gain.value = 0.05;
    drone.connect(droneG).connect(gain); drone.start();
    this.amb.wind = { src, filter, gain, lfo };

    // Tension pulse: low sines through a tremolo gain
    const osc = ac.createOscillator(); osc.type = 'sine'; osc.frequency.value = 55;
    const osc2 = ac.createOscillator(); osc2.type = 'triangle'; osc2.frequency.value = 110.5;
    const trem = ac.createGain(); trem.gain.value = 0.5;
    const tlfo = ac.createOscillator(); tlfo.type = 'sine'; tlfo.frequency.value = 1;
    const tlfoG = ac.createGain(); tlfoG.gain.value = 0.5;
    tlfo.connect(tlfoG).connect(trem.gain);
    const tg = ac.createGain(); tg.gain.value = 0;
    const o2g = ac.createGain(); o2g.gain.value = 0.35;
    osc.connect(trem); osc2.connect(o2g).connect(trem);
    trem.connect(tg).connect(this.ambBus);
    osc.start(); osc2.start(); tlfo.start();
    this.amb.tension = { osc, osc2, trem, lfo: tlfo, gain: tg };

    // Ship engine hum: detuned saws → lowpass → gain
    const e1 = ac.createOscillator(); e1.type = 'sawtooth'; e1.frequency.value = 48;
    const e2 = ac.createOscillator(); e2.type = 'sawtooth'; e2.frequency.value = 50.3;
    const ef = ac.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 320; ef.Q.value = 1.2;
    const eg = ac.createGain(); eg.gain.value = 0;
    e1.connect(ef); e2.connect(ef); ef.connect(eg).connect(this.ambBus);
    e1.start(); e2.start();
    this.amb.engine = { osc: e1, osc2: e2, filter: ef, gain: eg };
  }

  /* ── playback ────────────────────────────────────────────────────────── */
  private play(id: string, position: THREE.Vector3 | undefined, volume = 1, pitch = 1, auto = false): void {
    if (!this.ac || !this.synth || this.ac.state !== 'running') return;
    const fn = SOUNDS[id];
    if (!fn) { if (!auto) console.warn(`[Audio] unknown sound id "${id}"`); return; }
    const now = this.ac.currentTime;

    // Dedupe: same id from a different source within a short window → one plays.
    const last = this.lastPlay.get(id);
    if (last && last.auto !== auto && now - last.t < DEDUPE_WINDOW) return;
    this.lastPlay.set(id, { t: now, auto });

    // Rate limit identical ids.
    let arr = this.recent.get(id);
    if (!arr) { arr = []; this.recent.set(id, arr); }
    while (arr.length && now - arr[0] > RATE_WINDOW) arr.shift();
    if (arr.length >= RATE_MAX_SAME) return;
    arr.push(now);

    // Voice: [synth] → gain → (panner) → sfxBus
    const g = this.ac.createGain();
    g.gain.value = Math.max(0, Math.min(2, volume));
    let dest: AudioNode = this.sfxBus;
    if (position) {
      const p = this.ac.createPanner();
      p.panningModel = 'equalpower'; p.distanceModel = 'inverse';
      p.refDistance = 4; p.maxDistance = 220; p.rolloffFactor = 1.1;
      this.setParam(p.positionX, position.x, now); this.setParam(p.positionY, position.y, now); this.setParam(p.positionZ, position.z, now);
      p.connect(dest); dest = p;
      // Quick distance cull for tiny sounds
      const d = this.camPos.distanceTo(position);
      if (d > 160 && (id === 'footstep' || id === 'bug_step' || id === 'hit_terrain')) return;
    }
    g.connect(dest);
    const dur = fn(this.synth, g, now, Math.max(0.25, Math.min(4, pitch)));
    // Disconnect after the sound is done so the graph doesn't grow.
    window.setTimeout(() => { try { g.disconnect(); if (dest !== this.sfxBus) dest.disconnect(); } catch { /* ignore */ } }, (dur + 0.3) * 1000);
  }

  private setParam(p: AudioParam, v: number, t: number): void {
    if (Number.isFinite(v)) { try { p.setValueAtTime(v, t); } catch { p.value = v; } }
  }

  /* ── per-frame ───────────────────────────────────────────────────────── */
  update(dt: number, ctx: GameContext): void {
    if (!this.ac || this.ac.state !== 'running') return;
    const ac = this.ac, now = ac.currentTime;

    // Listener follows the camera.
    const cam = ctx.camera;
    cam.getWorldPosition(this.camPos);
    cam.getWorldDirection(this.camFwd);
    this.camUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const L = ac.listener;
    if (L.positionX) {
      this.setParam(L.positionX, this.camPos.x, now); this.setParam(L.positionY, this.camPos.y, now); this.setParam(L.positionZ, this.camPos.z, now);
      this.setParam(L.forwardX, this.camFwd.x, now); this.setParam(L.forwardY, this.camFwd.y, now); this.setParam(L.forwardZ, this.camFwd.z, now);
      this.setParam(L.upX, this.camUp.x, now); this.setParam(L.upY, this.camUp.y, now); this.setParam(L.upZ, this.camUp.z, now);
    } else {
      (L as any).setPosition?.(this.camPos.x, this.camPos.y, this.camPos.z);
      (L as any).setOrientation?.(this.camFwd.x, this.camFwd.y, this.camFwd.z, this.camUp.x, this.camUp.y, this.camUp.z);
    }

    // Ambience targets by phase.
    const inWorld = ctx.isGameplayPhase() || ctx.phase === 'deploying';
    const windTarget = inWorld ? (ctx.phase === 'deploying' ? 0.05 : 0.16) : (ctx.phase === 'menu' ? 0.06 : 0.08);
    this.amb.wind?.gain.gain.setTargetAtTime(windTarget, now, 0.6);

    // Tension: rises as countdown runs out.
    if (this.amb.tension) {
      let level = 0;
      if (ctx.phase === 'extracting') {
        const frac = 1 - this.countdownRemaining / Math.max(1, this.countdownTotal);
        level = 0.08 + frac * 0.14;
        this.tensionRate = 0.8 + frac * 5.2;
      } else if (ctx.phase === 'shipLanded') { level = 0.07; this.tensionRate = 2.5; }
      this.tensionTarget = level;
      this.amb.tension.gain.gain.setTargetAtTime(this.tensionTarget, now, 0.8);
      this.amb.tension.lfo.frequency.setTargetAtTime(this.tensionRate, now, 0.5);
    }

    // Engine hum while ship present; fades after liftoff.
    if (this.amb.engine) {
      if (this.liftoffTimer >= 0) {
        this.liftoffTimer -= dt;
        if (this.liftoffTimer < 3) this.engineTarget = Math.max(0, this.liftoffTimer / 3) * 0.9;
        if (this.liftoffTimer < 0) { this.engineTarget = 0; this.shipPresent = false; this.liftoffTimer = -1; }
      }
      const e = this.amb.engine;
      e.gain.gain.setTargetAtTime(this.shipPresent ? this.engineTarget * 0.28 : 0, now, 0.5);
      const f = this.engineTarget > 0.5 ? 620 : 320;
      e.filter.frequency.setTargetAtTime(f, now, 0.8);
      e.osc.frequency.setTargetAtTime(this.engineTarget > 0.5 ? 62 : 48, now, 1.0);
      e.osc2.frequency.setTargetAtTime(this.engineTarget > 0.5 ? 64.7 : 50.3, now, 1.0);
    }

    void this.tmp;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    for (const u of this.unlockHandlers) u();
    if (this.ac) { void this.ac.close().catch(() => { /* ignore */ }); this.ac = null; }
  }
}
