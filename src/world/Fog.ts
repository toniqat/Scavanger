/**
 * src/world/Fog.ts — **fog of war** (`FogRef`, published as `ctx.world.fog`).
 *
 * One square mask of `MAP_SIZE / FOG_CELL_M` a side is the source, and **a cell once lit never goes dark again
 * before the raid ends**. Every squadmate lights it — every `FOG_UPDATE_HZ` it paints `FOG_REVEAL_RADIUS` around
 * the local player and around every live squadmate in `ctx.net.getRemotePlayers()`. Everyone reads coordinates
 * from the `ps` snapshots that already flow, so **there is no new wire in normal play**; only a late-joining
 * client takes the host's mask through `fogq sync` (`fog sync {mask}` = base64 of `serialize()`).
 *
 * Landmark discovery is decided here too — the first time an extraction console · nest · crate · gather node
 * enters a lit cell it emits `fog:discovered`, and only landmarks (console · nest) raise a `ui:notify` toast.
 * The map · world markers · the compass are all gated on `isDiscovered` alone.
 *
 * It is not built in the training range (`WorldSystem.fog === null`).
 */
import type * as THREE from 'three';
import {
  FOG_CELL_M, FOG_REVEAL_RADIUS, FOG_UPDATE_HZ, MAP_SIZE,
  type FogRef, type GameContext, type PeerId,
} from '@/shared';

/** `fog:discovered.kind` — the same names as the map marker kinds. `structure` · `rail` were added on 2026-09-09. */
type DiscoverKind = 'extraction' | 'nest' | 'crate' | 'outpost' | 'gather' | 'structure' | 'rail'
  /* 2026-09-13: rover stations (the sign pole spot). The toast is owned by ui/ — it is not listed in `TOAST` here */
  | 'rover';

/**
 * The kinds that raise a discovery toast and their wording (crates · gather nodes are far too frequent — event only).
 * ⚠ **`structure` · `rail` are deliberately absent** — their toasts are owned by `ui/hud/RaidAlerts`
 * (2026-09-09). Listing them here too would show the same discovery twice. world/ only emits the event.
 */
const TOAST: Partial<Record<DiscoverKind, string>> = {
  extraction: '탈출 신호소 발견',
  nest: '벌레 둥지 발견',
  // 2026-09-11 (C-11): '전초기지' would be confused with the enterable structure (`StructureKind 'outpost'` = 버려진 전진기지)
  outpost: '폐허 전초 발견',
};

/** 2026-09-11 (C-11): the minimum shape of a POI ruin the discovery check needs (`Outposts.OutpostSite`). */
interface OutpostSpot { readonly id: string; readonly position: THREE.Vector3 }

/** base64 encode (the bit-packed mask — 6400 cells is 800 bytes → about 1.1 KB of base64). */
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(data: string): Uint8Array | null {
  try {
    const s = atob(data);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch { return null; }
}

export class Fog implements FogRef {
  readonly cells: number;
  readonly cellSize = FOG_CELL_M;
  readonly mask: Uint8Array;
  revision = 0;

  private revealed = 0;
  private readonly half = MAP_SIZE / 2;
  private ctx: GameContext | null = null;
  private timer = 0;
  private grew = false;
  /** Object ids whose discovery was already announced. */
  private readonly seen = new Set<string>();
  /** Kinds that raised a toast this tick (one nest is 3~4 holes, which would otherwise raise that many toasts). */
  private readonly toasted = new Set<DiscoverKind>();
  private readonly unsubs: Array<() => void> = [];
  private netHooked = false;
  /**
   * 2026-09-11 (C-11): POI ruins. `WorldRef` has no list (they are not mixed into the structures), so `WorldSystem`
   * hands them over. On discovery: `fog:discovered {kind:'outpost'}` + a toast — the map stacks that event into an icon.
   */
  private outposts: readonly OutpostSpot[] = [];
  /**
   * 2026-09-13: rover stations. A station is discovered even with no vehicle (`ctx.world.rover`) · even when it is
   * destroyed — so `WorldSystem` hands them over from the dirt road (`RoverRoad.route`), not `RoverRef`.
   */
  private roverStations: readonly { readonly id: string; readonly polePosition: THREE.Vector3 }[] = [];

  constructor() {
    this.cells = Math.max(1, Math.ceil(MAP_SIZE / FOG_CELL_M));
    this.mask = new Uint8Array(this.cells * this.cells);
  }

  get explored(): number {
    const total = this.cells * this.cells;
    return total > 0 ? this.revealed / total : 0;
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /** Called by `WorldSystem.generate` at mission start. A client asks the host for the mask so far. */
  attach(ctx: GameContext): void {
    this.ctx = ctx;
    this.ensureNet();
    this.requestSync();
  }

  /** Mission end (`game:abort` / the next mission). Drops the mask · the discovery record · the net subscriptions. */
  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.netHooked = false;
    this.mask.fill(0);
    this.revealed = 0;
    this.revision = 0;
    this.seen.clear();
    this.outposts = [];
    this.roverStations = [];
    this.ctx = null;
  }

  /** 2026-09-11 (C-11): this map's POI ruins (`WorldSystem.generate`). */
  setOutposts(sites: readonly OutpostSpot[]): void { this.outposts = sites; }
  /** 2026-09-13: this map's rover stations (`WorldSystem.generate`, an empty array with no dirt road). */
  setRoverStations(stations: readonly { readonly id: string; readonly polePosition: THREE.Vector3 }[]): void {
    this.roverStations = stations;
  }

  /* ── queries ───────────────────────────────────────────────────────── */

  private index(x: number, z: number): number {
    const cx = Math.floor((x + this.half) / this.cellSize);
    const cz = Math.floor((z + this.half) / this.cellSize);
    if (cx < 0 || cz < 0 || cx >= this.cells || cz >= this.cells) return -1;
    return cz * this.cells + cx;
  }

  isRevealed(x: number, z: number): boolean {
    const i = this.index(x, z);
    return i < 0 ? true : this.mask[i] !== 0;      // there is nothing to hide outside the map
  }

  isDiscovered(position: THREE.Vector3): boolean {
    return this.isRevealed(position.x, position.z);
  }

  /* ── painting ──────────────────────────────────────────────────────── */

  reveal(x: number, z: number, radius: number): void {
    if (radius <= 0) return;
    const s = this.cellSize;
    const c0 = Math.max(0, Math.floor((x - radius + this.half) / s));
    const c1 = Math.min(this.cells - 1, Math.floor((x + radius + this.half) / s));
    const r0 = Math.max(0, Math.floor((z - radius + this.half) / s));
    const r1 = Math.min(this.cells - 1, Math.floor((z + radius + this.half) / s));
    const r2 = radius * radius;
    let grew = false;
    for (let cz = r0; cz <= r1; cz++) {
      const wz = -this.half + (cz + 0.5) * s - z;
      const row = cz * this.cells;
      for (let cx = c0; cx <= c1; cx++) {
        const i = row + cx;
        if (this.mask[i] !== 0) continue;
        const wx = -this.half + (cx + 0.5) * s - x;
        if (wx * wx + wz * wz > r2) continue;
        this.mask[i] = 255;
        this.revealed++;
        grew = true;
      }
    }
    if (grew) { this.revision++; this.grew = true; }
  }

  /**
   * Called every frame, but the actual painting happens once per `FOG_UPDATE_HZ`.
   * The sight of the local player + every live remote squadmate is unioned.
   */
  update(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / Math.max(1, FOG_UPDATE_HZ);
    this.ensureNet();

    const p = ctx.player;
    if (p && !p.isDead) this.reveal(p.position.x, p.position.z, FOG_REVEAL_RADIUS);
    const net = ctx.net;
    if (net && ctx.isMultiplayer) {
      for (const r of net.getRemotePlayers()) {
        // Only live squadmates inside the same mission (someone in the hub · a fully dead player lights nothing)
        if (!r.inMission || r.isDead) continue;
        if (!r.connected && !r.suspended) continue;
        this.reveal(r.position.x, r.position.z, FOG_REVEAL_RADIUS);
      }
    }

    this.scanDiscoveries(ctx);
    if (this.grew) {
      this.grew = false;
      ctx.bus.emit('fog:revealed', { revision: this.revision, explored: this.explored });
    }
  }

  /* ── discovery gate ────────────────────────────────────────────────── */

  private scanDiscoveries(ctx: GameContext): void {
    const world = ctx.world;
    if (!world?.ready) return;
    this.toasted.clear();
    for (const e of world.getExtractionPoints()) this.discover('extraction', e.id, e.position);
    // `getNestPositions()` is one entry per **hole**, and a nest's holes are metres apart — they all cross the
    // reveal boundary in the same tick, so the per-tick `toasted` filter turns 3–4 of them into one discovery toast.
    const nests = world.getNestPositions();
    for (let i = 0; i < nests.length; i++) this.discover('nest', `nest_${i}`, nests[i]);
    for (const c of world.getCrates()) this.discover('crate', c.id, c.position);
    const nodes = world.getGatherNodes?.();
    if (nodes) for (const g of nodes) this.discover('gather', g.id, g.position);
    // 2026-09-09: abandoned structures and rails · platforms. The toast is raised by ui/ (see the `TOAST` comment above).
    for (const st of world.getStructures()) this.discover('structure', st.id, st.position);
    // 2026-09-11 (C-11): POI ruins — `'outpost'` was in the contract but nobody emitted it
    for (const o of this.outposts) this.discover('outpost', o.id, o.position);
    for (const line of world.getRailLines()) {
      for (const p of line.platforms) this.discover('rail', p.id, p.position);
    }
    // 2026-09-13: rover stations — once the sign pole spot is lit
    for (const st of this.roverStations) this.discover('rover', st.id, st.polePosition);
  }

  private discover(kind: DiscoverKind, id: string, position: THREE.Vector3): void {
    if (this.seen.has(id) || !this.isDiscovered(position)) return;
    this.seen.add(id);
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.bus.emit('fog:discovered', { kind, id, position });
    const text = TOAST[kind];
    if (!text || this.toasted.has(kind)) return;      // one toast per kind per tick
    this.toasted.add(kind);
    ctx.bus.emit('ui:notify', { text, kind: 'info', duration: 2.2 });
  }

  /* ── serialization (late-joining clients) ──────────────────────────── */

  serialize(): string {
    const bytes = new Uint8Array(Math.ceil(this.mask.length / 8));
    for (let i = 0; i < this.mask.length; i++) {
      if (this.mask[i] !== 0) bytes[i >> 3] |= 1 << (i & 7);
    }
    return toBase64(bytes);
  }

  applySerialized(data: string): void {
    const bytes = fromBase64(data);
    if (!bytes || bytes.length < Math.ceil(this.mask.length / 8)) return;
    let grew = false;
    for (let i = 0; i < this.mask.length; i++) {
      if ((bytes[i >> 3] & (1 << (i & 7))) === 0 || this.mask[i] !== 0) continue;
      this.mask[i] = 255;
      this.revealed++;
      grew = true;
    }
    if (!grew) return;
    this.revision++;
    this.ctx?.bus.emit('fog:revealed', { revision: this.revision, explored: this.explored });
  }

  /* ── multiplayer (host authority, late joins only) ─────────────────── */

  private ensureNet(): void {
    const ctx = this.ctx;
    const net = ctx?.net;
    if (!ctx || !net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('fog', (m) => {
        if (m.ev === 'sync' && !ctx.net?.isHost) this.applySerialized(m.mask);
      }),
      net.onMessage('fogq', (m, from) => {
        if (m.ev === 'sync' && ctx.net?.isHost) this.sendSync(from);
      }),
      net.onMessage('flow', (m, from) => {
        if (m.ev === 'rejoined' && ctx.net?.isHost) this.sendSync(from);
      }),
      // The promoted host has never seen this mask — instead this client receives it again from the new host
      ctx.bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost) this.requestSync(); }),
    );
  }

  private requestSync(): void {
    const ctx = this.ctx;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
    net.send({ t: 'fogq', ev: 'sync' }, 'host');
  }

  private sendSync(to: PeerId): void {
    const ctx = this.ctx;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer) return;
    net.send({ t: 'fog', ev: 'sync', mask: this.serialize() }, to);
  }
}
