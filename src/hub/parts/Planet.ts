/**
 * src/hub/parts/Planet.ts — **목표 행성 선택과 워프 이동** (Phase 11).
 *
 * 임무는 여전히 무작위 시드로 생성되지만 **어느 행성인지**는 플레이어가 고른다. 로비에서는
 * **호스트만** 정하고 나머지는 `lobby:state` 로 같은 컷씬을 본다. 이동은 함선 내부를 재생성하지
 * 않는다 — 창밖만 바뀐다. 목표 행성이 없으면 발사 슬롯에 탑승할 수 없다.
 */
import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import { getPlanet, isPlanetId, planetLabel, HUB_TRAVEL_DURATION, PLANET_NONE_LABEL, PLANET_STORAGE_KEY } from '@/shared';
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
import { type DockTransition, LOCK_REQUEST_GRACE_MS, READY_ECHO_GRACE, UNBOARD_GRACE, _camLook, _camPos, _front } from '../model';
import type { HubSystem } from '../HubSystem';

/**
 * Pick the 목표 행성 and fly there. Refused (false) for a non-host in a lobby, for an unknown id, while a
 * cutscene / travel runs, while a launch countdown is ticking, outside the hub and when it is already the target.
 * On success: `hub:travel {stage:'start'}` → the docking cutscene reused as a warp → `hub:travel {stage:'end'}` +
 * `hub:planetChanged`. The ship interior is **not** rebuilt — only the view outside it changes.
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
 * Fly to `planet`. Everyone steps out of their pod, the terminal / workbench close and `DockingCutscene` runs in
 * `'travel'` mode (`HUB_TRAVEL_DURATION`). The interior is **kept** (no `disposeInterior`, no rebuild, the phase
 * stays `'hub'`) — a planet change is a change of scenery, not a new ship.
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
  sys.travelling = true;
  sys.cutscene?.dispose();
  ctx.bus.emit('hub:travel', { stage: 'start', planet });
  ctx.bus.emit('ui:notify', { text: `${def.name} 항로 진입`, kind: 'info' });
  ctx.bus.emit('audio:play', { id: 'hub_dock_thrusters', volume: 0.85 });
  sys.cutscene = new DockingCutscene(ctx, 'travel', HUB_TRAVEL_DURATION, () => sys.finishTravel(planet, by), {
    shared: sys.ship === 'shared', color: def.hologram, atmo: def.hologramAtmo,
  });
  }

export function finishTravel(sys: HubSystem, planet: PlanetId, by: 'local' | 'squad'): void {
  const ctx = sys.ctx;
  sys.cutscene?.dispose(); sys.cutscene = null;
  sys.travelling = false;
  const p = ctx.player;
  if (p) { p.setCameraOverride(null); p.setControlsEnabled(true); }
  sys.applyPlanetLook();
  sys.updateTerminalScreen();
  sys.syncPods();
  ctx.bus.emit('hub:travel', { stage: 'end', planet });
  ctx.bus.emit('hub:planetChanged', { planet, by });
  ctx.bus.emit('ui:notify', { text: `${planetLabel(planet)} 궤도 진입 — 발사 슬롯 개방`, kind: 'success' });
  ctx.bus.emit('audio:play', { id: 'hub_dock_clamp', volume: 0.8 });
  sys.relock();
  }

/** The decorative planet outside the viewports takes the 목표 행성's colours (nothing else is rebuilt). */
export function applyPlanetLook(sys: HubSystem): void {
  const def = getPlanet(sys.planet);
  if (!def) return;
  sys.interior?.setPlanetLook?.(def.hologram, def.hologramAtmo);
  }
