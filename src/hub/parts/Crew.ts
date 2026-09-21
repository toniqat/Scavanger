/**
 * src/hub/parts/Crew.ts — **crew cards** (Phase 10) and entering the training arena.
 *
 * In the hub a `PlayerSnapshot`'s weapons and implant are null and `LobbyPlayer` carries no level.
 * So what the ready panel needs (name · level · equipped implant · armor) travels as its own `crew`
 * message. On request that member's loadout document goes with it.
 */
import type {  } from '@/shared';
import type { CrewCardWire, Interactable, LoadoutSlot, PeerId } from '@/shared';
import { CREW_CARD_MIN_INTERVAL_S, CREW_LOADOUT_COOLDOWN_S, LEADER_DEVICE_RANGE } from '@/shared';
import type {  } from '../interiors/stations';
import type {  } from '../interiors/types';
import { _camLook, _camPos, _front } from '../model';
/* 2026-09-15: squads · dock matchmaking — an undocked squad locks the training arena */
import { squadLockReason } from './SquadDock';
/* 2026-09-15: an android bot member is not a person — it is left out of the training head count and the leader handoff */
import { isBotPlayer } from '@/shared';
import type { HubSystem } from '../HubSystem';

/* ── the training arena (Phase 7) ─────────────────────────────────────── */
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

/** Connected members currently inside the training. 2026-09-15: androids never go there — a bot is not counted. */
export function trainingCount(sys: HubSystem): number {
  const lobby = sys.ctx.net?.lobby;
  return lobby ? lobby.players.filter((p) => !isBotPlayer(p) && p.connected && p.inMission === true).length : 0;
  }

/**
 * Enter the training arena — from the firing range's `furn_sim_hub` (personal ship) or the shared-ship terminal.
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
  // 2026-09-15 (squads · dock matchmaking): an undocked squad has no training range (the relay refuses `not_docked` as well)
  const squadLock = squadLockReason(sys, 'training');
  if (squadLock) return deny(squadLock);
  if (net && sys.squadLobby()) {
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
  ctx.missionIntel = null;             // 2026-09-14 (the intel broker): a training never has fixed gimmicks (the same contract)
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
  if (!sys.squadLobby()) return;   // 2026-09-15: cards are for the squad in the same shared ship only
  sys.sendCrewCard(false);
  }

/** `to` omitted = broadcast to `others`; `force` skips the debounce (a direct `crewq sync` answer / arrival). */
export function sendCrewCard(sys: HubSystem, force: boolean, to?: PeerId): void {
  const net = sys.ctx.net;
  if (!net || !sys.squadLobby() || typeof net.send !== 'function') { sys.cardDirty = false; return; }
  if (!force && sys.ctx.time - sys.lastCardAt < CREW_CARD_MIN_INTERVAL_S) { sys.cardDirty = true; return; }
  if (to === undefined) { sys.lastCardAt = sys.ctx.time; sys.cardDirty = false; }
  try { net.send({ t: 'crew', ev: 'card', card: sys.crewCard() }, to ?? 'others'); } catch { /* offline */ }
  }

/** `crewq loadout` answer: our card + `ctx.inventory.captureCrewLoadout()`, rate-limited per requester. */
export function sendCrewLoadout(sys: HubSystem, to: PeerId): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!net || !sys.squadLobby() || typeof net.send !== 'function') return;
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

/* ── the squad-leader handoff (2026-09-09) ────────────────────────────── */
/**
 * **Walk up to a squadmate in the shared ship and hand them the squad leader.** The `Interactable` exists only while
 * I am the host, and only for connected members **inside the same ship**
 * (`RemotePlayerRef.hubSite === HubSystem.hubSite`) — someone touring another member's personal ship from the hangar
 * cannot be spoken to.
 *
 * A remote avatar belongs to `player/RemotePlayerSystem`, so it is only **read** here: the position from
 * `getRemotePlayers()` is copied into our own `Vector3` and used as the interaction spot. The interaction emits one
 * `leader:transferRequested` — the transfer itself is settled by net → server → `lobby:state` (exactly the entrance
 * the community window's right-click uses).
 */
export function updateLeaderHandoff(sys: HubSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const live = ctx.phase === 'hub' && !sys.cutscene && !!net && !!sys.squadLobby() && net.isHost && !sys.housingMode.active;
  if (!live) { clearLeaderHandoff(sys); return; }
  const site = sys.hubSite;
  const seen = new Set<string>();
  for (const ref of net.getRemotePlayers()) {
    if (!ref.connected || ref.stale) continue;
    if ((ref.hubSite ?? null) !== site) continue;         // someone inside another ship is not even visible
    const member = net.lobby?.players.find((p) => p.id === ref.id);
    // 2026-09-15: a bot member never becomes the leader (the relay's rule) — no `lead:<id>` is registered for one
    if (!member || !member.connected || isBotPlayer(member)) continue;
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
    entry.pos.y += 1;   // chest height — easier to aim at than their feet
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
  if (!net || !sys.squadLobby() || typeof net.send !== 'function') return;
  sys.loadoutAnsweredAt.clear();
  sys.sendCrewCard(true);
  try { net.send({ t: 'crewq', ev: 'sync' }, 'others'); } catch { /* offline */ }
  }
