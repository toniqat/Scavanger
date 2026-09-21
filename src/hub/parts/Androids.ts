/**
 * src/hub/parts/Androids.ts — **the cockpit android bays** (2026-09-15, `src/allies/README.md` Decisions).
 *
 * The three capsules along one side of the shared ship's cockpit (`interiors/AndroidBays.ts`): **the squad leader
 * holding one for `ALLY_BAY_HOLD_S`** makes that bay's android a squadmate (`lobby:android {recruit:true}`), and
 * holding the same bay again sends it back. Every judgement is the relay's — here the request goes out and the lobby
 * state (`androidOnBay`) is drawn as it stands.
 *
 * **A refusal is shown as the prompt** (the launch-pod rule): `ctx.interactables.findBest` skips anything answering
 * `canInteract:false`, so refusing there would leave the player without a prompt and without a reason.
 *
 * This folder never builds an android's **body**. It publishes `HubRef.getAndroidBays()` (where a capsule's feet are)
 * and `HubRef.getPodStandPose(slot)` (where a recruited android stands ready in front of its launch pod); what is
 * drawn in those places is allies/ and player/'s to decide.
 */
import * as THREE from 'three';
import type { HubAndroidBay, Interactable, LobbyState } from '@/shared';
import { ALLY_BAY_HOLD_S, androidNameOf, androidOnBay, isDockedLobby } from '@/shared';
import type { HubSystem } from '../HubSystem';

/** Prefix of the bay interactable ids (`hub_android_<bay>`). */
export const ANDROID_BAY_ID = 'hub_android_';
/** Interaction radius (m) — wide enough to catch someone standing in front of the capsule. The launch pod's 2.2 feel. */
const BAY_RADIUS = 2.2;
/** Distance of the standing spot in front of a launch pod (m), along the pod door (`PodSlotDef.door`) — outside its door blocker. */
const POD_STAND_M = 1.6;

const NO_BAYS: readonly HubAndroidBay[] = [];

/** The squad of the shared ship we stand in (null in an undocked squad · a personal ship). A lobby is always read through `squadLobby()`. */
function lobbyOf(sys: HubSystem): LobbyState | null {
  const lobby = sys.squadLobby();
  return lobby && isDockedLobby(lobby) ? lobby : null;
}

/** Am I this squad's leader (`lobby.hostId`)? It reads the lobby, not `NetRef.isHost` — the ship we stand in decides which lobby counts. */
function iAmLeader(sys: HubSystem, lobby: LobbyState): boolean {
  const me = sys.ctx.net?.localId ?? null;
  return !!me && lobby.hostId === me;
}

/* ── HubRef ────────────────────────────────────────────────────────────── */

/** The android bays in the shared ship's cockpit (by bay), empty elsewhere. A reused array — read it and use it at once. */
export function getAndroidBays(sys: HubSystem): readonly HubAndroidBay[] {
  if (sys.ship !== 'shared' || sys.visit) return NO_BAYS;
  return sys.interior?.androidBays ?? NO_BAYS;
}

/**
 * The standing spot **in front of** lobby slot `slot`'s launch pod — where a recruited android stands ready. Null
 * outside the shared ship and with no such pod. The spots are computed once per ship build (this is read every frame,
 * so it allocates nothing).
 */
export function getPodStandPose(sys: HubSystem, slot: number): { position: THREE.Vector3; yaw: number } | null {
  if (sys.ship !== 'shared' || sys.visit) return null;
  return sys.podStands[slot] ?? null;
}

/** Once per ship build: the standing spot in front of every pod (`getPodStandPose`'s source). */
export function buildPodStands(sys: HubSystem): void {
  sys.podStands = [];
  if (sys.ship !== 'shared') return;
  for (const pod of sys.pods) {
    const def = pod.def;
    sys.podStands[def.slot] = {
      position: def.position.clone().addScaledVector(def.door, POD_STAND_M),
      // A pod's yaw already looks at the deck (the door side) — the waiting pose faces the same way
      yaw: def.yaw,
    };
  }
}

/* ── interaction ──────────────────────────────────────────────────────── */

/**
 * Why this bay cannot be touched right now (it goes straight into the prompt), or null when it can.
 * In order: a request is pending → no connection → not the leader → a mission is running.
 */
export function androidBlockReason(sys: HubSystem, bay: number): string | null {
  if (sys.androidPending) return sys.androidPending.bay === bay ? '요청 처리 중…' : '다른 슬롯 요청 처리 중…';
  const net = sys.ctx.net;
  if (!net || !net.connected) return '서버에 연결되어 있지 않습니다';
  const lobby = lobbyOf(sys);
  if (!lobby) return '서버에 연결되어 있지 않습니다';
  if (!iAmLeader(sys, lobby)) return '분대장만 안드로이드를 들일 수 있습니다';
  if (lobby.started || net.missionInProgress) return '임무 진행 중';
  return null;
}

/** The bay prompt: the refusal reason when there is one, else `<name> — 분대원으로 들이기` / `— 슬롯으로 돌려보내기`. */
export function androidPrompt(sys: HubSystem, bay: number): string | null {
  if (!androidCanInteract(sys, bay)) return null;
  const blocked = androidBlockReason(sys, bay);
  if (blocked) return blocked;
  const name = androidNameOf(bay);
  return recruited(sys, bay) ? `${name} — 슬롯으로 돌려보내기` : `${name} — 분대원으로 들이기`;
}

/** Is this bay's android already a squadmate (a bot member of the relay lobby)? */
export function recruited(sys: HubSystem, bay: number): boolean {
  return androidOnBay(lobbyOf(sys), bay) !== null;
}

/**
 * Can the bay be reached at all (**a refusal is not judged here** — it goes into the prompt)? The launch pod's
 * conditions: walking the ship, no screen up, not seated in a pod, no cutscene · warp · ship management running.
 */
export function androidCanInteract(sys: HubSystem, bay: number): boolean {
  const ctx = sys.ctx;
  if (bay < 0 || getAndroidBays(sys).length <= bay) return false;
  if (ctx.phase !== 'hub' || sys.cutscene || sys.travelling || sys.boardedSlot >= 0) return false;
  if (sys.menu.isOpen || sys.launchWarn.isOpen || sys.housingMode.active || sys.corpMenuOpen()) return false;
  if (sys.raidLaunch) return false;   // once the launch is committed (during the fade) nothing changes any more
  return true;
}

/** The hold finished → `lobby:android`. The answer (`lobby:state` · `lobby:androidReturned` · `lobby:error`) releases the wait. */
export function androidInteract(sys: HubSystem, bay: number): void {
  const ctx = sys.ctx;
  const blocked = androidBlockReason(sys, bay);
  if (blocked) {
    // The prompt already said it, but a press that does nothing at all is the worst outcome (the launch-pod rule)
    ctx.bus.emit('ui:notify', { text: blocked, kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
    return;
  }
  const net = ctx.net;
  if (!net || typeof net.setAndroidBay !== 'function') {
    ctx.bus.emit('ui:notify', { text: '안드로이드 슬롯을 사용할 수 없습니다', kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
    return;
  }
  const recruit = !recruited(sys, bay);
  sys.androidPending = { bay, recruit };
  refreshAndroidBays(sys);
  ctx.bus.emit('audio:play', { id: 'ui_equip' });
  try { net.setAndroidBay(bay, recruit); } catch (e) {
    console.warn('[hub] setAndroidBay failed', e);
    sys.androidPending = null;
    refreshAndroidBays(sys);
  }
}

/* ── registration · display ───────────────────────────────────────────── */

/** One `hub_android_<bay>` per bay when the shared ship is built (a visited ship gets none). */
export function buildAndroidBays(sys: HubSystem): void {
  const bays = getAndroidBays(sys);
  for (const def of bays) {
    const bay = def.bay;
    const it: Interactable = {
      id: `${ANDROID_BAY_ID}${bay}`,
      position: def.exit.clone(),
      radius: BAY_RADIUS,
      holdTime: ALLY_BAY_HOLD_S,
      getPrompt: () => androidPrompt(sys, bay),
      canInteract: () => androidCanInteract(sys, bay),
      interact: () => androidInteract(sys, bay),
    };
    sys.ctx.interactables.register(it);
    sys.androidBayIds.push(it.id);
  }
  refreshAndroidBays(sys);
}

export function clearAndroidBays(sys: HubSystem): void {
  for (const id of sys.androidBayIds) sys.ctx.interactables.unregister(id);
  sys.androidBayIds.length = 0;
  sys.podStands = [];
}

/** Bring the capsule status strips · name tags in line with the lobby (a squadmate = an empty bay, waiting = asleep inside). */
export function refreshAndroidBays(sys: HubSystem): void {
  const interior = sys.interior;
  if (!interior || typeof interior.setAndroidBayState !== 'function') return;
  const pending = sys.androidPending;
  for (const def of getAndroidBays(sys)) {
    const bay = def.bay;
    if (pending && pending.bay === bay) { interior.setAndroidBayState(bay, 'pending'); continue; }
    interior.setAndroidBayState(bay, recruited(sys, bay) ? 'out' : 'dormant');
  }
}

/**
 * The relay answered (`net:lobbyUpdated` · `net:androidReturned` · `net:error` · `net:lobbyLeft` ·
 * `net:statusChanged`): release the wait and repaint. The toasts are ui/'s share.
 */
export function androidAnswered(sys: HubSystem): void {
  if (sys.androidPending) sys.androidPending = null;
  refreshAndroidBays(sys);
}
