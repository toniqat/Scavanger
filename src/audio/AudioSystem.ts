import * as THREE from 'three';
import type { AudioChannel, AudioRef, AudioSettings, GameContext, GameSystem } from '@/shared';
import { AUDIO_DEFAULT_MASTER, AUDIO_DEFAULT_SFX, AUDIO_STORAGE_KEY } from '@/shared';
import { Synth, SOUNDS } from './Synth';

const RATE_WINDOW = 0.1;       // seconds
const RATE_MAX_SAME = 8;       // max identical ids per window
const DEDUPE_WINDOW = 0.1;     // auto-hook vs explicit `audio:play` of the same id

/* ── Phase 8: volume settings ─────────────────────────────────────────── */
/** `setTargetAtTime` time constant for a volume change — fast enough to feel instant, slow enough not to click. */
const VOLUME_RAMP = 0.03;
/** Master multiplier while `game:paused` (the classic 25 % duck), applied on top of the master setting. */
const PAUSE_DUCK = 0.25;
const SETTINGS_SAVE_DEBOUNCE_MS = 250;
/** One short reference sound per channel for `preview()`; both run through the sfx bus. */
const PREVIEW_SOUND: Record<AudioChannel, { id: string; volume: number }> = {
  master: { id: 'ui_click', volume: 0.8 },
  sfx: { id: 'shot_pistol', volume: 0.7 },
};
/** Dragging a slider must not machine-gun the preview. */
const PREVIEW_MIN_INTERVAL_MS = 140;
const SETTINGS_SAVE_VERSION = 1;

interface Ambient {
  wind: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; lfo: OscillatorNode } | null;
  tension: { osc: OscillatorNode; osc2: OscillatorNode; trem: GainNode; lfo: OscillatorNode; gain: GainNode } | null;
  engine: { osc: OscillatorNode; osc2: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null;
  /** Ship-interior hum + ventilation loop (hub / docking phases only). */
  hub: { filter: BiquadFilterNode; gain: GainNode; vent: GainNode } | null;
}

const RECONNECT_WARN_INTERVAL_MS = 5000;
/** A `pickup:spawned` this soon after our own `inventory:itemDropped` is the thrown item → no landing tick. */
const LOCAL_DROP_SPAWN_WINDOW = 0.15;

/**
 * Procedural WebAudio SFX + ambience. Plays `audio:play {id, position, volume, pitch}` and auto-hooks
 * gameplay events that don't send their own audio. Positional sounds are spatialized with a PannerNode.
 */
export class AudioSystem implements GameSystem, AudioRef {
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
  private amb: Ambient = { wind: null, tension: null, engine: null, hub: null };
  /** Set on `hub:entered`, cleared on `hub:left` / `game:newMission`. Silences planet wind + ship engine. */
  private hubActive = false;
  private lastLaunchSecond = -1;
  private lastReconnectWarn = -Infinity;
  private lastLocalDrop = -Infinity;
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
  /* tactical kit: barrier state, so `implant:barrierChanged` can tell deploy / stow / break apart. */
  private barrierActive = false;
  private barrierHp = 0;

  private camPos = new THREE.Vector3();
  private camFwd = new THREE.Vector3();
  private camUp = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  /* ── Phase 8: volume settings (`ctx.audio`) ────────────────────────── */
  private _settings: AudioSettings = { master: AUDIO_DEFAULT_MASTER, sfx: AUDIO_DEFAULT_SFX };
  /** True while `game:paused` — the master gain is the setting × PAUSE_DUCK. */
  private ducked = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPreview = -Infinity;

  /** 0 … 1 per channel; persisted in `localStorage[AUDIO_STORAGE_KEY]`. */
  get settings(): Readonly<AudioSettings> { return this._settings; }
  /** Legacy alias kept for readability inside this folder — the master channel level (without the pause duck). */
  get masterVolume(): number { return this._settings.master; }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.audio = this;
    this.loadSettings(); // before the graph is built so the first gains are correct
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
      // Phase 7: `player:dived` is the roll (the dive was replaced) — only the positional `roll` one-shot below plays now.
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

      // enemies (EnemySystem emits its own bug_* audio:play; we only add the wave alarm). Combat-only: never in the hub.
      b.on('enemy:waveStarted', () => { if (ctx.isGameplayPhase()) auto('wave_alarm'); }),

      // inventory / crates
      b.on('inventory:opened', () => auto('ui_open')),
      b.on('inventory:closed', () => auto('ui_close')),
      b.on('inventory:itemAdded', () => auto('ui_pickup')),
      b.on('inventory:full', () => auto('ui_error')),
      b.on('inventory:itemRotated', () => auto('ui_rotate')),
      b.on('crate:open', ({ position }) => auto('crate_open', position)),

      // pings / map / input
      b.on('ping:placed', ({ position, kind }) => {
        // v2 kinds have their own sounds; the original kinds keep the `ping` chirp.
        if (kind === 'attack') { auto('ping_attack', position, 0.85); return; }
        if (kind === 'caution') { auto('ping_caution', position, 0.8); return; }
        if (kind === 'item') { auto('ping_item', position, 0.65); return; }
        // enemy: higher + urgent; extraction: lower + calmer; crate slightly low; ground neutral.
        const pitch = kind === 'enemy' ? 1.35 : kind === 'extraction' ? 0.8 : kind === 'crate' ? 0.92 : 1;
        auto('ping', position, kind === 'enemy' ? 0.85 : 0.7, pitch);
      }),

      // chat (own lines get a quiet click; system lines are silent; 'ping' lines are covered by the ping sound itself)
      b.on('chat:message', ({ kind, local }) => {
        if (kind === 'system' || kind === 'ping') return;
        if (local) { auto('ui_click', undefined, 0.35); return; }
        if (kind === 'request') auto('chat_request', undefined, 0.75);
        else auto('chat_blip', undefined, 0.6);
      }),
      b.on('ui:chatToggled', ({ open }) => auto(open ? 'chat_open' : 'chat_close', undefined, 0.5)),

      // drop / pickups
      b.on('inventory:itemDropped', ({ position }) => {
        this.lastLocalDrop = this.ac ? this.ac.currentTime : -Infinity;
        auto('item_toss', position, 0.7, 0.95 + Math.random() * 0.1);
      }),
      b.on('pickup:spawned', ({ position }) => {
        // Our own drop spawns its pickup in the same frame as the toss; skip the landing tick for it.
        if (this.ac && this.ac.currentTime - this.lastLocalDrop < LOCAL_DROP_SPAWN_WINDOW) return;
        auto('pickup_land', position, 0.3, 0.9 + Math.random() * 0.2);
      }),
      // `pickup:taken` is intentionally NOT hooked: PickupSystem sends `audio:play {id:'pickup'}` itself on a local take.

      // ship hub
      b.on('hub:entered', () => {
        this.hubActive = true; this.lastLaunchSecond = -1;
        this.shipPresent = false; this.engineTarget = 0; this.tensionTarget = 0; this.liftoffTimer = -1;
      }),
      b.on('hub:left', () => { this.hubActive = false; this.lastLaunchSecond = -1; }),
      b.on('hub:docking', ({ stage }) => {
        if (stage === 'start') auto('hub_dock_thrusters', undefined, 0.8);
        else auto('hub_dock_clamp', undefined, 0.85);
      }),
      b.on('hub:slotChanged', ({ local, peerId }) => { if (local) auto('pod_door', undefined, 0.7, peerId === null ? 0.9 : 1); }),
      b.on('hub:launchCountdown', ({ seconds }) => {
        if (seconds > 0) {
          if (seconds === this.lastLaunchSecond) return; // one beep per second even if it ticks more often
          this.lastLaunchSecond = seconds;
          auto('countdown_beep', undefined, 0.6, seconds <= 3 ? 1.25 : 1);
        } else if (this.lastLaunchSecond !== 0) {
          this.lastLaunchSecond = 0;
          auto('launch_rumble', undefined, 0.9);
        }
      }),
      b.on('ui:hubMenuToggled', () => auto('ui_click', undefined, 0.6)),

      // net / reconnection
      b.on('net:reconnecting', () => {
        const now = performance.now();
        if (now - this.lastReconnectWarn < RECONNECT_WARN_INTERVAL_MS) return;
        this.lastReconnectWarn = now;
        auto('net_warning', undefined, 0.7);
      }),
      b.on('net:resumed', () => auto('net_resumed', undefined, 0.7)),
      b.on('net:matched', () => auto('net_matched', undefined, 0.7)),
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

      /* ══ tactical kit ══════════════════════════════════════════════════ */
      // melee / movement (weapons resolves the swing but may also send its own audio:play — dedupe covers it)
      b.on('melee:swing', () => auto('melee_swing', undefined, 0.8, 0.95 + Math.random() * 0.12)),
      b.on('melee:hit', ({ point, killed }) => auto('melee_hit', point, killed ? 1 : 0.85, killed ? 0.85 : 1)),
      b.on('player:dived', ({ position }) => auto('roll', position, 0.8, 0.96 + Math.random() * 0.08)),
      b.on('player:launched', ({ position }) => auto('jumppad', position, 0.8)),
      // survival states
      b.on('player:downed', () => auto('downed', undefined, 0.95)),
      b.on('player:revived', () => auto('revive', undefined, 0.9)),
      b.on('player:gritSaved', () => auto('grit_save', undefined, 0.9)),
      b.on('player:burning', ({ active }) => { if (active) auto('fire_ignite', undefined, 0.55); }),
      b.on('player:cloakChanged', ({ cloaked }) => auto(cloaked ? 'cloak_on' : 'cloak_off', undefined, 0.6)),
      // implants
      b.on('implant:activated', ({ id, position }) => { if (id === 'atlauncher') auto('rocket_fire', position, 0.95); }),
      b.on('implant:dashed', ({ position }) => auto('dash', position, 0.85)),
      b.on('implant:grappleFired', ({ origin }) => auto('grapple_fire', origin, 0.85)),
      b.on('implant:grappleAttached', ({ point }) => auto('grapple_attach', point, 0.9)),
      b.on('implant:grappleReleased', () => auto('grapple_release', undefined, 0.6)),
      b.on('implant:barrierChanged', ({ hp, active }) => {
        if (active !== this.barrierActive) {
          this.barrierActive = active;
          if (active) auto('barrier_deploy', undefined, 0.85);
          else if (hp > 0) auto('grapple_release', undefined, 0.5); // servo whir as it folds away
        }
        if (hp <= 0 && this.barrierHp > 0) auto('barrier_break', undefined, 0.95);
        this.barrierHp = hp;
      }),
      b.on('implant:barrierHit', ({ point }) => auto('barrier_hit', point, 0.7)),
      b.on('implant:scanned', ({ pulse }) => auto('scan_pulse', undefined, 0.75, 1 + Math.min(4, pulse) * 0.06)),
      b.on('implant:overcharge', ({ active }) => { if (active) auto('overcharge_beam', undefined, 0.6); }),
      b.on('implant:rocketExploded', ({ position }) => auto('rocket_explode', position, 1)),
      b.on('implant:wieldChanged', ({ wielded }) => auto(wielded ? 'ui_equip' : 'ui_close', undefined, 0.45)),
      b.on('implant:equipped', () => auto('ui_equip', undefined, 0.7)),
      // gadgets
      b.on('gadget:used', ({ id, position }) => {
        if (id === 'defib') auto('defib', position, 0.9);
        else if (id === 'cloakVeil') auto('cloak_on', position, 0.8);
        else auto('grenade_throw', position, 0.65);
      }),
      b.on('gadget:deployed', ({ kind, position }) => {
        switch (kind) {
          case 'mine': auto('mine_arm', position, 0.7); break;
          case 'domeShield': auto('dome_deploy', position, 0.85); break;
          case 'smoke': auto('smoke_hiss', position, 0.7); break;
          case 'fire': auto('fire_ignite', position, 0.85); break;
          case 'lure': auto('lure_beep', position, 0.7); break;
          default: auto('gadget_place', position, 0.85); break;
        }
      }),
      b.on('gadget:removed', ({ kind, reason }) => {
        if (reason === 'destroyed') auto(kind === 'mine' ? 'mine_explode' : 'gadget_break', undefined, 0.85);
        else if (reason === 'recovered') auto('ui_equip', undefined, 0.6);
      }),
      b.on('gadget:throwModeChanged', () => auto('ui_click', undefined, 0.5)),
      // gear upkeep, gathering, crafting, weight
      b.on('gather:collected', () => auto('gather', undefined, 0.8)),
      b.on('craft:started', () => auto('craft_start', undefined, 0.7)),
      b.on('craft:completed', () => auto('craft_done', undefined, 0.8)),
      b.on('craft:failed', ({ reason }) => { if (reason !== 'cancelled') auto('ui_error', undefined, 0.7); }),
      b.on('repair:completed', () => auto('repair_done', undefined, 0.8)),
      b.on('durability:broken', () => auto('durability_break', undefined, 0.9)),
      b.on('inventory:overloaded', ({ state }) => { if (state === 'heavy' || state === 'over') auto('ui_deny', undefined, 0.7); }),
      b.on('equip:changed', () => auto('ui_equip', undefined, 0.6)),
      // progression
      // Phase 7: `level_up` is played by the result screen (`ui/menus/RewardsBlock` → `audio:play`) when its XP bar crosses the level, not here.
      b.on('progress:skillUp', () => auto('skill_up', undefined, 0.5)),

      // flow
      b.on('game:phaseChanged', ({ phase, prev }) => {
        if (phase === 'deploying') auto('hellpod_fall');
        if (phase === 'complete') auto('mission_complete');
        if (phase === 'menu' && prev !== 'menu') auto('ui_close');
        if (phase === 'menu' || phase === 'complete' || phase === 'dead' || phase === 'hub' || phase === 'docking') { this.tensionTarget = 0; }
        if (phase === 'menu' || phase === 'hub') { this.shipPresent = false; this.engineTarget = 0; this.liftoffTimer = -1; }
      }),
      b.on('game:newMission', () => {
        this.shipPresent = false; this.engineTarget = 0; this.tensionTarget = 0; this.liftoffTimer = -1; this.lastScope = false; this.aiming = false;
        this.hubActive = false; this.lastLaunchSecond = -1;
        this.barrierActive = false; this.barrierHp = 0;
      }),
      b.on('game:paused', ({ paused }) => {
        this.ducked = paused;
        this.applyVolumes(0.1); // slower ramp: the duck is a mood change, not a setting
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
      this.master = ac.createGain(); this.master.gain.value = this._settings.master * (this.ducked ? PAUSE_DUCK : 1);
      this.sfxBus = ac.createGain(); this.sfxBus.gain.value = this._settings.sfx;
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

    // Ship interior (hub): low hum (triangle 55 + sine 110.7 + sub saw 27.5) → lowpass, plus looped noise
    // through a slowly swept bandpass for ventilation. Distinct from the planet wind: tonal, no LFO on the sub.
    const h1 = ac.createOscillator(); h1.type = 'triangle'; h1.frequency.value = 55;
    const h2 = ac.createOscillator(); h2.type = 'sine'; h2.frequency.value = 110.7;
    const h3 = ac.createOscillator(); h3.type = 'sawtooth'; h3.frequency.value = 27.5;
    const h3g = ac.createGain(); h3g.gain.value = 0.35;
    const hf = ac.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 260; hf.Q.value = 0.8;
    const hg = ac.createGain(); hg.gain.value = 0;
    h1.connect(hf); h2.connect(hf); h3.connect(h3g).connect(hf);
    hf.connect(hg).connect(this.ambBus);
    const vsrc = ac.createBufferSource(); vsrc.buffer = (s as any).noiseBuf as AudioBuffer; vsrc.loop = true;
    const vf = ac.createBiquadFilter(); vf.type = 'bandpass'; vf.frequency.value = 900; vf.Q.value = 0.6;
    const vlfo = ac.createOscillator(); vlfo.frequency.value = 0.09;
    const vlfoG = ac.createGain(); vlfoG.gain.value = 350;
    vlfo.connect(vlfoG).connect(vf.frequency);
    const vg = ac.createGain(); vg.gain.value = 0.3;
    vsrc.connect(vf).connect(vg).connect(hg);
    h1.start(); h2.start(); h3.start(); vsrc.start(); vlfo.start();
    this.amb.hub = { filter: hf, gain: hg, vent: vg };
  }

  /* ── volume settings (`AudioRef`) ────────────────────────────────────── */
  /** Clamp, apply to the live graph, persist (debounced) and announce. Safe before the AudioContext exists. */
  setVolume(channel: AudioChannel, value: number): void {
    const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    if (this._settings[channel] === v) return;
    this._settings[channel] = v;
    this.applyVolumes();
    this.queueSave();
    this.ctx?.bus.emit('audio:volumeChanged', { channel, value: v });
  }

  /** Short reference blip so the player hears the level just set (throttled while a slider is dragged). */
  preview(channel: AudioChannel): void {
    const now = performance.now();
    if (now - this.lastPreview < PREVIEW_MIN_INTERVAL_MS) return;
    this.lastPreview = now;
    this.ensureContext(); // the click that moved the slider is a valid unlock gesture
    const s = PREVIEW_SOUND[channel] ?? PREVIEW_SOUND.master;
    this.play(s.id, undefined, s.volume, 1, false);
  }

  /** Master = setting × pause duck, sfx bus = setting. Ambience rides `ambBus` → master only (no slider). */
  private applyVolumes(ramp = VOLUME_RAMP): void {
    if (!this.ac) return;
    const now = this.ac.currentTime;
    const master = this._settings.master * (this.ducked ? PAUSE_DUCK : 1);
    this.master.gain.setTargetAtTime(master, now, ramp);
    this.sfxBus.gain.setTargetAtTime(this._settings.sfx, now, ramp);
  }

  private loadSettings(): void {
    try {
      const raw = localStorage.getItem(AUDIO_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { master?: unknown; sfx?: unknown };
      if (typeof parsed !== 'object' || parsed === null) return;
      const num = (v: unknown, fallback: number): number =>
        typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
      this._settings = {
        master: num(parsed.master, AUDIO_DEFAULT_MASTER),
        sfx: num(parsed.sfx, AUDIO_DEFAULT_SFX),
      };
    } catch { /* corrupt or unavailable storage → defaults */ }
  }

  private queueSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveSettings(); }, SETTINGS_SAVE_DEBOUNCE_MS);
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify({ v: SETTINGS_SAVE_VERSION, ...this._settings }));
    } catch { /* private mode / quota → keep the session values only */ }
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

    // Ambience targets by phase. The hub is not gameplay: planet wind + ship engine are silenced, interior hum runs.
    const inHub = this.hubActive || ctx.phase === 'hub' || ctx.phase === 'docking';
    const inWorld = !inHub && (ctx.isGameplayPhase() || ctx.phase === 'deploying');
    const windTarget = inHub ? 0 : inWorld ? (ctx.phase === 'deploying' ? 0.05 : 0.16) : (ctx.phase === 'menu' ? 0.06 : 0.08);
    this.amb.wind?.gain.gain.setTargetAtTime(windTarget, now, 0.6);
    if (this.amb.hub) {
      const docking = ctx.phase === 'docking';
      this.amb.hub.gain.gain.setTargetAtTime(inHub ? (docking ? 0.22 : 0.15) : 0, now, inHub ? 0.8 : 0.4);
      this.amb.hub.filter.frequency.setTargetAtTime(docking ? 420 : 260, now, 0.8);
      this.amb.hub.vent.gain.setTargetAtTime(docking ? 0.15 : 0.3, now, 0.8);
    }

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
      e.gain.gain.setTargetAtTime(this.shipPresent && !inHub ? this.engineTarget * 0.28 : 0, now, 0.5);
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
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; this.saveSettings(); }
    if (this.ctx?.audio === this) this.ctx.audio = null;
    if (this.ac) { void this.ac.close().catch(() => { /* ignore */ }); this.ac = null; }
  }
}
