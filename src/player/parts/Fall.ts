/**
 * src/player/parts/Fall.ts — **낙하 피해** (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」, 사용자 결정).
 *
 * 이 파일이 답하는 질문: *떨어져서 착지했을 때 얼마나 아픈가.*
 *
 * **튜토리얼 전용이 아니라 게임 전역 기능이다.** 높이를 재는 곳은 `PlayerController`(`MoveResult.fallHeight` —
 * 낙하가 시작된 높이와 착지 높이의 차, 면제된 낙하는 0)이고, 그 높이를 피해로 바꾸는 곳이 여기 하나다.
 *
 *   피해 = min(`FALL_DAMAGE_MAX`, (높이 − `FALL_DAMAGE_SAFE_M`) × `FALL_DAMAGE_PER_M`)
 *
 * 수치는 전부 `data/constants.csv` 에 있다. 피해는 **새 경로를 만들지 않고** `applyDamage` 를 그대로 타므로
 * 피격 연출 · 인내(grit) · 전투불능 규칙이 평소와 한 글자도 다르지 않다 — 다만 **실드는 건너뛴다** (아래 `onLanded`,
 * 2026-09-16 사용자 결정: 모든 낙하 피해는 체력으로 곧장 간다).
 *
 * 자리마다 규칙이 다른 곳은 튜토리얼 월드뿐이다 — `ctx.world.tutorial?.fallRule(착지 자리)`:
 *   `kill`   즉사 (절벽 1 — 넘지 못하면 체크포인트로 돌아간다)
 *   `clamp`  피해는 들어가되 체력이 1 밑으로 내려가지 않는다 (절벽 2 — 반드시 살아서 착지한다)
 *   `normal` 위 식 그대로 (`ctx.world.tutorial` 이 null 인 본편은 늘 이쪽이다)
 *
 * 피해가 실제로 들어갔을 때만 `player:fell {height, damage, rule}` 을 낸다 (튜토리얼 단계 · HUD · 오디오가 읽는다).
 *
 * 2026-09-15 (TODO B-14, 사용자 결정 「착지음 + 흔들림 + HUD 비네트 + 분대원도 듣는다」) — 같은 자리에서
 *   ① `camera:shake {min(FALL_SHAKE_MAX, 피해 × FALL_SHAKE_PER_DAMAGE), FALL_SHAKE_S}` (받는 곳은 `PlayerSystem.init` 의
 *      `rig.addShake` — 드론 시점 · 탐사 차량 궤도 카메라는 늘 그렇듯 무시한다),
 *   ② 멀티면 `fall {p: 발, d: 피해}` 를 `others` 로 보낸다. 착지음은 audio 가, 비네트는 ui 가 `player:fell` 로 낸다.
 * 받는 쪽은 `receiveRemoteFall` — 네 겹(모양 · 보낸 사람 · 거리 · 요율)을 지난 것만 `player:remoteFell` 로 다시 낸다.
 */
import * as THREE from 'three';
import {
  FALL_DAMAGE_MAX, FALL_DAMAGE_PER_M, FALL_DAMAGE_SAFE_M, FALL_REMOTE_SOUND_RANGE, FALL_SHAKE_MAX, FALL_SHAKE_PER_DAMAGE,
  FALL_SHAKE_S, GRAVITY, type FallMessage, type GameContext, type PeerId, type TutorialFallRule,
} from '@/shared';
import type { PlayerSystem } from '../PlayerSystem';
import type { PlayerDamageOptions, PlayerDamageSource } from '@/shared';

/** 2026-09-15 (결과 창 개편): 낙하 피해의 출처 — 하나를 돌려 쓴다. */
const FALL_DAMAGE_SOURCE: PlayerDamageSource = Object.freeze({ kind: 'fall' });
/** 2026-09-16 (사용자 결정): 낙하 피해는 실드를 건너뛴다 — `onLanded` 의 주석. 하나를 돌려 쓴다. */
const FALL_DAMAGE_OPTS: PlayerDamageOptions = Object.freeze({ bypassShield: true });

/** 순수 식: `height` m 를 떨어졌을 때의 기본 피해 (안전 높이 이하면 0). 스모크 · 콘솔이 같이 쓴다. */
export function fallDamageFor(height: number): number {
  if (!Number.isFinite(height) || height <= FALL_DAMAGE_SAFE_M) return 0;
  return Math.min(FALL_DAMAGE_MAX, (height - FALL_DAMAGE_SAFE_M) * FALL_DAMAGE_PER_M);
}

/**
 * 몸이 이번에 **피해를 받을 수 있는 상태로 땅에 닿았나.** 컨트롤러가 이미 거른 것(갈고리 · 부양 · 차량 발판 ·
 * 사다리 · 함선 실내)과 별개로, 몸이 아예 「떨어질 수 없는」 상태였던 경우를 여기서 한 번 더 막는다 —
 * 탑승자는 어떤 피해도 받지 않는다는 규칙(탐사 차량)이 여기에도 그대로 걸린다.
 */
function canTakeFall(sys: PlayerSystem): boolean {
  if (!sys.spawned || sys.isDead || sys._downed) return false;
  if (sys._roverRide) return false;              // 2026-09-13: 탐사 차량 탑승자는 어떤 피해도 받지 않는다
  if (sys._droneControl) return false;           // 2026-09-11: 몸은 앉아 있다 — 떨어진 것은 드론이다
  if (sys._inPod || sys.isDropping) return false;// 헬포드 강하 착지 · 발사 포드
  if (sys.controller.climbing) return false;     // 사다리
  if (sys._interior !== null || sys.shipBounds !== null) return false;   // 함선 실내 · 탈출선 화물칸
  if (sys.carriedSocket !== null || sys.attachedParent !== null) return false;
  if (sys.introWaking) return false;             // 오프닝 기상 연출 중
  if (!sys.ctx.isGameplayPhase()) return false;  // 함선(허브) · 결과 화면에서는 떨어져도 아프지 않다
  return true;
}

/**
 * `MoveResult.fallHeight > 0` 인 프레임에 `PlayerSystem.update` 가 부른다. 튜토리얼 규칙까지 적용하고
 * 실제로 깎인 만큼을 `player:fell` 로 알린다.
 */
export function onLanded(sys: PlayerSystem, height: number): void {
  if (!(height > 0) || !canTakeFall(sys)) return;
  const ctx = sys.ctx;
  let rule: TutorialFallRule = 'normal';
  try { rule = ctx.world?.tutorial?.fallRule(sys.controller.position) ?? 'normal'; } catch { rule = 'normal'; }

  // 2026-09-16: 낙하는 체력만 깎으므로 「얼마나 아팠나」도 체력만 센다 — 치사 낙하에서 `die()` 가 비우는 실드(`clearShield`)가
  //   `player:fell.damage` · `fall` 와이어에 섞이지 않게
  const before = sys.hp;
  if (rule === 'kill') {
    // 절벽 1: 높이와 무관하게 즉사 — 시체 · 체크포인트 흐름은 game/ 이 평소대로 맡는다
    if (before <= 0) return;
    sys.hp = 0;
    sys._deathSource = FALL_DAMAGE_SOURCE;   // 2026-09-15 (결과 창 개편): 사망 원인 = 낙하
    sys.die();
    emitFell(sys, height, before, rule);
    return;
  }

  let damage = fallDamageFor(height);
  if (damage <= 0) return;
  if (rule === 'clamp') {
    // 절벽 2: 체력 1 은 남긴다. 낙하 피해는 실드를 건너뛰므로(아래) 「체력 − 1」 이 곧 상한이다.
    damage = Math.min(damage, Math.max(0, sys.hp - 1));
    if (damage <= 0) return;
  }
  /*
   * 2026-09-16 (사용자 결정 — 「모든 낙하 피해는 체력으로 곧장」): 방탄복 실드는 **낙하를 막지 않는다** (`bypassShield` —
   * 실드도 방탄복 내구도도 그대로다). 이유: 떨어져서 다리가 부러지는 것을 가슴판 실드가 막는 것이 이상하고, 튜토리얼에서
   * 붕대 단계 직전의 낙하가 실드에 다 먹혀 체력이 가득 찬 채로 「치료」 단계가 조용히 지나갔다. 이 줄의 규칙은 본편 ·
   * 튜토리얼(`normal` · `clamp`) 전부에 같다. 출처(`fall`) · 인내 · 전투불능 · 사망 · `player:fell` · 흔들림 · 와이어는
   * 그대로다 — `emitFell` 이 세는 값은 깎인 체력이다.
   */
  sys.applyDamage(damage, undefined, false, FALL_DAMAGE_SOURCE, FALL_DAMAGE_OPTS);   // 2026-09-15: 출처 `fall` (`player:damaged.source` · 사망 원인)
  emitFell(sys, height, before, rule);
}

/** 실제로 깎인 체력을 세어 `player:fell` 을 낸다 (`before` = 착지 직전 체력). 0 이면 아무것도 내지 않는다 (무적 시간 등). */
function emitFell(sys: PlayerSystem, height: number, before: number, rule: TutorialFallRule): void {
  const dealt = Math.max(0, before - sys.hp);
  if (dealt <= 0) return;
  const ctx = sys.ctx;
  ctx.bus.emit('player:fell', { height, damage: dealt, rule });
  // 2026-09-15 (B-14): 흔들림 — 피해에 비례, 상한 FALL_SHAKE_MAX (`PlayerSystem` 이 `camera:shake` 를 rig 에 넘긴다)
  ctx.bus.emit('camera:shake', { intensity: fallShakeFor(dealt), duration: FALL_SHAKE_S });
  // 2026-09-15 (B-14): 분대원이 착지음을 듣는다 — 소리 전용, 체력 · 실드는 이미 스냅샷이 싣는다
  if (ctx.isMultiplayer && ctx.net) {
    const p = sys.controller.position;
    ctx.net.send({ t: 'fall', p: [p.x, p.y, p.z], d: dealt }, 'others');
  }
}

/** 순수 식: 실제로 깎인 `damage` 에 대한 `camera:shake` 세기 (스모크가 같이 쓴다). */
export function fallShakeFor(damage: number): number {
  if (!(damage > 0)) return 0;
  return Math.min(FALL_SHAKE_MAX, damage * FALL_SHAKE_PER_DAMAGE);
}

/**
 * 같은 분대원의 두 `fall` 사이 최소 간격(초) — 코드에 적은 수치가 아니라 **데이터에서 유도한다**: 피해를 주는 낙하는
 * 적어도 `FALL_DAMAGE_SAFE_M` 를 자유낙하해야 하므로 두 번의 착지는 정지 상태에서 그 높이를 떨어지는 시간보다 가까울 수 없다.
 */
export const REMOTE_FALL_MIN_INTERVAL_S = Math.sqrt((2 * Math.max(0, FALL_DAMAGE_SAFE_M)) / Math.max(1e-3, GRAVITY));

/** `receiveRemoteFall` 이 거절한 사유 (스모크 · 디버그). `null` = 받아들여 `player:remoteFell` 을 냈다. */
export type RemoteFallReject = 'shape' | 'self' | 'member' | 'phase' | 'range' | 'damage' | 'rate';

/**
 * 2026-09-15 (B-14) — 분대원의 `fall` 수신 (`RemotePlayerSystem` 이 `net.onMessage('fall')` 로 부른다).
 * CLAUDE.md 「호스트가 받는 요청은 모양 · 보낸 사람 · 거리 · 요율 네 겹을 지난다」 순서 그대로:
 *   모양    `p` 는 유한한 수 셋, `d` 는 유한한 수 → `[0, FALL_DAMAGE_MAX]` 로 자르고 0 이면 버린다(들을 것이 없다)
 *   보낸 사람 나 자신이 아니고 지금 로비 멤버 (`net.getLobbyPlayer`), 그리고 이 클라이언트가 레이드 게임플레이 중
 *   거리    로컬 카메라(= 오디오 청취자)에서 `FALL_REMOTE_SOUND_RANGE` 안
 *   요율    같은 사람의 직전 수락에서 `REMOTE_FALL_MIN_INTERVAL_S` 이상 (`lastAt` 은 호출자가 들고, 실시간 초)
 * 통과하면 `player:remoteFell {peerId, position, damage}` — 위치 벡터는 메시지마다 하나 새로 만든다(받는 쪽이 들고 있어도 된다).
 */
export function receiveRemoteFall(
  ctx: GameContext, msg: FallMessage, from: PeerId, lastAt: Map<PeerId, number>, nowS: number,
): RemoteFallReject | null {
  if (!msg || typeof msg !== 'object' || !Array.isArray(msg.p) || msg.p.length !== 3) return 'shape';
  const x = msg.p[0], y = msg.p[1], z = msg.p[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || typeof msg.d !== 'number' || !Number.isFinite(msg.d)) return 'shape';
  const net = ctx.net;
  if (!net || typeof from !== 'string' || !from) return 'member';
  if (from === net.localId) return 'self';
  if (!net.getLobbyPlayer(from)) return 'member';
  if (!ctx.isGameplayPhase()) return 'phase';
  const cam = ctx.camera.position;
  const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
  if (dx * dx + dy * dy + dz * dz > FALL_REMOTE_SOUND_RANGE * FALL_REMOTE_SOUND_RANGE) return 'range';
  const damage = Math.min(FALL_DAMAGE_MAX, Math.max(0, msg.d));
  if (!(damage > 0)) return 'damage';
  const prev = lastAt.get(from);
  if (prev !== undefined && nowS - prev < REMOTE_FALL_MIN_INTERVAL_S) return 'rate';
  lastAt.set(from, nowS);
  ctx.bus.emit('player:remoteFell', { peerId: from, position: new THREE.Vector3(x, y, z), damage });
  return null;
}
