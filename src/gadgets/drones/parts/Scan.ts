/**
 * src/gadgets/drones/parts/Scan.ts — **the best rarity inside the crate · container · corpse a ground drone looked
 * into** (2026-09-12).
 *
 * While a ground drone is controlled, holding left-click for `DRONE_SCAN_HOLD_S` with the lens centre ray on a
 * scan target (`droneScanKindOf` — map crates · structure containers · enemy / squadmate corpses · supply crates)
 * leaves the result as a world label above the target (`ui/hud/DroneScanLabels`) for the rest of the raid and
 * broadcasts it to the squad (`drone scan` + one chat line). An air drone cannot do it (the design note §7).
 *
 *  - **Aiming**: the ray is intersected with a sphere of radius `DRONE_SCAN_AIM_RADIUS` around each target's
 *    centre (the floor + a per-kind height) — the first one it reaches. Anything past `DRONE_SCAN_HINT_RANGE` is
 *    not looked at, and lens → centre has to be within `DRONE_SCAN_RANGE` for the gauge to fill.
 *  - **Occlusion**: `world.raycast` from the lens to the target centre — anything that is not the target's **own
 *    collider** (a crate · container · supply crate stands a collider on its spot) caught `OCCLUDE_SLACK` ahead of
 *    the centre means it is not aimed at. A cabinet beyond a wall is blocked by the wall first.
 *  - **The gauge**: 0 when the target changes, when aim · range is lost, when left-click is released, or when
 *    control ends. Once filled it does not count again until the button is released. That the left-click does not
 *    leak into the gun is guaranteed by weapons' `droneLatch` (while controlled + until release afterwards).
 *  - **Previewing = opening**: `InventoryRef.peekContainerItems` (crate · supply crate = a tier roll, already
 *    opened = the current contents) · `WorldRef.previewContainerItems` (structure containers — the bonus key ·
 *    keycard roll included, owner: world) → `peekSuppliedItems` · an enemy corpse takes the same
 *    `shared/lootRolls.corpseLootRandom` → `rollCorpseOn` as `enemies/Corpses.Corpse.interact` · a squadmate
 *    corpse takes the `items` the `PlayerCorpse` holds. Nothing is opened and nothing is left rolled.
 *  - **No noise**: it emits neither `world:noise` nor positional audio (one small click, heard only by the
 *    controlling player).
 *
 * The receiving side (`onRemoteScan`) is display only, so it has no authority check and looks at **the shape ·
 * lobby membership · the rate · the distance of the sender's ground drone** alone.
 */
import * as THREE from 'three';
import {
  DRONE_SCAN_AIM_RADIUS, DRONE_SCAN_HINT_RANGE, DRONE_SCAN_HOLD_S, DRONE_SCAN_RANGE, DRONE_SCAN_SHARE_SLACK,
  DRONE_SCAN_TARGET_NAME, MouseButtons, PLAYER_CORPSE_COLS, PLAYER_CORPSE_ROWS, RARITY_LABEL_KO, RARITY_ORDER, corpseLootRandom,
  SUPPLY_CRATE_TIER, droneScanKindOf, rarityRank,
  type CorpseLootOpts, type DroneMessage, type DroneScanAim, type DroneScanResult, type DroneScanTargetKind, type EnemyType, type Interactable,
  type ItemInstance, type PeerId, type Rarity,
} from '@/shared';
import type { DroneSystem } from '../DroneSystem';

/* ── Target silhouettes (geometry — not gameplay numbers) ── */
/**
 * Aim sphere centre = the target's `Interactable.position` (which stands on the floor) + this height, i.e. roughly
 * the middle of the drawn silhouette: half a crate · half a supply crate · a corpse lying flat.
 * `container` is **one value for all three cabinet styles** (`world/structures/parts/Containers` `STYLE_H`), which
 * works only because `DRONE_SCAN_AIM_RADIUS` is wider than the gap between the tallest and the shortest of them —
 * making the cabinets differ in height by more than that radius would need a per-style centre instead.
 */
const CENTER_Y: Readonly<Record<DroneScanTargetKind, number>> = { crate: 0.45, container: 0.8, corpse: 0.3, playerCorpse: 0.25, supply: 0.6 };
/**
 * Only another collider · terrain caught this far (m) in front of the target centre counts as occlusion (a fold of
 * terrain in front of a low corpse · the target's own surface).
 */
const OCCLUDE_SLACK = 0.35;
/**
 * When the centre of the obstacle the ray hit lies within this (m, horizontal) of the target's spot, it is the
 * target's own collider.
 */
const OWN_COLLIDER_EPS = 0.3;
/**
 * Receiving side: scans arriving from one sender more often than this interval (s) are dropped — the hold is
 * `DRONE_SCAN_HOLD_S`, so a normal flow never trips it.
 */
const RECV_MIN_INTERVAL_S = DRONE_SCAN_HOLD_S * 0.5;
const ID_MAX = 96;

const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** The reused `DroneScanAim` object (nothing is allocated per frame). */
export interface MutableScanAim { id: string; kind: DroneScanTargetKind; name: string; distance: number; inRange: boolean }

interface AimHit { it: Interactable; kind: DroneScanTargetKind; distance: number }

/**
 * The public fields of an enemy corpse (`enemies/Corpses.Corpse`) — outside the contract (`Interactable`), so only
 * the shape is expected.
 */
interface EnemyCorpseLike { enemyId?: unknown; type?: unknown; weaponId?: unknown; seed?: unknown; /** 2026-09-13: spawn site · grenades left */ lootOpts?: unknown }
/**
 * `WorldRef.previewContainerItems` (owner: world, the design note §3) — read as a shape so a build that does not
 * have it yet still compiles.
 */
interface WorldContainerPreview { previewContainerItems?: (containerId: string) => readonly ItemInstance[] | null }

/* ═══════════════════════════ Aiming · hold (every frame) ═══════════════════════════ */

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

/** The end of `DroneSystem.update` (after the camera took this frame's pose). */
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

/** The first scan target the lens ray reaches (the occlusion check included), or null. */
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
    if (c > 0 && b > 0) continue;              // the sphere is behind the ray
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

/* ═══════════════════════════ Preview ═══════════════════════════ */

/**
 * What the target would show if it were opened now — the same roll · the same fill as the opening path. Unknown
 * gives null (the scan is refused).
 * With no `it` (a smoke test · debugging) it is looked up in the interactable list by id.
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
      // The container cache · the id in `crate:open` is the spec id with `container:` stripped
      // (`world/structures/parts/Containers`)
      const specId = id.slice('container:'.length);
      const cached = inv.peekContainerItems(specId);
      if (cached) return cached;
      const pw = world as unknown as WorldContainerPreview;
      if (typeof pw.previewContainerItems !== 'function') return null;
      let rolled: readonly ItemInstance[] | null = null;
      // 2026-09-19: asked with the **spec id only**. World keys its container sets by that id and seeds the roll
      // with it (`crateLootRandom(seed, specId)`), which is the very seed the opening path uses — passing the
      // prefixed interactable id instead would seed a different roll, so a preview that answered on it would show
      // contents the container never opens with (「previewing = opening」, CLAUDE.md §4.7).
      // This runs inside the game loop — another folder's preview throwing ends as a refused scan.
      try { rolled = pw.previewContainerItems(specId); } catch (e) { console.warn('[drones] previewContainerItems failed', e); return null; }
      if (!rolled) return null;
      return typeof inv.peekSuppliedItems === 'function' ? inv.peekSuppliedItems(specId, rolled) : rolled;
    }
    case 'corpse': {
      const cached = inv.peekContainerItems(id);
      if (cached) return cached;
      const it = findInteractable(sys, id) as (Interactable & EnemyCorpseLike) | null;
      const loot = ctx.loot;
      if (!it || !loot || typeof it.enemyId !== 'number' || typeof it.type !== 'string') return null;
      // The same formula as `enemies/Corpses.Corpse.interact` — the seed is what that corpse got (= `world.seed`)
      const seed = typeof it.seed === 'number' ? it.seed : world.seed;
      const rng = corpseLootRandom(seed, it.enemyId);   // the same `shared/lootRolls` formula as `Corpse.interact`
      const weaponId = typeof it.weaponId === 'string' ? it.weaponId : undefined;
      const items = typeof loot.rollCorpseOn === 'function'
        ? loot.rollCorpseOn(it.type as EnemyType, rng, weaponId, ctx.missionPlanet, (it.lootOpts ?? undefined) as CorpseLootOpts | undefined)
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

/** The highest rarity in the list, or null when it is empty. */
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

/* ═══════════════════════════ Results ═══════════════════════════ */

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
  // For the controlling player only (no position) — a scan makes no sound
  ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.6 });
  // One chat line: ChatLog draws it as my own line and, in a lobby, sends it to the squad as well
  // (`ping` = an automatic line that carries a name and is not hidden by a block)
  ctx.bus.emit('chat:post', { text: scanLine(name, rarity), kind: 'ping' });
  const net = ctx.net;
  if (ctx.isMultiplayer && net) {
    const p = it.position;
    net.send({ t: 'drone', ev: 'scan', id: it.id, r: rarity, p: [r2(p.x), r2(p.y), r2(p.z)] }, 'others');
  }
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Inserts or swaps in one result (the latest one per target; the end of the list is the newest). */
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

/* ═══════════════════════════ The receiving side ═══════════════════════════ */

/**
 * A squadmate's `drone scan` — display only. The shape · lobby membership · the rate · whether that player's
 * ground drone is next to the target.
 */
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

  // If the target exists in this world, its live spot; otherwise (a corpse not replicated yet, say) the
  // sent spot, as long as it is inside the map
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
