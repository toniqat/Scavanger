import type { GameContext } from '@/shared';
import { el, toggleClass } from '../dom';

const SIZE = 56;
const RADIUS = 22;

/**
 * 커서 홀드 링 (`.cursor-hold`, 2026-09-12, 사용자 결정) — 시설 관리에서 놓인 가구를 **LMB 로 꾹 누르는 동안** 커서를
 * 중심으로 차오르는 원형 게이지. 꽉 차면 hub/ 의 `HousingMode` 가 그 가구를 위치 이동 상태로 든다.
 *
 * `housing:moveHold {progress}` 의 유일한 소비자다 (owner: hub). `progress` 0 … 1 이 누르는 동안 매 프레임 오고,
 * `null` 이면 끝났다 (놓았다 · 커서가 가구를 벗어났다 · 1 에 닿아 이동 상태가 됐다). 좌표는 이벤트에 없고
 * `ctx.input.uiX / uiY`(클라이언트 좌표 — 시설 관리의 레이캐스트가 쓰는 바로 그 값)를 받을 때마다 읽는다.
 *
 * 크로스헤어 홀드 링(`hud/HoldGauge`)과 같은 결이다 — 전체 원 SVG 하나를 `stroke-dasharray` 로 채우고 `svg` 를 −90°
 * 돌려 12시에서 시작한다. 크기만 커서에 맞게 작다. 시설 관리 화면과 같은 `.hud.housing` 층에 산다 (그 층은 함선에서
 * 늘 붙어 있다). 게임 시작 · 중단이면 내린다.
 */
export class CursorHoldGauge {
  readonly root: HTMLElement;
  private fill: SVGCircleElement;
  private circumference: number;
  private lastT = -1;
  private shown = false;
  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'cursor-hold', parent });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    const mk = (cls: string): SVGCircleElement => {
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('cx', String(SIZE / 2)); c.setAttribute('cy', String(SIZE / 2)); c.setAttribute('r', String(RADIUS));
      svg.appendChild(c);
      return c;
    };
    mk('track');
    this.fill = mk('fill');
    this.circumference = 2 * Math.PI * RADIUS;
    this.fill.style.strokeDasharray = `0 ${this.circumference.toFixed(2)}`;
    this.root.appendChild(svg);
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:moveHold', ({ progress }) => this.set(progress)),
      b.on('housing:shipManageChanged', ({ active }) => { if (!active) this.set(null); }),
      b.on('game:newMission', () => this.set(null)),
      b.on('game:abort', () => this.set(null)),
    );
  }

  /** Whether the ring is up (debug / smoke). */
  get isShowing(): boolean { return this.shown; }
  /** Fill fraction 0..1 while showing, else −1 (debug / smoke). */
  get progress(): number { return this.shown ? this.lastT : -1; }

  private set(progress: number | null): void {
    const show = progress !== null;
    if (show !== this.shown) { this.shown = show; toggleClass(this.root, 'show', show); }
    if (!show) { this.setFill(0); return; }
    const input = this.ctx?.input;
    if (input) this.root.style.transform = `translate(${input.uiX.toFixed(1)}px, ${input.uiY.toFixed(1)}px)`;
    this.setFill(Math.max(0, Math.min(1, progress)));
  }

  private setFill(t: number): void {
    if (Math.abs(t - this.lastT) < 0.003) return;
    this.lastT = t;
    this.fill.style.strokeDasharray = `${(t * this.circumference).toFixed(2)} ${this.circumference.toFixed(2)}`;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.unsubs = []; this.root.remove(); }
}
