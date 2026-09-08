import { RETARGET_INTERVAL } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/parts/Spotlight.ts — **UI 포커싱**.
 *
 * 화면 전체를 어둡게 덮고 대상 요소 자리만 구멍을 뚫어 밝힌다. 구멍은 네 장의 `div` 로 만든다 —
 * 위 · 아래 · 왼쪽 · 오른쪽 판을 대상 사각형에 맞춰 붙이면 가운데가 비고, 그 네 판이 **클릭을 먹는다**.
 * (`clip-path` 한 장으로도 그릴 수는 있지만 그러면 구멍까지 포인터를 먹거나 반대로 전부 통과한다.)
 * 대상 위에는 테두리 링과 짧은 말풍선만 얹고 `pointer-events: none` 이라, 밝은 부분의 클릭은 그대로 UI 로 간다.
 *
 * 대상은 CSS 선택자 목록으로 받아 **먼저 찾히는 것 하나**를 쓴다 (버튼 → 그 행 → 그 패널 순으로 넓혀 둔다:
 * 화면이 아직 안 그려졌거나 구조가 바뀌어도 최소한 패널은 밝힌다). 없으면 스스로 숨는다 — 어두운 화면만
 * 남기고 아무것도 누를 수 없게 되는 상황을 만들지 않는다.
 * ──────────────────────────────────────────────────────────────────────────── */

interface Rect { x: number; y: number; w: number; h: number }

/** 구멍 둘레 여백 (px). */
const PAD = 6;

/**
 * 2026-09-08 — **비켜서야 하는 것들**. 스포트라이트가 밝히는 버튼을 누르면 그 위에 확인 팝업이 뜨는 화면이
 * 있다 (시설 증축 · 발전기 가동의 `.sm-confirm`). 어두운 판은 화면 전체를 덮으므로 그 팝업까지 덮어 클릭을
 * 먹어 버린다 — 안내를 따랐는데 다음 버튼을 못 누르는, 튜토리얼에서 제일 나쁜 상태다.
 * 이 선택자 중 하나라도 화면에 있으면 스포트라이트는 스스로 접힌다 (팝업이 닫히면 다시 켜진다).
 */
const YIELD_TO: readonly string[] = ['.sm-confirm', '.tut-popup'];

export class Spotlight {
  private readonly root: HTMLElement;
  private readonly panes: HTMLElement[] = [];
  private readonly ring: HTMLElement;
  private readonly tip: HTMLElement;
  private selectors: readonly string[] = [];
  private text = '';
  private timer = 0;
  private last: Rect | null = null;
  private shown = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'tut-spot';
    this.root.hidden = true;
    for (let i = 0; i < 4; i++) {
      const p = document.createElement('div');
      p.className = 'tut-spot-pane interactive';
      // 어두운 판이 클릭을 먹는다 — 이것이 "클릭 차단"의 전부다
      p.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
      p.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
      p.addEventListener('contextmenu', (e) => { e.preventDefault(); });
      this.panes.push(p);
      this.root.appendChild(p);
    }
    this.ring = document.createElement('div');
    this.ring.className = 'tut-spot-ring';
    this.tip = document.createElement('div');
    this.tip.className = 'tut-spot-tip';
    this.root.append(this.ring, this.tip);
    parent.appendChild(this.root);
  }

  /** 이 선택자들 중 먼저 찾히는 것을 밝힌다. 빈 목록 = 끄기. */
  set(selectors: readonly string[] | undefined, text: string): void {
    const next = selectors ?? [];
    if (next === this.selectors && text === this.text) return;
    this.selectors = next;
    this.text = text;
    this.timer = 0;                       // 다음 update 에서 즉시 다시 찾는다
    if (next.length === 0) this.hide();
  }

  /** 프레임마다. 대상이 움직이거나 사라지는 것을 따라간다 (`RETARGET_INTERVAL` 간격). */
  update(dt: number): void {
    if (this.selectors.length === 0) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = RETARGET_INTERVAL;
    if (this.yielding()) { this.hide(); return; }
    const el = this.find();
    if (!el) { this.hide(); return; }
    const b = el.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) { this.hide(); return; }
    this.place({ x: b.left - PAD, y: b.top - PAD, w: b.width + PAD * 2, h: b.height + PAD * 2 });
  }

  /** 위에 확인 팝업 같은 것이 떠 있는가 (`YIELD_TO`). */
  private yielding(): boolean {
    for (const sel of YIELD_TO) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.getClientRects().length > 0) return true;
    }
    return false;
  }

  /**
   * `offsetParent` 로 보이는지 판정하면 안 된다 — HUD 조각들은 `position: fixed` 조상 아래에 있어서 멀쩡히
   * 보이는데도 null 이 나온다. 실제로 그려진 사각형이 있는지(`getClientRects`)로 본다.
   *
   * 2026-09-08 — 사각형만으로는 모자란다: 닫힌 화면 중에는 `display:none` 이 아니라 **`visibility:hidden`**
   * 으로 접히는 것이 있어(`.ship-manage`) 사각형이 그대로 남는다. 그 자리를 밝히면 아무것도 없는 허공에
   * 링이 뜨므로 `visibility` 도 함께 본다 (0.25 초에 한 번이라 비용은 무시할 만하다).
   */
  private find(): HTMLElement | null {
    for (const sel of this.selectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden') return el;
    }
    return null;
  }

  private place(r: Rect): void {
    const vw = window.innerWidth, vh = window.innerHeight;
    const px = (v: number): string => `${Math.round(v)}px`;
    const [top, bottom, left, right] = this.panes;
    top.style.cssText = `left:0;top:0;width:${px(vw)};height:${px(Math.max(0, r.y))}`;
    bottom.style.cssText = `left:0;top:${px(r.y + r.h)};width:${px(vw)};height:${px(Math.max(0, vh - r.y - r.h))}`;
    left.style.cssText = `left:0;top:${px(r.y)};width:${px(Math.max(0, r.x))};height:${px(r.h)}`;
    right.style.cssText = `left:${px(r.x + r.w)};top:${px(r.y)};width:${px(Math.max(0, vw - r.x - r.w))};height:${px(r.h)}`;
    this.ring.style.cssText = `left:${px(r.x)};top:${px(r.y)};width:${px(r.w)};height:${px(r.h)}`;
    // 말풍선은 대상 아래, 화면을 벗어나면 위로
    const below = r.y + r.h + 10;
    const tipTop = below + 44 > vh ? r.y - 44 : below;
    this.tip.textContent = this.text;
    this.tip.style.cssText = `left:${px(Math.min(Math.max(8, r.x), vw - 300))};top:${px(Math.max(8, tipTop))}`;
    this.tip.hidden = !this.text;
    if (!this.shown) { this.shown = true; this.root.hidden = false; }
    this.last = r;
  }

  private hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.root.hidden = true;
    this.last = null;
  }

  /** 스모크 / 디버그: 지금 밝히고 있는 사각형 (없으면 null). */
  get rect(): Rect | null { return this.last; }
  get visible(): boolean { return this.shown; }

  dispose(): void {
    this.root.remove();
  }
}
