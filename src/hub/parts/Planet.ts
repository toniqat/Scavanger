/**
 * src/hub/parts/Planet.ts — **목표 행성 선택과 워프 이동** (Phase 11 · 창문 워프 2026-09-09).
 *
 * 임무는 여전히 무작위 시드로 생성되지만 **어느 행성인지**는 플레이어가 고른다. 로비에서는
 * **호스트만** 정하고 나머지는 `lobby:state` 로 같은 워프를 본다. 이동은 함선 내부를 재생성하지
 * 않는다 — 창밖만 바뀐다. 목표 행성이 없으면 발사 슬롯에 탑승할 수 없다.
 *
 * **창문 워프 (2026-09-09)**: 행성 이동은 더 이상 컷씬이 아니다. 카메라도 조작도 그대로 — 플레이어는
 * 함선 안을 걸어 다니고, 창밖의 별이 줄기로 늘어나며(`ShipInterior.setWarp`) 선체가 흔들린다
 * (`camera:shake`). `HubSystem.warp`(`WarpState`)가 `HUB_TRAVEL_DURATION` 동안 살아 있고 `tickTravel`
 * 이 매 프레임 `hub:warpProgress {planet, t, speed}` 를 낸다. `speed` 는 처음 `HUB_WARP_RAMP_S` 동안
 * smoothstep 으로 0→1, 중간에 1, 마지막 `HUB_WARP_RAMP_S` 동안 1→0 — 흔들림도 소리도 이 값을 따른다.
 */
import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import {
  getPlanet, isPlanetId, planetLabel, HUB_TRAVEL_DURATION, HUB_WARP_RAMP_S, HUB_WARP_SHAKE_INTERVAL_S, HUB_WARP_SHAKE_PEAK,
  PLANET_NONE_LABEL, PLANET_STORAGE_KEY,
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
import { Workbench } from '../Workbench';
import { Computer } from '../Computer';
import { DockingCutscene, type DockDirection } from '../DockingCutscene';
import { HubMenu } from '../ui/HubMenu';
import { WorkbenchMenu } from '../ui/WorkbenchMenu';
import { HubStatus } from '../ui/HubStatus';
import { ReadyPanel, type ReadyCellInfo } from '../ui/ReadyPanel';
import { randomSeed } from '../ui/dom';
import { type DockTransition, type WarpState, LOCK_REQUEST_GRACE_MS, READY_ECHO_GRACE, UNBOARD_GRACE, _camLook, _camPos, _front } from '../model';
import type { HubSystem } from '../HubSystem';

/**
 * Pick the 목표 행성 and fly there. Refused (false) for a non-host in a lobby, for an unknown id, while a
 * cutscene / travel runs, while a launch countdown is ticking, outside the hub and when it is already the target.
 * On success: `hub:travel {stage:'start'}` → the 창문 워프 (`hub:warpProgress` every frame) → `hub:travel
 * {stage:'end'}` + `hub:planetChanged`. The ship interior is **not** rebuilt — only the view outside it changes.
 */
export function setPlanet(sys: HubSystem, planet: PlanetId): boolean {
  const ctx = sys.ctx;
  if (!isPlanetId(planet)) return false;
  if (sys.travelBlockReason(planet) !== null) return false;
  if (sys.planet === planet) return false;
  const net = ctx.net;
  if (net?.lobby) {
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

/** Korean reason 행성 이동 is refused right now, or null when it is allowed (the terminal renders it). */
export function travelBlockReason(sys: HubSystem, planet?: PlanetId): string | null {
  const ctx = sys.ctx;
  const net = ctx?.net;
  // 2026-09-08: 튜토리얼은 첫 번째 행성만 허용한다. `planet` 없이 부르면 "지금 행성을 정할 수 있나"만 묻는 것.
  const tut = ctx?.tutorial?.blockReason('planet', planet) ?? null;
  if (tut) return tut;
  if (net?.lobby && !net.isHost) return '호스트만 지정할 수 있습니다';
  if (sys.travelling || sys.cutscene) return '이동 중';
  if (sys.countdown >= 0) return '발사 카운트다운 중';
  if (ctx?.phase !== 'hub') return '함선에서만 지정할 수 있습니다';
  return null;
  }

/** Restore the solo pick (`PLANET_STORAGE_KEY`); an unknown / absent value stays null (목표 미지정). */
export function loadPlanet(sys: HubSystem): void {
  try {
    const raw = localStorage.getItem(PLANET_STORAGE_KEY);
    if (isPlanetId(raw)) sys.localPlanet = raw;
  } catch { /* private mode */ }
  }

export function savePlanet(sys: HubSystem): void {
  try {
    if (sys.localPlanet) localStorage.setItem(PLANET_STORAGE_KEY, sys.localPlanet);
    else localStorage.removeItem(PLANET_STORAGE_KEY);
  } catch { /* private mode */ }
  }

/**
 * Fly to `planet` — the **창문 워프** (2026-09-09). Everyone steps out of their pod, the terminal / workbench close,
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
  sys.wbMenu.close(false);
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
 * One frame of the 창문 워프 (called from `HubSystem.update` after the pod / status tick so its status line wins).
 * Drives the interior (`setWarp`), emits `hub:warpProgress`, pulses `camera:shake` every `HUB_WARP_SHAKE_INTERVAL_S`
 * at `HUB_WARP_SHAKE_PEAK × speed` (weak at first, strongest mid-trip, easing off toward arrival) and lands the ship
 * once `HUB_TRAVEL_DURATION` is up. The interior is optional: a rebuild mid-warp (격납고 in / out) simply picks the
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
 * `hub:enter`, `game:abort`, 타이틀로 …). Mirrors what disposing the old travel cutscene did: `travelling` off, no
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

/** The decorative planet outside the viewports takes the 목표 행성's colours (nothing else is rebuilt). */
export function applyPlanetLook(sys: HubSystem): void {
  const def = getPlanet(sys.planet);
  if (!def) return;
  sys.interior?.setPlanetLook?.(def.hologram, def.hologramAtmo);
  }
