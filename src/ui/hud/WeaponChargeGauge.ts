import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const SIZE = 120;
const RADIUS = 48;
/** Arc span (degrees) bulging right of the reticle — the CookGauge silhouette, mirrored colours per kind. */
const ARC_DEG = 120;

type ChargeKind = 'charge' | 'spinup' | 'slash';
const KIND_CLASSES: readonly ChargeKind[] = ['charge', 'spinup', 'slash'];
const KIND_LABEL: Readonly<Record<ChargeKind, string>> = { charge: '충전', spinup: '예열', slash: '용검' };
const KIND_READY: Readonly<Record<ChargeKind, string>> = { charge: '충전 완료', spinup: '사격', slash: '용검 준비' };

/**
 * Unique-weapon wind-up gauge (`.wcharge`): a 120° SVG arc right of the reticle driven by `weapon:chargeChanged`.
 * Colour per kind — `charge` (전격총 충전 볼트) electric blue, `spinup` (미니건 예열) amber, `slash` (표창 용검 hold) red;
 * label under the arc end reads `충전 n%` / `예열 n%` / `용검 n%` and the ready text at 1. Hidden on `t = −1`
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
        if (t < 0) { this.hide(); return; }
        this.setKind(kind);
        const c = Math.min(1, Math.max(0, t));
        toggleClass(this.root, 'show', true);
        toggleClass(this.root, 'ready', c >= 1);
        this.setFill(c);
        const pct = Math.round(c * 100);
        if (pct !== this.lastPct) {
          this.lastPct = pct;
          setText(this.label, c >= 1 ? KIND_READY[kind] : `${KIND_LABEL[kind]} ${pct}%`);
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
    for (const k of KIND_CLASSES) toggleClass(this.root, k, k === kind);
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
