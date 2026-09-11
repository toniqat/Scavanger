/**
 * src/stratagems/parts/Rescue.ts — **구조선 투하**: 죽은 분대원을 다시 세우는 함선 호출.
 *
 * 흐름은 다른 호출과 다르다. 무장하면 곧바로 지면 조준으로 가지 않고 **분대원 4칸 선택 화면**
 * (`ui/hud/RescuePicker`)이 먼저 뜬다 — 그 화면이 blocker 를 들고 있는 동안 조준은 멈춰 있고,
 * `rescue:selectTarget` 으로 대상이 정해지면 그때부터 평소의 지면 링이 돌아온다.
 *
 * **잔여 횟수는 호스트가 들고 있다** (분대 공용 `RESCUE_DROPS_PER_RAID`회). 아무나 `rescue req` 를 보내고
 * 호스트가 `grant`(횟수 −1 + `world.scatterPoints` 로 착륙 지점 확정) 또는 `deny` 로 답한다. 차감은 **grant
 * 시점**이고 이후 무슨 일이 있어도 환불하지 않는다. 싱글 플레이는 자기가 호스트인 셈 치고 그대로 처리한다.
 *
 * 여기서 **헬포드는 그리지 않는다**. 원격에서 보이는 강하 포드는 `player/` 가 `pod drop` 으로 그리는 것이
 * 유일한 원본이라, 이 파일은 표적 마커 · 착륙 먼지 · 이벤트(`rescue:called` / `rescue:landed`)까지만 낸다.
 */
import * as THREE from 'three';
import {
  RESCUE_DROPS_PER_RAID, RESCUE_POD_MIN_GAP, RESCUE_SCATTER_RADIUS, STRATAGEM_HOST_ONLY,
  type PeerId, type RescueCandidate, type RescueMessage, type StratagemId,
} from '@/shared';
import { dustBurst } from '../Visuals';
import { Call, defOf, toTuple } from '../model';
import type { StratagemSystem } from '../StratagemSystem';
import { callRefusal, fromHost, rescueDenyId, sendCallDeny, wallSeconds } from './Wire';

/** Single-player id used everywhere a `PeerId` is expected but no relay exists. */
export const SOLO_ID = 'sp';

/** Our own id on the wire (`'sp'` offline). */
export function selfId(sys: StratagemSystem): string {
  return sys.ctx.net?.localId ?? SOLO_ID;
}

/* ─────────────────────────── 후보 목록 ─────────────────────────── */
/**
 * 분대원 칸. 로비가 있으면 로비 멤버가 원본(이름 · 슬롯이 확실하다), 없으면 로컬 + 원격 참조.
 * 죽었는지는 `RemotePlayerRef.isDead && !isDowned` 로 보고, `ctx.corpses` 가 이미 있다면 그 시체를 보조 근거로
 * 쓴다 (`ctx.corpses` 는 다른 폴더가 게시하므로 없을 수 있다).
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

/** 남은 횟수 > 0 이고 죽어 있는 분대원이 하나라도 있다. */
export function rescueAvailable(sys: StratagemSystem): boolean {
  if (sys._rescueLeft <= 0) return false;
  for (const c of getRescueCandidates(sys)) if (c.selectable) return true;
  return false;
}

/**
 * 무장 거부 사유 (없으면 null). 호스트 전용 호출과 구조선의 두 게이트를 한자리에 모았다 —
 * 휠에서 회색으로 그리는 판단과 실제 거부가 같은 규칙을 봐야 하기 때문이다.
 */
export function armBlockReason(sys: StratagemSystem, id: StratagemId): string | null {
  if (hostLocked(sys, id)) return '분대장만 쓸 수 있습니다';
  if (id === 'rescue_drop') {
    if (sys._rescueLeft <= 0) return '구조선을 모두 소진했습니다';
    if (!rescueAvailable(sys)) return '구조 대상이 없습니다';
  }
  return null;
}

/** 멀티에서 호스트가 아닌데 호스트 전용 호출인가 (싱글 플레이는 항상 false). */
export function hostLocked(sys: StratagemSystem, id: StratagemId): boolean {
  const ctx = sys.ctx;
  if (!ctx.isMultiplayer) return false;
  const net = ctx.net;
  if (!net) return false;
  return STRATAGEM_HOST_ONLY.includes(id) && !net.isHost;
}

/* ─────────────────────────── 선택 ─────────────────────────── */
/** `rescue:selectTarget` — 선택 화면이 고른 분대원 (null = 선택 해제 → 호출 자체를 내려놓는다). */
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

/* ─────────────────────────── 확정 → 요청 ─────────────────────────── */
/**
 * 지면 조준이 끝난 뒤의 확정. 호스트(또는 싱글)면 그 자리에서 승인하고, 아니면 `rescue req` 를 호스트에게 보낸다.
 * 쿨다운은 다른 호출과 똑같이 여기서 시작한다 — 잔여 횟수만 호스트의 승인 시점에 깎인다.
 */
export function confirmRescue(sys: StratagemSystem, target: string, position: THREE.Vector3): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!ctx.isMultiplayer || !net) { grant(sys, target, position, SOLO_ID); return; }
  if (net.isHost) { grant(sys, target, position, net.localId ?? SOLO_ID); return; }
  net.send({ t: 'rescue', ev: 'req', target, p: toTuple(position) }, 'host');
}

/**
 * 호스트 권한: 횟수를 깎고 착륙 지점을 확정한 뒤 모두에게 `rescue grant` 를 뿌린다.
 * 착륙 지점은 `world.scatterPoints` 로 뽑는다 — 그 함수가 아직 없는 트리에서는 지정 지점을 그대로 쓴다.
 */
export function grant(sys: StratagemSystem, target: string, position: THREE.Vector3, by: string): void {
  const ctx = sys.ctx;
  if (sys._rescueLeft <= 0) { deny(sys, by, 'empty'); return; }
  const cand = getRescueCandidates(sys).find((c) => c.peerId === target);
  if (cand && !cand.selectable) { deny(sys, by, 'alive'); return; }

  const def = defOf('rescue_drop');
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const pos = scatterOne(sys, position, seed);
  const callId = `${selfId(sys)}-r${++sys.seq}`;
  // 2026-09-11 (E-4): 분대원의 구조선도 공유 쿨타임을 탄다 — 호스트가 그 사람의 다음 호출 시각을 적어 둔다
  if (ctx.isMultiplayer && ctx.net?.isHost && by !== selfId(sys)) sys.callerReadyAt.set(by as PeerId, wallSeconds() + def.cooldown);
  setRescueLeft(sys, sys._rescueLeft - 1, true);
  applyGrant(sys, callId, target, by, pos, def.delay);
  const net = ctx.net;
  if (ctx.isMultiplayer && net) {
    net.send({ t: 'rescue', ev: 'grant', callId, target, by, p: toTuple(pos), eta: def.delay }, 'others');
  }
}

/** 포드가 서로 겹치지 않게 한 지점을 고른다 (`scatterPoints` 가 없으면 지정 지점 그대로). */
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

/** 호스트 → 요청자: 거절. 요청자가 우리 자신이면 그냥 알림만 띄운다. */
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
 * 요청자에게 보이는 구조선 거절 (`empty` · `alive` — 이 둘은 `strat deny` 의 사유 목록에 없는 구조선만의 사정이라
 * 옛 `rescue deny` 와이어에 그대로 남아 있다). 2026-09-11 (E-8 c): 거절이면 **여기서도 쿨타임을 전액 환불한다** —
 * 확정 때 이미 돌아 버린 값이고, 호출이 아예 서지 않았다는 뜻은 `strat deny` 와 똑같다.
 */
export function showDeny(sys: StratagemSystem, reason: 'empty' | 'alive' | 'busy'): void {
  sys.refundCooldown();
  sys.audio('ui_deny', undefined, 0.6);
  sys.ctx.bus.emit('ui:notify', { text: DENY_KO[reason], kind: 'warning', duration: 2 });
}

/** 승인된 호출을 이 클라이언트에 세운다 (호스트 자신도 같은 경로를 탄다). */
export function applyGrant(sys: StratagemSystem, callId: string, target: string, by: string, pos: THREE.Vector3, eta: number): void {
  if (sys.byId.has(callId)) return;
  const local = by === selfId(sys);
  const call = sys.createCall('rescue_drop', pos, eta, (Math.random() * 0xffffffff) >>> 0, local, callId, by as PeerId);
  call.rescueTarget = target;
  call.rescueBy = by;
  const name = getRescueCandidates(sys).find((c) => c.peerId === target)?.name ?? '분대원';
  sys.ctx.bus.emit('rescue:called', { callId, target, targetName: name, by, position: call.position, eta });
}

/* ─────────────────────────── 강하 ─────────────────────────── */
/**
 * 착륙 한 프레임. 포드 메시는 없다 (player/ 가 그린다) — 마커를 걷고 착륙 먼지 · 흔들림만 남긴 뒤
 * `rescue:landed` 를 낸다. 부활 자체는 그 이벤트를 듣는 쪽(player / game)이 한다.
 */
export function updateRescue(sys: StratagemSystem, c: Call, t: number): void {
  if (c.stage !== 'incoming') return;
  if (t < c.landsAt) return;
  c.stage = 'active';
  sys.removeMarker(c);
  sys.burst(dustBurst(c.position, c.def.radius));
  sys.shakeFrom(c.position, 0.5);
  sys.audio('explosion', c.position, 0.45);
  sys.landed(c);
  if (c.rescueTarget) sys.ctx.bus.emit('rescue:landed', { callId: c.id, target: c.rescueTarget, position: c.position });
  sys.ended(c);
}

/* ─────────────────────────── 잔여 횟수 ─────────────────────────── */
/** 값을 세우고 `rescue:countChanged` 를 낸다. `broadcast` 면 호스트가 `rescue count` 로 분대에 뿌린다. */
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

/** 미션 리셋: 분대 공용 횟수를 되돌린다. */
export function resetRescue(sys: StratagemSystem): void {
  sys._rescueTarget = null;
  sys._rescueLeft = RESCUE_DROPS_PER_RAID;
  sys.ctx.bus.emit('rescue:countChanged', { left: RESCUE_DROPS_PER_RAID, total: RESCUE_DROPS_PER_RAID });
}

/* ─────────────────────────── 네트워크 ─────────────────────────── */
/** `rescue` 메시지 하나. 호스트만 `req` 에 답하고, 나머지는 `grant` / `deny` / `count` 를 받는다. */
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
     * 2026-09-11 (E-8 c): 예전에는 `cooldown` 하나만 `rescue deny busy` 로 알리고 나머지 사유는 조용히 버렸다 —
     * 요청자는 확정 때 이미 공유 쿨타임을 돌렸으므로(`Targeting.confirm`) 사유와 **환불**이 필요하다. 이제 전부
     * `strat deny` 한 경로로 답한다(구조선 요청에는 `callId` 가 없어 `rescueDenyId` 가 요청자 소유의 id 를 만든다).
     * 기존 `rescue deny` 와이어는 그대로 남아 `grant` 의 `empty` · `alive` 가 쓴다 — 계약은 추가만 한다.
     */
    const why = callRefusal(sys, from, msg.p);
    if (why) {
      sys.lastCallRefusal = `rescue:${why}`;
      sendCallDeny(sys, from, rescueDenyId(from), why);
      return;
    }
    if (typeof msg.target !== 'string' || !net.lobby?.players.some((m) => m.id === msg.target)) {
      // 대상이 그 사이 로비를 떠났을 수 있다 — 요청자는 이미 쿨타임을 돌렸으므로 `member` 로 환불시킨다.
      sys.lastCallRefusal = 'rescue:target';
      sendCallDeny(sys, from, rescueDenyId(from), 'member');
      return;
    }
    grant(sys, msg.target, new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]), from);
  } else if (net && !fromHost(net, from)) {
    // 2026-09-11 (E-4): grant · deny · count 는 호스트만 보낸다
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
