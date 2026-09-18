import * as THREE from 'three';
import type { FireZoneInfo, GameContext, GrenadeView, StratagemId } from '@/shared';
import { DANGER_NEAR_RADIUS, DETECT_ENEMY_BASE_RADIUS, FIRE_ZONE_DANGER_RANGE, ROGUE_DROP_ALERT_RADIUS, shellLaunchVelocity, shellPositionAt } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { STRATAGEM_COLOR, STRATAGEM_GLYPH, stratagemDef } from './stratagemGlyphs';
import '../styles/danger.css';

/** Pooled indicators (heads and arcs alike) — two mortars, a squad's grenades and a couple of calls fit. */
const MAX = 10;
/** Candidate slots collected before the nearest `MAX` win. */
const MAX_CANDIDATES = 28;
/** Seconds to impact under which an indicator pulses fast. */
const HOT_S = 1.5;
/** Safety net past `flightTime` if neither landed nor intercepted arrives (mirrors `ShellProjectile`'s timeout). */
const TIMEOUT_PAD_S = 2.5;
/** |NDC| beyond this counts as off-screen (the projected point is at / past the viewport edge). */
const EDGE_NDC = 0.94;

type Cat = 'shell' | 'grenade' | 'call' | 'drop' | 'worm' | 'fire';

interface Shell {
  sid: number;
  from: THREE.Vector3;
  vel0: THREE.Vector3;
  /** Where the arc ends — the perception override is judged on this, not on where the shell is right now. */
  impact: THREE.Vector3;
  flight: number;
  life: number;
  active: boolean;
}
interface Call { id: string; kind: StratagemId; pos: THREE.Vector3; landsAt: number; landed: boolean }

/** One thing to draw this frame (pooled — the fields are overwritten, never re-allocated). */
interface Item {
  cat: Cat;
  pos: THREE.Vector3;
  color: string;
  icon: string;
  label: string;
  hot: boolean;
  d2: number;
}
interface Slot { el: HTMLElement; ico: HTMLElement; lbl: HTMLElement; lastKey: string }

const CAT_NAME: Record<Cat, string> = { shell: '포탄', grenade: '수류탄', call: '낙하물', drop: '레이더 강하', worm: '지상이변', fire: '화염 지대' };
const CAT_ICON: Record<Cat, string> = { shell: '◆', grenade: '●', call: '▣', drop: '⬇', worm: '◎', fire: '▲' };
/**
 * Fire zones (2026-09-15, B-16). Within this distance of the edge (negative while standing inside) it is `hot` — one
 * step and the fire has them. A presentation rule rather than a game number, so it did not move to csv (like `HOT_S`).
 */
const FIRE_HOT_EDGE_M = 1.5;
/**
 * Added to a fire zone's sort key. A zone **stays** where every other category **flies in**, so zones are pushed back
 * whenever slots run short — the fire at one's feet must not displace a grenade marker 3 m away. Zones queue among
 * themselves by edge distance; the candidate slots (`MAX_CANDIDATES`) collect zones **last** so they cannot fill first.
 */
const FIRE_RANK_BIAS = 1e12;
/**
 * Sandworm eruption telegraph (2026-09-13) — one `sandworm:warning {position, radius, eta}` is held until the eruption
 * time and cleared on `sandworm:erupted` (missed: eruption time + `WORM_TIMEOUT_S`). At most once per raid, so one slot.
 * No gate — the telegraph happens in the middle of the pack, so it is always close.
 */
const WORM_COLOR = '#ff4d4d';
const WORM_TIMEOUT_S = 1.5;
/** Hoisted so sorting the candidates allocates nothing (it runs only when more than `MAX` are live). */
const byNear = (a: Item, b: Item): number => a.d2 - b.d2;
/*
 * Colour says **whose it is**, the `hot` class (fast pulse + label) says **how imminent it is** (2026-09-10).
 * So an ally grenade never turns red however imminent, only a deeper amber — whether the thing at one's feet is one's
 * own or a rogue's decides dodging from picking it up, and two reds erase that. Enemy dangers are shell red.
 */
const SHELL_COLOR = '#ff4d4d';
const GRENADE_COLOR = '#ffb347';
const GRENADE_HOT_COLOR = '#ff8c1a';
const GRENADE_HOSTILE_COLOR = '#ff4d4d';
const GRENADE_HOSTILE_HOT_COLOR = '#ff2020';
/** Raider drop pods — the enemy's, so shell red. (2026-09-13: a drop no longer mixes in a leader, so the deeper red variant was removed.) */
const DROP_COLOR = '#ff4d4d';

/**
 * Danger indicators (`.dgr`, gameplay layer, 2026-09-10).
 *
 * For every "thing flying in right now" it draws **a head indicator on screen, a direction arc off screen** — the two
 * never appear together (one target uses exactly one element). The direction arc speaks the same language as the damage
 * arc (`hud/DamageOverlay`'s `.dmg-arc`): one wedge of the thick ring around the crosshair, its angle a
 * **screen-relative bearing** (0° = ahead, clockwise) saying only that it comes from over there.
 *
 * Three targets (confirmed by the user):
 *   - **Enemy artillery shells** — `enemy:shellFired {sid, from, target, flightTime}` is integrated into **the same
 *     parabola as the real shell** with `shellLaunchVelocity` / `shellPositionAt` from `@/shared/ballistics` (the formula
 *     is never copied — `enemies/fx/ShellProjectile` calls the same functions and the gravity `SHELL_ARC_GRAVITY` is csv).
 *     Cleared on `enemy:shellLanded` / `enemy:shellIntercepted`.
 *   - **Grenades** — both `ctx.weapons.getGrenades()` (allies — one's own + remote squadmates' replicas) and
 *     `ctx.enemies.getEnemyGrenades()` (enemies — thrown by rogues). The label is the fuse left, and **colour says whose
 *     it is** (ally amber · enemy red; `hot` marks imminence alone).
 *   - **Ship-call drops** — `stratagem:called` → `landed` / `ended`. Orbital barrage · supplies · tripod · rescue ship.
 *   - **Raider drop pods** (added 2026-09-10, 2026-09-13 rogue → raider) — `ctx.enemies.getRogueDrops()`. An enemy coming
 *     down out of the sky is "a thing falling right now" too, so it is drawn in the language of a ship-call drop. The
 *     colour is **the enemy's**, so red; the label is seconds to touchdown → `레이더 n` right after it lands (since
 *     2026-09-13 a drop carries no leader — `boss` only stayed because it is a contract field).
 *     The `.oarrow.drop` arrow `hud/OffscreenIndicators` drew on 2026-09-09 **moved here** — one target must not be drawn
 *     in two languages, and on screen there was no mark at all (one of the reasons drops were so quiet).
 *   - **Fire zones** (2026-09-15, B-16) — `ctx.enemies.getFireZones()` (enemy incendiaries, red) + `ctx.gadgets.getFireZones()`
 *     (the player's flame · incendiary grenades, amber). Only within `FIRE_ZONE_DANGER_RANGE` of the edge; the head marker is
 *     the zone centre + the seconds left, and being inside or within `FIRE_HOT_EDGE_M` of the edge is `hot`. A danger that
 *     **stays**, so when slots run short it always falls behind the ones flying in (`FIRE_RANK_BIAS`).
 *   Slot elements tag the category on `data-cat` (smokes pick with `.dgr-head[data-cat="fire"]`).
 *

 * **Perception radius gate (decision, 2026-09-10).** The `derived.enemyDetectRadius` gate on shells stays, but an impact
 * point inside `DANGER_NEAR_RADIUS` is shown **unconditionally** — the indicator exists to announce "the thing you do
 * not even know is coming", and if a shell dropping on one's head is hidden by too little perception that purpose
 * collapses. Grenades and drops have no gate: both are events the squad just made and are already in sight. **Only
 * raider drops ignore perception entirely and look at one dedicated radius, `ROGUE_DROP_ALERT_RADIUS`** (10× perception)
 * — a roar tearing through the air must be known however narrow the perception, and it is exactly the radius
 * `audio/AudioSystem`'s drop sound uses.
 *
 * **No fog-of-war gate** — the same 2026-09-09 reasoning as the head of `hud/OffscreenIndicators`. What is drawn here is
 * not a discovered object but an event happening right now.
 *
 * The DOM is fully pooled (`MAX` heads + `MAX` arcs) and written only when the rounded key changes. No per-frame
 * allocation (`THREE.Vector3` scratch reuse, the candidate `Item`s pooled too). Everything hides while a menu / the map
 * is open or while dead, and `game:abort` / `game:newMission` / `hub:entered` empty it. It owns no geometry or material.
 */
export class DangerIndicators {
  readonly root: HTMLElement;
  private arcsRoot: HTMLElement;
  private heads: Slot[] = [];
  private arcs: Slot[] = [];
  private shells: Shell[] = [];
  private calls: Call[] = [];
  private readonly worm = { pos: new THREE.Vector3(), eruptAt: 0, active: false };
  private pool: Item[] = [];
  private items: Item[] = [];
  private readonly p = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly camF = new THREE.Vector3();
  private shown = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'dgr', parent });
    // heads sit in screen space, arcs share one centred 0×0 anchor (like `.dmg-arcs`)
    for (let i = 0; i < MAX; i++) {
      const h = el('div', { cls: 'dgr-head', parent: this.root });
      h.hidden = true;
      el('i', { cls: 'ring', parent: h });
      const ico = el('span', { cls: 'ico', text: '', parent: h });
      const lbl = el('span', { cls: 'lbl ui-mono', text: '', parent: h });
      this.heads.push({ el: h, ico, lbl, lastKey: '' });
    }
    this.arcsRoot = el('div', { cls: 'dgr-arcs', parent: this.root });
    for (let i = 0; i < MAX; i++) {
      const a = el('div', { cls: 'dgr-arc', parent: this.arcsRoot });
      a.hidden = true;
      el('i', { cls: 'wedge', parent: a });
      const tag = el('div', { cls: 'tag', parent: a });
      const ico = el('span', { cls: 'ico', text: '', parent: tag });
      const lbl = el('span', { cls: 'lbl ui-mono', text: '', parent: tag });
      this.arcs.push({ el: a, ico, lbl, lastKey: '' });
    }
    for (let i = 0; i < MAX_CANDIDATES; i++) {
      this.pool.push({ cat: 'shell', pos: new THREE.Vector3(), color: SHELL_COLOR, icon: '', label: '', hot: false, d2: 0 });
    }
    for (let i = 0; i < MAX; i++) {
      this.shells.push({ sid: 0, from: new THREE.Vector3(), vel0: new THREE.Vector3(), impact: new THREE.Vector3(), flight: 0, life: 0, active: false });
    }
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('enemy:shellFired', ({ sid, from, target, flightTime }) => this.trackShell(sid, from, target, flightTime)),
      b.on('enemy:shellLanded', ({ sid }) => this.untrackShell(sid)),
      b.on('enemy:shellIntercepted', ({ sid }) => this.untrackShell(sid)),
      b.on('stratagem:called', ({ callId, kind, position, landsAt }) => {
        this.calls = this.calls.filter((c) => c.id !== callId);
        this.calls.push({ id: callId, kind, pos: position, landsAt, landed: false });
      }),
      b.on('stratagem:landed', ({ callId, kind }) => {
        // the laser keeps burning after it lands — everything else is over the moment it touches down
        if (kind === 'orbital_laser') { const c = this.calls.find((x) => x.id === callId); if (c) c.landed = true; }
        else this.calls = this.calls.filter((c) => c.id !== callId);
      }),
      b.on('stratagem:ended', ({ callId }) => { this.calls = this.calls.filter((c) => c.id !== callId); }),
      b.on('sandworm:warning', ({ position, eta }) => {
        this.worm.pos.copy(position);
        this.worm.eruptAt = ctx.time + Math.max(0, eta);
        this.worm.active = true;
      }),
      b.on('sandworm:erupted', () => { this.worm.active = false; }),
      b.on('game:abort', () => this.clear()),
      b.on('game:newMission', () => this.clear()),
      b.on('hub:entered', () => this.clear()),
    );
  }

  private trackShell(sid: number, from: THREE.Vector3, target: THREE.Vector3, flightTime: number): void {
    // re-fired id (host migration re-sends) → refresh in place; else a free slot; else the oldest
    let slot: Shell | null = null;
    for (const s of this.shells) if (s.active && s.sid === sid) { slot = s; break; }
    if (!slot) for (const s of this.shells) if (!s.active) { slot = s; break; }
    if (!slot) { slot = this.shells[0]; for (const s of this.shells) if (s.life > slot.life) slot = s; }
    const T = Math.max(0.5, flightTime);
    slot.sid = sid;
    slot.from.copy(from);
    slot.impact.copy(target);
    shellLaunchVelocity(from, target, T, slot.vel0);
    slot.flight = T;
    slot.life = 0;
    slot.active = true;
  }

  private untrackShell(sid: number): void {
    for (const s of this.shells) if (s.active && s.sid === sid) s.active = false;
  }

  private clear(): void {
    for (const s of this.shells) s.active = false;
    this.calls.length = 0;
    this.worm.active = false;
    this.hideAll();
  }

  private hideAll(): void {
    for (const h of this.heads) if (!h.el.hidden) { h.el.hidden = true; h.lastKey = ''; }
    for (const a of this.arcs) if (!a.el.hidden) { a.el.hidden = true; a.lastKey = ''; toggleClass(a.el, 'show', false); }
    this.shown = 0;
  }

  /** Perception radius (the default without progression) — the same radius as `hud/Detection`'s enemy arrows. */
  private detectRadius(ctx: GameContext): number {
    const r = ctx.progression?.derived?.enemyDetectRadius;
    return typeof r === 'number' && r > 0 ? r : DETECT_ENEMY_BASE_RADIUS;
  }

  /** Seconds label: one decimal under 10 s so a 2.4 s fuse reads, whole seconds above. */
  private etaLabel(eta: number, cat: Cat, name: string): string {
    if (eta <= 0.05) return name || CAT_NAME[cat];
    return eta < 10 ? `${eta.toFixed(1)}초` : `${Math.ceil(eta)}초`;
  }

  /**
   * Puts one batch of grenades on the list. Ally and enemy ones have the **same `GrenadeView` shape**, so one function
   * takes both. With `hostile` the colour becomes the enemy danger colour and the label is marked — whether the thing at
   * one's feet is one's own or a rogue's decides dodging from picking it up, so it must split at a glance.
   */
  private pushGrenades(list: readonly GrenadeView[] | undefined, from: THREE.Vector3, hostile: boolean): void {
    if (!list || list.length === 0) return;
    for (const g of list) {
      const hot = g.fuse < 1;
      const dx = g.position.x - from.x, dz = g.position.z - from.z;
      const color = hostile
        ? (hot ? GRENADE_HOSTILE_HOT_COLOR : GRENADE_HOSTILE_COLOR)
        : (hot ? GRENADE_HOT_COLOR : GRENADE_COLOR);
      this.push('grenade', g.position, color, CAT_ICON.grenade,
        this.etaLabel(g.fuse, 'grenade', hostile ? '적 수류탄' : ''), hot, dx * dx + dz * dz);
    }
  }

  /**
   * One batch of fire zones (2026-09-15, B-16). Enemy and player ones share the **same `FireZoneInfo` shape** and the colour
   * follows the grenade rule — `hostile` = enemy red, else ally amber, deeper when `hot`. The only gate is the **edge distance**
   * `FIRE_ZONE_DANGER_RANGE` (perception · fog of war are not read — it is burning now). Label = seconds left, marker = centre.
   */
  private pushFires(list: readonly FireZoneInfo[] | undefined, from: THREE.Vector3): void {
    if (!list || list.length === 0) return;
    for (const z of list) {
      if (!(z.remaining > 0)) continue;
      const dx = z.position.x - from.x, dz = z.position.z - from.z;
      const edge = Math.sqrt(dx * dx + dz * dz) - Math.max(0, z.radius);
      if (edge > FIRE_ZONE_DANGER_RANGE) continue;
      const hot = edge <= FIRE_HOT_EDGE_M;
      const color = z.hostile
        ? (hot ? GRENADE_HOSTILE_HOT_COLOR : GRENADE_HOSTILE_COLOR)
        : (hot ? GRENADE_HOT_COLOR : GRENADE_COLOR);
      const e = edge > 0 ? edge : 0;
      this.push('fire', z.position, color, CAT_ICON.fire, this.etaLabel(z.remaining, 'fire', ''), hot, FIRE_RANK_BIAS + e * e);
    }
  }

  private push(cat: Cat, pos: THREE.Vector3, color: string, icon: string, label: string, hot: boolean, d2: number): void {
    if (this.items.length >= MAX_CANDIDATES) return;
    const it = this.pool[this.items.length];
    it.cat = cat; it.pos.copy(pos); it.color = color; it.icon = icon; it.label = label; it.hot = hot; it.d2 = d2;
    this.items.push(it);
  }

  private collect(ctx: GameContext, from: THREE.Vector3): void {
    this.items.length = 0;
    const t = ctx.time;
    // (a) artillery shells — the perception gate with the "it is landing on me" override
    const detect = this.detectRadius(ctx);
    const detect2 = detect * detect;
    const near2 = DANGER_NEAR_RADIUS * DANGER_NEAR_RADIUS;
    for (const s of this.shells) {
      if (!s.active) continue;
      shellPositionAt(s.from, s.vel0, s.life, this.p);
      const dxi = s.impact.x - from.x, dzi = s.impact.z - from.z;
      const dx = this.p.x - from.x, dz = this.p.z - from.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > detect2 && dxi * dxi + dzi * dzi > near2) continue;
      const eta = s.flight - s.life;
      this.push('shell', this.p, SHELL_COLOR, CAT_ICON.shell, this.etaLabel(eta, 'shell', ''), eta < HOT_S, d2);
    }
    // (b) grenades — allies' (own + remote squadmates' replicas) and **enemies' (rogues')** alike. No gate: already at one's feet.
    this.pushGrenades(ctx.weapons?.getGrenades?.(), from, false);
    this.pushGrenades(ctx.enemies?.getEnemyGrenades?.(), from, true);
    // (c) raider drop pods (2026-09-10) — a live target from telegraph to touchdown, so the manager is asked
    //     directly instead of an event list (`getRogueDrops()` is an `EnemyManagerRef` contract, empty array without one).
    //     The gate is **not perception** but the drop's own radius `ROGUE_DROP_ALERT_RADIUS` — a roar tearing through
    //     the air must show however narrow the perception, yet not across the map (the sound uses the same radius).
    const drops = ctx.enemies?.getRogueDrops?.();
    if (drops && drops.length) {
      const alert2 = ROGUE_DROP_ALERT_RADIUS * ROGUE_DROP_ALERT_RADIUS;
      for (const d of drops) {
        const dx = d.position.x - from.x, dz = d.position.z - from.z;
        const dd2 = dx * dx + dz * dz;
        if (dd2 > alert2) continue;
        const eta = d.landsAt - t;
        const label = eta > 0.05 ? this.etaLabel(eta, 'drop', '') : `레이더 ${d.count}`;
        this.push('drop', d.position, DROP_COLOR, CAT_ICON.drop, label, eta > 0 && eta < HOT_S, dd2);
      }
    }
    // (c2) sandworm eruption telegraph (2026-09-13) — under the pack's feet, so no gate. A missed eruption event still times out.
    const w = this.worm;
    if (w.active) {
      const eta = w.eruptAt - t;
      if (eta < -WORM_TIMEOUT_S) w.active = false;
      else {
        const dx = w.pos.x - from.x, dz = w.pos.z - from.z;
        this.push('worm', w.pos, WORM_COLOR, CAT_ICON.worm, this.etaLabel(Math.max(0, eta), 'worm', ''), eta < HOT_S, dx * dx + dz * dz);
      }
    }
    // (d) ship-call drops — somebody in the squad called it, so no gate either
    for (const c of this.calls) {
      const eta = c.landed ? 0 : c.landsAt - t;
      const def = stratagemDef(c.kind);
      const dx = c.pos.x - from.x, dz = c.pos.z - from.z;
      this.push('call', c.pos, STRATAGEM_COLOR[c.kind] ?? '#ffb347', STRATAGEM_GLYPH[c.kind] ?? CAT_ICON.call,
        this.etaLabel(eta, 'call', def?.name ?? ''), !c.landed && eta > 0 && eta < HOT_S, dx * dx + dz * dz);
    }
    // (e) fire zones (2026-09-15, B-16) — enemy incendiary grenades (red) + the player's flame · incendiary grenades (amber).
    //     Collected **last** so a staying danger never eats a flying one's candidate slot (`FIRE_RANK_BIAS`). Both queries are
    //     optional — without them the category is simply empty.
    this.pushFires(ctx.enemies?.getFireZones?.(), from);
    this.pushFires(ctx.gadgets?.getFireZones?.(), from);
    if (this.items.length > MAX) {
      this.items.sort(byNear);   // nearest first
      this.items.length = MAX;
    }
  }

  /** Called from `HudSystem.lateUpdate` so the projection matches the camera of the frame being drawn. */
  lateUpdate(dt: number, ctx: GameContext): void {
    // advance every tracked shell even while hidden, so an indicator that reappears is where the shell is
    for (const s of this.shells) {
      if (!s.active) continue;
      s.life += dt;
      if (s.life > s.flight + TIMEOUT_PAD_S) s.active = false;
    }
    const player = ctx.player;
    const active = ctx.isGameplayPhase() && !!player && !player.isDead
      && !ctx.uiBlockers.has('menu') && !ctx.uiBlockers.has('map');
    if (!active) { if (this.shown) this.hideAll(); return; }
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    if (w <= 0 || h <= 0) return;

    this.collect(ctx, player!.position);
    const cam = ctx.camera;
    cam.getWorldDirection(this.camF);
    const camYaw = Math.atan2(this.camF.x, -this.camF.z);
    let heads = 0, arcs = 0;
    for (const it of this.items) {
      this.v.copy(it.pos).project(cam);
      const behind = this.v.z > 1 || this.v.z < -1;
      const off = behind || Math.abs(this.v.x) > EDGE_NDC || Math.abs(this.v.y) > EDGE_NDC;
      if (!off) {
        if (heads >= MAX) continue;
        const px = (this.v.x * 0.5 + 0.5) * w;
        const py = (-this.v.y * 0.5 + 0.5) * h;
        this.drawHead(this.heads[heads++], it, px, py);
        continue;
      }
      if (arcs >= MAX) continue;
      // Screen-relative bearing, exactly like the damage arc: 0° = ahead (top of the ring), clockwise.
      const toYaw = Math.atan2(it.pos.x - player!.position.x, -(it.pos.z - player!.position.z));
      const d = toYaw - camYaw;
      const rel = Math.atan2(Math.sin(d), Math.cos(d));
      this.drawArc(this.arcs[arcs++], it, (rel * 180) / Math.PI);
    }
    for (let i = heads; i < MAX; i++) { const s = this.heads[i]; if (!s.el.hidden) { s.el.hidden = true; s.lastKey = ''; } }
    for (let i = arcs; i < MAX; i++) { const s = this.arcs[i]; if (!s.el.hidden) { s.el.hidden = true; s.lastKey = ''; toggleClass(s.el, 'show', false); } }
    this.shown = heads + arcs;
  }

  private drawHead(s: Slot, it: Item, x: number, y: number): void {
    const key = `${it.cat}|${Math.round(x)}|${Math.round(y)}|${it.label}|${it.hot ? 1 : 0}|${it.color}`;
    if (s.el.hidden) s.el.hidden = false;
    if (key === s.lastKey) return;
    s.lastKey = key;
    if (s.el.dataset.cat !== it.cat) s.el.dataset.cat = it.cat;   // 2026-09-15: the key smokes · styles pick a category by
    s.el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
    s.el.style.setProperty('--dc', it.color);
    s.el.classList.toggle('hot', it.hot);
    setText(s.ico, it.icon);
    setText(s.lbl, it.label);
  }

  private drawArc(s: Slot, it: Item, deg: number): void {
    const key = `${it.cat}|${Math.round(deg)}|${it.label}|${it.hot ? 1 : 0}|${it.color}`;
    if (s.el.hidden) { s.el.hidden = false; toggleClass(s.el, 'show', true); }
    if (key === s.lastKey) return;
    s.lastKey = key;
    if (s.el.dataset.cat !== it.cat) s.el.dataset.cat = it.cat;
    s.el.style.setProperty('--rot', `${deg.toFixed(0)}deg`);
    s.el.style.setProperty('--dc', it.color);
    s.el.classList.toggle('hot', it.hot);
    setText(s.ico, it.icon);
    setText(s.lbl, it.label);
  }

  /** Head indicators + direction arcs currently visible (debug / smoke). */
  get visibleCount(): number { return this.shown; }
  /** Dangers being tracked — shells in flight + live ship calls (debug / smoke). */
  get trackedCount(): number { let n = 0; for (const s of this.shells) if (s.active) n++; return n + this.calls.length; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
  }
}
