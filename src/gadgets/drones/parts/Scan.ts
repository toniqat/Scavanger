/**
 * src/gadgets/drones/parts/Scan.ts — **지상 드론이 들여다본 상자 · 컨테이너 · 시체 안에서 가장 좋은 것은 몇 등급인가** (2026-09-12).
 *
 * 지상 드론을 조종하는 동안 렌즈 중심 광선이 스캔 대상(`droneScanKindOf` — 맵 상자 · 구조물 컨테이너 · 적/분대원 시체 ·
 * 보급 상자)에 걸린 채 좌클릭을 `DRONE_SCAN_HOLD_S` 누르고 있으면 결과가 대상 위 월드 라벨(`ui/hud/DroneScanLabels`)로
 * 레이드 내내 남고 분대에 방송된다(`drone scan` + 채팅 한 줄). 공중 드론은 못 한다(설계안 §7).
 *
 *  - **조준**: 대상마다 중심(바닥 + 종류별 높이) 반지름 `DRONE_SCAN_AIM_RADIUS` 구와 광선 교차 — 가장 먼저 닿는 것.
 *    `DRONE_SCAN_HINT_RANGE` 밖은 보지 않고, 렌즈 → 중심이 `DRONE_SCAN_RANGE` 안이어야 게이지가 찬다.
 *  - **가림**: 렌즈 → 대상 중심까지 `world.raycast` — 대상 **자기 콜라이더**(상자 · 컨테이너 · 보급 상자는 자리에 콜라이더가
 *    선다)가 아닌 것이 중심보다 `OCCLUDE_SLACK` 앞에서 걸리면 조준이 아니다. 벽 너머 캐비닛은 벽이 먼저 걸린다.
 *  - **게이지**: 대상이 바뀌거나 조준 · 거리를 잃거나 좌클릭을 떼거나 조종이 끝나면 0. 채운 뒤에는 뗄 때까지 다시 세지 않는다.
 *    좌클릭이 총으로 새지 않는 것은 weapons 의 `droneLatch` 가 보장한다(조종 중 + 끝난 뒤 뗄 때까지).
 *  - **미리보기 = 여는 것**: `InventoryRef.peekContainerItems`(상자 · 보급 상자 = 티어 굴림, 이미 연 것 = 지금 내용물) ·
 *    `WorldRef.previewContainerItems`(구조물 컨테이너 — 열쇠 · 키카드 부가 굴림 포함, owner: world) → `peekSuppliedItems` ·
 *    적 시체는 `enemies/Corpses.Corpse.interact` 와 같은 `shared/lootRolls.corpseLootRandom` → `rollCorpseOn` ·
 *    분대원 시체는 `PlayerCorpse` 가 든 `items`. 아무것도 열거나 굴려 두지 않는다.
 *  - **소음 없음**: `world:noise` 도 위치 오디오도 내지 않는다 (조종자에게만 들리는 작은 딸깍 하나).
 *
 * 받는 쪽(`onRemoteScan`)은 표시 전용이라 권위 검사가 없고 **모양 · 로비 멤버 · 빈도 · 보낸 사람의 지상 드론 거리**만 본다.
 */
import * as THREE from 'three';
import {
  DRONE_SCAN_AIM_RADIUS, DRONE_SCAN_HINT_RANGE, DRONE_SCAN_HOLD_S, DRONE_SCAN_RANGE, DRONE_SCAN_SHARE_SLACK,
  DRONE_SCAN_TARGET_NAME, MouseButtons, PLAYER_CORPSE_COLS, PLAYER_CORPSE_ROWS, RARITY_LABEL_KO, RARITY_ORDER, corpseLootRandom,
  SUPPLY_CRATE_TIER, droneScanKindOf, rarityRank,
  type DroneMessage, type DroneScanAim, type DroneScanResult, type DroneScanTargetKind, type EnemyType, type Interactable,
  type ItemInstance, type PeerId, type Rarity,
} from '@/shared';
import type { DroneSystem } from '../DroneSystem';

/* ── 대상 실루엣 (기하 — 게임플레이 수치 아님) ── */
/** 조준 구 중심 = 대상 `Interactable.position`(바닥) + 이 높이. 궤짝 0.85 m · 캐비닛 0.85–1.75 m · 누운 시체 · 보급 상자 1.2 m. */
const CENTER_Y: Readonly<Record<DroneScanTargetKind, number>> = { crate: 0.45, container: 0.8, corpse: 0.3, playerCorpse: 0.25, supply: 0.6 };
/** 대상 중심보다 이만큼(m) 앞에서 걸린 남의 콜라이더 · 지형만 가림으로 친다 (낮은 시체 앞 지형 굴곡 · 대상 표면). */
const OCCLUDE_SLACK = 0.35;
/** 광선이 맞은 장애물의 중심이 대상 자리에서 이만큼(m, 수평) 안이면 대상 자기 콜라이더다. */
const OWN_COLLIDER_EPS = 0.3;
/** 받는 쪽: 보낸 사람 한 명에게서 이 간격(초)보다 잦은 스캔은 버린다 — 홀드가 `DRONE_SCAN_HOLD_S` 라 정상 흐름은 절대 안 걸린다. */
const RECV_MIN_INTERVAL_S = DRONE_SCAN_HOLD_S * 0.5;
const ID_MAX = 96;

const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** `DroneScanAim` 의 재사용 객체 (프레임마다 할당하지 않는다). */
export interface MutableScanAim { id: string; kind: DroneScanTargetKind; name: string; distance: number; inRange: boolean }

interface AimHit { it: Interactable; kind: DroneScanTargetKind; distance: number }

/** 적 시체(`enemies/Corpses.Corpse`)의 공개 필드 — 계약(`Interactable`) 밖이라 모양만 기대한다. */
interface EnemyCorpseLike { enemyId?: unknown; type?: unknown; weaponId?: unknown; seed?: unknown }
/** `WorldRef.previewContainerItems`(owner: world, 설계안 §3) — 아직 없는 빌드에서도 컴파일되게 모양으로 읽는다. */
interface WorldContainerPreview { previewContainerItems?: (containerId: string) => readonly ItemInstance[] | null }

/* ═══════════════════════════ 조준 · 홀드 (매 프레임) ═══════════════════════════ */

export function scanHold(sys: DroneSystem): number {
  if (!sys.controlled || !sys.scanTargetId) return 0;
  return Math.min(1, sys.scanT / Math.max(0.01, DRONE_SCAN_HOLD_S));
}

export function scanAim(sys: DroneSystem): DroneScanAim | null {
  return sys.controlled && sys.scanAimOn ? sys.scanAimView : null;
}

function resetHold(sys: DroneSystem): void {
  sys.scanT = 0;
  sys.scanTargetId = null;
}

/** `DroneSystem.update` 끝(카메라가 이번 프레임 자세를 받은 뒤). */
export function updateScan(sys: DroneSystem, dt: number): void {
  const ctx = sys.ctx;
  const d = sys.controlled;
  if (!d || d.kind !== 'ground' || !ctx.isGameplayActive() || !ctx.world?.ready) {
    resetHold(sys);
    sys.scanAimOn = false;
    if (!d) sys.scanLatch = false;
    return;
  }
  d.body.getCameraPose(d.lookPitch, _pos, _look);
  _dir.subVectors(_look, _pos);
  if (_dir.lengthSq() < 1e-8) { resetHold(sys); sys.scanAimOn = false; return; }
  _dir.normalize();

  const hit = aimAt(sys, _pos, _dir);
  if (hit) {
    const v = sys.scanAimView;
    if (v.id !== hit.it.id || !sys.scanAimOn) { v.id = hit.it.id; v.kind = hit.kind; v.name = targetName(sys, hit.it.id, hit.kind); }
    v.distance = hit.distance;
    v.inRange = hit.distance <= DRONE_SCAN_RANGE;
    sys.scanAimOn = true;
  } else sys.scanAimOn = false;

  if (!ctx.input.isMouseDown(MouseButtons.FIRE)) { sys.scanLatch = false; resetHold(sys); return; }
  if (sys.scanLatch) return;
  if (!hit || hit.distance > DRONE_SCAN_RANGE) { resetHold(sys); return; }
  if (sys.scanTargetId !== hit.it.id) { sys.scanTargetId = hit.it.id; sys.scanT = 0; }
  sys.scanT += dt;
  if (sys.scanT < DRONE_SCAN_HOLD_S) return;
  sys.scanLatch = true;
  resetHold(sys);
  completeScan(sys, hit.it, hit.kind);
}

/** 렌즈 광선에 가장 먼저 닿는 스캔 대상 (가림 검사 포함), 없으면 null. */
function aimAt(sys: DroneSystem, origin: THREE.Vector3, dir: THREE.Vector3): AimHit | null {
  const ctx = sys.ctx;
  const world = ctx.world;
  if (!world) return null;
  const r2 = DRONE_SCAN_AIM_RADIUS * DRONE_SCAN_AIM_RADIUS;
  const hint2 = DRONE_SCAN_HINT_RANGE * DRONE_SCAN_HINT_RANGE;
  let best: Interactable | null = null;
  let bestKind: DroneScanTargetKind = 'crate';
  let bestT = Infinity, bestDist2 = 0, bestAlong = 0;
  const all = ctx.interactables.all();
  for (let i = 0; i < all.length; i++) {
    const it = all[i];
    const kind = droneScanKindOf(it.id);
    if (!kind) continue;
    const ox = origin.x - it.position.x;
    const oy = origin.y - (it.position.y + CENTER_Y[kind]);
    const oz = origin.z - it.position.z;
    const dist2 = ox * ox + oy * oy + oz * oz;
    if (dist2 > hint2) continue;
    const b = ox * dir.x + oy * dir.y + oz * dir.z;
    const c = dist2 - r2;
    if (c > 0 && b > 0) continue;              // 구가 광선 뒤에 있다
    const disc = b * b - c;
    if (disc < 0) continue;
    const t = Math.max(0, -b - Math.sqrt(disc));
    if (t < bestT) { bestT = t; best = it; bestKind = kind; bestDist2 = dist2; bestAlong = -b; }
  }
  if (!best) return null;
  const along = Math.max(0, bestAlong);
  if (along > OCCLUDE_SLACK) {
    const w = world.raycast(origin, dir, along);
    if (w && w.distance < along - OCCLUDE_SLACK) {
      const o = w.obstacle;
      const own = !!o && Math.hypot(o.position.x - best.position.x, o.position.z - best.position.z) < OWN_COLLIDER_EPS;
      if (!own) return null;
    }
  }
  return { it: best, kind: bestKind, distance: Math.sqrt(bestDist2) };
}

function targetName(sys: DroneSystem, id: string, kind: DroneScanTargetKind): string {
  if (kind === 'playerCorpse') {
    const owner = sys.ctx.corpses?.get(id)?.ownerName;
    if (owner) return `${owner}의 유해`;
  }
  return DRONE_SCAN_TARGET_NAME[kind];
}

/* ═══════════════════════════ 미리보기 ═══════════════════════════ */

/**
 * 대상을 지금 열면 보일 내용물 — 여는 경로와 같은 굴림 · 같은 채우기. 알 수 없으면 null (스캔 거부).
 * `it` 가 없으면(스모크 · 디버그) id 로 상호작용 목록에서 찾는다.
 */
export function previewItems(sys: DroneSystem, id: string): readonly ItemInstance[] | null {
  const ctx = sys.ctx;
  const inv = ctx.inventory;
  const world = ctx.world;
  const kind = droneScanKindOf(id);
  if (!kind || !inv || typeof inv.peekContainerItems !== 'function' || !world) return null;
  switch (kind) {
    case 'crate': {
      const def = world.getCrates().find((c) => c.id === id);
      return def ? inv.peekContainerItems(id, def.tier) : null;
    }
    case 'supply':
      return inv.peekContainerItems(id, SUPPLY_CRATE_TIER);
    case 'container': {
      // 컨테이너 캐시 · `crate:open` 의 id 는 `container:` 를 뗀 명세 id 다 (`world/structures/parts/Containers`)
      const specId = id.slice('container:'.length);
      const cached = inv.peekContainerItems(specId);
      if (cached) return cached;
      const pw = world as unknown as WorldContainerPreview;
      if (typeof pw.previewContainerItems !== 'function') return null;
      let rolled: readonly ItemInstance[] | null = null;
      // 게임 루프 안이다 — 다른 폴더의 미리보기가 던져도 스캔 거부로 끝낸다
      try { rolled = pw.previewContainerItems(specId) ?? pw.previewContainerItems(id); } catch (e) { console.warn('[drones] previewContainerItems failed', e); return null; }
      if (!rolled) return null;
      return typeof inv.peekSuppliedItems === 'function' ? inv.peekSuppliedItems(specId, rolled) : rolled;
    }
    case 'corpse': {
      const cached = inv.peekContainerItems(id);
      if (cached) return cached;
      const it = findInteractable(sys, id) as (Interactable & EnemyCorpseLike) | null;
      const loot = ctx.loot;
      if (!it || !loot || typeof it.enemyId !== 'number' || typeof it.type !== 'string') return null;
      // `enemies/Corpses.Corpse.interact` 와 같은 식이다 — 시드는 그 시체가 받은 값(= `world.seed`)
      const seed = typeof it.seed === 'number' ? it.seed : world.seed;
      const rng = corpseLootRandom(seed, it.enemyId);   // `Corpse.interact` 와 같은 `shared/lootRolls` 식
      const weaponId = typeof it.weaponId === 'string' ? it.weaponId : undefined;
      const items = typeof loot.rollCorpseOn === 'function'
        ? loot.rollCorpseOn(it.type as EnemyType, rng, weaponId, ctx.missionPlanet)
        : [];
      return typeof inv.peekSuppliedItems === 'function' ? inv.peekSuppliedItems(id, items) : items;
    }
    case 'playerCorpse': {
      const cached = inv.peekContainerItems(id);
      if (cached) return cached;
      const pc = (ctx.corpses?.get(id) ?? null) as ({ items?: unknown } | null);
      const items = pc && Array.isArray(pc.items) ? (pc.items as ItemInstance[]) : null;
      if (!items) return null;
      return typeof inv.peekSuppliedItems === 'function' ? inv.peekSuppliedItems(id, items, PLAYER_CORPSE_COLS, PLAYER_CORPSE_ROWS) : items;
    }
  }
  return null;
}

/** 목록 안의 최고 등급, 비었으면 null. */
export function maxRarity(sys: DroneSystem, items: readonly ItemInstance[]): Rarity | null {
  let best = -1;
  for (const it of items) {
    if (!it || !(it.qty > 0)) continue;
    const def = sys.ctx.loot?.getItemDef(it.defId) ?? sys.ctx.inventory?.getDef(it.defId);
    if (!def) continue;
    const r = rarityRank(def.rarity);
    if (r > best) best = r;
  }
  return best >= 0 ? RARITY_ORDER[best] : null;
}

function findInteractable(sys: DroneSystem, id: string): Interactable | null {
  const all = sys.ctx.interactables.all();
  for (let i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}

/* ═══════════════════════════ 결과 ═══════════════════════════ */

export function scanLine(name: string, rarity: Rarity | null): string {
  return `드론 스캔: ${name} — ${rarity ? `최고 등급 ${RARITY_LABEL_KO[rarity]}` : '비어 있음'}`;
}

function completeScan(sys: DroneSystem, it: Interactable, kind: DroneScanTargetKind): void {
  const ctx = sys.ctx;
  const items = previewItems(sys, it.id);
  if (!items) {
    ctx.bus.emit('ui:notify', { text: '스캔할 수 없다', kind: 'warning', duration: 1.4 });
    ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
    return;
  }
  const rarity = maxRarity(sys, items);
  const name = targetName(sys, it.id, kind);
  record(sys, it.id, kind, name, rarity, it.position, true, ctx.net?.playerName ?? '나');
  // 조종자에게만 (위치 없음) — 스캔은 소리를 내지 않는다
  ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.6 });
  // 채팅 한 줄: ChatLog 가 내 줄로 그리고 로비에 있으면 분대에도 보낸다 (`ping` = 이름이 붙고 차단해도 숨지 않는 자동 줄)
  ctx.bus.emit('chat:post', { text: scanLine(name, rarity), kind: 'ping' });
  const net = ctx.net;
  if (ctx.isMultiplayer && net) {
    const p = it.position;
    net.send({ t: 'drone', ev: 'scan', id: it.id, r: rarity, p: [r2(p.x), r2(p.y), r2(p.z)] }, 'others');
  }
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** 결과 하나를 넣거나 갈아 끼운다 (대상마다 최신 하나, 목록 끝이 최신). */
export function record(sys: DroneSystem, id: string, kind: DroneScanTargetKind, name: string, rarity: Rarity | null,
  position: THREE.Vector3, local: boolean, byName: string): DroneScanResult {
  const ctx = sys.ctx;
  const entry: DroneScanResult = { id, kind, name, rarity, position, local, byName, at: ctx.time };
  sys.scans.delete(id);
  sys.scans.set(id, entry);
  sys.scanList = [...sys.scans.values()];
  ctx.bus.emit('drone:scanned', { id, kind, name, rarity, position, local, byName });
  return entry;
}

export function getScanResults(sys: DroneSystem): readonly DroneScanResult[] { return sys.scanList; }

export function clearScans(sys: DroneSystem): void {
  sys.scans.clear();
  sys.scanList = [];
  sys.scanRecvAt.clear();
  sys.scanAimOn = false;
  sys.scanLatch = false;
  resetHold(sys);
}

/* ═══════════════════════════ 받는 쪽 ═══════════════════════════ */

/** 분대원의 `drone scan` — 표시 전용. 모양 · 로비 멤버 · 빈도 · 그 사람의 지상 드론이 대상 곁에 있는지. */
export function onRemoteScan(sys: DroneSystem, m: Extract<DroneMessage, { ev: 'scan' }>, from: PeerId): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const world = ctx.world;
  if (!net || !world?.ready || from === net.localId) return;
  const member = net.getLobbyPlayer(from);
  if (!member) { sys.scanRefused++; return; }
  const id = m.id;
  if (typeof id !== 'string' || id.length > ID_MAX) { sys.scanRefused++; return; }
  const kind = droneScanKindOf(id);
  const rarity = m.r === null ? null : (RARITY_ORDER as readonly unknown[]).includes(m.r) ? m.r : undefined;
  const p = m.p;
  if (!kind || rarity === undefined || !Array.isArray(p) || p.length !== 3 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    sys.scanRefused++;
    return;
  }
  const last = sys.scanRecvAt.get(from);
  if (last !== undefined && ctx.time - last < RECV_MIN_INTERVAL_S) { sys.scanRefused++; return; }

  // 대상이 이 월드에 있으면 그 살아 있는 자리, 없으면(아직 복제 전인 시체 등) 맵 안의 보낸 자리
  const it = findInteractable(sys, id);
  let pos: THREE.Vector3;
  if (it) pos = it.position;
  else {
    if (!world.isInsideBounds(p[0], p[2])) { sys.scanRefused++; return; }
    pos = new THREE.Vector3(p[0], p[1], p[2]);
  }
  const reach = DRONE_SCAN_RANGE + DRONE_SCAN_SHARE_SLACK;
  let near = false;
  for (let i = 0; i < sys.drones.length; i++) {
    const d = sys.drones[i];
    if (d.owner !== from || d.kind !== 'ground' || d.removing) continue;
    if (d.position.distanceToSquared(pos) <= reach * reach) { near = true; break; }
  }
  if (!near) { sys.scanRefused++; return; }
  sys.scanRecvAt.set(from, ctx.time);
  record(sys, id, kind, targetName(sys, id, kind), rarity, pos, false, member.name || '분대원');
}
