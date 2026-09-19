/**
 * src/player/parts/Fall.ts — **fall damage**
 * (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」, user's decision).
 *
 * The question this file answers: *how much a landing hurts.*
 *
 * **Not tutorial-only, a game-wide feature.** The height is measured by `PlayerController` (`MoveResult.fallHeight` —
 * the difference between the height the fall started at and the landing height, 0 for an exempt fall); turning that
 * height into damage happens here and nowhere else.
 *
 *   damage = min(`FALL_DAMAGE_MAX`, (height − `FALL_DAMAGE_SAFE_M`) × `FALL_DAMAGE_PER_M`)
 *
 * Every number lives in `data/constants.csv`. The damage rides `applyDamage` as it is, **without a new path**, so the
 * hit feedback · `인내` (grit) · downed rules are not one character different from usual — except that **the shield is
 * skipped** (`onLanded` below, 2026-09-16 user's decision: every fall damage goes straight to hp).
 *
 * The only world whose rule differs per spot is the tutorial — `ctx.world.tutorial?.fallRule(landing spot)`:
 *   `kill`   instant death (cliff 1 — not clearing it returns to the checkpoint)
 *   `clamp`  the damage lands but hp never drops below 1 (cliff 2 — the landing is always survived)
 *   `normal` the formula above (the main game, where `ctx.world.tutorial` is null, is always this one)
 *
 * `player:fell {height, damage, rule}` fires only when damage actually landed (tutorial steps · HUD · audio read it).
 *
 * 2026-09-15 (TODO B-14, user's decision 「착지음 + 흔들림 + HUD 비네트 + 분대원도 듣는다」) — from the same place
 *   ① `camera:shake {min(FALL_SHAKE_MAX, damage × FALL_SHAKE_PER_DAMAGE), FALL_SHAKE_S}` (received by `rig.addShake`
 *      in `PlayerSystem.init` — the drone view and the rover orbit camera ignore it, as they always do),
 *   ② in multiplayer `fall {p: feet, d: damage}` goes to `others`. audio makes the landing sound and ui the
 *      vignette, both off `player:fell`.
 * The receiving side is `receiveRemoteFall` — only what passed all four (shape · sender · distance · rate) is
 * re-emitted as `player:remoteFell`.
 */
import * as THREE from 'three';
import {
  FALL_DAMAGE_MAX, FALL_DAMAGE_PER_M, FALL_DAMAGE_SAFE_M, FALL_REMOTE_SOUND_RANGE, FALL_SHAKE_MAX, FALL_SHAKE_PER_DAMAGE,
  FALL_SHAKE_S, GRAVITY, type FallMessage, type GameContext, type PeerId, type TutorialFallRule,
} from '@/shared';
import type { PlayerSystem } from '../PlayerSystem';
import type { PlayerDamageOptions, PlayerDamageSource } from '@/shared';

/** 2026-09-15 (the result screen rework): the source of fall damage — one object, reused. */
const FALL_DAMAGE_SOURCE: PlayerDamageSource = Object.freeze({ kind: 'fall' });
/** 2026-09-16 (user's decision): fall damage skips the shield — see `onLanded`. One object, reused. */
const FALL_DAMAGE_OPTS: PlayerDamageOptions = Object.freeze({ bypassShield: true });

/** Pure formula: base damage for a fall of `height` m (0 at or below the safe height). Smokes · console share it. */
export function fallDamageFor(height: number): number {
  if (!Number.isFinite(height) || height <= FALL_DAMAGE_SAFE_M) return 0;
  return Math.min(FALL_DAMAGE_MAX, (height - FALL_DAMAGE_SAFE_M) * FALL_DAMAGE_PER_M);
}

/**
 * Did the body **touch the ground in a state that can take damage.** The controller already reports `fallHeight` 0
 * for its own exemptions (grapple · hover · a vehicle deck · ladder · ship interior — `fallExempt`), and the ladder
 * and interior lines below **deliberately test them a second time**: the states here are read from `PlayerSystem`,
 * whose flags (`_interior` · `shipBounds` · `climbing`) can be set in the same frame the controller measured the
 * height, and a state 「that cannot fall」 must never leak through. The rest are states the controller knows nothing
 * about — the rover rider (no damage at all), drone control, pods, being carried, the intro wake, the ship phase.
 */
function canTakeFall(sys: PlayerSystem): boolean {
  if (!sys.spawned || sys.isDead || sys._downed) return false;
  if (sys._roverRide) return false;              // 2026-09-13: a rover rider takes no damage at all
  if (sys._droneControl) return false;           // 2026-09-11: the body is crouched — the drone is what fell
  if (sys._inPod || sys.isDropping) return false;// hellpod drop landing · launch pod
  if (sys.controller.climbing) return false;     // ladder
  if (sys._interior !== null || sys.shipBounds !== null) return false;   // ship interior · extraction ship hold
  if (sys.carriedSocket !== null || sys.attachedParent !== null) return false;
  if (sys.introWaking) return false;             // during the intro wake
  if (!sys.ctx.isGameplayPhase()) return false;  // on the ship (hub) and the result screen a fall does not hurt
  return true;
}

/**
 * Called by `PlayerSystem.update` on the frame `MoveResult.fallHeight > 0`. Applies the tutorial rule too and
 * reports what was actually taken off through `player:fell`.
 */
export function onLanded(sys: PlayerSystem, height: number): void {
  if (!(height > 0) || !canTakeFall(sys)) return;
  const ctx = sys.ctx;
  let rule: TutorialFallRule = 'normal';
  try { rule = ctx.world?.tutorial?.fallRule(sys.controller.position) ?? 'normal'; } catch { rule = 'normal'; }

  // 2026-09-16: a fall takes hp only, so 「how much it hurt」 counts hp only — so that the shield `die()` empties on
  //   a lethal fall (`clearShield`) does not mix into `player:fell.damage` · the `fall` wire
  const before = sys.hp;
  if (rule === 'kill') {
    // Cliff 1: instant death regardless of height — the corpse · checkpoint flow is game/'s, as usual
    if (before <= 0) return;
    sys.hp = 0;
    sys._deathSource = FALL_DAMAGE_SOURCE;   // 2026-09-15 (the result screen rework): cause of death = the fall
    sys.die();
    emitFell(sys, height, before, rule);
    return;
  }

  let damage = fallDamageFor(height);
  if (damage <= 0) return;
  if (rule === 'clamp') {
    // Cliff 2: 1 hp is left. Fall damage skips the shield (below), so 「hp − 1」 is the cap.
    damage = Math.min(damage, Math.max(0, sys.hp - 1));
    if (damage <= 0) return;
  }
  /*
   * 2026-09-16 (user's decision — 「모든 낙하 피해는 체력으로 곧장」): the armor shield **does not stop a fall**
   * (`bypassShield` — neither the shield nor the armor's durability moves). The reason: a chest-plate shield stopping
   * a leg broken by a fall makes no sense, and in the tutorial the fall right before the bandage step was eaten whole
   * by the shield, so the `heal` step passed silently with hp still full. The rule on this line is the same for the
   * main game and for the tutorial (`normal` · `clamp`). The source (`fall`) · grit · downed · death ·
   * `player:fell` · the shake · the wire are unchanged — what `emitFell` counts is the hp taken off.
   */
  // 2026-09-15: source `fall` (`player:damaged.source` · the cause of death)
  sys.applyDamage(damage, undefined, false, FALL_DAMAGE_SOURCE, FALL_DAMAGE_OPTS);
  emitFell(sys, height, before, rule);
}

/**
 * Counts the hp actually taken off and emits `player:fell` (`before` = the hp just before landing).
 * 0 emits nothing (the invulnerability window and so on).
 */
function emitFell(sys: PlayerSystem, height: number, before: number, rule: TutorialFallRule): void {
  const dealt = Math.max(0, before - sys.hp);
  if (dealt <= 0) return;
  const ctx = sys.ctx;
  ctx.bus.emit('player:fell', { height, damage: dealt, rule });
  // 2026-09-15 (B-14): shake — proportional to damage, capped at FALL_SHAKE_MAX (`PlayerSystem` gives it to the rig)
  ctx.bus.emit('camera:shake', { intensity: fallShakeFor(dealt), duration: FALL_SHAKE_S });
  // 2026-09-15 (B-14): squadmates hear the landing — sound only, hp · shield already ride the snapshot
  if (ctx.isMultiplayer && ctx.net) {
    const p = sys.controller.position;
    ctx.net.send({ t: 'fall', p: [p.x, p.y, p.z], d: dealt }, 'others');
  }
}

/** Pure formula: the `camera:shake` strength for the `damage` actually taken off (smokes share it). */
export function fallShakeFor(damage: number): number {
  if (!(damage > 0)) return 0;
  return Math.min(FALL_SHAKE_MAX, damage * FALL_SHAKE_PER_DAMAGE);
}

/**
 * Minimum interval (seconds) between two `fall` messages from the same squadmate — not a number written in code but
 * **derived from data**: a fall that deals damage has to free-fall at least `FALL_DAMAGE_SAFE_M`, so two landings can
 * never be closer together than the time it takes to fall that height from rest.
 */
export const REMOTE_FALL_MIN_INTERVAL_S = Math.sqrt((2 * Math.max(0, FALL_DAMAGE_SAFE_M)) / Math.max(1e-3, GRAVITY));

/** Why `receiveRemoteFall` refused (smokes · debug). `null` = accepted and `player:remoteFell` was emitted. */
export type RemoteFallReject = 'shape' | 'self' | 'member' | 'phase' | 'range' | 'damage' | 'rate';

/**
 * 2026-09-15 (B-14) — receiving a squadmate's `fall` (`RemotePlayerSystem` calls it from `net.onMessage('fall')`).
 * In exactly CLAUDE.md's order, "host-bound requests pass shape → sender → distance → rate":
 *   shape     `p` is three finite numbers and `d` a finite number → clamped to `[0, FALL_DAMAGE_MAX]`, and 0 is
 *             dropped (there is nothing to hear)
 *   sender    not myself, a current lobby member (`net.getLobbyPlayer`), and this client is in raid gameplay
 *   distance  within `FALL_REMOTE_SOUND_RANGE` of the local camera (= the audio listener)
 *   rate      at least `REMOTE_FALL_MIN_INTERVAL_S` since the last accepted one from the same person (`lastAt` is
 *             held by the caller, in real-time seconds)
 * Passing all four emits `player:remoteFell {peerId, position, damage}` — the position vector is made fresh per
 * message (the receiver may keep it).
 */
export function receiveRemoteFall(
  ctx: GameContext, msg: FallMessage, from: PeerId, lastAt: Map<PeerId, number>, nowS: number,
): RemoteFallReject | null {
  if (!msg || typeof msg !== 'object' || !Array.isArray(msg.p) || msg.p.length !== 3) return 'shape';
  const x = msg.p[0], y = msg.p[1], z = msg.p[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || typeof msg.d !== 'number' || !Number.isFinite(msg.d)) return 'shape';
  const net = ctx.net;
  if (!net || typeof from !== 'string' || !from) return 'member';
  if (from === net.localId) return 'self';
  if (!net.getLobbyPlayer(from)) return 'member';
  if (!ctx.isGameplayPhase()) return 'phase';
  const cam = ctx.camera.position;
  const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
  if (dx * dx + dy * dy + dz * dz > FALL_REMOTE_SOUND_RANGE * FALL_REMOTE_SOUND_RANGE) return 'range';
  const damage = Math.min(FALL_DAMAGE_MAX, Math.max(0, msg.d));
  if (!(damage > 0)) return 'damage';
  const prev = lastAt.get(from);
  if (prev !== undefined && nowS - prev < REMOTE_FALL_MIN_INTERVAL_S) return 'rate';
  lastAt.set(from, nowS);
  ctx.bus.emit('player:remoteFell', { peerId: from, position: new THREE.Vector3(x, y, z), damage });
  return null;
}
