// 2026-09-12 조준 흔들림 (A2, docs/plans/consumables-keys-favorites.md §1-1) — 정조준 중 카메라가 8자로 떠돈다.
//  · 함선(허브)에서는 흔들림이 없다 · 무기 계열의 흔들림(data/aim_sway.csv)이 rig 에 들어간다 · 허리 사격은 0
//  · 정조준: 좌우 · 위아래가 시간에 따라 부호를 바꾸며 흔들리고 크기는 표의 값이다 · 렌더된 카메라 방향 === getLookDir (크로스헤어 선)
//  · 흔들림 한가운데서 쏜 탄(퍼짐 0)이 **화면 중심 선** 위에 떨어진다 (흔들림을 뺀 선에서는 벗어난다) · 반동은 그대로
//  · `aimSwayMul` 0.5 → 절반 · 앉기 < 서기 · 엎드리기 ≪ 서기 · 걸으면 커진다 · 어깨 전환 X 는 그대로 · 연출 카메라 · 조준 해제 → 0
// Usage: node scripts/smoke-aim-sway.mjs [http://localhost:5273]   (needs `npm run dev`)
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

// the tables the game reads (plain comma rows, no quoted cells in the columns used here)
const csvLines = (f) => readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
const SWAY = Object.fromEntries(csvLines('aim_sway.csv').slice(1).map((l) => { const [c, a, h] = l.split(','); return [c, { amp: Number(a), hz: Number(h) }]; }));
const CONST = Object.fromEntries(csvLines('constants.csv').map((l) => l.split(',')).filter((c) => c[0].startsWith('AIM_SWAY_')).map((c) => [c[0], Number(c[1])]));
const DEG = Math.PI / 180;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch (e) { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=960,540', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const keyDown = (c) => page.evaluate((x) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: x, key: x, bubbles: true })), c);
  const keyUp = (c) => page.evaluate((x) => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: x, key: x, bubbles: true })), c);
  const mDown = (b) => page.evaluate((x) => document.body.dispatchEvent(new MouseEvent('mousedown', { button: x, bubbles: true })), b);
  const mUp = (b) => page.evaluate((x) => document.body.dispatchEvent(new MouseEvent('mouseup', { button: x, bubbles: true })), b);
  const swayNow = () => page.evaluate(() => {
    const rig = window.__game.getSystem('player').rig; const p = window.__game.ctx.player;
    return { amp: rig.swayAmplitude, yaw: rig.swayYaw, pitch: rig.swayPitch, aiming: p.isAiming, profile: rig.swayAmp, hz: rig.swayHz, side: rig.shoulderSide };
  });
  /** Record the sway on every task tick for `sec` of simulation time. */
  const record = async (sec) => {
    await page.evaluate(() => {
      const rig = window.__game.getSystem('player').rig; const ctx = window.__game.ctx;
      window.__sw = []; window.__swT = setInterval(() => window.__sw.push({ t: ctx.time, yaw: rig.swayYaw, pitch: rig.swayPitch, amp: rig.swayAmplitude }), 8);
    });
    await waitSim(sec);
    return page.evaluate(() => { clearInterval(window.__swT); return window.__sw; });
  };
  const signChanges = (xs) => { let n = 0, s = 0; for (const x of xs) { const k = Math.sign(x); if (k && s && k !== s) n++; if (k) s = k; } return n; };

  console.log('함선: 흔들림 없음');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await sleep(1500);   // the server profile documents land a beat after the hub
  const armed = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const sr = ctx.loot.createItem('wpn_sr');
    const added = inv.tryAddItem(sr) && inv.equip(sr.uid, 'primary');
    for (const it of inv.getAllItems()) if (it.defId.startsWith('wpn_') && it.uid !== sr.uid) inv.takeItem(it.uid);
    inv.tryAddItem(ctx.loot.createItem('ammo_heavy', 25));
    return { added, primary: inv.getLoadout().primary?.defId };
  });
  ok(armed.added && armed.primary === 'wpn_sr', '저격소총 I equipped on the ship', JSON.stringify(armed));
  await mDown(2); await waitSim(1.0);
  const hub = await swayNow();
  await mUp(2);
  ok(hub.amp === 0 && hub.yaw === 0 && hub.pitch === 0, 'hub: RMB never sways the camera', JSON.stringify(hub));

  console.log('레이드: 계열 흔들림 · 허리 사격');
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 7 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
  await page.evaluate(() => window.__game.ctx.enemies?.killAll?.());
  await tap('Digit1');
  await waitSim(1.2);
  const prof = await swayNow();
  ok(Math.abs(prof.profile - SWAY.SR.amp * DEG) < 1e-9 && Math.abs(prof.hz - SWAY.SR.hz) < 1e-9,
    `SR in hand → rig sway profile = aim_sway.csv SR (${SWAY.SR.amp}° @ ${SWAY.SR.hz} Hz)`, JSON.stringify(prof));
  const hip = await record(1.5);
  ok(hip.length > 10 && hip.every((s) => s.amp === 0 && s.yaw === 0 && s.pitch === 0), `hip (no RMB): no sway over 1.5 s (${hip.length} samples)`);

  console.log('정조준: 8자 흔들림 · 렌더 === 조준선');
  await page.evaluate(() => { const p = window.__game.getSystem('player'); p.rig.yaw = 0.3; p.rig.pitch = -0.05; });
  await mDown(2);
  await waitSim(1.5);
  const ads = await record(3.4);   // ≥ one full yaw period at 0.32 Hz
  const A = SWAY.SR.amp * DEG;
  const yaws = ads.map((s) => s.yaw), pitches = ads.map((s) => s.pitch);
  const yawRange = Math.max(...yaws) - Math.min(...yaws), pitchRange = Math.max(...pitches) - Math.min(...pitches);
  const ampMean = ads.reduce((a, s) => a + s.amp, 0) / Math.max(1, ads.length);
  ok(Math.abs(ampMean - A) < A * 0.08, `standing ADS amplitude ≈ table (${(ampMean / DEG).toFixed(3)}° vs ${SWAY.SR.amp}°)`);
  ok(yawRange > 1.6 * A && yawRange < 2.1 * A, `yaw swings side to side (range ${(yawRange / DEG).toFixed(3)}° ≈ 2A)`);
  ok(pitchRange > 1.4 * A * CONST.AIM_SWAY_PITCH_RATIO && pitchRange < 2.1 * A * CONST.AIM_SWAY_PITCH_RATIO, `pitch swings at the pitch ratio (range ${(pitchRange / DEG).toFixed(3)}°)`);
  ok(signChanges(yaws) >= 2 && signChanges(pitches) >= 3, `figure-8: yaw crosses centre ${signChanges(yaws)}×, pitch ${signChanges(pitches)}× (twice as fast)`);
  // between frames: the frame the rig rendered looks exactly along `getLookDir` (= the shot line), sway included
  const agree = await page.evaluate(() => {
    const ctx = window.__game.ctx; const rig = window.__game.getSystem('player').rig; const V = ctx.camera.position.constructor;
    const cam = new V(); ctx.camera.getWorldDirection(cam);
    const look = new V(); rig.getLookDir(look);
    const o = new V(), d = new V(); ctx.player.getAimRay(o, d);
    const p = rig.pitch + rig.recoilPitch, y = rig.yaw + rig.recoilYaw, cp = Math.cos(p);
    const bare = new V(-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp);
    return { camLook: cam.angleTo(look), camAim: cam.angleTo(d), originOff: o.distanceTo(ctx.camera.position), camBare: cam.angleTo(bare), sway: Math.hypot(rig.swayYaw, rig.swayPitch) };
  });
  ok(agree.camLook < 2e-3 && agree.camAim < 2e-3, `rendered camera forward = getLookDir = getAimRay (${agree.camLook.toExponential(1)} rad)`, JSON.stringify(agree));
  ok(agree.originOff < 0.05, `aim origin = camera position (${agree.originOff.toFixed(3)} m)`);
  ok(agree.sway < 1e-4 || Math.abs(agree.camBare - agree.sway) < Math.max(3e-3, agree.sway * 0.35), `the rendered view is offset by the sway itself (${(agree.camBare / DEG).toFixed(3)}° vs sway ${(agree.sway / DEG).toFixed(3)}°)`, JSON.stringify(agree));

  console.log('흔들림 속 사격: 화면 중심 선 위 · 반동 유지');
  await page.evaluate(() => {
    const ctx = window.__game.ctx; const w = window.__game.getSystem('weapons');
    for (const k of ['primary', 'primary2', 'secondary']) { const sl = w.slots[k]; if (sl) { sl.stats.spread = 0; sl.stats.adsSpread = 0; } }
    // test hook: a large sway so a miss would be metres, not centimetres. Pinned — a weapon refresh (`applyAimZoom` on
    // `inventory:itemUpdated` / `loadout:changed`) would otherwise put the table value back before the trigger is pulled.
    const pl = window.__game.getSystem('player');
    pl.rig.setAimSway(1.5, 0.32);
    ctx.player.setAimSway = () => {};
    window.__hits = [];
    ctx.bus.on('weapon:hit', (h) => {
      // at the moment of the shot the camera still shows the frame the player pulled the trigger on
      const cam = ctx.camera; const V = cam.position.constructor; const rig = window.__game.getSystem('player').rig;
      const dir = new V(); cam.getWorldDirection(dir);
      const e = new cam.rotation.constructor().setFromQuaternion(cam.quaternion, 'YXZ');
      const pb = e.x - rig.swayPitch, yb = e.y - rig.swayYaw, cp = Math.cos(pb);
      const bare = new V(-Math.sin(yb) * cp, Math.sin(pb), -Math.cos(yb) * cp);
      const offOf = (d) => { const r = new V().subVectors(h.point, cam.position); return r.sub(d.clone().multiplyScalar(r.dot(d))).length(); };
      window.__hits.push({ dist: h.point.distanceTo(cam.position), off: offOf(dir), bareOff: offOf(bare), sway: Math.hypot(rig.swayYaw, rig.swayPitch) });
    });
  });
  // aim the camera centre at the ground ~25 m out (yaw scan + pitch bisection, same as smoke-weapons)
  const aim = await page.evaluate((D) => {
    const ctx = window.__game.ctx; const rig = window.__game.getSystem('player').rig; const cam = ctx.camera; const V = cam.position.constructor;
    for (let yi = 0; yi < 24; yi++) {
      const yaw = yi * Math.PI / 12;
      let lo = -0.7, hi = 0.05;
      for (let k = 0; k < 26; k++) {
        const p = (lo + hi) / 2; const cp = Math.cos(p);
        const r = ctx.world.raycast(cam.position, new V(-Math.sin(yaw) * cp, Math.sin(p), -Math.cos(yaw) * cp), 900);
        if ((r ? r.distance : 1e9) < D) lo = p; else hi = p;
      }
      const p = (lo + hi) / 2; const cp = Math.cos(p);
      const r = ctx.world.raycast(cam.position, new V(-Math.sin(yaw) * cp, Math.sin(p), -Math.cos(yaw) * cp), 900);
      if (r && Math.abs(r.distance - D) < D * 0.15) { rig.yaw = yaw; rig.pitch = p; return { yaw, pitch: p, dist: r.distance }; }
    }
    return null;
  }, 25);
  ok(!!aim, 'found a look line that meets the ground ~25 m out', JSON.stringify(aim));
  await waitSim(1.3);   // the stubbed amplitude damps in
  // pull the trigger near a swing peak so the sway-less line is clearly off
  await waitFor(page, (lim) => { const r = window.__game.getSystem('player').rig; return Math.abs(r.swayYaw) > lim; }, 'sway peak', 20000, 1.0 * DEG);
  const pitchBefore = await page.evaluate(() => window.__game.getSystem('player').rig.pitch);
  await mDown(0); await waitSim(0.1); await mUp(0);
  await waitSim(0.15);
  const shot = await page.evaluate(() => ({ hits: window.__hits.slice(), pitch: window.__game.getSystem('player').rig.pitch }));
  const h0 = shot.hits[0];
  ok(shot.hits.length === 1 && h0.off < 0.08, `shot lands on the rendered crosshair ray under sway: ${h0?.off?.toFixed(3)} m off at ${h0?.dist?.toFixed(1)} m`, JSON.stringify(shot.hits));
  if (h0 && h0.sway > 0.4 * DEG) ok(h0.bareOff > 0.12 && h0.bareOff > h0.off * 3, `…and not on the sway-less line (${h0.bareOff.toFixed(3)} m off — sway ${(h0.sway / DEG).toFixed(2)}°)`);
  else console.log(`  note sway at the shot was ${(h0?.sway / DEG).toFixed(2)}° — sway-less comparison skipped`);
  ok(shot.pitch - pitchBefore > 0.05 * DEG, `recoil still kicks the view up (+${((shot.pitch - pitchBefore) / DEG).toFixed(2)}°)`);
  await page.evaluate((s) => { const p = window.__game.ctx.player; delete p.setAimSway; p.setAimSway(s.amp, s.hz); }, SWAY.SR);
  await waitSim(1.8);   // bolt cycle + the amplitude damps back

  console.log('배수: aimSwayMul · 자세 · 이동');
  const settle = async (sec = 1.4) => { await waitSim(sec); const r = await record(0.4); return r.reduce((a, s) => a + s.amp, 0) / Math.max(1, r.length); };
  const stand = await settle(0.6);
  ok(Math.abs(stand - A) < A * 0.08, `standing back to the table amplitude (${(stand / DEG).toFixed(3)}°)`);
  await page.evaluate(() => Object.defineProperty(window.__game.ctx.player, 'aimSwayMul', { get: () => 0.5, configurable: true }));
  const half = await settle();
  await page.evaluate(() => { delete window.__game.ctx.player.aimSwayMul; });
  ok(Math.abs(half / stand - 0.5) < 0.06, `aimSwayMul 0.5 → half the sway (${(half / stand).toFixed(3)}×)`);
  await settle(0.8);
  await tap('KeyC');
  const crouch = await settle(1.6);
  const crouchState = await page.evaluate(() => window.__game.ctx.player.stance);
  ok(Math.abs(crouch / stand - CONST.AIM_SWAY_CROUCH_MUL) < 0.08, `crouch (${crouchState}): ${(crouch / stand).toFixed(3)}× (csv ${CONST.AIM_SWAY_CROUCH_MUL})`);
  await page.evaluate(() => window.__game.getSystem('player').setStance('prone'));
  const prone = await settle(2.2);
  const stillAiming = await page.evaluate(() => window.__game.ctx.player.isAiming);
  ok(stillAiming && Math.abs(prone / stand - CONST.AIM_SWAY_PRONE_MUL) < 0.06 && prone < crouch, `prone: ${(prone / stand).toFixed(3)}× (csv ${CONST.AIM_SWAY_PRONE_MUL}) < crouch`);
  await page.evaluate(() => window.__game.getSystem('player').setStance('stand'));
  await settle(1.6);
  await keyDown('KeyW');
  await waitSim(1.4);
  const walk = await page.evaluate(() => { const p = window.__game.getSystem('player'); return { amp: p.rig.swayAmplitude, speed: p.controller.speed }; });
  await keyUp('KeyW');
  ok(walk.speed > 0.5 && walk.amp > stand * 1.2, `moving while aiming sways more (${(walk.amp / stand).toFixed(2)}× at ${walk.speed.toFixed(2)} m/s)`, JSON.stringify(walk));

  console.log('어깨 전환 · 연출 카메라 · 조준 해제');
  await settle(1.4);
  await tap('KeyX');
  const left = await settle(0.8);
  const side = await swayNow();
  ok(side.side === -1 && Math.abs(left - A) < A * 0.1, `X → left shoulder, sway unchanged (${(left / DEG).toFixed(3)}°)`, JSON.stringify(side));
  await tap('KeyX'); await waitSim(0.6);
  ok((await swayNow()).side === 1, 'X again → right shoulder');
  await page.evaluate(() => {
    const ctx = window.__game.ctx; const V = ctx.camera.position.constructor;
    ctx.player.setCameraOverride(ctx.camera.position.clone().add(new V(0, 6, 0)), ctx.player.position.clone(), true);
  });
  await waitSim(1.5);
  const over = await swayNow();
  await page.evaluate(() => window.__game.ctx.player.setCameraOverride(null, undefined, true));
  ok(over.amp < A * 0.02, `cutscene camera override: the sway fades out (${(over.amp / DEG).toFixed(4)}°)`, JSON.stringify(over));
  await settle(1.4);
  await mUp(2);
  await waitSim(2.5);
  const off = await swayNow();
  ok(!off.aiming && off.amp < 1e-6 && off.yaw === 0 && off.pitch === 0, 'RMB released → the sway is gone and the phase back at the centre', JSON.stringify(off));

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
