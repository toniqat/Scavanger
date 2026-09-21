/**
 * src/enemies/parts/Pool.ts — **the enemy instance pool**.
 *
 * Enemies are borrowed from fixed pools rather than created and destroyed (`acquire` / `release`) — to avoid per-frame
 * allocation, which is why the id reuse rule (`find`) and growing the capacity (`ensureCapacity`) belong in one place.
 * The mission reset (`reset`) and disposing the geometry (`disposePools`) are this file's job too.
 */
import * as THREE from 'three';
import {
  type EnemyEvent, type EnemyType, type HumanoidSpawnOpts,
} from '@/shared';
import { Enemy } from '../Enemy';
import { ROGUE_AI, isEggType, isWormType } from '../EnemyTypes';
import { disposeBugAssets } from '../models/BugModel';
import { disposeRogueAssets } from '../models/RogueModel';
import { round, tuple } from '../net/HostSync';
import type {  } from '../RogueGuards';
import { disposeRogueDropAssets } from '../RogueDrop';
import { CORPSE_SLACK, RECYCLE_DISTANCE, _aim, _c, _dir, _eye, _hc, _hd, _hp, _kb, _m, _sd, _sh, _so, _to, _v, _v2, _zero } from '../model';
import type { EnemySystem } from '../EnemySystem';
import { rollGrenadeLoadout } from '../ai/HumanoidProfile';
import { isNamedAiType } from '../ai/named';
/* appended (2026-09-13): the dig-in spawn · the sandworm */
import { emergeFx } from './Burrow';
import { disposeWormAssets } from '../models/WormModel';
/* appended (2026-09-18): bug eggs */
import { disposeEggAssets } from '../models/EggModel';
import { applyEggSize } from '../NestDirector';

export function killAll(sys: EnemySystem): void {
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (e.active && e.state !== 'dead') e.kill(false);
  }
  }

export function reset(sys: EnemySystem): void {
  sys.resetting = true;
  sys.lures.clear();
  sys.xray.clear();
  for (let i = sys.active.length - 1; i >= 0; i--) sys.despawn(sys.active[i]);
  sys.active.length = 0;
  sys.byId.clear();
  sys.waves.reset();
  sys.spawner.reset();
  sys.replicaMgr.clear();
  sys.targets.clear();
  sys.corpses.clear();
  sys.rogueDrops.reset();     // 2026-09-09: the roll record (once per zone) restarts every raid too
  sys.sandworm.reset();       // 2026-09-13: the sandworm roll · its omen · the meta it held, every raid too
  sys.burrowFx?.clear();
  sys.burrowShakeAt = -Infinity;
  sys.named.reset();          // 2026-09-11: the named roll · its announcement record, every raid too (a named and its escort are rogues, so `ensureCapacity` never recycles them)
  sys.nests.reset();          // 2026-09-18: the nest anchors · refill rolls · garrison record, every raid too
  sys.fx?.clear();
  sys.acid?.clear();
  sys.shells?.clear();
  sys.grenades?.clear();
  sys.lastAudio.clear();
  sys.snapTimer = 0;
  sys.hazardTick = 0;
  sys.snapCache.reset();
  sys.bossId = 0;
  sys.nextSquadId = 1;        // 2026-09-13: a squad id is unique within one raid only (site groups · drop waves · the Heavy's squad)
  sys.sitePlacement = null;   // 2026-09-13: the site occupation record (debug · smokes)
  sys.lastClash = -Infinity;
  sys.training = false;
  sys.tutorial = false;             // 2026-09-14: `world:ready` decides it afresh every mission
  sys.tutorialPlacement = null;     // 2026-09-14: the tutorial's fixed placement record (debug · smokes)
  sys.wavesSeen = 0;
  sys.grenadesThrown = 0;
  sys.grenadesExploded = 0;
  sys.resetting = false;
  }

/* ── SpawnHost ─────────────────────────────────────────────────────────── */
export function aliveCount(sys: EnemySystem): number {
  let n = 0;
  for (let i = 0; i < sys.active.length; i++) { const e = sys.active[i]; if (e.isCombatant) n++; }
  return n;
  }

/**
 * The **living bodies** a per-type cap (artillery · behemoth) counts. 2026-09-17 (the two-artillery bug): it used to
 * count by `isCombatant`, which **leaves out** a body writhing in the incinerated state (`incapTimer > 0`) and one
 * fleeing the liftoff (`flee`, gone only after `FLEE_DURATION`) — and a patrol tick inside those few seconds dug a
 * second artillery in on a planet capped at 1. The cap means "bodies standing in the world now", so every body that is
 * not dead counts.
 */
export function countAlive(sys: EnemySystem, type: EnemyType): number {
  let n = 0;
  for (let i = 0; i < sys.active.length; i++) { const e = sys.active[i]; if (e.type === type && e.active && e.state !== 'dead') n++; }
  return n;
  }

export function ensureCapacity(sys: EnemySystem, n: number, cap: number): number {
  // 1) recycle far, unseen, unaware bugs when the alive cap is tight (rogue guards stay)
  let alive = sys.aliveCount();
  if (alive + n > cap && sys.targets.all.length > 0) {
    for (let i = sys.active.length - 1; i >= 0 && alive + n > cap; i--) {
      const e = sys.active[i];
      if (!e.active || e.state === 'dead' || e.aware || e.relentless || e.isHumanoid) continue;
      if (e.escortOf && e.escortOf.isCombatant) continue;   // 2026-09-17: a living artillery's escort stays with it (`ai/ArtilleryPack`)
      /* 2026-09-18: a nest egg is never recycled — its spot belongs to the world, and losing it loses 「the nest's
         reward」. (`isCombatant` is false for it, so the `aware` test above never catches it, but this loop does not
         read that.) */
      if (e.isEgg) continue;
      if (sys.targets.minDist(e.position) > RECYCLE_DISTANCE) { sys.despawn(e); alive--; }
    }
  }
  // 2) recycle oldest corpses so total entity count stays bounded
  let total = sys.active.length;
  if (total + n > cap + CORPSE_SLACK) {
    let oldest: Enemy | null;
    do {
      oldest = null;
      for (let i = 0; i < sys.active.length; i++) {
        const e = sys.active[i];
        if (e.state === 'dead' && (!oldest || e.deathTimer > oldest.deathTimer)) oldest = e;
      }
      if (oldest) { sys.despawn(oldest); total--; }
    } while (oldest && total + n > cap + CORPSE_SLACK);
  }
  return Math.max(0, Math.min(n, cap - alive));
  }

/** `emerge` (2026-09-13) > 0 = the bug digs up out of the ground over that many seconds (`Enemy.startEmerge` + FX + `ee spawn.em`). Ignored for humanoids. */
export function spawn(sys: EnemySystem, type: EnemyType, position: THREE.Vector3, yaw: number, chase: boolean, relentless: boolean, emerge = 0): Enemy | null {
  const ctx = sys.ctx;
  const e = sys.acquire(sys.nextId++, type, position, yaw);
  if (!e) return null;
  e.relentless = relentless;
  if (chase) { e.aware = true; e.state = 'chase'; e.perceptionTimer = 0.3 + Math.random() * 0.3; }
  const em = emerge > 0 && e.faction === 'bug' ? emerge : 0;
  if (em > 0) { e.startEmerge(em); emergeFx(sys, e); }
  ctx.bus.emit('enemy:spawned', { id: e.id, type, position: e.position });
  if (sys.hosting) {
    const msg: Extract<EnemyEvent, { ev: 'spawn' }> = { t: 'ee', ev: 'spawn', id: e.id, ty: type, p: tuple(e.position, 2), yaw: round(yaw, 3) };
    if (em > 0) msg.em = round(em, 2);
    ctx.net!.send(msg, 'others');
  }
  return e;
  }

/* ── RogueSpawnHost ────────────────────────────────────────────────────── */
export function spawnRogue(sys: EnemySystem, type: EnemyType, position: THREE.Vector3, yaw: number, guardPos: THREE.Vector3, weaponId: string, escortOf: Enemy | null, opts?: HumanoidSpawnOpts): Enemy | null {
  const e = sys.spawn(type, position, yaw, false, false);
  if (!e) return null;
  e.guardPos.copy(guardPos);
  e.weaponId = weaponId;
  e.escortOf = escortOf;
  if (escortOf) e.leash = ROGUE_AI.escortLeash;
  // 2026-09-13 (the contract): site · squad · role. The grenade loadout (`grenadeKind` / `grenadeCount`) is rolled here by the humanoid AI owner.
  e.site = opts?.site ?? null;
  e.squadId = opts?.squadId ?? -1;
  e.squadRole = opts?.role ?? 'member';
  // 1–3 and the kind, from the faction table (`HUMANOID_*.grenadeMin/Max · incendiaryChance`). An android gets 0; a named and the scan drone have no throwing AI, so 0.
  rollGrenadeLoadout(e, isNamedAiType(type));
  return e;
  }

/* ── ReplicaHost ───────────────────────────────────────────────────────── */
export function find(sys: EnemySystem, id: number): Enemy | undefined { return sys.byId.get(id); }

/** Pool → active with an explicit id (host-assigned on the authority, host's id on replicas). Silent. */
export function acquire(sys: EnemySystem, id: number, type: EnemyType, position: THREE.Vector3, yaw: number): Enemy | null {
  const ctx = sys.ctx;
  if (!ctx.world?.ready) return null;
  let pool = sys.pools.get(type);
  if (!pool) { pool = []; sys.pools.set(type, pool); }
  let e = pool.pop();
  if (!e) {
    e = new Enemy(type);
    e.bindHost(sys);
  }
  if (!e.rig.root.parent) ctx.scene.add(e.rig.root);
  e.reset(id, position, yaw, ctx.time);
  // 2026-09-14: bug hp by planet threat (`BUG_HP_MUL_BY_THREAT`). Both an authority spawn (`spawn`) and a replica
  // (`ee spawn` · an id a snapshot saw first) come through here, and every client fixes the multiplier from the same
  // planet on `world:ready` — so a replica's `maxHp` (hit shake · the hp cap on promotion) matches the host with no wire
  // field. Humanoid factions and the sandworm (its own `SANDWORM_HP_*` roll) are excluded; the training range and no
  // planet are ×1.
  const hpMul = sys.bugTuning.hpMul;
  if (hpMul !== 1 && e.faction === 'bug' && !isWormType(type)) e.hp = e.maxHp = Math.max(1, Math.round(e.stats.hp * hpMul));
  /* 2026-09-18 (bug eggs): the size differs per spot. It is matched with no wire field by **the same trick** as the hp
     multiplier above — the world is built identically on every client from the same seed, so the authority and a replica
     both find the same spot in `getNestEggSpots()` and put in the same radius (`NestDirector.applyEggSize`). That is why
     `ee spawn` has no radius field. */
  if (isEggType(type) && ctx.world) applyEggSize(e, ctx.world);
  // 2026-09-14 (4th pass): this raid's corpse lifetime (it overwrites the `CORPSE_LIFETIME` `reset` put in). Only the
  // tutorial is `Infinity`, so the main game · training range keep their 45 s, and a replica uses the same value (every
  // client decides the raid kind together on `world:ready`).
  e.corpseLife = sys.corpseLifetime;
  sys.active.push(e);
  sys.byId.set(id, e);
  return e;
  }

export function release(sys: EnemySystem, e: Enemy): void { sys.despawn(e); }

export function despawn(sys: EnemySystem, e: Enemy): void {
  sys.xray.remove(e);
  if (sys.hosting && !sys.resetting && e.active) sys.ctx.net!.send({ t: 'ee', ev: 'despawn', id: e.id }, 'others');
  if (!sys.resetting && sys.corpses.remove(e.id) && sys.hosting) sys.ctx.net!.send({ t: 'ee', ev: 'corpseGone', id: e.id }, 'others');
  const idx = sys.active.indexOf(e);
  if (idx >= 0) {
    const last = sys.active.length - 1;
    sys.active[idx] = sys.active[last];
    sys.active.pop();
  }
  if (sys.byId.get(e.id) === e) sys.byId.delete(e.id);
  e.deactivate();
  let pool = sys.pools.get(e.type);
  if (!pool) { pool = []; sys.pools.set(e.type, pool); }
  pool.push(e);
  }

export function disposePools(sys: EnemySystem): void {
  sys.xray.dispose();   // overlays are children of the pooled rigs — detach before the rigs go
  for (const pool of sys.pools.values()) { for (const e of pool) e.dispose(); pool.length = 0; }
  sys.pools.clear();
  sys.rogueDrops.dispose(sys.ctx.scene);   // 2026-09-09: the drop pods leave the scene in the same reset
  disposeBugAssets();
  disposeRogueAssets();
  disposeRogueDropAssets();
  disposeWormAssets();        // 2026-09-13: the sandworm's shared geometry (the rigs went first, in the pool dispose above)
  disposeEggAssets();         // 2026-09-18: the bug egg's shared geometry
  }
