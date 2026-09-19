/**
 * src/gadgets/drones/parts/Wire.ts — **drone networking: owner-authoritative (`drone` / `droneq`).**
 *
 * Unlike deployables (`gad`), **the controlling hand is the authority**. The owner sends `drone spawn` /
 * `state` (`DRONE_NET_HZ`) / `remove` to `'others'`, and everyone else (the host included) interpolates and draws a
 * replica. When the host's enemies hit a drone, `droneq damage` goes to the owner. A late joiner asks `droneq sync`
 * of `'others'` on `world:ready`, and each owner answers that peer alone with its own drone list (`drone sync`).
 */
import {
  DRONE_NET_HZ, type DroneMessage, type DroneRequest, type DroneWire, type PeerId,
} from '@/shared';
import { _w0, angleDelta, Drone, DRONE_REPLICA_SNAP_DIST, DRONE_SYNC_RETRY_S, droneMaxHp } from '../model';
import type { DroneSystem } from '../DroneSystem';
import { addDrone, applyOwnDamage, createBody, destroyFx, removeDrone } from './Lifecycle';
/* appended (2026-09-12): a squadmate's scan results (`drone scan`) */
import { onRemoteScan } from './Scan';

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export function ensureNetHooks(sys: DroneSystem): void {
  const net = sys.ctx.net;
  if (!net || sys.netHooked) return;
  sys.netHooked = true;
  sys.unsubs.push(
    net.onMessage('drone', (m, from) => onDroneMessage(sys, m, from)),
    net.onMessage('droneq', (m, from) => onDroneRequest(sys, m, from)),
  );
}

/**
 * When replicas may be accepted — only while the raid world stands (anything that arrives in the ship or during
 * loading is dropped and comes back through the `world:ready` sync).
 */
function accepting(sys: DroneSystem): boolean {
  const ctx = sys.ctx;
  return ctx.isMultiplayer && !!ctx.world?.ready && ctx.isRaidActive();
}

export function wireOf(sys: DroneSystem, d: Drone): DroneWire {
  return {
    id: d.id,
    kind: d.kind,
    owner: sys.ctx.net?.localId ?? 'sp',
    p: [r2(d.position.x), r2(d.position.y), r2(d.position.z)],
    yaw: r3(d.yaw),
    hp: Math.ceil(d.hp),
    maxHp: d.maxHp,
    fl: d.ownFlags(),
  };
}

export function sendSpawn(sys: DroneSystem, d: Drone): void {
  const ctx = sys.ctx;
  if (!ctx.isMultiplayer || !ctx.net) return;
  ctx.net.send({ t: 'drone', ev: 'spawn', d: wireOf(sys, d) }, 'others');
  d.netNextAt = ctx.time + 1 / Math.max(1, DRONE_NET_HZ);
  d.netDirty = false;
}

export function sendRemove(sys: DroneSystem, id: string, reason: 'destroyed' | 'recovered' | 'expired'): void {
  const ctx = sys.ctx;
  if (!ctx.isMultiplayer || !ctx.net) return;
  ctx.net.send({ t: 'drone', ev: 'remove', id, reason }, 'others');
}

/** Owner: sends the pose at `DRONE_NET_HZ` (immediately right after damage · a control switch). */
export function maybeSendState(sys: DroneSystem, d: Drone): void {
  const ctx = sys.ctx;
  if (!ctx.isMultiplayer || !ctx.net) return;
  if (ctx.time < d.netNextAt && !d.netDirty) return;
  d.netNextAt = ctx.time + 1 / Math.max(1, DRONE_NET_HZ);
  d.netDirty = false;
  const fl = d.ownFlags();
  d.flags = fl;
  const p = d.position;
  ctx.net.send({ t: 'drone', ev: 'state', id: d.id, p: [r2(p.x), r2(p.y), r2(p.z)], yaw: r3(d.yaw), hp: Math.ceil(d.hp), fl }, 'others');
}

/* ═══════════════════════════ replica ═══════════════════════════ */
/** Eases from the pose drawn now to the new sample over the sample interval. A long jump teleports instead. */
function pushSample(sys: DroneSystem, d: Drone, x: number, y: number, z: number, yaw: number): void {
  const now = sys.ctx.time;
  _w0.set(x, y, z);
  const first = d.lastSampleAt < 0;
  if (first || _w0.distanceTo(d.body.position) > DRONE_REPLICA_SNAP_DIST) {
    d.fromPos.copy(_w0); d.fromYaw = yaw;
    d.lerpDur = 0;
  } else {
    d.fromPos.copy(d.body.position); d.fromYaw = d.body.yaw;
    const nominal = 1 / Math.max(1, DRONE_NET_HZ);
    d.lerpDur = Math.max(nominal * 0.5, Math.min(0.25, now - d.lastSampleAt));
  }
  d.toPos.copy(_w0); d.toYaw = yaw;
  d.lerpT0 = now;
  d.lastSampleAt = now;
}

export function updateReplica(sys: DroneSystem, d: Drone): void {
  const a = d.lerpDur > 0 ? Math.max(0, Math.min(1, (sys.ctx.time - d.lerpT0) / d.lerpDur)) : 1;
  d.renderPos.lerpVectors(d.fromPos, d.toPos, a);
  d.body.applyRemote(d.renderPos, d.fromYaw + angleDelta(d.fromYaw, d.toYaw) * a, d.flags);
}

function applyReplicaHp(sys: DroneSystem, d: Drone, hp: number): void {
  if (hp === d.hp) return;
  const hurt = hp < d.hp;
  d.hp = hp;
  if (hurt) sys.ctx.bus.emit('audio:play', { id: 'drone_hit', position: d.position, volume: 0.5 });
  sys.ctx.bus.emit('drone:damaged', { id: d.id, hp: d.hp, maxHp: d.maxHp, own: false });
}

function spawnReplica(sys: DroneSystem, w: DroneWire, from: PeerId): Drone | null {
  const ctx = sys.ctx;
  if (sys.byId.has(w.id)) return null;
  if (w.kind !== 'ground' && w.kind !== 'air') return null;
  const body = createBody(w.kind);
  _w0.set(w.p[0], w.p[1], w.p[2]);
  body.reset(_w0, w.yaw, ctx);
  ctx.scene.add(body.root);
  const maxHp = w.maxHp > 0 ? w.maxHp : droneMaxHp(w.kind);
  const d = new Drone(ctx, w.id, w.kind, from, body, Math.max(0, Math.min(maxHp, w.hp)), maxHp);
  d.flags = w.fl | 0;
  pushSample(sys, d, w.p[0], w.p[1], w.p[2], w.yaw);
  body.applyRemote(_w0, w.yaw, d.flags);
  addDrone(sys, d);
  ctx.bus.emit('drone:deployed', { id: d.id, kind: d.kind, owner: from, position: d.position });
  return d;
}

/** Owner → others. */
export function onDroneMessage(sys: DroneSystem, m: DroneMessage, from: PeerId): void {
  if (!accepting(sys)) return;
  const ctx = sys.ctx;
  switch (m.ev) {
    case 'spawn': {
      const d = spawnReplica(sys, m.d, from);
      if (d) {
        d.fxPos.copy(d.position);
        ctx.bus.emit('audio:play', { id: 'drone_deploy', position: d.fxPos, volume: 0.7 });
      }
      break;
    }
    case 'state': {
      const d = sys.byId.get(m.id);
      if (!d) { askSync(sys, from); return; }
      if (d.isLocal || d.owner !== from || d.removing) return;
      d.flags = m.fl | 0;
      pushSample(sys, d, m.p[0], m.p[1], m.p[2], m.yaw);
      applyReplicaHp(sys, d, Math.max(0, Math.min(d.maxHp, m.hp)));
      break;
    }
    case 'remove': {
      const d = sys.byId.get(m.id);
      if (!d || d.isLocal || d.owner !== from) return;
      if (m.reason === 'destroyed') destroyFx(sys, d);
      else if (m.reason === 'recovered') {
        d.fxPos.copy(d.position);
        ctx.bus.emit('audio:play', { id: 'drone_recover', position: d.fxPos, volume: 0.6 });
      }
      removeDrone(sys, d, m.reason, false);
      break;
    }
    case 'sync': {
      // That owner's full drone list — what is missing is removed, what is there is updated or newly created
      for (let i = sys.drones.length - 1; i >= 0; i--) {
        const d = sys.drones[i];
        if (d.owner !== from) continue;
        let keep = false;
        for (const w of m.items) if (w.id === d.id) { keep = true; break; }
        if (!keep) removeDrone(sys, d, 'expired', false);
      }
      for (const w of m.items) {
        const d = sys.byId.get(w.id);
        if (!d) { spawnReplica(sys, w, from); continue; }
        if (d.isLocal || d.owner !== from) continue;
        d.flags = w.fl | 0;
        pushSample(sys, d, w.p[0], w.p[1], w.p[2], w.yaw);
        applyReplicaHp(sys, d, Math.max(0, Math.min(d.maxHp, w.hp)));
      }
      sys.syncAskedAt.delete(from);
      break;
    }
    case 'scan':
      // 2026-09-12: display only — shape · lobby membership · rate · the sender's ground-drone distance are all
      // checked by `Scan.onRemoteScan`
      onRemoteScan(sys, m, from);
      break;
  }
}

/** Any → owner (`damage`) / any → others (`sync`). */
export function onDroneRequest(sys: DroneSystem, m: DroneRequest, from: PeerId): void {
  const ctx = sys.ctx;
  if (!ctx.isMultiplayer || !ctx.net) return;
  switch (m.ev) {
    case 'damage': {
      const d = sys.byId.get(m.id);
      if (!d || !d.isLocal || !accepting(sys)) return;
      const dmg = Number(m.dmg);
      if (!Number.isFinite(dmg) || dmg <= 0) return;
      applyOwnDamage(sys, d, Math.min(dmg, d.maxHp));
      break;
    }
    case 'sync': {
      let items: DroneWire[] | null = null;
      for (const d of sys.drones) {
        if (!d.isLocal || d.removing) continue;
        (items ??= []).push(wireOf(sys, d));
      }
      if (items) ctx.net.send({ t: 'drone', ev: 'sync', items }, from);
      break;
    }
  }
}

/** A `state` for an unknown drone — its spawn was missed. To that owner only, once per `DRONE_SYNC_RETRY_S`. */
function askSync(sys: DroneSystem, owner: PeerId): void {
  const ctx = sys.ctx;
  const last = sys.syncAskedAt.get(owner);
  if (last !== undefined && ctx.time - last < DRONE_SYNC_RETRY_S) return;
  sys.syncAskedAt.set(owner, ctx.time);
  ctx.net?.send({ t: 'droneq', ev: 'sync' }, owner);
}
