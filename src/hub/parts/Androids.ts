/**
 * src/hub/parts/Androids.ts — **조종실 안드로이드 슬롯** (2026-09-15, docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원」).
 *
 * 공용 함선 조종실 한켠의 캡슐 세 칸(`interiors/AndroidBays.ts`)을 **분대장이 `ALLY_BAY_HOLD_S` 동안 꾹 누르면**
 * 그 칸의 안드로이드가 분대원이 되고(`lobby:android {recruit:true}`), 같은 칸을 다시 꾹 누르면 슬롯으로 돌아간다.
 * 판정은 전부 릴레이 것이다 — 여기서는 요청을 보내고, 로비 상태(`androidOnBay`)를 그대로 그린다.
 *
 * **거절 사유는 프롬프트로 보여 준다** (발사 포드와 같은 규칙): `ctx.interactables.findBest` 는 `canInteract:false`
 * 인 것을 건너뛰므로, 막아 버리면 플레이어는 프롬프트도 이유도 못 본다.
 *
 * 이 폴더는 안드로이드의 **몸**을 만들지 않는다. `HubRef.getAndroidBays()` (캡슐 발 위치) 와
 * `HubRef.getPodStandPose(slot)` (분대원이 된 안드로이드가 준비된 채 서 있는 발사 포드 앞자리)만 내주고,
 * 그 자리에 무엇을 그릴지는 allies/ · player/ 가 정한다.
 */
import * as THREE from 'three';
import type { HubAndroidBay, Interactable, LobbyState } from '@/shared';
import { ALLY_BAY_HOLD_S, androidNameOf, androidOnBay, isDockedLobby } from '@/shared';
import type { HubSystem } from '../HubSystem';

/** 슬롯 상호작용 id 접두어 (`hub_android_<bay>`). */
export const ANDROID_BAY_ID = 'hub_android_';
/** 상호작용 반경 (m) — 캡슐 앞에 서면 잡히는 넓이. 발사 포드(2.2)와 같은 감각. */
const BAY_RADIUS = 2.2;
/** 발사 포드 앞 대기 자리의 거리 (m) — 포드 문(`PodSlotDef.door`) 쪽으로 이만큼. 포드 문 블로커 밖이다. */
const POD_STAND_M = 1.6;

const NO_BAYS: readonly HubAndroidBay[] = [];

/** 지금 서 있는 공용 함선의 분대 (미도킹 분대 · 개인 함선이면 null). 로비는 언제나 `squadLobby()` 로 읽는다. */
function lobbyOf(sys: HubSystem): LobbyState | null {
  const lobby = sys.squadLobby();
  return lobby && isDockedLobby(lobby) ? lobby : null;
}

/** 내가 이 분대의 분대장인가 (`lobby.hostId`). `NetRef.isHost` 가 아니라 로비를 본다 — 서 있는 함선의 로비가 기준이다. */
function iAmLeader(sys: HubSystem, lobby: LobbyState): boolean {
  const me = sys.ctx.net?.localId ?? null;
  return !!me && lobby.hostId === me;
}

/* ── HubRef ────────────────────────────────────────────────────────────── */

/** 공용 함선 조종실의 안드로이드 슬롯 (bay 순). 공용 함선이 아니면 빈 배열. 재사용 배열 — 읽고 바로 쓴다. */
export function getAndroidBays(sys: HubSystem): readonly HubAndroidBay[] {
  if (sys.ship !== 'shared' || sys.visit) return NO_BAYS;
  return sys.interior?.androidBays ?? NO_BAYS;
}

/**
 * 로비 슬롯 `slot` 의 발사 포드 **앞** 대기 자리 — 분대원이 된 안드로이드가 준비된 채 서 있는 곳. 공용 함선이
 * 아니거나 그런 포드가 없으면 null. 자리는 함선을 지을 때 한 번 계산해 둔다 (매 프레임 읽히므로 할당하지 않는다).
 */
export function getPodStandPose(sys: HubSystem, slot: number): { position: THREE.Vector3; yaw: number } | null {
  if (sys.ship !== 'shared' || sys.visit) return null;
  return sys.podStands[slot] ?? null;
}

/** 함선을 지을 때 한 번: 포드마다 그 앞 대기 자리를 계산해 둔다 (`getPodStandPose` 의 원본). */
export function buildPodStands(sys: HubSystem): void {
  sys.podStands = [];
  if (sys.ship !== 'shared') return;
  for (const pod of sys.pods) {
    const def = pod.def;
    sys.podStands[def.slot] = {
      position: def.position.clone().addScaledVector(def.door, POD_STAND_M),
      // 포드의 yaw 는 이미 갑판(문 쪽)을 본다 — 대기 자세도 같은 방향이다
      yaw: def.yaw,
    };
  }
}

/* ── 상호작용 ───────────────────────────────────────────────────────────── */

/**
 * 지금 슬롯을 만질 수 없는 이유 (프롬프트에 그대로 나간다), 만질 수 있으면 null.
 * 순서: 요청 대기 → 접속 없음 → 분대장 아님 → 임무 진행 중.
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

/** 슬롯 프롬프트: 거절 사유가 있으면 그것, 없으면 `<이름> — 분대원으로 들이기` / `— 슬롯으로 돌려보내기`. */
export function androidPrompt(sys: HubSystem, bay: number): string | null {
  if (!androidCanInteract(sys, bay)) return null;
  const blocked = androidBlockReason(sys, bay);
  if (blocked) return blocked;
  const name = androidNameOf(bay);
  return recruited(sys, bay) ? `${name} — 슬롯으로 돌려보내기` : `${name} — 분대원으로 들이기`;
}

/** 이 칸의 안드로이드가 이미 분대원인가 (릴레이 로비의 봇 멤버). */
export function recruited(sys: HubSystem, bay: number): boolean {
  return androidOnBay(lobbyOf(sys), bay) !== null;
}

/**
 * 슬롯에 다가갈 수 있는 상황인가 (**거절 사유는 여기서 보지 않는다** — 프롬프트로 간다). 발사 포드와 같은 조건:
 * 함선을 걷고 있고, 화면이 떠 있지 않고, 포드에 앉아 있지 않고, 컷씬 · 워프 · 시설 관리 중이 아니다.
 */
export function androidCanInteract(sys: HubSystem, bay: number): boolean {
  const ctx = sys.ctx;
  if (bay < 0 || getAndroidBays(sys).length <= bay) return false;
  if (ctx.phase !== 'hub' || sys.cutscene || sys.travelling || sys.boardedSlot >= 0) return false;
  if (sys.menu.isOpen || sys.launchWarn.isOpen || sys.housingMode.active || sys.corpMenuOpen()) return false;
  if (sys.raidLaunch) return false;   // 발사가 확정된 뒤(암전 중)에는 아무것도 바꾸지 않는다
  return true;
}

/** 꾹 누르기가 끝났다 → `lobby:android`. 응답(`lobby:state` · `lobby:androidReturned` · `lobby:error`)이 대기를 푼다. */
export function androidInteract(sys: HubSystem, bay: number): void {
  const ctx = sys.ctx;
  const blocked = androidBlockReason(sys, bay);
  if (blocked) {
    // 프롬프트가 이미 말했지만, 눌렀는데 아무 일도 없는 것이 제일 나쁘다 (발사 포드와 같은 규칙)
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

/* ── 등록 · 표시 ─────────────────────────────────────────────────────────── */

/** 공용 함선을 지을 때 슬롯마다 `hub_android_<bay>` 를 세운다 (방문 중인 함선에는 아무것도 없다). */
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

/** 캡슐 표시등 · 이름표를 로비 상태에 맞춘다 (분대원 = 비어 있는 슬롯, 대기 = 안에 잠들어 있다). */
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
 * 릴레이에서 답이 왔다 (`net:lobbyUpdated` · `net:androidReturned` · `net:error` · `net:lobbyLeft` ·
 * `net:statusChanged`): 대기를 풀고 표시를 다시 맞춘다. 토스트는 ui/ 의 몫이다.
 */
export function androidAnswered(sys: HubSystem): void {
  if (sys.androidPending) sys.androidPending = null;
  refreshAndroidBays(sys);
}
