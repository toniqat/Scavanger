/**
 * src/allies/parts/Vitals.ts — **hp · shield · downed · death · hazard**.
 *
 * It runs the same rules as a person (user's decision 「사람처럼 쓰러지고 PC 가 일으킬 수 있다」): shield → hp → downed
 * (`ALLY_DOWN_HP` bleed-out, at a person's `PLAYER_DOWN_BLEED_PER_SEC`) → death. Only hp is a person's ×
 * `ALLY_HP_MUL`. The shield is the **equipped armor's `ArmorDef.shield`** as it stands and never refills during a
 * raid (the same as a person).
 *
 * A hazard · the planet atmosphere deal a person's damage per second on the same tick. Atmosphere damage
 * (`PLANET_ENV_DPS`) **skips the shield** — the reasoning 「대기를 방탄복이 막는 것이 이상하다」 carried over as it
 * stands (2026-09-11 A-13) — and so does the **toxic spore** hazard alone (2026-09-15 user's decision,
 * `HAZARD_SPORES_BYPASS_SHIELD`; `world/Hazard.SPORE_DAMAGE_OPTS` is the person's side of the same rule). Every
 * other hazard hits the shield first.
 *
 * **Known limit** (the folder `README.md` carries it too): the atmosphere tick here has no counterpart to a
 * person's `ProgressionRef.hasEnvPrep` — an android buys no preparation, so it is never offset. The exposure gate
 * itself is the same as a person's (`isGameplayPhase()` · not the training range).
 *
 * Damage lands **on the authority only** (`AlliesRef.damage` is ignored on a replica) — cut in two places, hp splits.
 */
import {
  ALLY_DOWN_HP, ALLY_HP_MUL, ALLY_REVIVE_HP, HAZARD_DPS, HAZARD_SPORES_BYPASS_SHIELD, HAZARD_TICK_S,
  PLANET_ENV_DPS, PLANET_ENV_TICK_S, PLAYER_DOWN_BLEED_PER_SEC, PLAYER_MAX_HP, getPlanet,
} from '@/shared';
import type { AllyId, PeerId, PlayerDamageSource } from '@/shared';
import type * as THREE from 'three';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';

/** Base hp on raid entry (a person's × `ALLY_HP_MUL`). */
export function resetVitals(a: Ally): void {
  a.maxHp = PLAYER_MAX_HP * ALLY_HP_MUL;
  a.hp = a.maxHp;
  a.shield = a.maxShield;
  a.downHp = 0;
  a.downed = false;
  a.dead = false;
}

export function update(sys: AllySystem, dt: number): void {
  const ctx = sys.ctx;
  const hz = ctx.world?.hazard ?? null;
  // The same exposure gate a person has (`player/parts/Statuses.updateEnv`): the atmosphere is breathed only
  // during play, never on the training range. (`ctx.missionPlanet` is null there today, so this only makes the
  // rule readable — it stops a future training planet from quietly gassing the squad.)
  const exposed = ctx.isGameplayPhase() && !ctx.isTraining();
  const envKind = exposed ? getPlanet(ctx.missionPlanet)?.env ?? null : null;
  // 2026-09-15 (user's decision): the toxic spores alone take hp straight through the shield — the same test
  // `world/Hazard` runs for a person.
  const hazardBypass = hz?.kind === 'spores' && HAZARD_SPORES_BYPASS_SHIELD;
  sys.hazardTimer += dt;
  sys.envTimer += dt;
  const hazardTick = sys.hazardTimer >= HAZARD_TICK_S;
  const envTick = sys.envTimer >= PLANET_ENV_TICK_S;
  if (hazardTick) sys.hazardTimer = 0;
  if (envTick) sys.envTimer = 0;

  for (const a of sys.bodies) {
    if (a.mode !== 'raid' || a.dead || a.hidden) continue;
    if (a.downed) {
      a.downHp -= PLAYER_DOWN_BLEED_PER_SEC * dt;
      if (a.downHp <= 0) die(sys, a);
      continue;
    }
    if (hazardTick && hz?.active && hz.isInside(a.position.x, a.position.z)) {
      apply(sys, a, HAZARD_DPS * hz.damageMul * HAZARD_TICK_S, hazardBypass);
    }
    if (envTick && envKind) apply(sys, a, PLANET_ENV_DPS * PLANET_ENV_TICK_S, true);
  }
}

/** `AlliesRef.damage` — enemies calls it on the authority only. */
export function damage(sys: AllySystem, id: AllyId, amount: number, source?: PlayerDamageSource, from?: THREE.Vector3): void {
  if (!sys.simulating) return;
  const a = sys.byId.get(id);
  if (!a || a.mode !== 'raid' || a.dead || a.hidden) return;
  void source; void from;
  apply(sys, a, amount, false);
}

/** Shield → hp → downed. `bypassShield` is atmosphere damage (it skips the shield). */
function apply(sys: AllySystem, a: Ally, amount: number, bypassShield: boolean): void {
  if (amount <= 0) return;
  let left = amount;
  if (a.downed) {
    a.downHp -= left;
    sys.ctx.bus.emit('ally:damaged', { id: a.id, amount, hp: a.hp, shield: a.shield });
    if (a.downHp <= 0) die(sys, a);
    return;
  }
  if (!bypassShield && a.shield > 0) {
    const used = Math.min(a.shield, left);
    a.shield -= used;
    left -= used;
  }
  if (left > 0) a.hp -= left;
  sys.ctx.bus.emit('ally:damaged', { id: a.id, amount, hp: Math.max(0, a.hp), shield: a.shield });
  if (a.hp <= 0) down(sys, a);
}

function down(sys: AllySystem, a: Ally): void {
  a.hp = 0;
  a.downed = true;
  a.downHp = ALLY_DOWN_HP;
  a.pose = 'downed';
  a.velocity.set(0, 0, 0);
  a.carrying = null;
  sys.ctx.bus.emit('ally:downed', { id: a.id, name: a.name });
}

function die(sys: AllySystem, a: Ally): void {
  if (a.dead) return;
  a.dead = true;
  a.downed = false;
  a.downHp = 0;
  a.hp = 0;
  a.pose = 'dead';
  a.velocity.set(0, 0, 0);
  a.carrying = null;
  // game/ makes the corpse — **only what was found in the raid** goes in (the base kit is a bound thing).
  sys.ctx.corpses?.spawnAllyCorpse?.(a.id, a.name, a.slot, a.position, a.yaw, a.loot());
  a.hidden = true;
  if (a.bag) a.bag.clear();
  for (const slot of ['primary', 'armor', 'bag'] as const) {
    const it = a.equip[slot];
    if (it && !a.kitUids.has(it.uid)) a.equip[slot] = null;
  }
  a.bagDirty = true;
  sys.ctx.bus.emit('ally:died', { id: a.id, name: a.name });
}

/** `AlliesRef.requestRevive` — at once on the authority, otherwise `allyq revive`. */
export function requestRevive(sys: AllySystem, id: AllyId, opts?: { defib?: boolean }): boolean {
  const a = sys.byId.get(id);
  if (!a || !a.downed || a.dead) return false;
  if (!sys.simulating) return sys.sendReviveRequest(id, !!opts?.defib);
  revive(sys, a, sys.ctx.net?.localId ?? null);
  return true;
}

/**
 * `AlliesRef.heal` (appended 2026-09-21, 회복 아이템을 아군에게) — at once on the authority, otherwise `allyq heal`.
 * A **downed** android is refused on purpose: the receiving rule for a person is the same (`implants/parts/Wire.onBuff`
 * turns a heal away while downed), and getting one up is the defibrillator's job, not a bandage's.
 */
export function requestHeal(sys: AllySystem, id: AllyId, hp: number): boolean {
  const a = sys.byId.get(id);
  if (!a || a.dead || a.downed || !(hp > 0) || a.hp >= a.maxHp) return false;
  if (!sys.simulating) return sys.sendHealRequest(id, hp);
  applyHeal(a, hp);
  return true;
}

/** Actually puts the hp back (on the authority only). The next `ally state` carries it — no message of its own. */
export function applyHeal(a: Ally, hp: number): void {
  if (a.dead || a.downed || !(hp > 0)) return;
  a.hp = Math.min(a.maxHp, a.hp + hp);
}

/**
 * `AlliesRef.chargeShield` (appended 2026-09-21) — the 실드 충전기 counterpart. `amount` -1 = fill it up
 * (`BuffMessage.amount`). Refused with no armor equipped (`maxShield` 0) or on a full pool, so the item is not eaten.
 */
export function requestShield(sys: AllySystem, id: AllyId, amount: number): boolean {
  const a = sys.byId.get(id);
  if (!a || a.dead || a.downed || a.maxShield <= 0 || a.shield >= a.maxShield) return false;
  if (!(amount > 0) && amount !== -1) return false;
  if (!sys.simulating) return sys.sendShieldRequest(id, amount);
  applyShield(a, amount);
  return true;
}

/** Actually charges the shield (on the authority only). */
export function applyShield(a: Ally, amount: number): void {
  if (a.dead || a.downed || a.maxShield <= 0) return;
  a.shield = amount === -1 ? a.maxShield : Math.min(a.maxShield, a.shield + Math.max(0, amount));
}

/** Actually gets it up (on the authority only). */
export function revive(sys: AllySystem, a: Ally, by: PeerId | null): void {
  if (!a.downed || a.dead) return;
  a.downed = false;
  a.downHp = 0;
  a.hp = ALLY_REVIVE_HP;
  a.pose = 'stand';
  sys.ctx.bus.emit('ally:revived', { id: a.id, by });
}
