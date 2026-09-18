import type { GameContext, KeyGuideEntry } from '@/shared';
import { Keys, createKeycap, keyLabel } from '@/shared';
import { el, toggleClass } from '../dom';

interface Owner { owner: string; keys: ReadonlyArray<KeyGuideEntry> }

/**
 * 2026-09-13: owners that are **not screens** — nothing closes them with Tab / Esc, so the guide does not append the
 * `닫기` entry. `'rover'` = while riding the rover (`hud/RoverHud` — `M 목적지 선택`).
 */
const NO_CLOSE_OWNERS: ReadonlySet<string> = new Set(['rover', 'pod']);   // `'pod'` (2026-09-14) = while in a launch slot (`hub/ui/ReadyPanel` — `E 내리기` · `Space 준비`)

/**
 * The key guide (2026-09-09) — one line in the bottom-right corner, `R 회전 · X 버리기 · Tab 닫기`, for whichever screen or
 * mode is on top. Consumes `ui:keyGuide {owner, keys}`: an owner with keys is pushed onto a stack in open order (or
 * updated in place when it re-emits, e.g. on `input:bindingsChanged`), `keys: null` pops it; the **topmost** owner is
 * rendered, so a popup opened over a screen wins and the screen's keys return when it closes.
 *
 * **The guide appends the close entry itself** — always the last item, because Tab closes every screen (decision
 * 2026-09-09) and owners never list it. Since 2026-09-09 that item carries **two** keycaps: `keyLabel(Keys.INVENTORY)`
 * followed by `keyLabel(Keys.MENU)` — ESC closes the topmost screen too (`game/escapeKey`), so the guide shows the two
 * keys together. The first keycap stays Tab (the tutorial and the smokes read that first `.keycap`). Re-rendered on `input:bindingsChanged`.
 * That last item also carries the class `kg-close` (2026-09-09) so it can be pointed at on its own — the tutorial's
 * `함선 관리 닫기` step spotlights `.key-guide .kg-close`.
 *
 * **Hold (2026-09-09):** an entry with `hold: true` renders its keycap as `.keycap.kc-hold` — the shared
 * stylesheet rule draws an accent **⌄ chevron** (`.keycap.kc-hold::before`, the same one
 * `hud/InteractionPrompt` uses for a hold interactable), so boarding · 1 s hold keys read as "hold" at HUD size without
 * a word of text. (2026-09-10: the modifier was renamed from `.hold`, which collided with the hold ring widget class.)
 * **2026-09-15:** every cap goes through `shared/keycap.createKeycap` — a `LMB` / `MMB` / `RMB` label becomes the mouse
 * glyph (pressed button white, accent + chevron when held), and the chevron now sits **inside** the cap's top edge, so
 * the guide no longer grows `padding-top` for a hold key.
 *
 * DOM: `.key-guide(.show)` > `.kg-panel` > `.kg-item` (`.keycap` + `.kg-label`) separated by `.kg-sep` (a thin vertical
 * line, 2026-09-16 — was a `·`). **2026-09-16 (user's decision):** the appended `닫기` sits in its **own** panel to the right
 * (`.kg-panel.kg-panel-close` > `.kg-item.kg-close`) — every screen, not just the inventory, so the close keys always
 * read apart from the screen's action keys; an owner with no keys shows the close panel alone. A direct child of
 * `ctx.uiRoot` (z 84) so it floats over the inventory window, the hub terminal, the ship management panel and the map
 * in both hub and gameplay phases. Hidden while the stack is empty, while the ESC pause menu is up (`'menu'` blocker,
 * polled in `update`) and while the chat input is open (`ui:chatToggled` — the chat carries its own close hint).
 * The stack is cleared on `game:newMission` / `game:abort`.
 */
export class KeyGuide {
  readonly root: HTMLElement;
  private ctx: GameContext | null = null;
  private stack: Owner[] = [];
  private shown = false;
  private chatOpen = false;
  private rendered: KeyGuideEntry[] = [];
  private renderKey = '';
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'key-guide', parent });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('ui:keyGuide', ({ owner, keys }) => this.set(owner, keys)),
      b.on('input:bindingsChanged', () => this.render()),
      b.on('ui:chatToggled', ({ open }) => { this.chatOpen = open; this.apply(); }),
      b.on('game:newMission', () => this.clear()),
      b.on('game:abort', () => this.clear()),
    );
  }

  /** Owner whose keys are showing (top of the stack), null when nothing is open (debug). */
  get owner(): string | null { return this.stack.length ? this.stack[this.stack.length - 1].owner : null; }
  /** Entries as rendered — the owner's keys plus the appended `닫기` (debug). */
  get entries(): readonly KeyGuideEntry[] { return this.rendered; }
  /** Every owner on the stack, bottom → top (debug). */
  get owners(): readonly string[] { return this.stack.map((o) => o.owner); }
  get isShowing(): boolean { return this.shown; }

  /** Per frame: the only thing polled is the `'menu'` blocker (one Set lookup). */
  update(): void { this.apply(); }

  private set(owner: string, keys: ReadonlyArray<KeyGuideEntry> | null): void {
    const i = this.stack.findIndex((o) => o.owner === owner);
    if (keys === null) { if (i >= 0) this.stack.splice(i, 1); }
    else if (i >= 0) this.stack[i].keys = keys;       // re-emit: keep its place in the open order
    else this.stack.push({ owner, keys });
    this.render();
  }

  private clear(): void {
    if (!this.stack.length) return;
    this.stack = [];
    this.render();
  }

  private render(): void {
    const top = this.stack.length ? this.stack[this.stack.length - 1] : null;
    // 2026-09-09: **ESC closes a screen too** (`game/escapeKey`), so the `닫기` item names two keys. 2026-09-12: they are
    // the same action on different keys, so the second one rides `alt` and reads `Tab 또는 Esc`. Tab stays the first
    // keycap — the tutorial and the smokes read that first `.keycap`.
    // 2026-09-13 (user's decision): the map also closes on the key that opened it, so its `닫기` reads `Tab 또는 Esc 또는 M`.
    const noClose = top !== null && NO_CLOSE_OWNERS.has(top.owner);
    const closeAlt = top?.owner === 'map' ? [{ key: keyLabel(Keys.MENU) }, { key: keyLabel(Keys.MAP) }] : [{ key: keyLabel(Keys.MENU) }];
    const entries: KeyGuideEntry[] = top
      ? noClose ? [...top.keys] : [...top.keys, { key: keyLabel(Keys.INVENTORY), label: '닫기', alt: closeAlt }]
      : [];
    const key = entries.map((e) => `${e.key}${e.hold ? '⌄' : ''}${(e.combo ?? []).map((c) => `+${c}`).join('')}`
      + `${(e.alt ?? []).map((a) => `|${a.key}${a.hold ? '⌄' : ''}`).join('')} ${e.label}`).join('');
    if (key !== this.renderKey) {
      this.renderKey = key;
      this.rendered = entries;
      this.root.replaceChildren();
      // 2026-09-16 (user's decision): the screen's action-key panel | the close panel — two boxes. With no action keys, only the close panel.
      let panel: HTMLElement | null = null;
      entries.forEach((e, i) => {
        // 2026-09-09: the appended `닫기` (always last) carries `kg-close` so something can point at just the close
        // key — the tutorial's `함선 관리 닫기` step spotlights `.key-guide .kg-close`.
        const close = !noClose && i === entries.length - 1;
        if (close) panel = el('div', { cls: 'kg-panel kg-panel-close', parent: this.root });
        else if (!panel) panel = el('div', { cls: 'kg-panel', parent: this.root });
        // 2026-09-16 (user's decision): items are separated by a thin vertical bar, not a middle dot (`.kg-sep` is an empty span, CSS draws the line)
        else el('span', { cls: 'kg-sep', parent: panel });
        const item = el('span', { cls: close ? 'kg-item kg-close' : 'kg-item', parent: panel });
        // 2026-09-09: `hold: true` → `.keycap.kc-hold` (the ⌄ chevron above the cap lives in the stylesheet, once).
        this.cap(item, e.key, e.hold);
        // 2026-09-12 (user's decision): keys pressed **together** are joined by a small `+`, keys that do the **same**
        // action by a small `또는`. Combo first (it belongs to the primary key), then the alternatives.
        for (const c of e.combo ?? []) { el('span', { cls: 'kg-plus', text: '+', parent: item }); this.cap(item, c, false); }
        for (const a of e.alt ?? []) { el('span', { cls: 'kg-or', text: '또는', parent: item }); this.cap(item, a.key, a.hold); }
        el('span', { cls: 'kg-label', text: e.label, parent: item });
      });
    }
    this.apply();
  }

  /** 2026-09-15: the shared `createKeycap` — a `LMB` · `MMB` · `RMB` label becomes the mouse glyph, `hold` adds the chevron (one path). */
  private cap(parent: HTMLElement, text: string, hold: boolean | undefined): void {
    createKeycap(text, { hold: hold === true, parent });
  }

  private apply(): void {
    const menu = this.ctx?.uiBlockers.has('menu') ?? false;
    const on = this.stack.length > 0 && !this.chatOpen && !menu;
    if (on === this.shown) return;
    this.shown = on;
    toggleClass(this.root, 'show', on);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }
}
