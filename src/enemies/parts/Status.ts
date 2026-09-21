/**
 * src/enemies/parts/Status.ts — **status effects**: burning · incinerated · shocked · slowed, and the recon scan's
 * **x-ray silhouette**.
 *
 * The host owns the status and mirrors it to a replica in the `EnemyWire.sb` bits. A replica cannot apply one itself,
 * so it **requests** it as `hit {dmg:0, st, dur}` (`requestStatus`). A DoT kill credits whoever lit the fire.
 */
import * as THREE from 'three';
import {
  BURNOUT_DURATION, ENEMY_STATUS_BITS, FLAME_AFTERBURN_DPS, FLAME_AFTERBURN_DURATION, SHOCK_SLOW_DURATION, SHOCK_SLOW_FACTOR, HAZARD_ENEMY_DPS, HAZARD_TICK_S,
  type EnemyStatusKind, type HitRequest,
} from '@/shared';
import { Enemy } from '../Enemy';
import { round, tuple } from '../net/HostSync';
import { BURN_TICK, EMBER_INTERVAL, INCAP_EMBER_INTERVAL, MAX_STATUS_DURATION, SHOCK_SPARK_TIME, SPARK_INTERVAL, STATUS_REQUEST_INTERVAL, _aim, _c, _dir, _eye, _hc, _hd, _hp, _kb, _m, _sd, _sh, _so, _to, _v, _v2, _zero } from '../model';
import { humanoidPainSound, hurtSound } from '../model';
import type { EnemySystem } from '../EnemySystem';

/**
 * 정찰 x-ray: red through-wall silhouette for these enemies (simulated or replica) for `seconds`; a second call
 * extends. Unknown ids are ignored; `seconds <= 0` hides the listed ones (`[]` + 0 is a no-op).
 */
export function setXray(sys: EnemySystem, ids: readonly number[], seconds: number): void {
  const until = sys.ctx.time + seconds;
  for (let i = 0; i < ids.length; i++) {
    const e = sys.byId.get(ids[i]);
    if (!e || !e.active) continue;
    if (!(seconds > 0)) { sys.xray.remove(e); continue; }
    if (e.state === 'dead') continue;
    sys.xray.show(e, until);
  }
  }

/**
 * Apply a status effect. `burning` deals `dps` damage (in 0.5 s ticks) for `duration` seconds and
 * spits embers; `slowed` reads `dps` as the fraction of speed removed (0.4 → 60 % speed), clamped to 0.2…1.
 * `incinerated` (2026-09-06): `duration` s of writhing on the spot — no movement / attacks, still damageable —
 * `isIncapacitated`, faster embers, `enemy:incinerated`; `dps` is ignored. `shocked`: `dps` is the **speed
 * multiplier** (0..1, `SHOCK_SLOW_FACTOR` = 55 % speed) for `duration` s, plus a cyan spark strobe and
 * `enemy:shocked` (emitted once per shock, not per tick — the arc calls this every frame).
 * `dps` 0 (or `duration` 0 for incineration) clears the effect. Visuals run everywhere; gameplay only on the authority:
 * a replica keeps the optimistic visual and forwards the request to the host as `hit {dmg: 0, st, dur}`
 * (`ENEMY_STATUS_BITS`), throttled per enemy for the continuous callers.
 */
export function applyStatus(sys: EnemySystem, id: number, status: EnemyStatusKind, dps: number, duration: number, attacker?: string): void {
  const e = sys.byId.get(id);
  if (!e || !e.active || e.state === 'dead') return;
  // Phase 9: the fire's owner gets the burn-kill credit (host side only; a replica's request carries it as the relay `from`)
  if (attacker !== undefined && !sys.replica && (status === 'burning' || status === 'incinerated') && (status === 'incinerated' ? duration > 0 : dps > 0)) {
    e.burnAttacker = sys.normalizeAttacker(attacker);
  }
  switch (status) {
    case 'incinerated': {
      if (!(duration > 0)) { e.incapTimer = 0; return; }
      if (sys.replica) {
        sys.requestStatus(e, ENEMY_STATUS_BITS.INCINERATED, duration);
        if (e.incapTimer <= 0) sys.ctx.bus.emit('enemy:incinerated', { id: e.id, position: e.position, duration });
        e.incapTimer = Math.max(e.incapTimer, duration);
        return;
      }
      sys.incinerate(e, duration);
      return;
    }
    case 'shocked': {
      if (!(duration > 0) || !(dps > 0)) { e.shockTimer = 0; e.slowFactor = 1; e.slowTimer = 0; return; }
      if (sys.replica) sys.requestStatus(e, ENEMY_STATUS_BITS.SHOCKED, duration);
      const factor = THREE.MathUtils.clamp(dps, 0.2, 1);
      e.slowFactor = Math.min(e.slowFactor, factor);
      e.slowTimer = Math.max(e.slowTimer, duration);
      if (e.shockTimer <= 0) {
        sys.ctx.bus.emit('enemy:shocked', { id: e.id, position: e.position });
        sys.playAudio(hurtSound(e.type), e.position, 0.35, 1.6);   // 2026-09-11 (C-51): a rogue uses hit_flesh
        e.sparkTimer = 0;
      }
      e.shockTimer = Math.max(e.shockTimer, Math.min(duration, SHOCK_SPARK_TIME));
      return;
    }
    case 'burning': {
      if (dps <= 0) { e.burnDps = 0; e.burnTimer = 0; return; }
      if (sys.replica) sys.requestStatus(e, ENEMY_STATUS_BITS.BURNING, duration);
      e.burnDps = Math.max(e.burnDps, dps);
      e.burnTimer = Math.max(e.burnTimer, duration);
      if (e.burnTick <= 0) e.burnTick = BURN_TICK;
      return;
    }
    default: {
      if (dps <= 0) { e.slowFactor = 1; e.slowTimer = 0; return; }
      if (sys.replica) sys.requestStatus(e, ENEMY_STATUS_BITS.SLOWED, duration);
      const factor = THREE.MathUtils.clamp(dps <= 1 ? 1 - dps : 1 / dps, 0.2, 1);
      e.slowFactor = Math.min(e.slowFactor, factor);
      e.slowTimer = Math.max(e.slowTimer, duration);
    }
  }
  }

/** Authority: put `e` into the incinerated state for `duration` s (event, scream, ember burst). */
export function incinerate(sys: EnemySystem, e: Enemy, duration: number): void {
  const fresh = e.incapTimer <= 0;
  e.incinerate(duration);
  if (!e.isIncapacitated) return;
  if (fresh) {
    sys.ctx.bus.emit('enemy:incinerated', { id: e.id, position: e.position, duration });
    if (e.isHumanoid) { const pv = humanoidPainSound(e.type); sys.playAudio(pv.id, e.position, 0.8, pv.pitch); }   // 2026-09-13: an android = a malfunction sound
    else sys.playAudio('bug_screech', e.position, 0.9, e.type === 'behemoth' ? 0.5 : e.type === 'charger' ? 0.7 : 1.35);
    _v.set(e.position.x, e.position.y + e.stats.height * 0.6, e.position.z);
    sys.emberBurst(_v, 14);
    e.sparkTimer = 0;
  }
  }

/**
 * Replica: forward a status to the host as a damage-less `HitRequest` (`st` bits + `dur`). Repeats of the same
 * bits inside STATUS_REQUEST_INTERVAL are dropped (the flamethrower / arc call `applyStatus` every tick).
 */
export function requestStatus(sys: EnemySystem, e: Enemy, bits: number, duration: number): void {
  const now = sys.ctx.time;
  if ((e.statusReqBits & bits) === bits && now - e.statusReqAt < STATUS_REQUEST_INTERVAL) return;
  e.statusReqBits = now - e.statusReqAt < STATUS_REQUEST_INTERVAL ? e.statusReqBits | bits : bits;
  e.statusReqAt = now;
  _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
  const msg: HitRequest = { t: 'hit', id: e.id, dmg: 0, p: tuple(_v, 2), d: tuple(_zero, 3), st: bits, dur: round(Math.min(MAX_STATUS_DURATION, duration), 2) };
  sys.ctx.net?.send(msg, 'host');
  }

/**
 * Host: apply the status bits a client attached to its hit (`HitRequest.st` / `dur`); the wire carries no dps, so the
 * defaults are the constants.
 *
 * 2026-09-11 (E-8): by the time this runs the caller (`parts/Damage.onHitRequest`) has already masked `bits` to
 * `ENEMY_STATUS_BITS_ALL`, checked that the sender's snapshot stands within `STATUS_SOURCE_REACH` of `e`, and spent one
 * token of that sender's status budget. What is left here is the duration clamp, unchanged — so **anything else that
 * ever calls this must do those three first**; it is not self-guarding.
 */
export function applyStatusBits(sys: EnemySystem, e: Enemy, bits: number, dur: number | undefined, from?: string): void {
  const d = dur !== undefined && dur > 0 ? Math.min(MAX_STATUS_DURATION, dur) : 0;
  if (bits & ENEMY_STATUS_BITS.INCINERATED) sys.applyStatus(e.id, 'incinerated', 0, d || BURNOUT_DURATION, from);
  if (bits & ENEMY_STATUS_BITS.SHOCKED) sys.applyStatus(e.id, 'shocked', SHOCK_SLOW_FACTOR, d || SHOCK_SLOW_DURATION, from);
  if (bits & ENEMY_STATUS_BITS.BURNING) sys.applyStatus(e.id, 'burning', FLAME_AFTERBURN_DPS, d || FLAME_AFTERBURN_DURATION, from);
  if (bits & ENEMY_STATUS_BITS.SLOWED) sys.applyStatus(e.id, 'slowed', 0.4, d || 2, from);
  }

/** Phase 12 (debug / smoke): x-ray overlay state of enemy `id` (built overlay count, visible now, expiry). */
export function debugXray(sys: EnemySystem, id: number): { overlays: number; visible: boolean; until: number } | null {
  const e = sys.byId.get(id);
  return e ? sys.xray.debugState(e) : null;
  }

/**
 * 2026-09-11 (C-14): the environmental hazard reaches enemies too — **on the authority only**, every `HAZARD_TICK_S`,
 * `HAZARD_ENEMY_DPS × HAZARD_TICK_S` to every living enemy inside the damage zone (`ctx.world.hazard.isInside`). It is
 * **quiet** damage: `Enemy.applyDot(…, 'ai', quiet)`, so there is no blood FX · `bug_hit` · `ee damaged` · flinch ·
 * aggro (`aware` / `alertNear`), and kill credit goes to nobody (`'ai'` → no `enemy:killed`). The falling hp rides the
 * ordinary snapshot to the replicas. The hazard is a function of `missionTime`, so a new host carries on with the same
 * zone. That is why `Enemy.takeDamage` is not used — on a replica it would become `requestHit`, and on the authority it
 * would fire FX · a broadcast · a flinch every tick.
 */
export function updateHazardDot(sys: EnemySystem, dt: number): void {
  const hz = sys.ctx.world?.hazard ?? null;
  if (!hz || !hz.active) { sys.hazardTick = 0; return; }
  sys.hazardTick += dt;
  if (sys.hazardTick < HAZARD_TICK_S) return;
  sys.hazardTick = Math.min(sys.hazardTick - HAZARD_TICK_S, HAZARD_TICK_S);   // a long frame never stacks ticks
  // 2026-09-13: the hazard grows stronger with time — the same ratio as for the player (`HazardRef.damageMul`, 1 → HAZARD_DPS_MAX / HAZARD_DPS)
  const dmg = HAZARD_ENEMY_DPS * HAZARD_TICK_S * hz.damageMul;
  if (!(dmg > 0)) return;
  for (let i = sys.active.length - 1; i >= 0; i--) {
    const e = sys.active[i];
    if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
    /* 2026-09-18 (bug eggs): the hazard does not break an egg. An egg is the nest's **reward** and its spot is fixed,
       so a passing hazard covering it would wipe that nest's loot whole before the player ever touched it — there is no
       「reward that silently disappears to hazard damage」. Status damage **somebody caused** (fire, an incendiary zone)
       still lands (`updateStatuses`). */
    if (e.isEgg) continue;
    if (!hz.isInside(e.position.x, e.position.z)) continue;
    e.applyDot(dmg, 'ai', true);
  }
  }

/* ── status effects (burning / slow / incinerated / shocked) ─────────── */
export function updateStatuses(sys: EnemySystem, dt: number): void {
  const authority = sys.authority;
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (!e.active || e.state === 'dead') continue;
    const incap = e.incapTimer > 0;
    // replicas hold `incapTimer` / `slowTimer` from the wire bits (the AI ticks them on the authority)
    if (!authority) {
      if (incap) e.incapTimer = Math.max(0, e.incapTimer - dt);
      if (e.slowTimer > 0) { e.slowTimer -= dt; if (e.slowTimer <= 0) e.slowFactor = 1; }
    }
    if (e.burnTimer > 0 || incap) {
      if (e.burnTimer > 0) e.burnTimer -= dt;
      e.emberTimer -= dt;
      if (e.emberTimer <= 0) {
        e.emberTimer = incap ? INCAP_EMBER_INTERVAL : EMBER_INTERVAL;
        _v.set(e.position.x + (Math.random() - 0.5) * e.stats.radius, e.position.y + e.stats.height * (incap ? 0.35 + Math.random() * 0.4 : 0.55), e.position.z + (Math.random() - 0.5) * e.stats.radius);
        sys.emberBurst(_v, incap ? 5 : 4);
      }
      if (authority && e.burnTimer > 0) {
        e.burnTick -= dt;
        if (e.burnTick <= 0) {
          e.burnTick += BURN_TICK;
          // Phase 9: the fire's owner (applyStatus attacker) takes the credit; a remote owner also gets the kill hitmarker
          const by = e.burnAttacker ?? e.lastDamager;
          e.applyDot(e.burnDps * BURN_TICK, by);
          if (e.isDead && sys.hosting && by !== 'local' && by !== 'ai') {
            sys.ctx.net!.send({ t: 'hitc', id: e.id, dmg: round(e.burnDps * BURN_TICK, 1), killed: true, part: 'body' }, by);
          }
        }
      }
      if (e.burnTimer <= 0) { e.burnDps = 0; e.burnTick = 0; e.burnAttacker = null; }
    }
    if (e.shockTimer > 0) {
      e.shockTimer -= dt;
      e.sparkTimer -= dt;
      if (e.sparkTimer <= 0) {
        e.sparkTimer = SPARK_INTERVAL;
        _v.set(e.position.x + (Math.random() - 0.5) * e.stats.radius * 1.4, e.position.y + e.stats.height * (0.3 + Math.random() * 0.6), e.position.z + (Math.random() - 0.5) * e.stats.radius * 1.4);
        sys.fx?.burst(_v, 3, 'spark', 2.2);
      }
    }
  }
  }
