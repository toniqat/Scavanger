/**
 * src/allies/parts/Vitals.ts — **체력 · 실드 · 쓰러짐 · 사망 · 재해**.
 *
 * 사람과 같은 규칙을 쓴다 (사용자 결정 「사람처럼 쓰러지고 PC 가 일으킬 수 있다」): 실드 → 체력 → 쓰러짐
 * (`ALLY_DOWN_HP` 출혈, 속도는 사람의 `PLAYER_DOWN_BLEED_PER_SEC`) → 사망. 체력만 사람의 `ALLY_HP_MUL` 배다.
 * 실드는 **장착 방탄복의 `ArmorDef.shield`** 그대로이고 레이드 중에는 차지 않는다 (사람과 같다).
 *
 * 재해 · 행성 대기는 사람과 같은 초당 피해를 같은 주기로 넣는다. 대기(`PLANET_ENV_DPS`)는 **실드를 건너뛴다** —
 * 「대기를 방탄복이 막는 것이 이상하다」 는 근거를 그대로 옮긴 것이다 (2026-09-11 A-13).
 *
 * 피해는 **권위에서만** 들어간다 (`AlliesRef.damage` 는 리플리카에서 무시된다) — 두 곳에서 깎으면 체력이 갈린다.
 */
import {
  ALLY_DOWN_HP, ALLY_HP_MUL, ALLY_REVIVE_HP, HAZARD_DPS, HAZARD_TICK_S,
  PLANET_ENV_DPS, PLANET_ENV_TICK_S, PLAYER_DOWN_BLEED_PER_SEC, PLAYER_MAX_HP, getPlanet,
} from '@/shared';
import type { AllyId, PeerId, PlayerDamageSource } from '@/shared';
import type * as THREE from 'three';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';

/** 레이드에 들어갈 때의 기본 체력 (사람 × `ALLY_HP_MUL`). */
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
  const envKind = getPlanet(ctx.missionPlanet)?.env ?? null;
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
      apply(sys, a, HAZARD_DPS * hz.damageMul * HAZARD_TICK_S, false);
    }
    if (envTick && envKind) apply(sys, a, PLANET_ENV_DPS * PLANET_ENV_TICK_S, true);
  }
}

/** `AlliesRef.damage` — enemies 가 권위에서만 부른다. */
export function damage(sys: AllySystem, id: AllyId, amount: number, source?: PlayerDamageSource, from?: THREE.Vector3): void {
  if (!sys.simulating) return;
  const a = sys.byId.get(id);
  if (!a || a.mode !== 'raid' || a.dead || a.hidden) return;
  void source; void from;
  apply(sys, a, amount, false);
}

/** 실드 → 체력 → 쓰러짐. `bypassShield` 는 대기 피해 (실드를 건너뛴다). */
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
  // 시체는 game/ 이 만든다 — **레이드에서 주운 것만** 들어간다 (기본 킷은 묶인 물건).
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

/** `AlliesRef.requestRevive` — 권위면 바로, 아니면 `allyq revive`. */
export function requestRevive(sys: AllySystem, id: AllyId, opts?: { defib?: boolean }): boolean {
  const a = sys.byId.get(id);
  if (!a || !a.downed || a.dead) return false;
  if (!sys.simulating) return sys.sendReviveRequest(id, !!opts?.defib);
  revive(sys, a, sys.ctx.net?.localId ?? null);
  return true;
}

/** 실제로 일으킨다 (권위에서만). */
export function revive(sys: AllySystem, a: Ally, by: PeerId | null): void {
  if (!a.downed || a.dead) return;
  a.downed = false;
  a.downHp = 0;
  a.hp = ALLY_REVIVE_HP;
  a.pose = 'stand';
  sys.ctx.bus.emit('ally:revived', { id: a.id, by });
}
