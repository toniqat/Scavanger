/**
 * src/allies/parts/Commands.ts — **명령**. 새 입력은 하나도 없다 (사용자 결정): 핑(`ping:placedV3`) ·
 * 의사소통 휠(`comms:sent`) · 인벤토리 요청(`inventory:itemRequested`, 원격은 `allyq item`)을 듣는다.
 *
 * 두 갈래다.
 *  - **명령** (이동 `attack` · 주의 `caution` · 앞장 `lead`): **분대장 것만** 따른다. 분대 전체가 같이 움직인다.
 *  - **요청** (회복 · 실드 · 탄약 · 아이템 · 상자 · 탈출 · 계약): 누구나 보낼 수 있고 **먼저 온 하나**만 받는다.
 *    그 뒤 `ALLY_REQUEST_COOLDOWN_S` 동안은 다른 요청을 무시한다 (분대 공용). 할 수 있는 가장 가까운 기가 맡고,
 *    아무도 못 하면 가장 가까운 기가 한 줄 말한다.
 */
import * as THREE from 'three';
import {
  ALLY_LEAD_AHEAD_M, ALLY_LEAD_DURATION_S, ALLY_MOVE_ARRIVE_M, ALLY_MOVE_HOLD_S, ALLY_REQUEST_COOLDOWN_S,
  ALLY_RUN_SPEED, ALLY_SPREAD_M, ALLY_WALK_SPEED, ALLY_WATCH_S, isAndroidId,
} from '@/shared';
import type { CommsId, EnemyRef, ItemRequestKind, PeerId, PingKind } from '@/shared';
import { shieldChargeOf, boostItemOf, AMMO_LABEL_KO } from '@/items';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import type { Proposal } from './Fsm';
import { CHAT_KO, PRIO, _v1, _v2, dist2D, forwardOf } from '../model';
import type { AllyRequestKind } from '../model';
import * as Nav from './Nav';
import * as Ping from './Ping';
import * as Bag from './Bag';
import * as Harness from './Harness';

/** 주의 핑 자리에 이보다 가까이 가지 않는다 (m) — 「해당 위치로 가려고 하지 않음」. */
const WATCH_KEEP_OUT_M = 6;
/** 사람의 탈출구 핑을 패드에 맞추는 창 (m) — 거리 제한이 아니라 「그 핑이 이 패드를 가리키는가」의 판정 창이다 (배치값). */
const PING_PAD_MATCH_M = 20;

/* ═══════════════════════════ 입력 ═══════════════════════════ */

export function onPing(
  sys: AllySystem,
  e: { position: THREE.Vector3; kind: PingKind; owner: PeerId | null; label?: string; enemyId?: number },
): void {
  if (isAndroidId(e.owner)) return;                 // 자기(또는 동료)가 찍은 핑은 명령이 아니다
  const by = e.owner ?? (sys.ctx.net?.localId ?? 'local');
  const fromLeader = by === sys.leaderId;
  switch (e.kind) {
    case 'attack':
      if (fromLeader) {
        sys.orderKind = 'moveTo';
        sys.orderPos.copy(e.position);
        sys.orderUntil = Infinity;
        // 이 명령을 **아직 끝내지 않았다**는 표시를 기마다 세운다 — 도착해서 머문 뒤에야 0 이 된다.
        // (없으면 `moveTo` 첫 프레임이 곧바로 「머무름 끝」으로 읽혀 따라가기 ↔ 이동을 오간다 — `proposal` 참고.)
        for (const a of sys.bodies) a.moveHoldT = ALLY_MOVE_HOLD_S;
        cancelExtractEscort(sys);                   // 새 이동 명령이 이긴다 (탈출구 동행 해제)
      }
      break;
    case 'caution':
      if (fromLeader) { sys.watchPos.copy(e.position); sys.watchUntil = sys.ctx.time + ALLY_WATCH_S; }
      break;
    case 'enemy':
      // 2026-09-16 사용자 결정 「PC 가 적 핑을 찍으면」 — **사람이면 누구든** 따른다 (분대장 전용이 아니다).
      if (typeof e.enemyId === 'number') onEnemyPing(sys, e.enemyId, e.position);
      break;
    case 'extraction':
      // 2026-09-16 사용자 결정 — 사람이 찍은 탈출구를 기억해 둔다. 그 사람이 「탈출하고 싶다」면 거기로 간다.
      if (sys.raidActive && sys.simulating) {
        sys.humanExtractPos.copy(e.position);
        sys.humanExtractBy = by;
        sys.humanExtractAt = sys.ctx.time;
        sys.hasHumanExtractPing = true;
      }
      break;
    case 'crate':
      request(sys, 'crate', by, e.position, { targetId: e.label ?? null });
      break;
    case 'item':
      request(sys, 'item', by, e.position, {});
      break;
    default:
      break;
  }
}

/* ── 적 핑: 동의하고 요격한다 (2026-09-16) ─────────────────────────────── */

/**
 * 사람이 찍은 적 핑을 받아들인다. 지목은 `parts/Combat` 이 읽고, 해제는 `tickEnemyPing` 이 한다:
 * **죽었다 · 아무도 `ALLY_WATCH_S` 동안 못 봤다 · 더 새로운 핑이 왔다** 중 하나 (분대를 영원히 묶어 두지 않는다).
 */
function onEnemyPing(sys: AllySystem, enemyId: number, at: THREE.Vector3): void {
  if (!sys.raidActive || !sys.simulating) return;   // 판단은 권위에서만 (리플리카가 대사를 내보내면 두 번 말한다)
  /* 2026-09-18 (벌레 알): 알을 가리킨 핑에는 동의하지 않는다. 교전은 **맞서 싸우는 것**을 상대로만 한다 —
     알은 움직이지도 쏘지도 않으므로 「저것을 쏴라」 가 성립하지 않고, 분대가 둥지 앞에서 탄을 쏟게 만든다.
     세포가 필요하면 사람이 직접 쏜다. (`ui/hud/Pings` 가 이미 알에 핑을 붙이지 않으므로 여기는 옛 핑 · 조작된
     id 에 대한 보험이다.) */
  if (isEggId(sys, enemyId)) return;
  sys.preferredEnemyId = enemyId;
  sys.preferredEnemyPos.copy(at);
  sys.preferredEnemyUntil = sys.ctx.time + ALLY_WATCH_S;
  const who = nearestBody(sys, at);
  if (who) Ping.say(sys, who, CHAT_KO.agreeEnemy);   // 같은 문장의 반복은 `Ping.say` 가 막는다
}

/** 지목을 푼다. */
function clearEnemyPing(sys: AllySystem): void {
  sys.preferredEnemyId = null;
  sys.preferredEnemyUntil = -Infinity;
}

/** 지목된 적을 매 프레임 한 번만 확인한다 (`AllySystem.update` — 기마다 훑으면 배열이 계속 생긴다). */
export function tickEnemyPing(sys: AllySystem): void {
  if (sys.preferredEnemyId === null) return;
  const now = sys.ctx.time;
  let found: EnemyRef | null = null;
  for (const e of sys.ctx.enemies?.getEnemies() ?? []) {
    if (e.id === sys.preferredEnemyId) { found = e; break; }
  }
  // 2026-09-18: 죽었거나 · 사라졌거나 · 알이다 (알은 애초에 지목되지 않지만, 지목이 살아남는 유일한 자리라 여기서도 본다)
  if (!found || found.isDead || found.isEgg) { clearEnemyPing(sys); return; }
  sys.preferredEnemyPos.copy(found.position);
  // 창을 미는 것은 **실제로 사선에 넣은** 기뿐이다 (`parts/Combat.proposal`) — 벽 너머에 두고 서성이면 풀린다.
  if (now >= sys.preferredEnemyUntil) clearEnemyPing(sys);
}

/** 그 id 가 벌레 알인가 (`EnemyRef.isEgg` — 모르는 id 는 아니다). */
function isEggId(sys: AllySystem, enemyId: number): boolean {
  for (const e of sys.ctx.enemies?.getEnemies() ?? []) if (e.id === enemyId) return e.isEgg === true;
  return false;
}

/** `at` 에 가장 가까운, 지금 레이드에서 움직일 수 있는 한 기 (한 마디는 한 기만 한다). */
function nearestBody(sys: AllySystem, at: THREE.Vector3): Ally | null {
  let best: Ally | null = null;
  let bestD = Infinity;
  for (const a of sys.bodies) {
    if (a.mode !== 'raid' || a.dead || a.downed || a.hidden) continue;
    const d = dist2D(a.position, at);
    if (d < bestD) { best = a; bestD = d; }
  }
  return best;
}

export function onComms(sys: AllySystem, e: { id: CommsId; by: string | null; position: THREE.Vector3 | null; text: string }): void {
  const by = e.by ?? (sys.ctx.net?.localId ?? 'local');
  if (isAndroidId(by)) return;
  const at = e.position ?? sys.leaderPos;
  switch (e.id) {
    case 'need_heal':
      request(sys, 'heal', by, at, {});
      break;
    case 'extract':
      onExtractComms(sys, by, at);
      break;
    case 'contract':
      request(sys, 'contract', by, at, { text: e.text });
      break;
    case 'lead':
      if (by === sys.leaderId) onLead(sys);
      break;
    default:
      break;
  }
}

/** 로컬 플레이어의 인벤토리 요청 (가운데 클릭 · 메뉴). */
export function onItemRequest(
  sys: AllySystem,
  e: { kind: ItemRequestKind; defId: string | null; ammoType: string | null; position: THREE.Vector3 },
): void {
  const by = sys.ctx.net?.localId ?? 'local';
  request(sys, e.kind, by, e.position, { defId: e.defId, ammoType: e.ammoType });
}

/** 원격 분대원의 인벤토리 요청 (`allyq item`, 호스트에서만 도착한다). */
export function onRemoteItemRequest(
  sys: AllySystem, from: PeerId,
  e: { kind: ItemRequestKind; defId?: string; ammoType?: string; p: [number, number, number] },
): void {
  _v1.set(e.p[0], e.p[1], e.p[2]);
  request(sys, e.kind, from, _v1, { defId: e.defId ?? null, ammoType: e.ammoType ?? null });
}

export function onContainerViewed(sys: AllySystem, containerId: string): void {
  sys.viewedContainers.add(containerId);
  for (const a of sys.bodies) if (a.lootContainerId === containerId) a.lootContainerId = null;
}

/**
 * 「탈출하고 싶다」 — 순서가 곧 규칙이다.
 *  ① 확인 창(`ALLY_EXTRACT_CONFIRM_S`)이 열려 있으면 **호출 버튼을 누른다** (`parts/Extract`). 안드로이드가 스스로
 *     찍은 핑이든, 아래 ②로 PC 의 탈출구 핑에 동의한 것이든 같은 창을 쓴다.
 *  ② 사람이 찍어 둔 탈출구 핑이 있으면 **분대 전체가 동의하고 그 자리로** 간다 (2026-09-16 사용자 결정).
 *  ③ 아무것도 없으면 예전대로 「탈출」 요청 — 가장 가까운 한 기가 하네스 안에서 패드를 찾아 핑을 찍는다.
 */
function onExtractComms(sys: AllySystem, by: PeerId, at: THREE.Vector3): void {
  for (const a of sys.bodies) {
    if (a.extractRequester === by && a.extractPadId && sys.ctx.time - a.extractPingAt <= sys.extractConfirmWindow) {
      a.taskKind = 'extract';
      a.taskBy = by;
      a.confirmExtract = true;
      return;
    }
  }
  if (agreeToHumanExtract(sys, by)) return;
  request(sys, 'extract', by, at, {});
}

/**
 * PC 가 찍은 탈출구 핑에 동의한다 — 분대 전체가 「PC 하네스 범위 내에서 해당 탈출구를 향해」 움직인다
 * (`parts/Extract.seek` 가 `hasExtractPing` 을 보고 하네스로 잘라 걸어간다). 동의했으면 true.
 * 그 자리의 패드를 같이 걸어 두므로, 같은 사람이 확인 창 안에 한 번 더 말하면 위 ①이 콘솔을 누른다.
 */
function agreeToHumanExtract(sys: AllySystem, by: PeerId): boolean {
  if (!sys.hasHumanExtractPing || !sys.raidActive || !sys.simulating) return false;
  const padId = padNearPing(sys);
  let any = false;
  for (const a of sys.bodies) {
    if (a.mode !== 'raid' || a.dead || a.hidden) continue;
    a.extractPingPos.copy(sys.humanExtractPos);
    a.hasExtractPing = true;
    a.taskKind = 'extract';
    a.taskBy = by;
    a.taskAt.copy(sys.humanExtractPos);
    a.extractRequester = by;
    a.extractPingAt = sys.ctx.time;
    if (padId) a.extractPadId = padId;
    a.confirmExtract = false;
    a.oneShot = false;
    any = true;
  }
  if (!any) return false;
  const who = nearestBody(sys, sys.humanExtractPos);
  if (who) Ping.say(sys, who, CHAT_KO.agreeExtract);
  return true;
}

/** 사람이 찍은 탈출구 핑에 가장 가까운 패드의 id (그 핑이 패드를 가리키지 않으면 null). */
function padNearPing(sys: AllySystem): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const p of sys.ctx.extraction?.getPads?.() ?? []) {
    const d = dist2D(p.position, sys.humanExtractPos);
    if (d < bestD) { best = p.id; bestD = d; }
  }
  return bestD <= PING_PAD_MATCH_M ? best : null;
}

/**
 * 탈출구 **동행만** 푼다 (새 이동 명령이 이긴다). 사람이 찍어 둔 핑 자체(`sys.humanExtractPos`)는 남긴다 —
 * 기억은 레이드가 끝날 때만 지워지고(`AllySystem.clearPingOrders`), 다시 「탈출하고 싶다」면 또 동의한다.
 */
function cancelExtractEscort(sys: AllySystem): void {
  for (const a of sys.bodies) {
    if (!a.hasExtractPing) continue;
    a.hasExtractPing = false;
    if (a.taskKind === 'extract' && !a.confirmExtract) finishTask(sys, a);
  }
}

/**
 * 「앞장서라」 (2026-09-16 사용자 결정 「일반 범위의 2배로 각자 일대를 수색, 일정 시간 뒤 자동 해제」).
 *  - 하네스가 `ALLY_LEAD_HARNESS_MUL` 배로 넓어진다 (`parts/Harness.update` 가 `sys.leadUntil` 을 읽는다 — 따라가기 ·
 *    자유 탐색 · 엄폐 · 탈출 모두 같은 반경을 본다).
 *  - 기마다 **자기 구역**으로 앞서 나간다 (`leadSpot` — 한 점에 겹치지 않게 `ALLY_SPREAD_M` 씩 벌린다). 도착하면 명령이
 *    끝나고 넓어진 하네스 안에서 `roam`(자유 탐색)이 일대를 훑는다.
 *  - `ALLY_LEAD_DURATION_S` 가 지나면 저절로 풀린다. 그 전에 온 다른 명령(가자 · 주의 · 다른 한 마디)이 이긴다.
 */
function onLead(sys: AllySystem): void {
  if (!sys.raidActive) return;      // 하네스를 넓히는 명령이다 — 레이드 밖에서는 의미가 없다
  forwardOf(leaderYaw(sys), _v1);
  sys.orderKind = 'lead';
  sys.orderPos.copy(sys.leaderPos).addScaledVector(_v1, ALLY_LEAD_AHEAD_M);
  sys.orderUntil = sys.ctx.time + ALLY_LEAD_DURATION_S;
  sys.leadUntil = sys.ctx.time + ALLY_LEAD_DURATION_S;
  cancelExtractEscort(sys);
}

/* ═══════════════════════════ 요청 ═══════════════════════════ */

function request(
  sys: AllySystem, kind: AllyRequestKind, by: PeerId, at: THREE.Vector3,
  opts: { defId?: string | null; ammoType?: string | null; targetId?: string | null; text?: string },
): void {
  if (!sys.raidActive || !sys.simulating) return;
  if (sys.ctx.time < sys.requestBlockedUntil) return;     // 선착순 — 그동안 온 요청은 버린다
  sys.request = {
    kind, by, at: at.clone(), defId: opts.defId ?? null, ammoType: opts.ammoType ?? null,
    targetId: opts.targetId ?? null, time: sys.ctx.time, claimedBy: null,
  };
  sys.requestText = opts.text ?? '';
  sys.requestBlockedUntil = sys.ctx.time + ALLY_REQUEST_COOLDOWN_S;
}

/** 아직 아무도 맡지 않은 요청을 **할 수 있는 가장 가까운 기**에게 붙인다. 아무도 못 하면 한 줄 말하고 버린다. */
export function tickRequest(sys: AllySystem): void {
  const req = sys.request;
  if (!req || req.claimedBy) return;
  let best: Ally | null = null;
  let bestD = Infinity;
  let nearest: Ally | null = null;
  let nearestD = Infinity;
  for (const a of sys.bodies) {
    if (a.mode !== 'raid' || a.dead || a.downed || a.hidden) continue;
    const d = dist2D(a.position, req.at);
    if (d < nearestD) { nearest = a; nearestD = d; }
    if (!canFulfil(sys, a, req.kind, req.defId, req.ammoType)) continue;
    if (d < bestD) { best = a; bestD = d; }
  }
  if (best) {
    req.claimedBy = best.id;
    best.taskKind = req.kind;
    best.taskBy = req.by;
    best.taskAt.copy(req.at);
    best.taskDefId = req.defId;
    best.taskAmmoType = req.ammoType;
    best.taskTargetId = req.targetId;
    best.deliverUid = null;
    best.deliverPinged = false;
    best.deliverWaitT = 0;
    return;
  }
  if (nearest) Ping.say(sys, nearest, missingLine(req.kind, req.ammoType));
  sys.request = null;
}

/** 지금 몸에 그 요청을 채울 것이 있는가. 탐색형(상자 · 탈출 · 계약)은 늘 맡는다. */
function canFulfil(sys: AllySystem, a: Ally, kind: AllyRequestKind, defId: string | null, ammoType: string | null): boolean {
  switch (kind) {
    case 'heal':
      // 「회복 아이템」 = 순수 회복약이다 — 실드 충전기 · 부스트는 아니다.
      return !!Bag.findInBag(sys, a, (d) => d.category === 'stim' && !shieldChargeOf(d.id) && !boostItemOf(d.id));
    case 'shield':
      return !!Bag.findInBag(sys, a, (d) => !!shieldChargeOf(d.id));
    case 'ammo':
      return !!Bag.findInBag(sys, a, (d) => d.category === 'ammo' && (!ammoType || d.ammoType === ammoType));
    case 'item':
      return !!defId && !!Bag.findInBag(sys, a, (d) => d.id === defId);
    default:
      return true;
  }
}

function missingLine(kind: AllyRequestKind, ammoType: string | null): string {
  switch (kind) {
    case 'heal': return CHAT_KO.noHeal;
    case 'shield': return CHAT_KO.noShield;
    case 'ammo': return CHAT_KO.noAmmo(ammoType ? ((AMMO_LABEL_KO as Record<string, string>)[ammoType] ?? ammoType) : '');
    case 'extract': return CHAT_KO.noExtract;
    case 'contract': return CHAT_KO.noContract;
    default: return CHAT_KO.noItem;
  }
}

/** 요청을 끝낸다 (건네줬다 · 못 했다). 탈출구 핑 동행도 여기서 함께 끝난다 — 새 일이 잡히면 더 따라갈 이유가 없다. */
export function finishTask(sys: AllySystem, a: Ally): void {
  if (sys.request?.claimedBy === a.id) sys.request = null;
  a.hasExtractPing = false;
  a.taskKind = null;
  a.taskBy = null;
  a.taskDefId = null;
  a.taskAmmoType = null;
  a.taskTargetId = null;
  a.deliverUid = null;
  a.deliverPinged = false;
  a.deliverWaitT = 0;
}

/* ═══════════════════════════ 명령 상태 ═══════════════════════════ */

/**
 * 명령 상태의 제안. **`moveHoldT` 는 「이 명령을 아직 끝내지 않았다」는 표시다** — 명령이 들어올 때
 * `ALLY_MOVE_HOLD_S` 로 서고, 도착해서 그만큼 머문 뒤에야 0 이 된다.
 *
 * 예전에는 도착한 **뒤에야** `moveHoldT` 를 세웠다: `moveTo` 첫 프레임이 곧바로 「머무름이 끝났다」로 읽혀
 * 제안이 null → `Fsm.decide` 가 따라가기로 떨어뜨림 → 다음 프레임에 명령이 다시 제안됨 → 핑과 분대장 사이를
 * 왕복하는 오실레이션이 됐다 (2026-09-16 수정).
 */
export function proposal(sys: AllySystem, a: Ally): Proposal | null {
  const now = sys.ctx.time;
  if (now < sys.watchUntil) return { state: 'watch', prio: PRIO.order };
  if (sys.orderKind && now < sys.orderUntil) {
    if (sys.orderKind === 'moveTo' && a.moveHoldT <= 0) return null;   // 도착해서 머물기까지 끝냈다 → 하네스로
    return { state: sys.orderKind, prio: PRIO.order };
  }
  return null;
}

/**
 * 「앞장서라」의 **자기 구역** — 분대장 앞 `ALLY_LEAD_AHEAD_M` 지점에서 기마다 `ALLY_SPREAD_M` 씩 옆으로 벌린
 * 자리를 `out` 에 쓴다 (한 점에 세 기가 겹쳐 서지 않게). 넓어진 하네스 안으로 자른다.
 */
function leadSpot(sys: AllySystem, a: Ally, out: THREE.Vector3): THREE.Vector3 {
  out.copy(sys.orderPos);
  const dx = sys.orderPos.x - sys.leaderPos.x;
  const dz = sys.orderPos.z - sys.leaderPos.z;
  const d = Math.hypot(dx, dz);
  if (d > 1e-3) {
    const n = Math.max(1, sys.bodies.length);
    const k = (a.bay - (n - 1) / 2) * ALLY_SPREAD_M;
    out.x += (dz / d) * k;
    out.z += (-dx / d) * k;
  }
  return Nav.clampToHarness(sys.leaderPos, sys.harness, out, out);
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  if (a.state === 'watch') {
    // 그 자리를 바라보되 가지 않는다 (사용자 결정).
    a.lookVec.copy(sys.watchPos);
    a.lookAt = a.lookVec;
    Nav.face(a, sys.watchPos, dt);
    // 분대장 곁은 지킨다 — 주의 중에도 하네스는 살아 있다.
    if (sys.leaderKnown && dist2D(a.position, sys.leaderPos) > sys.harness) {
      a.running = true;
      Nav.step(sys, a, sys.leaderPos, ALLY_RUN_SPEED, dt, sys.watchPos, WATCH_KEEP_OUT_M);
    } else Nav.halt(a);
    return;
  }
  const lead = a.state === 'lead';
  const dest = lead ? leadSpot(sys, a, _v2) : sys.orderPos;
  a.running = lead;
  const left = Nav.step(sys, a, dest, lead ? ALLY_RUN_SPEED : ALLY_WALK_SPEED, dt,
    sys.ctx.time < sys.watchUntil ? sys.watchPos : null, WATCH_KEEP_OUT_M);
  if (left > ALLY_MOVE_ARRIVE_M) return;
  Nav.halt(a);
  a.running = false;
  if (lead) {
    // 자기 구역에 닿았다 → 명령은 여기서 끝나고, 넓어진 하네스(`sys.leadUntil`) 안에서 자유 탐색이 일대를 훑는다.
    sys.orderKind = null;
    sys.orderUntil = -Infinity;
    return;
  }
  // 「가자」 — 도착한 뒤부터 `ALLY_MOVE_HOLD_S` 를 깎는다. 0 이 되면 이 명령은 **한 번** 끝난 것이다.
  a.moveHoldT -= dt;
  if (a.moveHoldT <= 0) { a.moveHoldT = 0; sys.orderKind = null; sys.orderUntil = -Infinity; }
}

function leaderYaw(sys: AllySystem): number {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? 'local';
  if (sys.leaderId === localId) return ctx.player?.yaw ?? 0;
  return ctx.net?.getRemotePlayer(sys.leaderId)?.yaw ?? 0;
}

/** 요청자의 위치 · 속도 · 시선 (건네기 조건 판정, `parts/Support`). 모르면 null. */
export function requesterOf(sys: AllySystem, peer: PeerId): { position: THREE.Vector3; speed: number; yaw: number } | null {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? 'local';
  if (peer === localId) {
    const p = ctx.player;
    return p ? { position: p.position, speed: Math.hypot(p.velocity.x, p.velocity.z), yaw: p.yaw } : null;
  }
  const rp = ctx.net?.getRemotePlayer(peer);
  return rp ? { position: rp.position, speed: Math.hypot(rp.velocity.x, rp.velocity.z), yaw: rp.yaw } : null;
}

/** 요청자의 장착 주무기 탄종 (탄약 요청의 기본값). */
export function requesterAmmoType(sys: AllySystem, peer: PeerId): string | null {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? 'local';
  if (peer === localId) {
    const prim = ctx.inventory?.getLoadout().primary ?? null;
    return prim ? ctx.loot?.getEffectiveStats(prim)?.ammoType ?? null : null;
  }
  const card = ctx.net?.getCrewCard(peer);
  return card?.primary ? ctx.loot?.getEffectiveStats(card.primary)?.ammoType ?? null : null;
}

/** 분대장을 다시 읽는다 (`parts/Harness` 위임 — 콘솔 치트가 쓴다). */
export const leaderIdOf = Harness.leaderOf;
