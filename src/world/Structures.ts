/**
 * src/world/Structures.ts — **버려진 구조물** (전진기지 · 연구실 · 불시착 함선).
 *
 * 들어갈 수 있는 폐건물이다. 안에는 상호작용 컨테이너가 밀집해 있고, 전진기지 · 연구실에는 **지하실**이
 * 딸릴 수 있다 — 지하실 문은 **언제나 잠겨 있고** 그 구조물의 지상층 컨테이너 **딱 하나**에 키카드가
 * 들어 있다 (`key_basement`, 열면 소비된다). 전진기지 · 연구실의 **옥상**에는 주변 안개를 걷는 **맵 스캐너**가
 * 있다 (구조물당 1회).
 *
 * 2026-09-11 — 천장 · 2층 · 창문 · 사다리 · 옥상 스캐너 · 실내 조명 · 지하 계단 복도와 서 있는 문
 * (지오메트리는 `structures/parts/Build`, 유리는 `parts/Glass`, 파동은 `parts/ScanWave`). 여기에는 수명 ·
 * 상호작용 · 멀티만 남는다.
 *
 * 소유 계약: `StructureDef` · `LadderDef` · `WorldRef.getStructures / structureAt / getLadders` ·
 * `structure:unlocked / scanned / investigated / glassBroken` · `ladder:grab` · `StructureMessage`(`struct`) /
 * `StructureRequest`(`structq`) · `STRUCTURE_*` 상수. 수치는 `data/structures.csv` (`structures/model.ts` 가 읽는다).
 *
 * 멀티: 지하실 개방 · 맵 스캔은 **호스트 권위**다 (`Gather` 의 `harv` / `harvq` 와 같은 모양). 창문은 **깬 사람이
 * 알린다** — 누가 깨든 결과가 같아서 확정이 필요 없다.
 */
import * as THREE from 'three';
import {
  LADDER_GRAB_RANGE, Layers, LightPool, STRUCTURE_INTERACT_RANGE, STRUCTURE_LABEL_KO, STRUCTURE_POINT_LIGHTS,
  STRUCTURE_SCAN_HOLD_S, STRUCTURE_SCAN_RADIUS, STRUCTURE_UNLOCK_HOLD_S,
  type GameContext, type LadderDef, type LightFixture, type PeerId, type Random, type StructureDef, type StructureKind,
  type StructureMessage, type StructureRequest,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { type BuildCtx, merge, paint, paintGradient, xform } from './build';
import type { ObstacleEntry, SpatialHash } from './SpatialHash';
import {
  PALETTE, type BuildingPlan, type DoorSpot, type Spot, type StructureNav, buildBuilding, buildWreck, mergeOrNull,
} from './structures/parts/Build';
import { ContainerSet, type ContainerSpec } from './structures/parts/Containers';
import { GlassSet, type WindowSpec } from './structures/parts/Glass';
import { ScanWave } from './structures/parts/ScanWave';
import { pickTier, structureRow } from './structures/model';

/** 지하실 열쇠의 아이템 def id. `items/` 가 아직 등록하지 않았으면 키카드가 그냥 안 들어간다 (문은 그대로 잠긴다). */
export const BASEMENT_KEY_DEF = 'key_basement';

/** 지하실 문짝이 옆으로 밀려나는 데 걸리는 시간(초). */
const DOOR_SLIDE_S = 1.1;

interface Inst {
  def: StructureDef;
  /** 잠긴 동안 복도를 막는 문짝 콜라이더. 열리면 hash 에서 빠진다. */
  doorEntry: ObstacleEntry | null;
  doorMesh: THREE.Object3D | null;
  readonly doorBase: THREE.Vector3;
  readonly doorSlide: THREE.Vector3;
  doorAnim: number;      // −1 idle
  scanMat: THREE.MeshStandardMaterial | null;
  /** 옥상 스캐너 자리 (불시착 함선은 null). */
  scanPos: THREE.Vector3 | null;
}

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

export class Structures {
  readonly group = new THREE.Group();
  private readonly insts: Inst[] = [];
  private readonly byId = new Map<string, Inst>();
  private readonly defs: StructureDef[] = [];
  private readonly ladders: LadderDef[] = [];
  /** 2026-09-12: 건물 안내 (도달성 스모크 · 디버그 전용 — 판정에 쓰지 않는다). */
  private readonly navs: { id: string; kind: StructureKind; nav: StructureNav; basementDoor: { x: number; y: number; z: number } | null }[] = [];
  /**
   * 로그 강하를 이미 굴린 구역 (`structure:investigated` 의 `zoneId`). 구조물 id 뿐 아니라 **선로 플랫폼 ·
   * 전차**의 zoneId 도 들어간다 — 그쪽은 `StructureDef` 가 아니라 여기 문자열로만 남는다.
   * `struct sync.rogued` 가 통째로 실어 나른다: 굴려서 **실패한** 구역은 다른 와이어가 없으므로,
   * 호스트가 바뀌면 새 호스트는 이 목록으로만 "그 구역은 이미 소진됐다" 를 안다.
   */
  private readonly roguedZones = new Set<string>();
  private readonly containers = new ContainerSet('StructureContainers');
  private glass = new GlassSet();
  private scanWave = new ScanWave();
  private lightPool: LightPool | null = null;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private structMat: THREE.MeshStandardMaterial | null = null;
  private glowMat: THREE.MeshStandardMaterial | null = null;
  private hash: SpatialHash | null = null;
  private game: GameContext | null = null;
  private built = false;
  private netHooked = false;
  private busHooked = false;
  private readonly unsubs: Array<() => void> = [];

  constructor() { this.group.name = 'Structures'; }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /** `WorldSystem.init` 에서 한 번. 네트워크 훅은 `ctx.net` 이 게시된 뒤 게으르게 붙는다. */
  attach(game: GameContext): void {
    this.game = game;
    this.hookBus();
    this.ensureNet();
  }

  /** 시스템 dispose 전용 (미션 사이의 `clear()` 는 구독을 유지한다). */
  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.netHooked = false;
    this.busHooked = false;
    this.game = null;
  }

  getDefs(): readonly StructureDef[] { return this.defs; }

  getLadders(): readonly LadderDef[] { return this.ladders; }

  /** 창문 (디버그 · 스모크). */
  get glassSet(): GlassSet { return this.glass; }
  /** 맵 스캐너 파동 (디버그 · 스모크). */
  get scanWaves(): ScanWave { return this.scanWave; }
  /** 광원 풀 (디버그 · 스모크). */
  get lights(): LightPool | null { return this.lightPool; }
  /** 컨테이너가 열린 모습인가 (디버그 · 스모크). */
  isContainerOpened(id: string): boolean { return this.containers.isOpened(id); }
  /**
   * 2026-09-12: 건물마다의 안내 — 정문 안팎 · 방 사각형 · 계단 층계참/도착 자리 · 지하실 문 상호작용 자리
   * (`scripts/smoke-structure-reach.mjs` 가 이것으로 flood fill 을 시작하고 목표를 잡는다). 디버그 · 스모크 전용.
   */
  debugNav(): readonly { id: string; kind: StructureKind; nav: StructureNav; basementDoor: { x: number; y: number; z: number } | null }[] {
    return this.navs;
  }

  /** `(x, z)` 를 품는 구조물 (자기 `radius` 안), 없으면 null. */
  structureAt(x: number, z: number): StructureDef | null {
    for (let i = 0; i < this.defs.length; i++) {
      const d = this.defs[i];
      const dx = d.position.x - x, dz = d.position.z - z;
      if (dx * dx + dz * dz <= d.radius * d.radius) return d;
    }
    return null;
  }

  /** 컨테이너가 이 클라이언트에서 처음 열렸을 때 (월드가 `crate opened` 를 보낸다). */
  setOpenListener(cb: ((id: string) => void) | null): void { this.containers.setOpenListener(cb); }
  /** 남이 연 컨테이너를 열린 모습으로. 이 묶음의 것이 아니면 false. */
  markContainerOpened(id: string): boolean { return this.containers.markOpened(id); }
  /** 2026-09-11 (C-57): 컨테이너 위치 (없으면 null). */
  containerPositionOf(id: string): THREE.Vector3 | null { return this.containers.positionOf(id); }

  build(ctx: BuildCtx, game: GameContext): void {
    this.game = game;
    this.hash = ctx.hash;
    this.hookBus();
    this.ensureNet();
    this.built = true;
    /* 광원 풀은 **구조물이 하나도 없어도** 만든다 — 레이드의 점광원 개수를 맵마다 같게 둔다 (`core/LightBudget`). */
    this.lightPool = new LightPool(this.group, STRUCTURE_POINT_LIGHTS, [], 'StructureLight');
    this.group.add(this.scanWave.group);
    ctx.root.add(this.group);
    const sites = ctx.layout.structures;
    if (sites.length === 0) return;
    const rng = ctx.rng.fork('structures');

    this.structMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.84, metalness: 0.2 });
    this.glowMat = new THREE.MeshStandardMaterial({ color: 0x08120f, emissive: new THREE.Color(0xfff0d0), emissiveIntensity: 1.6 });
    this.mats.push(this.structMat, this.glowMat);

    const specs: ContainerSpec[] = [];
    const glassSpecs: { structureId: string; index: number; spec: WindowSpec }[] = [];
    const fixtures: LightFixture[] = [];
    const counters: Partial<Record<StructureKind, number>> = {};
    for (const site of sites) {
      const row = structureRow(site.kind);
      if (!row) continue;
      const n = counters[site.kind] ?? 0;
      counters[site.kind] = n + 1;
      const id = `struct_${site.kind}_${n}`;
      const plan: BuildingPlan = {
        cx: site.pad.x, cz: site.pad.z, yaw: site.pad.yaw, y0: site.pad.height,
        halfW: site.halfW, halfD: site.halfD, wallH: site.wallH, pit: site.pit, floors: site.floors,
        containers: row.containers, basementContainers: row.basementContainers,
      };
      const out = site.kind === 'wreck' ? buildWreck(ctx, plan, rng) : buildBuilding(ctx, plan, rng, site.kind === 'lab');

      const body = mergeOrNull(out.parts);
      if (body) {
        this.geos.push(body);
        const mesh = new THREE.Mesh(body, this.structMat);
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.layers.enable(Layers.PROP);
        mesh.name = id;
        this.group.add(mesh);
      }
      const glow = mergeOrNull(out.glow);
      if (glow) {
        this.geos.push(glow);
        const gm = new THREE.Mesh(glow, this.glowMat);
        gm.name = `${id}_glow`;
        this.group.add(gm);
      }

      const def: StructureDef = {
        id, kind: site.kind,
        position: new THREE.Vector3(site.pad.x, site.pad.height, site.pad.z),
        yaw: site.pad.yaw,
        radius: Math.hypot(site.halfW, site.halfD) + 2,
        hasBasement: out.door !== null,
        basementDoor: out.door ? new THREE.Vector3(out.door.x, out.door.y, out.door.z) : null,
        unlocked: false, scanned: false, rogueDropUsed: false,
      };
      const inst: Inst = {
        def, doorEntry: null, doorMesh: null, doorBase: new THREE.Vector3(), doorSlide: new THREE.Vector3(), doorAnim: -1,
        scanMat: null, scanPos: null,
      };

      /* 컨테이너: 지상층(1 · 2층) + (있으면) 지하실. 키카드는 **지상 컨테이너 하나**에만 들어간다 — 지하실 안에
       * 넣으면 영영 못 여는 방이 된다. 자리 고르기는 `buildBuilding` 이 이미 끝냈다 (조명이 그 방에 달린다). */
      const ground = out.containers;
      const keyIdx = def.hasBasement && ground.length > 0 ? rng.int(0, ground.length - 1) : -1;
      ground.forEach((s, i) => specs.push({
        id: `${id}_c${i}`, position: new THREE.Vector3(s.x, s.y, s.z), yaw: s.yaw,
        tier: pickTier(row.tiers, rng.next()), style: (i % 3) as 0 | 1 | 2,
        zoneId: id, zoneKind: site.kind,
        bonusDefId: i === keyIdx ? BASEMENT_KEY_DEF : undefined,
      }));
      const deepTiers = row.basementTiers.length > 0 ? row.basementTiers : row.tiers;
      out.basementContainers.forEach((s, i) => specs.push({
        id: `${id}_b${i}`, position: new THREE.Vector3(s.x, s.y, s.z), yaw: s.yaw,
        tier: pickTier(deepTiers, rng.next()), style: ((i + 1) % 3) as 0 | 1 | 2,
        zoneId: id, zoneKind: site.kind,
      }));

      if (out.console) this.buildConsole(ctx, game, rng, inst, out.console);
      if (out.door) this.buildDoor(ctx, game, rng, inst, out.door);
      out.ladders.forEach((l, i) => {
        const ladder: LadderDef = {
          id: `ladder_${id}_${i}`,
          base: new THREE.Vector3(l.base.x, l.base.y, l.base.z),
          topY: l.topY,
          normal: new THREE.Vector3(l.normal.x, 0, l.normal.z).normalize(),
          exit: new THREE.Vector3(l.exit.x, l.exit.y, l.exit.z),
        };
        this.ladders.push(ladder);
        this.registerLadder(game, ladder);
      });
      out.windows.forEach((w, i) => glassSpecs.push({ structureId: id, index: i, spec: w }));
      fixtures.push(...out.fixtures);
      this.navs.push({ id, kind: site.kind, nav: out.nav, basementDoor: out.door ? { ...out.door.interact } : null });

      this.insts.push(inst);
      this.byId.set(id, inst);
      this.defs.push(def);
    }

    this.containers.build(ctx, game, specs);
    this.glass.build(ctx, glassSpecs, (sid, idx, point) => this.breakGlass(sid, idx, true, point));
    this.group.add(this.glass.group);
    this.lightPool.setFixtures(fixtures);
    this.requestSync();
  }

  /** `eye` = 조명 풀이 가까운 방을 고르는 기준 (플레이어 눈 · 없으면 카메라). */
  update(dt: number, time: number, eye: THREE.Vector3 | null): void {
    if (!this.built) return;
    this.containers.update(dt, time);
    if (this.glowMat) this.glowMat.emissiveIntensity = 1.35 + 0.15 * Math.sin(time * 1.7);
    for (const inst of this.insts) {
      if (inst.scanMat) inst.scanMat.emissiveIntensity = inst.def.scanned ? 0.3 : 1.1 + 0.7 * Math.sin(time * 3.1);
      if (inst.doorAnim < 0 || !inst.doorMesh) continue;
      inst.doorAnim += dt;
      const t = Math.min(1, inst.doorAnim / DOOR_SLIDE_S);
      const e = 1 - Math.pow(1 - t, 3);
      inst.doorMesh.position.copy(inst.doorBase).addScaledVector(inst.doorSlide, e);
      if (t >= 1) inst.doorAnim = -1;
    }
    if (eye && this.lightPool) this.lightPool.update(dt, eye.x, eye.z, -1, eye.y);
    this.scanWave.update(dt);
  }

  dispose(): void {
    const game = this.game;
    this.containers.dispose();
    for (const inst of this.insts) {
      game?.interactables.unregister(`struct:${inst.def.id}:scan`);
      game?.interactables.unregister(`struct:${inst.def.id}:door`);
    }
    for (const l of this.ladders) {
      game?.interactables.unregister(`ladder:${l.id}:bottom`);
      game?.interactables.unregister(`ladder:${l.id}:top`);
    }
    this.ladders.length = 0;
    this.navs.length = 0;
    this.insts.length = 0;
    this.byId.clear();
    this.defs.length = 0;
    this.roguedZones.clear();
    this.glass.dispose();
    this.glass = new GlassSet();
    this.scanWave.dispose();
    this.scanWave = new ScanWave();
    this.lightPool?.dispose();
    this.lightPool = null;
    for (const g of this.geos) g.dispose();
    this.geos = [];
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.structMat = null;
    this.glowMat = null;
    this.hash = null;
    this.group.clear();
    this.group.removeFromParent();
    this.built = false;
  }

  /* ── 옥상 맵 스캐너 ────────────────────────────────────────────────── */

  private buildConsole(ctx: BuildCtx, game: GameContext, rng: Random, inst: Inst, spot: Spot): void {
    const parts: THREE.BufferGeometry[] = [];
    const ped = new THREE.BoxGeometry(0.95, 1.05, 0.62);
    xform(ped, { x: spot.x, y: spot.y + 0.52, z: spot.z }, new THREE.Euler(0, -spot.yaw, 0));
    paintGradient(ped, PALETTE.METAL_DARK, PALETTE.METAL, spot.y, spot.y + 1.05);
    parts.push(ped);
    const hood = new THREE.BoxGeometry(0.9, 0.55, 0.24);
    xform(hood, { x: spot.x, y: spot.y + 1.4, z: spot.z }, new THREE.Euler(-0.32, -spot.yaw, 0));
    paint(hood, PALETTE.METAL_DARK, 0.06, rng);
    parts.push(hood);
    // 옥상 스캐너다운 안테나 접시 (그림만)
    const px = spot.x - Math.cos(spot.yaw) * 0.72, pz = spot.z - Math.sin(spot.yaw) * 0.72;
    const dishPole = new THREE.BoxGeometry(0.1, 1.1, 0.1);
    xform(dishPole, { x: px, y: spot.y + 1.6, z: pz });
    paint(dishPole, PALETTE.METAL_DARK);
    parts.push(dishPole);
    const dish = new THREE.CylinderGeometry(0.55, 0.12, 0.22, 12);
    xform(dish, { x: px, y: spot.y + 2.2, z: pz }, new THREE.Euler(0.6, -spot.yaw, 0));
    paint(dish, PALETTE.METAL, 0.05, rng);
    parts.push(dish);
    const geo = merge(parts);
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, this.structMat!);
    mesh.castShadow = true;
    mesh.name = `${inst.def.id}_console`;
    this.group.add(mesh);

    const screenGeo = new THREE.BoxGeometry(0.74, 0.44, 0.05);
    this.geos.push(screenGeo);
    const scanMat = new THREE.MeshStandardMaterial({ color: 0x05121a, emissive: new THREE.Color(0x66ccff), emissiveIntensity: 1.2 });
    this.mats.push(scanMat);
    inst.scanMat = scanMat;
    const screen = new THREE.Mesh(screenGeo, scanMat);
    screen.name = `${inst.def.id}_console_screen`;
    screen.position.set(spot.x + Math.sin(spot.yaw) * 0.14, spot.y + 1.42, spot.z - Math.cos(spot.yaw) * 0.14);
    screen.rotation.set(-0.32, -spot.yaw, 0);
    this.group.add(screen);

    /* 2026-09-12: 받침대 상자 그대로 (예전 반지름 0.55 원기둥은 앞뒤로 24 cm 씩 보이지 않는 벽이었다) + 접시 기둥 */
    ctx.hash.addBox(new THREE.Vector3(spot.x, spot.y, spot.z), 0.475, 0.31, spot.yaw, 1.1, 'console');
    ctx.hash.addBox(new THREE.Vector3(px, spot.y, pz), 0.05, 0.05, spot.yaw, 2.2, 'console');

    const pos = new THREE.Vector3(spot.x, spot.y, spot.z);
    inst.scanPos = pos;
    game.interactables.register({
      id: `struct:${inst.def.id}:scan`,
      position: pos,
      radius: STRUCTURE_INTERACT_RANGE,
      holdTime: STRUCTURE_SCAN_HOLD_S,
      hidePillar: true,
      getPrompt: () => (inst.def.scanned ? null : '맵 스캔 (E)'),
      canInteract: () => !inst.def.scanned && !!this.game?.isGameplayActive(),
      interact: () => this.requestScan(inst),
    });
  }

  /* ── 지하실 문 (서 있는 문짝) ──────────────────────────────────────── */

  private buildDoor(ctx: BuildCtx, game: GameContext, rng: Random, inst: Inst, door: DoorSpot): void {
    const parts: THREE.BufferGeometry[] = [];
    const panel = new THREE.BoxGeometry(door.halfW * 2, door.height, door.thick);
    xform(panel, { x: 0, y: door.height / 2, z: 0 });
    paintGradient(panel, PALETTE.METAL_DARK, PALETTE.METAL, 0, door.height);
    parts.push(panel);
    for (const y of [0.45, door.height - 0.55]) {
      const st = new THREE.BoxGeometry(door.halfW * 1.8, 0.16, door.thick + 0.03);
      xform(st, { x: 0, y, z: 0 });
      paint(st, new THREE.Color(0x9a7a2a), 0.05, rng);
      parts.push(st);
    }
    const handle = new THREE.BoxGeometry(0.08, 0.5, door.thick + 0.12);
    xform(handle, { x: door.halfW * 0.7, y: 1.1, z: 0 });
    paint(handle, PALETTE.METAL_DARK);
    parts.push(handle);
    const geo = merge(parts);
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, this.structMat!);
    mesh.castShadow = true;
    mesh.name = `${inst.def.id}_door`;
    const holder = new THREE.Group();
    holder.name = `${inst.def.id}_door_holder`;
    holder.position.set(door.x, door.y, door.z);
    holder.rotation.y = -door.yaw;
    holder.add(mesh);
    this.group.add(holder);
    inst.doorMesh = holder;
    inst.doorBase.set(door.x, door.y, door.z);
    inst.doorSlide.set(door.slideX, 0, door.slideZ);
    /* 잠긴 동안은 문짝이 곧 콜라이더다 — 열리면 hash 에서 빠지고 옆으로 밀려난다. */
    inst.doorEntry = ctx.hash.addBox(new THREE.Vector3(door.x, door.y, door.z), door.halfW, door.thick / 2 + 0.02, door.yaw, door.height, 'door');

    // 카드 리더기 (복도 벽의 가슴 높이 상자 + LED)
    {
      const box = new THREE.BoxGeometry(0.3, 0.42, 0.16);
      xform(box, { x: door.reader.x, y: door.y + 1.35, z: door.reader.z }, new THREE.Euler(0, -door.reader.yaw, 0));
      paint(box, PALETTE.METAL_DARK);
      this.geos.push(box);
      const bm = new THREE.Mesh(box, this.structMat!);
      bm.name = `${inst.def.id}_reader`;
      this.group.add(bm);
      const led = new THREE.BoxGeometry(0.17, 0.08, 0.2);
      xform(led, { x: door.reader.x, y: door.y + 1.46, z: door.reader.z }, new THREE.Euler(0, -door.reader.yaw, 0));
      this.geos.push(led);
      const lm = new THREE.Mesh(led, this.glowMat!);
      lm.name = `${inst.def.id}_reader_led`;
      this.group.add(lm);
    }

    const pos = new THREE.Vector3(door.interact.x, door.interact.y, door.interact.z);
    const self = this;
    game.interactables.register({
      id: `struct:${inst.def.id}:door`,
      position: pos,
      radius: STRUCTURE_INTERACT_RANGE,
      /* 키카드가 없으면 홀드 0 — 눌러 보면 바로 거부음이 난다. 게이지를 다 채우고 나서 거절당하는 것보다 낫다. */
      get holdTime(): number { return self.hasKeycard() ? STRUCTURE_UNLOCK_HOLD_S : 0; },
      getPrompt: () => (inst.def.unlocked ? null
        : self.hasKeycard() ? '키카드로 지하실 개방 (E)' : '지하실 잠김 — 키카드 필요'),
      canInteract: () => !inst.def.unlocked && !!this.game?.isGameplayActive(),
      interact: () => this.requestUnlock(inst),
    });
  }

  private hasKeycard(): boolean {
    const inv = this.game?.inventory;
    return !!inv && inv.countWhere((def) => def.id === BASEMENT_KEY_DEF) > 0;
  }

  /* ── 사다리 ───────────────────────────────────────────────────────── */

  /**
   * 사다리마다 **발치 · 꼭대기** 두 `Interactable`. 누르면 `ladder:grab` 을 낼 뿐이고 오르내리기는 전부
   * `player/` 가 한다. 매달려 있는 동안에는 두 프롬프트가 모두 숨는다 (E 가 사다리 놓기이기 때문이다).
   */
  private registerLadder(game: GameContext, ladder: LadderDef): void {
    const self = this;
    const can = (): boolean => !!self.game?.isGameplayActive() && !self.game.player?.climbingLadder && !self.game.player?.isDead;
    const grab = (from: 'bottom' | 'top'): void => {
      const g = self.game;
      if (!g || g.player?.climbingLadder) return;
      g.bus.emit('ladder:grab', { ladder, from });
    };
    game.interactables.register({
      id: `ladder:${ladder.id}:bottom`,
      position: ladder.base.clone(),
      radius: LADDER_GRAB_RANGE,
      getPrompt: () => '사다리 오르기 (E)',
      canInteract: can,
      interact: () => grab('bottom'),
    });
    game.interactables.register({
      id: `ladder:${ladder.id}:top`,
      position: ladder.exit.clone(),
      radius: LADDER_GRAB_RANGE,
      getPrompt: () => '사다리 내려가기 (E)',
      canInteract: can,
      interact: () => grab('top'),
    });
  }

  /* ── 창문 ─────────────────────────────────────────────────────────── */

  /** 창 한 장을 깬다. `byLocal` = 이 클라이언트의 총알 · 투척물이 깼다 (와이어로 알린다). */
  private breakGlass(structureId: string, index: number, byLocal: boolean, point?: THREE.Vector3): void {
    if (!this.glass.breakPane(structureId, index)) return;
    const ctx = this.game;
    if (!ctx) return;
    const center = this.glass.centerOf(structureId, index, new THREE.Vector3());
    if (!center) return;
    const fx = FxManager.get();
    if (fx && this.glass.normalOf(structureId, index, _n)) {
      _c.copy(point ?? center);
      ParticleBurst.sparks(fx.additive, _c, _n, 12, 3.5, 0xd8f4ff);
      ParticleBurst.sparks(fx.additive, _c, _n.negate(), 9, 2.5, 0xd8f4ff);
    }
    ctx.bus.emit('audio:play', { id: 'glass_break', position: center });
    ctx.bus.emit('structure:glassBroken', { structureId, index, position: center, byLocal });
    const net = ctx.net;
    if (byLocal && ctx.isMultiplayer && net) net.send({ t: 'struct', ev: 'glass', id: structureId, w: index }, 'others');
  }

  /* ── 상호작용 → 호스트 권위 ───────────────────────────────────────── */

  private requestScan(inst: Inst): void {
    const ctx = this.game;
    if (!ctx || inst.def.scanned) return;
    const net = ctx.net;
    if (ctx.isMultiplayer && net && !net.isHost) { net.send({ t: 'structq', ev: 'scan', id: inst.def.id }, 'host'); return; }
    this.applyScan(inst, true);
    if (ctx.isMultiplayer && net) net.send({ t: 'struct', ev: 'scanned', id: inst.def.id }, 'others');
  }

  private requestUnlock(inst: Inst): void {
    const ctx = this.game;
    if (!ctx || inst.def.unlocked) return;
    if (!this.hasKeycard()) {
      ctx.bus.emit('audio:play', { id: 'keycard_deny', position: inst.def.basementDoor ?? inst.def.position });
      ctx.bus.emit('ui:notify', { text: '키카드가 필요하다 — 이 건물 어딘가에 있다', kind: 'warning', duration: 2.4 });
      return;
    }
    const net = ctx.net;
    if (ctx.isMultiplayer && net && !net.isHost) { net.send({ t: 'structq', ev: 'unlock', id: inst.def.id }, 'host'); return; }
    const by: PeerId | null = net?.localId ?? null;
    this.applyUnlock(inst, by, true);
    if (ctx.isMultiplayer && net) net.send({ t: 'struct', ev: 'unlocked', id: inst.def.id, by }, 'others');
  }

  /**
   * `announce` = 이 클라이언트의 조작으로 일어난 일인가 (토스트). **파동과 소리는 누구 화면에서든** 난다
   * (옥상에서 누가 스캔하면 분대 전원이 맵을 훑는 파동을 본다).
   */
  private applyScan(inst: Inst, announce: boolean): void {
    const ctx = this.game;
    if (!ctx || inst.def.scanned) return;
    inst.def.scanned = true;
    const at = inst.scanPos ?? inst.def.position;
    ctx.world?.fog?.reveal(at.x, at.z, STRUCTURE_SCAN_RADIUS);
    this.scanWave.fire(at);
    ctx.bus.emit('structure:scanned', {
      id: inst.def.id, kind: inst.def.kind, position: inst.def.position, radius: STRUCTURE_SCAN_RADIUS,
    });
    ctx.bus.emit('audio:play', { id: 'scan_pulse', position: at, volume: 1, pitch: 0.7 });
    if (!announce) return;
    ctx.bus.emit('ui:notify', { text: `${STRUCTURE_LABEL_KO[inst.def.kind]} — 맵 스캔 완료`, kind: 'success', duration: 2.6 });
  }

  /** `consume` = 이 클라이언트가 키카드를 낸 사람인가. */
  private applyUnlock(inst: Inst, by: PeerId | null, consume: boolean): void {
    const ctx = this.game;
    if (!ctx || inst.def.unlocked) return;
    inst.def.unlocked = true;
    if (inst.doorEntry) { this.hash?.remove(inst.doorEntry); inst.doorEntry = null; }
    inst.doorAnim = 0;
    if (consume) {
      ctx.inventory?.consumeWhere((def) => def.id === BASEMENT_KEY_DEF, 1);
      ctx.bus.emit('audio:play', { id: 'keycard_use', position: inst.def.basementDoor ?? inst.def.position });
      ctx.bus.emit('ui:notify', { text: '지하실이 열렸다', kind: 'success', duration: 2.2 });
    }
    ctx.bus.emit('structure:unlocked', {
      id: inst.def.id, kind: inst.def.kind, by, position: inst.def.basementDoor ?? inst.def.position,
    });
  }

  /* ── 멀티 ─────────────────────────────────────────────────────────── */

  private ensureNet(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('struct', (m) => this.onMessage(m)),
      net.onMessage('structq', (m, from) => this.onRequest(m, from)),
      net.onMessage('flow', (m, from) => { if (m.ev === 'rejoined' && ctx.net?.isHost) this.sendSync(from); }),
      ctx.bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost && this.built) this.requestSync(); }),
    );
  }

  /**
   * 네트워크가 없어도 붙어야 하는 구독. `ensureNet` 은 `ctx.net` 이 게시된 뒤에야 붙는데, 로그 강하의
   * "구역당 1회" 기록은 **싱글 플레이에서도** 남아야 한다 (다음에 그 구역을 다시 굴리지 않게).
   */
  private hookBus(): void {
    const ctx = this.game;
    if (!ctx || this.busHooked) return;
    this.busHooked = true;
    this.unsubs.push(ctx.bus.on('structure:investigated', ({ zoneId }) => this.markRogued(zoneId)));
  }

  /** 그 구역의 로그 강하 추첨이 끝났다고 적어 둔다 (구조물이면 `StructureDef` 에도). */
  private markRogued(zoneId: string): void {
    this.roguedZones.add(zoneId);
    const inst = this.byId.get(zoneId);
    if (inst) inst.def.rogueDropUsed = true;
  }

  private requestSync(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
    net.send({ t: 'structq', ev: 'sync' }, 'host');
  }

  /** 호스트 → 클라이언트. 창문만은 **누구 → 전원**이라 호스트도 받는다. */
  private onMessage(m: StructureMessage): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer) return;
    if (m.ev === 'glass') { this.breakGlass(m.id, m.w, false); return; }
    if (net.isHost) return;
    if (m.ev === 'unlocked') {
      const inst = this.byId.get(m.id);
      // 키카드는 **연 사람의 것만** 사라진다
      if (inst) this.applyUnlock(inst, m.by, m.by !== null && m.by === net.localId);
      return;
    }
    if (m.ev === 'scanned') {
      const inst = this.byId.get(m.id);
      if (inst) this.applyScan(inst, false);
      return;
    }
    for (const id of m.unlocked) { const i = this.byId.get(id); if (i) this.applyUnlock(i, null, false); }
    for (const id of m.scanned) { const i = this.byId.get(id); if (i) this.applyScanQuiet(i); }
    for (const id of m.rogued) this.markRogued(id);
    for (const key of m.glass ?? []) {
      const at = key.lastIndexOf(':');
      if (at > 0) this.breakGlassQuiet(key.slice(0, at), Number(key.slice(at + 1)));
    }
  }

  /** 늦게 합류한 사람의 동기화: 이미 끝난 스캔은 파동 · 소리 없이 상태만. */
  private applyScanQuiet(inst: Inst): void {
    if (inst.def.scanned) return;
    inst.def.scanned = true;
    const at = inst.scanPos ?? inst.def.position;
    this.game?.world?.fog?.reveal(at.x, at.z, STRUCTURE_SCAN_RADIUS);
  }

  /** 늦게 합류한 사람의 동기화: 이미 깨진 창은 파편 · 소리 없이. */
  private breakGlassQuiet(structureId: string, index: number): void {
    if (!Number.isFinite(index)) return;
    if (!this.glass.breakPane(structureId, index)) return;
    const center = this.glass.centerOf(structureId, index, new THREE.Vector3());
    if (center) this.game?.bus.emit('structure:glassBroken', { structureId, index, position: center, byLocal: false });
  }

  /** 클라이언트 → 호스트. */
  private onRequest(m: StructureRequest, from: PeerId): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || !net.isHost) return;
    if (m.ev === 'sync') { this.sendSync(from); return; }
    const inst = this.byId.get(m.id);
    if (!inst) return;
    if (m.ev === 'unlock') {
      if (inst.def.unlocked) return;              // 먼저 연 사람이 있다 — 요청자의 키카드는 살아남는다
      this.applyUnlock(inst, from, false);
      net.send({ t: 'struct', ev: 'unlocked', id: inst.def.id, by: from }, 'others');
      return;
    }
    if (inst.def.scanned) return;
    this.applyScan(inst, false);
    net.send({ t: 'struct', ev: 'scanned', id: inst.def.id }, 'others');
  }

  private sendSync(to: PeerId): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer) return;
    net.send({
      t: 'struct', ev: 'sync',
      unlocked: this.defs.filter((d) => d.unlocked).map((d) => d.id),
      scanned: this.defs.filter((d) => d.scanned).map((d) => d.id),
      rogued: [...this.roguedZones],
      glass: this.glass.brokenKeys(),
    }, to);
  }
}
