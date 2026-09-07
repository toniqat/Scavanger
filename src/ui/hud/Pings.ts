import * as THREE from 'three';
import type { GameContext, EnemyRef, PeerId, PingKind as SharedPingKind, PingMessage, WeaponSlot } from '@/shared';
import {
  MouseButtons, PING_LIFETIME, PING_DRAG_THRESHOLD_PX, PING_HOLD_MAX,
  NET_SLOT_COLORS, NET_SLOT_COLORS_CSS,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';

/** Re-exported from the shared contract (`ground|enemy|crate|extraction|item|attack|caution`). */
export type PingKind = SharedPingKind;

export const PING_LABEL: Record<PingKind, string> = {
  ground: '핑', enemy: '적', crate: '보급', extraction: '탈출', item: '아이템', attack: '돌격', caution: '주의',
};
export const PING_COLOR: Record<PingKind, number> = {
  ground: 0x7fb7e6, enemy: 0xff4d4d, crate: 0x4fd17e, extraction: 0xffb347, item: 0xc77dff, attack: 0xff6a3d, caution: 0xffc23a,
};
const ENEMY_LOST_LABEL = '적 (마지막 위치)';

const MAX_PINGS = 3;          // local pings; remote peers get one live ping each
const COOLDOWN = 0.3;
const RAY_MAX = 300;
const FALLBACK_DIST = 120;
const CRATE_SNAP = 2.5;
const ITEM_SNAP = 2;
const PAD_SNAP = 8;
const BEACON_HEIGHT = 6;
const REMOTE_ENEMY_SNAP = 2.5; // remote 'enemy' pings without a matching id latch onto the nearest enemy within this radius
const HINT_DELAY = 0.15;       // seconds of holding before the gesture hint fades in
const VIS_CHECK_INTERVAL = 0.1;// seconds between enemy visibility checks per ping
const ENEMY_DEAD_LINGER = 1.5; // seconds an enemy ping stays after its enemy died

/** Owner info for pings placed by squad members (null/undefined for local pings). */
export interface PingOwner { id: PeerId; name: string; slot: number; color: string }

/** Read-only view of a live ping (map / other HUD parts). */
export interface PingView {
  id: number; kind: PingKind; position: THREE.Vector3; expires: number; owner: PingOwner | null;
  /** Display label (item name, `적 (마지막 위치)`, …). */
  label: string;
  /** Enemy pings: true while the enemy is out of sight (marker parked at the last seen position). */
  lost: boolean;
}

interface Ping extends PingView {
  enemy: EnemyRef | null;
  nextVisCheck: number;
  // DOM
  el: HTMLElement;
  lbl: HTMLElement;
  dist: HTMLElement;
  lastKey: string;
  // 3D
  group: THREE.Group;
  ring: THREE.Mesh;
  lineMat: THREE.MeshBasicMaterial;
  ringMat: THREE.MeshBasicMaterial;
}

type Gesture = 'plain' | 'attack' | 'caution' | 'ammo';

/**
 * Middle-mouse pings (v2).
 *
 * Gesture: press = start hold; drag while held (pointer-locked deltas accumulate). Release:
 *   dx ≥ +PING_DRAG_THRESHOLD_PX → `attack` (돌격), dx ≤ −threshold → `caution` (주의),
 *   dy ≥ threshold (drag down) → ammo request quick chat (no world ping), otherwise a plain ping.
 *   Holding longer than PING_HOLD_MAX locks the gesture to a plain ping. A radial hint appears after 150 ms.
 * Targets: enemy hit → `enemy` (follows the enemy only while it is visible — frustum + `world.raycast`
 *   occlusion — else parks at the last seen position, dimmed, `적 (마지막 위치)`), pickup ≤ 2 m → `item`,
 *   crate ≤ 2.5 m → `crate`, pad ≤ 8 m → `extraction`, else `ground`.
 * Each ping = projected DOM marker + scene beacon. Max 3 local pings, expire after PING_LIFETIME.
 * Emits `ping:placed` + `ping:placedV2 {owner}` / `ping:removed` (local **and** remote). Item/crate/attack/caution pings also post a chat line.
 * Multiplayer: local pings go out as `PingMessage {p, kind, label, enemyId}`; incoming pings are read through
 * `ctx.net.onMessage('ping')` (falls back to `net:remotePing` when no net module exists).
 * Phase 10: `placeAtWorld(position, kind?)` (and the `ping:requestAt` event) ping a world point directly for surfaces
 * with no aim ray — the tactical map's middle-click. It skips the pointer-lock / gameplay-active gate (the map holds a
 * blocker) but keeps `MAX_PINGS`, the cooldown and the crate / pad / pickup snapping.
 */
export class Pings {
  readonly root: HTMLElement;
  private hint: HTMLElement;
  private ctx!: GameContext;
  private pings: Ping[] = [];
  private nextId = 1;
  private lastPingTime = -Infinity;
  private lineGeo: THREE.BufferGeometry | null = null;
  private ringGeo: THREE.BufferGeometry | null = null;
  private unsubs: Array<() => void> = [];

  // gesture state
  private holding = false;
  private holdStart = 0;
  private dragX = 0;
  private dragY = 0;
  private hintShown = false;
  private hintDir: Gesture = 'plain';
  private pressOrigin = new THREE.Vector3();
  private pressDir = new THREE.Vector3();

  // active weapon (for the ammo request)
  private activeWeaponName: string | null = null;
  private activeWeaponSlot: WeaponSlot | null = null;

  // scratch
  private origin = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'ping-markers', parent });
    this.hint = el('div', { cls: 'ping-hint', parent });
    el('span', { cls: 'l', text: '◄ 주의', parent: this.hint });
    el('span', { cls: 'sep', text: '·', parent: this.hint });
    el('span', { cls: 'r', text: '돌격 ►', parent: this.hint });
    el('span', { cls: 'sep', text: '·', parent: this.hint });
    el('span', { cls: 'd', text: '▼ 탄약', parent: this.hint });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.unsubs.push(
      ctx.bus.on('game:abort', () => { this.clear(true); this.cancelHold(); }),
      ctx.bus.on('game:newMission', () => { this.clear(true); this.cancelHold(); }),
      ctx.bus.on('player:died', () => { this.clearLocal(); this.cancelHold(); }),
      ctx.bus.on('net:remotePlayerRemoved', ({ id }) => this.removeOwnedBy(id)),
      ctx.bus.on('weapon:equipped', ({ slot, name }) => { this.activeWeaponSlot = slot; this.activeWeaponName = name; }),
      // Phase 10: a surface with no aim ray (the tactical map's middle-click) asks for a ping at a world point.
      ctx.bus.on('ping:requestAt', ({ position, kind }) => this.placeAtWorld(position, kind)),
      ctx.bus.on('loadout:changed', ({ primary, secondary, primary2 }) => {
        if (this.activeWeaponSlot === 'primary2' && !primary2) { this.activeWeaponSlot = null; this.activeWeaponName = null; }
        if (this.activeWeaponSlot === 'primary' && !primary) { this.activeWeaponSlot = null; this.activeWeaponName = null; }
        if (this.activeWeaponSlot === 'secondary' && !secondary) { this.activeWeaponSlot = null; this.activeWeaponName = null; }
      }),
    );
    // Full PingMessage (label / enemyId) through the net module; the bus event only carries position + kind.
    if (ctx.net) {
      this.unsubs.push(ctx.net.onMessage('ping', (msg, from) => this.onPingMessage(msg, from)));
    } else {
      this.unsubs.push(ctx.bus.on('net:remotePing', ({ id, position, kind }) => this.placeRemote(id, position, kind, undefined, undefined)));
    }
  }

  /** Live pings (read-only view) for other HUD parts (map). */
  getPings(): readonly PingView[] { return this.pings; }

  update(dt: number, ctx: GameContext): void {
    void dt;
    this.updateGesture(ctx);

    // expiry + follow + pulse
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      if (ctx.time >= p.expires) { this.remove(i, true); continue; }
      if (p.enemy) this.trackEnemy(p, ctx);
      const life = p.expires - ctx.time;
      const fade = life < 2 ? Math.max(0, life / 2) : 1;
      const pulse = 0.5 + 0.5 * Math.sin(ctx.time * 4.2 + p.id);
      const lostMul = p.lost ? 0.45 : 1;
      p.group.position.copy(p.position);
      p.ring.scale.setScalar(1 + 0.35 * pulse);
      p.ringMat.opacity = (0.35 + 0.5 * (1 - pulse)) * fade * lostMul;
      p.lineMat.opacity = (0.55 + 0.3 * pulse) * fade * lostMul;
    }
  }

  lateUpdate(ctx: GameContext): void {
    const cam = ctx.camera;
    const player = ctx.player;
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    for (const p of this.pings) {
      this.v.copy(p.position); this.v.y += p.kind === 'enemy' ? 1.6 : p.kind === 'item' ? 0.9 : 1.4;
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
      if (p.lost) alpha *= 0.6;
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

  /* ── gesture ───────────────────────────────────────────────────────────── */

  private updateGesture(ctx: GameContext): void {
    const input = ctx.input;
    const canPing = ctx.isGameplayActive() && input.isPointerLocked && !(ctx.player?.isDead ?? false);

    if (!this.holding) {
      if (!(canPing && input.wasMousePressed(MouseButtons.PING) && ctx.time - this.lastPingTime >= COOLDOWN)) return;
      this.holding = true;
      this.holdStart = ctx.time;
      this.dragX = 0; this.dragY = 0;
      this.hintDir = 'plain';
      ctx.camera.getWorldPosition(this.pressOrigin);
      ctx.camera.getWorldDirection(this.pressDir);
      // fall through: a press and release inside the same frame (quick click at low fps) must still ping
    }

    // holding
    if (!canPing) { this.cancelHold(); return; }
    const held = ctx.time - this.holdStart;
    const locked = held > PING_HOLD_MAX; // gesture timed out → plain ping on release
    if (!locked) { this.dragX += input.mouseDX; this.dragY += input.mouseDY; }

    const gesture = locked ? 'plain' : this.classify();
    if (gesture !== this.hintDir) {
      this.hintDir = gesture;
      toggleClass(this.hint, 'caution', gesture === 'caution');
      toggleClass(this.hint, 'attack', gesture === 'attack');
      toggleClass(this.hint, 'ammo', gesture === 'ammo');
    }
    const showHint = held >= HINT_DELAY && !locked;
    if (showHint !== this.hintShown) { this.hintShown = showHint; toggleClass(this.hint, 'show', showHint); }

    if (input.wasMouseReleased(MouseButtons.PING)) {
      this.endHold();
      this.lastPingTime = ctx.time;
      switch (gesture) {
        case 'attack': this.place(ctx, 'attack', this.pressOrigin, this.pressDir); break;
        case 'caution': this.place(ctx, 'caution', this.pressOrigin, this.pressDir); break;
        case 'ammo': this.requestAmmo(ctx); break;
        default: {
          ctx.camera.getWorldPosition(this.origin);
          ctx.camera.getWorldDirection(this.dir);
          this.place(ctx, null, this.origin, this.dir);
        }
      }
    } else if (!input.isMouseDown(MouseButtons.PING)) {
      // button state was reset (window blur) without a release event
      this.cancelHold();
    }
  }

  private classify(): Gesture {
    const T = PING_DRAG_THRESHOLD_PX;
    const ax = Math.abs(this.dragX);
    if (this.dragY >= T && this.dragY > ax) return 'ammo';
    if (ax >= T) return this.dragX > 0 ? 'attack' : 'caution';
    return 'plain';
  }

  private endHold(): void {
    this.holding = false;
    if (this.hintShown) { this.hintShown = false; toggleClass(this.hint, 'show', false); }
  }

  private cancelHold(): void { if (this.holding) this.endHold(); }

  private requestAmmo(ctx: GameContext): void {
    let name = this.activeWeaponName;
    // Resolve through the loadout when possible (weapon def name is the canonical one).
    const loadout = ctx.inventory?.getLoadout();
    const inst = this.activeWeaponSlot && loadout ? loadout[this.activeWeaponSlot] : null;
    if (inst && ctx.loot) {
      const def = ctx.loot.getItemDef(inst.defId);
      const wd = def?.weaponId ? ctx.loot.getWeaponDef(def.weaponId) : undefined;
      name = wd?.name ?? def?.name ?? name;
    }
    ctx.bus.emit('chat:post', { text: name ? `탄약 요청: ${name}` : '탄약 요청', kind: 'request' });
  }

  /* ── enemy tracking (visible only) ─────────────────────────────────────── */

  private trackEnemy(p: Ping, ctx: GameContext): void {
    const e = p.enemy!;
    if (e.isDead) {
      p.enemy = null;
      if (p.expires - ctx.time > ENEMY_DEAD_LINGER) p.expires = ctx.time + ENEMY_DEAD_LINGER;
      return;
    }
    if (ctx.time < p.nextVisCheck) { if (!p.lost) p.position.copy(e.position); return; }
    p.nextVisCheck = ctx.time + VIS_CHECK_INTERVAL;
    const visible = this.isEnemyVisible(ctx, e);
    if (visible) p.position.copy(e.position);
    if (visible === p.lost) {
      p.lost = !visible;
      toggleClass(p.el, 'lost', p.lost);
      const base = p.lost ? ENEMY_LOST_LABEL : PING_LABEL.enemy;
      p.label = base;
      setText(p.lbl, p.owner ? `${p.owner.name} · ${base}` : base);
    }
  }

  /** Enemy inside the camera frustum and not occluded by terrain / obstacles. */
  private isEnemyVisible(ctx: GameContext, e: EnemyRef): boolean {
    const cam = ctx.camera;
    this.v.copy(e.position); this.v.y += e.height * 0.6;
    this.v2.copy(this.v).project(cam);
    if (this.v2.z < -1 || this.v2.z > 1 || Math.abs(this.v2.x) > 1 || Math.abs(this.v2.y) > 1) return false;
    cam.getWorldPosition(this.origin);
    this.dir.subVectors(this.v, this.origin);
    const dist = this.dir.length();
    if (dist < 0.05) return true;
    this.dir.divideScalar(dist);
    const hit = ctx.world?.raycast(this.origin, this.dir, Math.max(0, dist - e.radius)) ?? null;
    return hit === null;
  }

  /* ── placement ─────────────────────────────────────────────────────────── */

  /** `forced` = attack / caution (directional gesture); null → classify by what the ray hit. */
  private place(ctx: GameContext, forced: 'attack' | 'caution' | null, origin: THREE.Vector3, dir: THREE.Vector3): void {
    const world = ctx.world;
    if (!world?.ready) return;

    const eh = ctx.enemies?.raycast(origin, dir, RAY_MAX) ?? null;
    const wh = world.raycast(origin, dir, RAY_MAX);

    let kind: PingKind = 'ground';
    let enemy: EnemyRef | null = null;
    let label = '';
    const pos = new THREE.Vector3();

    if (eh && (!wh || eh.distance <= wh.distance)) {
      pos.copy(eh.enemy.position);
      if (!forced) { kind = 'enemy'; enemy = eh.enemy; }
    } else if (wh) {
      pos.copy(wh.point);
    } else {
      pos.copy(origin).addScaledVector(dir, FALLBACK_DIST);
      const half = world.size / 2 - 1;
      pos.x = THREE.MathUtils.clamp(pos.x, -half, half);
      pos.z = THREE.MathUtils.clamp(pos.z, -half, half);
      pos.y = world.getHeightAt(pos.x, pos.z);
    }

    if (forced) {
      kind = forced;
    } else if (kind !== 'enemy') {
      const snapped = this.snap(ctx, pos);
      kind = snapped.kind; label = snapped.label;
    }

    this.placeResolved(ctx, pos, kind, label, enemy);
  }

  /**
   * Ping a world point from a surface that has no aim ray — the tactical map's middle-click (`ping:requestAt`).
   * The pointer-lock / `isGameplayActive()` gate of the gesture path is deliberately **skipped** (the map holds a UI
   * blocker by definition), but `MAX_PINGS` and the cooldown still apply, and a `ground` request reuses the same
   * pickup / crate / pad snapping, so a map ping dropped on a crate still reads `보급 상자 (n등급)`.
   */
  placeAtWorld(position: THREE.Vector3, kind: PingKind = 'ground'): void {
    const ctx = this.ctx;
    const world = ctx?.world;
    if (!ctx || !world?.ready) return;
    if (ctx.time - this.lastPingTime < COOLDOWN) return;
    this.lastPingTime = ctx.time;

    const pos = position.clone();
    const half = world.size / 2 - 1;
    pos.x = THREE.MathUtils.clamp(pos.x, -half, half);
    pos.z = THREE.MathUtils.clamp(pos.z, -half, half);
    pos.y = world.getHeightAt(pos.x, pos.z);

    let k = kind;
    let label = '';
    if (k === 'ground') { const snapped = this.snap(ctx, pos); k = snapped.kind; label = snapped.label; }
    this.placeResolved(ctx, pos, k, label, null);
  }

  /** Snap a resolved point onto a dropped item / crate / extraction pad; mutates `pos` and returns kind + label. */
  private snap(ctx: GameContext, pos: THREE.Vector3): { kind: PingKind; label: string } {
    const world = ctx.world;
    let kind: PingKind = 'ground';
    let label = '';
    const pickup = ctx.pickups?.findNear(pos, ITEM_SNAP) ?? null;
    if (pickup) {
      kind = 'item';
      pos.copy(pickup.position);
      const name = ctx.loot?.getItemDef(pickup.item.defId)?.name ?? pickup.item.defId;
      label = pickup.item.qty > 1 ? `${name} ×${pickup.item.qty}` : name;
      return { kind, label };
    }
    if (!world?.ready) return { kind, label };
    let bestD = CRATE_SNAP;
    for (const c of world.getCrates()) {
      const d = Math.hypot(c.position.x - pos.x, c.position.z - pos.z);
      if (d < bestD) { bestD = d; kind = 'crate'; pos.copy(c.position); label = `보급 상자 (${c.tier}등급)`; }
    }
    if (kind !== 'crate') {
      let padD = PAD_SNAP;
      for (const e of world.getExtractionPoints()) {
        const d = Math.hypot(e.position.x - pos.x, e.position.z - pos.z);
        if (d < padD) { padD = d; kind = 'extraction'; pos.copy(e.position); }
      }
    }
    return { kind, label };
  }

  /** Shared tail of every local ping: eviction → build → `ping:placed(V2)` → chat callout → relay. */
  private placeResolved(ctx: GameContext, pos: THREE.Vector3, kind: PingKind, label: string, enemy: EnemyRef | null): void {
    const text = label || PING_LABEL[kind];

    while (this.localCount() >= MAX_PINGS) {
      const idx = this.pings.findIndex((p) => !p.owner);
      if (idx < 0) break;
      this.remove(idx, true);
    }

    const id = this.nextId++;
    const expires = ctx.time + PING_LIFETIME;
    const ping = this.build(id, kind, pos, expires, enemy, null, text);
    this.pings.push(ping);
    ctx.bus.emit('ping:placed', { id, position: ping.position, kind, expires });
    ctx.bus.emit('ping:placedV2', { id, position: ping.position, kind, expires, owner: null });

    // chat line for callouts
    const player = ctx.player;
    const dist = player ? Math.round(Math.hypot(pos.x - player.position.x, pos.z - player.position.z)) : 0;
    if (kind === 'item' || kind === 'crate') ctx.bus.emit('chat:post', { text: `아이템 발견: ${text} (${dist}m)`, kind: 'ping' });
    else if (kind === 'attack') ctx.bus.emit('chat:post', { text: '돌격!', kind: 'ping' });
    else if (kind === 'caution') ctx.bus.emit('chat:post', { text: '주의!', kind: 'ping' });

    // squad: share it
    if (ctx.net && (ctx.isMultiplayer || ctx.net.lobby)) {
      const msg: PingMessage = { t: 'ping', p: [pos.x, pos.y, pos.z], kind };
      if (kind === 'item' || kind === 'crate') msg.label = text;
      if (enemy) msg.enemyId = enemy.id;
      ctx.net.send(msg, 'others');
    }
  }

  private onPingMessage(msg: PingMessage, from: PeerId): void {
    const p = msg.p;
    if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    const kind: PingKind = typeof msg.kind === 'string' && msg.kind in PING_LABEL ? msg.kind : 'ground';
    const label = typeof msg.label === 'string' ? msg.label.slice(0, 40) : undefined;
    const enemyId = typeof msg.enemyId === 'number' ? msg.enemyId : undefined;
    this.placeRemote(from, this.v.set(p[0], p[1], p[2]), kind, label, enemyId);
  }

  /** A squad member pinged. One live ping per sender; drawn in their slot colour. */
  private placeRemote(peerId: PeerId, position: THREE.Vector3, kind: PingKind, label: string | undefined, enemyId: number | undefined): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!net) return;
    if (!ctx.isGameplayPhase()) return; // no world → nothing to attach to (hub, menus)
    const lp = net.getLobbyPlayer(peerId);
    const ref = net.getRemotePlayer(peerId);
    const slot = lp?.slot ?? ref?.slot ?? 0;
    const owner: PingOwner = { id: peerId, name: lp?.name ?? ref?.name ?? '분대원', slot, color: NET_SLOT_COLORS_CSS[slot] ?? '#ffffff' };

    this.removeOwnedBy(peerId);

    const pos = position.clone();
    let enemy: EnemyRef | null = null;
    if (kind === 'enemy' && ctx.enemies) {
      const list = ctx.enemies.getEnemies();
      if (enemyId !== undefined) {
        for (const e of list) if (e.id === enemyId && !e.isDead) { enemy = e; break; }
      }
      if (!enemy) {
        let best = REMOTE_ENEMY_SNAP;
        for (const e of list) {
          if (e.isDead) continue;
          const d = e.position.distanceTo(pos);
          if (d < best) { best = d; enemy = e; }
        }
      }
      if (enemy) pos.copy(enemy.position);
    }

    const id = this.nextId++;
    const expires = ctx.time + PING_LIFETIME;
    const ping = this.build(id, kind, pos, expires, enemy, owner, label && label.length ? label : PING_LABEL[kind]);
    this.pings.push(ping);
    ctx.bus.emit('ping:placed', { id, position: ping.position, kind, expires });
    ctx.bus.emit('ping:placedV2', { id, position: ping.position, kind, expires, owner: owner.id });
  }

  private build(id: number, kind: PingKind, pos: THREE.Vector3, expires: number, enemy: EnemyRef | null, owner: PingOwner | null, label: string): Ping {
    const m = el('div', { cls: `pmarker ${kind}${owner ? ' remote' : ''}`, parent: this.root });
    if (owner) m.style.setProperty('--pc', owner.color);
    el('i', { cls: 'ico', parent: m });
    const lbl = el('span', { cls: 'lbl', text: owner ? `${owner.name} · ${label}` : label, parent: m });
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
    const color = owner ? (NET_SLOT_COLORS[owner.slot] ?? 0xffffff) : PING_COLOR[kind];
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

    return { id, kind, position: pos, expires, owner, label, lost: false, enemy, nextVisCheck: 0, el: m, lbl, dist, lastKey: '', group, ring, lineMat, ringMat };
  }

  private localCount(): number {
    let n = 0;
    for (const p of this.pings) if (!p.owner) n++;
    return n;
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

  private removeOwnedBy(peerId: PeerId): void {
    for (let i = this.pings.length - 1; i >= 0; i--) if (this.pings[i].owner?.id === peerId) this.remove(i, true);
  }

  /** Local player died: drop own pings, keep the squad's. */
  private clearLocal(): void {
    for (let i = this.pings.length - 1; i >= 0; i--) if (!this.pings[i].owner) this.remove(i, true);
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
    this.hint.remove();
  }
}
