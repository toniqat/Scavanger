import type { GadgetId, GameContext } from '@/shared';
import { Keys, droneKindOfGadget, keyLabel, paintKeycap } from '@/shared';
import { el, setText } from '../dom';
import '../styles/gadgetHint.css';

/** How many notice rows show at once — place + detonate, or one drone row. */
const MAX_ROWS = 2;

type Tone = 'ok' | 'bad' | 'det' | 'info';

/** `code` = the key code of that row's keycap (`KeyboardEvent.code` / `MouseN`, 2026-09-15 — the code is held, not the label, and the shared keycap paints it). */
interface Row { el: HTMLElement; pre: HTMLElement; key: HTMLElement; txt: HTMLElement; sig: string; code: string }

/**
 * **Held gadget notice** (`.gadget-hand-hint`, gameplay layer, under the crosshair, 2026-09-11).
 *
 * One row = keycap + text. At most two rows, stacking only whichever of the three apply:
 *   - **Placement preview** — `gadget:placementChanged {gadget, valid, reason, mount}` (gadgets emits it only on a change).
 *     With a `ctx.gadgets.placement` that live value is read first (right even when a late registration missed the event).
 *     valid → `[좌클릭] 설치` (`드론에 탑재` when there is a mount), invalid → the `reason` in red (`설치 불가` with none).
 *     The judgement is never imitated — only the result of the **same** judgement gadgets uses on LMB is copied here.
 *   - **Remote mine detonation** — when the item in hand (`ctx.weapons.remoteState.heldItemId` → `ItemDef.gadgetId`) or
 *     the preview gadget is `remoteMine` (C4 · the detonator hand after placing the last one) and
 *     `liveRemoteMineCount() > 0`: `[우클릭] 기폭 (n)`. In the **detonator hand** (the slotless hand after the last C4 —
 *     `heldItemId` is still the C4 def, `remoteState.detonator === true`, `quick:equipped`'s uid starts with `detonator:`)
 *     no placement row is drawn, only `기폭기 · [우클릭] 기폭 (n)` (`기폭기 · 설치된 원격 지뢰 없음` at 0).
 *   - **Drone** — when the gadget in hand is a `droneKindOfGadget`: with no own drone `[좌클릭] 드론 배치`, with one in
 *     range `[R ˅] 꾹 조종` (`.keycap.kc-hold` — the shared chevron), on `linkLost` a red `신호 범위 밖`.
 *
 * Mouse keys are written as `좌클릭` · `우클릭` (`FIRE` · `AIM` are mouse-only actions but the button can change, so
 * `Keys.X` is read every frame). **2026-09-15 (user's decision):** they are drawn with the **mouse glyph** of the shared
 * keycap (`shared/keycap.paintKeycap`) instead of text — the button to press in white; for a hold like `R 꾹 조종` the
 * chevron sits on the **inside** top edge of the cap, so the row does not lift by that much (the `:has(.kc-hold)` margin
 * in `gadgetHint.css` was deleted). `lines` writes the key label (`LMB` …). **It hides while a drone is controlled
 * (`ctx.player.droneControl`) · a screen is open · on death · outside the phase.** Values are polled every frame, but the
 * DOM is written only when a row's signature (key · text · colour · hold) changes.
 */
export class GadgetHandHint {
  readonly root: HTMLElement;
  private rows: Row[] = [];
  private evGadget: GadgetId | null = null;
  private evValid = false;
  private evReason: string | null = null;
  private evMount: string | null = null;
  private shown = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'gadget-hand-hint', parent });
    for (let i = 0; i < MAX_ROWS; i++) {
      const row = el('div', { cls: 'ghh-row', parent: this.root });
      row.hidden = true;
      const pre = el('span', { cls: 'pre', parent: row });
      pre.hidden = true;
      const key = el('span', { cls: 'keycap', parent: row });
      const txt = el('span', { cls: 'txt', parent: row });
      this.rows.push({ el: row, pre, key, txt, sig: '', code: '' });
    }
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    const clear = (): void => { this.evGadget = null; this.evValid = false; this.evReason = null; this.evMount = null; };
    this.unsubs.push(
      b.on('gadget:placementChanged', ({ gadget, valid, reason, mount }) => {
        this.evGadget = gadget; this.evValid = valid; this.evReason = reason; this.evMount = mount;
      }),
      b.on('game:abort', clear),
      b.on('game:newMission', clear),
    );
  }

  update(_dt: number, ctx: GameContext): void {
    let n = 0;
    const p = ctx.player;
    const on = ctx.isGameplayActive() && !!p && !p.isDead && !(p.droneControl ?? false) && !(p.roverRide ?? false) && ctx.uiBlockers.size === 0;
    if (on) {
      const held = this.heldGadget(ctx);
      // The detonator hand: the slotless hand after the last C4 was placed. `heldItemId` is still the C4 def and weapons turns `detonator` on.
      const detonator = (ctx.weapons?.remoteState as { detonator?: boolean } | undefined)?.detonator === true;

      // (1) placement preview — the live value when there is one, else the last event. The detonator hand has none.
      const live = ctx.gadgets?.placement;
      const pGadget = detonator ? null : live !== undefined ? (live?.gadget ?? null) : this.evGadget;
      if (pGadget) {
        const valid = live !== undefined ? live!.valid : this.evValid;
        const reason = live !== undefined ? live!.reason : this.evReason;
        const mount = live !== undefined ? live!.mount : this.evMount;
        if (valid) n = this.setRow(n, null, Keys.FIRE, mount ? '드론에 탑재' : '설치', 'ok', false);
        else n = this.setRow(n, null, null, reason || '설치 불가', 'bad', false);
      }

      // (2) remote mine detonation — C4 in hand or the detonator hand
      if (detonator || held === 'remoteMine' || pGadget === 'remoteMine') {
        const count = ctx.gadgets?.liveRemoteMineCount?.() ?? 0;
        const pre = detonator ? '기폭기 ·' : null;
        if (count > 0) n = this.setRow(n, pre, Keys.AIM, `기폭 (${count})`, 'det', false);
        else if (detonator) n = this.setRow(n, '기폭기 ·', null, '설치된 원격 지뢰 없음', 'info', false);
      }

      // (3) a drone item = the controller
      const kind = droneKindOfGadget(held);
      if (kind) {
        const own = ctx.drones?.getOwnDrone(kind) ?? null;
        if (!own) n = this.setRow(n, null, Keys.FIRE, '드론 배치', 'info', false);
        else if (own.linkLost) n = this.setRow(n, null, null, '신호 범위 밖', 'bad', false);
        else n = this.setRow(n, null, Keys.RELOAD, '꾹 조종', 'ok', true);
      }
    }
    for (let i = n; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (!r.el.hidden) { r.el.hidden = true; r.sig = ''; }
    }
    this.shown = n;
  }

  /** The id when the consumable in hand is a gadget. null with a gun in hand or a non-gadget. */
  private heldGadget(ctx: GameContext): GadgetId | null {
    const id = ctx.weapons?.remoteState?.heldItemId;
    if (!id) return null;
    return (ctx.loot?.getItemDef(id)?.gadgetId as GadgetId | undefined) ?? null;
  }

  /**
   * Fills row `i` and returns the next row number. An unchanged signature leaves the DOM alone.
   * `key` is the key **code** (2026-09-15) — the code is part of the signature, so a rebinding repaints on the next frame.
   */
  private setRow(i: number, pre: string | null, key: string | null, text: string, tone: Tone, hold: boolean): number {
    if (i >= this.rows.length) return i;
    const r = this.rows[i];
    const sig = `${pre ?? ''}|${key ?? ''}|${text}|${tone}|${hold ? 1 : 0}`;
    if (r.el.hidden) r.el.hidden = false;
    if (sig !== r.sig) {
      r.sig = sig;
      r.code = key ?? '';
      r.el.className = `ghh-row ${tone}`;
      if (r.pre.hidden !== !pre) r.pre.hidden = !pre;
      setText(r.pre, pre ?? '');
      if (r.key.hidden !== !key) r.key.hidden = !key;
      if (key) paintKeycap(r.key, key, { hold });
      setText(r.txt, text);
    }
    return i + 1;
  }

  /** How many notice rows are visible and their texts (debug / smoke). */
  get rowCount(): number { return this.shown; }
  get lines(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.shown; i++) {
      const r = this.rows[i];
      const parts: string[] = [];
      if (!r.pre.hidden) parts.push(r.pre.textContent ?? '');
      if (!r.key.hidden) parts.push(keyLabel(r.code));
      parts.push(r.txt.textContent ?? '');
      out.push(parts.join(' '));
    }
    return out;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
  }
}
