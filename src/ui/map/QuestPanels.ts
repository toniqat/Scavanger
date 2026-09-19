/**
 * src/ui/map/QuestPanels.ts — the **quest panel list** of the tactical map's left column + a hover detail tooltip
 * (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」 — user's decision 「the quest list
 * panel above the legend, the legend at the bottom left」).
 *
 * What is drawn: `ctx.meta.npc.getRaidTracks()` — NPC quests that are running and have at least one objective that
 * can be counted in this raid. Each panel holds the quest name · the NPC (portrait glyph + name, NPC colour) · the
 * objective rows **that count in this raid** (`라벨  p / t`, a committed one dimmed with ✓) · a progress gauge at
 * the bottom of the panel (`info.progress`). Hovering shows a tooltip with the summary · every objective (a ship
 * objective is tagged 「함선에서」, plus the planet condition) · the rewards.
 *
 * The list is rebuilt only when its **signature** (quest · state · objective progress) changes — while the map is
 * open `tick` asks every `POLL_S` (a recovery objective counts what is carried, so it moves with the inventory),
 * and `npc:objectiveProgress` · `npc:questChanged` call `refresh(true)`. With no `ctx.meta.npc` (an old meta · a
 * test) the list hides and only the legend remains. The tooltip is built inside ui (progression's SheetTip is not
 * imported).
 *
 * **2026-09-18 (user's decision)** — one more panel, the tutorial objective panel, stands **above** that list
 * (`MapTutorialPanel`, at the very top of the left column). Its one source is `ctx.tutorial.panelInfo()` (the same
 * snapshot the guide panel draws), and with no tutorial running it draws nothing at all, exactly like the quest
 * list. Same column · same update beat, so this class builds both and `refresh`es · `hide`s both together.
 */
import type { GameContext, NpcObjectiveInfo, NpcQuestInfo, TutorialPanelInfo } from '@/shared';
import {
  CORP_DEFS, PLANET_DEFS, formatCompactSigned, formatCredits, renderKeyText, tutorialCountLabel,
} from '@/shared';
/* 2026-09-16 (user's decision 「큰 수 축약」): XP on the reward row uses the same notation as credits
   (`shared/numberFormat`). Objective progress `p / t` · trust · item counts stay `count` — there the exact value
   is the meaning. */
import { el, escapeHtml, rarityColor } from '../dom';
import '../styles/mapquests.css';

/** Interval at which the tracks are asked for again while the map is open (simulation seconds). */
const POLL_S = 0.5;
/** Gap between the tooltip and the left column (px). */
const TIP_GAP = 12;

function planetName(id: string | undefined): string {
  if (!id) return '';
  return PLANET_DEFS.find((p) => p.id === id)?.name ?? id;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const count = (n: number): string => String(Math.max(0, Math.floor(Number.isFinite(n) ? n : 0)));

/** Objectives drawn on a panel — the raid objectives that count right now or are already committed. */
function panelObjectives(t: NpcQuestInfo): NpcObjectiveInfo[] {
  return t.objectives.filter((o) => o.raid && (o.countsHere || o.done));
}

function signatureOf(tracks: readonly NpcQuestInfo[]): string {
  let s = '';
  for (const t of tracks) {
    s += `${t.def.id}:${t.state}:${t.ready ? 1 : 0}[`;
    for (const o of t.objectives) s += `${o.progress}/${o.target}${o.done ? 'd' : ''}${o.countsHere ? 'h' : ''},`;
    s += ']|';
  }
  return s;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The tutorial objective panel (2026-09-18, user's decision — 「in the tutorial raid the guide objectives show on
 * the map too」).
 *
 * At the **very top** of the left column, above the NPC quest list. What it draws is the one snapshot
 * `ctx.tutorial.panelInfo()` hands over — sequential reveal · completion · the counted numbers are not recomputed
 * here (that is how it would go out of step with the guide panel at the top left). With no tutorial running
 * (`panelInfo()` is null · there is no `ctx.tutorial`) it **draws nothing at all**, exactly like the quest list.
 * The look is the quest panel's and the colour is the accent (leaving `--mq-npc` unset drops `.mq-panel` to the
 * accent colour).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Panel subtitle — one line saying this panel is the guide, not a quest. */
const TUTORIAL_SUB_KO = '튜토리얼';

/** The signature that decides a rebuild — step · progress · each row's done state and count. */
function tutorialSignature(info: TutorialPanelInfo | null): string {
  if (!info) return '';
  let s = `${info.track}:${info.step}:${info.index}/${info.count}|${info.gauge?.label ?? ''}[`;
  for (const o of info.objectives) s += `${o.id}${o.done ? 'd' : ''}${o.count ? `${o.count.at}/${o.count.total}` : ''},`;
  return `${s}]`;
}

class MapTutorialPanel {
  readonly root: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly body: HTMLElement;
  private ctx: GameContext | null = null;
  /** Rebuild sentinel — a single space is a signature neither builder can make (both start empty and only append). It was a raw NUL until 2026-09-19, which made git · `rg` read this file as binary. */
  private sig = ' ';
  private suppressed = false;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'mq-tut', parent });
    const head = el('div', { cls: 'mq-head', parent: this.root });
    el('span', { cls: 'ui-label', text: '안내', parent: head });
    this.countEl = el('span', { cls: 'mq-count ui-mono', parent: head });
    this.body = el('div', { cls: 'mq-tut-body', parent: this.root });
    this.root.hidden = true;
  }

  bind(ctx: GameContext): void { this.ctx = ctx; }

  /** The step currently drawn (debug · smoke, null with none). */
  get stepId(): string | null { return this.root.hidden ? null : this.body.firstElementChild?.getAttribute('data-step') ?? null; }

  setSuppressed(on: boolean): void {
    if (this.suppressed === on) return;
    this.suppressed = on;
    this.refresh(true);
  }

  refresh(force = false): void {
    let info: TutorialPanelInfo | null = null;
    const t = this.ctx?.tutorial;
    if (t && !this.suppressed && typeof t.panelInfo === 'function') {
      try { info = t.panelInfo(); } catch { info = null; }
    }
    const sig = tutorialSignature(info);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    this.render(info);
  }

  /** On closing the map — the next open rebuilds from scratch. */
  hide(): void { this.sig = ' '; }

  dispose(): void { this.root.remove(); }

  private render(info: TutorialPanelInfo | null): void {
    this.root.hidden = info === null;
    this.body.replaceChildren();
    if (!info) { this.countEl.textContent = ''; return; }
    this.countEl.textContent = info.count > 0 ? `${info.index} / ${info.count}` : '';
    const p = el('div', { cls: 'mq-panel is-tut', parent: this.body });
    p.dataset.step = info.step;
    const top = el('div', { cls: 'mq-top', parent: p });
    el('span', { cls: 'mq-glyph', text: '◇', parent: top });
    const names = el('div', { cls: 'mq-names', parent: top });
    el('div', { cls: 'mq-name', text: info.label, parent: names });
    el('div', { cls: 'mq-npc', text: TUTORIAL_SUB_KO, parent: names });
    const objs = el('div', { cls: 'mq-objs', parent: p });
    for (const o of info.objectives) {
      const row = el('div', { cls: `mq-obj${o.done ? ' is-done' : ''}`, parent: objs });
      row.dataset.obj = o.id;
      el('span', { cls: 'mq-tut-box', parent: row });
      // Keycap tokens (`{INTERACT}` · `{JUMP:hold}`) resolve against the live `Keys` **at draw time** — the same
      // function the guide panel uses
      renderKeyText(el('span', { cls: 'mq-obj-l', parent: row }), o.text);
      /* 2026-09-18: the number text is built by **the same function as the guide panel**
         (`shared/tutorial.tutorialCountLabel`) — writing the grouping commas separately here made the same row read
         `1,000 / 1,000 C` on one screen and `1000 / 1000 C` on the other. The NPC quest rows below stay on
         `count()` — they carry no unit and their progress is one where 「정확한 값이 곧 뜻」, so the rule differs
         (`CLAUDE.md` §4.2 「큰 수 축약」). */
      const n = o.count ? tutorialCountLabel(o.count.at, o.count.total, o.count.unit) : o.done ? '✓' : '';
      if (n) el('span', { cls: 'mq-obj-n ui-mono', text: n, parent: row });
    }
    /* Progress gauge — only the raid step of 「출격 안내」 measures **loot value** (`gauge`) and prints the real
       value over it (`1,400 C / 1,000 C` — the same value as the guide panel's bar,
       `tutorial/model.creditGaugeLabel`). Everything else is the step count. */
    const g = info.gauge;
    if (g) el('div', { cls: 'mq-tut-n ui-mono', text: g.label, parent: p });
    const frac = g ? (g.total > 0 ? g.at / g.total : 0) : (info.count > 0 ? info.index / info.count : 0);
    const pct = Math.round(clamp01(frac) * 100);
    const gauge = el('div', { cls: 'mq-gauge', parent: p });
    gauge.dataset.progress = String(pct);
    el('i', { parent: gauge }).style.width = `${pct}%`;
  }
}

export class MapQuestPanels {
  readonly root: HTMLElement;
  /** 2026-09-18: the tutorial objective panel **above** the quest list — same column, so this class builds and refreshes both. */
  private readonly tutorial: MapTutorialPanel;
  private readonly countEl: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly tip: HTMLElement;
  private ctx: GameContext | null = null;
  private tracks: readonly NpcQuestInfo[] = [];
  /** Rebuild sentinel — a single space is a signature neither builder can make (both start empty and only append). It was a raw NUL until 2026-09-19, which made git · `rg` read this file as binary. */
  private sig = ' ';
  private hoverId: string | null = null;
  private suppressed = false;
  private nextPoll = 0;

  private readonly onOver = (e: PointerEvent): void => {
    const panel = (e.target as HTMLElement | null)?.closest<HTMLElement>('.mq-panel') ?? null;
    const id = panel?.dataset.quest ?? null;
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.renderTip();
  };
  private readonly onLeave = (): void => {
    if (this.hoverId === null) return;
    this.hoverId = null;
    this.renderTip();
  };
  private readonly onScroll = (): void => { this.placeTip(); };

  /** `parent` = the map's left column (appended right after the head), `tipHost` = the map screen root. */
  constructor(parent: HTMLElement, tipHost: HTMLElement) {
    // 2026-09-18: the tutorial panel is appended **first** — the left column stacks in append order and the guide
    //             sits above the quests (user's decision)
    this.tutorial = new MapTutorialPanel(parent);
    this.root = el('div', { cls: 'mq-list', parent });
    const head = el('div', { cls: 'mq-head', parent: this.root });
    el('span', { cls: 'ui-label', text: '퀘스트', parent: head });
    this.countEl = el('span', { cls: 'mq-count ui-mono', parent: head });
    this.scroll = el('div', { cls: 'mq-scroll', parent: this.root });
    this.tip = el('div', { cls: 'mq-tip', parent: tipHost });
    this.tip.hidden = true;
    this.root.hidden = true;
    this.scroll.addEventListener('pointerover', this.onOver);
    this.scroll.addEventListener('pointerleave', this.onLeave);
    this.scroll.addEventListener('scroll', this.onScroll, { passive: true });
  }

  bind(ctx: GameContext): void { this.ctx = ctx; this.tutorial.bind(ctx); }

  /** Quest ids of the visible panels (debug · smoke). */
  get questIds(): string[] { return this.tracks.map((t) => t.def.id); }
  /** The step the tutorial panel is drawing (debug · smoke, null with none). */
  get tutorialStep(): string | null { return this.tutorial.stepId; }
  /** Quest id whose tooltip is up (debug · smoke). */
  get tipQuest(): string | null { return this.tip.hidden ? null : this.hoverId; }

  /** Hides the list during destination selection mode (the rover panel takes the column's room). */
  setSuppressed(on: boolean): void {
    if (this.suppressed === on) return;
    this.suppressed = on;
    this.tutorial.setSuppressed(on);
    this.refresh(true);
  }

  /** Every frame while the map is open. */
  tick(time: number): void {
    if (time < this.nextPoll) return;
    this.nextPoll = time + POLL_S;
    this.refresh();
  }

  /** Asks for the tracks again and rebuilds when the signature changed or `force` is set. */
  refresh(force = false): void {
    // 2026-09-18: the tutorial objectives follow the same beat (loot value moves with every pickup — an unchanged
    //             signature leaves the DOM alone)
    this.tutorial.refresh(force);
    let tracks: readonly NpcQuestInfo[] = [];
    const npc = this.ctx?.meta?.npc;
    if (npc && !this.suppressed) {
      try { tracks = npc.getRaidTracks(); } catch { tracks = []; }
    }
    const sig = signatureOf(tracks);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    this.tracks = tracks;
    this.render();
  }

  /** On closing the map — the tooltip goes down and the next open rebuilds from scratch. */
  hide(): void {
    this.tutorial.hide();
    this.hoverId = null;
    this.tip.hidden = true;
    this.sig = ' ';
  }

  dispose(): void {
    this.scroll.removeEventListener('pointerover', this.onOver);
    this.scroll.removeEventListener('pointerleave', this.onLeave);
    this.scroll.removeEventListener('scroll', this.onScroll);
    this.tip.remove();
    this.tutorial.dispose();
    this.root.remove();
  }

  /* ── drawing ────────────────────────────────────────────────────────────── */

  private render(): void {
    const list = this.tracks;
    this.root.hidden = list.length === 0;
    this.countEl.textContent = list.length > 0 ? String(list.length) : '';
    const top = this.scroll.scrollTop;
    this.scroll.replaceChildren();
    for (const t of list) this.scroll.appendChild(this.buildPanel(t));
    this.scroll.scrollTop = top;
    if (this.hoverId && !list.some((t) => t.def.id === this.hoverId)) this.hoverId = null;
    this.renderTip();
  }

  private buildPanel(t: NpcQuestInfo): HTMLElement {
    const p = el('div', { cls: `mq-panel${t.ready ? ' is-ready' : ''}` });
    p.dataset.quest = t.def.id;
    p.style.setProperty('--mq-npc', t.npc.color);
    const top = el('div', { cls: 'mq-top', parent: p });
    el('span', { cls: 'mq-glyph', text: t.npc.glyph, parent: top });
    const names = el('div', { cls: 'mq-names', parent: top });
    el('div', { cls: 'mq-name', text: t.def.name, parent: names });
    el('div', { cls: 'mq-npc', text: t.npc.name, parent: names });
    const objs = el('div', { cls: 'mq-objs', parent: p });
    for (const o of panelObjectives(t)) {
      const row = el('div', { cls: `mq-obj${o.done ? ' is-done' : ''}`, parent: objs });
      row.dataset.index = String(o.def.index);
      el('span', { cls: 'mq-obj-l', text: o.label, parent: row });
      el('span', { cls: 'mq-obj-n ui-mono', text: o.done ? '✓' : `${count(o.progress)} / ${o.target}`, parent: row });
    }
    const pct = Math.round(clamp01(t.progress) * 100);
    const gauge = el('div', { cls: 'mq-gauge', parent: p });
    gauge.dataset.progress = String(pct);
    el('i', { parent: gauge }).style.width = `${pct}%`;
    return p;
  }

  private renderTip(): void {
    const t = this.hoverId ? this.tracks.find((x) => x.def.id === this.hoverId) : undefined;
    if (!t) { this.tip.hidden = true; return; }
    this.tip.style.setProperty('--mq-npc', t.npc.color);
    this.tip.innerHTML = this.tipHtml(t);
    this.tip.hidden = false;
    this.placeTip();
  }

  /** To the right of the left column, aligned with the hovered panel's top line (lifted when it overflows the bottom). */
  private placeTip(): void {
    if (this.tip.hidden || !this.hoverId) return;
    let panel: HTMLElement | null = null;
    for (const c of this.scroll.children) if ((c as HTMLElement).dataset.quest === this.hoverId) { panel = c as HTMLElement; break; }
    if (!panel) { this.tip.hidden = true; return; }
    const r = panel.getBoundingClientRect();
    const side = this.root.parentElement?.getBoundingClientRect();
    const x = (side?.right ?? r.right) + TIP_GAP;
    const h = this.tip.offsetHeight;
    const y = Math.max(8, Math.min(window.innerHeight - h - 8, r.top));
    this.tip.style.left = `${Math.round(x)}px`;
    this.tip.style.top = `${Math.round(y)}px`;
  }

  private tipHtml(t: NpcQuestInfo): string {
    const e = escapeHtml;
    const who = t.npc.title ? `${e(t.npc.name)} · ${e(t.npc.title)}` : e(t.npc.name);
    let h = `<div class="mq-tip-name">${e(t.def.name)}</div><div class="mq-tip-npc">${who}</div>`;
    if (t.def.summary) h += `<div class="mq-tip-sum">${e(t.def.summary)}</div>`;
    h += '<div class="mq-tip-sec">목표</div><div class="mq-tip-objs">';
    for (const o of t.objectives) h += this.objHtml(o);
    h += '</div>';
    const rw = this.rewardsHtml(t);
    if (rw) h += `<div class="mq-tip-sec">보상</div><div class="mq-tip-rw">${rw}</div>`;
    const pct = Math.round(clamp01(t.progress) * 100);
    h += `<div class="mq-tip-foot">진행 ${pct}%${t.ready ? ' · 함선에서 메신저로 완료 보고' : ''}</div>`;
    return h;
  }

  private objHtml(o: NpcObjectiveInfo): string {
    const tags: string[] = [];
    if (!o.raid) tags.push('함선에서');
    else {
      if (o.def.planet) { const pn = planetName(o.def.planet); if (!o.label.includes(pn)) tags.push(pn); }
      if (o.def.chain) tags.push('한 레이드 안에');
    }
    const off = o.raid && !o.countsHere && !o.done;
    const cls = `mq-tip-obj${o.done ? ' is-done' : ''}${off ? ' is-off' : ''}`;
    const tagHtml = tags.map((s) => `<span class="tag">${escapeHtml(s)}</span>`).join('');
    const n = o.done ? '✓' : `${count(o.progress)} / ${o.target}`;
    return `<div class="${cls}"><span class="l">${escapeHtml(o.label)}</span>${tagHtml}<span class="n">${n}</span></div>`;
  }

  private rewardsHtml(t: NpcQuestInfo): string {
    const r = t.def.rewards;
    const parts: string[] = [];
    if (r.credits > 0) parts.push(`<span class="mq-rw">${escapeHtml(formatCredits(r.credits, { sign: true }))}</span>`);
    if (r.xp > 0) parts.push(`<span class="mq-rw">XP ${formatCompactSigned(r.xp, true)}</span>`);
    for (const rep of r.rep) {
      const corp = CORP_DEFS[rep.corp];
      parts.push(`<span class="mq-rw" style="color:${corp?.color ?? 'inherit'}">신뢰도 · ${escapeHtml(corp?.name ?? rep.corp)} +${count(rep.amount)}</span>`);
    }
    for (const it of r.items) {
      const def = this.ctx?.loot?.getItemDef(it.defId);
      const qty = it.qty > 1 ? ` ×${count(it.qty)}` : '';
      parts.push(`<span class="mq-rw" style="color:${rarityColor(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? it.defId)}${qty}</span>`);
    }
    return parts.join('');
  }
}
