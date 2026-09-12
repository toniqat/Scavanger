import type { DerivedStats, GameContext, GymStat, PlayerProfile, SkillDef, SkillId, StatDef, StatId } from '@/shared';
import { GYM_FATIGUE_LABEL_KO, GYM_STATS, GYM_TRAINED_MAX, SKILL_LEVEL_MAX, STAT_MAX } from '@/shared';

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

interface StatRow {
  root: HTMLElement; value: HTMLElement; base: HTMLElement; bonus: HTMLElement; plus: HTMLButtonElement; fill: HTMLElement; xp: HTMLElement;
  /** A-3a: ` (+n 단련)` after the implant bonus (empty + hidden at 0). */
  trained: HTMLElement;
  /** A-3a, 근력 · 지구력 only: `단련 +n · p %` / `단련 최대` and the debuff countdown line. */
  gymProg: HTMLElement | null;
  fatigue: HTMLElement | null;
}

interface SkillRow { root: HTMLElement; level: HTMLElement; fill: HTMLElement; bonus: HTMLElement }

export interface SheetBodyOptions {
  /** Standalone overlay only: the 닫기 button in the footer. */
  onClose?: () => void;
  /** Footer hint (standalone: `Tab 으로 닫기`); omitted in the embedded tab. */
  hint?: string;
  /**
   * Which shell this body belongs to. Both exist at once (the overlay is built at init and merely hidden), so the
   * smokes need a way to tell them apart. Nothing in the body hangs off `ctx.uiRoot` any more (the two implant
   * pickers that did moved to the inventory window on 2026-09-08), so this is only a marker today.
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
  private resetBtn: HTMLButtonElement;
  private resetArmed = false;
  /**
   * A-3a: 1 Hz repaint of the debuff countdown. Runs **only** while a debuff is active **and** the body is on screen — the
   * tick stops itself when the body is hidden (closed overlay / other inventory tab) or no debuff is left; both shells call
   * `refresh()` when they show the body again, which restarts it.
   */
  private ticker: number | null = null;

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

    /* ── body: 능력치 | 숙련도 (2026-09-08: 임플란트 두 블록은 인벤토리 장착 장비 칸으로 이사했다) ── */
    const body = this.own(el('div', { cls: 'cs-body', parent }));

    const statCol = el('div', { cls: 'cs-col', parent: body });
    el('div', { cls: 'ui-label', text: '능력치', parent: statCol });
    for (const def of host.getAllStatDefs()) this.buildStatRow(statCol, def);
    this.statHint = el('div', { cls: 'hint', text: '', parent: statCol });

    const skillCol = el('div', { cls: 'cs-col', parent: body });
    el('div', { cls: 'ui-label', text: '숙련도', parent: skillCol });
    const skillGrid = el('div', { cls: 'cs-skills', parent: skillCol });
    for (const def of host.getAllSkillDefs()) this.buildSkillRow(skillGrid, def);

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
    // A-3a: 헬스장 단련 보너스 — its own span and colour after the implant one: `10 (+2) (+1 단련)`
    const tb = typeof this.host.getTrainedBonus === 'function' ? this.host.getTrainedBonus(id) : 0;
    const hasTrained = Number.isFinite(tb) && tb > 0;
    row.trained.hidden = !hasTrained;
    setText(row.trained, hasTrained ? ` (+${tb} 단련)` : '');
    row.root.classList.toggle('has-bonus', hasBonus || hasTrained);
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
    // A-3a: 근력 · 지구력 carry a short 단련 line (`단련 +2 · 40 %` / `단련 최대`) and, while a debuff runs, its countdown
    let gymProg: HTMLElement | null = null;
    let fatigue: HTMLElement | null = null;
    if (isGymStat(def.id)) {
      const gy = el('div', { cls: 'gy', parent: txt });
      gymProg = el('span', { cls: 'gtr ui-mono', text: '', parent: gy });
      fatigue = el('span', { cls: 'fat ui-mono', text: '', parent: gy });
      fatigue.hidden = true;
    }
    const value = el('div', { cls: 'v ui-mono', parent: row });
    const base = el('span', { cls: 'base', text: '0', parent: value });
    const bonus = el('span', { cls: 'ib', text: '', parent: value });   // Phase 12: ` (+n)` from 임플란트 items
    bonus.hidden = true;
    const trained = el('span', { cls: 'tb', text: '', parent: value });  // A-3a: ` (+n 단련)` from the 헬스장
    trained.hidden = true;
    const plus = el('button', { cls: 'ui-btn plus', text: '＋', parent: row });
    plus.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.host.spendStatPoint(def.id)) {
        this.ctx.bus.emit('audio:play', { id: 'ui_click' });
        this.refresh();
      }
    });
    this.statRows.set(def.id, { root: row, value, base, bonus, plus, fill, xp, trained, gymProg, fatigue });
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
    this.stopTicker();
    for (const e of this.created) e.remove();
    this.created = [];
    this.statRows.clear();
    this.skillRows.clear();
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
