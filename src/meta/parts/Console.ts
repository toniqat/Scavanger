/**
 * src/meta/parts/Console.ts — the dev console commands `credits` / `rep` / `contract` / `implant` / `npc`
 * (2026-09-14 — in place of the old `quest`) / `mail` (2026-09-21).
 *
 * Registered on dev clients only (see `src/console`). It holds no game rule at all and calls the APIs above.
 */
import type {
  ConsoleCommand, ContractGoalKind,
} from '@/shared';
import {
  CONTRACT_DEFS, CONTRACT_GOAL_LABEL_KO, CORP_DEFS, CORP_IDS, formatCredits,
} from '@/shared';
import {
  contractBlockReason,
} from '../Rules';
import { GOAL_IDS } from '../model';
import type { MetaSystem } from '../MetaSystem';
import { formatCreditReason } from '@/shared';
import { NPC_DEFS, NPC_FLAGS, NPC_QUEST_DEFS } from '@/shared';
import type { NpcFlag } from '@/shared';
import { freshNpcSave } from '../NpcRules';

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
        // E-4 (⑦): a dev reason — a relay only takes it with SCAV_DEV_ECONOMY=1 (only the relay the verify runner starts — dev:all keeps it off; the console prints a hint); otherwise it is reverted
        if (!sys.addCredits(n, formatCreditReason({ kind: 'dev', id: '', tag: 'console' }))) return { error: `크레딧 부족 (보유 ${formatCredits(sys.credits)})` };
        return `크레딧 ${formatCredits(sys.credits)}`;
      },
    },
    {
      name: 'rep', usage: 'rep <helix|bastion|nomad|ceres|atlas|한국어> <±n>', description: '기업 신뢰도를 더하거나 뺍니다',
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
    /* 2026-09-14: corp quests (`quest`) dropped → NPC quests (`npc`). Forced contact · offer (requirements
       ignored), accept · defer · deliver · report, a progress cheat, and a reset. */
    {
      name: 'npc', usage: 'npc list|flags [<플래그> <n>]|contact <npc>|offer <quest>|accept <quest>|deliver <quest> <i>|report <quest>|progress <quest> <i> <n>|reset',
      description: 'NPC 연락 · 퀘스트 목록 / 진행 플래그 보기 · 올리기 / 강제 연락 · 제안 / 수락 · 납품 · 완료 보고 / 진행 치트',
      run: (args, _ctx, print) => {
        const nq = sys.npcQuests;
        const sub = (args[0] ?? 'list').toLowerCase();
        if (sub === 'list') {
          for (const c of nq.getContacts()) print(`  ${c.npc.id}  ${c.npc.name} (${c.npc.title}) · 안 읽음 ${c.unread}`, 'info');
          /* 2026-09-14 (3rd pass): `getQuests()` now answers with accepted quests only (active · complete) — the
           * console has to see `offered` too, so it walks the defs and asks `getQuest(id)` (null when there is no
           * state). */
          let n = 0;
          for (const def of NPC_QUEST_DEFS) {
            const q = nq.getQuest(def.id);
            if (!q) continue;
            n++;
            const objs = q.objectives.map((o, i) => `#${i} ${o.label} ${o.progress}/${o.target}${o.done ? '✓' : ''}`).join(' · ');
            print(`  ${q.def.id}  [${q.state}] ${q.npc.name} · ${q.def.name} — ${objs}`, q.state === 'complete' ? 'success' : 'info');
          }
          return `연락 ${nq.getContacts().length} · 퀘스트 ${n} (정의 NPC ${NPC_DEFS.length} · 퀘스트 ${NPC_QUEST_DEFS.length})`;
        }
        /* 2026-09-14 (3rd pass): the progress flags — the first-contact requirement of the four corps' NPCs
           (`reqFlag` in `data/npcs.csv`). With no argument = show them. */
        if (sub === 'flags') {
          const flag = args[1];
          if (flag !== undefined) {
            if (!(NPC_FLAGS as readonly string[]).includes(flag)) return { error: `모르는 플래그: ${flag} (${NPC_FLAGS.join(' | ')})` };
            const want = args[2] === undefined ? nq.flagOf(flag as NpcFlag) + 1 : num(args[2]);
            if (Number.isNaN(want)) return { error: '사용법: /npc flags <플래그> <횟수>' };
            const delta = Math.max(0, Math.floor(want) - nq.flagOf(flag as NpcFlag));
            if (delta <= 0) return { error: `${flag} 은 이미 ${nq.flagOf(flag as NpcFlag)} 이다 (플래그는 내릴 수 없다 — /npc reset)` };
            nq.bumpFlag(flag as NpcFlag, delta);
            return `${flag} = ${nq.flagOf(flag as NpcFlag)}`;
          }
          for (const f of NPC_FLAGS) print(`  ${f} = ${nq.flagOf(f)}`, 'info');
          return `진행 플래그 ${NPC_FLAGS.length}종`;
        }
        if (sub === 'reset') {
          sys.store.data.npc = freshNpcSave();
          sys.store.markDirty();
          nq.reset();
          nq.evaluate();
          return 'NPC 연락 · 대화 · 퀘스트 · 진행 플래그 초기화';
        }
        const id = args[1];
        if (!id) return { error: `사용법: /npc ${sub} <id>` };
        if (sub === 'contact') return nq.forceContact(id) ? `연락: ${id}` : { error: `이미 연락했거나 모르는 NPC: ${id}` };
        if (sub === 'offer') return nq.forceOffer(id) ? `제안: ${id}` : { error: `이미 상태가 있거나 모르는 퀘스트: ${id}` };
        if (sub === 'accept') return nq.accept(id) ? `수락: ${id}` : { error: `수락 실패 (${nq.getQuest(id)?.state ?? '제안 없음'}${sys.inShip ? '' : ' · 함선에서만'})` };
        // 2026-09-14 (3rd pass): 「생각해보지」 is retired — `defer` is always false. Kept for old fingers: it
        // answers with the reason and nothing else.
        if (sub === 'defer') return { error: '「생각해보지」는 은퇴했습니다 (2026-09-14 3차) — 제안은 수락하거나 그대로 둡니다' };
        if (sub === 'report') return nq.report(id) ? `완료 보고: ${id}` : { error: `보고 실패: ${nq.getQuest(id)?.blocked ?? '진행 중인 퀘스트가 아닙니다'}` };
        const idx = num(args[2]);
        if (sub === 'deliver') {
          if (Number.isNaN(idx)) return { error: '사용법: /npc deliver <quest> <목표 번호>' };
          const n = nq.deliver(id, idx);
          return n > 0 ? `납품 ${n}개` : { error: `납품 실패: ${nq.getQuest(id)?.objectives[idx]?.blocked ?? '납품 목표가 아닙니다'}` };
        }
        if (sub === 'progress') {
          const n = num(args[3]);
          if (Number.isNaN(idx) || Number.isNaN(n)) return { error: '사용법: /npc progress <quest> <목표 번호> <n>' };
          return nq.devProgress(id, idx, n) ? `진행 ${id} #${idx} = ${n}` : { error: '진행 중인 퀘스트 · 목표가 아닙니다' };
        }
        return { error: '사용법: /npc list|flags|contact|offer|accept|deliver|report|progress|reset' };
      },
      complete: (args) => {
        const subs = ['list', 'flags', 'contact', 'offer', 'accept', 'deliver', 'report', 'progress', 'reset'];
        if (args.length <= 1) return subs.filter((s) => s.startsWith((args[0] ?? '').toLowerCase()));
        if (args.length === 2 && args[0] === 'flags') return NPC_FLAGS.filter((s) => s.startsWith(args[1] ?? ''));
        if (args.length === 2 && args[0] === 'contact') return NPC_DEFS.map((d) => d.id).filter((s) => s.startsWith(args[1] ?? ''));
        if (args.length === 2) return NPC_QUEST_DEFS.map((d) => d.id).filter((s) => s.startsWith(args[1] ?? ''));
        return [];
      },
    },
    /*
     * 2026-09-21: the mailbox. `mail send [<defId> <qty> …]` delivers a test mail (a fresh id every time, so it is never
     * swallowed by the idempotent `send`); with no items it carries a bandage stack and a sapphire.
     */
    {
      name: 'mail', usage: 'mail list|send [<defId> <qty> …]|claim|clear|reset', description: '우편함 — 테스트 메일 보내기 / 목록 / 모두 받기 / 읽은 메일 삭제 / 초기화',
      run: (args) => {
        const mail = sys.mail;
        const sub = (args[0] ?? 'list').toLowerCase();
        if (sub === 'list') {
          const l = mail.list();
          if (l.length === 0) return '우편함이 비었습니다';
          return l.map((m) => `${m.read ? ' ' : '*'} ${m.id} · ${m.fromName} · ${m.subject}${m.items.length ? ` · 첨부 ${m.items.map((i) => `${i.defId}×${i.qty}`).join(', ')}` : ''}`).join('\n');
        }
        if (sub === 'send') {
          const items: { defId: string; qty: number }[] = [];
          for (let i = 1; i < args.length; i += 2) {
            const defId = args[i];
            const qty = args[i + 1] === undefined ? 1 : num(args[i + 1]);
            if (!sys.ctx.loot?.getItemDef(defId)) return { error: `알 수 없는 아이템: ${defId}` };
            if (Number.isNaN(qty) || qty < 1) return { error: `수량이 올바르지 않습니다: ${args[i + 1]}` };
            items.push({ defId, qty: Math.floor(qty) });
          }
          if (items.length === 0) items.push({ defId: 'heal_bandage', qty: 3 }, { defId: 'gem_sapphire', qty: 1 });
          const id = `dev:${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
          const ok = mail.send({
            id, from: '시스템', subject: '테스트 메일',
            body: '개발 콘솔에서 보낸 테스트 메일입니다.\n첨부 아이템은 함선 창고로 받습니다.',
            items,
          });
          return ok ? `메일 발송: ${id}` : { error: '발송 실패' };
        }
        if (sub === 'claim') return `모두 받기: ${mail.claimAll()}`;
        if (sub === 'clear') return `읽은 메일 ${mail.deleteRead()}통 삭제`;
        if (sub === 'reset') { sys.mailPart.reset(); return '우편함 초기화'; }
        return { error: '사용법: /mail list|send [<defId> <qty> …]|claim|clear|reset' };
      },
      complete: (args) => {
        if (args.length <= 1) return ['list', 'send', 'claim', 'clear', 'reset'].filter((s) => s.startsWith((args[0] ?? '').toLowerCase()));
        if (args[0] === 'send' && args.length % 2 === 0) {
          const q = args[args.length - 1] ?? '';
          return (sys.ctx.loot?.getAllItemDefs() ?? []).map((d) => d.id).filter((s) => s.startsWith(q)).slice(0, 40);
        }
        return [];
      },
    },
  ];
  for (const c of cmds) sys.unsubs.push(con.register(c));
  }
