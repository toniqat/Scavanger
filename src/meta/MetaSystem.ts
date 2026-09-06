import type {
  ContractGoalKind, ContractInfo, ContractSettlement, CorpId, GameContext, GameSystem, ItemInstance, MetaRef, MissionStats,
  QuestInfo, QuestState, RepInfo, ShopItem,
} from '@/shared';
import { CREDITS_INITIAL, REP_TABLE, repLevelOf } from '@/shared';

/**
 * Phase 5 skeleton (2026-09-06): publishes `ctx.meta` with neutral behaviour so every other folder compiles and
 * degrades gracefully. The meta agent replaces this file with the real system (storage, rules, corp screen).
 */
export class MetaSystem implements GameSystem, MetaRef {
  readonly name = 'meta';
  private ctx!: GameContext;
  private _credits = CREDITS_INITIAL;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.meta = this;
  }

  update(_dt: number, _ctx: GameContext): void {}

  dispose(): void {
    if (this.ctx?.meta === this) this.ctx.meta = null;
  }

  /* ── MetaRef (stub) ── */
  get credits(): number { return this._credits; }
  getRep(_corp: CorpId): RepInfo { return { rep: 0, level: repLevelOf(0), next: REP_TABLE[1] ?? null }; }
  addCredits(delta: number, _reason: string): boolean {
    if (this._credits + delta < 0) return false;
    this._credits += delta;
    return true;
  }
  addRep(_corp: CorpId, _delta: number, _reason: string): void {}
  getShop(_corp: CorpId): ShopItem[] { return []; }
  priceOf(_corp: CorpId, _defId: string): number | null { return null; }
  buy(_corp: CorpId, _defId: string): boolean { return false; }
  sellPriceOf(_uid: string, _qty?: number): number | null { return null; }
  sell(_uid: string, _qty?: number): boolean { return false; }
  getSellable(): readonly ItemInstance[] { return []; }
  getContracts(_corp: CorpId): ContractInfo[] { return []; }
  get activeContract(): ContractInfo | null { return null; }
  acceptContract(_id: string): boolean { return false; }
  abandonContract(): boolean { return false; }
  reportContractHit(_goal: ContractGoalKind, _amount: number, _local: boolean): void {}
  settleMission(_stats: MissionStats): ContractSettlement | null { return null; }
  getQuests(_corp: CorpId): QuestInfo[] { return []; }
  getQuestState(_id: string): QuestState { return 'locked'; }
  acceptQuest(_id: string): boolean { return false; }
  completeQuest(_id: string): boolean { return false; }
  openCorpMenu(_corp?: CorpId): void {}
  closeCorpMenu(): void {}
  get isMenuOpen(): boolean { return false; }
  save(): void {}
  resetMeta(): void { this._credits = CREDITS_INITIAL; }
}
