/**
 * src/world/structures/parts/Turret.ts — the **ceiling turret** inside a locked space
 * (2026-09-21, user's decision 「무적 방어장치」).
 *
 * Why it exists: the basement and the lab's floor-2 locked room each have a **drone vent** beside their door, so
 * the room's loot could be taken without ever finding the key. The turret puts the key back in the middle: it is
 * **indestructible** (no hp, no collider to shoot, not an enemy — nothing can target it) and the **only** way to
 * switch it off is opening that room's door with the matching planet's key · keycard. Then it powers down for
 * good, for everyone.
 *
 * ## The loop
 * `idle` → a body inside the watched room within `CEIL_TURRET_RANGE_M` with a clear line → turn onto it at
 * `CEIL_TURRET_TURN_RATE` while the alarm sounds and the aiming laser paints it (`CEIL_TURRET_WARMUP_S` — the
 * moment the intruder gets to leave) → a shot of `CEIL_TURRET_DAMAGE` every `CEIL_TURRET_INTERVAL_S`. Losing the
 * target resets the warm-up, so stepping out and back in always costs the intruder the warning again.
 *
 * ## What is authoritative and what is not
 * - **Powering down is the existing `struct unlocked` fact** — host-decided, carried to everyone and replayed to a
 *   late joiner in `struct sync.unlocked` (`Structures.applyUnlock` calls `disableFor`). There is deliberately no
 *   second wire for it: the door and the turret are one state.
 * - **Damage is applied by the authority only** (`GameContext.isAuthority`): the local player through
 *   `PlayerRef.takeDamage` with a `PlayerDamageSource`, a squadmate through the existing `dmg` message (「host → one
 *   client: you took damage」), an android through `AlliesRef.damage`. A client never damages anyone.
 * - The **look** (turning, the laser, the alarm, the tracer) is stepped on every client from state everyone already
 *   has — the room's unlocked flag plus the player · squadmate · android positions that flow at 20 Hz anyway. That
 *   is what makes the warning appear for the victim on their own screen at the moment it is aimed at them; the
 *   worst a disagreement can do is draw the beam at the wrong body for a frame.
 *
 * ## Budgets (CLAUDE.md §4.5)
 * - **No point light.** Adding one would recompile every material and the raid budget has zero spare slots
 *   (`SCENE_POINT_LIGHT_BUDGET`, `core/LightBudget`). The warning reads through the laser, the alarm and an
 *   emissive LED instead.
 * - **Two draws per turret plus one shared.** All mount plates merge into one static mesh; each turret owns one
 *   head (~24 triangles) and one LED quad, and the heads share the structure material while the LEDs share one
 *   emissive material. A map has at most a handful of locked spaces.
 * - The laser and the shot go through the shared `TracerPool`, so they cost no object of their own.
 */
import * as THREE from 'three';
import {
  CEIL_TURRET_DAMAGE, CEIL_TURRET_INTERVAL_S, CEIL_TURRET_RANGE_M, CEIL_TURRET_TURN_RATE, CEIL_TURRET_WARMUP_S,
  PLAYER_HEIGHT, type GameContext, type PeerId, type PlayerDamageSource,
} from '@/shared';
import { FxManager } from '@/core/fx';
import { type BuildCtx, merge, paint, paintGradient, xform } from '../../build';
import type { TurretSpot } from './Build';

/** One turret to build — `structureId` is the locked door's owner, so unlocking that door powers it down. */
export interface TurretSpec {
  id: string;
  structureId: string;
  spot: TurretSpot;
}

/* ── Drawing numbers (a model matter, like the rest of `structures/model.ts` — not balance) ────────── */
/** Ceiling plate half-width · thickness (m). */
const PLATE_HALF = 0.19;
const PLATE_T = 0.09;
/** How far below the ceiling the head's pivot hangs (m). */
const PIVOT_DROP = 0.14;
/** Head body half-extents · barrel length / thickness (m). The head is drawn with its barrel along local +Z,
 *  so aiming is one `lookAt` and no yaw-sign convention can be got wrong. */
const HEAD_HALF = 0.13;
const BARREL_LEN = 0.34;
const BARREL_HALF = 0.037;
/** Where the muzzle sits in head-local space (m) — the tracer and the line-of-fire ray start here. */
const MUZZLE_Z = HEAD_HALF + BARREL_LEN;
/** Chest height of a standing body (m) — what the turret aims at and measures its line of fire to. */
const AIM_HEIGHT = PLAYER_HEIGHT * 0.62;
/** Slack (m) allowed on the line-of-fire ray so the body's own surroundings do not count as cover. */
const LOS_SLACK = 0.35;
/** How far outside the room's box a body still counts as inside (m) — the walls have thickness. */
const ROOM_MARGIN = 0.2;
/** Aiming laser · shot tracer colours, the laser's width (m) and the shortest beam a frame may draw (s). */
const LASER_COLOR = 0xff3524;
const SHOT_COLOR = 0xffd9a0;
const LASER_WIDTH = 0.012;
const MIN_BEAM_LIFE_S = 1 / 30;
/** How close the barrel has to be to the target direction (rad) before a shot goes off. */
const AIM_TOLERANCE = 0.12;
/** Idle parking direction: straight down. */
const PARK = new THREE.Vector3(0, -1, 0);

const _v = new THREE.Vector3(), _aim = new THREE.Vector3(), _hit = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

/** What the turret is shooting at. `peer` · `ally` carry the id the damage call needs. */
type TargetKind = 'local' | 'peer' | 'ally';
interface Target { kind: TargetKind; id: string; point: THREE.Vector3 }

interface Turret {
  readonly spec: TurretSpec;
  readonly pivot: THREE.Vector3;
  readonly head: THREE.Mesh;
  readonly led: THREE.Mesh;
  /** Current barrel direction (unit) — turned toward the target at `CEIL_TURRET_TURN_RATE`. */
  readonly aim: THREE.Vector3;
  readonly muzzle: THREE.Vector3;
  /** Powered down by the door being opened. */
  off: boolean;
  /** `kind:id` of what it is on now, null with nothing. */
  lock: string | null;
  warm: number;
  cool: number;
}

export class CeilingTurretSet {
  readonly group = new THREE.Group();
  private readonly turrets: Turret[] = [];
  private readonly byStructure = new Map<string, Turret[]>();
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  /** One emissive material for every LED — the breathing pulse is therefore one write per frame. */
  private ledMat: THREE.MeshStandardMaterial | null = null;
  private game: GameContext | null = null;
  /** Reused target record — the update loop allocates nothing. */
  private readonly target: Target = { kind: 'local', id: '', point: new THREE.Vector3() };

  constructor(name = 'CeilingTurrets') { this.group.name = name; }

  /** Debug · smoke: is this structure's turret still armed. Null when it has none. */
  isArmed(structureId: string): boolean | null {
    const list = this.byStructure.get(structureId);
    return list && list.length > 0 ? list.some((t) => !t.off) : null;
  }

  build(ctx: BuildCtx, game: GameContext, specs: readonly TurretSpec[], body: THREE.Material): void {
    this.game = game;
    ctx.root.add(this.group);
    if (specs.length === 0) return;

    /* Every mount plate in one merged static mesh — the plates never move, so they cost one draw for the map. */
    const plates: THREE.BufferGeometry[] = [];
    const ledMat = new THREE.MeshStandardMaterial({ color: 0x1a0603, emissive: new THREE.Color(0xff3a22), emissiveIntensity: 1.4 });
    this.mats.push(ledMat);
    this.ledMat = ledMat;

    for (const spec of specs) {
      const { x, y, z } = spec.spot;
      const plate = new THREE.BoxGeometry(PLATE_HALF * 2, PLATE_T, PLATE_HALF * 2);
      xform(plate, { x, y: y - PLATE_T / 2, z });
      paintGradient(plate, new THREE.Color(0x24272c), new THREE.Color(0x424750), y - PLATE_T, y);
      plates.push(plate);

      /* The head: a small box plus a barrel along local +Z, so `lookAt` aims it. It casts no shadow — a
       * hand-sized body under a ceiling adds a caster for nothing (§4.5). */
      const parts: THREE.BufferGeometry[] = [];
      const shell = new THREE.BoxGeometry(HEAD_HALF * 2, HEAD_HALF * 1.6, HEAD_HALF * 2);
      paint(shell, new THREE.Color(0x3a3f47));
      parts.push(shell);
      const barrel = new THREE.BoxGeometry(BARREL_HALF * 2, BARREL_HALF * 2, BARREL_LEN);
      xform(barrel, { x: 0, y: 0, z: HEAD_HALF + BARREL_LEN / 2 });
      paint(barrel, new THREE.Color(0x1d2024));
      parts.push(barrel);
      const geo = merge(parts);
      this.geos.push(geo);
      const head = new THREE.Mesh(geo, body);
      head.name = `${spec.id}_head`;
      head.position.set(x, y - PIVOT_DROP, z);
      this.group.add(head);

      const ledGeo = new THREE.BoxGeometry(0.075, 0.05, 0.03);
      xform(ledGeo, { x: 0, y: HEAD_HALF * 0.55, z: HEAD_HALF + 0.01 });
      this.geos.push(ledGeo);
      const led = new THREE.Mesh(ledGeo, ledMat);
      led.name = `${spec.id}_led`;
      head.add(led);

      const t: Turret = {
        spec, pivot: new THREE.Vector3(x, y - PIVOT_DROP, z), head, led,
        aim: PARK.clone(), muzzle: new THREE.Vector3(), off: false, lock: null, warm: 0, cool: 0,
      };
      this.applyAim(t);
      this.turrets.push(t);
      const list = this.byStructure.get(spec.structureId) ?? [];
      list.push(t);
      this.byStructure.set(spec.structureId, list);
    }

    const plateGeo = merge(plates);
    this.geos.push(plateGeo);
    const plateMesh = new THREE.Mesh(plateGeo, body);
    plateMesh.name = 'CeilingTurretMounts';
    plateMesh.receiveShadow = true;
    this.group.add(plateMesh);
  }

  /**
   * That structure's locked door was opened — its turret powers down for good. Called from
   * `Structures.applyUnlock`, so it runs on the opener, on every other client through `struct unlocked` and on a
   * late joiner through `struct sync.unlocked`. There is no way back.
   */
  disableFor(structureId: string): void {
    for (const t of this.byStructure.get(structureId) ?? []) {
      if (t.off) continue;
      t.off = true;
      t.lock = null;
      t.warm = 0;
      t.led.visible = false;
      t.aim.copy(PARK);
      this.applyAim(t);
    }
  }

  update(dt: number, time: number): void {
    const ctx = this.game;
    if (!ctx || this.turrets.length === 0) return;
    if (this.ledMat) this.ledMat.emissiveIntensity = 1.1 + 0.5 * Math.sin(time * 6);
    const live = ctx.isGameplayActive();
    for (const t of this.turrets) {
      if (t.off) continue;
      const found = live ? this.pickTarget(t) : null;
      const key = found ? `${found.kind}:${found.id}` : null;
      if (key !== t.lock) {
        t.lock = key;
        t.warm = 0;
        t.cool = 0;
        /* The alarm is what says 「leave now」 — it fires on acquisition, not on the shot. */
        if (key) ctx.bus.emit('audio:play', { id: 'c4_beep', position: t.pivot, volume: 0.9, pitch: 0.75 });
      }
      if (!found) { this.turn(t, PARK, dt); continue; }

      _aim.copy(found.point).sub(t.pivot).normalize();
      this.turn(t, _aim, dt);
      /* The laser paints the target from the moment it is acquired — that, the alarm and the warm-up are the
       * one chance the intruder gets to walk back out. */
      this.drawBeam(t, found.point, LASER_COLOR, LASER_WIDTH, Math.max(dt, MIN_BEAM_LIFE_S));
      if (t.warm < CEIL_TURRET_WARMUP_S) { t.warm += dt; continue; }
      t.cool -= dt;
      /* It also has to be **pointing** there — a turret that just swung round does not snipe through the turn. */
      if (t.cool > 0 || t.aim.angleTo(_aim) > AIM_TOLERANCE) continue;
      t.cool = CEIL_TURRET_INTERVAL_S;
      this.fire(t, found);
    }
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    this.geos = [];
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.ledMat = null;
    this.turrets.length = 0;
    this.byStructure.clear();
    this.group.clear();
    this.group.removeFromParent();
    this.game = null;
  }

  /* ── Aiming ───────────────────────────────────────────────────────────── */

  /** Turns `t.aim` toward `want` by at most `CEIL_TURRET_TURN_RATE · dt` and re-poses the head. */
  private turn(t: Turret, want: THREE.Vector3, dt: number): void {
    const ang = t.aim.angleTo(want);
    if (ang > 1e-4) {
      const step = Math.min(1, (CEIL_TURRET_TURN_RATE * dt) / ang);
      _qa.setFromUnitVectors(t.aim, want);
      _qb.identity().slerp(_qa, step);
      t.aim.applyQuaternion(_qb).normalize();
    }
    this.applyAim(t);
  }

  /** Points the head along `t.aim` and recomputes the muzzle. */
  private applyAim(t: Turret): void {
    _v.copy(t.pivot).add(t.aim);
    t.head.lookAt(_v);
    t.head.updateMatrixWorld();
    t.muzzle.copy(t.pivot).addScaledVector(t.aim, MUZZLE_Z);
  }

  /* ── Target choice ────────────────────────────────────────────────────── */

  /** Is this world point inside the room this turret watches. */
  private inRoom(t: Turret, x: number, y: number, z: number): boolean {
    const r = t.spec.spot.room;
    if (y < r.yBottom - ROOM_MARGIN || y > r.yTop + ROOM_MARGIN) return false;
    const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
    const dx = x - r.x, dz = z - r.z;
    return Math.abs(dx * c + dz * s) <= r.halfX + ROOM_MARGIN && Math.abs(-dx * s + dz * c) <= r.halfZ + ROOM_MARGIN;
  }

  /**
   * The nearest body the turret may shoot — inside the room, within range, with a clear line from the muzzle.
   * Players and androids only (a drone that crawled through the vent is not a target, and enemies are not either:
   * the device belongs to the building, not to a side).
   */
  private pickTarget(t: Turret): Target | null {
    const ctx = this.game;
    if (!ctx) return null;
    let best = Infinity;
    let found = false;
    const consider = (kind: TargetKind, id: string, feetX: number, feetY: number, feetZ: number): void => {
      const y = feetY + AIM_HEIGHT;
      if (!this.inRoom(t, feetX, feetY, feetZ)) return;
      const d = Math.hypot(feetX - t.pivot.x, y - t.pivot.y, feetZ - t.pivot.z);
      if (d > CEIL_TURRET_RANGE_M || d >= best) return;
      /* The line is measured from the **pivot**, not the muzzle: the muzzle swings while the head turns, and a
         barrel still pointing at the floor would briefly block its own line and reset the warm-up over and over.
         The pivot hangs `PIVOT_DROP` below the ceiling, so it is inside the room and never inside the slab. */
      _v.set(feetX - t.pivot.x, y - t.pivot.y, feetZ - t.pivot.z);
      const dist = _v.length();
      if (dist < 1e-3) return;
      _v.divideScalar(dist);
      /* The closed door is a collider (`kind: 'door'`, removed only when the door opens), so this one ray is also
         「it must not shoot through the door」 — and once the door is gone the turret is off anyway. */
      const blocked = ctx.world?.raycast(t.pivot, _v, dist - LOS_SLACK);
      if (blocked) return;
      best = d;
      found = true;
      this.target.kind = kind;
      this.target.id = id;
      this.target.point.set(feetX, y, feetZ);
    };

    const p = ctx.player;
    if (p && !p.isDead && !p.isDowned && !p.isDropping && !p.isInShip) {
      /* A fixed id, not `net.localId` — that one can appear mid-raid and the change would reset the warm-up. */
      consider('local', 'self', p.position.x, p.position.y, p.position.z);
    }
    for (const r of ctx.net?.getRemotePlayers() ?? []) {
      if (r.isDead || r.isDowned || !r.inMission || r.suspended) continue;
      consider('peer', r.id, r.position.x, r.position.y, r.position.z);
    }
    /* `getCombatBodies` is already 「in a raid · neither downed nor dead · visible」. */
    for (const a of ctx.allies?.getCombatBodies() ?? []) {
      consider('ally', a.id, a.position.x, a.position.y, a.position.z);
    }
    return found ? this.target : null;
  }

  /* ── Firing ───────────────────────────────────────────────────────────── */

  private drawBeam(t: Turret, to: THREE.Vector3, color: number, width: number, life: number): void {
    FxManager.get()?.tracers.add(t.muzzle, to, color, width, life);
  }

  private fire(t: Turret, target: Target): void {
    const ctx = this.game;
    if (!ctx) return;
    _hit.copy(target.point);
    this.drawBeam(t, _hit, SHOT_COLOR, 0.03, 0.06);
    ctx.bus.emit('audio:play', { id: 'turret_shot', position: t.muzzle, volume: 0.85, pitch: 1.15 });
    /* Only the authority decides that anyone was hit — a client's copy of this loop is the warning and the look. */
    if (!ctx.isAuthority) return;
    /* `explosion` = 「physical damage that is nobody's body」 (`DamageCauseKind`) — the same cause a tram collision
       carries, so the results screen reads 「폭발」 and no NPC kill objective can misread it as an enemy's doing. */
    const source: PlayerDamageSource = { kind: 'explosion' };
    if (target.kind === 'local') { ctx.player?.takeDamage(CEIL_TURRET_DAMAGE, t.muzzle, source); return; }
    if (target.kind === 'ally') { ctx.allies?.damage(target.id, CEIL_TURRET_DAMAGE, source, t.muzzle); return; }
    const net = ctx.net;
    if (!net || !ctx.isMultiplayer) return;
    net.send({
      t: 'dmg', amount: CEIL_TURRET_DAMAGE,
      from: [t.muzzle.x, t.muzzle.y, t.muzzle.z], src: { k: 'explosion' },
    }, target.id as PeerId);
  }
}
