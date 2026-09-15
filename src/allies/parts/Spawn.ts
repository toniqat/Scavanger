/**
 * src/allies/parts/Spawn.ts — **레이드 진입**. 사람과 같은 자리에 **강하 포드**로 내려온다.
 *
 * 권위에서만 몸을 세운다 (솔로 · 로비 호스트). 훈련장 · 튜토리얼은 건너뛴다 — 안드로이드는 본편 레이드의 분대원이다.
 * 매 레이드 기본 킷(`ANDROID_KIT`)으로 다시 시작하고(사용자 결정), 착지 전까지는 `hidden` 이라 아무도 그리지 않는다.
 */
import { ALLY_LOCAL_PEER } from '@/shared';
import type * as THREE from 'three';
import type { AllySystem } from '../AllySystem';
import { _v1 } from '../model';
import * as Bag from './Bag';
import * as Vitals from './Vitals';
import * as Nav from './Nav';

/**
 * 강하 포드가 땅에 닿아 몸이 나오기까지 (s). `player/Hellpod.ts` 의 연출 길이(낙하 2.4 + 충격 0.35 + 문 0.55)를
 * 맞춘 **연출 동기값**이다 — 균형 수치가 아니라서 csv 가 아니라 여기 있고, 그쪽이 바뀌면 같이 바꾼다.
 */
const POD_LAND_S = 3.3;
/** 분대원끼리 겹치지 않게 벌리는 간격 (m) — 몸 지름보다 넉넉한 배치값이다. */
const SPAWN_GAP_M = 2.5;

export function onAbort(sys: AllySystem): void {
  sys.raidActive = false;
  sys.request = null;
  sys.orderKind = null;
  sys.watchUntil = -Infinity;
  sys.preferredEnemyId = null;
  sys.viewedContainers.clear();
  for (const a of sys.bodies) { a.resetSim(); a.mode = 'dormant'; a.hidden = true; }
}

/**
 * ⚠ 이 폴더는 `game:newMission` 을 **듣지 않는다**. world 가 자기 `game:newMission` 핸들러 **안에서** 동기로 월드를 만들기
 * 때문에 `world:ready` 가 뒤에 등록된 시스템의 `game:newMission` 보다 **먼저** 온다 (docs/ARCHITECTURE.md 의 gotcha).
 * 여기서 새 임무 정리까지 같이 하지 않으면, 세워 둔 몸을 그 뒤에 오는 `game:newMission` 이 곧바로 지운다.
 */
export function onWorldReady(sys: AllySystem, playerSpawn: THREE.Vector3): void {
  const ctx = sys.ctx;
  sys.viewedContainers.clear();
  sys.landAt.clear();
  sys.request = null;
  sys.requestBlockedUntil = -Infinity;
  sys.orderKind = null;
  sys.watchUntil = -Infinity;
  sys.preferredEnemyId = null;
  for (const a of sys.bodies) { a.resetSim(); a.mode = 'dormant'; a.hidden = true; }
  if (ctx.missionMode !== 'raid') { sys.raidActive = false; return; }
  sys.raidActive = true;
  if (!sys.simulating) return;                      // 리플리카는 `ally state` 를 기다린다

  let i = 0;
  for (const a of sys.bodies) {
    if (!sys.roster.some((e) => e.id === a.id)) continue;   // 잠든 슬롯 몸은 레이드에 오지 않는다
    a.mode = 'raid';
    const ang = (i / Math.max(1, sys.roster.length)) * Math.PI * 2;
    a.position.set(playerSpawn.x + Math.cos(ang) * SPAWN_GAP_M, playerSpawn.y, playerSpawn.z + Math.sin(ang) * SPAWN_GAP_M);
    Nav.snapToGround(sys, a);
    a.yaw = ang;
    Bag.equipKit(sys, a);
    Vitals.resetVitals(a);
    a.hidden = true;
    a.state = 'idle';
    a.pose = 'stand';
    // 강하 포드 — player/ 가 그리고, 착지 시각에 몸이 나온다.
    _v1.copy(a.position);
    ctx.bus.emit('ally:podDrop', { id: a.id, position: _v1, yaw: a.yaw });
    sys.sendPodDrop(a);
    sys.landAt.set(a.id, ctx.time + POD_LAND_S);
    i++;
  }
}

/** 착지 시각이 지난 기를 드러낸다 (매 프레임). */
export function updateLanding(sys: AllySystem): void {
  if (sys.landAt.size === 0) return;
  for (const [id, at] of sys.landAt) {
    if (sys.ctx.time < at) continue;
    sys.landAt.delete(id);
    const a = sys.byId.get(id);
    if (!a || a.dead) continue;
    a.hidden = false;
    Nav.snapToGround(sys, a);
  }
}

/** 이 클라이언트를 가리키는 PeerId (서버 없으면 `ALLY_LOCAL_PEER`). */
export function localPeer(sys: AllySystem): string {
  return sys.ctx.net?.localId ?? ALLY_LOCAL_PEER;
}
