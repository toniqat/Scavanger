/**
 * src/enemies/RogueDrop.ts — **레이더 강하** (2026-09-09 로그 강하 → 2026-09-13 레이더 파도).
 *
 * 이 파일이 답하는 질문: *버려진 전진기지 · 연구실 · 선로 플랫폼을 뒤지면 무슨 일이 벌어지는가.*
 *
 * world/ 가 그 구역의 컨테이너를 **처음** 조사할 때 `structure:investigated {zoneId, kind, position}` 를 낸다.
 * 호스트가 그 구역에 대해 딱 한 번 **행성 threat 별 확률**(`RAIDER_DROP_CHANCE_BY_THREAT`, threat 1 = 0 → 굴리지도 않는다)을
 * 굴리고, 성공하면 **레이더** 분대가 하늘에서 내려온다:
 *
 *   예고(`rogueDrop:incoming` + `rdrop incoming`) → `ROGUE_DROP_ETA_S` 초 낙하 →
 *   착지(`rogueDrop:landed` + `rdrop landed`) → 레이더 스폰 → **트리거 지점(구조물)으로 진격**
 *
 * 이름(`rogueDrop:*` · `rdrop` · `callRogueDrop` · `getRogueDrops` · `ROGUE_DROP_ETA_S` · `ROGUE_DROP_RADIUS`)은 계약이라
 * 그대로다. 사람에게 보이는 문구("레이더 강하")는 ui/ 의 몫이다.
 *
 * ## 파도 (2026-09-13, 사용자 결정)
 * 한 강하는 **최대 두 파도**이고 파도마다 인원은 분대 인원이 정한다 — `data/tables.csv` 의 `RAIDER_DROP_WAVE1_*` ·
 * `RAIDER_DROP_WAVE2_*` (index 0 = 분대 1명): 1인 3 · 2인 3 → 2 · 3인 3 → 3 · 4인 4 → 3–4. 한 파도는
 * `RAIDER_DROP_WAVE_MAX`(4)명을 넘지 않는다. 두 번째 파도는 첫 예고 `RAIDER_DROP_WAVE_GAP_S`(10) 초 뒤에 **따로 예고되는
 * 독립된 강하**다 — dropId `${zoneId}#2`, 자기 `rdrop incoming` / `landed`, 자기 포드 · 자기 착지 지점(시드 = 그 dropId).
 * 리플리카는 파도를 모른다: 받은 `rdrop` 하나하나가 강하 하나다. 파도마다 분대 하나(`allocSquadId`)이고
 * 정확히 한 명이 `flanker`, 거점은 `'drop'`. 분대장(`rogue_boss`)은 없다 (`RogueDropView.boss` 는 늘 false).
 * 두 번째 파도는 **호스트가 들고 있는 예약**이다 — 그 10 초 사이 호스트가 바뀌면 그 파도는 오지 않는다 (알려진 한계).
 *
 * ## 알린다 (2026-09-10)
 * 강하는 조용히 일어나면 안 된다. 이 파일이 내는 것은 **포드 착지 충격음(`rogue_pod_impact`)뿐**이고,
 * 무전 경보(`rogue_drop_alarm`)와 대기를 찢는 낙하 굉음(`rogue_pod_fall`)은 `audio/AudioSystem` 이
 * `rogueDrop:incoming` 을 받아 낸다 — 둘 다 인지력이 아니라 전용 반경 `ROGUE_DROP_ALERT_RADIUS` 로
 * 게이트하고 그 안에서 거리에 따라 줄어든다. 화면 표시는 `ui/hud/RaidAlerts`(토스트)와
 * `ui/hud/DangerIndicators`(화면 안 = 머리 마커 · 밖 = 방향 호)의 몫이다. 파도마다 한 번씩 울린다.
 *
 * ## 호스트 권한 · 구역당 1회
 * 굴리는 것은 **호스트뿐**이고 결과는 `rdrop` 으로 흐른다. "이 구역은 이미 썼다"는 기록은 두 곳에서 온다:
 *  1. `used` — 이 클라이언트가 본 모든 구역 (호스트가 굴린 것 + **리플리카가 받은 `rdrop incoming`** 의 구역 —
 *     `#2` 를 뗀 zoneId 로도 적는다). 리플리카도 기록하므로 호스트 이관으로 승격된 사람이 같은 구역을 다시 굴리지 않는다.
 *  2. `ctx.world.getStructures()` 의 `StructureDef.rogueDropUsed` — world/ 가 `struct sync` 로 채워 주는
 *     구조물별 플래그. 레이드 도중에 합류해 `rdrop` 을 한 번도 못 본 사람이 호스트가 되는 경우를 덮는다.
 * 둘 중 하나라도 참이면 굴리지 않는다. 첫 파도의 `dropId` 는 `structure:investigated.zoneId` 를 그대로 쓴다 —
 * 그래야 두 기록이 같은 열쇠를 쓴다. **실패한 굴림도 "굴렸다"로 친다** (사용자 규칙: 구역당 1회만 발생).
 * 굴림 자체는 `worldSeed ^ hash(zoneId)` 의 시드 스트림이라 누가 호스트든 같은 답이 나온다.
 *
 * ## 개체수 상한
 * 강하 병력은 `AmbientSpawner` 의 `ensureCapacity` 를 **거치지 않는다** — `host.spawnRogue` 를 직접 부르므로
 * 상한이 인원을 깎지 못한다. 반대로 조용히 사라지는 일도 없다: 재활용 패스는 `e.isHumanoid` 를 건너뛴다.
 * 다만 `aliveCount()` 에는 그대로 잡혀 **상시 벌레 순찰이 그만큼 줄어든다** — 의도한 것이다.
 *
 * ## 포드
 * 외부 에셋 없이 이 파일에서 절차 생성한다 (`player/Hellpod` · `stratagems` 의 구조 포드를 **참고만** 했고
 * import 하지 않는다 — 적 포드는 붉은 육각 캡슐로 아군 헬포드와 실루엣이 다르다). 지오메트리 ·
 * 머티리얼은 모듈 단위로 공유하고 `disposeRogueDropAssets()` 가 미션 리셋에서 정리한다.
 */
import * as THREE from 'three';
import {
  ROGUE_DROP_ETA_S, ROGUE_DROP_RADIUS, Random,
  type EnemySquadRole, type RogueDropView, type Vec3Tuple,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import type { Enemy } from './Enemy';
import { HUMANOID_WEAPONS, ROGUE_AI } from './EnemyTypes';
import { beginInvestigation } from './ai/Investigate';
import { tuple } from './net/HostSync';
import type { RogueSpawnHost } from './RogueGuards';
/* ── 표 · 상수 (data/tables.csv · data/constants.csv → factionTables.ts) ─────────────────────────────── */
import {
  RAIDER_DROP_CHANCE_BY_THREAT as DROP_CHANCE_BY_THREAT, RAIDER_DROP_WAVE1_MAX as WAVE1_MAX, RAIDER_DROP_WAVE1_MIN as WAVE1_MIN,
  RAIDER_DROP_WAVE2_MAX as WAVE2_MAX, RAIDER_DROP_WAVE2_MIN as WAVE2_MIN, RAIDER_DROP_WAVE_GAP_S as WAVE_GAP_S,
  RAIDER_DROP_WAVE_MAX as WAVE_MAX,
} from './factionTables';

/* ── 연출 상수 (수치가 아니라 타이밍이므로 csv 가 아니다) ────────────────────────────────────────────── */
/** 포드가 나타나는 고도(m). 예고 순간 하늘의 점으로 보이고 착지 직전에 급격히 커진다. */
const POD_HEIGHT = 420;
/** 낙하 가속 곡선의 지수 (1 = 등속, 클수록 마지막에 몰린다). */
const POD_FALL_EXP = 2.4;
/** 착지한 포드가 월드에 남아 있는 시간(초). 지나면 지오메트리를 반납한다. */
const POD_LINGER_S = 30;
/** 착지 지점끼리의 최소 간격(m) — `scatterPoints` 로 넘어간다. */
const POD_MIN_GAP = 4.5;
/** 낙하 연기 입자 간격(초). */
const SMOKE_INTERVAL = 0.08;
/** 이 고도 아래로 내려와야 연기를 뿜는다(m) — 상공의 입자는 보이지도 않고 풀만 먹는다. */
const SMOKE_MAX_ALT = 140;
/** 착지 충격이 화면을 흔드는 최대 거리(m). */
const IMPACT_SHAKE_DIST = 45;
/** 강하 인원 표의 색인 범위 (분대 1..4명). */
const MAX_SQUAD = 4;
/** 두 번째 파도의 dropId 접미사 (`${zoneId}#2`). */
const WAVE2_SUFFIX = '#2';
/** 착지 지점 시드 · 슬롯 시드 소금. */
const POINT_SALT = 0x5bf03635;
const SLOT_SALT = 0x2545f491;

/** `zone#2` → `zone` (첫 파도 id 는 그대로). */
export function dropZoneOf(dropId: string): string {
  return dropId.endsWith(WAVE2_SUFFIX) ? dropId.slice(0, -WAVE2_SUFFIX.length) : dropId;
}

/** 착지 지점 하나에 실려 오는 것 (종류는 늘 `raider`). */
interface Slot { weaponId: string; role: EnemySquadRole }

/* ══ 절차 포드 ═══════════════════════════════════════════════════════════════════════════════════════ */

interface PodAssets {
  geo: THREE.BufferGeometry[];
  hull: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  burn: THREE.MeshStandardMaterial;
}
let assets: PodAssets | null = null;

function getAssets(): PodAssets {
  if (assets) return assets;
  const glow = new THREE.MeshStandardMaterial({ color: 0x2a0a08, roughness: 0.4, metalness: 0.3 });
  glow.emissive.setHex(0xff3322); glow.emissiveIntensity = 1.4;
  const burn = new THREE.MeshStandardMaterial({ color: 0x2a1000, roughness: 0.5, metalness: 0.2 });
  burn.emissive.setHex(0xff8a20); burn.emissiveIntensity = 0;
  assets = {
    geo: [
      new THREE.CylinderGeometry(0.62, 0.84, 1.9, 6),   // 0 동체
      new THREE.ConeGeometry(0.64, 0.8, 6),             // 1 노즈콘
      new THREE.CylinderGeometry(0.88, 0.88, 0.16, 6),  // 2 발광 띠
      new THREE.BoxGeometry(0.09, 1.05, 0.62),          // 3 핀
      new THREE.CylinderGeometry(0.4, 0.62, 0.5, 6),    // 4 역추진 노즐
    ],
    hull: new THREE.MeshStandardMaterial({ color: 0x4a2b26, roughness: 0.72, metalness: 0.45 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x14100f, roughness: 0.6, metalness: 0.6 }),
    glow, burn,
  };
  return assets;
}

/** 미션 리셋: 포드가 만든 지오메트리 · 머티리얼을 반납한다 (`EnemySystem.disposePools` 에서 부른다). */
export function disposeRogueDropAssets(): void {
  if (!assets) return;
  for (const g of assets.geo) g.dispose();
  assets.hull.dispose(); assets.dark.dispose(); assets.glow.dispose(); assets.burn.dispose();
  assets = null;
}

/**
 * 역추진 발광은 **공유 머티리얼 한 장**이라 프레임마다 0 으로 되돌려 놓고, 그 프레임에 떨어지는 포드들이
 * `Math.max` 로 올린다 (포드마다 머티리얼을 따로 만들면 낙하 한 번에 8장이 생긴다).
 */
function resetPodBurn(): void {
  if (assets) assets.burn.emissiveIntensity = 0;
}

const _fxDir = new THREE.Vector3(0, 1, 0);

/**
 * 강하 포드 하나. 하늘에서 `fallTime` 초에 걸쳐 가속하며 내려와 `landing` 에 꽂힌다.
 * 상태를 바꾸지 않는 순수 연출이다 — 적 스폰은 `RogueDropDirector` 가 착지 시각에 따로 한다.
 */
class RogueDropPod {
  readonly group = new THREE.Group();
  private readonly landing = new THREE.Vector3();
  private readonly burn: THREE.MeshStandardMaterial;
  private t = 0;
  private fallTime = 1;
  private smoke = 0;
  /** 낙하 중이면 true (착지하면 false — 그래도 월드에는 남는다). */
  falling = false;
  active = false;

  constructor() {
    const a = getAssets();
    this.burn = a.burn;
    this.group.name = 'RogueDropPod';
    const hull = new THREE.Mesh(a.geo[0], a.hull);
    hull.position.y = 0.95;
    this.group.add(hull);
    const nose = new THREE.Mesh(a.geo[1], a.hull);
    nose.position.y = 2.3;
    this.group.add(nose);
    const band = new THREE.Mesh(a.geo[2], a.glow);
    band.position.y = 1.55;
    this.group.add(band);
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      const fin = new THREE.Mesh(a.geo[3], a.dark);
      fin.position.set(Math.cos(ang) * 0.78, 0.6, Math.sin(ang) * 0.78);
      fin.rotation.y = -ang;
      this.group.add(fin);
    }
    const bell = new THREE.Mesh(a.geo[4], a.burn);
    bell.position.y = -0.12;
    this.group.add(bell);
  }

  get position(): THREE.Vector3 { return this.group.position; }

  start(landing: THREE.Vector3, yaw: number, fallTime: number): void {
    this.landing.copy(landing);
    this.fallTime = Math.max(0.2, fallTime);
    this.t = 0;
    this.smoke = 0;
    this.falling = true;
    this.active = true;
    this.group.rotation.set(0, yaw, 0);
    this.group.position.set(landing.x, landing.y + POD_HEIGHT, landing.z);
    this.group.visible = true;
  }

  /** 이미 떨어진 자리에 그대로 세워 둔다 (호스트의 `rdrop landed` 가 로컬 타이머보다 먼저 왔을 때). */
  snapDown(): void {
    this.t = 1;
    this.falling = false;
    this.group.position.copy(this.landing);
  }

  /** 한 틱. 이 프레임에 땅에 닿았으면 true. */
  update(dt: number, fx: FxManager | null): boolean {
    if (!this.active || !this.falling) return false;
    this.t = Math.min(1, this.t + dt / this.fallTime);
    const rest = 1 - this.t;
    this.group.position.y = this.landing.y + POD_HEIGHT * Math.pow(rest, POD_FALL_EXP);
    // 마지막 1.2 초에 역추진이 붙는다
    const brake = this.t > 0.82 ? (this.t - 0.82) / 0.18 : 0;
    this.burn.emissiveIntensity = Math.max(this.burn.emissiveIntensity, brake * 2.5);
    // 연기는 눈에 보이는 고도에서만 — 400 m 상공의 입자는 어차피 안 보이고 풀만 먹는다
    if (fx && this.group.position.y - this.landing.y < SMOKE_MAX_ALT) {
      this.smoke -= dt;
      if (this.smoke <= 0) {
        this.smoke = SMOKE_INTERVAL;
        ParticleBurst.dust(fx.alpha, this.group.position, _fxDir, 2, 1.1, 0x6a5a50);
      }
    }
    if (this.t >= 1) {
      this.falling = false;
      this.group.position.copy(this.landing);
      // 살짝 기울여 박아 둔다 — 반듯하게 선 포드는 프롭처럼 안 보인다
      this.group.rotation.x = (Math.random() - 0.5) * 0.16;
      this.group.rotation.z = (Math.random() - 0.5) * 0.16;
      return true;
    }
    return false;
  }

  retire(): void {
    this.active = false;
    this.falling = false;
    this.group.visible = false;
  }
}

/* ══ 진행 중인 강하 ═══════════════════════════════════════════════════════════════════════════════════ */

interface Drop {
  /** 이 파도의 dropId (`zone` 또는 `zone#2`). */
  id: string;
  /** 트리거 지점 = 구조물 중심. 레이더가 진격하는 목표이자 포드가 흩어지는 중심이다. */
  readonly position: THREE.Vector3;
  count: number;
  landsAt: number;
  points: THREE.Vector3[];
  slots: Slot[];
  pods: RogueDropPod[];
  landed: boolean;
  /** 호스트가 실제 스폰까지 마쳤는가 (리플리카는 언제나 false — 적은 `es` / `ee` 로 온다). */
  spawned: boolean;
  /** 착지 뒤 포드를 치울 시각. */
  retireAt: number;
}

/** 호스트가 예약해 둔 두 번째 파도. */
interface PendingWave { id: string; position: THREE.Vector3; count: number; at: number }

/** RogueDrop 이 EnemySystem 에 요구하는 것. */
export interface RogueDropHost extends RogueSpawnHost {
  /** 이 클라이언트가 적을 시뮬레이션하는가 (싱글 또는 호스트). */
  readonly authority: boolean;
  /** 세션 안의 호스트인가 (= `rdrop` 을 방송해야 하는가). */
  readonly hosting: boolean;
  /** 시뮬레이션 훈련장인가. */
  readonly training: boolean;
  /** 2026-09-13: 이번 레이드 목표 행성의 threat (1..3, `world:ready` 에서 정한다 — 행성 없음 = 1). */
  readonly planetThreatLevel: 1 | 2 | 3;
  playAudio(id: string, position: THREE.Vector3, volume?: number, pitch?: number): void;
}

const _p = new THREE.Vector3();
const _spawn = new THREE.Vector3();

function dropSeed(worldSeed: number, dropId: string): number {
  return (((worldSeed >>> 0) ^ Random.hash(dropId) ^ POINT_SALT) >>> 0);
}

/**
 * 레이더 강하 전체를 소유한다. 호스트에서는 굴림 · 파도 예약 · 스폰 · 방송을, 모든 클라이언트에서는 포드 연출을 한다.
 */
export class RogueDropDirector {
  private host!: RogueDropHost;
  private readonly drops: Drop[] = [];
  /** 호스트가 예약한 두 번째 파도. */
  private readonly pending: PendingWave[] = [];
  /** 이미 굴린 구역 (성공 · 실패 무관). 리플리카도 `rdrop incoming` 으로 채운다. */
  private readonly used = new Set<string>();
  private readonly podPool: RogueDropPod[] = [];
  private readonly viewBuf: RogueDropView[] = [];
  private viewsDirty = true;
  /** 디버그 · 스모크: 이번 레이드에서 굴린 횟수 / 실제로 부른 강하(구역) 수 / 떨어뜨린 파도 수. */
  rolls = 0;
  calls = 0;
  waves = 0;
  /** 디버그 · 스모크: 분대 인원을 이 값(1..4)으로 친다 (null = 실제 인원). 미션 리셋이 지운다. */
  squadOverride: number | null = null;

  bind(host: RogueDropHost): void { this.host = host; }

  /* ── 트리거 ──────────────────────────────────────────────────────────── */
  /**
   * `structure:investigated` — 그 구역을 처음 조사했다. **호스트만** 굴리고, 굴린 사실 자체를 기록한다
   * (실패도 기록: 구역당 한 번만 일어난다). 강하가 없는 행성(threat 1)이면 굴리지도 기록하지도 않는다.
   */
  onInvestigated(zoneId: string, position: THREE.Vector3): void {
    const host = this.host;
    if (!host || !host.authority || host.training) return;
    const ctx = host.ctx;
    if (ctx.isTraining() || !ctx.world?.ready) return;
    if (this.hasRolled(zoneId)) return;
    const chance = this.dropChance();
    if (chance <= 0) return;
    this.used.add(zoneId);
    this.rolls++;
    // 시드 굴림: 누가 호스트든(이관 뒤에도) 같은 구역은 같은 답을 낸다
    const rng = new Random((((ctx.world.seed >>> 0) ^ Random.hash(zoneId)) >>> 0));
    if (!rng.chance(chance)) return;
    this.call(zoneId, this.dropTargetFor(ctx.world, zoneId, position));
  }

  /** 이번 행성의 강하 확률 (`RAIDER_DROP_CHANCE_BY_THREAT[threat − 1]`, 0..1). */
  private dropChance(): number {
    const t = this.host.planetThreatLevel ?? 1;
    const raw = DROP_CHANCE_BY_THREAT[Math.max(0, Math.min(DROP_CHANCE_BY_THREAT.length - 1, t - 1))];
    return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
  }

  /**
   * 2026-09-11 (C-18): 강하 목표. 구조물 · 고정 플랫폼은 조사 지점 그대로다. 그런데 **전차 안 컨테이너**(zoneId
   * `tram_<lineId>`)는 조사 순간의 전차 자리가 넘어오므로, 달리던 전차였다면 포드가 선로 한가운데에 떨어지고 분대가
   * 빈 선로를 지키게 된다. 그래서 그 선로의 **가장 가까운 플랫폼**으로 바꾼다 — 전차는 결국 플랫폼에 선다.
   * 플랫폼이 없는 선로(없어야 정상이다)면 원래 지점.
   */
  private dropTargetFor(world: NonNullable<RogueDropHost['ctx']['world']>, zoneId: string, position: THREE.Vector3): THREE.Vector3 {
    if (!zoneId.startsWith('tram_')) return position;
    const lines = world.getRailLines();
    let best: THREE.Vector3 | null = null;
    let bestD = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const plats = lines[i].platforms;
      for (let j = 0; j < plats.length; j++) {
        const p = plats[j].position;
        const d = (p.x - position.x) ** 2 + (p.z - position.z) ** 2;
        if (d < bestD) { bestD = d; best = p; }
      }
    }
    return best ?? position;
  }

  /** 이 구역은 이미 굴렸는가 — 자체 기록 + world/ 가 동기화해 주는 `StructureDef.rogueDropUsed`. */
  private hasRolled(zoneId: string): boolean {
    if (this.used.has(zoneId)) return true;
    const structures = this.host?.ctx.world?.getStructures();
    if (!structures) return false;
    for (let i = 0; i < structures.length; i++) {
      if (structures[i].id === zoneId) return structures[i].rogueDropUsed === true;
    }
    return false;
  }

  /* ── EnemyManagerRef.callRogueDrop ───────────────────────────────────── */
  /**
   * 호스트 전용. `position` 주위에 레이더 첫 파도를 떨어뜨리고, 분대 인원표가 두 번째 파도를 주면
   * `RAIDER_DROP_WAVE_GAP_S` 뒤로 예약한다 (dropId `${dropId}#2`). 행성 threat 는 보지 않는다 — 조사 트리거만 본다.
   * 같은 `dropId` 가 진행 · 예약 중이거나 호스트가 아니거나 자리가 없으면 false.
   */
  call(dropId: string, position: THREE.Vector3): boolean {
    const host = this.host;
    if (!host || !host.authority || host.training) return false;
    const ctx = host.ctx;
    const world = ctx.world;
    if (!world?.ready || ctx.isTraining()) return false;
    const wave2 = dropId + WAVE2_SUFFIX;
    if (this.find(dropId) || this.find(wave2) || this.pending.some((w) => w.id === wave2)) return false;

    const idx = Math.max(0, Math.min(MAX_SQUAD - 1, this.squadSize() - 1));
    const rng = new Random(dropSeed(world.seed, dropId));
    const n1 = waveCount(rng, WAVE1_MIN, WAVE1_MAX, idx);
    const n2 = waveCount(rng, WAVE2_MIN, WAVE2_MAX, idx);   // 늘 굴린다 — 스트림이 인원표에 따라 밀리지 않게
    if (n1 <= 0 || !this.launch(dropId, position, n1)) return false;
    this.calls++;
    if (n2 > 0) this.pending.push({ id: wave2, position: position.clone(), count: n2, at: ctx.time + Math.max(0, WAVE_GAP_S) });
    return true;
  }

  /** 파도 하나를 예고한다 (호스트): 착지 지점 · 포드 · 이벤트 · `rdrop incoming`. 자리가 없으면 false. */
  private launch(id: string, position: THREE.Vector3, count: number): boolean {
    const host = this.host;
    const ctx = host.ctx;
    const world = ctx.world!;
    const seed = dropSeed(world.seed, id);
    const points = world.scatterPoints(position, ROGUE_DROP_RADIUS, count, POD_MIN_GAP, seed);
    if (points.length === 0) return false;       // 자리가 모자라면 그만큼만 내려온다
    const drop = this.begin(id, position, points.length, ROGUE_DROP_ETA_S, points, seed);
    this.waves++;
    ctx.bus.emit('rogueDrop:incoming', { dropId: id, position: drop.position.clone(), count: drop.count, boss: false, eta: ROGUE_DROP_ETA_S });
    if (host.hosting) {
      ctx.net!.send({ t: 'rdrop', ev: 'incoming', dropId: id, p: tuple(drop.position, 2), eta: ROGUE_DROP_ETA_S, count: drop.count, boss: false }, 'others');
    }
    return true;
  }

  /** 진행 중인 강하 (예고 ~ 착지, 파도마다 한 줄). ui/ 의 HUD 경고 · 화면 밖 화살표가 읽는다. */
  views(): readonly RogueDropView[] {
    if (this.viewsDirty) {
      this.viewBuf.length = 0;
      for (const d of this.drops) {
        if (d.landed) continue;
        this.viewBuf.push({ id: d.id, position: d.position, count: d.count, boss: false, landsAt: d.landsAt });
      }
      this.viewsDirty = false;
    }
    return this.viewBuf;
  }

  /** 디버그 · 스모크: 예약된 두 번째 파도 (복사본). */
  pendingWaves(): Array<{ id: string; count: number; at: number }> {
    return this.pending.map((w) => ({ id: w.id, count: w.count, at: w.at }));
  }

  /* ── 와이어 (비호스트) ───────────────────────────────────────────────── */
  /** `rdrop incoming` — 호스트가 강하(파도 하나)를 예고했다. 적은 여기서 만들지 않는다 (기존 `es` / `ee` 경로). */
  onIncomingWire(dropId: string, p: Vec3Tuple, eta: number, count: number, _boss: boolean): void {
    const host = this.host;
    if (!host || host.authority) return;                  // 호스트는 자기 방송을 되받지 않는다
    this.used.add(dropId);
    this.used.add(dropZoneOf(dropId));                    // 승격되더라도 이 구역은 다시 굴리지 않는다
    if (this.find(dropId)) return;
    const ctx = host.ctx;
    if (!ctx.world?.ready) return;
    _p.set(p[0], p[1], p[2]);
    const n = Math.max(0, Math.min(16, Math.round(count)));
    if (n === 0) return;
    const seed = dropSeed(ctx.world.seed, dropId);
    // 호스트와 같은 시드 · 같은 인자 → 같은 착지 지점. 포드가 실제로 레이더가 서는 자리에 꽂힌다.
    const points = ctx.world.scatterPoints(_p, ROGUE_DROP_RADIUS, n, POD_MIN_GAP, seed);
    if (points.length === 0) return;
    const drop = this.begin(dropId, _p, points.length, Math.max(0.5, eta), points, seed);
    ctx.bus.emit('rogueDrop:incoming', { dropId, position: drop.position.clone(), count: drop.count, boss: false, eta: Math.max(0.5, eta) });
  }

  /** `rdrop landed` — 호스트가 착지를 확정했다. 로컬 타이머가 아직이면 지금 내려앉힌다. */
  onLandedWire(dropId: string): void {
    const host = this.host;
    if (!host || host.authority) return;
    const drop = this.find(dropId);
    if (!drop || drop.landed) return;                     // 예고를 못 본 강하는 무시한다 (적은 `ee spawn` 으로 온다)
    this.land(drop);
  }

  /* ── 틱 ──────────────────────────────────────────────────────────────── */
  update(dt: number): void {
    const host = this.host;
    if (!host) return;
    if (this.pending.length > 0) this.launchDueWaves();
    if (this.drops.length === 0) return;
    const ctx = host.ctx;
    const now = ctx.time;
    const fx = FxManager.get();
    resetPodBurn();                              // 공유 발광은 매 프레임 0 에서 다시 쌓는다
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const drop = this.drops[i];
      for (const pod of drop.pods) {
        if (pod.update(dt, fx)) this.impactFx(pod.position);
      }
      if (!drop.landed && now >= drop.landsAt) this.land(drop);
      if (drop.landed && now >= drop.retireAt) {
        for (const pod of drop.pods) { pod.retire(); this.podPool.push(pod); }
        drop.pods.length = 0;
        this.drops.splice(i, 1);
      }
    }
  }

  /** 예약 시각이 된 두 번째 파도를 띄운다. 그 사이 권한을 잃었으면(호스트 이관) 버린다. */
  private launchDueWaves(): void {
    const host = this.host;
    const ctx = host.ctx;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const w = this.pending[i];
      if (ctx.time < w.at) continue;
      this.pending.splice(i, 1);
      if (!host.authority || host.training || ctx.isTraining() || !ctx.world?.ready || this.find(w.id)) continue;
      this.launch(w.id, w.position, w.count);
    }
  }

  /** 미션 리셋: 굴림 기록 · 진행 중인 강하 · 예약 · 포드를 전부 버린다. */
  reset(): void {
    for (const drop of this.drops) for (const pod of drop.pods) { pod.retire(); this.podPool.push(pod); }
    this.drops.length = 0;
    this.pending.length = 0;
    this.used.clear();
    this.viewBuf.length = 0;
    this.viewsDirty = true;
    this.rolls = 0;
    this.calls = 0;
    this.waves = 0;
    this.squadOverride = null;
  }

  /** dispose: 씬에서 포드를 떼고 지오메트리를 반납한다. */
  dispose(scene: THREE.Object3D): void {
    this.reset();
    for (const pod of this.podPool) scene.remove(pod.group);
    this.podPool.length = 0;
  }

  /* ── 내부 ────────────────────────────────────────────────────────────── */
  private find(dropId: string): Drop | null {
    for (const d of this.drops) if (d.id === dropId) return d;
    return null;
  }

  /** 분대 인원 (1..4). 싱글은 1. */
  private squadSize(): number {
    if (this.squadOverride != null && Number.isFinite(this.squadOverride)) return Math.max(1, Math.min(MAX_SQUAD, Math.round(this.squadOverride)));
    const net = this.host.ctx.net;
    let n = 1;
    if (net) for (const r of net.getRemotePlayers()) if (r.connected) n++;
    return Math.max(1, Math.min(MAX_SQUAD, n));
  }

  /**
   * 예고 상태를 만든다 (호스트 · 리플리카 공통): 슬롯 구성 + 포드 낙하 시작. 소리는 audio/ 가 낸다.
   * 슬롯(무기 · 우회조)은 `seed` 에서 굴린다 — 호스트와 리플리카가 같은 구성을 본다 (리플리카는 쓰지 않을 뿐이다).
   */
  private begin(id: string, position: THREE.Vector3, count: number, eta: number, points: THREE.Vector3[], seed: number): Drop {
    const ctx = this.host.ctx;
    const rng = new Random((seed ^ SLOT_SALT) >>> 0);
    const weapons = HUMANOID_WEAPONS.raider;
    const flanker = rng.int(0, Math.max(0, count - 1));
    const slots: Slot[] = [];
    for (let i = 0; i < count; i++) {
      slots.push({
        weaponId: weapons.length > 0 ? weapons[rng.int(0, weapons.length - 1)] : 'ar',
        role: i === flanker ? 'flanker' : 'member',
      });
    }
    const drop: Drop = {
      id, position: position.clone(), count,
      landsAt: ctx.time + eta, points, slots, pods: [],
      landed: false, spawned: false, retireAt: Infinity,
    };
    for (let i = 0; i < points.length; i++) {
      const pod = this.acquirePod();
      const yaw = Math.atan2(position.x - points[i].x, position.z - points[i].z);
      pod.start(points[i], yaw, eta);
      drop.pods.push(pod);
    }
    this.drops.push(drop);
    this.viewsDirty = true;
    /*
     * 2026-09-10 — **경보 · 낙하 굉음은 여기서 울리지 않는다.** `rogueDrop:incoming` 하나만 내고
     * `audio/AudioSystem` 이 그것을 받아 `rogue_drop_alarm`(무전 경보, 지금) 과 `rogue_pod_fall`
     * (대기를 찢는 굉음, 착지 `ROGUE_DROP_FALL_LEAD_S` 초 전) 을 낸다. 이유는 둘이다:
     *  ① 소리의 **거리 감쇠**가 `ROGUE_DROP_ALERT_RADIUS` 라는 전용 반경(인지력과 무관)의 함수인데
     *     그 곡선은 패너의 감쇠와 겹치면 안 되므로 `panOnly` 를 아는 audio/ 안에서만 계산할 수 있다,
     *  ② 예고와 굉음의 **시각이 다르다** — 8초 전에 다 울려 버리면 정작 떨어질 때가 조용하다.
     * 이벤트는 호스트 · 리플리카(`onIncomingWire`) 양쪽에서 나가므로 멀티에서도 전원이 듣는다.
     * 포드 하나하나의 착지 충격음(`rogue_pod_impact`)만 위치가 포드 자신이라 `impactFx` 에 남는다.
     */
    return drop;
  }

  private acquirePod(): RogueDropPod {
    const pod = this.podPool.pop();
    if (pod) { pod.active = true; return pod; }
    const fresh = new RogueDropPod();
    this.host.ctx.scene.add(fresh.group);
    return fresh;
  }

  /** 착지: 이벤트 · 방송 · (호스트면) 실제 스폰 + 진격 명령. */
  private land(drop: Drop): void {
    const host = this.host;
    const ctx = host.ctx;
    drop.landed = true;
    drop.retireAt = ctx.time + POD_LINGER_S;
    this.viewsDirty = true;
    for (const pod of drop.pods) if (pod.falling) { pod.snapDown(); this.impactFx(pod.position); }
    ctx.bus.emit('rogueDrop:landed', { dropId: drop.id, position: drop.position.clone(), count: drop.count, boss: false });
    if (host.hosting) ctx.net!.send({ t: 'rdrop', ev: 'landed', dropId: drop.id, p: tuple(drop.position, 2) }, 'others');
    if (!host.authority || drop.spawned) return;
    drop.spawned = true;
    this.spawnSquad(drop);
  }

  /** 호스트: 착지 지점마다 레이더를 세우고 트리거 지점으로 진격시킨다. 파도 하나 = 분대 하나 (우회조 정확히 한 명). */
  private spawnSquad(drop: Drop): void {
    const host = this.host;
    const world = host.ctx.world;
    if (!world?.ready) return;
    const squadId = host.allocSquadId();
    const spawned: Enemy[] = [];
    for (let i = 0; i < drop.points.length && i < drop.slots.length; i++) {
      const slot = drop.slots[i];
      _spawn.copy(drop.points[i]);
      world.resolveCollision(_spawn, 1.0);
      _spawn.y = world.getHeightAt(_spawn.x, _spawn.z);
      const yaw = Math.atan2(drop.position.x - _spawn.x, drop.position.z - _spawn.z);
      // guardPos = 구조물: 진격이 끝나면 그 자리를 지키며 순찰한다 (기존 인간형 가드 AI 그대로)
      const e = host.spawnRogue('raider', _spawn, yaw, drop.position, slot.weaponId, null, { site: 'drop', squadId, role: slot.role });
      if (!e) continue;
      e.leash = ROGUE_AI.leash;
      // 기존 investigate/advance 경로로 구조물까지 전진한다 — 도중에 누군가를 보면 그대로 교전에 들어간다
      beginInvestigation(e, drop.position);
      spawned.push(e);
    }
    // 우회조 슬롯이 스폰에 실패했으면 첫 멤버가 맡는다
    if (spawned.length > 0 && !spawned.some((e) => e.squadRole === 'flanker')) spawned[0].squadRole = 'flanker';
  }

  private impactFx(p: THREE.Vector3): void {
    const host = this.host;
    const ctx = host.ctx;
    const fx = FxManager.get();
    if (fx) {
      ParticleBurst.groundBlast(fx.alpha, p, 42, 10, 0x8f7f66, 0.4);
      ParticleBurst.dust(fx.alpha, p, _fxDir, 12, 1.6);
      ParticleBurst.sparks(fx.additive, p, _fxDir, 10, 6, 0xff8844);
    }
    // 2026-09-10: 아군 헬포드(`hellpod_impact`)가 아니라 **적 포드**의 충격음 — 더 낮게 꽂히고 파편이 튄다
    host.playAudio('rogue_pod_impact', p, 0.9, 0.9);
    const player = ctx.player?.position;
    if (player) {
      const d = Math.hypot(player.x - p.x, player.z - p.z);
      if (d < IMPACT_SHAKE_DIST) ctx.bus.emit('camera:shake', { intensity: 0.55 * (1 - d / IMPACT_SHAKE_DIST), duration: 0.3 });
    }
  }
}

/** 파도 인원 한 번 굴림 — `[lo, hi]` 표 칸(없으면 0) → `RAIDER_DROP_WAVE_MAX` 로 자른다. */
function waveCount(rng: Random, minTable: readonly number[], maxTable: readonly number[], idx: number): number {
  const lo = Math.max(0, Math.round(Number.isFinite(minTable[idx]) ? minTable[idx] : 0));
  const hi = Math.max(lo, Math.round(Number.isFinite(maxTable[idx]) ? maxTable[idx] : lo));
  const n = rng.int(lo, hi);
  return Math.min(n, Math.max(1, Math.round(Number.isFinite(WAVE_MAX) ? WAVE_MAX : 4)));
}
