/**
 * src/world/Rails.ts — **선로 · 플랫폼 · 전차**.
 *
 * 구역마다 `RAIL_CHANCE` 로 놓이고, 모양은 두 가지다 — 구역 외곽을 도는 **순환 선로**(`loop`)와 구역을
 * 가로지르는 **왕복 직선 선로**(`line`). 이동 수단이면서 파밍 장소다: 플랫폼만 털거나, 콘솔에서
 * `TRAM_START_HOLD_S` 홀드로 전차에 시동을 걸고 올라타 **달리는 전차 안**을 털면서 다음 플랫폼까지 간다.
 *
 * 소유 계약: `RailLineDef` · `RailPlatformDef` · `TramDef` · `TramState` · `WorldRef.getRailLines / getTrams`
 * · `rail:tramStarted` / `rail:tramDocked` · `TramMessage`(`tram`) / `TramRequest`(`tramq`) · `RAIL_*` / `TRAM_*`.
 *
 * **선로는 지형을 평탄화하지 않는다** — 교각이 높이를 맞춘다 (평탄화하면 맵 한복판에 1 km 짜리 활주로가
 * 생긴다). 평탄화하는 것은 플랫폼 자리뿐이고 그 패드는 `layout.ts` 가 잡는다.
 *
 * 전차의 진짜 상태는 **선로 위 진행거리 `s` 하나**이고 **호스트 권위**다. 경로는 시드 결정적이라
 * 와이어에는 `s` · 방향 · 상태만 흐른다 (`TRAM_NET_INTERVAL` 마다 한 번).
 */
import * as THREE from 'three';
import {
  Layers, TRAM_DOCK_S, TRAM_SPEED, TRAM_START_HOLD_S, TRAM_STATES,
  type GameContext, type PeerId, type RailLineDef, type RailPlatformDef, type Random,
  type TramDef, type TramMessage, type TramRequest, type TramState, type TramWire,
} from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from './build';
import type { ObstacleEntry, SpatialHash } from './SpatialHash';
import {
  DOCK_WINDOW, GAUGE_HALF, PIER_STEP, PLATFORM_OFFSET, RAIL_DECK_Y, TIE_STEP,
  TRAM_NET_INTERVAL, TRAM_SNAP_M, type RailPath, deltaS, makePath, nearestS, sampleAt, wrapS,
} from './rails/model';
import { ContainerSet, type ContainerSpec } from './structures/parts/Containers';
import { pickTier, structureRow } from './structures/model';

/** 전차 바닥이 레일 상면 위로 뜨는 높이(m). 플랫폼 데크 윗면도 같은 높이라 그냥 걸어 건넌다. */
const TRAM_FLOOR_UP = 0.35;
/** 옆판 가운데를 비워 두는 승강구의 반폭(m). 양쪽 다 비운다 (왕복 선로에서 전차가 뒤집혀 달린다). */
const TRAM_DOOR_HALF = 1.4;

const STEEL = new THREE.Color(0x6a6f76);
const STEEL_DARK = new THREE.Color(0x33383e);
const TIE = new THREE.Color(0x4a423a);
const DECK = new THREE.Color(0x6d6a63);
const DECK_DARK = new THREE.Color(0x45433e);

interface MovingPart {
  entry: ObstacleEntry;
  /** 전차 로컬 오프셋 (X = 폭, Z = 길이). */
  ox: number; oz: number;
  /** 상자 밑면의 y 오프셋 (전차 바닥 기준). */
  oy: number;
}

interface TramInst {
  def: TramDef;
  root: THREE.Group;
  parts: MovingPart[];
  /** 모든 발판 콜라이더가 **같은 객체**를 참조한다 — 제자리에서 고치면 다 같이 바뀐다. */
  vel: THREE.Vector3;
  containers: { spec: ContainerSpec; ox: number; oz: number; oy: number }[];
  dockTimer: number;
  lastDock: string | null;
  /** 클라이언트가 맞춰 갈 호스트의 `s` (호스트에서는 쓰지 않는다). */
  targetS: number;
}

export class Rails {
  readonly group = new THREE.Group();
  private path: RailPath | null = null;
  private line: RailLineDef | null = null;
  private platformS: number[] = [];
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
    const path = makePath(pts, loop);
    this.path = path;

    const railMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.6 });
    this.mats.push(railMat);
    this.mat = railMat;
    this.buildTrack(ctx, rng, path, railMat);

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
      this.buildPlatform(ctx, game, rng, def, platRow, pad.height, deckTop, yaw, ax, az, specs);
    });

    this.line = {
      id: 'rail_0', kind: plan.kind, points: pts, length: path.total, platforms,
    };

    /* ── 전차 ───────────────────────────────────────────────────────── */
    this.buildTram(ctx, rng, path, specs);

    this.containers.build(ctx, game, specs);
    ctx.root.add(this.group);
    this.requestSync();
  }

  dispose(): void {
    const game = this.game;
    this.containers.dispose();
    for (const p of this.platformS.keys()) game?.interactables.unregister(`rail:plat_${p}:console`);
    this.platformS.length = 0;
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

  /* ── 선로 지오메트리 ──────────────────────────────────────────────── */

  private buildTrack(ctx: BuildCtx, rng: Random, path: RailPath, mat: THREE.MeshStandardMaterial): void {
    const parts: THREE.BufferGeometry[] = [];
    const pos = new THREE.Vector3(), tan = new THREE.Vector3();
    // 침목 + 레일 토막: 구간마다 한 덩어리로 놓아 곡선을 따라간다
    for (let s = 0; s < path.total; s += TIE_STEP) {
      sampleAt(path, s, pos, tan);
      const yaw = Math.atan2(tan.z, tan.x);
      const tie = new THREE.BoxGeometry(0.9, 0.16, GAUGE_HALF * 2 + 0.5);
      xform(tie, { x: pos.x, y: pos.y - 0.16, z: pos.z }, new THREE.Euler(0, -yaw, 0));
      paint(tie, TIE, 0.09, rng);
      parts.push(tie);
      for (const side of [-1, 1]) {
        const rail = new THREE.BoxGeometry(TIE_STEP + 0.12, 0.14, 0.16);
        xform(rail, { x: 0, y: 0, z: side * GAUGE_HALF });
        xform(rail, { x: pos.x, y: pos.y - 0.04, z: pos.z }, new THREE.Euler(0, -yaw, 0));
        paintGradient(rail, STEEL_DARK, STEEL);
        parts.push(rail);
      }
    }
    // 교각 (지형까지 내려가는 기둥) — 이것만 콜라이더를 갖는다
    for (let s = 0; s < path.total; s += PIER_STEP) {
      sampleAt(path, s, pos, tan);
      const ground = ctx.terrain.getHeightAt(pos.x, pos.z);
      const h = Math.max(0.4, pos.y - 0.3 - ground);
      const yaw = Math.atan2(tan.z, tan.x);
      const pier = new THREE.BoxGeometry(0.55, h, 0.55);
      xform(pier, { x: pos.x, y: ground + h / 2, z: pos.z }, new THREE.Euler(0, -yaw, 0));
      paintGradient(pier, STEEL_DARK, STEEL, ground, ground + h);
      parts.push(pier);
      const cap = new THREE.BoxGeometry(1.5, 0.2, GAUGE_HALF * 2 + 0.7);
      xform(cap, { x: pos.x, y: ground + h + 0.1, z: pos.z }, new THREE.Euler(0, -yaw, 0));
      paint(cap, STEEL_DARK, 0.05, rng);
      parts.push(cap);
      ctx.hash.addBox(new THREE.Vector3(pos.x, ground, pos.z), 0.3, 0.3, yaw, h, 'pier');
    }
    const geo = merge(parts);
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.layers.enable(Layers.PROP);
    mesh.name = 'rail_track';
    this.group.add(mesh);
  }

  /* ── 플랫폼 ───────────────────────────────────────────────────────── */

  private buildPlatform(
    ctx: BuildCtx, game: GameContext, rng: Random, def: RailPlatformDef,
    row: ReturnType<typeof structureRow>, groundY: number, deckTop: number, yaw: number,
    ax: number, az: number, specs: ContainerSpec[],
  ): void {
    const halfW = row ? row.halfW : 7, halfD = row ? row.halfD : 4.5;
    const parts: THREE.BufferGeometry[] = [];
    const { x: cx, z: cz } = def.position;
    const deckH = Math.max(0.4, deckTop - groundY);

    // 데크: **뜬 상자 콜라이더**가 아니라 땅에서 올라오는 덩어리다 (밑에 들어갈 일이 없다)
    const deck = new THREE.BoxGeometry(halfW * 2, deckH, halfD * 2);
    xform(deck, { x: cx, y: deckTop - deckH / 2, z: cz }, new THREE.Euler(0, -yaw, 0));
    paintGradient(deck, DECK_DARK, DECK, deckTop - deckH, deckTop);
    parts.push(deck);
    ctx.hash.addBox(new THREE.Vector3(cx, deckTop - deckH, cz), halfW, halfD, yaw, deckH, 'platform');

    // 계단 (바깥쪽으로 4단)
    {
      const steps = 4;
      for (let i = 0; i < steps; i++) {
        const top = groundY + (deckH * (steps - i)) / (steps + 1);
        const px = cx + ax * (halfD + 0.45 + i * 0.9), pz = cz + az * (halfD + 0.45 + i * 0.9);
        const h = Math.max(0.12, top - groundY);
        const g = new THREE.BoxGeometry(4.4, h, 0.9);
        xform(g, { x: px, y: groundY + h / 2, z: pz }, new THREE.Euler(0, -yaw, 0));
        paint(g, DECK_DARK, 0.05, rng);
        parts.push(g);
        ctx.hash.addBox(new THREE.Vector3(px, groundY, pz), 2.2, 0.45, yaw, h, 'platform');
      }
    }

    // 바깥쪽 난간 · 지붕 기둥 (실루엣만 — 카메라를 막지 않는다)
    for (let i = -1; i <= 1; i += 2) {
      const g = new THREE.BoxGeometry(0.28, 2.6, 0.28);
      const px = cx + ax * (halfD - 0.5) + Math.cos(yaw) * (halfW - 0.8) * i;
      const pz = cz + az * (halfD - 0.5) + Math.sin(yaw) * (halfW - 0.8) * i;
      xform(g, { x: px, y: deckTop + 1.3, z: pz }, new THREE.Euler(0, -yaw, 0));
      paint(g, STEEL_DARK, 0.06, rng);
      parts.push(g);
    }
    {
      const rail = new THREE.BoxGeometry(halfW * 2, 0.14, 0.16);
      const px = cx + ax * (halfD - 0.25), pz = cz + az * (halfD - 0.25);
      xform(rail, { x: px, y: deckTop + 1.0, z: pz }, new THREE.Euler(0, -yaw, 0));
      paint(rail, STEEL, 0.05, rng);
      parts.push(rail);
    }

    const geo = merge(parts);
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, this.mat!);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.layers.enable(Layers.PROP);
    mesh.name = `rail_${def.id}`;
    this.group.add(mesh);

    // 컨테이너 (데크 위, 선로 반대쪽에 붙여)
    const count = row ? row.containers : 4;
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : (i / (count - 1) - 0.5) * (halfW * 2 - 2.4);
      const px = cx + Math.cos(yaw) * t + ax * (halfD - 1.1);
      const pz = cz + Math.sin(yaw) * t + az * (halfD - 1.1);
      specs.push({
        id: `${def.id}_c${i}`, position: new THREE.Vector3(px, deckTop, pz), yaw: yaw + Math.PI / 2,
        tier: pickTier(row ? row.tiers : [], rng.next()), style: (i % 3) as 0 | 1 | 2,
        zoneId: def.id, zoneKind: 'platform',
      });
    }

    // 콘솔 (전차 시동)
    {
      const px = cx + Math.cos(yaw) * (halfW - 1.2) - ax * (halfD - 1.0);
      const pz = cz + Math.sin(yaw) * (halfW - 1.2) - az * (halfD - 1.0);
      const post = new THREE.BoxGeometry(0.8, 1.1, 0.5);
      xform(post, { x: px, y: deckTop + 0.55, z: pz }, new THREE.Euler(0, -yaw, 0));
      paintGradient(post, STEEL_DARK, STEEL, deckTop, deckTop + 1.1);
      const cgeo = merge([post]);
      this.geos.push(cgeo);
      const cm = new THREE.Mesh(cgeo, this.mat!);
      cm.castShadow = true;
      cm.name = `rail_${def.id}_console`;
      this.group.add(cm);
      ctx.hash.add(new THREE.Vector3(px, deckTop, pz), 0.5, 1.1, 'console');

      const pos = new THREE.Vector3(px, deckTop, pz);
      game.interactables.register({
        id: `rail:${def.id}:console`,
        position: pos,
        radius: 2.6,
        holdTime: TRAM_START_HOLD_S,
        getPrompt: () => {
          const st = this.tram?.def.state;
          if (!st) return null;
          return st === 'moving' ? null : '전차 시동 (E)';
        },
        canInteract: () => !!this.game?.isGameplayActive() && this.tram?.def.state !== 'moving',
        interact: () => this.requestStart(),
      });
    }
  }

  /* ── 전차 ─────────────────────────────────────────────────────────── */

  private buildTram(ctx: BuildCtx, rng: Random, path: RailPath, specs: ContainerSpec[]): void {
    const row = structureRow('tram');
    const halfW = row ? row.halfW : 1.9, halfD = row ? row.halfD : 6, wallH = row ? row.wallH : 2.2;
    const parts: THREE.BufferGeometry[] = [];

    // 바닥 · 대차
    const floor = new THREE.BoxGeometry(halfW * 2, 0.3, halfD * 2);
    xform(floor, { x: 0, y: -0.15, z: 0 });
    paintGradient(floor, STEEL_DARK, STEEL);
    parts.push(floor);
    for (const s of [-1, 1]) {
      const bogie = new THREE.BoxGeometry(halfW * 1.5, 0.4, 1.6);
      xform(bogie, { x: 0, y: -0.5, z: s * halfD * 0.6 });
      paint(bogie, STEEL_DARK, 0.06, rng);
      parts.push(bogie);
    }
    /* 옆판 (허리 높이 — 위가 열려 있어 카메라가 갇히지 않는다). 가운데는 **승강구**로 비운다:
     * 양쪽 다 비우는 이유는 왕복 선로에서 전차가 뒤집혀 달리기 때문이다 (플랫폼이 반대편에 온다). */
    const doorHalf = TRAM_DOOR_HALF;
    for (const s of [-1, 1]) {
      for (const seg of [-1, 1]) {
        const z0 = seg < 0 ? -halfD : doorHalf, z1 = seg < 0 ? -doorHalf : halfD;
        const len = z1 - z0;
        const w = new THREE.BoxGeometry(0.24, 1.05, len);
        xform(w, { x: s * halfW, y: 0.52, z: (z0 + z1) / 2 });
        paintGradient(w, STEEL_DARK, STEEL, 0, 1.05);
        parts.push(w);
        const cap = new THREE.BoxGeometry(0.34, 0.1, len);
        xform(cap, { x: s * halfW, y: 1.08, z: (z0 + z1) / 2 });
        paint(cap, STEEL, 0.05, rng);
        parts.push(cap);
      }
    }
    // 운전실 (앞쪽 끝) + 전조등
    {
      const cab = new THREE.BoxGeometry(halfW * 2, wallH, 1.8);
      xform(cab, { x: 0, y: wallH / 2, z: halfD - 0.9 });
      paintGradient(cab, STEEL_DARK, STEEL, 0, wallH);
      parts.push(cab);
      const glass = new THREE.BoxGeometry(halfW * 1.5, 0.6, 0.08);
      xform(glass, { x: 0, y: wallH * 0.66, z: halfD - 0.02 });
      paint(glass, new THREE.Color(0x1b3742));
      parts.push(glass);
    }
    // 후미 난간
    {
      const g = new THREE.BoxGeometry(halfW * 2, 1.05, 0.22);
      xform(g, { x: 0, y: 0.52, z: -halfD });
      paintGradient(g, STEEL_DARK, STEEL, 0, 1.05);
      parts.push(g);
    }

    const geo = merge(parts);
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, this.mat!);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.layers.enable(Layers.PROP);
    const root = new THREE.Group();
    root.name = 'tram';
    root.add(mesh);
    this.group.add(root);

    const startS = this.platformS.length > 0 ? this.platformS[0] : 0;
    const vel = new THREE.Vector3();
    const def: TramDef = {
      id: 'tram_rail_0', lineId: 'rail_0',
      position: new THREE.Vector3(), yaw: 0, state: 'idle', s: startS, dir: 1,
    };
    const inst: TramInst = {
      def, root, parts: [], vel, containers: [], dockTimer: 0,
      lastDock: this.platformS.length > 0 ? 'plat_0' : null, targetS: startS,
    };

    /* 콜라이더: 바닥(= 발판) 하나 + 옆판 둘 + 운전실 하나. 전부 `Obstacle.box` 이고 `velocity` 는
     * **같은 벡터 객체**를 공유한다 — 매 프레임 그 하나만 고치면 발판 질의가 곧바로 새 속도를 본다. */
    const addPart = (ox: number, oz: number, oy: number, hx: number, hz: number, h: number, kind: string): void => {
      const entry = ctx.hash.addBox(new THREE.Vector3(0, -9999, 0), hx, hz, 0, h, kind);
      entry.velocity = vel;
      inst.parts.push({ entry, ox, oz, oy });
    };
    addPart(0, 0, -0.3, halfW, halfD, 0.3, 'tram');                       // 바닥 (윗면 = 전차 바닥)
    for (const sx of [-1, 1]) for (const seg of [-1, 1]) {
      const z0 = seg < 0 ? -halfD : TRAM_DOOR_HALF, z1 = seg < 0 ? -TRAM_DOOR_HALF : halfD;
      addPart(sx * halfW, (z0 + z1) / 2, 0, 0.12, (z1 - z0) / 2, 1.05, 'tram');   // 옆판 (승강구 빼고)
    }
    addPart(0, halfD - 0.9, 0, halfW, 0.9, wallH, 'tram');                // 운전실
    addPart(0, -halfD, 0, halfW, 0.11, 1.05, 'tram');                     // 후미 난간

    // 객실 컨테이너 (움직인다 — `ContainerSpec.dynamic`)
    const count = row ? row.containers : 3;
    for (let i = 0; i < count; i++) {
      const oz = -halfD + 1.6 + (i * (halfD * 2 - 4.2)) / Math.max(1, count - 1);
      const ox = (i % 2 === 0 ? -1 : 1) * (halfW - 0.8);
      const spec: ContainerSpec = {
        id: `tram_c${i}`, position: new THREE.Vector3(), yaw: 0,
        tier: pickTier(row ? row.tiers : [], rng.next()), style: (i % 3) as 0 | 1 | 2,
        zoneId: 'tram_rail_0', zoneKind: 'platform', dynamic: true,
      };
      specs.push(spec);
      inst.containers.push({ spec, ox, oz, oy: 0 });
    }

    this.tram = inst;
    this.placeTram(inst, path, 0);
  }

  /** `s` 에서 전차 · 콜라이더 · 컨테이너를 다시 놓는다. `speed` 는 발판 속도(m/s, 0 이면 정지). */
  private placeTram(inst: TramInst, path: RailPath, speed: number): void {
    sampleAt(path, inst.def.s, this.sPos, this.sTan);
    const yaw = Math.atan2(this.sTan.z, this.sTan.x) + (inst.def.dir < 0 ? Math.PI : 0);
    const fy = this.sPos.y + TRAM_FLOOR_UP;
    inst.def.position.set(this.sPos.x, fy, this.sPos.z);
    inst.def.yaw = yaw;
    inst.root.position.set(this.sPos.x, fy, this.sPos.z);
    inst.root.rotation.y = -yaw;
    inst.vel.set(this.sTan.x * speed * inst.def.dir, 0, this.sTan.z * speed * inst.def.dir);

    const c = Math.cos(yaw), s = Math.sin(yaw);
    // 로컬 X = 폭, 로컬 Z = 길이. 메시는 Euler(0, −yaw, 0) 이라 로컬 +X → 월드 (cos, sin), +Z → (−sin, cos).
    for (const p of inst.parts) {
      const wx = this.sPos.x + p.ox * c - p.oz * s;
      const wz = this.sPos.z + p.ox * s + p.oz * c;
      this.hash?.move(p.entry, wx, fy + p.oy, wz, yaw);
    }
    for (const cc of inst.containers) {
      cc.spec.position.set(this.sPos.x + cc.ox * c - cc.oz * s, fy + cc.oy, this.sPos.z + cc.ox * s + cc.oz * c);
      cc.spec.yaw = yaw + (cc.ox < 0 ? 0 : Math.PI);
    }
  }

  /* ── update ───────────────────────────────────────────────────────── */

  update(dt: number, time: number): void {
    if (!this.built) return;
    this.containers.update(dt, time);
    const inst = this.tram, path = this.path;
    if (!inst || !path) return;
    const ctx = this.game;
    const host = !ctx?.isMultiplayer || !ctx.net || ctx.net.isHost;

    let speed = 0;
    if (inst.def.state === 'moving') {
      speed = TRAM_SPEED;
      inst.def.s = wrapS(path, inst.def.s + TRAM_SPEED * inst.def.dir * dt);
      // 왕복 선로는 끝에서 되돌아온다. **끝으로 달려들 때만** 뒤집는다 — 조건을 `s <= 0` 로만 두면
      // 방향이 매 프레임 뒤집혀 전차가 그 자리에서 떤다.
      if (!path.loop) {
        if (inst.def.s <= 0 && inst.def.dir === -1) inst.def.dir = 1;
        else if (inst.def.s >= path.total && inst.def.dir === 1) inst.def.dir = -1;
      }
    } else if (inst.def.state === 'docked') {
      inst.dockTimer -= dt;
      if (host && inst.dockTimer <= 0) {
        inst.def.state = 'moving';
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

    this.placeTram(inst, path, speed);

    if (host && ctx?.isMultiplayer && ctx.net) {
      this.netTimer -= dt;
      if (this.netTimer <= 0) { this.netTimer = TRAM_NET_INTERVAL; this.broadcastState(); }
    }
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

  private applyStart(by: PeerId | null): void {
    const ctx = this.game;
    const inst = this.tram;
    if (!ctx || !inst || inst.def.state === 'moving') return;
    inst.def.state = 'moving';
    inst.dockTimer = 0;
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
      this.game?.bus.emit('audio:play', { id: 'tram_start', position: inst.def.position });
    }
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
        if (this.tram && m.id === this.tram.def.id) this.applyStart(from);
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
