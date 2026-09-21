/**
 * src/weapons/parts/Healing.ts — **hold-to-use healing consumables**.
 *
 * `붕대` · `약초 붕대` · `회복주사` · `제세동기` need the left button **held** for their own per-item time
 * (`heal:holdChanged.dur`, movement 50 % meanwhile), while the heal spray burns its gauge and keeps healing the
 * user and every ally inside the radius. At gauge 0 the can does not disappear — it is repaired in the ship.
 */
import * as THREE from 'three';
import {
  MouseButtons, HEAL_HOLD_S, CONSUMABLE_SLOW_KEY, CONSUMABLE_SLOW_MUL, type ItemDef, type PlayerRef,
} from '@/shared';
import type { PeerId } from '@/shared';
import { buffLineClear } from '@/shared';
import { boostItemOf, shieldChargeOf } from '@/items';
import { BROKEN_NOTIFY_INTERVAL, CHANNEL_EMIT_HZ, FIRING_POSE_HOLD, type Host, QUICK_USE_COOLDOWN, type QuickHand, SPRAY_SEND_INTERVAL, _block, _blockInfo, _d, _md, _mq, _muzzle, _netDir, _o, _pd, _rep, _right, _tA, _tB, _target, _tmp, gaugeOf, useTimeOf } from '../model';
import type { WeaponSystem } from '../WeaponSystem';

/* ── Consumable use (Phase 10 heals → 2026-09-07 every healing consumable + the defibrillator) ─── */
/**
 * `heal:holdChanged` at ≤ 30 Hz. `t` = 0..1 of the item's own use time while holding (the remaining gauge for
 * the spray), `-1` on a cancel. `force` bypasses the throttle (start / finish / cancel must always land).
 */
export function emitHeal(sys: WeaponSystem, t: number, force: boolean, dur = HEAL_HOLD_S): void {
  if (!force && sys.ctx.time - sys.healEmitAt < 1 / 30) return;
  sys.healEmitAt = sys.ctx.time;
  sys.ctx.bus.emit('heal:holdChanged', { holding: sys.healHeld, t, dur, spray: sys.healSpray });
  }

/**
 * Phase 12 perk `quick_heal` (`가속 대사`): every hold-to-use time (a healing consumable and the defibrillator's
 * `DEFIB_USE_TIME_S`) is halved while the perk is active. The HUD ring reads the halved value from
 * `heal:holdChanged.dur`.
 */
export function holdTimeOf(sys: WeaponSystem, def: ItemDef): number {
  const base = useTimeOf(def);
  return sys.ctx.progression?.derived.perks?.quick_heal ? base * 0.5 : base;
  }

/**
 * `item:channelChanged` for the spray channel: `active:true` when it starts, ≤ `CHANNEL_EMIT_HZ` while it runs
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
 * 2026-09-10 — the shield charger: is there shield left to fill right now. With no armor (max 0) or already full
 * it is false, and then the hold does not even start — **because the item must not be consumed**
 * (`PlayerRef.chargeShield`'s contract).
 */
export function canChargeShield(sys: WeaponSystem): boolean {
  const p = sys.ctx.player;
  if (!p || typeof p.chargeShield !== 'function') return false;
  return p.maxShield > 0 && p.shield < p.maxShield;
  }

/**
 * LMB pressed with a healing consumable / shield charger / defibrillator in hand. A plain heal is refused at full
 * hp (the old instant-use rule); a shield charger is refused with no armor / a full shield; the spray is refused
 * only when its gauge is empty (it also heals squadmates), the defibrillator never checks hp. 2026-09-12: the
 * three combat boosts (`boostItemOf` — `아드레날린` · `각성제` · `안정제`) are never refused either.
 */
export function beginHeal(sys: WeaponSystem, host: Host, q: QuickHand): void {
  // 2026-09-10 the shield charger — the same hold · movement slow as a healing consumable, ending in chargeShield
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
  // 2026-09-12 the three combat boosts: the hold starts whatever the hp · implant state is (`안정제` is
  //   consumed even when full — user's decision)
  if (q.kind === 'stim' && !boostItemOf(q.defId) && host.hp >= host.maxHp) { sys.deny(); return; }
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
 * The heal spray: every `spray.tick` seconds one gauge unit is spent and `healPerTick` hp goes to the user and to
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
 * Phase 12: the spray channel ends (gauge empty, button released, swap, death, screen). The can is **never**
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

/**
 * Squadmates inside `radius` owe `hp` this tick (flushed as `buff heal` at `SPRAY_SEND_INTERVAL`).
 * 2026-09-11 (E-4): only those in the open — my chest → their chest must not cross world geometry
 * (`shared/buffLineClear`), so the mist no longer heals through walls. The receiver additionally caps range and rate.
 */
export function sprayAllies(sys: WeaponSystem, hp: number, radius: number): void {
  const net = sys.ctx.net;
  const me = sys.ctx.player;
  if (!net || !me || !sys.ctx.isMultiplayer) return;
  const r2 = radius * radius;
  _sprayFrom.copy(me.position); _sprayFrom.y += SPRAY_CHEST_Y;
  for (const peer of net.getRemotePlayers()) {
    if (!peer.connected || peer.isDead) continue;
    if (peer.position.distanceToSquared(me.position) > r2) continue;
    _sprayTo.copy(peer.position); _sprayTo.y += SPRAY_CHEST_Y;
    if (!buffLineClear(sys.ctx.world, _sprayFrom, _sprayTo)) continue;
    sys.sprayOwed.set(peer.id, (sys.sprayOwed.get(peer.id) ?? 0) + hp);
  }
  }

/** Chest height above the feet for the spray's line test (same as the overcharge beam's `CHEST_Y`). */
const SPRAY_CHEST_Y = 1.15;
const _sprayFrom = new THREE.Vector3();
const _sprayTo = new THREE.Vector3();

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

/** Hold completed: consume the item and apply its effect (the defibrillator hands off to the gadget path). */
export function finishHeal(sys: WeaponSystem, host: Host, q: QuickHand): void {
  const spray = q.def.heal?.spray;
  // the spray never "finishes" into a consume (Phase 12): its only end is `stopSpray`
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
    const boost = boostItemOf(q.defId);
    const p = sys.ctx.player as (PlayerRef & { applyHeal?: (a: number, s: number, quiet?: boolean) => boolean }) | null;
    if (boost) {
      // 2026-09-12 combat boosts: player holds the timed effects and implants refills for `안정제` (both are
      //   optional methods — with neither, the item is silently consumed and nothing else happens)
      if (boost.effect === 'implant_refill') {
        (sys.ctx.implants as { refillAll?(): void } | null)?.refillAll?.();
        sys.ctx.bus.emit('audio:play', { id: 'stim', volume: 0.7 });
      } else {
        p?.applyBoost?.(boost.effect, q.defId);
      }
    } else if (charge) {
      // The shield charger fills the shield, not hp (`Infinity` = a full refill). player/ emits the event.
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

/**
 * Button released, swap, implant wield, death / downed, phase change, world reset: the hold is thrown away.
 * 2026-09-21: the **right-button** ally hold (`parts/AllyHeal`) rides along here on purpose — every path that ends
 * a self hold ends an ally hold too, and folding it in means no cancel site had to learn about the second button.
 */
export function cancelHeal(sys: WeaponSystem): void {
  sys.cancelAllyHeal();
  if (!sys.healHeld) return;
  if (sys.healSpray) { sys.stopSpray(); return; }
  sys.healHeld = false; sys.healT = 0; sys.healSpray = false;
  sys.setConsumableSlow(false);
  sys.emitHeal(-1, true);
  }
