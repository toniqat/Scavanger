/**
 * src/net/parts/Messages.ts — **수신 메시지 분배**.
 *
 * 서버 프로토콜 메시지(`handleServerMessage`)와 다른 클라이언트가 보낸 불투명 게임 메시지
 * (`handleRelay`)를 각 시스템의 `onMessage` 구독자에게 넘긴다. 게임 규칙은 여기 없다 —
 * 스냅샷 적용과 `net:*` 버스 이벤트 번역까지가 이 파일의 범위다.
 */
import * as THREE from 'three';
import type {
  ChatKind, GameContext, GameSystem, GameMessage, GameMessageOf, GameMessageType, GhostWire, LobbyPlayer, LobbyState,
  NetRef, NetStatus, PeerId, PingKind, RelayTarget, RemotePlayerRef, ServerToClient, Vec3Tuple,
} from '@/shared';
import type { ClientToServer, MissionMode, ProfileRef, RaidSessionBlob } from '@/shared';
import type { PlanetId, SocialRef } from '@/shared';
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
import { CHAT_KINDS, type Handler, IMPLANT_ID_SET, MAX_LOBBYLESS_ATTEMPTS, NAME_STORAGE_KEY, PEER_LINGER, PING_KINDS, SNAPSHOT_INTERVAL, TOKEN_ALPHABET, TOKEN_RE, defIdOrNull, isGhostWire, isNum, isVec3, loadOrCreateSessionToken, sameCard, sanitizeCrewCard, sanitizeShipVisit, vec } from '../model';
import type { NetSystem } from '../NetSystem';

/* ── game messages ──────────────────────────────────────────────────── */
export function send(sys: NetSystem, msg: GameMessage, to: RelayTarget = 'others'): void {
  // Phase 10: hub/ owns sending the crew card; record our own copy so `getCrewCard(localId)` answers for the local
  // cell of the READY panel (and keeps answering while offline / single-player, where the relay drops the message).
  if (msg.t === 'crew') {
    const me = sys.localId;
    const own = sanitizeCrewCard(msg.card);
    if (me !== null && own !== null) {
      const prev = sys.crewCards.get(me);
      sys.crewCards.set(me, own);
      // Re-emit only on a real change — a hub/ handler that reacts by re-sending can never loop.
      if (!prev || !sameCard(prev, own)) sys.ctx.bus.emit('net:crewCard', { id: me, card: own });
    }
  }
  /*
   * 공용 함선 격납고 (2026-09-08): the same snoop for `ship state`. hub/ broadcasts our own ship layout; keeping our
   * copy here means our **own** hangar bay renders from exactly the wire the squad sees — one code path, and it
   * still works offline / single-player where the relay drops the message.
   */
  if (msg.t === 'ship' && msg.ev === 'state') {
    const me = sys.localId;
    const own = sanitizeShipVisit(msg.ship);
    if (me !== null && own !== null) {
      sys.shipVisits.set(me, own);
      sys.ctx.bus.emit('net:shipVisit', { id: me });
    }
  }
  if (!sys.client.connected || !sys._lobby) return;
  sys.client.send({ t: 'relay', to, d: msg });
  }

/* ── inbound: server ────────────────────────────────────────────────── */
export function handleServerMessage(sys: NetSystem, msg: ServerToClient): void {
  const bus = sys.ctx.bus;
  switch (msg.t) {
    case 'welcome':
      sys.onWelcome(msg);
      return;
    case 'pong':
      if (sys.client.hasServerTime) sys.serverOffset = sys.client.serverTimeOffset;
      return;

    case 'lobby:state': {
      const matched = sys.pendingQuickMatch && (!sys._lobby || sys._lobby.code !== msg.lobby.code);
      sys.applyLobby(msg.lobby);
      if (matched) {
        sys.pendingQuickMatch = false;
        bus.emit('net:matched', { lobby: msg.lobby, created: msg.lobby.players.length === 1 });
      }
      return;
    }

    case 'lobby:error':
      if (msg.code === 'duplicate') sys.duplicateKicked = true;
      // C-29: the operator kicked us / the server is at its cap — the close follows; `onSocketDown` stops reconnecting.
      if (msg.code === 'kicked' || msg.code === 'server_full') sys.serverRefused = msg.code;
      sys.profileSync.onError(msg.code);
      sys.pendingQuickMatch = false;
      bus.emit('net:error', { code: msg.code, message: msg.message });
      return;

    case 'lobby:left':
      sys.dropLobby('left');
      return;

    case 'game:start': {
      const mode: MissionMode = msg.mode ?? 'raid';
      const me = sys.localId ? msg.lobby.players.find((p) => p.id === sys.localId) : undefined;
      // A training reaches every member, but only those the server marked `inMission` (the starter) enter it;
      // the rest just see the lobby running (`missionInProgress`) and may join from the terminal.
      const enters = me ? (me.inMission ?? true) : true;
      if (sys._inSession || (mode === 'training' && !enters)) { sys.applyLobby(msg.lobby); return; }
      // Phase 11: the raid's 목표 행성 — the server echoes it, `lobby.planet` is the fallback for an older relay.
      const planet = mode === 'training' ? null : (isPlanetId(msg.planet) ? msg.planet : (isPlanetId(msg.lobby.planet) ? msg.lobby.planet : null));
      sys.beginSession(msg.seed, msg.lobby, mode, false, planet);
      return;
    }

    case 'peer:left': {
      const prev = sys._lobby;
      const gone = prev ? prev.players.find((p) => p.id === msg.id) : undefined;
      sys._lobby = msg.lobby;
      if (prev && prev.code === msg.lobby.code && prev.hostId !== msg.lobby.hostId) sys.onHostChanged(prev.hostId, msg.lobby.hostId);
      sys.syncRemoteIdentities();
      bus.emit('net:lobbyUpdated', { lobby: msg.lobby });
      bus.emit('net:peerLeft', { id: msg.id, name: gone?.name ?? '대원' });
      const r = sys.remotes.get(msg.id);
      if (r && r.connected) {
        r.connected = false;
        r.removeAt = sys.ctx.time + PEER_LINGER;
      }
      return;
    }

    case 'relay':
      sys.handleRelay(msg.from, msg.d);
      return;

    /* Phase 7 */
    case 'profile:docs':
      sys.profileSync.onDocs(msg.profile);
      return;
    case 'credits:result':
      sys.profileSync.onCreditsResult(msg);
      return;

    /* Phase 11: 소셜 — SocialSync validates every frame before it reaches the UI. */
    case 'social:state':
      sys.socialSync.onState(msg.social);
      return;
    case 'social:invited':
      sys.socialSync.onInvited(msg.invite);
      return;
    case 'social:whisper':
      sys.socialSync.onWhisper(msg);
      return;
    case 'social:play':
      sys.socialSync.onPlay(msg);
      return;
    case 'social:error':
      sys.socialSync.onError(msg);
      return;
  }
  }

/* ── inbound: relayed game messages ─────────────────────────────────── */
export function handleRelay(sys: NetSystem, from: PeerId, d: GameMessage): void {
  if (typeof d !== 'object' || d === null || typeof (d as { t?: unknown }).t !== 'string') {
    console.warn('[net] malformed relay payload dropped', d);
    return;
  }
  const bus = sys.ctx.bus;
  switch (d.t) {
    case 'ps': {
      if (!isNum(d.seq) || !isVec3(d.p) || !isVec3(d.v) || !isNum(d.yaw) || !isNum(d.pitch) || !isNum(d.hp) || !isNum(d.f)) {
        console.warn('[net] malformed snapshot dropped', from);
        return;
      }
      // Only peers sharing our space become remote refs: hub snapshots (IN_HUB) while we are in a mission — or
      // mission snapshots while we walk the ship — belong to a different 3D scene. An existing ref simply goes stale.
      const senderInHub = (d.f & PlayerFlags.IN_HUB) !== 0;
      if (senderInHub === sys._inSession) break;
      const r = sys.getOrCreateRemote(from);
      const wasDowned = r.isDowned;
      const wasCarrying = r.carrying;
      r.push(d, sys.ctx.time);
      // Phase 10: the carried peer changed → HUD markers / 분대 목록 (`carriedBy` is derived in `update`).
      if (r.carrying !== wasCarrying) bus.emit('net:remoteCarryChanged', { id: from, carrying: r.carrying });
      // Phase 2: squadmate went down / got back up → HUD feed (derived from the DOWNED flag transition)
      if (r.isDowned !== wasDowned) {
        const name = r.name ?? sys.getLobbyPlayer(from)?.name ?? '대원';
        if (r.isDowned) bus.emit('net:remoteDowned', { id: from, name, position: r.position.clone() });
        else if (!r.isDead) bus.emit('net:remoteRevived', { id: from, name });
      }
      break;
    }
    case 'fire':
      if (typeof d.w === 'string' && isVec3(d.o) && isVec3(d.d)) {
        bus.emit('net:remoteFired', { id: from, weaponId: d.w, origin: vec(d.o), direction: vec(d.d) });
      }
      break;
    case 'reload':
      if (typeof d.w === 'string') bus.emit('net:remoteReloaded', { id: from, weaponId: d.w });
      break;
    case 'grenade':
      if (isVec3(d.p) && isVec3(d.v)) bus.emit('net:remoteGrenade', { id: from, position: vec(d.p), velocity: vec(d.v), fuse: typeof d.fuse === 'number' ? d.fuse : undefined });
      break;
    case 'revive': {
      // reviver → us (Phase 2): progress feeds the HUD, done stands us back up
      if (d.target !== sys.localId) break;
      const byName = sys.getLobbyPlayer(from)?.name ?? sys.remotes.get(from)?.name ?? '대원';
      if (d.ev === 'done') { sys.ctx.player?.revive(); bus.emit('player:reviveProgress', { t: -1, by: from, byName }); }
      else if (d.ev === 'progress') bus.emit('player:reviveProgress', { t: typeof d.p === 'number' ? Math.max(0, Math.min(1, d.p)) : 0, by: from, byName });
      else if (d.ev === 'cancel') bus.emit('player:reviveProgress', { t: -1, by: from, byName });
      break;
    }
    case 'died': {
      const r = sys.remotes.get(from);
      if (r) r.markDead();
      const name = r?.name ?? sys.getLobbyPlayer(from)?.name ?? '대원';
      bus.emit('net:remoteDied', { id: from, name, position: isVec3(d.p) ? vec(d.p) : (r ? r.position.clone() : new THREE.Vector3()) });
      break;
    }
    case 'ping':
      if (isVec3(d.p)) {
        const kind: PingKind = typeof d.kind === 'string' && PING_KINDS.has(d.kind) ? d.kind : 'ground';
        bus.emit('net:remotePing', { id: from, position: vec(d.p), kind });
      }
      break;
    case 'chat':
      if (typeof d.text === 'string') {
        const name = sys.getLobbyPlayer(from)?.name ?? sys.remotes.get(from)?.name ?? '대원';
        const kind: ChatKind = typeof d.kind === 'string' && CHAT_KINDS.has(d.kind) ? d.kind : 'text';
        bus.emit('net:chat', { id: from, name, text: d.text.slice(0, 200), kind });
      }
      break;
    case 'dmg':
      if (isNum(d.amount) && sys.ctx.player && sys._inSession) {
        sys.ctx.player.takeDamage(d.amount, isVec3(d.from) ? vec(d.from) : undefined);
        if (d.slow && isNum(d.slow.duration) && isNum(d.slow.factor)) bus.emit('player:applySlow', { duration: d.slow.duration, factor: d.slow.factor });
        // Phase 7: knockback rides along (behemoth charge, blasts); the player ignores it while downed.
        if (d.kb && isVec3(d.kb.d) && isNum(d.kb.s) && d.kb.s > 0) sys.ctx.player.applyKnockback(vec(d.kb.d), d.kb.s);
      }
      break;
    /* Phase 7: the host's ghost of a suspended member overrides that ref's pose / vitals. */
    case 'ghost':
      if (!sys._inSession) break;
      if (d.ev === 'state') { if (isGhostWire(d.g)) sys.applyGhost(d.g); }
      else if (d.ev === 'sync') { if (Array.isArray(d.ghosts)) for (const g of d.ghosts) if (isGhostWire(g)) sys.applyGhost(g); }
      else if (d.ev === 'restore') {
        if (isGhostWire(d.g) && d.g.id === sys.localId) {
          bus.emit('net:ghostRestore', { state: { position: vec(d.g.p), yaw: d.g.yaw, hp: d.g.hp, downHp: d.g.dhp, state: d.g.st, shield: d.g.sh } });
        }
      } else if (d.ev === 'gone') {
        if (typeof d.id === 'string') sys.remotes.get(d.id)?.clearGhost();
      }
      break;
    /*
     * Phase 10: a member's ship-side crew card (`crew card`) or its full answer to `crewq loadout`
     * (`crew loadout`). Stored + mirrored onto the ref; the loadout document itself stays opaque (inventory/
     * validates it before rendering). `crewq` needs no case — hub/ answers it through `onMessage('crewq')`.
     */
    case 'crew': {
      const card = sanitizeCrewCard(d.card);
      if (!card) break;
      sys.crewCards.set(from, card);
      sys.applyCrewCard(from, card);
      bus.emit('net:crewCard', { id: from, card });
      if (d.ev === 'loadout') bus.emit('net:crewLoadout', { id: from, card, loadout: d.loadout });
      break;
    }
    /*
     * 공용 함선 격납고 (2026-09-08): a member's ship layout (`ship state`), sent on arrival in the shared ship, on a
     * debounced housing change and as the answer to `shipq state`. Stored for hub/ to render a hangar bay from.
     * `shipq` needs no case — hub/ answers it through `onMessage('shipq')`, exactly like `crewq`.
     */
    case 'ship': {
      const ship = sanitizeShipVisit(d.ship);
      if (!ship) break;
      sys.shipVisits.set(from, ship);
      bus.emit('net:shipVisit', { id: from });
      break;
    }
    /*
     * Phase 10: 들쳐메기 one-shots. The steady state rides on `PlayerFlags.CARRYING` + `cr`, so these only buy
     * instant feedback (before the next 20 Hz snapshot) and tell everyone where a dropped body landed.
     */
    case 'carry': {
      if (typeof d.target !== 'string' || d.target.length === 0) break;
      const r = sys.remotes.get(from);
      if (!r) break;
      const next = d.ev === 'pick' ? d.target : null;
      if (d.ev === 'drop' && r.carrying !== d.target) break; // a stale drop for someone else's body
      if (r.carrying !== next) {
        r.carrying = next;
        bus.emit('net:remoteCarryChanged', { id: from, carrying: next });
      }
      break;
    }
    /* Phase 7: the new host finished promoting itself → every system re-requests its sync (isLocalHost false). */
    case 'flow':
      if (d.ev === 'takeover' && sys._inSession && from !== sys.localId) {
        const cur = sys._lobby?.hostId ?? from;
        const prev = cur === from ? sys.prevHostId : cur;
        bus.emit('net:hostChanged', { hostId: from, prev: prev === from ? null : prev, isLocalHost: false });
      }
      break;
    default:
      // hit / explode / hitc / es / ee / ex / exq / crate / item / itemq / cont / contq / ghostq …: subscribers only.
      break;
  }

  const set = sys.handlers.get(d.t);
  if (set && set.size) {
    for (const h of Array.from(set)) {
      try { h(d, from); } catch (e) { console.error(`[net] onMessage handler for '${d.t}' threw`, e); }
    }
  }
  }
