import type { GameContext, NpcQuestInfo } from '@/shared';
import { CORP_DEFS, NPC_ROLE_LABEL_KO } from '@/shared';
import { clamp01, el, setText, toggleClass } from '../../dom';
import { initialOf } from './format';
import { buildQuestCard, questStateText } from './QuestCard';
import { npcOf } from './sources';

export interface QuestsTabHost {
  /** 그 NPC 의 대화로 옮긴다 (대화 탭). */
  openNpc(npcId: string): void;
  /** 퀘스트 탭이 지금 보이나. */
  isVisible(): boolean;
}

/**
 * 메신저 `퀘스트` 탭 (2026-09-14, docs/plans/messenger-quests.md §5).
 *
 * 좌 목록 = 진행 중(보고 가능이 위) · 새 제안 · 보류 · 완료(접힘). 우 상세 = NPC 머리 + 퀘스트 카드(`detail`):
 * 목표마다 진척 · [납품], [완료 보고](목표가 다 차야 켜진다 — 이유는 카드 아래 한 줄), 보류는 [수락] → 대화 탭의 그 NPC 로 옮겨
 * NPC 의 짧은 설명(brief)을 보여 준다. 포기 버튼은 없다 (사용자 결정). 새 제안은 「대화에서 답하기」 로만 답한다.
 */
export class QuestsTab {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly detailEmpty: HTMLElement;
  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];
  private selected: string | null = null;
  private doneOpen = false;
  private key = '';
  private acc = 0;

  constructor(parent: HTMLElement, private readonly host: QuestsTabHost) {
    this.root = el('div', { cls: 'ms-quests', parent });
    this.list = el('div', { cls: 'ms-qlist', parent: this.root });
    this.list.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    const right = el('div', { cls: 'ms-qdetail-wrap', parent: this.root });
    this.detail = el('div', { cls: 'ms-qdetail', parent: right });
    this.detail.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.detailEmpty = el('div', { cls: 'ms-thread-empty', text: '왼쪽 목록에서 퀘스트를 고르세요', parent: right });
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const again = (): void => { if (this.host.isVisible()) this.refresh(true); else this.key = ''; };
    this.unsubs.push(
      ctx.bus.on('npc:questChanged', again),
      ctx.bus.on('npc:objectiveProgress', again),
      ctx.bus.on('npc:questReady', again),
      ctx.bus.on('inventory:changed', again),
      ctx.bus.on('inventory:stashChanged', again),
    );
  }

  get selectedId(): string | null { return this.selected; }

  select(id: string | null): void {
    this.selected = id;
    this.refresh(true);
  }

  onShow(): void { this.refresh(true); }

  tick(dt: number): void {
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc = 0;
    this.refresh();
  }

  private quests(): readonly NpcQuestInfo[] {
    return this.ctx ? npcOf(this.ctx)?.getQuests() ?? [] : [];
  }

  refresh(force = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const npc = npcOf(ctx);
    const all = this.quests();
    const key = `${!!npc}|${this.selected}|${this.doneOpen}|` + all.map((q) =>
      `${q.def.id}${q.state}${q.ready ? 1 : 0}${q.blocked ?? ''}${q.objectives.map((o) => `${o.progress}${o.have ?? ''}${o.blocked ?? ''}`).join('.')}`).join(',');
    if (!force && key === this.key) return;
    this.key = key;

    if (!this.selected || !all.some((q) => q.def.id === this.selected)) {
      this.selected = (all.find((q) => q.state === 'active') ?? all.find((q) => q.state !== 'complete') ?? all[0])?.def.id ?? null;
    }

    const active = all.filter((q) => q.state === 'active').sort((a, b) => Number(b.ready) - Number(a.ready) || b.at - a.at);
    const offered = all.filter((q) => q.state === 'offered').sort((a, b) => b.at - a.at);
    const deferred = all.filter((q) => q.state === 'deferred').sort((a, b) => b.at - a.at);
    const done = all.filter((q) => q.state === 'complete').sort((a, b) => b.at - a.at);
    const nodes: HTMLElement[] = [];
    const section = (id: string, label: string, qs: readonly NpcQuestInfo[], collapsible = false): void => {
      if (qs.length === 0) return;
      const head = el('div', { cls: `ms-qgroup-head${collapsible ? ' is-toggle' : ''}${collapsible && this.doneOpen ? ' is-open' : ''}` });
      head.dataset.group = id;
      el('span', { cls: 'ui-label', text: `${label} ${qs.length}`, parent: head });
      if (collapsible) {
        el('span', { cls: 'ms-qgroup-caret', text: this.doneOpen ? '▾' : '▸', parent: head });
        head.addEventListener('click', (e) => { e.stopPropagation(); this.doneOpen = !this.doneOpen; this.refresh(true); });
      }
      nodes.push(head);
      if (collapsible && !this.doneOpen) return;
      for (const q of qs) nodes.push(this.row(q));
    };
    section('active', '진행 중', active);
    section('offered', '새 제안', offered);
    section('deferred', '보류', deferred);
    section('complete', '완료', done, true);
    if (nodes.length === 0) {
      nodes.push(el('div', { cls: 'ms-empty', text: npc ? '받은 퀘스트가 없습니다 — NPC 가 메신저로 연락해 옵니다' : '퀘스트 정보를 불러올 수 없습니다' }));
    }
    this.list.replaceChildren(...nodes);

    const q = all.find((x) => x.def.id === this.selected) ?? null;
    this.detailEmpty.hidden = !!q;
    this.detail.hidden = !q;
    if (!q) { this.detail.replaceChildren(); return; }
    const head = el('div', { cls: 'ms-qdetail-head' });
    const av = el('span', { cls: 'ms-av big', text: q.npc.glyph || initialOf(q.npc.name), parent: head });
    av.style.setProperty('--av', q.npc.color);
    const main = el('div', { cls: 'ms-thead-main', parent: head });
    el('div', { cls: 'ms-thead-title', text: q.npc.name, parent: main });
    const corp = q.npc.corp ? CORP_DEFS[q.npc.corp]?.name ?? '' : '';
    el('div', { cls: 'ms-thead-sub', text: [q.npc.title, corp || NPC_ROLE_LABEL_KO[q.npc.role]].filter(Boolean).join(' · '), parent: main });
    const card = buildQuestCard(ctx, q, 'detail', {
      accept: (id) => {
        const ref = npcOf(ctx);
        if (!ref?.accept(id)) { this.deny('지금은 수락할 수 없습니다 — 함선에서만 가능합니다'); return; }
        ctx.bus.emit('audio:play', { id: 'ui_equip' });
        this.host.openNpc(q.npc.id);
      },
      deliver: (id, index) => {
        const n = npcOf(ctx)?.deliver(id, index) ?? 0;
        if (n > 0) ctx.bus.emit('audio:play', { id: 'ui_equip' });
        else this.deny(q.objectives.find((o) => o.def.index === index)?.blocked ?? '납품할 수 없습니다');
        this.refresh(true);
      },
      report: (id) => {
        if (!npcOf(ctx)?.report(id)) { this.deny(q.blocked ?? '지금은 보고할 수 없습니다'); return; }
        this.refresh(true);
      },
      openNpc: (npcId) => this.host.openNpc(npcId),
    });
    this.detail.replaceChildren(head, card);
  }

  private row(q: NpcQuestInfo): HTMLElement {
    const row = el('button', { cls: `ms-qrow is-${q.state}${q.state === 'active' && q.ready ? ' is-ready' : ''}${q.def.id === this.selected ? ' is-sel' : ''}` });
    row.type = 'button';
    row.dataset.quest = q.def.id;
    row.style.setProperty('--qc', q.npc.color);
    const top = el('span', { cls: 'ms-qrow-top', parent: row });
    el('span', { cls: 'ms-qrow-name', text: q.def.name, parent: top });
    el('span', { cls: 'ms-qrow-state', text: questStateText(q), parent: top });
    el('span', { cls: 'ms-qrow-npc', text: q.npc.name, parent: row });
    if (q.state === 'active') {
      const bar = el('span', { cls: 'ms-bar', parent: row });
      el('i', { parent: bar }).style.transform = `scaleX(${clamp01(q.progress).toFixed(3)})`;
    }
    row.addEventListener('click', (e) => { e.stopPropagation(); this.select(q.def.id); });
    return row;
  }

  private deny(text: string): void {
    this.ctx?.bus.emit('ui:notify', { text, kind: 'warning', duration: 2.8 });
    this.ctx?.bus.emit('audio:play', { id: 'ui_deny' });
  }

  /** 진행 중 ∧ 보고 가능 + 새 제안 (탭 배지). */
  static badgeCount(ctx: GameContext): number {
    const qs = npcOf(ctx)?.getQuests() ?? [];
    let n = 0;
    for (const q of qs) if ((q.state === 'active' && q.ready) || q.state === 'offered') n++;
    return n;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }
}

/* keep `setText` / `toggleClass` in the import list honest for future row updates */
void setText; void toggleClass;
