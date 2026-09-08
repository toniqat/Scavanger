/**
 * src/meta/parts/Console.ts — 개발자 콘솔 명령 `credits` / `rep` / `contract` / `quest` / `implant`.
 *
 * dev 클라이언트에서만 등록된다(`src/console` 참고). 게임 규칙은 하나도 갖지 않고 위의 API 만 부른다.
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
import { MAX_PROGRESS, MetaStorage } from '../Storage';
import {
  REASON, buildShop, canRepairImplant, contractBlockReason, contractHitDelta, corpSells, implantRepairCost, implantRepairFee,
  implantRepairMaterialIds, isRepairableImplantDef, killGoalOf, questBlockReason, questStateOf, repInfoOf, settleContract,
} from '../Rules';
import { CorpView } from '../ui/CorpView';
import { CORP_ALIASES, GOAL_IDS, type ImplantRepairInfo, type ImplantRepairResult, type PurchaseFailure, isValidHit } from '../model';
import type { MetaSystem } from '../MetaSystem';

export function registerConsole(sys: MetaSystem): void {
  const con = sys.ctx.console;
  if (!con) return;
  const num = (raw: string | undefined): number => {
    if (raw === undefined) return NaN;
    const s = raw.trim().replace(/^\+/, '');
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  };
  const corpNames = (): string[] => [...CORP_IDS, ...CORP_IDS.map((c) => CORP_DEFS[c].name)];
  const cmds: ConsoleCommand[] = [
    {
      name: 'credits', usage: 'credits <±n>', description: '크레딧을 더하거나 뺍니다',
      run: (args) => {
        const n = num(args[0]);
        if (Number.isNaN(n)) return { error: '사용법: /credits <±n>' };
        if (!sys.addCredits(n, 'console')) return { error: `크레딧 부족 (보유 ${formatCredits(sys.credits)})` };
        return `크레딧 ${formatCredits(sys.credits)}`;
      },
    },
    {
      name: 'rep', usage: 'rep <helix|bastion|nomad|ceres|한국어> <±n>', description: '기업 신뢰도를 더하거나 뺍니다',
      run: (args) => {
        if (args.length < 2) return { error: '사용법: /rep <기업> <±n>' };
        const corp = sys.resolveCorp(args.slice(0, -1).join(' '));
        const n = num(args[args.length - 1]);
        if (!corp) return { error: `알 수 없는 기업: ${args.slice(0, -1).join(' ')} (${CORP_IDS.join('/')})` };
        if (Number.isNaN(n)) return { error: '신뢰도가 숫자가 아닙니다' };
        sys.addRep(corp, n, 'console');
        const r = sys.getRep(corp);
        return `${CORP_DEFS[corp].name} 신뢰도 ${r.rep} (Lv.${r.level}${r.next !== null ? ` · 다음 ${r.next}` : ''})`;
      },
      complete: (args) => (args.length > 1 ? [] : corpNames().filter((n) => n.toLowerCase().startsWith((args[0] ?? '').toLowerCase()))),
    },
    {
      name: 'contract', usage: 'contract list|accept <id>|abandon|hit <goal> <n>', description: '계약 목록 / 수락 / 포기 / 진척 치트',
      run: (args, _ctx, print) => {
        const sub = (args[0] ?? 'list').toLowerCase();
        if (sub === 'list') {
          const ac = sys.store.data.activeContract;
          for (const d of CONTRACT_DEFS) {
            const active = ac?.id === d.id;
            print(`${active ? '▶ ' : '  '}${d.id}  ${CORP_DEFS[d.corp].name} · ${d.name} · ${CONTRACT_GOAL_LABEL_KO[d.goal]} ${active ? `${ac!.progress}/` : ''}${d.target} · 신뢰도 Lv.${d.minRepLevel}`, active ? 'success' : 'info');
          }
          return ac ? `진행 중: ${ac.id}` : '진행 중인 계약 없음';
        }
        if (sub === 'accept') {
          const id = args[1];
          if (!id) return { error: '사용법: /contract accept <id>' };
          const def = CONTRACT_DEFS.find((d) => d.id === id);
          if (!def) return { error: `알 수 없는 계약: ${id}` };
          if (!sys.acceptContract(id)) return { error: `수락 실패: ${contractBlockReason(def, sys.level(def.corp), sys.store.data.activeContract ? 1 : 0, sys.inShip) ?? '알 수 없음'}` };
          return `계약 수락: ${def.name}`;
        }
        if (sub === 'abandon') return sys.abandonContract() ? '계약 포기' : { error: '진행 중인 계약 없음' };
        if (sub === 'hit') {
          const goal = args[1] as ContractGoalKind | undefined;
          const n = num(args[2] ?? '1');
          if (!goal || !GOAL_IDS.includes(goal)) return { error: `사용법: /contract hit <${GOAL_IDS.join('|')}> <n>` };
          if (Number.isNaN(n)) return { error: '수량이 숫자가 아닙니다' };
          const before = sys.store.data.activeContract?.progress ?? 0;
          sys.reportContractHit(goal, n, true);
          const ac = sys.activeContract;
          if (!ac) return { error: '진행 중인 계약 없음' };
          if (ac.progress === before) return { error: `목표 불일치 (${CONTRACT_GOAL_LABEL_KO[ac.def.goal]})` };
          return `${ac.def.name} ${ac.progress} / ${ac.def.target}`;
        }
        return { error: '사용법: /contract list|accept <id>|abandon|hit <goal> <n>' };
      },
      complete: (args) => {
        if (args.length <= 1) return ['list', 'accept', 'abandon', 'hit'].filter((s) => s.startsWith((args[0] ?? '').toLowerCase()));
        if (args[0] === 'accept' && args.length === 2) return CONTRACT_DEFS.map((d) => d.id).filter((s) => s.startsWith(args[1] ?? ''));
        if (args[0] === 'hit' && args.length === 2) return GOAL_IDS.filter((s) => s.startsWith(args[1] ?? ''));
        return [];
      },
    },
    {
      name: 'implant', usage: 'implant list|repair <uid|first>', description: '망가진 임플란트 목록 / 세레스 수리 (재료 · 크레딧은 그대로 요구)',
      run: (args, _ctx, print) => {
        const sub = (args[0] ?? 'list').toLowerCase();
        const list = sys.getRepairableImplants();
        if (sub === 'list') {
          for (const r of list) print(`  ${r.inst.uid}  ${r.broken.name} → ${r.target?.name ?? '?'} · ${formatCredits(r.fee)} · ${r.cost.map((c) => `${c.defId} ${c.have}/${c.qty}`).join(', ')}${r.blocked ? ` · ${r.blocked}` : ''}`, r.blocked ? 'info' : 'success');
          return `${list.length}개`;
        }
        if (sub === 'repair') {
          const key = args[1];
          const r = !key || key === 'first' ? list[0] : list.find((x) => x.inst.uid === key);
          if (!r) return { error: key && key !== 'first' ? `망가진 임플란트가 아닙니다: ${key}` : '망가진 임플란트 없음' };
          if (r.blocked) return { error: `수리 불가: ${r.blocked}` };
          return sys.repairImplant(r.inst.uid) ? `수리: ${r.broken.name} → ${r.target?.name ?? '?'} (−${formatCredits(r.fee)})` : { error: '수리 실패' };
        }
        return { error: '사용법: /implant list|repair <uid|first>' };
      },
      complete: (args) => {
        if (args.length <= 1) return ['list', 'repair'].filter((s) => s.startsWith((args[0] ?? '').toLowerCase()));
        if (args[0] === 'repair' && args.length === 2) return ['first', ...sys.getRepairableImplants().map((r) => r.inst.uid)].filter((s) => s.startsWith(args[1] ?? ''));
        return [];
      },
    },
    {
      name: 'quest', usage: 'quest list|accept <id>|complete <id>', description: '퀘스트 목록 / 수락 / 납품',
      run: (args, _ctx, print) => {
        const sub = (args[0] ?? 'list').toLowerCase();
        if (sub === 'list') {
          for (const d of QUEST_DEFS) {
            const st = sys.getQuestState(d.id);
            print(`  ${d.id}  ${CORP_DEFS[d.corp].name} · ${d.name} · ${st} · ${d.deliver.map((x) => `${x.defId}×${x.qty}`).join(', ')}`, st === 'complete' ? 'success' : 'info');
          }
          return `${QUEST_DEFS.length}개`;
        }
        const id = args[1];
        if (!id) return { error: `사용법: /quest ${sub} <id>` };
        const def = QUEST_DEFS.find((d) => d.id === id);
        if (!def) return { error: `알 수 없는 퀘스트: ${id}` };
        if (sub === 'accept') return sys.acceptQuest(id) ? `퀘스트 수락: ${def.name}` : { error: `수락 실패 (${sys.getQuestState(id)})` };
        if (sub === 'complete') {
          if (sys.completeQuest(id)) return `퀘스트 완료: ${def.name}`;
          return { error: `납품 실패: ${sys.questInfo(def).blocked ?? '알 수 없음'}` };
        }
        return { error: '사용법: /quest list|accept <id>|complete <id>' };
      },
      complete: (args) => {
        if (args.length <= 1) return ['list', 'accept', 'complete'].filter((s) => s.startsWith((args[0] ?? '').toLowerCase()));
        if (args.length === 2) return QUEST_DEFS.map((d) => d.id).filter((s) => s.startsWith(args[1] ?? ''));
        return [];
      },
    },
  ];
  for (const c of cmds) sys.unsubs.push(con.register(c));
  }
