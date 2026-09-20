/**
 * src/stratagems/parts/Rescue.ts — **the rescue drop**: the ship call that stands a dead squadmate back up.
 *
 * Its flow differs from every other call. Arming does not go straight to ground targeting — the **four-cell
 * squadmate picker** (`ui/hud/RescuePicker`) comes up first, and while that screen holds a blocker the targeting
 * stands still; once `rescue:selectTarget` names a target the usual ground ring comes back.
 *
 * **The host holds the count left** (squad-wide, `RESCUE_DROPS_PER_RAID` of them). Anyone sends `rescue req` and
 * the host answers with `grant` (one charge spent + the landing point picked with `world.scatterPoints`) or
 * `deny`. The charge goes at the **moment of the grant** and is never refunded afterwards, whatever happens.
 * Single-player treats itself as the host and runs the same path.
 *
 * **No hellpod is drawn here.** The drop pod seen remotely is drawn by `player/` from `pod drop` and that is the
 * only source, so this file raises nothing past the target marker · the events (`rescue:called` / `rescue:landed`).
 */
import * as THREE from 'three';
import {
  RESCUE_DROPS_PER_RAID, RESCUE_POD_MIN_GAP, RESCUE_SCATTER_RADIUS, STRATAGEM_HOST_ONLY,
  isAndroidId, isBotPlayer,
  type PeerId, type RescueCandidate, type RescueMessage, type StratagemId,
} from '@/shared';
import { Call, defOf, toTuple } from '../model';
import type { StratagemSystem } from '../StratagemSystem';
import { callRefusal, fromHost, rescueDenyId, sendCallDeny, wallSeconds } from './Wire';

/** Single-player id used everywhere a `PeerId` is expected but no relay exists. */
export const SOLO_ID = 'sp';

/** Our own id on the wire (`'sp'` offline). */
export function selfId(sys: StratagemSystem): string {
  return sys.ctx.net?.localId ?? SOLO_ID;
}

/* ─────────────────────────── candidates ─────────────────────────── */
/**
 * The squadmate cells. With a lobby the lobby members are the source (name · slot are certain), without one the
 * local player + the remote refs. Death is read from `RemotePlayerRef.isDead && !isDowned`, and a corpse already
 * in `ctx.corpses` is used as a second piece of evidence (`ctx.corpses` is published by another folder, so it can
 * be missing).
 */
export function getRescueCandidates(sys: StratagemSystem): readonly RescueCandidate[] {
  const ctx = sys.ctx;
  const net = ctx.net;
  const me = selfId(sys);
  const out: RescueCandidate[] = [];
  const corpseOf = (id: string): THREE.Vector3 | null => {
    try { return ctx.corpses?.latestOf(id)?.position ?? null; } catch { return null; }
  };

  const pushLocal = (name: string, slot: number): void => {
    const p = ctx.player;
    const corpse = corpseOf(me);
    const dead = (!!p && p.isDead && !p.isDowned) || corpse !== null;
    out.push({ peerId: me, name, slot, selectable: dead, corpse });
  };

  const members = net?.lobby?.players ?? null;
  if (members && members.length > 0) {
    for (const m of members) {
      // 2026-09-15 (user's decision): an android is **never a rescue-drop target** — a person gets it up when it
      //   goes down, and when it dies that is the end of it
      if (isBotPlayer(m)) continue;
      // 2026-09-15 (abandoning the raid from the title): a **drifted** squadmate cannot be revived by a rescue
      //   drop — they are left out of the candidate list entirely (user's decision)
      if (m.drifted) continue;
      if (m.id === me) { pushLocal(m.name || '나', m.slot); continue; }
      const ref = net?.getRemotePlayer(m.id) ?? null;
      const corpse = corpseOf(m.id);
      const dead = (!!ref && ref.isDead && !ref.isDowned) || corpse !== null;
      out.push({ peerId: m.id, name: m.name || '분대원', slot: m.slot, selectable: dead, corpse });
    }
  } else {
    pushLocal(net?.playerName ?? '나', net?.localSlot ?? 0);
    for (const ref of net?.getRemotePlayers() ?? []) {
      const corpse = corpseOf(ref.id);
      const dead = (ref.isDead && !ref.isDowned) || corpse !== null;
      out.push({ peerId: ref.id, name: ref.name || '분대원', slot: ref.slot, selectable: dead, corpse });
    }
  }
  out.sort((a, b) => a.slot - b.slot);
  return out;
}

/** The count left > 0 and at least one squadmate is dead. */
export function rescueAvailable(sys: StratagemSystem): boolean {
  if (sys._rescueLeft <= 0) return false;
  for (const c of getRescueCandidates(sys)) if (c.selectable) return true;
  return false;
}

/**
 * The arming refusal reason (null with none). The host-only gate and the rescue-drop gate are gathered in one
 * place — because what the wheel greys out and what is actually refused have to read the same rule.
 */
export function armBlockReason(sys: StratagemSystem, id: StratagemId): string | null {
  if (hostLocked(sys, id)) return '분대장만 쓸 수 있습니다';
  if (id === 'rescue_drop') {
    if (sys._rescueLeft <= 0) return '구조선을 모두 소진했습니다';
    if (!rescueAvailable(sys)) return '구조 대상이 없습니다';
  }
  return null;
}

/** A host-only call while not the host in multiplayer (always false in single-player). */
export function hostLocked(sys: StratagemSystem, id: StratagemId): boolean {
  const ctx = sys.ctx;
  if (!ctx.isMultiplayer) return false;
  const net = ctx.net;
  if (!net) return false;
  return STRATAGEM_HOST_ONLY.includes(id) && !net.isHost;
}

/* ─────────────────────────── selection ─────────────────────────── */
/** `rescue:selectTarget` — the squadmate the picker chose (null = cleared → the call itself is put away). */
export function selectTarget(sys: StratagemSystem, peerId: string | null): void {
  if (sys._armed !== 'rescue_drop') { sys._rescueTarget = null; return; }
  if (peerId === null) { sys._rescueTarget = null; sys.disarm(); return; }
  const cand = getRescueCandidates(sys).find((c) => c.peerId === peerId);
  if (!cand || !cand.selectable) {
    sys.audio('ui_deny', undefined, 0.6);
    sys.ctx.bus.emit('ui:notify', { text: '구조할 수 없는 대원입니다', kind: 'warning', duration: 1.5 });
    return;
  }
  sys._rescueTarget = peerId;
  sys.audio('ui_click', undefined, 0.6);
}

/* ─────────────────────────── confirm → request ─────────────────────────── */
/**
 * The confirm after ground targeting ends. The host (or single-player) grants it on the spot, anyone else sends
 * `rescue req` to the host. The cooldown starts here exactly as for any other call — only the count left is taken
 * at the host's grant.
 */
export function confirmRescue(sys: StratagemSystem, target: string, position: THREE.Vector3): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!ctx.isMultiplayer || !net) { grant(sys, target, position, SOLO_ID); return; }
  if (net.isHost) { grant(sys, target, position, net.localId ?? SOLO_ID); return; }
  net.send({ t: 'rescue', ev: 'req', target, p: toTuple(position) }, 'host');
}

/**
 * Host authority: spends one charge, picks the landing point and broadcasts `rescue grant` to everyone.
 * The landing point comes from `world.scatterPoints` — in a tree where that function does not exist yet the
 * aimed point is used as it is.
 */
export function grant(sys: StratagemSystem, target: string, position: THREE.Vector3, by: string): void {
  const ctx = sys.ctx;
  if (sys._rescueLeft <= 0) { deny(sys, by, 'empty'); return; }
  // 2026-09-15 (user's decision): an android is never a rescue-drop target — it is not in the candidate list
  //   either, but a forged request is stopped here too
  if (isAndroidId(target)) { deny(sys, by, 'alive'); return; }
  const cand = getRescueCandidates(sys).find((c) => c.peerId === target);
  if (cand && !cand.selectable) { deny(sys, by, 'alive'); return; }

  const def = defOf('rescue_drop');
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const pos = scatterOne(sys, position, seed);
  const callId = `${selfId(sys)}-r${++sys.seq}`;
  // 2026-09-11 (E-4): a squadmate's rescue drop rides the shared cooldown too — the host notes when that person
  //   may call next
  if (ctx.isMultiplayer && ctx.net?.isHost && by !== selfId(sys)) sys.callerReadyAt.set(by as PeerId, wallSeconds() + def.cooldown);
  setRescueLeft(sys, sys._rescueLeft - 1, true);
  applyGrant(sys, callId, target, by, pos, def.delay);
  const net = ctx.net;
  if (ctx.isMultiplayer && net) {
    net.send({ t: 'rescue', ev: 'grant', callId, target, by, p: toTuple(pos), eta: def.delay }, 'others');
  }
}

/** Picks one point so the pods never overlap (without `scatterPoints`, the aimed point as it is). */
function scatterOne(sys: StratagemSystem, center: THREE.Vector3, seed: number): THREE.Vector3 {
  const w = sys.world();
  if (w && typeof w.scatterPoints === 'function') {
    try {
      const pts = w.scatterPoints(center, RESCUE_SCATTER_RADIUS, 1, RESCUE_POD_MIN_GAP, seed);
      if (pts && pts.length > 0) return pts[0].clone();
    } catch { /* world lane still mid-flight — fall through to the aimed point */ }
  }
  const p = center.clone();
  if (w) p.y = w.getHeightAt(p.x, p.z);
  return p;
}

/** Host → requester: the deny. When the requester is us, it only raises the notification. */
export function deny(sys: StratagemSystem, to: string, reason: 'empty' | 'alive' | 'busy'): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (to === selfId(sys) || !ctx.isMultiplayer || !net) { showDeny(sys, reason); return; }
  net.send({ t: 'rescue', ev: 'deny', reason }, to as PeerId);
}

const DENY_KO: Readonly<Record<'empty' | 'alive' | 'busy', string>> = {
  empty: '구조선을 모두 소진했습니다',
  alive: '구조 대상이 없습니다',
  busy: '구조선을 준비 중입니다',
};

/**
 * The rescue-drop deny as the requester sees it (`empty` · `alive` — these two are rescue-drop-only circumstances
 * missing from the `strat deny` reason list, so they stay on the old `rescue deny` wire). 2026-09-11 (E-8 c): a
 * deny **refunds the cooldown in full here too** — it already started at the confirm, and "the call never stood
 * at all" means exactly what it means for `strat deny`.
 */
export function showDeny(sys: StratagemSystem, reason: 'empty' | 'alive' | 'busy'): void {
  sys.refundCooldown();
  sys.audio('ui_deny', undefined, 0.6);
  sys.ctx.bus.emit('ui:notify', { text: DENY_KO[reason], kind: 'warning', duration: 2 });
}

/** Stands the granted call up on this client (the host itself rides the same path). */
export function applyGrant(sys: StratagemSystem, callId: string, target: string, by: string, pos: THREE.Vector3, eta: number): void {
  if (sys.byId.has(callId)) return;
  const local = by === selfId(sys);
  const call = sys.createCall('rescue_drop', pos, eta, (Math.random() * 0xffffffff) >>> 0, local, callId, by as PeerId);
  call.rescueTarget = target;
  call.rescueBy = by;
  const name = getRescueCandidates(sys).find((c) => c.peerId === target)?.name ?? '분대원';
  sys.ctx.bus.emit('rescue:called', { callId, target, targetName: name, by, position: call.position, eta });
}

/* ─────────────────────────── the drop ─────────────────────────── */
/**
 * The one landing frame. There is no pod mesh (player/ draws it) — it takes the marker down and raises
 * `rescue:landed`. The revival itself is done by whoever listens to that event (player / game).
 * 2026-09-17: no dust · shake · explosion sound here — the revived player's hellpod starts falling from this
 *   moment, so it was a double impact: one 「bang」 over an empty spot and another when the pod touched down.
 *   The landing FX is the hellpod's alone (`player/Hellpod` · `RemotePods`).
 */
export function updateRescue(sys: StratagemSystem, c: Call, t: number): void {
  if (c.stage !== 'incoming') return;
  if (t < c.landsAt) return;
  c.stage = 'active';
  sys.removeMarker(c);
  sys.landed(c);
  if (c.rescueTarget) sys.ctx.bus.emit('rescue:landed', { callId: c.id, target: c.rescueTarget, position: c.position });
  sys.ended(c);
}

/* ─────────────────────────── the count left ─────────────────────────── */
/** Sets the value and raises `rescue:countChanged`. With `broadcast` the host pushes `rescue count` to the squad. */
export function setRescueLeft(sys: StratagemSystem, left: number, broadcast: boolean): void {
  const v = Math.max(0, Math.min(RESCUE_DROPS_PER_RAID, Math.round(left)));
  const changed = v !== sys._rescueLeft;
  sys._rescueLeft = v;
  if (changed) sys.ctx.bus.emit('rescue:countChanged', { left: v, total: RESCUE_DROPS_PER_RAID });
  const net = sys.ctx.net;
  if (broadcast && changed && sys.ctx.isMultiplayer && net && net.isHost) {
    net.send({ t: 'rescue', ev: 'count', left: v }, 'others');
  }
}

/** Mission reset: the squad-wide count is put back. */
export function resetRescue(sys: StratagemSystem): void {
  sys._rescueTarget = null;
  sys._rescueLeft = RESCUE_DROPS_PER_RAID;
  sys.ctx.bus.emit('rescue:countChanged', { left: RESCUE_DROPS_PER_RAID, total: RESCUE_DROPS_PER_RAID });
}

/* ─────────────────────────── net ─────────────────────────── */
/** One `rescue` message. Only the host answers `req`; everyone else receives `grant` / `deny` / `count`. */
export function onRescueMessage(sys: StratagemSystem, msg: RescueMessage, from: PeerId): void {
  const net = sys.ctx.net;
  if (msg.ev === 'req') {
    if (!net?.isHost) return;
    if (!Array.isArray(msg.p) || msg.p.length !== 3) return;
    /*
     * 2026-09-11 (E-4): the same host checks as every other ship call (`Wire.callRefusal` — member · alive · in the map ·
     * `STRAT_MAX_CALL_RANGE` · the caller's shared cooldown). A cooldown refusal answers `deny busy`; anything else is a
     * forged request and is dropped silently. The target must be a lobby member.
     */
    /*
     * 2026-09-11 (E-8 c): it used to answer `cooldown` alone with `rescue deny busy` and drop every other reason
     * silently — the requester already started the shared cooldown at the confirm (`Targeting.confirm`), so it
     * needs the reason and the **refund**. Now everything answers through the one `strat deny` path (a rescue
     * request has no `callId`, so `rescueDenyId` builds one the requester owns). The old `rescue deny` wire stays
     * as it is and `grant`'s `empty` · `alive` use it — the contract is add-only.
     */
    const why = callRefusal(sys, from, msg.p);
    if (why) {
      sys.lastCallRefusal = `rescue:${why}`;
      sendCallDeny(sys, from, rescueDenyId(from), why);
      return;
    }
    if (typeof msg.target !== 'string' || !net.lobby?.players.some((m) => m.id === msg.target)) {
      // The target may have left the lobby meanwhile — the requester already started the cooldown, so `member`
      //   gives it back.
      sys.lastCallRefusal = 'rescue:target';
      sendCallDeny(sys, from, rescueDenyId(from), 'member');
      return;
    }
    grant(sys, msg.target, new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]), from);
  } else if (net && !fromHost(net, from)) {
    // 2026-09-11 (E-4): only the host sends grant · deny · count
    return;
  } else if (msg.ev === 'grant') {
    if (!Array.isArray(msg.p) || msg.p.length !== 3) return;
    const pos = new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]);
    const w = sys.world();
    if (w) pos.y = w.getHeightAt(pos.x, pos.z);
    applyGrant(sys, msg.callId, msg.target, msg.by, pos, Number(msg.eta) || 0);
  } else if (msg.ev === 'deny') {
    showDeny(sys, msg.reason);
  } else if (msg.ev === 'count') {
    setRescueLeft(sys, Number(msg.left) || 0, false);
  }
}
