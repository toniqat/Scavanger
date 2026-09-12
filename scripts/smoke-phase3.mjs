// Single-player smoke test for Phase 3: ship-call wheel, cooldown, top-view targeting, airstrike / laser / supply / structures, off-screen indicators.
// Usage: node scripts/smoke-phase3.mjs [http://localhost:5273]   (needs `npm run dev`)
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
// Real GPU through ANGLE D3D11 by default (headless Chrome renders at full speed, CPU stays free). SMOKE_GL=swiftshader falls back to the CPU rasterizer (no GPU / CI).
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

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
  // Never let headless Chrome take a real pointer lock: on Windows it calls ClipCursor and traps the OS cursor inside the
  // hidden 960×540 window at the top-left of the screen. Scripts fake `pointerLockElement` themselves where they need it.
  await page.evaluateOnNewDocument(() => {
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);   // another editor's save must not full-reload the page mid-run (scripts/quiet-hmr.mjs, C-65)
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
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['stratagem:wheelChanged', 'stratagem:armed', 'stratagem:chargeChanged', 'stratagem:targeting', 'stratagem:called', 'stratagem:landed',
      'stratagem:ended', 'stratagem:cooldown', 'structure:damaged', 'structure:destroyed', 'crate:open', 'weapon:fired', 'player:damaged', 'enemy:damaged', 'enemy:killed']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  const keyDown = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true })), code);
  const keyUp = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true })), code);
  const mouseDown = (b) => page.evaluate((x) => window.dispatchEvent(new MouseEvent('mousedown', { button: x })), b);
  const mouseUp = (b) => page.evaluate((x) => window.dispatchEvent(new MouseEvent('mouseup', { button: x })), b);
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  // a tap = keydown + keyup in the same frame (dt is clamped to 50 ms, so any wait between them can read as a hold)
  const key = async (code) => { await page.evaluate((c) => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true })); document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true })); }, code); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const P = (fn, arg) => page.evaluate(fn, arg);

  console.log('mission');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 21 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  ok(await P(() => !!window.__game.ctx.stratagems && !!window.__game.ctx.weapons), 'ctx.stratagems and ctx.weapons published');

  console.log('wheel / arm');
  await key('KeyG');
  await waitSim(0.4);
  let armed = await lastEv('stratagem:armed');
  ok(armed && armed.id !== null, 'G tap arms a call', JSON.stringify(armed));
  const gunBlocked = await P(async () => { const n0 = window.__ev['weapon:fired'].length; window.dispatchEvent(new MouseEvent('mousedown', { button: 0 })); return n0; });
  await waitSim(0.3);
  await mouseUp(0);
  await waitSim(0.2);
  const firedWhileArmed = await P((n0) => window.__ev['weapon:fired'].length - n0, gunBlocked);
  ok(firedWhileArmed === 0, 'gun does not fire while a call is armed', `${firedWhileArmed}`);
  await key('KeyG');
  await waitSim(0.3);
  armed = await lastEv('stratagem:armed');
  ok(armed && armed.id === null, 'G again puts the call away', JSON.stringify(armed));
  await keyDown('KeyG'); await waitSim(0.5);
  let wheel = await lastEv('stratagem:wheelChanged');
  ok(wheel && wheel.open === true, 'G hold opens the ship-call wheel', JSON.stringify(wheel));
  // 2026-09-09: STRATAGEM_ORDER = N 궤도 폭격 · E 보급품 투하 · S 트라이포드 투하 · W 구조선 투하
  await P(() => { window.__game.ctx.input.mouseDX += 80; });
  await waitSim(0.2);
  wheel = await lastEv('stratagem:wheelChanged');
  ok(wheel && wheel.hover === 'supply_drop', 'drag right hovers 보급품 투하 (E)', JSON.stringify(wheel));
  // back to N for the top-view section (the only remaining topview call is 궤도 폭격)
  await P(() => { const i = window.__game.ctx.input; i.mouseDX -= 80; i.mouseDY -= 80; });
  await waitSim(0.2);
  wheel = await lastEv('stratagem:wheelChanged');
  ok(wheel && wheel.hover === 'orbital_laser', 'drag up hovers 궤도 폭격 (N)', JSON.stringify(wheel));
  await keyUp('KeyG'); await waitSim(0.3);
  armed = await lastEv('stratagem:armed');
  ok(armed && armed.id === 'orbital_laser', 'release arms the orbital laser', JSON.stringify(armed));

  console.log('top-view targeting');
  await mouseDown(0);
  await waitSim(1.0);
  let charge = await lastEv('stratagem:chargeChanged');
  ok(charge && charge.t > 0.2 && charge.t < 0.6, 'LMB hold charges (~1/3 after 1 s)', JSON.stringify(charge));
  await waitSim(2.4);
  let tg = await lastEv('stratagem:targeting');
  ok(tg && tg.active === true && tg.kind === 'orbital_laser', 'charge complete → top-view targeting', JSON.stringify(tg));
  const camState = await P(() => { const ctx = window.__game.ctx; const p = ctx.player.position; return { camY: ctx.camera.position.y - p.y, controls: ctx.player.controlsEnabled }; });
  ok(camState.camY > 40, 'camera is high above the player', JSON.stringify(camState));
  await mouseUp(0);
  await waitSim(0.2);
  await P(() => { window.__game.ctx.input.mouseDX += 200; });
  await waitSim(0.3);
  tg = await lastEv('stratagem:targeting');
  const playerPos = await P(() => window.__game.ctx.player.position.toArray());
  const cursorDist = tg && tg.position ? Math.hypot(tg.position[0] - playerPos[0], tg.position[2] - playerPos[2]) : 0;
  ok(cursorDist > 5, 'mouse drag moves the ground cursor', `${cursorDist.toFixed(1)} m`);
  await mouseDown(2); await waitSim(0.1); await mouseUp(2);
  await waitSim(0.3);
  tg = await lastEv('stratagem:targeting');
  armed = await lastEv('stratagem:armed');
  ok(tg && tg.active === false && (await ev('stratagem:called')).length === 0, 'RMB cancels targeting without calling', JSON.stringify(tg));
  await waitSim(1.5); // the override eases back to the rig (damp 4)
  const camBack = await P(() => { const ctx = window.__game.ctx; return ctx.camera.position.y - ctx.player.position.y; });
  ok(camBack < 10, 'camera returns to the rig after cancel', `${camBack.toFixed(1)}`);

  console.log('airstrike via debugCall');
  // target the nearest live bug so the blast has a victim (fallback: 30 m ahead)
  const picked = await P(() => { const ctx = window.__game.ctx; const p = ctx.player.position; const es = ctx.enemies.getEnemies().filter((e) => !e.isDead).sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p)); if (!es.length) return null; const e = es[0]; return { id: e.id, hp: e.hp, t: [e.position.x, e.position.y, e.position.z] }; });
  const target = picked ? picked.t : await P(() => { const ctx = window.__game.ctx; const p = ctx.player.position; const f = ctx.player.getForward(); const t = [p.x + f.x * 30, 0, p.z + f.z * 30]; t[1] = ctx.world.getHeightAt(t[0], t[2]); return t; });
  const bugId = picked ? { id: picked.id, hp: picked.hp } : null;
  const sys = await P((t) => { const s = window.__game.getSystem('stratagems'); const V = window.__game.ctx.player.position.constructor; s.debugCall('airstrike', new V(t[0], t[1], t[2])); return { cd: s.cooldown, total: s.cooldownTotal, calls: s.getCalls().length }; }, target);
  ok(sys.calls === 1, 'debugCall creates the call (debug path skips the cooldown by design)', JSON.stringify(sys));
  const called = await lastEv('stratagem:called');
  ok(called && called.kind === 'airstrike', 'stratagem:called emitted', JSON.stringify(called));
  await P(() => { window.__game.ctx.timeScale = 4; });
  // bugs patrol during the 5 s incoming delay: keep the picked one parked on the target until impact
  await waitFor(page, (a) => { if (a) { const e = window.__game.ctx.enemies.getEnemies().find((x) => x.id === a.id); if (e && !e.isDead) e.position.set(a.t[0], a.t[1], a.t[2]); } return window.__ev['stratagem:landed'].some((e) => e.kind === 'airstrike'); }, 'airstrike landed', 240000, picked ? { id: picked.id, t: target } : null);
  await waitSim(0.3);
  await P(() => { window.__game.ctx.timeScale = 1; });
  ok(true, 'airstrike lands after its delay');
  if (bugId) {
    const bugAfter = await P((id) => { const e = window.__game.ctx.enemies.getEnemies().find((x) => x.id === id); return e ? { hp: e.hp, dead: e.isDead } : null; }, bugId.id);
    ok(!bugAfter || bugAfter.dead || bugAfter.hp < bugId.hp, 'enemy inside the blast took damage', JSON.stringify({ before: bugId.hp, after: bugAfter }));
  }

  console.log('structures');
  await P(() => { const s = window.__game.getSystem('stratagems'); s.debugCooldownReset?.(); });
  const st = await P((t) => { const s = window.__game.getSystem('stratagems'); const V = window.__game.ctx.player.position.constructor; const before = window.__game.ctx.world.getObstaclesNear(t[0], t[2], 12).length; s.debugCall('structure_drop', new V(t[0], t[1], t[2])); return { before }; }, target);
  await P(() => { window.__game.ctx.timeScale = 4; });
  await waitFor(page, () => window.__ev['stratagem:landed'].some((e) => e.kind === 'structure_drop'), 'structures landed', 240000);
  await waitSim(2.5);
  await P(() => { window.__game.ctx.timeScale = 1; });
  const obs = await P((t) => { const w = window.__game.ctx.world; const near = w.getObstaclesNear(t[0], t[2], 12); return { total: near.length, destructible: near.filter((o) => o.destructible).length, count: window.__game.getSystem('stratagems').structureCount }; }, target);
  ok(obs.destructible === 5 && obs.count === 5, '5 destructible cover obstacles registered in the world', JSON.stringify(obs));
  const destroyed = await P((t) => { const w = window.__game.ctx.world; const o = w.getObstaclesNear(t[0], t[2], 12).find((x) => x.destructible); const id = o.destructible.id; o.destructible.onDamage(500); const hpMid = o.destructible.hp; o.destructible.onDamage(5000); const still = w.getObstaclesNear(t[0], t[2], 12).some((x) => x.destructible && x.destructible.id === id); return { hpMid, still, count: window.__game.getSystem('stratagems').structureCount }; }, target);
  ok(destroyed.hpMid === 1500, 'structure hp 2000 → 1500 after 500 damage', `${destroyed.hpMid}`);
  ok(!destroyed.still && destroyed.count === 4, 'destroyed structure leaves the world', JSON.stringify(destroyed));
  ok((await ev('structure:destroyed')).length === 1 && (await ev('structure:damaged')).length >= 1, 'structure:damaged / destroyed emitted');

  console.log('supply drop');
  /* 2026-09-08: a solo death is instant now (no 전투불능 bleed-out), and a dead player stops the world / stratagem
     update — the two long `timeScale 4` waits below would then hang on `stratagem:landed` / `stratagem:ended`.
     The airstrike section above is the one that needs live enemies; from here the field is quiet on purpose. */
  await P(() => {
    const ctx = window.__game.ctx, p = ctx.player;
    ctx.enemies?.setThreatLevel?.(0);
    ctx.enemies?.killAll?.();
    if (p.isDowned) p.revive();
    p.heal(1000);
  });
  await P(() => { const s = window.__game.getSystem('stratagems'); s.debugCooldownReset?.(); });
  const sTarget = await P(() => { const ctx = window.__game.ctx; const p = ctx.player.position; const f = ctx.player.getForward(); const t = [p.x + f.x * 3, 0, p.z + f.z * 3]; t[1] = ctx.world.getHeightAt(t[0], t[2]); return t; });
  await P((t) => { const s = window.__game.getSystem('stratagems'); const V = window.__game.ctx.player.position.constructor; s.debugCall('supply_drop', new V(t[0], t[1], t[2])); }, sTarget);
  await P(() => { window.__game.ctx.timeScale = 4; });
  await waitFor(page, () => window.__ev['stratagem:landed'].some((e) => e.kind === 'supply_drop'), 'supply landed', 240000);
  await P(() => { window.__game.ctx.timeScale = 1; });
  const supply = await P(() => { const all = window.__game.ctx.interactables.all(); const s = all.find((i) => i.id.startsWith('supply:')); if (!s) return { found: false }; s.interact(); return { found: true, prompt: s.getPrompt() }; });
  ok(supply.found, 'supply crate registers an interactable', JSON.stringify(supply));
  const crate = await lastEv('crate:open');
  ok(crate && crate.tier === 5 && String(crate.crateId).startsWith('supply:'), 'interact → crate:open tier 5', JSON.stringify(crate));
  const invOpen = await P(() => window.__game.ctx.inventory.isOpen);
  ok(invOpen, 'inventory loot window opened for the supply crate');
  if (invOpen) { await P(() => window.__game.ctx.inventory.closeAll()); await waitSim(0.3); }
  const afterLoot = await P(() => { const ctx = window.__game.ctx, p = ctx.player;
    return { active: ctx.isGameplayActive(), phase: ctx.phase, dead: p.isDead, downed: p.isDowned, hp: Math.round(p.hp), blockers: [...ctx.uiBlockers] }; });
  ok(afterLoot.active, 'gameplay active again after closing the loot window', JSON.stringify(afterLoot));

  /* ── 2026-09-12: 준비 연출 — 쿨타임이 끝나는 순간 플래시 + 준비된 동안 글로우, 무전 차임 (거절 환불은 약한 플래시 · 무음) ──
   * `stratagem:ready` 는 게임플레이 페이즈에서만 나간다. 예전에는 이 구간이 레이저 **뒤**에 있었는데, 레이저 구간이 timeScale 4 로
   * 수십 초를 흘리는 동안 플레이어가 죽어 함선으로 돌아가면 이벤트가 하나도 안 나와 5개가 한꺼번에 빨갛게 됐다(verify:all 1회).
   * 게임플레이가 확인된 바로 여기서 잰다. */
  console.log('ready flash');
  const rdy0 = await P(async () => {
    const ctx = window.__game.ctx, s = window.__game.getSystem('stratagems'), audio = window.__game.getSystem('audio');
    const m = await import('/src/audio/Synth.ts');
    window.__rdy = { ev: [], snd: [] };
    ctx.bus.on('stratagem:ready', (e) => window.__rdy.ev.push(e.refunded));
    // recorded at AudioSystem.play, before its "is the AudioContext running" gate
    const play = audio.play.bind(audio);
    audio.play = (id, ...rest) => { if (id === 'stratagem_ready') window.__rdy.snd.push(id); return play(id, ...rest); };
    s.startCooldown(0.3);
    const el = document.querySelector('.scall');
    return { sound: typeof m.SOUNDS.stratagem_ready === 'function', dim: el.classList.contains('dim'), ready: el.classList.contains('is-ready'), phase: ctx.phase };
  });
  ok(rdy0.sound, 'SOUNDS defines stratagem_ready');
  ok(rdy0.dim && !rdy0.ready, `cooling ship call: dimmed, no ready glow (${JSON.stringify(rdy0)})`);
  await waitSim(0.6);
  const rdy1 = await P(() => {
    const el = document.querySelector('.scall');
    return { ev: window.__rdy.ev.slice(), snd: window.__rdy.snd.length, major: el.classList.contains('rdy-major'), minor: el.classList.contains('rdy-minor'), ready: el.classList.contains('is-ready'), dim: el.classList.contains('dim'), phase: window.__game.ctx.phase };
  });
  ok(rdy1.ev.length === 1 && rdy1.ev[0] === false, `cooldown ran out → one stratagem:ready {refunded:false} (${JSON.stringify(rdy1)})`);
  ok(rdy1.major && !rdy1.minor && rdy1.ready && !rdy1.dim, `.scall flashes (.rdy-major) and keeps the ready glow (.is-ready) (${JSON.stringify(rdy1)})`);
  ok(rdy1.snd === 1, `stratagem_ready chime requested once (${rdy1.snd})`);
  const rdy2 = await P(() => {
    const s = window.__game.getSystem('stratagems');
    s.startCooldown(5);
    const el = document.querySelector('.scall');
    const cooling = { dim: el.classList.contains('dim'), ready: el.classList.contains('is-ready') };
    s.refundCooldown();                            // a host refusal gives the cooldown back
    return { cooling, ev: window.__rdy.ev.slice(), snd: window.__rdy.snd.length, major: el.classList.contains('rdy-major'), minor: el.classList.contains('rdy-minor'), ready: el.classList.contains('is-ready') };
  });
  ok(rdy2.cooling.dim && !rdy2.cooling.ready, 'a new cooldown turns the ready glow off');
  ok(rdy2.ev.length === 2 && rdy2.ev[1] === true && rdy2.minor && !rdy2.major && rdy2.ready, `refused call refund → stratagem:ready {refunded:true}, weak flash (.rdy-minor), glow back (${JSON.stringify(rdy2)})`);
  ok(rdy2.snd === 1, `no chime for the refund (${rdy2.snd} requests in total)`);
  await P(() => { window.__game.getSystem('stratagems').debugCooldownReset?.(); });   // the laser below calls on a clean cooldown

  console.log('laser');
  // 2026-09-09 (적 체력 ×2): 이 구간은 timeScale 4 로 수십 초를 흘려보내는데, 앞선 폭격에서 살아남은 벌레가
  // 그 사이에 플레이어를 물어 죽이면 레이드가 실패해 함선으로 돌아가고 호출 목록이 통째로 비워진다 —
  // 레이저가 제 시간에 끝나는지와는 아무 상관 없는 실패다. 주변을 비우고 체력을 채운 뒤 잰다.
  await P(() => {
    const ctx = window.__game.ctx;
    ctx.enemies.setThreatLevel(0);
    ctx.enemies.applyExplosion(ctx.player.position, 120, 99999);
    ctx.player.applyStim(ctx.player.maxHp);
  });
  await waitSim(2);
  await P(() => { const s = window.__game.getSystem('stratagems'); s.debugCooldownReset?.(); });
  await P((t) => { const s = window.__game.getSystem('stratagems'); const V = window.__game.ctx.player.position.constructor; s.debugCall('orbital_laser', new V(t[0], t[1], t[2])); }, target);
  await P(() => { window.__game.ctx.timeScale = 4; });
  await waitFor(page, () => window.__ev['stratagem:landed'].some((e) => e.kind === 'orbital_laser'), 'laser ignited', 240000);
  const laserActive = await P(() => window.__game.getSystem('stratagems').getCalls().some((c) => c.kind === 'orbital_laser' && c.stage === 'active'));
  ok(laserActive, 'laser call is active after landing');
  await waitFor(page, () => window.__ev['stratagem:ended'].some((e) => e.kind === 'orbital_laser'), 'laser ended', 60000)
    .catch(async (e) => { console.log('  state:', JSON.stringify(await P(() => { const ctx = window.__game.ctx, p = ctx.player; return { phase: ctx.phase, dead: p.isDead, downed: p.isDowned, active: ctx.isGameplayActive(), calls: window.__game.getSystem('stratagems').getCalls().map((c) => `${c.kind}:${c.stage}`) }; }))); throw e; });
  await P(() => { window.__game.ctx.timeScale = 1; });
  ok(true, 'laser ends after its duration');

  console.log('hud');
  const hud = await P(() => ({
    swheel: !!document.querySelector('.swheel'),
    panel: !!document.querySelector('.scall .sc-thumb'),
    offscr: !!document.querySelector('.offscr'),
  }));
  ok(hud.swheel, 'stratagem wheel element exists');
  ok(hud.panel, '함선 호출 썸네일(.scall .sc-thumb)이 있다 — 2026-09-10 2차에 .strat-panel 텍스트 패널을 대신했다');
  ok(hud.offscr, 'off-screen indicator layer exists');
  const grenViews = await P(() => Array.isArray(window.__game.ctx.weapons.getGrenades()));
  ok(grenViews, 'ctx.weapons.getGrenades() returns a list');

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
