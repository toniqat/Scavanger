// Phase 5 HUD / menu smoke (src/ui): title `Lv. n` chip, contract panel under the objective, meta toasts (credits chip,
// reputation level, contract settlement, quest / purchase / sale lines) and the result-screen XP settlement block
// (count-up, level-up highlight + audio, XP bar, contract line). Enters a solo mission, then feeds synthetic bus events
// from `page.evaluate` and asserts the DOM — `ctx.meta` may still be the skeleton.
// Phase 7 additions: the level-up moment fires at the boundary crossing (badge + `.up-burst` + a single `audio:play
// level_up`, no `progress:levelUp` toast), contract wording keyed on `settlement.outcome` (never `ctx.stats.extracted`),
// the 레이드 실패 death screen (`game:raidFailed`: no 부활, auto-return countdown, Space ignored), suspended nameplate /
// squad rows + 훈련장 / 임무 중 / 함선 badges (`remotePlayers.debugSpawn` + `hud.debugRemotes`), host-change / suspended /
// training chat + notification lines, the training objective. Phase 9: ghost bleed bar / 사망 tag on a suspended member's
// nameplate + squad row from `ref.ghostState / ghostDownHp`. Phase 10: the crosshair reload ring (`weapon:reloadStarted` /
// `Cancelled` / `Finished`), the 회복약 2 s hold gauge (`heal:holdChanged`), the map's middle-click ping, the software
// cursor sprite + cursor mode on the map (no `exitPointerLock`), and the item card's `100 C` credit bar. C-13 · C-19 (2026-09-11): the 회복 스프레이 ring never goes .ready at a full gauge, and the thin nameplate shield bar (ref.shield / maxShield; hidden when downed or suspended). C-36 후속: the item card's bag 내구도 row. 142 checks. Needs the relay on 8787 too (the hub's
// `ensureConnected` logs a console error otherwise), e.g. `npm run dev:all` or `npm run server` + a private vite.
// Usage: node scripts/smoke-ui-p5.mjs [http://localhost:5273]   (needs `npm run dev`)
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
  await page.evaluateOnNewDocument(() => {
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    // Never let headless Chrome take a real pointer lock (Windows ClipCursor trap); `pointerLockElement` is faked below.
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // Park vite's HMR socket: another editor's save would otherwise full-reload the page mid-run (scripts/quiet-hmr.mjs).
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.progression, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['audio:play', 'game:respawn', 'ping:placed']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const emit = (name, payload) => P(([n, p]) => window.__game.ctx.bus.emit(n, p), [name, payload]);
  const texts = (sel) => P((s) => [...document.querySelectorAll(s)].map((e) => e.textContent), sel);
  const hud = (expr) => P((e) => { const h = window.__game.getSystem('hud'); return h[e]; }, expr);

  // 2026-09-09: 타이틀의 `.lv-chip` 은 사라졌다 — 레벨은 캐릭터 선택창의 슬롯 카드가 읽는다 (세이브에서 직접).
  console.log('character select slot card');
  const lvReal = await P(() => window.__game.ctx.progression.level);
  const noChip = await P(() => ({ chip: !!document.querySelector('.menu.title .lv-chip'), phase: window.__game.ctx.phase }));
  ok(noChip.phase === 'menu' && !noChip.chip, '타이틀에는 레벨 칩이 없다 (버튼 셋뿐)', JSON.stringify(noChip));
  await P(() => [...document.querySelectorAll('.menu.title .title-actions .ui-btn')].find((b) => b.textContent === '게임 시작').click());
  // 빈 브라우저로 부팅했으므로 세 칸 모두 비어 있다 — 프로필은 캐릭터 생성창이 쓰고, 그전에는 아무 세이브도 없다.
  const empties = await P(() => ({
    cards: document.querySelectorAll('.char-select .cs-card').length,
    empty: document.querySelectorAll('.char-select .cs-card.empty').length,
    plus: document.querySelector('.char-select .cs-card.empty .cs-empty-label')?.textContent,
  }));
  ok(empties.cards === 3 && empties.empty === 3 && empties.plus === '캐릭터 생성',
    '빈 저장소 → 칸 셋 전부 비어 있고 각각 캐릭터 생성', JSON.stringify(empties));
  // 슬롯 2 에 캐릭터를 심고 다시 열면 그 칸이 세이브에서 이름 · 레벨 · 능력치를 읽어 온다 (색인 파일 없음).
  const card = await P((lv) => {
    const p = { ...window.__game.ctx.progression.profile, name: '테스트대원', level: lv };
    localStorage.setItem('scav.s2.profile', JSON.stringify(p));
    const back = [...document.querySelectorAll('.char-select .ts-foot .ui-btn')].find((b) => b.textContent === '뒤로');
    back.click();
    [...document.querySelectorAll('.menu.title .title-actions .ui-btn')].find((b) => b.textContent === '게임 시작').click();
    const c = [...document.querySelectorAll('.char-select .cs-card')].find((x) => x.querySelector('.cs-slot')?.textContent === '슬롯 2');
    return c ? { lv: c.querySelector('.cs-lv')?.textContent, name: c.querySelector('.cs-name')?.textContent, empty: c.classList.contains('empty'), stats: c.querySelectorAll('.cs-stats .cc-mini').length } : null;
  }, lvReal);
  ok(card && !card.empty && card.name === '테스트대원' && card.lv === `Lv. ${lvReal}`, `슬롯 2 카드가 세이브를 읽는다 (Lv. ${lvReal})`, JSON.stringify(card));
  ok(card && card.stats === 5, '슬롯 카드에 능력치 다섯 줄', JSON.stringify(card));
  await P(() => {
    localStorage.removeItem('scav.s2.profile');
    [...document.querySelectorAll('.char-select .ts-foot .ui-btn')].find((b) => b.textContent === '뒤로')?.click();
  });
  await emit('progress:levelUp', { level: 7, statPoints: 1 });
  const lvToasts = await P(() => document.querySelectorAll('.ptoast.level').length);
  ok(lvToasts === 0, 'progress:levelUp raises no 레벨 업 toast any more (the result screen owns the moment)', String(lvToasts));
  await P(() => window.__game.ctx.bus.emit('progress:loaded', { profile: window.__game.ctx.progression.profile }));
  // 2026-09-09: `progress:loaded` 는 이제 콜사인을 `ctx.net` 에 밀어 넣는 자리다 — 타이틀에 칩이 없으니 그것을 본다.
  const pushedName = await P(() => ({ profile: window.__game.ctx.progression.profile.name, net: window.__game.ctx.net?.playerName }));
  ok(!pushedName.net || pushedName.net === pushedName.profile,
    'progress:loaded → 캐릭터 이름이 net.playerName 으로 간다', JSON.stringify(pushedName));
  // The synthetic level-up toast above must not leak into the mission (ProgressToasts clears on game:newMission).

  console.log('mission');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  // an implant can only be chosen in the ship — the raid HUD then shows its thumbnail (Phase 9 UI pass)
  await P(() => { try { window.__game.ctx.implants?.setEquipped('dash'); } catch { /* no implant system */ } });
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 11 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  const layers = await P(() => ({
    panel: !!document.querySelector('.hud.gameplay .contract-panel'),
    afterObjective: (() => { const o = document.querySelector('.hud.gameplay .objective'); const c = document.querySelector('.hud.gameplay .contract-panel'); return !!o && !!c && !!(o.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING); })(),
    toasts: !!document.querySelector('.hud.social .progress-toasts'),
  }));
  ok(layers.panel && layers.afterObjective, 'contract panel lives in the gameplay layer after the objective', JSON.stringify(layers));
  ok(layers.toasts, 'meta toasts share the .progress-toasts column in the social layer');

  /* -- Phase 10: crosshair reload ring + heal hold gauge -- */
  console.log('crosshair gauges (Phase 10)');
  // `stroke-dasharray` comes back as "<filled> <circumference>", with or without px units -> the filled fraction
  const dashT = (d) => { const n = String(d).match(/[\d.]+/g); return n && n.length >= 2 ? Number(n[0]) / Number(n[1]) : NaN; };
  const gaugeDom = await P(() => {
    const r = document.querySelector('.hud.gameplay > .reload'), h = document.querySelector('.hud.gameplay > .heal');
    const w = document.querySelector('.weapon');
    // the ring must sit on the reticle: its own centre within a few px of the viewport centre
    const box = r ? r.getBoundingClientRect() : null;
    const off = box ? Math.max(Math.abs(box.left + box.width / 2 - window.innerWidth / 2), Math.abs(box.top + box.height / 2 - window.innerHeight / 2)) : 999;
    return {
      reload: !!r, heal: !!h,
      arcGone: !w.querySelector('.arc'), pillGone: !w.querySelector('.reloading'),
      off: Math.round(off), size: box ? Math.round(box.width) : 0,
      rot: r ? getComputedStyle(r.querySelector('svg')).transform : '',
      hidden: r ? !r.className.includes('show') : false,
    };
  });
  ok(gaugeDom.reload && gaugeDom.heal, 'both new crosshair rings live in the gameplay layer (.reload / .heal)', JSON.stringify(gaugeDom));
  ok(gaugeDom.arcGone && gaugeDom.pillGone, 'the weapon panel lost its .arc SVG and its 재장전 pill', JSON.stringify(gaugeDom));
  ok(gaugeDom.off <= 2 && gaugeDom.size === 120 && /matrix\(0,\s*-1,\s*1,\s*0/.test(gaugeDom.rot), `reload ring is reticle-centred (SIZE 120, off ${gaugeDom.off}px) and rotated -90deg (fills from 12 o clock)`, JSON.stringify(gaugeDom));
  ok(gaugeDom.hidden, 'reload ring starts hidden');
  const reloadRing = () => P(() => { const e = document.querySelector('.reload'); const h = window.__game.getSystem('hud'); return { cls: e.className, dash: e.querySelector('.fill').style.strokeDasharray, lbl: e.querySelector('.lbl').textContent, on: h.isReloadGaugeOn, t: h.reloadProgress }; });
  await emit('weapon:reloadStarted', { weaponId: 'ar', duration: 2 });
  let rg = await reloadRing();
  ok(/\bshow\b/.test(rg.cls) && rg.on && dashT(rg.dash) < 0.02 && rg.lbl === '재장전 2.0 s', 'weapon:reloadStarted {duration:2} -> ring shown, empty, 재장전 2.0 s', JSON.stringify(rg));
  await waitSim(0.9);
  rg = await reloadRing();
  ok(dashT(rg.dash) > 0.2 && dashT(rg.dash) < 0.9 && rg.t > 0.2, `ring fills on its own countdown (${rg.dash} · ${rg.lbl})`, JSON.stringify(rg));
  await emit('weapon:reloadCancelled', { weaponId: 'ar' });
  rg = await reloadRing();
  ok(!/\bshow\b/.test(rg.cls) && !rg.on && dashT(rg.dash) < 0.02, 'weapon:reloadCancelled hides the ring and resets it (a melee / swap cancel no longer leaves it filling)', JSON.stringify(rg));
  await emit('weapon:reloadStarted', { weaponId: 'ar', duration: 2 });
  await emit('weapon:reloadFinished', { weaponId: 'ar' });
  rg = await reloadRing();
  ok(!/\bshow\b/.test(rg.cls) && !rg.on, 'weapon:reloadFinished hides it too', JSON.stringify(rg));
  await emit('weapon:reloadStarted', { weaponId: 'ar', duration: 5 });
  await emit('player:downed', { bleedout: 60 });
  rg = await reloadRing();
  ok(!rg.on, 'player:downed closes the ring mid-reload', JSON.stringify(rg));
  await emit('player:revived', { hp: 100, byName: null });
  // 회복 소모품: LMB hold of the item's own length (`heal:holdChanged.dur`), a full circle rather than the cook gauge's 120 deg arc
  const healRing = () => P(() => { const e = document.querySelector('.heal'); return { cls: e.className, dash: e.querySelector('.fill').style.strokeDasharray, lbl: e.querySelector('.lbl').textContent, on: window.__game.getSystem('hud').isHealGaugeOn, circle: !!e.querySelector('circle.fill') }; });
  await emit('heal:holdChanged', { holding: true, t: 0, dur: 2 });
  let hg = await healRing();
  ok(/\bshow\b/.test(hg.cls) && hg.on && hg.circle, 'heal:holdChanged {holding} -> 회복약 ring shown, drawn as a full circle (not an arc path)', JSON.stringify(hg));
  await emit('heal:holdChanged', { holding: true, t: 0.5, dur: 2 });
  hg = await healRing();
  ok(Math.abs(dashT(hg.dash) - 0.5) < 0.02 && hg.lbl === '회복 1.0 s', 'half-held -> ring half full, 1.0 s left of the item use time (dur 2)', JSON.stringify(hg));
  await emit('heal:holdChanged', { holding: true, t: 0.4, dur: 5, spray: true });
  hg = await healRing();
  ok(hg.lbl === '스프레이 40 %' && !/\bready\b/.test(hg.cls), '회복 스프레이 channel -> the ring shows the remaining gauge', JSON.stringify(hg));
  await emit('heal:holdChanged', { holding: true, t: 1, dur: 5, spray: true });
  hg = await healRing();
  ok(!/\bready\b/.test(hg.cls) && hg.lbl === '스프레이 100 %', '회복 스프레이 at a full gauge -> 스프레이 100 %, never .ready (the ready flash is for timed heals only)', JSON.stringify(hg));
  await emit('heal:holdChanged', { holding: true, t: 1, dur: 2 });
  hg = await healRing();
  ok(/\bready\b/.test(hg.cls) && Math.abs(dashT(hg.dash) - 1) < 0.02, 't = 1 -> .ready, full ring', JSON.stringify(hg));
  await emit('heal:holdChanged', { holding: false, t: -1 });
  hg = await healRing();
  ok(!/\bshow\b/.test(hg.cls) && !hg.on && dashT(hg.dash) < 0.02, 'releasing (holding false / t -1) hides and resets it', JSON.stringify(hg));
  // the weapon panel's hint follows the item's own use time (붕대 = 5 s)
  const stimHint = await P(() => {
    window.__game.ctx.bus.emit('quick:equipped', { item: { uid: 'smoke-stim', defId: 'heal_bandage', qty: 2, x: 0, y: 0, rot: 0 }, slot: 1 });
    const w = document.querySelector('.weapon');
    return { hint: w.querySelector('.cons .hint').textContent, cons: w.className.includes('consumable') };
  });
  ok(stimHint.cons && stimHint.hint === '좌클릭 5초 홀드 · 이동 50 %', '붕대 in hand -> 좌클릭 5초 홀드 · 이동 50 % hint', JSON.stringify(stimHint));
  await emit('quick:equipped', { item: null, slot: 1 });
  // 2026-09-07: the bottom-left 회복약 / 수류탄 pills were removed — the counts are the right-hand 빠른 사용 thumbnail
  // and the weapon panel's consumable block, so the health corner is health + stamina only.
  const bl = await P(() => ({ pills: document.querySelectorAll('.vitals .pill').length, stam: !!document.querySelector('.stamina') }));
  ok(bl.pills === 0 && bl.stam, `bottom-left vitals = health + stamina, no pills (${bl.pills})`);

  /* -- Phase 10: middle-click ping on the tactical map -- */
  console.log('map middle-click ping (Phase 10)');
  await P(() => { window.__ev['ping:placed'].length = 0; });
  await page.evaluate(() => {
    // Key taps must dispatch keydown + keyup in the same frame (CLAUDE.md): `Input.wasPressed` only fires on a fresh
    // down, so a keydown left held makes every later tap of that key invisible.
    window.tapKey = (code, key) => {
      const init = { code, key: key ?? code.replace('Key', '').toLowerCase(), bubbles: true, cancelable: true };
      document.body.dispatchEvent(new KeyboardEvent('keydown', init));
      document.body.dispatchEvent(new KeyboardEvent('keyup', init));
    };
  });
  await P(() => { tapKey('KeyM'); });
  await waitFor(page, () => window.__game.getSystem('hud').isMapOpen, 'map open');
  const mapPt = await P(() => {
    const c = document.querySelector('.map-canvas');
    const r = c.getBoundingClientRect();
    return { hint: document.querySelector('.map-hint').textContent, x: Math.round(r.left + r.width * 0.4), y: Math.round(r.top + r.height * 0.6) };
  });
  ok(/휠클릭 핑/.test(mapPt.hint), `map footer hint mentions the middle-click ping (${mapPt.hint})`);
  await P((pt) => {
    document.querySelector('.map-canvas').dispatchEvent(new MouseEvent('mousedown', { button: 1, buttons: 4, clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true }));
  }, mapPt);
  const mapPing = await P(() => {
    const placed = window.__ev['ping:placed'];
    return { n: placed.length, last: placed[placed.length - 1] ?? null, open: window.__game.getSystem('hud').isMapOpen, markers: document.querySelectorAll('.pmarker').length };
  });
  ok(mapPing.n === 1 && !!mapPing.last, 'a middle-click on the map places exactly one ping (ping:placed)', JSON.stringify(mapPing));
  ok(mapPing.open, 'the middle-click does not close the map or start a pan');
  ok(mapPing.markers >= 1, 'the map ping got its own world marker', JSON.stringify(mapPing));
  /* 2026-09-07 (커서 rework): the open map is a cursor-mode owner and the pointer lock is **released** — the real OS
     cursor comes back, restyled by `ui/hud/GameCursor`. The DOM sprite and the virtual cursor are gone. */
  const mapCursor = await P(() => ({
    mode: window.__game.ctx.input.isCursorMode,
    blocked: window.__game.ctx.uiBlockers.has('map'),
    art: window.__game.getSystem('hud').isGameCursorOn,
    bodyMode: document.body.classList.contains('cursor-on'),
    bodyArt: document.body.classList.contains('cursor-ui'),
    sprite: document.querySelectorAll('.soft-cursor').length,
  }));
  ok(mapCursor.mode && mapCursor.blocked, 'the open map is a cursor-mode owner with the map blocker', JSON.stringify(mapCursor));
  ok(mapCursor.art && mapCursor.bodyArt && mapCursor.bodyMode, 'the game cursor art is installed and the mode class is on', JSON.stringify(mapCursor));
  ok(mapCursor.sprite === 0, 'there is no cursor sprite in the DOM any more (the OS cursor draws it)');
  // `uiX / uiY` are simply the real cursor position now — no virtual position to keep in sync.
  const pos = await P(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 420, clientY: 260, bubbles: true }));
    const i = window.__game.ctx.input;
    return { x: i.uiX, y: i.uiY, cx: i.cursorX, cy: i.cursorY };
  });
  ok(pos.x === 420 && pos.y === 260 && pos.cx === 420 && pos.cy === 260,
    'input.uiX / uiY follow the real cursor position', JSON.stringify(pos));
  await P(() => { tapKey('KeyM'); });
  await waitFor(page, () => !window.__game.getSystem('hud').isMapOpen, 'map closed');
  const afterMap = await P(() => ({ mode: window.__game.ctx.input.isCursorMode, bodyMode: document.body.classList.contains('cursor-on') }));
  ok(!afterMap.mode && !afterMap.bodyMode, 'closing the map releases cursor mode', JSON.stringify(afterMap));

  /* -- Phase 10: the item card's credit bar -- */
  console.log('item tip credit bar (Phase 10)');
  const tipBar = await P(() => {
    const def = window.__game.ctx.loot.getItemDef('heal_bandage');
    const chip = document.createElement('span');
    chip.className = 'item-chip';
    chip.dataset.defId = 'heal_bandage';
    window.__game.ctx.uiRoot.appendChild(chip);
    chip.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 200, clientY: 200 }));
    const tip = document.querySelector('#ui-root > .item-tip');
    const bar = tip.querySelector('.it-value');
    const res = {
      value: def ? def.value : null,
      hidden: tip.hidden,
      bar: !!bar,
      last: tip.lastElementChild === bar,
      // 2026-09-09: the bar is 무게(.wt, left) + 가치(.val, right) — read the 가치 half
      label: bar ? (bar.querySelector('.val .k') ?? bar.querySelector('.k')).textContent : '',
      amount: bar ? (bar.querySelector('.val .v') ?? bar.querySelector('.v')).textContent : '',
      align: bar ? getComputedStyle(bar).justifyContent : '',
      rows: [...tip.querySelectorAll('.it-stats .k')].map((e) => e.textContent),
    };
    chip.remove();
    return res;
  });
  ok(!tipBar.hidden && tipBar.bar && tipBar.last, 'the 가치 row became a bottom bar (.it-value, the card last child)', JSON.stringify(tipBar));
  ok(tipBar.label === '가치' && tipBar.amount === `${tipBar.value.toLocaleString('ko-KR')} C`, `bar reads 가치 / ${tipBar.value} C via formatCredits (${tipBar.amount})`, JSON.stringify(tipBar));
  ok(!tipBar.rows.includes('가치') && tipBar.align === 'space-between', '가치 is gone from the stats table and the amount is right-aligned', JSON.stringify(tipBar));
  await P(() => document.querySelector('#ui-root > .item-tip').dispatchEvent(new PointerEvent('pointerout', { bubbles: true })));
  // C-36 후속 (2026-09-11): 가방 내구도 한 줄 — 칩뿐이면 `최대 max`, data-uid 로 인스턴스를 찾으면 `cur / max`
  const bagTip = await P(() => {
    const ctx = window.__game.ctx;
    const max = ctx.loot.getItemDef('bag_common')?.durabilityMax ?? null;
    const readRow = (uid) => {
      const chip = document.createElement('span');
      chip.className = 'item-chip';
      chip.dataset.defId = 'bag_common';
      if (uid) chip.dataset.uid = uid;
      ctx.uiRoot.appendChild(chip);
      chip.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 200, clientY: 200 }));
      const tip = document.querySelector('#ui-root > .item-tip');
      const ks = [...tip.querySelectorAll('.it-stats .k')];
      const i = ks.findIndex((e) => e.textContent === '내구도');
      const v = i >= 0 ? ks[i].nextElementSibling?.textContent : null;
      chip.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
      chip.remove();
      return v;
    };
    const def = readRow(null);
    // 인스턴스 조회만 가짜로 — 저장소를 건드리지 않는다
    const inv = ctx.inventory;
    const orig = inv.findItemAnywhere;
    const own = Object.prototype.hasOwnProperty.call(inv, 'findItemAnywhere');
    inv.findItemAnywhere = (u) => (u === 'smoke-bag' ? { uid: 'smoke-bag', defId: 'bag_common', qty: 1, x: 0, y: 0, rot: 0, durability: 37 } : orig.call(inv, u));
    let inst = null;
    try { inst = readRow('smoke-bag'); } finally { if (own) inv.findItemAnywhere = orig; else delete inv.findItemAnywhere; }
    return { max, def, inst };
  });
  ok(bagTip.max > 0 && bagTip.def === `최대 ${bagTip.max}` && bagTip.inst === `37 / ${bagTip.max}`, 'item tip: bag 내구도 row — 최대 max on a def chip, cur / max for a data-uid instance', JSON.stringify(bagTip));

  /* ── Phase 9 UI pass: 무게 표시 제거 · 분대 목록은 좌하단 · 우하단은 임플란트 → 빠른 사용 → 무기 슬롯 ── */
  const p9 = await P(() => {
    const bl = document.querySelector('.hud.social .hud-bl');
    const vitals = document.querySelector('.hud .vitals');   // 2026-09-12: the vitals block lives in the social layer now
    const w = document.querySelector('.hud.gameplay .weapon');
    const filled = [...document.querySelectorAll('.qstrip .qs-cell')].filter((c) => !c.hidden && !c.classList.contains('empty'));
    return {
      weight: !!document.querySelector('.weightbar'),
      column: !!bl && !!bl.querySelector('.chat') && !!bl.querySelector('.squad'),
      aboveVitals: !!bl && !!vitals && bl.getBoundingClientRect().bottom <= vitals.getBoundingClientRect().top + 4,
      left: bl ? Math.round(bl.getBoundingClientRect().left) : -1,
      order: w ? [...w.children].slice(0, 4).map((n) => n.className.split(' ')[0]).join(',') : '',
      stratInColumn: !!w?.querySelector('.scall'),
      slotLbl: !!w?.querySelector(':scope > .name-row .slot-lbl'),   // the 빠른 사용 block keeps its own label
      type: w?.querySelector('.type')?.textContent ?? '',
      quick: filled.length,
      chips: document.querySelectorAll('.qstrip .qs-cell .item-chip[data-def-id]').length,
      /* 2026-09-10: 임플란트는 우하단 칩이 아니라 화면 중앙 하단의 `.imp-hud` 이고, 이름을 표기하지 않는다. */
      implant: (() => { const h = document.querySelector('.imp-hud'); return h && !h.hidden ? (h.dataset.implant ?? null) : null; })(),
      implantName: !!document.querySelector('.imp-hud .ib-name'),
      implantKey: document.querySelector('.imp-hud .imp-key')?.textContent ?? null,
      equipped: window.__game.ctx.implants?.equipped ?? null,
      stamFill: getComputedStyle(document.querySelector('.stam-bar .fill')).backgroundColor,
    };
  });
  ok(!p9.weight, '인게임 무게 표시(.weightbar) 제거');
  ok(p9.column && p9.aboveVitals && p9.left === 32, `채팅 + 분대 목록이 좌하단 한 열(.hud-bl)에서 체력바 위에 (left ${p9.left})`, JSON.stringify(p9));
  /* 2026-09-10 (2차): 함선 호출도 하단 중앙(임플란트 왼쪽 `.scall`)으로 떠났다 — 우하단은 빠른 사용 → 무기 상자(.wbox)뿐이다. */
  ok(p9.order.startsWith('qstrip,wbox') && !p9.stratInColumn,
    `우하단 순서: 빠른 사용 → 무기 패널, 함선 호출은 열에 없다 (${p9.order})`);
  ok(!p9.slotLbl && !p9.type.includes('·'), `무기 정보에서 '주무기' / 탄약 표기 제거 (type '${p9.type}')`);
  ok(p9.quick >= 1 && p9.chips === p9.quick, `빠른 사용 썸네일 ${p9.quick}칸 (모두 item-chip)`, JSON.stringify({ quick: p9.quick, chips: p9.chips }));
  ok(p9.equipped === null ? p9.implant === null : p9.implant === p9.equipped, `전술 임플란트 썸네일이 화면 하단 중앙에 (${p9.implant ?? '없음'} / equipped ${p9.equipped})`);
  ok(!p9.implantName && (p9.equipped === null || !!p9.implantKey), `임플란트 이름은 표기하지 않고 사용 키만 (${p9.implantKey ?? '없음'})`, JSON.stringify(p9));
  ok(p9.stamFill === 'rgb(255, 255, 255)', `스태미나 바가 불투명한 흰색 (${p9.stamFill})`);
  const activeAtStart = await P(() => !!(window.__game.ctx.meta && window.__game.ctx.meta.activeContract));
  const shown0 = await hud('isContractPanelOn');
  ok(shown0 === activeAtStart, `panel at world:ready follows ctx.meta.activeContract (${activeAtStart ? 'active' : 'none / skeleton'})`, String(shown0));

  console.log('contract panel');
  await emit('meta:contractProgress', { id: 'helix_1', corp: 'helix', goal: 'kill_bugs', progress: 3, target: 25, delta: 1 });
  let cp = await P(() => { const e = document.querySelector('.contract-panel'); return { cls: e.className, name: e.querySelector('.name').textContent, goal: e.querySelector('.goal').textContent, num: e.querySelector('.num').textContent, fill: e.querySelector('.fill').style.transform, on: window.__game.getSystem('hud').isContractPanelOn, pulse: window.__game.getSystem('hud').isContractPulsing, vis: getComputedStyle(e).visibility }; });
  ok(/\bshow\b/.test(cp.cls) && cp.on, 'meta:contractProgress alone brings the panel up (.show)', cp.cls);
  ok(cp.name === '소탕 작전 I' && cp.goal === '터미니드 처치', 'name from CONTRACT_DEFS, goal from CONTRACT_GOAL_LABEL_KO', `${cp.name} / ${cp.goal}`);
  ok(cp.num === '3 / 25' && /scaleX\(0\.12/.test(cp.fill), 'progress 3 / 25, bar 12 %', `${cp.num} ${cp.fill}`);
  ok(/\bpulse\b/.test(cp.cls) && cp.pulse && !/\bdone\b/.test(cp.cls), 'progress pulse on, no 달성 badge yet', cp.cls);
  await waitSim(1.0);
  cp = await P(() => ({ cls: document.querySelector('.contract-panel').className, pulse: window.__game.getSystem('hud').isContractPulsing, op: getComputedStyle(document.querySelector('.contract-panel')).opacity }));
  ok(!/\bpulse\b/.test(cp.cls) && !cp.pulse, 'pulse drops after 0.9 s of sim time', cp.cls);
  ok(cp.op === '1', 'panel fully faded in (opacity 1)', cp.op);
  await emit('meta:contractProgress', { id: 'helix_1', corp: 'helix', goal: 'kill_bugs', progress: 25.25, target: 25, delta: 0.25 });
  cp = await P(() => { const e = document.querySelector('.contract-panel'); return { cls: e.className, num: e.querySelector('.num').textContent, badge: getComputedStyle(e.querySelector('.badge')).opacity, fill: e.querySelector('.fill').style.transform }; });
  ok(/\bdone\b/.test(cp.cls) && cp.num === '25 / 25' && /scaleX\(1/.test(cp.fill), 'progress ≥ target → .done, floored 25 / 25, full bar', `${cp.cls} ${cp.num} ${cp.fill}`);
  await sleep(350);
  cp = await P(() => ({ badge: getComputedStyle(document.querySelector('.contract-panel .badge')).opacity, text: document.querySelector('.contract-panel .badge').textContent }));
  ok(Number(cp.badge) > 0.9 && cp.text === '달성', '달성 badge visible', JSON.stringify(cp));
  await emit('meta:contractSettled', { id: 'helix_1', corp: 'helix', name: '소탕 작전 I', success: true, progress: 25, target: 25, rep: 60, xp: 150, credits: 120 });
  cp = await P(() => ({ cls: document.querySelector('.contract-panel').className, on: window.__game.getSystem('hud').isContractPanelOn }));
  ok(!/\bshow\b/.test(cp.cls) && !cp.on, 'meta:contractSettled hides the panel', cp.cls);
  await emit('meta:contractProgress', { id: 'ceres_2', corp: 'ceres', goal: 'loot_corpses', progress: 1, target: 15, delta: 1 });
  cp = await P(() => ({ on: window.__game.getSystem('hud').isContractPanelOn, name: document.querySelector('.contract-panel .name').textContent, goal: document.querySelector('.contract-panel .goal').textContent }));
  ok(cp.on && cp.name === '검체 채취 II' && cp.goal === '시체 수색', 'a new contract re-opens the panel with its own name / goal', JSON.stringify(cp));
  await emit('meta:contractAbandoned', { id: 'ceres_2', corp: 'ceres' });
  ok((await hud('isContractPanelOn')) === false, 'meta:contractAbandoned hides the panel');
  /* Phase 9 UI pass: 분대 계약 rows under the own contract — empty (and hidden) without a squad */
  const mates = await P(() => {
    const p = document.querySelector('.contract-panel');
    const list = window.__game.ctx.meta && typeof window.__game.ctx.meta.getSquadContracts === 'function'
      ? window.__game.ctx.meta.getSquadContracts() : null;
    return { block: !!p.querySelector('.mates'), hidden: p.querySelector('.mates').hidden,
      rows: p.querySelectorAll('.mates .mrow').length, api: Array.isArray(list) ? list.length : -1 };
  });
  ok(mates.block && mates.hidden && mates.rows === 0 && mates.api === 0,
    '분대 계약 블록은 분대원 계약이 없으면 숨는다 (ctx.meta.getSquadContracts() = [])', JSON.stringify(mates));

  console.log('meta toasts');
  const settledToast = await texts('.ptoast.contract');
  ok(settledToast.length === 1 && settledToast[0].includes('계약 성공') && settledToast[0].includes('소탕 작전 I') && settledToast[0].includes('신뢰도 +60') && settledToast[0].includes('크레딧 +120 C'), 'meta:contractSettled success → big 계약 성공 toast with rep / credits', JSON.stringify(settledToast));
  await emit('meta:creditsChanged', { credits: 620, delta: 120, reason: 'contract' });
  await emit('meta:creditsChanged', { credits: 650, delta: 30, reason: 'sale' });
  let chips = await texts('.ptoast.credits');
  ok(chips.length === 0, 'credit changes are coalesced (no chip yet)', JSON.stringify(chips));
  await waitSim(1.15);
  chips = await texts('.ptoast.credits');
  ok(chips.length === 1 && chips[0] === '크레딧 +150 C', 'one 크레딧 +150 C chip after 1 s', JSON.stringify(chips));
  await emit('meta:creditsChanged', { credits: 650, delta: 0, reason: 'noop' });
  await waitSim(1.15);
  chips = await texts('.ptoast.credits');
  ok(chips.length === 1, 'delta 0 raises no chip', JSON.stringify(chips));
  await emit('meta:creditsChanged', { credits: 610, delta: -40, reason: 'buy' });
  await waitSim(1.15);
  let minus = await P(() => [...document.querySelectorAll('.ptoast.credits.minus')].map((e) => e.textContent));
  ok(minus.length === 1 && minus[0] === '크레딧 −40 C', 'negative delta → 크레딧 −40 C (.minus)', JSON.stringify(minus));
  await emit('meta:repChanged', { corp: 'helix', rep: 100, level: 1, delta: 100, levelUp: true });
  let rep = await texts('.ptoast.rep');
  ok(rep.length === 1 && rep[0].includes('헬릭스 방산 신뢰도 Lv.1'), 'meta:repChanged levelUp → 헬릭스 방산 신뢰도 Lv.1', JSON.stringify(rep));
  await emit('meta:repChanged', { corp: 'helix', rep: 130, level: 1, delta: 30, levelUp: false });
  rep = await texts('.ptoast.rep');
  ok(rep.length === 1, 'rep gain without a level-up raises no toast', JSON.stringify(rep));
  await emit('meta:questChanged', { id: 'h1', corp: 'helix', state: 'complete' });
  await emit('meta:questChanged', { id: 'h2', corp: 'helix', state: 'accepted' });
  let notifs = await texts('.notif');
  ok(notifs.some((t) => t.includes('퀘스트') && t.includes('퀘스트 완료 · 고철 납품')) && !notifs.some((t) => t.includes('합금 납품')), 'meta:questChanged complete → 퀘스트 완료 · 고철 납품 (accepted stays silent)', JSON.stringify(notifs));
  await emit('meta:contractAccepted', { id: 'bastion_1', corp: 'bastion' });
  await emit('meta:purchase', { corp: 'helix', defId: 'ammo_light', price: 40, placed: 'stash' });
  await emit('meta:sale', { defId: 'gem_amber', qty: 2, credits: 130 });
  notifs = await texts('.notif');
  const ammoName = await P(() => { const d = window.__game.ctx.loot.getItemDef('ammo_light'); return d ? d.name : 'ammo_light'; });
  const gemName = await P(() => { const d = window.__game.ctx.loot.getItemDef('gem_amber'); return d ? d.name : 'gem_amber'; });
  ok(notifs.some((t) => t.includes('계약 수락 · 용병 제거 I')), 'meta:contractAccepted → 계약 수락 line', JSON.stringify(notifs));
  ok(notifs.some((t) => t.includes(`구매: ${ammoName}`) && t.includes('크레딧 −40 C') && t.includes('(창고)')), 'meta:purchase → 구매 line with price and 창고', JSON.stringify(notifs));
  ok(notifs.some((t) => t.includes(`판매: ${gemName}`) && t.includes('×2') && t.includes('크레딧 +130 C')), 'meta:sale → 판매 line with qty and credits', JSON.stringify(notifs));
  // Phase 7: wording keyed on settlement.outcome only — ctx.stats.extracted is deliberately set to the opposite.
  await P(() => { window.__game.ctx.stats.extracted = false; });
  await emit('meta:contractSettled', { id: 'nomad_1', corp: 'nomad', name: '회수 임무 I', success: false, outcome: 'incomplete', progress: 900, target: 1500, rep: 0, xp: 0, credits: 0 });
  const keep = await texts('.ptoast.contract.keep');
  ok(keep.length === 1 && keep[0].includes('계약 미완 · 계속') && keep[0].includes('900 / 1,500'), 'outcome incomplete (extracted=false ignored) → 계약 미완 · 계속 + 900 / 1,500', JSON.stringify(keep));
  await P(() => { window.__game.ctx.stats.extracted = true; });
  await emit('meta:contractSettled', { id: 'nomad_1', corp: 'nomad', name: '회수 임무 I', success: false, outcome: 'failed', progress: 900, target: 1500, rep: 0, xp: 0, credits: 0 });
  const failT = await texts('.ptoast.contract.fail');
  ok(failT.length === 1 && failT[0].includes('계약 실패 · 진척 유지 안 됨') && !failT[0].includes('계속'), 'outcome failed (extracted=true ignored) → 계약 실패 · 진척 유지 안 됨', JSON.stringify(failT));
  await emit('meta:contractSettled', { id: 'nomad_1', corp: 'nomad', name: '회수 임무 I', success: false, progress: 3, target: 15, rep: 0, xp: 0, credits: 0 });
  const legacyKeep = await texts('.ptoast.contract.keep');
  ok(legacyKeep.length === 2 && legacyKeep[1].includes('계약 미완 · 계속') && legacyKeep[1].includes('3 / 15'), 'settlement without outcome (older producer) falls back to 계약 미완 · 계속', JSON.stringify(legacyKeep));
  await P(() => { window.__game.ctx.stats.extracted = false; });
  const live = await hud('metaToastCount');
  ok(live <= 4, `meta toast stack capped at 4 (${live})`);

  console.log('mission complete rewards');
  const base = await P(() => JSON.parse(JSON.stringify(window.__game.ctx.stats)));
  await P(() => { window.__ev['audio:play'].length = 0; });
  await emit('game:complete', { stats: { ...base, extracted: true, lootValue: 900, rewards: { xpEarned: 340, levelBefore: 2, levelAfter: 3, xp: 40, xpToNext: 300, contract: { id: 'helix_1', corp: 'helix', name: '소탕 작전 I', success: true, progress: 25, target: 25, rep: 60, xp: 150, credits: 120 } } } });
  let rw = await P(() => { const m = document.querySelector('.menu.complete'); const r = m.querySelector('.rewards'); return { menu: m.className, hidden: r.hidden, lv: r.querySelector('.lv').textContent, gain: r.querySelector('.xp-gain').textContent, num: r.querySelector('.xp-num').textContent, up: r.classList.contains('up'), badge: r.querySelector('.up-badge').hidden, contract: r.querySelector('.contract-line').textContent, ccls: r.querySelector('.contract-line').className, counting: window.__game.getSystem('hud').completeRewards.isCounting, order: (() => { const s = m.querySelector('.stats'); const a = m.querySelector('.actions'); return !!(s.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(r.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); })() }; });
  ok(!/\bhidden\b/.test(rw.menu) && !rw.hidden && rw.order, 'game:complete with rewards → .rewards block between stats and actions', `${rw.menu} hidden=${rw.hidden} order=${rw.order}`);
  ok(rw.lv === 'Lv. 2 → 3' && !rw.up && rw.badge && rw.counting, 'Lv. 2 → 3, no highlight before the count-up ends', JSON.stringify(rw));
  ok(rw.num === '40 / 300 XP', 'XP bar numbers 40 / 300 XP', rw.num);
  ok(rw.contract === '계약 성공 · 소탕 작전 I · 신뢰도 +60 · 크레딧 +120 C' && /\bsuccess\b/.test(rw.ccls), 'contract success line (outcome wording)', `${rw.contract} ${rw.ccls}`);
  // The level-up moment fires when the count-up crosses the boundary (bar hits the old cap), not at the end.
  const cross = await waitFor(page, () => {
    const r = document.querySelector('.menu.complete .rewards');
    if (!r.classList.contains('up')) return null;
    return { gain: r.querySelector('.xp-gain').textContent, badge: r.querySelector('.up-badge').hidden, burst: !!r.querySelector('.up-burst'), bursting: window.__game.getSystem('hud').completeRewards.isBursting, counting: window.__game.getSystem('hud').completeRewards.isCounting, audio: window.__ev['audio:play'].filter((a) => a.id === 'level_up').length };
  }, 'level-up crossing', 10000);
  const atCross = Number(cross.gain.replace(/[^\d]/g, ''));
  ok(cross.counting && atCross > 0 && atCross < 340, `.up fires mid count-up (${cross.gain}), not at the end`, JSON.stringify(cross));
  ok(!cross.badge && cross.burst && cross.bursting, '레벨 업 badge + .up-burst light burst at the crossing', JSON.stringify(cross));
  ok(cross.audio === 1, 'audio:play level_up emitted exactly once at the crossing', String(cross.audio));
  await waitSim(1.6);
  rw = await P(() => { const r = document.querySelector('.menu.complete .rewards'); return { gain: r.querySelector('.xp-gain').textContent, fill: r.querySelector('.xp-bar .fill').style.transform, up: r.classList.contains('up'), badge: r.querySelector('.up-badge').hidden, counting: window.__game.getSystem('hud').completeRewards.isCounting, audio: window.__ev['audio:play'].filter((a) => a.id === 'level_up').length }; });
  ok(rw.gain === '+340' && !rw.counting, 'count-up ends at +340', rw.gain);
  ok(rw.up && !rw.badge, 'level-up highlight (.up + 레벨 업 badge) stays after the count', JSON.stringify(rw));
  ok(/scaleX\(0\.13/.test(rw.fill), 'bar settles at 40 / 300 (13 %)', rw.fill);
  ok(rw.audio === 1, 'still a single level_up chime after the count (no second play at the end)', String(rw.audio));
  await sleep(1000);
  ok(await P(() => !document.querySelector('.menu.complete .rewards .up-burst')), 'burst element is removed after its animation');
  await emit('game:phaseChanged', { phase: 'playing', prev: 'complete' });
  ok(await P(() => document.querySelector('.menu.complete').classList.contains('hidden')), 'complete screen hides when the phase moves on');

  console.log('death screen rewards');
  await emit('game:over', { stats: { ...base, extracted: false, rewards: { xpEarned: 80, levelBefore: 3, levelAfter: 3, xp: 120, xpToNext: 300, contract: { id: 'helix_2', corp: 'helix', name: '소탕 작전 II', success: false, progress: 12, target: 60, rep: 0, xp: 0, credits: 0 } } } });
  rw = await P(() => { const m = document.querySelector('.menu.death'); const r = m.querySelector('.rewards'); return { menu: m.className, hidden: r.hidden, lv: r.querySelector('.lv').textContent, num: r.querySelector('.xp-num').textContent, fill: r.querySelector('.xp-bar .fill').style.transform, contract: r.querySelector('.contract-line').textContent, ccls: r.querySelector('.contract-line').className, counting: window.__game.getSystem('hud').deathRewards.isCounting }; });
  ok(!/\bhidden\b/.test(rw.menu) && !rw.hidden && rw.counting, 'game:over with rewards → death screen .rewards block', `${rw.menu} hidden=${rw.hidden}`);
  ok(rw.lv === 'Lv. 3' && rw.num === '120 / 300 XP', 'no level-up → Lv. 3, 120 / 300 XP', `${rw.lv} ${rw.num}`);
  ok(/scaleX\(0\.13/.test(rw.fill), 'bar starts at the pre-mission fraction (40 / 300)', rw.fill);
  ok(rw.contract === '계약 실패 · 진척 유지 안 됨 · 소탕 작전 II 12 / 60' && /\blost\b/.test(rw.ccls), 'death contract line without outcome falls back to 계약 실패 · 진척 유지 안 됨 · p / t', `${rw.contract} ${rw.ccls}`);
  // 2026-09-09: 자동 부활 폐지 — 이 화면에 `부활` 버튼은 아예 없다. 남는 버튼은 `함선으로 귀환` 하나다.
  ok(!(await hud('isRaidFailed')) && (await P(() => !document.querySelector('.menu.death .ui-btn.respawn')
    && [...document.querySelectorAll('.menu.death .ui-btn')].some((b) => b.textContent === '함선으로 귀환'))),
  'plain death: no 부활 button any more, 함선으로 귀환 only');
  await waitSim(1.8);
  rw = await P(() => { const r = document.querySelector('.menu.death .rewards'); return { gain: r.querySelector('.xp-gain').textContent, up: r.classList.contains('up'), fill: r.querySelector('.xp-bar .fill').style.transform, counting: window.__game.getSystem('hud').deathRewards.isCounting, audio: window.__ev['audio:play'].filter((a) => a.id === 'level_up').length }; });
  ok(rw.gain === '+80' && !rw.counting && !rw.up && /scaleX\(0\.4/.test(rw.fill) && rw.audio === 1, 'death count-up ends at +80, bar 40 %, no level-up audio', JSON.stringify(rw));
  await emit('game:phaseChanged', { phase: 'playing', prev: 'dead' });
  // outcome beats the screen: an `incomplete` settlement on the death screen still reads 계약 미완 · 계속
  await emit('game:over', { stats: { ...base, extracted: false, rewards: { xpEarned: 5, levelBefore: 3, levelAfter: 3, xp: 125, xpToNext: 300, contract: { id: 'helix_2', corp: 'helix', name: '소탕 작전 II', success: false, outcome: 'incomplete', progress: 12, target: 60, rep: 0, xp: 0, credits: 0 } } } });
  rw = await P(() => { const r = document.querySelector('.menu.death .rewards'); return { contract: r.querySelector('.contract-line').textContent, ccls: r.querySelector('.contract-line').className }; });
  ok(rw.contract === '계약 미완 · 계속 · 소탕 작전 II 12 / 60' && /\bkeep\b/.test(rw.ccls), 'outcome incomplete on the death screen → 계약 미완 · 계속 (.keep)', `${rw.contract} ${rw.ccls}`);
  await emit('game:phaseChanged', { phase: 'playing', prev: 'dead' });

  console.log('raid failed');
  await P(() => { window.__ev['game:respawn'].length = 0; });
  await emit('game:raidFailed', { stats: { ...base, extracted: false } });
  await emit('game:over', { stats: { ...base, extracted: false } });
  let rf = await P(() => { const m = document.querySelector('.menu.death'); return { cls: m.className, title: m.querySelector('.title').textContent, sub: m.querySelector('.subtitle').textContent, respawnHidden: !m.querySelector('.ui-btn.respawn'), autoHidden: m.querySelector('.auto-return').hidden, auto: m.querySelector('.auto-return').textContent, hasReturn: [...m.querySelectorAll('.ui-btn')].some((b) => b.textContent === '함선으로 귀환'), failed: window.__game.getSystem('hud').isRaidFailed }; });
  ok(!/\bhidden\b/.test(rf.cls) && /\braid-failed\b/.test(rf.cls) && rf.failed, 'game:raidFailed + game:over → death screen in .raid-failed mode', rf.cls);
  ok(rf.title === '레이드 실패' && rf.sub.includes('전멸'), 'title 레이드 실패', `${rf.title} / ${rf.sub}`);
  ok(rf.respawnHidden && rf.hasReturn, 'no 부활 button in the DOM at all, 함선으로 귀환 stays', JSON.stringify(rf));
  const autoS = 12; // RAID_FAILED_AUTO_RETURN_S (src/shared/constants.ts)
  ok(!rf.autoHidden && rf.auto === `${autoS}초 후 자동 귀환`, `auto-return line reads ${autoS}초 후 자동 귀환 (RAID_FAILED_AUTO_RETURN_S)`, rf.auto);
  await waitSim(1.6);
  rf = await P(() => ({ auto: document.querySelector('.menu.death .auto-return').textContent }));
  const left = Number(rf.auto.replace(/[^\d]/g, ''));
  ok(left > 0 && left <= autoS - 1, `countdown ticks on sim time (${rf.auto})`, rf.auto);
  await P(() => { const ev = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }); document.body.dispatchEvent(ev); });
  await emit('game:respawnAvailable', { seconds: 0 });
  await P(() => { const ev = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }); document.body.dispatchEvent(ev); });
  const respawns = await P(() => window.__ev['game:respawn'].length);
  ok(respawns === 0 && (await P(() => document.querySelector('.menu.death').classList.contains('raid-failed'))), 'Space never emits game:respawn (자동 부활 폐지 — 화면에 부활 경로가 없다)', String(respawns));
  await emit('game:phaseChanged', { phase: 'playing', prev: 'dead' });
  ok(await P(() => document.querySelector('.menu.death').classList.contains('hidden')), 'raid-failed screen hides when the phase moves on');
  // (the mode reset on game:abort is asserted in the final "mission reset" section)

  console.log('rewards hidden without data');
  await emit('game:complete', { stats: { ...base, extracted: true, rewards: { xpEarned: 10, levelBefore: 1, levelAfter: 1, xp: 10, xpToNext: 120, contract: null } } });
  rw = await P(() => { const r = document.querySelector('.menu.complete .rewards'); return { hidden: r.hidden, chidden: r.querySelector('.contract-line').hidden, lv: r.querySelector('.lv').textContent }; });
  ok(!rw.hidden && rw.chidden && rw.lv === 'Lv. 1', 'contract null → block shown, contract line hidden', JSON.stringify(rw));
  await emit('game:phaseChanged', { phase: 'playing', prev: 'complete' });
  await emit('game:complete', { stats: { ...base, extracted: true } });
  rw = await P(() => { const m = document.querySelector('.menu.complete'); return { menu: m.className, hidden: m.querySelector('.rewards').hidden, counting: window.__game.getSystem('hud').completeRewards.isCounting }; });
  ok(!/\bhidden\b/.test(rw.menu) && rw.hidden && !rw.counting, 'rewards undefined → block hidden (legacy emitter)', JSON.stringify(rw));
  await emit('game:phaseChanged', { phase: 'playing', prev: 'complete' });
  await emit('game:over', { stats: { ...base, extracted: false } });
  rw = await P(() => ({ hidden: document.querySelector('.menu.death .rewards').hidden }));
  ok(rw.hidden, 'death screen hides the block without rewards too', JSON.stringify(rw));
  await emit('game:phaseChanged', { phase: 'playing', prev: 'dead' });

  console.log('suspended members / squad badges');
  // A fake peer from remotePlayers.debugSpawn (real avatar, no relay) fed to the nameplates + squad panel through hud.debugRemotes.
  await P(() => {
    const ctx = window.__game.ctx;
    const rp = window.__game.getSystem('remotePlayers');
    const pos = ctx.player.position.clone();
    const fwd = ctx.player.getForward(pos.clone());
    pos.addScaledVector(fwd, 4);
    window.__peer = rp.debugSpawn({ slot: 1, name: '브라보', position: pos });
    window.__lobby = {
      code: 'SMOKE1', hostId: 'me', started: true, seed: 11, isPublic: false, mode: 'raid',
      players: [
        { id: ctx.net?.localId ?? 'me', name: ctx.net?.playerName ?? '나', slot: 0, ready: true, isHost: true, connected: true, inMission: true },
        { id: window.__peer.id, name: '브라보', slot: 1, ready: true, isHost: false, connected: true, inMission: true },
      ],
    };
    window.__game.getSystem('hud').debugRemotes([window.__peer], window.__lobby);
  });
  await waitSim(0.3);
  const rowOf = (name) => P((n) => { const r = [...document.querySelectorAll('.squad .srow')].find((e) => !e.hidden && e.querySelector('.name').textContent === n); return r ? { cls: r.className, state: r.querySelector('.state').textContent, badge: r.querySelector('.badge').textContent, badgeHidden: r.querySelector('.badge').hidden, badgeCls: r.querySelector('.badge').className, bleedTf: r.querySelector('.hp .bleed').style.transform, bleedDisp: getComputedStyle(r.querySelector('.hp .bleed')).display } : null; }, name);
  let row = await rowOf('브라보');
  ok(!!row && !/\bsuspended\b/.test(row.cls) && row.state === '', 'debug peer row in the squad panel, connected (no state text)', JSON.stringify(row));
  ok(!!row && row.badge === '임무 중' && !row.badgeHidden, 'raid member badge 임무 중', JSON.stringify(row));
  const squadPos = await P(() => {
    const s = document.querySelector('.squad'), v = document.querySelector('.hud .vitals');
    const sr = s.getBoundingClientRect(), vr = v.getBoundingClientRect();
    return { h: Math.round(sr.height), above: sr.bottom <= vr.top + 4, left: Math.round(sr.left), vLeft: Math.round(vr.left) };
  });
  ok(squadPos.h > 0 && squadPos.above && squadPos.left === squadPos.vLeft, `분대 목록이 좌하단 체력바 바로 위 (h ${squadPos.h}, left ${squadPos.left})`, JSON.stringify(squadPos));
  const meRow = await P(() => { const r = document.querySelector('.squad .srow.me'); return r ? { badge: r.querySelector('.badge').textContent, name: r.querySelector('.name').textContent } : null; });
  ok(!!meRow && meRow.badge === '임무 중' && meRow.name.endsWith('(나)'), 'local row also carries 임무 중', JSON.stringify(meRow));
  let plate = await P(() => { const p = [...document.querySelectorAll('.nameplate')].find((e) => e.querySelector('.name').textContent === '브라보'); return p ? { cls: p.className, op: p.style.opacity, tagHidden: p.querySelector('.tag').hidden, tag: p.querySelector('.tag').textContent } : null; });
  ok(!!plate && Number(plate.op) > 0 && !/\bsuspended\b/.test(plate.cls) && plate.tagHidden, 'nameplate visible over the avatar, no tag while connected', JSON.stringify(plate));
  // C-19 (2026-09-11): thin shield bar above the hp bar from ref.shield / maxShield (PlayerSnapshot.sh / shm)
  const shieldOf = () => P(() => { const p = [...document.querySelectorAll('.nameplate')].find((e) => e.querySelector('.name').textContent === '브라보'); const sh = p?.querySelector('.sh'); return p && sh ? { cls: p.className, disp: getComputedStyle(sh).display, tf: sh.querySelector('.fill').style.transform, shc: sh.style.getPropertyValue('--shc'), above: sh.getBoundingClientRect().bottom <= p.querySelector('.hp').getBoundingClientRect().top + 1 } : null; });
  let shp = await shieldOf();
  ok(!!shp && !/\bhas-shield\b/.test(shp.cls) && shp.disp === 'none', 'no armour (maxShield undefined) -> no shield bar on the nameplate', JSON.stringify(shp));
  await P(() => { window.__peer.armorId = 'armor_3'; window.__peer.maxShield = 60; window.__peer.shield = 30; });
  await waitSim(0.3);
  shp = await shieldOf();
  ok(!!shp && /\bhas-shield\b/.test(shp.cls) && shp.disp === 'block' && shp.tf === 'scaleX(0.5)' && shp.above && shp.shc === 'var(--r-rare)', 'shield 30 / 60 -> .has-shield bar above the hp bar at scaleX 0.5, armour rarity colour', JSON.stringify(shp));
  await P(() => { window.__peer.isDowned = true; });
  await waitSim(0.3);
  shp = await shieldOf();
  ok(!!shp && !/\bhas-shield\b/.test(shp.cls) && shp.disp === 'none', 'downed peer -> shield bar hidden', JSON.stringify(shp));
  await P(() => { window.__peer.isDowned = false; window.__peer.armorId = null; window.__peer.maxShield = undefined; window.__peer.shield = undefined; });
  await waitSim(0.3);
  // socket drops: net/ flips ref.suspended (ref stays, stale by definition), LobbyPlayer.connected=false, net:peerSuspended
  await P(() => {
    window.__peer.suspended = true; window.__peer.stale = true;
    window.__lobby.players[1].connected = false;
    window.__game.ctx.bus.emit('net:peerSuspended', { id: window.__peer.id, name: '브라보', suspended: true });
  });
  await waitSim(0.3);
  row = await rowOf('브라보');
  ok(!!row && row.state === '연결 끊김' && /\bsuspended\b/.test(row.cls) && /\boff\b/.test(row.cls), 'suspended member → squad state 연결 끊김 (.suspended.off grey)', JSON.stringify(row));
  plate = await P(() => { const p = [...document.querySelectorAll('.nameplate')].find((e) => e.querySelector('.name').textContent === '브라보'); return p ? { cls: p.className, op: p.style.opacity, tagHidden: p.querySelector('.tag').hidden, tag: p.querySelector('.tag').textContent, sc: getComputedStyle(p).getPropertyValue('--sc').trim() } : null; });
  ok(!!plate && Number(plate.op) > 0 && /\bsuspended\b/.test(plate.cls), 'suspended nameplate stays visible (stale ignored) with .suspended', JSON.stringify(plate));
  ok(!!plate && !plate.tagHidden && plate.tag === '연결 끊김' && plate.sc === '#9aa0aa', '연결 끊김 tag shown, slot colour swapped to grey', JSON.stringify(plate));
  await P(() => { window.__peer.maxShield = 60; window.__peer.shield = 60; });
  await waitSim(0.3);
  shp = await shieldOf();
  ok(!!shp && !/\bhas-shield\b/.test(shp.cls) && shp.disp === 'none', 'suspended member -> no shield bar even with a stale maxShield on the ref', JSON.stringify(shp));
  await P(() => { window.__peer.maxShield = undefined; window.__peer.shield = undefined; });
  // Phase 9: net fills ghostState / ghostDownHp on the suspended ref (host ghost downed → bleeding, dead → 사망)
  const plateOf = () => P(() => { const p = [...document.querySelectorAll('.nameplate')].find((e) => e.querySelector('.name').textContent === '브라보'); return p ? { cls: p.className, op: p.style.opacity, tag: p.querySelector('.tag').textContent, tagCls: p.querySelector('.tag').className, tagHidden: p.querySelector('.tag').hidden, bleedTf: p.querySelector('.hp .bleed').style.transform, bleedDisp: getComputedStyle(p.querySelector('.hp .bleed')).display } : null; });
  await P(() => { window.__peer.ghostState = 1; window.__peer.ghostDownHp = 40; });
  await waitSim(0.3);
  plate = await plateOf();
  ok(!!plate && /\bbleeding\b/.test(plate.cls) && plate.bleedTf === 'scaleX(0.4)' && plate.bleedDisp === 'block' && Number(plate.op) > 0, 'ghostState 1 / ghostDownHp 40 → nameplate .bleeding, bleed bar scaleX 0.4', JSON.stringify(plate));
  ok(!!plate && plate.tag === '연결 끊김' && !plate.tagHidden && !/\bdead\b/.test(plate.cls), 'downed ghost keeps the 연결 끊김 tag (not dead)', JSON.stringify(plate));
  row = await rowOf('브라보');
  ok(!!row && /\bbleeding\b/.test(row.cls) && row.bleedTf === 'scaleX(0.4)' && row.bleedDisp === 'block' && row.state === '연결 끊김' && /\bsuspended\b/.test(row.cls), 'squad row .bleeding with a 40 % red bar over the grey hp, state 연결 끊김', JSON.stringify(row));
  await P(() => { window.__peer.ghostDownHp = 15; });
  await waitSim(0.3);
  plate = await plateOf(); row = await rowOf('브라보');
  ok(!!plate && plate.bleedTf === 'scaleX(0.15)' && !!row && row.bleedTf === 'scaleX(0.15)', 'ghostDownHp 15 → both bars scaleX 0.15', JSON.stringify({ p: plate && plate.bleedTf, r: row && row.bleedTf }));
  await P(() => { window.__peer.ghostState = 2; window.__peer.ghostDownHp = 0; });
  await waitSim(0.3);
  plate = await plateOf(); row = await rowOf('브라보');
  ok(!!plate && plate.tag === '사망' && /\bdead\b/.test(plate.tagCls) && /\bdead\b/.test(plate.cls) && !/\bbleeding\b/.test(plate.cls) && plate.bleedDisp === 'none', 'ghostState 2 → nameplate tag 사망 (.tag.dead, .dead), bleed bar gone', JSON.stringify(plate));
  ok(!!row && row.state === '사망' && /\bsuspended\b/.test(row.cls) && /\bdead\b/.test(row.cls) && !/\bbleeding\b/.test(row.cls), 'squad row state 사망 (.suspended.dead), no bleed bar', JSON.stringify(row));
  await P(() => { window.__peer.ghostState = 0; window.__peer.ghostDownHp = undefined; });
  await waitSim(0.3);
  plate = await plateOf(); row = await rowOf('브라보');
  ok(!!plate && plate.tag === '연결 끊김' && !/\bdead\b|\bbleeding\b/.test(plate.cls) && !!row && row.state === '연결 끊김' && !/\bdead\b|\bbleeding\b/.test(row.cls), 'ghostState 0 (revived ghost) → plain 연결 끊김 again on both', JSON.stringify({ plate, row }));
  await P(() => { window.__peer.ghostState = undefined; });
  let sysLines = await texts('.chat-line.system .txt');
  ok(sysLines.some((t) => t === '브라보 연결 끊김'), 'net:peerSuspended → chat system line 브라보 연결 끊김', JSON.stringify(sysLines.slice(-3)));
  notifs = await texts('.notif');
  ok(notifs.some((t) => t.includes('브라보') && t.includes('연결 끊김')), 'net:peerSuspended → 분대 notification', JSON.stringify(notifs.slice(-3)));
  // training lobby: the peer stays in the ship, we are inside the arena
  await P(() => {
    window.__peer.suspended = false; window.__peer.stale = false;
    window.__lobby.players[1].connected = true; window.__lobby.players[1].inMission = false;
    window.__lobby.mode = 'training';
    window.__game.ctx.bus.emit('net:peerSuspended', { id: window.__peer.id, name: '브라보', suspended: false });
    window.__game.ctx.bus.emit('net:missionMembership', { id: window.__peer.id, inMission: false });
  });
  await waitSim(0.3);
  row = await rowOf('브라보');
  ok(!!row && row.state === '' && !/\bsuspended\b/.test(row.cls) && row.badge === '함선' && /\bship\b/.test(row.badgeCls), 'reconnected + out of the training → state clear, badge 함선 (.ship)', JSON.stringify(row));
  const meRow2 = await P(() => { const r = document.querySelector('.squad .srow.me'); return r ? { badge: r.querySelector('.badge').textContent, cls: r.querySelector('.badge').className } : null; });
  ok(!!meRow2 && meRow2.badge === '훈련장' && /\btraining\b/.test(meRow2.cls), 'local row badge 훈련장 while lobby.mode = training', JSON.stringify(meRow2));
  sysLines = await texts('.chat-line.system .txt');
  ok(sysLines.some((t) => t === '브라보 재연결'), 'suspended:false → chat line 브라보 재연결', JSON.stringify(sysLines.slice(-3)));
  await P(() => { window.__lobby.started = false; });
  await waitSim(0.3);
  row = await rowOf('브라보');
  ok(!!row && row.badgeHidden && row.badge === '', 'no badges while the lobby is not started', JSON.stringify(row));
  await P(() => { window.__game.getSystem('hud').debugRemotes(null); window.__game.getSystem('remotePlayers').debugClear(); });
  await waitSim(0.3);
  const cleared = await P(() => ({ rows: [...document.querySelectorAll('.squad .srow')].filter((e) => !e.hidden).length, plates: document.querySelectorAll('.nameplate').length, squadHidden: document.querySelector('.squad').classList.contains('hidden') }));
  ok(cleared.rows === 0 && cleared.plates === 0 && cleared.squadHidden, 'debugRemotes(null) clears rows and plates, squad hidden again (solo)', JSON.stringify(cleared));

  console.log('host change / training lines');
  await emit('net:hostChanged', { hostId: 'ghost-peer', prev: 'me', isLocalHost: false });
  await emit('net:hostChanged', { hostId: 'me', prev: 'ghost-peer', isLocalHost: true });
  const myName = await P(() => window.__game.ctx.net?.playerName ?? '나');
  sysLines = await texts('.chat-line.system .txt');
  ok(sysLines.some((t) => t === '호스트 변경: 분대원'), 'net:hostChanged (unknown peer) → 호스트 변경: 분대원', JSON.stringify(sysLines.slice(-3)));
  ok(sysLines.some((t) => t === `호스트 변경: ${myName}`), 'net:hostChanged isLocalHost → 호스트 변경: <own name>', JSON.stringify(sysLines.slice(-3)));
  notifs = await texts('.notif');
  ok(notifs.filter((t) => t.includes('호스트 변경')).length === 2 && notifs.some((t) => t.includes('호스트 변경') && t.includes('(나)')), 'two 호스트 변경 notifications, the local one tagged (나)', JSON.stringify(notifs.slice(-3)));
  await emit('training:exitRequested', {});
  sysLines = await texts('.chat-line.system .txt');
  notifs = await texts('.notif');
  ok(sysLines.some((t) => t === '시뮬레이션 훈련장 퇴장') && notifs.some((t) => t.includes('훈련장') && t.includes('퇴장')), 'training:exitRequested → chat line + notification', JSON.stringify(sysLines.slice(-2)));

  /*
   * 2026-09-10: 좌측 상단에 **임무 시간만** 남았다 (사용자 결정). 목표 문구(`.text`) · 보조 문구(`.sub`) ·
   * `임무 목표` 라벨은 전부 사라졌고, `ui:objective` 는 계약으로만 남은 no-op 이다 — 훈련장의 명중 카운터는
   * `hud/TrainingPanel` 이 자기 패널에 그린다.
   */
  console.log('objective = clock only');
  const objective = () => P(() => { const o = document.querySelector('.hud.gameplay .objective'); return { clock: o?.querySelector('.clock')?.textContent ?? null, text: !!o?.querySelector('.text'), sub: !!o?.querySelector('.sub') }; });
  await P(() => { window.__game.ctx.missionMode = 'training'; });
  await emit('game:phaseChanged', { phase: 'playing', prev: 'deploying' });
  let obj = await objective();
  ok(!obj.text && !obj.sub, '임무 목표 문구 · 보조 문구 제거', JSON.stringify(obj));
  ok(/^\d{2}:\d{2}$/.test(obj.clock ?? ''), `좌측 상단에는 임무 시간만 (${obj.clock})`);
  // 계약으로 남긴 no-op: 아무도 그리지 않지만 발행해도 터지지 않아야 한다
  await emit('ui:objective', { text: '시뮬레이션 훈련장 · 출구 콘솔로 종료', subText: '표적 명중 3 / 12' });
  obj = await objective();
  ok(!obj.text && !obj.sub, 'ui:objective 는 no-op — 문구가 되살아나지 않는다', JSON.stringify(obj));
  await P(() => { window.__game.ctx.missionMode = 'raid'; });
  await emit('game:phaseChanged', { phase: 'playing', prev: 'deploying' });
  obj = await objective();
  ok(!obj.text && !obj.sub && obj.clock !== null, '레이드로 돌아와도 시계만 남는다', JSON.stringify(obj));

  console.log('mission reset');
  await emit('meta:contractProgress', { id: 'helix_1', corp: 'helix', goal: 'kill_bugs', progress: 5, target: 25, delta: 1 });
  await emit('meta:creditsChanged', { credits: 700, delta: 90, reason: 'x' });
  ok(await hud('isRaidFailed'), 'raid-failed mode still armed before the abort');
  await emit('game:abort', {});
  await waitSim(1.2);
  const reset = await P(() => { const h = window.__game.getSystem('hud'); return { panel: h.isContractPanelOn, toasts: h.metaToastCount, chips: document.querySelectorAll('.ptoast.credits').length, phase: window.__game.ctx.phase, failed: h.isRaidFailed }; });
  ok(!reset.panel && reset.toasts === 0 && reset.chips === 0, 'game:abort hides the panel and drops pending / live meta toasts', JSON.stringify(reset));
  ok(!reset.failed, 'game:abort resets the death screen out of raid-failed mode', JSON.stringify(reset));

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
