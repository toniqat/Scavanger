/**
 * src/net/parts/Remotes.ts — **원격 플레이어 참조**.
 *
 * 들어온 스냅샷마다 `RemotePlayerRef` 를 만들고 지운다. 이름 · 레벨 · 크루 카드 · 들쳐메기 관계가
 * 각각 다른 메시지로 오므로, 그것들을 하나의 ref 위에 합치는 것이 이 파일의 일이다.
 */
import * as THREE from 'three';
import type {
  ChatKind, GameContext, GameSystem, GameMessage, GameMessageOf, GameMessageType, GhostWire, LobbyPlayer, LobbyState,
  NetRef, NetStatus, PeerId, PingKind, RelayTarget, RemotePlayerRef, ServerToClient, Vec3Tuple,
} from '@/shared';
import type { ClientToServer, MissionMode, ProfileRef, RaidSessionBlob } from '@/shared';
import type { PlanetId, SocialRef } from '@/shared';
/* appended (2026-09-08): 공용 함선 격납고 */
import type { ShipVisitWire } from '@/shared';
import { isPlanetId } from '@/shared';
import {
  NET_INVITE_PARAM, NET_MISSION_RESUME_TIMEOUT_MS, NET_NAME_PARAM, NET_PLAYER_SNAPSHOT_HZ, NET_RECONNECT_BACKOFF_MS,
  NET_TOKEN_LENGTH, NET_TOKEN_PARAM, NET_TOKEN_STORAGE_KEY, NET_WS_PATH, PlayerFlags, RAID_BLOB_MAX_BYTES,
  isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName,
} from '@/shared';
import { NetClient } from '../NetClient';
import { ProfileSync } from '../ProfileSync';
import { SocialSync } from '../SocialSync';
import { RemotePlayer } from '../RemotePlayer';
import { Snapshotter } from '../Snapshotter';
import type { CrewCardWire, ImplantId } from '@/shared';
import { IMPLANT_IDS } from '@/shared';
import { CHAT_KINDS, type Handler, IMPLANT_ID_SET, MAX_LOBBYLESS_ATTEMPTS, NAME_STORAGE_KEY, PEER_LINGER, PING_KINDS, SNAPSHOT_INTERVAL, TOKEN_ALPHABET, TOKEN_RE, defIdOrNull, isGhostWire, isNum, isVec3, loadOrCreateSessionToken, sameCard, sanitizeCrewCard, vec } from '../model';
import type { NetSystem } from '../NetSystem';

/** `social:me` with the current character level; a no-op without a progression system (headless tests / stubs). */
export function pushLevel(sys: NetSystem): void {
  const level = sys.ctx.progression?.level;
  if (typeof level === 'number') sys.socialSync.setLevel(level);
  }

export function getRemotePlayers(sys: NetSystem): readonly RemotePlayerRef[] { return sys.remoteList; }

export function getRemotePlayer(sys: NetSystem, id: PeerId): RemotePlayerRef | undefined { return sys.remotes.get(id); }

/**
 * Mirror lobby facts onto the remote refs (name / slot; Phase 7: `inMission`, `suspended`) and report membership
 * changes for every member (`net:missionMembership`), suspension changes for refs (`net:peerSuspended`).
 */
export function syncRemoteIdentities(sys: NetSystem): void {
  const lobby = sys._lobby;
  if (!lobby) return;
  const bus = sys.ctx.bus;
  const me = sys.localId;
  const seen = new Set<PeerId>();
  for (const p of lobby.players) {
    seen.add(p.id);
    const inM = sys.playerInMission(p, lobby);
    if (sys.membership.get(p.id) !== inM) {
      sys.membership.set(p.id, inM);
      if (p.id !== me) bus.emit('net:missionMembership', { id: p.id, inMission: inM });
    }
    const r = sys.remotes.get(p.id);
    if (!r) continue;
    r.name = p.name;
    r.slot = p.slot;
    r.inMission = inM;
    // Suspended = socket down while part of the running mission we are in (the host keeps their body as a ghost).
    const susp = sys._inSession && inM && !p.connected;
    if (r.suspended !== susp) {
      r.suspended = susp;
      // Phase 10: a carrier whose socket went down drops the body it held — the host owns it as a ghost from now
      // on, so the victim's `carriedBy` must not keep pointing at a suspended shoulder.
      if (susp && r.carrying !== null) {
        r.carrying = null;
        bus.emit('net:remoteCarryChanged', { id: p.id, carrying: null });
      }
      bus.emit('net:peerSuspended', { id: p.id, name: p.name, suspended: susp });
    }
  }
  for (const id of Array.from(sys.membership.keys())) if (!seen.has(id)) sys.membership.delete(id);
  // Phase 10: forget the crew cards of members who are gone (our own card is kept — hub/ owns it).
  for (const id of Array.from(sys.crewCards.keys())) if (id !== me && !seen.has(id)) sys.crewCards.delete(id);
  // 2026-09-08: and their ship layouts, so a 격납고 bay never renders a member who left (ours is kept — hub/ owns it).
  for (const id of Array.from(sys.shipVisits.keys())) if (id !== me && !seen.has(id)) sys.shipVisits.delete(id);
  // 2026-09-12: and their buff lists + sync cooldowns.
  sys.charBuffRelay.prune(seen);
  }

/** `ghost state` / `sync` entry for a lobby member (never ourselves): the ref is created when missing. */
export function applyGhost(sys: NetSystem, g: GhostWire): void {
  if (g.id === sys.localId || !sys.getLobbyPlayer(g.id)) return;
  const r = sys.getOrCreateRemote(g.id);
  r.applyGhost(g);
  sys.ctx.bus.emit('net:ghostState', { id: g.id, hp: g.hp, downHp: g.dhp, state: g.st });
  }

/* ── remote players ─────────────────────────────────────────────────── */
export function getOrCreateRemote(sys: NetSystem, id: PeerId): RemotePlayer {
  let r = sys.remotes.get(id);
  if (r) return r;
  const lp = sys.getLobbyPlayer(id);
  r = new RemotePlayer(id, lp?.name ?? '대원', lp?.slot ?? 0, sys.ctx.time);
  if (lp && sys._lobby) {
    r.inMission = sys.playerInMission(lp, sys._lobby);
    r.suspended = sys._inSession && r.inMission && !lp.connected;
  }
  sys.remotes.set(id, r);
  sys.remoteList = Array.from(sys.remotes.values());
  // Phase 10: a card that arrived before the ref existed (hub → mission transition) is applied now.
  const card = sys.crewCards.get(id);
  if (card) { r.crewLevel = card.level; r.equippedImplant = card.implant; }
  // 2026-09-12: a buff list we already hold (the ref was rebuilt at a hub ↔ mission change) — no flicker, no request.
  sys.charBuffRelay.mirror(r);
  sys.ctx.bus.emit('net:remotePlayerAdded', { id });
  if (r.suspended) sys.ctx.bus.emit('net:peerSuspended', { id, name: r.name, suspended: true });
  return r;
  }

export function removeRemote(sys: NetSystem, id: PeerId): void {
  const r = sys.remotes.get(id);
  if (!r) return;
  sys.remotes.delete(id);
  sys.remoteList = Array.from(sys.remotes.values());
  sys.ctx.bus.emit('net:remotePlayerRemoved', { id });
  r.dispose();
  }

export function clearRemotes(sys: NetSystem): void {
  if (sys.remotes.size === 0) return;
  for (const id of Array.from(sys.remotes.keys())) sys.removeRemote(id);
  }

/* ══ Phase 10 — 발사 준비 패널 crew cards ══════════════════════════════ */
/**
 * Last `crew card` seen for `id`, the local player included: hub/ owns *sending* the card and we snoop our own
 * broadcast in `send()`, so the READY panel reads every cell (ours and the squad's) through this one accessor.
 */
export function getCrewCard(sys: NetSystem, id: PeerId): CrewCardWire | null { return sys.crewCards.get(id) ?? null; }

/**
 * Ask `id` for its full loadout (`crewq loadout` addressed to that peer). The answer comes back as
 * `crew loadout` → `net:crewLoadout {id, card, loadout}`; a peer may rate-limit it (`CREW_LOADOUT_COOLDOWN_S`),
 * so the caller must tolerate no answer at all.
 */
export function requestCrewLoadout(sys: NetSystem, id: PeerId): void {
  if (typeof id !== 'string' || id.length === 0 || id === sys.localId) return;
  sys.send({ t: 'crewq', ev: 'loadout' }, id);
  }

/* ── 공용 함선 격납고 (2026-09-08) ─────────────────────────────────────── */
/** Last `ship state` seen for `id` (our own included), or null. */
export function getShipVisit(sys: NetSystem, id: PeerId): ShipVisitWire | null { return sys.shipVisits.get(id) ?? null; }

/** Ask `id` for its ship layout (`shipq state`). Never sent to ourselves — our own copy is snooped in `send()`. */
export function requestShipVisit(sys: NetSystem, id: PeerId): void {
  if (typeof id !== 'string' || id.length === 0 || id === sys.localId) return;
  sys.send({ t: 'shipq', ev: 'state' }, id);
  }

/** Mirror the ship-side card onto the member's ref (the wielded `implantId` stays snapshot-driven). */
export function applyCrewCard(sys: NetSystem, id: PeerId, card: CrewCardWire): void {
  const r = sys.remotes.get(id);
  if (!r) return;
  r.crewLevel = card.level;
  r.equippedImplant = card.implant;
  }

/**
 * Phase 10: `RemotePlayerRef.carriedBy` is derived, not sent — every carrier advertises `carrying` and the carried
 * side only sets `PlayerFlags.CARRIED`. Runs once per frame while anybody carries (≤ 4 refs, so the O(n²) scan is
 * free) plus one trailing pass that clears the field when the last carry ends. A **suspended** carrier is ignored:
 * its socket is down, the host owns that body as a ghost, so the victim is no longer on a shoulder.
 */
export function refreshCarriedBy(sys: NetSystem): void {
  const localCarry = typeof sys.ctx.player?.carrying === 'string' ? sys.ctx.player.carrying : null;
  let any = localCarry !== null;
  if (!any) {
    for (const r of sys.remoteList) if (r.carrying !== null && !r.suspended) { any = true; break; }
  }
  if (!any && !sys.carryActive) return;
  for (const r of sys.remoteList) {
    // A suspended member's body is a host ghost, not a passenger — never point it at a shoulder.
    if (r.suspended) { r.carriedBy = null; continue; }
    let by: PeerId | null = null;
    if (localCarry === r.id) by = sys.localId;
    else {
      for (const o of sys.remoteList) {
        if (o !== r && !o.suspended && o.carrying === r.id) { by = o.id; break; }
      }
    }
    r.carriedBy = by;
  }
  sys.carryActive = any;
  }
