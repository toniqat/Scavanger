/**
 * **공용 드롭다운** (2026-09-16 사용자 결정) — 게임 안의 네이티브 `<select>` 를 전부 대신한다.
 *
 * 네이티브 목록은 **OS 가 그린다**: 폰트 · 모서리 · 강조색 · 스크롤바가 게임 UI 와 따로 놀고, 값 하나 고르는 동안
 * 화면 밖에 브라우저 창이 하나 뜬 것처럼 보인다. 그래서 목록까지 우리가 그린다.
 *
 * 네이티브를 골랐던 이유 셋(`inventory/ui/GridTools.ts` 옛 주석)은 여기서 이렇게 갚는다:
 *
 *  ① **잘림** — 목록은 트리거 옆이 아니라 `document.body` 바로 아래 `position: fixed` 레이어에 그린다. 스크롤 상자
 *     (`.tg-gridwrap` · `.inv-stash-scroll`)의 `overflow` 가 닿지 않는다. 자리는 열 때 `getBoundingClientRect` 로
 *     재고, 아래가 좁으면 위로 뒤집는다. 스크롤 · 리사이즈가 나면 **다시 재지 않고 닫는다** (따라다니는 목록은
 *     프레임마다 자리를 재야 하고, 그 값이면 사용자는 이미 목록을 놓친 것이다).
 *  ② **바깥 클릭** — 열려 있는 동안 `window` 의 캡처 단계 `pointerdown` 을 듣는다. 목록 · 트리거 밖이면 닫는다.
 *     그 이벤트는 **삼키지 않는다** — 뒤 화면이 눌린 대로 반응하는 편이 「닫고 다시 누르기」보다 낫다.
 *  ③ **Escape** — 캡처 단계에서 먹고 `stopPropagation` + `preventDefault` 한다 (「가장 안쪽 팝업이 Escape 를 삼킨다」).
 *     그래서 목록을 닫는 Escape 가 인벤토리 창까지 닫지 않는다. `ctx.escape` 스택에는 올리지 않는다 — 스택은 *화면*
 *     단위이고, 이 목록은 한 프레임 안에서 열리고 닫히는 팝업이다.
 *
 * 키보드: ↑ ↓ 로 옮기고 Enter · Space 로 고르고 Escape 로 닫는다. 트리거는 `role="combobox"`, 목록은 `role="listbox"`.
 *
 * 마크업 (스타일은 `src/ui/styles/base.css` 의 `.dd-*`):
 *
 *   div.dd                      ← 부른 쪽이 붙이는 껍데기 (인라인 블록)
 *     button.dd-trigger           ← 현재 값 + ▾
 *       span.dd-value
 *   div.dd-pop                  ← body 바로 아래, 열렸을 때만 존재
 *     button.dd-opt[.is-sel]      ← 항목 하나
 */

/** 드롭다운 항목 하나. `icon` 은 이름 앞에 붙는 글리프(없어도 된다). */
export interface DropdownOption<T extends string = string> {
  value: T;
  label: string;
  icon?: string;
  /** 고를 수 없는 항목 (흐리게 그리고 클릭을 먹지 않는다). */
  disabled?: boolean;
}

export interface DropdownOpts<T extends string = string> {
  options: readonly DropdownOption<T>[];
  /** 처음 고른 값. 없으면 첫 항목. */
  value?: T;
  /** 트리거의 `title` · `aria-label`. */
  label?: string;
  /** 껍데기에 더 붙일 클래스 (부른 쪽 스타일 갈고리 — `.dd` 는 언제나 붙는다). */
  className?: string;
  /** 목록 최소 너비(px). 기본은 트리거 너비. */
  minWidth?: number;
  onPick(value: T): void;
}

export interface DropdownControl<T extends string = string> {
  readonly el: HTMLElement;
  /** 표시만 바꾼다 (`onPick` 을 부르지 않는다). */
  set(value: T): void;
  /** 현재 값. */
  get(): T;
  /** 항목을 통째로 갈아 끼운다 (열려 있으면 닫는다). */
  setOptions(options: readonly DropdownOption<T>[], value?: T): void;
  /** 열려 있으면 닫는다 — 화면이 사라질 때 부른다. */
  close(): void;
  /** 리스너 · 떠 있는 목록까지 치운다. */
  dispose(): void;
}

/** 목록이 화면 가장자리에서 떨어져 있어야 하는 여백(px). */
const EDGE_PAD = 8;

/** 뒤집기 판정 — 아래 남은 높이가 이보다 좁으면 트리거 위로 연다. */
const MIN_BELOW = 120;

export function buildDropdown<T extends string = string>(opts: DropdownOpts<T>): DropdownControl<T> {
  let options = opts.options.slice();
  let value = (opts.value ?? options[0]?.value ?? '') as T;

  const el = document.createElement('div');
  el.className = opts.className ? `dd ${opts.className}` : 'dd';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dd-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-expanded', 'false');
  if (opts.label) { trigger.title = opts.label; trigger.setAttribute('aria-label', opts.label); }
  const valueEl = document.createElement('span');
  valueEl.className = 'dd-value';
  trigger.appendChild(valueEl);
  el.appendChild(trigger);

  let pop: HTMLElement | null = null;
  /** 열려 있는 동안 키보드가 짚고 있는 항목 (마우스 hover 와 별개). */
  let cursor = 0;

  const textOf = (o: DropdownOption<T> | undefined): string =>
    !o ? '' : o.icon ? `${o.icon} ${o.label}` : o.label;

  const paint = (): void => {
    valueEl.textContent = textOf(options.find((o) => o.value === value)) || '—';
  };

  const place = (): void => {
    if (!pop) return;
    const r = trigger.getBoundingClientRect();
    const w = Math.max(opts.minWidth ?? 0, r.width);
    pop.style.minWidth = `${Math.round(w)}px`;
    // 높이를 재려면 먼저 붙어 있어야 한다 — `open` 이 body 에 붙인 뒤에 부른다.
    const h = pop.offsetHeight;
    const below = window.innerHeight - r.bottom - EDGE_PAD;
    const up = below < Math.min(h, MIN_BELOW) && r.top > below;
    const top = up ? Math.max(EDGE_PAD, r.top - h - 2) : r.bottom + 2;
    const left = Math.min(Math.max(EDGE_PAD, r.left), Math.max(EDGE_PAD, window.innerWidth - w - EDGE_PAD));
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.maxHeight = `${Math.round(Math.max(MIN_BELOW, (up ? r.top : window.innerHeight - r.bottom) - EDGE_PAD * 2))}px`;
    pop.classList.toggle('dd-up', up);
  };

  const highlight = (): void => {
    if (!pop) return;
    const kids = pop.querySelectorAll('.dd-opt');
    kids.forEach((k, i) => k.classList.toggle('is-cursor', i === cursor));
    (kids[cursor] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  };

  function onOutside(e: PointerEvent): void {
    const t = e.target as Node | null;
    if (t && (el.contains(t) || pop?.contains(t))) return;
    close();
  }

  function onKey(e: KeyboardEvent): void {
    if (!pop) return;
    if (e.key === 'Escape') {
      // 「가장 안쪽 팝업이 Escape 를 삼킨다」 — 이 Escape 가 인벤토리 창까지 닫으면 안 된다.
      e.preventDefault(); e.stopPropagation();
      close(); trigger.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      for (let i = 0; i < options.length; i++) {
        cursor = (cursor + step + options.length) % options.length;
        if (!options[cursor]?.disabled) break;
      }
      highlight();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation();
      const o = options[cursor];
      if (o) pick(o.value);
      return;
    }
    if (e.key === 'Tab') close();
  }

  function close(): void {
    if (!pop) return;
    pop.remove();
    pop = null;
    trigger.setAttribute('aria-expanded', 'false');
    el.classList.remove('is-open');
    window.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close);
  }

  function pick(v: T): void {
    const o = options.find((x) => x.value === v);
    if (!o || o.disabled) return;
    close();
    if (v === value) return;
    value = v;
    paint();
    opts.onPick(v);
  }

  const open = (): void => {
    if (pop) { close(); return; }
    const box = document.createElement('div');
    pop = box;
    box.className = 'dd-pop';
    box.setAttribute('role', 'listbox');
    options.forEach((o, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dd-opt';
      b.setAttribute('role', 'option');
      b.textContent = textOf(o);
      if (o.value === value) { b.classList.add('is-sel'); b.setAttribute('aria-selected', 'true'); }
      if (o.disabled) b.disabled = true;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => { e.stopPropagation(); pick(o.value); });
      b.addEventListener('pointerenter', () => { cursor = i; highlight(); });
      box.appendChild(b);
    });
    document.body.appendChild(box);
    cursor = Math.max(0, options.findIndex((o) => o.value === value));
    place();
    highlight();
    trigger.setAttribute('aria-expanded', 'true');
    el.classList.add('is-open');
    window.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('keydown', onKey, true);
    // 스크롤 · 리사이즈는 따라가지 않고 닫는다 (위 주석 ①).
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
  };

  trigger.addEventListener('pointerdown', (e) => e.stopPropagation());
  trigger.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  paint();

  return {
    el,
    set(v) { if (v === value) return; value = v; paint(); },
    get: () => value,
    setOptions(next, v) {
      close();
      options = next.slice();
      if (v !== undefined) value = v;
      if (!options.some((o) => o.value === value)) value = (options[0]?.value ?? '') as T;
      paint();
    },
    close,
    dispose() { close(); el.remove(); },
  };
}
