import type { GameContext, StratagemId } from '@/shared';
import { Keys, keyLabel } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { STRATAGEM_COLOR, STRATAGEM_GLYPH, stratagemArmHint, stratagemDef } from './stratagemGlyphs';

/**
 * Ship-call panel (`.strat-panel`, bottom-right above the weapon panel). Two states:
 *   - **armed** (`.armed`, `stratagem:armed {id}`): glyph + call name (tinted by call), `STRATAGEM_DEFS.hint`, mouse hint
 *     (`좌클 홀드 → 위치 지정` for topview calls, `좌클 투하 · 우클 취소` for ground calls); `.targeting` while targeting.
 *   - **idle**: `G` keycap + `함선 호출 준비` / `재충전 n초` (`.cooling`) and a thin shared-cooldown bar
 *     (`stratagem:cooldown {remaining, total}` → `.fill` scaleX = 1 − remaining/total; polled from `ctx.stratagems`
 *     each update so the bar keeps moving between the 0.5 s events).
 * Hidden entirely (`.off`) when `ctx.stratagems` is null and no event has arrived yet.
 */
export class StratagemPanel {
  readonly root: HTMLElement;
  private keyEl: HTMLElement;
  private ico: HTMLElement;
  private nameEl: HTMLElement;
  private hintEl: HTMLElement;
  private ctrlEl: HTMLElement;
  private fill: HTMLElement;
  private armed: StratagemId | null = null;
  private targeting = false;
  private remaining = 0;
  private total = 0;
  private seen = false;
  private lastKey = '';
  private lastFill = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'strat-panel off', parent });
    const row = el('div', { cls: 'row', parent: this.root });
    this.keyEl = el('span', { cls: 'keycap g', text: keyLabel(Keys.SHIP_CALL), parent: row });
    this.ico = el('span', { cls: 'ico', text: '', parent: row });
    this.nameEl = el('span', { cls: 'nm', text: '함선 호출 준비', parent: row });
    this.hintEl = el('div', { cls: 'hint', text: '', parent: this.root });
    this.ctrlEl = el('div', { cls: 'ctrl', text: '', parent: this.root });
    const bar = el('div', { cls: 'cd-bar', parent: this.root });
    this.fill = el('div', { cls: 'fill', parent: bar });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('input:bindingsChanged', () => setText(this.keyEl, keyLabel(Keys.SHIP_CALL))),
      b.on('stratagem:armed', ({ id }) => { this.armed = id; this.seen = true; this.render(); }),
      b.on('stratagem:targeting', ({ active }) => { this.targeting = active; this.render(); }),
      b.on('stratagem:cooldown', ({ remaining, total }) => {
        this.seen = true;
        this.remaining = Math.max(0, remaining); this.total = Math.max(this.total, total, 0);
        if (remaining <= 0) this.total = total;
        this.render();
      }),
      b.on('game:newMission', () => { this.armed = null; this.targeting = false; this.render(); }),
      b.on('game:abort', () => { this.armed = null; this.targeting = false; this.render(); }),
      b.on('player:died', () => { this.armed = null; this.targeting = false; this.render(); }),
    );
  }

  update(ctx: GameContext): void {
    const s = ctx.stratagems;
    if (s) {
      if (!this.seen) { this.seen = true; this.render(); }
      // Smooth the bar between cooldown events.
      const rem = Math.max(0, s.cooldown), tot = s.cooldownTotal > 0 ? s.cooldownTotal : this.total;
      if (Math.abs(rem - this.remaining) > 0.01 || tot !== this.total) {
        this.remaining = rem; this.total = tot;
        this.render();
      }
    }
  }

  private render(): void {
    const def = stratagemDef(this.armed);
    const cooling = this.remaining > 0;
    const secs = Math.ceil(this.remaining);
    const key = `${this.seen ? 1 : 0}|${this.armed ?? ''}|${this.targeting ? 1 : 0}|${cooling ? secs : 0}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      toggleClass(this.root, 'off', !this.seen);
      toggleClass(this.root, 'armed', !!def);
      toggleClass(this.root, 'targeting', this.targeting);
      toggleClass(this.root, 'cooling', cooling && !def);
      if (def) {
        setText(this.ico, STRATAGEM_GLYPH[def.id]);
        this.ico.style.color = STRATAGEM_COLOR[def.id];
        setText(this.nameEl, def.name);
        setText(this.hintEl, def.hint);
        setText(this.ctrlEl, this.targeting ? (def.targeting === 'topview' ? '좌클 확정 · 우클/Esc 취소' : '좌클 투하 · 우클 취소') : stratagemArmHint(def));
      } else {
        setText(this.ico, '');
        setText(this.nameEl, cooling ? `재충전 ${secs}초` : '함선 호출 준비');
        setText(this.hintEl, '');
        setText(this.ctrlEl, cooling ? '' : 'G 길게: 호출 휠');
      }
      toggleClass(this.keyEl, 'lit', !!def);
    }
    const t = this.total > 0 ? 1 - Math.min(1, this.remaining / this.total) : 1;
    if (Math.abs(t - this.lastFill) > 0.003) {
      this.lastFill = t;
      this.fill.style.transform = `scaleX(${t.toFixed(3)})`;
    }
  }

  /** Whether a call is armed (debug). */
  get armedId(): StratagemId | null { return this.armed; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
