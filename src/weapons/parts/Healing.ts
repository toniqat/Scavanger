/**
 * src/weapons/parts/Healing.ts — **회복 소모품의 홀드 사용**.
 *
 * 붕대 · 약초 붕대 · 회복주사 · 제세동기는 좌클릭을 아이템별 시간만큼 **누르고 있어야** 하고
 * (`heal:holdChanged.dur`, 그 동안 이동 50 %), 회복 스프레이는 게이지를 깎으며 자신과 반경 안 아군을
 * 계속 회복한다. 게이지가 0 이 되어도 캔은 사라지지 않고 함선에서 충전한다.
 */
import * as THREE from 'three';
import {
  GameContext, Keys, MouseButtons, WEAPON_DURABILITY_PER_SHOT, WEAPON_SWAP_TIME_PRIMARY, WEAPON_SWAP_TIME_SECONDARY,
  IMPLANT_OVERCHARGE_FIRERATE_MUL,
  QUICK_SLOTS, QUICK_SLOT_UNLOCK_ORDER, QUICK_USABLE_CATEGORIES, isQuickSlotActive, QUICK_WHEEL_HOLD, QUICK_WHEEL_DRAG_PX, GRENADE_FUSE, GRENADE_COOK_MAX, GRENADE_UNDERHAND_SPEED_MUL,
  HEAL_HOLD_S, CONSUMABLE_SLOW_KEY, CONSUMABLE_SLOW_MUL, DEFIB_USE_TIME_S,
  type GameSystem, type WeaponDef, type ItemInstance, type ItemDef, type PlayerRef, type PlayerWeaponHost, type EnemyRef, type Vec3Tuple,
  type WeaponSlot, type EffectiveWeaponStats, type WeaponClass, type GadgetId, type WeaponRemoteState,
} from '@/shared';
import type { Obstacle as WorldObstacle, InterceptableRef, PeerId } from '@/shared';
import { ARMOR_IMMUNE_AMMO } from '@/shared';
import { FxManager } from '@/core/fx';
import { randomInCone } from '@/core/util/MathUtil';
import { shieldChargeOf } from '@/items';
import { WEAPON_SLOTS, defaultFor, kindOf, shotSoundId, shotPitchFor, weaponClassOf, damageFalloff, statsFromDef, STANCE_ACCURACY } from '../WeaponDefaults';
import { WeaponModel, type WeaponAttachmentVisuals } from '../WeaponModel';
import { attachmentVisualsFor, attachmentIdsOf, sameIds } from '../Attachments';
import { WeaponFx } from '../fx/WeaponFx';
import { GrenadeManager } from '../Grenade';
import { ProjectilePool, projectileOptsFor, type ProjectileHit } from '../Projectile';
import { RemoteWeapons } from '../RemoteWeapons';
import { MeleeController } from '../Melee';
import { raycastBlockers, damageBarrierAt, makeBlockInfo } from '../Blocking';
import { createUniqueHandler, UniqueFx, type UniqueHandler, type UniqueInput, type UniqueServices, type UniqueShot, type UniqueWeapon } from '../unique';
import { BLOOM_DECAY, BLOOM_PER_SHOT, BOLT_SOUND_DELAY, BROKEN_NOTIFY_INTERVAL, CHANNEL_EMIT_HZ, FIRING_POSE_HOLD, GRENADE_MIN_FUSE, GRENADE_THROW_LIFT, GRENADE_THROW_SPEED, GRENADE_UNDERHAND_LIFT, type HitInfo, type Host, LOADOUT_FALLBACK_DELAY, MOVING_SPREAD_MUL, QUICK_HOLSTER_TIME, QUICK_USE_COOLDOWN, type QuickHand, type QuickKind, SPRAY_SEND_INTERVAL, SPRINT_SPREAD_MUL, type WeaponInstance, _block, _blockInfo, _d, _md, _mq, _muzzle, _netDir, _o, _pd, _rep, _right, _tA, _tB, _target, _tmp, gaugeOf, makeHit, toTuple, useTimeOf } from '../model';
import type { WeaponSystem } from '../WeaponSystem';

/* ── 소모품 사용 (Phase 10 회복약 → 2026-09-07 모든 회복 소모품 + 제세동기) ─── */
/**
 * `heal:holdChanged` at ≤ 30 Hz. `t` = 0..1 of the item's own use time while holding (remaining gauge for a
 * 스프레이), `-1` on a cancel. `force` bypasses the throttle (start / finish / cancel must always land).
 */
export function emitHeal(sys: WeaponSystem, t: number, force: boolean, dur = HEAL_HOLD_S): void {
  if (!force && sys.ctx.time - sys.healEmitAt < 1 / 30) return;
  sys.healEmitAt = sys.ctx.time;
  sys.ctx.bus.emit('heal:holdChanged', { holding: sys.healHeld, t, dur, spray: sys.healSpray });
  }

/**
 * Phase 12 perk `quick_heal` (가속 대사): every hold-to-use time (회복 소모품 and the 제세동기's `DEFIB_USE_TIME_S`)
 * is halved while the perk is active. The HUD ring reads the halved value from `heal:holdChanged.dur`.
 */
export function holdTimeOf(sys: WeaponSystem, def: ItemDef): number {
  const base = useTimeOf(def);
  return sys.ctx.progression?.derived.perks?.quick_heal ? base * 0.5 : base;
  }

/**
 * `item:channelChanged` for the 스프레이 channel: `active:true` when it starts, ≤ `CHANNEL_EMIT_HZ` while it runs
 * (`gauge` 0..1), `active:false` when it stops for any reason. `force` bypasses the throttle (start / stop).
 */
export function emitChannel(sys: WeaponSystem, active: boolean, gauge01: number, force: boolean): void {
  const ch = sys.channel;
  if (!ch) return;
  if (!force && sys.ctx.time - sys.channelEmitAt < 1 / CHANNEL_EMIT_HZ) return;
  sys.channelEmitAt = sys.ctx.time;
  sys.ctx.bus.emit('item:channelChanged', { uid: ch.uid, defId: ch.defId, active, gauge: THREE.MathUtils.clamp(gauge01, 0, 1) });
  if (!active) sys.channel = null;
  }

/** Close the ticker at the item's current gauge (`active:false`), whatever ended the channel. */
export function closeChannel(sys: WeaponSystem): void {
  const ch = sys.channel;
  if (!ch) return;
  sys.emitChannel(false, (sys.ctx.inventory?.findItem(ch.uid)?.durability ?? 0) / ch.max, true);
  }

/** `스프레이가 비었습니다` — throttled like the broken-weapon toast so a held button does not spam it. */
export function notifySprayEmpty(sys: WeaponSystem): void {
  if (sys.ctx.time - sys.sprayEmptyNotifyAt < BROKEN_NOTIFY_INTERVAL) return;
  sys.sprayEmptyNotifyAt = sys.ctx.time;
  sys.ctx.bus.emit('ui:notify', { text: '스프레이가 비었습니다', kind: 'warning', duration: 1.4 });
  }

/** Movement penalty while a consumable is being used (`CONSUMABLE_SLOW_MUL`); `1` releases it. */
export function setConsumableSlow(sys: WeaponSystem, on: boolean): void {
  sys.ctx.player?.setSpeedModifier(CONSUMABLE_SLOW_KEY, on ? CONSUMABLE_SLOW_MUL : 1);
  }

/**
 * 2026-09-10 — 실드 충전기: 지금 채울 실드가 남아 있는가. 방탄복이 없거나(최대치 0) 이미 가득이면 false 이고,
 * 그때는 홀드를 시작조차 하지 않는다 — **아이템이 소모되면 안 되기 때문**이다 (`PlayerRef.chargeShield` 의 계약).
 */
export function canChargeShield(sys: WeaponSystem): boolean {
  const p = sys.ctx.player;
  if (!p || typeof p.chargeShield !== 'function') return false;
  return p.maxShield > 0 && p.shield < p.maxShield;
  }

/**
 * LMB pressed with a 회복 소모품 / 실드 충전기 / 제세동기 in hand. A plain heal is refused at full hp (the old
 * instant-use rule); a 실드 충전기 is refused with no armor / a full shield; the 스프레이 is refused only when its
 * gauge is empty (it also heals squadmates), the 제세동기 never checks hp.
 */
export function beginHeal(sys: WeaponSystem, host: Host, q: QuickHand): void {
  // 2026-09-10 실드 충전기 — 회복 소모품과 같은 홀드 · 이동 감속을 쓰고, 끝나면 chargeShield 로 간다
  if (shieldChargeOf(q.defId)) {
    if (!sys.canChargeShield()) { sys.deny(); return; }
    sys.healSpray = false;
    sys.healHeld = true;
    sys.healT = 0;
    sys.setConsumableSlow(true);
    sys.emitHeal(0, true, sys.holdTimeOf(q.def));
    return;
  }
  const spray = q.def.heal?.spray;
  if (spray) {
    const max = Math.max(1, q.def.durabilityMax ?? 1);
    const gauge = gaugeOf(q.item, q.def);
    // Phase 12: an empty can stays in the slot at durability 0 (repaired in the ship) — the channel just refuses
    if (gauge <= 0) { sys.deny(); sys.notifySprayEmpty(); return; }
    sys.healSpray = true; sys.sprayAcc = 0; sys.spraySendAcc = 0; sys.sprayOwed.clear();
    sys.healHeld = true; sys.healT = 0;
    sys.setConsumableSlow(true);
    sys.channel = { uid: q.uid, defId: q.defId, max };
    sys.emitChannel(true, gauge / max, true);
    sys.emitHeal(gauge / max, true, 0);
    return;
  }
  if (q.kind === 'stim' && host.hp >= host.maxHp) { sys.deny(); return; }
  sys.healSpray = false;
  sys.healHeld = true;
  sys.healT = 0;
  sys.setConsumableSlow(true);
  sys.emitHeal(0, true, sys.holdTimeOf(q.def));
  }

/**
 * Accumulate while LMB stays down; releasing cancels. Taking damage does **not** cancel
 * (`HEAL_HOLD_CANCEL_ON_DAMAGE` is false — nothing here watches for damage on purpose).
 */
export function updateHeal(sys: WeaponSystem, dt: number, host: Host, q: QuickHand): void {
  if (!sys.ctx.input.isMouseDown(MouseButtons.FIRE)) { sys.cancelHeal(); return; }
  if (sys.healSpray) { sys.updateSpray(dt, host, q); return; }
  const dur = sys.holdTimeOf(q.def);
  sys.healT += dt;
  if (sys.healT >= dur) { sys.finishHeal(host, q); return; }
  sys.emitHeal(Math.min(1, sys.healT / Math.max(0.01, dur)), false, dur);
  }

/**
 * 회복 스프레이: every `spray.tick` seconds one gauge unit is spent and `healPerTick` hp goes to the user and to
 * every squadmate inside `spray.radius` (remote ones as a batched `buff heal`, the same wire the overcharge beam
 * uses). The gauge lives on the instance (`durability`), so a half-used can keeps its charge in the stash.
 */
export function updateSpray(sys: WeaponSystem, dt: number, host: Host, q: QuickHand): void {
  const spray = q.def.heal!.spray!;
  const max = Math.max(1, q.def.durabilityMax ?? 1);
  sys.sprayAcc += dt;
  sys.spraySendAcc += dt;
  let gauge = gaugeOf(q.item, q.def);
  let spent = 0;
  while (sys.sprayAcc >= spray.tick && gauge > 0) {
    sys.sprayAcc -= spray.tick;
    gauge = Math.max(0, gauge - spray.gaugePerTick);
    spent++;
  }
  if (spent > 0) {
    const hp = spray.healPerTick * spent;
    sys.ctx.inventory?.updateItem(q.uid, { durability: gauge });
    const p = sys.ctx.player as (PlayerRef & { applyHeal?: (a: number, s: number, quiet?: boolean) => boolean }) | null;
    p?.applyHeal?.(hp, spray.tick * spent, true);
    sys.sprayAllies(hp, spray.radius);
    sys.ctx.bus.emit('audio:play', { id: 'stim', volume: 0.15 });
  }
  if (sys.spraySendAcc >= SPRAY_SEND_INTERVAL) { sys.spraySendAcc = 0; sys.flushSprayHeals(); }
  sys.emitHeal(gauge / max, spent > 0, 0);
  if (gauge <= 0) { sys.stopSpray(); sys.notifySprayEmpty(); return; }
  sys.emitChannel(true, gauge / max, false);
  }

/**
 * Phase 12: the 스프레이 channel ends (gauge empty, button released, swap, death, screen). The can is **never**
 * consumed — at 0 it stays in the slot with `durability` 0 until the ship repairs it. Closes both the HUD ring
 * (`heal:holdChanged -1`) and the ticker (`item:channelChanged active:false`).
 */
export function stopSpray(sys: WeaponSystem): void {
  if (!sys.healHeld || !sys.healSpray) return;
  sys.healHeld = false; sys.healT = 0; sys.healSpray = false;
  sys.setConsumableSlow(false);
  sys.flushSprayHeals();
  sys.emitHeal(-1, true, 0);
  sys.closeChannel();
  }

/** Squadmates inside `radius` owe `hp` this tick (flushed as `buff heal` at `SPRAY_SEND_INTERVAL`). */
export function sprayAllies(sys: WeaponSystem, hp: number, radius: number): void {
  const net = sys.ctx.net;
  const me = sys.ctx.player;
  if (!net || !me || !sys.ctx.isMultiplayer) return;
  const r2 = radius * radius;
  for (const peer of net.getRemotePlayers()) {
    if (!peer.connected || peer.isDead) continue;
    if (peer.position.distanceToSquared(me.position) > r2) continue;
    sys.sprayOwed.set(peer.id, (sys.sprayOwed.get(peer.id) ?? 0) + hp);
  }
  }

/** Send one `buff heal` per owed squadmate and clear the ledger. */
export function flushSprayHeals(sys: WeaponSystem): void {
  if (sys.sprayOwed.size === 0) return;
  const net = sys.ctx.net;
  const by = net?.playerName ?? '';
  for (const [id, hp] of sys.sprayOwed) {
    if (hp <= 0) continue;
    net?.send({ t: 'buff', kind: 'heal', amount: Math.round(hp * 10) / 10, duration: 0, by }, id as PeerId);
  }
  sys.sprayOwed.clear();
  }

/** Hold completed: consume the item and apply its effect (a 제세동기 hands off to the gadget path). */
export function finishHeal(sys: WeaponSystem, host: Host, q: QuickHand): void {
  const spray = q.def.heal?.spray;
  // a 스프레이 never "finishes" into a consume (Phase 12): its only end is `stopSpray`
  if (spray || sys.healSpray) { sys.stopSpray(); return; }
  sys.healHeld = false; sys.healT = 0; sys.healSpray = false;
  sys.setConsumableSlow(false);
  if (q.kind === 'gadget') {
    sys.emitHeal(1, true, sys.holdTimeOf(q.def));
    sys.useGadget(host, q);
    return;
  }
  const remaining = sys.consumeQuick(q);
  sys.emitHeal(remaining < 0 ? -1 : 1, true, sys.holdTimeOf(q.def));
  if (remaining < 0) { sys.deny(); return; }
  sys.quickCooldown = QUICK_USE_COOLDOWN / sys.useSpeedMul();
  sys.firingTimer = FIRING_POSE_HOLD * 0.5;
  if (!spray) {
    const charge = shieldChargeOf(q.defId);
    const p = sys.ctx.player as (PlayerRef & { applyHeal?: (a: number, s: number, quiet?: boolean) => boolean }) | null;
    if (charge) {
      // 실드 충전기: 체력이 아니라 실드를 채운다 (`Infinity` = 완전 회복). 이벤트는 player/ 가 낸다.
      p?.chargeShield?.(charge.amount);
    } else {
      const heal = q.def.heal;
      const amount = heal?.amount ?? q.def.healAmount ?? 50;
      if (heal && typeof p?.applyHeal === 'function') p.applyHeal(amount, heal.overTime);
      else host.applyStim(amount);
    }
  }
  sys.ctx.bus.emit('quick:used', { index: q.index, item: q.item, remaining });
  if (remaining <= 0) sys.returnToGun();
  }

/** Button released, swap, implant wield, death / downed, phase change, world reset: the hold is thrown away. */
export function cancelHeal(sys: WeaponSystem): void {
  if (!sys.healHeld) return;
  if (sys.healSpray) { sys.stopSpray(); return; }
  sys.healHeld = false; sys.healT = 0; sys.healSpray = false;
  sys.setConsumableSlow(false);
  sys.emitHeal(-1, true);
  }
