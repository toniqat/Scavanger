import * as THREE from 'three';
import type { AudioChannel, AudioRef, AudioSettings, GameContext, GameSystem, PeerId, Stance, SurfaceMaterial } from '@/shared';
import {
  numberMap,
  AUDIO_DEFAULT_MASTER, AUDIO_DEFAULT_SFX, AUDIO_DEFAULT_BGM, AUDIO_STORAGE_KEY,
  DRONE_GADGET_OF, DRONE_NOISE_RADIUS,
  FOOTSTEP_AUDIBLE_RANGE, FOOTSTEP_FALLOFF_EXP, FOOTSTEP_REMOTE_GAIN,
  FOOTSTEP_VOL_CROUCH, FOOTSTEP_VOL_PRONE, FOOTSTEP_VOL_SPRINT, FOOTSTEP_VOL_WALK,
  ROGUE_DROP_ALARM_VOLUME, ROGUE_DROP_ALERT_FALLOFF_EXP, ROGUE_DROP_ALERT_RADIUS,
  ROGUE_DROP_FALL_LEAD_S, ROGUE_DROP_FALL_VOLUME, ROGUE_DROP_MIN_VOLUME,
  /* 2026-09-15: the fall landing (B-14) */
  FALL_REMOTE_SOUND_RANGE, FALL_VIGNETTE_FULL_DAMAGE,
  /* 2026-09-13: the rover */
  ROVER_CLANG_GAP_S, ROVER_TRIP_SPEED,
  /* 2026-09-16: bug sounds — burrowing up · footsteps · the incoming shell whistle */
  BUG_STEP_GIANT_RANGE_M, BUG_STEP_RANGE_M, BUG_STEP_VOICE_CAP, BURROW_EMERGE_VOICE_CAP,
  SHELL_INCOMING_FLOOR, SHELL_INCOMING_LEAD_S, SHELL_INCOMING_RANGE_M, SHELL_INCOMING_VOICE_CAP, SHELL_INCOMING_VOLUME,
  SHELL_LAUNCH_RANGE_M, shellLaunchVelocity, shellPositionAt,
} from '@/shared';
/* 2026-09-13 (the cooking minigame): keeps a cook bench dish from doubling the craft-done sound */
import { cookStepsOf } from '@/shared';
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
  // 2026-09-14: nothing is wired to the bgm channel yet — its preview is a neutral blip on the sfx bus.
  bgm: { id: 'ui_click', volume: 0.5 },
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
  /**
   * The window warp (2026-09-09): drive hum that follows `hub:warpProgress.speed`
   * (detuned saws + rushing noise → lowpass).
   */
  warp: { osc: OscillatorNode; osc2: OscillatorNode; filter: BiquadFilterNode; gain: GainNode; rush: GainNode } | null;
}

/** Seconds without a `hub:warpProgress` after which the warp hum is treated as over (a cancelled trip emits no `end`). */
const WARP_HUM_HOLD_S = 0.3;

/* ── footsteps (2026-09-10) ──────────────────────────────────────────
 * The volumes (per stance · range · falloff exponent) are all in `data/constants.csv`. What stays here is only the
 * pitch multipliers, **the sound itself** — the tone of a surface stepped on in a stance, not a balance number.
 */
const FOOTSTEP_PITCH_SPRINT = 1.05;
const FOOTSTEP_PITCH_CROUCH = 0.96;
const FOOTSTEP_PITCH_PRONE = 0.9;
/** Quieter than this and no voice is made at all (no silent playback at the far edge of the range). */
const FOOTSTEP_MIN_VOLUME = 0.012;

/* ── footsteps by material (2026-09-11, C-22) ───────────────────────
 * The surface stepped on (`WorldRef.getSurfaceMaterial`) picks the sound id — the 11 `footstep_<SurfaceMaterial>`
 * (`Synth`). Inside the ship (hub · docking phases) the material is **metal by phase**, not by `WorldRef` (the local
 * player's own steps included — it replaces the old `FOOTSTEP_PITCH_DECK` 1.16 pitch hack, which only hit remotes).
 * The multiplier that levels each material by ear is csv (`FOOTSTEP_MATERIAL_GAIN`). It is a
 * `Record<SurfaceMaterial, …>`, so a material added to the contract is a type error right here.
 */
const FOOTSTEP_ID: Readonly<Record<SurfaceMaterial, string>> = {
  dirt: 'footstep_dirt', sand: 'footstep_sand', snow: 'footstep_snow', mud: 'footstep_mud', moss: 'footstep_moss',
  ash: 'footstep_ash', rock: 'footstep_rock', crystal: 'footstep_crystal', organic: 'footstep_organic',
  metal: 'footstep_metal', concrete: 'footstep_concrete',
};
const FOOTSTEP_MATERIAL_GAIN: Readonly<Partial<Record<SurfaceMaterial, number>>> = numberMap<SurfaceMaterial>('tables.csv', 'FOOTSTEP_MATERIAL_GAIN');
/** id → material multiplier (an enemy footstep arrives only as an `audio:play` id, so it is found by id). */
const FOOTSTEP_GAIN_BY_ID: Readonly<Record<string, number>> = Object.fromEntries(
  (Object.keys(FOOTSTEP_ID) as SurfaceMaterial[]).map((m) => [FOOTSTEP_ID[m], FOOTSTEP_MATERIAL_GAIN[m] ?? 1]),
);
/**
 * The distance curve for enemy footsteps (2026-09-11 C-23 · X-3). Enemies emit them as a positional
 * `audio:play {footstep_<mat>}`, so all 11 ids go into `RANGED_SOUNDS` below through this one line — they carry
 * further than a remote squadmate's steps (`FOOTSTEP_AUDIBLE_RANGE` 26 m), and in exchange the base volume is set
 * by the caller (`enemies/model.stepSound`'s per-type gain — a behemoth is loud, a warrior quiet).
 * It used to be the emitter's linear falloff × the panner's inverse multiplied **twice**: 0.06 at 20 m.
 * (Local and remote squadmate steps never ride this curve — `footstep()` calls `play` directly.)
 */
const ENEMY_STEP_RANGE: RangeProfile = { range: 45, exp: 1.5 };

/* ── the rogue drop (2026-09-10) ───────────────────────────────────
 * The pitches stay in code because they are "the sound itself" (the same rule as the footstep pitches). Volume ·
 * radius · falloff exponent are csv.
 */
/** The alarm's pitch — a little above the friendly wave alarm (`wave_alarm`), so it reads as "theirs". */
const ROGUE_DROP_ALARM_PITCH = 1.06;
/** The fall roar's pitch — it sits lower than a friendly hellpod. */
const ROGUE_DROP_FALL_PITCH = 0.88;
/** This long after the landing the drop is dropped from tracking (for a drop whose landing never broadcast). */
const ROGUE_DROP_FORGET_S = 3;

/* ── the fall landing (2026-09-15, B-14) ──────────────────────────────
 * damage → weight k = min(1, damage / `FALL_VIGNETTE_FULL_DAMAGE`) — the same yardstick as the damage at which the
 * HUD vignette is deepest, so 「the sound is heaviest when the screen is reddest」. What follows is the sound itself
 * (pitch · the balance between the layers), so it stays in code (the same rule as the footstep pitches). A
 * squadmate's landing takes its range and exponent from the one `RANGED_SOUNDS.fall_impact` line.
 */
const FALL_PITCH_LIGHT = 1.15;
const FALL_PITCH_HEAVY = 0.8;
const FALL_VOL_LIGHT = 0.55;
const FALL_VOL_HEAVY = 1;
/**
 * The material footstep layered on top = the sprint step (`FOOTSTEP_VOL_SPRINT`) × this multiplier (light → heavy).
 * The pitch is pushed down a little to carry the weight.
 */
const FALL_STEP_GAIN_LIGHT = 1.3;
const FALL_STEP_GAIN_HEAVY = 2.2;
const FALL_STEP_PITCH_LIGHT = 0.92;
const FALL_STEP_PITCH_HEAVY = 0.78;

/* ── sounds with a distance curve (2026-09-11) ──────────────────
 * Drones · remote mines · named rogues cannot get their character from the default panner (inverse, ref 4 m) — a
 * ground drone walking has to stay beside its owner, a sniper shot has to carry almost the width of the map. So
 * when `audio:play` comes with a position, the ids in this table multiply the caller's volume by the **same curve**
 * `(1 − d/range)^exp` as remote footsteps and the rogue drop, and the panner only handles direction (`panOnly`).
 * Beyond `range` no voice is made at all.
 *
 * `floor` = the smallest fraction guaranteed inside the range. Only sounds that are **fair only if their warning is
 * heard** have one (the sniper glint · the sniper shot · the scan pulse). It falls to 0 over the last
 * `RANGED_FLOOR_EDGE` of the range, so nothing cuts off abruptly at the edge.
 *
 * These radii are **presentation for the player's ear** and no gameplay judgement reads them — a sound that does
 * have a judgement radius binds to that contract constant: a sprinting ground drone carries a little further than
 * the `DRONE_NOISE_RADIUS` the enemies hear, so there is never a "they heard it and I did not".
 */
interface RangeProfile { range: number; exp: number; floor?: number }
const RANGED_SOUNDS: Readonly<Record<string, RangeProfile>> = {
  drone_deploy: { range: 30, exp: 1.5 },
  drone_move: { range: 12, exp: 1.8 },
  drone_sprint: { range: DRONE_NOISE_RADIUS * 1.5, exp: 1.3 },
  drone_jump: { range: 30, exp: 1.5 },
  drone_land: { range: 30, exp: 1.5 },
  drone_rotor: { range: 45, exp: 1.4 },
  drone_hit: { range: 40, exp: 1.4 },
  drone_destroyed: { range: 90, exp: 1.2 },
  drone_recover: { range: 30, exp: 1.5 },
  c4_place: { range: 20, exp: 1.5 },
  c4_arm: { range: 18, exp: 1.6 },
  c4_beep: { range: 8, exp: 1.8 },
  scan_drone_hum: { range: 120, exp: 1.2 },
  scan_pulse: { range: 180, exp: 1.0, floor: 0.25 },
  sniper_glint: { range: 260, exp: 0.9, floor: 0.4 },
  sniper_shot: { range: 900, exp: 0.8, floor: 0.3 },
  hammer_swing: { range: 30, exp: 1.5 },
  hammer_impact: { range: 70, exp: 1.2 },
  minigun_spinup: { range: 90, exp: 1.2 },
  minigun_fire: { range: 220, exp: 1.0, floor: 0.1 },
  minigun_spindown: { range: 90, exp: 1.2 },
  // 2026-09-13: burrow spawns · the sandworm (enemies/). Rumble · eruption · roar must carry to be fair — floor.
  burrow_emerge: { range: 40, exp: 1.5 },
  sandworm_rumble: { range: 200, exp: 1.0, floor: 0.3 },
  sandworm_erupt: { range: 260, exp: 0.9, floor: 0.3 },
  sandworm_roar: { range: 220, exp: 1.0, floor: 0.2 },
  sandworm_spit: { range: 90, exp: 1.2 },
  sandworm_death: { range: 200, exp: 1.0, floor: 0.15 },
  // 2026-09-11 (C-23): enemy footsteps — the 11 per-material ids share one curve (`ENEMY_STEP_RANGE` above)
  ...Object.fromEntries(Object.values(FOOTSTEP_ID).map((id) => [id, ENEMY_STEP_RANGE])),
  // 2026-09-13: the android servo layers over the material footstep, so it needs the same curve to not carry further
  android_step: ENEMY_STEP_RANGE,
  // 2026-09-13: the rover (world/rover). Only the destruction blast has to carry — floor.
  rover_engine: { range: 70, exp: 1.4 },
  rover_depart: { range: 120, exp: 1.2 },
  rover_shot: { range: 160, exp: 1.0 },
  rover_hatch: { range: 25, exp: 1.5 },
  rover_brake: { range: 60, exp: 1.3 },
  rover_clang: { range: 45, exp: 1.4 },
  rover_explode: { range: 320, exp: 0.9, floor: 0.2 },
  // 2026-09-15 (B-14): a squadmate's landing — the remote footstep exponent, and the range player filters
  // `FallMessage` by, verbatim (the curve reaches 0 at the edge, so it meets player's cut without a hard stop).
  fall_impact: { range: FALL_REMOTE_SOUND_RANGE, exp: FOOTSTEP_FALLOFF_EXP },
  // 2026-09-15 (B-16): fire zones (enemies · gadgets). The ignition carries a little, the crackle only nearby —
  // with several zones it is `VOICE_CAP` that cuts.
  fire_ignite: { range: 40, exp: 1.3 },
  fire_crackle: { range: 32, exp: 1.5 },
  // 2026-09-15 (gadgets, the thumper): the ground strike — heard a little past THUMPER_SHAKE_RADIUS (30 m)
  thumper_thump: { range: 55, exp: 1.3 },
  // 2026-09-16: bug footsteps — shorter than a person's 45 m `ENEMY_STEP_RANGE`, the behemoth alone a bit further.
  // The three ids share one cap through `VOICE_GROUP`; the swarm's 1/√n is multiplied in by the emitter
  // (`enemies/model.emitEnemyStep`).
  // 2026-09-18 (user's decision 「벌레 발소리가 너무 안 난다 — 뒤에 있으면 소리로 알아차리게」): exponent 1.4 / 1.3 → 1.0
  // (linear) — a bug 10 m behind you was 0.43 on the old curve (22 m, ^1.4) and is 0.69 now (32 m, ^1). The base
  // volumes were raised in `STEP_VOICES`.
  bug_step_skitter: { range: BUG_STEP_RANGE_M, exp: 1.0 },
  bug_step_heavy: { range: BUG_STEP_RANGE_M, exp: 1.0 },
  bug_step_giant: { range: BUG_STEP_GIANT_RANGE_M, exp: 1.0 },
  // 2026-09-16: artillery — the launch thump carries past engagement range, the whistle is measured to the
  // **impact point** (floor = a fair warning; `updateShells`).
  shell_launch: { range: SHELL_LAUNCH_RANGE_M, exp: 1.1 },
  shell_incoming: { range: SHELL_INCOMING_RANGE_M, exp: 1.2, floor: SHELL_INCOMING_FLOOR },
};
/** Gap (s) between rover engine clips — `rover_engine` is a little longer than this, so the clips run together. */
const ROVER_ENGINE_STEP_S = 0.5;
/** `floor` falls linearly to 0 over this fraction of the range at its far edge. */
const RANGED_FLOOR_EDGE = 0.15;
/** Quieter than this and no voice is made at all. */
const RANGED_MIN_VOLUME = 0.01;
/**
 * The cap on **simultaneous voices** of one id (2026-09-15, B-16). `RATE_MAX_SAME` only cuts the frequency inside a
 * 100 ms window, so the ≈1 s `fire_crackle` called every 0.7 s stacks past twenty voices with twenty zones burning.
 * At the cap a new sound is **not made** when it is no louder than the quietest one currently playing; when it is
 * louder, the quietest is faded out over `VOICE_STEAL_FADE` and hands its slot over. The volume has already been
 * through the `RANGED_SOUNDS` distance curve, so this is the same as 「the nearest zone wins」. One zone overlaps
 * two clips (0.95 s / 0.7 s), so 8 = the four nearest zones.
 */
const VOICE_CAP: Readonly<Record<string, number>> = {
  fire_crackle: 8, fire_ignite: 4,
  // 2026-09-16: the three bug step ids are one group (`VOICE_GROUP`) — past ten walking bugs, only the near ones.
  // The burrow emerge plays per bug, hence a cap.
  bug_steps: BUG_STEP_VOICE_CAP, burrow_emerge: BURROW_EMERGE_VOICE_CAP, shell_incoming: SHELL_INCOMING_VOICE_CAP,
};
/**
 * 2026-09-16: id → the voice group that shares a cap (with none, the id is its own group). A group name is chosen
 * so it cannot collide with a sound id (`bug_steps` ≠ the hunter's landing tick `bug_step`).
 */
const VOICE_GROUP: Readonly<Record<string, string>> = { bug_step_skitter: 'bug_steps', bug_step_heavy: 'bug_steps', bug_step_giant: 'bug_steps' };
/** Fade time constant (s) for a stolen voice — just long enough that cutting it makes no click. */
const VOICE_STEAL_FADE = 0.04;
/**
 * One live voice — it goes into its `VOICE_CAP` group's list and `play` returns it (2026-09-16: the incoming shell
 * whistle moves its panner and volume every frame and cuts it on impact). `stolen` = faded out by the cap (never
 * brought back up). `panner` = only when there is a position.
 */
interface CappedVoice { end: number; vol: number; gain: GainNode; panner: PannerNode | null; stolen: boolean }

/* ── the incoming shell whistle (2026-09-16) ─────────────────────
 * `enemy:shellFired` comes from both the host (`enemies/parts/Attacks.fireShell`) and the replica
 * (`RemoteFx.shellVisual`), so everyone hears it. Range · floor · lead · volume · cap are csv; what follows are
 * sound-handling constants — the number of tracking slots, the fades.
 */
const SHELL_TRACK_MAX = 8;
/** This long (s) past the impact time with no landed · intercepted broadcast, tracking is given up. */
const SHELL_FORGET_S = 1;
/** With less flight left than this the whistle is not started (a late broadcast — it would be cut as it begins). */
const SHELL_INCOMING_MIN_S = 0.35;
/** Fade time constant (s) that cuts the whistle on impact · interception — the blast covers it. */
const SHELL_STOP_FADE = 0.03;
/** Time constant (s) for re-applying the impact-point distance curve each frame — running away fades it down. */
const SHELL_GAIN_RAMP = 0.08;
/** The launch thump's base volume (before the distance curve). */
const SHELL_LAUNCH_VOLUME = 0.85;
/**
 * One shell in flight — its trajectory is the closed form in `shared/ballistics` (the same function
 * `enemies/fx/ShellProjectile` and the HUD use).
 */
interface IncomingShell {
  active: boolean; sid: number; firedAt: number; flight: number; started: boolean; voice: CappedVoice | null;
  readonly from: THREE.Vector3; readonly vel0: THREE.Vector3; readonly impact: THREE.Vector3; readonly pos: THREE.Vector3;
}
/** `drone_deploy` stands in for a drone item's `gadget:used` (no throw whoosh layered on top). */
const DRONE_GADGET_IDS: readonly string[] = Object.values(DRONE_GADGET_OF);

/** One announced drop whose roar is still waiting for the moment before it lands. */
interface DropSound { id: string; pos: THREE.Vector3; landsAt: number; roared: boolean }

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
  private amb: Ambient = { wind: null, tension: null, engine: null, hub: null, warp: null };
  /** Set on `hub:entered`, cleared on `hub:left` / `game:newMission`. Silences planet wind + ship engine. */
  private hubActive = false;
  /** Last `hub:warpProgress.speed` (0..1) and the seconds left before it is forgotten (`WARP_HUM_HOLD_S`). */
  private warpSpeed = 0;
  private warpHold = 0;
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

  /** Rogue drops between the announcement and the landing (2026-09-10) — waiting for the moment to roar. */
  private drops: DropSound[] = [];
  /* 2026-09-13: the rover — the next engine clip's time · the speed estimate · the gap between hit sounds */
  private roverEngineNext = 0;
  private readonly roverLastPos = new THREE.Vector3();
  private roverHasLast = false;
  private roverLastClang = -Infinity;
  /** 2026-09-15 (B-16): the live voices per `VOICE_CAP` id (`play` clears out the finished ones as it goes). */
  private cappedVoices = new Map<string, CappedVoice[]>();
  /** 2026-09-16: incoming artillery shells — pre-made slots (when they are full the oldest is reused). */
  private incoming: IncomingShell[] = Array.from({ length: SHELL_TRACK_MAX }, () => ({
    active: false, sid: -1, firedAt: 0, flight: 0, started: false, voice: null,
    from: new THREE.Vector3(), vel0: new THREE.Vector3(), impact: new THREE.Vector3(), pos: new THREE.Vector3(),
  }));

  private camPos = new THREE.Vector3();
  private camFwd = new THREE.Vector3();
  private camUp = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  /* ── Phase 8: volume settings (`ctx.audio`) ────────────────────────── */
  private _settings: AudioSettings = { master: AUDIO_DEFAULT_MASTER, sfx: AUDIO_DEFAULT_SFX, bgm: AUDIO_DEFAULT_BGM };
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
      b.on('audio:play', ({ id, position, volume, pitch }) => this.playRequested(id, position, volume, pitch)),

      // player
      b.on('player:damaged', () => auto('player_hurt', undefined, 0.9, 0.9 + Math.random() * 0.2)),
      b.on('player:died', () => auto('player_death')),
      // footsteps (2026-09-10): the local player is always the same volume with no falloff; only a remote
      // squadmate fades with distance.
      b.on('player:footstep', ({ position, sprinting }) => this.footstep(null, position, sprinting)),
      b.on('remote:footstep', ({ position, sprinting, peerId }) => this.footstep(peerId, position, sprinting)),
      // the fall landing (2026-09-15, B-14): the local player has no position and one volume, a squadmate rides
      // the distance curve. Both layer the material footstep under the foot. (`player:fell` only when damage really
      // landed; `player:remoteFell` only after player/ has filtered by member and range.)
      b.on('player:fell', ({ damage }) => this.fallImpact(null, damage)),
      b.on('player:remoteFell', ({ position, damage }) => this.fallImpact(position, damage)),
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
      // the rogue drop (2026-09-10): the alarm now, the fall roar just before the landing. Neither looks at
      // perception — both read their own dedicated radius.
      b.on('rogueDrop:incoming', ({ dropId, position, eta }) => this.rogueDropIncoming(dropId, position, eta)),
      b.on('rogueDrop:landed', ({ dropId }) => this.rogueDropDone(dropId)),
      // artillery shells (2026-09-16): the launch thump now at the launch point, the whistle from
      // `SHELL_INCOMING_LEAD_S` before impact at the shell's moving position (`updateShells`).
      b.on('enemy:shellFired', ({ sid, from, target, flightTime }) => this.shellFired(sid, from, target, flightTime)),
      b.on('enemy:shellLanded', ({ sid }) => this.shellDone(sid)),
      b.on('enemy:shellIntercepted', ({ sid }) => this.shellDone(sid)),

      // the rover (2026-09-13, world/rover). `update` chains the engine clips from the vehicle's speed.
      b.on('rover:departed', () => { const v = ctx.world?.rover?.vehicle; if (v) this.playRequested('rover_depart', v.position, 0.9, 1); }),
      b.on('rover:fired', ({ from }) => this.playRequested('rover_shot', from, 0.7, 0.95 + Math.random() * 0.1)),
      b.on('rover:boarded', ({ local }) => {
        const v = ctx.world?.rover?.vehicle;
        if (v) this.playRequested('rover_hatch', v.position, local ? 0.9 : 0.6, local ? 1 : 0.95);
      }),
      b.on('rover:arrived', () => { const v = ctx.world?.rover?.vehicle; if (v) this.playRequested('rover_brake', v.position, 0.85, 1); }),
      b.on('rover:damaged', ({ hazard }) => {
        if (hazard || ctx.time - this.roverLastClang < ROVER_CLANG_GAP_S) return;
        const v = ctx.world?.rover?.vehicle;
        if (!v) return;
        this.roverLastClang = ctx.time;
        this.playRequested('rover_clang', v.position, 0.75, 0.9 + Math.random() * 0.2);
      }),
      b.on('rover:destroyed', ({ position }) => this.playRequested('rover_explode', position, 1, 1)),
      b.on('rover:refused', () => auto('tram_deny', undefined, 0.8)),
      b.on('rover:tripStarted', ({ local }) => { if (local) auto('rover_pay', undefined, 0.7); }),

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
      b.on('hub:left', () => { this.hubActive = false; this.lastLaunchSecond = -1; this.warpSpeed = 0; this.warpHold = 0; }),
      b.on('hub:docking', ({ stage }) => {
        if (stage === 'start') auto('hub_dock_thrusters', undefined, 0.8);
        else auto('hub_dock_clamp', undefined, 0.85);
      }),
      // The window warp (2026-09-09): the hub sends `hub_dock_thrusters` / `hub_dock_clamp` itself at the ends of a
      // trip; in between, the drive hum rides `speed` (rising / falling with the ramps). No one-shot here.
      b.on('hub:warpProgress', ({ speed }) => { this.warpSpeed = Math.max(0, Math.min(1, speed)); this.warpHold = WARP_HUM_HOLD_S; }),
      b.on('hub:travel', ({ stage }) => { if (stage === 'end') { this.warpSpeed = 0; this.warpHold = 0; } }),
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
      // 2026-09-15: `implant:activated {id:'atlauncher'}`→rocket_fire and `implant:rocketExploded`→rocket_explode are gone
      // with the retired 대전차포 implant (nothing emits them any more; the synth ids stay in `SOUNDS`).
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
      b.on('implant:wieldChanged', ({ wielded }) => auto(wielded ? 'ui_equip' : 'ui_close', undefined, 0.45)),
      b.on('implant:equipped', () => auto('ui_equip', undefined, 0.7)),
      // 2026-09-12, the ready sounds: an implant = a short high electronic chirp (a charge-type implant's middle
      // charge is quieter and a little lower; the last charge · a single charge · the `안정제` get the full one), a
      // ship call = a two-note radio chime. The moment a denial refund takes it to 0 (`refunded`) is silent — the
      // denial sound already played. Both events only fire in a gameplay phase, so the phase is not re-checked here.
      b.on('implant:ready', ({ full }) => auto('implant_ready', undefined, full ? 0.55 : 0.26, full ? 1 : 0.9)),
      b.on('stratagem:ready', ({ refunded }) => { if (!refunded) auto('stratagem_ready', undefined, 0.7); }),
      // gadgets
      b.on('gadget:used', ({ id, position }) => {
        // 2026-09-11: drones (`drone_deploy`) and the remote mine (`c4_place`) are voiced by gadgets/ itself.
        if (DRONE_GADGET_IDS.includes(id) || id === 'remoteMine') return;
        if (id === 'defib') auto('defib', position, 0.9);
        else if (id === 'cloakVeil') auto('cloak_on', position, 0.8);
        else auto('grenade_throw', position, 0.65);
      }),
      b.on('gadget:deployed', ({ kind, position }) => {
        switch (kind) {
          case 'mine': auto('mine_arm', position, 0.7); break;
          case 'domeShield': auto('dome_deploy', position, 0.85); break;
          case 'smoke': auto('smoke_hiss', position, 0.7); break;
          // 2026-09-15 (B-16): gadgets/ owns fire zones and emits `audio:play fire_ignite` too — it has to take
          // the same distance curve so dedupe leaves the same sound whichever arrives first (the auto flag is
          // unchanged, so the two collapse into one).
          case 'fire': this.playRequested('fire_ignite', position, 0.85, 1, true); break;
          case 'lure': auto('lure_beep', position, 0.7); break;
          case 'remoteMine': break; // 2026-09-11: gadgets/ plays `c4_place` itself
          default: auto('gadget_place', position, 0.85); break;
        }
      }),
      b.on('gadget:removed', ({ kind, reason }) => {
        // 2026-09-11: a destroyed remote mine is silent here — a detonation already played `explosion` in gadgets/
        // and this event cannot tell a dud from a detonation.
        if (reason === 'destroyed' && kind === 'remoteMine') return;
        if (reason === 'destroyed') auto(kind === 'mine' ? 'mine_explode' : 'gadget_break', undefined, 0.85);
        else if (reason === 'recovered') auto('ui_equip', undefined, 0.6);
      }),
      b.on('gadget:throwModeChanged', () => auto('ui_click', undefined, 0.5)),
      // gear upkeep, gathering, crafting, weight
      b.on('gather:collected', () => auto('gather', undefined, 0.8)),
      b.on('craft:started', () => auto('craft_start', undefined, 0.7)),
      // 2026-09-13 (the cooking minigame): housing already played `cook_finish` for a cook bench dish (an output
      // with `cookStepsOf`) — no craft click on top of it
      b.on('craft:completed', ({ item }) => { if (cookStepsOf(item?.defId ?? '').length === 0) auto('craft_done', undefined, 0.8); }),
      b.on('craft:failed', ({ reason }) => { if (reason !== 'cancelled') auto('ui_error', undefined, 0.7); }),
      b.on('repair:completed', () => auto('repair_done', undefined, 0.8)),
      // 2026-09-13 crypto mining: a cycle finished and paid into the wallet — only while in the ship (silent
      // during a raid or an offline catch-up), no distance falloff
      b.on('housing:cryptoMined', () => { if (ctx.phase === 'hub') auto('crypto_mined', undefined, 0.5); }),
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
        this.drops.length = 0;
        this.clearShells();
      }),
      b.on('game:abort', () => { this.drops.length = 0; this.clearShells(); }),
      b.on('hub:entered', () => this.clearShells()),
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

    // Window warp drive (2026-09-09): two detuned saws + a rushing noise band → lowpass → gain. Everything is a
    // target set per frame from `hub:warpProgress.speed`: pitch 38 → 90 Hz, filter 180 → 1600 Hz, gain 0 → 0.22.
    const w1 = ac.createOscillator(); w1.type = 'sawtooth'; w1.frequency.value = 38;
    const w2 = ac.createOscillator(); w2.type = 'sawtooth'; w2.frequency.value = 38.7;
    const wsub = ac.createOscillator(); wsub.type = 'sine'; wsub.frequency.value = 19;
    const wsubG = ac.createGain(); wsubG.gain.value = 0.6;
    const wf = ac.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 180; wf.Q.value = 1.6;
    const wg = ac.createGain(); wg.gain.value = 0;
    w1.connect(wf); w2.connect(wf); wsub.connect(wsubG).connect(wf);
    const wn = ac.createBufferSource(); wn.buffer = (s as any).noiseBuf as AudioBuffer; wn.loop = true;
    const wnf = ac.createBiquadFilter(); wnf.type = 'bandpass'; wnf.frequency.value = 1400; wnf.Q.value = 0.5;
    const rush = ac.createGain(); rush.gain.value = 0;
    wn.connect(wnf).connect(rush).connect(wf);
    wf.connect(wg).connect(this.ambBus);
    w1.start(); w2.start(); wsub.start(); wn.start();
    this.amb.warp = { osc: w1, osc2: w2, filter: wf, gain: wg, rush };
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
      const parsed = JSON.parse(raw) as { master?: unknown; sfx?: unknown; bgm?: unknown };
      if (typeof parsed !== 'object' || parsed === null) return;
      const num = (v: unknown, fallback: number): number =>
        typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
      this._settings = {
        master: num(parsed.master, AUDIO_DEFAULT_MASTER),
        sfx: num(parsed.sfx, AUDIO_DEFAULT_SFX),
        // Added 2026-09-14 — not in an old save. An omission means 「unknown」, not 0, so the default fills it.
        bgm: num(parsed.bgm, AUDIO_DEFAULT_BGM),
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

  /* ── footsteps (2026-09-10) ───────────────────────────────────────── */
  /** Volume by stance: sprint > walk > crouch > prone. With the stance unknown, only walk / sprint differ. */
  private footstepVolume(stance: Stance | undefined, sprinting: boolean): number {
    if (stance === 'prone') return FOOTSTEP_VOL_PRONE;
    if (stance === 'crouch') return FOOTSTEP_VOL_CROUCH;
    return sprinting ? FOOTSTEP_VOL_SPRINT : FOOTSTEP_VOL_WALK;
  }

  /**
   * The shared playback path for `player:footstep` (peerId null = the local player) and `remote:footstep`.
   *
   * - **The local player** is never attenuated — no position is given, so no panner is involved at all and the step
   *   is always the same volume.
   * - **A remote** drops by `(1 - d / FOOTSTEP_AUDIBLE_RANGE) ^ FOOTSTEP_FALLOFF_EXP` and is not played at all
   *   outside the range. The panner handles **direction only** (`panOnly`) — layering the panner's inverse falloff
   *   on top of that would attenuate twice.
   * - The stance is not on the event, so it is read from `ctx.player` / `ctx.net` (the contract stays add-only).
   * - 2026-09-11 (C-22): **the material stepped on** picks the sound (`surfaceAt` → `footstep_<mat>`, volume ×
   *   `FOOTSTEP_MATERIAL_GAIN`). Inside the ship (hub · docking) both local and remote are metal — it replaces the
   *   old remote-only deck pitch multiplier.
   * - The ids are shared with enemy footsteps, so **dedupe is skipped** — an enemy's step and mine landing within
   *   100 ms would have silenced one of them. The local player's step skips the same-id rate limit too (a swarm
   *   walking the same material never eats my own footsteps).
   */
  private footstep(peerId: PeerId | null, position: THREE.Vector3, sprinting: boolean): void {
    const ctx = this.ctx;
    const stance = peerId === null
      ? ctx?.player?.stance
      : ctx?.net?.getRemotePlayer(peerId)?.stance;
    let vol = this.footstepVolume(stance, sprinting);
    const pitch = sprinting ? FOOTSTEP_PITCH_SPRINT
      : stance === 'prone' ? FOOTSTEP_PITCH_PRONE
        : stance === 'crouch' ? FOOTSTEP_PITCH_CROUCH : 1;
    const mat = this.surfaceAt(position);
    const id = FOOTSTEP_ID[mat];
    vol *= FOOTSTEP_MATERIAL_GAIN[mat] ?? 1;
    if (peerId === null) { this.play(id, undefined, vol, pitch, true, false, false, false); return; }

    const d = this.camPos.distanceTo(position);
    if (d >= FOOTSTEP_AUDIBLE_RANGE) return;
    vol *= FOOTSTEP_REMOTE_GAIN * Math.pow(1 - d / FOOTSTEP_AUDIBLE_RANGE, FOOTSTEP_FALLOFF_EXP);
    if (vol < FOOTSTEP_MIN_VOLUME) return;
    this.play(id, position, vol, pitch, true, true, false);
  }

  /**
   * The material at foot position `p` (foot height = `p.y`). Inside the ship (hub · docking) it is `metal` by
   * phase; with the world not ready, or with no `getSurfaceMaterial` on it yet (the contract is optional), `dirt` —
   * the old single footstep tone.
   */
  private surfaceAt(p: THREE.Vector3): SurfaceMaterial {
    const ctx = this.ctx;
    if (this.hubActive || ctx?.phase === 'hub' || ctx?.phase === 'docking') return 'metal';
    const w = ctx?.world;
    if (!w || !w.ready) return 'dirt';
    const m = w.getSurfaceMaterial?.(p.x, p.z, p.y);
    return m && m in FOOTSTEP_ID ? m : 'dirt';
  }

  /* ── the fall landing (2026-09-15, B-14) ─────────────────────────── */
  /**
   * The shared path for `player:fell` (position null = the local player) and `player:remoteFell`.
   *
   * - **The local player**: no position given = no panner and always the same volume (the same handling as the
   *   local footstep). The material is read at `ctx.player.position` (the feet).
   * - **A squadmate**: the `RANGED_SOUNDS.fall_impact` curve is measured **once** and multiplied into both
   *   `fall_impact` and the material footstep, both emitted `panOnly` — direction only, so no inverse falloff on
   *   top of the curve. The material is asked for at the landing foot position.
   * - The material footstep layer skips dedupe and the rate limit for the same reason as in `footstep()` (its id is
   *   shared with enemy footsteps).
   */
  private fallImpact(position: THREE.Vector3 | null, damage: number): void {
    if (!this.ac || this.ac.state !== 'running') return;
    const dmg = Number.isFinite(damage) ? damage : 0;
    const k = Math.max(0, Math.min(1, dmg / Math.max(1, FALL_VIGNETTE_FULL_DAMAGE)));
    const lerp = (a: number, b: number) => a + (b - a) * k;
    const dist = position ? this.rangeGain(RANGED_SOUNDS.fall_impact, this.camPos.distanceTo(position)) : 1;
    const pos = position ?? undefined;
    const vol = lerp(FALL_VOL_LIGHT, FALL_VOL_HEAVY) * dist;
    if (vol < RANGED_MIN_VOLUME) return;
    this.play('fall_impact', pos, vol, lerp(FALL_PITCH_LIGHT, FALL_PITCH_HEAVY), true, !!position);

    const mat = this.surfaceAt(position ?? this.ctx?.player?.position ?? this.camPos);
    const stepVol = FOOTSTEP_VOL_SPRINT * lerp(FALL_STEP_GAIN_LIGHT, FALL_STEP_GAIN_HEAVY) * (FOOTSTEP_MATERIAL_GAIN[mat] ?? 1) * dist;
    if (stepVol >= FOOTSTEP_MIN_VOLUME) {
      this.play(FOOTSTEP_ID[mat], pos, stepVol, lerp(FALL_STEP_PITCH_LIGHT, FALL_STEP_PITCH_HEAVY), true, !!position, false, false);
    }
  }

  /* ── the rogue drop (2026-09-10) ─────────────────────────────────── */
  /**
   * The volume of a drop sound. **It does not look at the perception radius (`derived.enemyDetectRadius`)** — this
   * is a roar tearing through the air, and the requirement is that it be heard however narrow perception is, so it
   * is gated by one dedicated radius instead, `ROGUE_DROP_ALERT_RADIUS` (10× perception). Outside it the gain is
   * 0 = not played, because a drop on the far side of the map must not be audible. Inside, it falls on the same
   * curve as a remote footstep.
   */
  private dropGain(position: THREE.Vector3, base: number): number {
    const d = this.camPos.distanceTo(position);
    if (d >= ROGUE_DROP_ALERT_RADIUS) return 0;
    const v = base * Math.pow(1 - d / ROGUE_DROP_ALERT_RADIUS, ROGUE_DROP_ALERT_FALLOFF_EXP);
    return v < ROGUE_DROP_MIN_VOLUME ? 0 : v;
  }

  /**
   * `rogueDrop:incoming` — the same event arrives whether the host rolled it (`enemies/RogueDrop.call`) or a
   * replica received it as `rdrop`, so **everyone hears it in multiplayer too.** Only the alarm sounds now; the
   * roar goes out just before the landing (`update`) — spending it all 8 seconds early leaves the landing silent.
   *
   * The alarm is given **no position**: it is a warning on the squad radio, not a sound coming out of the sky (the
   * same handling as the local footstep). Direction is what the roar and the HUD danger indicator say.
   */
  private rogueDropIncoming(dropId: string, position: THREE.Vector3, eta: number): void {
    const now = this.ctx?.time ?? 0;
    const landsAt = now + Math.max(0, eta);
    const i = this.drops.findIndex((d) => d.id === dropId);
    if (i >= 0) this.drops.splice(i, 1);
    this.drops.push({ id: dropId, pos: position.clone(), landsAt, roared: false });
    const vol = this.dropGain(position, ROGUE_DROP_ALARM_VOLUME);
    if (vol > 0) this.play('rogue_drop_alarm', undefined, vol, ROGUE_DROP_ALARM_PITCH, true);
  }

  /** It landed — the roar already played and `enemies/RogueDrop` sounds the impact per pod. Only tracking ends. */
  private rogueDropDone(dropId: string): void {
    const i = this.drops.findIndex((d) => d.id === dropId);
    if (i >= 0) this.drops.splice(i, 1);
  }

  /**
   * Every frame: `ROGUE_DROP_FALL_LEAD_S` seconds before the landing the fall roar plays once. **Direction matters**
   * for the roar (which part of the sky it is coming down from), so a position is given but passed `panOnly`, so
   * the panner's inverse falloff is never layered on our curve. The falloff is measured again from the distance at
   * that moment (far away when it was announced but close now = loud).
   */
  private updateDrops(now: number): void {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      if (!d.roared && now >= d.landsAt - ROGUE_DROP_FALL_LEAD_S) {
        d.roared = true;
        const vol = this.dropGain(d.pos, ROGUE_DROP_FALL_VOLUME);
        if (vol > 0) this.play('rogue_pod_fall', d.pos, vol, ROGUE_DROP_FALL_PITCH, true, true);
      }
      if (now > d.landsAt + ROGUE_DROP_FORGET_S) this.drops.splice(i, 1);
    }
  }

  /* ── artillery shells (2026-09-16) ───────────────────────────────── */
  /**
   * `enemy:shellFired`: sounds a dull thump at the launch point (`shell_launch`, carrying past engagement range)
   * and starts tracking the shell. The same `sid` arriving again (a host transfer re-send) refreshes the slot in
   * place and leaves a whistle that is already sounding alone. With no slot free, the oldest is cut and reused.
   */
  private shellFired(sid: number, from: THREE.Vector3, target: THREE.Vector3, flightTime: number): void {
    if (!this.ctx) return;
    let slot: IncomingShell | null = null;
    for (const s of this.incoming) if (s.active && s.sid === sid) { slot = s; break; }
    const refresh = slot !== null;
    if (!slot) for (const s of this.incoming) if (!s.active) { slot = s; break; }
    if (!slot) {
      slot = this.incoming[0];
      for (const s of this.incoming) if (s.firedAt < slot.firedAt) slot = s;
      this.stopShell(slot);
    }
    const T = Math.max(0.5, flightTime);
    slot.sid = sid;
    slot.from.copy(from);
    slot.impact.copy(target);
    shellLaunchVelocity(from, target, T, slot.vel0);
    slot.flight = T;
    slot.firedAt = this.ctx.time;
    slot.active = true;
    if (refresh) return;
    slot.started = false;
    slot.voice = null;
    this.playRequested('shell_launch', from, SHELL_LAUNCH_VOLUME, 0.95 + Math.random() * 0.1, true);
  }

  /** Impact · interception: the whistle is cut short and the tracking ends. */
  private shellDone(sid: number): void {
    for (const s of this.incoming) if (s.active && s.sid === sid) this.stopShell(s);
  }

  private clearShells(): void {
    for (const s of this.incoming) if (s.active) this.stopShell(s);
  }

  private stopShell(s: IncomingShell): void {
    const v = s.voice;
    if (v && !v.stolen && this.ac && v.end > this.ac.currentTime) {
      const now = this.ac.currentTime;
      try { v.gain.gain.cancelScheduledValues(now); v.gain.gain.setTargetAtTime(0, now, SHELL_STOP_FADE); } catch { /* already gone */ }
      v.vol = 0;          // the quietest in the cap list = the next whistle takes this slot first
      v.stolen = true;
    }
    s.voice = null;
    s.active = false;
  }

  /**
   * Every frame (after camPos is updated): a shell `SHELL_INCOMING_LEAD_S` from impact starts its whistle once —
   * the volume is the `RANGED_SOUNDS.shell_incoming` curve on the **distance between the ear and the impact
   * point** (floor = a fair warning), the panner the shell's current position from `shellPositionAt` (direction
   * only). Once started, the panner rides the shell and the volume is re-applied from the current distance
   * (running away makes it quieter). Out of range at the moment it starts, that shell stays silent (a whistle
   * cannot be started from the middle). A shell whose broadcast never arrived is dropped after `SHELL_FORGET_S`.
   */
  private updateShells(now: number): void {
    const ac = this.ac;
    if (!ac) return;
    const prof = RANGED_SOUNDS.shell_incoming;
    for (const s of this.incoming) {
      if (!s.active) continue;
      const life = now - s.firedAt;
      const remain = s.flight - life;
      if (remain < -SHELL_FORGET_S) { this.stopShell(s); continue; }
      if (remain < 0) continue;
      shellPositionAt(s.from, s.vel0, Math.max(0, life), s.pos);
      const g = SHELL_INCOMING_VOLUME * this.rangeGain(prof, this.camPos.distanceTo(s.impact));
      if (!s.started) {
        if (remain > SHELL_INCOMING_LEAD_S) continue;
        s.started = true;
        if (remain >= SHELL_INCOMING_MIN_S && g >= RANGED_MIN_VOLUME) s.voice = this.play('shell_incoming', s.pos, g, 1, true, true);
        continue;
      }
      const v = s.voice;
      if (!v || v.stolen || !v.panner || v.end <= ac.currentTime) continue;
      const t = ac.currentTime;
      this.setParam(v.panner.positionX, s.pos.x, t); this.setParam(v.panner.positionY, s.pos.y, t); this.setParam(v.panner.positionZ, s.pos.z, t);
      v.gain.gain.setTargetAtTime(Math.min(2, g), t, SHELL_GAIN_RAMP);
      v.vol = g;
    }
  }

  /**
   * The rover engine (2026-09-13). No loop node: a `rover_engine` clip is played at the vehicle every
   * `ROVER_ENGINE_STEP_S` — each clip is a little longer than the gap, so they run together. Volume and pitch
   * follow the speed measured from the distance travelled between frames (the vehicle does not expose its speed).
   * A standing vehicle idles only during its departure grace (`departing`).
   */
  private updateRoverEngine(dt: number, ctx: GameContext): void {
    const rv = ctx.world?.rover;
    if (!rv || !ctx.isGameplayPhase()) { this.roverHasLast = false; return; }
    const v = rv.vehicle;
    let speed = 0;
    if (this.roverHasLast && dt > 1e-4) speed = this.roverLastPos.distanceTo(v.position) / dt;
    this.roverLastPos.copy(v.position);
    this.roverHasLast = true;
    const running = v.state === 'patrol' || v.state === 'trip' || v.state === 'departing';
    if (!running || ctx.time < this.roverEngineNext) return;
    this.roverEngineNext = ctx.time + ROVER_ENGINE_STEP_S;
    const k = Math.max(0, Math.min(1, speed / Math.max(1, ROVER_TRIP_SPEED)));
    this.playRequested('rover_engine', v.position, 0.5 + 0.4 * k, 0.78 + 0.45 * k);
  }

  /* ── the distance curve (2026-09-11) ─────────────────────────────── */
  /** The multiplier one `RANGED_SOUNDS` line gives at a distance. 0 = out of range. */
  private rangeGain(prof: RangeProfile, d: number): number {
    if (d >= prof.range) return 0;
    const k = 1 - d / prof.range;
    const curve = Math.pow(k, prof.exp);
    const floor = prof.floor ?? 0;
    if (floor <= 0) return curve;
    return curve * (1 - floor) + floor * Math.min(1, k / RANGED_FLOOR_EDGE);
  }

  /**
   * The entry point for `audio:play`. An id listed in `RANGED_SOUNDS` arriving with a position is multiplied by
   * that curve and emitted through a **direction-only** panner (so nothing attenuates twice). Everything else
   * rides the default panner as before.
   */
  private playRequested(id: string, position: THREE.Vector3 | undefined, volume: number | undefined, pitch: number | undefined, auto = false): void {
    const prof = position ? RANGED_SOUNDS[id] : undefined;
    if (!position || !prof) { this.play(id, position, volume, pitch, auto); return; }
    if (!this.ac || this.ac.state !== 'running') return;
    // 2026-09-11 (C-22): enemy steps take the material multiplier too (`footstep()` applies it for local · remote)
    const v = (volume ?? 1) * (FOOTSTEP_GAIN_BY_ID[id] ?? 1) * this.rangeGain(prof, this.camPos.distanceTo(position));
    if (v < RANGED_MIN_VOLUME) return;
    this.play(id, position, v, pitch, auto, true);
  }

  /* ── playback ────────────────────────────────────────────────────────── */
  /**
   * `panOnly` = **the caller has already computed** the distance falloff (footsteps). The panner handles direction
   * only (equalpower) and with rolloff 0 it never touches the gain — otherwise the inverse falloff layers on top
   * and attenuates twice.
   */
  private play(id: string, position: THREE.Vector3 | undefined, volume = 1, pitch = 1, auto = false, panOnly = false, dedupe = true, rateLimit = true): CappedVoice | null {
    if (!this.ac || !this.synth || this.ac.state !== 'running') return null;
    const fn = SOUNDS[id];
    if (!fn) { if (!auto) console.warn(`[Audio] unknown sound id "${id}"`); return null; }
    const now = this.ac.currentTime;
    const vol = Math.max(0, Math.min(2, volume));

    // 2026-09-15 (B-16): the simultaneous-voice cap — no louder than the quietest one currently playing and it
    // is dropped right here (before it takes a dedupe · rate-limit slot). A voice is only stolen once this sound
    // is actually made (below).
    // 2026-09-16: the cap is keyed by the voice group (`VOICE_GROUP`, else the id itself), not by the id — the
    // three bug step ids share one cap.
    const group = VOICE_GROUP[id] ?? id;
    const cap = VOICE_CAP[group];
    let capped: CappedVoice[] | undefined;
    let quietest = -1;
    if (cap !== undefined) {
      capped = this.cappedVoices.get(group);
      if (!capped) { capped = []; this.cappedVoices.set(group, capped); }
      for (let i = capped.length - 1; i >= 0; i--) if (capped[i].end <= now) capped.splice(i, 1);
      if (capped.length >= cap) {
        quietest = 0;
        for (let i = 1; i < capped.length; i++) if (capped[i].vol < capped[quietest].vol) quietest = i;
        if (capped[quietest].vol >= vol) return null;
      }
    }

    // Dedupe: same id from a different source within a short window → one plays.
    // (2026-09-11: footsteps pass `dedupe` false — material ids are shared with enemies: no check, no record.)
    if (dedupe) {
      const last = this.lastPlay.get(id);
      if (last && last.auto !== auto && now - last.t < DEDUPE_WINDOW) return null;
      this.lastPlay.set(id, { t: now, auto });
    }

    // Rate limit identical ids.
    if (rateLimit) {
      let arr = this.recent.get(id);
      if (!arr) { arr = []; this.recent.set(id, arr); }
      while (arr.length && now - arr[0] > RATE_WINDOW) arr.shift();
      if (arr.length >= RATE_MAX_SAME) return null;
      arr.push(now);
    }

    if (capped && quietest >= 0) {
      const stolen = capped.splice(quietest, 1)[0];
      stolen.stolen = true;
      try { stolen.gain.gain.cancelScheduledValues(now); stolen.gain.gain.setTargetAtTime(0, now, VOICE_STEAL_FADE); } catch { /* already gone */ }
    }

    // Voice: [synth] → gain → (panner) → sfxBus
    const g = this.ac.createGain();
    g.gain.value = vol;
    let dest: AudioNode = this.sfxBus;
    let panner: PannerNode | null = null;
    if (position) {
      const p = this.ac.createPanner();
      panner = p;
      p.panningModel = 'equalpower';
      if (panOnly) {
        // The caller's curve already applied the falloff — rolloff 0 = direction only, the gain untouched.
        p.distanceModel = 'linear'; p.refDistance = 1; p.maxDistance = 10000; p.rolloffFactor = 0;
      } else {
        p.distanceModel = 'inverse';
        p.refDistance = 4; p.maxDistance = 220; p.rolloffFactor = 1.1;
      }
      this.setParam(p.positionX, position.x, now); this.setParam(p.positionY, position.y, now); this.setParam(p.positionZ, position.z, now);
      p.connect(dest); dest = p;
      // Quick distance cull for tiny sounds (`footstep()` already filtered steps by `FOOTSTEP_AUDIBLE_RANGE`)
      if (!panOnly) {
        const d = this.camPos.distanceTo(position);
        if (d > 160 && (id === 'bug_step' || id === 'hit_terrain')) { p.disconnect(); g.disconnect(); return null; }
      }
    }
    g.connect(dest);
    const dur = fn(this.synth, g, now, Math.max(0.25, Math.min(4, pitch)));
    const voice: CappedVoice = { end: now + dur, vol, gain: g, panner, stolen: false };
    if (capped) capped.push(voice);
    // Disconnect after the sound is done so the graph doesn't grow.
    window.setTimeout(() => { try { g.disconnect(); if (dest !== this.sfxBus) dest.disconnect(); } catch { /* ignore */ } }, (dur + 0.3) * 1000);
    return voice;
  }

  /** Debug / smoke (2026-09-16): voices in a group (`VOICE_GROUP` name, else the id) still sounding (not stolen). */
  debugVoices(group: string): number {
    const list = this.cappedVoices.get(group);
    if (!list || !this.ac) return 0;
    const now = this.ac.currentTime;
    let n = 0;
    for (const v of list) if (v.end > now && !v.stolen) n++;
    return n;
  }

  /** Debug / smoke (2026-09-16): the tracked shells — has the whistle started · is it sounding · its volume. */
  debugIncomingShells(): Array<{ sid: number; started: boolean; playing: boolean; vol: number }> {
    const now = this.ac?.currentTime ?? 0;
    return this.incoming.filter((s) => s.active).map((s) => ({
      sid: s.sid, started: s.started, playing: !!s.voice && !s.voice.stolen && s.voice.end > now, vol: s.voice?.vol ?? 0,
    }));
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

    // The rogue drop: the roar just before the landing (only after camPos is updated is the falloff this frame's).
    if (this.drops.length) this.updateDrops(ctx.time);
    // The incoming shell whistle (2026-09-16) — after camPos for the same reason
    this.updateShells(ctx.time);
    // The rover engine (2026-09-13)
    this.updateRoverEngine(dt, ctx);

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

    // Window warp drive: follows the last `hub:warpProgress.speed`; forgotten after `WARP_HUM_HOLD_S` without one.
    if (this.amb.warp) {
      if (this.warpHold > 0) { this.warpHold -= dt; if (this.warpHold <= 0) this.warpSpeed = 0; }
      const s = inHub ? this.warpSpeed : 0;
      const w = this.amb.warp;
      w.gain.gain.setTargetAtTime(s * 0.22, now, 0.12);
      w.filter.frequency.setTargetAtTime(180 + s * 1420, now, 0.15);
      w.osc.frequency.setTargetAtTime(38 + s * 52, now, 0.2);
      w.osc2.frequency.setTargetAtTime(38.7 + s * 53.1, now, 0.2);
      w.rush.gain.setTargetAtTime(s * 0.55, now, 0.15);
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
