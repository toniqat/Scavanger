import { Keys, mouseButtonOf } from './constants';
import { keyLabel } from './Keybinds';

/* ────────────────────────────────────────────────────────────────────────────
 * 공용 키캡 (2026-09-15, 사용자 결정). Owner: shared/ — 계약이므로 추가만 한다.
 *
 * 키캡이 뜨는 **모든 곳**(키 가이드 · 튜토리얼 조작/목표 · 상호작용 프롬프트 · HUD 힌트 · 미니게임 안내 · ESC 조작 도표 ·
 * 키 설정 메뉴)이 이 한 함수로 그린다. 폴더마다 `el('span', { cls: 'keycap', text: keyLabel(...) })` 를 따로 적으면
 * 마우스 버튼 그림이 어떤 화면에서는 나오고 어떤 화면에서는 `LMB` 글자로 남는다.
 *
 *  - **키보드 키**: 예전 그대로 글자 (`keyLabel`).
 *  - **마우스 좌 · 휠 · 우 (`Mouse0` · `Mouse1` · `Mouse2`, 또는 라벨 `LMB` · `MMB` · `RMB`)**: 글자 대신 **마우스 윗부분 그림**
 *    (위로 둥글고 좌 / 휠 / 우 버튼이 갈린다). 눌러야 하는 부분만 **흰색**으로 칠한다. `M4` · `M5` 는 글자 그대로.
 *  - **꾹 누르기 (`hold`)**: 키보드든 마우스든 **모양이 같다** (2026-09-15 2차, 사용자 결정) — `.kc-hold` 가 붙고
 *    ① 아래 테두리가 다른 면과 같은 1px 로 얇어지며 내용이 1px 내려앉고(「눌린 키」), ② chevron 은 키캡
 *    **윗변에 걸쳐** 절반은 안 · 절반은 밖으로 솟아 있다. 그리는 곳은 `ui/styles/base.css` 의 `.keycap.kc-hold::before`
 *    **하나**다 — 마우스 그림은 예전에 chevron 을 SVG 안에 그렸지만 이제 안 그린다(칠하는 색만 **강조색**이다).
 *
 * 스타일(크기 · 여백)은 `ui/styles/base.css` 의 `.keycap.kc-mouse` 가 갖는다. 여기는 DOM 과 SVG 모양만 만든다.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface KeycapOptions {
  /** 꾹 누르는 키 — 키보드는 `.kc-hold`, 마우스 그림은 강조색 + 버튼 위 chevron. */
  hold?: boolean;
}

/** 마우스 그림의 버튼 칸: 0 = 좌 · 1 = 휠 · 2 = 우. 그림으로 그리지 않는 코드면 -1. */
export type MouseGlyphButton = 0 | 1 | 2;

const LABEL_TO_BUTTON: Readonly<Record<string, MouseGlyphButton>> = { LMB: 0, MMB: 1, RMB: 2 };

/** `Mouse0` · `Mouse1` · `Mouse2` 또는 라벨 `LMB` · `MMB` · `RMB` → 그림 버튼 칸. 아니면 -1. */
export function mouseGlyphButtonOf(codeOrLabel: string): MouseGlyphButton | -1 {
  if (typeof codeOrLabel !== 'string') return -1;
  const byLabel = LABEL_TO_BUTTON[codeOrLabel];
  if (byLabel !== undefined) return byLabel;
  const m = mouseButtonOf(codeOrLabel);
  return m === 0 || m === 1 || m === 2 ? m : -1;
}

/* SVG 모양 — viewBox 16×16. 위가 반원인 마우스 윗부분 (아래는 버튼이 끝나는 곧은 선).
 * 켜진 칸은 흰색(`#fff`) 또는 강조색, 꺼진 칸은 비우고 윤곽만 긋는다 (윤곽은 `currentColor` = 키캡 글자색).
 *
 * 2026-09-15 (ui 다듬기): HUD 크기(키캡 20 px 안의 약 14 px)에서 어두운 바탕 위로 읽히도록 —
 *  - 윤곽 1.2 → **1.35**, 가르는 선 · 휠 1 → **1.1** (1 px 아래로 떨어지면 안티에일리어싱에 묻힌다).
 *  - 휠 안은 늘 **어둡게 채운다** (`WHEEL_HOLE`). 켜진 좌 / 우 칸은 가운데 선까지 칠해지므로, 휠을 비워 두면 흰 칸이 휠 안으로
 *    번져 휠이 사라진다. 휠 자체가 켜진 칸이면 흰색 / 강조색으로 채운다.
 *  - 꾹 누르기 chevron 은 켜진 칸의 **가운데**(좌 · 우 칸은 휠 아래 몸통 한가운데)로 옮기고 선을 굵게 했다.
 *  - `<title>` 에 키 라벨(`LMB` …)을 넣는다 — 그림 키캡의 `textContent` 가 예전 글자 키캡과 같게 남아 스모크 · 디버그가
 *    `.keycap` 글자로 읽던 자리가 그대로 맞는다 (보조 기술 이름은 키캡의 `aria-label` 이 따로 준다). */
const OUTLINE = 'M1.5 15 V8 A6.5 6.5 0 0 1 14.5 8 V15 Z';
const LEFT = 'M1.5 15 V8 A6.5 6.5 0 0 1 8 1.5 V15 Z';
const RIGHT = 'M8 1.5 A6.5 6.5 0 0 1 14.5 8 V15 H8 Z';
const ACCENT = 'var(--c-accent, #ffb347)';
const ON = '#fff';
const WHEEL_HOLE = 'rgba(8, 10, 12, 0.88)';
const GLYPH_LABEL: readonly string[] = ['LMB', 'MMB', 'RMB'];
const SVG_CACHE = new Map<string, string>();

/** 마우스 그림 SVG 문자열 (캐시). `hold` 면 켜진 칸이 강조색이고 그 칸에 아래 chevron 이 들어간다. */
export function mouseGlyphSvg(button: MouseGlyphButton, hold = false): string {
  const key = `${button}|${hold ? 1 : 0}`;
  const hit = SVG_CACHE.get(key);
  if (hit) return hit;
  const fill = hold ? ACCENT : ON;
  const parts: string[] = [`<title>${GLYPH_LABEL[button]}</title>`];
  if (button === 0) parts.push(`<path d="${LEFT}" style="fill:${fill}"/>`);
  if (button === 2) parts.push(`<path d="${RIGHT}" style="fill:${fill}"/>`);
  // 좌우 칸 가르는 선 (휠 위 · 아래)
  parts.push('<path d="M8 1.5 V4 M8 10 V15" style="fill:none;stroke:currentColor;stroke-width:1.1"/>');
  // 휠 — 켜진 칸이 아니면 어두운 구멍 (좌 / 우 칸의 칠이 휠 안으로 번지지 않게)
  parts.push(`<rect x="6.55" y="4" width="2.9" height="6" rx="1.45" style="fill:${button === 1 ? fill : WHEEL_HOLE};stroke:currentColor;stroke-width:1.1"/>`);
  // 윤곽
  parts.push(`<path d="${OUTLINE}" style="fill:none;stroke:currentColor;stroke-width:1.35;stroke-linejoin:round"/>`);
  const svg = `<svg class="kcm-glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
  SVG_CACHE.set(key, svg);
  return svg;
}

/**
 * `cap` 을 키캡으로 칠한다 — 여러 번 불러도 된다(리바인드 · 자세 변경 때 다시 부른다; 바뀐 것이 없으면 DOM 을 안 건드린다).
 * `codeOrLabel` 은 `KeyboardEvent.code` / `MouseN` 이거나 이미 만든 라벨(`LMB`, `Tab 또는 Esc` …)이다.
 * 클래스는 **더하기만** 한다 (`keycap` · `kc-hold` · `kc-mouse`) — 호출부가 붙인 다른 클래스는 그대로 남는다.
 */
export function paintKeycap(cap: HTMLElement, codeOrLabel: string, opts?: KeycapOptions): void {
  const hold = opts?.hold === true;
  const btn = mouseGlyphButtonOf(codeOrLabel);
  const stamp = `${codeOrLabel}|${hold ? 1 : 0}`;
  cap.classList.add('keycap');
  cap.classList.toggle('kc-hold', hold);
  cap.classList.toggle('kc-mouse', btn >= 0);
  if (cap.dataset.kc === stamp) return;
  cap.dataset.kc = stamp;
  const label = keyLabel(codeOrLabel);
  if (btn !== -1) {
    cap.innerHTML = mouseGlyphSvg(btn, hold);
    cap.setAttribute('aria-label', label);
    cap.title = label;
  } else {
    cap.textContent = label;
    cap.removeAttribute('aria-label');
    cap.removeAttribute('title');
  }
}

/** 새 키캡 요소를 만들어 칠한다. `tag` 기본 `span`, `cls` 는 추가 클래스. */
export function createKeycap(
  codeOrLabel: string,
  opts?: KeycapOptions & { tag?: string; cls?: string; parent?: HTMLElement | null },
): HTMLElement {
  const cap = document.createElement(opts?.tag ?? 'span');
  if (opts?.cls) cap.className = opts.cls;
  paintKeycap(cap, codeOrLabel, opts);
  if (opts?.parent) opts.parent.appendChild(cap);
  return cap;
}

/**
 * **꾹 누르는 버튼** 안에 라벨 왼쪽으로 붙이는 좌클릭 홀드 키캡 (2026-09-15 2차, 사용자 결정).
 *
 * `UI_HOLD_CONFIRM_S` 동안 눌러야 실행되는 버튼(확정 팝업 · 제작 · 분해 · 거래 · 강화 · 정보상 · 매매 · 시설 제거 …)은
 * 예전에 버튼 **위에** 「N초 동안 누르고 있어야 실행됩니다」 한 줄을 깔았다. 그 문구 대신 **버튼 안**에 이 키캡을
 * 둔다 — 「어떻게 누르는가」는 그림이 말하고, 문장은 그 줄이 진짜로 나를던 정보(차단 사유 · 경고)만 남긴다.
 *
 * 만들어지는 것은 `Mouse0` · `hold` 키캡이고 클래스가 `kc-btn` 이다 (크기 · 여백 · 포인터 차단은 base.css).
 * ⚠ `setText(btn, ...)` 는 `textContent` 를 갈아 끼우므로 라벨을 다시 쓸 때마다 이 캡을 **다시 앞에 넣는다**
 * (채움 바 `i` 를 다시 appendChild 하는 것과 같은 규약).
 */
export function createHoldButtonCap(parent?: HTMLElement | null): HTMLElement {
  return createKeycap('Mouse0', { hold: true, cls: 'kc-btn', parent });
}

/**
 * **리바인드와 무관한 고정 토큰** (2026-09-16, 사용자 결정 — 튜토리얼 시체 포커싱 문구). 인벤토리의 드래그 · 더블클릭은
 * `Keys` 의 액션이 아니라 실제 버튼이다 (`contextmenu` · `dblclick`). 그래서 `{FIRE}` 로 적으면 사격을 리바인드했을 때 거짓말이 된다.
 *   `{MOUSE_LEFT}`   → 좌클릭 마우스 그림 (`Mouse0`)
 *   `{DOUBLE_CLICK}` → 키 가이드의 `더블클릭` 키캡과 **같은 모양** (`ui/hud/KeyGuide` 가 `createKeycap('더블클릭')` 으로 그린다)
 * `Keys` 의 필드 이름과 겹치지 않는다 (대문자 액션 이름 목록에 없다). 추가만 한다.
 */
export const KEYCAP_FIXED_TOKENS: Readonly<Record<string, string>> = {
  MOUSE_LEFT: 'Mouse0',
  DOUBLE_CLICK: '더블클릭',
};

/**
 * 문장 안에 키캡을 끼워 넣는다 — 토큰 문법 (`KEYCAP_FIXED_TOKENS` 도 같은 문법이다):
 *   `{ACTION}`       → `Keys.ACTION` 의 키캡 (그릴 때 읽는다 — 리바인드하면 다시 부른다)
 *   `{ACTION:hold}`  → 꾹 누르는 키캡
 *   `{br}`           → 줄바꿈
 * `ACTION` 은 `KeyBindings` 의 필드 이름이다. 모르는 토큰은 글자 그대로 둔다. `host` 의 기존 자식은 지운다.
 * 글자는 텍스트 노드로만 넣는다 (HTML 해석 없음). 끼워 넣은 키캡에는 `kc-inline` 클래스가 붙는다.
 */
export function renderKeyText(host: HTMLElement, text: string): void {
  host.textContent = '';
  const re = /\{([A-Za-z_]+)(?::(hold))?\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) host.appendChild(document.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    const name = m[1];
    if (name === 'br') { host.appendChild(document.createElement('br')); continue; }
    const code = KEYCAP_FIXED_TOKENS[name] ?? (Keys as unknown as Record<string, string | undefined>)[name];
    if (typeof code !== 'string') { host.appendChild(document.createTextNode(m[0])); continue; }
    createKeycap(code, { hold: m[2] === 'hold', cls: 'kc-inline', parent: host });
  }
  if (last < text.length) host.appendChild(document.createTextNode(text.slice(last)));
}

/** 토큰을 걷어낸 순수 글자 (콘솔 · 토스트 · 검색용). `{ACTION}` 은 그 키 라벨, `{br}` 은 공백. */
export function plainKeyText(text: string): string {
  return text.replace(/\{([A-Za-z_]+)(?::hold)?\}/g, (all, name: string) => {
    if (name === 'br') return ' ';
    const code = KEYCAP_FIXED_TOKENS[name] ?? (Keys as unknown as Record<string, string | undefined>)[name];
    return typeof code === 'string' ? keyLabel(code) : all;
  });
}
