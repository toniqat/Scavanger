import * as THREE from 'three';
import type {
  GameContext, EnemyRef, InteriorCollider, PeerId, PingKind as SharedPingKind, PingMessage, PingAckMessage, WeaponSlot, AmmoType,
} from '@/shared';
import {
  MouseButtons, PING_LIFETIME, PING_DRAG_THRESHOLD_PX, PING_HOLD_MAX, PING_MAX_PER_PLAYER, PING_AIM_ASSIST_PX,
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

/**
 * Korean calibre names for the ammo-request quick chat. Mirrors `items/ItemDefs.AMMO_LABEL_KO` — this folder imports
 * only `@/shared`, and the calibre union (`AmmoType`) is a shared contract, so the table is repeated here.
 */
const AMMO_TYPE_KO: Readonly<Record<AmmoType, string>> = {
  light: '경량탄', medium: '준중량탄', heavy: '중량탄', shell: '산탄',
  rifle: '소총탄', pistol: '권총탄', shotgun: '산탄', energy: '에너지 셀',
  fuel: '연료통', cell: '전지', shuriken: '표창', arrow: '화살', rocket: '로켓', belt: '탄띠',
};

const COOLDOWN = 0.3;
const RAY_MAX = 300;
const FALLBACK_DIST = 120;
const HUB_FALLBACK_DIST = 12;  // ship interior: nothing hit → a point this far along the ray, on the deck
const CRATE_SNAP = 2.5;
const ITEM_SNAP = 2;
const PAD_SNAP = 8;
const BEACON_HEIGHT = 6;
const REMOTE_ENEMY_SNAP = 2.5; // remote 'enemy' pings without a matching id latch onto the nearest enemy within this radius
const HINT_DELAY = 0.15;       // seconds of holding before the gesture hint fades in
const VIS_CHECK_INTERVAL = 0.1;// seconds between enemy visibility checks per ping
const ENEMY_DEAD_LINGER = 1.5; // seconds an enemy ping stays after its enemy died
/** Occlusion margin (m) for a ground-level aim-assist candidate — the ray must not count the ground under it as a wall. */
const GROUND_OCCLUSION_MARGIN = 0.6;
/** Ack ring geometry: first ring just outside the base ring (0.75–0.95), each further acker one step out. */
const ACK_RING_INNER = 1.08;
const ACK_RING_WIDTH = 0.12;
const ACK_RING_STEP = 0.22;

/** Owner info for pings placed by squad members (null/undefined for local pings). */
export interface PingOwner { id: PeerId; name: string; slot: number; color: string }

/** One 알겠다 on a ping: who, and the slot colour their ring is drawn in. */
export interface PingAck { id: PeerId; slot: number }

/** Read-only view of a live ping (map / other HUD parts). */
export interface PingView {
  id: number; kind: PingKind; position: THREE.Vector3; expires: number; owner: PingOwner | null;
  /** Display label (item name, `적 (마지막 위치)`, …). */
  label: string;
  /** Enemy pings: true while the enemy is out of sight (marker parked at the last seen position). */
  lost: boolean;
  /** Squadmates (or the local player) who acknowledged this ping, in order. */
  acks: readonly PingAck[];
}

interface Ping extends PingView {
  acks: PingAck[];
  /** Sender-local sequence (own pings: ours; remote: the sender's `PingMessage.seq`; null = unackable legacy ping). */
  seq: number | null;
  enemy: EnemyRef | null;
  nextVisCheck: number;
  // DOM
  el: HTMLElement;
  lbl: HTMLElement;
  dist: HTMLElement;
  acksRow: HTMLElement;
  lastKey: string;
  // 3D
  group: THREE.Group;
  ring: THREE.Mesh;
  lineMat: THREE.MeshBasicMaterial;
  ringMat: THREE.MeshBasicMaterial;
  ackMats: THREE.MeshBasicMaterial[];
}

type Gesture = 'plain' | 'attack' | 'caution' | 'ammo';

/** Aim-assist candidate. `pri` 1 = squad ping (→ ack), 2 enemy, 3 pickup, 4 crate, 5 pad; lower wins, then screen distance. */
interface AimCandidate { pri: number; px: number; kind: PingKind; pos: THREE.Vector3; enemy: EnemyRef | null; ping: Ping | null; label: string }

/**
 * Middle-mouse pings (v3, 2026-09-09).
 *
 * **Where.** Anywhere the player has control and the pointer is locked — a mission *or* a ship (`ctx.isControlActive()`).
 * In the hub there is no `ctx.world`: the aim ray is cast against `ctx.hub.collider` (`InteriorCollider.raycast`) and a
 * miss lands `HUB_FALLBACK_DIST` m along the ray on the deck (`getFloorAt`); no enemy / crate / pad / pickup snapping,
 * kind `ground`. Pings relay to the squad only while `ctx.net.lobby` exists (the shared ship — everybody stands in the
 * same interior, so a remote ping attaches fine; the personal ship has nobody to tell). Remote pings are accepted in
 * gameplay **and** hub phases, dropped otherwise. `hub:entered` / `hub:left` clear every ping so ship pings never
 * linger into the next ship or mission.
 *
 * **Gesture** (unchanged): press = start hold; drag while held (pointer-locked deltas accumulate). Release:
 *   dx ≥ +PING_DRAG_THRESHOLD_PX → `attack` (돌격), dx ≤ −threshold → `caution` (주의),
 *   dy ≥ threshold (drag down) → ammo request quick chat `탄약 필요: <탄종>` (the equipped weapon's calibre through
 *   `ctx.loot.getEffectiveStats`, `AMMO_TYPE_KO`; no world ping), otherwise a plain ping.
 *   Holding longer than PING_HOLD_MAX locks the gesture to a plain ping. A radial hint appears after 150 ms.
 *
 * **Aim assist** (plain gesture pings only — not 돌격 / 주의, not the map's `placeAtWorld`). Before the exact raycast,
 * candidates are projected to the screen and the one nearest the crosshair inside `PING_AIM_ASSIST_PX` wins, provided it
 * is in front of the camera and not occluded (`world.raycast` / `hub.collider.raycast` from the camera). Priority when
 * several qualify: (1) a **squadmate's ping** → that is an *acknowledgement*, see below; (2) living enemies (chest
 * height); (3) pickups (`ctx.pickups.getPickups()`); (4) crates; (5) extraction pads. Same priority → smallest screen
 * distance. Nothing qualifies → the v2 exact ray: enemy hit → `enemy` (follows the enemy only while it is visible —
 * frustum + occlusion — else parks at the last seen position, dimmed, `적 (마지막 위치)`), pickup ≤ 2 m → `item`,
 * crate ≤ 2.5 m → `crate`, pad ≤ 8 m → `extraction`, else `ground`.
 *
 * **Confirmation ("알겠다").** Aiming a plain ping at a squadmate's ping (own pings cannot be acked, nor legacy pings
 * without `seq`) places nothing: the acker posts `chat:post {text:'알겠다고 확인.', kind:'ping'}` (the chat prefixes the
 * name, so everyone reads `<이름>: 알겠다고 확인.`), sends `PingAckMessage {owner, seq}` to the squad, and every client that
 * has that ping (found by owner peer id + the sender-local `seq`; the owner finds its own by its own `seq`) adds the
 * acker's slot colour to it — a thin flat ring on the ground outside the base ring (nested per acker) and a coloured dot
 * in the marker's `.acks` row. Duplicate acks from the same peer are ignored. Emits `ping:acked {id, by, name, slot}`
 * (`by` null = the local player acked). Only the normal cooldown applies; the cap is untouched.
 *
 * **Cap.** Every player — me and each squadmate — may have `PING_MAX_PER_PLAYER` live pings; a further one evicts that
 * player's oldest. Pings expire after PING_LIFETIME (fade the last 2 s); enemy pings detach when the enemy dies and
 * expire within 1.5 s.
 *
 * **Chat.** Every local ping posts a `kind:'ping'` line with the distance: `핑 (32m)`, `적 발견 (32m)`,
 * `보급 상자 (n등급) 여기 (32m)`, `탈출 지점 (32m)`, `<아이템 이름> 여기 있음 (32m)`, `돌격!`, `주의!`. Remote pings post
 * nothing locally — the sender's own line arrives through the chat relay.
 *
 * Each ping = projected DOM marker (`.pmarker.<kind>`, `.remote` in the sender's slot colour) + scene beacon (additive
 * 6 m line + pulsing ground ring; shared geometries, per-ping materials). Emits `ping:placed` + `ping:placedV2 {owner}` /
 * `ping:removed` for local **and** remote pings. Local pings go out as `PingMessage {p, kind, label, enemyId, seq}`;
 * incoming pings / acks are read through `ctx.net.onMessage('ping' | 'pingack')` (`net:remotePing` only without a net
 * module). `placeAtWorld(position, kind?)` (and `ping:requestAt`) ping a world point directly for surfaces with no aim
 * ray — the tactical map's middle-click; it skips the pointer-lock gate but keeps the cap, cooldown and snapping.
 */
export class Pings {
  readonly root: HTMLElement;
  private hint: HTMLElement;
  private ctx!: GameContext;
  private pings: Ping[] = [];
  private nextId = 1;
  /** Sender-local sequence stamped on every own ping (`PingMessage.seq`) so squadmates can name it in an ack. */
  private seq = 0;
  private lastPingTime = -Infinity;
  private lineGeo: THREE.BufferGeometry | null = null;
  private ringGeo: THREE.BufferGeometry | null = null;
  private ackGeos: THREE.BufferGeometry[] = [];
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
  /** Dedicated ray scratch for visibility / aim-assist checks — `origin` / `dir` may be the live aim ray of `place()`. */
  private rayO = new THREE.Vector3();
  private rayD = new THREE.Vector3();

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
      // v3: ship pings must not survive into the next ship / the mission (the mission reset would clear them anyway).
      ctx.bus.on('hub:entered', () => { this.clear(false); this.cancelHold(); }),
      ctx.bus.on('hub:left', () => { this.clear(false); this.cancelHold(); }),
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
    // Full PingMessage (label / enemyId / seq) through the net module; the bus event only carries position + kind.
    if (ctx.net) {
      this.unsubs.push(
        ctx.net.onMessage('ping', (msg, from) => this.onPingMessage(msg, from)),
        ctx.net.onMessage('pingack', (msg, from) => this.onPingAck(msg, from)),
      );
    } else {
      this.unsubs.push(ctx.bus.on('net:remotePing', ({ id, position, kind }) => this.placeRemote(id, position, kind, undefined, undefined, null)));
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
      for (const m of p.ackMats) m.opacity = 0.85 * fade * lostMul;
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
    // v3: pings work in the ship too — control active (gameplay OR hub, no blockers) + pointer locked + alive.
    const canPing = ctx.isControlActive() && input.isPointerLocked && !(ctx.player?.isDead ?? false);

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

  /** Drag-down quick chat: `탄약 필요: <탄종>` — the equipped weapon's calibre, falling back to the weapon name. */
  private requestAmmo(ctx: GameContext): void {
    let name = this.activeWeaponName;
    let ammo: string | null = null;
    const loadout = ctx.inventory?.getLoadout();
    const inst = this.activeWeaponSlot && loadout ? loadout[this.activeWeaponSlot] : null;
    if (inst && ctx.loot) {
      const stats = ctx.loot.getEffectiveStats(inst);
      if (stats?.ammoType) ammo = AMMO_TYPE_KO[stats.ammoType] ?? stats.ammoType;
      const def = ctx.loot.getItemDef(inst.defId);
      const wd = def?.weaponId ? ctx.loot.getWeaponDef(def.weaponId) : undefined;
      name = wd?.name ?? def?.name ?? name;
    }
    const what = ammo ?? name;
    ctx.bus.emit('chat:post', { text: what ? `탄약 필요: ${what}` : '탄약 필요', kind: 'request' });
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
    this.v.copy(e.position); this.v.y += e.height * 0.6;
    return this.screenDistance(ctx, this.v, e.radius, null, Infinity) >= 0;
  }

  /**
   * Screen-space distance (px) of a world point from the crosshair, or −1 when it is behind the camera, outside the
   * viewport, farther than `maxPx` from the centre, or occluded (camera → point ray, shortened by `margin`, against
   * `interior` in the ship or `ctx.world` in a mission).
   */
  private screenDistance(ctx: GameContext, target: THREE.Vector3, margin: number, interior: InteriorCollider | null, maxPx: number): number {
    const cam = ctx.camera;
    this.v2.copy(target).project(cam);
    if (this.v2.z < -1 || this.v2.z > 1 || Math.abs(this.v2.x) > 1 || Math.abs(this.v2.y) > 1) return -1;
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    const px = Math.hypot(this.v2.x * 0.5 * w, this.v2.y * 0.5 * h);
    if (px > maxPx) return -1;
    cam.getWorldPosition(this.rayO);
    this.rayD.subVectors(target, this.rayO);
    const dist = this.rayD.length();
    if (dist < 0.05) return px;
    this.rayD.divideScalar(dist);
    const maxD = Math.max(0, dist - margin);
    const hit = interior ? interior.raycast(this.rayO, this.rayD, maxD) : (ctx.world?.raycast(this.rayO, this.rayD, maxD) ?? null);
    return hit === null ? px : -1;
  }

  /* ── placement ─────────────────────────────────────────────────────────── */

  /** True while the player walks a ship (no `ctx.world` to hit; `ctx.hub.collider` is the geometry). */
  private inShip(ctx: GameContext): boolean {
    return ctx.isHubPhase() || ctx.hub?.active === true;
  }

  /** `forced` = attack / caution (directional gesture); null → aim assist, then classify by what the ray hit. */
  private place(ctx: GameContext, forced: 'attack' | 'caution' | null, origin: THREE.Vector3, dir: THREE.Vector3): void {
    const ship = this.inShip(ctx);
    const world = ctx.world;
    const interior = ship ? (ctx.hub?.collider ?? null) : null;
    if (!ship && !world?.ready) return;

    // v3: generous screen-space aim assist for plain pings — a squad ping under the crosshair is an ack, not a ping.
    if (!forced) {
      const c = this.aimAssist(ctx, interior);
      if (c) {
        if (c.ping) { this.ack(ctx, c.ping); return; }
        this.placeResolved(ctx, c.pos.clone(), c.kind, c.label, c.enemy);
        return;
      }
    }

    let kind: PingKind = 'ground';
    let enemy: EnemyRef | null = null;
    let label = '';
    const pos = new THREE.Vector3();

    if (ship) {
      const hit = interior?.raycast(origin, dir, RAY_MAX) ?? null;
      if (hit) pos.copy(hit.point);
      else {
        pos.copy(origin).addScaledVector(dir, HUB_FALLBACK_DIST);
        if (interior) pos.y = interior.getFloorAt(pos.x, pos.z);
      }
      // no enemies / crates / pads / pickups inside a ship — always a ground ping
      this.placeResolved(ctx, pos, forced ?? 'ground', '', null);
      return;
    }

    const eh = ctx.enemies?.raycast(origin, dir, RAY_MAX) ?? null;
    const wh = world!.raycast(origin, dir, RAY_MAX);

    if (eh && (!wh || eh.distance <= wh.distance)) {
      pos.copy(eh.enemy.position);
      if (!forced) { kind = 'enemy'; enemy = eh.enemy; }
    } else if (wh) {
      pos.copy(wh.point);
    } else {
      pos.copy(origin).addScaledVector(dir, FALLBACK_DIST);
      const half = world!.size / 2 - 1;
      pos.x = THREE.MathUtils.clamp(pos.x, -half, half);
      pos.z = THREE.MathUtils.clamp(pos.z, -half, half);
      pos.y = world!.getHeightAt(pos.x, pos.z);
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
   * Screen-space aim assist: the candidate nearest the crosshair within `PING_AIM_ASSIST_PX`, in front and unoccluded.
   * Lower `pri` always wins (squad ping → enemy → pickup → crate → pad); ties go to the smaller screen distance.
   * In the ship only squad pings are candidates. Returns null when nothing qualifies (→ exact ray).
   */
  private aimAssist(ctx: GameContext, interior: InteriorCollider | null): AimCandidate | null {
    // holder object rather than a `let` — TS would narrow a closure-assigned local to its initial `null`
    const acc: { best: AimCandidate | null } = { best: null };
    const consider = (pri: number, target: THREE.Vector3, margin: number, kind: PingKind, pos: THREE.Vector3, enemy: EnemyRef | null, ping: Ping | null, label: string): void => {
      const cur = acc.best;
      if (cur && cur.pri < pri) return;
      const px = this.screenDistance(ctx, target, margin, interior, PING_AIM_ASSIST_PX);
      if (px < 0) return;
      if (cur && cur.pri === pri && cur.px <= px) return;
      acc.best = { pri, px, kind, pos, enemy, ping, label };
    };

    // (1) squadmates' pings — an ack. Own pings and legacy pings without `seq` are not candidates.
    const myId = ctx.net?.localId ?? null;
    for (const p of this.pings) {
      if (!p.owner || p.seq === null) continue;
      if (myId && p.acks.some((a) => a.id === myId)) continue; // already confirmed by me → let the aim pass through
      this.v.copy(p.position); this.v.y += 0.6;
      consider(1, this.v, GROUND_OCCLUSION_MARGIN + 0.6, p.kind, p.position, null, p, '');
    }
    if (acc.best) return acc.best;

    const world = ctx.world;
    if (interior || !world?.ready) return null;

    // (2) living enemies, chest height
    if (ctx.enemies) {
      for (const e of ctx.enemies.getEnemies()) {
        if (e.isDead) continue;
        this.v.copy(e.position); this.v.y += e.height * 0.6;
        consider(2, this.v, e.radius, 'enemy', e.position, e, null, '');
      }
    }
    if (acc.best) return acc.best;

    // (3) pickups
    if (ctx.pickups) {
      for (const pk of ctx.pickups.getPickups()) {
        this.v.copy(pk.position); this.v.y += 0.4;
        const name = ctx.loot?.getItemDef(pk.item.defId)?.name ?? pk.item.defId;
        consider(3, this.v, GROUND_OCCLUSION_MARGIN, 'item', pk.position, null, null, pk.item.qty > 1 ? `${name} ×${pk.item.qty}` : name);
      }
    }
    if (acc.best) return acc.best;

    // (4) crates
    for (const c of world.getCrates()) {
      this.v.copy(c.position); this.v.y += 0.7;
      consider(4, this.v, GROUND_OCCLUSION_MARGIN + 0.6, 'crate', c.position, null, null, `보급 상자 (${c.tier}등급)`);
    }
    if (acc.best) return acc.best;

    // (5) extraction pads
    for (const e of world.getExtractionPoints()) {
      this.v.copy(e.position); this.v.y += 1.0;
      consider(5, this.v, GROUND_OCCLUSION_MARGIN + 1.0, 'extraction', e.position, null, null, '');
    }
    return acc.best;
  }

  /**
   * Ping a world point from a surface that has no aim ray — the tactical map's middle-click (`ping:requestAt`).
   * The pointer-lock / control gate of the gesture path is deliberately **skipped** (the map holds a UI blocker by
   * definition), but the per-player cap and the cooldown still apply, and a `ground` request reuses the same pickup /
   * crate / pad snapping, so a map ping dropped on a crate still reads `보급 상자 (n등급)`. No aim assist (no crosshair).
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

  /** Chat callout for a local ping — every kind posts one (v3), with the horizontal distance from the player. */
  private chatLine(kind: PingKind, text: string, dist: number): string {
    const d = `(${dist}m)`;
    switch (kind) {
      case 'attack': return '돌격!';
      case 'caution': return '주의!';
      case 'enemy': return `적 발견 ${d}`;
      case 'crate': return `${text} 여기 ${d}`;
      case 'extraction': return `탈출 지점 ${d}`;
      case 'item': return `${text} 여기 있음 ${d}`;
      default: return `핑 ${d}`;
    }
  }

  /** Shared tail of every local ping: eviction → build → `ping:placed(V2)` → chat callout → relay. */
  private placeResolved(ctx: GameContext, pos: THREE.Vector3, kind: PingKind, label: string, enemy: EnemyRef | null): void {
    const text = label || PING_LABEL[kind];

    this.evictFor(null);

    const id = this.nextId++;
    const seq = ++this.seq;
    const expires = ctx.time + PING_LIFETIME;
    const ping = this.build(id, kind, pos, expires, enemy, null, text, seq);
    this.pings.push(ping);
    ctx.bus.emit('ping:placed', { id, position: ping.position, kind, expires });
    ctx.bus.emit('ping:placedV2', { id, position: ping.position, kind, expires, owner: null });

    // chat line — every ping (v3)
    const player = ctx.player;
    const dist = player ? Math.round(Math.hypot(pos.x - player.position.x, pos.z - player.position.z)) : 0;
    ctx.bus.emit('chat:post', { text: this.chatLine(kind, text, dist), kind: 'ping' });

    // squad: share it (only while a lobby exists — the personal ship has nobody to tell)
    if (ctx.net && (ctx.isMultiplayer || ctx.net.lobby)) {
      const msg: PingMessage = { t: 'ping', p: [pos.x, pos.y, pos.z], kind, seq };
      if (kind === 'item' || kind === 'crate') msg.label = text;
      if (enemy) msg.enemyId = enemy.id;
      ctx.net.send(msg, 'others');
    }
  }

  /* ── 알겠다 (acks) ─────────────────────────────────────────────────────── */

  /** Local player confirmed a squadmate's ping: chat line + `pingack` to the squad + own ring on the ping. */
  private ack(ctx: GameContext, ping: Ping): void {
    if (!ping.owner || ping.seq === null) return;
    const net = ctx.net;
    ctx.bus.emit('chat:post', { text: '알겠다고 확인.', kind: 'ping' });
    if (net && (ctx.isMultiplayer || net.lobby)) {
      const msg: PingAckMessage = { t: 'pingack', owner: ping.owner.id, seq: ping.seq };
      net.send(msg, 'others');
    }
    const myId = net?.localId ?? 'local';
    const slot = (net?.localId ? net.getLobbyPlayer(net.localId)?.slot : undefined) ?? 0;
    this.applyAck(ping, myId, slot, net?.playerName ?? '나', null);
  }

  private onPingAck(msg: PingAckMessage, from: PeerId): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!net) return;
    if (typeof msg.owner !== 'string' || typeof msg.seq !== 'number' || !Number.isFinite(msg.seq)) return;
    const mine = msg.owner === net.localId;
    const ping = this.pings.find((p) => (mine ? !p.owner : p.owner?.id === msg.owner) && p.seq === msg.seq);
    if (!ping) return;
    const lp = net.getLobbyPlayer(from);
    const ref = net.getRemotePlayer(from);
    this.applyAck(ping, from, lp?.slot ?? ref?.slot ?? 0, lp?.name ?? ref?.name ?? '분대원', from);
  }

  /** Record one acker on a ping (idempotent per peer): nested slot-colour ground ring + marker dot + `ping:acked`. */
  private applyAck(ping: Ping, ackerId: PeerId, slot: number, name: string, by: PeerId | null): void {
    if (ping.acks.some((a) => a.id === ackerId)) return;
    const index = ping.acks.length;
    ping.acks.push({ id: ackerId, slot });

    const css = NET_SLOT_COLORS_CSS[slot] ?? '#ffffff';
    const dot = el('i', { parent: ping.acksRow });
    dot.style.setProperty('--ac', css);
    dot.title = name;

    const geo = this.ackGeo(index);
    const mat = new THREE.MeshBasicMaterial({ color: NET_SLOT_COLORS[slot] ?? 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = 0.05;
    mesh.frustumCulled = false;
    ping.group.add(mesh);
    ping.ackMats.push(mat);

    this.ctx.bus.emit('ping:acked', { id: ping.id, by, name, slot });
  }

  /** Shared flat ring for the n-th acker (lazily built, disposed with the other shared geometries). */
  private ackGeo(index: number): THREE.BufferGeometry {
    let g = this.ackGeos[index];
    if (!g) {
      const inner = ACK_RING_INNER + index * ACK_RING_STEP;
      g = new THREE.RingGeometry(inner, inner + ACK_RING_WIDTH, 48);
      g.rotateX(-Math.PI / 2);
      this.ackGeos[index] = g;
    }
    return g;
  }

  /* ── remote pings ──────────────────────────────────────────────────────── */

  private onPingMessage(msg: PingMessage, from: PeerId): void {
    const p = msg.p;
    if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    const kind: PingKind = typeof msg.kind === 'string' && msg.kind in PING_LABEL ? msg.kind : 'ground';
    const label = typeof msg.label === 'string' ? msg.label.slice(0, 40) : undefined;
    const enemyId = typeof msg.enemyId === 'number' ? msg.enemyId : undefined;
    const seq = typeof msg.seq === 'number' && Number.isFinite(msg.seq) ? msg.seq : null;
    this.placeRemote(from, this.v.set(p[0], p[1], p[2]), kind, label, enemyId, seq);
  }

  /** A squad member pinged. Up to `PING_MAX_PER_PLAYER` live pings per sender; drawn in their slot colour. */
  private placeRemote(peerId: PeerId, position: THREE.Vector3, kind: PingKind, label: string | undefined, enemyId: number | undefined, seq: number | null): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!net) return;
    const gameplay = ctx.isGameplayPhase();
    if (!gameplay && !this.inShip(ctx)) return; // menus / cutscenes: nothing to attach to
    const lp = net.getLobbyPlayer(peerId);
    const ref = net.getRemotePlayer(peerId);
    const slot = lp?.slot ?? ref?.slot ?? 0;
    const owner: PingOwner = { id: peerId, name: lp?.name ?? ref?.name ?? '분대원', slot, color: NET_SLOT_COLORS_CSS[slot] ?? '#ffffff' };

    this.evictFor(peerId);

    const pos = position.clone();
    let enemy: EnemyRef | null = null;
    if (kind === 'enemy' && gameplay && ctx.enemies) {
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
    const ping = this.build(id, kind, pos, expires, enemy, owner, label && label.length ? label : PING_LABEL[kind], seq);
    this.pings.push(ping);
    ctx.bus.emit('ping:placed', { id, position: ping.position, kind, expires });
    ctx.bus.emit('ping:placedV2', { id, position: ping.position, kind, expires, owner: owner.id });
    // no local chat line: the sender's own callout arrives through the chat relay
  }

  private build(id: number, kind: PingKind, pos: THREE.Vector3, expires: number, enemy: EnemyRef | null, owner: PingOwner | null, label: string, seq: number | null): Ping {
    const m = el('div', { cls: `pmarker ${kind}${owner ? ' remote' : ''}`, parent: this.root });
    if (owner) m.style.setProperty('--pc', owner.color);
    el('i', { cls: 'ico', parent: m });
    const lbl = el('span', { cls: 'lbl', text: owner ? `${owner.name} · ${label}` : label, parent: m });
    const dist = el('span', { cls: 'dist ui-mono', text: '', parent: m });
    const acksRow = el('span', { cls: 'acks', parent: m });

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

    return {
      id, kind, position: pos, expires, owner, label, lost: false, acks: [], seq, enemy, nextVisCheck: 0,
      el: m, lbl, dist, acksRow, lastKey: '', group, ring, lineMat, ringMat, ackMats: [],
    };
  }

  /** Per-player cap: while `owner` (null = me) already has `PING_MAX_PER_PLAYER` live pings, drop their oldest (lowest id). */
  private evictFor(owner: PeerId | null): void {
    for (;;) {
      let count = 0;
      let oldest = -1;
      for (let i = 0; i < this.pings.length; i++) {
        const p = this.pings[i];
        if ((p.owner?.id ?? null) !== owner) continue;
        count++;
        if (oldest < 0 || p.id < this.pings[oldest].id) oldest = i;
      }
      if (count < PING_MAX_PER_PLAYER || oldest < 0) return;
      this.remove(oldest, true);
    }
  }

  private remove(index: number, emit: boolean): void {
    const p = this.pings[index];
    if (!p) return;
    this.pings.splice(index, 1);
    p.el.remove();
    this.ctx.scene.remove(p.group);
    p.lineMat.dispose(); p.ringMat.dispose();
    for (const m of p.ackMats) m.dispose();
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
      for (const g of this.ackGeos) g.dispose();
      this.ackGeos.length = 0;
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.clear(true);
    this.root.remove();
    this.hint.remove();
  }
}
