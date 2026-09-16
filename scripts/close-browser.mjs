/**
 * 스모크 공용 헬퍼: 헤드리스 Chrome 을 **기다리지 않고** 닫는다 (2026-09-16). 스모크가 아니다 — `verify.mjs` 는 `SMOKES`
 * 표에 적힌 파일만 돌린다.
 *
 * 왜: Windows 에서 D3D11(ANGLE) 로 렌더하던 Chrome 이 **다른 Chrome 이 아직 돌고 있을 때** 정상 종료(`browser.close()` →
 * CDP `Browser.close`)되면, 브라우저 프로세스가 CDP 를 끊은 뒤에도 CPU 0 · 스레드 `LpcReply` 대기로 **최대 2분** 살아 있다.
 * puppeteer 는 그 프로세스가 끝날 때까지(`hasClosed()`, 제한 시간 없음) 기다리므로 스모크 프로세스가 검사를 다 끝내고도
 * 그만큼 레인을 붙잡는다. 여럿이 걸리면 ~120초 간격으로 **한꺼번에** 풀린다 — 「스모크 묶음이 같은 초에 끝난다」의 정체다.
 * 잰 값 (7800X3D · RTX 4080 SUPER, `verify:all` 4레인): 스모크 프로세스 시간 5476초 중 **2244초(41 %)** 가 이 대기였고
 * 전체 26분 46초. 재현: 게임을 띄운 헤드리스 Chrome 4대를 15초 간격으로 닫으면 첫 대만 0.3초, 나머지는 85~220초.
 * 혼자 도는 스모크 · SwiftShader 에서는 안 걸린다. 오디오를 끄거나(`AudioContext` 제거) crashpad 를 끄거나
 * `--use-angle=d3d11on12` 로 바꿔도 그대로 걸린다 — 플래그로는 못 막는다.
 * 프로세스 트리를 `taskkill /T /F` 로 죽이면 ~0.25초에 사라지고 뒤따르는 Chrome 도 걸리지 않는다.
 *
 * 어떻게: 먼저 트리를 죽이고 나서 `browser.close()` 를 부른다 — 이미 끊긴 연결이라 곧바로 끝나고, puppeteer 가
 * 임시 프로필 폴더(`%TEMP%/puppeteer_dev_chrome_profile-*`)를 지우는 뒷정리는 그대로 탄다. 스모크는 프로필을 다시 쓰지
 * 않으므로(`userDataDir` 을 쓰는 스크립트가 없다) 정상 종료로 잃는 것이 없다. `puppeteer.connect` 로 붙은 브라우저
 * (`process()` 가 null)와 Windows 가 아닌 곳은 예전처럼 정상 종료한다.
 *
 * 쓰는 법: `browser.close()` 대신
 *
 *   import { closeBrowser } from './close-browser.mjs';
 *   await closeBrowser(browser);
 *
 * 던지지 않는다 — 이미 죽은 브라우저를 닫아도 조용히 끝난다.
 */
import { spawnSync } from 'node:child_process';

export async function closeBrowser(browser) {
  if (!browser) return;
  const proc = typeof browser.process === 'function' ? browser.process() : null;
  if (process.platform === 'win32' && proc && proc.pid && proc.exitCode === null) {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  try { await browser.close(); } catch { /* already gone */ }
}
