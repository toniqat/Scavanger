import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameContext, Interactable, ItemDef } from '@/shared';
import { SKILL_LEVEL_MAX } from '@/shared';
import type { GardenStationDef } from './interiors/stations';

/* ────────────────────────────────────────────────────────────────────────────
 * 함선 수경 재배 (hydroponics). Plant → wait (real time, keeps growing during a raid) → harvest.
 * Harvesting adds herbs through `ctx.loot.createItem` + `ctx.inventory.tryAddItem` and emits
 * `gather:collected`, which is what raises the 원예 skill in progression/.
 * The plot state lives outside the interior (module scope + localStorage) so it survives
 * rebuilding the ship, docking and missions. Both ships show the same garden.
 * ──────────────────────────────────────────────────────────────────────────── */

const STORE_KEY = 'scav.hub.garden.v1';
const PLOT_COUNT = 6;
/** Real seconds for one crop at 원예 0 (halved at SKILL_LEVEL_MAX). */
const GROW_TIME = 150;
/** Units per plot before `derived.gatherYieldMul`. */
const BASE_YIELD = 2;
const HARVEST_HOLD = 1.6;
const PLANT_HOLD = 1.0;

interface Plot { planted: number; ready: number }   // epoch ms; 0/0 = empty

let plots: Plot[] | null = null;

function freshPlots(): Plot[] {
  const out: Plot[] = [];
  for (let i = 0; i < PLOT_COUNT; i++) out.push({ planted: 0, ready: 0 });
  return out;
}

function getPlots(): Plot[] {
  if (plots) return plots;
  const list = freshPlots();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as Array<{ p?: number; r?: number }>;
      if (Array.isArray(data)) {
        for (let i = 0; i < PLOT_COUNT && i < data.length; i++) {
          const p = Number(data[i]?.p) || 0, r = Number(data[i]?.r) || 0;
          if (p > 0 && r > p) list[i] = { planted: p, ready: r };
        }
      }
    }
  } catch { /* private mode / corrupt entry → fresh plots */ }
  plots = list;
  return list;
}

function savePlots(): void {
  if (!plots) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(plots.map((q) => ({ p: q.planted, r: q.ready }))));
  } catch { /* ignore */ }
}

/** 0 = just planted … 1 = ready. Empty plots return −1. */
function progressOf(q: Plot, now: number): number {
  if (q.planted <= 0) return -1;
  const span = Math.max(1, q.ready - q.planted);
  return THREE.MathUtils.clamp((now - q.planted) / span, 0, 1);
}

/** Single merged plant geometry (stem + leaves + bud), shared by every instance. */
function buildPlantGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const stem = new THREE.CylinderGeometry(0.018, 0.032, 0.3, 5);
  stem.translate(0, 0.15, 0);
  parts.push(stem);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const leaf = new THREE.BoxGeometry(0.021, 0.2, 0.1);
    leaf.translate(0, 0.1, 0.05);
    leaf.rotateX(-0.7);
    leaf.rotateY(a);
    leaf.translate(0, 0.1, 0);
    parts.push(leaf);
  }
  // NB: every part must be *indexed* — mergeGeometries refuses a mix (IcosahedronGeometry is not indexed).
  const bud = new THREE.SphereGeometry(0.055, 7, 5);
  bud.translate(0, 0.33, 0);
  parts.push(bud);
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged ?? new THREE.ConeGeometry(0.08, 0.3, 6);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _col = new THREE.Color();

const SPROUT = new THREE.Color(0x6f9a4a);
const RIPE = new THREE.Color(0xa8e05a);

/**
 * Hydroponics station: one `InstancedMesh` of plants (1 draw call) plus an `Interactable`
 * (`hub_garden`) whose prompt and hold time follow the plot state.
 */
export class GardenStation {
  readonly interactable: Interactable;
  private readonly plotPositions: THREE.Vector3[];
  private readonly mesh: THREE.InstancedMesh;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.MeshStandardMaterial;
  private colorsDirty = true;
  /** Cheap change detector so instance colours are only rewritten when a plot changes bucket. */
  private lastBuckets: number[];

  constructor(private readonly ctx: GameContext, def: GardenStationDef) {
    this.plotPositions = def.plots.slice(0, PLOT_COUNT);
    const n = Math.max(1, this.plotPositions.length);
    this.geo = buildPlantGeometry();
    this.mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72, metalness: 0.05, emissive: 0x1d3a12, emissiveIntensity: 0.5 });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, n);
    this.mesh.name = 'HubGardenPlants';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < n; i++) this.mesh.setColorAt(i, SPROUT);
    ctx.scene.add(this.mesh);
    this.lastBuckets = new Array(n).fill(-2);

    this.interactable = {
      id: 'hub_garden',
      position: def.position.clone(),
      radius: 2.3,
      holdTime: PLANT_HOLD,
      getPrompt: () => this.prompt(),
      canInteract: () => this.canInteract(),
      interact: () => this.interact(),
    };
    ctx.interactables.register(this.interactable);
    this.refreshInstances(Date.now(), 0);
  }

  /* ── state helpers ───────────────────────────────────────────────────────── */
  private counts(now: number): { ready: number; empty: number; growing: number; nextMs: number } {
    let ready = 0, empty = 0, growing = 0, nextMs = Infinity;
    const list = getPlots();
    for (let i = 0; i < this.plotPositions.length; i++) {
      const q = list[i];
      if (!q || q.planted <= 0) { empty++; continue; }
      if (now >= q.ready) ready++;
      else { growing++; nextMs = Math.min(nextMs, q.ready - now); }
    }
    return { ready, empty, growing, nextMs };
  }

  private usable(): boolean {
    return this.ctx.phase === 'hub' && this.ctx.uiBlockers.size === 0;
  }

  private prompt(): string | null {
    if (!this.usable()) return null;
    const c = this.counts(Date.now());
    if (c.ready > 0) return `약초 수확 (${c.ready})`;
    if (c.empty > 0) return '약초 심기';
    const s = Math.max(0, Math.ceil(c.nextMs / 1000));
    return `성장 중 · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  private canInteract(): boolean {
    if (!this.usable()) return false;
    const c = this.counts(Date.now());
    return c.ready > 0 || c.empty > 0;
  }

  private interact(): void {
    const c = this.counts(Date.now());
    if (c.ready > 0) this.harvest();
    else if (c.empty > 0) this.plant();
  }

  /* ── plant / harvest ─────────────────────────────────────────────────────── */
  private growMs(): number {
    const skill = this.ctx.progression?.getSkill?.('gardening') ?? 0;
    const mul = 1 - 0.5 * THREE.MathUtils.clamp(skill / SKILL_LEVEL_MAX, 0, 1);
    return GROW_TIME * 1000 * mul;
  }

  private plant(): void {
    const now = Date.now();
    const span = this.growMs();
    const list = getPlots();
    let n = 0;
    for (let i = 0; i < this.plotPositions.length; i++) {
      const q = list[i];
      if (!q || q.planted > 0) continue;
      q.planted = now;
      q.ready = now + span;
      n++;
    }
    if (n === 0) return;
    savePlots();
    this.colorsDirty = true;
    const mins = Math.max(1, Math.round(span / 60000));
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    this.ctx.bus.emit('ui:notify', { text: `모종 ${n}개를 심었습니다 — 약 ${mins}분 후 수확`, kind: 'info' });
  }

  /** Herb item definitions, discovered at runtime (items/ owns the ids). */
  private herbDefs(): ItemDef[] {
    const all = this.ctx.loot?.getAllItemDefs?.() ?? [];
    return all.filter((d) => d.category === 'herb');
  }

  private harvest(): void {
    const ctx = this.ctx;
    const defs = this.herbDefs();
    if (defs.length === 0 || !ctx.loot) {
      ctx.bus.emit('ui:notify', { text: '약초 데이터를 불러올 수 없습니다', kind: 'warning' });
      return;
    }
    if (!ctx.inventory) {
      ctx.bus.emit('ui:notify', { text: '가방을 사용할 수 없습니다', kind: 'warning' });
      return;
    }
    const mul = ctx.progression?.derived?.gatherYieldMul ?? 1;
    const now = Date.now();
    const list = getPlots();
    let total = 0, full = false;
    for (let i = 0; i < this.plotPositions.length; i++) {
      const q = list[i];
      if (!q || q.planted <= 0 || now < q.ready) continue;
      const def = defs[i % defs.length];
      const qty = Math.max(1, Math.round(BASE_YIELD * mul));
      const item = ctx.loot.createItem(def.id, qty);
      if (!item || !ctx.inventory.tryAddItem(item)) { full = true; break; }
      q.planted = 0; q.ready = 0;
      total += qty;
      ctx.bus.emit('gather:collected', { nodeId: `hub_garden_${i}`, defId: def.id, qty });
    }
    savePlots();
    this.colorsDirty = true;
    if (total > 0) {
      ctx.bus.emit('audio:play', { id: 'ui_equip' });
      ctx.bus.emit('ui:notify', { text: `약초 ${total}개를 수확했습니다`, kind: 'success' });
    }
    if (full) ctx.bus.emit('ui:notify', { text: '가방이 가득 찼습니다', kind: 'warning' });
  }

  /* ── visuals ─────────────────────────────────────────────────────────────── */
  private refreshInstances(now: number, time: number): void {
    const list = getPlots();
    let colorChanged = this.colorsDirty;
    for (let i = 0; i < this.plotPositions.length; i++) {
      const p = this.plotPositions[i];
      const q = list[i];
      const t = q ? progressOf(q, now) : -1;
      if (t < 0) {
        _scale.set(0, 0, 0);
        _pos.copy(p);
        _q.identity();
      } else {
        const grow = 0.22 + 0.78 * t;
        _scale.set(grow, grow, grow);
        _pos.set(p.x, p.y, p.z);
        _e.set(0, i * 1.7 + Math.sin(time * 0.7 + i) * 0.06, Math.sin(time * 0.9 + i * 2.1) * 0.035, 'YXZ');
        _q.setFromEuler(_e);
      }
      _m.compose(_pos, _q, _scale);
      this.mesh.setMatrixAt(i, _m);
      // colour bucket: 0..4 by growth, 5 = ripe
      const bucket = t < 0 ? -1 : t >= 1 ? 5 : Math.floor(t * 5);
      if (bucket !== this.lastBuckets[i]) {
        this.lastBuckets[i] = bucket;
        _col.copy(SPROUT).lerp(RIPE, t < 0 ? 0 : t);
        this.mesh.setColorAt(i, _col);
        colorChanged = true;
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (colorChanged && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.colorsDirty = false;
  }

  update(_dt: number, time: number): void {
    const now = Date.now();
    this.refreshInstances(now, time);
    const c = this.counts(now);
    const speed = this.ctx.progression?.derived?.interactSpeedMul ?? 1;
    const base = c.ready > 0 ? HARVEST_HOLD : PLANT_HOLD;
    this.interactable.holdTime = base / Math.max(0.2, speed);
    this.mat.emissiveIntensity = 0.35 + (c.ready > 0 ? 0.45 + 0.2 * Math.sin(time * 2.4) : 0);
  }

  dispose(): void {
    this.ctx.interactables.unregister(this.interactable.id);
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}
