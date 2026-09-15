/**
 * src/game/parts/RaidReport.ts — **결과 창의 재료** (2026-09-15, 결과 창 개편 — 사용자 결정).
 *
 * 사망 결과 창은 「잃은 전리품 가치」(그 레이드에서 가장 높았던 소지품 가치) · 「사망 원인」(막타 — 적이면 그 개체,
 * 아니면 원인 종류)과 그 원인에게서 받은 피해를 보여 준다. 셋 다 레이드가 끝나는 순간에는 이미 알 수 없다 —
 * 소지품은 `stripForCorpse` 가 시체로 비웠고, 피해는 흘러간 이벤트다. 그래서 레이드 동안 여기서 모은다.
 *
 * - **최고 소지품 가치** — `InventoryRef.getTotalValue()`(가방 · 퀵슬롯 · 주머니) + 장착 로드아웃(무기 · 가방 · 방탄복 ·
 *   주머니 아이템 자체 · 무기 소켓 부착물)의 `def.value × qty`. 인벤토리 변화 이벤트마다 + `POLL_S` 마다 한 번 재고
 *   `ctx.stats.peakLootValue` 에 **최댓값으로만** 쓴다. 사망 순간에는 **시체로 비우기 전에** 한 번 더 잰다
 *   (`GameFlowSystem.init` 이 이 구독을 `onLocalDied` 보다 먼저 건다). 값이 `MissionStats` 에 사므로 레이드 세션
 *   저장 · 복귀를 그대로 따라간다.
 * - **원인별 받은 피해** — `player:damaged.source` 를 열쇠로 합산한다: 적은 개체(`enemyId`, 없으면 `enemyType`),
 *   나머지는 `kind` (+ `hazard`). 출처가 없는 피해는 세지 않는다 (모르는 것을 지어내지 않는다 — 원인 줄이 숨는다).
 * - **막타** — `player:died.source`, 없으면 마지막으로 받은 피해의 출처. 자발적 귀환(`returnPending`)으로 죽은
 *   몸에는 원인이 없다.
 *
 * `fill()` 은 `GameFlowSystem.complete()` · `gameOver()` 가 결산 **앞에서** 부른다 — 결과 화면이 읽는 `ctx.stats` 에
 * `peakLootValue` · `death` 가 이미 들어 있게. 레이드가 새로 시작하거나(`game:newMission`) 끝나고 함선에 들어서면 비운다.
 */
import type { DamageCauseKind, GameContext, InventoryRef, ItemInstance, MissionDeathCause, PlayerDamageSource } from '@/shared';
import { HAZARD_LABEL_KO, HAZARD_KINDS, type HazardKind } from '@/shared';
import type { GameFlowSystem } from '../GameFlowSystem';

/** 소지품 가치를 다시 재는 간격 (초) — 이벤트를 놓친 변화의 안전망이라 촘촘할 필요가 없다. */
const POLL_S = 1;

/** 적 · 재해가 아닌 원인의 이름 (결과 창 표시). */
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

/** 지금 몸에 지닌 모든 것의 가치 — 가방 · 퀵슬롯 · 주머니 + 장착한 장비. */
export function carriedValue(inv: InventoryRef | null | undefined): number {
  if (!inv) return 0;
  let v = 0;
  try { v += inv.getTotalValue(); } catch { /* 인벤토리가 아직 없다 */ }
  try {
    const l = inv.getLoadout();
    for (const it of [l.primary, l.primary2, l.secondary, l.bag, l.armor ?? null, l.pouch ?? null]) v += itemValue(inv, it);
  } catch { /* 로드아웃이 아직 없다 */ }
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

export class RaidReport {
  private readonly tallies = new Map<string, Tally>();
  private last: PlayerDamageSource | null = null;
  private lethal: PlayerDamageSource | null = null;
  /** 막타 시점에 자발적 귀환 중이었다 — 원인 줄을 비운다. */
  private diedByReturn = false;
  private poll = 0;
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly sys: GameFlowSystem) {}

  private get ctx(): GameContext { return this.sys.ctx; }

  /** `GameFlowSystem.init` 에서 **`player:died` → `onLocalDied` 구독보다 먼저** 부른다 (시체로 비우기 전에 잰다). */
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

  /** `GameFlowSystem.update` — 저율 폴링. */
  update(dt: number): void {
    this.poll -= dt;
    if (this.poll > 0) return;
    this.poll = POLL_S;
    this.sample();
  }

  /** 레이드 중이고 몸이 살아 있을 때만 잰다 (시체로 비워진 뒤 · 함선 · 훈련장은 최고값을 건드리지 않는다). */
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
    // 시체로 비우기 전 — 이 구독은 `onLocalDied` 보다 먼저 돈다. 죽음 판정이 이미 켜졌어도 가방은 아직 그대로다.
    this.bump(carriedValue(this.ctx.inventory));
    this.lethal = source && typeof source.kind === 'string' ? source : this.last;
    this.diedByReturn = this.sys.returnPending;
  }

  /**
   * 결산 직전: `ctx.stats.peakLootValue` 를 마지막으로 올리고, 몸이 쓰러져 있으면 `ctx.stats.death` 를 확정한다.
   * 멱등이다 (같은 상태에서 몇 번 불러도 같은 값).
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
  /** 원인별 합계 (디버그 · 스모크). */
  debugTallies(): Array<{ key: string } & Tally> {
    return [...this.tallies.entries()].map(([key, t]) => ({ key, ...t }));
  }
}
