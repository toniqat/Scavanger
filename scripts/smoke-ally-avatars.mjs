// 2026-09-15 (안드로이드 분대원 — src/player): `ctx.allies` 가 말하는 몸을 player 가 어떻게 그리는가.
// `remotePlayers.debugAllyBody()` 로 몸을 주입해 allies/ 없이도 검사한다: 안드로이드 외형(얼굴 조각 교체 · SoldierModel.isAndroid) ·
// 자세 매핑(stand · crouch · downed · dormant = 회색 + 실루엣 없음 · carry) · 감춰진 · 죽은 몸은 그리지 않음 · 손에 든 총 · 방탄복 판 ·
// 몸 풀 재사용(같은 SoldierModel 이 돌아온다) · 쓰러진 기의 `revive:ally:<id>` 상호작용(프롬프트 · 완료 → requestRevive) ·
// 안드로이드가 업은 로컬 플레이어(`carrierOf` → setCarriedBy) · `ally:fired` 연출이 씬의 점광원 개수를 바꾸지 않는다 ·
// 안드로이드 얼굴 초상 · 분대에 안드로이드가 있으면 솔로 PC 도 즉사하지 않고 쓰러진다.
// Usage: node scripts/smoke-ally-avatars.mjs [http://localhost:5273]   (needs `npm run dev`)
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
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
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.player, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['audio:play', 'remote:footstep', 'player:downed', 'player:died', 'player:revived', 'ui:notify']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
    window.__rp = window.__game.getSystem('remotePlayers');
    window.__V = window.__game.ctx.player.position.constructor;
    window.__lights = () => { let n = 0; window.__game.ctx.scene.traverse((o) => { if (o.isPointLight) n++; }); return n; };
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);

  console.log('mission (seed 21)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 21 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
  await waitSim(0.3);

  console.log('debug hook: the injected body gets an android avatar');
  const a0 = await P(() => {
    const rp = window.__rp; const p = window.__game.ctx.player;
    const pos = p.position.clone(); pos.x += 1.6;
    const body = rp.debugAllyBody({ id: 'ally-a', slot: 1, position: pos, yaw: 0.3, weaponDefId: 'ar', armorDefId: 'armor_2' });
    window.__b = body;
    return { made: !!body, hook: typeof rp.debugAllyBodies === 'function' };
  });
  ok(a0.made && a0.hook, 'debugAllyBody / debugAllyBodies hooks exist', JSON.stringify(a0));
  await waitSim(0.5);
  const a1 = await P(() => {
    const av = window.__rp.getAllyAvatars().getAvatar('ally-a');
    const m = av && av.model;
    return {
      has: !!av, shown: av && av.isShown, isAndroid: m && m.isAndroid,
      weapon: av && av.heldWeaponId, gun: av ? av.weaponSocket.children.map((c) => c.name) : [],
      armor: m && m.armorId, name: av && av.root.name,
    };
  });
  ok(a1.has && a1.shown, 'a body in the list gets a drawn avatar', JSON.stringify(a1));
  ok(a1.isAndroid === true, 'SoldierModel.setAndroidLook(true) is applied', JSON.stringify(a1));
  ok(a1.weapon === 'ar' && a1.gun.some((n) => String(n).startsWith('HeldWeapon:')), 'weaponDefId → a gun in the hand', JSON.stringify(a1));
  ok(a1.armor !== null, 'armorDefId → armor plates on the torso', JSON.stringify(a1));

  const look = await P(() => {
    const m = window.__rp.getAllyAvatars().getAvatar('ally-a').model;
    // 안드로이드 조각(얼굴판 · 바이저 띠 · 관절)과 사람 얼굴 조각(볏 · 바이저 · 챙)의 visible 이 정확히 반대여야 한다
    const before = { on: m.isAndroid };
    m.setAndroidLook(false);
    const human = [];
    m.headPivot.children.forEach((c) => human.push(c.visible));
    m.setAndroidLook(true);
    const android = [];
    m.headPivot.children.forEach((c) => android.push(c.visible));
    const flipped = human.length === android.length && human.some((v, i) => v !== android[i]);
    return { before, flipped, n: human.length, isAndroid: m.isAndroid };
  });
  ok(look.flipped && look.isAndroid, 'the head swaps between the human and the android parts', JSON.stringify(look));

  console.log('pose mapping');
  const poseOf = async (pose, extra = {}) => {
    await P((arg) => { Object.assign(window.__b, { pose: arg.pose }, arg.extra); }, { pose, extra });
    await waitSim(0.7);
    return P(() => {
      const av = window.__rp.getAllyAvatars().getAvatar('ally-a');
      const p = av.poseView;
      return { shown: av.isShown, greyed: av.isGreyed, sil: av.model.silhouetteVisible, crouch: p.crouch, prone: p.prone, downed: p.downed, carry: p.carry };
    });
  };
  const pCrouch = await poseOf('crouch');
  ok(pCrouch.shown && pCrouch.crouch > 0.6 && pCrouch.downed < 0.2, 'pose crouch → crouch blend', JSON.stringify(pCrouch));
  const pDowned = await poseOf('downed', { downed: true });
  ok(pDowned.shown && pDowned.downed > 0.6 && pDowned.prone > 0.5 && pDowned.crouch < 0.2, 'pose downed → downed + prone', JSON.stringify(pDowned));
  const pCarry = await poseOf('carry', { downed: false });
  ok(pCarry.shown && pCarry.carry > 0.6 && pCarry.downed < 0.2, 'pose carry → fireman carry blend', JSON.stringify(pCarry));
  const pDormant = await poseOf('dormant', { mode: 'dormant' });
  ok(pDormant.shown && pDormant.greyed && !pDormant.sil, 'pose dormant → grey, dim visor, no silhouette', JSON.stringify(pDormant));
  const pStand = await poseOf('stand', { mode: 'raid' });
  ok(pStand.shown && !pStand.greyed && pStand.sil, 'back to stand → colour + silhouette', JSON.stringify(pStand));

  console.log('hidden / dead bodies are not drawn');
  await P(() => { window.__b.hidden = true; });
  await waitSim(0.3);
  const hid = await P(() => ({ shown: window.__rp.getAllyAvatars().getAvatar('ally-a').isShown }));
  await P(() => { window.__b.hidden = false; window.__b.pose = 'dead'; window.__b.dead = true; });
  await waitSim(0.3);
  const dead = await P(() => ({ shown: window.__rp.getAllyAvatars().getAvatar('ally-a').isShown }));
  await P(() => { window.__b.pose = 'stand'; window.__b.dead = false; });
  await waitSim(0.3);
  ok(!hid.shown, 'hidden body → nothing drawn', JSON.stringify(hid));
  ok(!dead.shown, 'dead body → nothing drawn (the corpse object stands there)', JSON.stringify(dead));

  console.log('pooled reuse');
  const reuse = await P(() => {
    const rp = window.__rp; const mgr = rp.getAllyAvatars();
    window.__model = mgr.getAvatar('ally-a').model;
    rp.debugAllyClear('ally-a');
    return { before: mgr.size };
  });
  await waitSim(0.3);
  const reuse2 = await P(() => {
    const rp = window.__rp; const mgr = rp.getAllyAvatars();
    const gone = mgr.size;
    const p = window.__game.ctx.player;
    const pos = p.position.clone(); pos.x += 1.6;
    window.__b = rp.debugAllyBody({ id: 'ally-a', slot: 1, position: pos, weaponDefId: 'ar' });
    return { gone };
  });
  await waitSim(0.3);
  const reuse3 = await P(() => {
    const m = window.__rp.getAllyAvatars().getAvatar('ally-a').model;
    return { same: m === window.__model, android: m.isAndroid, greyed: m.isGreyed, armor: m.armorId };
  });
  ok(reuse.before === 1 && reuse2.gone === 0, 'a body that leaves the list releases its avatar', JSON.stringify({ ...reuse, ...reuse2 }));
  ok(reuse3.same && reuse3.android && !reuse3.greyed && reuse3.armor === null, 'the same SoldierModel comes back from the pool, reset and android again', JSON.stringify(reuse3));

  console.log('revive interactable on a downed body');
  await P(() => {
    const ctx = window.__game.ctx;
    window.__calls = [];
    // `ctx.allies` 는 클래스 인스턴스일 수 있어 Object.assign 으로는 메서드가 안 넘어온다 — 계약 전체를 직접 세운다
    window.__allies0 = ctx.allies;
    ctx.allies = {
      roster: [], simulating: false,
      getBodies: () => [], getBody: () => null, getCombatBodies: () => [], getLoadout: () => null,
      damage: () => {}, carrierOf: () => null,
      requestRevive: (id) => { window.__calls.push(id); return true; },
    };
    Object.assign(window.__b, { pose: 'downed', downed: true, downHp: 80, mode: 'raid', name: '안드로이드 알파' });
  });
  await waitSim(0.4);
  const rv = await P(() => {
    const mgr = window.__rp.getAllyAvatars();
    const targets = mgr.getReviveTargets();
    const all = window.__game.ctx.interactables.all().filter((i) => i.id === 'revive:ally:ally-a');
    const i = all[0];
    return {
      targets, id: i && i.id, prompt: i && i.getPrompt(), can: i && i.canInteract(), hold: i && i.holdTime,
      d: i ? i.position.distanceTo(window.__b.position) : -1,
    };
  });
  ok(rv.targets.includes('ally-a') && rv.id === 'revive:ally:ally-a', 'a downed android offers revive:ally:<id>', JSON.stringify(rv));
  ok(rv.prompt === '안드로이드 알파 일으키기' && rv.can === true && rv.hold > 0, 'prompt / gates / hold time', JSON.stringify(rv));
  ok(rv.d < 0.05, 'the prompt follows the body', String(rv.d));
  const rv2 = await P(() => {
    const i = window.__game.ctx.interactables.all().find((x) => x.id === 'revive:ally:ally-a');
    i.interact();
    return { calls: window.__calls.slice(), left: window.__rp.getAllyAvatars().getReviveTargets() };
  });
  ok(rv2.calls.length === 1 && rv2.calls[0] === 'ally-a', 'the completed hold calls ctx.allies.requestRevive(id)', JSON.stringify(rv2));
  ok(!rv2.left.includes('ally-a'), 'the prompt is taken away until the body stands up', JSON.stringify(rv2));
  await P(() => { Object.assign(window.__b, { pose: 'stand', downed: false, downHp: 0 }); });
  await waitSim(0.3);

  console.log('carried by an android');
  const c1 = await P(() => {
    const ctx = window.__game.ctx;
    window.__b.carrying = ctx.net && ctx.net.localId ? ctx.net.localId : 'local';
    window.__b.pose = 'carry';
    return { peer: window.__b.carrying };
  });
  await waitSim(0.4);
  const c2 = await P(() => {
    const p = window.__game.ctx.player;
    const av = window.__rp.getAllyAvatars().getAvatar('ally-a');
    return { isCarried: p.isCarried, onSocket: p.object.parent === av.shoulderSocket };
  });
  ok(c2.isCarried && c2.onSocket, 'ctx.allies.carrierOf(me) → the local body hangs on the android shoulder socket', JSON.stringify({ ...c1, ...c2 }));
  await P(() => { window.__b.carrying = null; window.__b.pose = 'stand'; });
  await waitSim(0.4);
  const c3 = await P(() => {
    const p = window.__game.ctx.player;
    return { isCarried: p.isCarried, inScene: p.object.parent === window.__game.ctx.scene };
  });
  ok(!c3.isCarried && c3.inScene, 'put down again → the body is back in the scene', JSON.stringify(c3));

  console.log('ally:fired FX never changes the scene point-light count');
  const fx = await P(() => {
    const ctx = window.__game.ctx; const V = window.__V;
    const before = window.__lights();
    const audio0 = window.__ev['audio:play'].length;
    const from = ctx.player.position.clone(); from.y += 1.2;
    const to = from.clone(); to.x += 25;
    for (let i = 0; i < 6; i++) ctx.bus.emit('ally:fired', { id: 'ally-a', from, to, weaponDefId: 'ar' });
    const shots = window.__ev['audio:play'].slice(audio0).filter((e) => String(e.id).startsWith('shot_'));
    return { before, after: window.__lights(), shots: shots.length, id: shots[0] && shots[0].id };
  });
  ok(fx.after === fx.before, `ally:fired keeps the point-light count (${fx.before})`, JSON.stringify(fx));
  ok(fx.shots === 6 && fx.id === 'shot_rifle', 'every shot plays the weapon class sound', JSON.stringify(fx));

  console.log('android face portrait');
  const face = await P(() => {
    const p = window.__game.ctx.player;
    const has = typeof p.snapshotAndroidFace === 'function';
    const a = has ? p.snapshotAndroidFace({ accent: '#7fd8ff', size: 96 }) : null;
    const h = typeof p.snapshotFace === 'function' ? p.snapshotFace({ accent: '#7fd8ff', size: 96 }) : null;
    const again = has ? p.snapshotAndroidFace({ accent: '#7fd8ff', size: 96 }) : null;
    return { has, android: a ? a.slice(0, 15) : null, differs: !!a && !!h && a !== h, cached: a === again, gl: !!a };
  });
  ok(face.has, 'PlayerRef.snapshotAndroidFace exists', JSON.stringify(face));
  ok(!face.gl || (face.android === 'data:image/png;' && face.differs && face.cached), 'android face = its own cached PNG (null without a 2nd GL context)', JSON.stringify(face));

  console.log('downed rule: an android in the squad means the solo player goes down instead of dying');
  await P(() => {
    const ctx = window.__game.ctx;
    ctx.allies = Object.assign({}, ctx.allies, { roster: [{ id: 'ally-a', bay: 0, slot: 1, name: '안드로이드 알파', recruitedAt: 0, local: true }] });
    const p = ctx.player;
    p.restoreState({ position: p.position.clone(), yaw: 0, hp: 100, downHp: 0, state: 0 });
  });
  await waitSim(1);   // 무적 창(`INVULN_TIME`)이 지나야 피해가 들어간다
  const d1 = await P(() => {
    const p = window.__game.ctx.player;
    const died0 = window.__ev['player:died'].length;
    p.takeDamage(9999);
    return { downed: p.isDowned, dead: p.isDead, died: window.__ev['player:died'].length - died0 };
  });
  ok(d1.downed && !d1.dead && d1.died === 0, 'with an android on the roster a lethal hit goes to 전투불능', JSON.stringify(d1));
  await P(() => {
    const ctx = window.__game.ctx;
    const p = ctx.player;
    p.revive();
    ctx.allies = Object.assign({}, ctx.allies, { roster: [] });
    p.restoreState({ position: p.position.clone(), yaw: 0, hp: 100, downHp: 0, state: 0 });
  });
  await waitSim(1);
  const d2 = await P(() => {
    const p = window.__game.ctx.player;
    const died0 = window.__ev['player:died'].length;
    p.takeDamage(9999);
    return { downed: p.isDowned, dead: p.isDead, died: window.__ev['player:died'].length - died0 };
  });
  ok(!d2.downed && d2.dead && d2.died === 1, 'with an empty roster the solo player still dies at once', JSON.stringify(d2));

  console.log('mission reset releases the bodies');
  const cleared = await P(() => {
    const ctx = window.__game.ctx;
    ctx.allies = window.__allies0;
    const mgr = window.__rp.getAllyAvatars();
    const before = mgr.size;
    window.__rp.debugAllyBodies(null);
    ctx.bus.emit('game:abort', {});
    return { before, size: mgr.size, revives: mgr.getReviveTargets().length };
  });
  ok(cleared.before === 1 && cleared.size === 0 && cleared.revives === 0, 'game:abort clears the ally avatars and their prompts', JSON.stringify(cleared));

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));
  ok(gameErrors.length === 0, `no console errors (${gameErrors.length}; ${errors.length - gameErrors.length} relay socket errors ignored)`, gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log('  FAIL', e.message);
  if (errors.length) console.log('  console errors:', errors.slice(0, 5).join(' | '));
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
