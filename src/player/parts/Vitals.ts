/**
 * src/player/parts/Vitals.ts — **hp · downed · death · healing**.
 *
 * When damage arrives (`applyDamage` — the armor **shield** eats it first, then hp · `인내` (grit) · knockback;
 * the plate itself cuts nothing, see the block above `applyDamage`) and hp hits 0 the player does
 * not die but goes **downed** (crawling, the `downHp` bleed, the Space give-up hold), and comes back up from an
 * ally's revive or the perk `auto_revive`. Healing is not instant: it lands over the item's own time (`applyHeal`).
 */
import * as THREE from 'three';
import type { PlayerDamageOptions, PlayerDamageSource } from '@/shared';
import {
  Keys, PLAYER_DOWN_HP, PLAYER_DOWN_BLEED_PER_SEC, PLAYER_REVIVE_HP, PLAYER_GIVE_UP_HOLD, ROLL_DAMAGE_MUL,
} from '@/shared';
/* appended (2026-09-15): android squadmates — bots are not counted as people (`onLethal`'s solo test) */
import { humanPlayersOf } from '@/shared';
import {
  AUTO_REVIVE_DELAY_S, GIVE_UP_PROGRESS_HZ, INVULN_TIME, KNOCKBACK_MIN_LIFT, STIM_DURATION, _dir,
} from '../model';
import * as IntroWake from './IntroWake';
import type { PlayerSystem } from '../PlayerSystem';

/** Teammate finished the revive hold (net → `ctx.player.revive()`): back up with PLAYER_REVIVE_HP, still prone. */
export function revive(sys: PlayerSystem): void {
  if (!sys._downed || sys.isDead) return;
  sys.autoReviveTimer = -1;
  sys._downed = false;
  sys._downHp = 0;
  sys._deathSource = undefined;   // 2026-09-15: stood back up — the downing source is no longer the cause of death
  sys.bleedAcc = 0; sys.giveUpHold = 0;
  sys.hp = PLAYER_REVIVE_HP;
  sys.invuln = Math.max(sys.invuln, 0.5);
  sys.controlsEnabled = true;
  const bus = sys.ctx.bus;
  bus.emit('player:revived', { hp: sys.hp });
  bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: sys.hp });
  bus.emit('audio:play', { id: 'stim', volume: 0.8 });
}

/**
 * Shove (behemoth charge, blasts, `dmg.kb`): `direction × speed` through the controller's `applyImpulse` path —
 * an in-flight roll is cancelled first and the impulse always carries at least a small lift so the feet leave the
 * ground (grounded cleared) and the shove is not eaten by ground friction. Ignored while dead / downed / not
 * spawned / inside the hellpod. No `player:launched` (that is the jump-pad / rocket-jump event).
 */
export function applyKnockback(sys: PlayerSystem, direction: THREE.Vector3, speed: number): void {
  if (sys.isDead || sys._downed || !sys.spawned) return;
  if (sys._roverRide) return;   // 2026-09-13: a body inside the rover is not shoved
  if (sys._sceneLock) return;   // 2026-09-14 3rd pass: the scene lock — no blast moves a body the scene put in place
  if (sys.hellpod.isActive && sys.hellpod.state !== 'exiting') return;
  const len = direction.length();
  if (len < 1e-5 || !(speed > 0)) return;
  const c = sys.controller;
  if (c.rolling) c.cancelRoll();
  sys.setHovering(false);
  _dir.copy(direction).multiplyScalar(speed / len);
  if (_dir.y < KNOCKBACK_MIN_LIFT) _dir.y = KNOCKBACK_MIN_LIFT;
  c.applyImpulse(_dir);
  c.sprinting = false;
  sys.rig.addShake(Math.min(0.6, speed * 0.04), 0.4);
}

/** Stim heal-over-time (1.5 s). The caller (weapons quick-use) has already consumed the item. */
export function applyStim(sys: PlayerSystem, healAmount: number): boolean {
  return sys.applyHeal(healAmount, STIM_DURATION);
}

/**
 * appended (2026-09-07): the consumable's own heal-over-time. `seconds` ≤ 0 lands the whole `amount` on the next
 * frame; `quiet` skips the SFX (the 회복 스프레이 ticks 10×/s). A pool already running is **topped up** rather than
 * refused for a spray tick — a fresh use still refuses while one is running, which is what `applyStim` always did.
 */
export function applyHeal(sys: PlayerSystem, amount: number, seconds: number, quiet = false): boolean {
  if (!sys.spawned || sys.isDead || sys._downed || sys.hp >= sys.maxHp || amount <= 0) return false;
  if (sys.healPool > 0 && !quiet) return false; // already healing
  const dur = Math.max(0.05, seconds);
  const rate = amount / dur;
  sys.healRate = sys.healPool > 0 ? Math.max(sys.healRate, rate) : rate;
  sys.healPool += amount;
  sys.ctx.bus.emit('player:stimUsed', { hp: sys.hp });
  if (!quiet) sys.ctx.bus.emit('audio:play', { id: 'stim', volume: 0.8 });
  return true;
}

export function takeDamage(sys: PlayerSystem, amount: number, from?: THREE.Vector3, source?: PlayerDamageSource, opts?: PlayerDamageOptions): void {
  sys.applyDamage(amount, from, false, source, opts);
}

/**
 * Single damage path. `dot` (burning) skips the invulnerability window, the shake / audio and the `인내` (grit)
 * save. **2026-09-10 — shield first**: the shield the armor grants eats the damage first (and the plate wears by
 * that much) and only the remainder goes to hp. Armor gives no damage reduction. A roll counts as a partial i-frame.
 *
 * 2026-09-15 (the result screen rework): `source` = the damage source (`PlayerDamageSource`). It goes out unchanged
 * on `player:damaged.source`, and if this damage takes hp to 0 it is written to `sys._deathSource` so that `die()`
 * sends it as `player:died.source` — while downed, the source of the damage that downed the player survives through
 * bleeding out · giving up, and a last hit landed after going down replaces it.
 *
 * 2026-09-15 (toxic spores, user's decision): with `opts.bypassShield` the damage **skips the shield and takes hp
 * only** (`absorbShield` is never called, so the armor does not wear either). 「대기를 방탄복 실드가 막는 것이 이상하다」
 * extends the reasoning behind `PLANET_ENV_DPS` (A-13) to hazards. **No new bypass branch was made** — only the
 * absorbed amount forks to 0 here; the scene lock · downed · death · stats · events all run the same lines.
 */
export function applyDamage(sys: PlayerSystem, amount: number, from: THREE.Vector3 | undefined, dot: boolean, source?: PlayerDamageSource, opts?: PlayerDamageOptions): void {
  if (sys.isDead || !(amount > 0) || !sys.spawned) return;
  // 2026-09-13: inside the rover — only the vehicle is hit (hazard · burning · tram · blast all take this path)
  if (sys._roverRide) return;
  // 2026-09-14 3rd pass: the scene lock (`PlayerRef.setSceneLock`) — while the scene holds the body it is neither
  //   hurt nor killed. It sits next to the line above for the same reason: burning · hazards · blasts · bullets all
  //   pass through this **single entry**.
  // 2026-09-15: `setSceneLock(true, {allowDamage})` **does take** damage — hp is clamped to `_sceneLockMinHp` below,
  //   and there is no downed and no death
  if (sys._sceneLock && !sys._sceneLockDamage) return;
  if (!dot && sys.invuln > 0) return;
  if (sys.hellpod.isActive && sys.hellpod.state !== 'exiting') return; // safe inside the pod
  if (!dot) sys.invuln = INVULN_TIME;
  const bus = sys.ctx.bus;
  if (sys._downed) {
    // 2026-09-15: a body the scene holds does not lose its bleed pool (it cannot go down while locked — insurance)
    if (sys._sceneLock) return;
    // already down: damage eats the bleed-out pool instead
    const dealt = Math.min(sys._downHp, amount);
    sys._downHp -= dealt;
    sys.ctx.stats.damageTaken += dealt;
    sys.flinch = 1;
    bus.emit('player:damaged', { amount: dealt, hp: sys.hp, from, source });
    bus.emit('player:downHpChanged', { downHp: Math.max(0, sys._downHp), max: PLAYER_DOWN_HP });
    bus.emit('ui:damageIndicator', { from: from ?? sys.controller.position.clone() });
    sys.rig.addShake(Math.min(0.5, 0.1 + dealt / 80), 0.2);
    bus.emit('audio:play', { id: 'player_hurt', volume: Math.min(1, 0.4 + dealt / 50), pitch: 0.85 });
    if (sys._downHp <= 0) {
      if (source) sys._deathSource = source;   // the last hit after going down — unknown source keeps the downing one
      sys.die();
    }
    return;
  }
  let raw = amount;
  if (sys.controller.rolling) raw *= ROLL_DAMAGE_MUL;
  /*
   * 2026-09-10 — armor **does not reduce** damage. Instead the shield (extra hp) is emptied first and only the
   * remainder goes to hp (`absorbShield` emits `player:shieldChanged`). The old `raw * (1 - gear.damageReduction)`
   * path is gone entirely, and `damageReduction` is a contract leftover that is always 0.
   */
  // 2026-09-15: the toxic-spore hazard — skips the shield, hp only (the armor does not wear either). Everything else
  //   still has the shield eating first, as before.
  const absorbed = opts?.bypassShield ? 0 : sys.absorbShield(raw);
  const after = raw - absorbed;
  // 2026-09-15: a damage-taking scene lock — hp stops at `_sceneLockMinHp` (≥ 1) (the shield still eats first)
  const dealt = Math.min(sys._sceneLock ? Math.max(0, sys.hp - sys._sceneLockMinHp) : sys.hp, after);
  /** The total the body felt this time (the hit feedback goes out even when the shield stopped all of it). */
  const felt = dealt + absorbed;
  sys.wearGear(absorbed);
  sys.hp -= dealt;
  sys.ctx.stats.damageTaken += dealt;
  bus.emit('player:damaged', { amount: felt, hp: sys.hp, from, source });
  bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: -dealt });
  if (!dot) {
    sys.flinch = 1;
    bus.emit('ui:damageIndicator', { from: from ?? sys.controller.position.clone() });
    const shake = Math.min(0.7, 0.15 + felt / 60);
    sys.rig.addShake(shake, 0.25);
    bus.emit('audio:play', { id: 'player_hurt', volume: Math.min(1, 0.4 + felt / 50) });
  }
  if (sys.hp <= 0) { sys._deathSource = source; sys.onLethal(dot); }
}

/**
 * hp hit 0: the `인내` (grit) skill may leave 1 hp (never on a DoT tick), otherwise the player goes downed.
 *
 * **2026-09-08 — solo dies at once.** Downed is a window for a squadmate to pick the player up; alone (no lobby, or
 * a one-player squad) there is nobody to come, so the bleed-out was just `PLAYER_DOWN_HP / PLAYER_DOWN_BLEED_PER_SEC`
 * seconds of crawling before the same death screen. Solo therefore skips straight to `die()`. The one exception is
 * the Phase 12 perk **재기동 회로** (`auto_revive`), which brings the player back up from downed with nobody else
 * there: while it is still unspent the downed state is what makes it fire, so a solo player who bought it goes down
 * first all the same.
 */
export function onLethal(sys: PlayerSystem, dot: boolean): void {
  if (!dot) {
    const chance = sys.ctx.progression?.derived.gritChance ?? 0;
    if (chance > 0 && Math.random() < chance) {
      sys.hp = 1;
      sys._deathSource = undefined;   // 2026-09-15: survived — the candidate cause of death is dropped
      sys.ctx.bus.emit('player:gritSaved', { hp: sys.hp });
      sys.ctx.bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta: 1 });
      sys.ctx.bus.emit('ui:notify', { text: '인내! 버텨냈다', kind: 'warning', duration: 1.6 });
      return;
    }
  }
  if (isAloneInSquad(sys) && !canSelfRevive(sys)) { sys.hp = 0; sys.die(); return; }
  sys.enterDowned();
}

/**
 * No squad, or a squad of one: nobody can run over and revive the player.
 *
 * 2026-09-15 (android squadmates): an android picks a downed PC up too — one unit on the squad already means **not
 * alone** (the server-less cheat roster is on `ctx.allies.roster` as well, so it holds in a solo raid too). A bot
 * member of the lobby, on the other hand, is not counted as a person (`humanPlayersOf`) — the head count is a
 * different axis from the 「who comes running」 measured here.
 */
function isAloneInSquad(sys: PlayerSystem): boolean {
  const ctx = sys.ctx;
  if ((ctx.allies?.roster.length ?? 0) > 0) return false;
  if (!ctx.isMultiplayer) return true;
  return humanPlayersOf(ctx.net?.lobby).length <= 1;
}

/**
 * The `재기동 회로` perk is bought and still unspent **this raid** — it only fires out of the downed state.
 * `autoReviveUsed` is cleared on `world:ready` (`PlayerSystem`), so one raid grants exactly one self-revive no
 * matter how many times the body goes down in it.
 */
function canSelfRevive(sys: PlayerSystem): boolean {
  return !sys.autoReviveUsed && !!sys.ctx.progression?.derived.perks?.auto_revive;
}

export function heal(sys: PlayerSystem, amount: number): void {
  if (sys.isDead || sys._downed || amount <= 0) return;
  const before = sys.hp;
  sys.hp = Math.min(sys.maxHp, sys.hp + amount);
  const delta = sys.hp - before;
  if (delta > 0) sys.ctx.bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta });
}

/**
 * **Sets hp outright** (2026-09-14) — the place where a scripted scene decides the state of the body. The only user
 * today is the tutorial — the person waking in the ruins is **on a sliver of hp**, so one hit from a bug kills (the
 * user's spec).
 *
 * Why it does **not** go through `takeDamage`: that drags the hit feedback · a direction arc · a sound along with it
 * and eats the shield first — both say something other than 「waking up already hurt」. Dead or downed it does nothing.
 */
export function setHp(sys: PlayerSystem, hp: number): void {
  if (sys.isDead || sys._downed || !sys.spawned) return;
  const next = Math.max(1, Math.min(sys.maxHp, Math.round(hp)));
  const delta = next - sys.hp;
  if (delta === 0) return;
  sys.hp = next;
  sys.ctx.bus.emit('player:healthChanged', { hp: sys.hp, maxHp: sys.maxHp, delta });
}

/** hp reached 0: downed instead of death — prone crawl, weapons off, `downHp` starts bleeding. */
export function enterDowned(sys: PlayerSystem): void {
  if (sys._downed || sys.isDead) return;
  sys.releaseDroneControl();  // 2026-09-11: going down cuts the drone view too (the stance goes prone below)
  sys.releaseFurniturePose('reset');   // 2026-09-12
  sys.clearCarry('action');   // a downed carrier cannot hold anybody up
  sys.releaseLadder();        // 2026-09-11: nor hang on a ladder — the body falls
  sys._downed = true;
  sys._downHp = PLAYER_DOWN_HP;
  sys.bleedAcc = 0; sys.giveUpHold = 0;
  sys.hp = 0;
  sys.healPool = 0;
  sys.clearShield();   // 2026-09-10: downed means no shield (not even a charger — `chargeShield` is alive-only)
  sys.setAiming(false);
  sys.setHovering(false);
  sys.controller.cancelRoll();
  sys.setGrappleTarget(null);
  sys.meleeTimer = 0;
  sys.controller.sprinting = false;
  sys.setStance('prone'); sys.standUpTimer = 0;
  sys.rig.addShake(0.7, 0.5);
  // Phase 12 perk `auto_revive`: arm the one-shot self-revive (fires from `updateDowned`)
  sys.autoReviveTimer = !sys.autoReviveUsed && sys.ctx.progression?.derived.perks?.auto_revive ? AUTO_REVIVE_DELAY_S : -1;
  const bus = sys.ctx.bus;
  bus.emit('player:downed', { position: sys.controller.position.clone() });
  bus.emit('player:downHpChanged', { downHp: sys._downHp, max: PLAYER_DOWN_HP });
  bus.emit('player:healthChanged', { hp: 0, maxHp: sys.maxHp, delta: 0 });
  bus.emit('audio:play', { id: 'player_hurt', volume: 1, pitch: 0.6 });
}

/** Bleed PLAYER_DOWN_BLEED_PER_SEC (whole points → `player:downHpChanged`), Space held PLAYER_GIVE_UP_HOLD → die. */
export function updateDowned(sys: PlayerSystem, dt: number, active: boolean): void {
  if (sys.autoReviveTimer >= 0) {
    sys.autoReviveTimer -= dt;
    if (sys.autoReviveTimer <= 0) {
      sys.autoReviveTimer = -1;
      sys.autoReviveUsed = true;
      sys.revive();
      sys.ctx.bus.emit('ui:notify', { text: '재기동 회로 작동', kind: 'success', duration: 1.8 });
      return;
    }
  }
  sys.bleedAcc += PLAYER_DOWN_BLEED_PER_SEC * dt;
  const whole = Math.floor(sys.bleedAcc);
  if (whole >= 1) {
    sys.bleedAcc -= whole;
    sys._downHp = Math.max(0, sys._downHp - whole);
    sys.ctx.bus.emit('player:downHpChanged', { downHp: sys._downHp, max: PLAYER_DOWN_HP });
    if (sys._downHp <= 0) { sys.die(); return; }
  }
  if (active && sys.ctx.input.isDown(Keys.GIVE_UP)) {
    sys.giveUpHold += dt;
    if (sys.giveUpHold >= PLAYER_GIVE_UP_HOLD) { sys.giveUpHold = 0; sys.die(); return; }   // die() → clearDowned → t -1
    sys.emitGiveUpProgress(Math.min(1, sys.giveUpHold / PLAYER_GIVE_UP_HOLD));
  } else {
    sys.giveUpHold = 0;
    sys.emitGiveUpProgress(-1);
  }
}

/**
 * Phase 9: `player:giveUpProgress {t}` for the HUD bar — 0..1 while Space is held (≤ GIVE_UP_PROGRESS_HZ, only on
 * change), a single `-1` when the hold is released / the downed state ends. Nothing is sent while idle.
 */
export function emitGiveUpProgress(sys: PlayerSystem, t: number): void {
  if (t < 0) {
    if (sys.giveUpSent < 0) return;
    sys.giveUpSent = -1;
    sys.ctx.bus.emit('player:giveUpProgress', { t: -1 });
    return;
  }
  if (t === sys.giveUpSent) return;
  if (sys.giveUpSent >= 0 && t < 1 && sys.ctx.time - sys.giveUpSentAt < 1 / GIVE_UP_PROGRESS_HZ) return;
  sys.giveUpSent = t;
  sys.giveUpSentAt = sys.ctx.time;
  sys.ctx.bus.emit('player:giveUpProgress', { t });
}

export function clearDowned(sys: PlayerSystem): void {
  sys.autoReviveTimer = -1;
  sys._downed = false;
  sys._downHp = 0;
  // 2026-09-15: so a spawn · return reset does not drag the last raid's cause along (`die` reads it first)
  sys._deathSource = undefined;
  sys.bleedAcc = 0;
  sys.giveUpHold = 0;
  sys.emitGiveUpProgress(-1);
}

export function die(sys: PlayerSystem): void {
  if (sys.isDead) return;
  /*
   * 2026-09-15 (the result screen rework): the cause of death = the source of the damage that took hp to 0 (while
   * downed, the source that downed the player · the last hit). Dying with hp left is only the voluntary return
   * (`PlayerRef.die`), which has no cause — filtered here so that an old value cannot leak. Read before
   * `clearDowned` empties it.
   */
  const deathSource = sys._downed || sys.hp <= 0 ? sys._deathSource : undefined;
  sys._deathSource = undefined;
  // 2026-09-13: the voluntary return (`die`) dies beside the vehicle — so the corpse does not stand inside the hull
  sys.releaseRoverRide();
  sys.isDead = true;
  sys.deadTimer = 0;
  sys.healPool = 0;
  sys.clearShield();
  sys.releaseDroneControl();   // 2026-09-11
  sys.releaseFurniturePose('reset');   // 2026-09-12
  IntroWake.cancelIntroWake(sys);      // 2026-09-14: dying mid-cutscene gives the camera back and ends it silently
  sys.clearCarry('died');
  sys.releaseLadder();   // 2026-09-11
  sys.clearDowned();
  sys.setAiming(false);
  sys.setHovering(false);
  sys.controller.cancelRoll();
  sys.setGrappleTarget(null);
  sys.meleeTimer = 0;
  sys.controlsEnabled = false;
  sys.cancelHold();
  sys.rig.addShake(0.8, 0.5);
  sys.ctx.bus.emit('audio:play', { id: 'player_death', volume: 1 });
  sys.ctx.bus.emit('player:died', { position: sys.controller.position.clone(), source: deathSource });
}
