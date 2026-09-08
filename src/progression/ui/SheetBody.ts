import type {
  DerivedStats, EquippedImplant, GameContext, ImplantDef, ImplantId, ImplantMode, ItemDef, ItemInstance, PlayerProfile,
  SkillDef, SkillId, StatDef, StatId,
} from '@/shared';
import { Keys, PERK_DEFS, RARITY_COLORS, RARITY_LABEL_KO, SKILL_LEVEL_MAX, STAT_MAX, buildItemChip, keyLabel } from '@/shared';

/** What the sheet needs from ProgressionSystem (kept structural so there is no circular import). */
export interface CharacterSheetHost {
  readonly profile: PlayerProfile;
  readonly derived: DerivedStats;
  readonly level: number;
  readonly xp: number;
  readonly xpToNext: number;
  readonly statPoints: number;
  /** Phase 12: 임플란트 items — slot budget, what is equipped, equip / unequip (ship only), per-stat bonus. */
  readonly implantSlots: number;
  readonly implantSlotsUsed: number;
  getEquippedImplants(): readonly EquippedImplant[];
  equipImplant(uid: string): boolean;
  unequipImplant(uid: string): boolean;
  getImplantBonus(id: StatId): number;
  getStat(id: StatId): number;
  getSkill(id: SkillId): number;
  getSkillProgress(id: SkillId): number;
  /** Stat XP (2026-09-06): 0..1 toward the next point, and the raw XP that point costs. */
  getStatProgress(id: StatId): number;
  statXpToNext(id: StatId): number;
  /** Ship-facility skill-gain multiplier (사격장); 1 when nothing applies. */
  getSkillGainMul(id: SkillId): number;
  getAllStatDefs(): readonly StatDef[];
  getAllSkillDefs(): readonly SkillDef[];
  spendStatPoint(id: StatId): boolean;
  resetProfile(): void;
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

interface StatRow { root: HTMLElement; value: HTMLElement; base: HTMLElement; bonus: HTMLElement; plus: HTMLButtonElement; fill: HTMLElement; xp: HTMLElement }

/* ── 임플란트 아이템 (Phase 12, 2026-09-08) ─────────────────────────────────
 * The `.cs-impitems` block under the 전술 임플란트 slot: `임플란트 n / m칸` + a pip row, one row per equipped item (the
 * shared `buildItemChip` thumbnail → hover card, name, `장착칸 k`, stat line / perk name; click = unequip) and a
 * `+ 장착` button that raises a second modeless picker (`.cs-impi-pop`, a `uiRoot` child like `.cs-imp-pop`) listing
 * every implant item in the bag + 함선 창고; rows that do not fit or are broken are dimmed + disabled with the reason.
 * Everything routes through the host (`equipImplant` / `unequipImplant`) — the sheet holds no item state itself.
 * ────────────────────────────────────────────────────────────────────────── */
const IMPL_TEXT = {
  label: '임플란트',
  slots: (used: number, total: number) => `${used} / ${total}칸`,
  slotCost: (n: number) => `장착칸 ${n}`,
  add: '+ 장착',
  pick: '임플란트 장착',
  none: '장착한 임플란트가 없습니다.',
  nothingToPick: '가방과 함선 창고에 임플란트가 없습니다 — 레이드에서 망가진 임플란트를 찾아 세레스 바이오에서 수리하세요.',
  raidLocked: '레이드 중에는 교체할 수 없습니다',
  shipOnly: '함선에서만 교체할 수 있습니다',
  noRoom: '보관할 공간이 없습니다 — 가방이나 함선 창고를 비우세요',
  broken: '망가짐 — 세레스 바이오에서 수리',
  noFit: '장착칸 부족',
  equipped: '장착',
  unequipped: '해제',
  failed: '장착할 수 없습니다',
  clickToRemove: '클릭해 해제',
};

/** `근력 +2 · 재주 +1` for an implant def (empty string when it has no stat bonus). */
function implantStatLine(def: ItemDef | undefined, statName: (id: StatId) => string): string {
  const stats = def?.implant?.stats;
  if (!stats) return '';
  const parts: string[] = [];
  for (const [id, v] of Object.entries(stats) as Array<[StatId, number | undefined]>) {
    if (typeof v === 'number' && v !== 0) parts.push(`${statName(id)} ${v > 0 ? '+' : ''}${v}`);
  }
  return parts.join(' · ');
}
interface SkillRow { root: HTMLElement; level: HTMLElement; fill: HTMLElement; bonus: HTMLElement }

/* ── 전술 임플란트 (Phase 9 UI pass; reshaped 2026-09-07) ───────────────────
 * The implant slot used to live in the inventory window's 장착 장비 column behind a modeless picker. It is a
 * character choice, not a bag item, so it belongs to this sheet — and since 2026-09-07 it is the **third column**
 * of `.cs-body` (능력치 | 숙련도 | 전술 임플란트): the column shows one **slot card** for the equipped implant and
 * pressing it raises a **modeless picker** with every implant as a card. The card list is unchanged (`.cs-imp-card`,
 * `.is-equipped`, click to equip / unequip, raid-locked); only where it lives changed.
 *
 * The picker is a direct child of `ctx.uiRoot` (`.cs-imp-pop.interactive`), not of the column: the embedded 캐릭터
 * tab sits inside `.inv-screen`, whose `inv-pop` animation leaves a `scale:` on the element and would therefore
 * become the containing block of a `position: fixed` popup.
 * ────────────────────────────────────────────────────────────────────────── */
const IMPLANT_TEXT = {
  label: '전술 임플란트',
  empty: '장착한 임플란트가 없습니다 — 칸을 눌러 고르세요.',
  slotEmpty: '비어 있음',
  pick: '임플란트 선택',
  none: '해제',
  unavailable: '임플란트 시스템을 사용할 수 없습니다.',
  raidLocked: '레이드 중에는 임플란트를 교체할 수 없습니다 — 함선에서 바꾸세요.',
  equipped: '장착',
  unequipped: '임플란트를 해제했습니다',
  cooldown: '쿨타임',
  charges: '충전',
  mode: { instant: '즉시', hold: '홀드', wielded: '장비형' } as Readonly<Record<ImplantMode, string>>,
};

export interface SheetBodyOptions {
  /** Standalone overlay only: the 닫기 button in the footer. */
  onClose?: () => void;
  /** Footer hint (standalone: `ESC 또는 P 로 닫기`); omitted in the embedded tab. */
  hint?: string;
  /**
   * Which shell this body belongs to. Both shells exist at once (the overlay is built at init and merely hidden),
   * and the 전술 임플란트 picker is a `uiRoot` child rather than a child of the sheet — so the popup carries
   * `.cs-imp-pop-<variant>` to keep the two apart for CSS and the smokes.
   */
  variant?: 'overlay' | 'embed';
}

/**
 * The character-sheet **body** — header, XP bar, 능력치 / 숙련도 columns, 파생 능력치 grid and the footer with the
 * two-step 캐릭터 초기화 button. Built into whatever element the owner passes in, so the standalone overlay
 * (`CharacterSheet`) and the embedded 캐릭터 tab (`SheetView`, `ProgressionRef.createSheetView`) share one renderer.
 *
 * Knows nothing about blockers, the pointer lock, Escape or the `.scr-tabs` pill — those belong to the shell.
 */
export class SheetBody {
  private statRows = new Map<StatId, StatRow>();
  private skillRows = new Map<SkillId, SkillRow>();
  private derivedRows: Array<{ key: string; value: HTMLElement }> = [];
  private created: HTMLElement[] = [];

  private subtitle: HTMLElement;
  private levelText: HTMLElement;
  private pointsTag: HTMLElement;
  private xpFill: HTMLElement;
  private xpText: HTMLElement;
  private statHint: HTMLElement;
  private implantHint: HTMLElement;
  private implantCards = new Map<ImplantId, { root: HTMLButtonElement; meta: HTMLElement }>();
  /** 전술 임플란트 column: the equipped-implant slot and the modeless picker it raises. */
  private implantSlot!: HTMLButtonElement;
  private implantPop!: HTMLElement;
  private implantGrid!: HTMLElement;
  private implantCol!: HTMLElement;
  private pickerOpen = false;
  private onPickerOutside = (e: PointerEvent): void => {
    const t = e.target as Node | null;
    if (!t) return;
    if (this.implantPop.contains(t) || this.implantSlot.contains(t)) return;
    this.closePicker();
  };
  private onPickerKey = (e: KeyboardEvent): void => {
    if (!this.pickerOpen || e.code !== 'Escape') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.closePicker();
  };
  private resetBtn: HTMLButtonElement;
  private resetArmed = false;

  /* 임플란트 아이템 block (Phase 12) */
  private implBlock!: HTMLElement;
  private implCount!: HTMLElement;
  private implPips!: HTMLElement;
  private implList!: HTMLElement;
  private implMsg!: HTMLElement;
  private implAdd!: HTMLButtonElement;
  private implPop!: HTMLElement;
  private implOpts!: HTMLElement;
  private implPickerOpen = false;
  private implMsgTimer = 0;
  private onImplOutside = (e: PointerEvent): void => {
    const t = e.target as Node | null;
    if (!t) return;
    if (this.implPop.contains(t) || this.implAdd.contains(t)) return;
    this.closeImplantPicker();
  };
  private onImplKey = (e: KeyboardEvent): void => {
    if (!this.implPickerOpen || e.code !== 'Escape') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.closeImplantPicker();
  };

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

    /* ── body: 능력치 | 숙련도 | 전술 임플란트 (2026-09-07) ── */
    const body = this.own(el('div', { cls: 'cs-body', parent }));

    const statCol = el('div', { cls: 'cs-col', parent: body });
    el('div', { cls: 'ui-label', text: '능력치', parent: statCol });
    for (const def of host.getAllStatDefs()) this.buildStatRow(statCol, def);
    this.statHint = el('div', { cls: 'hint', text: '', parent: statCol });

    const skillCol = el('div', { cls: 'cs-col', parent: body });
    el('div', { cls: 'ui-label', text: '숙련도', parent: skillCol });
    const skillGrid = el('div', { cls: 'cs-skills', parent: skillCol });
    for (const def of host.getAllSkillDefs()) this.buildSkillRow(skillGrid, def);

    const imp = el('div', { cls: 'cs-col cs-implants', parent: body });
    const impHead = el('div', { cls: 'h', parent: imp });
    el('div', { cls: 'ui-label', text: IMPLANT_TEXT.label, parent: impHead });
    el('kbd', { cls: 'cs-imp-key', text: keyLabel(Keys.IMPLANT), parent: impHead });
    this.implantSlot = this.buildImplantSlot(imp);
    this.implantHint = el('div', { cls: 'hint', text: '', parent: imp });
    /* the picker itself hangs off `ctx.uiRoot` (see the block comment above) */
    this.implantPop = this.own(el('div', { cls: `cs-imp-pop cs-imp-pop-${opts.variant ?? 'embed'} interactive`, parent: ctx.uiRoot }));
    this.implantPop.hidden = true;
    const popHead = el('div', { cls: 'h', parent: this.implantPop });
    el('div', { cls: 'ui-label', text: IMPLANT_TEXT.pick, parent: popHead });
    const popClose = el('button', { cls: 'ui-btn cs-imp-close', text: '닫기', parent: popHead, attrs: { type: 'button' } });
    popClose.addEventListener('click', (e) => { e.stopPropagation(); this.closePicker(); });
    this.implantGrid = el('div', { cls: 'cs-imp-grid', parent: this.implantPop });
    this.implantCol = imp;
    this.buildImplantCards();
    /* Phase 12: 임플란트 items under the 전술 임플란트 slot (picker hangs off `ctx.uiRoot`, see `.cs-imp-pop`) */
    this.buildImplantItems(imp, opts.variant ?? 'embed');

    /* ── derived ── */
    const der = this.own(el('div', { cls: 'cs-derived', parent }));
    el('div', { cls: 'ui-label', text: '파생 능력치', parent: der });
    const grid = el('div', { cls: 'grid', parent: der });
    for (const [key, label] of DERIVED_LABELS) {
      const cell = el('div', { cls: 'cell', parent: grid });
      el('div', { cls: 'k', text: label, parent: cell });
      this.derivedRows.push({ key, value: el('div', { cls: 'v ui-mono', text: '', parent: cell }) });
    }

    /* ── footer ── */
    const foot = this.own(el('div', { cls: 'cs-foot', parent }));
    this.resetBtn = this.button(foot, '캐릭터 초기화', () => this.onReset(), 'danger');
    const spacer = el('div', { cls: 'sp', parent: foot });
    if (opts.hint) el('div', { cls: 'hint', text: opts.hint, parent: spacer });
    if (opts.onClose) this.button(foot, '닫기', opts.onClose);
  }

  private own<T extends HTMLElement>(e: T): T { this.created.push(e); return e; }

  /** Reset the two-step 초기화 confirmation (the shell calls this when it opens). */
  disarmReset(): void { this.resetArmed = false; }

  /* ── rendering ────────────────────────────────────────────────────────── */
  refresh(): void {
    const host = this.host;
    const p = host.profile;

    setText(this.subtitle, `${p.name} · 레이드 ${p.raids}회 · 탈출 ${p.extractions}회`);
    setText(this.levelText, `LV ${host.level}`);
    const pts = host.statPoints;
    this.pointsTag.hidden = pts <= 0;
    setText(this.pointsTag, `잔여 포인트 ${pts}`);

    const need = Math.max(1, host.xpToNext);
    const ratio = Math.min(1, Math.max(0, host.xp / need));
    this.xpFill.style.transform = `scaleX(${ratio.toFixed(4)})`;
    setText(this.xpText, `${Math.floor(host.xp)} / ${need} XP`);

    const inRaid = this.ctx.isRaidActive();
    setText(this.statHint, inRaid
      ? '레이드 중에는 능력치를 올릴 수 없습니다 — 함선에서 배분하세요.'
      : pts > 0 ? '＋ 를 눌러 능력치에 포인트를 배분합니다.' : '레벨업으로 포인트를 얻습니다.');

    for (const [id, row] of this.statRows) {
      const v = host.getStat(id);
      const canSpend = !inRaid && pts > 0 && v < STAT_MAX;
      row.plus.disabled = !canSpend;
      this.refreshStat(id);
    }

    for (const id of this.skillRows.keys()) this.refreshSkill(id);

    const d = host.derived;
    for (const row of this.derivedRows) setText(row.value, derivedText(row.key, d));

    this.refreshImplants();
    this.refreshImplantItems();

    this.resetBtn.disabled = inRaid;
    setText(this.resetBtn, this.resetArmed ? '정말 초기화합니다' : '캐릭터 초기화');
    this.resetBtn.classList.toggle('armed', this.resetArmed);
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

  /** Cheap partial update for a single stat row (value, stat-XP bar and `xp/next` readout). */
  refreshStat(id: StatId): void {
    const row = this.statRows.get(id);
    if (!row) return;
    const v = this.host.getStat(id);
    // Phase 12: `base (+bonus)` while an 임플란트 adds to this stat; the bonus span stays empty otherwise so `.v` reads the base
    setText(row.base, String(v));
    const bonus = typeof this.host.getImplantBonus === 'function' ? this.host.getImplantBonus(id) : 0;
    const hasBonus = Number.isFinite(bonus) && bonus !== 0;
    row.bonus.hidden = !hasBonus;
    setText(row.bonus, hasBonus ? ` (${bonus > 0 ? '+' : ''}${bonus})` : '');
    row.root.classList.toggle('has-bonus', hasBonus);
    const maxed = v >= STAT_MAX;
    const need = Math.max(1, this.host.statXpToNext(id));
    const p = Math.min(1, Math.max(0, this.host.getStatProgress(id)));
    row.fill.style.transform = `scaleX(${(maxed ? 1 : p).toFixed(4)})`;
    setText(row.xp, maxed ? '최대' : `${Math.floor(p * need)} / ${need} XP`);
    row.root.classList.toggle('maxed', maxed);
  }

  /* ── builders ─────────────────────────────────────────────────────────── */
  private buildStatRow(parent: HTMLElement, def: StatDef): void {
    const row = el('div', { cls: 'cs-stat', parent });
    const txt = el('div', { cls: 't', parent: row });
    el('div', { cls: 'n', text: def.name, parent: txt });
    el('div', { cls: 'd', text: def.description, parent: txt });
    // Stat XP (2026-09-06): progress bar + `xp / next XP` under the description.
    const prog = el('div', { cls: 'sp', parent: txt });
    const bar = el('div', { cls: 'bar', parent: prog });
    const fill = el('i', { parent: bar });
    const xp = el('div', { cls: 'xp ui-mono', text: '', parent: prog });
    const value = el('div', { cls: 'v ui-mono', parent: row });
    const base = el('span', { cls: 'base', text: '0', parent: value });
    const bonus = el('span', { cls: 'ib', text: '', parent: value });   // Phase 12: ` (+n)` from 임플란트 items
    bonus.hidden = true;
    const plus = el('button', { cls: 'ui-btn plus', text: '＋', parent: row });
    plus.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.host.spendStatPoint(def.id)) {
        this.ctx.bus.emit('audio:play', { id: 'ui_click' });
        this.refresh();
      }
    });
    this.statRows.set(def.id, { root: row, value, base, bonus, plus, fill, xp });
  }

  /* ── 전술 임플란트 ─────────────────────────────────────────────────────── */

  /**
   * The 전술 임플란트 **slot** — one card showing what is equipped (icon / name / mode / cooldown), or 비어 있음.
   * Pressing it raises the picker; pressing it again closes it.
   */
  private buildImplantSlot(parent: HTMLElement): HTMLButtonElement {
    const slot = el('button', { cls: 'cs-imp-slot', parent, attrs: { type: 'button' } });
    el('span', { cls: 'ico', parent: slot }).setAttribute('aria-hidden', 'true');
    const body = el('span', { cls: 'body', parent: slot });
    const line = el('span', { cls: 'line', parent: body });
    el('span', { cls: 'nm', parent: line });
    el('span', { cls: 'tag', parent: line });
    el('span', { cls: 'desc', parent: body });
    slot.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.pickerOpen) { this.closePicker(); return; }
      if (this.ctx.isRaidActive()) {
        this.ctx.bus.emit('audio:play', { id: 'ui_error' });
        this.ctx.bus.emit('ui:notify', { text: IMPLANT_TEXT.raidLocked, kind: 'warning', duration: 1.8 });
        return;
      }
      this.openPicker();
    });
    return slot;
  }

  /* ── 모달리스 picker ─────────────────────────────────────────────────── */

  /** true while either picker (전술 임플란트 or 임플란트 items) is up (smoke tests / the shell's Escape chain). */
  get isPickerOpen(): boolean { return this.pickerOpen || this.implPickerOpen; }

  private openPicker(): void {
    if (this.pickerOpen || this.implantCards.size === 0) return;
    this.pickerOpen = true;
    this.implantPop.hidden = false;
    this.implantSlot.classList.add('is-open');
    this.refreshImplants();
    this.placePicker();
    requestAnimationFrame(() => this.placePicker());
    document.addEventListener('pointerdown', this.onPickerOutside, true);
    window.addEventListener('keydown', this.onPickerKey, true);
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /** Closes both pickers; returns true when one was actually open (so a shell can consume that Escape). */
  closePicker(): boolean {
    const closedItems = this.closeImplantPicker();
    if (!this.pickerOpen) return closedItems;
    this.pickerOpen = false;
    this.implantPop.hidden = true;
    this.implantSlot.classList.remove('is-open');
    document.removeEventListener('pointerdown', this.onPickerOutside, true);
    window.removeEventListener('keydown', this.onPickerKey, true);
    return true;
  }

  /** Anchor the picker to the left of the slot, clamped into the viewport. */
  private placePicker(): void {
    if (!this.pickerOpen) return;
    const a = this.implantSlot.getBoundingClientRect();
    const r = this.implantPop.getBoundingClientRect();
    const m = 12;
    let left = a.left - r.width - m;
    if (left < m) left = Math.min(a.right + m, window.innerWidth - r.width - m);
    const top = Math.min(Math.max(m, a.top), window.innerHeight - r.height - m);
    this.implantPop.style.left = `${Math.round(Math.max(m, left))}px`;
    this.implantPop.style.top = `${Math.round(Math.max(m, top))}px`;
  }

  private buildImplantCard(parent: HTMLElement, id: ImplantId): void {
    const def = this.ctx.implants?.getDef(id);
    if (!def) return;
    const card = el('button', { cls: 'cs-imp-card', parent, attrs: { type: 'button', 'data-id': id, title: def.description } });
    card.style.setProperty('--ic', def.color);
    const ico = el('span', { cls: 'ico', text: def.icon, parent: card });
    ico.setAttribute('aria-hidden', 'true');
    const body = el('span', { cls: 'body', parent: card });
    const line = el('span', { cls: 'line', parent: body });
    el('span', { cls: 'nm', text: def.name, parent: line });
    el('span', { cls: 'tag', text: IMPLANT_TEXT.mode[def.mode], parent: line });
    el('span', { cls: 'desc', text: def.description, parent: body });
    const meta = el('span', { cls: 'meta', text: '', parent: body });
    card.addEventListener('click', (e) => { e.stopPropagation(); this.pickImplant(id); this.closePicker(); });
    this.implantCards.set(id, { root: card, meta });
  }

  /**
   * Build one card per implant. Called again from `refreshImplants` while the list is still empty: `ctx.implants` is
   * only set by `ImplantSystem.init`, which runs **after** `ProgressionSystem.init` builds the standalone sheet
   * (see the registration order in `main.ts`), so the overlay would otherwise never show a single implant.
   */
  private buildImplantCards(): void {
    for (const def of this.ctx.implants?.getAllDefs() ?? []) this.buildImplantCard(this.implantGrid, def.id);
    this.implantCol.classList.toggle('is-empty', this.implantCards.size === 0);
  }

  private refreshImplants(): void {
    const imp = this.ctx.implants;
    if (this.implantCards.size === 0 && imp) this.buildImplantCards();
    if (this.implantCards.size === 0) {
      setText(this.implantHint, imp ? IMPLANT_TEXT.empty : IMPLANT_TEXT.unavailable);
      this.implantHint.hidden = false;
      this.paintImplantSlot(null, false);
      return;
    }
    const inRaid = this.ctx.isRaidActive();
    const equipped = imp?.equipped ?? null;
    const def = equipped ? imp?.getDef(equipped) ?? null : null;
    // the slot card already carries the name / mode / description, so the hint is only the raid lock
    setText(this.implantHint, inRaid ? IMPLANT_TEXT.raidLocked : '');
    this.implantHint.hidden = !inRaid;
    for (const [id, card] of this.implantCards) {
      const d = imp?.getDef(id);
      card.root.classList.toggle('is-equipped', id === equipped);
      card.root.disabled = inRaid;
      setText(card.meta, d ? `${IMPLANT_TEXT.cooldown} ${d.cooldown}s${d.charges > 1 ? ` · ${IMPLANT_TEXT.charges} ${d.charges}` : ''}` : '');
    }
    this.paintImplantSlot(def, inRaid);
    if (inRaid) this.closePicker();
  }

  /** The equipped-implant slot card (empty state included). */
  private paintImplantSlot(def: ImplantDef | null, inRaid: boolean): void {
    const slot = this.implantSlot;
    if (!slot) return;
    slot.classList.toggle('is-filled', !!def);
    slot.disabled = this.implantCards.size === 0;
    slot.style.setProperty('--ic', def?.color ?? 'rgba(255,255,255,0.35)');
    slot.title = inRaid ? IMPLANT_TEXT.raidLocked : IMPLANT_TEXT.pick;
    setText(slot.querySelector<HTMLElement>('.ico')!, def?.icon ?? '＋');
    setText(slot.querySelector<HTMLElement>('.nm')!, def?.name ?? IMPLANT_TEXT.slotEmpty);
    const tag = slot.querySelector<HTMLElement>('.tag')!;
    tag.hidden = !def;
    setText(tag, def ? IMPLANT_TEXT.mode[def.mode] : '');
    setText(slot.querySelector<HTMLElement>('.desc')!, def?.description ?? IMPLANT_TEXT.empty);
  }

  private pickImplant(id: ImplantId): void {
    const imp = this.ctx.implants;
    if (!imp) return;
    if (this.ctx.isRaidActive()) {
      this.ctx.bus.emit('audio:play', { id: 'ui_error' });
      this.ctx.bus.emit('ui:notify', { text: IMPLANT_TEXT.raidLocked, kind: 'warning', duration: 1.8 });
      return;
    }
    const next = imp.equipped === id ? null : id;
    if (!imp.setEquipped(next)) { this.ctx.bus.emit('audio:play', { id: 'ui_error' }); return; }
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    const def = imp.getDef(id);
    this.ctx.bus.emit('ui:notify', {
      text: next ? `${def?.name ?? id} ${IMPLANT_TEXT.equipped}` : IMPLANT_TEXT.unequipped,
      kind: 'success', duration: 1.6,
    });
    this.refreshImplants();
  }

  /* ── 임플란트 아이템 (Phase 12) ───────────────────────────────────────── */

  private statName(id: StatId): string {
    return this.host.getAllStatDefs().find((d) => d.id === id)?.name ?? id;
  }

  private itemDef(defId: string): ItemDef | undefined {
    try { return this.ctx.loot?.getItemDef(defId); } catch { return undefined; }
  }

  /** The block itself (under the 전술 임플란트 slot) and its picker (a `uiRoot` child, like the 전술 임플란트 one). */
  private buildImplantItems(parent: HTMLElement, variant: 'overlay' | 'embed'): void {
    const block = this.implBlock = el('div', { cls: 'cs-impitems', parent });
    const head = el('div', { cls: 'h', parent: block });
    el('div', { cls: 'ui-label', text: IMPL_TEXT.label, parent: head });
    this.implCount = el('div', { cls: 'cnt ui-mono', text: '', parent: head });
    this.implPips = el('div', { cls: 'cs-impi-pips', parent: block });
    this.implList = el('div', { cls: 'cs-impi-list', parent: block });
    this.implMsg = el('div', { cls: 'cs-impi-msg', text: '', parent: block });
    this.implMsg.hidden = true;
    this.implAdd = el('button', { cls: 'ui-btn cs-impi-add', text: IMPL_TEXT.add, parent: block, attrs: { type: 'button' } });
    this.implAdd.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.implPickerOpen) { this.closeImplantPicker(); return; }
      const why = this.swapBlockReason();
      if (why) { this.showImplMsg(why, true); return; }
      this.openImplantPicker();
    });

    this.implPop = this.own(el('div', { cls: `cs-impi-pop cs-impi-pop-${variant} interactive`, parent: this.ctx.uiRoot }));
    this.implPop.hidden = true;
    const popHead = el('div', { cls: 'h', parent: this.implPop });
    el('div', { cls: 'ui-label', text: IMPL_TEXT.pick, parent: popHead });
    const close = el('button', { cls: 'ui-btn cs-imp-close', text: '닫기', parent: popHead, attrs: { type: 'button' } });
    close.addEventListener('click', (e) => { e.stopPropagation(); this.closeImplantPicker(); });
    this.implOpts = el('div', { cls: 'cs-impi-opts', parent: this.implPop });
  }

  /** Why a swap is refused right now (null = allowed): raid first, then anything that is not the ship. */
  private swapBlockReason(): string | null {
    let inRaid = false;
    try { inRaid = this.ctx.isRaidActive(); } catch { inRaid = false; }
    if (inRaid) return IMPL_TEXT.raidLocked;
    if (this.ctx.phase !== 'hub') return IMPL_TEXT.shipOnly;
    return null;
  }

  /** Inline one-line feedback under the list (replaces a toast — the block is small and the reason belongs next to it). */
  private showImplMsg(text: string, error: boolean): void {
    setText(this.implMsg, text);
    this.implMsg.hidden = false;
    this.implMsg.classList.toggle('is-error', error);
    this.ctx.bus.emit('audio:play', { id: error ? 'ui_error' : 'ui_click' });
    window.clearTimeout(this.implMsgTimer);
    this.implMsgTimer = window.setTimeout(() => { this.implMsg.hidden = true; }, 2600);
  }

  /** Header count, pip row, equipped rows and the 장착 button state. */
  private refreshImplantItems(): void {
    if (!this.implBlock) return;
    const host = this.host;
    const total = Math.max(0, host.implantSlots | 0);
    const used = Math.max(0, host.implantSlotsUsed | 0);
    setText(this.implCount, IMPL_TEXT.slots(used, total));
    // pips: one per slot, filled = used (rebuilt only when the count changes)
    if (this.implPips.childElementCount !== total) {
      this.implPips.replaceChildren();
      for (let i = 0; i < total; i++) el('i', { parent: this.implPips });
    }
    const pips = this.implPips.children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i < used);

    const blocked = this.swapBlockReason();
    const list = host.getEquippedImplants();
    this.implList.replaceChildren();
    if (list.length === 0) {
      el('div', { cls: 'cs-impi-empty', text: IMPL_TEXT.none, parent: this.implList });
    }
    for (const e of list) {
      const def = this.itemDef(e.defId);
      const row = el('button', { cls: 'cs-impi-row', parent: this.implList, attrs: { type: 'button', 'data-uid': e.uid, 'data-def-id': e.defId } });
      row.style.setProperty('--rc', RARITY_COLORS[def?.rarity ?? 'common']);
      row.appendChild(buildItemChip(def, { size: 30 }));
      const info = el('span', { cls: 'info', parent: row });
      const line = el('span', { cls: 'line', parent: info });
      el('span', { cls: 'nm', text: def?.name ?? e.defId, parent: line });
      el('span', { cls: 'tag', text: IMPL_TEXT.slotCost(def?.implant?.slots ?? 0), parent: line });
      const perk = def?.implant?.perk ? PERK_DEFS[def.implant.perk] : null;
      const statLine = implantStatLine(def, (id) => this.statName(id));
      el('span', { cls: 'meta', text: perk ? `${perk.name}${statLine ? ` · ${statLine}` : ''}` : statLine, parent: info });
      el('span', { cls: 'act', text: blocked ?? IMPL_TEXT.clickToRemove, parent: info });
      row.classList.toggle('is-locked', !!blocked);
      row.title = blocked ?? `${def?.name ?? e.defId} — ${IMPL_TEXT.clickToRemove}`;
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const why = this.swapBlockReason();
        if (why) { this.showImplMsg(why, true); return; }
        if (host.unequipImplant(e.uid)) {
          this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
          this.showImplMsg(`${def?.name ?? e.defId} ${IMPL_TEXT.unequipped}`, false);
        } else {
          this.showImplMsg(IMPL_TEXT.noRoom, true);
        }
        this.refreshImplantItems();
        if (this.implPickerOpen) this.refreshImplantOptions();
      });
    }
    this.implAdd.classList.toggle('is-locked', !!blocked);
    this.implAdd.classList.toggle('is-open', this.implPickerOpen);
    this.implAdd.title = blocked ?? IMPL_TEXT.pick;
    if (blocked) this.closeImplantPicker();
  }

  /** Every implant item in the bag + 함선 창고 (read through the inventory ref; nothing is moved here). */
  private implantCandidates(): ItemInstance[] {
    const inv = this.ctx.inventory;
    if (!inv) return [];
    const out: ItemInstance[] = [];
    const seen = new Set<string>();
    const take = (items: ItemInstance[] | undefined): void => {
      for (const it of items ?? []) {
        if (seen.has(it.uid)) continue;
        if (!this.itemDef(it.defId)?.implant) continue;
        seen.add(it.uid);
        out.push(it);
      }
    };
    try { take(typeof inv.getAllItems === 'function' ? inv.getAllItems() : undefined); } catch { /* bag not ready */ }
    try { take(typeof inv.getStashItems === 'function' ? inv.getStashItems() : undefined); } catch { /* stash not ready */ }
    // working first, then by rarity (high → low), then name
    const rank = (d: ItemDef | undefined): number => ['common', 'uncommon', 'rare', 'epic', 'legendary'].indexOf(d?.rarity ?? 'common');
    out.sort((a, b) => {
      const da = this.itemDef(a.defId), db = this.itemDef(b.defId);
      const ba = da?.implant?.broken ? 1 : 0, bb = db?.implant?.broken ? 1 : 0;
      if (ba !== bb) return ba - bb;
      const r = rank(db) - rank(da);
      if (r !== 0) return r;
      return (da?.name ?? '').localeCompare(db?.name ?? '', 'ko');
    });
    return out;
  }

  private refreshImplantOptions(): void {
    const host = this.host;
    const free = Math.max(0, host.implantSlots - host.implantSlotsUsed);
    const items = this.implantCandidates();
    this.implOpts.replaceChildren();
    if (items.length === 0) {
      el('div', { cls: 'cs-impi-empty', text: IMPL_TEXT.nothingToPick, parent: this.implOpts });
      return;
    }
    for (const it of items) {
      const def = this.itemDef(it.defId);
      const imp = def?.implant;
      const broken = !!imp?.broken;
      const slots = imp?.slots ?? 0;
      const fits = !broken && slots <= free;
      const opt = el('button', { cls: 'cs-impi-opt', parent: this.implOpts, attrs: { type: 'button', 'data-uid': it.uid, 'data-def-id': it.defId } });
      opt.style.setProperty('--rc', RARITY_COLORS[def?.rarity ?? 'common']);
      opt.appendChild(buildItemChip(def, { size: 30 }));
      const info = el('span', { cls: 'info', parent: opt });
      const line = el('span', { cls: 'line', parent: info });
      el('span', { cls: 'nm', text: def?.name ?? it.defId, parent: line });
      el('span', { cls: 'tag', text: IMPL_TEXT.slotCost(slots), parent: line });
      el('span', { cls: 'tag rar', text: RARITY_LABEL_KO[def?.rarity ?? 'common'], parent: line });
      const perk = imp?.perk ? PERK_DEFS[imp.perk] : null;
      const statLine = implantStatLine(def, (id) => this.statName(id));
      el('span', { cls: 'meta', text: perk ? `${perk.name} — ${perk.description}${statLine ? ` · ${statLine}` : ''}` : statLine, parent: info });
      const why = broken ? IMPL_TEXT.broken : !fits ? IMPL_TEXT.noFit : '';
      if (why) el('span', { cls: 'why', text: why, parent: info });
      opt.classList.toggle('is-dim', !fits);
      opt.classList.toggle('is-broken', broken);
      opt.disabled = !fits;
      opt.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const blocked = this.swapBlockReason();
        if (blocked) { this.showImplMsg(blocked, true); this.closeImplantPicker(); return; }
        if (host.equipImplant(it.uid)) {
          this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
          this.showImplMsg(`${def?.name ?? it.defId} ${IMPL_TEXT.equipped}`, false);
        } else {
          this.showImplMsg(IMPL_TEXT.failed, true);
        }
        this.refreshImplantItems();
        this.refreshImplantOptions();
        this.placeImplantPicker();
      });
    }
  }

  /** true while the 임플란트 item picker is up. */
  get isImplantPickerOpen(): boolean { return this.implPickerOpen; }

  private openImplantPicker(): void {
    if (this.implPickerOpen) return;
    this.closePicker();                      // one popup at a time
    this.implPickerOpen = true;
    this.implPop.hidden = false;
    this.implAdd.classList.add('is-open');
    this.refreshImplantOptions();
    this.placeImplantPicker();
    requestAnimationFrame(() => this.placeImplantPicker());
    document.addEventListener('pointerdown', this.onImplOutside, true);
    window.addEventListener('keydown', this.onImplKey, true);
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /** Closes the 임플란트 item picker; true when it was open. */
  closeImplantPicker(): boolean {
    if (!this.implPickerOpen) return false;
    this.implPickerOpen = false;
    this.implPop.hidden = true;
    this.implAdd?.classList.remove('is-open');
    document.removeEventListener('pointerdown', this.onImplOutside, true);
    window.removeEventListener('keydown', this.onImplKey, true);
    return true;
  }

  /** Anchor the picker to the left of the 장착 button, clamped into the viewport (same rule as the 전술 임플란트 picker). */
  private placeImplantPicker(): void {
    if (!this.implPickerOpen) return;
    const a = this.implAdd.getBoundingClientRect();
    const r = this.implPop.getBoundingClientRect();
    const m = 12;
    let left = a.left - r.width - m;
    if (left < m) left = Math.min(a.right + m, window.innerWidth - r.width - m);
    const top = Math.min(Math.max(m, a.bottom - r.height), window.innerHeight - r.height - m);
    this.implPop.style.left = `${Math.round(Math.max(m, left))}px`;
    this.implPop.style.top = `${Math.round(Math.max(m, top))}px`;
  }

  private buildSkillRow(parent: HTMLElement, def: SkillDef): void {
    const row = el('div', { cls: 'cs-skill', parent, attrs: { title: def.description } });
    const head = el('div', { cls: 'h', parent: row });
    el('div', { cls: 'n', text: def.name, parent: head });
    const bonus = el('div', { cls: 'bonus', text: '', parent: head });
    bonus.hidden = true;
    const level = el('div', { cls: 'lv ui-mono', text: '0', parent: head });
    const bar = el('div', { cls: 'bar', parent: row });
    const fill = el('i', { parent: bar });
    this.skillRows.set(def.id, { root: row, level, fill, bonus });
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`, text: label, parent });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      onClick();
    });
    return b;
  }

  /** Two-step confirmation so a stray click never wipes a character. */
  private onReset(): void {
    if (this.ctx.isRaidActive()) return;
    if (!this.resetArmed) { this.resetArmed = true; this.refresh(); return; }
    this.resetArmed = false;
    this.host.resetProfile();
    this.ctx.bus.emit('ui:notify', { text: '캐릭터를 초기화했습니다', kind: 'warning' });
    this.refresh();
  }

  dispose(): void {
    this.closePicker();
    this.closeImplantPicker();
    window.clearTimeout(this.implMsgTimer);
    for (const e of this.created) e.remove();
    this.created = [];
    this.statRows.clear();
    this.skillRows.clear();
    this.implantCards.clear();
    this.derivedRows = [];
  }
}

/* ── derived readout ──────────────────────────────────────────────────────── */
const DERIVED_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['carryCapacity', '기본 적재량'],
  ['maxStamina', '최대 스태미나'],
  ['detectRadius', '감지 반경'],
  ['enemyDetectRadius', '적 감지 반경'],
  ['meleeDamageMul', '근접 피해'],
  ['throwRangeMul', '투척 거리'],
  ['skillGainMul', '숙련 상승'],
  ['useSpeedMul', '사용 속도'],
  ['interactSpeedMul', '상호작용 속도'],
  ['gritChance', '인내 발동'],
  ['searchSpeedMul', '서치 속도'],
  ['healPowerMul', '회복 효과'],
  ['shipCallSpeedMul', '탈출 호출'],
  ['implantCooldownMul', '임플란트 쿨타임'],
  ['durabilityLossMul', '내구도 소모'],
  ['gatherYieldMul', '채집 수확'],
  ['craftSpeedMul', '제작 속도'],
  ['carryReliefFactor', '운반 부담 경감'],
];

function derivedText(key: string, d: DerivedStats): string {
  switch (key) {
    case 'carryCapacity': return `${d.carryCapacity.toFixed(1)} kg`;
    case 'maxStamina': return `${Math.round(d.maxStamina)}`;
    case 'detectRadius': return dist(d.detectRadius);
    case 'enemyDetectRadius': return dist(d.enemyDetectRadius);
    case 'meleeDamageMul': return mul(d.meleeDamageMul);
    case 'throwRangeMul': return mul(d.throwRangeMul);
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
