import type { GameContext, NpcQuestInfo } from '@/shared';
import { CORP_DEFS, NPC_ROLE_LABEL_KO } from '@/shared';
import { clamp01, el, setText, toggleClass } from '../../dom';
import { initialOf } from './format';
import { buildQuestCard, questStateText } from './QuestCard';
import { npcOf } from './sources';
import { buildNpcAvatar, buildNpcTrust, npcTrustOf } from './Trust';

export interface QuestsTabHost {
  /** Moves to that NPC’s conversation (the 대화 tab). */
  openNpc(npcId: string): void;
  /** Whether the quest tab is visible right now. */
  isVisible(): boolean;
}

/**
 * The messenger's `퀘스트` tab (2026-09-14).
 *
 * Left list = active (reportable on top) · complete (collapsed). Right detail = the NPC head (the avatar wearing the trust ring · name · job title · the **personal trust gauge**) +
 * the quest card (`detail`): progress · [납품] per objective, [완료 보고] (lit only once every objective is full — the reason is one line under the card). There is no abandon button (user's decision).
 *
 * 2026-09-14 3rd pass (user's decision): the **engine** is where the list is filtered (`NpcQuestRef.getQuests` answers without `offered` · `deferred`) —
 * nothing is filtered again here. The branches that draw the `새 제안` · `보류` groups are kept for old saves and normally never draw a row.
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
      ctx.bus.on('meta:npcTrustChanged', again),
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
    const selNpc = all.find((q) => q.def.id === this.selected)?.npc.id ?? '';
    const key = `${!!npc}|${this.selected}|${this.doneOpen}|${npcTrustOf(ctx, selNpc)?.trust ?? ''}|` + all.map((q) =>
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
    /* 2026-09-14 3rd pass: the **same avatar** as the conversation head — the trust radial ring + the level badge at the bottom right. */
    head.appendChild(buildNpcAvatar(ctx, q.npc.id, q.npc.name, { glyph: q.npc.glyph || initialOf(q.npc.name), color: q.npc.color }));
    const main = el('div', { cls: 'ms-thead-main', parent: head });
    el('div', { cls: 'ms-thead-title', text: q.npc.name, parent: main });
    const corp = q.npc.corp ? CORP_DEFS[q.npc.corp]?.name ?? '' : '';
    el('div', { cls: 'ms-thead-sub', text: [q.npc.title, corp || NPC_ROLE_LABEL_KO[q.npc.role]].filter(Boolean).join(' · '), parent: main });
    /* 2026-09-14: the personal trust gauge of the NPC who gave the quest (the same piece as the conversation head). */
    const trustEl = buildNpcTrust(ctx, q.npc.id, q.npc.name, { color: q.npc.color });
    if (trustEl) { trustEl.classList.add('in-head'); main.appendChild(trustEl); }
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

  /** Active ∧ reportable + newly offered (the tab badge). */
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
