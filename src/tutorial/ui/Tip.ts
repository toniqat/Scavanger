import { TIP_FADE_S, TIP_GAP_PX, TIP_HOLD_S, TIP_LABEL_KO } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/ui/Tip.ts — **TIP 토스트** (2026-09-15, 사용자 결정).
 *
 * 우측 조작 가이드(`ui/Controls`, `.tut-controls`) **바로 아래**에 뜨는 작은 패널 하나. 머리에 `TIP` 라벨, 아래에 한 줄.
 * 지금 쓰는 곳은 포복 · 앉아 조준 구간의 「앉거나 포복해서 조준 시, 명중률이 높아집니다.」 하나다 (한 번만 —
 * 언제 띄울지는 `TutorialSystem.maybeCrouchTip` 이 정한다).
 *
 * **나타남 · 머묾 · 사라짐은 `update(dt)` 가 인라인 opacity 로 몬다.** 이 개발 PC 는 `prefers-reduced-motion` 을
 * 보고하고 `ui/styles/base.css` 가 모든 CSS 전이를 0.01 ms 로 자르므로, 의미를 싣는 페이드를 CSS 로 만들면
 * 한 프레임에 켜지고 꺼진다 (`HudSystem.stepScreenFade` 와 같은 이유).
 *
 * 자리: 조작 가이드는 `top`/`bottom` 띠 안에서 세로 가운데에 서므로(`tutorial.css`) 그 바닥이 창 크기 · 줄 수에 따라
 * 움직인다. 그래서 떠 있는 동안만 프레임마다 가이드의 사각형을 읽어 그 아래에 붙인다 — 떠 있는 시간은 몇 초라
 * `getBoundingClientRect` 한 번이 비용의 전부다. 가이드가 접혀 있으면(인벤토리 화면) 함께 숨되 시간은 그대로 흐른다.
 * ──────────────────────────────────────────────────────────────────────────── */

export class TutorialTip {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  /** 떠 있은 시간 (s). -1 = 꺼져 있다. */
  private t = -1;

  constructor(parent: HTMLElement) {
    const root = this.root = document.createElement('div');
    root.className = 'tut-tip';
    root.hidden = true;
    root.style.opacity = '0';
    const head = document.createElement('div');
    head.className = 'tut-tip-head';
    head.textContent = TIP_LABEL_KO;
    this.body = document.createElement('div');
    this.body.className = 'tut-tip-body';
    root.append(head, this.body);
    parent.appendChild(root);
  }

  /** 떠 있는가 (나타나는 중 · 사라지는 중 포함). */
  get active(): boolean { return this.t >= 0; }
  /** 스모크 / 디버그: 지금 칠해진 불투명도. */
  get opacity(): number { return Number(this.root.style.opacity) || 0; }

  /** 한 줄을 띄운다 — 처음부터 다시 센다. */
  show(text: string): void {
    this.body.textContent = text;
    this.t = 0;
  }

  /** 즉시 끈다 (트랙이 끝남 · 미션 리셋). */
  clear(): void {
    this.t = -1;
    this.root.hidden = true;
    this.root.style.opacity = '0';
  }

  /**
   * 프레임마다. `anchor` = 조작 가이드 뿌리 — 보이면 그 바닥 아래에 붙고, 안 보이면 함께 숨는다.
   * 시간은 가이드가 접혀 있어도 흐른다 (다시 열었을 때 몇 분 전의 TIP 이 뜨면 안 된다).
   */
  update(dt: number, anchor: HTMLElement | null): void {
    if (this.t < 0) return;
    this.t += Math.max(0, dt);
    const total = TIP_FADE_S * 2 + TIP_HOLD_S;
    if (this.t >= total) { this.clear(); return; }
    const r = anchor && !anchor.hidden ? anchor.getBoundingClientRect() : null;
    if (!r || r.height <= 0) { this.root.hidden = true; return; }
    const a = this.t < TIP_FADE_S ? this.t / TIP_FADE_S
      : this.t > total - TIP_FADE_S ? (total - this.t) / TIP_FADE_S : 1;
    this.root.hidden = false;
    this.root.style.top = `${Math.round(r.bottom + TIP_GAP_PX)}px`;
    this.root.style.right = `${Math.round(window.innerWidth - r.right)}px`;
    this.root.style.width = `${Math.round(r.width)}px`;
    this.root.style.opacity = Math.max(0, Math.min(1, a)).toFixed(3);
  }

  dispose(): void { this.root.remove(); }
}
