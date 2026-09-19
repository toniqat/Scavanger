/**
 * src/allies/parts/Sync.ts — **the wire** (`ally` facts · `allyq` requests, contract: the last section of
 * `shared/net.ts`).
 *
 * The authority is one host: the host sends a snapshot of every unit every `ALLY_NET_INTERVAL_S`, and a replica
 * accepts **only the `ally` the host sent** (`lobby.hostId` is checked — taking an android state from anyone at
 * all would itself be a cheat).
 * A replica interpolates `NET_INTERP_DELAY` behind — the same contract as a remote player, so a body never moves
 * out of step.
 *
 * The ship has no wire (`parts/Hub`) — it only sends during a raid session.
 */
import {
  ALLY_FLAGS, ALLY_MODES, ALLY_NET_INTERVAL_S, ALLY_POSES, ALLY_STATES, NET_INTERP_DELAY, isAndroidId,
} from '@/shared';
import type * as THREE from 'three';
import type { AllyId, AllyWire, GameMessage, ItemInstance, PeerId, PingKind, Vec3Tuple } from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import * as Vitals from './Vitals';
import * as Commands from './Commands';
import * as Bag from './Bag';

function tup(v: THREE.Vector3): Vec3Tuple {
  return [round(v.x), round(v.y), round(v.z)];
}
/** Coordinates are sent cut down to 2 decimal places (contract). */
function round(n: number): number { return Math.round(n * 100) / 100; }

/* ═══════════════════════════ Hooks ═══════════════════════════ */

export function ensureNetHooks(sys: AllySystem): void {
  const net = sys.ctx.net;
  if (!net || sys.netHooked) return;
  sys.netHooked = true;
  sys.netUnsubs.push(
    net.onMessage('ally', (msg, from) => onAlly(sys, msg, from)),
    net.onMessage('allyq', (msg, from) => onAllyq(sys, msg, from)),
  );
}

export function unhook(sys: AllySystem): void {
  for (const u of sys.netUnsubs) u();
  sys.netUnsubs.length = 0;
  sys.netHooked = false;
}

/* ═══════════════════════════ Sending ═══════════════════════════ */

function live(sys: AllySystem): boolean {
  return !!sys.ctx.net && sys.ctx.isMultiplayer;
}

export function update(sys: AllySystem, dt: number): void {
  if (!live(sys) || !sys.simulating || !sys.raidActive) return;
  sys.netTimer += dt;
  if (sys.netTimer < ALLY_NET_INTERVAL_S) return;
  sys.netTimer = 0;
  const allies: AllyWire[] = [];
  for (const a of sys.bodies) {
    if (a.mode !== 'raid') continue;
    allies.push(encode(a));
    if (a.bagDirty) { a.bagDirty = false; sendBag(sys, a); }
  }
  if (allies.length > 0) sys.ctx.net?.send({ t: 'ally', ev: 'state', allies }, 'others');
}

function encode(a: Ally): AllyWire {
  const w: AllyWire = {
    id: a.id,
    md: Math.max(0, ALLY_MODES.indexOf(a.mode)),
    st: Math.max(0, ALLY_STATES.indexOf(a.state)),
    po: Math.max(0, ALLY_POSES.indexOf(a.pose)),
    p: tup(a.position), v: tup(a.velocity), y: round(a.yaw), pt: round(a.pitch),
    hp: Math.round(a.hp), mhp: Math.round(a.maxHp), sh: Math.round(a.shield), msh: Math.round(a.maxShield),
    dhp: Math.round(a.downHp),
    f: a.flags | (a.hidden ? ALLY_FLAGS.HIDDEN : 0),
    w: a.weaponDefId, a: a.armorDefId, b: a.bagDefId,
    c: a.carrying,
  };
  if (a.lookAt) w.lk = tup(a.lookAt);
  return w;
}

function sendBag(sys: AllySystem, a: Ally): void {
  if (!live(sys)) return;
  sys.ctx.net?.send({
    t: 'ally', ev: 'bag', id: a.id,
    equip: { primary: a.equip.primary, armor: a.equip.armor, bag: a.equip.bag },
    items: (a.bag?.items() ?? []).slice(),
    kit: Array.from(a.kitUids),
  }, 'others');
}

export function sendPing(sys: AllySystem, a: Ally, kind: PingKind, p: THREE.Vector3, label?: string, enemyId?: number): void {
  if (!live(sys) || !sys.simulating) return;
  const msg: GameMessage = { t: 'ally', ev: 'ping', id: a.id, kind, p: tup(p) };
  if (label) (msg as { label?: string }).label = label;
  if (typeof enemyId === 'number') (msg as { enemyId?: number }).enemyId = enemyId;
  sys.ctx.net?.send(msg, 'others');
}

export function sendChat(sys: AllySystem, a: Ally, text: string): void {
  if (!live(sys) || !sys.simulating) return;
  sys.ctx.net?.send({ t: 'ally', ev: 'chat', id: a.id, text }, 'others');
}

export function sendFire(sys: AllySystem, a: Ally, from: THREE.Vector3, to: THREE.Vector3): void {
  if (!live(sys) || !sys.simulating) return;
  sys.ctx.net?.send({ t: 'ally', ev: 'fire', id: a.id, from: tup(from), to: tup(to), w: a.weaponDefId }, 'others');
}

export function sendPodDrop(sys: AllySystem, a: Ally): void {
  if (!live(sys) || !sys.simulating) return;
  sys.ctx.net?.send({ t: 'ally', ev: 'drop', id: a.id, p: tup(a.position), yaw: round(a.yaw) }, 'others');
}

/** The revive hold finished on a replica → the host looks at the distance · state again. */
export function sendReviveRequest(sys: AllySystem, id: AllyId, defib: boolean): boolean {
  if (!live(sys)) return false;
  sys.ctx.net?.send(defib ? { t: 'allyq', ev: 'revive', id, defib: 1 } : { t: 'allyq', ev: 'revive', id }, 'host');
  return true;
}

/** An android got a person up — directly when that person is the host itself, otherwise `ally revive`. */
export function revivePlayer(sys: AllySystem, a: Ally, target: PeerId, defib: boolean): void {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? 'local';
  if (target === localId) {
    ctx.player?.revive();
    if (defib) ctx.player?.applyStim(ctx.player.maxHp);
    return;
  }
  if (!live(sys)) return;
  ctx.net?.send(defib ? { t: 'ally', ev: 'revive', id: a.id, target, defib: 1 } : { t: 'ally', ev: 'revive', id: a.id, target }, target);
}

/** An extracted unit's loot goes to the squad leader's stash — one event when the leader is this client. */
export function depositToLeader(sys: AllySystem, a: Ally, items: readonly ItemInstance[]): void {
  if (items.length === 0) return;
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? 'local';
  if (sys.leaderId === localId || !live(sys)) {
    ctx.bus.emit('inventory:allyDeposit', { id: a.id, name: a.name, items: items.slice() });
    return;
  }
  ctx.net?.send({ t: 'ally', ev: 'deposit', id: a.id, to: sys.leaderId, items: items.slice() }, sys.leaderId);
}

/* ═══════════════════════════ Receiving ═══════════════════════════ */

function fromHost(sys: AllySystem, from: PeerId): boolean {
  const host = sys.ctx.net?.lobby?.hostId ?? null;
  return !!host && from === host;
}

function onAlly(sys: AllySystem, msg: Extract<GameMessage, { t: 'ally' }>, from: PeerId): void {
  if (!fromHost(sys, from)) return;             // host authority — an android state sent by anyone else is dropped
  switch (msg.ev) {
    case 'state': {
      for (const w of msg.allies) applyWire(sys, w);
      break;
    }
    case 'bag': {
      const a = sys.byId.get(msg.id);
      if (!a) break;
      a.equip.primary = msg.equip.primary;
      a.equip.armor = msg.equip.armor;
      a.equip.bag = msg.equip.bag;
      a.wireItems = msg.items.slice();
      a.kitUids.clear();
      for (const uid of msg.kit) a.kitUids.add(uid);
      break;
    }
    case 'fire': {
      const a = sys.byId.get(msg.id);
      if (!a) break;
      sys.fireFrom.set(msg.from[0], msg.from[1], msg.from[2]);
      sys.fireTo.set(msg.to[0], msg.to[1], msg.to[2]);
      sys.ctx.bus.emit('ally:fired', { id: a.id, from: sys.fireFrom, to: sys.fireTo, weaponDefId: msg.w });
      break;
    }
    case 'ping': {
      const a = sys.byId.get(msg.id);
      if (!a) break;
      sys.fireFrom.set(msg.p[0], msg.p[1], msg.p[2]);
      sys.ctx.bus.emit('ally:ping', {
        id: a.id, name: a.name, slot: a.slot, kind: msg.kind, position: sys.fireFrom,
        label: msg.label, enemyId: msg.enemyId,
      });
      break;
    }
    case 'chat': {
      const a = sys.byId.get(msg.id);
      if (a) sys.ctx.bus.emit('ally:chat', { id: a.id, name: a.name, slot: a.slot, text: msg.text });
      break;
    }
    case 'drop': {
      const a = sys.byId.get(msg.id);
      if (!a) break;
      sys.fireFrom.set(msg.p[0], msg.p[1], msg.p[2]);
      a.mode = 'raid';
      a.position.copy(sys.fireFrom);
      a.yaw = msg.yaw;
      a.hidden = true;
      sys.ctx.bus.emit('ally:podDrop', { id: a.id, position: sys.fireFrom, yaw: msg.yaw });
      break;
    }
    case 'deposit': {
      // Loot that arrived because this client is the squad leader — inventory puts it in the stash.
      const a = sys.byId.get(msg.id);
      sys.ctx.bus.emit('inventory:allyDeposit', { id: msg.id, name: a?.name ?? msg.id, items: msg.items });
      break;
    }
    default:
      break;
  }
}

function onAllyq(sys: AllySystem, msg: Extract<GameMessage, { t: 'allyq' }>, from: PeerId): void {
  if (!sys.simulating) return;                  // only the host handles requests
  switch (msg.ev) {
    case 'sync': {
      const allies: AllyWire[] = [];
      for (const a of sys.bodies) if (a.mode === 'raid') allies.push(encode(a));
      sys.ctx.net?.send({ t: 'ally', ev: 'state', allies }, from);
      for (const a of sys.bodies) if (a.mode === 'raid') sendBag(sys, a);
      break;
    }
    case 'revive': {
      const a = sys.byId.get(msg.id);
      if (!a || !a.downed || a.dead) break;
      const rp = sys.ctx.net?.getRemotePlayer(from);
      // The host looks at the distance again — a request sent from far away is dropped.
      if (rp && rp.position.distanceTo(a.position) > sys.reviveRange) break;
      Vitals.revive(sys, a, from);
      break;
    }
    case 'item':
      Commands.onRemoteItemRequest(sys, from, msg);
      break;
    case 'viewing':
      Commands.onContainerViewed(sys, msg.containerId);
      break;
    default:
      break;
  }
}

/* ═══════════════════════════ Replica interpolation ═══════════════════════════ */

function applyWire(sys: AllySystem, w: AllyWire): void {
  if (!isAndroidId(w.id)) return;
  const a = sys.byId.get(w.id);
  if (!a) return;
  a.wirePrev.copy(a.position);
  a.wirePrevYaw = a.yaw;
  a.wireNext.set(w.p[0], w.p[1], w.p[2]);
  a.wireNextYaw = w.y;
  a.wireAt = sys.ctx.time;
  a.wireSpan = Math.max(ALLY_NET_INTERVAL_S, NET_INTERP_DELAY);
  a.mode = ALLY_MODES[w.md] ?? 'raid';
  a.state = ALLY_STATES[w.st] ?? 'idle';
  a.pose = ALLY_POSES[w.po] ?? 'stand';
  a.velocity.set(w.v[0], w.v[1], w.v[2]);
  a.pitch = w.pt;
  const hadHp = a.hp;
  a.hp = w.hp; a.maxHp = w.mhp; a.shield = w.sh; a.maxShield = w.msh;
  a.downHp = w.dhp;
  const wasDowned = a.downed;
  a.downed = w.dhp > 0;
  a.dead = w.hp <= 0 && w.dhp <= 0 && a.pose === 'dead';
  a.hidden = (w.f & ALLY_FLAGS.HIDDEN) !== 0;
  a.flags = w.f;
  a.weaponDefId = w.w; a.armorDefId = w.a; a.bagDefId = w.b;
  a.carrying = w.c;
  if (w.lk) { a.lookVec.set(w.lk[0], w.lk[1], w.lk[2]); a.lookAt = a.lookVec; } else a.lookAt = null;
  if (w.hp < hadHp) sys.ctx.bus.emit('ally:damaged', { id: a.id, amount: hadHp - w.hp, hp: w.hp, shield: w.sh });
  if (!wasDowned && a.downed) sys.ctx.bus.emit('ally:downed', { id: a.id, name: a.name });
  if (wasDowned && !a.downed && !a.dead) sys.ctx.bus.emit('ally:revived', { id: a.id, by: null });
}

export function updateReplicas(sys: AllySystem, dt: number): void {
  for (const a of sys.bodies) {
    if (a.mode !== 'raid' || a.wireSpan <= 0) continue;
    const t = Math.min(1, (sys.ctx.time - a.wireAt) / a.wireSpan);
    a.position.lerpVectors(a.wirePrev, a.wireNext, t);
    let d = a.wireNextYaw - a.wirePrevYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    a.yaw = a.wirePrevYaw + d * t;
    const v = Math.hypot(a.velocity.x, a.velocity.z);
    a.moveBlend = Math.min(1, v / 4);
    a.stridePhase = (a.stridePhase + v * dt) % 1;
  }
}

/** The host changed — the new host picks up from the last snapshot · bag, the demoted one becomes a replica. */
export function onHostChanged(sys: AllySystem, isLocalHost: boolean): void {
  if (isLocalHost) {
    for (const a of sys.bodies) {
      if (a.mode !== 'raid') continue;
      // Takes over the last state received as it is and restarts only the AI (the body · bag are already known
      // from `ally bag`).
      a.pendingState = null;
      a.pendingT = 0;
      a.statePrio = 0;
      a.stuckT = 0;
      a.hasDest = false;
      a.targetEnemyId = null;
      if (!a.bag) {
        const bagDef = Bag.defOf(sys, a.bagDefId)?.bag;
        a.bag = sys.ctx.inventory?.createAllyBag?.(bagDef?.cols ?? 0, bagDef?.rows ?? 0) ?? null;
        if (a.bag) for (const it of a.wireItems) a.bag.autoPlace(it);
      }
      a.bagDirty = true;
    }
    sys.netTimer = 0;
  } else {
    for (const a of sys.bodies) { a.pendingState = null; a.pendingT = 0; }
  }
}

/** A late join · a reconnect — asks the host for the current state. */
export function askSync(sys: AllySystem): void {
  if (!live(sys) || sys.simulating) return;
  sys.ctx.net?.send({ t: 'allyq', ev: 'sync' }, 'host');
}
