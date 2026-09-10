/**
 * src/world/structures/parts/Glass.ts — **구조물 창문 유리** (2026-09-11).
 *
 * 사용자 요청: "1층과 2층 벽에 무작위 위치에 창문이 존재하도록. 창문은 총알, 투척물에 의해 뚫림" + 결정:
 * **깨진 뒤에도 사람은 못 드나든다 — 총알 · 투척물만 통과**.
 *
 * - 맵의 유리 전부가 `InstancedMesh` **하나**다 (드로우콜 +1). 깨지면 그 인스턴스만 크기 0 으로 접는다.
 * - 유리 한 장 = 얇은 상자 콜라이더 하나 (`Obstacle.fragile` + `destructible`). 총알은 `weapons/` 의 기존
 *   `obstacle.destructible.onDamage` 경로로, 투척물은 자기 비행 선분을 `world.raycast` 로 훑어 같은 함수를 부른다.
 * - **깨져도 콜라이더는 hash 에 남는다.** 대신 `passRays`(레이가 무시) + `passSmall`(반지름 `SMALL_BODY_R` 미만의
 *   몸 — 수류탄 · 투척 가젯 — 은 밀어내지 않는다)로 바뀐다. 사람 · 적의 몸은 여전히 막힌다. 두 플래그는 world
 *   내부(`ObstacleEntry`)라 계약이 늘지 않는다.
 * - 누가 깼는지는 중요하지 않다 (결과가 같다) — 깬 클라이언트가 `struct glass` 를 보내고, 받은 쪽은 같은 함수를
 *   조용히(`byLocal: false`) 부른다. 이미 깨졌으면 아무 일도 없다.
 */
import * as THREE from 'three';
import { Layers } from '@/shared';
import type { BuildCtx } from '../../build';
import type { ObstacleEntry } from '../../SpatialHash';
import { GLASS_T } from '../model';

/** 이 반지름(m) 미만의 몸은 깨진 창틀을 지나간다 (`resolveCollision`). 수류탄 0.08 · 투척 가젯 0.08 · 사람 0.45. */
export const SMALL_BODY_R = 0.25;

/** 창문 한 장의 자리 (월드). `yaw` 는 창 면이 뻗는 방향(수학 규약, 로컬 +X = 가로). */
export interface WindowSpec {
  x: number;
  /** 유리 **밑변** 높이. */
  y: number;
  z: number;
  halfW: number;
  height: number;
  yaw: number;
}

interface Pane { structureId: string; index: number; spec: WindowSpec; entry: ObstacleEntry; broken: boolean }

export class GlassSet {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private mat: THREE.MeshStandardMaterial | null = null;
  private geo: THREE.BoxGeometry | null = null;
  private readonly panes: Pane[] = [];
  private readonly byKey = new Map<string, Pane>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor() { this.group.name = 'StructureGlass'; }

  static key(structureId: string, index: number): string { return `${structureId}:${index}`; }

  get count(): number { return this.panes.length; }
  get brokenCount(): number { let n = 0; for (const p of this.panes) if (p.broken) n++; return n; }
  /** 깨진 창 `<structureId>:<index>` 전부 (`struct sync.glass`). */
  brokenKeys(): string[] { return this.panes.filter((p) => p.broken).map((p) => GlassSet.key(p.structureId, p.index)); }

  /**
   * 유리를 전부 세운다. `onHit(structureId, index, point)` 는 총알 · 투척물이 **이 클라이언트에서** 유리를 맞혔을 때
   * 불린다 — 실제로 깨는 것은 호출한 쪽이 `breakPane` 으로 한다 (소리 · 와이어 · 이벤트를 한 곳에서 내려고).
   */
  build(ctx: BuildCtx, specs: readonly { structureId: string; index: number; spec: WindowSpec }[],
    onHit: (structureId: string, index: number, point: THREE.Vector3 | undefined) => void): void {
    if (specs.length === 0) return;
    this.geo = new THREE.BoxGeometry(1, 1, 1);
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x9cc6d6, roughness: 0.06, metalness: 0.2, transparent: true, opacity: 0.26, depthWrite: false,
      emissive: new THREE.Color(0x0d1e26), emissiveIntensity: 0.6,
    });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, specs.length);
    this.mesh.name = 'structure_glass';
    this.mesh.frustumCulled = false;
    this.mesh.layers.enable(Layers.PROP);
    this.mesh.renderOrder = 2;
    specs.forEach(({ structureId, index, spec }, i) => {
      this.writeInstance(i, spec, false);
      const entry = ctx.hash.addBox(
        new THREE.Vector3(spec.x, spec.y, spec.z), spec.halfW, GLASS_T / 2 + 0.02, spec.yaw, spec.height, 'glass',
      ) as ObstacleEntry;
      entry.fragile = true;
      const pane: Pane = { structureId, index, spec, entry, broken: false };
      entry.destructible = {
        id: `glass:${structureId}:${index}`,
        get hp(): number { return pane.broken ? 0 : 1; },
        maxHp: 1,
        onDamage: (_amount: number, point?: THREE.Vector3) => { if (!pane.broken) onHit(structureId, index, point); },
      };
      this.panes.push(pane);
      this.byKey.set(GlassSet.key(structureId, index), pane);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.mesh);
  }

  /** 창 한 장의 가운데 (소리 · 파편 자리). 없으면 null. */
  centerOf(structureId: string, index: number, out: THREE.Vector3): THREE.Vector3 | null {
    const p = this.byKey.get(GlassSet.key(structureId, index));
    if (!p) return null;
    return out.set(p.spec.x, p.spec.y + p.spec.height / 2, p.spec.z);
  }

  /** 창 면의 법선 (창 면에 수직인 수평 단위 벡터). */
  normalOf(structureId: string, index: number, out: THREE.Vector3): THREE.Vector3 | null {
    const p = this.byKey.get(GlassSet.key(structureId, index));
    if (!p) return null;
    return out.set(-Math.sin(p.spec.yaw), 0, Math.cos(p.spec.yaw));
  }

  /** 깨뜨린다. 이미 깨졌거나 없는 창이면 false. */
  breakPane(structureId: string, index: number): boolean {
    const pane = this.byKey.get(GlassSet.key(structureId, index));
    if (!pane || pane.broken) return false;
    pane.broken = true;
    const e = pane.entry;
    e.fragile = false;
    e.destructible = undefined;
    e.passRays = true;
    e.passSmall = true;
    const i = this.panes.indexOf(pane);
    if (this.mesh && i >= 0) { this.writeInstance(i, pane.spec, true); this.mesh.instanceMatrix.needsUpdate = true; }
    return true;
  }

  private writeInstance(i: number, spec: WindowSpec, hidden: boolean): void {
    if (!this.mesh) return;
    this.p.set(spec.x, spec.y + spec.height / 2, spec.z);
    this.q.setFromAxisAngle(this.up, -spec.yaw);
    if (hidden) this.s.set(0, 0, 0); else this.s.set(spec.halfW * 2, spec.height, GLASS_T);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
  }

  dispose(): void {
    this.panes.length = 0;
    this.byKey.clear();
    this.mesh?.dispose();
    this.mesh = null;
    this.geo?.dispose(); this.geo = null;
    this.mat?.dispose(); this.mat = null;
    this.group.clear();
    this.group.removeFromParent();
  }
}
