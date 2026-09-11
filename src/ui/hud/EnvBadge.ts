import type { EnvKind, GameContext } from '@/shared';
import { ENV_COLOR, ENV_DESC_KO, ENV_ICON, ENV_LABEL_KO } from '@/shared';
import '../styles/env.css';
import { el, setText, toggleClass } from '../dom';

/**
 * **행성 상시 환경 배지 (A-13, 2026-09-11).** `player:envChanged {env, protected}` 의 **유일한** 소비자다 —
 * 판정(행성에 환경이 있나 · 준비물이 실려 있나 · 지금 깎이고 있나)은 전부 `player/` 가 하고 이 위젯은 그 한 줄을
 * 그리기만 한다. 이벤트는 **상태가 바뀔 때만** 오므로 `update()` 도 타이머도 없다.
 *
 *   - 환경이 없는 행성(`env: null`) · 훈련장 · 함선 → 배지가 아예 뜨지 않는다.
 *   - `protected` (맞는 준비물이 실려 있다 = 피해 0) → **차분한 색 + 「차단됨」**.
 *   - 그렇지 않으면 → **환경 색(`ENV_COLOR`) + 글로우 + 맥박 + 「노출」**. 지금 체력이 깎이고 있다는 뜻이다.
 *
 * 자리는 게임플레이 레이어 좌측 상단, 임무 시계 바로 아래다 (`styles/env.css`). **레이드에서만 보인다** — 이
 * 레이어 자체가 함선 · 타이틀에서 내려가기 때문에 자기 게이트를 따로 두지 않고, 함선에서 오는 `env: null` 과
 * `.hud.hub` CSS 규칙이 이중으로 막는다. 이름 · 색 · 글리프 · 설명은 전부 `shared/labels` 의 `ENV_*` 표 하나에서
 * 온다 (행성 터미널 브리핑 · 준비물 툴팁과 같은 원본).
 */
export class EnvBadge {
  readonly root: HTMLElement;
  private glyphEl: HTMLElement;
  private nameEl: HTMLElement;
  private stateEl: HTMLElement;
  private env: EnvKind | null = null;
  private guarded = false;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'env-badge', parent });
    this.glyphEl = el('span', { cls: 'g', text: '', parent: this.root });
    this.nameEl = el('span', { cls: 'nm', text: '', parent: this.root });
    this.stateEl = el('span', { cls: 'st', text: '', parent: this.root });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('player:envChanged', ({ env, protected: guarded }) => this.set(env, guarded)),
      // 레이드가 끝나면 다음 행성의 첫 이벤트가 올 때까지 옛 배지가 남지 않게 한다
      b.on('game:newMission', () => this.set(null, false)),
      b.on('game:abort', () => this.set(null, false)),
    );
  }

  /** 지금 그리고 있는 환경과 차단 여부 (debug / smoke). */
  get shownEnv(): EnvKind | null { return this.env; }
  get isProtected(): boolean { return this.guarded; }

  private set(env: EnvKind | null, guarded: boolean): void {
    if (env === this.env && guarded === this.guarded) return;
    this.env = env;
    this.guarded = guarded;
    if (!env) {
      toggleClass(this.root, 'show', false);
      toggleClass(this.root, 'is-exposed', false);
      toggleClass(this.root, 'is-safe', false);
      return;
    }
    this.root.style.setProperty('--ec', ENV_COLOR[env]);
    setText(this.glyphEl, ENV_ICON[env]);
    setText(this.nameEl, ENV_LABEL_KO[env]);
    setText(this.stateEl, guarded ? '차단됨' : '노출');
    // pointer-events 가 없어 툴팁은 안 뜨지만, 접근성 도구 · 스모크가 읽을 한 줄은 남겨 둔다
    this.root.title = guarded ? `${ENV_LABEL_KO[env]} — 준비물이 막고 있습니다` : ENV_DESC_KO[env];
    toggleClass(this.root, 'is-safe', guarded);
    toggleClass(this.root, 'is-exposed', !guarded);
    toggleClass(this.root, 'show', true);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }
}
