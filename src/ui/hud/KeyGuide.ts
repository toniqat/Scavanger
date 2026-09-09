import type { GameContext, KeyGuideEntry } from '@/shared';
import { Keys, keyLabel } from '@/shared';
import { el, toggleClass } from '../dom';

interface Owner { owner: string; keys: ReadonlyArray<KeyGuideEntry> }

/**
 * 키 가이드 (2026-09-09) — one line in the bottom-right corner, `R 회전 · X 버리기 · Tab 닫기`, for whichever screen or
 * mode is on top. Consumes `ui:keyGuide {owner, keys}`: an owner with keys is pushed onto a stack in open order (or
 * updated in place when it re-emits, e.g. on `input:bindingsChanged`), `keys: null` pops it; the **topmost** owner is
 * rendered, so a popup opened over a screen wins and the screen's keys return when it closes.
 *
 * **The guide appends the close entry itself** — always the last item, because Tab closes every screen (decision
 * 2026-09-09) and owners never list it. Since 2026-09-09 그 항목은 keycap 이 **둘**이다: `keyLabel(Keys.INVENTORY)`
 * 다음에 `keyLabel(Keys.MENU)` — ESC 도 맨 위 화면 하나를 닫으므로(`game/escapeKey`) 가이드가 두 키를 함께
 * 보여 준다. 첫 keycap 은 Tab 으로 남는다 (튜토리얼 · 스모크가 그 첫 `.keycap` 을 읽는다). Re-rendered on `input:bindingsChanged`.
 * That last item also carries the class `kg-close` (2026-09-09) so it can be pointed at on its own — the tutorial's
 * 함선 관리 닫기 step spotlights `.key-guide .kg-close`.
 *
 * **꾹 누르기 (2026-09-09):** an entry with `hold: true` renders its keycap as `.keycap.kc-hold` — the shared
 * stylesheet rule draws a bold accent **⌄ chevron above the keycap** (`.keycap.kc-hold::before`, the same one
 * `hud/InteractionPrompt` uses for a hold interactable), so 탑승 · 1초 홀드 keys read as "hold" at HUD size without a
 * word of text. (2026-09-10: the modifier was renamed from `.hold`, which collided with the 홀드 링 widget class.)
 *
 * DOM: `.key-guide(.show)` > `.kg-item` (`.keycap` + `.kg-label`) separated by `.kg-sep` (`·`). A direct child of
 * `ctx.uiRoot` (z 84) so it floats over the inventory window, the hub terminal, the 시설 관리 panel and the map in
 * both hub and gameplay phases. Hidden while the stack is empty, while the ESC 일시정지 메뉴 is up (`'menu'` blocker,
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
    const entries: KeyGuideEntry[] = top ? [...top.keys, { key: keyLabel(Keys.INVENTORY), label: '닫기' }] : [];
    // 2026-09-09: the 닫기 item names **two** keys (Tab · ESC), so a rebound Escape must re-render as well.
    const key = `${entries.map((e) => `${e.key}${e.hold ? '⌄' : ''} ${e.label}`).join('')}${keyLabel(Keys.MENU)}`;
    if (key !== this.renderKey) {
      this.renderKey = key;
      this.rendered = entries;
      this.root.replaceChildren();
      entries.forEach((e, i) => {
        if (i) el('span', { cls: 'kg-sep', text: '·', parent: this.root });
        // 2026-09-09: the appended 닫기 (always last) carries `kg-close` so something can point at just the close
        // key — the tutorial's 함선 관리 닫기 step spotlights `.key-guide .kg-close`.
        const close = i === entries.length - 1;
        const item = el('span', { cls: close ? 'kg-item kg-close' : 'kg-item', parent: this.root });
        // 2026-09-09: `hold: true` → `.keycap.kc-hold` (the ⌄ chevron above the cap lives in the stylesheet, once).
        el('span', { cls: e.hold ? 'keycap kc-hold' : 'keycap', text: e.key, parent: item });
        // 2026-09-09: **ESC 도 화면을 닫는다** (`game/escapeKey` — 열린 순서의 역순으로 맨 위 하나), so the 닫기
        // item carries a second keycap. Tab stays the first one: it is the key every screen has always closed on,
        // and the tutorial / smokes read that first `.keycap`.
        if (close) el('span', { cls: 'keycap', text: keyLabel(Keys.MENU), parent: item });
        el('span', { cls: 'kg-label', text: e.label, parent: item });
      });
    }
    this.apply();
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
