import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const SIZE = 120;
const RADIUS = 48;
/** Arc span (degrees) bulging right of the reticle — the CookGauge silhouette, mirrored colours per kind. */
const ARC_DEG = 120;

type ChargeKind = 'charge' | 'spinup' | 'slash';
/**
 * 2026-09-15: kind → root class. The classes carry the `wc-` prefix: the bare `charge` used to collide with the ship-call
 * charge ring (`hud/ChargeGauge`, `.charge`), whose `.charge svg { rotate(-90deg) }` spun this right-side arc to the top
 * and whose `.charge.ready` turned the full tesla arc red.
 */
const KIND_CLASS: Readonly<Record<ChargeKind, string>> = { charge: 'wc-charge', spinup: 'wc-spinup', slash: 'wc-slash' };
/** Label prefix per kind; '' = the percentage alone (2026-09-15: 전격총 reads just `37%` … `100%`). */
const KIND_LABEL: Readonly<Record<ChargeKind, string>> = { charge: '', spinup: '예열', slash: '용검' };
/** Ready text at t = 1; null = keep the percentage (`100%`). */
const KIND_READY: Readonly<Record<ChargeKind, string | null>> = { charge: null, spinup: '사격', slash: '용검 준비' };

/**
 * Unique-weapon wind-up gauge (`.wcharge`): a 120° SVG arc right of the reticle driven by `weapon:chargeChanged`.
 * Colour per kind — `wc-charge` (전격총 충전 볼트) electric blue that turns a **brighter** blue when full,
 * `wc-spinup` (미니건 예열) amber, `wc-slash` (표창 용검 hold) red; label under the arc end reads `n%` (전격총) /
 * `예열 n%` / `용검 n%` and the ready text at 1 (`100%` / `사격` / `용검 준비`). Hidden on `t = −1`
 * (cancelled / released), on a weapon swap, death / down and mission reset. Gameplay layer only.
 */
export class WeaponChargeGauge {
  readonly root: HTMLElement;
  private fill: SVGPathElement;
  private label: HTMLElement;
  private kind: ChargeKind | null = null;
  private lastT = -1;
  private lastPct = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'wcharge', parent });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    const d = arcPath(SIZE / 2, SIZE / 2, RADIUS, -ARC_DEG / 2, ARC_DEG / 2);
    const mk = (cls: string): SVGPathElement => {
      const p = document.createElementNS(svgNS, 'path');
      p.setAttribute('class', cls);
      p.setAttribute('d', d);
      p.setAttribute('pathLength', '1');
      svg.appendChild(p);
      return p;
    };
    mk('track');
    this.fill = mk('fill');
    this.fill.style.strokeDasharray = '0 1';
    this.root.appendChild(svg);
    this.label = el('div', { cls: 'lbl ui-mono', text: '', parent: this.root });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('weapon:chargeChanged', ({ kind, t }) => {
        // 2026-09-14: 활 시위(`draw`)는 호가 아니라 크로스헤어의 가로 바가 그린다 (`hud/Reticle`)
        if (kind === 'draw') { this.hide(); return; }
        if (t < 0) { this.hide(); return; }
        this.setKind(kind);
        const c = Math.min(1, Math.max(0, t));
        toggleClass(this.root, 'show', true);
        toggleClass(this.root, 'ready', c >= 1);
        this.setFill(c);
        const pct = Math.round(c * 100);
        if (pct !== this.lastPct) {
          this.lastPct = pct;
          const ready = c >= 1 ? KIND_READY[kind] : null;
          const prefix = KIND_LABEL[kind];
          setText(this.label, ready ?? (prefix ? `${prefix} ${pct}%` : `${pct}%`));
        }
      }),
      b.on('weapon:equipped', () => this.hide()),
      b.on('quick:equipped', ({ item }) => { if (item) this.hide(); }),
      b.on('player:died', () => this.hide()),
      b.on('player:downed', () => this.hide()),
      b.on('game:newMission', () => this.hide()),
      b.on('game:abort', () => this.hide()),
    );
  }

  /** Kind currently shown (debug), null while hidden. */
  get activeKind(): ChargeKind | null { return this.root.classList.contains('show') ? this.kind : null; }

  private setKind(kind: ChargeKind): void {
    if (this.kind === kind) return;
    this.kind = kind;
    // the label cache is per kind: tesla `100%` → minigun at t 1 has the same pct but must read `사격`
    this.lastPct = -1;
    for (const k of Object.keys(KIND_CLASS) as ChargeKind[]) toggleClass(this.root, KIND_CLASS[k], k === kind);
  }

  private hide(): void {
    if (!this.root.classList.contains('show')) return;
    this.root.classList.remove('show', 'ready');
    this.setFill(0);
    this.lastPct = -1;
  }

  private setFill(t: number): void {
    if (Math.abs(t - this.lastT) < 0.003) return;
    this.lastT = t;
    this.fill.style.strokeDasharray = `${t.toFixed(3)} 1`;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}

/** SVG arc path around (cx, cy); angles in degrees, 0 = +X (right), clockwise positive (screen space). */
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const rad = (a: number) => (a * Math.PI) / 180;
  const x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0));
  const x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1));
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
