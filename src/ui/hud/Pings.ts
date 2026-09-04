import * as THREE from 'three';
import type { GameContext, EnemyRef } from '@/shared';
import { MouseButtons, PING_LIFETIME } from '@/shared';
import { el, setText } from '../dom';

export type PingKind = 'ground' | 'enemy' | 'crate' | 'extraction';

export const PING_LABEL: Record<PingKind, string> = { ground: '핑', enemy: '적', crate: '보급', extraction: '탈출' };
export const PING_COLOR: Record<PingKind, number> = { ground: 0x7fb7e6, enemy: 0xff4d4d, crate: 0x4fd17e, extraction: 0xffb347 };

const MAX_PINGS = 3;
const COOLDOWN = 0.3;
const RAY_MAX = 300;
const FALLBACK_DIST = 120;
const CRATE_SNAP = 2.5;
const PAD_SNAP = 8;
const BEACON_HEIGHT = 6;

interface Ping {
  id: number;
  kind: PingKind;
  position: THREE.Vector3;    // live (follows the enemy for 'enemy' pings)
  expires: number;
  enemy: EnemyRef | null;
  // DOM
  el: HTMLElement;
  dist: HTMLElement;
  lastKey: string;
  // 3D
  group: THREE.Group;
  ring: THREE.Mesh;
  lineMat: THREE.MeshBasicMaterial;
  ringMat: THREE.MeshBasicMaterial;
}

/**
 * Middle-mouse pings: projected DOM marker (icon + label + live distance) and a small
 * procedural beacon in the scene (emissive line + pulsing ground ring). Max 3, expire after
 * PING_LIFETIME. Emits `ping:placed` / `ping:removed`.
 */
export class Pings {
  readonly root: HTMLElement;
  private ctx!: GameContext;
  private pings: Ping[] = [];
  private nextId = 1;
  private lastPingTime = -Infinity;
  private lineGeo: THREE.BufferGeometry | null = null;
  private ringGeo: THREE.BufferGeometry | null = null;
  private unsubs: Array<() => void> = [];

  // scratch
  private origin = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private v = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'ping-markers', parent });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.unsubs.push(
      ctx.bus.on('game:abort', () => this.clear(true)),
      ctx.bus.on('game:newMission', () => this.clear(true)),
      ctx.bus.on('player:died', () => this.clear(false)),
    );
  }

  /** Live pings (read-only view) for other HUD parts (map). */
  getPings(): readonly { id: number; kind: PingKind; position: THREE.Vector3; expires: number }[] { return this.pings; }

  update(dt: number, ctx: GameContext): void {
    void dt;
    // input
    if (ctx.isGameplayActive() && ctx.input.isPointerLocked && !(ctx.player?.isDead ?? false)
      && ctx.input.wasMousePressed(MouseButtons.PING) && ctx.time - this.lastPingTime >= COOLDOWN) {
      this.lastPingTime = ctx.time;
      this.place(ctx);
    }
    // expiry + follow + pulse
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      if (ctx.time >= p.expires) { this.remove(i, true); continue; }
      if (p.enemy && !p.enemy.isDead) p.position.copy(p.enemy.position);
      const life = p.expires - ctx.time;
      const fade = life < 2 ? Math.max(0, life / 2) : 1;
      const pulse = 0.5 + 0.5 * Math.sin(ctx.time * 4.2 + p.id);
      p.group.position.copy(p.position);
      p.ring.scale.setScalar(1 + 0.35 * pulse);
      p.ringMat.opacity = (0.35 + 0.5 * (1 - pulse)) * fade;
      p.lineMat.opacity = (0.55 + 0.3 * pulse) * fade;
    }
  }

  lateUpdate(ctx: GameContext): void {
    const cam = ctx.camera;
    const player = ctx.player;
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    for (const p of this.pings) {
      this.v.copy(p.position); this.v.y += p.kind === 'enemy' ? 1.6 : 1.4;
      this.v.project(cam);
      if (this.v.z > 1 || this.v.z < -1) { this.hide(p); continue; }
      const sx = (this.v.x * 0.5 + 0.5) * w;
      const sy = (-this.v.y * 0.5 + 0.5) * h;
      if (sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) { this.hide(p); continue; }
      const dist = player ? Math.hypot(p.position.x - player.position.x, p.position.z - player.position.z) : 0;
      let alpha = 1;
      if (dist < 6) alpha = Math.max(0.2, (dist - 1.5) / 4.5);
      const life = p.expires - ctx.time;
      if (life < 2) alpha *= Math.max(0, life / 2);
      const key = `${Math.round(sx)}|${Math.round(sy)}|${Math.round(dist)}|${alpha.toFixed(2)}`;
      if (key === p.lastKey) continue;
      p.lastKey = key;
      p.el.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -100%)`;
      p.el.style.opacity = alpha.toFixed(2);
      setText(p.dist, `${Math.round(dist)}m`);
    }
  }

  private hide(p: Ping): void {
    if (p.lastKey !== 'hidden') { p.lastKey = 'hidden'; p.el.style.opacity = '0'; }
  }

  /* ── placement ─────────────────────────────────────────────────────────── */

  private place(ctx: GameContext): void {
    const world = ctx.world;
    if (!world?.ready) return;
    const cam = ctx.camera;
    cam.getWorldPosition(this.origin);
    cam.getWorldDirection(this.dir);

    const eh = ctx.enemies?.raycast(this.origin, this.dir, RAY_MAX) ?? null;
    const wh = world.raycast(this.origin, this.dir, RAY_MAX);

    let kind: PingKind = 'ground';
    let enemy: EnemyRef | null = null;
    const pos = new THREE.Vector3();

    if (eh && (!wh || eh.distance <= wh.distance)) {
      kind = 'enemy'; enemy = eh.enemy;
      pos.copy(eh.enemy.position);
    } else if (wh) {
      pos.copy(wh.point);
    } else {
      pos.copy(this.origin).addScaledVector(this.dir, FALLBACK_DIST);
      const half = world.size / 2 - 1;
      pos.x = THREE.MathUtils.clamp(pos.x, -half, half);
      pos.z = THREE.MathUtils.clamp(pos.z, -half, half);
      pos.y = world.getHeightAt(pos.x, pos.z);
    }

    if (kind !== 'enemy') {
      // snap to nearby crate / extraction pad
      let bestD = CRATE_SNAP;
      for (const c of world.getCrates()) {
        const d = Math.hypot(c.position.x - pos.x, c.position.z - pos.z);
        if (d < bestD) { bestD = d; kind = 'crate'; pos.copy(c.position); }
      }
      if (kind !== 'crate') {
        let padD = PAD_SNAP;
        for (const e of world.getExtractionPoints()) {
          const d = Math.hypot(e.position.x - pos.x, e.position.z - pos.z);
          if (d < padD) { padD = d; kind = 'extraction'; pos.copy(e.position); }
        }
      }
    }

    while (this.pings.length >= MAX_PINGS) this.remove(0, true);

    const id = this.nextId++;
    const expires = ctx.time + PING_LIFETIME;
    const ping = this.build(id, kind, pos, expires, enemy);
    this.pings.push(ping);
    ctx.bus.emit('ping:placed', { id, position: ping.position, kind, expires });
  }

  private build(id: number, kind: PingKind, pos: THREE.Vector3, expires: number, enemy: EnemyRef | null): Ping {
    const m = el('div', { cls: `pmarker ${kind}`, parent: this.root });
    el('i', { cls: 'ico', parent: m });
    el('span', { cls: 'lbl', text: PING_LABEL[kind], parent: m });
    const dist = el('span', { cls: 'dist ui-mono', text: '', parent: m });

    if (!this.lineGeo) {
      const g = new THREE.CylinderGeometry(0.035, 0.05, BEACON_HEIGHT, 6, 1, true);
      g.translate(0, BEACON_HEIGHT / 2, 0);
      this.lineGeo = g;
    }
    if (!this.ringGeo) {
      const g = new THREE.RingGeometry(0.75, 0.95, 40);
      g.rotateX(-Math.PI / 2);
      this.ringGeo = g;
    }
    const color = PING_COLOR[kind];
    const lineMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide });
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide });
    const group = new THREE.Group();
    group.name = `ping-${id}`;
    const line = new THREE.Mesh(this.lineGeo, lineMat);
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    ring.position.y = 0.06;
    line.frustumCulled = false; ring.frustumCulled = false;
    group.add(line, ring);
    group.position.copy(pos);
    this.ctx.scene.add(group);

    return { id, kind, position: pos, expires, enemy, el: m, dist, lastKey: '', group, ring, lineMat, ringMat };
  }

  private remove(index: number, emit: boolean): void {
    const p = this.pings[index];
    if (!p) return;
    this.pings.splice(index, 1);
    p.el.remove();
    this.ctx.scene.remove(p.group);
    p.lineMat.dispose(); p.ringMat.dispose();
    if (emit) this.ctx.bus.emit('ping:removed', { id: p.id });
  }

  private clear(disposeShared: boolean): void {
    while (this.pings.length) this.remove(this.pings.length - 1, true);
    if (disposeShared) {
      this.lineGeo?.dispose(); this.ringGeo?.dispose();
      this.lineGeo = null; this.ringGeo = null;
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.clear(true);
    this.root.remove();
  }
}
