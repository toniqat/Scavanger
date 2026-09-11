/**
 * src/weapons/parts/QuickUse.ts — **빠른 사용** (T 탭 / 홀드 휠).
 *
 * 소모품 · 가젯을 손에 드는 경로 전체: 휠 열기/닫기, 슬롯 해석, 무기 홀스터, 손에 든 것을 놓고
 * 총으로 돌아가기, 그리고 들쳐메기 중에는 모든 행동을 `dropCarried` 로 바꾸는 `carryGate`.
 * 2026-09-11: 손에 든 원격 지뢰(C4)의 우클릭 기폭 · 슬롯이 빈 뒤의 **기폭기 손** · 드론 조종기 손.
 */
import * as THREE from 'three';
import {
  GameContext, Keys, MouseButtons, WEAPON_DURABILITY_PER_SHOT, WEAPON_SWAP_TIME_PRIMARY, WEAPON_SWAP_TIME_SECONDARY,
  IMPLANT_OVERCHARGE_FIRERATE_MUL,
  QUICK_SLOTS, QUICK_SLOT_UNLOCK_ORDER, QUICK_USABLE_CATEGORIES, isQuickSlotActive, QUICK_WHEEL_HOLD, QUICK_WHEEL_DRAG_PX, GRENADE_FUSE, GRENADE_COOK_MAX, GRENADE_UNDERHAND_SPEED_MUL,
  HEAL_HOLD_S, CONSUMABLE_SLOW_KEY, CONSUMABLE_SLOW_MUL, DEFIB_USE_TIME_S,
  droneKindOfGadget,
  type GameSystem, type WeaponDef, type ItemInstance, type ItemDef, type PlayerRef, type PlayerWeaponHost, type EnemyRef, type Vec3Tuple,
  type WeaponSlot, type EffectiveWeaponStats, type WeaponClass, type GadgetId, type WeaponRemoteState,
} from '@/shared';
import type { Obstacle as WorldObstacle, InterceptableRef, PeerId } from '@/shared';
import { ARMOR_IMMUNE_AMMO } from '@/shared';
import { FxManager } from '@/core/fx';
import { randomInCone } from '@/core/util/MathUtil';
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
import { BLOOM_DECAY, BLOOM_PER_SHOT, BOLT_SOUND_DELAY, BROKEN_NOTIFY_INTERVAL, CHANNEL_EMIT_HZ, DETONATOR_CONFIRM_GRACE_S, DETONATOR_UID_PREFIX, FIRING_POSE_HOLD, GRENADE_MIN_FUSE, GRENADE_THROW_LIFT, GRENADE_THROW_SPEED, GRENADE_UNDERHAND_LIFT, type HitInfo, type Host, LOADOUT_FALLBACK_DELAY, MOVING_SPREAD_MUL, QUICK_HOLSTER_TIME, QUICK_USE_COOLDOWN, type QuickHand, type QuickKind, SPRAY_SEND_INTERVAL, SPRINT_SPREAD_MUL, type WeaponInstance, _block, _blockInfo, _d, _md, _mq, _muzzle, _netDir, _o, _pd, _rep, _right, _tA, _tB, _target, _tmp, gaugeOf, makeHit, toTuple, useTimeOf } from '../model';
import type { WeaponSystem } from '../WeaponSystem';

/** 2026-09-11: 원격 지뢰(C4) 가젯 id. */
const REMOTE_MINE: GadgetId = 'remoteMine';

/** True when `def` is a drone item (`droneGround` / `droneAir`) — in the hand it is the drone's controller. */
function isDroneDef(def: ItemDef | null | undefined): boolean {
  return !!def && droneKindOfGadget(def.gadgetId as GadgetId | undefined) !== null;
}

/**
 * Phase 10 들쳐메기 gate. While `ctx.player.carrying` holds a squadmate, every weapon action (fire, melee, swap,
 * throw, quick use, reload) puts the body down first and does nothing else this frame. Returns true when the frame
 * was spent dropping. Duck-typed so a player build without the carry API can never break the trigger.
 */
export function carryGate(sys: WeaponSystem, usable: boolean): boolean {
  const p = sys.ctx.player as (PlayerRef & { carrying?: string | null }) | null;
  if (!usable || !p || typeof p.dropCarried !== 'function' || p.carrying == null) return false;
  const input = sys.ctx.input;
  // 2026-09-11: 드론 조종기를 든 손에서 R 은 무기 행동이 아니다 (드론 코어가 R 홀드를 읽는다)
  const droneHand = !!sys.quick && isDroneDef(sys.quick.def);
  const acted = input.isMouseDown(MouseButtons.FIRE) || input.wasMousePressed(MouseButtons.FIRE)
    || input.wasMousePressed(MouseButtons.AIM)
    || (!droneHand && input.wasPressed(Keys.RELOAD)) || input.wasPressed(Keys.QUICK) || input.wasPressed(Keys.MELEE)
    || input.wasPressed(Keys.PRIMARY) || input.wasPressed(Keys.PRIMARY2) || input.wasPressed(Keys.SECONDARY);
  if (!acted) return false;
  p.dropCarried('action');
  return true;
  }

/**
 * LMB with a gadget in hand: `ctx.gadgets.use` consumes the item itself; RMB toggles over / under-hand.
 * 2026-09-11: a drone item is **not** consumed (`use` returns true, the stack stays) → it simply stays in the hand as
 * the controller. The last 원격 지뢰 placed → the hand becomes the 기폭기 instead of going back to the gun.
 */
export function useGadget(sys: WeaponSystem, host: Host, q: QuickHand): void {
  const gadgets = sys.ctx.gadgets;
  const id = q.def.gadgetId as GadgetId | undefined;
  if (!gadgets || !id) { sys.deny(); return; }
  const inv = sys.ctx.inventory;
  sys.quickBusy = true;
  let ok = false;
  try { ok = gadgets.use(id, sys.gadgetUnderhand); } finally { sys.quickBusy = false; }
  if (!ok) { sys.deny(); return; }
  sys.quickCooldown = QUICK_USE_COOLDOWN / sys.useSpeedMul();
  sys.firingTimer = FIRING_POSE_HOLD * 0.5;
  host.addRecoil(0.01, 0);
  const cur = inv && typeof inv.getQuickSlots === 'function' ? inv.getQuickSlots()[q.index] : null;
  const remaining = sys.adoptSlot(cur) ? Math.max(0, cur!.qty) : 0;
  sys.ctx.bus.emit('quick:used', { index: q.index, item: q.item, remaining });
  if (remaining > 0) return;
  // 리드 결정 (2026-09-11): 마지막 C4 를 설치해 슬롯이 비어도 손은 기폭기로 남는다
  if (id === REMOTE_MINE && sys.equipDetonator(q.defId, true)) return;
  sys.returnToGun();
  }

/* ─────────────────────────── 2026-09-11: 원격 지뢰 기폭 · 기폭기 손 ─────────────────────────── */

/** Remote mines the local player still has in the world (0 when gadgets/ does not publish the count). */
export function liveRemoteMines(sys: WeaponSystem): number {
  const g = sys.ctx.gadgets;
  if (!g || typeof g.liveRemoteMineCount !== 'function') return 0;
  const n = g.liveRemoteMineCount();
  return Number.isFinite(n) ? Math.max(0, n) : 0;
  }

/**
 * RMB with a C4 or the 기폭기 in hand: every armed remote mine of mine goes off (`GadgetsRef.detonateRemoteMines`,
 * a non-host sends the request). Nothing to detonate → deny. A short thumb-press kick on success.
 */
export function detonateHeld(sys: WeaponSystem, host: Host): void {
  const g = sys.ctx.gadgets;
  const n = g && typeof g.detonateRemoteMines === 'function' ? g.detonateRemoteMines() : 0;
  if (!(n > 0)) { sys.deny(); return; }
  sys.quickCooldown = QUICK_USE_COOLDOWN / sys.useSpeedMul();
  sys.firingTimer = FIRING_POSE_HOLD * 0.3;
  host.addRecoil(0.004, 0);
  sys.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.55 });
  }

/** The synthetic `qty: 0` instance + def the 기폭기 hand shows (`defId` null = the remote-mine item def from loot). */
function detonatorSlot(sys: WeaponSystem, defId: string | null): { item: ItemInstance; def: ItemDef } | null {
  const loot = sys.ctx.loot, inv = sys.ctx.inventory;
  let id = defId ?? sys.detonatorItem?.defId ?? null;
  if (!id && loot) id = loot.getAllItemDefs().find((d) => d.gadgetId === REMOTE_MINE)?.id ?? null;
  if (!id) return null;
  const def = loot?.getItemDef(id) ?? inv?.getDef(id);
  if (!def) return null;
  if (!sys.detonatorItem || sys.detonatorItem.defId !== id) {
    sys.detonatorItem = { uid: DETONATOR_UID_PREFIX + id, defId: id, qty: 0, rotated: false };
  }
  return { item: sys.detonatorItem, def };
  }

/**
 * Take the 기폭기 into the hand (virtual, not bound to a quick slot): `quick:equipped {index: null, item}` with the
 * synthetic instance, `remoteState.heldItemId` = the C4 def id. `fromPlacement` = the last C4 was just placed — the hand
 * swaps silently and survives `DETONATOR_CONFIRM_GRACE_S` of a 0 count (a non-host's mine is not counted until the host
 * confirms it). Returns false when no remote-mine item def exists.
 */
export function equipDetonator(sys: WeaponSystem, defId: string | null, fromPlacement: boolean): boolean {
  const host = sys.getHost();
  const slot = detonatorSlot(sys, defId);
  if (!host || !slot) return false;
  sys.lastQuickDetonator = true;
  sys.detonatorGraceT = fromPlacement ? DETONATOR_CONFIRM_GRACE_S : 0;
  if (sys.quick?.detonator) return true;
  takeIntoHand(sys, host, {
    index: -1, uid: slot.item.uid, defId: slot.item.defId, item: slot.item, def: slot.def, kind: 'gadget', detonator: true,
  }, null, !fromPlacement);
  return true;
  }

/**
 * The 기폭기 in hand, every frame: back to the gun once no mine of mine is left (after the confirm grace, never while
 * looking through a drone — the hand stays as it was until the control ends). LMB = deny + `원격 지뢰 없음` (throttled),
 * RMB = detonate. Weapon keys / T tap / the wheel leave it through the usual paths.
 */
export function updateDetonator(sys: WeaponSystem, dt: number, host: Host, inputFree: boolean): void {
  if (sys.detonatorGraceT > 0) sys.detonatorGraceT = Math.max(0, sys.detonatorGraceT - dt);
  if (liveRemoteMines(sys) > 0) sys.detonatorGraceT = 0;
  else if (sys.detonatorGraceT <= 0 && sys.ctx.player?.droneControl !== true) { sys.returnToGun(); return; }
  if (!inputFree || sys.quickCooldown > 0 || sys.quickHolsterT > 0) return;
  const input = sys.ctx.input;
  if (input.wasMousePressed(MouseButtons.AIM)) { sys.detonateHeld(host); return; }
  if (input.wasMousePressed(MouseButtons.FIRE)) {
    sys.deny();
    if (sys.ctx.time - sys.detonatorNotifyAt >= BROKEN_NOTIFY_INTERVAL) {
      sys.detonatorNotifyAt = sys.ctx.time;
      sys.ctx.bus.emit('ui:notify', { text: '원격 지뢰 없음', kind: 'warning' });
    }
  }
  }

/* ─────────────────────────── quick-use (F): wheel & consumable in hand ─────────────────────────── */
/**
 * F pressed → hold timer. Released before `QUICK_WHEEL_HOLD` = tap (last used consumable, else the first usable slot).
 * Held longer = wheel: look locked, mouse delta accumulated, hover = 8-way direction once the drag exceeds
 * `QUICK_WHEEL_DRAG_PX`; release equips the hovered slot.
 */
export function updateQuickKey(sys: WeaponSystem, dt: number, host: Host, usable: boolean): void {
  const input = sys.ctx.input;
  if (!sys.quickKeyHeld) {
    if (usable && input.wasPressed(Keys.QUICK)) { sys.quickKeyHeld = true; sys.quickHoldT = 0; }
    return;
  }
  if (!usable) { sys.closeWheel(host); sys.quickKeyHeld = false; return; }
  if (!input.isDown(Keys.QUICK)) {
    // release
    sys.quickKeyHeld = false;
    if (sys.wheelOpen) {
      const hover = sys.wheelHover;
      sys.closeWheel(host);
      if (hover !== null) sys.equipQuick(hover);
    } else sys.quickTap();
    return;
  }
  sys.quickHoldT += dt;
  if (!sys.wheelOpen) {
    if (sys.quickHoldT < QUICK_WHEEL_HOLD) return;
    sys.wheelOpen = true;
    sys.wheelDX = 0; sys.wheelDY = 0; sys.wheelHover = null;
    host.setLookLocked(true);
    sys.ctx.bus.emit('quick:wheelChanged', { open: true, hover: null });
    sys.ctx.bus.emit('audio:play', { id: 'ui_open', volume: 0.35 });
    return;
  }
  sys.wheelDX += input.mouseDX; sys.wheelDY += input.mouseDY;
  let hover: number | null = null;
  if (sys.wheelDX * sys.wheelDX + sys.wheelDY * sys.wheelDY >= QUICK_WHEEL_DRAG_PX * QUICK_WHEEL_DRAG_PX) {
    // 0 = N (up), clockwise; screen y grows downward
    const ang = Math.atan2(sys.wheelDX, -sys.wheelDY);
    const idx = ((Math.round(ang / (Math.PI / 4)) % QUICK_SLOTS) + QUICK_SLOTS) % QUICK_SLOTS;
    hover = sys.quickSlotItem(idx) ? idx : null;
  }
  if (hover !== sys.wheelHover) {
    sys.wheelHover = hover;
    sys.ctx.bus.emit('quick:wheelChanged', { open: true, hover });
    if (hover !== null) sys.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.3 });
  }
  }

export function closeWheel(sys: WeaponSystem, host: Host): void {
  if (!sys.wheelOpen) return;
  sys.wheelOpen = false; sys.wheelHover = null;
  host.setLookLocked(false);
  sys.ctx.bus.emit('quick:wheelChanged', { open: false, hover: null });
  }

/** First usable quick slot holding a 원격 지뢰, or null. */
function firstRemoteMineSlot(sys: WeaponSystem): number | null {
  for (const i of QUICK_SLOT_UNLOCK_ORDER) {
    const s = sys.quickSlotItem(i);
    if (s && s.def.gadgetId === REMOTE_MINE) return i;
  }
  return null;
  }

/**
 * F tap: the last used consumable (else the first usable slot) into the hand; the same item again → back to the gun.
 * 2026-09-11: with my remote mines still in the world, the 기폭기 is a tap target too — when no slot is usable, or when
 * the last thing used was the C4 / 기폭기 and its slot is empty now. A C4 still sitting in a slot always wins over the
 * virtual 기폭기 (that hand detonates with RMB as well). Tapping with the 기폭기 in hand and nothing else to pick → gun.
 */
export function quickTap(sys: WeaponSystem): void {
  let index: number | null = null;
  const live = liveRemoteMines(sys) > 0;
  if (sys.lastQuickIndex !== null && sys.quickSlotItem(sys.lastQuickIndex)) index = sys.lastQuickIndex;
  else if (live && sys.lastQuickDetonator) index = firstRemoteMineSlot(sys);
  else {
    for (const i of QUICK_SLOT_UNLOCK_ORDER) if (sys.quickSlotItem(i)) { index = i; break; }
  }
  if (index === null) {
    if (sys.quick?.detonator) { sys.returnToGun(); return; }
    if (live && sys.equipDetonator(null, false)) return;
    sys.deny();
    return;
  }
  if (sys.quick && !sys.quick.detonator && sys.quick.index === index) { sys.returnToGun(); return; }
  sys.equipQuick(index);
  }

export function deny(sys: WeaponSystem): void { sys.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 }); }

export function quickSlotCount(sys: WeaponSystem): number {
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.getQuickSlotCount !== 'function') return 0;
  return Math.min(QUICK_SLOTS, inv.getQuickSlotCount());
  }

/**
 * Usable consumable (stim / grenade) in wheel slot `index`, or null (empty, slot locked for the bag's quick-slot
 * count — see `isQuickSlotActive` / `QUICK_SLOT_UNLOCK_ORDER` —, wrong category).
 */
export function quickSlotItem(sys: WeaponSystem, index: number): { item: ItemInstance; def: ItemDef } | null {
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.getQuickSlots !== 'function' || !isQuickSlotActive(index, sys.quickSlotCount())) return null;
  const item = inv.getQuickSlots()[index];
  if (!item || item.qty <= 0) return null;
  const def = sys.ctx.loot?.getItemDef(item.defId) ?? inv.getDef(item.defId);
  if (!def || !QUICK_USABLE_CATEGORIES.includes(def.category)) return null;
  return { item, def };
  }

/**
 * Shared by `equipQuick` and `equipDetonator`: end a grenade / heal hold, finish a swap, cancel a reload, flush and
 * draw the gun down, set the hand, neutral zoom, `quick:equipped {index: announceIndex, item}`.
 */
function takeIntoHand(sys: WeaponSystem, host: Host, hand: QuickHand, announceIndex: number | null, sound: boolean): void {
  // leaving a grenade hold for another item: a pulled pin is dropped at the feet, otherwise nothing happens
  if (sys.holding) sys.cancelHold(host);
  else sys.cancelHeal();
  if (sys.phase === 'reloading') sys.cancelReload();
  if (sys.phase === 'swapping') { sys.phase = 'ready'; sys.active = sys.swapTarget; sys.attachActive(false); }
  const cur = sys.slots[sys.active];
  if (cur) { sys.flush(cur); cur.model.setBolt(-1); cur.model.setReload(-1); }
  sys.boltTimer = 0; sys.boltSoundTimer = 0; sys.dryFlagged = false;
  const first = !sys.quick;
  sys.quick = hand;
  sys.quickHolsterT = first && sys.attachedModel ? QUICK_HOLSTER_TIME : 0;
  if (!first) sys.attachedModel?.setDraw(0);
  sys.applyAimZoom(null);
  sys.ctx.bus.emit('quick:equipped', { index: announceIndex, item: hand.item });
  if (sound) sys.ctx.bus.emit('audio:play', { id: 'weapon_swap', volume: 0.45 });
  }

/** Take wheel slot `index` into the hand (`active = 'quick'`): gun drawn down, one-handed pose, `quick:equipped`. */
export function equipQuick(sys: WeaponSystem, index: number): void {
  const host = sys.getHost();
  const slot = sys.quickSlotItem(index);
  if (!host || !slot) { sys.deny(); return; }
  if (sys.quick && sys.quick.uid === slot.item.uid) return;
  sys.lastQuickIndex = index;
  sys.lastQuickDetonator = slot.def.gadgetId === REMOTE_MINE;
  takeIntoHand(sys, host, {
    index, uid: slot.item.uid, defId: slot.item.defId, item: slot.item, def: slot.def, kind: slot.def.category as QuickKind,
  }, index, true);
  }

/** Gun draw-down after taking a consumable (0.15 s), then the model hides itself (`drawT` ≤ 0.02). */
export function updateQuickHolster(sys: WeaponSystem, dt: number): void {
  if (!sys.quick || sys.quickHolsterT <= 0) return;
  sys.quickHolsterT -= dt;
  sys.attachedModel?.setDraw(Math.max(0, sys.quickHolsterT / QUICK_HOLSTER_TIME));
  }

/** Clear the hand state (no swap, no events beyond `quick:equipped null`); the caller draws a gun or announces empty. */
export function leaveQuick(sys: WeaponSystem): void {
  if (!sys.quick) return;
  if (sys.holding) { const h = sys.getHost(); if (h) sys.cancelHold(h); }
  sys.quick = null;
  sys.quickHolsterT = 0;
  sys.detonatorGraceT = 0;
  sys.ctx.bus.emit('quick:equipped', { index: null, item: null });
  }

/** Back to the gun that was in hand before the consumable (else the next occupied slot, else empty hands). */
export function returnToGun(sys: WeaponSystem): void {
  if (!sys.quick) return;
  const target = sys.slots[sys.active] ? sys.active : sys.nextOccupied(sys.active);
  if (!target) { sys.leaveQuick(); sys.emitEmpty(); return; }
  sys.requestSwap(target);
  }

/**
 * Hard exit from the hand state on world reset / abort / holster: the hold ends without a throw (the grenade pool is
 * cleared right after anyway), the gun model comes back instantly without a swap animation.
 */
export function dropQuick(sys: WeaponSystem): void {
  sys.quickKeyHeld = false;
  const host = sys.getHost();
  if (host) sys.closeWheel(host);
  sys.cancelHeal();
  if (!sys.quick) return;
  sys.endHold(true);
  sys.quick = null;
  sys.quickHolsterT = 0;
  sys.detonatorGraceT = 0;
  sys.attachedModel?.setDraw(1);
  sys.ctx.bus.emit('quick:equipped', { index: null, item: null });
  }

/**
 * `inventory:quickSlotsChanged`: the consumable in hand vanished (dropped, moved, consumed elsewhere) → back to the
 * gun. A sibling stack of the same def that the inventory relinked into the slot is adopted instead.
 * 2026-09-11: the 기폭기 is not bound to a slot, so slot changes never kick it (it leaves when my mines are gone).
 */
export function onQuickSlotsChanged(sys: WeaponSystem, slots: readonly (ItemInstance | null)[]): void {
  if (!sys.quick || sys.quickBusy || sys.quick.detonator) return;
  if (!sys.adoptSlot(slots[sys.quick.index])) sys.returnToGun();
  }

/** LMB / R / RMB while a consumable is in hand. */
export function updateQuickHand(sys: WeaponSystem, dt: number, host: Host, usable: boolean, inputFree: boolean): void {
  const q = sys.quick!;
  const input = sys.ctx.input;
  if (q.detonator) { sys.updateDetonator(dt, host, inputFree); return; }
  if (sys.holding) {
    if (!usable) { sys.cancelHold(host); if (sys.quick && !sys.quickSlotItem(q.index)) sys.returnToGun(); return; }
    sys.updateHold(dt, host, q);
    return;
  }
  // Phase 10 / 2026-09-07: 소모품은 LMB 홀드로 쓴다. Death / downed / menu / a wielded implant clear `usable` → cancel.
  if (sys.healHeld) {
    if (!usable) { sys.cancelHeal(); if (sys.quick && !sys.quickSlotItem(q.index)) sys.returnToGun(); return; }
    sys.updateHeal(dt, host, q);
    return;
  }
  if (!inputFree || sys.quickCooldown > 0 || sys.quickHolsterT > 0) return;
  if (q.kind === 'gadget' && input.wasMousePressed(MouseButtons.AIM)) {
    // 2026-09-11: C4 는 우클릭이 기폭이다. 드론 조종기는 우클릭에 할 일이 없다 (오버/언더 토글은 던지는 가젯의 것).
    // 드론 조종기의 R 도 여기서 읽지 않는다 — 재장전 · 쿠킹 · 취소 어느 것도 아니고 consume 도 하지 않는다 (드론 코어의 R 홀드).
    if (q.def.gadgetId === REMOTE_MINE) { sys.detonateHeld(host); return; }
    if (isDroneDef(q.def)) return;
    sys.gadgetUnderhand = !sys.gadgetUnderhand;
    sys.ctx.bus.emit('gadget:throwModeChanged', { underhand: sys.gadgetUnderhand });
    sys.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.3 });
    return;
  }
  if (!input.wasMousePressed(MouseButtons.FIRE)) return;
  if (q.kind === 'stim') sys.beginHeal(host, q);
  else if (q.kind === 'gadget') { if (useTimeOf(q.def) > 0) sys.beginHeal(host, q); else sys.useGadget(host, q); }
  else sys.beginHold();
  }

/**
 * Take one unit of the consumable in hand out of the bag. Returns the stack left (0 = gone) or −1 when nothing
 * could be consumed. The echoed `inventory:quickSlotsChanged` is ignored (`quickBusy`) so the `quick:used` event
 * goes out before we return to the gun.
 */
export function consumeQuick(sys: WeaponSystem, q: QuickHand): number {
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeItem !== 'function') return -1;
  let n = 0;
  sys.quickBusy = true;
  try { n = inv.consumeItem(q.uid, 1); } finally { sys.quickBusy = false; }
  if (n < 1) return -1;
  // at 0 the inventory relinks the slot to a sibling stack of the same def when it has one → keep it in hand
  const cur = typeof inv.getQuickSlots === 'function' ? inv.getQuickSlots()[q.index] : null;
  const remaining = sys.adoptSlot(cur) ? Math.max(0, cur!.qty) : 0;
  if (q.kind === 'grenade') sys.emitGrenadeCount();
  return remaining;
  }
