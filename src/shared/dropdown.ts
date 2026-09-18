/**
 * **The shared dropdown** (2026-09-16 user's decision) — it replaces every native `<select>` in the game.
 *
 * A native list is **drawn by the OS**: its font · corners · accent colour · scrollbar play apart from the game UI, and
 * while one value is picked it looks as if a browser window had opened off-screen. So we draw the list too.
 *
 * The three reasons native was chosen (the old comment in `inventory/ui/GridTools.ts`) are paid back here like this:
 *
 *  ① **Clipping** — the list is drawn on a `position: fixed` layer directly under `document.body`, not next to the
 *     trigger. The `overflow` of a scroll box (`.tg-gridwrap` · `.inv-stash-scroll`) does not reach it. Its place is
 *     measured with `getBoundingClientRect` on open, and flips above when there is little room below. On a scroll ·
 *     resize it **closes instead of measuring again** (a list that follows has to measure its place every frame, and at
 *     that price the user has already lost the list).
 *  ② **An outside click** — while open it listens to `pointerdown` on `window` in the capture phase. Outside the list ·
 *     the trigger it closes. That event is **not swallowed** — the screen behind reacting to the press is better than
 *     「close and press again」.
 *  ③ **Escape** — it is taken in the capture phase with `stopPropagation` + `preventDefault` (「the innermost popup
 *     swallows Escape」). So the Escape that closes the list does not close the inventory window too. It is not pushed
 *     onto the `ctx.escape` stack — that stack is per *screen*, and this list is a popup that opens and closes within one frame.
 *
 * Keyboard: ↑ ↓ move, Enter · Space pick, Escape closes. The trigger is `role="combobox"`, the list `role="listbox"`.
 *
 * Markup (styled by `.dd-*` in `src/ui/styles/base.css`):
 *
 *   div.dd                      ← the shell the caller attaches (an inline block)
 *     button.dd-trigger           ← the current value + ▾
 *       span.dd-value
 *   div.dd-pop                  ← directly under body, exists only while open
 *     button.dd-opt[.is-sel]      ← one option
 */

/** One dropdown option. `icon` is a glyph put in front of the name (it may be absent). */
export interface DropdownOption<T extends string = string> {
  value: T;
  label: string;
  icon?: string;
  /** An option that cannot be picked (drawn dim and does not take clicks). */
  disabled?: boolean;
}

export interface DropdownOpts<T extends string = string> {
  options: readonly DropdownOption<T>[];
  /** The initially picked value. With none, the first option. */
  value?: T;
  /** The trigger's `title` · `aria-label`. */
  label?: string;
  /** Extra classes for the shell (the caller's style hook — `.dd` is always on it). */
  className?: string;
  /** The list's minimum width (px). Defaults to the trigger's width. */
  minWidth?: number;
  onPick(value: T): void;
}

export interface DropdownControl<T extends string = string> {
  readonly el: HTMLElement;
  /** Changes the display only (it does not call `onPick`). */
  set(value: T): void;
  /** The current value. */
  get(): T;
  /** Replaces the options wholesale (closes if open). */
  setOptions(options: readonly DropdownOption<T>[], value?: T): void;
  /** Closes if open — called when the screen goes away. */
  close(): void;
  /** Clears the listeners · the floating list as well. */
  dispose(): void;
}

/** The margin (px) the list must keep from the edge of the screen. */
const EDGE_PAD = 8;

/** The flip judgement — with less height left below than this, it opens above the trigger. */
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
  /** The option the keyboard points at while open (separate from mouse hover). */
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
    // It must be attached before its height can be measured — called after `open` appended it to body.
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
      // 「the innermost popup swallows Escape」 — this Escape must not close the inventory window too.
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
    // A scroll · resize is not followed; it closes instead (comment ① above).
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
