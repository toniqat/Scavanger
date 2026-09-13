import * as THREE from 'three';
import type { EnemyRef, GameContext } from '@/shared';
import { COMPASS_ENEMY_COLOR, DETECT_ENEMY_BASE_RADIUS } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import type { ScanTracker } from './ScanTracker';

const STRIP_WIDTH = 440;
const PX_PER_RAD = STRIP_WIDTH / (Math.PI * 0.9); // ~160° visible
const CARDINALS: Array<[number, string, boolean]> = [
  [0, 'N', true], [45, 'NE', false], [90, 'E', true], [135, 'SE', false],
  [180, 'S', true], [225, 'SW', false], [270, 'W', true], [315, 'NW', false],
];

/** Pooled red enemy ticks (Phase 12 감지): plenty for the ambient cap inside one detect radius. */
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
 * **2026-09-09 (레이드 플레이 개선):** 구조물 · 선로 · 거대 버섯 군락 마커가 `fog:discovered` 로 하나씩 붙는다
 * (`.marker.structure` / `.rail` / `.grove`). 발견 전에는 존재하지 않고, 발견 뒤에는 아래의 `isDiscovered`
 * 게이트를 자동으로 통과한다. 환경 재해는 여기 오지 않는다 — 랜드마크가 아니라 함선이 관측하는 현상이라
 * 안개 규칙이 다르고, 안전 방향 화살표는 `hud/HazardHud` 가 자기 블록 안에서 그린다.
 *
 * **Phase 12 — 감지 스탯:** every living enemy inside `ctx.progression.derived.enemyDetectRadius` (grows with 인지력;
 * `DETECT_ENEMY_BASE_RADIUS` without progression) appears as a red tick (`COMPASS_ENEMY_COLOR`) at its bearing,
 * fading with distance. `ctx.enemies.queryNear` is polled at most every `ENEMY_POLL_INTERVAL` (10 Hz); the bearings
 * themselves are recomputed per frame from the cached refs, so the ticks slide smoothly. Enemies revealed by a 정찰
 * pulse (`scan:cast`, via the shared `ScanTracker`) get a tick for the reveal's duration **regardless of distance**
 * (their position follows the enemy object live). Ticks are pooled (`MAX_ENEMY_TICKS` DOM nodes, created once) and
 * only those whose bearing falls inside the visible ±80° arc are shown — the off-screen edge arrows of `hud/Detection`
 * cover the rest.
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
  private tickLayer: HTMLElement;
  private near: EnemyRef[] = [];
  private nearIds = new Set<number>();
  private nextPoll = 0;
  private shownTicks = 0;

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
       * 2026-09-09 (레이드 플레이 개선): 구조물 · 선로 · 거대 버섯 군락도 나침반에 뜬다. 탈출 신호소와 달리
       * `world:ready` 에 미리 만들지 않고 **발견하는 순간** (`fog:discovered`) 하나씩 붙인다 — 개수가 맵마다
       * 다르고, 안개 게이트를 통과한 뒤에만 존재해야 하기 때문이다. 아래 `update` 의 `isDiscovered` 게이트는
       * 그대로 걸리므로 (이미 참) 이중으로 안전하다.
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
    // (2) 정찰 reveals still running, wherever they are (an enemy already drawn from (1) is not drawn twice)
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

  update(ctx: GameContext): void {
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
    // 발견 게이트 (2026-09-09): 안개가 아직 안 걷힌 신호소는 나침반에도 뜨지 않는다. 활성 신호소(`activeId`)와
    // 함선은 분대 전원이 이미 아는 사실이라 예외. 안개가 없는 세계(훈련장)에서는 전부 예전처럼 보인다.
    const fog = ctx.world?.fog ?? null;
    for (const [id, m] of this.markers) {
      const gated = fog !== null && id !== '__ship' && id !== this.activeId && !fog.isDiscovered(m.pos);
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
    void yaw;
  }

  /** Heading in radians where 0 = north (−Z), increasing clockwise (toward +X). */
  private headingFromYaw(ctx: GameContext): number {
    const f = ctx.player!.getForward(this.tmp);
    return Math.atan2(f.x, -f.z);
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
