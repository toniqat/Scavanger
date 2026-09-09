import * as THREE from 'three';
import {
  GATHER_INTERACT_TIME, GATHER_NODES_PER_MISSION, Layers,
  SALVAGE_INTERACT_TIME, SALVAGE_NODES_PER_MISSION,
  type GameContext, type GatherNodeDef, type GatherNodeKind, type GatherWire, type HarvestMessage, type HarvestRequest,
  type Interactable, type ItemInstance, type PeerId, type PlanetEcosystem, type Random,
} from '@/shared';
import { type BuildCtx, PLAY_LIMIT, composeMatrix, isSpotFree, merge, paint, paintGradient, xform } from './build';
import {
  GROVE_PICKS_MAX, GROVE_PICKS_MIN, GROVE_PICK_RING_MAX, GROVE_PICK_RING_MIN, GROVE_PICK_VARIANT,
} from './hazard/model';

/** Seconds the shrink-away animation runs after a node is harvested. */
const HARVEST_ANIM = 0.42;
/** Interaction radius of a plant. */
const NODE_RADIUS = 2.2;
/** A client's `harvq take` is retried after this long without an answer. */
const PENDING_TIMEOUT = 3;
/** Minimum distance between two nodes of different clusters. */
const MIN_SPACING = 7;

/**
 * Herb def ids used when `items/` has not registered any `category: 'herb'` def yet
 * (the folders are built in parallel). Real ids are discovered from `ctx.loot` at generation time.
 */
const FALLBACK_HERB_IDS: readonly string[] = ['herb_bloodroot', 'herb_ashleaf', 'herb_glowcap'];

const GLOW_COLORS: readonly number[] = [0xff5a6a, 0x7affc8, 0xffc24a, 0xffb347];

/* ── 고철 노드 (2026-09-08) ────────────────────────────────────────────────
 * 폐금속이 상자의 `material` 롤에서만 나오던 병목을 푸는 세 갈래 중 하나. 약초와 **같은 노드 시스템**을 쓴다 —
 * 배치 · 상호작용 · 호스트 권한 동기화(`harv` / `harvq`)가 전부 그대로 돌고, 다른 것은 변종 메시(난파 고철 더미),
 * 프롬프트 동사(`해체`), 집는 시간, 그리고 채집 수율 대신 고정 수량이라는 점뿐이다. */
/** `variants` index of the 고철 더미 mesh (0–2 are the plant shapes). */
const SALVAGE_VARIANT = 3;
/** What a 고철 더미 hands over. */
const SALVAGE_DEF_ID = 'mat_scrap';
/** Interaction radius of a 고철 더미 (a bit wider than a plant — it is a pile). */
const SALVAGE_RADIUS = 2.6;
/** Minimum distance from a 고철 더미 to any other node. */
const SALVAGE_SPACING = 12;

interface Variant {
  meshes: THREE.InstancedMesh[];
  geometries: THREE.BufferGeometry[];
  glowMat: THREE.MeshStandardMaterial;
  count: number;
}

/** One placed cluster member: where it stands, which of the 3 shapes it uses and which herb it hands over. */
interface Spot { x: number; z: number; variant: number; defId: string; kind: GatherNodeKind }

interface Node {
  def: GatherNodeDef;
  variant: number;
  kind: GatherNodeKind;
  slot: number;
  x: number; y: number; z: number;
  yaw: number;
  scale: number;
  /** -1 idle, else seconds since the harvest started (shrink animation). */
  anim: number;
  /** Client only: a `harvq take` is in flight. */
  pending: boolean;
  pendingAt: number;
  interactable: Interactable;
}

/**
 * Harvestable nodes (채집물) scattered over the map — 약초 plants and, since 2026-09-08, 고철 더미.
 *
 * - `GATHER_NODES_PER_MISSION` procedural plants in 3 variants plus `SALVAGE_NODES_PER_MISSION` 고철 더미
 *   (variant `SALVAGE_VARIANT`), drawn with one `InstancedMesh` per part (2 parts per variant → 8 draw calls
 *   total) so the whole set costs nothing. `GatherNodeDef.kind` says which a node is; 고철 더미 hand over
 *   `mat_scrap`, take `SALVAGE_INTERACT_TIME` to strip, ignore the 채집 수율 multiplier and grant 제작 XP.
 * - Each node registers an `Interactable` with `holdTime = GATHER_INTERACT_TIME` (the player scales holds by `derived.interactSpeedMul`).
 * - Harvesting emits `gather:collected` and then hands the herb to `ctx.inventory.tryAddItem`
 *   (quantity scaled by `derived.gatherYieldMul`).
 * - Multiplayer is host-authoritative, mirroring pickups: clients send `harvq take/sync`, the host answers with
 *   `harv taken/sync`. Node ids/positions are deterministic from the mission seed, so only the id travels.
 */
export class Gather {
  readonly group = new THREE.Group();
  private variants: Variant[] = [];
  private bodyMat: THREE.MeshStandardMaterial | null = null;
  private readonly nodes: Node[] = [];
  private readonly byId = new Map<string, Node>();
  private readonly defs: GatherNodeDef[] = [];
  private game: GameContext | null = null;
  private netHooked = false;
  private readonly unsubs: Array<() => void> = [];
  private matrixDirty = false;
  private built = false;

  constructor() { this.group.name = 'GatherNodes'; }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /** Called once from `WorldSystem.init`; net hooks are attached lazily (NetSystem publishes `ctx.net` first). */
  attach(game: GameContext): void {
    this.game = game;
    this.ensureNet();
  }

  getNodes(): readonly GatherNodeDef[] { return this.defs; }

  /**
   * `eco` (Phase 11): the 목표 행성's ecosystem — `eco.herbs` are relative weights **by herb def id** (replacing the
   * old uniform "one herb per plant shape") and `eco.gatherDensity` scales `GATHER_NODES_PER_MISSION`.
   * null (no planet / an unknown id) reproduces the pre-Phase-11 placement draw exactly for the same seed.
   */
  build(
    ctx: BuildCtx, game: GameContext, eco: PlanetEcosystem | null = null,
    groves: ReadonlyArray<{ x: number; z: number }> = [],
  ): void {
    this.game = game;
    this.ensureNet();
    const rng = ctx.rng.fork('gather');
    const herbIds = this.resolveHerbIds(game);
    const weights = this.resolveHerbWeights(herbIds, eco);
    const target = this.nodeTarget(eco);

    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.0, side: THREE.DoubleSide });

    // variants 0–2 are the plant shapes, variant 3 the 고철 더미 — each mesh is sized for its own node budget
    const salvageTarget = SALVAGE_NODES_PER_MISSION;
    // 2026-09-09: 거대 버섯 군락 둘레의 채집 버섯은 전부 포자균 갓(변종 1)이라 그 변종만 자리를 더 잡는다
    const groveExtra = groves.length * GROVE_PICKS_MAX;
    const capacityOf = (k: number): number => (
      k === SALVAGE_VARIANT ? salvageTarget : k === GROVE_PICK_VARIANT ? target + groveExtra : target
    );
    for (let k = 0; k <= SALVAGE_VARIANT; k++) {
      const glowMat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.35, metalness: 0.0,
        emissive: new THREE.Color(GLOW_COLORS[k]), emissiveIntensity: 1.1,
      });
      const geos = this.makeVariantGeometry(k, ctx, rng);
      const meshes: THREE.InstancedMesh[] = [];
      const bodyIm = new THREE.InstancedMesh(geos[0], this.bodyMat, capacityOf(k));
      const glowIm = new THREE.InstancedMesh(geos[1], glowMat, capacityOf(k));
      for (const im of [bodyIm, glowIm]) {
        im.name = k === SALVAGE_VARIANT ? 'gather_salvage' : `gather_plant_${k}`;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.castShadow = false;
        im.receiveShadow = false;
        im.frustumCulled = false;
        im.layers.enable(Layers.INTERACTABLE);
        im.count = 0;
        meshes.push(im);
      }
      this.variants.push({ meshes, geometries: geos, glowMat, count: 0 });
    }

    // ── placement: sparse clusters on gentle, unoccupied ground ──────────
    const spots: Spot[] = [];
    const spacing2 = MIN_SPACING * MIN_SPACING;
    const free = (x: number, z: number, near: number): boolean => {
      if (!isSpotFree(ctx, x, z, 0.7, { maxSlope: 0.3, padExtra: 3 })) return false;
      for (let i = 0; i < spots.length; i++) {
        const dx = spots[i].x - x, dz = spots[i].z - z;
        if (dx * dx + dz * dz < near) return false;
      }
      return true;
    };
    for (let a = 0; a < 5000 && spots.length < target; a++) {
      const x = rng.range(-PLAY_LIMIT + 8, PLAY_LIMIT - 8);
      const z = rng.range(-PLAY_LIMIT + 8, PLAY_LIMIT - 8);
      if (!free(x, z, spacing2)) continue;
      const variant = rng.int(0, 2);
      // Phase 11: the plant **shape** (`variant`) and the **herb it drops** (`defId`) are independent draws now — the
      // shape is cosmetic, the herb comes from the planet's weights. With no planet the old `herbIds[variant]` pairing
      // is used verbatim so the rng stream (and therefore the whole layout) is byte-identical to before.
      const defId = weights ? this.pickHerb(weights, rng) : herbIds[variant % herbIds.length];
      spots.push({ x, z, variant, defId, kind: 'herb' });
      // small cluster of the same herb so gathering feels like finding a patch
      const extra = rng.chance(0.55) ? rng.int(1, 2) : 0;
      for (let c = 0; c < extra && spots.length < target; c++) {
        const ang = rng.range(0, Math.PI * 2), d = rng.range(2.2, 4.2);
        const cx = x + Math.cos(ang) * d, cz = z + Math.sin(ang) * d;
        if (free(cx, cz, 1.6 * 1.6)) spots.push({ x: cx, z: cz, variant, defId, kind: 'herb' });
      }
    }

    // ── 고철 더미 (2026-09-08): 구조물(POI) 주변에 먼저, 남는 만큼 개활지에 ──────
    // 플랜트 배치가 끝난 **뒤에** 뽑으므로 같은 시드의 약초 레이아웃은 이전과 바이트 단위로 같다.
    {
      const salvageSpots: Spot[] = [];
      const freeSalvage = (x: number, z: number): boolean => {
        if (!isSpotFree(ctx, x, z, 1.1, { maxSlope: 0.32, padExtra: 4 })) return false;
        const near = SALVAGE_SPACING * SALVAGE_SPACING;
        for (const p of salvageSpots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < near) return false;
        for (const p of spots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < 5 * 5) return false;
        return true;
      };
      const push = (x: number, z: number): boolean => {
        if (!freeSalvage(x, z)) return false;
        salvageSpots.push({ x, z, variant: SALVAGE_VARIANT, defId: SALVAGE_DEF_ID, kind: 'salvage' });
        return true;
      };
      for (const poi of ctx.layout.pois) {
        if (salvageSpots.length >= salvageTarget) break;
        for (let a = 0; a < 24; a++) {
          const ang = rng.range(0, Math.PI * 2), d = rng.range(5, 14);
          if (push(poi.x + Math.cos(ang) * d, poi.z + Math.sin(ang) * d)) break;
        }
      }
      for (let a = 0; a < 3000 && salvageSpots.length < salvageTarget; a++) {
        push(rng.range(-PLAY_LIMIT + 12, PLAY_LIMIT - 12), rng.range(-PLAY_LIMIT + 12, PLAY_LIMIT - 12));
      }
      spots.push(...salvageSpots);
    }

    /* ── 거대 버섯 군락의 채집 버섯 (2026-09-09) ──────────────────────────────
     * 군락 자체는 `world/Hazard` 가 세운다 (줄기가 이미 hash 에 들어가 있다). 여기서 하는 것은 그 둘레
     * 고리에 **채집 가능한 버섯**을 심는 것뿐이고, 노드 · 상호작용 · 호스트 권한 동기화는 약초 코드 그대로다.
     * 고철 더미와 같은 수법으로 **약초 · 고철 배치가 끝난 뒤에** 뽑으므로 앞의 rng 스트림을 밀지 않는다. */
    if (groves.length > 0) {
      const groveSpots: Spot[] = [];
      const clear = (x: number, z: number): boolean => {
        if (!isSpotFree(ctx, x, z, 0.7, { maxSlope: 0.34, padExtra: 3 })) return false;
        for (const p of spots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < 2.6 * 2.6) return false;
        for (const p of groveSpots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < 2.6 * 2.6) return false;
        return true;
      };
      for (const g of groves) {
        const want = rng.int(GROVE_PICKS_MIN, GROVE_PICKS_MAX);
        // 한 군락은 한 종류로 — 약초 무리와 같은 규칙 (행성 가중치가 있으면 그것으로 뽑는다)
        const defId = weights ? this.pickHerb(weights, rng) : herbIds[GROVE_PICK_VARIANT % herbIds.length];
        let placed = 0;
        for (let a = 0; a < 80 && placed < want; a++) {
          const ang = rng.range(0, Math.PI * 2);
          const d = rng.range(GROVE_PICK_RING_MIN, GROVE_PICK_RING_MAX);
          const x = g.x + Math.cos(ang) * d, z = g.z + Math.sin(ang) * d;
          if (!clear(x, z)) continue;
          groveSpots.push({ x, z, variant: GROVE_PICK_VARIANT, defId, kind: 'herb' });
          placed++;
        }
      }
      spots.push(...groveSpots);
    }

    let id = 0;
    for (const s of spots) {
      const v = this.variants[s.variant];
      if (v.count >= capacityOf(s.variant)) continue;
      const y = ctx.terrain.getHeightAt(s.x, s.z);
      const yaw = rng.range(0, Math.PI * 2);
      const salvage = s.kind === 'salvage';
      const scale = salvage ? rng.range(0.9, 1.15) : rng.range(0.85, 1.3);
      const def: GatherNodeDef = {
        id: salvage ? `salvage_${id++}` : `gather_${id++}`,
        position: new THREE.Vector3(s.x, y, s.z),
        defId: s.defId,
        // 고철: 폐금속 1, 3할은 2 (레이드당 기대 ~10). 약초: 종전 그대로.
        qty: salvage ? (rng.chance(0.3) ? 2 : 1) : (rng.chance(0.25) ? 2 : 1),
        harvested: false,
        kind: s.kind,
      };
      const node: Node = {
        def, variant: s.variant, kind: s.kind, slot: v.count,
        x: s.x, y, z: s.z, yaw, scale, anim: -1, pending: false, pendingAt: -Infinity,
        interactable: null as unknown as Interactable,
      };
      node.interactable = this.makeInteractable(node);
      this.writeMatrix(node, 1);
      v.count++;
      this.nodes.push(node);
      this.byId.set(def.id, node);
      this.defs.push(def);
      game.interactables.register(node.interactable);
    }

    for (const v of this.variants) {
      for (const im of v.meshes) {
        im.count = v.count;
        im.instanceMatrix.needsUpdate = true;
        if (v.count > 0) this.group.add(im);
      }
    }
    this.built = true;
    ctx.root.add(this.group);

    // (re)joining client: ask the host which nodes are already gone
    this.requestSync();
  }

  update(dt: number, time: number): void {
    if (!this.built) return;
    for (let k = 0; k < this.variants.length; k++) {
      const v = this.variants[k];
      v.glowMat.emissiveIntensity = 0.75 + 0.4 * Math.sin(time * 1.5 + k * 2.1) + 0.12 * Math.sin(time * 4.7 + k);
    }
    const now = this.game?.time ?? time;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (n.pending && now - n.pendingAt > PENDING_TIMEOUT) n.pending = false;
      if (n.anim < 0) continue;
      n.anim += dt;
      const t = Math.min(1, n.anim / HARVEST_ANIM);
      this.writeMatrix(n, 1 - t);
      if (t >= 1) n.anim = -1;
    }
    if (this.matrixDirty) {
      for (const v of this.variants) for (const im of v.meshes) im.instanceMatrix.needsUpdate = true;
      this.matrixDirty = false;
    }
  }

  dispose(): void {
    const game = this.game;
    for (const n of this.nodes) game?.interactables.unregister(n.interactable.id);
    this.nodes.length = 0;
    this.byId.clear();
    this.defs.length = 0;
    for (const v of this.variants) {
      for (const im of v.meshes) { this.group.remove(im); im.dispose(); }
      for (const g of v.geometries) g.dispose();
      v.glowMat.dispose();
    }
    this.variants.length = 0;
    this.bodyMat?.dispose();
    this.bodyMat = null;
    this.group.removeFromParent();
    this.built = false;
  }

  /** Unhook net listeners (system dispose only — `clear()` between missions keeps them). */
  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.netHooked = false;
    this.game = null;
  }

  /* ── harvesting ────────────────────────────────────────────────────── */

  private makeInteractable(node: Node): Interactable {
    const game = () => this.game;
    // 2026-09-08: 고철 더미는 더 오래 걸리고 `해체` 라고 뜬다 — 나머지 규칙은 약초와 같다
    const salvage = node.kind === 'salvage';
    const verb = salvage ? '해체' : '채집';
    return {
      id: `gather:${node.def.id}`,
      position: node.def.position,
      // base hold; the player applies `derived.interactSpeedMul` to every hold (Phase 5)
      holdTime: salvage ? SALVAGE_INTERACT_TIME : GATHER_INTERACT_TIME,
      radius: salvage ? SALVAGE_RADIUS : NODE_RADIUS,
      getPrompt: () => {
        if (node.def.harvested) return null;
        const name = this.game?.loot?.getItemDef(node.def.defId)?.name ?? (salvage ? '고철' : '약초');
        return node.pending ? `${name} ${verb} 중…` : `${name} ${verb} (E)`;
      },
      canInteract: () => {
        const g = this.game;
        return !!g && g.isGameplayActive() && !node.def.harvested && !node.pending;
      },
      interact: () => this.onInteract(node),
    };
  }

  private onInteract(node: Node): void {
    const ctx = this.game;
    if (!ctx || node.def.harvested || node.pending) return;
    const net = ctx.net;
    if (ctx.isMultiplayer && net && !net.isHost) {
      node.pending = true;
      node.pendingAt = ctx.time;
      net.send({ t: 'harvq', ev: 'take', id: node.def.id }, 'host');
      return;
    }
    const by: string = net?.localId ?? 'local';
    this.collect(node, by, true);
    if (ctx.isMultiplayer && net) net.send({ t: 'harv', ev: 'taken', id: node.def.id, by }, 'others');
  }

  /** Mark the node consumed; `award` → the local player gets the herb and `gather:collected` fires. */
  private collect(node: Node, _by: string, award: boolean): void {
    const ctx = this.game;
    if (!ctx || node.def.harvested) return;
    node.def.harvested = true;
    node.pending = false;
    node.anim = 0;
    ctx.interactables.unregister(node.interactable.id);
    if (!award) return;

    // 채집 수율(원예)은 약초에만 붙는다 — 고철은 뜯어낸 만큼 그대로 나온다
    const mul = node.kind === 'salvage' ? 1 : (ctx.progression?.derived.gatherYieldMul ?? 1);
    const qty = Math.max(1, Math.round(node.def.qty * (mul > 0 ? mul : 1)));
    ctx.bus.emit('gather:collected', { nodeId: node.def.id, defId: node.def.defId, qty, kind: node.kind });
    ctx.bus.emit('audio:play', { id: 'gather', position: node.def.position, volume: 0.7 });
    const item = this.makeItem(node.def.defId, qty);
    if (item) ctx.inventory?.tryAddItem(item);
  }

  private makeItem(defId: string, qty: number): ItemInstance | null {
    const ctx = this.game;
    const loot = ctx?.loot;
    if (loot?.getItemDef(defId)) {
      try { return loot.createItem(defId, qty); } catch { /* fall through */ }
    }
    // items/ has not defined this herb yet — do not fabricate an instance the inventory cannot render
    return null;
  }

  /* ── multiplayer (host authority) ──────────────────────────────────── */

  private ensureNet(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('harv', (m) => this.onHarvestMessage(m)),
      net.onMessage('harvq', (m, from) => this.onHarvestRequest(m, from)),
      net.onMessage('flow', (m, from) => {
        if (m.ev === 'rejoined' && this.game?.net?.isHost) this.sendSync(from);
      }),
      // Phase 9: a promoted host never saw our harvests as authority — re-request the taken set from the new host
      ctx.bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost && this.built) this.requestSync(); }),
    );
  }

  private requestSync(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
    net.send({ t: 'harvq', ev: 'sync' }, 'host');
  }

  /** Host → clients. */
  private onHarvestMessage(m: HarvestMessage): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
    if (m.ev === 'taken') {
      const node = this.byId.get(m.id);
      if (!node) return;
      this.collect(node, m.by, m.by === net.localId);
      return;
    }
    // full state for a (re)joining client
    for (const w of m.nodes) {
      const node = this.byId.get(w.id);
      if (!node) continue;
      node.pending = false;
      if (w.harvested && !node.def.harvested) this.collect(node, 'host', false);
    }
  }

  /** Clients → host. */
  private onHarvestRequest(m: HarvestRequest, from: PeerId): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || !net.isHost) return;
    if (m.ev === 'sync') { this.sendSync(from); return; }
    const node = this.byId.get(m.id);
    if (!node || node.def.harvested) return;   // already gone → the requester's pending flag times out
    this.collect(node, from, false);
    net.send({ t: 'harv', ev: 'taken', id: node.def.id, by: from }, 'others');
  }

  private sendSync(to: PeerId): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer) return;
    const nodes: GatherWire[] = [];
    for (const n of this.nodes) {
      if (!n.def.harvested) continue;    // only the deltas travel; positions are seed-deterministic
      nodes.push({ id: n.def.id, defId: n.def.defId, p: [n.x, n.y, n.z], harvested: true });
    }
    net.send({ t: 'harv', ev: 'sync', nodes }, to);
  }

  /* ── geometry ──────────────────────────────────────────────────────── */

  private resolveHerbIds(game: GameContext): string[] {
    const defs = game.loot?.getAllItemDefs?.() ?? [];
    const herbs = defs.filter((d) => d.category === 'herb').map((d) => d.id);
    if (herbs.length > 0) return herbs.slice(0, 3);
    return FALLBACK_HERB_IDS.slice();
  }

  /**
   * Phase 11: `eco.herbs` folded into a cumulative table over the herb ids this build actually knows.
   * An id `items/` never registered is ignored (contract), and a planet whose whole mix is unknown / non-positive
   * falls back to null = the old shape-bound pairing.
   */
  private resolveHerbWeights(herbIds: readonly string[], eco: PlanetEcosystem | null): { ids: string[]; cum: number[] } | null {
    if (!eco) return null;
    const ids: string[] = [];
    const cum: number[] = [];
    let total = 0;
    for (const id of herbIds) {
      const w = eco.herbs[id];
      if (typeof w !== 'number' || !(w > 0)) continue;   // absent / 0 / NaN → this herb does not grow here
      total += w;
      ids.push(id);
      cum.push(total);
    }
    return ids.length > 0 && total > 0 ? { ids, cum } : null;
  }

  private pickHerb(w: { ids: string[]; cum: number[] }, rng: Random): string {
    const r = rng.next() * w.cum[w.cum.length - 1];
    for (let i = 0; i < w.cum.length; i++) if (r < w.cum[i]) return w.ids[i];
    return w.ids[w.ids.length - 1];
  }

  /** Node count for this mission: `GATHER_NODES_PER_MISSION × eco.gatherDensity`, at least 1 plant. */
  private nodeTarget(eco: PlanetEcosystem | null): number {
    const d = eco && Number.isFinite(eco.gatherDensity) ? eco.gatherDensity : 1;
    if (!(d > 0)) return 0;
    return Math.max(1, Math.round(GATHER_NODES_PER_MISSION * d));
  }

  private writeMatrix(node: Node, shrink: number): void {
    const v = this.variants[node.variant];
    const s = node.scale * Math.max(0, shrink);
    const sink = (1 - Math.max(0, shrink)) * 0.35;
    const m = composeMatrix(node.x, node.y - sink, node.z, node.yaw, 0, 0, s, s, s);
    for (const im of v.meshes) im.setMatrixAt(node.slot, m);
    this.matrixDirty = true;
  }

  /** [body, glow] geometry for variant `k` — 0–2 are plants tinted from the biome, 3 is the 고철 더미. */
  private makeVariantGeometry(k: number, ctx: BuildCtx, rng: Random): THREE.BufferGeometry[] {
    if (k === SALVAGE_VARIANT) return this.makeSalvageGeometry(rng);
    const b = ctx.biome;
    const stemLow = b.trunk.clone().lerp(b.grass, 0.5).multiplyScalar(0.8);
    const stemHigh = b.grass.clone().lerp(b.grassTip, 0.4);
    const leaf = b.grass.clone().lerp(b.canopy, 0.35);
    const leafTip = b.grassTip.clone();
    const glowCol = new THREE.Color(GLOW_COLORS[k]);
    const body: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];

    if (k === 0) {
      // 혈청초: slim stalk with drooping blades and a hanging bulb
      const stalk = new THREE.CylinderGeometry(0.03, 0.07, 0.95, 5);
      xform(stalk, { x: 0, y: 0.47, z: 0 });
      paintGradient(stalk, stemLow, stemHigh);
      body.push(stalk);
      const blades = 5;
      for (let i = 0; i < blades; i++) {
        const ang = (i / blades) * Math.PI * 2 + rng.range(-0.2, 0.2);
        const len = rng.range(0.45, 0.68);
        const g = new THREE.ConeGeometry(0.09, len, 3, 1, true);
        xform(g, { x: 0, y: len * 0.5, z: 0 });
        xform(g, undefined, new THREE.Euler(0, 0, 1.05 + rng.range(-0.2, 0.2)));
        xform(g, { x: Math.cos(ang) * 0.16, y: rng.range(0.18, 0.42), z: Math.sin(ang) * 0.16 }, new THREE.Euler(0, ang, 0));
        paintGradient(g, leaf, leafTip);
        body.push(g);
      }
      const bulb = new THREE.IcosahedronGeometry(0.13, 1);
      xform(bulb, { x: 0, y: 1.0, z: 0 }, undefined, { x: 1, y: 1.25, z: 1 });
      paint(bulb, glowCol);
      glow.push(bulb);
      const seedRing = new THREE.TorusGeometry(0.09, 0.02, 4, 8);
      xform(seedRing, { x: 0, y: 0.86, z: 0 }, new THREE.Euler(Math.PI / 2, 0, 0));
      paint(seedRing, glowCol.clone().multiplyScalar(0.7));
      glow.push(seedRing);
    } else if (k === 1) {
      // 포자균: squat fungal cap with a glowing gill ring underneath
      const stalk = new THREE.CylinderGeometry(0.11, 0.16, 0.42, 6);
      xform(stalk, { x: 0, y: 0.21, z: 0 });
      paintGradient(stalk, stemLow, stemLow.clone().lerp(stemHigh, 0.6));
      body.push(stalk);
      const cap = new THREE.SphereGeometry(0.34, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
      xform(cap, { x: 0, y: 0.42, z: 0 }, undefined, { x: 1, y: 0.62, z: 1 });
      paintGradient(cap, b.canopy.clone().multiplyScalar(0.55), b.canopy);
      body.push(cap);
      for (let i = 0; i < 2; i++) {
        const small = new THREE.SphereGeometry(0.15, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55);
        const ang = rng.range(0, Math.PI * 2);
        xform(small, { x: Math.cos(ang) * 0.26, y: 0.16, z: Math.sin(ang) * 0.26 }, undefined, { x: 1, y: 0.6, z: 1 });
        paintGradient(small, b.canopy.clone().multiplyScalar(0.5), b.canopy);
        body.push(small);
      }
      const gills = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 12, 1, true);
      xform(gills, { x: 0, y: 0.4, z: 0 });
      paint(gills, glowCol);
      glow.push(gills);
    } else {
      // 철넝쿨: low tangle of blades with glowing berries
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * Math.PI * 2 + rng.range(-0.3, 0.3);
        const len = rng.range(0.5, 0.85);
        const g = new THREE.ConeGeometry(0.055, len, 3, 1, true);
        xform(g, { x: 0, y: len * 0.5, z: 0 });
        xform(g, undefined, new THREE.Euler(0, 0, rng.range(0.25, 0.75)));
        xform(g, { x: Math.cos(ang) * 0.08, y: 0, z: Math.sin(ang) * 0.08 }, new THREE.Euler(0, ang, 0));
        paintGradient(g, leaf.clone().multiplyScalar(0.75), leafTip);
        body.push(g);
      }
      for (let i = 0; i < 4; i++) {
        const berry = new THREE.IcosahedronGeometry(rng.range(0.055, 0.085), 0);
        const ang = rng.range(0, Math.PI * 2), r = rng.range(0.1, 0.3);
        xform(berry, { x: Math.cos(ang) * r, y: rng.range(0.25, 0.6), z: Math.sin(ang) * r });
        paint(berry, glowCol);
        glow.push(berry);
      }
    }

    return [merge(body), merge(glow)];
  }

  /**
   * 고철 더미 (2026-09-08): 찌그러진 화물통 하나에 휜 강판 몇 장과 파이프를 기대 놓고, 잘라낼 자리마다 호박색
   * 표식이 빛난다. 바이옴 색을 쓰지 않는다 — 금속은 어느 행성에서나 금속이라 멀리서도 식물과 구분된다.
   */
  private makeSalvageGeometry(rng: Random): THREE.BufferGeometry[] {
    const steel = new THREE.Color(0x6b7078);
    const steelDark = new THREE.Color(0x3a3e44);
    const rust = new THREE.Color(0x8a5a3a);
    const glowCol = new THREE.Color(GLOW_COLORS[SALVAGE_VARIANT]);
    const body: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];

    // crushed cargo drum, tipped over
    const drum = new THREE.CylinderGeometry(0.34, 0.38, 0.86, 8);
    xform(drum, { x: 0, y: 0.34, z: 0 }, new THREE.Euler(Math.PI / 2, 0, rng.range(-0.25, 0.25)), { x: 1, y: 1, z: 0.78 });
    paintGradient(drum, steelDark, steel);
    body.push(drum);

    // bent hull plates leaning on the drum
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2 + rng.range(-0.35, 0.35);
      const w = rng.range(0.34, 0.6), h = rng.range(0.5, 0.85);
      const plate = new THREE.BoxGeometry(w, h, 0.045);
      xform(plate, { x: 0, y: h * 0.5, z: 0 });
      xform(plate, undefined, new THREE.Euler(rng.range(0.35, 0.7), 0, rng.range(-0.3, 0.3)));
      xform(plate, { x: Math.cos(ang) * 0.42, y: 0, z: Math.sin(ang) * 0.42 }, new THREE.Euler(0, ang, 0));
      paintGradient(plate, i === 1 ? rust : steel, steelDark);
      body.push(plate);
    }

    // a couple of pipes poking out of the pile
    for (let i = 0; i < 2; i++) {
      const len = rng.range(0.7, 1.05);
      const pipe = new THREE.CylinderGeometry(0.05, 0.05, len, 6);
      const ang = rng.range(0, Math.PI * 2);
      xform(pipe, { x: 0, y: len * 0.5, z: 0 });
      xform(pipe, undefined, new THREE.Euler(0, 0, rng.range(0.7, 1.15)));
      xform(pipe, { x: Math.cos(ang) * 0.2, y: 0.12, z: Math.sin(ang) * 0.2 }, new THREE.Euler(0, ang, 0));
      paintGradient(pipe, steel, rust);
      body.push(pipe);
    }

    // cut markers: a band around the drum and two studs, so the pile reads as harvestable from a distance
    const band = new THREE.TorusGeometry(0.3, 0.028, 4, 10);
    xform(band, { x: 0, y: 0.34, z: 0 }, new THREE.Euler(0, Math.PI / 2, 0));
    paint(band, glowCol);
    glow.push(band);
    for (let i = 0; i < 2; i++) {
      const stud = new THREE.IcosahedronGeometry(0.07, 0);
      const ang = rng.range(0, Math.PI * 2);
      xform(stud, { x: Math.cos(ang) * 0.34, y: rng.range(0.5, 0.78), z: Math.sin(ang) * 0.34 });
      paint(stud, glowCol.clone().multiplyScalar(0.85));
      glow.push(stud);
    }

    return [merge(body), merge(glow)];
  }
}
