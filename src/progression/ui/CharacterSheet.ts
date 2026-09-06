import type { DerivedStats, GameContext, PlayerProfile, SkillDef, SkillId, StatDef, StatId } from '@/shared';
import { Keys, SKILL_LEVEL_MAX, STAT_MAX } from '@/shared';
import './character.css';

/** What the sheet needs from ProgressionSystem (kept structural so there is no circular import). */
export interface CharacterSheetHost {
  readonly profile: PlayerProfile;
  readonly derived: DerivedStats;
  readonly level: number;
  readonly xp: number;
  readonly xpToNext: number;
  readonly statPoints: number;
  getStat(id: StatId): number;
  getSkill(id: SkillId): number;
  getSkillProgress(id: SkillId): number;
  getAllStatDefs(): readonly StatDef[];
  getAllSkillDefs(): readonly SkillDef[];
  spendStatPoint(id: StatId): boolean;
  resetProfile(): void;
}

const BLOCKER = 'stats';

interface ElOptions { cls?: string; text?: string; parent?: HTMLElement; attrs?: Record<string, string> }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, o: ElOptions = {}): HTMLElementTagNameMap[K] {
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

interface StatRow { root: HTMLElement; value: HTMLElement; plus: HTMLButtonElement }
interface SkillRow { root: HTMLElement; level: HTMLElement; fill: HTMLElement }

/**
 * 캐릭터 시트 (`.menu.char-sheet`): level + XP bar, the five stats with a `＋` button that only works in the ship,
 * the fourteen skills with their training progress, and a readout of every derived number.
 *
 * Opened / closed by `ui:statsToggled` (the inventory window's 캐릭터 tab and the ship terminal emit it) — see ProgressionSystem.
 * Carries the shared screen tabs (인벤토리 → closes the sheet and opens the inventory window · 캐릭터 · 기업 disabled). Adds the
 * `'stats'` UI blocker token **before** exiting pointer lock, and re-locks on close when nothing else blocks.
 */
export class CharacterSheet {
  readonly root: HTMLElement;
  private frame: HTMLElement;
  private _open = false;

  private subtitle: HTMLElement;
  private levelText: HTMLElement;
  private pointsTag: HTMLElement;
  private xpFill: HTMLElement;
  private xpText: HTMLElement;
  private statHint: HTMLElement;
  private statRows = new Map<StatId, StatRow>();
  private skillRows = new Map<SkillId, SkillRow>();
  private derivedRows: Array<{ key: string; value: HTMLElement }> = [];
  private resetBtn: HTMLButtonElement;
  private resetArmed = false;

  private escHandler = (e: KeyboardEvent): void => {
    if (e.code !== Keys.MENU || !this._open) return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };

  constructor(private readonly ctx: GameContext, private readonly host: CharacterSheetHost) {
    const root = this.root = el('div', { cls: 'menu char-sheet interactive', parent: ctx.uiRoot });
    root.hidden = true;
    el('div', { cls: 'scan', parent: root });
    // Screen tabs shared with the inventory window (same look, `.scr-tabs` in ui/styles/base.css).
    const tabs = el('nav', { cls: 'scr-tabs', parent: root });
    const tabInv = el('button', { cls: 'scr-tab', text: '인벤토리', parent: tabs });
    tabInv.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.close(false);
      this.ctx.inventory?.toggleBag();
    });
    el('button', { cls: 'scr-tab is-on', text: '캐릭터', parent: tabs });
    const tabCorp = el('button', { cls: 'scr-tab is-disabled', text: '기업', parent: tabs, attrs: { disabled: '', title: '기업 · 계약 · 퀘스트는 준비 중입니다' } });
    tabCorp.disabled = true;
    const f = this.frame = el('div', { cls: 'frame', parent: root });

    /* ── header ── */
    const head = el('div', { cls: 'cs-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '캐릭터', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });
    const lvBox = el('div', { cls: 'cs-level', parent: head });
    this.levelText = el('div', { cls: 'lv', text: 'LV 1', parent: lvBox });
    this.pointsTag = el('div', { cls: 'pts', text: '', parent: lvBox });
    this.pointsTag.hidden = true;

    /* ── xp bar ── */
    const xp = el('div', { cls: 'cs-xp', parent: f });
    const xpBar = el('div', { cls: 'bar', parent: xp });
    this.xpFill = el('i', { parent: xpBar });
    this.xpText = el('div', { cls: 'txt ui-mono', text: '', parent: xp });

    /* ── body: stats | skills ── */
    const body = el('div', { cls: 'cs-body', parent: f });

    const statCol = el('div', { cls: 'cs-col', parent: body });
    el('div', { cls: 'ui-label', text: '능력치', parent: statCol });
    for (const def of host.getAllStatDefs()) this.buildStatRow(statCol, def);
    this.statHint = el('div', { cls: 'hint', text: '', parent: statCol });

    const skillCol = el('div', { cls: 'cs-col', parent: body });
    el('div', { cls: 'ui-label', text: '숙련도', parent: skillCol });
    const skillGrid = el('div', { cls: 'cs-skills', parent: skillCol });
    for (const def of host.getAllSkillDefs()) this.buildSkillRow(skillGrid, def);

    /* ── derived ── */
    const der = el('div', { cls: 'cs-derived', parent: f });
    el('div', { cls: 'ui-label', text: '파생 능력치', parent: der });
    const grid = el('div', { cls: 'grid', parent: der });
    for (const [key, label] of DERIVED_LABELS) {
      const cell = el('div', { cls: 'cell', parent: grid });
      el('div', { cls: 'k', text: label, parent: cell });
      this.derivedRows.push({ key, value: el('div', { cls: 'v ui-mono', text: '', parent: cell }) });
    }

    /* ── footer ── */
    const foot = el('div', { cls: 'cs-foot', parent: f });
    this.resetBtn = this.button(foot, '캐릭터 초기화', () => this.onReset(), 'danger');
    const spacer = el('div', { cls: 'sp', parent: foot });
    el('div', { cls: 'hint', text: 'ESC 또는 P 로 닫기', parent: spacer });
    this.button(foot, '닫기', () => this.close());

    root.addEventListener('mousedown', (e) => e.stopPropagation());
    window.addEventListener('keydown', this.escHandler, true);
  }

  get isOpen(): boolean { return this._open; }

  /* ── open / close ─────────────────────────────────────────────────────── */
  open(): void {
    if (this._open) return;
    this._open = true;
    this.resetArmed = false;
    // Blocker first, then exit the lock, so GameFlow's pointerlockchange handler sees an intended exit.
    this.ctx.uiBlockers.add(BLOCKER);
    this.ctx.input.exitPointerLock();
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    this.refresh();
    this.ctx.bus.emit('ui:statsToggled', { open: true });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(relock = true): void {
    if (!this._open) return;
    this._open = false;
    this.resetArmed = false;
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(BLOCKER);
    this.ctx.bus.emit('ui:statsToggled', { open: false });
    if (!relock) return;
    // The key press / click that closed us is a user activation → Chrome allows re-locking here.
    queueMicrotask(() => {
      const ctx = this.ctx;
      if (this._open || ctx.uiBlockers.size > 0) return;
      if (!ctx.isGameplayPhase() && !ctx.isHubPhase()) return;
      if (ctx.player?.isDead ?? false) return;
      ctx.input.requestPointerLock();
    });
  }

  /* ── rendering ────────────────────────────────────────────────────────── */
  refresh(): void {
    if (!this._open) return;
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
      setText(row.value, String(v));
      const canSpend = !inRaid && pts > 0 && v < STAT_MAX;
      row.plus.disabled = !canSpend;
      row.root.classList.toggle('maxed', v >= STAT_MAX);
    }

    for (const id of this.skillRows.keys()) this.refreshSkill(id);

    const d = host.derived;
    for (const row of this.derivedRows) setText(row.value, derivedText(row.key, d));

    this.resetBtn.disabled = inRaid;
    setText(this.resetBtn, this.resetArmed ? '정말 초기화합니다' : '캐릭터 초기화');
    this.resetBtn.classList.toggle('armed', this.resetArmed);
  }

  /** Cheap partial update for a single skill bar (called while training). */
  refreshSkill(id: SkillId): void {
    if (!this._open) return;
    const row = this.skillRows.get(id);
    if (!row) return;
    const lv = this.host.getSkill(id);
    setText(row.level, `${lv}`);
    const p = lv >= SKILL_LEVEL_MAX ? 1 : Math.min(1, Math.max(0, this.host.getSkillProgress(id)));
    row.fill.style.transform = `scaleX(${p.toFixed(4)})`;
    row.root.classList.toggle('maxed', lv >= SKILL_LEVEL_MAX);
  }

  /* ── builders ─────────────────────────────────────────────────────────── */
  private buildStatRow(parent: HTMLElement, def: StatDef): void {
    const row = el('div', { cls: 'cs-stat', parent });
    const txt = el('div', { cls: 't', parent: row });
    el('div', { cls: 'n', text: def.name, parent: txt });
    el('div', { cls: 'd', text: def.description, parent: txt });
    const value = el('div', { cls: 'v ui-mono', text: '0', parent: row });
    const plus = el('button', { cls: 'ui-btn plus', text: '＋', parent: row });
    plus.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.host.spendStatPoint(def.id)) {
        this.ctx.bus.emit('audio:play', { id: 'ui_click' });
        this.refresh();
      }
    });
    this.statRows.set(def.id, { root: row, value, plus });
  }

  private buildSkillRow(parent: HTMLElement, def: SkillDef): void {
    const row = el('div', { cls: 'cs-skill', parent, attrs: { title: def.description } });
    const head = el('div', { cls: 'h', parent: row });
    el('div', { cls: 'n', text: def.name, parent: head });
    const level = el('div', { cls: 'lv ui-mono', text: '0', parent: head });
    const bar = el('div', { cls: 'bar', parent: row });
    const fill = el('i', { parent: bar });
    this.skillRows.set(def.id, { root: row, level, fill });
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
    window.removeEventListener('keydown', this.escHandler, true);
    this.ctx.uiBlockers.delete(BLOCKER);
    this._open = false;
    this.root.remove();
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
