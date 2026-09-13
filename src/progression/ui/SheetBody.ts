import type { DerivedStats, EquippedImplant, GameContext, GymStat, HoldAskHandle, PlayerProfile, SkillDef, SkillId, StatDef, StatId } from '@/shared';
import {
  GYM_FATIGUE_LABEL_KO, GYM_STATS, GYM_TRAINED_MAX, SKILL_LEVEL_MAX, STAT_IDS, STAT_MAX, UI_HOLD_CONFIRM_S, buildItemChip, openHoldAsk,
} from '@/shared';
import { DERIVED_PANEL_KEYS, derivedKeysOfSkill, derivedKeysOfStat, type DerivedPanelKey } from '../defs';
import { SKILL_GAIN_PER_INT, SKILL_STAT_FACTOR } from '../derive';
import { SheetTip, type SheetTipRow, type SheetTipSpec } from './SheetTip';

const isGymStat = (id: StatId): id is GymStat => (GYM_STATS as readonly string[]).includes(id);

/** `HH:MM:SS` of a positive span in ms (hours are not wrapped — a fresh 24 h debuff reads `24:00:00`). */
function hms(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}`;
}

/** What the sheet needs from ProgressionSystem (kept structural so there is no circular import). */
export interface CharacterSheetHost {
  readonly profile: PlayerProfile;
  readonly derived: DerivedStats;
  readonly level: number;
  readonly xp: number;
  readonly xpToNext: number;
  readonly statPoints: number;
  /**
   * Sum of the equipped 임플란트 아이템 bonuses for a stat. The implants themselves moved to the inventory window
   * (`inventory/ui/ImplantPanel`, 2026-09-08) — the sheet only still **shows** their effect as the `(+2)` on a stat.
   */
  getImplantBonus(id: StatId): number;
  getStat(id: StatId): number;
  getSkill(id: SkillId): number;
  getSkillProgress(id: SkillId): number;
  /** Stat XP (2026-09-06): 0..1 toward the next point, and the raw XP that point costs. */
  getStatProgress(id: StatId): number;
  statXpToNext(id: StatId): number;
  /** 헬스장 (A-3a): 단련 보너스 · 다음 단계까지의 진행도 · 디버프 끝 시각 (0 = 없음) and the clock it is measured on. */
  getTrainedBonus?(id: StatId): number;
  getTrainedProgress?(id: StatId): number;
  getGymFatigueUntil?(id: StatId): number;
  gymNow?(): number;
  /** Ship-facility skill-gain multiplier (사격장); 1 when nothing applies. */
  getSkillGainMul(id: SkillId): number;
  getAllStatDefs(): readonly StatDef[];
  getAllSkillDefs(): readonly SkillDef[];
  spendStatPoint(id: StatId): boolean;
  resetProfile(): void;
  /* ── 2026-09-13: 배분 확정 · 미리보기 · 임플란트 썸네일 ── */
  /** All-or-nothing batch invest (`ProgressionRef.spendStatPoints`). */
  spendStatPoints(alloc: Partial<Record<StatId, number>>): boolean;
  /** `derived` as it would be with `alloc` invested — same derive path, nothing written. */
  previewDerived(alloc: Partial<Record<StatId, number>>): DerivedStats;
  readonly implantSlots: number;
  readonly implantSlotsUsed: number;
  getEquippedImplants(): readonly EquippedImplant[];
}

interface ElOptions { cls?: string; text?: string; parent?: HTMLElement; attrs?: Record<string, string> }

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, o: ElOptions = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (o.cls) e.className = o.cls;
  if (o.text !== undefined) e.textContent = o.text;
  if (o.attrs) for (const k in o.attrs) e.setAttribute(k, o.attrs[k]);
  if (o.parent) o.parent.appendChild(e);
  return e;
}

function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

const pct = (v: number): string => `${Math.round(v * 100)} %`;
const mul = (v: number): string => `×${v.toFixed(2)}`;
const dist = (v: number): string => `${v.toFixed(1)} m`;
/** `0.04` → `4%`, `0.02` → `2%`, `0.015` → `1.5%` (tooltip per-point figures). */
const perPt = (v: number): string => `+${Number((v * 100).toFixed(1))}%/pt`;

interface StatRow {
  root: HTMLElement; name: HTMLElement; value: HTMLElement; base: HTMLElement; bonus: HTMLElement;
  plus: HTMLButtonElement; fill: HTMLElement; xp: HTMLElement;
  /** 2026-09-13: `－` (removes pending points only) and the `+n` pending span after the base value. */
  minus: HTMLButtonElement; pend: HTMLElement;
  /** A-3a: ` (+n 단련)` after the implant bonus (empty + hidden at 0). */
  trained: HTMLElement;
  /** A-3a, 근력 · 지구력 only: `단련 +n · p %` / `단련 최대` and the debuff countdown line. */
  gymProg: HTMLElement | null;
  fatigue: HTMLElement | null;
}

interface SkillRow { root: HTMLElement; name: HTMLElement; level: HTMLElement; fill: HTMLElement; bonus: HTMLElement }

interface DerivedRow { cell: HTMLElement; value: HTMLElement; shown: string }

export interface SheetBodyOptions {
  /** Standalone overlay only: the 닫기 button in the footer. */
  onClose?: () => void;
  /** Footer hint (standalone: `Tab 으로 닫기`); omitted in the embedded tab. */
  hint?: string;
  /**
   * Which shell this body belongs to. Both exist at once (the overlay is built at init and merely hidden), so the
   * smokes need a way to tell them apart. Also stamped as `data-variant` on the tooltip element.
   */
  variant?: 'overlay' | 'embed';
}

/** 캐릭터 시트 강조 class (2026-09-13) — 툴팁 · 임플란트 썸네일이 가리키는 능력치 · 숙련 · 파생 줄. */
const LINKED = 'pg-linked';

/**
 * The character-sheet **body** — header, XP bar, 능력치 / 숙련도 columns (+ the read-only implant thumbnails under 숙련도),
 * 파생 능력치 grid and the footer with 캐릭터 초기화. Built into whatever element the owner passes in, so the standalone
 * overlay (`CharacterSheet`) and the embedded 캐릭터 tab (`SheetView`, `ProgressionRef.createSheetView`) share one renderer.
 *
 * 2026-09-13 (사용자 결정):
 *  - ＋ / － only move **pending** points (`pending`); `되돌리기` clears them, `포인트 투자 확정` invests them with a
 *    `UI_HOLD_CONFIRM_S` hold (`host.spendStatPoints`). While points are pending the 파생 능력치 rows that would change read
 *    `현재 → 확정 후` (`host.previewDerived`). Pending survives every `refresh()`; forced exits call `discardPending()`.
 *  - Hovering a stat / skill **name** shows an in-game tooltip (`SheetTip`) and outlines the linked rows (`.pg-linked`);
 *    hovering an implant thumbnail outlines its stats, their skills and their derived rows.
 *  - Leaving with pending points asks first (`requestLeave`) through the shared hold popup (`openHoldAsk`); 초기화 too.
 *
 * Knows nothing about blockers, the pointer lock or the `.scr-tabs` pill — those belong to the shell (the popups hold their own).
 */
export class SheetBody {
  private statRows = new Map<StatId, StatRow>();
  private skillRows = new Map<SkillId, SkillRow>();
  private derivedRows = new Map<DerivedPanelKey, DerivedRow>();
  private created: HTMLElement[] = [];

  private subtitle: HTMLElement;
  private levelText: HTMLElement;
  private pointsTag: HTMLElement;
  private xpFill: HTMLElement;
  private xpText: HTMLElement;
  private resetBtn: HTMLButtonElement;
  /** 2026-09-13: points placed with ＋ but not invested yet (display order = `STAT_IDS`). */
  private readonly pending = new Map<StatId, number>();
  private revertBtn: HTMLButtonElement;
  private confirmBtn: HTMLButtonElement;
  private confirmFill: HTMLElement;
  private confirmHold: { t0: number; raf: number; timer: number } | null = null;
  /** Read-only implant thumbnails under 숙련도 (rebuilt only when the equipped list changes). */
  private impSlots: HTMLElement;
  private impRow: HTMLElement;
  private impEmpty: HTMLElement;
  private impSig = '';
  private readonly tip: SheetTip;
  private tipOwner: HTMLElement | null = null;
  private linked: HTMLElement[] = [];
  /** The warning popup this body raised (leave · reset), if any. */
  private ask: HoldAskHandle | null = null;
  /**
   * A-3a: 1 Hz repaint of the debuff countdown. Runs **only** while a debuff is active **and** the body is on screen — the
   * tick stops itself when the body is hidden (closed overlay / other inventory tab) or no debuff is left; both shells call
   * `refresh()` when they show the body again, which restarts it.
   */
  private ticker: number | null = null;

  private readonly onConfirmUp = (): void => this.cancelConfirmHold();

  constructor(
    private readonly ctx: GameContext,
    private readonly host: CharacterSheetHost,
    parent: HTMLElement,
    opts: SheetBodyOptions = {},
  ) {
    /* ── header ── */
    const head = this.own(el('div', { cls: 'cs-head', parent }));
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '캐릭터', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });
    const lvBox = el('div', { cls: 'cs-level', parent: head });
    this.levelText = el('div', { cls: 'lv', text: 'LV 1', parent: lvBox });
    this.pointsTag = el('div', { cls: 'pts', text: '', parent: lvBox });
    this.pointsTag.hidden = true;

    /* ── xp bar ── */
    const xp = this.own(el('div', { cls: 'cs-xp', parent }));
    const xpBar = el('div', { cls: 'bar', parent: xp });
    this.xpFill = el('i', { parent: xpBar });
    this.xpText = el('div', { cls: 'txt ui-mono', text: '', parent: xp });

    /* ── body: 능력치 | 숙련도 (2026-09-08: 임플란트 장착은 인벤토리 장착 장비 칸이 한다) ── */
    const body = this.own(el('div', { cls: 'cs-body', parent }));

    const statCol = el('div', { cls: 'cs-col', parent: body });
    el('div', { cls: 'ui-label', text: '능력치', parent: statCol });
    for (const def of host.getAllStatDefs()) this.buildStatRow(statCol, def);
    // 2026-09-13: bottom-right of the stat panel — clear the pending points / invest them with a 1 s hold
    const alloc = el('div', { cls: 'pg-alloc', parent: statCol });
    this.revertBtn = el('button', { cls: 'ui-btn pg-revert', text: '되돌리기', parent: alloc });
    this.revertBtn.type = 'button';
    this.revertBtn.addEventListener('click', (e) => { e.stopPropagation(); this.revertPending(); });
    this.confirmBtn = el('button', { cls: 'ui-btn primary pg-confirm', parent: alloc });
    this.confirmBtn.type = 'button';
    this.confirmFill = el('i', { cls: 'pg-fill', parent: this.confirmBtn });
    el('span', { cls: 'pg-label', text: '포인트 투자 확정', parent: this.confirmBtn });
    // a click / Enter never confirms — only the hold timer does
    this.confirmBtn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
    this.confirmBtn.addEventListener('pointerdown', (e) => this.startConfirmHold(e));
    this.confirmBtn.addEventListener('pointerleave', () => this.cancelConfirmHold());

    const skillCol = el('div', { cls: 'cs-col', parent: body });
    el('div', { cls: 'ui-label', text: '숙련도', parent: skillCol });
    const skillGrid = el('div', { cls: 'cs-skills', parent: skillCol });
    for (const def of host.getAllSkillDefs()) this.buildSkillRow(skillGrid, def);
    // 2026-09-13: equipped (non-tactical) implants as read-only thumbnails — equipping stays in the inventory window
    const imps = el('div', { cls: 'pg-imps', parent: skillCol });
    const ih = el('div', { cls: 'ui-label pg-imps-head', parent: imps });
    el('span', { text: '임플란트', parent: ih });
    el('i', { cls: 'line', parent: ih });
    this.impSlots = el('span', { cls: 'pg-imps-slots ui-mono', text: '', parent: ih });
    this.impRow = el('div', { cls: 'pg-imps-row', parent: imps });
    this.impEmpty = el('div', { cls: 'pg-imps-empty', text: '장착한 임플란트가 없습니다', parent: imps });

    /* ── derived ── */
    const der = this.own(el('div', { cls: 'cs-derived', parent }));
    el('div', { cls: 'ui-label', text: '파생 능력치', parent: der });
    const grid = el('div', { cls: 'grid', parent: der });
    for (const key of DERIVED_PANEL_KEYS) {
      const cell = el('div', { cls: 'cell', parent: grid, attrs: { 'data-key': key } });
      el('div', { cls: 'k', text: DERIVED_LABEL[key], parent: cell });
      this.derivedRows.set(key, { cell, value: el('div', { cls: 'v ui-mono', text: '', parent: cell }), shown: '' });
    }

    /* ── footer ── */
    const foot = this.own(el('div', { cls: 'cs-foot', parent }));
    this.resetBtn = el('button', { cls: 'ui-btn danger', text: '캐릭터 초기화', parent: foot });
    this.resetBtn.type = 'button';
    this.resetBtn.addEventListener('click', (e) => { e.stopPropagation(); this.onReset(); });
    const spacer = el('div', { cls: 'sp', parent: foot });
    if (opts.hint) el('div', { cls: 'hint', text: opts.hint, parent: spacer });
    if (opts.onClose) this.button(foot, '닫기', opts.onClose);

    this.tip = new SheetTip(ctx.uiRoot);
    if (opts.variant) this.tip.el.dataset.variant = opts.variant;
  }

  private own<T extends HTMLElement>(e: T): T { this.created.push(e); return e; }

  /* ── pending points (2026-09-13) ─────────────────────────────────────── */
  get pendingTotal(): number {
    let t = 0;
    for (const n of this.pending.values()) t += n;
    return t;
  }

  get hasPending(): boolean { return this.pendingTotal > 0; }

  /** 0..1 while `포인트 투자 확정` is held (smoke / debug). */
  get confirmHoldProgress(): number {
    const h = this.confirmHold;
    return h ? Math.min(1, (performance.now() - h.t0) / Math.max(1, UI_HOLD_CONFIRM_S * 1000)) : 0;
  }

  private allocObj(): Partial<Record<StatId, number>> {
    const o: Partial<Record<StatId, number>> = {};
    for (const [id, n] of this.pending) if (n > 0) o[id] = n;
    return o;
  }

  /**
   * Keep the pending points valid against the live profile (a server document, stat XP reaching `STAT_MAX`, a raid).
   * Returns true when something was dropped.
   */
  private reconcilePending(inRaid: boolean): boolean {
    if (this.pending.size === 0) return false;
    if (inRaid) { this.pending.clear(); return true; }
    let budget = Math.max(0, this.host.statPoints);
    let changed = false;
    for (const id of STAT_IDS) {
      const n = this.pending.get(id) ?? 0;
      if (n <= 0) { if (this.pending.delete(id)) changed = true; continue; }
      const keep = Math.min(n, Math.max(0, STAT_MAX - this.host.getStat(id)), budget);
      budget -= keep;
      if (keep !== n) changed = true;
      if (keep > 0) this.pending.set(id, keep); else this.pending.delete(id);
    }
    return changed;
  }

  private stepPending(id: StatId, delta: 1 | -1): void {
    if (this.ctx.isRaidActive()) return;
    const cur = this.pending.get(id) ?? 0;
    if (delta > 0) {
      const remaining = this.host.statPoints - this.pendingTotal;
      if (remaining <= 0 || this.host.getStat(id) + cur >= STAT_MAX) { this.ctx.bus.emit('audio:play', { id: 'ui_deny' }); return; }
    } else if (cur <= 0) {
      return;
    }
    const next = cur + delta;
    if (next > 0) this.pending.set(id, next); else this.pending.delete(id);
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  private revertPending(): void {
    if (!this.hasPending) return;
    this.cancelConfirmHold();
    this.pending.clear();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  /**
   * Forced exit (phase change, death, server document, reset, the shell closing without asking): drop the pending points and
   * any popup this body raised, without a warning.
   */
  discardPending(): void {
    this.cancelConfirmHold();
    this.clearHover();
    if (this.ask?.isOpen) this.ask.close();
    this.ask = null;
    if (this.pending.size === 0) return;
    this.pending.clear();
    this.refresh();
  }

  /**
   * The shell / the inventory window is about to leave this body because the player asked (`EmbeddedView.requestLeave`).
   * A popup of ours already up → Tab / a second request is its 돌아가기 (true). Pending points → the warning (true);
   * `버리고 이동` discards and calls `proceed`. Nothing pending → false, leave now.
   */
  requestLeave(proceed: () => void): boolean {
    if (this.ask?.isOpen) { this.ask.cancel(); return true; }
    const total = this.pendingTotal;
    if (total <= 0) return false;
    this.cancelConfirmHold();
    this.clearHover();
    this.ask = openHoldAsk(this.ctx, {
      id: 'character-leave',
      title: '확정하지 않은 능력치 포인트',
      body: `배분해 둔 포인트 ${total}점을 아직 확정하지 않았습니다.\n이대로 이동하면 배분이 취소됩니다 (포인트는 그대로 남습니다).`,
      buttons: [
        { label: '돌아가기', cancel: true },
        { label: '버리고 이동', kind: 'danger', run: () => { this.discardPending(); proceed(); } },
      ],
    });
    return true;
  }

  private startConfirmHold(e: PointerEvent): void {
    if (e.button !== 0 || this.confirmHold || this.confirmBtn.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const holdMs = Math.max(1, UI_HOLD_CONFIRM_S * 1000);
    const t0 = performance.now();
    const tick = (): void => {
      const h = this.confirmHold;
      if (!h || h.t0 !== t0) return;
      const f = Math.min(1, (performance.now() - t0) / holdMs);
      this.confirmFill.style.transform = `scaleX(${f.toFixed(3)})`;
      if (f < 1) h.raf = requestAnimationFrame(tick);
    };
    const timer = window.setTimeout(() => {
      if (this.confirmHold?.t0 !== t0) return;
      this.cancelConfirmHold();
      this.commitPending();
    }, holdMs);
    this.confirmHold = { t0, raf: requestAnimationFrame(tick), timer };
    this.confirmBtn.classList.add('is-holding');
    window.addEventListener('pointerup', this.onConfirmUp);
    window.addEventListener('pointercancel', this.onConfirmUp);
  }

  private cancelConfirmHold(): void {
    const h = this.confirmHold;
    this.confirmHold = null;
    window.removeEventListener('pointerup', this.onConfirmUp);
    window.removeEventListener('pointercancel', this.onConfirmUp);
    if (!h) return;
    cancelAnimationFrame(h.raf);
    clearTimeout(h.timer);
    this.confirmFill.style.transform = 'scaleX(0)';
    this.confirmBtn.classList.remove('is-holding');
  }

  private commitPending(): void {
    const total = this.pendingTotal;
    if (total <= 0) return;
    if (this.ctx.isRaidActive()) { this.pending.clear(); this.refresh(); return; }
    const alloc = this.allocObj();
    this.pending.clear();                                  // before the spend: its own refresh must not reconcile against the new points
    if (this.host.spendStatPoints(alloc)) {
      this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
      this.ctx.bus.emit('ui:notify', { text: `능력치 포인트 ${total}점을 투자했습니다`, kind: 'success', duration: 1.8 });
    } else {
      for (const id of STAT_IDS) if (alloc[id]) this.pending.set(id, alloc[id]!);
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
    }
    this.refresh();
  }

  /* ── rendering ────────────────────────────────────────────────────────── */
  refresh(): void {
    const host = this.host;
    const p = host.profile;
    const inRaid = this.ctx.isRaidActive();
    this.reconcilePending(inRaid);

    setText(this.subtitle, `${p.name} · 레이드 ${p.raids}회 · 탈출 ${p.extractions}회`);
    setText(this.levelText, `LV ${host.level}`);
    const pts = host.statPoints;
    const total = this.pendingTotal;
    this.pointsTag.hidden = pts <= 0;
    setText(this.pointsTag, `잔여 포인트 ${Math.max(0, pts - total)}`);

    const need = Math.max(1, host.xpToNext);
    const ratio = Math.min(1, Math.max(0, host.xp / need));
    this.xpFill.style.transform = `scaleX(${ratio.toFixed(4)})`;
    setText(this.xpText, `${Math.floor(host.xp)} / ${need} XP`);

    for (const id of this.statRows.keys()) this.refreshStat(id);
    for (const id of this.skillRows.keys()) this.refreshSkill(id);

    this.revertBtn.disabled = total <= 0;
    this.confirmBtn.disabled = total <= 0 || inRaid;
    this.confirmBtn.classList.toggle('is-ready', total > 0 && !inRaid);
    if (this.confirmBtn.disabled) this.cancelConfirmHold();

    // 파생 능력치 — `현재 → 확정 후` (green) on the rows the pending points would change, through the same derive path
    const d = host.derived;
    const preview = total > 0 ? host.previewDerived(this.allocObj()) : null;
    for (const [key, row] of this.derivedRows) {
      const cur = derivedText(key, d);
      const next = preview ? derivedText(key, preview) : cur;
      const shown = next === cur ? cur : `${cur} ${next}`;
      if (shown === row.shown) continue;
      row.shown = shown;
      row.cell.classList.toggle('pg-preview', next !== cur);
      if (next === cur) { row.value.textContent = cur; continue; }
      row.value.replaceChildren();
      el('span', { cls: 'pg-cur', text: cur, parent: row.value });
      el('span', { cls: 'pg-arr', text: '→', parent: row.value });
      el('span', { cls: 'pg-next', text: next, parent: row.value });
    }

    this.refreshImplants();
    this.resetBtn.disabled = inRaid;
  }

  /** Cheap partial update for a single skill bar (called while training). */
  refreshSkill(id: SkillId): void {
    const row = this.skillRows.get(id);
    if (!row) return;
    const lv = this.host.getSkill(id);
    setText(row.level, `${lv}`);
    const p = lv >= SKILL_LEVEL_MAX ? 1 : Math.min(1, Math.max(0, this.host.getSkillProgress(id)));
    row.fill.style.transform = `scaleX(${p.toFixed(4)})`;
    row.root.classList.toggle('maxed', lv >= SKILL_LEVEL_MAX);
    // 사격장 etc. — only shown when a facility actually boosts this skill.
    const bonus = this.host.getSkillGainMul(id);
    const hasBonus = Number.isFinite(bonus) && Math.abs(bonus - 1) > 1e-6;
    row.bonus.hidden = !hasBonus;
    setText(row.bonus, hasBonus ? `시설 ×${bonus.toFixed(2)}` : '');
  }

  /** Cheap partial update for a single stat row (value, pending, ＋ / －, stat-XP bar and `xp/next` readout). */
  refreshStat(id: StatId): void {
    const row = this.statRows.get(id);
    if (!row) return;
    const inRaid = this.ctx.isRaidActive();
    // a stat that just reached STAT_MAX through stat XP (or a raid) can invalidate the plan — repaint everything once
    if (this.reconcilePending(inRaid)) { this.refresh(); return; }
    const v = this.host.getStat(id);
    // Phase 12: `base (+bonus)` while an 임플란트 adds to this stat; the bonus span stays empty otherwise so `.v` reads the base
    setText(row.base, String(v));
    const pend = this.pending.get(id) ?? 0;
    row.pend.hidden = pend <= 0;
    setText(row.pend, pend > 0 ? `+${pend}` : '');
    row.root.classList.toggle('has-pending', pend > 0);
    const remaining = this.host.statPoints - this.pendingTotal;
    row.plus.disabled = inRaid || remaining <= 0 || v + pend >= STAT_MAX;
    row.minus.disabled = inRaid || pend <= 0;
    // the － only exists while this stat has something to take back or points are left to place
    row.minus.hidden = pend <= 0 && this.host.statPoints <= 0;
    const bonus = typeof this.host.getImplantBonus === 'function' ? this.host.getImplantBonus(id) : 0;
    const hasBonus = Number.isFinite(bonus) && bonus !== 0;
    row.bonus.hidden = !hasBonus;
    setText(row.bonus, hasBonus ? ` (${bonus > 0 ? '+' : ''}${bonus})` : '');
    // A-3a: 헬스장 단련 보너스 — its own span and colour after the implant one: `10 (+2) (+1 단련)`
    const tb = typeof this.host.getTrainedBonus === 'function' ? this.host.getTrainedBonus(id) : 0;
    const hasTrained = Number.isFinite(tb) && tb > 0;
    row.trained.hidden = !hasTrained;
    setText(row.trained, hasTrained ? ` (+${tb} 단련)` : '');
    row.root.classList.toggle('has-bonus', hasBonus || hasTrained || pend > 0);
    if (row.gymProg) {
      const maxedT = hasTrained && tb >= GYM_TRAINED_MAX;
      const tp = typeof this.host.getTrainedProgress === 'function' ? this.host.getTrainedProgress(id) : 0;
      const pc = Math.floor(Math.min(1, Math.max(0, Number.isFinite(tp) ? tp : 0)) * 100);
      setText(row.gymProg, maxedT ? '단련 최대' : `단련 +${hasTrained ? tb : 0} · ${pc} %`);
      row.gymProg.classList.toggle('maxed', maxedT);
    }
    this.paintFatigue(id, row);
    this.syncTicker();
    const maxed = v >= STAT_MAX;
    const need = Math.max(1, this.host.statXpToNext(id));
    const p = Math.min(1, Math.max(0, this.host.getStatProgress(id)));
    row.fill.style.transform = `scaleX(${(maxed ? 1 : p).toFixed(4)})`;
    setText(row.xp, maxed ? '최대' : `${Math.floor(p * need)} / ${need} XP`);
    row.root.classList.toggle('maxed', maxed);
  }

  /** Equipped implant thumbnails + `n / m 슬롯` (DOM rebuilt only when the list changes, so a hover survives repaints). */
  private refreshImplants(): void {
    const host = this.host;
    const list = typeof host.getEquippedImplants === 'function' ? host.getEquippedImplants() : [];
    setText(this.impSlots, `${host.implantSlotsUsed ?? 0} / ${host.implantSlots ?? 0} 슬롯`);
    this.impEmpty.hidden = list.length > 0;
    const loot = this.ctx.loot;
    const sig = `${loot ? 1 : 0}#${list.map((e) => `${e.uid}:${e.defId}`).join('|')}`;
    if (sig === this.impSig) return;
    this.impSig = sig;
    if (this.tipOwner && this.impRow.contains(this.tipOwner)) this.clearHover();
    this.impRow.replaceChildren();
    for (const e of list) {
      let def;
      try { def = loot?.getItemDef(e.defId); } catch { def = undefined; }
      const wrap = el('div', { cls: 'pg-imp', parent: this.impRow, attrs: { 'data-uid': e.uid } });
      // `data-def-id` on the chip → `ui/hud/ItemTip` shows the item card; this wrapper only drives the row outline
      wrap.appendChild(buildItemChip(def, { size: 40 }));
      const stats = def?.implant ? STAT_IDS.filter((s) => { const b = def.implant!.stats[s]; return typeof b === 'number' && b !== 0; }) : [];
      this.hover(wrap, null, () => this.linksForStats(stats, true));
    }
  }

  /* ── 헬스장 디버프 countdown (A-3a) ───────────────────────────────────── */
  /** Remaining ms of the debuff on `id` (0 when none / expired / the host has no gym API). */
  private fatigueLeft(id: StatId): number {
    const h = this.host;
    if (typeof h.getGymFatigueUntil !== 'function') return 0;
    const until = h.getGymFatigueUntil(id);
    if (!(until > 0)) return 0;
    const now = typeof h.gymNow === 'function' ? h.gymNow() : Date.now();
    return Math.max(0, until - now);
  }

  private paintFatigue(id: StatId, row: StatRow): void {
    if (!row.fatigue || !isGymStat(id)) return;
    const left = this.fatigueLeft(id);
    row.fatigue.hidden = left <= 0;
    setText(row.fatigue, left > 0 ? `${GYM_FATIGUE_LABEL_KO[id]} · 남은 ${hms(left)}` : '');
    row.root.classList.toggle('is-fatigued', left > 0);
  }

  private anyFatigue(): boolean { return GYM_STATS.some((id) => this.fatigueLeft(id) > 0); }

  /** Start the 1 Hz countdown when a debuff is showing, stop it when none is left. */
  private syncTicker(): void {
    const need = this.anyFatigue();
    if (need && this.ticker === null) this.ticker = window.setInterval(() => this.tick(), 1000);
    else if (!need) this.stopTicker();
  }

  private stopTicker(): void {
    if (this.ticker !== null) { window.clearInterval(this.ticker); this.ticker = null; }
  }

  private tick(): void {
    const anchor = this.created[0];
    // hidden (closed overlay, another inventory tab) or torn down → stop; the next `refresh()` restarts it
    if (!anchor || !anchor.isConnected || anchor.getClientRects().length === 0) { this.stopTicker(); return; }
    for (const id of GYM_STATS) {
      const row = this.statRows.get(id);
      if (row) this.paintFatigue(id, row);
    }
    if (!this.anyFatigue()) this.stopTicker();
  }

  /* ── tooltips + linked-row outline (2026-09-13) ──────────────────────── */
  /**
   * Hover wiring: `pointerover` / `pointerout` / `pointermove` (the in-game cursor synthesises all three — `ui/hud/ItemTip` relies
   * on the same). `spec` null = no tooltip of ours (implant thumbnails: the item card is ItemTip's), outline only.
   */
  private hover(target: HTMLElement, spec: (() => SheetTipSpec) | null, links: () => HTMLElement[]): void {
    target.addEventListener('pointerover', (e) => {
      if (this.tipOwner === target) return;
      this.clearHover();
      this.tipOwner = target;
      if (spec) this.tip.show(spec(), e.clientX, e.clientY);
      this.setLinked(links());
    });
    target.addEventListener('pointermove', (e) => { if (this.tipOwner === target) this.tip.move(e.clientX, e.clientY); });
    target.addEventListener('pointerout', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && target.contains(to)) return;
      if (this.tipOwner === target) this.clearHover();
    });
  }

  private clearHover(): void {
    this.tipOwner = null;
    this.tip.hide();
    this.setLinked([]);
  }

  private setLinked(next: HTMLElement[]): void {
    const keep = new Set(next);
    for (const e of this.linked) if (!keep.has(e)) e.classList.remove(LINKED);
    for (const e of next) e.classList.add(LINKED);
    this.linked = next;
  }

  private derivedCells(keys: readonly DerivedPanelKey[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const k of keys) { const r = this.derivedRows.get(k); if (r) out.push(r.cell); }
    return out;
  }

  /** Skills whose `stats` column includes any of `stats`, the derived rows those stats change, and (implants) the stat rows. */
  private linksForStats(stats: readonly StatId[], withStatRows: boolean): HTMLElement[] {
    const out: HTMLElement[] = [];
    const set = new Set(stats);
    if (withStatRows) for (const s of stats) { const r = this.statRows.get(s); if (r) out.push(r.root); }
    for (const def of this.host.getAllSkillDefs()) {
      if (def.stats.some((s) => set.has(s))) { const r = this.skillRows.get(def.id); if (r) out.push(r.root); }
    }
    const keys = new Set<DerivedPanelKey>();
    for (const s of stats) for (const k of derivedKeysOfStat(s)) keys.add(k);
    out.push(...this.derivedCells([...keys]));
    return out;
  }

  private statTip(def: StatDef): SheetTipSpec {
    const skills = this.host.getAllSkillDefs().filter((s) => s.stats.includes(def.id));
    const notes = def.id === 'intelligence' ? [`모든 숙련 성장 ${perPt(SKILL_GAIN_PER_INT)}`] : [];
    return {
      name: def.name,
      sub: '능력치',
      desc: def.description,
      notes,
      sections: [{
        title: '관련 숙련 · 성장 속도',
        // statFactor averages the skill's stats, so one point of this stat moves a two-stat skill by half the factor
        rows: skills.map((s) => ({ k: s.name, v: perPt(SKILL_STAT_FACTOR / Math.max(1, s.stats.length)) })),
      }],
    };
  }

  private skillTip(def: SkillDef): SheetTipSpec {
    const host = this.host;
    const lv = host.getSkill(def.id);
    const prog = Math.floor(Math.min(1, Math.max(0, host.getSkillProgress(def.id))) * 100);
    const d = host.derived;
    const effect: SheetTipRow[] = [];
    if (def.weaponClass) {
      // 사격 숙련: per weapon class recoil / reload — not rows of the 파생 능력치 panel (사용자 결정: numbers only)
      const recoil = Math.round((1 - (d.recoilMul?.[def.weaponClass] ?? 1)) * 100);
      const reload = Math.round(((d.reloadSpeedMul?.[def.weaponClass] ?? 1) - 1) * 100);
      effect.push({ k: '반동 · 장전', v: `반동 −${recoil}% · 장전 +${reload}%`, tone: recoil > 0 || reload > 0 ? 'good' : undefined });
    } else {
      for (const k of derivedKeysOfSkill(def.id)) effect.push({ k: DERIVED_LABEL[k], v: derivedText(k, d) });
    }
    const growth: SheetTipRow[] = def.stats.map((s) => ({
      k: this.statRows.has(s) ? (host.getAllStatDefs().find((x) => x.id === s)?.name ?? s) : s,
      v: perPt(SKILL_STAT_FACTOR / Math.max(1, def.stats.length)),
    }));
    const facility = host.getSkillGainMul(def.id);
    if (Number.isFinite(facility) && Math.abs(facility - 1) > 1e-6) growth.push({ k: '시설 보너스', v: `×${facility.toFixed(2)}`, tone: 'good' });
    return {
      name: def.name,
      sub: lv >= SKILL_LEVEL_MAX ? `숙련도 · Lv ${lv} 최대` : `숙련도 · Lv ${lv} / ${SKILL_LEVEL_MAX} · ${prog} %`,
      desc: def.description,
      sections: [
        { title: '현재 효과', rows: effect },
        { title: '관련 능력치 · 성장 속도', rows: growth },
      ],
    };
  }

  /* ── builders ─────────────────────────────────────────────────────────── */
  private buildStatRow(parent: HTMLElement, def: StatDef): void {
    const row = el('div', { cls: 'cs-stat', parent, attrs: { 'data-stat': def.id } });
    const txt = el('div', { cls: 't', parent: row });
    // 2026-09-13: the effect text moved into the name's tooltip (`statTip`)
    const name = el('div', { cls: 'n', text: def.name, parent: txt });
    // Stat XP (2026-09-06): progress bar + `xp / next XP` under the name.
    const prog = el('div', { cls: 'sp', parent: txt });
    const bar = el('div', { cls: 'bar', parent: prog });
    const fill = el('i', { parent: bar });
    const xp = el('div', { cls: 'xp ui-mono', text: '', parent: prog });
    // A-3a: 근력 · 지구력 carry a short 단련 line (`단련 +2 · 40 %` / `단련 최대`) and, while a debuff runs, its countdown
    let gymProg: HTMLElement | null = null;
    let fatigue: HTMLElement | null = null;
    if (isGymStat(def.id)) {
      const gy = el('div', { cls: 'gy', parent: txt });
      gymProg = el('span', { cls: 'gtr ui-mono', text: '', parent: gy });
      fatigue = el('span', { cls: 'fat ui-mono', text: '', parent: gy });
      fatigue.hidden = true;
    }
    const minus = el('button', { cls: 'ui-btn minus', text: '－', parent: row });
    minus.type = 'button';
    const value = el('div', { cls: 'v ui-mono', parent: row });
    const base = el('span', { cls: 'base', text: '0', parent: value });
    const pend = el('span', { cls: 'pa', text: '', parent: value });     // 2026-09-13: `+n` pending (accent)
    pend.hidden = true;
    const bonus = el('span', { cls: 'ib', text: '', parent: value });   // Phase 12: ` (+n)` from 임플란트 items
    bonus.hidden = true;
    const trained = el('span', { cls: 'tb', text: '', parent: value });  // A-3a: ` (+n 단련)` from the 헬스장
    trained.hidden = true;
    const plus = el('button', { cls: 'ui-btn plus', text: '＋', parent: row });
    plus.type = 'button';
    plus.addEventListener('click', (e) => { e.stopPropagation(); this.stepPending(def.id, 1); });
    minus.addEventListener('click', (e) => { e.stopPropagation(); this.stepPending(def.id, -1); });
    this.statRows.set(def.id, { root: row, name, value, base, pend, bonus, plus, minus, fill, xp, trained, gymProg, fatigue });
    this.hover(name, () => this.statTip(def), () => {
      const out = this.linksForStats([def.id], false);
      return out;
    });
  }

  private buildSkillRow(parent: HTMLElement, def: SkillDef): void {
    // 2026-09-13: no native `title` any more — the name carries the in-game tooltip (`skillTip`)
    const row = el('div', { cls: 'cs-skill', parent, attrs: { 'data-skill': def.id } });
    const head = el('div', { cls: 'h', parent: row });
    const name = el('div', { cls: 'n', text: def.name, parent: head });
    const bonus = el('div', { cls: 'bonus', text: '', parent: head });
    bonus.hidden = true;
    const level = el('div', { cls: 'lv ui-mono', text: '0', parent: head });
    const bar = el('div', { cls: 'bar', parent: row });
    const fill = el('i', { parent: bar });
    this.skillRows.set(def.id, { root: row, name, level, fill, bonus });
    this.hover(name, () => this.skillTip(def), () => this.derivedCells(derivedKeysOfSkill(def.id)));
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`, text: label, parent });
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      onClick();
    });
    return b;
  }

  /** 2026-09-13: a warning popup confirmed by a `UI_HOLD_CONFIRM_S` hold (was a two-click arm). */
  private onReset(): void {
    if (this.ctx.isRaidActive()) return;
    this.cancelConfirmHold();
    this.clearHover();
    if (this.ask?.isOpen) this.ask.close();
    this.ask = openHoldAsk(this.ctx, {
      id: 'character-reset',
      danger: true,
      title: '캐릭터 초기화',
      body: '레벨 · 경험치 · 능력치 · 숙련도 · 단련이 모두 처음으로 돌아갑니다.\n장착한 임플란트는 함선 창고로 돌아갑니다. 되돌릴 수 없습니다.',
      buttons: [
        { label: '취소', cancel: true },
        {
          label: '초기화', kind: 'danger', hold: true, run: () => {
            if (this.ctx.isRaidActive()) return;
            this.pending.clear();
            this.host.resetProfile();
            this.ctx.bus.emit('ui:notify', { text: '캐릭터를 초기화했습니다', kind: 'warning' });
            this.refresh();
          },
        },
      ],
    });
  }

  dispose(): void {
    this.stopTicker();
    this.cancelConfirmHold();
    if (this.ask?.isOpen) this.ask.close();
    this.ask = null;
    this.clearHover();
    this.tip.dispose();
    this.pending.clear();
    for (const e of this.created) e.remove();
    this.created = [];
    this.statRows.clear();
    this.skillRows.clear();
    this.derivedRows.clear();
  }
}

/* ── derived readout ──────────────────────────────────────────────────────── */
const DERIVED_LABEL: Readonly<Record<DerivedPanelKey, string>> = {
  carryCapacity: '기본 적재량',
  maxStamina: '최대 스태미나',
  detectRadius: '감지 반경',
  enemyDetectRadius: '적 감지 반경',
  meleeDamageMul: '근접 피해',
  throwRangeMul: '투척 거리',
  skillGainMul: '숙련 상승',
  useSpeedMul: '사용 속도',
  interactSpeedMul: '상호작용 속도',
  gritChance: '인내 발동',
  searchSpeedMul: '서치 속도',
  healPowerMul: '회복 효과',
  shipCallSpeedMul: '탈출 호출',
  implantCooldownMul: '임플란트 쿨타임',
  durabilityLossMul: '내구도 소모',
  gatherYieldMul: '채집 수확',
  craftSpeedMul: '제작 속도',
  carryReliefFactor: '운반 부담 경감',
};

function derivedText(key: DerivedPanelKey, d: DerivedStats): string {
  switch (key) {
    case 'carryCapacity': return `${d.carryCapacity.toFixed(1)} kg`;
    case 'maxStamina': return `${Math.round(d.maxStamina)}`;
    case 'detectRadius': return dist(d.detectRadius);
    case 'enemyDetectRadius': return dist(d.enemyDetectRadius);
    case 'meleeDamageMul': return mul(d.meleeDamageMul);
    // 2026-09-09: 사용자 결정 — 배율이 아니라 m 로 보여 준다 (평지 오버핸드 기준, derive.throwRangeMetres).
    case 'throwRangeMul': return dist(d.throwRangeM);
    case 'skillGainMul': return mul(d.skillGainMul);
    case 'useSpeedMul': return mul(d.useSpeedMul);
    case 'interactSpeedMul': return mul(d.interactSpeedMul);
    case 'gritChance': return pct(d.gritChance);
    case 'searchSpeedMul': return mul(d.searchSpeedMul);
    case 'healPowerMul': return mul(d.healPowerMul);
    case 'shipCallSpeedMul': return mul(d.shipCallSpeedMul);
    case 'implantCooldownMul': return mul(d.implantCooldownMul);
    case 'durabilityLossMul': return mul(d.durabilityLossMul);
    case 'gatherYieldMul': return mul(d.gatherYieldMul);
    case 'craftSpeedMul': return mul(d.craftSpeedMul);
    case 'carryReliefFactor': return pct(d.carryReliefFactor);
    default: return '';
  }
}
