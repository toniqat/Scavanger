import type { GameContext, SlotCard, SlotId, StatDef, StatId } from '@/shared';
import {
  CREATE_STAT_MAX, CREATE_STAT_MIN, DEFAULT_ACCENT, SLOT_IDS, STAT_IDS, activeSlot, deleteSlot, formatCredits,
  markAutoStart, readSlotCards, setActiveSlot,
} from '@/shared';
import { el, fmtInt, setText, toggleClass } from '../dom';
import { AskPopup } from './askPopup';
import { enterShip, hasPendingInvite } from './enterShip';

interface CardEls {
  /** 카드 전체가 누를 수 있는 면이지만 `<button>` 이 아니다 — 안에 `삭제` 버튼이 들어가므로(버튼 중첩은 금지). */
  root: HTMLElement;
  bar: HTMLElement;
  slotTag: HTMLElement;
  /** 채워진 칸의 내용 전부 (빈 칸일 때 통째로 숨긴다). */
  filled: HTMLElement;
  empty: HTMLElement;
  name: HTMLElement;
  level: HTMLElement;
  credits: HTMLElement;
  raids: HTMLElement;
  extractions: HTMLElement;
  stats: Map<StatId, { value: HTMLElement; fill: HTMLElement }>;
  del: HTMLButtonElement;
}

/**
 * 캐릭터 선택 (2026-09-09) — 타이틀의 `게임 시작` 이 여는 화면.
 *
 * `SLOT_IDS` 만큼(기본 3칸)의 큰 카드를 가운데 나란히 놓고 `readSlotCards()` 로 채운다. 색인 파일은 없다 —
 * 요약은 그 슬롯의 세이브에서 바로 읽는다(`shared/saveSlot`).
 *
 *  - **채워진 칸**: 이름 · `Lv. n` · 크레딧 · 레이드/탈출 횟수 · 능력치 다섯, 그리고 그 캐릭터의 악센트 색이
 *    카드의 색(`--ac`)이다. 카드를 누르면 그 캐릭터로 시작하고, `삭제` 는 되돌릴 수 없는 것이므로
 *    무엇이 사라지는지 적은 경고 팝업(`menus/askPopup`)을 지난다.
 *  - **빈 칸**: `＋ 캐릭터 생성` — 그 슬롯의 생성창을 연다.
 *
 * **시작**: 고른 칸이 이미 `activeSlot()` 이면 새로고침 없이 곧장 함선으로 들어가고(`menus/enterShip`),
 * 다른 칸이면 `setActiveSlot` + `markAutoStart` + `location.reload()` 다 — 시스템은 부팅 때 한 번 저장소를
 * 읽으므로 슬롯 전환은 언제나 새로고침을 낀다.
 *
 * **초대 링크**(`?lobby=CODE`)는 예전 타이틀의 `함선 탑승` 이 갖고 있던 흐름 그대로 `menus/enterShip` 에 있고,
 * 슬롯을 바꿔 들어가도 새로고침 뒤의 자동 시작이 같은 길을 지나므로 초대받은 사람은 여전히 공유 함선에 닿는다.
 *
 * blocker 토큰도 커서 소유권도 갖지 않는다 — 타이틀(`MenuBase`)이 쥐고 있고 이 화면은 그 위에 얹힌다.
 */
export class CharacterSelect {
  readonly root: HTMLElement;
  private ctx!: GameContext;
  private readonly ask: AskPopup;
  private readonly cards = new Map<SlotId, CardEls>();
  private readonly msg: HTMLElement;
  private readonly sub: HTMLElement;
  private busy = false;
  private _open = false;

  constructor(
    parent: HTMLElement,
    private readonly onBack: () => void,
    private readonly onCreate: (slot: SlotId) => void,
  ) {
    this.root = el('div', { cls: 'title-screen char-select interactive', parent });
    this.root.hidden = true;

    const head = el('div', { cls: 'ts-head', parent: this.root });
    el('div', { cls: 'ts-title', text: '캐릭터 선택', parent: head });
    this.sub = el('div', { cls: 'ts-sub', text: '', parent: head });

    const wrap = el('div', { cls: 'cs-cards', parent: this.root });
    for (const id of SLOT_IDS) this.cards.set(id, this.buildCard(wrap, id));

    this.msg = el('div', { cls: 'form-msg', text: '', parent: this.root });
    this.msg.hidden = true;

    const foot = el('div', { cls: 'ts-foot', parent: this.root });
    const back = el('button', { cls: 'ui-btn', text: '뒤로', parent: foot });
    back.addEventListener('click', (e) => { e.stopPropagation(); this.back(); });
    el('div', { cls: 'hint', text: '캐릭터마다 창고 · 장비 · 함선 · 진행도가 완전히 따로 저장됩니다.', parent: foot });

    this.ask = new AskPopup(this.root);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ── build ────────────────────────────────────────────────────────────── */

  private statDefs(): readonly StatDef[] {
    const defs = (this.ctx as GameContext | undefined)?.progression?.getAllStatDefs?.();
    if (defs && defs.length > 0) return defs;
    return STAT_IDS.map((id) => ({ id, name: id, description: '' }));
  }

  private buildCard(parent: HTMLElement, id: SlotId): CardEls {
    const root = el('div', { cls: 'cs-card', attrs: { role: 'button', tabindex: '0' }, parent });
    const bar = el('div', { cls: 'cs-bar', parent: root });
    const slotTag = el('div', { cls: 'cs-slot', text: `슬롯 ${id}`, parent: root });

    /* 빈 칸 */
    const empty = el('div', { cls: 'cs-empty-wrap', parent: root });
    el('div', { cls: 'cs-plus', text: '＋', parent: empty });
    el('div', { cls: 'cs-empty-label', text: '캐릭터 생성', parent: empty });

    /* 채워진 칸 */
    const filled = el('div', { cls: 'cs-filled', parent: root });
    const name = el('div', { cls: 'cs-name', text: '', parent: filled });
    const level = el('div', { cls: 'cs-lv', text: '', parent: filled });

    const meta = el('div', { cls: 'cs-meta', parent: filled });
    const cell = (k: string): HTMLElement => {
      const c = el('div', { cls: 'cell', parent: meta });
      el('div', { cls: 'k', text: k, parent: c });
      return el('div', { cls: 'v', text: '0', parent: c });
    };
    const credits = cell('크레딧');
    const raids = cell('레이드');
    const extractions = cell('탈출');

    el('div', { cls: 'cs-divider', parent: filled });

    const statsWrap = el('div', { cls: 'cs-stats', parent: filled });
    const stats = new Map<StatId, { value: HTMLElement; fill: HTMLElement }>();
    // 능력치 줄은 `bind` 뒤에 이름을 알 수 있으므로 첫 `refresh()` 에서 채운다.
    statsWrap.dataset.pending = '1';

    const actions = el('div', { cls: 'cs-actions', parent: filled });
    const del = el('button', { cls: 'ui-btn danger', text: '삭제', parent: actions });
    del.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); this.askDelete(id); });

    root.addEventListener('click', (e) => { e.stopPropagation(); this.pick(id); });
    // 카드가 `<button>` 이 아니므로 Enter / Space 를 손으로 받는다 (탭 이동으로도 고를 수 있게).
    root.addEventListener('keydown', (e) => {
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'Space') return;
      e.preventDefault();
      e.stopPropagation();
      this.pick(id);
    });

    return { root, bar, slotTag, filled, empty, name, level, credits, raids, extractions, stats, del };
  }

  /** 카드 하나의 능력치 다섯 줄 (시트와 같은 어휘의 축소판: 이름 · mono 값 · 얇은 바). */
  private fillStatRows(card: CardEls): void {
    const wrap = card.filled.querySelector<HTMLElement>('.cs-stats');
    if (!wrap || !wrap.dataset.pending) return;
    delete wrap.dataset.pending;
    for (const def of this.statDefs()) {
      const row = el('div', { cls: 'cc-mini', parent: wrap });
      const top = el('div', { cls: 'row', parent: row });
      el('div', { cls: 'n', text: def.name, parent: top });
      const value = el('div', { cls: 'v', text: '0', parent: top });
      const bar = el('div', { cls: 'bar', parent: row });
      const fill = el('i', { parent: bar });
      card.stats.set(def.id, { value, fill });
    }
  }

  /* ── state ────────────────────────────────────────────────────────────── */

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.ask.bind(ctx);
  }

  get isOpen(): boolean { return this._open; }
  /** 칸이 몇 개 차 있나 (디버그 / 스모크). */
  get occupiedCount(): number { return readSlotCards().filter((c) => c.name !== null).length; }

  open(): void {
    this._open = true;
    this.root.hidden = false;
    this.busy = false;
    this.msg.hidden = true;
    this.refresh();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.ask.close();
    this.root.hidden = true;
  }

  private back(): void {
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.close();
    this.onBack();
  }

  /* ── render ───────────────────────────────────────────────────────────── */

  refresh(): void {
    const cards = readSlotCards();
    const active = activeSlot();
    setText(this.sub, hasPendingInvite(this.ctx)
      ? '초대를 수락합니다 — 캐릭터를 고르면 공유 함선으로 합류합니다.'
      : '출격할 대원을 고르세요.');
    for (const data of cards) {
      const card = this.cards.get(data.id);
      if (!card) continue;
      this.fillStatRows(card);
      this.renderCard(card, data, data.id === active);
    }
  }

  private renderCard(card: CardEls, data: SlotCard, isActive: boolean): void {
    const occupied = data.name !== null;
    toggleClass(card.root, 'empty', !occupied);
    toggleClass(card.root, 'is-active', occupied && isActive);
    toggleClass(card.root, 'busy', this.busy);
    card.empty.hidden = occupied;
    card.filled.hidden = !occupied;
    card.bar.hidden = !occupied;
    setText(card.slotTag, `슬롯 ${data.id}`);
    const accent = data.accent ?? DEFAULT_ACCENT;
    card.root.style.setProperty('--ac', accent);
    if (!occupied) return;

    setText(card.name, data.name ?? '');
    setText(card.level, `Lv. ${data.level}`);
    setText(card.credits, formatCredits(data.credits, { suffix: true }));
    setText(card.raids, `${fmtInt(data.raids)}회`);
    setText(card.extractions, `${fmtInt(data.extractions)}회`);
    // 바의 기준은 생성 상한(5)이되, 게임 안에서 그 위로 자란 능력치가 있으면 **그 카드의 최댓값**으로 늘린다 —
    // 상한을 `STAT_MAX`(20) 로 고정하면 갓 만든 캐릭터의 다섯 줄이 전부 바닥에 붙어 읽히지 않는다.
    let top = CREATE_STAT_MAX;
    for (const id of card.stats.keys()) top = Math.max(top, data.stats[id] ?? 0);
    const span = Math.max(1, top - CREATE_STAT_MIN);
    for (const [id, row] of card.stats) {
      const v = data.stats[id] ?? 0;
      setText(row.value, String(v));
      const t = Math.max(0, Math.min(1, (v - CREATE_STAT_MIN) / span));
      row.fill.style.transform = `scaleX(${t.toFixed(4)})`;
    }
  }

  private showMsg(text: string, kind: 'info' | 'warning' | 'danger'): void {
    this.msg.className = `form-msg ${kind}`;
    setText(this.msg, text);
    this.msg.hidden = false;
  }

  /* ── 고르기 ───────────────────────────────────────────────────────────── */

  private pick(id: SlotId): void {
    if (this.busy || this.ask.isOpen) return;
    const card = this.cards.get(id);
    if (card?.root.classList.contains('empty')) {
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.close();
      this.onCreate(id);
      return;
    }
    void this.start(id);
  }

  /**
   * 그 캐릭터로 게임에 들어간다. 활성 슬롯이면 새로고침 없이 그대로, 아니면 다음 부팅 슬롯을 적고 새로고침한다
   * (`markAutoStart` 덕분에 새로고침 뒤 타이틀을 건너뛰고 바로 함선이다).
   */
  private async start(id: SlotId): Promise<void> {
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    if (id !== activeSlot()) {
      setActiveSlot(id);
      markAutoStart();
      window.location.reload();
      return;
    }
    this.busy = true;
    this.refresh();
    await enterShip(this.ctx, {
      setBusy: (busy) => {
        this.busy = busy;
        if (busy) this.showMsg('서버 연결 중…', 'info'); else this.msg.hidden = true;
        this.refresh();
      },
      showMessage: (text, kind) => this.showMsg(text, kind),
    });
    this.busy = false;
    this.refresh();
  }

  /* ── 삭제 ─────────────────────────────────────────────────────────────── */

  private askDelete(id: SlotId): void {
    if (this.busy) return;
    const card = readSlotCards().find((c) => c.id === id);
    if (!card || card.name === null) return;
    this.ask.open({
      title: '캐릭터 삭제',
      body: `${card.name} (Lv. ${card.level}) 을(를) 지웁니다.\n`
        + '창고 · 장비 · 함선 · 진행도 · 크레딧이 모두 사라집니다. 되돌릴 수 없습니다.',
      ok: '삭제',
      danger: true,
      run: () => this.remove(id),
    });
  }

  private remove(id: SlotId): void {
    deleteSlot(id);
    this.showMsg('캐릭터를 삭제했습니다.', 'warning');
    this.refresh();
    // 지운 것이 지금 부팅한 슬롯이면 메모리에 올라온 시스템들이 아직 그 캐릭터를 들고 있다 — 새 캐릭터를
    // 만들거나 다른 칸을 고르면 그때 새로고침이 걸리므로, 여기서는 굳이 강제하지 않고 안내만 남긴다.
    if (id === activeSlot()) {
      this.showMsg('캐릭터를 삭제했습니다 — 다른 캐릭터를 고르거나 새로 만들면 새 세이브로 시작합니다.', 'warning');
    }
  }

  dispose(): void {
    this.close();
    this.ask.dispose();
    this.root.remove();
  }
}
