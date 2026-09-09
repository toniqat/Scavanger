/**
 * src/world/Structures.ts — **버려진 구조물** (전진기지 · 연구실 · 불시착 함선).
 *
 * 들어갈 수 있는 폐건물이다. 안에는 상호작용 컨테이너가 밀집해 있고, 전진기지 · 연구실에는 **지하실**이
 * 딸릴 수 있다 — 지하실 해치는 **언제나 잠겨 있고** 그 구조물의 지상층 컨테이너 **딱 하나**에 키카드가
 * 들어 있다 (`key_basement`, 열면 소비된다). 각 구조물의 컴퓨터로는 주변 안개를 걷는 **행성 스캔**을
 * 한 번 돌릴 수 있다.
 *
 * 소유 계약: `StructureDef` · `WorldRef.getStructures / structureAt` · `structure:unlocked / scanned /
 * investigated` · `StructureMessage`(`struct`) / `StructureRequest`(`structq`) · `STRUCTURE_*` 상수.
 * 수치는 `data/structures.csv` (`structures/model.ts` 가 읽는다).
 *
 * 생성 순서: 부지는 **`layout.ts`** 가 잡는다 (지형이 그 자리를 평탄화하고 지하실 구덩이를 파야 하므로).
 * 건물은 **지형 · 아웃포스트 다음, 소품 · 상자 앞**에 세운다 — `isSpotFree` 가 건물 자리를 이미 알고 있어야
 * 방 안에 바위가 서지 않는다.
 *
 * 멀티: 지하실 개방 · 행성 스캔은 **호스트 권위**다 (`Gather` 의 `harv` / `harvq` 와 같은 모양).
 */
import * as THREE from 'three';
import {
  Layers,
  STRUCTURE_INTERACT_RANGE, STRUCTURE_LABEL_KO, STRUCTURE_SCAN_HOLD_S, STRUCTURE_SCAN_RADIUS,
  STRUCTURE_UNLOCK_HOLD_S,
  type GameContext, type PeerId, type Random, type StructureDef, type StructureKind,
  type StructureMessage, type StructureRequest,
} from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from './build';
import type { ObstacleEntry, SpatialHash } from './SpatialHash';
import { PALETTE, type BuildingPlan, type Spot, buildBuilding, buildWreck, mergeOrNull } from './structures/parts/Build';
import { ContainerSet, type ContainerSpec } from './structures/parts/Containers';
import { pickTier, structureRow } from './structures/model';

/** 지하실 열쇠의 아이템 def id. `items/` 가 아직 등록하지 않았으면 키카드가 그냥 안 들어간다 (문은 그대로 잠긴다). */
export const BASEMENT_KEY_DEF = 'key_basement';

/** 해치가 옆으로 밀려나는 데 걸리는 시간(초). */
const HATCH_SLIDE_S = 0.9;

interface Inst {
  def: StructureDef;
  /** 잠긴 동안 계단 구멍을 막는 상자 콜라이더. 열리면 hash 에서 빠진다. */
  hatchEntry: ObstacleEntry | null;
  hatchMesh: THREE.Object3D | null;
  hatchDx: number;
  hatchDz: number;
  hatchAnim: number;      // −1 idle
  scanMat: THREE.MeshStandardMaterial | null;
}

export class Structures {
  readonly group = new THREE.Group();
  private readonly insts: Inst[] = [];
  private readonly byId = new Map<string, Inst>();
  private readonly defs: StructureDef[] = [];
  /**
   * 로그 강하를 이미 굴린 구역 (`structure:investigated` 의 `zoneId`). 구조물 id 뿐 아니라 **선로 플랫폼 ·
   * 전차**의 zoneId 도 들어간다 — 그쪽은 `StructureDef` 가 아니라 여기 문자열로만 남는다.
   * `struct sync.rogued` 가 통째로 실어 나른다: 굴려서 **실패한** 구역은 다른 와이어가 없으므로,
   * 호스트가 바뀌면 새 호스트는 이 목록으로만 "그 구역은 이미 소진됐다" 를 안다.
   */
  private readonly roguedZones = new Set<string>();
  private readonly containers = new ContainerSet('StructureContainers');
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

  /** `(x, z)` 를 품는 구조물 (자기 `radius` 안), 없으면 null. */
  structureAt(x: number, z: number): StructureDef | null {
    for (let i = 0; i < this.defs.length; i++) {
      const d = this.defs[i];
      const dx = d.position.x - x, dz = d.position.z - z;
      if (dx * dx + dz * dz <= d.radius * d.radius) return d;
    }
    return null;
  }

  build(ctx: BuildCtx, game: GameContext): void {
    this.game = game;
    this.hash = ctx.hash;
    this.hookBus();
    this.ensureNet();
    this.built = true;
    const sites = ctx.layout.structures;
    if (sites.length === 0) return;
    const rng = ctx.rng.fork('structures');

    this.structMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.84, metalness: 0.2 });
    this.glowMat = new THREE.MeshStandardMaterial({ color: 0x08120f, emissive: new THREE.Color(0x74e0b0), emissiveIntensity: 1.6 });
    this.mats.push(this.structMat, this.glowMat);

    const specs: ContainerSpec[] = [];
    const counters: Partial<Record<StructureKind, number>> = {};
    for (const site of sites) {
      const row = structureRow(site.kind);
      if (!row) continue;
      const n = counters[site.kind] ?? 0;
      counters[site.kind] = n + 1;
      const id = `struct_${site.kind}_${n}`;
      const plan: BuildingPlan = {
        cx: site.pad.x, cz: site.pad.z, yaw: site.pad.yaw, y0: site.pad.height,
        halfW: site.halfW, halfD: site.halfD, wallH: site.wallH, pit: site.pit,
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
        hasBasement: out.hatch !== null,
        basementDoor: out.hatch ? new THREE.Vector3(out.hatch.x, out.hatch.y, out.hatch.z) : null,
        unlocked: false, scanned: false, rogueDropUsed: false,
      };
      const inst: Inst = { def, hatchEntry: null, hatchMesh: null, hatchDx: 0, hatchDz: 0, hatchAnim: -1, scanMat: null };

      /* 컨테이너: 지상층 + (있으면) 지하실. 키카드는 **지상층 하나**에만 들어간다 — 지하실 안에 넣으면
       * 영영 못 여는 방이 된다. */
      const ground = out.containers.slice(0, row.containers);
      const keyIdx = def.hasBasement && ground.length > 0 ? rng.int(0, ground.length - 1) : -1;
      ground.forEach((s, i) => specs.push({
        id: `${id}_c${i}`, position: new THREE.Vector3(s.x, s.y, s.z), yaw: s.yaw,
        tier: pickTier(row.tiers, rng.next()), style: (i % 3) as 0 | 1 | 2,
        zoneId: id, zoneKind: site.kind,
        bonusDefId: i === keyIdx ? BASEMENT_KEY_DEF : undefined,
      }));
      const deepTiers = row.basementTiers.length > 0 ? row.basementTiers : row.tiers;
      out.basementContainers.slice(0, row.basementContainers).forEach((s, i) => specs.push({
        id: `${id}_b${i}`, position: new THREE.Vector3(s.x, s.y, s.z), yaw: s.yaw,
        tier: pickTier(deepTiers, rng.next()), style: ((i + 1) % 3) as 0 | 1 | 2,
        zoneId: id, zoneKind: site.kind,
      }));

      this.buildConsole(ctx, game, rng, inst, out.console);
      if (out.hatch) this.buildHatch(ctx, game, rng, inst, out.hatch);

      this.insts.push(inst);
      this.byId.set(id, inst);
      this.defs.push(def);
    }

    this.containers.build(ctx, game, specs);
    ctx.root.add(this.group);
    this.requestSync();
  }

  update(dt: number, time: number): void {
    if (!this.built) return;
    this.containers.update(dt, time);
    if (this.glowMat) this.glowMat.emissiveIntensity = 1.1 + 0.5 * Math.sin(time * 1.7);
    for (const inst of this.insts) {
      if (inst.scanMat) inst.scanMat.emissiveIntensity = inst.def.scanned ? 0.3 : 1.1 + 0.7 * Math.sin(time * 3.1);
      if (inst.hatchAnim < 0 || !inst.hatchMesh) continue;
      inst.hatchAnim += dt;
      const t = Math.min(1, inst.hatchAnim / HATCH_SLIDE_S);
      const e = 1 - Math.pow(1 - t, 3);
      inst.hatchMesh.position.set(inst.hatchDx * e, 0, inst.hatchDz * e);
      if (t >= 1) { inst.hatchAnim = -1; inst.hatchMesh.visible = false; }
    }
  }

  dispose(): void {
    const game = this.game;
    this.containers.dispose();
    for (const inst of this.insts) {
      game?.interactables.unregister(`struct:${inst.def.id}:scan`);
      game?.interactables.unregister(`struct:${inst.def.id}:door`);
    }
    this.insts.length = 0;
    this.byId.clear();
    this.defs.length = 0;
    this.roguedZones.clear();
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

  /* ── 컴퓨터 (행성 스캔) ────────────────────────────────────────────── */

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
    screen.position.set(
      spot.x + Math.sin(spot.yaw) * 0.14,
      spot.y + 1.42,
      spot.z - Math.cos(spot.yaw) * 0.14,
    );
    screen.rotation.set(-0.32, -spot.yaw, 0);
    this.group.add(screen);

    ctx.hash.add(new THREE.Vector3(spot.x, spot.y, spot.z), 0.55, 1.1, 'console');

    const pos = new THREE.Vector3(spot.x, spot.y, spot.z);
    game.interactables.register({
      id: `struct:${inst.def.id}:scan`,
      position: pos,
      radius: STRUCTURE_INTERACT_RANGE,
      holdTime: STRUCTURE_SCAN_HOLD_S,
      getPrompt: () => (inst.def.scanned ? null : '행성 스캔 (E)'),
      canInteract: () => !inst.def.scanned && !!this.game?.isGameplayActive(),
      interact: () => this.requestScan(inst),
    });
  }

  /* ── 지하실 해치 ──────────────────────────────────────────────────── */

  private buildHatch(ctx: BuildCtx, game: GameContext, rng: Random, inst: Inst,
    hatch: Spot & { halfX: number; halfZ: number }): void {
    const plate = new THREE.BoxGeometry(hatch.halfX * 2, 0.26, hatch.halfZ * 2);
    xform(plate, { x: 0, y: -0.13, z: 0 });
    paint(plate, PALETTE.METAL, 0.06, rng);
    const stripes: THREE.BufferGeometry[] = [plate];
    for (const s of [-1, 1]) {
      const st = new THREE.BoxGeometry(hatch.halfX * 1.7, 0.03, 0.22);
      xform(st, { x: 0, y: 0.005, z: s * hatch.halfZ * 0.45 });
      paint(st, PALETTE.RUST);
      stripes.push(st);
    }
    const geo = merge(stripes);
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, this.structMat!);
    mesh.castShadow = true;
    const holder = new THREE.Group();
    holder.name = `${inst.def.id}_hatch`;
    holder.add(mesh);
    const outer = new THREE.Group();
    outer.position.set(hatch.x, hatch.y, hatch.z);
    outer.rotation.y = -hatch.yaw;
    outer.add(holder);
    this.group.add(outer);
    inst.hatchMesh = holder;
    // 열리면 **로컬 +X** 로 미끄러진다 (holder 는 이미 회전한 부모 밑이라 로컬 축이면 된다)
    inst.hatchDx = hatch.halfX * 2 + 0.5;
    inst.hatchDz = 0;

    /* 잠긴 동안은 이 뚜껑이 곧 콜라이더다. 밑면을 지상층 바닥 바로 아래에 두어 **윗면이 정확히 바닥
     * 높이**가 되게 한다 — 그 위를 걸어 지나갈 수 있고, 열면 hash 에서 빠져 계단이 드러난다. */
    inst.hatchEntry = ctx.hash.addBox(
      new THREE.Vector3(hatch.x, hatch.y - 0.26, hatch.z), hatch.halfX, hatch.halfZ, hatch.yaw, 0.26, 'hatch',
    );

    // 카드 리더기 (해치 옆의 낮은 기둥 + LED)
    {
      const rx = hatch.x - Math.sin(hatch.yaw) * (hatch.halfZ + 0.8);
      const rz = hatch.z + Math.cos(hatch.yaw) * (hatch.halfZ + 0.8);
      const post = new THREE.BoxGeometry(0.32, 1.15, 0.32);
      xform(post, { x: rx, y: hatch.y + 0.58, z: rz }, new THREE.Euler(0, -hatch.yaw, 0));
      paintGradient(post, PALETTE.METAL_DARK, PALETTE.METAL, hatch.y, hatch.y + 1.15);
      this.geos.push(post);
      const pm = new THREE.Mesh(post, this.structMat!);
      pm.castShadow = true;
      this.group.add(pm);
      const led = new THREE.BoxGeometry(0.17, 0.11, 0.07);
      xform(led, { x: rx, y: hatch.y + 0.98, z: rz }, new THREE.Euler(0, -hatch.yaw, 0));
      this.geos.push(led);
      this.group.add(new THREE.Mesh(led, this.glowMat!));
      ctx.hash.add(new THREE.Vector3(rx, hatch.y, rz), 0.26, 1.15, 'console');
    }

    const pos = new THREE.Vector3(hatch.x, hatch.y, hatch.z);
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

  /** `announce` = 이 클라이언트의 조작으로 일어난 일인가 (토스트 · 소리). */
  private applyScan(inst: Inst, announce: boolean): void {
    const ctx = this.game;
    if (!ctx || inst.def.scanned) return;
    inst.def.scanned = true;
    ctx.world?.fog?.reveal(inst.def.position.x, inst.def.position.z, STRUCTURE_SCAN_RADIUS);
    ctx.bus.emit('structure:scanned', {
      id: inst.def.id, kind: inst.def.kind, position: inst.def.position, radius: STRUCTURE_SCAN_RADIUS,
    });
    if (!announce) return;
    ctx.bus.emit('audio:play', { id: 'scan_pulse', position: inst.def.position });
    ctx.bus.emit('ui:notify', { text: `${STRUCTURE_LABEL_KO[inst.def.kind]} — 행성 스캔 완료`, kind: 'success', duration: 2.6 });
  }

  /** `consume` = 이 클라이언트가 키카드를 낸 사람인가. */
  private applyUnlock(inst: Inst, by: PeerId | null, consume: boolean): void {
    const ctx = this.game;
    if (!ctx || inst.def.unlocked) return;
    inst.def.unlocked = true;
    if (inst.hatchEntry) { this.hash?.remove(inst.hatchEntry); inst.hatchEntry = null; }
    inst.hatchAnim = 0;
    if (consume) {
      ctx.inventory?.consumeWhere((def) => def.id === BASEMENT_KEY_DEF, 1);
      ctx.bus.emit('audio:play', { id: 'keycard_use', position: inst.def.basementDoor ?? inst.def.position });
      ctx.bus.emit('ui:notify', { text: '지하실이 열렸다', kind: 'success', duration: 2.2 });
    }
    ctx.bus.emit('structure:unlocked', {
      id: inst.def.id, kind: inst.def.kind, by, position: inst.def.basementDoor ?? inst.def.position,
    });
  }

  /* ── 멀티 (호스트 권위) ───────────────────────────────────────────── */

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
    // 조사한 그 순간 (성공 · 실패와 무관하게) 소진으로 표시한다 — enemies/ 는 읽기만 한다.
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

  /** 호스트 → 클라이언트. */
  private onMessage(m: StructureMessage): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
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
    for (const id of m.scanned) { const i = this.byId.get(id); if (i) this.applyScan(i, false); }
    for (const id of m.rogued) this.markRogued(id);
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
    }, to);
  }
}
