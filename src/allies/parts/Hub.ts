/**
 * src/allies/parts/Hub.ts — **함선의 안드로이드**.
 *
 * 공용 함선: 조종실 슬롯(`HubRef.getAndroidBays`) 안에 잠든 몸이 서 있고, 분대장이 들이면 그 기가 캡슐 밖으로 나와
 * (`emerge`) 자기 **발사 포드 앞**(`HubRef.getPodStandPose`)까지 걸어가 대기한다(`hubIdle`). 돌려보내면 반대로
 * 걸어 들어간다(`retire` → `dormant`).
 *
 * **함선에는 와이어가 없다** — 모든 클라이언트가 같은 로비 상태에서 같은 자리를 스스로 계산한다. 함선 안의 몸은
 * 위치가 로비로부터 결정되므로 스냅샷을 주고받을 이유가 없고, 그래야 늦게 들어온 사람도 즉시 같은 그림을 본다.
 *
 * 개인 함선의 치트 안드로이드는 슬롯이 없다 (사용자 결정 「공용 함선 전용」) — PC 곁에 `ALLY_HUB_FOLLOW_M` 로 선다.
 */
import { ALLY_HUB_FOLLOW_M, ALLY_WALK_SPEED } from '@/shared';
import type { HubAndroidBay } from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import { _v1, dist2D, yawToward } from '../model';
import * as Nav from './Nav';
import * as Roster from './Roster';

/** 걸어서 「도착」으로 보는 거리 (m) — 배치값이다. */
const ARRIVE_M = 0.4;

export function onHubEntered(sys: AllySystem): void {
  Roster.syncBodies(sys);
  for (const a of sys.bodies) {
    a.resetSim();
    a.mode = Roster.isRecruited(sys, a.id) ? 'hub' : 'dormant';
    a.state = a.mode === 'hub' ? 'hubIdle' : 'dormant';
    a.pose = a.mode === 'hub' ? 'stand' : 'dormant';
    a.hidden = false;
    a.hp = a.maxHp = Math.max(1, a.maxHp);
    a.dead = false;
    a.downed = false;
    place(sys, a, true);
  }
}

export function onHubLeft(sys: AllySystem): void {
  for (const a of sys.bodies) a.hidden = true;
}

export function update(sys: AllySystem, dt: number): void {
  const ship = sys.ctx.hub?.ship ?? null;
  if (!ship) return;
  // 조종실 슬롯은 함선이 다 지어진 **뒤에** 생길 수 있다 (hub 가 짓는 순서). 빠진 슬롯이 보이면 몸을 다시 맞춘다.
  if (ship === 'shared') {
    for (const b of sys.ctx.hub?.getAndroidBays?.() ?? []) {
      if (!sys.bodies.some((x) => x.bay === b.bay)) { Roster.syncBodies(sys); break; }
    }
  }
  for (const a of sys.bodies) {
    const recruited = Roster.isRecruited(sys, a.id);
    if (ship === 'personal') { personal(sys, a, recruited, dt); continue; }
    shared(sys, a, recruited, dt);
  }
}

/* ── 공용 함선 ─────────────────────────────────────────────────────────── */

function bayOf(sys: AllySystem, a: Ally): HubAndroidBay | null {
  for (const b of sys.ctx.hub?.getAndroidBays?.() ?? []) if (b.bay === a.bay) return b;
  return null;
}

function shared(sys: AllySystem, a: Ally, recruited: boolean, dt: number): void {
  const bay = bayOf(sys, a);
  a.hidden = false;
  // 상태 전이 — 들였으면 나오고, 돌려보냈으면 들어간다.
  if (recruited && (a.state === 'dormant' || a.state === 'retire')) a.state = 'emerge';
  if (!recruited && (a.state === 'hubIdle' || a.state === 'emerge')) a.state = 'retire';
  a.mode = a.state === 'dormant' ? 'dormant' : 'hub';

  switch (a.state) {
    case 'dormant':
      if (bay) { a.position.copy(bay.position); a.yaw = bay.yaw; }
      a.pose = 'dormant';
      Nav.halt(a);
      break;
    case 'emerge': {
      a.pose = 'stand';
      const stand = sys.ctx.hub?.getPodStandPose?.(a.slot) ?? null;
      // 먼저 캡슐 밖 한 걸음, 그 다음 발사 포드 앞으로.
      const target = bay && dist2D(a.position, bay.exit) > ARRIVE_M && !leftBay(a, bay) ? bay.exit : stand?.position ?? null;
      if (!target) { a.state = 'hubIdle'; Nav.halt(a); break; }
      const left = Nav.step(sys, a, target, ALLY_WALK_SPEED, dt);
      if (left <= ARRIVE_M && (!stand || target === stand.position)) {
        a.state = 'hubIdle';
        if (stand) a.yaw = stand.yaw;
        Nav.halt(a);
      }
      break;
    }
    case 'hubIdle': {
      a.pose = 'stand';
      const stand = sys.ctx.hub?.getPodStandPose?.(a.slot) ?? null;
      if (stand && dist2D(a.position, stand.position) > ARRIVE_M) Nav.step(sys, a, stand.position, ALLY_WALK_SPEED, dt);
      else { Nav.halt(a); if (stand) a.yaw = stand.yaw; }
      break;
    }
    case 'retire': {
      a.pose = 'stand';
      if (!bay) { a.state = 'dormant'; Nav.halt(a); break; }
      const target = dist2D(a.position, bay.exit) > ARRIVE_M ? bay.exit : bay.position;
      const left = Nav.step(sys, a, target, ALLY_WALK_SPEED, dt);
      if (left <= ARRIVE_M && target === bay.position) { a.state = 'dormant'; a.yaw = bay.yaw; Nav.halt(a); }
      break;
    }
    default:
      a.state = recruited ? 'hubIdle' : 'dormant';
      break;
  }
}

/** 캡슐 밖으로 이미 나왔는가 (한 걸음 지점을 지났다). */
function leftBay(a: Ally, bay: HubAndroidBay): boolean {
  return dist2D(a.position, bay.position) > dist2D(bay.exit, bay.position);
}

/* ── 개인 함선 (치트) ───────────────────────────────────────────────────── */

function personal(sys: AllySystem, a: Ally, recruited: boolean, dt: number): void {
  if (!recruited) { a.hidden = true; return; }
  const p = sys.ctx.player;
  if (!p) { a.hidden = true; return; }
  a.hidden = false;
  a.mode = 'hub';
  a.state = 'hubIdle';
  a.pose = 'stand';
  const d = dist2D(a.position, p.position);
  if (d > ALLY_HUB_FOLLOW_M) Nav.step(sys, a, p.position, ALLY_WALK_SPEED, dt);
  else { Nav.halt(a); a.yaw = yawToward(a.position, p.position); }
}

/** 치트 안드로이드를 PC 곁에 처음 세운다. */
export function place(sys: AllySystem, a: Ally, snap: boolean): void {
  const ship = sys.ctx.hub?.ship ?? null;
  if (ship === 'shared') {
    const bay = bayOf(sys, a);
    if (bay && !Roster.isRecruited(sys, a.id)) { a.position.copy(bay.position); a.yaw = bay.yaw; return; }
    const stand = sys.ctx.hub?.getPodStandPose?.(a.slot) ?? null;
    if (stand) { a.position.copy(stand.position); a.yaw = stand.yaw; }
    else if (bay) { a.position.copy(bay.exit); a.yaw = bay.yaw; }
    return;
  }
  const p = sys.ctx.player;
  if (!p) return;
  _v1.copy(p.position);
  _v1.x += ALLY_HUB_FOLLOW_M;
  a.position.copy(_v1);
  a.yaw = yawToward(a.position, p.position);
  if (snap) Nav.snapToGround(sys, a);
}
