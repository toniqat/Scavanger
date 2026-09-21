/**
 * src/game/parts/RaidXp.ts — **raid-end XP settlement** (2026-09-21, the result screen rework — user's decisions).
 *
 * Raid XP is no longer kills only. Every source becomes one `RaidXpCard` (`shared/raidRewards.ts`) and the cards
 * sum to `MissionRewards.xpEarned`:
 *   - `kill`      — `stats.killXp` (enemies/ sums `data/enemies.csv` `raidXp` of my last-hit kills).
 *   - `gather`    — `stats.gathers` × `RAID_XP_PER_GATHER` (my own `gather:collected` during a live raid).
 *   - `discover`  — `stats.structuresFound` (rail platforms · labs · outposts · crashed ships · POI ruins, from
 *                   `fog:discovered`) × the per-kind `RAID_XP_DISCOVER_*`. The fog is squad-shared, so a structure a
 *                   squadmate uncovered counts too.
 *   - `mapReveal` — `stats.mapExplored` (fog explored fraction, kept as a maximum) × `RAID_XP_MAP_FULL`.
 *   - `survey`    — one card per `SurveyRef.raidGains()` entry, percentage points × `RAID_XP_SURVEY_PER_PCT`.
 *   - `trust`     — one card per human squadmate: `RAID_XP_TRUST_BASE + level × RAID_XP_TRUST_PER_LEVEL`, level =
 *                   that pair's trust **before** this raid (`NetRef.trust`).
 *   - `contract`  — the corp contract's reward XP when it succeeded.
 * Every card × `XP_DEATH_MUL` when the raid did not extract; the library `raidXp` multiplier applies to every
 * raid-sourced card and never to the contract (a fixed `contracts.csv` reward), as before.
 *
 * **Resume safety**: the tracker keeps no state of its own — it writes straight into `ctx.stats`, and the raid
 * session blob (relay and solo alike, `parts/Session`) spreads the whole `stats` object, so the counters survive a
 * reload / rejoin exactly like `killXp`. `structuresFound` is a plain array (JSON-safe); after a resume the fog
 * re-announces what it had already seen, so the array is deduped on insert.
 *
 * `structuresFound` entries are `<kind>:<id>` with kind ∈ `DISCOVER_KINDS` — the kind is taken at discovery time,
 * because the title's `레이드 포기` settles without a world to look the id up in.
 */
import type { GameContext, MissionStats, RaidContractRow, RaidSquadEntry, RaidXpCard, LobbyPlayer } from '@/shared';
import {
  CONTRACT_DEFS, PLAYER_TRUST_RAID_GAIN, isAndroidId,
  RAID_XP_DISCOVER_LAB, RAID_XP_DISCOVER_OUTPOST, RAID_XP_DISCOVER_PLATFORM, RAID_XP_DISCOVER_RUIN,
  RAID_XP_DISCOVER_WRECK, RAID_XP_MAP_FULL, RAID_XP_PER_GATHER, RAID_XP_SURVEY_PER_PCT, RAID_XP_TRUST_BASE,
  RAID_XP_TRUST_PER_LEVEL, isRaidFound,
} from '@/shared';
import type { ContractSettlement } from '@/shared';
import type { GameFlowSystem } from '../GameFlowSystem';

/** What a discovered structure counts as — the prefix of each `stats.structuresFound` entry. */
type DiscoverKind = 'platform' | 'lab' | 'outpost' | 'wreck' | 'ruin';

const DISCOVER_XP: Readonly<Record<DiscoverKind, number>> = {
  platform: RAID_XP_DISCOVER_PLATFORM,
  lab: RAID_XP_DISCOVER_LAB,
  outpost: RAID_XP_DISCOVER_OUTPOST,
  wreck: RAID_XP_DISCOVER_WRECK,
  ruin: RAID_XP_DISCOVER_RUIN,
};

function finite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** Collects the per-raid counters into `ctx.stats` while a raid runs. Bound once in `GameFlowSystem.init`. */
export class RaidXpTracker {
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly sys: GameFlowSystem) {}

  bind(): void {
    const ctx = this.sys.ctx;
    const b = ctx.bus;
    this.unsubs.push(
      // Only the local award path emits it (a squadmate's harvest never reaches `gather:collected` here); the
      // ship's greenhouse emits it too, hence the live-raid gate.
      b.on('gather:collected', () => {
        if (!this.counting()) return;
        ctx.stats.gathers = finite(ctx.stats.gathers) + 1;
      }),
      b.on('fog:discovered', ({ kind, id }) => {
        if (!this.counting()) return;
        const dk = this.discoverKind(kind, id);
        if (!dk) return;
        const key = `${dk}:${id}`;
        const list = Array.isArray(ctx.stats.structuresFound) ? ctx.stats.structuresFound : (ctx.stats.structuresFound = []);
        if (!list.includes(key)) list.push(key);
      }),
      b.on('fog:revealed', ({ explored }) => {
        if (!this.counting()) return;
        ctx.stats.mapExplored = Math.max(finite(ctx.stats.mapExplored), Math.min(1, Math.max(0, finite(explored))));
      }),
    );
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  private counting(): boolean {
    return this.sys.inLiveMission() && !this.sys.isTraining();
  }

  private discoverKind(kind: string, id: string): DiscoverKind | null {
    if (kind === 'rail') return 'platform';
    if (kind === 'outpost') return 'ruin';   // `fog:discovered {kind:'outpost'}` = a POI ruin (`world/Outposts`)
    if (kind !== 'structure') return null;
    const st = this.sys.ctx.world?.getStructures().find((s) => s.id === id);
    return st ? st.kind : null;
  }
}

/** Refresh the end-of-raid readings that are not event-driven (explored fraction · found value). */
export function finalizeStats(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  const s = ctx.stats;
  const fog = ctx.world?.fog;
  if (fog && sys.inLiveMission()) s.mapExplored = Math.max(finite(s.mapExplored), Math.min(1, Math.max(0, finite(fog.explored))));
  s.raidFoundValue = raidFoundValue(ctx, s);
}

/**
 * The value (`def.value × qty`) of the carried items found in this raid — the same scope as `stats.lootValue`
 * (`InventoryRef.getTotalValue`: bag · quick slots · pouch; `countWhere` walks exactly those), so page ① can put the
 * two side by side. After a death the belongings are already in the corpse, so it reads 0 — which is what was lost.
 */
function raidFoundValue(ctx: GameContext, s: MissionStats): number {
  const inv = ctx.inventory;
  if (!inv) return 0;
  let sum = 0;
  try {
    inv.countWhere((d, it) => {
      if (d.value > 0 && isRaidFound(it, s.seed)) sum += d.value * Math.max(1, it.qty);
      return false;
    });
  } catch { /* inventory not ready */ }
  return Number.isFinite(sum) ? Math.max(0, Math.round(sum)) : 0;
}

/** Human squadmates of this raid (me · androids · members who abandoned from the title excluded). */
function squadmates(sys: GameFlowSystem): LobbyPlayer[] {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!net || !ctx.isMultiplayer || !net.lobby || !sys.inLiveMission()) return [];
  const me = net.localId;
  return net.lobby.players.filter((p) => p.id !== me && !p.bot && !isAndroidId(p.id) && !p.drifted);
}

export interface RaidXpResult {
  cards: RaidXpCard[];
  xp: number;
  deathMul: number;
  squad: RaidSquadEntry[];
  contracts: RaidContractRow[];
}

/**
 * Builds every card of a main-game raid. `contract` is my settlement (already run). `libraryMul` = `1 + raidXp`.
 */
export function buildRaidXp(sys: GameFlowSystem, contract: ContractSettlement | null, deathMul: number, libraryMul: number): RaidXpResult {
  const ctx = sys.ctx;
  const s = ctx.stats;
  const cards: RaidXpCard[] = [];
  const raidMul = deathMul * libraryMul;
  const push = (card: Omit<RaidXpCard, 'xp'>, base: number, mul: number): void => {
    const xp = Math.max(0, Math.round(base * mul));
    if (!Number.isFinite(xp)) return;
    cards.push({ ...card, xp });
  };

  const killXp = Math.max(0, finite(s.killXp));
  if (killXp > 0) push({ kind: 'kill', id: 'kill', title: '처치', detail: `${Math.max(0, finite(s.kills))}마리` }, killXp, raidMul);

  const gathers = Math.max(0, Math.floor(finite(s.gathers)));
  if (gathers > 0) push({ kind: 'gather', id: 'gather', title: '채집', detail: `${gathers}회` }, gathers * RAID_XP_PER_GATHER, raidMul);

  const found = Array.isArray(s.structuresFound) ? s.structuresFound : [];
  let discoverXp = 0;
  let discoverCount = 0;
  for (const key of found) {
    const kind = String(key).split(':', 1)[0] as DiscoverKind;
    const per = DISCOVER_XP[kind];
    if (per === undefined) continue;
    discoverXp += per;
    discoverCount++;
  }
  if (discoverCount > 0) push({ kind: 'discover', id: 'discover', title: '구조물 발견', detail: `${discoverCount}곳` }, discoverXp, raidMul);

  const explored = Math.min(1, Math.max(0, finite(s.mapExplored)));
  if (explored > 0) push({ kind: 'mapReveal', id: 'mapReveal', title: '지도 탐사', detail: `${Math.round(explored * 100)} %` }, explored * RAID_XP_MAP_FULL, raidMul);

  let gains: readonly { subjectId: string; name: string; gained: number }[] = [];
  try { gains = ctx.survey?.raidGains() ?? []; } catch { gains = []; }
  for (const g of gains) {
    const pct = Math.max(0, finite(g.gained)) * 100;
    if (pct <= 0) continue;
    push({ kind: 'survey', id: `survey:${g.subjectId}`, title: g.name, detail: `+${Math.round(pct)} %` }, pct * RAID_XP_SURVEY_PER_PCT, raidMul);
  }

  // Squadmates: page ④ rows and one trust card each.
  const squad: RaidSquadEntry[] = [];
  const trust = ctx.net?.trust ?? null;
  for (const p of squadmates(sys)) {
    if (!p.code) continue;   // anonymous socket — no pair to speak of
    let points = 0;
    let level = 0;
    try { const t = trust?.beforeRaid(p.code); points = finite(t?.points); level = Math.max(0, Math.floor(finite(t?.level))); } catch { /* offline */ }
    squad.push({
      peerId: p.id, code: p.code, name: p.name, accent: p.accent, level: p.level, shipModel: p.shipModel,
      trustBefore: points, trustRaidGain: PLAYER_TRUST_RAID_GAIN,
    });
    push({
      kind: 'trust', id: `trust:${p.code}`, title: p.name, detail: `신뢰도 Lv.${level}`,
      peer: { code: p.code, name: p.name, accent: p.accent },
    }, RAID_XP_TRUST_BASE + level * RAID_XP_TRUST_PER_LEVEL, raidMul);
  }

  if (contract?.success && contract.xp > 0) {
    push({ kind: 'contract', id: 'contract', title: '계약', detail: contract.name }, contract.xp, deathMul);
  }

  let xp = 0;
  for (const c of cards) xp += c.xp;
  return { cards, xp, deathMul, squad, contracts: contractRows(sys, contract, squad) };
}

/** Page ③: my contract first, then every human squadmate's (label null = no contract). */
function contractRows(sys: GameFlowSystem, mine: ContractSettlement | null, squad: readonly RaidSquadEntry[]): RaidContractRow[] {
  const ctx = sys.ctx;
  const myName = ctx.net?.playerName || ctx.progression?.profile.name || '';
  const rows: RaidContractRow[] = [{
    name: myName, self: true,
    label: mine ? mine.name : null,
    success: !!mine?.success,
    progress: mine ? finite(mine.progress) : 0,
    target: mine ? finite(mine.target) : 0,
  }];
  let infos: readonly { peer: string; id: string; progress: number }[] = [];
  try { infos = ctx.meta?.getSquadContracts() ?? []; } catch { infos = []; }
  for (const m of squad) {
    const info = infos.find((c) => c.peer === m.peerId);
    const def = info ? CONTRACT_DEFS.find((d) => d.id === info.id) : undefined;
    const progress = info ? Math.max(0, finite(info.progress)) : 0;
    const target = def ? finite(def.target) : 0;
    rows.push({
      name: m.name, self: false,
      label: def ? def.name : null,
      success: !!def && target > 0 && progress >= target,
      progress, target,
    });
  }
  return rows;
}
