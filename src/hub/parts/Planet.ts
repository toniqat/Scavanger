/**
 * src/hub/parts/Planet.ts — **picking the target planet and the warp trip** (Phase 11 · the window warp 2026-09-09).
 *
 * A mission is still generated from a random seed, but **which planet** it happens on is the player's pick. In a
 * lobby **only the host** decides and everyone else sees the same warp through `lobby:state`. The trip does not
 * rebuild the ship interior — only the view outside changes. With no target planet the launch slots refuse boarding.
 *
 * **The window warp (2026-09-09)**: planet travel is no longer a cutscene. Camera and controls stay as they are —
 * the player walks the ship while the stars outside stretch into streaks (`ShipInterior.setWarp`) and the hull
 * shakes (`camera:shake`). `HubSystem.warp` (`WarpState`) lives for `HUB_TRAVEL_DURATION` and `tickTravel` emits
 * `hub:warpProgress {planet, t, speed}` every frame. `speed` smoothsteps 0→1 over the first `HUB_WARP_RAMP_S`,
 * holds at 1, then 1→0 over the last `HUB_WARP_RAMP_S` — the shake and the sound both follow that value.
 */
import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import {
  getPlanet, isPlanetId, planetLabel, HUB_TRAVEL_DURATION, HUB_WARP_RAMP_S, HUB_WARP_SHAKE_INTERVAL_S, HUB_WARP_SHAKE_PEAK,
  PLANET_NONE_LABEL, PLANET_STORAGE_KEY, slotKey,
} from '@/shared';
import type { CrewCardWire, GameContext, GameSystem, HubLaunchSlot, HubRef, HubShipKind, Interactable, InteriorCollider, LoadoutSlot, LobbyState, PeerId, RoomPurpose } from '@/shared';
import { CREW_CARD_MIN_INTERVAL_S, CREW_LOADOUT_COOLDOWN_S, HUB_DOCKING_DURATION, HUB_LAUNCH_COUNTDOWN, HUB_READY_BLOCKER, HUB_READY_CELLS, Keys, NET_SLOT_COLORS, ROOM_PURPOSE_LABEL_KO } from '@/shared';
import { PersonalShip } from '../interiors/PersonalShip';
import { SharedShip } from '../interiors/SharedShip';
import type { StationDef } from '../interiors/stations';
import type { ShipInterior } from '../interiors/types';
import { FurnitureLayer } from '../interiors/Furniture';
import { roomAtWorld } from '../interiors/RoomLayout';
import { HousingMode } from '../HousingMode';
import { LaunchPod } from '../LaunchPod';
import { Terminal } from '../Terminal';
import { Computer } from '../Computer';
import { DockingCutscene, type DockDirection } from '../DockingCutscene';
import { HubMenu } from '../ui/HubMenu';
import { HubStatus } from '../ui/HubStatus';
import { ReadyPanel, type ReadyCellInfo } from '../ui/ReadyPanel';
import { randomSeed } from '../ui/dom';
import { type DockTransition, type WarpState, LOCK_REQUEST_GRACE_MS, READY_ECHO_GRACE, UNBOARD_GRACE, _camLook, _camPos, _front } from '../model';
import type { HubSystem } from '../HubSystem';

/**
 * Pick the target planet and fly there. Refused (false) for a non-host in a lobby, for an unknown id, while a
 * cutscene / travel runs, while a launch countdown is ticking, outside the hub and when it is already the target.
 * On success: `hub:travel {stage:'start'}` → the window warp (`hub:warpProgress` every frame) → `hub:travel
 * {stage:'end'}` + `hub:planetChanged`. The ship interior is **not** rebuilt — only the view outside it changes.
 */
export function setPlanet(sys: HubSystem, planet: PlanetId): boolean {
  const ctx = sys.ctx;
  if (!isPlanetId(planet)) return false;
  if (sys.travelBlockReason(planet) !== null) return false;
  if (sys.planet === planet) return false;
  const net = ctx.net;
  // 2026-09-15: only the docked squad's shared ship shares a planet — an undocked squad member flies their own ship
  if (net && sys.squadLobby()) {
    // the host owns `lobby.planet`; net mirrors it optimistically, so `sys.planet` is already the new value
    net.setLobbyPlanet(planet);
    sys.knownLobbyPlanet = planet;
  } else {
    sys.localPlanet = planet;
    sys.savePlanet();
  }
  sys.startTravel(planet, 'local');
  return true;
  }

/** Korean reason `행성 이동` is refused right now, or null when it is allowed (the terminal renders it). */
export function travelBlockReason(sys: HubSystem, planet?: PlanetId): string | null {
  const ctx = sys.ctx;
  const net = ctx?.net;
  // 2026-09-08: the tutorial allows the first planet only. Called without `planet` it only asks "can a planet be set at all".
  const tut = ctx?.tutorial?.blockReason('planet', planet) ?? null;
  if (tut) return tut;
  if (net && sys.squadLobby() && !net.isHost) return '호스트만 지정할 수 있습니다';
  if (sys.travelling || sys.cutscene) return '이동 중';
  if (sys.countdown >= 0) return '발사 카운트다운 중';
  if (ctx?.phase !== 'hub') return '함선에서만 지정할 수 있습니다';
  return null;
  }

/** Restore the solo pick (`PLANET_STORAGE_KEY`); an unknown / absent value stays null (no target). */
export function loadPlanet(sys: HubSystem): void {
  try {
    const raw = localStorage.getItem(slotKey(PLANET_STORAGE_KEY));
    if (isPlanetId(raw)) sys.localPlanet = raw;
  } catch { /* private mode */ }
  }

export function savePlanet(sys: HubSystem): void {
  try {
    if (sys.localPlanet) localStorage.setItem(slotKey(PLANET_STORAGE_KEY), sys.localPlanet);
    else localStorage.removeItem(slotKey(PLANET_STORAGE_KEY));
  } catch { /* private mode */ }
  }

/**
 * Fly to `planet` — the **window warp** (2026-09-09). Everyone steps out of their pod, the terminal / workbench close,
 * the READY panel hides and the countdown resets; then `HubSystem.warp` is armed and `tickTravel` carries the trip
 * for `HUB_TRAVEL_DURATION`. **No cutscene**: the camera is not overridden and the controls stay on — the player
 * watches the stars streak past the viewports while walking around. The interior is **kept** (no
 * `disposeInterior`, no rebuild, the phase stays `'hub'`) — a planet change is a change of scenery, not a new ship.
 * Pods / terminal / bays keep refusing through `travelling` for the whole trip.
 */
export function startTravel(sys: HubSystem, planet: PlanetId, by: 'local' | 'squad'): void {
  const ctx = sys.ctx;
  const def = getPlanet(planet);
  if (!def) return;
  if (sys.boardedSlot >= 0) sys.leavePod(true, true);
  sys.menu.close(false);
  sys.ready.hide();
  sys.countdown = -1; sys.lastCountdownSecond = -1; sys.launched = false;
  // a docking cutscene cannot be running here (`travelBlockReason` / `onLobbyUpdated` refuse), but never leave one behind
  if (sys.cutscene) { sys.cutscene.dispose(); sys.cutscene = null; }
  sys.travelling = true;
  sys.warp = { planet, by, elapsed: 0, shakeIn: HUB_WARP_SHAKE_INTERVAL_S, dest: { color: def.hologram, atmo: def.hologramAtmo } };
  ctx.bus.emit('hub:travel', { stage: 'start', planet });
  ctx.bus.emit('ui:notify', { text: `${def.name} 행성으로 이동합니다`, kind: 'info' });
  ctx.bus.emit('audio:play', { id: 'hub_dock_thrusters', volume: 0.85 });
  // the terminal closed with `relock = false` above; the player is about to walk the ship, so take the pointer back
  // now (guarded: never over an open UI / housing mode)
  sys.relock();
  sys.tickTravel(0);
  }

/** smoothstep on 0..1 (the warp's ramp shape). */
function smooth01(x: number): number {
  const k = THREE.MathUtils.clamp(x, 0, 1);
  return k * k * (3 - 2 * k);
  }

/** Warp intensity 0..1 at `elapsed` seconds: ramp up over `HUB_WARP_RAMP_S`, cruise, ramp down over the last `HUB_WARP_RAMP_S`. */
export function warpSpeedAt(elapsed: number): number {
  const D = HUB_TRAVEL_DURATION;
  const R = Math.max(1e-3, Math.min(HUB_WARP_RAMP_S, D / 2));
  const e = THREE.MathUtils.clamp(elapsed, 0, D);
  return smooth01(Math.min(e / R, (D - e) / R));
  }

/**
 * One frame of the window warp (called from `HubSystem.update` after the pod / status tick so its status line wins).
 * Drives the interior (`setWarp`), emits `hub:warpProgress`, pulses `camera:shake` every `HUB_WARP_SHAKE_INTERVAL_S`
 * at `HUB_WARP_SHAKE_PEAK × speed` (weak at first, strongest mid-trip, easing off toward arrival) and lands the ship
 * once `HUB_TRAVEL_DURATION` is up. The interior is optional: a rebuild mid-warp (hangar in / out) simply picks the
 * effect up again on its next frame.
 */
export function tickTravel(sys: HubSystem, dt: number): void {
  const w = sys.warp;
  if (!w) return;
  const ctx = sys.ctx;
  w.elapsed += dt;
  const D = HUB_TRAVEL_DURATION;
  const speed = warpSpeedAt(w.elapsed);
  sys.interior?.setWarp?.(speed, w.dest);
  ctx.bus.emit('hub:warpProgress', { planet: w.planet, t: THREE.MathUtils.clamp(w.elapsed / D, 0, 1), speed });
  w.shakeIn -= dt;
  if (w.shakeIn <= 0) {
    w.shakeIn += HUB_WARP_SHAKE_INTERVAL_S;
    if (w.shakeIn < 0) w.shakeIn = HUB_WARP_SHAKE_INTERVAL_S;          // a long frame never queues a burst
    if (speed > 0) ctx.bus.emit('camera:shake', { intensity: HUB_WARP_SHAKE_PEAK * speed, duration: HUB_WARP_SHAKE_INTERVAL_S * 1.5 });
  }
  sys.status.set(`${planetLabel(w.planet)} 항로 이동 중`, null);
  if (w.elapsed >= D) sys.finishTravel(w.planet, w.by);
  }

/**
 * Arrival. The warp state is cleared, the interior is told `speed = 0` one last time (stars back, streaks gone,
 * planet fully in — `setWarp` already re-tinted it, `applyPlanetLook` makes sure of it), then the same tail as
 * before: terminal screen + pods re-synced, `hub:travel {end}` + `hub:planetChanged` + the arrival toast + clamp.
 * No `relock`: the pointer was never released by the warp, and re-requesting it here could only fight a UI the
 * player opened during the trip.
 */
export function finishTravel(sys: HubSystem, planet: PlanetId, by: 'local' | 'squad'): void {
  const ctx = sys.ctx;
  sys.warp = null;
  sys.travelling = false;
  sys.applyPlanetLook();
  sys.interior?.setWarp?.(0);
  sys.updateTerminalScreen();
  sys.syncPods();
  ctx.bus.emit('hub:travel', { stage: 'end', planet });
  ctx.bus.emit('hub:planetChanged', { planet, by });
  ctx.bus.emit('ui:notify', { text: `${planetLabel(planet)} 궤도 진입 — 발사 슬롯 개방`, kind: 'success' });
  ctx.bus.emit('audio:play', { id: 'hub_dock_clamp', volume: 0.8 });
  }

/**
 * Drop a warp in flight **without** landing it (the interior is being torn down or swapped by a docking cutscene,
 * `hub:enter`, `game:abort`, `타이틀로` …). Mirrors what disposing the old travel cutscene did: `travelling` off, no
 * `hub:travel {end}` — the path that called us emits its own `hub:docking` / `hub:entered` / `hub:left`, which is what
 * the listeners reset on. The interior (if it survives) is put back to rest.
 */
export function cancelTravel(sys: HubSystem): void {
  if (!sys.warp && !sys.travelling) return;
  sys.warp = null;
  sys.travelling = false;
  sys.interior?.setWarp?.(0);
  // the target itself already moved (`setPlanet` / `lobby:state` did that before the trip): an interior that survives
  // the cancel (idempotent `hub:enter`) shows it at once instead of the colours it was leaving behind
  sys.applyPlanetLook();
  }

/**
 * The decorative planet outside the viewports takes the target planet's colours (nothing else is rebuilt).
 *
 * **2026-09-09:** no destination → no planet. `HubRef.planet` (the lobby's pick, else the slot's saved solo pick) is
 * the single source of truth; when it is null — a fresh character, a lobby whose host has not chosen, a cleared
 * pick — the window shows stars only (`ShipInterior.setPlanetVisible(false)`). Every caller that already re-tinted
 * here (interior build, `lobby:state` planet change, warp arrival / cancel) gets the gate for free, and the warp's
 * own re-tint moment (`interiors/WarpStreaks.ViewportWarp`) opens it before the fade-in so a first pick appears.
 */
export function applyPlanetLook(sys: HubSystem): void {
  const def = getPlanet(sys.planet);
  sys.interior?.setPlanetVisible?.(!!def);
  if (!def) return;
  sys.interior?.setPlanetLook?.(def.hologram, def.hologramAtmo);
  }
