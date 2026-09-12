/**
 * src/world/Rails.ts — **선로 · 플랫폼 · 전차**.
 *
 * 구역마다 `RAIL_CHANCE` 로 놓이고, 모양은 두 가지다 — 구역 외곽을 도는 **순환 선로**(`loop`)와 구역을
 * 가로지르는 **왕복 직선 선로**(`line`). 이동 수단이면서 파밍 장소다: 플랫폼만 털거나, **운전실 콘솔**에서
 * `TRAM_START_HOLD_S` 홀드로 전차에 시동을 걸고 **달리는 전차 안**을 털면서 다음 플랫폼까지 간다.
 *
 * 소유 계약: `RailLineDef` · `RailPlatformDef` · `TramDef` · `TramState` · `WorldRef.getRailLines / getTrams`
 * · `rail:tramStarted` / `rail:tramDocked` · `TramMessage`(`tram`) / `TramRequest`(`tramq`) · `RAIL_*` / `TRAM_*`.
 *
 * **선로는 지형을 평탄화하지 않는다** — 교각이 높이를 맞춘다 (평탄화하면 맵 한복판에 1 km 짜리 활주로가
 * 생긴다). 평탄화하는 것은 플랫폼 자리뿐이고 그 패드는 `layout.ts` 가 잡는다.
 *
 * 전차의 진짜 상태는 **선로 위 진행거리 `s` 하나**이고 **호스트 권위**다. 경로는 시드 결정적이라
 * 와이어에는 `s` · 방향 · 상태만 흐른다 (`TRAM_NET_INTERVAL` 마다 한 번).
 *
 * ## 2026-09-10 배치
 * - **도착하면 선다.** 정차 뒤 자동 재출발을 없앴다 — 다음 출발은 반드시 콘솔 조작이다 (`update` 의 `docked`).
 * - **콘솔은 운전실 안**이다 (`parts/Tram`).
 * - **플랫폼 기둥은 「전차 호출」 콘솔이다** (2026-09-10, 두 번째 배치). 시동이 차 안으로 들어간 뒤
 *   플랫폼에서 전차를 부를 수단이 없어졌으므로, 그 기둥이 **부르기만** 하는 콘솔이 됐다 — 출발은
 *   여전히 타서 운전실 콘솔을 눌러야 한다. 호출은 **기존 출발 절차를 그대로 재사용**한다
 *   (`applyStart` → 알림 → `TRAM_START_DELAY_S` 대기 → `TRAM_ACCEL_S` 가속 → `checkDock` → `idle`).
 * - **차체가 진행 방향으로 길쭉하다.** 축 규약과 그 전의 버그는 `rails/model` 의 주석에 있다.
 * - **최고 속도 근처의 전차에 치이면 피해 + 넉백** (`parts/Tram.updateTramHit`).
 * - 지오메트리 · 배치 · 충돌은 전부 `rails/parts/` 로 내렸다. 이 파일에 남은 것은 **수명 · 상태 기계 · 멀티**다.
 */
import * as THREE from 'three';
import {
  Layers, TRAM_ACCEL_S, TRAM_CALL_HOLD_S, TRAM_CALL_RANGE, TRAM_DEPART_NOTICE_RANGE, TRAM_DOCK_S, TRAM_SPEED,
  TRAM_START_DELAY_S, TRAM_STATES,
  type GameContext, type PeerId, type RailLineDef, type RailPlatformDef,
  type TramDef, type TramMessage, type TramRequest, type TramState, type TramWire,
  type ItemInstance,
} from '@/shared';
import { merge, type BuildCtx } from './build';
import type { SpatialHash } from './SpatialHash';
import {
  CONSOLE_GLOW, CONSOLE_GLOW_BASE, DOCK_WINDOW, PLATFORM_OFFSET, RAIL_MAX_GRADE, RAIL_DECK_Y, TRAM_FLOOR_UP,
  TRAM_NET_INTERVAL, TRAM_SNAP_M, type RailBuild, type RailPath, type TramInst,
  deltaS, makePath, nearestS, sampleAt, wrapS,
} from './rails/model';
import { buildTrack } from './rails/parts/Track';
import { buildPlatform } from './rails/parts/Platform';
import { TRAM_CONSOLE, buildTram, placeTram, updateTramHit } from './rails/parts/Tram';
import { ContainerSet, type ContainerSpec } from './structures/parts/Containers';
import { structureRow } from './structures/model';

/** 운전실 콘솔의 `Interactable` id — 전차가 하나뿐이라 상수다. */
const TRAM_CONSOLE_ID = 'rail:tram_rail_0:console';
/** 플랫폼 호출 콘솔의 `Interactable` id. */
const callConsoleId = (platformId: string): string => `rail:${platformId}:call`;
/**
 * 내가 전차를 부른 뒤 이 시간(초) 안에 시작된 출발에는 「곧 출발합니다」를 띄우지 않는다 (2026-09-10).
 * 부른 사람에게는 「전차를 호출했다」 한 줄이면 된다. 클라이언트는 호스트의 `tram state` 가 돌아와야 출발이
 * 시작되므로 왕복 지연을 넉넉히 덮는다 — 밸런스 수치가 아니라 네트워크 여유다 (`TRAM_SNAP_M` 과 같은 부류).
 */
const CALL_NOTICE_MUTE_S = 3;

/**
 * 호출 콘솔이 지금 무엇을 할 수 있나.
 * - `ready` — 부를 수 있다 (전차가 서 있고, 여기 있지 않다)
 * - `here`  — 이미 이 승강장에 서 있다 (부를 것이 없다)
 * - `busy`  — 달리는 중이다 (도착할 때까지 못 부른다)
 */
type CallState = 'ready' | 'here' | 'busy';

export class Rails {
  readonly group = new THREE.Group();
  private path: RailPath | null = null;
  private line: RailLineDef | null = null;
  private platformS: number[] = [];
  /** 플랫폼별 호출 콘솔의 자리 (거부음을 그 자리에서 낸다). 인덱스는 `platformS` 와 같다. */
  private callPos: THREE.Vector3[] = [];
  private tram: TramInst | null = null;
  private readonly containers = new ContainerSet('RailContainers');
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private hash: SpatialHash | null = null;
  private mat: THREE.MeshStandardMaterial | null = null;
  private game: GameContext | null = null;
  private built = false;
  private netHooked = false;
  private netTimer = 0;
  /** `ctx.time` 기준 — 이 시각 전에 시작한 출발에는 「곧 출발합니다」를 띄우지 않는다 (내가 방금 불렀다). */
  private callNoticeUntil = -Infinity;
  private readonly unsubs: Array<() => void> = [];

  // scratch (핫 패스에서 프레임당 할당 금지)
  private readonly sPos = new THREE.Vector3();
  private readonly sTan = new THREE.Vector3();

  constructor() { this.group.name = 'Rails'; }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  attach(game: GameContext): void {
    this.game = game;
    this.ensureNet();
  }

  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.netHooked = false;
    this.game = null;
  }

  getLines(): readonly RailLineDef[] { return this.line ? [this.line] : []; }
  getTrams(): readonly TramDef[] { return this.tram ? [this.tram.def] : []; }

  build(ctx: BuildCtx, game: GameContext): void {
    this.game = game;
    this.hash = ctx.hash;
    this.ensureNet();
    this.built = true;
    const plan = ctx.layout.rail;
    if (!plan) return;
    const rng = ctx.rng.fork('rails');

    /* ── 중심선: 지형 높이를 뜬 뒤 평활화해서 레일이 울퉁불퉁 오르내리지 않게 한다 ── */
    const loop = plan.kind === 'loop';
    const n = loop ? 72 : Math.max(8, Math.round((plan.extent * 2) / 12));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const t = loop ? i / n : i / (n - 1);
      const x = loop ? Math.cos(plan.angle + t * Math.PI * 2) * plan.extent : Math.cos(plan.angle) * (t * 2 - 1) * plan.extent;
      const z = loop ? Math.sin(plan.angle + t * Math.PI * 2) * plan.extent : Math.sin(plan.angle) * (t * 2 - 1) * plan.extent;
      pts.push(new THREE.Vector3(x, ctx.terrain.getHeightAt(x, z), z));
    }
    for (let pass = 0; pass < 4; pass++) {
      const src = pts.map((p) => p.y);
      for (let i = 0; i < n; i++) {
        const a = src[loop ? (i - 1 + n) % n : Math.max(0, i - 1)];
        const b = src[i];
        const c = src[loop ? (i + 1) % n : Math.min(n - 1, i + 1)];
        pts[i].y = (a + 2 * b + c) / 4;
      }
    }
    for (const p of pts) p.y += RAIL_DECK_Y;

    /* ── 2026-09-10: **선로가 땅에 파묻히지 않게 들어 올린다** ────────────────────────────────────
     * 위의 평활화는 표본점의 높이만 다듬는다. 표본 간격이 20 m 를 넘으므로 언덕을 가로지르는 구간에서는
     * 중심선이 두 점 사이의 지형 **아래**로 내려가고, 거기서 침목이 흙에 잠겼다 (교각도 `max(0.4, …)` 로
     * 눌려 안 보였다). 여기서 점마다 **자기 좌우 구간의 지형 최고점**을 실제로 재서 그보다
     * `RAIL_DECK_Y` 위로 끌어올린다. **내리지는 않는다** — 내리면 다시 파묻힌다. */
    {
      const groundMax = (i: number, j: number): number => {
        const a = pts[i], b = pts[j];
        let g = -Infinity;
        for (let k = 0; k <= 6; k++) {
          const t = k / 6;
          g = Math.max(g, ctx.terrain.getHeightAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t));
        }
        return g;
      };
      const prevOf = (i: number): number => (loop ? (i - 1 + n) % n : Math.max(0, i - 1));
      const nextOf = (i: number): number => (loop ? (i + 1) % n : Math.min(n - 1, i + 1));
      const need = new Array<number>(n);
      for (let i = 0; i < n; i++) need[i] = Math.max(groundMax(prevOf(i), i), groundMax(i, nextOf(i))) + RAIL_DECK_Y;
      for (let i = 0; i < n; i++) pts[i].y = Math.max(pts[i].y, need[i]);
      /* 들어 올리면 이웃과 단차가 생긴다 — **올리기만 하는** 평활화로 경사를 제한한다. */
      let per = 0;
      const segs = loop ? n : n - 1;
      for (let i = 0; i < segs; i++) { const a = pts[i], b = pts[(i + 1) % n]; per += Math.hypot(b.x - a.x, b.z - a.z); }
      const maxStep = Math.max(0.2, (per / Math.max(1, segs)) * RAIL_MAX_GRADE);
      for (let pass = 0; pass < 6; pass++) {
        for (let i = 0; i < n; i++) pts[i].y = Math.max(pts[i].y, pts[prevOf(i)].y - maxStep, pts[nextOf(i)].y - maxStep);
      }
    }

    const path = makePath(pts, loop);
    this.path = path;

    const railMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.6 });
    this.mats.push(railMat);
    this.mat = railMat;
    const out: RailBuild = { geos: this.geos, group: this.group, mat: railMat, glow: [] };
    buildTrack(ctx, rng, path, out);

    /* ── 플랫폼 ─────────────────────────────────────────────────────── */
    const platRow = structureRow('rail_platform');
    const platforms: RailPlatformDef[] = [];
    const specs: ContainerSpec[] = [];
    plan.platforms.forEach((pad, i) => {
      const s = nearestS(path, pad.x, pad.z);
      this.platformS.push(s);
      sampleAt(path, s, this.sPos, this.sTan);
      const yaw = Math.atan2(this.sTan.z, this.sTan.x);
      // 선로에서 옆으로 물러난 데크 중심
      const ax = -Math.sin(yaw), az = Math.cos(yaw);
      const cx = this.sPos.x + ax * PLATFORM_OFFSET, cz = this.sPos.z + az * PLATFORM_OFFSET;
      const deckTop = this.sPos.y + TRAM_FLOOR_UP;
      const id = `plat_${i}`;
      const def: RailPlatformDef = {
        id, position: new THREE.Vector3(cx, deckTop, cz), yaw,
        radius: platRow ? Math.hypot(platRow.halfW, platRow.halfD) : 8,
      };
      platforms.push(def);
      const conPos = buildPlatform(ctx, rng, def, platRow, pad.height, deckTop, yaw, ax, az, specs, out);
      this.callPos.push(conPos);
      this.registerCall(game, def, conPos, i);
    });

    /* 호출 콘솔의 발광 조각은 플랫폼마다 메시를 늘리지 않고 **하나로** 합친다 (드로우콜 +1). */
    if (out.glow.length > 0) {
      const glowMat = new THREE.MeshStandardMaterial({
        color: CONSOLE_GLOW_BASE, emissive: CONSOLE_GLOW, emissiveIntensity: 1.5, roughness: 0.4,
      });
      this.mats.push(glowMat);
      const glowGeo = merge(out.glow);
      this.geos.push(glowGeo);
      const glowMesh = new THREE.Mesh(glowGeo, glowMat);
      glowMesh.layers.enable(Layers.PROP);
      // 이름은 `rail_` 로 시작해야 한다 — `scripts/smoke-structures.mjs` 가 그 접두사로 선로 실루엣을 모은다.
      glowMesh.name = 'rail_console_glow';
      this.group.add(glowMesh);
      out.glow.length = 0;
    }

    this.line = {
      id: 'rail_0', kind: plan.kind, points: pts, length: path.total, platforms,
    };

    /* ── 전차 ───────────────────────────────────────────────────────── */
    const startS = this.platformS.length > 0 ? this.platformS[0] : 0;
    const inst = buildTram(ctx, rng, startS, this.platformS.length > 0 ? 'plat_0' : null, specs, out);
    this.tram = inst;
    placeTram(inst, path, 0, this.hash);
    this.registerConsole(game, inst);

    this.containers.build(ctx, game, specs);
    ctx.root.add(this.group);
    this.requestSync();
  }

  dispose(): void {
    const game = this.game;
    this.containers.dispose();
    game?.interactables.unregister(TRAM_CONSOLE_ID);
    for (const p of this.line?.platforms ?? []) game?.interactables.unregister(callConsoleId(p.id));
    this.platformS.length = 0;
    this.callPos.length = 0;
    this.tram = null;
    this.line = null;
    this.path = null;
    for (const g of this.geos) g.dispose();
    this.geos = [];
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.hash = null;
    this.mat = null;
    this.group.clear();
    this.group.removeFromParent();
    this.built = false;
  }

  /* ── 운전실 콘솔 (2026-09-10 — 플랫폼에서 차 안으로) ─────────────────
   * `Interactable.position` 은 `inst.consolePos` **그 객체**다 — `placeTram` 이 매 프레임 제자리에서
   * 고치므로 달리는 중에도 조준이 따라붙는다 (객실 컨테이너와 같은 수법). */
  private registerConsole(game: GameContext, inst: TramInst): void {
    game.interactables.register({
      id: TRAM_CONSOLE_ID,
      position: inst.consolePos,
      radius: TRAM_CONSOLE.radius,
      holdTime: TRAM_CONSOLE.holdTime,
      // 2026-09-10: 콘솔은 그 자체로 발광하는 장치다 — 감지 빛기둥(`ui/hud/Detection`)을 세우지 않는다.
      hidePillar: true,
      getPrompt: () => (this.tram && this.tram.def.state !== 'moving' ? '전차 시동 (E)' : null),
      canInteract: () => !!this.game?.isGameplayActive() && this.tram?.def.state !== 'moving',
      interact: () => this.requestStart(),
    });
  }

  /* ── 플랫폼 호출 콘솔 (2026-09-10 — 「부르기만」 한다) ────────────────────
   * 상태를 **프롬프트와 홀드 시간으로** 드러낸다: 부를 수 없는 상태에서는 홀드 0 이라 눌러 보면
   * 곧바로 거부음 + 이유 토스트다 (지하실 해치와 같은 규약 — 게이지를 다 채운 뒤 거절당하지 않는다).
   * `canInteract` 를 false 로 내리지 않는 이유가 그것이다: 그러면 `findBest` 가 통째로 걸러
   * **프롬프트조차 안 뜬다** — 왜 안 오는지 알 길이 없어진다. */
  private registerCall(game: GameContext, def: RailPlatformDef, pos: THREE.Vector3, index: number): void {
    const self = this;
    game.interactables.register({
      id: callConsoleId(def.id),
      position: pos,
      radius: TRAM_CALL_RANGE,
      get holdTime(): number { return self.callState(index) === 'ready' ? TRAM_CALL_HOLD_S : 0; },
      hidePillar: true,   // 2026-09-10: 호출 콘솔에도 감지 빛기둥을 세우지 않는다 (발광 띠가 이미 표시다)
      getPrompt: () => {
        switch (self.callState(index)) {
          case 'ready': return '전차 호출 (E)';
          case 'here': return '전차 대기 중 — 타서 운전실 콘솔로 출발';
          default: return '전차 운행 중 — 정차하면 부를 수 있다';
        }
      },
      canInteract: () => !!self.game?.isGameplayActive() && !!self.tram,
      interact: () => self.requestCall(index),
    });
  }

  /** 이 플랫폼의 호출 콘솔이 지금 무엇을 할 수 있나. */
  private callState(index: number): CallState {
    const inst = this.tram, path = this.path;
    if (!inst || !path || index >= this.platformS.length) return 'busy';
    if (inst.def.state === 'moving') return 'busy';
    // 정차 판정과 **같은 창**을 쓴다 (`checkDock`) — 눈에 보이게 서 있는데 "부를 수 있다" 고 하지 않는다.
    if (Math.abs(deltaS(path, inst.def.s, this.platformS[index])) <= DOCK_WINDOW) return 'here';
    return 'ready';
  }

  /* ── update ───────────────────────────────────────────────────────── */

  /** 2026-09-11: 플랫폼 · 전차 컨테이너가 이 클라이언트에서 처음 열리면 불린다. */
  setOpenListener(cb: ((id: string) => void) | null): void { this.containers.setOpenListener(cb); }
  /** 2026-09-11: 분대원이 연 컨테이너를 열린 모습으로. 이 묶음의 것이 아니면 false. */
  markContainerOpened(id: string): boolean { return this.containers.markOpened(id); }
  /** 2026-09-11 (C-57): 플랫폼 · 전차 컨테이너 위치 (없으면 null). */
  containerPositionOf(id: string): THREE.Vector3 | null { return this.containers.positionOf(id); }
  /** 2026-09-12 (C): 플랫폼 · 전차 컨테이너를 처음 열면 나올 내용물 (`WorldRef.previewContainerItems`), 없으면 null. */
  previewContainerItems(id: string): ItemInstance[] | null { return this.containers.preview(id); }

  update(dt: number, time: number): void {
    if (!this.built) return;
    this.containers.update(dt, time);
    const inst = this.tram, path = this.path;
    if (!inst || !path) return;
    const ctx = this.game;
    const host = !ctx?.isMultiplayer || !ctx.net || ctx.net.isHost;

    let speed = 0;
    if (inst.def.state === 'moving') {
      inst.runT += dt;
      speed = this.tramSpeed(inst);
      inst.def.s = wrapS(path, inst.def.s + speed * inst.def.dir * dt);
      // 왕복 선로는 끝에서 되돌아온다. **끝으로 달려들 때만** 뒤집는다 — 조건을 `s <= 0` 로만 두면
      // 방향이 매 프레임 뒤집혀 전차가 그 자리에서 떤다.
      if (!path.loop) {
        if (inst.def.s <= 0 && inst.def.dir === -1) inst.def.dir = 1;
        else if (inst.def.s >= path.total && inst.def.dir === 1) inst.def.dir = -1;
      }
    } else if (inst.def.state === 'docked') {
      /* 2026-09-10 — **자동 재출발은 없다** (사용자 보고: 콘솔을 만지지 않았는데 다시 떠났다).
       * `TRAM_DOCK_S` 는 이제 "정차 안내" 가 떠 있는 시간일 뿐이고, 그 뒤에는 `idle` 로 내려앉아
       * **운전실 콘솔이 다시 눌릴 때까지 서 있는다.** 두 상태 모두 `state !== 'moving'` 이라
       * 콘솔은 어느 쪽에서든 눌린다. */
      inst.dockTimer -= dt;
      if (host && inst.dockTimer <= 0) {
        inst.dockTimer = 0;
        inst.def.state = 'idle';
        ctx?.bus.emit('rail:tramDocked', { tramId: inst.def.id, platformId: inst.lastDock, docked: false });
        this.broadcastState();
      }
    }

    if (host && inst.def.state === 'moving') this.checkDock(inst, path);
    if (!host) {
      // 호스트가 준 `s` 로 부드럽게 끌어당긴다 (경로가 같으므로 오차는 지연분뿐이다)
      const d = deltaS(path, inst.def.s, inst.targetS);
      if (Math.abs(d) > TRAM_SNAP_M) inst.def.s = inst.targetS;
      else inst.def.s = wrapS(path, inst.def.s + d * Math.min(1, dt * 4));
    }

    placeTram(inst, path, speed, this.hash);
    updateTramHit(ctx, inst, speed, dt);

    if (host && ctx?.isMultiplayer && ctx.net) {
      this.netTimer -= dt;
      if (this.netTimer <= 0) { this.netTimer = TRAM_NET_INTERVAL; this.broadcastState(); }
    }
  }

  /**
   * 2026-09-10 — **출발은 알림 → 1초 대기 → 3초에 걸친 가속**이다 (사용자 결정). 예전에는 시동을 건
   * 프레임에 곧바로 `TRAM_SPEED` 로 튀어 나가서, 데크에 올라탄 사람이 그대로 떨어졌다.
   * 여기서는 `runT` 만 되감고 알림 한 줄을 띄운다 — 실제 감속/가속 곡선은 `tramSpeed` 다.
   * 호스트 · 클라이언트가 모두 부른다 (클라이언트는 `applyWire` 에서).
   */
  private beginRun(inst: TramInst): void {
    inst.runT = -TRAM_START_DELAY_S;
    if (this.nearDeparture(inst)) this.game?.bus.emit('ui:notify', { text: '전차가 곧 출발합니다', kind: 'info' });
  }

  /**
   * 2026-09-10 — 「전차가 곧 출발합니다」는 **떠나는 전차 곁에 있는 사람**에게만 뜬다 (사용자 결정).
   * 멀리 있는 승강장에서 부른 사람에게 "곧 출발" 은 틀린 말이다 — 그 사람에게는 「전차를 호출했다」가 이미 떴다.
   *
   * 곁 = 차체 단면(OBB) 바깥 거리가 `TRAM_DEPART_NOTICE_RANGE` 안 (탑승자는 0 이라 늘 포함, 옆 승강장 데크 ·
   * 계단 발치까지). 각 클라이언트가 **자기 플레이어로** 판단하므로 와이어는 그대로다. 방금 내가 불렀으면
   * (`callNoticeUntil`) 곁에 있어도 띄우지 않는다.
   */
  private nearDeparture(inst: TramInst): boolean {
    const ctx = this.game;
    const p = ctx?.player;
    if (!ctx || !p || p.isDead) return false;
    if (ctx.time < this.callNoticeUntil) return false;
    const c = Math.cos(inst.def.yaw), s = Math.sin(inst.def.yaw);
    const dx = p.position.x - inst.def.position.x, dz = p.position.z - inst.def.position.z;
    const ox = Math.max(0, Math.abs(dx * c + dz * s) - inst.halfLen);
    const oz = Math.max(0, Math.abs(-dx * s + dz * c) - inst.halfWid);
    return Math.hypot(ox, oz) <= TRAM_DEPART_NOTICE_RANGE;
  }

  /**
   * 지금 속도(m/s). `runT` 가 음수면 아직 서 있고(출발 알림 대기), 그 뒤 `TRAM_ACCEL_S` 동안
   * **cubic ease-in**(t³)으로 `TRAM_SPEED` 까지 오른다 — 선형이 아니라 점점 빨라진다.
   */
  private tramSpeed(inst: TramInst): number {
    if (inst.runT <= 0) return 0;
    const t = Math.min(1, inst.runT / Math.max(0.001, TRAM_ACCEL_S));
    return TRAM_SPEED * t * t * t;
  }

  private checkDock(inst: TramInst, path: RailPath): void {
    const ctx = this.game;
    for (let i = 0; i < this.platformS.length; i++) {
      const id = `plat_${i}`;
      const d = deltaS(path, inst.def.s, this.platformS[i]);
      if (Math.abs(d) > DOCK_WINDOW) {
        if (inst.lastDock === id && Math.abs(d) > DOCK_WINDOW * 2.5) inst.lastDock = null;
        continue;
      }
      if (inst.lastDock === id) continue;
      inst.def.s = this.platformS[i];
      inst.def.state = 'docked';
      inst.dockTimer = TRAM_DOCK_S;
      inst.runT = 0;
      inst.lastDock = id;
      ctx?.bus.emit('rail:tramDocked', { tramId: inst.def.id, platformId: id, docked: true });
      ctx?.bus.emit('audio:play', { id: 'tram_dock', position: inst.def.position });
      this.broadcastState();
      return;
    }
  }

  /* ── 시동 (호스트 권위) ───────────────────────────────────────────── */

  private requestStart(): void {
    const ctx = this.game;
    const inst = this.tram;
    if (!ctx || !inst || inst.def.state === 'moving') return;
    const net = ctx.net;
    if (ctx.isMultiplayer && net && !net.isHost) { net.send({ t: 'tramq', ev: 'start', id: inst.def.id }, 'host'); return; }
    this.applyStart(net?.localId ?? null);
  }

  /**
   * **호출** — 이 플랫폼을 목적지로 삼아 출발시킨다 (2026-09-10).
   *
   * 새 경로를 만들지 않는다: 목적지 쪽으로 방향만 정하고 그대로 `applyStart` 로 들어가므로
   * 알림 → `TRAM_START_DELAY_S` 대기 → `TRAM_ACCEL_S` 가속 → `checkDock` → `docked` → `idle` 까지가
   * 시동 콘솔과 **완전히 같은 절차**다. 그래서 호출로 온 전차도 도착하면 그 자리에 선다.
   *
   * **중복 호출은 거부한다** (무시도 예약도 아니다). 예약해 두면 누른 사람은 왜 안 오는지 모른 채
   * 기다리고, 도착한 전차가 아무도 안 만졌는데 다시 떠나는 2026-09-10 의 그 버그가 되살아난다.
   * 달리는 중에는 어차피 `applyStart` 가 거절하므로, 거부를 **눌리는 순간** 보여 주는 편이 정직하다 —
   * 정차하면 곧바로 다시 부를 수 있다.
   */
  private requestCall(index: number): void {
    const ctx = this.game;
    const inst = this.tram;
    if (!ctx || !inst) return;
    const state = this.callState(index);
    const at = this.callPos[index] ?? inst.def.position;
    if (state !== 'ready') {
      // 2026-09-11 (C-39): 호출 전용 거부음 — 예전에는 지하실 카드 리더기의 `keycard_deny` 를 빌려 썼다.
      ctx.bus.emit('audio:play', { id: 'tram_deny', position: at });
      ctx.bus.emit('ui:notify', {
        text: state === 'here' ? '전차가 이미 이 승강장에 있다' : '전차가 운행 중이다 — 정차한 뒤에 다시 부른다',
        kind: 'warning', duration: 2.2,
      });
      return;
    }
    /* 2026-09-10: 부른 사람에게는 **「전차를 호출했다」 한 줄만** 띄운다 — 싱글 · 호스트 · 클라이언트가 같다.
     * 곧이어 시작될 출발(`beginRun`)이 「곧 출발합니다」를 겹치지 않게 잠깐 입을 막는다 (`nearDeparture`). */
    this.callNoticeUntil = ctx.time + CALL_NOTICE_MUTE_S;
    ctx.bus.emit('ui:notify', { text: '전차를 호출했다', kind: 'info', duration: 2 });
    /* 2026-09-11 (C-39): 호출 접수 차임 — **부른 사람의 콘솔 자리에서, 이 클라이언트에만** 울린다. 출발음
     * `tram_start` 는 전차 위치에서 나므로 반대편 승강장에서 부른 사람에게는 거리 감쇠로 들리지 않았다.
     * 클라이언트는 호스트의 답을 기다리지 않고 낙관적으로 울린다 (토스트와 같다 — 거절되면 출발음이 없을 뿐). */
    ctx.bus.emit('audio:play', { id: 'tram_call', position: at });
    const net = ctx.net;
    if (ctx.isMultiplayer && net && !net.isHost) {
      /* 와이어에는 목적지 칸이 없다 (`TramRequest` 는 계약이고 이 배치는 `src/shared` 를 건드리지 않는다).
       * 호스트가 **요청자의 위치**에서 목적지를 읽는다 — `targetSFor`. */
      net.send({ t: 'tramq', ev: 'start', id: inst.def.id }, 'host');
      return;
    }
    this.applyStart(net?.localId ?? null, this.platformS[index]);
  }

  /**
   * 요청자에게 **가장 가까운 플랫폼**의 진행거리. 호출의 목적지를 와이어 없이 푸는 자리다.
   * 운전실 콘솔을 누른 사람은 정차한 전차 안에 있으므로 그 전차가 선 플랫폼이 뽑히고, 그러면
   * 목적지 = 지금 자리라 방향이 그대로 유지된다 (= 예전 동작). 위치를 모르면 null 이다.
   */
  private targetSFor(peer: PeerId): number | null {
    const net = this.game?.net;
    const line = this.line;
    if (!net || !line || this.platformS.length === 0) return null;
    const ref = net.getRemotePlayers().find((r) => r.id === peer);
    if (!ref) return null;
    let best = -1, bestD = Infinity;
    line.platforms.forEach((p, i) => {
      const d = Math.hypot(p.position.x - ref.position.x, p.position.z - ref.position.z);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best >= 0 ? this.platformS[best] : null;
  }

  /**
   * @param targetS 목적지로 삼을 진행거리 (호출). null 이면 지금 방향 그대로 (시동 콘솔).
   *   **`loop` 에서는 방향을 건드리지 않는다** — `TramDef.dir` 은 순환 선로에서 언제나 +1 이라고
   *   계약(`shared/types`)에 적혀 있고, 플랫폼이 둘뿐이라 그대로 돌아도 부른 쪽에 닿는다.
   */
  private applyStart(by: PeerId | null, targetS: number | null = null): void {
    const ctx = this.game;
    const inst = this.tram;
    if (!ctx || !inst || inst.def.state === 'moving') return;
    const path = this.path;
    if (targetS !== null && path && !path.loop) {
      const d = targetS - inst.def.s;
      if (Math.abs(d) > 0.01) inst.def.dir = d > 0 ? 1 : -1;
    }
    inst.def.state = 'moving';
    inst.dockTimer = 0;
    this.beginRun(inst);
    ctx.bus.emit('rail:tramStarted', { lineId: inst.def.lineId, tramId: inst.def.id, by });
    ctx.bus.emit('audio:play', { id: 'tram_start', position: inst.def.position });
    this.broadcastState();
  }

  /* ── 멀티 ─────────────────────────────────────────────────────────── */

  private wire(inst: TramInst): TramWire {
    return { id: inst.def.id, s: inst.def.s, dir: inst.def.dir, st: Math.max(0, TRAM_STATES.indexOf(inst.def.state)) };
  }

  private broadcastState(): void {
    const ctx = this.game;
    const net = ctx?.net;
    const inst = this.tram;
    if (!ctx || !net || !ctx.isMultiplayer || !net.isHost || !inst) return;
    net.send({ t: 'tram', ev: 'state', tram: this.wire(inst) }, 'others');
  }

  private applyWire(w: TramWire): void {
    const inst = this.tram;
    if (!inst || w.id !== inst.def.id) return;
    const prev = inst.def.state;
    inst.def.dir = w.dir;
    inst.def.state = (TRAM_STATES[w.st] ?? 'idle') as TramState;
    inst.targetS = w.s;
    if (inst.def.state !== 'moving') inst.def.s = w.s;
    if (prev !== 'docked' && inst.def.state === 'docked') {
      this.game?.bus.emit('audio:play', { id: 'tram_dock', position: inst.def.position });
    }
    if (prev !== 'moving' && inst.def.state === 'moving') {
      // 클라이언트도 같은 대기 · 가속 곡선을 굴린다 (알림 한 줄 + `vel` 이 맞아야 데크가 사람을 실어 간다)
      this.beginRun(inst);
      this.game?.bus.emit('audio:play', { id: 'tram_start', position: inst.def.position });
    }
    if (prev === 'moving' && inst.def.state !== 'moving') inst.runT = 0;
  }

  private ensureNet(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('tram', (m: TramMessage) => {
        if (!ctx.net || ctx.net.isHost) return;
        if (m.ev === 'state') this.applyWire(m.tram);
        else for (const w of m.trams) this.applyWire(w);
      }),
      net.onMessage('tramq', (m: TramRequest, from) => {
        if (!ctx.net?.isHost) return;
        if (m.ev === 'sync') { this.sendSync(from); return; }
        // 시동이든 호출이든 같은 요청이다 — 목적지는 요청자가 서 있는 자리에서 읽는다 (`targetSFor`).
        if (this.tram && m.id === this.tram.def.id) this.applyStart(from, this.targetSFor(from));
      }),
      net.onMessage('flow', (m, from) => { if (m.ev === 'rejoined' && ctx.net?.isHost) this.sendSync(from); }),
      ctx.bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost && this.built) this.requestSync(); }),
    );
  }

  private requestSync(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
    net.send({ t: 'tramq', ev: 'sync' }, 'host');
  }

  private sendSync(to: PeerId): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || !this.tram) return;
    net.send({ t: 'tram', ev: 'sync', trams: [this.wire(this.tram)] }, to);
  }
}
