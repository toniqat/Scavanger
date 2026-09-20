/**
 * src/weapons/parts/AllyHeal.ts — **giving a healing consumable to a squadmate** (2026-09-21, user's decision).
 *
 * With `붕대` · `약초 붕대` · `회복주사` · the three `실드 충전기` in hand the two mouse buttons mean two different
 * uses of the same item: **LMB = on myself** (`parts/Healing`, unchanged, movement halved) and **RMB = on the
 * squadmate on the crosshair**. The ally use is deliberately the cheaper of the two — there is **no**
 * `CONSUMABLE_SLOW_MUL` on it, because the slow exists to make treating *yourself* mid-fight a commitment, and
 * standing still next to someone else already is.
 *
 * Who it lands on follows **the defibrillator's rule** (`parts/Defib` · gadgets' `findDownedAlly`): the body at the
 * **smallest angle off the aim ray**, not the nearest one. Human squadmates and **androids** are the same kind of
 * target here (`ctx.allies.getCombatBodies()`), exactly as they are for the defibrillator. Two thresholds, both
 * from `data/constants.csv`:
 *   - `HEAL_ALLY_RANGE_START` — how close they must be for the hold to *begin*;
 *   - `HEAL_ALLY_RANGE_HOLD`  — how far the *running* hold survives, so the target may take a step. Past that the
 *     channel cancels and **the item is not consumed** (the same contract as releasing the defibrillator with no target).
 * `HEAL_ALLY_AIM_CONE_DEG` is the half-angle, wider than `DEFIB_AIM_CONE_DEG`: the defibrillator picks one body lying
 * on the ground, this picks a squadmate who is standing and moving.
 *
 * A body the item could do nothing for is **not a target** (full hp for a heal, no armour / a full pool for a
 * charger) — otherwise the hold would spend the item on nothing. With nothing valid on the crosshair the right
 * button is **unavailable, not silent**: `heal:allyTargetChanged` carries the name (or null) every time it changes
 * and `ui/hud/HealGauge` draws the chip from it.
 *
 * **How it is applied** — two different paths, because the two kinds of body are owned by different code:
 *   - a **person** gets one `buff` (`kind: 'heal'` or `'shield'`, `amount` -1 = fill the pool up) sent straight to
 *     that peer and applied by `implants/parts/Wire.onBuff` behind `shared/buffRules.createBuffGuard` (shape →
 *     sender → distance → its own token bucket). Nothing new is broadcast and no host is involved; the receiver's
 *     guard is what makes a forged one harmless. It is also why a **downed** person is not a target here: `onBuff`
 *     refuses both kinds while the receiver is downed (that is the defibrillator's job).
 *   - an **android** goes through `AlliesRef.heal` / `chargeShield` (the authority applies at once, anyone else
 *     sends `allyq`). Those **return false** when there is nothing to do, so they are called **before**
 *     `consumeQuick` — a refusal must leave the item in the bag.
 */
import * as THREE from 'three';
import {
  HEAL_ALLY_AIM_CONE_DEG, HEAL_ALLY_RANGE_HOLD, HEAL_ALLY_RANGE_START, MouseButtons,
  buffLineClear, type AllyBodyView, type BuffMessage, type ItemDef, type PeerId,
} from '@/shared';
import { shieldChargeOf } from '@/items';
import { FIRING_POSE_HOLD, QUICK_USE_COOLDOWN, type Host, type QuickHand } from '../model';
import type { WeaponSystem } from '../WeaponSystem';

/** `heal:allyHoldChanged` send cap (30 Hz — the same as the self hold's `heal:holdChanged`). */
const EMIT_HZ = 30;

/**
 * An ally's 「chest」 height above their feet for the aim test and the line-of-sight test — the same 1.15 m
 * `parts/Defib`, `parts/Healing`'s spray and the overcharge beam use, so all four agree on where a body is.
 */
const CHEST_Y = 1.15;

const _o = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
const _from = new THREE.Vector3();
const _chest = new THREE.Vector3();

/**
 * What the item in hand would give a squadmate. `amount` is hp for `'heal'` and shield points for `'shield'`,
 * where **-1 means 「fill it up」** (`shield_charger_full`, whose `items.csv` `shieldHp` is negative → the def's
 * `amount` is `Infinity`) — the same -1 the wire and `AlliesRef.chargeShield` use.
 */
export interface AllyGift {
  kind: 'heal' | 'shield';
  amount: number;
}

/**
 * The gift this item is, or null when it cannot be given to anybody. The spray is excluded (it already heals
 * allies in an area on its own — `parts/Healing.updateSpray`), and so is anything with a `gadgetId` (the
 * defibrillator has its own aimed hold in `parts/Defib`) and the three combat boosts (`boostItemOf` rows carry no
 * `heal` and no `shieldHp`, so they fall out on their own).
 */
export function allyGiftOf(def: ItemDef): AllyGift | null {
  if (def.gadgetId) return null;
  const charge = shieldChargeOf(def.id);
  if (charge) return { kind: 'shield', amount: Number.isFinite(charge.amount) ? charge.amount : -1 };
  const heal = def.heal;
  if (!heal || heal.spray) return null;
  const amount = Math.max(0, heal.amount ?? def.healAmount ?? 0);
  return amount > 0 ? { kind: 'heal', amount } : null;
}

/**
 * Is the thing in hand an item the right button can give to a squadmate — **and is there anybody to give it to**.
 * The second half is why an empty solo raid never shows the chip: with no squadmate in the world the right button
 * is not 「unavailable」, it simply has no meaning, and a permanent `아군 없음` under the crosshair would be noise.
 * A **solo raid with an android squad is a normal situation**, so the android bodies count here too.
 */
export function isAllyHealHand(sys: WeaponSystem, q: QuickHand): boolean {
  if (q.detonator || q.kind !== 'stim' || !allyGiftOf(q.def)) return false;
  const ctx = sys.ctx;
  if ((ctx.net?.getRemotePlayers().length ?? 0) > 0) return true;
  return (ctx.allies?.getCombatBodies().length ?? 0) > 0;
}

/** A squadmate the right button would treat. `ally` = an android, which is applied through `ctx.allies`. */
export interface AllyHealTarget {
  id: string;
  name: string;
  position: THREE.Vector3;
  ally: boolean;
}

/** Would this gift do anything for a body with these pools? A `undefined` max is 「not known yet」, so it passes. */
function worthGiving(gift: AllyGift, hp: number, maxHp: number, shield: number | undefined, maxShield: number | undefined): boolean {
  if (gift.kind === 'heal') return !(maxHp > 0) || hp < maxHp;
  if (maxShield === undefined) return true;          // a peer whose armour is still unknown — let the receiver judge
  return maxShield > 0 && (shield ?? 0) < maxShield;
}

/**
 * The squadmate at the smallest angle off the crosshair inside `HEAL_ALLY_AIM_CONE_DEG` and `maxRange`, or null.
 * Dead, downed, stale and disconnected bodies are skipped (a downed one is the defibrillator's job — the
 * receiver's `onBuff` refuses a heal then, and `AlliesRef.heal` refuses too), and so is anyone the gift could do
 * nothing for. Androids come from `getCombatBodies()`, which already filters raid / alive / visible.
 */
export function pickAllyTarget(sys: WeaponSystem, host: Host, maxRange: number, gift: AllyGift): AllyHealTarget | null {
  const ctx = sys.ctx;
  const me = ctx.player;
  if (!me) return null;
  host.getAimRay(_o, _dir);
  _dir.normalize();
  const cos = Math.cos((HEAL_ALLY_AIM_CONE_DEG * Math.PI) / 180);
  const rangeSq = maxRange * maxRange;
  let bestCos = cos;
  let bestId: string | null = null;
  let bestName = '';
  let bestPos: THREE.Vector3 | null = null;
  let bestAlly = false;
  /** Angle test against the aim ray; `true` = this body is the new best. */
  const consider = (id: string, name: string, position: THREE.Vector3, ally: boolean): void => {
    if (position.distanceToSquared(me.position) > rangeSq) return;
    _to.copy(position); _to.y += CHEST_Y; _to.sub(_o);
    const len = _to.length();
    const c = len < 1e-3 ? 1 : _to.dot(_dir) / len;
    if (c < bestCos) return;
    bestCos = c; bestId = id; bestName = name; bestPos = position; bestAlly = ally;
  };
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (!r.connected || r.stale || r.isDead || r.isDowned) continue;
    if (!worthGiving(gift, r.hp, r.maxHp, r.shield, r.maxShield)) continue;
    consider(r.id, r.name, r.position, false);
  }
  for (const b of ctx.allies?.getCombatBodies() ?? []) {
    if (!worthGiving(gift, b.hp, b.maxHp, b.shield, b.maxShield)) continue;
    consider(b.id, b.name, b.position, true);
  }
  if (bestId === null || bestPos === null) return null;
  // The wall test runs **once, on the winner** — this is called every frame while the item is in hand, and
  // `buffLineClear` is a world raycast. Blocked = no target at all (the next body along is not a silent fallback).
  _from.copy(me.position); _from.y += CHEST_Y;
  _chest.copy(bestPos); _chest.y += CHEST_Y;
  if (!buffLineClear(ctx.world, _from, _chest)) return null;
  _out.id = bestId; _out.name = bestName; _out.position = bestPos; _out.ally = bestAlly;
  return _out;
}

/** Reused result — `pickAllyTarget` runs every frame, so it never allocates one. Read it before the next call. */
const _out: AllyHealTarget = { id: '', name: '', position: _chest, ally: false };

/**
 * `heal:allyTargetChanged` — only on a real change (the aim runs every frame while an item is in hand).
 * `inHand` false is its own state, not 「no target」: the prompt disappears instead of going dim.
 */
export function emitAllyAim(sys: WeaponSystem, name: string | null, inHand: boolean, kind: AllyGift['kind'] | null): void {
  const key = inHand ? `${kind ?? ''}:${name ?? ''}` : null;
  if (sys.allyAimName === key) return;
  sys.allyAimName = key;
  sys.ctx.bus.emit('heal:allyTargetChanged', { name: inHand ? name : null, inHand, kind: inHand ? kind : null });
}

/** `heal:allyHoldChanged` at ≤ 30 Hz; `force` (start · finish · cancel) always lands. */
export function emitAllyHold(sys: WeaponSystem, t: number, dur: number, force: boolean): void {
  if (!force && sys.ctx.time - sys.allyHealEmitAt < 1 / EMIT_HZ) return;
  sys.allyHealEmitAt = sys.ctx.time;
  sys.ctx.bus.emit('heal:allyHoldChanged', {
    holding: sys.allyHealHeld, t, dur, name: sys.allyHealName || null, kind: sys.allyHealKind,
  });
}

/**
 * Right button pressed with a givable consumable in hand. Refused (deny sound, nothing consumed) when no squadmate
 * is aimed at inside `HEAL_ALLY_RANGE_START` — the chip already said so, this is only the backstop.
 */
export function beginAllyHeal(sys: WeaponSystem, host: Host, q: QuickHand): void {
  const gift = allyGiftOf(q.def);
  if (!gift) { sys.deny(); return; }
  const target = pickAllyTarget(sys, host, HEAL_ALLY_RANGE_START, gift);
  if (!target) { sys.deny(); return; }
  sys.allyHealHeld = true;
  sys.allyHealT = 0;
  sys.allyHealId = target.id;
  sys.allyHealName = target.name;
  sys.allyHealIsAndroid = target.ally;
  sys.allyHealKind = gift.kind;
  // No `setConsumableSlow` on purpose (user's decision): treating someone else carries no movement penalty.
  emitAllyHold(sys, 0, sys.holdTimeOf(q.def), true);
  sys.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.35 });
}

/**
 * Every frame while the right-button hold runs. It ends on: the button released, the target gone / dead / downed,
 * or the target further away than `HEAL_ALLY_RANGE_HOLD` — none of which consumes the item. The **cone is not
 * re-tested**: once the hold started it follows that one body, so looking away for a moment does not break it.
 */
export function updateAllyHeal(sys: WeaponSystem, dt: number, host: Host, q: QuickHand): void {
  if (!sys.ctx.input.isMouseDown(MouseButtons.AIM)) { cancelAllyHeal(sys); return; }
  const me = sys.ctx.player;
  const at = holdTargetPosition(sys);
  if (!me || !at || at.distanceTo(me.position) > HEAL_ALLY_RANGE_HOLD) { cancelAllyHeal(sys); return; }
  const dur = sys.holdTimeOf(q.def);
  sys.allyHealT += dt;
  if (sys.allyHealT >= dur) { finishAllyHeal(sys, host, q); return; }
  emitAllyHold(sys, Math.min(1, sys.allyHealT / Math.max(0.01, dur)), dur, false);
}

/** Where the body the hold follows stands right now, or null when it is no longer a valid target. */
function holdTargetPosition(sys: WeaponSystem): THREE.Vector3 | null {
  const id = sys.allyHealId;
  if (!id) return null;
  if (sys.allyHealIsAndroid) {
    const b: AllyBodyView | null = sys.ctx.allies?.getBody(id) ?? null;
    return b && !b.downed && !b.dead && !b.hidden && b.mode === 'raid' ? b.position : null;
  }
  const r = sys.ctx.net?.getRemotePlayer(id);
  return r && r.connected && !r.stale && !r.isDead && !r.isDowned ? r.position : null;
}

/**
 * The hold filled. An **android** is applied first and only then is the item taken (`AlliesRef.heal` /
 * `chargeShield` return false when there is nothing to do, and a refusal must leave the item in the bag); a
 * **person** is the other way round — the wire cannot answer, so the item is consumed and one `buff` goes out.
 */
export function finishAllyHeal(sys: WeaponSystem, host: Host, q: QuickHand): void {
  void host;
  const dur = sys.holdTimeOf(q.def);
  const gift = allyGiftOf(q.def);
  const id = sys.allyHealId;
  const name = sys.allyHealName;
  const android = sys.allyHealIsAndroid;
  if (!gift || !id) { cancelAllyHeal(sys); return; }

  if (android) {
    const allies = sys.ctx.allies;
    const ok = gift.kind === 'heal' ? allies?.heal(id, gift.amount) : allies?.chargeShield(id, gift.amount);
    if (!ok) { cancelAllyHeal(sys); sys.deny(); return; }
  }

  sys.allyHealHeld = false;
  sys.allyHealT = 0;
  const remaining = sys.consumeQuick(q);
  emitAllyHold(sys, remaining < 0 ? -1 : 1, dur, true);
  sys.allyHealId = null;
  sys.allyHealName = '';
  sys.allyHealIsAndroid = false;
  if (remaining < 0) { sys.deny(); return; }
  sys.quickCooldown = QUICK_USE_COOLDOWN / sys.useSpeedMul();
  sys.firingTimer = FIRING_POSE_HOLD * 0.5;
  const net = sys.ctx.net;
  if (!android && net) {
    const msg: BuffMessage = { t: 'buff', kind: gift.kind, amount: gift.amount, duration: 0, by: net.playerName ?? '' };
    net.send(msg, id as PeerId);
  }
  sys.ctx.bus.emit('audio:play', { id: 'stim', volume: 0.7 });
  sys.ctx.bus.emit('ui:notify', { text: gift.kind === 'shield' ? `${name} 실드 충전` : `${name} 회복`, kind: 'success', duration: 1.4 });
  sys.ctx.bus.emit('quick:used', { index: q.index, item: q.item, remaining });
  if (remaining <= 0) sys.returnToGun();
}

/** Button released, target lost, swap, death / downed, phase change, reset: nothing is consumed. */
export function cancelAllyHeal(sys: WeaponSystem): void {
  if (!sys.allyHealHeld) return;
  sys.allyHealHeld = false;
  sys.allyHealT = 0;
  sys.allyHealId = null;
  sys.allyHealName = '';
  sys.allyHealIsAndroid = false;
  emitAllyHold(sys, -1, 0, true);
}
