import * as THREE from 'three';
import type { AudioChannel, AudioRef, AudioSettings, GameContext, GameSystem, PeerId, Stance, SurfaceMaterial } from '@/shared';
import {
  numberMap,
  AUDIO_DEFAULT_MASTER, AUDIO_DEFAULT_SFX, AUDIO_STORAGE_KEY,
  DRONE_GADGET_OF, DRONE_NOISE_RADIUS,
  FOOTSTEP_AUDIBLE_RANGE, FOOTSTEP_FALLOFF_EXP, FOOTSTEP_REMOTE_GAIN,
  FOOTSTEP_VOL_CROUCH, FOOTSTEP_VOL_PRONE, FOOTSTEP_VOL_SPRINT, FOOTSTEP_VOL_WALK,
  ROGUE_DROP_ALARM_VOLUME, ROGUE_DROP_ALERT_FALLOFF_EXP, ROGUE_DROP_ALERT_RADIUS,
  ROGUE_DROP_FALL_LEAD_S, ROGUE_DROP_FALL_VOLUME, ROGUE_DROP_MIN_VOLUME,
} from '@/shared';
/* 2026-09-13 (요리 미니게임): 조리대 요리의 제작 완료음 겹침 방지 */
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
  /** 창문 워프 (2026-09-09): drive hum that follows `hub:warpProgress.speed` (detuned saws + rushing noise → lowpass). */
  warp: { osc: OscillatorNode; osc2: OscillatorNode; filter: BiquadFilterNode; gain: GainNode; rush: GainNode } | null;
}

/** Seconds without a `hub:warpProgress` after which the warp hum is treated as over (a cancelled trip emits no `end`). */
const WARP_HUM_HOLD_S = 0.3;

/* ── 발소리 (2026-09-10) ────────────────────────────────────────────────
 * 크기(자세별 · 사거리 · 감쇠 지수)는 전부 `data/constants.csv` 다. 여기 남는 것은 **소리 그 자체**인
 * 피치 배수뿐 — 어떤 표면을 어떤 자세로 밟았을 때의 톤이라 밸런스 수치가 아니다.
 */
const FOOTSTEP_PITCH_SPRINT = 1.05;
const FOOTSTEP_PITCH_CROUCH = 0.96;
const FOOTSTEP_PITCH_PRONE = 0.9;
/** 이보다 조용해질 바에는 보이스를 만들지 않는다 (사거리 끝자락의 무음 재생 방지). */
const FOOTSTEP_MIN_VOLUME = 0.012;

/* ── 재질별 발소리 (2026-09-11, C-22) ─────────────────────────────────────
 * 밟은 표면(`WorldRef.getSurfaceMaterial`)이 소리 id 를 고른다 — `footstep_<SurfaceMaterial>` 11종(`Synth`). 함선(허브 ·
 * 도킹 페이즈)은 `WorldRef` 가 아니라 **페이즈로 금속**이다 (본인 발소리 포함 — 옛 `FOOTSTEP_PITCH_DECK` 1.16 피치
 * 해킹이 원격에만 걸리던 것을 대신한다). 재질마다 체감 크기를 맞추는 배수는 csv (`FOOTSTEP_MATERIAL_GAIN`).
 * `Record<SurfaceMaterial, …>` 라 계약에 재질이 늘면 여기서 타입 오류가 난다.
 */
const FOOTSTEP_ID: Readonly<Record<SurfaceMaterial, string>> = {
  dirt: 'footstep_dirt', sand: 'footstep_sand', snow: 'footstep_snow', mud: 'footstep_mud', moss: 'footstep_moss',
  ash: 'footstep_ash', rock: 'footstep_rock', crystal: 'footstep_crystal', organic: 'footstep_organic',
  metal: 'footstep_metal', concrete: 'footstep_concrete',
};
const FOOTSTEP_MATERIAL_GAIN: Readonly<Partial<Record<SurfaceMaterial, number>>> = numberMap<SurfaceMaterial>('tables.csv', 'FOOTSTEP_MATERIAL_GAIN');
/** id → 재질 배수 (적 발소리는 `audio:play` 의 id 로만 오므로 id 에서 찾는다). */
const FOOTSTEP_GAIN_BY_ID: Readonly<Record<string, number>> = Object.fromEntries(
  (Object.keys(FOOTSTEP_ID) as SurfaceMaterial[]).map((m) => [FOOTSTEP_ID[m], FOOTSTEP_MATERIAL_GAIN[m] ?? 1]),
);
/**
 * 적 발소리(2026-09-11 C-23 · X-3)의 거리 곡선. 적은 위치를 주는 `audio:play {footstep_<mat>}` 로 내므로 아래
 * `RANGED_SOUNDS` 에 11개 id 가 모두 이 한 줄로 들어간다 — 원격 분대원 발소리(`FOOTSTEP_AUDIBLE_RANGE` 26 m)보다
 * 멀리 들리는 대신 밑값은 호출부(`enemies/model.stepSound` 의 타입별 gain — 베헤모스는 크고 전사는 작다)가 정한다.
 * 예전에는 방출부의 선형 감쇠 × 패너 inverse 가 **두 번** 곱해져 20 m 에서 0.06 이었다.
 * (본인 · 원격 분대원 발소리는 `footstep()` 이 직접 `play` 하므로 이 곡선을 타지 않는다.)
 */
const ENEMY_STEP_RANGE: RangeProfile = { range: 45, exp: 1.5 };

/* ── 로그 강하 (2026-09-10) ────────────────────────────────────────────
 * 피치는 "소리 그 자체" 라 코드에 둔다 (발소리 피치와 같은 규약). 크기 · 반경 · 감쇠 지수는 csv 다.
 */
/** 경보음의 피치 — 아군 웨이브 경보(`wave_alarm`)보다 살짝 높아 "적의 것" 으로 읽힌다. */
const ROGUE_DROP_ALARM_PITCH = 1.06;
/** 낙하 굉음의 피치 — 아군 헬포드보다 낮게 깔린다. */
const ROGUE_DROP_FALL_PITCH = 0.88;
/** 착지 뒤 이만큼 지나면 추적을 버린다 (착지 방송을 못 받은 강하 대비). */
const ROGUE_DROP_FORGET_S = 3;

/* ── 거리 곡선을 가진 효과음 (2026-09-11) ─────────────────────────────────
 * 드론 · 원격 지뢰 · 네임드 로그의 소리는 기본 패너(inverse, ref 4 m)로는 성격을 못 낸다 — 지상 드론 걷기는
 * 소유자 곁에서만, 저격 한 발은 맵 거의 끝까지 들려야 한다. 그래서 `audio:play` 에 위치가 오면 이 표의 id 는
 * 원격 발소리 · 로그 강하와 **같은 곡선** `(1 − d/range)^exp` 을 호출부 볼륨에 곱하고, 패너는 방향만 맡는다
 * (`panOnly`). `range` 밖은 보이스를 만들지 않는다.
 *
 * `floor` = 사거리 안에서 보장하는 최소 비율. **전조가 들려야 공정한** 소리(저격 반짝임 · 저격 · 스캔 음파)만
 * 갖는다. 사거리 끝에서 뚝 끊기지 않게 마지막 `RANGED_FLOOR_EDGE` 구간에서 0 으로 줄어든다.
 *
 * 이 반경들은 **플레이어 귀의 연출**이고 게임 판정에 쓰이지 않는다 — 판정 반경이 있는 소리는 그 계약 상수에
 * 묶는다: 질주하는 지상 드론은 적이 듣는 `DRONE_NOISE_RADIUS` 보다 조금 멀리까지 들린다 ("적이 들었는데 나는
 * 못 들었다" 가 없게).
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
  // 2026-09-13: 버그 굴착 스폰 · 지하벌레 (enemies/). 전조 땅울림 · 분출 · 포효는 멀리서도 들려야 공정하다 — floor.
  burrow_emerge: { range: 40, exp: 1.5 },
  sandworm_rumble: { range: 200, exp: 1.0, floor: 0.3 },
  sandworm_erupt: { range: 260, exp: 0.9, floor: 0.3 },
  sandworm_roar: { range: 220, exp: 1.0, floor: 0.2 },
  sandworm_spit: { range: 90, exp: 1.2 },
  sandworm_death: { range: 200, exp: 1.0, floor: 0.15 },
  // 2026-09-11 (C-23): 적 발소리 — 재질별 id 11개가 같은 곡선 (위 `ENEMY_STEP_RANGE`)
  ...Object.fromEntries(Object.values(FOOTSTEP_ID).map((id) => [id, ENEMY_STEP_RANGE])),
  // 2026-09-13: 안드로이드 서보음은 재질 발소리 위에 겹쳐 나므로 같은 곡선이어야 발소리보다 멀리 들리지 않는다
  android_step: ENEMY_STEP_RANGE,
};
/** `floor` 가 사거리 끝 이 비율 구간에서 선형으로 0 이 된다. */
const RANGED_FLOOR_EDGE = 0.15;
/** 이보다 조용해질 바에는 보이스를 만들지 않는다. */
const RANGED_MIN_VOLUME = 0.01;
/** 드론 아이템의 `gadget:used` 는 `drone_deploy` 가 대신한다 (투척 휙 소리를 겹치지 않는다). */
const DRONE_GADGET_IDS: readonly string[] = Object.values(DRONE_GADGET_OF);

/** 예고를 받아 놓고 착지 직전에 굉음을 낼 강하 하나. */
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

  /** 예고~착지 사이의 로그 강하 (2026-09-10) — 굉음을 낼 시각을 기다린다. */
  private drops: DropSound[] = [];

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
      b.on('audio:play', ({ id, position, volume, pitch }) => this.playRequested(id, position, volume, pitch)),

      // player
      b.on('player:damaged', () => auto('player_hurt', undefined, 0.9, 0.9 + Math.random() * 0.2)),
      b.on('player:died', () => auto('player_death')),
      // 발소리 (2026-09-10): 본인은 거리 감쇠 없이 늘 같은 크기, 원격 분대원만 멀 수록 작아진다.
      b.on('player:footstep', ({ position, sprinting }) => this.footstep(null, position, sprinting)),
      b.on('remote:footstep', ({ position, sprinting, peerId }) => this.footstep(peerId, position, sprinting)),
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
      // 로그 강하 (2026-09-10): 경보는 지금, 낙하 굉음은 착지 직전에. 둘 다 인지력이 아니라 전용 반경을 본다.
      b.on('rogueDrop:incoming', ({ dropId, position, eta }) => this.rogueDropIncoming(dropId, position, eta)),
      b.on('rogueDrop:landed', ({ dropId }) => this.rogueDropDone(dropId)),

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
      // 창문 워프 (2026-09-09): the hub sends `hub_dock_thrusters` / `hub_dock_clamp` itself at the ends of a trip; in
      // between, the drive hum rides `speed` (rising / falling with the ramps). No one-shot here.
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
      // 2026-09-12 준비 소리: 임플란트 = 짧고 높은 전자음 (충전형의 중간 충전은 작고 조금 낮게, 마지막 충전 · 단일 충전 ·
      // 안정제는 정식), 함선 호출 = 무전 두 음 차임. 거절 환불로 0 이 된 순간(`refunded`)은 조용하다 — 거절음이 이미 났다.
      // 둘 다 게임플레이 페이즈에서만 나오는 이벤트라 여기서 페이즈를 다시 보지 않는다.
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
          case 'fire': auto('fire_ignite', position, 0.85); break;
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
      // 2026-09-13 (요리 미니게임): 조리대 요리(`cookStepsOf` 가 있는 산출물)는 housing 이 `cook_finish` 를 이미 냈다 — 제작 딸깍을 겹치지 않는다
      b.on('craft:completed', ({ item }) => { if (cookStepsOf(item?.defId ?? '').length === 0) auto('craft_done', undefined, 0.8); }),
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
        this.drops.length = 0;
      }),
      b.on('game:abort', () => { this.drops.length = 0; }),
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

    // 창문 워프 drive (2026-09-09): two detuned saws + a rushing noise band → lowpass → gain. Everything is a target
    // set per frame from `hub:warpProgress.speed`: pitch 38 → 90 Hz, filter 180 → 1600 Hz, gain 0 → 0.22.
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

  /* ── 발소리 (2026-09-10) ─────────────────────────────────────────────── */
  /** 자세별 크기: 달리기 > 걷기 > 웅크림 > 엎드림. 자세를 모르면 걷기/달리기만 구분한다. */
  private footstepVolume(stance: Stance | undefined, sprinting: boolean): number {
    if (stance === 'prone') return FOOTSTEP_VOL_PRONE;
    if (stance === 'crouch') return FOOTSTEP_VOL_CROUCH;
    return sprinting ? FOOTSTEP_VOL_SPRINT : FOOTSTEP_VOL_WALK;
  }

  /**
   * `player:footstep` (peerId null = 본인) 과 `remote:footstep` 의 공통 재생 경로.
   *
   * - **본인**은 감쇠 대상이 아니다 — 위치를 주지 않으므로 패너를 아예 타지 않고 늘 같은 크기로 들린다.
   * - **원격**은 `(1 - d / FOOTSTEP_AUDIBLE_RANGE) ^ FOOTSTEP_FALLOFF_EXP` 로 줄고 사거리 밖이면 재생조차
   *   하지 않는다. 패너는 **방향만** 맡는다 (`panOnly`) — 패너의 inverse 감쇠까지 겹치면 두 번 줄어든다.
   * - 자세는 이벤트에 없으므로 `ctx.player` / `ctx.net` 에서 읽는다 (계약은 추가만 하는 규칙 그대로 둔다).
   * - 2026-09-11 (C-22): **밟은 재질**이 소리를 고른다(`surfaceAt` → `footstep_<mat>`, 크기 × `FOOTSTEP_MATERIAL_GAIN`).
   *   함선 안(허브 · 도킹)은 본인 · 원격 모두 금속이다 — 옛 원격 전용 갑판 피치 배수를 대신한다.
   * - 적 발소리와 id 를 나눠 쓰므로 **중복 제거(DEDUPE)를 타지 않는다** — 적 한 걸음과 내 한 걸음이 100 ms 안에
   *   겹치면 한쪽이 사라졌을 것이다. 본인 발소리는 같은 id 속도 제한(RATE)도 건너뛴다 (적 무리가 같은 재질을 밟고
   *   있어도 내 발소리는 먹히지 않는다).
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
   * 발 위치 `p`(발 높이 = `p.y`)의 재질. 함선(허브 · 도킹)은 페이즈로 `metal`, 월드가 준비되지 않았거나 world 가
   * `getSurfaceMaterial` 을 아직 안 가지면(옵셔널 계약) `dirt` — 옛 단일 발소리 음색이다.
   */
  private surfaceAt(p: THREE.Vector3): SurfaceMaterial {
    const ctx = this.ctx;
    if (this.hubActive || ctx?.phase === 'hub' || ctx?.phase === 'docking') return 'metal';
    const w = ctx?.world;
    if (!w || !w.ready) return 'dirt';
    const m = w.getSurfaceMaterial?.(p.x, p.z, p.y);
    return m && m in FOOTSTEP_ID ? m : 'dirt';
  }

  /* ── 로그 강하 (2026-09-10) ──────────────────────────────────────────── */
  /**
   * 강하음의 크기. **인지력 반경(`derived.enemyDetectRadius`)을 보지 않는다** — 대기를 찢고 떨어지는 굉음이라
   * 인지력이 좁아도 들려야 한다는 것이 이 소리의 요구사항이고, 그 대신 전용 반경
   * `ROGUE_DROP_ALERT_RADIUS`(인지력의 10배) 하나로 게이트한다. 반경 밖은 0 = 재생하지 않는다 —
   * 맵 반대편의 강하까지 들리면 안 되기 때문이다. 안쪽은 원격 발소리와 같은 곡선으로 줄어든다.
   */
  private dropGain(position: THREE.Vector3, base: number): number {
    const d = this.camPos.distanceTo(position);
    if (d >= ROGUE_DROP_ALERT_RADIUS) return 0;
    const v = base * Math.pow(1 - d / ROGUE_DROP_ALERT_RADIUS, ROGUE_DROP_ALERT_FALLOFF_EXP);
    return v < ROGUE_DROP_MIN_VOLUME ? 0 : v;
  }

  /**
   * `rogueDrop:incoming` — 호스트가 굴렸든(`enemies/RogueDrop.call`) 리플리카가 `rdrop` 으로 받았든 같은
   * 이벤트가 오므로 **멀티에서도 전원이 듣는다.** 지금 울리는 것은 경보뿐이고, 굉음은 착지 직전에 나간다
   * (`update`) — 8초 전에 다 울려 버리면 정작 떨어질 때가 조용하다.
   *
   * 경보는 **위치를 주지 않는다**: 분대 무전에 뜨는 경고이지 하늘에서 나는 소리가 아니다 (본인 발소리와 같은
   * 처리). 방향은 굉음과 HUD 위험 표시가 말한다.
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

  /** 착지했다 — 굉음은 이미 났고 충격음은 `enemies/RogueDrop` 이 포드마다 낸다. 추적만 끝낸다. */
  private rogueDropDone(dropId: string): void {
    const i = this.drops.findIndex((d) => d.id === dropId);
    if (i >= 0) this.drops.splice(i, 1);
  }

  /**
   * 매 프레임: 착지 `ROGUE_DROP_FALL_LEAD_S` 초 전이 되면 낙하 굉음을 한 번 낸다. 굉음은 **방향이 중요하다**
   * (어느 쪽 하늘에서 내려오는가) — 그래서 위치를 주되 `panOnly` 로 넘겨 패너의 inverse 감쇠가 우리 곡선과
   * 겹치지 않게 한다. 감쇠는 그 순간의 거리로 다시 잰다 (예고 때 멀었어도 달려갔으면 크게 들린다).
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

  /* ── 거리 곡선 (2026-09-11) ──────────────────────────────────────────── */
  /** `RANGED_SOUNDS` 한 줄의 거리별 배수. 0 = 사거리 밖. */
  private rangeGain(prof: RangeProfile, d: number): number {
    if (d >= prof.range) return 0;
    const k = 1 - d / prof.range;
    const curve = Math.pow(k, prof.exp);
    const floor = prof.floor ?? 0;
    if (floor <= 0) return curve;
    return curve * (1 - floor) + floor * Math.min(1, k / RANGED_FLOOR_EDGE);
  }

  /**
   * `audio:play` 의 입구. `RANGED_SOUNDS` 에 있는 id 가 위치와 함께 오면 그 곡선을 곱해 **방향 전용** 패너로
   * 낸다 (감쇠가 두 번 걸리지 않게). 나머지는 예전 그대로 기본 패너를 탄다.
   */
  private playRequested(id: string, position: THREE.Vector3 | undefined, volume: number | undefined, pitch: number | undefined): void {
    const prof = position ? RANGED_SOUNDS[id] : undefined;
    if (!position || !prof) { this.play(id, position, volume, pitch, false); return; }
    if (!this.ac || this.ac.state !== 'running') return;
    // 2026-09-11 (C-22): 적 발소리도 재질 배수를 먹는다 (본인 · 원격은 `footstep()` 이 곱한다)
    const v = (volume ?? 1) * (FOOTSTEP_GAIN_BY_ID[id] ?? 1) * this.rangeGain(prof, this.camPos.distanceTo(position));
    if (v < RANGED_MIN_VOLUME) return;
    this.play(id, position, v, pitch, false, true);
  }

  /* ── playback ────────────────────────────────────────────────────────── */
  /**
   * `panOnly` = 거리 감쇠를 **호출부가 이미 계산했다** (발소리). 패너는 방향(equalpower)만 맡고 rolloff 0 이라
   * 게인을 건드리지 않는다 — 그렇지 않으면 inverse 감쇠가 겹쳐 두 번 줄어든다.
   */
  private play(id: string, position: THREE.Vector3 | undefined, volume = 1, pitch = 1, auto = false, panOnly = false, dedupe = true, rateLimit = true): void {
    if (!this.ac || !this.synth || this.ac.state !== 'running') return;
    const fn = SOUNDS[id];
    if (!fn) { if (!auto) console.warn(`[Audio] unknown sound id "${id}"`); return; }
    const now = this.ac.currentTime;

    // Dedupe: same id from a different source within a short window → one plays.
    // (2026-09-11: 발소리는 `dedupe` false — 같은 재질 id 를 적과 나눠 쓰므로 검사도 기록도 하지 않는다.)
    if (dedupe) {
      const last = this.lastPlay.get(id);
      if (last && last.auto !== auto && now - last.t < DEDUPE_WINDOW) return;
      this.lastPlay.set(id, { t: now, auto });
    }

    // Rate limit identical ids.
    if (rateLimit) {
      let arr = this.recent.get(id);
      if (!arr) { arr = []; this.recent.set(id, arr); }
      while (arr.length && now - arr[0] > RATE_WINDOW) arr.shift();
      if (arr.length >= RATE_MAX_SAME) return;
      arr.push(now);
    }

    // Voice: [synth] → gain → (panner) → sfxBus
    const g = this.ac.createGain();
    g.gain.value = Math.max(0, Math.min(2, volume));
    let dest: AudioNode = this.sfxBus;
    if (position) {
      const p = this.ac.createPanner();
      p.panningModel = 'equalpower';
      if (panOnly) {
        // 감쇠는 호출부의 곡선이 이미 걸었다 — rolloff 0 = 방향만, 게인은 그대로.
        p.distanceModel = 'linear'; p.refDistance = 1; p.maxDistance = 10000; p.rolloffFactor = 0;
      } else {
        p.distanceModel = 'inverse';
        p.refDistance = 4; p.maxDistance = 220; p.rolloffFactor = 1.1;
      }
      this.setParam(p.positionX, position.x, now); this.setParam(p.positionY, position.y, now); this.setParam(p.positionZ, position.z, now);
      p.connect(dest); dest = p;
      // Quick distance cull for tiny sounds (발소리는 `footstep()` 이 `FOOTSTEP_AUDIBLE_RANGE` 로 이미 걸렀다)
      if (!panOnly) {
        const d = this.camPos.distanceTo(position);
        if (d > 160 && (id === 'bug_step' || id === 'hit_terrain')) { p.disconnect(); g.disconnect(); return; }
      }
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

    // 로그 강하: 착지 직전의 굉음 (camPos 를 갱신한 뒤라야 거리 감쇠가 이 프레임 값이다).
    if (this.drops.length) this.updateDrops(ctx.time);

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

    // 창문 워프 drive: follows the last `hub:warpProgress.speed`; forgotten after `WARP_HUM_HOLD_S` without one.
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
