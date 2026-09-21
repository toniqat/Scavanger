/**
 * src/weapons/parts/Slots.ts — **the state of the weapon slots**.
 *
 * 1 `주무기 I` · 2 `주무기 II` (`WEAPON_SLOTS` — the secondary is off the list and `secondary` survives only for
 * the type and old saves) — which `ItemInstance` is in which slot, and what its effective stats · magazine ·
 * reserve · durability · attachments are. Changes on the inventory side (`loadout:changed`, socket changes, item
 * updates) arrive here and the weapon model and the HUD numbers are re-matched. **It does not fire.**
 */
import {
  WEAPON_SWAP_TIME_PRIMARY, WEAPON_SWAP_TIME_SECONDARY,
  isQuickSlotActive, type WeaponDef, type ItemInstance, type WeaponSlot, type EffectiveWeaponStats,
} from '@/shared';
import { WEAPON_SLOTS, defaultFor, statsFromDef } from '../WeaponDefaults';
import { WeaponModel, type WeaponAttachmentVisuals } from '../WeaponModel';
import { attachmentVisualsFor } from '../Attachments';
import { createUniqueHandler } from '../unique';
import { type WeaponInstance, _block, _blockInfo, _d, _md, _mq, _muzzle, _netDir, _o, _pd, _rep, _right, _tA, _tB, _target, _tmp } from '../model';
import type { WeaponSystem } from '../WeaponSystem';

export function resolveDef(sys: WeaponSystem, item: ItemInstance, slot: WeaponSlot): WeaponDef {
  const ctx = sys.ctx;
  const itemDef = ctx.loot?.getItemDef(item.defId) ?? ctx.inventory?.getDef(item.defId);
  let def: WeaponDef | undefined;
  if (itemDef?.weaponId) def = ctx.loot?.getWeaponDef(itemDef.weaponId);
  if (!def) def = ctx.loot?.getWeaponDef(item.defId);
  if (!def) {
    const d = defaultFor(slot);
    const other = defaultFor(slot === 'secondary' ? 'primary' : 'secondary');
    def = item.defId === other.id ? other : d;
  }
  return def;
  }

/** Graded + socketed stats for the instance (loot service), else derived from the bare def. */
export function resolveStats(sys: WeaponSystem, inst: ItemInstance, def: WeaponDef): EffectiveWeaponStats {
  const loot = sys.ctx.loot;
  let stats: EffectiveWeaponStats | null = null;
  if (loot && typeof loot.getEffectiveStats === 'function') {
    try { stats = loot.getEffectiveStats(inst); } catch { stats = null; }
    if (!stats) { try { stats = loot.getEffectiveStats(def.id); } catch { stats = null; } }
  }
  return stats ?? statsFromDef(def);
  }

/** Attachment visuals from the instance's sockets (`att_brake`, `att_laser`, …) via the item defs (shared helper). */
export function attachmentsFor(sys: WeaponSystem, inst: ItemInstance): WeaponAttachmentVisuals {
  return attachmentVisualsFor(sys.ctx, inst);
  }

export function onLoadout(sys: WeaponSystem, items: Record<WeaponSlot, ItemInstance | null>): void {
  sys.loadoutWait = -1;
  for (const slot of WEAPON_SLOTS) {
    const item = items[slot];
    const cur = sys.slots[slot];
    if (!item) { if (cur) { sys.flush(cur); sys.setSlot(slot, null); } continue; }
    if (cur && cur.uid === item.uid) {
      // same weapon, possibly a fresh instance object → keep the inventory's reference and re-read its stats
      if (cur.inst !== item) cur.inst = item;
      cur.stats = sys.resolveStats(item, cur.def);
      cur.model.setAttachments(sys.attachmentsFor(item));
      sys.attachDirty = true;
      continue;
    }
    if (cur) sys.flush(cur);
    const def = sys.resolveDef(item, slot);
    const stats = sys.resolveStats(item, def);
    const model = new WeaponModel(def);
    model.setAttachments(sys.attachmentsFor(item));
    const unique = def.unique ? createUniqueHandler(def.unique, sys.services) : null;
    sys.setSlot(slot, { uid: item.uid, slot, def, inst: item, stats, model, unique, ammoFrac: 0, durFrac: 0 });
    sys.initInstanceFields(sys.slots[slot]!);
  }
  // make sure something usable is in hand
  if (!sys.slots[sys.active]) {
    const next = sys.nextOccupied(sys.active);
    if (next) sys.active = next;
  }
  if (sys.phase === 'reloading') sys.cancelReload();
  if (sys.phase === 'swapping') { sys.phase = 'ready'; }
  sys.attachActive(true);
  sys.emitGrenadeCount();
  }

/** `ammoInMag` / `durability` undefined on the instance → treat as full (loot normally initialises both). */
export function initInstanceFields(sys: WeaponSystem, w: WeaponInstance): void {
  if (w.inst.ammoInMag === undefined) w.inst.ammoInMag = w.stats.magSize;
  if (w.inst.durability === undefined) w.inst.durability = w.stats.maxDurability;
  // 2026-09-15: a bow saved with the old 12-arrow quiver-magazine hands the extra arrows back to the bag. Whatever does
  // not fit stays in the magazine (it is spent first and never reloaded, so nothing is lost and the counts stay right).
  if (w.unique?.autoFeed && w.inst.ammoInMag > w.stats.magSize) {
    const back = returnRoundsCounted(sys, w, w.inst.ammoInMag - w.stats.magSize);
    if (back > 0) { w.inst.ammoInMag -= back; sys.persist(w, { ammoInMag: w.inst.ammoInMag }); }
  }
  }

/**
 * 2026-09-15 (「롱혼」 no reload): a weapon whose unique handler has `autoFeed` keeps its magazine topped up from
 * the carried ammo — no reload phase, no `weapon:reload*`, no net `reload`. Called by the handler (`UniqueServices.feed`)
 * from its per-frame update (never from inside an inventory event). Moves `magSize − mag` rounds of the calibre from the
 * bag onto the instance, persists, and re-announces the ammo (so `ammoInMag + reserveRounds` is always the rounds carried).
 * Returns true when anything moved.
 */
export function autoFeed(sys: WeaponSystem, w: WeaponInstance): boolean {
  if (!w.unique?.autoFeed) return false;
  const mag = sys.magOf(w);
  const need = w.stats.magSize - mag;
  if (need <= 0) return false;
  let n = 0;
  const inv = sys.ctx.inventory;
  if (inv) {
    const type = w.stats.ammoType;
    sys.selfWriting = true;
    try { n = inv.consumeWhere((d) => d.category === 'ammo' && d.ammoType === type, need); } finally { sys.selfWriting = false; }
  } else {
    const r = sys.reserveOf(w);
    n = Math.min(need, r);
    sys.fallbackReserve.set(w.uid, r - n);
  }
  if (n <= 0) return false;
  w.inst.ammoInMag = mag + n;
  sys.persist(w, { ammoInMag: w.inst.ammoInMag });
  if (w === sys.slots[sys.active]) sys.emitAmmo(w);
  return true;
  }

export function setSlot(sys: WeaponSystem, slot: WeaponSlot, inst: WeaponInstance | null): void {
  const cur = sys.slots[slot];
  if (cur) {
    if (sys.attachedModel === cur.model) { cur.unique?.onUnequip(cur); cur.model.root.removeFromParent(); sys.attachedModel = null; }
    cur.unique?.dispose();
    cur.model.dispose();
  }
  sys.slots[slot] = inst;
  }

/** Next occupied slot after `from` in 1 → 2 → 3 order (wrapping), or null. */
export function nextOccupied(sys: WeaponSystem, from: WeaponSlot): WeaponSlot | null {
  const i = WEAPON_SLOTS.indexOf(from);
  for (let k = 1; k < WEAPON_SLOTS.length; k++) {
    const s = WEAPON_SLOTS[(i + k) % WEAPON_SLOTS.length];
    if (sys.slots[s]) return s;
  }
  return null;
  }

/** Parent the active weapon model to the hand socket and announce it. */
export function attachActive(sys: WeaponSystem, announce: boolean): void {
  const host = sys.getHost();
  const weapon = sys.slots[sys.active];
  if (sys.attachedModel && (!weapon || sys.attachedModel !== weapon.model)) {
    const prev = sys.findByModel(sys.attachedModel);
    prev?.unique?.onUnequip(prev);
    sys.attachedModel.root.removeFromParent();
    sys.attachedModel = null;
  }
  if (!weapon || !host) { if (announce && !weapon) sys.emitEmpty(); if (!weapon) sys.applyAimZoom(null); return; }
  if (sys.attachedModel !== weapon.model) {
    host.getWeaponSocket().add(weapon.model.root);
    sys.attachedModel = weapon.model;
    weapon.model.setDraw(1);
    weapon.model.setReload(-1);
    weapon.model.setBolt(-1);
    sys.boltTimer = 0;
    weapon.unique?.onEquip(weapon);
  }
  if (sys.quick) {
    // a consumable is in hand: the gun stays parented but drawn down, no zoom, no `weapon:equipped`
    if (sys.quickHolsterT <= 0) weapon.model.setDraw(0);
    sys.applyAimZoom(null);
    return;
  }
  sys.applyAimZoom(sys.holstered ? null : sys.zoomStatsFor(weapon));
  if (announce) {
    const st = weapon.stats;
    sys.ctx.bus.emit('weapon:equipped', {
      slot: sys.active, weaponId: st.weaponId, name: weapon.def.name, magSize: st.magSize,
      ammoInMag: sys.magOf(weapon), reserveRounds: sys.reserveOf(weapon),
    });
    sys.emitAmmo(weapon);
    sys.emitDurability(weapon);
  }
  }

export function emitEmpty(sys: WeaponSystem): void {
  sys.ctx.bus.emit('weapon:equipped', { slot: sys.active, weaponId: '', name: '', magSize: 0, ammoInMag: 0, reserveRounds: 0 });
  sys.applyAimZoom(null);
  }

/* ─────────────────────────── ammo / durability state (lives on the ItemInstance) ─────────────────────────── */
export function magOf(sys: WeaponSystem, w: WeaponInstance): number {
  const v = w.inst.ammoInMag;
  return v === undefined ? w.stats.magSize : Math.max(0, v);
  }

export function durabilityOf(sys: WeaponSystem, w: WeaponInstance): number {
  const v = w.inst.durability;
  return v === undefined ? w.stats.maxDurability : Math.max(0, v);
  }

/** Rounds of the weapon's calibre in the bag (v2); dev fallback without an inventory = `magSize × reserveMags`. */
export function reserveOf(sys: WeaponSystem, w: WeaponInstance): number {
  const inv = sys.ctx.inventory;
  if (inv) {
    const type = w.stats.ammoType;
    return inv.countWhere((d) => d.category === 'ammo' && d.ammoType === type);
  }
  let r = sys.fallbackReserve.get(w.uid);
  if (r === undefined) { r = w.def.magSize * w.def.reserveMags; sys.fallbackReserve.set(w.uid, r); }
  return r;
  }

/**
 * Persist `ammoInMag` / `durability` through the inventory so it emits `inventory:itemUpdated` for the HUD / bag UI.
 * The fields are already written on the shared instance; `selfWriting` makes us ignore the echoed events.
 */
export function persist(sys: WeaponSystem, w: WeaponInstance, patch: { durability?: number; ammoInMag?: number }): void {
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.updateItem !== 'function') return;
  sys.selfWriting = true;
  try { inv.updateItem(w.uid, patch); } finally { sys.selfWriting = false; }
  }

export function flush(sys: WeaponSystem, w: WeaponInstance): void {
  sys.persist(w, { ammoInMag: sys.magOf(w), durability: sys.durabilityOf(w) });
  }

export function flushAll(sys: WeaponSystem): void {
  for (const s of WEAPON_SLOTS) { const w = sys.slots[s]; if (w) sys.flush(w); }
  }

export function emitAmmo(sys: WeaponSystem, w: WeaponInstance): void {
  sys.ctx.bus.emit('weapon:ammoChanged', { weaponId: w.stats.weaponId, ammoInMag: sys.magOf(w), magSize: w.stats.magSize, reserveRounds: sys.reserveOf(w) });
  }

export function emitDurability(sys: WeaponSystem, w: WeaponInstance): void {
  sys.ctx.bus.emit('weapon:durabilityChanged', { uid: w.uid, weaponId: w.stats.weaponId, durability: sys.durabilityOf(w), max: w.stats.maxDurability });
  }

export function findByUid(sys: WeaponSystem, uid: string): WeaponInstance | null {
  for (const s of WEAPON_SLOTS) { const w = sys.slots[s]; if (w && w.uid === uid) return w; }
  return null;
  }

export function findByModel(sys: WeaponSystem, model: WeaponModel): WeaponInstance | null {
  for (const s of WEAPON_SLOTS) { const w = sys.slots[s]; if (w && w.model === model) return w; }
  return null;
  }

/** Stats to aim with: a unique without `allowsAim` aims at zoom 1 (RMB is its alt fire — since 2026-09-14 the bow's too, RMB cancels the draw). */
export function zoomStatsFor(sys: WeaponSystem, w: WeaponInstance): EffectiveWeaponStats | null {
  if (w.unique && !w.unique.allowsAim) return null;
  return w.stats;
  }

/** `inventory:itemUpdated` (repair at the workbench, unload, external edits): adopt the instance and re-announce. */
export function onItemUpdated(sys: WeaponSystem, item: ItemInstance): void {
  if (sys.selfWriting) return;
  const w = sys.findByUid(item.uid);
  if (!w) return;
  if (w.inst !== item) {
    // a different object for the same uid → mirror the persistent fields onto ours and adopt it
    w.inst = item;
    sys.attachDirty = true;
  }
  // (an `autoFeed` bow may still hold arrows from the old 12-arrow magazine that did not fit the bag — never clamp those away)
  if (!w.unique?.autoFeed && w.inst.ammoInMag !== undefined && w.inst.ammoInMag > w.stats.magSize) w.inst.ammoInMag = w.stats.magSize;
  sys.emitDurability(w);
  if (w === sys.slots[sys.active]) sys.emitAmmo(w);
  }

/** `inventory:socketChanged`: stats (mag size, spread, zoom, …) and the attachment meshes change. */
export function onSocketChanged(sys: WeaponSystem, item: ItemInstance): void {
  const w = sys.findByUid(item.uid);
  if (!w) return;
  if (w.inst !== item) w.inst = item;
  w.stats = sys.resolveStats(w.inst, w.def);
  w.model.setAttachments(sys.attachmentsFor(w.inst));
  sys.attachDirty = true;
  // a smaller magazine (extended mag removed) → hand the excess rounds back to the bag when possible
  const mag = sys.magOf(w);
  if (mag > w.stats.magSize) {
    const excess = mag - w.stats.magSize;
    w.inst.ammoInMag = w.stats.magSize;
    sys.returnRounds(w, excess);
    sys.persist(w, { ammoInMag: w.inst.ammoInMag });
  }
  if (w === sys.slots[sys.active]) {
    if (!sys.holstered) sys.applyAimZoom(sys.zoomStatsFor(w));
    sys.emitAmmo(w);
  }
  sys.emitDurability(w);
  }

/** Try to put `rounds` of the weapon's calibre back into the bag (best effort; leftovers are lost). */
export function returnRounds(sys: WeaponSystem, w: WeaponInstance, rounds: number): void {
  returnRoundsCounted(sys, w, rounds);
  }

/** `returnRounds` that reports how many rounds actually went back (2026-09-15 — the bow keeps what did not fit). */
function returnRoundsCounted(sys: WeaponSystem, w: WeaponInstance, rounds: number): number {
  const loot = sys.ctx.loot, inv = sys.ctx.inventory;
  if (!loot || !inv || rounds <= 0) return 0;
  const type = w.stats.ammoType;
  const ammoDef = loot.getAllItemDefs().find((d) => d.category === 'ammo' && d.ammoType === type);
  if (!ammoDef) return 0;
  let left = rounds;
  while (left > 0) {
    const n = Math.min(left, Math.max(1, ammoDef.stackMax));
    if (!inv.tryAddItem(loot.createItem(ammoDef.id, n))) break;
    left -= n;
  }
  return rounds - left;
  }

/** Bag contents changed (ammo picked up / dropped / consumed) → refresh the reserve on the HUD. */
export function onInventoryChanged(sys: WeaponSystem): void {
  if (sys.selfWriting || sys.quickBusy) return;
  const w = sys.slots[sys.active];
  if (w && !sys.holstered && !sys.quick) sys.emitAmmo(w);
  if (sys.quick) sys.emitGrenadeCount();
  }

/* ─────────────────────────── swap ─────────────────────────── */
export function requestSwap(sys: WeaponSystem, slot: WeaponSlot | null): void {
  if (sys.phase === 'swapping') return;
  if (!slot || !sys.slots[slot]) {
    sys.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 });
    return;
  }
  const fromQuick = !!sys.quick;
  if (slot === sys.active && sys.attachedModel && !fromQuick) return;
  if (fromQuick) sys.leaveQuick();
  if (sys.phase === 'reloading') sys.cancelReload();
  const cur = sys.slots[sys.active];
  if (cur) sys.flush(cur);
  sys.phase = 'swapping';
  sys.boltTimer = 0; sys.boltSoundTimer = 0;
  cur?.model.setBolt(-1);
  sys.swapTimer = 0;
  sys.swapTarget = slot;
  sys.swapSwitched = false;
  const target = sys.slots[slot]!;
  sys.swapDuration = Math.max(0.05, target.stats.swapTime || (slot === 'secondary' ? WEAPON_SWAP_TIME_SECONDARY : WEAPON_SWAP_TIME_PRIMARY));
  // coming from a consumable the gun is already drawn down: skip the holster half, play the draw half only
  if (fromQuick) sys.swapTimer = sys.swapDuration * 0.5;
  sys.ctx.bus.emit('weapon:swapStarted', { slot, duration: fromQuick ? sys.swapDuration * 0.5 : sys.swapDuration });
  sys.ctx.bus.emit('audio:play', { id: 'weapon_swap', volume: 0.6 });
  }

export function updateSwap(sys: WeaponSystem, dt: number): void {
  sys.swapTimer += dt;
  const t = Math.min(1, sys.swapTimer / sys.swapDuration);
  const cur = sys.slots[sys.active];
  if (t < 0.5) {
    if (cur && sys.attachedModel === cur.model) cur.model.setDraw(1 - t * 2);
  } else {
    if (!sys.swapSwitched) {
      sys.swapSwitched = true;
      sys.active = sys.swapTarget;
      sys.attachActive(true);
      sys.slots[sys.active]?.model.setDraw(0);
    }
    sys.slots[sys.active]?.model.setDraw((t - 0.5) * 2);
  }
  if (t >= 1) { sys.phase = 'ready'; sys.slots[sys.active]?.model.setDraw(1); }
  }

/** Keep the hand on `cur` when it is our stack (or a same-def sibling stack); false when the slot no longer fits. */
export function adoptSlot(sys: WeaponSystem, cur: ItemInstance | null | undefined): boolean {
  const q = sys.quick;
  if (!q || !cur || cur.qty <= 0 || cur.defId !== q.defId || !isQuickSlotActive(q.index, sys.quickSlotCount())) return false;
  q.uid = cur.uid; q.item = cur;
  return true;
  }
