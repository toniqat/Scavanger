import * as THREE from 'three';
import type { GameContext, ScanTarget } from '@/shared';
import {
  DETECT_HIGHLIGHT_COLOR, DETECT_ENEMY_COLOR, IMPLANT_SCAN_REVEAL_TIME,
  INTERACT_PILLAR_OPACITY, SCAN_PILLAR_HEIGHT,
} from '@/shared';
import { makePillarGeometry, makePillarMaterial, pillarAllowed } from './pillar';

/**
 * Pool size. Phase 12's 정찰 is one wide `IMPLANT_SCAN_RADIUS` (70 m) pulse that reveals every interactable **and**
 * enemy in range for 15 s — a busy map can hand over ~34 gather nodes + crates + pickups + the ambient enemy cap in
 * one event, so 64 starved (the oldest reveals were evicted while still valid). 160 meshes of one shared geometry.
 */
const MAX_REVEALS = 160;
/**
 * Pillar **height multiplier** per revealed kind (Phase 10 — it used to be the fresnel shell's radius in metres).
 * The base height is `SCAN_PILLAR_HEIGHT`; scaling the mesh on Y scales the baked colour ramp with it, so a taller
 * pillar still fades out at the same fraction of its own height.
 */
const KIND_SCALE: Record<ScanTarget['kind'], number> = {
  enemy: 1.15, crate: 0.95, pickup: 0.7, gather: 0.75, objective: 1.4, deployable: 1,
};

interface Reveal {
  key: string;
  kind: ScanTarget['kind'];
  position: THREE.Vector3;
  object: THREE.Object3D | null;
  expires: number;
}

/**
 * Through-wall outlines for scan results (`implant:scanned`) and any other `detect:reveal` command.
 *
 * Each revealed object gets a pooled **light pillar** drawn with `depthTest: false` (so it reads through geometry) for
 * the requested duration — 15 s for the Phase 12 정찰 pulse (`scan:cast`, `IMPLANT_SCAN_REVEAL_TIME_V2`). Phase 10 replaced the light-blue fresnel shell with the pillar
 * from `hud/pillar.ts` (open cylinder from the ground up, baked vertex colours fading to black, additive), and
 * `KIND_SCALE` became a **height** multiplier of `SCAN_PILLAR_HEIGHT` instead of a radius. Targets that came with an
 * `object` follow it, so revealed enemies keep their marker while they move. Pool: `MAX_REVEALS` meshes, one shared
 * geometry and two shared materials (enemy red / everything else cyan); nothing is allocated per frame.
 */
export class ScanReveal {
  private ctx!: GameContext;
  private reveals: Reveal[] = [];
  private group: THREE.Group | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private matNeutral: THREE.MeshBasicMaterial | null = null;
  private matEnemy: THREE.MeshBasicMaterial | null = null;
  private meshes: THREE.Mesh[] = [];
  private unsubs: Array<() => void> = [];

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('detect:reveal', ({ targets, duration }) => this.add(targets, duration)),
      b.on('implant:scanned', ({ targets, duration }) => this.add(targets, duration)),
      // Phase 12: the wide 정찰 pulse (mine or a squadmate's). `add` merges by `kind:id`, so an implants build that
      // still emits `implant:scanned` / `detect:reveal` alongside it never doubles a pillar.
      b.on('scan:cast', ({ targets, duration }) => this.add(targets, duration)),
      b.on('detect:clear', () => this.clear()),
      b.on('game:abort', () => this.teardown()),
      b.on('game:newMission', () => this.teardown()),
      b.on('player:died', () => this.clear()),
    );
  }

  private ensureScene(): void {
    if (this.group) return;
    this.geo = makePillarGeometry(SCAN_PILLAR_HEIGHT);
    const make = (hex: number): THREE.MeshBasicMaterial => makePillarMaterial(hex, INTERACT_PILLAR_OPACITY, true);
    this.matNeutral = make(DETECT_HIGHLIGHT_COLOR);
    this.matEnemy = make(DETECT_ENEMY_COLOR);
    this.group = new THREE.Group();
    this.group.name = 'scan-reveals';
    this.group.renderOrder = 999;
    for (let i = 0; i < MAX_REVEALS; i++) {
      const m = new THREE.Mesh(this.geo, this.matNeutral);
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 999;
      this.group.add(m);
      this.meshes.push(m);
    }
    this.ctx.scene.add(this.group);
  }

  private add(targets: readonly ScanTarget[] | undefined, duration: number): void {
    if (!targets || targets.length === 0) return;
    const dur = duration > 0 ? duration : IMPLANT_SCAN_REVEAL_TIME;
    const expires = this.ctx.time + dur;
    for (const t of targets) {
      // 2026-09-11: 빛기둥은 시체에만 — 적은 붉은 투시 실루엣(`enemies.setXray`)과 화살표가, 나머지는 나침반이 알린다.
      if (!pillarAllowed(t.id)) continue;
      const key = `${t.kind}:${t.id}`;
      const existing = this.reveals.find((r) => r.key === key);
      if (existing) {
        existing.expires = Math.max(existing.expires, expires);
        existing.position.copy(t.position);
        existing.object = t.object ?? existing.object;
        continue;
      }
      if (this.reveals.length >= MAX_REVEALS) this.reveals.shift();
      this.reveals.push({ key, kind: t.kind, position: t.position.clone(), object: t.object ?? null, expires });
    }
    if (this.reveals.length > 0) this.ensureScene();
  }

  private clear(): void {
    this.reveals.length = 0;
    for (const m of this.meshes) m.visible = false;
  }

  private teardown(): void {
    this.clear();
    if (this.group) {
      this.ctx.scene.remove(this.group);
      this.group.clear();
      this.group = null;
    }
    this.meshes.length = 0;
    this.geo?.dispose(); this.geo = null;
    this.matNeutral?.dispose(); this.matNeutral = null;
    this.matEnemy?.dispose(); this.matEnemy = null;
  }

  lateUpdate(_dt: number, ctx: GameContext): void {
    if (this.reveals.length === 0) return;
    const t = ctx.time;
    for (let i = this.reveals.length - 1; i >= 0; i--) {
      if (t >= this.reveals[i].expires) this.reveals.splice(i, 1);
    }
    if (this.reveals.length === 0) { this.clear(); return; }
    this.ensureScene();
    const pulse = INTERACT_PILLAR_OPACITY * (0.9 + 0.35 * Math.sin(t * 4));
    if (this.matNeutral) this.matNeutral.opacity = pulse;
    if (this.matEnemy) this.matEnemy.opacity = pulse * 1.15;

    const n = Math.min(this.reveals.length, this.meshes.length);
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      if (i >= n) { if (m.visible) m.visible = false; continue; }
      const r = this.reveals[i];
      if (r.object) r.object.getWorldPosition(r.position);
      // The pillar's base is its origin, so it stands on the target — no vertical lift.
      m.position.copy(r.position);
      const s = KIND_SCALE[r.kind] ?? 1;
      m.scale.set(1, s, 1);
      const mat = r.kind === 'enemy' ? this.matEnemy : this.matNeutral;
      if (mat && m.material !== mat) m.material = mat;
      if (!m.visible) m.visible = true;
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.teardown();
  }
}
