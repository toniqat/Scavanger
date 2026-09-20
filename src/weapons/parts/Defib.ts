/**
 * src/weapons/parts/Defib.ts — **aimed use of the defibrillator** (2026-09-15, user's decision).
 *
 * It is the **opposite** of every other hold-to-use consumable: a heal · a shield charger · a gadget fires the
 * **moment the hold fills**, but the defibrillator keeps the left button **held** after it has filled and revives
 * only when it is **released** with a downed ally on the crosshair. Released with no target nothing fires and
 * **the item is not consumed**.
 *
 * This file does three things and no more — ① the charge timer (`DEFIB_USE_TIME_S`, or the item's own
 * `gadgetUseTime` when it has one), ② the aimed-target test (inside `GADGET_DEFIB_RANGE` · half-angle
 * `DEFIB_AIM_CONE_DEG`), ③ broadcasting the state as `gadget:defibAim`.
 * **`ui/hud/Reticle` is the only place that draws it** (a small white circle grows into a large translucent one,
 * orange while aimed).
 *
 * The revive itself is still `ctx.gadgets.use('defib')` — consuming the item, checking the range and sending
 * `buff revive` are all in there. The `target` here is **a crosshair display only**, and 「which ally」 is
 * decided by gadgets' `findDownedAlly`, which picks **the ally at the smallest angle off the same aim ray**, so
 * the two never disagree.
 */
import * as THREE from 'three';
import { DEFIB_AIM_CONE_DEG, GADGET_DEFIB_RANGE, MouseButtons, type GadgetId, type GameContext, type ItemDef, type PeerId } from '@/shared';
import type { Host, QuickHand } from '../model';
import type { WeaponSystem } from '../WeaponSystem';

/** The defibrillator's gadget id — the item def's `gadgetId`. */
const DEFIB: GadgetId = 'defib';

/**
 * `gadget:defibAim` send cap (30 Hz, the same as the heal hold gauge). Start · armed · a target change · the end
 * are sent regardless.
 */
const EMIT_HZ = 30;

const _o = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
/**
 * An ally's 「chest」 height — so it catches without aiming at their feet (the same value the heal spray and the
 * overcharge beam use).
 */
const CHEST_Y = 1.15;

/** Is the thing in hand a defibrillator (a one-line test, like the detonator hand · a drone controller). */
export function isDefibHand(sys: WeaponSystem, q: QuickHand): boolean {
  void sys;
  return !q.detonator && q.def.gadgetId === DEFIB;
}

/** Seconds the charge takes — the item's `gadgetUseTime` (else `DEFIB_USE_TIME_S`), with perk `quick_heal` on top. */
function chargeTime(sys: WeaponSystem, def: ItemDef): number {
  return Math.max(0.05, sys.holdTimeOf(def));
}

/**
 * Is an ally that releasing now would revive on the crosshair — true when at least one **downed** squadmate
 * inside `GADGET_DEFIB_RANGE` sits within `DEFIB_AIM_CONE_DEG` of the aim ray. It does not look behind walls
 * (the range is 5 m, so it would mean nothing, and gadgets' real revive test looks at the range alone — the two
 * tests must not disagree).
 */
function hasAimedAlly(sys: WeaponSystem, host: Host): boolean {
  const ctx = sys.ctx;
  const me = ctx.player;
  if (!me) return false;
  host.getAimRay(_o, _dir);
  _dir.normalize();
  const cos = Math.cos((DEFIB_AIM_CONE_DEG * Math.PI) / 180);
  const rangeSq = GADGET_DEFIB_RANGE * GADGET_DEFIB_RANGE;
  const aimed = (at: THREE.Vector3): boolean => {
    if (at.distanceToSquared(me.position) > rangeSq) return false;
    _to.copy(at); _to.y += CHEST_Y;
    _to.sub(_o);
    const len = _to.length();
    return len < 1e-3 || _to.dot(_dir) / len >= cos;
  };
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (!r.isDowned || r.stale) continue;
    /* 2026-09-21 (user's decision — the defibrillator works on a **shouldered** body). A carried body's own
     * `position` is a stale snapshot (`RemotePlayerRef.isCarried`), so the carrier's stands in for it; a body on
     * our **own** shoulder cannot be aimed at, so it counts as aimed outright. Must stay identical to gadgets'
     * `findDownedAlly.carrierPositionOf` — that one decides *which* body, this one only 「it fires on release」. */
    const carrier = carrierPositionOf(ctx, r.id);
    if (carrier?.mine) { if (me.position.distanceToSquared(carrier.position) <= rangeSq) return true; continue; }
    if (aimed(carrier ? carrier.position : r.position)) return true;
  }
  /* 2026-09-15 (android squadmates): a downed **android** is the same kind of target — this is the gate for
   * 「it fires on release」 (`releaseDefib`'s `fire = armed && target`), so it has to look at the **same range**
   * as gadgets' `findDownedAlly`. */
  for (const b of ctx.allies?.getBodies?.() ?? []) {
    if (!b.downed || b.dead || b.hidden || b.mode !== 'raid') continue;
    if (aimed(b.position)) return true;
  }
  return false;
}

/**
 * Who is carrying `id` and where they stand (2026-09-21), or null when nobody is. `mine` = **our** shoulder.
 * The twin of gadgets' `parts/Deploy.carrierPositionOf` — the two files already duplicate the chest height and the
 * cone test on purpose (the target and the 「fires on release」 gate must never disagree); change one, change both.
 */
function carrierPositionOf(ctx: GameContext, id: PeerId): Carrier | null {
  const me = ctx.player;
  if (me && (me.carrying ?? null) === id) return carrier(me.position, true);
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (r.id === id) { if (r.carriedBy) { const c = ctx.net?.getRemotePlayer(r.carriedBy); if (c) return carrier(c.position, false); } continue; }
    if (r.carrying === id) return carrier(r.position, false);
  }
  const android = ctx.allies?.carrierOf?.(id) ?? null;
  return android ? carrier(android.position, false) : null;
}

/** Reused result — `hasAimedAlly` runs every frame per downed peer, so the lookup allocates nothing. */
interface Carrier { position: THREE.Vector3; mine: boolean }
const _carrier: Carrier = { position: new THREE.Vector3(), mine: false };
function carrier(position: THREE.Vector3, mine: boolean): Carrier {
  _carrier.position = position; _carrier.mine = mine;
  return _carrier;
}

/** `gadget:defibAim` (throttled). `force` = start · armed · a target change · the end. */
function emit(sys: WeaponSystem, armed: boolean, charge: number, target: boolean, force: boolean): void {
  if (!force && sys.ctx.time - sys.defibEmitAt < 1 / EMIT_HZ) return;
  sys.defibEmitAt = sys.ctx.time;
  sys.ctx.bus.emit('gadget:defibAim', { armed, charge: THREE.MathUtils.clamp(charge, 0, 1), target });
}

/** Released, swapped weapon or died: the crosshair closes and the movement slow is released. Items are untouched. */
export function cancelDefib(sys: WeaponSystem, quiet = true): void {
  if (!sys.defibHeld && !sys.defibArmed) { if (!quiet) emit(sys, false, 0, false, true); return; }
  sys.defibHeld = false;
  sys.defibArmed = false;
  sys.defibT = 0;
  sys.defibTarget = false;
  sys.setConsumableSlow(false);
  emit(sys, false, 0, false, true);
}

/**
 * Every frame while the defibrillator is in hand. Press → charge → armed (the movement slow is released) → the
 * aimed marker → **release** fires it (`useGadget` only with a target; with none a deny sound and nothing used).
 */
export function updateDefibHand(sys: WeaponSystem, dt: number, host: Host, q: QuickHand, usable: boolean, inputFree: boolean): void {
  const input = sys.ctx.input;
  if (!usable) { cancelDefib(sys); return; }
  const down = input.isMouseDown(MouseButtons.FIRE);

  if (!sys.defibHeld) {
    // The crosshair takes the defibrillator shape the moment it is in hand (Reticle learns that from
    //   `quick:equipped`) — only the press is read here.
    if (!inputFree || sys.quickCooldown > 0 || sys.quickHolsterT > 0) return;
    if (!input.wasMousePressed(MouseButtons.FIRE)) return;
    sys.defibHeld = true;
    sys.defibArmed = false;
    sys.defibT = 0;
    sys.defibTarget = false;
    sys.setConsumableSlow(true);
    emit(sys, false, 0, false, true);
    return;
  }

  if (!down) { releaseDefib(sys, host, q); return; }

  const dur = chargeTime(sys, q.def);
  let force = false;
  if (!sys.defibArmed) {
    sys.defibT += dt;
    if (sys.defibT >= dur) {
      sys.defibArmed = true;
      sys.defibT = dur;
      force = true;
      // The slow is released once armed — one has to **walk** to the downed ally holding it ready (user's decision).
      sys.setConsumableSlow(false);
      sys.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.5 });
    }
  }
  const target = sys.defibArmed && hasAimedAlly(sys, host);
  if (target !== sys.defibTarget) { sys.defibTarget = target; force = true; }
  emit(sys, sys.defibArmed, sys.defibArmed ? 1 : sys.defibT / dur, target, force);
}

/** The left button was released. Armed + a target revives; otherwise nothing fires — **the item is not consumed**. */
function releaseDefib(sys: WeaponSystem, host: Host, q: QuickHand): void {
  const fire = sys.defibArmed && sys.defibTarget;
  sys.defibHeld = false;
  sys.defibArmed = false;
  sys.defibT = 0;
  sys.defibTarget = false;
  sys.setConsumableSlow(false);
  emit(sys, false, 0, false, true);
  if (!fire) { sys.deny(); return; }
  // Consuming · re-checking the range · `buff revive` are all inside gadgets (a refusal leaves the item alone too).
  sys.useGadget(host, q);
}
