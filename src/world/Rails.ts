/**
 * src/world/Rails.ts — **the rail · the platforms · the tram**.
 *
 * Placed per map with `RAIL_CHANCE`, in one of two shapes — a **loop rail** (`loop`) around the map edge and a
 * **straight back-and-forth rail** (`line`) across it. It is **transport** and the farming spot is the **platform**:
 * loot the platform containers, then start it at the **cab console** with a `TRAM_START_HOLD_S` hold to the next one.
 *
 * Owns the contract: `RailLineDef` · `RailPlatformDef` · `TramDef` · `TramState` · `WorldRef.getRailLines / getTrams`
 * · `rail:tramStarted` / `rail:tramDocked` · `TramMessage`(`tram`) / `TramRequest`(`tramq`) · `RAIL_*` / `TRAM_*`.
 *
 * **The rail does not flatten terrain** — the piers make up the height (flattening would leave a 1 km runway through
 * the middle of the map). Only the platform spots are flattened, and `layout.ts` picks those pads.
 *
 * The tram's real state is **its arc position `s`, one number**, and it is **host-authoritative**. The path is seed
 * deterministic, so only `s` · direction · state go on the wire (once every `TRAM_NET_INTERVAL`).
 *
 * ## 2026-09-10 batch
 * - **It stops on arrival.** The automatic restart after docking is gone — the next departure must be a console press (`docked` in `update`).
 * - **The console is inside the cab** (`parts/Tram`).
 * - **The platform pole is the 「전차 호출」 console** (2026-09-10, second batch). Once the ignition moved into the
 *   car there was no way to call the tram from a platform, so that pole became a console that **only calls** —
 *   departing still means boarding and pressing the cab console. A call **reuses the existing departure procedure**
 *   (`applyStart` → notice → `TRAM_START_DELAY_S` wait → `TRAM_ACCEL_S` acceleration → `checkDock` → `idle`).
 * - **The body is long along the travel direction.** The axis convention and the bug before it are in `rails/model`'s comment.
 * - **Being hit by a tram near top speed costs damage + knockback** (`parts/Tram.updateTramHit`).
 * - Geometry · placement · collision all moved down to `rails/parts/`. What is left here is **lifecycle · state machine · multiplayer**.
 *
 * ## 2026-09-18 batch (user's decision)
 * - **The tram never turns around.** The body faces one way all raid and the round trip runs forwards · backwards (`parts/Tram.placeTram`).
 * - **A cab console at each end** (`TRAM_CONSOLE_IDS`) — both are the one `requestStart` → `applyStart` procedure.
 * - **Cabin containers are gone** — this file's container set (`ContainerSet`) now takes in **platform ones only**.
 */
import * as THREE from 'three';
import {
  Layers, TRAM_ACCEL_S, TRAM_CALL_HOLD_S, TRAM_CALL_RANGE, TRAM_DEPART_NOTICE_RANGE, TRAM_DOCK_S, TRAM_SPEED,
  TRAM_START_DELAY_S, TRAM_STATES,
  type GameContext, type PeerId, type RailLineDef, type RailPlatformDef,
  type TramDef, type TramMessage, type TramRequest, type TramState, type TramWire,
  type ItemInstance,
} from '@/shared';
import { merge, type BuildCtx } from './build';
import type { SpatialHash } from './SpatialHash';
import {
  CONSOLE_GLOW, CONSOLE_GLOW_BASE, DOCK_WINDOW, PLATFORM_OFFSET, RAIL_MAX_GRADE, RAIL_DECK_Y, TRAM_FLOOR_UP,
  TRAM_NET_INTERVAL, TRAM_SNAP_M, type RailBuild, type RailPath, type TramInst,
  deltaS, makePath, nearestS, sampleAt, wrapS,
} from './rails/model';
import { buildTrack } from './rails/parts/Track';
import { buildPlatform } from './rails/parts/Platform';
import { TRAM_CONSOLE, buildTram, placeTram, updateTramHit } from './rails/parts/Tram';
import { ContainerSet, type ContainerSpec } from './structures/parts/Containers';
import { structureRow } from './structures/model';

/**
 * The cab console's `Interactable` id — a constant, because there is only one tram.
 *
 * 2026-09-18: two of them, **one at each end** (index = the index into `TramInst.consolePos`: 0 = the local +X end).
 * The first id is unchanged — `scripts/smoke-structures.mjs` finds the cab console by that string.
 */
const TRAM_CONSOLE_IDS = ['rail:tram_rail_0:console', 'rail:tram_rail_0:console2'] as const;
/** The platform call console's `Interactable` id. */
const callConsoleId = (platformId: string): string => `rail:${platformId}:call`;
/**
 * A departure starting within this time (seconds) of a local call does not raise 「곧 출발합니다」 (2026-09-10).
 * 「전차를 호출했다」, one line, is enough for the caller. A client only sees a departure start once the host's
 * `tram state` comes back, so it covers that round trip generously — network slack, not a balance number (like `TRAM_SNAP_M`).
 */
const CALL_NOTICE_MUTE_S = 3;

/**
 * What the call console can do right now.
 * - `ready` — can be called (the tram is standing, and not here)
 * - `here`  — already standing at this platform (nothing to call)
 * - `busy`  — running (cannot be called until it arrives)
 */
type CallState = 'ready' | 'here' | 'busy';

export class Rails {
  readonly group = new THREE.Group();
  private path: RailPath | null = null;
  private line: RailLineDef | null = null;
  private platformS: number[] = [];
  /** Each platform's call console spot (the deny sound plays there). Indexed like `platformS`. */
  private callPos: THREE.Vector3[] = [];
  private tram: TramInst | null = null;
  private readonly containers = new ContainerSet('RailContainers');
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private hash: SpatialHash | null = null;
  private game: GameContext | null = null;
  private built = false;
  private netHooked = false;
  private netTimer = 0;
  /** In `ctx.time` — a departure started before this moment does not raise 「곧 출발합니다」 (a local call just happened). */
  private callNoticeUntil = -Infinity;
  private readonly unsubs: Array<() => void> = [];

  // scratch (no per-frame allocation on the hot path)
  private readonly sPos = new THREE.Vector3();
  private readonly sTan = new THREE.Vector3();

  constructor() { this.group.name = 'Rails'; }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  attach(game: GameContext): void {
    this.game = game;
    this.ensureNet();
  }

  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.netHooked = false;
    this.game = null;
  }

  getLines(): readonly RailLineDef[] { return this.line ? [this.line] : []; }
  getTrams(): readonly TramDef[] { return this.tram ? [this.tram.def] : []; }

  build(ctx: BuildCtx, game: GameContext): void {
    this.game = game;
    this.hash = ctx.hash;
    this.ensureNet();
    this.built = true;
    const plan = ctx.layout.rail;
    if (!plan) return;
    const rng = ctx.rng.fork('rails');

    /* ── Centreline: sample the terrain height, then smooth it so the rail does not ripple up and down ── */
    const loop = plan.kind === 'loop';
    const n = loop ? 72 : Math.max(8, Math.round((plan.extent * 2) / 12));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const t = loop ? i / n : i / (n - 1);
      const x = loop ? Math.cos(plan.angle + t * Math.PI * 2) * plan.extent : Math.cos(plan.angle) * (t * 2 - 1) * plan.extent;
      const z = loop ? Math.sin(plan.angle + t * Math.PI * 2) * plan.extent : Math.sin(plan.angle) * (t * 2 - 1) * plan.extent;
      pts.push(new THREE.Vector3(x, ctx.terrain.getHeightAt(x, z), z));
    }
    for (let pass = 0; pass < 4; pass++) {
      const src = pts.map((p) => p.y);
      for (let i = 0; i < n; i++) {
        const a = src[loop ? (i - 1 + n) % n : Math.max(0, i - 1)];
        const b = src[i];
        const c = src[loop ? (i + 1) % n : Math.min(n - 1, i + 1)];
        pts[i].y = (a + 2 * b + c) / 4;
      }
    }
    for (const p of pts) p.y += RAIL_DECK_Y;

    /* ── 2026-09-10: **lift the rail so it is not buried in the ground** ─────────────────────────
     * The smoothing above only tidies the sample points' heights. Sample spacing is over 20 m, so on a stretch crossing
     * a hill the centreline dropped **below** the terrain between two points and the ties sank into the soil (the piers
     * were squashed to `max(0.4, …)` and invisible). Each point here measures the **terrain maximum over its own two
     * neighbouring stretches** and is pulled `RAIL_DECK_Y` above it. **It is never lowered** — lowering buries it again. */
    {
      const groundMax = (i: number, j: number): number => {
        const a = pts[i], b = pts[j];
        let g = -Infinity;
        for (let k = 0; k <= 6; k++) {
          const t = k / 6;
          g = Math.max(g, ctx.terrain.getHeightAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t));
        }
        return g;
      };
      const prevOf = (i: number): number => (loop ? (i - 1 + n) % n : Math.max(0, i - 1));
      const nextOf = (i: number): number => (loop ? (i + 1) % n : Math.min(n - 1, i + 1));
      const need = new Array<number>(n);
      for (let i = 0; i < n; i++) need[i] = Math.max(groundMax(prevOf(i), i), groundMax(i, nextOf(i))) + RAIL_DECK_Y;
      for (let i = 0; i < n; i++) pts[i].y = Math.max(pts[i].y, need[i]);
      /* Lifting creates a step against the neighbours — an **upward-only** smoothing limits the grade. */
      let per = 0;
      const segs = loop ? n : n - 1;
      for (let i = 0; i < segs; i++) { const a = pts[i], b = pts[(i + 1) % n]; per += Math.hypot(b.x - a.x, b.z - a.z); }
      const maxStep = Math.max(0.2, (per / Math.max(1, segs)) * RAIL_MAX_GRADE);
      for (let pass = 0; pass < 6; pass++) {
        for (let i = 0; i < n; i++) pts[i].y = Math.max(pts[i].y, pts[prevOf(i)].y - maxStep, pts[nextOf(i)].y - maxStep);
      }
    }

    const path = makePath(pts, loop);
    this.path = path;

    const railMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.6 });
    this.mats.push(railMat);
    const out: RailBuild = { geos: this.geos, group: this.group, mat: railMat, glow: [] };
    buildTrack(ctx, rng, path, out);

    /* ── Platforms ──────────────────────────────────────────────────── */
    const platRow = structureRow('rail_platform');
    const platforms: RailPlatformDef[] = [];
    const specs: ContainerSpec[] = [];
    plan.platforms.forEach((pad, i) => {
      const s = nearestS(path, pad.x, pad.z);
      this.platformS.push(s);
      sampleAt(path, s, this.sPos, this.sTan);
      const yaw = Math.atan2(this.sTan.z, this.sTan.x);
      // Deck centre, stepped sideways off the rail
      const ax = -Math.sin(yaw), az = Math.cos(yaw);
      const cx = this.sPos.x + ax * PLATFORM_OFFSET, cz = this.sPos.z + az * PLATFORM_OFFSET;
      const deckTop = this.sPos.y + TRAM_FLOOR_UP;
      const id = `plat_${i}`;
      const def: RailPlatformDef = {
        id, position: new THREE.Vector3(cx, deckTop, cz), yaw,
        radius: platRow ? Math.hypot(platRow.halfW, platRow.halfD) : 8,
      };
      platforms.push(def);
      const conPos = buildPlatform(ctx, rng, def, platRow, pad.height, deckTop, yaw, ax, az, specs, out);
      this.callPos.push(conPos);
      this.registerCall(game, def, conPos, i);
    });

    /* The call consoles' glow pieces merge into **one** mesh instead of one per platform (+1 draw call). */
    if (out.glow.length > 0) {
      const glowMat = new THREE.MeshStandardMaterial({
        color: CONSOLE_GLOW_BASE, emissive: CONSOLE_GLOW, emissiveIntensity: 1.5, roughness: 0.4,
      });
      this.mats.push(glowMat);
      const glowGeo = merge(out.glow);
      this.geos.push(glowGeo);
      const glowMesh = new THREE.Mesh(glowGeo, glowMat);
      glowMesh.layers.enable(Layers.PROP);
      // The name must start with `rail_` — `scripts/smoke-structures.mjs` collects the rail silhouette by that prefix.
      glowMesh.name = 'rail_console_glow';
      this.group.add(glowMesh);
      out.glow.length = 0;
    }

    this.line = {
      id: 'rail_0', kind: plan.kind, points: pts, length: path.total, platforms,
    };

    /* ── Tram ───────────────────────────────────────────────────────── */
    const startS = this.platformS.length > 0 ? this.platformS[0] : 0;
    const inst = buildTram(ctx, rng, startS, this.platformS.length > 0 ? 'plat_0' : null, out);
    this.tram = inst;
    placeTram(inst, path, 0, this.hash);
    this.registerConsole(game, inst);

    this.containers.build(ctx, game, specs);
    ctx.root.add(this.group);
    this.requestSync();
  }

  dispose(): void {
    const game = this.game;
    this.containers.dispose();
    for (const id of TRAM_CONSOLE_IDS) game?.interactables.unregister(id);
    for (const p of this.line?.platforms ?? []) game?.interactables.unregister(callConsoleId(p.id));
    this.platformS.length = 0;
    this.callPos.length = 0;
    this.tram = null;
    this.line = null;
    this.path = null;
    for (const g of this.geos) g.dispose();
    this.geos = [];
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.hash = null;
    this.group.clear();
    this.group.removeFromParent();
    this.built = false;
  }

  /* ── Cab console (2026-09-10 — from the platform into the car) ──────
   * `Interactable.position` is `inst.consolePos[i]`, **that very object** — `placeTram` fixes it in place every
   * frame, so the aim follows it even while running.
   *
   * 2026-09-18 (user's decision): register **one at each end**. Now that the body does not turn around, one console
   * would be left at the tail for half of every run. Both call **exactly the same procedure** (`requestStart` →
   * `applyStart`) — no new wire, and no 「which console was pressed」 state. */
  private registerConsole(game: GameContext, inst: TramInst): void {
    TRAM_CONSOLE_IDS.forEach((id, i) => {
      game.interactables.register({
        id,
        position: inst.consolePos[i],
        radius: TRAM_CONSOLE.radius,
        holdTime: TRAM_CONSOLE.holdTime,
        // 2026-09-10: the console is a device that glows on its own — no detection light pillar (`ui/hud/Detection`).
        hidePillar: true,
        getPrompt: () => (this.tram && this.tram.def.state !== 'moving' ? '전차 시동 (E)' : null),
        canInteract: () => !!this.game?.isGameplayActive() && this.tram?.def.state !== 'moving',
        interact: () => this.requestStart(),
      });
    });
  }

  /* ── Platform call console (2026-09-10 — it 「only calls」) ───────────────
   * The state shows **through the prompt and the hold time**: when it cannot be called the hold is 0, so pressing
   * gives the deny sound + a reason toast at once (the same rule as the basement hatch — nobody is refused after
   * filling the gauge). That is why `canInteract` is not dropped to false: `findBest` would filter it out entirely
   * and **not even the prompt would appear** — leaving no way to know why the tram is not coming. */
  private registerCall(game: GameContext, def: RailPlatformDef, pos: THREE.Vector3, index: number): void {
    const self = this;
    game.interactables.register({
      id: callConsoleId(def.id),
      position: pos,
      radius: TRAM_CALL_RANGE,
      get holdTime(): number { return self.callState(index) === 'ready' ? TRAM_CALL_HOLD_S : 0; },
      hidePillar: true,   // 2026-09-10: no detection light pillar on the call console either (its glow band already marks it)
      getPrompt: () => {
        switch (self.callState(index)) {
          case 'ready': return '전차 호출 (E)';
          case 'here': return '전차 대기 중 — 타서 운전실 콘솔로 출발';
          default: return '전차 운행 중 — 정차하면 부를 수 있다';
        }
      },
      canInteract: () => !!self.game?.isGameplayActive() && !!self.tram,
      interact: () => self.requestCall(index),
    });
  }

  /** What this platform's call console can do right now. */
  private callState(index: number): CallState {
    const inst = this.tram, path = this.path;
    if (!inst || !path || index >= this.platformS.length) return 'busy';
    if (inst.def.state === 'moving') return 'busy';
    // Uses the **same window** as the dock judgement (`checkDock`) — a tram visibly standing here never reads as "can call".
    if (Math.abs(deltaS(path, inst.def.s, this.platformS[index])) <= DOCK_WINDOW) return 'here';
    return 'ready';
  }

  /* ── update ───────────────────────────────────────────────────────── */

  /** 2026-09-11: called when a platform container is opened for the first time on this client (2026-09-18: the tram's are gone). */
  setOpenListener(cb: ((id: string) => void) | null): void { this.containers.setOpenListener(cb); }
  /** 2026-09-11: show a container a squadmate opened in its opened look. False when it is not in this set. */
  markContainerOpened(id: string): boolean { return this.containers.markOpened(id); }
  /** 2026-09-11 (C-57): a platform container's position (null with none). */
  containerPositionOf(id: string): THREE.Vector3 | null { return this.containers.positionOf(id); }
  /** 2026-09-15 (androids): hands this set's containers over one by one (`WorldRef.getLootContainers`). */
  collectContainers(push: (id: string, position: THREE.Vector3, tier: number, opened: boolean) => void): void { this.containers.collect(push); }
  /** 2026-09-12 (C): what a platform container yields on its first open (`WorldRef.previewContainerItems`), null with none. */
  previewContainerItems(id: string): ItemInstance[] | null { return this.containers.preview(id); }

  update(dt: number, time: number): void {
    if (!this.built) return;
    this.containers.update(dt, time);
    const inst = this.tram, path = this.path;
    if (!inst || !path) return;
    const ctx = this.game;
    const host = !ctx?.isMultiplayer || !ctx.net || ctx.net.isHost;

    let speed = 0;
    if (inst.def.state === 'moving') {
      inst.runT += dt;
      speed = this.tramSpeed(inst);
      inst.def.s = wrapS(path, inst.def.s + speed * inst.def.dir * dt);
      // A line rail turns back at its ends. The direction flips **only while running into an end** — with the
      // condition on `s <= 0` alone it would flip every frame and the tram would shiver in place.
      if (!path.loop) {
        if (inst.def.s <= 0 && inst.def.dir === -1) inst.def.dir = 1;
        else if (inst.def.s >= path.total && inst.def.dir === 1) inst.def.dir = -1;
      }
    } else if (inst.def.state === 'docked') {
      /* 2026-09-10 — **there is no automatic restart** (user report: it left again without the console being touched).
       * `TRAM_DOCK_S` is now only how long the "docked" notice stays up; after it the tram settles to `idle` and
       * **stands there until the cab console is pressed again.** Both states are `state !== 'moving'`, so the
       * console is pressable from either. */
      inst.dockTimer -= dt;
      if (host && inst.dockTimer <= 0) {
        inst.dockTimer = 0;
        inst.def.state = 'idle';
        ctx?.bus.emit('rail:tramDocked', { tramId: inst.def.id, platformId: inst.lastDock, docked: false });
        this.broadcastState();
      }
    }

    if (host && inst.def.state === 'moving') this.checkDock(inst, path);
    if (!host) {
      // Pulled smoothly toward the host's `s` (the path is identical, so the error is only the latency)
      const d = deltaS(path, inst.def.s, inst.targetS);
      if (Math.abs(d) > TRAM_SNAP_M) inst.def.s = inst.targetS;
      else inst.def.s = wrapS(path, inst.def.s + d * Math.min(1, dt * 4));
    }

    placeTram(inst, path, speed, this.hash);
    updateTramHit(ctx, inst, speed);

    if (host && ctx?.isMultiplayer && ctx.net) {
      this.netTimer -= dt;
      if (this.netTimer <= 0) { this.netTimer = TRAM_NET_INTERVAL; this.broadcastState(); }
    }
  }

  /**
   * 2026-09-10 — **a departure is a notice → a 1 s wait → a 3 s acceleration** (user's decision). It used to leap
   * to `TRAM_SPEED` on the very frame the ignition was pressed, which dropped anyone standing on the deck.
   * Here only `runT` is rewound and one notice is raised — the real braking / acceleration curve is `tramSpeed`.
   * Both the host and the clients call it (clients from `applyWire`).
   */
  private beginRun(inst: TramInst): void {
    inst.runT = -TRAM_START_DELAY_S;
    if (this.nearDeparture(inst)) this.game?.bus.emit('ui:notify', { text: '전차가 곧 출발합니다', kind: 'info' });
  }

  /**
   * 2026-09-10 — 「전차가 곧 출발합니다」 shows **only to someone next to the departing tram** (user's decision).
   * "About to leave" is the wrong thing to tell a caller on a far platform — they already got 「전차를 호출했다」.
   *
   * Next to = the distance outside the body's cross-section (OBB) is within `TRAM_DEPART_NOTICE_RANGE` (a rider is
   * at 0 and so always counts; it reaches the platform deck beside it and the foot of its stairs). Each client
   * judges **with its own player**, so the wire is unchanged. After a local call (`callNoticeUntil`) it stays quiet.
   */
  private nearDeparture(inst: TramInst): boolean {
    const ctx = this.game;
    const p = ctx?.player;
    if (!ctx || !p || p.isDead) return false;
    if (ctx.time < this.callNoticeUntil) return false;
    const c = Math.cos(inst.def.yaw), s = Math.sin(inst.def.yaw);
    const dx = p.position.x - inst.def.position.x, dz = p.position.z - inst.def.position.z;
    const ox = Math.max(0, Math.abs(dx * c + dz * s) - inst.halfLen);
    const oz = Math.max(0, Math.abs(-dx * s + dz * c) - inst.halfWid);
    return Math.hypot(ox, oz) <= TRAM_DEPART_NOTICE_RANGE;
  }

  /**
   * The current speed (m/s). While `runT` is negative the tram still stands (waiting out the departure notice);
   * after that it rises to `TRAM_SPEED` over `TRAM_ACCEL_S` by a **cubic ease-in** (t³) — not linear, it builds up.
   */
  private tramSpeed(inst: TramInst): number {
    if (inst.runT <= 0) return 0;
    const t = Math.min(1, inst.runT / Math.max(0.001, TRAM_ACCEL_S));
    return TRAM_SPEED * t * t * t;
  }

  private checkDock(inst: TramInst, path: RailPath): void {
    const ctx = this.game;
    for (let i = 0; i < this.platformS.length; i++) {
      const id = `plat_${i}`;
      const d = deltaS(path, inst.def.s, this.platformS[i]);
      if (Math.abs(d) > DOCK_WINDOW) {
        if (inst.lastDock === id && Math.abs(d) > DOCK_WINDOW * 2.5) inst.lastDock = null;
        continue;
      }
      if (inst.lastDock === id) continue;
      inst.def.s = this.platformS[i];
      inst.def.state = 'docked';
      inst.dockTimer = TRAM_DOCK_S;
      inst.runT = 0;
      inst.lastDock = id;
      ctx?.bus.emit('rail:tramDocked', { tramId: inst.def.id, platformId: id, docked: true });
      ctx?.bus.emit('audio:play', { id: 'tram_dock', position: inst.def.position });
      this.broadcastState();
      return;
    }
  }

  /* ── Ignition (host-authoritative) ────────────────────────────────── */

  private requestStart(): void {
    const ctx = this.game;
    const inst = this.tram;
    if (!ctx || !inst || inst.def.state === 'moving') return;
    const net = ctx.net;
    // 2026-09-14 (NPC quest interact): tram ignition — on a client at request time (the host's `tram state` does not say who started it)
    ctx.bus.emit('world:interacted', { kind: 'tram', id: inst.def.id });
    if (ctx.isMultiplayer && net && !net.isHost) { net.send({ t: 'tramq', ev: 'start', id: inst.def.id }, 'host'); return; }
    this.applyStart(net?.localId ?? null);
  }

  /**
   * **The call** — departs with this platform as the destination (2026-09-10).
   *
   * It builds no new path: it only picks the direction toward the destination and goes straight into `applyStart`,
   * so notice → `TRAM_START_DELAY_S` wait → `TRAM_ACCEL_S` acceleration → `checkDock` → `docked` → `idle` is
   * **exactly the same procedure** as the cab console. A called tram therefore also stops where it arrives.
   *
   * **A duplicate call is refused** (neither ignored nor queued). Queuing would leave the presser waiting with no
   * idea why it is not coming, and would revive the 2026-09-10 bug where an arrived tram left again untouched.
   * While it is running `applyStart` refuses anyway, so showing the refusal **the moment it is pressed** is the
   * honest answer — once it docks it can be called again immediately.
   */
  private requestCall(index: number): void {
    const ctx = this.game;
    const inst = this.tram;
    if (!ctx || !inst) return;
    const state = this.callState(index);
    const at = this.callPos[index] ?? inst.def.position;
    if (state !== 'ready') {
      // 2026-09-11 (C-39): a deny sound of the call's own — it used to borrow the basement card reader's `keycard_deny`.
      ctx.bus.emit('audio:play', { id: 'tram_deny', position: at });
      ctx.bus.emit('ui:notify', {
        text: state === 'here' ? '전차가 이미 이 승강장에 있다' : '전차가 운행 중이다 — 정차한 뒤에 다시 부른다',
        kind: 'warning', duration: 2.2,
      });
      return;
    }
    /* 2026-09-10: the caller gets **only the one line 「전차를 호출했다」** — the same in single player, host and client.
     * The departure that follows (`beginRun`) is muted briefly so 「곧 출발합니다」 does not stack on it (`nearDeparture`). */
    this.callNoticeUntil = ctx.time + CALL_NOTICE_MUTE_S;
    ctx.bus.emit('ui:notify', { text: '전차를 호출했다', kind: 'info', duration: 2 });
    /* 2026-09-11 (C-39): the call-accepted chime — it plays **at the caller's console spot, on this client only**. The
     * departure sound `tram_start` comes from the tram's position, so distance falloff hid it from a caller on the far platform.
     * A client plays it optimistically without waiting for the host's answer (like the toast — a refusal just means no departure sound). */
    ctx.bus.emit('audio:play', { id: 'tram_call', position: at });
    ctx.bus.emit('world:interacted', { kind: 'tram', id: inst.def.id });   // 2026-09-14: tram call (NPC quest interact)
    const net = ctx.net;
    if (ctx.isMultiplayer && net && !net.isHost) {
      /* The wire has no destination field (`TramRequest` is contract and this batch does not touch `src/shared`).
       * The host reads the destination from the **requester's position** — `targetSFor`. */
      net.send({ t: 'tramq', ev: 'start', id: inst.def.id }, 'host');
      return;
    }
    this.applyStart(net?.localId ?? null, this.platformS[index]);
  }

  /**
   * The arc position of the platform **nearest the requester** — where a call's destination is resolved with no wire.
   * Someone pressing the cab console sits inside a docked tram, so that tram's own platform is picked; destination =
   * the current spot, which keeps the direction as it was (= the old behaviour). Null when the position is unknown.
   */
  private targetSFor(peer: PeerId): number | null {
    const net = this.game?.net;
    const line = this.line;
    if (!net || !line || this.platformS.length === 0) return null;
    const ref = net.getRemotePlayers().find((r) => r.id === peer);
    if (!ref) return null;
    let best = -1, bestD = Infinity;
    line.platforms.forEach((p, i) => {
      const d = Math.hypot(p.position.x - ref.position.x, p.position.z - ref.position.z);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best >= 0 ? this.platformS[best] : null;
  }

  /**
   * @param targetS the arc position to take as the destination (a call). Null keeps the current direction (cab console).
   *   **On a `loop` the direction is left alone** — the contract (`shared/types`) states that `TramDef.dir` is always
   *   +1 on a loop rail, and with only two platforms going round as it is still reaches the caller.
   */
  private applyStart(by: PeerId | null, targetS: number | null = null): void {
    const ctx = this.game;
    const inst = this.tram;
    if (!ctx || !inst || inst.def.state === 'moving') return;
    const path = this.path;
    if (targetS !== null && path && !path.loop) {
      const d = targetS - inst.def.s;
      if (Math.abs(d) > 0.01) inst.def.dir = d > 0 ? 1 : -1;
    }
    inst.def.state = 'moving';
    inst.dockTimer = 0;
    this.beginRun(inst);
    ctx.bus.emit('rail:tramStarted', { lineId: inst.def.lineId, tramId: inst.def.id, by });
    ctx.bus.emit('audio:play', { id: 'tram_start', position: inst.def.position });
    this.broadcastState();
  }

  /* ── Multiplayer ──────────────────────────────────────────────────── */

  private wire(inst: TramInst): TramWire {
    return { id: inst.def.id, s: inst.def.s, dir: inst.def.dir, st: Math.max(0, TRAM_STATES.indexOf(inst.def.state)) };
  }

  private broadcastState(): void {
    const ctx = this.game;
    const net = ctx?.net;
    const inst = this.tram;
    if (!ctx || !net || !ctx.isMultiplayer || !net.isHost || !inst) return;
    net.send({ t: 'tram', ev: 'state', tram: this.wire(inst) }, 'others');
  }

  private applyWire(w: TramWire): void {
    const inst = this.tram;
    if (!inst || w.id !== inst.def.id) return;
    const prev = inst.def.state;
    inst.def.dir = w.dir;
    inst.def.state = (TRAM_STATES[w.st] ?? 'idle') as TramState;
    inst.targetS = w.s;
    if (inst.def.state !== 'moving') inst.def.s = w.s;
    if (prev !== 'docked' && inst.def.state === 'docked') {
      this.game?.bus.emit('audio:play', { id: 'tram_dock', position: inst.def.position });
    }
    if (prev !== 'moving' && inst.def.state === 'moving') {
      // Clients run the same wait · acceleration curve (the one notice, and `vel` must match or the deck will not carry people)
      this.beginRun(inst);
      this.game?.bus.emit('audio:play', { id: 'tram_start', position: inst.def.position });
    }
    if (prev === 'moving' && inst.def.state !== 'moving') inst.runT = 0;
  }

  private ensureNet(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('tram', (m: TramMessage) => {
        if (!ctx.net || ctx.net.isHost) return;
        if (m.ev === 'state') this.applyWire(m.tram);
        else for (const w of m.trams) this.applyWire(w);
      }),
      net.onMessage('tramq', (m: TramRequest, from) => {
        if (!ctx.net?.isHost) return;
        if (m.ev === 'sync') { this.sendSync(from); return; }
        // Ignition or call, it is the same request — the destination is read from where the requester stands (`targetSFor`).
        if (this.tram && m.id === this.tram.def.id) this.applyStart(from, this.targetSFor(from));
      }),
      net.onMessage('flow', (m, from) => { if (m.ev === 'rejoined' && ctx.net?.isHost) this.sendSync(from); }),
      ctx.bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost && this.built) this.requestSync(); }),
    );
  }

  private requestSync(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
    net.send({ t: 'tramq', ev: 'sync' }, 'host');
  }

  private sendSync(to: PeerId): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || !this.tram) return;
    net.send({ t: 'tram', ev: 'sync', trams: [this.wire(this.tram)] }, to);
  }
}
