/**
 * vite HMR 소켓을 **조용히 붙잡아 두는** 스모크 공용 헬퍼 (2026-09-11, C-65). 스모크가 아니다 — `verify.mjs` 는
 * `SMOKES` 표에 적힌 파일만 돌리므로 이 파일이 스모크로 오인되지 않는다.
 *
 * 왜: 스모크가 여는 vite 페이지는 HMR 소켓을 잡고 있고, 같은 트리에서 누군가 `src/` 파일을 저장하면 vite 가 그 페이지를
 * **full-reload** 한다 (이 게임은 TS 모듈 변경이 거의 전부 full-reload 다). 그러면 스모크가 심어 둔 상태가 날아가 아무 시점에나
 * `Execution context was destroyed` · `timeout waiting for boot` 로 깨진다. 여러 에이전트가 동시에 편집 · 검증하는 트리에서는
 * 늘 일어나는 일이다. 예전에는 35개 스모크가 같은 12줄을 각자 복사해 들고 있었고 10개는 아예 없었다.
 *
 * 어떻게: 페이지 로드 **전에**(`page.evaluateOnNewDocument` — 게임 모듈보다 먼저, 새로고침 · `page.goto` 뒤에도 매번) `window.WebSocket`
 * 을 Proxy 로 감싸, 서브프로토콜이 `vite-hmr` 인 소켓에만 **CONNECTING(0) 에 머무는 가짜 소켓**을 돌려준다. vite 클라이언트는
 * error / close 에만 로그를 찍으므로 영영 연결 중인 소켓은 조용하다. **게임의 릴레이 소켓(`/ws`)은 그대로 통과한다** —
 * 서브프로토콜이 없기 때문이다. 릴레이까지 막는 것은 `parkRelay` 를 **명시했을 때만**이다.
 *
 * 쓰는 법 (puppeteer-core, `page.goto` 전에):
 *
 *   import { quietViteHmr } from './quiet-hmr.mjs';
 *   await quietViteHmr(page);                          // HMR 만 막는다 (기본)
 *   await quietViteHmr(page, { parkRelay: true });     // + 릴레이 소켓(`…/ws`, `…/ws?…`)도 막는다 — 서버 프로필이 도중에 들어오면
 *                                                       //   안 되는 싱글 플레이 스모크 (meta · housing · ladder …)
 *   await quietViteHmr(page, { logSockets: '__ws' });  // 통과시킨 소켓을 `window.__ws` 에 `{url, at}` 로 적는다 (netlink)
 *
 * 여러 페이지(멀티 클라이언트 · 새 탭 · 새 브라우저)를 여는 스모크는 **페이지마다** 부른다. 같은 문서에 두 번 설치되면
 * 뒤의 것은 아무것도 하지 않는다(먼저 건 옵션이 이긴다). 반환값은 `evaluateOnNewDocument` 의 `{identifier}` 다.
 *
 * vite 를 여는 새 스모크는 이 헬퍼를 건다 (`scripts/README.md`). vite 를 안 여는 것 — 서버 exe(`smoke-server-dist`) ·
 * 진짜 Electron 셸(`smoke-desktop`, `dist/` 에는 HMR 클라이언트가 없다) · 정적 피칭 문서(`smoke-pitch`) — 은 걸 필요가 없다.
 */

/** 릴레이 경로: `…/ws` 로 끝나거나 `?` · `#` · `/` 가 이어진다 (옛 복사본의 `/\/ws\?/` · `/\/ws(\?|$)/` · `includes('/ws')` 를 합쳤다). */
const RELAY_PATH_SOURCE = String.raw`\/ws(?:[?#/]|$)`;

/**
 * 브라우저 안에서 도는 설치 함수 — puppeteer 가 `toString()` 으로 넘기므로 **바깥 변수를 참조하지 않는다** (옵션은 인자로만).
 * @param {{ parkRelay: boolean, logSockets: string | null, relayPath: string }} opts
 */
function installQuietSockets(opts) {
  if (window.__quietViteHmr) return;
  Object.defineProperty(window, '__quietViteHmr', { value: true, configurable: true });
  const RealWS = window.WebSocket;
  if (typeof RealWS !== 'function') return;
  const relay = new RegExp(opts.relayPath);
  if (opts.logSockets) window[opts.logSockets] = [];
  // A socket stuck in CONNECTING: never opens, never errors, never closes — the vite client stays silent.
  class QuietSocket extends EventTarget {
    constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
    send() {} close() {}
  }
  window.WebSocket = new Proxy(RealWS, {
    construct(target, args) {
      const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
      if (protos.includes('vite-hmr')) return new QuietSocket(args[0]);
      if (opts.parkRelay && relay.test(String(args[0]))) return new QuietSocket(args[0]);
      if (opts.logSockets) window[opts.logSockets].push({ url: String(args[0]), at: performance.now() });
      return new target(...args);
    },
  });
}

/**
 * Park vite's HMR socket (and optionally the relay socket) on every document this page loads from now on.
 * Call it **before** `page.goto`.
 * @param {import('puppeteer-core').Page} page
 * @param {{ parkRelay?: boolean, logSockets?: string }} [options]
 */
export function quietViteHmr(page, options = {}) {
  return page.evaluateOnNewDocument(installQuietSockets, {
    parkRelay: !!options.parkRelay,
    logSockets: options.logSockets ?? null,
    relayPath: RELAY_PATH_SOURCE,
  });
}
