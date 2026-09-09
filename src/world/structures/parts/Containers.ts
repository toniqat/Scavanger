/**
 * src/world/structures/parts/Containers.ts — 구조물 · 선로 플랫폼 · 전차 안의 **상호작용 컨테이너**.
 *
 * 새 루팅 경로를 만들지 않는다. 열면 그냥 `crate:open {crateId, tier, position}` 을 쏘고, 나머지는
 * `inventory/` 의 상자 코드가 그대로 한다 (티어별 롤 · 컨테이너 캐시 · 멀티 동기화 · 감정 XP · 계약 카운터 ·
 * `stats.cratesOpened`). 이 파일이 더하는 것은 **실루엣**(캐비닛 · 궤짝 · 시약장)과 두 가지 규칙뿐이다:
 *   1. 그 **구역에서 처음** 컨테이너를 열면 `structure:investigated` 가 나간다 (enemies/ 의 로그 강하 계기).
 *   2. 한 컨테이너에는 `bonusDefId`(지하실 키카드)가 **반드시** 들어 있을 수 있다 — 그때만
 *      `inventory.openContainerItems` 로 내용물을 직접 채우고 **그 다음** `crate:open` 을 쏜다.
 *      캐시가 먼저 만들어지므로 상자 코드는 이미 있는 컨테이너를 그대로 보여 주고, 통계 · XP · 계약은
 *      다른 상자와 똑같이 오른다 (대가는 `inventory:containerOpened` 가 그 한 번 두 번 나가는 것뿐이다).
 */
import * as THREE from 'three';
import {
  Layers, Random,
  type GameContext, type Interactable, type ItemInstance, type StructureKind,
} from '@/shared';
import type { BuildCtx } from '../../build';
import { merge, paint, paintGradient, xform } from '../../build';
import { CONTAINER_RADIUS } from '../model';

/** 컨테이너 하나의 명세 (배치하는 쪽이 만든다). */
export interface ContainerSpec {
  id: string;
  position: THREE.Vector3;
  yaw: number;
  tier: number;
  /** 0 = 벽 캐비닛, 1 = 바닥 궤짝, 2 = 시약장/선반. */
  style: 0 | 1 | 2;
  /** "구역당 1회" 를 세는 열쇠 — 구조물 id 또는 플랫폼 id. */
  zoneId: string;
  zoneKind: StructureKind | 'platform';
  /** 이 컨테이너에 반드시 들어 있는 아이템 def id (지하실 키카드). */
  bonusDefId?: string;
  /**
   * true = **움직이는** 컨테이너 (전차 안). 콜라이더를 걸지 않고, 매 프레임 `position` / `yaw` 를 메시에
   * 다시 옮긴다 — 배치한 쪽이 같은 `Vector3` 객체를 제자리에서 고치면 상호작용 판정(`Interactable.position`
   * 이 바로 그 객체다)도 함께 따라간다.
   */
  dynamic?: boolean;
}

interface Inst {
  spec: ContainerSpec;
  root: THREE.Group;
  door: THREE.Object3D;
  anim: number;                 // −1 idle, else seconds since opening
  opened: boolean;
  interactable: Interactable;
}

const STYLE_H = [1.75, 0.85, 1.5];
const STYLE_R = [0.5, 0.6, 0.55];
const OPEN_S = 0.45;

/** 컨테이너 묶음 — 구조물 하나 · 플랫폼 하나 · 전차 한 대가 각각 하나씩 들고 있어도 되고 공유해도 된다. */
export class ContainerSet {
  readonly group = new THREE.Group();
  private readonly insts: Inst[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private lampMat: THREE.MeshStandardMaterial | null = null;
  private game: GameContext | null = null;
  /** 이미 조사한 구역 (구역당 `structure:investigated` 한 번). */
  private readonly investigated = new Set<string>();

  constructor(name = 'StructureContainers') { this.group.name = name; }

  /** 이미 열려 있는 컨테이너 id (호스트 동기화가 필요하지 않다 — inventory/ 가 컨테이너를 이미 동기화한다). */
  get count(): number { return this.insts.length; }

  build(ctx: BuildCtx, game: GameContext, specs: readonly ContainerSpec[]): void {
    this.game = game;
    const rng = ctx.rng.fork('structContainers');
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.45 });
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: new THREE.Color(0x6fd8ff), emissiveIntensity: 1.8 });
    this.mats.push(bodyMat, this.lampMat);

    const bodies = [0, 1, 2].map((k) => this.makeBody(k as 0 | 1 | 2, rng));
    const doors = [0, 1, 2].map((k) => this.makeDoor(k as 0 | 1 | 2, rng));
    const lampGeo = new THREE.BoxGeometry(0.1, 0.06, 0.05);
    this.geos.push(...bodies, ...doors, lampGeo);

    for (const spec of specs) {
      const root = new THREE.Group();
      root.position.copy(spec.position);
      root.rotation.y = -spec.yaw;
      root.name = spec.id;

      const body = new THREE.Mesh(bodies[spec.style], bodyMat);
      body.castShadow = true; body.receiveShadow = true;
      body.layers.enable(Layers.INTERACTABLE);
      root.add(body);

      const door = new THREE.Group();
      door.position.set(-STYLE_R[spec.style] * 0.9, 0, STYLE_R[spec.style] * 0.62);
      const doorMesh = new THREE.Mesh(doors[spec.style], bodyMat);
      doorMesh.castShadow = true;
      door.add(doorMesh);
      root.add(door);

      const lamp = new THREE.Mesh(lampGeo, this.lampMat);
      lamp.position.set(0.28, STYLE_H[spec.style] - 0.22, STYLE_R[spec.style] * 0.66);
      root.add(lamp);

      const inst: Inst = { spec, root, door, anim: -1, opened: false, interactable: null as unknown as Interactable };
      inst.interactable = {
        id: `container:${spec.id}`,
        position: spec.position,
        radius: CONTAINER_RADIUS,
        getPrompt: () => (inst.opened ? '컨테이너 살펴보기 (E)' : '컨테이너 열기 (E)'),
        canInteract: () => !!this.game?.isGameplayActive(),
        get hidePillar(): boolean { return inst.opened; },
        interact: () => this.open(inst),
      };
      this.insts.push(inst);
      this.group.add(root);
      game.interactables.register(inst.interactable);
      if (!spec.dynamic) {
        ctx.hash.add(new THREE.Vector3(spec.position.x, spec.position.y, spec.position.z),
          STYLE_R[spec.style], STYLE_H[spec.style], 'container');
      }
    }
    ctx.root.add(this.group);
  }

  private open(inst: Inst): void {
    const game = this.game;
    if (!game) return;
    const spec = inst.spec;
    const first = !inst.opened;
    if (first) {
      inst.opened = true;
      inst.anim = 0;
      // 키카드가 든 컨테이너만 내용물을 직접 채운다 — 나머지는 상자 코드가 티어로 굴린다.
      if (spec.bonusDefId) {
        const items = this.rollWithBonus(game, spec);
        if (items) game.inventory?.openContainerItems(spec.id, items, spec.position, '컨테이너');
      }
    }
    game.bus.emit('crate:open', { crateId: spec.id, tier: spec.tier, position: spec.position });
    if (!first) return;
    if (this.investigated.has(spec.zoneId)) return;
    this.investigated.add(spec.zoneId);
    game.bus.emit('structure:investigated', { zoneId: spec.zoneId, kind: spec.zoneKind, position: spec.position });
  }

  /**
   * 상자 코드와 **같은 방식**으로 굴린 내용물 + 키카드. rng 시드도 `inventory/Container` 와 같은
   * `<맵 시드> ^ hash(id)` 라 어느 클라이언트에서 열어도 같은 물건이 나온다 (`ctx.world.seed` = 이 맵의 시드).
   * `items/` 가 아직 키카드 def 를 등록하지 않았으면 **조용히 빼고** 나머지만 채운다.
   */
  private rollWithBonus(game: GameContext, spec: ContainerSpec): ItemInstance[] | null {
    const loot = game.loot;
    if (!loot) return null;
    const rng = new Random((((game.world?.seed ?? 0) >>> 0) ^ Random.hash(spec.id)) >>> 0);
    const items = loot.rollCrate(spec.tier, rng);
    if (spec.bonusDefId && loot.getItemDef(spec.bonusDefId)) {
      try { items.unshift(loot.createItem(spec.bonusDefId, 1)); } catch { /* def 가 있어도 만들 수 없으면 그냥 넘어간다 */ }
    }
    return items;
  }

  update(dt: number, time: number): void {
    if (this.lampMat) this.lampMat.emissiveIntensity = (time % 2.2) < 0.5 ? 2.2 : 0.3;
    for (let i = 0; i < this.insts.length; i++) {
      const c = this.insts[i];
      if (c.spec.dynamic) { c.root.position.copy(c.spec.position); c.root.rotation.y = -c.spec.yaw; }
      if (c.anim < 0) continue;
      c.anim += dt;
      const t = Math.min(1, c.anim / OPEN_S);
      c.door.rotation.y = -1.9 * (1 - Math.pow(1 - t, 3));
      if (t >= 1) c.anim = -1;
    }
  }

  dispose(): void {
    for (const c of this.insts) {
      this.game?.interactables.unregister(c.interactable.id);
      this.group.remove(c.root);
    }
    this.insts.length = 0;
    this.investigated.clear();
    for (const g of this.geos) g.dispose();
    this.geos = [];
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.lampMat = null;
    this.group.removeFromParent();
    this.game = null;
  }

  /* ── 지오메트리 ─────────────────────────────────────────────────────── */

  private makeBody(style: 0 | 1 | 2, rng: Random): THREE.BufferGeometry {
    const shell = new THREE.Color(style === 2 ? 0x3d4a54 : 0x4b4f52);
    const dark = shell.clone().multiplyScalar(0.55);
    const trim = new THREE.Color(style === 2 ? 0x6fd8ff : 0x8a6a3a);
    const parts: THREE.BufferGeometry[] = [];
    const h = STYLE_H[style], r = STYLE_R[style];

    const box = new THREE.BoxGeometry(r * 1.8, h, r * 1.25);
    xform(box, { x: 0, y: h / 2, z: 0 });
    paintGradient(box, dark, shell, 0, h);
    parts.push(box);

    // 발 · 상단 테두리
    for (const sx of [-1, 1]) {
      const foot = new THREE.BoxGeometry(0.16, 0.1, r * 1.1);
      xform(foot, { x: sx * (r * 0.75), y: 0.05, z: 0 });
      paint(foot, dark);
      parts.push(foot);
    }
    const cap = new THREE.BoxGeometry(r * 1.9, 0.1, r * 1.35);
    xform(cap, { x: 0, y: h + 0.04, z: 0 });
    paint(cap, dark, 0.06, rng);
    parts.push(cap);

    if (style === 0) {
      // 벽 캐비닛: 세로 홈 세 줄
      for (let i = 0; i < 3; i++) {
        const rib = new THREE.BoxGeometry(0.05, h - 0.3, 0.04);
        xform(rib, { x: (i - 1) * r * 0.5, y: h / 2, z: r * 0.64 });
        paint(rib, trim);
        parts.push(rib);
      }
    } else if (style === 1) {
      // 궤짝: 띠 두 줄
      for (const y of [h * 0.35, h * 0.72]) {
        const band = new THREE.BoxGeometry(r * 1.85, 0.07, r * 1.3);
        xform(band, { x: 0, y, z: 0 });
        paint(band, trim);
        parts.push(band);
      }
    } else {
      // 시약장: 유리 선반 두 칸
      for (const y of [h * 0.4, h * 0.72]) {
        const shelf = new THREE.BoxGeometry(r * 1.6, 0.05, r * 1.0);
        xform(shelf, { x: 0, y, z: 0 });
        paint(shelf, trim);
        parts.push(shelf);
      }
    }
    return merge(parts);
  }

  private makeDoor(style: 0 | 1 | 2, rng: Random): THREE.BufferGeometry {
    const h = STYLE_H[style], r = STYLE_R[style];
    const shell = new THREE.Color(style === 2 ? 0x46545f : 0x55595c);
    const parts: THREE.BufferGeometry[] = [];
    const panel = new THREE.BoxGeometry(r * 1.75, h - 0.14, 0.07);
    xform(panel, { x: r * 0.88, y: h / 2, z: 0 });
    paintGradient(panel, shell.clone().multiplyScalar(0.7), shell, 0, h);
    parts.push(panel);
    const handle = new THREE.BoxGeometry(0.07, 0.28, 0.07);
    xform(handle, { x: r * 1.6, y: h * 0.55, z: 0.07 });
    paint(handle, new THREE.Color(0x22252a), 0.08, rng);
    parts.push(handle);
    return merge(parts);
  }
}
