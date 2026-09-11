/**
 * src/hub/parts/Crew.ts — **크루 카드** (Phase 10) 와 훈련장 입장.
 *
 * 허브에서는 `PlayerSnapshot` 의 무기 · 임플란트가 null 이고 `LobbyPlayer` 에는 레벨이 없다.
 * 그래서 발사 준비 패널이 쓸 정보(이름 · 레벨 · 장착 임플란트 · 방어구)를 별도 `crew` 메시지로
 * 주고받는다. 요청이 오면 그 대원의 장비 문서도 보낸다.
 */
import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import { getPlanet, isPlanetId, planetLabel, HUB_TRAVEL_DURATION, PLANET_NONE_LABEL, PLANET_STORAGE_KEY } from '@/shared';
import type { CrewCardWire, GameContext, GameSystem, HubLaunchSlot, HubRef, HubShipKind, Interactable, InteriorCollider, LoadoutSlot, LobbyState, PeerId, RoomPurpose } from '@/shared';
import { CREW_CARD_MIN_INTERVAL_S, CREW_LOADOUT_COOLDOWN_S, HUB_DOCKING_DURATION, HUB_LAUNCH_COUNTDOWN, HUB_READY_BLOCKER, HUB_READY_CELLS, Keys, LEADER_DEVICE_RANGE, NET_SLOT_COLORS, ROOM_PURPOSE_LABEL_KO } from '@/shared';
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
import { type DockTransition, LOCK_REQUEST_GRACE_MS, READY_ECHO_GRACE, UNBOARD_GRACE, _camLook, _camPos, _front } from '../model';
import type { HubSystem } from '../HubSystem';

/* ── 시뮬레이션 훈련장 (Phase 7) ─────────────────────────────────────────── */
/** A training is running in our lobby (`lobby.started` with mode `'training'`). */
export function trainingRunning(sys: HubSystem): boolean {
  const net = sys.ctx.net, lobby = net?.lobby;
  return !!lobby?.started && (net?.missionMode ?? lobby?.mode ?? 'raid') === 'training';
  }

/** A raid is running in our lobby (pods rejoin it; the training hub is locked). */
export function raidRunning(sys: HubSystem): boolean {
  const net = sys.ctx.net, lobby = net?.lobby;
  return !!lobby?.started && (net?.missionMode ?? lobby?.mode ?? 'raid') !== 'training';
  }

/** Connected members currently inside the training. */
export function trainingCount(sys: HubSystem): number {
  const lobby = sys.ctx.net?.lobby;
  return lobby ? lobby.players.filter((p) => p.connected && p.inMission === true).length : 0;
  }

/**
 * Enter the 시뮬레이션 훈련장 — from the 사격장 `furn_sim_hub` (personal ship) or the shared-ship terminal.
 * No countdown, no ready gating, individual entry: in a lobby any member calls `ctx.net.startGame(seed, 'training')`
 * (the server marks only the caller `inMission`), a training already running is joined with `rejoinMission()`, and a
 * running raid refuses. Solo: `ctx.missionMode = 'training'` is set **before** `game:newMission {seed, mode}` so
 * every `game:newMission` handler (world included) already sees the mode. Returns true when a request went out.
 */
export function startTraining(sys: HubSystem): boolean {
  const ctx = sys.ctx;
  if (ctx.phase !== 'hub' || sys.cutscene || sys.boardedSlot >= 0 || sys.housingMode.active) return false;
  const net = ctx.net;
  const seed = sys.resolveSeed();
  const deny = (text: string): false => {
    ctx.bus.emit('ui:notify', { text, kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
    return false;
  };
  if (net?.lobby) {
    if (sys.raidRunning()) return deny('임무 진행 중 — 훈련장을 열 수 없습니다');
    if (sys.trainingRunning()) {
      if (!net.missionInProgress || typeof net.rejoinMission !== 'function') return deny('이미 훈련장에 있습니다');
      ctx.bus.emit('ui:notify', { text: `훈련장에 합류합니다 (${sys.trainingCount()}명 훈련 중)`, kind: 'info' });
      net.rejoinMission();          // → net:gameStarting {mode:'training', rejoin} + game:newMission → teardown('mission')
      return true;
    }
    if (typeof net.startGame !== 'function') return deny('훈련장을 열 수 없습니다');
    ctx.bus.emit('ui:notify', { text: '시뮬레이션 훈련장 입장', kind: 'info' });
    net.startGame(seed, 'training');   // server → game:start {mode:'training'} → net emits game:newMission for us only
    return true;
  }
  ctx.missionMode = 'training';
  ctx.missionPlanet = null;            // the arena has no planet (Phase 11 contract: a training clears it)
  ctx.bus.emit('ui:notify', { text: '시뮬레이션 훈련장 입장', kind: 'info' });
  ctx.bus.emit('game:newMission', { seed, mode: 'training' });
  return true;
  }

/* ── crew cards (Phase 10) ─────────────────────────────────────────────── */
/**
 * Answer the two `crewq` requests. Receiving / storing cards is `net/`'s job (`getCrewCard`, `net:crewCard`,
 * `net:crewLoadout`); the hub only **sends**. Registered once — `ctx.net` exists by our `init` (NetSystem is
 * registered first) but the ref is optional in the contract, so a missing one is retried on `hub:entered`.
 */
export function bindCrewRequests(sys: HubSystem): void {
  if (sys.crewUnsub) return;
  const net = sys.ctx.net;
  if (!net || typeof net.onMessage !== 'function') return;
  sys.crewUnsub = net.onMessage('crewq', (msg, from) => {
    if (msg.ev === 'sync') sys.sendCrewCard(true, from);
    else if (msg.ev === 'loadout') sys.sendCrewLoadout(from);
  });
  }

/** Our own card: level / ship implant / armor + the three weapon slots (no attachments). */
export function crewCard(sys: HubSystem): CrewCardWire {
  const ctx = sys.ctx;
  const inv = ctx.inventory;
  const defId = (slot: LoadoutSlot): string | null => {
    if (!inv || typeof inv.getEquipped !== 'function') return null;
    try { return inv.getEquipped(slot)?.defId ?? null; } catch { return null; }
  };
  let level = 1;
  try { const l = ctx.progression?.level; if (typeof l === 'number' && Number.isFinite(l)) level = Math.max(1, Math.round(l)); } catch { /* stub */ }
  let implant: CrewCardWire['implant'] = null;
  try { implant = ctx.implants?.equipped ?? null; } catch { /* stub */ }
  return { level, implant, armor: defId('armor'), primary: defId('primary'), primary2: defId('primary2'), secondary: defId('secondary') };
  }

/**
 * A level / implant / equipment change: repaint our own READY cell, then broadcast (debounced). Only while the hub
 * is up — mid-raid loadout churn is nobody's business, and a `crewq sync` re-reads the card on demand anyway.
 */
export function crewCardChanged(sys: HubSystem): void {
  if (!sys.interior || !sys.active) return;
  sys.syncPods();
  if (!sys.ctx.net?.lobby) return;
  sys.sendCrewCard(false);
  }

/** `to` omitted = broadcast to `others`; `force` skips the debounce (a direct `crewq sync` answer / arrival). */
export function sendCrewCard(sys: HubSystem, force: boolean, to?: PeerId): void {
  const net = sys.ctx.net;
  if (!net?.lobby || typeof net.send !== 'function') { sys.cardDirty = false; return; }
  if (!force && sys.ctx.time - sys.lastCardAt < CREW_CARD_MIN_INTERVAL_S) { sys.cardDirty = true; return; }
  if (to === undefined) { sys.lastCardAt = sys.ctx.time; sys.cardDirty = false; }
  try { net.send({ t: 'crew', ev: 'card', card: sys.crewCard() }, to ?? 'others'); } catch { /* offline */ }
  }

/** `crewq loadout` answer: our card + `ctx.inventory.captureCrewLoadout()`, rate-limited per requester. */
export function sendCrewLoadout(sys: HubSystem, to: PeerId): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!net?.lobby || typeof net.send !== 'function') return;
  const last = sys.loadoutAnsweredAt.get(to) ?? -Infinity;
  if (ctx.time - last < CREW_LOADOUT_COOLDOWN_S) return;
  const inv = ctx.inventory;
  if (!inv || typeof inv.captureCrewLoadout !== 'function') return;
  let loadout: unknown = null;
  try { loadout = inv.captureCrewLoadout(); } catch { return; }
  if (loadout === null || loadout === undefined) return;
  sys.loadoutAnsweredAt.set(to, ctx.time);
  try { net.send({ t: 'crew', ev: 'loadout', card: sys.crewCard(), loadout }, to); } catch { /* offline */ }
  }

/* ── 분대장 넘기기 (2026-09-09) ─────────────────────────────────────────── */
/**
 * 공용 함선 안에서 **다른 분대원에게 다가가 분대장을 넘긴다**. 내가 호스트일 때만 `Interactable` 이 뜨고,
 * **같은 함선 안**(`RemotePlayerRef.hubSite === HubSystem.hubSite`)에 있는 접속 중인 대원만 대상이다 —
 * 격납고에서 남의 개인 함선을 구경하는 사람에게 말을 걸 수는 없다.
 *
 * 원격 아바타는 `player/RemotePlayerSystem` 소유이므로 여기서는 **읽기만** 한다: `getRemotePlayers()` 의 위치를
 * 우리 쪽 `Vector3` 로 복사해 상호작용 지점으로 쓴다. 상호작용은 `leader:transferRequested` 하나만 낸다 —
 * 실제 이관은 net → 서버 → `lobby:state` 가 확정한다 (커뮤니티 창의 우클릭과 완전히 같은 입구).
 */
export function updateLeaderHandoff(sys: HubSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const live = ctx.phase === 'hub' && !sys.cutscene && !!net?.lobby && net.isHost && !sys.housingMode.active;
  if (!live) { clearLeaderHandoff(sys); return; }
  const site = sys.hubSite;
  const seen = new Set<string>();
  for (const ref of net.getRemotePlayers()) {
    if (!ref.connected || ref.stale) continue;
    if ((ref.hubSite ?? null) !== site) continue;         // 다른 함선 안에 있는 사람은 보이지도 않는다
    const member = net.lobby?.players.find((p) => p.id === ref.id);
    if (!member || !member.connected) continue;
    seen.add(ref.id);
    let entry = sys.leaderHandoffs.get(ref.id);
    if (!entry) {
      const pos = ref.position.clone();
      const id = `lead:${ref.id}`;
      const peerId = ref.id;
      const it: Interactable = {
        id, position: pos, radius: LEADER_DEVICE_RANGE,
        getPrompt: () => `${nameOf(sys, peerId)}에게 분대장 넘기기`,
        canInteract: () => ctx.phase === 'hub' && !!ctx.net?.isHost && !sys.uiBlocked(),
        interact: () => {
          ctx.bus.emit('leader:transferRequested', { peerId });
          ctx.bus.emit('audio:play', { id: 'ui_click' });
        },
      };
      entry = { it, pos };
      sys.leaderHandoffs.set(peerId, entry);
      ctx.interactables.register(it);
    }
    entry.pos.copy(ref.position);
    entry.pos.y += 1;   // 가슴 높이 — 발밑보다 조준하기 쉽다
  }
  for (const [id, entry] of sys.leaderHandoffs) {
    if (seen.has(id)) continue;
    ctx.interactables.unregister(entry.it.id);
    sys.leaderHandoffs.delete(id);
  }
  }

function nameOf(sys: HubSystem, peerId: PeerId): string {
  const p = sys.ctx.net?.lobby?.players.find((q) => q.id === peerId);
  return p?.name || '분대원';
}

export function clearLeaderHandoff(sys: HubSystem): void {
  if (sys.leaderHandoffs.size === 0) return;
  for (const entry of sys.leaderHandoffs.values()) sys.ctx.interactables.unregister(entry.it.id);
  sys.leaderHandoffs.clear();
  }

/** Arriving in the shared ship: publish our card and ask the squad for theirs. */
export function announceCrew(sys: HubSystem): void {
  sys.bindCrewRequests();
  const net = sys.ctx.net;
  if (!net?.lobby || typeof net.send !== 'function') return;
  sys.loadoutAnsweredAt.clear();
  sys.sendCrewCard(true);
  try { net.send({ t: 'crewq', ev: 'sync' }, 'others'); } catch { /* offline */ }
  }
