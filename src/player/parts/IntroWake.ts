/**
 * src/player/parts/IntroWake.ts — **the intro wake** (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」).
 *
 * The question this file answers: *what the body and the camera do while waking up.*
 *
 * The implementation of `PlayerRef.playIntroWake(durationS)`. The tutorial calls it once as it starts (the number is
 * `TUTORIAL_INTRO_WAKE_S`), and for that long:
 *   - the body starts in the **downed pose** and rises slowly. No new pose is built: the progress of the downed pose
 *     (`SoldierPose.downed` → `SoldierModel.poseDowned`) is rewound 1 → 0 — that pose already is
 *     「a living person fallen on their back」, and 0 crosses smoothly into the normal pose.
 *   - movement · stance · jump · roll · aim · weapons · interaction · mouse look are locked (the same trick as the
 *     places that read the drone-control gate — `moveFrozen` · `canUseWeapons` in `PlayerSystem.update`).
 *   - the camera looks at the downed body from low at its side, then **slides to the normal third-person back-view
 *     spot while the body rises** (2026-09-14 user's decision — `updateIntroCamera` below). On the last frame it is
 *     already at that spot, so releasing the override (`setCameraOverride(null, undefined, true)`) does not jump.
 *   - **the screen starts black and brightens** (2026-09-14 2nd pass, user's decision — *the opening fade* below).
 * It emits `player:introWakeDone` when it ends. `PlayerRef.introWaking` is true until that frame, and the compass and
 * the Tab bag read it — they do not appear before the camera is fully back (user's decision).
 *
 * It releases itself on: `game:abort` · `game:newMission` · death · the reset paths (`resetAll` · `respawnAt` ·
 * `spawnStanding` · `restoreState`). Those do not emit `player:introWakeDone` (the cutscene did not finish).
 *
 * ## 2026-09-14 — the cutscene that never ended
 *
 * The timer was decremented with `introWakeT -= dt` and `endIntroWake` was called on the frame it went **past 0 into
 * the negative**, where that function's first line turned back on `introWakeT < 0` — the 「not playing」 marker. The
 * override was never released, so **the camera stayed beside the body forever**, and with no `player:introWakeDone`
 * the tutorial was stuck on the `wake` step (no guidance, until the `cliff` checkpoint folded it away). From the next
 * frame `updateIntroWake` turned back on the same marker too. The timer now **stops at 0** (`Math.max(0, …)`) and
 * never mixes with the negative marker. Regression: `scripts/smoke-intro-wake.mjs`.
 *
 * ## The opening fade (2026-09-14 2nd pass)
 *
 * `ui/` draws it — this file only says **when · for how long**, through `ui:screenFade {opacity, durationS}`
 * (opacity 1 = fully black, 0 = transparent). There is one rule: **never get stuck on a black screen.**
 * The start (`playIntroWake`) lays black down at once, and **every path** that ends (`endIntroWake`) or cancels
 * (`cancelIntroWake`) the cutscene restores the screen with `{opacity: 0, durationS: 0}` — death · downed ·
 * `game:abort` · `game:newMission` · a reset all pass through one of those two.
 * (2026-09-14: `ui/HudSystem` runs the brightening transition **in code** — when the OS turns animation effects off a
 *  CSS transition is clipped to 0.01 ms and the fade ended in one frame. The way this file speaks is unchanged.)
 */
import * as THREE from 'three';
import { TUTORIAL_INTRO_WAKE_S } from '@/shared';
/* appended (2026-09-15): the tutorial respawn wake — `playIntroWake(d, {respawn:true})` */
import { TUTORIAL_RESPAWN_WAKE_S } from '@/shared';
import { smoothstep } from '@/core/util/MathUtil';
import type { PlayerSystem } from '../PlayerSystem';

/* Cutscene geometry — camera · pose framing, not balance numbers, so it sits with `model.ts`'s `EYE_*` · `FADE_*`. */
/**
 * Stays down until this progress and rises after it (0..1).
 * 2026-09-14 3rd pass: **the value is unchanged** — what halved the rise speed is `TUTORIAL_INTRO_WAKE_S` (4.5 → 9),
 * and this is a spot on the progress, so it stretches twice as long by itself (3.15 → 6.3 s).
 */
const WAKE_RISE_START = 0.3;
/**
 * 2026-09-15 — the same spot for the **respawn wake** (`respawn`). In the 2 s cutscene (`TUTORIAL_RESPAWN_WAKE_S`)
 * the body lies for 0.4 s and rises over 1.6 s — lying 30 % of it as the opening does reads as 「a frozen screen」
 * in a cutscene this short.
 */
const RESPAWN_RISE_START = 0.2;
/** The angle the camera stands at — this much turned from where the body faces (`bodyYaw`), to its front side. */
const CAM_YAW_OFFSET = 2.1;
/** Camera distance (start → end, m) · height (from the feet, m) · the height it looks at (from the feet, m). */
const CAM_DIST = [3.6, 2.7] as const;
const CAM_HEIGHT = [0.75, 1.45] as const;
const CAM_LOOK_Y = [0.35, 1.05] as const;
/**
 * The camera's return (2026-09-14, user's decision — 「the view comes back to normal while rising」). From this
 * progress to the end (1) the side camera moves by smoothstep to the rig's back-view spot — about the rear half of
 * the rise (`WAKE_RISE_START` 0.3 → 1); in a 9 s cutscene that is 4.05 s starting at 4.95 s.
 */
const CAM_RETURN_START = 0.55;
/**
 * A point on the back-view sight line — this far ahead of the rig spot along its look direction (m).
 * Only `lookAt` uses it, so the distance itself does not change the rotation.
 */
const CAM_RETURN_LOOK_DIST = 10;

/* The fade sits here too — **not a balance number but a spot on the cutscene progress (0..1)**, so it belongs with
 * `WAKE_RISE_START` right above, and its length grows and shrinks with the csv's `TUTORIAL_INTRO_WAKE_S`.
 * (Moving it to a csv row would need one `K.num` line in `shared/constants.ts` — that file is not owned by this
 *  change, so it stays here for now.) */
/** Fully black until this progress — a very short hold (0.36 s in a 9 s cutscene = the old 4.5 s × 0.08). */
const FADE_HOLD = 0.04;
/**
 * Fully bright at this progress. **Just before** `WAKE_RISE_START` (where the rise begins), so the body is already
 * fully visible as it stands up.
 *
 * 2026-09-14 3rd pass (user's decision — 「brightens gradually over about 2 seconds」): the **real time** the
 * brightening takes is `(FADE_DONE − FADE_HOLD) × TUTORIAL_INTRO_WAKE_S` (`updateIntroWake` hands that value to
 * `ui:screenFade.durationS`). The length became 4.5 → 9 s, so `0.26 − 0.04 = 0.22`, `0.22 × 9 = 1.98 s` ≈ 2 s.
 * In clock terms: black until 0.36 s → fully bright at 2.34 s → the rise starts at 2.7 s (`WAKE_RISE_START` × 9).
 * `WAKE_RISE_START` **stays 0.3**, so the rise stretches 3.15 → 6.3 s — exactly half speed.
 */
const FADE_DONE = 0.26;

const _camPos = new THREE.Vector3();
const _camLook = new THREE.Vector3();
const _rigLook = new THREE.Vector3();

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** 0 (start) … 1 (end). 1 when no cutscene is playing. */
function progress(sys: PlayerSystem): number {
  if (sys.introWakeT < 0 || sys.introWakeDur <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - sys.introWakeT / sys.introWakeDur));
}

/**
 * `PlayerRef.playIntroWake`. Taken only while the body stands in the world (ignored when dead or before the spawn).
 * One already running only gets a new length.
 *
 * ## 2026-09-15 — the respawn wake (`opts.respawn`, user's decision 「a tutorial respawn also rises from the ground」)
 *
 * It uses only the same downed pose → rise and the input lock. **Everything the opening alone has is dropped**: the
 * black fade (`ui:screenFade`) · the dedicated camera on the body (the normal third-person camera instead) ·
 * `PlayerRef.introWaking` (read by the compass fade · the Tab lock — it stays false) · `player:introWakeDone` (the
 * signal the tutorial's `wake` step waits for). The marker is `PlayerSystem.introWakeRespawn`. It never overwrites
 * a body playing the opening (insurance never actually reached — the respawn path `respawnAt` cancels it first).
 */
export function playIntroWake(sys: PlayerSystem, durationS: number, opts?: { respawn?: boolean }): void {
  if (!sys.spawned || sys.isDead || sys._downed) return;
  const respawn = opts?.respawn === true;
  if (respawn && sys.introWakeT >= 0 && !sys.introWakeRespawn) return;
  const fallback = respawn ? TUTORIAL_RESPAWN_WAKE_S : TUTORIAL_INTRO_WAKE_S;
  const dur = Number.isFinite(durationS) && durationS > 0 ? durationS : fallback;
  // Puts down everything the body was doing (the rover · drone · furniture · ladder each have their own release)
  sys.releaseRoverRide();
  sys.releaseDroneControl();
  sys.releaseFurniturePose('reset');
  sys.clearClimbState();
  sys.setAiming(false);
  sys.setHovering(false);
  sys.controller.cancelRoll();
  sys.controller.velocity.set(0, 0, 0);
  sys.controller.sprinting = false;
  sys.setStance('stand'); sys.standUpTimer = 0;
  sys.cancelHold(); sys.interactTarget = null;
  sys.introWakeDur = Math.max(0.1, dur);
  sys.introWakeT = sys.introWakeDur;
  sys.introWakeRespawn = respawn;
  // The respawn wake: the camera stays the normal rig · nothing covers the screen
  // 2026-09-16 (user's decision — the tutorial respawn only): **it lies down from the first frame.** With the joint
  // blend pulling the body `respawnAt` had stood up with `resetPose` back down, it read as 「appears standing → drops
  // in a heap → rises slowly」 — the pose is moved straight to the downed spot so only the rise is left.
  if (respawn) { sys.model.snapDowned(sys.ctx?.time ?? 0); return; }
  // Starts at that spot from the first frame (blending in would sweep the camera from the back view onto the body)
  updateIntroCamera(sys, true);
  // And that first frame shows **nothing at all** — `updateIntroWake` is what starts the brightening
  fade(sys, 1, 0);
}

/** One `ui:screenFade` line (`ui/` draws it). */
function fade(sys: PlayerSystem, opacity: number, durationS: number): void {
  sys.ctx?.bus.emit('ui:screenFade', { opacity, durationS });
}

/** Called every frame by `PlayerSystem.update`. On the last frame: release the override + `player:introWakeDone`. */
export function updateIntroWake(sys: PlayerSystem, dt: number): void {
  if (sys.introWakeT < 0) return;
  // The body can no longer hold the cutscene (death · downed · the ship) — end it silently
  if (!sys.spawned || sys.isDead || sys._downed) { cancelIntroWake(sys); return; }
  /*
   * Raises the fade **without state**: when this frame's progress crosses `FADE_HOLD`, the brightening
   * starts exactly once right there (only one frame crosses the boundary, so no new flag is needed).
   */
  const before = progress(sys);
  // ⚠ Stops at 0 — a negative value is the 「not playing」 marker (header comment, *the cutscene that never ended*)
  sys.introWakeT = Math.max(0, sys.introWakeT - Math.max(0, dt));
  // 2026-09-15 the respawn wake: no fade · no camera — only the clock runs
  if (sys.introWakeRespawn) { if (sys.introWakeT <= 0) endIntroWake(sys); return; }
  const after = progress(sys);
  if (before < FADE_HOLD && after >= FADE_HOLD) {
    fade(sys, 0, Math.max(0, (FADE_DONE - FADE_HOLD) * sys.introWakeDur));
  }
  if (sys.introWakeT > 0) { updateIntroCamera(sys, false); return; }
  endIntroWake(sys);
}

/** Ends the cutscene normally — releases the override (already at the back-view spot) + `player:introWakeDone`. */
export function endIntroWake(sys: PlayerSystem): void {
  if (sys.introWakeT < 0) return;
  const respawn = sys.introWakeRespawn;
  sys.introWakeT = -1; sys.introWakeDur = 0; sys.introWakeRespawn = false;
  // The respawn wake never took the camera or covered the screen, and `player:introWakeDone` is the opening's signal
  if (respawn) return;
  sys.setCameraOverride(null, undefined, true);
  // Normally it is bright already (the fade ends at `FADE_DONE`), but a short cutscene takes it down for certain too
  fade(sys, 0, 0);
  sys.ctx.bus.emit('player:introWakeDone', {});
}

/** Reset · death · new mission: ends without announcing. **The screen is always restored** (never stuck on black). */
export function cancelIntroWake(sys: PlayerSystem): void {
  if (sys.introWakeT < 0) return;
  const respawn = sys.introWakeRespawn;
  sys.introWakeT = -1; sys.introWakeDur = 0; sys.introWakeRespawn = false;
  // The respawn wake has no camera · screen to restore (so it never wrongly releases another override, e.g. liftoff)
  if (respawn) return;
  sys.setCameraOverride(null, undefined, true);
  fade(sys, 0, 0);
}

/**
 * How far down the body is, 0..1 — carried on `SoldierPose.downed` (`PlayerSystem` takes the larger of it and the
 * downed blend). It lies at 1 for the first `WAKE_RISE_START` of the progress, then eases smoothly to 0.
 */
export function wakeBlend(sys: PlayerSystem): number {
  if (sys.introWakeT < 0) return 0;
  return 1 - smoothstep(sys.introWakeRespawn ? RESPAWN_RISE_START : WAKE_RISE_START, 1, progress(sys));
}

/**
 * The camera on the downed body (rising to eye height as the body does) — over the last part of the progress it
 * moves to the rig's back-view spot.
 *
 * That spot is **the rig's own position, which it keeps computing every frame even under an override**
 * (`CameraRig.position` — `finishFrame` only blends the override on top of it). Its look direction is `getLookDir`
 * and there is no roll, so `lookAt(spot + direction)` equals the rig's rotation — at progress 1 the override is the
 * rig, so the release is invisible. The values read are the previous `lateUpdate`'s, but the body is frozen
 * (`scripted`) and does not move between frames.
 */
function updateIntroCamera(sys: PlayerSystem, snap: boolean): void {
  const t = progress(sys);
  const feet = sys.controller.position;
  const a = sys.bodyYaw + CAM_YAW_OFFSET;
  const dist = lerp(CAM_DIST[0], CAM_DIST[1], t);
  _camPos.set(feet.x + Math.sin(a) * dist, feet.y + lerp(CAM_HEIGHT[0], CAM_HEIGHT[1], t), feet.z + Math.cos(a) * dist);
  _camLook.set(feet.x, feet.y + lerp(CAM_LOOK_Y[0], CAM_LOOK_Y[1], t), feet.z);
  const back = smoothstep(CAM_RETURN_START, 1, t);
  const rig = sys.rig;
  if (back > 0 && rig) {
    rig.getLookDir(_rigLook).multiplyScalar(CAM_RETURN_LOOK_DIST).add(rig.position);
    _camPos.lerp(rig.position, back);
    _camLook.lerp(_rigLook, back);
  }
  sys.setCameraOverride(_camPos, _camLook, snap);
}
