import * as THREE from 'three';
import type { EnemyRef, GameContext } from '@/shared';
import { COMPASS_ENEMY_COLOR, DETECT_ENEMY_BASE_RADIUS, TUTORIAL_COMPASS_FADE_S } from '@/shared';
/* 2026-09-15 (android squadmates): android ticks — the same way as the enemy ticks, in the slot colour */
import { ANDROID_BAY_COUNT, NET_SLOT_COLORS_CSS } from '@/shared';
import { allyBodies } from './allySource';
import { el, setText, toggleClass } from '../dom';
import type { ScanTracker } from './ScanTracker';

const STRIP_WIDTH = 440;
const PX_PER_RAD = STRIP_WIDTH / (Math.PI * 0.9); // ~160° visible
const CARDINALS: Array<[number, string, boolean]> = [
  [0, 'N', true], [45, 'NE', false], [90, 'E', true], [135, 'SE', false],
  [180, 'S', true], [225, 'SW', false], [270, 'W', true], [315, 'NW', false],
];

/** Pooled red enemy ticks (Phase 12 detection): plenty for the ambient cap inside one detect radius. */
const MAX_ENEMY_TICKS = 24;
/** Seconds between `queryNear` polls for the detect-radius ticks (≤ 10 Hz). */
const ENEMY_POLL_INTERVAL = 0.1;

interface CompassMarker {
  el: HTMLElement;
  dist: HTMLElement;
  pos: THREE.Vector3;
  lastX: number;
  lastDist: number;
}

interface EnemyTick { el: HTMLElement; lastKey: string }

/**
 * Top-center heading strip with extraction / ship markers.
 *
 * **2026-09-09 (raid play improvements):** structure · rail · giant mushroom grove markers are attached one at a
 * time by `fog:discovered` (`.marker.structure` / `.rail` / `.grove`). They do not exist before discovery, and
 * after it they pass the `isDiscovered` gate below automatically. Environmental hazards do not come here — they
 * are not landmarks but a phenomenon the ship observes, so their fog rule differs, and the safe-direction arrow is
 * drawn by `hud/HazardHud` inside its own block.
 *
 * **Phase 12 — detection stat:** every living enemy inside `ctx.progression.derived.enemyDetectRadius` (grows with `인지력`;
 * `DETECT_ENEMY_BASE_RADIUS` without progression) appears as a red tick (`COMPASS_ENEMY_COLOR`) at its bearing,
 * fading with distance. `ctx.enemies.queryNear` is polled at most every `ENEMY_POLL_INTERVAL` (10 Hz); the bearings
 * themselves are recomputed per frame from the cached refs, so the ticks slide smoothly. Enemies revealed by a recon
 * pulse (`scan:cast`, via the shared `ScanTracker`) get a tick for the reveal's duration **regardless of distance**
 * (their position follows the enemy object live). Ticks are pooled (`MAX_ENEMY_TICKS` DOM nodes, created once) and
 * only those whose bearing falls inside the visible ±80° arc are shown — the off-screen edge arrows of `hud/Detection`
 * cover the rest.
 *
 * **2026-09-14 (tutorial)**: this strip is the 「screen marker」 the contract names (`hides('hud','shipScreenMarker')`)
 * — a compass tick, and also the direction readout that pins to the edge (`clamped`) once the target is out of
 * view. The extraction ship tick is not drawn for the whole tutorial raid. (The off-screen arrow widget
 * `hud/OffscreenIndicators` **has no ship branch at all** — only pings.)
 *
 * **2026-09-14 (tutorial opening, user's decision)**: while the intro wake cutscene runs (`PlayerRef.introWaking`
 * — before the camera has come fully back to the back view) the whole strip is **invisible**, and once it ends the
 * strip appears gradually over `TUTORIAL_COMPASS_FADE_S`. The opacity is raised by this file every frame, not by a
 * CSS transition — when the OS turns animation effects off, the reduced-motion rule in `base.css` cuts every
 * transition to 0.01 ms (the same reason as `HudSystem`'s black fade). In a raid with no cutscene it is 1 from the
 * start, so not one glyph changes.
 */
export class Compass {
  readonly root: HTMLElement;
  private strip: HTMLElement;
  private markers = new Map<string, CompassMarker>();
  private activeId: string | null = null;
  private shipPos: THREE.Vector3 | null = null;
  private lastYaw = NaN;
  private tmp = new THREE.Vector3();
  private unsubs: Array<() => void> = [];
  private ticks: EnemyTick[] = [];
  /** 2026-09-15: android squadmate ticks (created up front, one per bay). */
  private allyTicks: EnemyTick[] = [];
  private shownAllyTicks = 0;
  private tickLayer: HTMLElement;
  private near: EnemyRef[] = [];
  private nearIds = new Set<number>();
  private nextPoll = 0;
  private shownTicks = 0;
  /** 2026-09-14: reveal amount after the intro wake, 0..1 (always 1 with no cutscene) · the last inline opacity written. */
  private reveal = 1;
  private lastRevealStr = '';

  constructor(parent: HTMLElement, private scans: ScanTracker | null = null) {
    this.root = el('div', { cls: 'compass', parent });
    this.strip = el('div', { cls: 'strip', parent: this.root });
    this.tickLayer = el('div', { cls: 'eticks', parent: this.root });
    for (let i = 0; i < MAX_ENEMY_TICKS; i++) {
      const t = el('div', { cls: 'etick', parent: this.tickLayer });
      t.style.background = COMPASS_ENEMY_COLOR;
      t.hidden = true;
      this.ticks.push({ el: t, lastKey: '' });
    }
    /* 2026-09-15 (android squadmates): a tick on the same layer but **a different shape** (`.atick` — a small
     * diamond in the slot colour). It must be told apart from an enemy tick at a glance, and no fog · detect-radius
     * gate is raised on it (it is my own squadmate). */
    for (let i = 0; i < ANDROID_BAY_COUNT; i++) {
      const t = el('div', { cls: 'atick', parent: this.tickLayer });
      t.hidden = true;
      this.allyTicks.push({ el: t, lastKey: '' });
    }
    // Build 3 copies (−360°, 0°, +360°) so the strip wraps seamlessly.
    for (let rep = -1; rep <= 1; rep++) {
      for (let deg = 0; deg < 360; deg += 15) {
        const x = THREE.MathUtils.degToRad(deg + rep * 360) * PX_PER_RAD;
        const major = deg % 45 === 0;
        const t = el('div', { cls: major ? 'tick major' : 'tick', parent: this.strip });
        t.style.left = `${x.toFixed(1)}px`;
      }
      for (const [deg, label, major] of CARDINALS) {
        const x = THREE.MathUtils.degToRad(deg + rep * 360) * PX_PER_RAD;
        const c = el('div', { cls: major ? 'card' : 'card minor', text: label, parent: this.strip });
        c.style.left = `${x.toFixed(1)}px`;
      }
    }
    el('div', { cls: 'center', parent: this.root });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('world:ready', () => this.rebuild(ctx)),
      b.on('extraction:activated', ({ pointId }) => { this.activeId = pointId; this.refreshActive(); }),
      b.on('extraction:shipIncoming', ({ position }) => this.setShip(position)),
      b.on('extraction:shipLanded', ({ position }) => this.setShip(position)),
      b.on('extraction:liftoff', () => this.removeShip()),
      // 2026-09-13: the ship left without us — no pad is active any more, any console can call the next one
      b.on('extraction:reset', () => { this.activeId = null; this.refreshActive(); this.removeShip(); }),
      // world:ready fires synchronously inside game:newMission (before our handler would) → rebuild there only.
      b.on('game:abort', () => this.clear()),
      b.on('hub:entered', () => this.clearEnemies()),
      /*
       * 2026-09-09 (raid play improvements): structures · rails · giant mushroom groves appear on the compass too.
       * Unlike the extraction pads they are not built up front at `world:ready` but attached one at a time **the
       * moment they are discovered** (`fog:discovered`) — their count differs per map, and they must exist only
       * after they have passed the fog gate. The `isDiscovered` gate in `update` below still applies (already
       * true), so it is safe twice over.
       */
      b.on('fog:discovered', ({ kind, id, position }) => {
        if (kind !== 'structure' && kind !== 'rail' && kind !== 'grove') return;
        if (this.markers.has(id)) return;
        this.addMarker(id, position.clone(), `marker ${kind}`);
      }),
    );
  }

  /** Enemy ticks currently visible on the strip (debug). */
  get enemyTickCount(): number { return this.shownTicks; }

  private rebuild(ctx: GameContext): void {
    this.clear();
    // Training arena (Phase 7): no extraction, so no markers even if a world reported pads.
    if (ctx.missionMode === 'training' || ctx.world?.mode === 'training') return;
    const pts = ctx.world?.getExtractionPoints() ?? [];
    for (const p of pts) this.addMarker(p.id, p.position, 'marker');
  }

  private setShip(position: THREE.Vector3): void {
    if (!this.shipPos) {
      this.shipPos = position.clone();
      this.addMarker('__ship', this.shipPos, 'marker ship');
    } else this.shipPos.copy(position);
  }
  private removeShip(): void {
    const m = this.markers.get('__ship');
    if (m) { m.el.remove(); this.markers.delete('__ship'); }
    this.shipPos = null;
  }

  private addMarker(id: string, pos: THREE.Vector3, cls: string): void {
    const m = el('div', { cls, parent: this.root });
    el('i', { cls: 'ico', parent: m });
    const dist = el('span', { cls: 'dist', text: '', parent: m });
    this.markers.set(id, { el: m, dist, pos, lastX: NaN, lastDist: -1 });
  }

  private refreshActive(): void {
    for (const [id, m] of this.markers) toggleClass(m.el, 'active', id === this.activeId);
  }

  private clear(): void {
    for (const m of this.markers.values()) m.el.remove();
    this.markers.clear();
    this.activeId = null;
    this.shipPos = null;
    this.clearEnemies();
  }

  private clearEnemies(): void {
    this.near.length = 0;
    this.nearIds.clear();
    this.nextPoll = 0;
    this.hideTicksFrom(0);
    this.shownTicks = 0;
    // 2026-09-15: the android ticks are cleared with them (entering the ship · aborting a raid)
    for (const t of this.allyTicks) if (!t.el.hidden) { t.el.hidden = true; t.lastKey = ''; }
    this.shownAllyTicks = 0;
  }

  private hideTicksFrom(index: number): void {
    for (let i = index; i < this.ticks.length; i++) {
      const t = this.ticks[i];
      if (!t.el.hidden) { t.el.hidden = true; t.lastKey = ''; }
    }
  }

  private enemyRadius(ctx: GameContext): number {
    const r = ctx.progression?.derived?.enemyDetectRadius;
    return typeof r === 'number' && r > 0 ? r : DETECT_ENEMY_BASE_RADIUS;
  }

  /** Re-poll the enemies inside the detect radius (≤ 10 Hz); the bearings are recomputed per frame from these refs. */
  private pollEnemies(ctx: GameContext, from: THREE.Vector3): void {
    if (ctx.time < this.nextPoll) return;
    this.nextPoll = ctx.time + ENEMY_POLL_INTERVAL;
    this.near.length = 0;
    this.nearIds.clear();
    const em = ctx.enemies;
    if (!em || typeof em.queryNear !== 'function') return;
    for (const e of em.queryNear(from, this.enemyRadius(ctx))) {
      if (e.isDead) continue;
      this.near.push(e);
      this.nearIds.add(e.id);
      if (this.near.length >= MAX_ENEMY_TICKS) break;
    }
  }

  /**
   * Place the pooled tick `index` at `pos`'s bearing. Returns the next free index: unchanged when the bearing falls
   * outside the visible arc (nothing drawn), −1 when the pool is exhausted.
   */
  private placeTick(index: number, pos: THREE.Vector3, from: THREE.Vector3, heading: number, half: number, radius: number, scanned: boolean): number {
    if (index >= this.ticks.length) return -1;
    this.tmp.subVectors(pos, from);
    const dist = Math.hypot(this.tmp.x, this.tmp.z);
    const bearing = Math.atan2(this.tmp.x, -this.tmp.z);
    let rel = bearing - heading;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const x = rel * PX_PER_RAD;
    if (Math.abs(x) > half) return index; // behind / outside the visible arc: the detection arrows cover it
    // detected: fade toward the edge of the radius; scanned: steady (distance is not what revealed it)
    const alpha = scanned ? 0.95 : Math.max(0.35, 1 - (dist / Math.max(1, radius)) * 0.65);
    const t = this.ticks[index];
    const key = `${x.toFixed(0)}|${alpha.toFixed(2)}|${scanned ? 1 : 0}`;
    if (t.el.hidden) t.el.hidden = false;
    if (key !== t.lastKey) {
      t.lastKey = key;
      t.el.style.transform = `translateX(calc(-50% + ${x.toFixed(1)}px))`;
      t.el.style.opacity = alpha.toFixed(2);
      toggleClass(t.el, 'scanned', scanned);
    }
    return index + 1;
  }

  private updateEnemies(ctx: GameContext, from: THREE.Vector3, heading: number, half: number): void {
    const gameplay = ctx.isGameplayPhase() && !(ctx.player?.isDead ?? true);
    if (!gameplay) { if (this.near.length || this.shownTicks) this.clearEnemies(); return; }
    this.pollEnemies(ctx, from);
    const radius = this.enemyRadius(ctx);
    let used = 0;
    // (1) inside the detect radius
    for (const e of this.near) {
      if (e.isDead) continue;
      const next = this.placeTick(used, e.position, from, heading, half, radius, false);
      if (next < 0) break;
      used = next;
    }
    // (2) recon reveals still running, wherever they are (an enemy already drawn from (1) is not drawn twice)
    const scanned = this.scans?.update(ctx);
    if (scanned && used >= 0) {
      for (const s of scanned) {
        if (this.nearIds.has(s.id)) continue;
        const next = this.placeTick(used, s.position, from, heading, half, radius, true);
        if (next < 0) break;
        used = next;
      }
    }
    this.hideTicksFrom(used);
    this.shownTicks = used;
  }

  /** Reveal amount after the intro wake, 0..1 (smoke). */
  get revealAmount(): number { return this.reveal; }

  /**
   * 2026-09-14: 0 while the intro wake runs, then up to 1 over `TUTORIAL_COMPASS_FADE_S`. true = invisible right
   * now (the rest of the update is skipped). `dt` is the simulation dt, so it stops during a pause · a shader hold.
   */
  private updateReveal(ctx: GameContext, dt: number): boolean {
    const waking = ctx.player?.introWaking ?? false;
    if (waking) this.reveal = 0;
    else if (this.reveal < 1) this.reveal = TUTORIAL_COMPASS_FADE_S > 0 ? Math.min(1, this.reveal + dt / TUTORIAL_COMPASS_FADE_S) : 1;
    const s = this.reveal >= 1 ? '' : this.reveal.toFixed(3);
    if (s !== this.lastRevealStr) { this.lastRevealStr = s; this.root.style.opacity = s; }
    return waking;
  }

  update(ctx: GameContext, dt = 0): void {
    if (this.updateReveal(ctx, dt)) return;
    const player = ctx.player;
    if (!player) return;
    const yaw = player.yaw;
    // Heading: yaw 0 = looking toward -Z (north). Strip scrolls opposite to heading.
    const heading = this.headingFromYaw(ctx);
    if (heading !== this.lastYaw) {
      this.lastYaw = heading;
      this.strip.style.transform = `translateX(${(-heading * PX_PER_RAD).toFixed(1)}px)`;
    }
    const half = STRIP_WIDTH / 2 - 14;
    // The discovery gate (2026-09-09): a pad whose fog has not lifted yet does not appear on the compass either.
    // The active pad (`activeId`) and the ship are exempt — the whole squad already knows them. In a world with no
    // fog (the training range) everything shows as it did before.
    const fog = ctx.world?.fog ?? null;
    /* 2026-09-14 (tutorial, user's decision): **no readout points at the extraction ship on screen for the whole
     * raid** — neither the compass tick nor the `clamped` arrow that pins to the edge. The map · world markers are
     * a separate name (`shipMarker`) and are released at the last step, but this one stays closed to the end.
     * Outside the tutorial it is always false. */
    const hideShip = ctx.tutorial?.hides('hud', 'shipScreenMarker') ?? false;
    for (const [id, m] of this.markers) {
      const gated = (id === '__ship' && hideShip)
        || (fog !== null && id !== '__ship' && id !== this.activeId && !fog.isDiscovered(m.pos));
      if (m.el.hidden !== gated) m.el.hidden = gated;
      if (gated) continue;
      this.tmp.subVectors(m.pos, player.position);
      const dist = Math.hypot(this.tmp.x, this.tmp.z);
      const bearing = Math.atan2(this.tmp.x, -this.tmp.z); // 0 = north
      let rel = bearing - heading;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      let x = rel * PX_PER_RAD;
      const clamped = Math.abs(x) > half;
      if (clamped) x = Math.sign(x) * half;
      if (Math.abs(x - m.lastX) > 0.3 || Number.isNaN(m.lastX)) {
        m.lastX = x;
        m.el.style.transform = `translateX(calc(-50% + ${x.toFixed(1)}px))`;
      }
      toggleClass(m.el, 'clamped', clamped);
      const d = Math.round(dist);
      if (d !== m.lastDist) { m.lastDist = d; setText(m.dist, `${d}m`); }
    }
    this.updateEnemies(ctx, player.position, heading, STRIP_WIDTH / 2 - 6);
    this.updateAllies(ctx, player.position, heading, STRIP_WIDTH / 2 - 6);
    void yaw;
  }

  /**
   * 2026-09-15 (android squadmates): bearing ticks for the androids visible in a raid. They do not dim with
   * distance (they are my own squadmates) and there is no fog gate — only a dead or hidden unit (drop pod · liftoff
   * ship) drops out. The colour is that unit's lobby slot colour.
   */
  private updateAllies(ctx: GameContext, from: THREE.Vector3, heading: number, half: number): void {
    const bodies = ctx.isGameplayPhase() ? allyBodies(ctx) : null;
    if (!bodies || bodies.length === 0) {
      if (this.shownAllyTicks) { for (const t of this.allyTicks) if (!t.el.hidden) { t.el.hidden = true; t.lastKey = ''; } this.shownAllyTicks = 0; }
      return;
    }
    let used = 0;
    for (const b of bodies) {
      if (used >= this.allyTicks.length) break;
      if (b.hidden || b.dead || b.mode !== 'raid') continue;
      this.tmp.subVectors(b.position, from);
      const bearing = Math.atan2(this.tmp.x, -this.tmp.z);
      let rel = bearing - heading;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      const x = rel * PX_PER_RAD;
      if (Math.abs(x) > half) continue;  // behind · out of view
      const t = this.allyTicks[used++];
      const col = NET_SLOT_COLORS_CSS[b.slot] ?? '#fff';
      const key = `${x.toFixed(0)}|${col}|${b.downed ? 1 : 0}`;
      if (t.el.hidden) t.el.hidden = false;
      if (key !== t.lastKey) {
        t.lastKey = key;
        t.el.style.transform = `translateX(calc(-50% + ${x.toFixed(1)}px)) rotate(45deg)`;
        t.el.style.background = col;
        toggleClass(t.el, 'downed', b.downed);
      }
    }
    for (let i = used; i < this.allyTicks.length; i++) {
      const t = this.allyTicks[i];
      if (!t.el.hidden) { t.el.hidden = true; t.lastKey = ''; }
    }
    this.shownAllyTicks = used;
  }

  /** 2026-09-15 (debug / smoke): number of android ticks currently visible. */
  get allyTickCount(): number { return this.shownAllyTicks; }

  /** Heading in radians where 0 = north (−Z), increasing clockwise (toward +X). */
  private headingFromYaw(ctx: GameContext): number {
    const f = ctx.player!.getForward(this.tmp);
    return Math.atan2(f.x, -f.z);
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
