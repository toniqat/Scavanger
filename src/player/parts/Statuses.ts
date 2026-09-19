/**
 * src/player/parts/Statuses.ts — **the states that attach to the player**: cloak · burning · armor regen.
 *
 * The cloak multiplies enemy detection directly (`getStealthFactor`), and optical-camo armor is a permanent cloak.
 * Burning is a DoT dealing damage per second, and the armor perk `regen` (`방탄복 신화 재생`, `updateArmorRegen`)
 * heals **hp** — neither the plate's durability nor the shield — a whole point at a time while the stamina is full.
 */
import {
  GameContext, CLOAK_BREAK_TIME, CLOAK_DETECT_MUL, CLOAK_REVEAL_DISTANCE, PLANET_ENV_DPS, PLANET_ENV_TICK_S,
} from '@/shared';
import { BURN_TICK, CLOAK_PROBE_INTERVAL } from '../model';
import type { PlayerSystem } from '../PlayerSystem';
import type { PlayerDamageSource } from '@/shared';

/**
 * 2026-09-15 (the result screen rework): the source for the planet environment tick — one object, reused
 * (nothing is allocated per tick).
 */
const ENV_DAMAGE_SOURCE: PlayerDamageSource = Object.freeze({ kind: 'env' });

/** Apply / refresh a cloak. Optical-camo armor passes `Infinity`; the strongest remaining duration wins. */
export function setCloak(sys: PlayerSystem, duration: number, source: 'gadget' | 'armor'): void {
  if (!(duration > 0)) {
    if (sys.cloakSource === source) { sys.cloakTimer = 0; sys.cloakSource = null; }
    return;
  }
  if (duration >= sys.cloakTimer || sys.cloakSource === null) sys.cloakSource = source;
  sys.cloakTimer = Math.max(sys.cloakTimer, duration);
}

/** 0..1 factor an enemy multiplies its detection range by (1 = fully visible). */
export function getStealthFactor(sys: PlayerSystem): number {
  return sys._cloaked ? CLOAK_DETECT_MUL : 1;
}

/** Fire zone / incendiary: DoT that also suppresses the `인내` (grit) save while it kills. */
export function setBurning(sys: PlayerSystem, dps: number, duration: number, source?: PlayerDamageSource): void {
  if (!(dps > 0) || !(duration > 0)) {
    if (sys._burning) { sys._burning = false; sys.burnDps = 0; sys.burnTimer = 0; sys.burnSource = undefined; sys.ctx.bus.emit('player:burning', { active: false, dps: 0 }); }
    return;
  }
  if (sys._roverRide) return;   // 2026-09-13: nothing catches fire inside the rover
  const wasBurning = sys._burning;
  // 2026-09-15 (the result screen rework): the source of the burn — taken when the fire is new, or when an equal or
  //   stronger fire covers it. An unknown source never erases a known one.
  // (Inside a fire zone this is called every frame, so the caller passes a pre-made source object — nothing is
  //   allocated here either.)
  if (!wasBurning) sys.burnSource = source;
  else if (source && (dps >= sys.burnDps || !sys.burnSource)) sys.burnSource = source;
  sys.burnDps = Math.max(sys.burnDps, dps);
  sys.burnTimer = Math.max(sys.burnTimer, duration);
  sys._burning = true;
  if (!wasBurning) {
    sys.burnTick = BURN_TICK;
    sys.ctx.bus.emit('player:burning', { active: true, dps: sys.burnDps });
  }
}

/**
 * Cloak upkeep: firing, sprinting, rolling, meleeing or an enemy inside CLOAK_REVEAL_DISTANCE reveal the player
 * for CLOAK_BREAK_TIME; once the cause is gone (and the distance opened again) the cloak comes back.
 */
export function updateCloak(sys: PlayerSystem, dt: number, ctx: GameContext): void {
  if (sys.cloakTimer > 0 && sys.cloakTimer !== Infinity) sys.cloakTimer = Math.max(0, sys.cloakTimer - dt);
  if (sys.cloakTimer <= 0) {
    sys.cloakBreak = 0;
    sys.cloakNearEnemy = false;
    if (sys.cloakSource !== null) sys.cloakSource = null;
  } else {
    sys.cloakProbe -= dt;
    if (sys.cloakProbe <= 0) {
      sys.cloakProbe = CLOAK_PROBE_INTERVAL;
      sys.cloakNearEnemy = sys.enemyWithin(ctx, CLOAK_REVEAL_DISTANCE);
    }
    const reveal = sys.weaponState.firing || sys.controller.sprinting || sys.controller.rolling
      || sys.meleeTimer > 0 || sys.cloakNearEnemy;
    if (reveal) sys.cloakBreak = CLOAK_BREAK_TIME;
    else if (sys.cloakBreak > 0) sys.cloakBreak = Math.max(0, sys.cloakBreak - dt);
  }
  const cloaked = sys.cloakTimer > 0 && sys.cloakBreak <= 0 && !sys.isDead;
  if (cloaked !== sys._cloaked) {
    sys._cloaked = cloaked;
    ctx.bus.emit('player:cloakChanged', { cloaked, source: cloaked ? sys.cloakSource : null });
  }
}

/** Any alive enemy within `radius`. */
export function enemyWithin(sys: PlayerSystem, ctx: GameContext, radius: number): boolean {
  const em = ctx.enemies;
  if (!em) return false;
  return em.queryNear(sys.controller.position, radius).length > 0;
}

/** Burning DoT (incendiary / fire zone). Applied in BURN_TICK chunks; never triggers the `인내` (grit) save. */
export function updateBurning(sys: PlayerSystem, dt: number): void {
  if (!sys._burning) return;
  sys.burnTimer -= dt;
  sys.burnTick -= dt;
  if (sys.burnTick <= 0) {
    sys.burnTick = BURN_TICK;
    sys.applyDamage(sys.burnDps * BURN_TICK, undefined, true, sys.burnSource);
  }
  if (sys.burnTimer <= 0) {
    sys._burning = false; sys.burnDps = 0; sys.burnTimer = 0; sys.burnSource = undefined;
    sys.ctx.bus.emit('player:burning', { active: false, dps: 0 });
  }
}

/* ══ the planet's permanent environment (A-13, 2026-09-11 — user's decision) ══════════════════════════════════════
 * Standing on 피로스 VII (`heat`) · 카민 I (`toxin`) **without the matching prep** takes `PLANET_ENV_DPS × tick` off
 * every `PLANET_ENV_TICK_S`. Two things are contract —
 *   ① **hp only.** Armor cannot stop the atmosphere, so this does not ride `applyDamage` (that path empties the
 *      shield first).
 *   ② with the prep it is a **100 % cancel**. Not a reduction — zero.
 * It is a soft gate: entering is never blocked — nowhere blocks it.
 * `player:envChanged` goes out **only when the exposed state changes** (never per tick — one badge in ui/ is its
 * only consumer).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */
export function updateEnv(sys: PlayerSystem, dt: number, ctx: GameContext): void {
  const exposed = ctx.isGameplayPhase() && !ctx.isTraining();
  const env = exposed ? (ctx.world?.env ?? null) : null;
  const guarded = env !== null && (ctx.progression?.hasEnvPrep(env) ?? false);
  if (env !== sys.envKind || guarded !== sys.envProtected) {
    sys.envKind = env;
    sys.envProtected = guarded;
    sys.envTick = 0;
    ctx.bus.emit('player:envChanged', { env, protected: guarded });
  }
  if (env === null || guarded) return;
  // 2026-09-13: the rover is sealed — the exposed state (the badge) stays, only the damage is gone
  if (sys._roverRide) { sys.envTick = 0; return; }
  // 2026-09-14 3rd pass: the scene lock — this is the **only** damage that bypasses `applyDamage`, so it is blocked
  //   here too (the badge stays)
  // 2026-09-15: a damage-taking scene lock (`allowDamage`) does land, but is clamped to `_sceneLockMinHp` below
  if (sys._sceneLock && !sys._sceneLockDamage) { sys.envTick = 0; return; }
  // Downed · dead · inside the drop pod · a body not yet out does not breathe the atmosphere.
  if (!sys.spawned || sys.isDead || sys._downed) return;
  if (sys.hellpod.isActive && sys.hellpod.state !== 'exiting') return;
  sys.envTick += dt;
  if (sys.envTick < PLANET_ENV_TICK_S) return;
  sys.envTick -= PLANET_ENV_TICK_S;
  // 2026-09-15: the scene lock = an hp clamp
  const room = sys._sceneLock ? Math.max(0, sys.hp - sys._sceneLockMinHp) : sys.hp;
  const dealt = Math.min(room, PLANET_ENV_DPS * PLANET_ENV_TICK_S);
  if (dealt <= 0) return;
  sys.hp -= dealt;
  ctx.stats.damageTaken += dealt;
  const bus = ctx.bus;
  // 2026-09-15 (the result screen rework): source `env` — this path has emitted `player:damaged` all along (there
  //   never was a direction arc or a shake here)
  bus.emit('player:damaged', { amount: dealt, hp: sys.hp, from: undefined, source: ENV_DAMAGE_SOURCE });
  bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: -dealt });
  // A DoT, so the `인내` (grit) save never fires — the same contract as burning.
  if (sys.hp <= 0) { sys._deathSource = ENV_DAMAGE_SOURCE; sys.onLethal(true); }
}

/**
 * The armor perk `regen` (`방탄복 신화 재생`): 1 **hp** per second (`perkValue`) while the stamina bar is full,
 * healed in whole points to avoid event spam. Despite the name it restores neither the plate's durability nor the
 * shield — the shield refills only in the ship and from raid chargers (`PlayerSystem.chargeShield`).
 */
export function updateArmorRegen(sys: PlayerSystem, dt: number): void {
  const rate = sys.gear.regenPerSecond;
  if (rate <= 0 || sys.isDead || sys._downed || sys.hp >= sys.maxHp) { sys.regenAccum = 0; return; }
  if (sys.stamina < sys.maxStamina - 0.5) { sys.regenAccum = 0; return; }
  sys.regenAccum += rate * dt;
  if (sys.regenAccum >= 1) {
    const whole = Math.floor(sys.regenAccum);
    sys.regenAccum -= whole;
    sys.heal(whole);
  }
}
