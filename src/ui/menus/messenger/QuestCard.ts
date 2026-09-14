import type { CurrencyId, GameContext, NpcObjectiveInfo, NpcQuestInfo } from '@/shared';
import { buildCurrencyChip, buildItemChip } from '@/shared';
import { clamp01, el } from '../../dom';
import { buildTrustChip } from './Trust';

/**
 * NPC 퀘스트 카드 (2026-09-14) — 대화 말풍선(`bubble`)과 퀘스트 탭의 상세(`detail`)가 **같은 카드**를 그린다.
 * 이름 · 설명 · 목표(문구 · 진척 · [납품]) · 보상(재화 칩 + **NPC 개인 신뢰도 칩** + 아이템 칩) · 버튼. 상태는 매번 `NpcQuestRef.getQuest` 로 새로 읽어
 * 다시 짓는다 (카드는 상태를 들고 있지 않다).
 *
 *   - bubble · offered  → [수락] **하나뿐**이다 (2026-09-14 3차, 사용자 결정 — 「생각해보지」 는 없앴다)
 *   - bubble · 그 밖    → 상태 배지 + 「퀘스트 탭에서 보기」
 *   - detail · offered  → 「대화에서 답하기」
 *   - detail · deferred → [수락]. `deferred` 는 **은퇴한 상태**라(`shared/npc`) 엔진이 더 이상 돌려주지 않는다 —
 *                         옛 세이브가 들고 있을 수 있어 그리는 분기만 조용히 남겨 둔다.
 *   - detail · active   → 목표마다 [납품] (deliver) + [완료 보고] (목표가 다 차야 켜진다). **포기 버튼은 없다** (사용자 결정).
 */

export interface QuestCardActions {
  accept?(id: string): void;
  deliver?(id: string, index: number): void;
  report?(id: string): void;
  /** 말풍선 카드의 「퀘스트 탭에서 보기」. */
  openTab?(id: string): void;
  /** 상세 카드의 「대화에서 답하기」 · 「대화 보기」. */
  openNpc?(npcId: string): void;
}

export type QuestCardMode = 'bubble' | 'detail';

export function questStateText(q: NpcQuestInfo): string {
  switch (q.state) {
    case 'offered': return '제안';
    case 'deferred': return '보류';
    case 'active': return q.ready ? '보고 가능' : '진행 중';
    case 'complete': return '완료';
    default: return '';
  }
}

function button(parent: HTMLElement, text: string, kind: string, act: string, run: () => void): HTMLButtonElement {
  const b = el('button', { cls: `ms-btn${kind ? ` ${kind}` : ''}`, text, parent });
  b.type = 'button';
  b.dataset.act = act;
  b.addEventListener('click', (e) => { e.stopPropagation(); if (!b.disabled) run(); });
  return b;
}

function objectiveRow(q: NpcQuestInfo, o: NpcObjectiveInfo, mode: QuestCardMode, showProgress: boolean, act: QuestCardActions): HTMLElement {
  const row = el('div', { cls: `ms-qobj${o.done ? ' is-done' : ''}${o.raid ? ' is-raid' : ' is-ship'}${o.countsHere ? ' is-here' : ''}` });
  row.dataset.index = String(o.def.index);
  row.dataset.kind = o.def.kind;
  el('span', { cls: 'ms-qchk', text: o.done ? '✓' : '', parent: row });
  const main = el('div', { cls: 'ms-qomain', parent: row });
  const line = el('div', { cls: 'ms-qoline', parent: main });
  el('span', { cls: 'ms-qolabel', text: o.label, parent: line });
  el('span', { cls: 'ms-qokind', text: o.raid ? '레이드' : '함선', parent: line });
  if (showProgress) {
    const shown = Math.max(0, Math.min(o.progress, o.target));
    el('span', { cls: 'ms-qonum ui-mono', text: `${shown} / ${o.target}`, parent: line });
    const bar = el('div', { cls: 'ms-bar', parent: main });
    const fill = el('i', { parent: bar });
    fill.style.transform = `scaleX(${clamp01(o.target > 0 ? o.progress / o.target : 0).toFixed(3)})`;
  }
  if (mode === 'detail' && q.state === 'active' && o.def.kind === 'deliver' && !o.done) {
    const side = el('div', { cls: 'ms-qoside', parent: row });
    el('span', { cls: 'ms-qhave ui-mono', text: `보유 ${o.have ?? 0}`, parent: side });
    const b = button(side, '납품', '', 'deliver', () => act.deliver?.(q.def.id, o.def.index));
    if (o.blocked) { b.disabled = true; b.title = o.blocked; }
  }
  return row;
}

export function buildQuestCard(ctx: GameContext, q: NpcQuestInfo, mode: QuestCardMode, act: QuestCardActions): HTMLElement {
  const id = q.def.id;
  const card = el('div', { cls: `ms-qcard is-${q.state}${q.state === 'active' && q.ready ? ' is-ready' : ''} mode-${mode}` });
  card.dataset.quest = id;
  card.style.setProperty('--qc', q.npc.color);

  const head = el('div', { cls: 'ms-qhead', parent: card });
  el('span', { cls: 'ms-qtag', text: '퀘스트', parent: head });
  el('span', { cls: 'ms-qname', text: q.def.name, parent: head });
  el('span', { cls: 'ms-qstate', text: questStateText(q), parent: head });
  if (q.def.summary) el('div', { cls: 'ms-qsum', text: q.def.summary, parent: card });

  const showProgress = q.state === 'active' || q.state === 'complete';
  const objs = el('div', { cls: 'ms-qobjs', parent: card });
  el('div', { cls: 'ms-qsec', text: '목표', parent: objs });
  for (const o of q.objectives) objs.appendChild(objectiveRow(q, o, mode, showProgress, act));
  if (showProgress && q.state === 'active') {
    const total = el('div', { cls: 'ms-qtotal', parent: objs });
    const bar = el('div', { cls: 'ms-bar big', parent: total });
    el('i', { parent: bar }).style.transform = `scaleX(${clamp01(q.progress).toFixed(3)})`;
    el('span', { cls: 'ms-qpct ui-mono', text: `${Math.round(clamp01(q.progress) * 100)}%`, parent: total });
  }

  const rew = el('div', { cls: 'ms-qrew', parent: card });
  el('div', { cls: 'ms-qsec', text: '보상', parent: rew });
  const chips = el('div', { cls: 'ms-qchips', parent: rew });
  const r = q.def.rewards;
  if (r.credits > 0) chips.appendChild(buildCurrencyChip('credits', { amount: r.credits, signed: true, size: 30 }));
  if (r.xp > 0) chips.appendChild(buildCurrencyChip('xp', { amount: r.xp, signed: true, size: 30 }));
  for (const p of r.rep) if (p.amount > 0) chips.appendChild(buildCurrencyChip(`rep:${p.corp}` as CurrencyId, { amount: p.amount, signed: true, size: 30 }));
  /* 2026-09-14: 기업 신뢰도 칩 바로 뒤에 **그 NPC 개인** 신뢰도 칩 (같은 육각 틀 · NPC 색). */
  const trustChip = buildTrustChip(q.npc.name, r.npcTrust, q.npc.color);
  if (trustChip) chips.appendChild(trustChip);
  for (const it of r.items) chips.appendChild(buildItemChip(ctx.loot?.getItemDef(it.defId), { need: it.qty, size: 30 }));
  if (chips.childElementCount === 0) el('span', { cls: 'ms-qnone', text: '없음', parent: chips });

  const foot = el('div', { cls: 'ms-qfoot', parent: card });
  if (mode === 'bubble') {
    if (q.state === 'offered') {
      button(foot, '수락', 'primary', 'accept', () => act.accept?.(id));
    } else if (act.openTab) {
      button(foot, '퀘스트 탭에서 보기', 'link', 'tab', () => act.openTab?.(id));
    }
  } else {
    if (q.state === 'offered') button(foot, '대화에서 답하기', 'primary', 'npc', () => act.openNpc?.(q.npc.id));
    else if (act.openNpc) button(foot, '대화 보기', 'link', 'npc', () => act.openNpc?.(q.npc.id));
    if (q.state === 'deferred') button(foot, '수락', 'primary', 'accept', () => act.accept?.(id));
    if (q.state === 'active') {
      const b = button(foot, '완료 보고', 'primary', 'report', () => act.report?.(id));
      const why = q.blocked ?? (q.ready ? null : '목표를 모두 채워야 보고할 수 있습니다');
      if (why) {
        b.disabled = true;
        b.title = why;
        el('div', { cls: 'ms-qwhy', text: why, parent: card });
      }
    }
  }
  if (foot.childElementCount === 0) foot.remove();
  else card.appendChild(foot);   // keep the buttons last (the reason line above them)
  return card;
}
