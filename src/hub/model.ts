/**
 * src/hub/model.ts — 함선 허브 폴더의 공용 어휘.
 *
 * `HubSystem` 에서 떼어낸 상수 · 타입(그리고 상태 없는 보조 클래스)만 있다. 클래스를 참조하지 않으므로
 * `parts/*` 모듈이 `HubSystem.ts` 를 되돌아 import 하지 않고 쓸 수 있다(순환 import 방지).
 * `HubSystem.ts` 가 `export *` 로 재수출하므로 기존 import 경로는 전부 유지된다.
 */
import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import { getPlanet, isPlanetId, planetLabel, HUB_TRAVEL_DURATION, PLANET_NONE_LABEL, PLANET_STORAGE_KEY } from '@/shared';
import type { CrewCardWire, GameContext, GameSystem, HubLaunchSlot, HubRef, HubShipKind, Interactable, InteriorCollider, LoadoutSlot, LobbyState, PeerId, RoomPurpose } from '@/shared';
import { CREW_CARD_MIN_INTERVAL_S, CREW_LOADOUT_COOLDOWN_S, HUB_DOCKING_DURATION, HUB_LAUNCH_COUNTDOWN, HUB_READY_BLOCKER, HUB_READY_CELLS, Keys, NET_SLOT_COLORS, ROOM_PURPOSE_LABEL_KO } from '@/shared';
import { PersonalShip } from './interiors/PersonalShip';
import { SharedShip } from './interiors/SharedShip';
import type { StationDef } from './interiors/stations';
import type { ShipInterior } from './interiors/types';
import { FurnitureLayer } from './interiors/Furniture';
import { roomAtWorld } from './interiors/RoomLayout';
import { HousingMode } from './HousingMode';
import { LaunchPod } from './LaunchPod';
import { Terminal } from './Terminal';
import { Computer } from './Computer';
import { DockingCutscene, type DockDirection } from './DockingCutscene';
import { HubMenu } from './ui/HubMenu';
import { HubStatus } from './ui/HubStatus';
import { ReadyPanel, type ReadyCellInfo } from './ui/ReadyPanel';
import { randomSeed } from './ui/dom';
import './hub.css';

/** A pointer-lock exit this soon after a lock request is a denied request, not the user pressing Esc. */
export const LOCK_REQUEST_GRACE_MS = 300;
/** Seconds after boarding before E can un-board (the boarding hold-release must not immediately leave). */
export const UNBOARD_GRACE = 0.6;
/** Seconds after `setReady(true)` before a server-side `ready=false` is treated as a lobby reset. */
export const READY_ECHO_GRACE = 1.5;
/**
 * Seconds after un-boarding before the same pod takes us again (2026-09-09).
 *
 * The E that un-boards is **not** consumed by `HubSystem` for `player/`'s sake — `Interactable.holdTime` reads
 * `isDown`, not `wasPressed`, so a press that is still held when the pod re-appears simply starts a fresh boarding
 * hold and puts the player straight back in. `consume()` cannot stop that (it only clears `pressed`), so the pod
 * itself stays closed for a moment, exactly mirroring `UNBOARD_GRACE` on the way in.
 */
export const REBOARD_GRACE = 0.5;
/**
 * The two cutscene directions that swap the ship interior. (Until 2026-09-09 this excluded a `'travel'` direction;
 * 행성 이동 is no longer a cutscene — see `WarpState` and `parts/Planet.ts`.)
 */
export type DockTransition = DockDirection;

/**
 * 창문 워프 (2026-09-09): one 행성 이동 in flight. Lives on `HubSystem.warp` for exactly the span of
 * `hub:travel {start}` → `{end}` and is ticked by `parts/Planet.tickTravel` every hub frame — no cutscene, no camera
 * override, no control lock. The interior is a spectator: it gets `setWarp(speed, dest)` each frame.
 */
export interface WarpState {
  planet: PlanetId;
  by: 'local' | 'squad';
  /** Seconds since `startTravel`. */
  elapsed: number;
  /** Seconds until the next `camera:shake` pulse (`HUB_WARP_SHAKE_INTERVAL_S`). */
  shakeIn: number;
  /** Colours the window planet takes on arrival (`PlanetDef.hologram` / `hologramAtmo`). */
  dest: { color: number; atmo: number };
}

/**
 * 분대 도킹 (2026-09-15, `parts/SquadDock`): a countdown (`HubSystem.squadDock`) or a fade-out (`HubSystem.dockFade`)
 * pending for the docked lobby `code`; `left` = seconds still to run on the hub's own dt.
 */
export interface SquadDockState {
  code: string;
  left: number;
}

/**
 * 레이드 진입 로딩 (2026-09-15, `parts/Pods.beginRaidLoad`): the launch countdown reached 0, every client faded to
 * black (`ui:screenFade {1, hold}` + `raid:loadBegin`) and the **authority** launches `RAID_LOAD_FADE_OUT_S` later.
 *
 * Once this exists the launch is **committed** — un-readying, E and the ready hold no longer cancel it (the squad is
 * already looking at a black screen). `authority` = solo or lobby host. A member whose host never launched by
 * `RAID_LOAD_FADE_OUT_S + RAID_LOAD_START_GRACE_S` fades back in and stays in the ship.
 *
 * ⚠ `dueMs` is **wall clock** (`performance.now()`), not the hub's dt: `game/parts/LoadGate` holds the engine from
 * `raid:loadBegin` onward and every system then gets dt 0, so a dt-driven countdown here would never reach the launch.
 */
export interface RaidLaunchState {
  /** `performance.now()` the next step is due at (end of the fade, then the grace). */
  dueMs: number;
  authority: boolean;
  /** true once the authority's `launch()` ran — from here on we only wait for `game:newMission`. */
  launched: boolean;
  /**
   * Wall-clock backup for the same step. The frame tick is the normal driver, but `LoadGate` may hold the engine from
   * `raid:loadBegin`, and a hold that also skips `update` would strand the launch — so the timer fires it regardless.
   * Idempotent with the frame tick (`dueMs` / `launched` decide, not who called).
   */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 안드로이드 슬롯 (2026-09-15, `parts/Androids`): a `lobby:android` request sent to the relay, waiting for the answer.
 * Cleared by the next `net:lobbyUpdated` / `net:androidReturned` / `net:error` / `net:lobbyLeft` / `net:statusChanged`
 * — the relay always answers with one of them, so no timer is needed (and no number in code).
 */
export interface AndroidPending {
  bay: number;
  recruit: boolean;
}

export const _camPos = new THREE.Vector3();
export const _camLook = new THREE.Vector3();
export const _front = new THREE.Vector3();

/**
 * Ship hub (Helldivers-style ship interior between missions). Publishes `ctx.hub`.
 *
 * Flow: `hub:enter {personal}` → walk the personal ship → terminal (menu: quick match / code / broadcast) →
 * lobby appears → `docking` cutscene → shared ship (up to 4) → each player boards their launch pod (`setReady`) →
 * every connected member ready → host runs `HUB_LAUNCH_COUNTDOWN` → `ctx.net.startGame(seed)` → `game:newMission`
 * tears the hub down (`hub:left`). Solo: the personal pod launches `game:newMission` directly after the countdown.
 * Phases owned here: 'hub' and 'docking'. Not a gameplay phase (no world, no enemies, no weapons).
 */

