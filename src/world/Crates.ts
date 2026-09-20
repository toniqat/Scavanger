import * as THREE from 'three';
import { Layers, keyTable, type CrateDef, type GameContext, type Interactable, type Random } from '@/shared';
import { type BuildCtx, isSpotFree, makeSoftParticleTexture, merge, paint, paintGradient, xform } from './build';

/** No crate is placed within this distance (m) of a nest pad centre (`data/tuning.csv`, 2026-09-18 user's decision). */
const NEST_CRATE_CLEAR_M = /* data/tuning.csv */ keyTable('tuning.csv').num('NEST_CRATE_CLEAR_M');

const CRATE_W = 1.25, CRATE_H = 0.85, CRATE_D = 0.8;
const OPEN_ANGLE = -1.95;       // radians, lid hinges up/back
const OPEN_DURATION = 0.6;

const TIER_STRIPE: Record<number, number> = { 1: 0xc8c8c0, 2: 0x38c860, 3: 0x4a80ff, 4: 0xffb020 };
const TIER_BODY: Record<number, number> = { 1: 0x5a6250, 2: 0x4a5a58, 3: 0x3e4660, 4: 0x5a4a30 };
const TIER_LIGHT: Record<number, number> = { 1: 0xa0ffb0, 2: 0x40ff80, 3: 0x60a0ff, 4: 0xffc040 };

interface CrateInst {
  def: CrateDef;
  root: THREE.Group;
  lid: THREE.Group;
  light: THREE.Mesh;
  animT: number;      // -1 idle, else seconds since open started
  /** Has this client already opened it once (2026-09-11) — `def.opened` is the open look, whoever opened it. */
  rolled: boolean;
  interactable: Interactable;
}

/** Loot crates: mesh + lid animation + Interactable registration + tiny dust puffs. */
export class Crates {
  readonly group = new THREE.Group();
  private crates: CrateInst[] = [];
  private defs: CrateDef[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private lightMats = new Map<number, THREE.MeshStandardMaterial>();
  private gameCtx: GameContext | null = null;
  private readonly byId = new Map<string, CrateInst>();
  /** When the lid first opens on this client (world tells the squad with `crate opened`). */
  private onOpened: ((id: string) => void) | null = null;
  private puffs: Puffs | null = null;

  constructor() { this.group.name = 'Crates'; }

  getDefs(): readonly CrateDef[] { return this.defs; }

  /** 2026-09-11: open-look sync — called when the lid first opens on this client. */
  setOpenListener(cb: ((id: string) => void) | null): void { this.onOpened = cb; }

  /**
   * 2026-09-11: put a crate a squadmate opened into the **open look** (lid · light only; no event, stats or sound).
   * With the light pillar gone, this look is what says "someone has already searched it". False when the crate is not in this set.
   */
  /** 2026-09-11 (C-57): the position of a crate in this set (null with none) — the receiver measures `crate opened`'s distance. */
  positionOf(id: string): THREE.Vector3 | null { return this.byId.get(id)?.def.position ?? null; }

  markOpened(id: string): boolean {
    const inst = this.byId.get(id);
    if (!inst) return false;
    if (!inst.def.opened) { inst.def.opened = true; inst.animT = 0; inst.light.visible = false; }
    return true;
  }

  build(ctx: BuildCtx, game: GameContext): void {
    this.gameCtx = game;
    const rng = ctx.rng.fork('crates');
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.4 });
    this.materials.push(bodyMat);
    for (const tier of [1, 2, 3, 4]) {
      const m = new THREE.MeshStandardMaterial({ color: 0x101010, emissive: new THREE.Color(TIER_LIGHT[tier]), emissiveIntensity: 2 });
      this.lightMats.set(tier, m);
      this.materials.push(m);
    }

    // geometry per tier (body incl. frame + stripes), one lid geometry per tier
    const bodyGeos = new Map<number, THREE.BufferGeometry>();
    const lidGeos = new Map<number, THREE.BufferGeometry>();
    for (const tier of [1, 2, 3, 4]) {
      bodyGeos.set(tier, this.makeBodyGeometry(tier, rng));
      lidGeos.set(tier, this.makeLidGeometry(tier, rng));
    }
    this.geometries.push(...bodyGeos.values(), ...lidGeos.values());
    const lightGeo = new THREE.BoxGeometry(0.16, 0.08, 0.06);
    this.geometries.push(lightGeo);

    // ── placement ─────────────────────────────────────────────────────
    /* 2026-09-18 (user's decision) — **no crate stands beside a nest.** The nest's reward is now destructible
     * eggs (`bug_egg`), so the crate ring that made 「the bugs guarding it earn their keep」 is not needed. Dropping
     * the ring alone is not enough — a POI or structure ring can roll toward a nest by chance, so everything within
     * `NEST_CRATE_CLEAR_M` of a pad centre is refused (`data/tuning.csv`). */
    const nestClearSq = NEST_CRATE_CLEAR_M * NEST_CRATE_CLEAR_M;
    const nestClear = (x: number, z: number): boolean => {
      for (const n of ctx.layout.nests) if ((n.x - x) ** 2 + (n.z - z) ** 2 < nestClearSq) return false;
      return true;
    };
    const placements: { x: number; z: number; tier: number }[] = [];
    const tryPlace = (x: number, z: number, tier: number, padExtra: number, ignorePads = false): boolean => {
      if (!isSpotFree(ctx, x, z, 0.95, { maxSlope: 0.28, padExtra, ignorePads })) return false;
      if (!nestClear(x, z)) return false;
      for (const p of placements) if ((p.x - x) ** 2 + (p.z - z) ** 2 < 6 * 6) return false;
      placements.push({ x, z, tier });
      // reserve immediately so later props/crates avoid it
      ctx.hash.add(new THREE.Vector3(x, ctx.terrain.getHeightAt(x, z), z), 0.9, CRATE_H, 'crate');
      return true;
    };
    const ring = (cx: number, cz: number, rMin: number, rMax: number, tier: number, want: number, attempts: number, ignorePads: boolean) => {
      let placed = 0;
      for (let a = 0; a < attempts && placed < want; a++) {
        const ang = rng.range(0, Math.PI * 2), d = rng.range(rMin, rMax);
        if (tryPlace(cx + Math.cos(ang) * d, cz + Math.sin(ang) * d, tier, -50, ignorePads)) placed++;
      }
      return placed;
    };

    /* 2026-09-10 — **no crates in the open field** (user's decision).
     *
     * The old placement scattered 30–40 tier-1 crates over the whole map and put even tier 3–4 anywhere. So most
     * crates were ones a player walked into by accident, and it became "tier 3–4 is lying all over the field". Now a
     * crate stands **only where people were** — POI ruins · around abandoned structures (2026-09-18: the nest ring is gone).
     * Containers **inside** a structure are still placed by `world/structures`, those on a platform by `world/Rails`.
     * **This file no longer places tier 4** — it stands only in basements and the crash-landed ship (`data/structures.csv`).
     * The total is 20–40, close to the old 30–40, and all of it gathered around landmarks. */

    // 5–8 POI ruins — this map's main outdoor looting spots. One tier 2 + two tier 1.
    for (const poi of ctx.layout.pois) {
      ring(poi.x, poi.z, 2.5, 9, 2, 1, 40, true);
      ring(poi.x, poi.z, 3, 13, 1, 2, 70, true);
    }
    // Around abandoned structures (outpost · lab · crash-landed ship) — **outside** the walls, one tier 3 + one or two tier 2.
    for (const st of ctx.layout.structures) {
      const reach = Math.hypot(st.halfW, st.halfD) + 4;      // = that structure pad's radius
      ring(st.pad.x, st.pad.z, reach + 2, reach + 10, 3, 1, 60, true);
      ring(st.pad.x, st.pad.z, reach + 2, reach + 15, 2, 1 + rng.int(0, 1), 80, true);
    }
    /* The nest ring (one tier 3 × 4–6 nests) is gone as of 2026-09-18 — see the `nestClear` comment above.
     * A raid has that many fewer crates (usually 4–6, all tier 3). No other ring was raised to make up for it (the user's call). */

    // ── build instances ───────────────────────────────────────────────
    let id = 0;
    for (const p of placements) {
      const y = ctx.terrain.getHeightAt(p.x, p.z);
      const yaw = rng.range(0, Math.PI * 2);
      const def: CrateDef = { id: `crate_${id++}`, position: new THREE.Vector3(p.x, y, p.z), yaw, tier: p.tier, opened: false };
      this.defs.push(def);

      const root = new THREE.Group();
      root.position.copy(def.position);
      root.rotation.y = yaw;
      // settle into terrain tilt slightly
      const n = ctx.terrain.getNormalAt(p.x, p.z, new THREE.Vector3());
      root.rotation.x = -n.z * 0.6; root.rotation.z = n.x * 0.6;
      root.name = def.id;

      // 2026-09-20 (`docs/DECISIONS.md` perf Phase A2, user's decision 「작은 물체도 그림자 끄기」): a loot box
      // is waist-high and stands on open ground or a lit floor, so its own shadow reads as a smudge under it —
      // 138 casters in S2 for 12k triangles. It still **receives** shadow, which is what makes it sit on the ground.
      const body = new THREE.Mesh(bodyGeos.get(p.tier)!, bodyMat);
      body.castShadow = false; body.receiveShadow = true;
      body.layers.enable(Layers.INTERACTABLE);
      root.add(body);

      const lid = new THREE.Group();
      lid.position.set(0, CRATE_H, -CRATE_D / 2);
      const lidMesh = new THREE.Mesh(lidGeos.get(p.tier)!, bodyMat);
      lidMesh.castShadow = false;
      lid.add(lidMesh);
      root.add(lid);

      const light = new THREE.Mesh(lightGeo, this.lightMats.get(p.tier)!);
      light.position.set(0.4, CRATE_H - 0.12, CRATE_D / 2 + 0.02);
      root.add(light);

      /* 2026-09-11: the tier-4 crate's light pillar (beam) was removed — light pillars stand only on corpses (user's decision). */
      const inst: CrateInst = {
        def, root, lid, light, animT: -1, rolled: false,
        interactable: {
          id: def.id,
          position: def.position,
          radius: 2.8,
          getPrompt: () => (def.opened ? '상자 살펴보기 (E)' : '상자 열기 (E)'),
          canInteract: () => true,
          // 2026-09-08: an opened crate keeps its E prompt (you can look inside again) but must stop advertising
          // itself — the 감지 빛기둥 over a 귀중품 상자 stayed lit forever because `canInteract` never turns false.
          // `Interactable.hidePillar` is read per frame by `ui/hud/Detection`, so a getter is enough.
          get hidePillar(): boolean { return def.opened; },
          interact: () => this.onInteract(inst),
        },
      };
      this.crates.push(inst);
      this.byId.set(def.id, inst);
      this.group.add(root);
      game.interactables.register(inst.interactable);
    }

    this.puffs = new Puffs();
    this.group.add(this.puffs.points);
    ctx.root.add(this.group);
  }

  private onInteract(inst: CrateInst): void {
    const game = this.gameCtx;
    if (!game) return;
    if (!inst.def.opened) {
      inst.def.opened = true;
      inst.animT = 0;
      inst.light.visible = false;
      this.onOpened?.(inst.def.id);
    }
    const first = !inst.rolled;
    if (first) {
      inst.rolled = true;
      game.stats.cratesOpened++;
      game.bus.emit('audio:play', { id: 'crate_open', position: inst.def.position });
      this.puffs?.burst(inst.def.position.x, inst.def.position.y + CRATE_H, inst.def.position.z, 14);
    }
    game.bus.emit('crate:open', { crateId: inst.def.id, tier: inst.def.tier, position: inst.def.position });
  }

  update(dt: number, time: number): void {
    // blink unopened lights (shared materials → one pulse per tier)
    for (const [tier, m] of this.lightMats) {
      const ph = time * (tier === 4 ? 6 : 2.5) + tier;
      m.emissiveIntensity = (ph % (Math.PI * 2)) < 0.6 ? 3.0 : 0.25;
    }
    for (let i = 0; i < this.crates.length; i++) {
      const c = this.crates[i];
      if (c.animT < 0) continue;
      c.animT += dt;
      const t = Math.min(1, c.animT / OPEN_DURATION);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      c.lid.rotation.x = OPEN_ANGLE * e;
      if (t >= 1) c.animT = -1;
    }
    this.puffs?.update(dt);
  }

  dispose(): void {
    const game = this.gameCtx;
    for (const c of this.crates) {
      game?.interactables.unregister(c.def.id);
      this.group.remove(c.root);
    }
    this.crates.length = 0;
    this.byId.clear();
    this.onOpened = null;
    this.defs.length = 0;
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    this.lightMats.clear();
    if (this.puffs) { this.group.remove(this.puffs.points); this.puffs.dispose(); this.puffs = null; }
    this.group.removeFromParent();
    this.gameCtx = null;
  }

  /* ── geometry ───────────────────────────────────────────────────────── */

  private makeBodyGeometry(tier: number, rng: Random): THREE.BufferGeometry {
    const body = new THREE.Color(TIER_BODY[tier]), frame = new THREE.Color(0x2a2c2a), stripe = new THREE.Color(TIER_STRIPE[tier]);
    const parts: THREE.BufferGeometry[] = [];
    const inner = new THREE.BoxGeometry(CRATE_W - 0.1, CRATE_H - 0.06, CRATE_D - 0.1);
    xform(inner, { x: 0, y: (CRATE_H - 0.06) / 2, z: 0 });
    paintGradient(inner, body.clone().multiplyScalar(0.75), body);
    parts.push(inner);
    // beveled frame: 12 edge bars
    const t = 0.08;
    const edges: [number, number, number, number, number, number][] = [];
    const hx = CRATE_W / 2, hz = CRATE_D / 2;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) edges.push([sx * hx, CRATE_H / 2, sz * hz, t, CRATE_H, t]);              // verticals
    for (const sz of [-1, 1]) for (const y of [t / 2, CRATE_H - t / 2]) edges.push([0, y, sz * hz, CRATE_W, t, t]);          // x bars
    for (const sx of [-1, 1]) for (const y of [t / 2, CRATE_H - t / 2]) edges.push([sx * hx, y, 0, t, t, CRATE_D]);          // z bars
    for (const [x, y, z, w, h, d] of edges) {
      const bar = new THREE.BoxGeometry(w, h, d);
      xform(bar, { x, y, z });
      paint(bar, frame, 0.05, rng);
      parts.push(bar);
    }
    // stripes on front & back
    for (const sz of [-1, 1]) {
      for (const sx of [-0.28, 0.28]) {
        const s = new THREE.BoxGeometry(0.14, CRATE_H - 0.2, 0.03);
        xform(s, { x: sx, y: CRATE_H / 2, z: sz * (hz - 0.035) });
        paint(s, stripe);
        parts.push(s);
      }
    }
    // side handles
    for (const sx of [-1, 1]) {
      const h = new THREE.BoxGeometry(0.06, 0.08, 0.36);
      xform(h, { x: sx * (hx + 0.02), y: CRATE_H * 0.55, z: 0 });
      paint(h, frame);
      parts.push(h);
    }
    // feet
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const f = new THREE.BoxGeometry(0.18, 0.06, 0.18);
      xform(f, { x: sx * (hx - 0.15), y: -0.02, z: sz * (hz - 0.15) });
      paint(f, frame);
      parts.push(f);
    }
    return merge(parts);
  }

  private makeLidGeometry(tier: number, rng: Random): THREE.BufferGeometry {
    const body = new THREE.Color(TIER_BODY[tier]), frame = new THREE.Color(0x2a2c2a), stripe = new THREE.Color(TIER_STRIPE[tier]);
    const parts: THREE.BufferGeometry[] = [];
    const lidH = 0.14;
    const top = new THREE.BoxGeometry(CRATE_W + 0.04, lidH, CRATE_D + 0.04);
    xform(top, { x: 0, y: lidH / 2, z: CRATE_D / 2 });   // hinge at z = 0 (back edge)
    paintGradient(top, body, body.clone().multiplyScalar(1.15));
    parts.push(top);
    const rim = new THREE.BoxGeometry(CRATE_W + 0.08, 0.05, CRATE_D + 0.08);
    xform(rim, { x: 0, y: 0.025, z: CRATE_D / 2 });
    paint(rim, frame, 0.05, rng);
    parts.push(rim);
    const band = new THREE.BoxGeometry(CRATE_W * 0.5, 0.02, 0.12);
    xform(band, { x: 0, y: lidH + 0.01, z: CRATE_D / 2 });
    paint(band, stripe);
    parts.push(band);
    // latch on front
    const latch = new THREE.BoxGeometry(0.2, 0.12, 0.05);
    xform(latch, { x: -0.4, y: lidH / 2 - 0.04, z: CRATE_D + 0.04 });
    paint(latch, frame);
    parts.push(latch);
    return merge(parts);
  }
}

/** Tiny CPU particle pool for dust puffs (shared across all crates). */
class Puffs {
  readonly points: THREE.Points;
  private readonly max = 96;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly mat: THREE.PointsMaterial;
  private readonly tex: THREE.Texture;
  private cursor = 0;

  constructor() {
    this.pos = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.tex = makeSoftParticleTexture(32);
    this.mat = new THREE.PointsMaterial({ size: 0.55, map: this.tex, color: 0xb8a888, transparent: true, opacity: 0.55, depthWrite: false, sizeAttenuation: true });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.name = 'crate_puffs';
    for (let i = 0; i < this.max; i++) this.pos[i * 3 + 1] = -1000;
  }

  burst(x: number, y: number, z: number, n: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.5;
      this.pos[i * 3] = x + Math.cos(a) * r; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z + Math.sin(a) * r;
      this.vel[i * 3] = Math.cos(a) * (0.6 + Math.random() * 0.8);
      this.vel[i * 3 + 1] = 0.8 + Math.random() * 1.2;
      this.vel[i * 3 + 2] = Math.sin(a) * (0.6 + Math.random() * 0.8);
      this.life[i] = 0.7 + Math.random() * 0.5;
    }
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -1000; continue; }
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= 1.5 * dt;
      this.vel[i * 3] *= 0.96; this.vel[i * 3 + 2] *= 0.96;
    }
    if (any) (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}
