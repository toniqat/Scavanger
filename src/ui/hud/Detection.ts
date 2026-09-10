import * as THREE from 'three';
import type { GameContext, EnemyRef } from '@/shared';
import {
  DETECT_BASE_RADIUS, DETECT_ENEMY_BASE_RADIUS, DETECT_HIGHLIGHT_COLOR, DETECT_ENEMY_COLOR,
  INTERACT_PILLAR_OPACITY,
} from '@/shared';
import { el } from '../dom';
import { makePillarGeometry, makePillarMaterial, pillarAllowed } from './pillar';
import type { ScanTracker } from './ScanTracker';

const MAX_SHELLS = 24;          // pooled light pillars (interactables in range)
const MAX_ARROWS = 6;           // pooled off-screen enemy arrows
const MAX_MARKS = 12;           // pooled on-screen enemy chevrons (Phase 12)
const SCAN_INTERVAL = 0.15;     // seconds between candidate re-scans
const ARROW_RX = 0.34;          // arrow ring radii as a fraction of the viewport
const ARROW_RY = 0.34;
const MARK_LIFT = 0.55;         // metres above the enemy's `height` the chevron floats

interface Shell { mesh: THREE.Mesh; active: boolean }
interface Arrow { el: HTMLElement; lastKey: string }
/** One candidate for the arrows / chevrons: a live ref inside the radius, or a 정찰-revealed position. */
interface Candidate { pos: THREE.Vector3; height: number; scanned: boolean }

/**
 * 감지 시스템 (perception).
 *
 * 1. **Corpses only** (2026-09-11 — `pillarAllowed`; crates / gather nodes / pickups / deployables no longer get one) inside
 *    `ctx.progression.derived.detectRadius` get a pooled **light pillar** in the scene (Phase 10 — it replaced the
 *    light-blue fresnel sphere): an open cylinder rising from the ground with baked vertex colours that go black
 *    toward the top, drawn additively so black reads as transparent (see `hud/pillar.ts`). Depth-tested, so walls
 *    still hide it (the through-wall version is `ScanReveal`).
 * 2. Enemies inside `derived.enemyDetectRadius` that are off-screen get a pooled red edge arrow; those **on screen**
 *    get a small pooled red chevron floating above the body (Phase 12 — the same projection decides which of the two
 *    a candidate takes, so the chevron costs nothing extra per enemy).
 * 3. Enemies revealed by a 정찰 pulse (`scan:cast`, through the shared `ScanTracker`) join (2) for the reveal's
 *    duration regardless of distance — their red through-wall silhouette is enemies/' `setXray`, their pillar is
 *    `ScanReveal`; this adds the screen-space arrow / chevron only.
 *
 * Everything is pooled: no per-frame geometry/material/DOM allocation, and no runtime light changes.
 * Falls back to `DETECT_BASE_RADIUS` / `DETECT_ENEMY_BASE_RADIUS` while `ctx.progression` is missing.
 */
export class Detection {
  readonly root: HTMLElement;
  private ctx!: GameContext;
  private shells: Shell[] = [];
  private arrows: Arrow[] = [];
  private marks: Arrow[] = [];
  private group: THREE.Group | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private mat: THREE.MeshBasicMaterial | null = null;
  private scanTimer = 0;
  private visible = false;
  private targets: THREE.Vector3[] = [];
  private enemies: EnemyRef[] = [];
  private enemyIds = new Set<number>();
  private candidates: Candidate[] = [];
  private candidatePool: Candidate[] = [];
  private shownMarks = 0;
  private v = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement, private scans: ScanTracker | null = null) {
    this.root = el('div', { cls: 'detect-arrows', parent });
    for (let i = 0; i < MAX_ARROWS; i++) {
      const a = el('div', { cls: 'detect-arrow', parent: this.root });
      a.hidden = true;
      el('i', { parent: a });
      this.arrows.push({ el: a, lastKey: '' });
    }
    for (let i = 0; i < MAX_MARKS; i++) {
      const m = el('div', { cls: 'detect-mark', parent: this.root });
      m.hidden = true;
      el('i', { parent: m });
      this.marks.push({ el: m, lastKey: '' });
    }
    for (let i = 0; i < MAX_ARROWS + MAX_MARKS + 8; i++) this.candidatePool.push({ pos: new THREE.Vector3(), height: 1, scanned: false });
  }

  /** On-screen enemy chevrons currently shown (debug). */
  get markCount(): number { return this.shownMarks; }

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
    this.geo = makePillarGeometry();
    this.mat = makePillarMaterial(DETECT_HIGHLIGHT_COLOR, INTERACT_PILLAR_OPACITY);
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
    for (const m of this.marks) { if (!m.el.hidden) { m.el.hidden = true; m.lastKey = ''; } }
    this.shownMarks = 0;
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
    // Breathing on the material's own opacity (the vertex-colour ramp owns the vertical fade).
    if (this.mat) this.mat.opacity = INTERACT_PILLAR_OPACITY * (0.85 + 0.3 * Math.sin(ctx.time * 3));

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
      // 2026-09-11: 빛기둥은 시체에만 (`pillarAllowed`) — 상자 · 컨테이너는 열린 모습으로 조사 여부를 보여 준다.
      if (!pillarAllowed(it.id)) continue;
      if (!it.canInteract()) continue;
      // 2026-09-08: an interactable this client has already dealt with (a searched corpse) hides its own pillar.
      if (it.hidePillar) continue;
      this.targets.push(it.position);
      if (this.targets.length >= MAX_SHELLS) break;
    }

    this.enemies.length = 0;
    this.enemyIds.clear();
    const er = this.enemyRadius(ctx);
    const em = ctx.enemies;
    if (em) {
      // `queryNear` is part of the appended contract but the enemies folder may not have it yet.
      const qn = (em as { queryNear?: (p: THREE.Vector3, radius: number) => EnemyRef[] }).queryNear;
      const near = typeof qn === 'function' ? qn.call(em, from, er) : null;
      if (near) {
        for (const e of near) { if (!e.isDead) { this.enemies.push(e); this.enemyIds.add(e.id); } }
      } else {
        const er2 = er * er;
        for (const e of em.getEnemies()) {
          if (e.isDead) continue;
          const dx = e.position.x - from.x, dz = e.position.z - from.z;
          if (dx * dx + dz * dz <= er2) { this.enemies.push(e); this.enemyIds.add(e.id); }
        }
      }
    }
  }

  /** Detected refs + 정찰 reveals into one pooled candidate list (no allocation once the pool is warm). */
  private gatherCandidates(ctx: GameContext): void {
    this.candidates.length = 0;
    let n = 0;
    const take = (): Candidate | null => {
      if (n >= this.candidatePool.length) return null;
      const c = this.candidatePool[n++];
      this.candidates.push(c);
      return c;
    };
    for (const e of this.enemies) {
      if (e.isDead) continue;
      const c = take(); if (!c) return;
      c.pos.copy(e.position); c.height = e.height; c.scanned = false;
    }
    const scanned = this.scans?.update(ctx);
    if (!scanned) return;
    for (const s of scanned) {
      if (this.enemyIds.has(s.id)) continue;
      const c = take(); if (!c) return;
      c.pos.copy(s.position); c.height = 1.2; c.scanned = true;
    }
  }

  private placeShells(): void {
    const n = Math.min(this.targets.length, this.shells.length);
    for (let i = 0; i < this.shells.length; i++) {
      const s = this.shells[i];
      if (i < n) {
        // A pillar starts at ground level — no lift (the old fresnel sphere needed `+= 0.45` to sit on the object).
        s.mesh.position.copy(this.targets[i]);
        if (!s.mesh.visible) s.mesh.visible = true;
        s.active = true;
      } else if (s.active || s.mesh.visible) {
        s.mesh.visible = false; s.active = false;
      }
    }
  }

  private placeArrows(ctx: GameContext, from: THREE.Vector3): void {
    this.gatherCandidates(ctx);
    const cam = ctx.camera;
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    const cx = w / 2, cy = h / 2;
    const rx = w * ARROW_RX, ry = h * ARROW_RY;
    const radius = this.enemyRadius(ctx);
    let used = 0;
    let marks = 0;
    for (const c of this.candidates) {
      if (used >= MAX_ARROWS && marks >= MAX_MARKS) break;
      const dist = this.tmp.set(c.pos.x - from.x, 0, c.pos.z - from.z).length();
      // a scanned enemy was not found by distance, so it does not fade with it
      const alpha = c.scanned ? 0.95 : Math.max(0.25, 1 - dist / (radius * 1.15));
      this.v.copy(c.pos); this.v.y += 0.8;
      this.v.project(cam);
      const behind = this.v.z > 1;
      if (behind) { this.v.x = -this.v.x; this.v.y = -this.v.y; }
      const off = behind || Math.abs(this.v.x) > 0.98 || Math.abs(this.v.y) > 0.98;
      if (!off) {
        // on screen → chevron above the head (Phase 12), from the same projection at the body's top
        if (marks >= MAX_MARKS) continue;
        this.v.copy(c.pos); this.v.y += c.height + MARK_LIFT;
        this.v.project(cam);
        const px = (this.v.x * 0.5 + 0.5) * w;
        const py = (-this.v.y * 0.5 + 0.5) * h;
        const mark = this.marks[marks++];
        const key = `${px.toFixed(0)}|${py.toFixed(0)}|${alpha.toFixed(2)}|${c.scanned ? 1 : 0}`;
        if (mark.el.hidden) mark.el.hidden = false;
        if (key !== mark.lastKey) {
          mark.lastKey = key;
          mark.el.style.transform = `translate(${px.toFixed(0)}px, ${py.toFixed(0)}px) translate(-50%, -100%)`;
          mark.el.style.opacity = alpha.toFixed(2);
          mark.el.classList.toggle('scanned', c.scanned);
        }
        continue;
      }
      if (used >= MAX_ARROWS) continue;
      const a = Math.atan2(this.v.y, this.v.x);
      const px = cx + Math.cos(a) * rx;
      const py = cy - Math.sin(a) * ry;
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
    for (let i = marks; i < this.marks.length; i++) {
      const m = this.marks[i];
      if (!m.el.hidden) { m.el.hidden = true; m.lastKey = ''; }
    }
    this.shownMarks = marks;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.teardown();
    this.root.remove();
  }
}

/** Colour the arrows use (mirrored in CSS as `--detect-enemy`). */
export const DETECT_ENEMY_CSS = `#${DETECT_ENEMY_COLOR.toString(16).padStart(6, '0')}`;
