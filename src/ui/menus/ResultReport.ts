import '../styles/results.css';
import type { GameContext, MissionDeathCause, MissionStats } from '@/shared';
import { formatCredits } from '@/shared';
import { el, fmtInt, setText, toggleClass } from '../dom';

/**
 * 결과 창 공용 몸통 (2026-09-15, 결과 창 개편 — 사용자 결정). `menus/MissionComplete` · `menus/DeathScreen` 이 함께 쓴다.
 *
 * - `buildResultHeader` — 제목 줄: 왼쪽 제목(`탈출 성공` / `전사` / `레이드 실패`), 오른쪽 **임무 시간** 하나.
 * - `buildPlanetLine` — 행성 줄: 왼쪽 회색 라벨 `행성`(없앤 부제와 같은 크기), 오른쪽 조금 큰 흰 이름. 가운뎃점 없음.
 * - `ResultReport` — `.stats.rs-stats` 한 덩어리:
 *   - 전리품 줄: 왼쪽 라벨 · 오른쪽 값(`1,234 C`, 카운트업). 탈출 = `전리품 가치`(`stats.lootValue`, 호박색),
 *     사망 = `잃은 전리품 가치`(`stats.peakLootValue` — 그 레이드의 최고 소지품 가치, 빨강).
 *   - 사망 원인 줄(사망 모드에서 `stats.death` 가 있을 때만): 왼쪽 정사각 썸네일 — 적이면 `ctx.enemies.renderPortrait`
 *     얼굴(다음 프레임에 그려 화면이 먼저 뜬다 · 못 그리면 대체 아이콘), 아니면 원인 아이콘(SVG, 절차) — 오른쪽 위 작은 이름,
 *     아래 큰 숫자 = 그 원인(적이면 **그 개체**)에게서 받은 피해. 원인을 모르면 줄이 숨는다.
 * 처치 · 개봉한 상자 · 받은 피해 칸은 없어졌다. 스타일은 `styles/results.css` (접두사 `.rs-`).
 */

export type ResultMode = 'extract' | 'death';

export interface ResultHeader {
  row: HTMLElement;
  title: HTMLElement;
  time: HTMLElement;
}

/** 제목 줄 — 왼쪽 제목, 오른쪽 임무 시간. `.title` 이 줄의 첫 `.title` 이다 (스모크가 그렇게 찾는다). */
export function buildResultHeader(parent: HTMLElement, titleText: string, titleCls: string): ResultHeader {
  const row = el('div', { cls: 'rs-titlerow', parent });
  const title = el('div', { cls: `title ${titleCls}`, text: titleText, parent: row });
  const box = el('div', { cls: 'rs-time', parent: row });
  el('span', { cls: 'ui-label', text: '임무 시간', parent: box });
  const time = el('span', { cls: 'rs-time-v', text: '00:00', parent: box });
  return { row, title, time };
}

export interface PlanetLine {
  row: HTMLElement;
  value: HTMLElement;
}

/**
 * 행성 줄 (2026-09-15, 사용자 결정) — 두 결과 창이 같은 모습을 쓴다. 가운뎃점 대신 gap 으로 벌린 두 조각:
 * 회색 라벨 `행성`(`.rs-planet-k`, 없앤 부제와 같은 12px) + 조금 큰 흰 이름(`.rs-planet-v`).
 * `.planet-line` 은 계약대로 남는다 (스모크가 그 이름으로 줄을 찾는다). 이름은 `planetLabel` 이 채우는데
 * 그것은 행성이 없어도 `PLANET_NONE_LABEL`(`목표 미지정`) 을 돌려주므로 **빈 줄이 될 수 없다** — 숨김 갈래가 없다.
 */
export function buildPlanetLine(parent: HTMLElement): PlanetLine {
  const row = el('div', { cls: 'planet-line rs-planet', parent });
  el('span', { cls: 'rs-planet-k', text: '행성', parent: row });
  const value = el('span', { cls: 'rs-planet-v', text: '', parent: row });
  return { row, value };
}

const LOOT_DELAY = 0.4;   // 카운트업 시작 전 (프레임 등장 애니메이션 뒤)
const LOOT_DUR = 1.6;     // 카운트업 길이
/** 썸네일의 CSS 크기 (px) — `results.css` `.rs-cause-thumb` 와 같은 값. 그리는 해상도는 × devicePixelRatio (최대 2). */
const THUMB_CSS_PX = 72;

/* ── 원인 아이콘 (24×24 선 그림, currentColor) ─────────────────────────────────────────── */
const ICON_PATHS: Readonly<Record<string, string>> = {
  // 적 (얼굴을 못 그렸을 때) — 투구 쓴 머리
  enemy: '<path d="M5 12a7 7 0 0 1 14 0v3.5l-2 1.2V20h-3v-2h-4v2H7v-3.3l-2-1.2z"/><path d="M8.5 11.5h2.5M13 11.5h2.5"/>',
  // 낙하 — 아래 화살표와 땅
  fall: '<path d="M12 3v11"/><path d="M7.5 10l4.5 4.5 4.5-4.5"/><path d="M3.5 20.5h17"/><path d="M6 20.5l1.5-2.5M18 20.5l-1.5-2.5"/>',
  // 폭풍 — 구름과 번개
  storm: '<path d="M7 16.5a4.2 4.2 0 0 1-.4-8.4A5.6 5.6 0 0 1 17.3 8a3.8 3.8 0 0 1 .4 7.6"/><path d="M12.8 12.5l-2.6 4h3.2l-2.2 4"/>',
  // 독성 포자 — 흩어진 알갱이
  spores: '<circle cx="12" cy="12.5" r="2.4"/><circle cx="6" cy="8" r="1.5"/><circle cx="17.5" cy="6.5" r="1.7"/><circle cx="6.5" cy="17.5" r="1.7"/><circle cx="17.5" cy="17" r="1.3"/><circle cx="12" cy="4.5" r="1"/>',
  // 행성 환경 — 행성과 열기
  env: '<circle cx="12" cy="14.5" r="5.5"/><path d="M6.5 14.5c3 1.4 8 1.4 11 0"/><path d="M8 2.5c1 1-1 2 0 3.2M12 2c1 1-1 2 0 3.2M16 2.5c1 1-1 2 0 3.2"/>',
  // 폭발 — 별 모양 파열
  explosion: '<path d="M12 2.5l1.8 5.3 5-2.6-2.6 5 5.3 1.8-5.3 1.8 2.6 5-5-2.6-1.8 5.3-1.8-5.3-5 2.6 2.6-5-5.3-1.8 5.3-1.8-2.6-5 5 2.6z"/>',
  // 자기 폭발물 — 수류탄
  self: '<circle cx="11" cy="14.5" r="6"/><path d="M9 8.8V6h4v2.8"/><path d="M13 6l3.5-2"/><path d="M18 7.5l2.2-.6M18.2 10.2l2 .6"/>',
  // 아군 폭발물 — 사람과 파열
  ally: '<circle cx="8" cy="8" r="3"/><path d="M2.8 20.5a5.2 5.2 0 0 1 10.4 0"/><path d="M17.5 4.5l.9 2.6 2.5-1.2-1.2 2.5 2.6.9-2.6.9 1.2 2.5-2.5-1.2-.9 2.6-.9-2.6-2.5 1.2 1.2-2.5-2.6-.9 2.6-.9-1.2-2.5 2.5 1.2z"/>',
  // 그 밖 — 물음표
  other: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.8"/><path d="M12 16.9v.3"/>',
};

function iconKeyOf(d: MissionDeathCause): string {
  if (d.kind === 'hazard') return d.hazard === 'spores' ? 'spores' : 'storm';
  return ICON_PATHS[d.kind] ? d.kind : 'other';
}

function iconSvg(key: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[key] ?? ICON_PATHS.other}</svg>`;
}

export class ResultReport {
  readonly root: HTMLElement;
  private lootRow: HTMLElement;
  private lootLabel: HTMLElement;
  private lootVal: HTMLElement;
  private causeRow: HTMLElement;
  private causeThumb: HTMLElement;
  private causeName: HTMLElement;
  private causeNum: HTMLElement;
  private ctx: GameContext | null = null;

  private mode: ResultMode = 'extract';
  private target = 0;
  private timer = 0;
  private counting = false;
  private lastText = '';
  /** 썸네일 요청 번호 — 다음 프레임에 그리는 사이 다른 결과로 바뀌면 버린다. */
  private job = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'stats rs-stats', parent });

    this.lootRow = el('div', { cls: 'rs-loot', parent: this.root });
    this.lootLabel = el('span', { cls: 'ui-label rs-loot-label', text: '전리품 가치', parent: this.lootRow });
    this.lootVal = el('span', { cls: 'rs-loot-v', text: formatCredits(0), parent: this.lootRow });

    this.causeRow = el('div', { cls: 'rs-cause', parent: this.root });
    this.causeRow.hidden = true;
    this.causeThumb = el('div', { cls: 'rs-cause-thumb', parent: this.causeRow });
    el('span', { cls: 'ui-label rs-cause-cap', text: '사망 원인', parent: this.causeRow });
    const text = el('div', { cls: 'rs-cause-text', parent: this.causeRow });
    this.causeName = el('div', { cls: 'rs-cause-name', parent: text });
    const dmg = el('div', { cls: 'rs-cause-dmg', parent: text });
    el('span', { cls: 'ui-label rs-cause-unit', text: '받은 피해', parent: dmg });
    this.causeNum = el('span', { cls: 'rs-cause-num', text: '0', parent: dmg });
  }

  bind(ctx: GameContext): void { this.ctx = ctx; }

  fill(s: MissionStats, mode: ResultMode): void {
    this.mode = mode;
    const dead = mode === 'death';
    toggleClass(this.lootRow, 'lost', dead);
    setText(this.lootLabel, dead ? '잃은 전리품 가치' : '전리품 가치');
    const raw = dead ? (s.peakLootValue ?? s.lootValue) : s.lootValue;
    this.target = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    this.timer = 0;
    this.counting = true;
    this.lastText = formatCredits(0);
    setText(this.lootVal, this.lastText);
    this.fillCause(dead ? (s.death ?? null) : null);
  }

  private fillCause(d: MissionDeathCause | null): void {
    const job = ++this.job;
    this.causeRow.hidden = !d;
    if (!d) { this.causeThumb.replaceChildren(); return; }
    const enemy = d.kind === 'enemy';
    toggleClass(this.causeRow, 'is-enemy', enemy);
    this.causeRow.dataset.kind = d.kind;
    setText(this.causeName, d.label || '알 수 없는 원인');
    setText(this.causeNum, fmtInt(Math.max(0, d.damage)));
    this.causeThumb.innerHTML = iconSvg(iconKeyOf(d));
    if (!enemy || !d.enemyType) return;
    const type = d.enemyType;
    const label = d.label;
    const draw = (): void => {
      if (job !== this.job) return;
      const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
      const px = Math.round(THUMB_CSS_PX * Math.min(2, Math.max(1, dpr)));
      let url: string | null = null;
      try { url = this.ctx?.enemies?.renderPortrait?.(type, px) ?? null; } catch { url = null; }
      if (!url || job !== this.job) return;
      const img = document.createElement('img');
      img.alt = label;
      img.draggable = false;
      img.src = url;
      this.causeThumb.replaceChildren(img);
    };
    // 한 프레임 미룬다 — 처음 그리는 종류는 셰이더를 굽느라 수십 ms 걸릴 수 있어 결과 창이 먼저 떠야 한다.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(draw);
    else draw();
  }

  update(dt: number): void {
    if (!this.counting) return;
    this.timer += dt;
    const t = Math.min(1, (this.timer - LOOT_DELAY) / LOOT_DUR);
    if (t < 0) return;
    const eased = 1 - Math.pow(1 - t, 3);
    const txt = formatCredits(this.target * eased);
    if (txt !== this.lastText) { this.lastText = txt; setText(this.lootVal, txt); }
    if (t >= 1) {
      this.counting = false;
      if (this.mode === 'extract') this.ctx?.bus.emit('audio:play', { id: 'ui_equip' });
    }
  }

  stop(): void { this.counting = false; }

  /* ── debug ── */
  get lootText(): string { return this.lootVal.textContent ?? ''; }
  get causeShown(): boolean { return !this.causeRow.hidden; }
  get isCounting(): boolean { return this.counting; }
}
