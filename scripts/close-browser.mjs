/**
 * A shared smoke helper: closes a headless Chrome **without waiting for it** (2026-09-16). Not a smoke — `verify.mjs`
 * only runs the files listed in the `SMOKES` map.
 *
 * Why: on Windows, a Chrome that was rendering through D3D11 (ANGLE) and is closed normally (`browser.close()` →
 * CDP `Browser.close`) **while other Chromes are still rendering** stays alive for **up to 2 minutes** after the browser
 * process drops CDP — 0 CPU, its threads waiting in `LpcReply`. puppeteer waits for that process to end (`hasClosed()`,
 * no timeout), so the smoke process holds its lane that long after every check has already passed. Several stuck at
 * once are released **together** in ~120 s steps — that is what 「a group of smokes finishes in the same second」 is.
 * Measured (7800X3D · RTX 4080 SUPER, `verify:all` on 4 lanes): **2244 s (41 %)** of the 5476 s of smoke process time
 * was this wait, 26 min 46 s over all. To reproduce: close four headless Chromes running the game 15 s apart — only the
 * first takes 0.3 s, the rest 85–220 s. A smoke running on its own, or on SwiftShader, never hits it. Turning audio off
 * (removing `AudioContext`), turning crashpad off, or switching to `--use-angle=d3d11on12` changes nothing — no flag
 * stops it. Killing the process tree with `taskkill /T /F` makes it vanish in ~0.25 s and the Chromes behind it stay clear.
 *
 * `taskkill` is not the whole answer either (2026-09-17, found while chasing E-12 「the middle 8 run at 2×」): a chrome
 * caught in a kernel wait is not reaped the moment it is asked to quit, so **part of the tree survives (usually the two
 * gpu-process + crashpad-handler)**, and puppeteer's `close()` waits **with no timeout** for that process to go and the
 * temp profile folder to be deleted. Measured that day: in two 4-lane runs **all 8 smokes** passed their last check and
 * then stopped in teardown without printing `N passed`, and were still alive 30 minutes later (the runner was only
 * waiting for its lanes to come free). While the leftover chromes lived, even WMI `Win32_Process` enumeration timed out,
 * and the instant they were killed every stalled smoke was released at once — the shape of 「only the middle group runs
 * at 2×」 exactly. So `close()` is **not waited on**: the tree is killed, `CLOSE_GIVE_UP_MS` is given and the rest
 * abandoned. A normal close takes 0–1 ms, so it never hits that limit, and when it does the lane is not held in its place.
 * Confirmed: on the same 16-smoke set · 4 lanes that measured the 2×, **the middle 8 went 141–157 s → 64–84 s** (69–85 s
 * run on their own), the whole set 5 min 6 s · 16/16 green, with 0 chrome processes and 0 temp profiles left behind.
 *
 * How: the tree is killed first, `browser.close()` is raced against a timeout, and the temp profile puppeteer did not
 * get to delete (`%TEMP%/puppeteer_dev_chrome_profile-*`) is removed once by hand. A smoke never reuses a profile
 * (no script passes `userDataDir`), so nothing is lost. Folders that survive even that are swept by `verify.mjs` at the
 * start of a run. A browser attached with `puppeteer.connect` (`process()` is null), and anything not Windows, closes
 * normally as before.
 *
 * How to use it: instead of `browser.close()`
 *
 *   import { closeBrowser } from './close-browser.mjs';
 *   await closeBrowser(browser);
 *
 * It never throws — closing a browser that is already dead ends quietly.
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

/* A normal close takes 0–1 ms (2026-09-17, measured with 1 browser and with 4). Going past this means it is caught in a
   kernel wait, and such a wait has once gone unfinished for 30 minutes, so the lane is abandoned rather than held. */
const CLOSE_GIVE_UP_MS = 5_000;

/** Removes only a temp profile puppeteer itself made — a `userDataDir` the caller chose is left alone. */
function removeTempProfile(proc) {
  const arg = (proc?.spawnargs ?? []).find((a) => a.startsWith('--user-data-dir='));
  const dir = arg?.slice('--user-data-dir='.length).replace(/^"|"$/g, '');
  if (!dir || !/puppeteer_dev_chrome_profile-/.test(dir)) return;
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch { /* a surviving chrome is holding it */ }
}

export async function closeBrowser(browser) {
  if (!browser) return;
  const proc = typeof browser.process === 'function' ? browser.process() : null;
  if (process.platform === 'win32' && proc && proc.pid && proc.exitCode === null) {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  const closed = browser.close().catch(() => { /* already gone */ });
  // The timer is unref'd — this wait must never be the reason the smoke process outlives its work.
  await Promise.race([closed, new Promise((r) => { const t = setTimeout(r, CLOSE_GIVE_UP_MS); t.unref?.(); })]);
  if (process.platform === 'win32') removeTempProfile(proc);
}
