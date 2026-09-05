import * as THREE from 'three';
import type { GameContext, EnemyRef } from '@/shared';
import {
  DETECT_BASE_RADIUS, DETECT_ENEMY_BASE_RADIUS, DETECT_HIGHLIGHT_COLOR, DETECT_ENEMY_COLOR,
} from '@/shared';
import { el } from '../dom';

const MAX_SHELLS = 24;          // pooled fresnel shells (interactables in range)
const MAX_ARROWS = 6;           // pooled off-screen enemy arrows
const SCAN_INTERVAL = 0.15;     // seconds between candidate re-scans
const SHELL_RADIUS = 0.85;      // meters
const ARROW_RX = 0.34;          // arrow ring radii as a fraction of the viewport
const ARROW_RY = 0.34;

const VERT = `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
  gl_FragColor = vec4(uColor, f * uOpacity);
}`;

interface Shell { mesh: THREE.Mesh; active: boolean }
interface Arrow { el: HTMLElement; lastKey: string }

/**
 * 감지 시스템 (perception).
 *
 * 1. Interactables (crates, gather nodes, pickups, deployables, switches) inside
 *    `ctx.progression.derived.detectRadius` get a pooled fresnel shell in the scene — depth-tested, so walls
 *    still hide it (the through-wall version is `ScanReveal`).
 * 2. Enemies inside `derived.enemyDetectRadius` that are off-screen get a pooled red edge arrow.
 *
 * Everything is pooled: no per-frame geometry/material/DOM allocation, and no runtime light changes.
 * Falls back to `DETECT_BASE_RADIUS` / `DETECT_ENEMY_BASE_RADIUS` while `ctx.progression` is missing.
 */
export class Detection {
  readonly root: HTMLElement;
  private ctx!: GameContext;
  private shells: Shell[] = [];
  private arrows: Arrow[] = [];
  private group: THREE.Group | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private mat: THREE.ShaderMaterial | null = null;
  private scanTimer = 0;
  private visible = false;
  private targets: THREE.Vector3[] = [];
  private enemies: EnemyRef[] = [];
  private v = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'detect-arrows', parent });
    for (let i = 0; i < MAX_ARROWS; i++) {
      const a = el('div', { cls: 'detect-arrow', parent: this.root });
      a.hidden = true;
      el('i', { parent: a });
      this.arrows.push({ el: a, lastKey: '' });
    }
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.unsubs.push(
      ctx.bus.on('game:abort', () => this.teardown()),
      ctx.bus.on('game:newMission', () => this.teardown()),
      ctx.bus.on('hub:entered', () => this.hideAll()),
    );
  }

  private ensureScene(): void {
    if (this.group) return;
    this.geo = new THREE.IcosahedronGeometry(SHELL_RADIUS, 2);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(DETECT_HIGHLIGHT_COLOR) },
        uOpacity: { value: 0.6 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.group = new THREE.Group();
    this.group.name = 'detect-highlights';
    for (let i = 0; i < MAX_SHELLS; i++) {
      const m = new THREE.Mesh(this.geo, this.mat);
      m.visible = false;
      m.frustumCulled = false;
      this.group.add(m);
      this.shells.push({ mesh: m, active: false });
    }
    this.ctx.scene.add(this.group);
  }

  private teardown(): void {
    this.hideAll();
    if (this.group) {
      this.ctx.scene.remove(this.group);
      this.group.clear();
      this.group = null;
    }
    this.shells.length = 0;
    this.geo?.dispose(); this.geo = null;
    this.mat?.dispose(); this.mat = null;
    this.targets.length = 0;
    this.enemies.length = 0;
  }

  private hideAll(): void {
    for (const s of this.shells) { s.mesh.visible = false; s.active = false; }
    for (const a of this.arrows) { if (!a.el.hidden) { a.el.hidden = true; a.lastKey = ''; } }
    this.visible = false;
  }

  private detectRadius(ctx: GameContext): number {
    const r = ctx.progression?.derived?.detectRadius;
    return typeof r === 'number' && r > 0 ? r : DETECT_BASE_RADIUS;
  }
  private enemyRadius(ctx: GameContext): number {
    const r = ctx.progression?.derived?.enemyDetectRadius;
    return typeof r === 'number' && r > 0 ? r : DETECT_ENEMY_BASE_RADIUS;
  }

  lateUpdate(dt: number, ctx: GameContext): void {
    const player = ctx.player;
    const active = ctx.isGameplayPhase() && !!player && !player.isDead
      && !ctx.uiBlockers.has('menu') && !ctx.uiBlockers.has('map');
    if (!active) { if (this.visible) this.hideAll(); return; }
    this.visible = true;
    this.ensureScene();
    if (this.mat) this.mat.uniforms.uOpacity.value = 0.5 + 0.18 * Math.sin(ctx.time * 3);

    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = SCAN_INTERVAL;
      this.collect(ctx, player!.position);
    }
    this.placeShells();
    this.placeArrows(ctx, player!.position);
  }

  /** Re-scan interactables / enemies in range (cheap, a few times a second). */
  private collect(ctx: GameContext, from: THREE.Vector3): void {
    this.targets.length = 0;
    const r = this.detectRadius(ctx);
    const r2 = r * r;
    for (const it of ctx.interactables.all()) {
      const dx = it.position.x - from.x, dy = it.position.y - from.y, dz = it.position.z - from.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      if (!it.canInteract()) continue;
      this.targets.push(it.position);
      if (this.targets.length >= MAX_SHELLS) break;
    }

    this.enemies.length = 0;
    const er = this.enemyRadius(ctx);
    const em = ctx.enemies;
    if (em) {
      // `queryNear` is part of the appended contract but the enemies folder may not have it yet.
      const qn = (em as { queryNear?: (p: THREE.Vector3, radius: number) => EnemyRef[] }).queryNear;
      const near = typeof qn === 'function' ? qn.call(em, from, er) : null;
      if (near) {
        for (const e of near) { if (!e.isDead) this.enemies.push(e); }
      } else {
        const er2 = er * er;
        for (const e of em.getEnemies()) {
          if (e.isDead) continue;
          const dx = e.position.x - from.x, dz = e.position.z - from.z;
          if (dx * dx + dz * dz <= er2) this.enemies.push(e);
        }
      }
    }
  }

  private placeShells(): void {
    const n = Math.min(this.targets.length, this.shells.length);
    for (let i = 0; i < this.shells.length; i++) {
      const s = this.shells[i];
      if (i < n) {
        s.mesh.position.copy(this.targets[i]);
        s.mesh.position.y += 0.45;
        if (!s.mesh.visible) s.mesh.visible = true;
        s.active = true;
      } else if (s.active || s.mesh.visible) {
        s.mesh.visible = false; s.active = false;
      }
    }
  }

  private placeArrows(ctx: GameContext, from: THREE.Vector3): void {
    const cam = ctx.camera;
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    const cx = w / 2, cy = h / 2;
    const rx = w * ARROW_RX, ry = h * ARROW_RY;
    let used = 0;
    for (const e of this.enemies) {
      if (used >= MAX_ARROWS) break;
      this.v.copy(e.position); this.v.y += 0.8;
      this.v.project(cam);
      const behind = this.v.z > 1;
      if (behind) { this.v.x = -this.v.x; this.v.y = -this.v.y; }
      const off = behind || Math.abs(this.v.x) > 0.98 || Math.abs(this.v.y) > 0.98;
      if (!off) continue;
      const a = Math.atan2(this.v.y, this.v.x);
      const px = cx + Math.cos(a) * rx;
      const py = cy - Math.sin(a) * ry;
      const dist = this.tmp.set(e.position.x - from.x, 0, e.position.z - from.z).length();
      const alpha = Math.max(0.25, 1 - dist / (this.enemyRadius(ctx) * 1.15));
      const deg = (-a * 180) / Math.PI;
      const arrow = this.arrows[used++];
      const key = `${px.toFixed(0)}|${py.toFixed(0)}|${deg.toFixed(0)}|${alpha.toFixed(2)}`;
      if (arrow.el.hidden) arrow.el.hidden = false;
      if (key !== arrow.lastKey) {
        arrow.lastKey = key;
        arrow.el.style.transform = `translate(${px.toFixed(0)}px, ${py.toFixed(0)}px) translate(-50%, -50%) rotate(${deg.toFixed(0)}deg)`;
        arrow.el.style.opacity = alpha.toFixed(2);
      }
    }
    for (let i = used; i < this.arrows.length; i++) {
      const a = this.arrows[i];
      if (!a.el.hidden) { a.el.hidden = true; a.lastKey = ''; }
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.teardown();
    this.root.remove();
  }
}

/** Colour the arrows use (mirrored in CSS as `--detect-enemy`). */
export const DETECT_ENEMY_CSS = `#${DETECT_ENEMY_COLOR.toString(16).padStart(6, '0')}`;
