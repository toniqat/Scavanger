/**
 * src/game/parts/RaidReport.ts — **what fills the results screen** (2026-09-15, the results screen rework —
 * user's decision).
 *
 * The death results screen shows 「잃은 전리품 가치」 (the highest value carried in that raid) · 「사망 원인」 (the
 * last hit — the body itself if it was an enemy, otherwise the kind of cause) and the damage that cause dealt. None
 * of the three can still be known the moment the raid ends — `stripForCorpse` has stripped the belongings into the
 * corpse, and damage is an event that has gone by. So they are collected here, during the raid.
 *
 * - **Peak carried value** — `InventoryRef.getTotalValue()` (bag · quick slots · pouch) + `def.value × qty` of the
 *   equipped loadout (weapon · bag · armor · the pouch item itself · weapon socket attachments). Measured on every
 *   inventory change event and once every `POLL_S`, and written to `ctx.stats.peakLootValue` **only as a maximum**.
 *   At the moment of death it is measured once more **before the strip into the corpse** (`GameFlowSystem.init`
 *   raises this subscription earlier than `onLocalDied`). The value lives in `MissionStats`, so it follows the raid
 *   session save · resume as it is.
 * - **Damage tallies per source** — summed with `player:damaged.source` as the key: an enemy by body (`enemyId`, or
 *   `enemyType` when there is none), everything else by `kind` (+ `hazard`). Damage with no source is not counted
 *   (nothing unknown is invented — the death cause row hides instead).
 * - **The last hit** — `player:died.source`, else the source of the last damage taken. A body that died of the
 *   voluntary return (`returnPending`) has no cause.
 *
 * `fill()` is called by `GameFlowSystem.complete()` · `gameOver()` **before** the settlement — so `ctx.stats`, which
 * the results screen reads, already holds `peakLootValue` · `death`. It is cleared when a raid starts anew
 * (`game:newMission`), or when one ends and the ship is entered.
 */
import type { DamageCauseKind, GameContext, InventoryRef, ItemInstance, MissionDeathCause, PlayerDamageSource } from '@/shared';
import { HAZARD_LABEL_KO, HAZARD_KINDS, type HazardKind } from '@/shared';
import type { GameFlowSystem } from '../GameFlowSystem';

/** The interval for re-measuring the carried value (s) — a safety net for missed events, so it need not be tight. */
const POLL_S = 1;

/** The names of causes that are neither an enemy nor a hazard (shown on the results screen). */
const CAUSE_LABEL_KO: Readonly<Record<Exclude<DamageCauseKind, 'enemy' | 'hazard'>, string>> = {
  fall: '낙하',
  env: '행성 환경',
  explosion: '폭발',
  self: '자기 폭발물',
  ally: '아군 폭발물',
  other: '알 수 없는 피해',
};

interface Tally {
  kind: DamageCauseKind;
  enemyType?: string;
  hazard?: string;
  damage: number;
}

function keyOf(src: PlayerDamageSource): string {
  if (src.kind === 'enemy') {
    if (typeof src.enemyId === 'number' && Number.isFinite(src.enemyId)) return `enemy#${src.enemyId}`;
    return `enemy:${src.enemyType ?? '?'}`;
  }
  if (src.kind === 'hazard') return `hazard:${src.hazard ?? ''}`;
  return src.kind;
}

function itemValue(inv: InventoryRef, it: ItemInstance | null | undefined): number {
  if (!it) return 0;
  const qty = it.qty > 0 ? it.qty : 1;
  let v = (inv.getDef(it.defId)?.value ?? 0) * qty;
  if (it.sockets) {
    for (const a of Object.values(it.sockets)) {
      if (a) v += (inv.getDef(a.defId)?.value ?? 0) * (a.qty > 0 ? a.qty : 1);
    }
  }
  return v;
}

/** The value of everything the body carries right now — bag · quick slots · pouch + the equipped gear. */
export function carriedValue(inv: InventoryRef | null | undefined): number {
  if (!inv) return 0;
  let v = 0;
  try { v += inv.getTotalValue(); } catch { /* the inventory is not there yet */ }
  try {
    const l = inv.getLoadout();
    for (const it of [l.primary, l.primary2, l.secondary, l.bag, l.armor ?? null, l.pouch ?? null]) v += itemValue(inv, it);
  } catch { /* the loadout is not there yet */ }
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

export class RaidReport {
  private readonly tallies = new Map<string, Tally>();
  private last: PlayerDamageSource | null = null;
  private lethal: PlayerDamageSource | null = null;
  /** The voluntary return was under way at the last hit — the death cause row is left empty. */
  private diedByReturn = false;
  private poll = 0;
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly sys: GameFlowSystem) {}

  private get ctx(): GameContext { return this.sys.ctx; }

  /**
   * Called from `GameFlowSystem.init` **earlier than the `player:died` → `onLocalDied` subscription** (it measures
   * before the strip into the corpse).
   */
  bind(): void {
    const b = this.ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', () => this.reset()),
      b.on('game:abort', () => this.reset()),
      b.on('hub:entered', () => this.reset()),
      b.on('player:damaged', ({ amount, source }) => this.onDamaged(amount, source)),
      b.on('player:died', ({ source }) => this.onDied(source)),
      b.on('inventory:changed', () => this.sample()),
      b.on('inventory:quickSlotsChanged', () => this.sample()),
      b.on('inventory:pouchChanged', () => this.sample()),
      b.on('loadout:changed', () => this.sample()),
    );
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  reset(): void {
    this.tallies.clear();
    this.last = null;
    this.lethal = null;
    this.diedByReturn = false;
    this.poll = 0;
  }

  /** `GameFlowSystem.update` — low-rate polling. */
  update(dt: number): void {
    this.poll -= dt;
    if (this.poll > 0) return;
    this.poll = POLL_S;
    this.sample();
  }

  /**
   * Measures only in a raid with the body alive (after the strip into the corpse · the ship · the training range
   * never touch the peak).
   */
  private sample(): void {
    const ctx = this.ctx;
    if (!this.inRaid()) return;
    if (ctx.player?.isDead) return;
    this.bump(carriedValue(ctx.inventory));
  }

  private bump(v: number): void {
    const s = this.ctx.stats;
    if (!(v > (s.peakLootValue ?? 0))) return;
    s.peakLootValue = v;
  }

  private inRaid(): boolean {
    const ctx = this.ctx;
    if (this.sys.isTraining()) return false;
    return ctx.isGameplayPhase() || ctx.phase === 'deploying';
  }

  private onDamaged(amount: number, source: PlayerDamageSource | undefined): void {
    if (!(amount > 0) || !this.inRaid()) return;
    if (!source || typeof source.kind !== 'string') { this.last = null; return; }
    const key = keyOf(source);
    let t = this.tallies.get(key);
    if (!t) {
      t = { kind: source.kind, damage: 0 };
      if (source.enemyType) t.enemyType = source.enemyType;
      if (source.hazard) t.hazard = source.hazard;
      this.tallies.set(key, t);
    }
    t.damage += amount;
    this.last = source;
  }

  private onDied(source: PlayerDamageSource | undefined): void {
    if (!this.inRaid()) return;
    // before the strip into the corpse — this subscription runs earlier than `onLocalDied`. The death check may
    // already be on, but the bag is still as it was.
    this.bump(carriedValue(this.ctx.inventory));
    this.lethal = source && typeof source.kind === 'string' ? source : this.last;
    this.diedByReturn = this.sys.returnPending;
  }

  /**
   * Just before the settlement: raises `ctx.stats.peakLootValue` one last time and, if the body is down, settles
   * `ctx.stats.death`. It is idempotent (the same value however many times it is called in the same state).
   */
  fill(): void {
    const ctx = this.ctx;
    const s = ctx.stats;
    this.sample();
    if (s.peakLootValue === undefined) s.peakLootValue = 0;
    const p = ctx.player;
    const out = !!p && (p.isDead || (p.isDowned ?? false));
    if (!out || this.diedByReturn) { s.death = null; return; }
    const src = this.lethal ?? this.last;
    s.death = src ? this.causeOf(src) : null;
  }

  private causeOf(src: PlayerDamageSource): MissionDeathCause {
    const t = this.tallies.get(keyOf(src));
    const damage = Math.max(0, Math.round(t?.damage ?? 0));
    const cause: MissionDeathCause = { kind: src.kind, label: this.labelOf(src), damage };
    if (src.enemyType) cause.enemyType = src.enemyType;
    if (src.hazard) cause.hazard = src.hazard;
    return cause;
  }

  private labelOf(src: PlayerDamageSource): string {
    if (src.kind === 'enemy') {
      let name: string | null = null;
      try { name = src.enemyType ? (this.ctx.enemies?.enemyDisplayName?.(src.enemyType) ?? null) : null; } catch { name = null; }
      return name ?? '적';
    }
    if (src.kind === 'hazard') {
      const h = src.hazard;
      return h && (HAZARD_KINDS as readonly string[]).includes(h) ? HAZARD_LABEL_KO[h as HazardKind] : '환경 재해';
    }
    return CAUSE_LABEL_KO[src.kind] ?? CAUSE_LABEL_KO.other;
  }

  /* ── debug ── */
  /** The tallies per source — a debug hook only (`window.__game`); nothing in `src/` or `scripts/` calls it. */
  debugTallies(): Array<{ key: string } & Tally> {
    return [...this.tallies.entries()].map(([key, t]) => ({ key, ...t }));
  }
}
