import * as THREE from 'three';
import {
  GATHER_INTERACT_TIME, GATHER_NODES_PER_MISSION, Layers,
  type GameContext, type GatherNodeDef, type GatherWire, type HarvestMessage, type HarvestRequest,
  type Interactable, type ItemInstance, type PeerId, type Random,
} from '@/shared';
import { type BuildCtx, PLAY_LIMIT, composeMatrix, isSpotFree, merge, paint, paintGradient, xform } from './build';

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

const GLOW_COLORS: readonly number[] = [0xff5a6a, 0x7affc8, 0xffc24a];

interface Variant {
  meshes: THREE.InstancedMesh[];
  geometries: THREE.BufferGeometry[];
  glowMat: THREE.MeshStandardMaterial;
  count: number;
}

interface Node {
  def: GatherNodeDef;
  variant: number;
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
 * Harvestable plants (채집물) scattered over the map.
 *
 * - `GATHER_NODES_PER_MISSION` procedural plants in 3 variants, drawn with one `InstancedMesh` per part
 *   (2 parts per variant → 6 draw calls total) so 34 nodes cost nothing.
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

  build(ctx: BuildCtx, game: GameContext): void {
    this.game = game;
    this.ensureNet();
    const rng = ctx.rng.fork('gather');
    const herbIds = this.resolveHerbIds(game);

    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.0, side: THREE.DoubleSide });

    for (let k = 0; k < 3; k++) {
      const glowMat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.35, metalness: 0.0,
        emissive: new THREE.Color(GLOW_COLORS[k]), emissiveIntensity: 1.1,
      });
      const geos = this.makeVariantGeometry(k, ctx, rng);
      const meshes: THREE.InstancedMesh[] = [];
      const bodyIm = new THREE.InstancedMesh(geos[0], this.bodyMat, GATHER_NODES_PER_MISSION);
      const glowIm = new THREE.InstancedMesh(geos[1], glowMat, GATHER_NODES_PER_MISSION);
      for (const im of [bodyIm, glowIm]) {
        im.name = `gather_plant_${k}`;
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
    const spots: { x: number; z: number; variant: number }[] = [];
    const spacing2 = MIN_SPACING * MIN_SPACING;
    const free = (x: number, z: number, near: number): boolean => {
      if (!isSpotFree(ctx, x, z, 0.7, { maxSlope: 0.3, padExtra: 3 })) return false;
      for (let i = 0; i < spots.length; i++) {
        const dx = spots[i].x - x, dz = spots[i].z - z;
        if (dx * dx + dz * dz < near) return false;
      }
      return true;
    };
    for (let a = 0; a < 5000 && spots.length < GATHER_NODES_PER_MISSION; a++) {
      const x = rng.range(-PLAY_LIMIT + 8, PLAY_LIMIT - 8);
      const z = rng.range(-PLAY_LIMIT + 8, PLAY_LIMIT - 8);
      if (!free(x, z, spacing2)) continue;
      const variant = rng.int(0, 2);
      spots.push({ x, z, variant });
      // small cluster of the same herb so gathering feels like finding a patch
      const extra = rng.chance(0.55) ? rng.int(1, 2) : 0;
      for (let c = 0; c < extra && spots.length < GATHER_NODES_PER_MISSION; c++) {
        const ang = rng.range(0, Math.PI * 2), d = rng.range(2.2, 4.2);
        const cx = x + Math.cos(ang) * d, cz = z + Math.sin(ang) * d;
        if (free(cx, cz, 1.6 * 1.6)) spots.push({ x: cx, z: cz, variant });
      }
    }

    let id = 0;
    for (const s of spots) {
      const v = this.variants[s.variant];
      if (v.count >= GATHER_NODES_PER_MISSION) continue;
      const y = ctx.terrain.getHeightAt(s.x, s.z);
      const yaw = rng.range(0, Math.PI * 2);
      const scale = rng.range(0.85, 1.3);
      const defId = herbIds[s.variant % herbIds.length];
      const def: GatherNodeDef = {
        id: `gather_${id++}`,
        position: new THREE.Vector3(s.x, y, s.z),
        defId,
        qty: rng.chance(0.25) ? 2 : 1,
        harvested: false,
      };
      const node: Node = {
        def, variant: s.variant, slot: v.count,
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
    return {
      id: `gather:${node.def.id}`,
      position: node.def.position,
      // base hold; the player applies `derived.interactSpeedMul` to every hold (Phase 5)
      holdTime: GATHER_INTERACT_TIME,
      radius: NODE_RADIUS,
      getPrompt: () => {
        if (node.def.harvested) return null;
        const name = this.game?.loot?.getItemDef(node.def.defId)?.name ?? '약초';
        return node.pending ? `${name} 채집 중…` : `${name} 채집 (E)`;
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

    const mul = ctx.progression?.derived.gatherYieldMul ?? 1;
    const qty = Math.max(1, Math.round(node.def.qty * (mul > 0 ? mul : 1)));
    ctx.bus.emit('gather:collected', { nodeId: node.def.id, defId: node.def.defId, qty });
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

  private writeMatrix(node: Node, shrink: number): void {
    const v = this.variants[node.variant];
    const s = node.scale * Math.max(0, shrink);
    const sink = (1 - Math.max(0, shrink)) * 0.35;
    const m = composeMatrix(node.x, node.y - sink, node.z, node.yaw, 0, 0, s, s, s);
    for (const im of v.meshes) im.setMatrixAt(node.slot, m);
    this.matrixDirty = true;
  }

  /** [body, glow] geometry for plant variant `k`, tinted from the biome palette. */
  private makeVariantGeometry(k: number, ctx: BuildCtx, rng: Random): THREE.BufferGeometry[] {
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
}
