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
 * 그런데 `taskkill` 도 만능이 아니다 (2026-09-17, E-12 「중간 8개가 2배」 추적 중 확인): 커널 대기에 걸린 chrome 은
 * 종료 요청을 받고도 곧바로 회수되지 않아 **트리 일부(대개 gpu-process + crashpad-handler 2개)가 살아남고**, puppeteer 의
 * `close()` 는 그 프로세스가 사라지고 임시 프로필 폴더가 지워질 때까지 **제한 시간 없이** 기다린다. 그날 실측: 4레인 실행
 * 두 번에서 **스모크 8개 전부**가 마지막 검사를 통과한 뒤 `N passed` 를 찍지 못한 채 teardown 에서 멈췄고, 30분 뒤에도
 * 살아 있었다(러너는 레인이 풀리기만 기다렸다). 남은 chrome 이 살아 있는 동안은 WMI `Win32_Process` 열거까지 타임아웃하고,
 * 그것들을 죽이는 순간 멈춰 있던 스모크가 한꺼번에 풀렸다 — 「중간 묶음만 2배」의 모양 그대로다.
 * 그래서 `close()` 를 **기다리지 않는다**: 트리를 죽인 뒤 `CLOSE_GIVE_UP_MS` 만 기다리고 버린다. 정상 종료는 0~1 ms 라
 * 이 시간에 걸릴 일이 없고, 걸린 경우에는 레인이 대신 붙잡히지 않는다.
 * 확인: 이전에 2배를 잰 것과 같은 16개 묶음 · 4레인에서 **중간 8개가 141~157 s → 64~84 s**(단독 실행값 69~85 s)로 돌아오고
 * 전체가 5분 6초 · 16/16 초록, 끝난 직후 chrome 프로세스 0 · 남은 임시 프로필 0 이었다.
 *
 * 어떻게: 먼저 트리를 죽이고 `browser.close()` 를 제한 시간과 경주시킨 뒤, puppeteer 가 못 지우고 간 임시 프로필
 * (`%TEMP%/puppeteer_dev_chrome_profile-*`)을 직접 한 번 지운다. 스모크는 프로필을 다시 쓰지 않으므로
 * (`userDataDir` 을 쓰는 스크립트가 없다) 잃는 것이 없다. 그래도 남는 폴더는 `verify.mjs` 가 실행 시작에 쓸어낸다.
 * `puppeteer.connect` 로 붙은 브라우저(`process()` 가 null)와 Windows 가 아닌 곳은 예전처럼 정상 종료한다.
 *
 * 쓰는 법: `browser.close()` 대신
 *
 *   import { closeBrowser } from './close-browser.mjs';
 *   await closeBrowser(browser);
 *
 * 던지지 않는다 — 이미 죽은 브라우저를 닫아도 조용히 끝난다.
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

/* 정상 종료는 0~1 ms 다 (2026-09-17, 브라우저 1대 · 4대 실측). 이 시간을 넘긴다는 것은 커널 대기에 걸렸다는 뜻이고,
   그 대기는 30분도 안 끝난 적이 있으므로 레인을 붙잡지 않고 버린다. */
const CLOSE_GIVE_UP_MS = 5_000;

/** puppeteer 가 만든 임시 프로필만 지운다 — 사용자가 지정한 `userDataDir` 은 건드리지 않는다. */
function removeTempProfile(proc) {
  const arg = (proc?.spawnargs ?? []).find((a) => a.startsWith('--user-data-dir='));
  const dir = arg?.slice('--user-data-dir='.length).replace(/^"|"$/g, '');
  if (!dir || !/puppeteer_dev_chrome_profile-/.test(dir)) return;
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch { /* 살아남은 chrome 이 쥐고 있다 */ }
}

export async function closeBrowser(browser) {
  if (!browser) return;
  const proc = typeof browser.process === 'function' ? browser.process() : null;
  if (process.platform === 'win32' && proc && proc.pid && proc.exitCode === null) {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  const closed = browser.close().catch(() => { /* already gone */ });
  // 타이머는 unref — 이 대기 때문에 스모크 프로세스가 더 살아 있으면 안 된다.
  await Promise.race([closed, new Promise((r) => { const t = setTimeout(r, CLOSE_GIVE_UP_MS); t.unref?.(); })]);
  if (process.platform === 'win32') removeTempProfile(proc);
}
