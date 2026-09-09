import type { GameContext, ImplantDef, ImplantId, SlotId, StatDef, StatId } from '@/shared';
import {
  ACCENT_COLORS, CHARACTER_NAME_MAX, CREATE_IMPLANT_IDS, CREATE_STAT_MAX, CREATE_STAT_MIN, CREATE_STAT_POINTS,
  DEFAULT_ACCENT, STAT_IDS, baseCreateStats, canAdjustStat, createCharacterInSlot, deleteSlot, markAutoStart,
  rollCallsign, rollCreateStats, sanitizeCharacterName, setActiveSlot, statPointsLeft,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { AskPopup } from './askPopup';
import { createSoldierPreview, type SoldierPreview } from './SoldierPreview';

interface StatRow {
  root: HTMLElement;
  value: HTMLElement;
  fill: HTMLElement;
  down: HTMLButtonElement;
  up: HTMLButtonElement;
}

/**
 * 캐릭터 생성 (2026-09-09) — 캐릭터 선택창의 빈 칸에서 열린다.
 *
 * 화면은 **세 열**(`.cc-body`)이다 (2026-09-09 개편 — 1280×720 에 스크롤 없이 들어가야 한다):
 *  - **왼쪽 · 캐릭터 설정**: 이름(+주사위) · **시작 임플란트 타일**. 임플란트는 목록이 아니라 지금 고른 것
 *    하나를 큰 썸네일(`.cc-imp-tile`, 아이콘 크게 · `--ic` 색 · 이름은 우하단)로 보여 주고, 타일을 누르면
 *    **타일 오른쪽에 컨텍스트 메뉴**(`.cc-imp-menu`, 커뮤니티 우클릭 메뉴 `.sc-menu` 와 같은 껍데기)가 떠서
 *    `CREATE_IMPLANT_IDS` 전부를 아이콘 · 이름 · 설명으로 나열한다. 고르면 닫히고, 바깥 클릭 · Escape 로도
 *    닫힌다 — Escape 는 다른 팝업과 같이 capture 핸들러에서 삼켜 `Input` 이 보지 못하게 한다.
 *  - **가운데 · 캐릭터 스탯**: 능력치 다섯을 **세로 한 줄씩**(`.cc-stat-list`) `◀ ▶` 로 배분한다. 표현은
 *    캐릭터 시트(`progression/ui/SheetBody` 의 `.cs-stat`)를 그대로 옮겼다 — 이름 · 설명 · 얇은 바 · mono 숫자.
 *    `◀` 와 `▶` 는 둘 다 악센트(주황) 윤곽이고 못 누르는 쪽만 흐려진다. 남은 점수를 크게 띄운다.
 *  - **오른쪽 · 3D 미리보기**: `menus/SoldierPreview` (자기 WebGL 컨텍스트, `hub/ui/PlanetHologram` 의 규칙).
 *    그 **바로 아래 악센트 스와치**(`.cc-accent`) — 고르면 그 자리에서 다시 칠해진다.
 *
 * **규칙은 전부 `shared/character.ts`** 에 있다 (`CREATE_STAT_MIN/MAX/POINTS`, `canAdjustStat`,
 * `rollCreateStats`, `rollCallsign`, `sanitizeCharacterName`, `ACCENT_COLORS`, `CREATE_IMPLANT_IDS`).
 * 이 파일은 그것을 그리기만 한다 — 숫자가 하나도 없다.
 *
 * **주사위는 사람이 손으로 넣은 것을 말없이 지우지 않는다**: 이름을 직접 쳤거나 능력치를 한 번이라도
 * 조정했다면 먼저 경고 팝업(`menus/askPopup`)을 띄우고 확인해야 덮어쓴다. `확정` 도 요약 팝업을 지난다.
 *
 * **점수가 남아 있으면 확정할 수 없다** (2026-09-09): `확정` 버튼은 `statPointsLeft > 0` 인 동안 `disabled`
 * (툴팁 `남은 점수를 모두 배분하세요`)이고, 그래도 눌리면(키보드 등) `능력치 배분 미완료` 안내 팝업만 뜬다.
 * 그래서 옛 "남은 점수 N점은 버려집니다" 줄은 요약에서 사라졌다 — 그런 일이 이제 없다.
 *
 * 확정 뒤에는 `createCharacterInSlot` → `setActiveSlot` → `markAutoStart` → `location.reload()` 다.
 * 실행 중인 시스템에 새 프로필을 밀어 넣는 길은 없다 (창고 · 메타 · 함선까지 다시 읽어야 하고, 그게 부팅이다).
 *
 * blocker 토큰도 커서 소유권도 갖지 않는다 — 타이틀(`MenuBase`)이 계속 쥐고 있고 이 화면은 그 위에 얹힌다.
 */
export class CharacterCreate {
  readonly root: HTMLElement;
  private ctx!: GameContext;
  private readonly ask: AskPopup;

  private readonly nameInput: HTMLInputElement;
  private readonly slotTag: HTMLElement;
  private readonly swatches: { hex: string; btn: HTMLButtonElement }[] = [];
  /** 컨텍스트 메뉴의 항목들 (`.cc-imp-mi[data-id]`). */
  private readonly implantBtns = new Map<ImplantId, HTMLButtonElement>();
  /** 지금 고른 임플란트를 보여 주는 큰 타일 + 그 안의 아이콘 · 이름. */
  private readonly implantTile: HTMLButtonElement;
  private readonly implantIcon: HTMLElement;
  private readonly implantName: HTMLElement;
  private readonly implantMenu: HTMLElement;
  private readonly statRows = new Map<StatId, StatRow>();
  private readonly pointsValue: HTMLElement;
  private readonly pointsBox: HTMLElement;
  private readonly confirmBtn: HTMLButtonElement;
  private readonly msg: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly noGl: HTMLElement;
  private preview: SoldierPreview | null = null;
  /** 미리보기는 화면이 처음 열릴 때 만든다 — 타이틀에 서 있는 내내 두 번째 GL 컨텍스트를 쥐고 있지 않게. */
  private previewTried = false;
  /** 임플란트 · 능력치 목록은 `ctx` 가 있어야 이름을 얻으므로 첫 `open()` 에서 채운다. */
  private implantHost: HTMLElement | null = null;
  private statHost: HTMLElement | null = null;

  /** 임플란트 메뉴 바깥을 누르면 닫는다 (커뮤니티 우클릭 메뉴와 같은 규약 — `window` capture). */
  private readonly onDocDownImp = (e: MouseEvent): void => {
    if (this.implantMenu.hidden) return;
    if (e.target instanceof Node && (this.implantMenu.contains(e.target) || this.implantTile.contains(e.target))) return;
    this.closeImplantMenu();
  };
  /** 메뉴가 떠 있는 동안 Escape 는 메뉴만 닫고 아무에게도 가지 않는다 (다른 팝업과 같은 capture 규약). */
  private readonly onKeyImp = (e: KeyboardEvent): void => {
    if (this.implantMenu.hidden) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.closeImplantMenu(); }
  };

  private slot: SlotId = 1;
  private stats: Record<StatId, number> = baseCreateStats();
  private accent: string = DEFAULT_ACCENT;
  private implant: ImplantId = CREATE_IMPLANT_IDS[0];
  /** 사람이 이름을 직접 쳤는가 / 능력치를 손으로 옮겼는가 — 주사위가 경고를 띄울지 정한다. */
  private nameTouched = false;
  private statsTouched = false;
  private _open = false;

  constructor(parent: HTMLElement, private readonly onCancel: () => void) {
    this.root = el('div', { cls: 'title-screen char-create interactive', parent });
    this.root.hidden = true;

    const head = el('div', { cls: 'ts-head', parent: this.root });
    el('div', { cls: 'ts-title', text: '캐릭터 생성', parent: head });
    this.slotTag = el('div', { cls: 'ts-sub', text: '', parent: head });

    const body = el('div', { cls: 'cc-body', parent: this.root });

    /* ── 왼쪽: 캐릭터 설정 ── */
    const form = el('div', { cls: 'cc-panel', parent: body });

    const nameSec = el('div', { cls: 'cc-section', parent: form });
    el('span', { cls: 'ui-label', text: '이름', parent: nameSec });
    const nameRow = el('div', { cls: 'cc-name-row', parent: nameSec });
    this.nameInput = el('input', {
      cls: 'ui-input',
      attrs: {
        type: 'text', placeholder: `최대 ${CHARACTER_NAME_MAX}자까지 입력`, maxlength: String(CHARACTER_NAME_MAX),
        spellcheck: 'false', autocomplete: 'off',
      },
      parent: nameRow,
    });
    // 게임 키(WASD · Tab · Escape)가 `Input` 까지 가지 않게 필드에서 끊는다 (기존 메뉴 입력칸과 같은 규약).
    this.nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Escape') { e.preventDefault(); this.nameInput.blur(); }
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); this.nameInput.blur(); }
    });
    this.nameInput.addEventListener('keyup', (e) => e.stopPropagation());
    this.nameInput.addEventListener('input', () => { this.nameTouched = this.nameInput.value.trim().length > 0; });
    const dice = el('button', { cls: 'ui-btn cc-dice', text: '🎲', attrs: { title: '무작위 호출명' }, parent: nameRow });
    dice.addEventListener('click', (e) => { e.stopPropagation(); this.rollName(); });

    const impSec = el('div', { cls: 'cc-section cc-implant-sec', parent: form });
    el('span', { cls: 'ui-label', text: '시작 임플란트', parent: impSec });
    this.implantHost = el('div', { cls: 'cc-implants', parent: impSec });
    // 큰 타일 하나 — 지금 고른 임플란트. 누르면 오른쪽에 메뉴가 뜬다.
    this.implantTile = el('button', { cls: 'cc-imp-tile', attrs: { title: '시작 임플란트 고르기', 'aria-haspopup': 'menu' }, parent: this.implantHost });
    this.implantIcon = el('span', { cls: 'ico', text: '', parent: this.implantTile });
    this.implantName = el('span', { cls: 'nm', text: '', parent: this.implantTile });
    el('span', { cls: 'caret', text: '▸', parent: this.implantTile });
    this.implantTile.addEventListener('click', (e) => { e.stopPropagation(); this.toggleImplantMenu(); });
    this.implantMenu = el('div', { cls: 'sc-menu cc-imp-menu', attrs: { role: 'menu' }, parent: this.root });
    this.implantMenu.hidden = true;
    this.implantMenu.addEventListener('mousedown', (e) => e.stopPropagation());

    /* ── 가운데: 캐릭터 스탯 (세로 한 줄씩) ── */
    const statsWrap = el('div', { cls: 'cc-stats-wrap', parent: body });
    const statsHead = el('div', { cls: 'cc-stats-head', parent: statsWrap });
    el('span', { cls: 'ui-label', text: '캐릭터 스탯', parent: statsHead });
    const right = el('div', { cls: 'cc-stats-head-right', parent: statsHead });
    this.pointsBox = el('div', { cls: 'cc-points', parent: right });
    el('span', { cls: 'k', text: '남은 점수', parent: this.pointsBox });
    this.pointsValue = el('span', { cls: 'v', text: String(CREATE_STAT_POINTS), parent: this.pointsBox });
    const statDice = el('button', { cls: 'ui-btn cc-dice', text: '🎲', attrs: { title: '능력치 무작위 배분' }, parent: right });
    statDice.addEventListener('click', (e) => { e.stopPropagation(); this.rollStats(); });

    this.statHost = el('div', { cls: 'cc-stat-list', parent: statsWrap });

    /* ── 오른쪽: 3D 미리보기 + 그 아래 악센트 스와치 ── */
    const side = el('div', { cls: 'cc-side', parent: body });
    const preview = el('div', { cls: 'cc-preview', parent: side });
    this.stage = el('div', { cls: 'cc-stage', parent: preview });
    this.noGl = el('div', {
      cls: 'cc-nogl',
      text: '이 브라우저에서는 미리보기를 그릴 수 없습니다 (WebGL 컨텍스트 부족). 캐릭터 생성은 그대로 진행됩니다.',
      parent: this.stage,
    });
    this.noGl.hidden = true;
    const accentSec = el('div', { cls: 'cc-section cc-accent', parent: side });
    el('span', { cls: 'ui-label', text: '악센트 색상', parent: accentSec });
    const swWrap = el('div', { cls: 'cc-swatches', parent: accentSec });
    for (const hex of ACCENT_COLORS) {
      const btn = el('button', { cls: 'cc-sw', attrs: { title: hex, 'aria-label': hex }, parent: swWrap });
      btn.style.setProperty('--sw', hex);
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.setAccent(hex); });
      this.swatches.push({ hex, btn });
    }

    this.msg = el('div', { cls: 'form-msg danger', text: '', parent: this.root });
    this.msg.hidden = true;

    const foot = el('div', { cls: 'ts-foot', parent: this.root });
    const cancel = el('button', { cls: 'ui-btn', text: '취소', parent: foot });
    cancel.addEventListener('click', (e) => { e.stopPropagation(); this.cancel(); });
    this.confirmBtn = el('button', { cls: 'ui-btn primary', text: '확정', parent: foot });
    this.confirmBtn.addEventListener('click', (e) => { e.stopPropagation(); this.askConfirm(); });

    this.ask = new AskPopup(this.root);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ── build ────────────────────────────────────────────────────────────── */

  private implantDefs(): readonly ImplantDef[] {
    const all = this.ctxSafe()?.implants?.getAllDefs?.();
    if (!all) return [];
    return all.filter((d) => (CREATE_IMPLANT_IDS as readonly string[]).includes(d.id));
  }

  /** `bind` 전에도 안전한 ctx 접근. */
  private ctxSafe(): GameContext | null { return (this.ctx as GameContext | undefined) ?? null; }

  /** 임플란트 메뉴 항목은 `ctx.implants` 가 있어야 이름 · 설명이 나오므로 `bind` 뒤에 채운다. */
  private fillImplants(): void {
    const host = this.implantHost;
    if (!host || this.implantBtns.size > 0) return;
    const defs = this.implantDefs();
    if (defs.length === 0) {
      this.implantTile.disabled = true;
      setText(this.implantName, '임플란트 정보 없음');
      return;
    }
    const items = el('div', { cls: 'sc-menu-items', parent: this.implantMenu });
    for (const def of defs) {
      const btn = el('button', { cls: 'sc-mi cc-imp-mi', attrs: { role: 'menuitemradio', 'data-id': def.id }, parent: items });
      btn.style.setProperty('--ic', def.color);
      el('span', { cls: 'ico', text: def.icon, parent: btn });
      const body = el('span', { cls: 'body', parent: btn });
      el('span', { cls: 'nm', text: def.name, parent: body });
      el('span', { cls: 'desc', text: def.description, parent: body });
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.setImplant(def.id); this.closeImplantMenu(); });
      this.implantBtns.set(def.id, btn);
    }
    if (!this.implantBtns.has(this.implant)) this.implant = defs[0].id;
  }

  /** 타일 클릭 — 메뉴를 타일 **오른쪽**에 붙여 띄운다 (화면 밖으로 나가면 안쪽으로 밀어 넣는다). */
  private toggleImplantMenu(): void {
    if (!this.implantMenu.hidden) { this.closeImplantMenu(); return; }
    if (this.implantBtns.size === 0) return;
    this.implantMenu.hidden = false;
    const tile = this.implantTile.getBoundingClientRect();
    const w = this.implantMenu.offsetWidth, h = this.implantMenu.offsetHeight;
    const gap = 8;
    let x = tile.right + gap;
    if (x + w > window.innerWidth - gap) x = Math.max(gap, tile.left - gap - w);   // 오른쪽에 자리가 없으면 왼쪽
    const y = Math.max(gap, Math.min(window.innerHeight - h - gap, tile.top));
    this.implantMenu.style.left = `${Math.round(x)}px`;
    this.implantMenu.style.top = `${Math.round(y)}px`;
    window.addEventListener('mousedown', this.onDocDownImp, true);
    window.addEventListener('keydown', this.onKeyImp, true);
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.implantBtns.get(this.implant)?.focus({ preventScroll: true });
  }

  private closeImplantMenu(): void {
    if (this.implantMenu.hidden) return;
    this.implantMenu.hidden = true;
    window.removeEventListener('mousedown', this.onDocDownImp, true);
    window.removeEventListener('keydown', this.onKeyImp, true);
  }

  private statDefs(): readonly StatDef[] {
    const defs = this.ctxSafe()?.progression?.getAllStatDefs?.();
    if (defs && defs.length > 0) return defs;
    // progression 시스템이 없는 스켈레톤 부팅 — id 만으로라도 다섯 줄을 그린다.
    return STAT_IDS.map((id) => ({ id, name: id, description: '' }));
  }

  private fillStats(): void {
    const host = this.statHost;
    if (!host || this.statRows.size > 0) return;
    for (const def of this.statDefs()) {
      const row = el('div', { cls: 'cc-stat', parent: host });
      const down = el('button', { cls: 'ui-btn step down', text: '◀', attrs: { title: `${def.name} 낮추기` }, parent: row });
      const txt = el('div', { cls: 't', parent: row });
      el('div', { cls: 'n', text: def.name, parent: txt });
      if (def.description) el('div', { cls: 'd', text: def.description, parent: txt });
      const prog = el('div', { cls: 'sp', parent: txt });
      const bar = el('div', { cls: 'bar', parent: prog });
      const fill = el('i', { parent: bar });
      const value = el('div', { cls: 'v', text: String(CREATE_STAT_MIN), parent: row });
      const up = el('button', { cls: 'ui-btn step up', text: '▶', attrs: { title: `${def.name} 올리기` }, parent: row });
      down.addEventListener('click', (e) => { e.stopPropagation(); this.adjust(def.id, -1); });
      up.addEventListener('click', (e) => { e.stopPropagation(); this.adjust(def.id, +1); });
      this.statRows.set(def.id, { root: row, value, fill, down, up });
    }
  }

  /* ── state ────────────────────────────────────────────────────────────── */

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.ask.bind(ctx);
  }

  get isOpen(): boolean { return this._open; }
  /** 지금 그리고 있는 슬롯 (디버그 / 스모크). */
  get targetSlot(): SlotId { return this.slot; }
  /** 지금 배분 상태 (디버그 / 스모크). */
  get draftStats(): Readonly<Record<StatId, number>> { return this.stats; }
  /** 미리보기 캔버스가 살아 있는가 (디버그). */
  get hasPreview(): boolean { return this.preview !== null; }
  /** 지금 고른 시작 임플란트 (디버그 / 스모크). */
  get draftImplant(): ImplantId { return this.implant; }
  /** 임플란트 컨텍스트 메뉴가 떠 있는가 (디버그 / 스모크). */
  get isImplantMenuOpen(): boolean { return !this.implantMenu.hidden; }

  /** `slot` 칸에 새 캐릭터를 만드는 화면을 연다 (상태는 매번 처음부터). */
  open(slot: SlotId): void {
    this.slot = slot;
    this.stats = baseCreateStats();
    this.accent = DEFAULT_ACCENT;
    this.implant = CREATE_IMPLANT_IDS[0];
    this.nameTouched = false;
    this.statsTouched = false;
    this.nameInput.value = '';
    this.msg.hidden = true;
    setText(this.slotTag, `슬롯 ${slot}`);

    this.fillImplants();
    this.fillStats();
    this.root.hidden = false;
    this._open = true;

    if (!this.previewTried) {
      this.previewTried = true;
      this.preview = createSoldierPreview(this.stage);
      this.noGl.hidden = this.preview !== null;
    }
    this.preview?.setVisible(true);
    this.refresh();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.ask.close();
    this.closeImplantMenu();
    this.preview?.setVisible(false);
    this.root.hidden = true;
  }

  /** 프레임마다 (HudSystem → TitleMenu). 닫혀 있으면 미리보기가 스스로 즉시 돌아온다. */
  update(dt: number): void { this.preview?.render(dt); }

  private cancel(): void {
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.close();
    this.onCancel();
  }

  /* ── 선택 ─────────────────────────────────────────────────────────────── */

  private setAccent(hex: string): void {
    this.accent = hex;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  private setImplant(id: ImplantId): void {
    this.implant = id;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  private adjust(id: StatId, delta: number): void {
    if (!canAdjustStat(this.stats, id, delta)) return;
    const next = { ...this.stats } as Record<StatId, number>;
    next[id] = (next[id] ?? CREATE_STAT_MIN) + delta;
    this.stats = next;
    this.statsTouched = true;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  /* ── 주사위 (손으로 넣은 값을 말없이 지우지 않는다) ────────────────────── */

  private rollName(): void {
    const run = (): void => {
      this.nameInput.value = rollCallsign();
      this.nameTouched = false;      // 주사위가 넣은 이름은 "직접 입력" 이 아니다
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    };
    if (this.nameTouched && this.nameInput.value.trim()) {
      this.ask.open({
        title: '이름 다시 뽑기',
        body: '직접 입력한 이름이 사라집니다. 무작위 호출명으로 덮어쓸까요?',
        ok: '덮어쓰기',
        run,
      });
      return;
    }
    run();
  }

  private rollStats(): void {
    const run = (): void => {
      this.stats = rollCreateStats();
      this.statsTouched = false;
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.refresh();
    };
    if (this.statsTouched) {
      this.ask.open({
        title: '능력치 다시 뽑기',
        body: '직접 배분한 능력치가 사라집니다. 무작위 배분으로 덮어쓸까요?',
        ok: '덮어쓰기',
        run,
      });
      return;
    }
    run();
  }

  /* ── 확정 ─────────────────────────────────────────────────────────────── */

  private askConfirm(): void {
    this.closeImplantMenu();
    const left = statPointsLeft(this.stats);
    if (left > 0) {
      // 버튼은 이미 disabled 지만 키보드 · 스모크가 우회할 수 있다 — 안내만 하고 아무것도 만들지 않는다.
      this.ask.open({
        title: '능력치 배분 미완료',
        body: `남은 점수 ${left}점을 모두 배분해야 캐릭터를 만들 수 있습니다.`,
        ok: '확인',
        run: () => {},
      });
      return;
    }
    const name = sanitizeCharacterName(this.nameInput.value);
    const lines = this.statDefs().map((d) => `${d.name} ${this.stats[d.id]}`).join(' · ');
    this.ask.open({
      title: '캐릭터 확정',
      body: `이름  ${name}\n능력치  ${lines}\n\n정말로 만들겠습니까?`,
      ok: '만들기',
      run: () => this.create(name),
    });
  }

  private create(name: string): void {
    const slot = this.slot;
    // 빈 칸에서만 열리므로 보통 비어 있지만, 계약대로 부르는 쪽이 먼저 치운다.
    deleteSlot(slot);
    const profile = createCharacterInSlot(slot, {
      name, stats: this.stats, accent: this.accent, implant: this.implant,
    });
    if (!profile) {
      this.refresh();
      setText(this.msg, '저장소에 쓸 수 없어 캐릭터를 만들지 못했습니다 — 브라우저의 사이트 데이터 차단 · 시크릿 모드를 확인하세요.');
      this.msg.hidden = false;
      return;
    }
    this.confirmBtn.disabled = true;
    // 시스템은 부팅 때 한 번 저장소를 읽는다 — 새 캐릭터로 들어가는 길은 새로고침뿐이다.
    setActiveSlot(slot);
    markAutoStart();
    window.location.reload();
  }

  /* ── render ───────────────────────────────────────────────────────────── */

  private refresh(): void {
    for (const s of this.swatches) toggleClass(s.btn, 'is-on', s.hex === this.accent);
    for (const [id, btn] of this.implantBtns) {
      const on = id === this.implant;
      toggleClass(btn, 'is-on', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    const cur = this.implantDefs().find((d) => d.id === this.implant);
    if (cur) {
      this.implantTile.style.setProperty('--ic', cur.color);
      this.implantTile.dataset.id = cur.id;
      setText(this.implantIcon, cur.icon);
      setText(this.implantName, cur.name);
      this.implantTile.title = cur.description || '시작 임플란트 고르기';
    }
    this.preview?.setAccent(this.accent);

    const left = statPointsLeft(this.stats);
    setText(this.pointsValue, String(left));
    toggleClass(this.pointsBox, 'spent', left <= 0);
    // 점수가 남아 있으면 만들 수 없다 — 버튼이 스스로 말한다.
    this.confirmBtn.disabled = left > 0;
    this.confirmBtn.title = left > 0 ? '남은 점수를 모두 배분하세요' : '';
    for (const [id, row] of this.statRows) {
      const v = this.stats[id] ?? CREATE_STAT_MIN;
      setText(row.value, String(v));
      const span = Math.max(1, CREATE_STAT_MAX - CREATE_STAT_MIN);
      row.fill.style.transform = `scaleX(${((v - CREATE_STAT_MIN) / span).toFixed(4)})`;
      toggleClass(row.root, 'maxed', v >= CREATE_STAT_MAX);
      row.down.disabled = !canAdjustStat(this.stats, id, -1);
      row.up.disabled = !canAdjustStat(this.stats, id, +1);
    }
  }

  dispose(): void {
    this.close();
    this.implantMenu.remove();
    this.preview?.dispose();
    this.preview = null;
    this.ask.dispose();
    this.root.remove();
  }
}
