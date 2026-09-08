/**
 * src/meta/model.ts — 메타 진행 폴더의 공용 어휘.
 *
 * `MetaSystem` 에서 떼어낸 상수 · 타입(그리고 상태 없는 보조 클래스)만 있다. 클래스를 참조하지 않으므로
 * `parts/*` 모듈이 `MetaSystem.ts` 를 되돌아 import 하지 않고 쓸 수 있다(순환 import 방지).
 * `MetaSystem.ts` 가 `export *` 로 재수출하므로 기존 import 경로는 전부 유지된다.
 */
import type {
  ConsoleCommand, ContractDef, ContractGoalKind, ContractInfo, ContractSettlement, CorpId, CreditsTxResult, EmbeddedView,
  GameContext, GameMessageOf, GameSystem, ItemDef, ItemInstance, MetaRef, MetaRequest, MissionStats, PeerId, ProfileRef, QuestInfo,
  QuestState, RepInfo, ShopItem, SquadContractInfo,
} from '@/shared';
import {
  CONTRACT_DEFS, CONTRACT_GOAL_LABEL_KO, CORP_DEFS, CORP_IDS, CREDITS_MAX, META_HIT_MAX, QUEST_DEFS, formatCredits,
  repLevelOf, sellPriceOf,
} from '@/shared';
import { MAX_PROGRESS, MetaStorage } from './Storage';
import {
  REASON, buildShop, canRepairImplant, contractBlockReason, contractHitDelta, corpSells, implantRepairCost, implantRepairFee,
  implantRepairMaterialIds, isRepairableImplantDef, killGoalOf, questBlockReason, questStateOf, repInfoOf, settleContract,
} from './Rules';
import { CorpView } from './ui/CorpView';
import './meta.css';

/* ────────────────────────────────────────────────────────────────────────────
 * MetaSystem (Phase 5-c, 2026-09-06): corporations · reputation · credits · contracts · quests · corp shop.
 * Publishes `ctx.meta` (`MetaRef`), persists `MetaSave` v1 in localStorage (`Storage.ts`), applies the pure rules of
 * `Rules.ts`, owns the corp screen DOM (`ui/CorpView.ts`, the Tab window's 기업 tab) and the `credits / rep / contract / quest`
 * console commands. Contract goals rise from bus events during a mission; local hits are shared with the squad over
 * the relay-opaque `meta contractHit` message. Toasts are the ui folder's job: this system only emits `meta:*`.
 *
 * Phase 7 (server profile): when `ctx.net.profile.available`, credits are **server-owned** — every `addCredits` is an
 * optimistic local apply followed by a `credits:tx` whose answer overwrites the balance (or reverts it when refused);
 * `buy` is `canFit` → server debit → item creation, `meta:purchase` announces the (possibly async) completion. The
 * save also mirrors into the `meta` profile document; `net:profileLoaded` replaces it with the server copy.
 *
 * Phase 9 (late-join catch-up + relay validation): a client that rejoins a running raid (`net:gameStarting {rejoin}`)
 * asks the squad for the contract hits it missed (`metaq sync` to others on `world:ready`); every peer answers ONCE per
 * requester per mission with the hits it broadcast so far (`sentHits` → `meta sync {corp, hits}` unicast), and the
 * requester feeds them through `reportContractHit(goal, n, false)` like live relayed hits. Relayed messages are
 * validated (`GOAL_IDS` / `CORP_IDS` whitelists, finite `1..META_HIT_MAX` — a sync entry is capped by the contract
 * target instead) and the progress is clamped to `MAX_PROGRESS`. The profile upload no longer needs the server
 * (`ProfileSync` queues + stamps an offline `set`).
 * ──────────────────────────────────────────────────────────────────────────── */

export const CORP_ALIASES: Readonly<Record<string, CorpId>> = { helix: 'helix', bastion: 'bastion', nomad: 'nomad', ceres: 'ceres' };
export const GOAL_IDS: readonly ContractGoalKind[] = ['kill_bugs', 'kill_rogues', 'open_crates', 'loot_corpses', 'extract_with_value', 'use_stratagems'];

/** Phase 9 relay validation: a whitelisted goal with a finite amount in `1..max`. */
export function isValidHit(goal: unknown, amount: unknown, max: number): goal is ContractGoalKind {
  return typeof goal === 'string' && GOAL_IDS.includes(goal as ContractGoalKind)
    && typeof amount === 'number' && Number.isFinite(amount) && amount >= 1 && amount <= max;
}

/** Why the last `buy()` / async purchase did not go through (corp screen message; folder-internal, not in `MetaRef`). */
export interface PurchaseFailure { corp: CorpId; defId: string; price: number; reason: string; }

/**
 * Phase 12 (2026-09-08): one broken implant as the 세레스 바이오 repair desk lists it (folder-internal — `MetaRef` is
 * frozen for this batch; `ui/CorpView` and the smoke read it through the `MetaSystem` instance).
 */
export interface ImplantRepairInfo {
  /** The broken implant in the bag / stash. */
  inst: ItemInstance;
  broken: ItemDef;
  /** `repairsTo` def (null when items/ does not know the id — the row is listed but blocked). */
  target: ItemDef | null;
  /** Materials with what the player holds (bag + stash). */
  cost: readonly { defId: string; qty: number; have: number }[];
  /** Credit fee (`IMPLANT_REPAIR_FEE × grade`). */
  fee: number;
  /** 한국어 reason `repairImplant` would refuse now, null = ready. */
  blocked: string | null;
}

/** Outcome of a finished (possibly async) repair, for the desk's message line. */
export interface ImplantRepairResult { uid: string; brokenId: string; targetId: string | null; fee: number; ok: boolean; reason: string | null; }


