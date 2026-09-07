// Smoke test for the 2026-09-06 UI / implant package: title controls diagram + key rebinding, the hub Tab ship
// screen (stash persistence, implant slot / picker, right-click repair, screen tabs), the terminal without
// scrollbars, and the reworked implants (crosshair gauge, launcher stowed by a weapon key, hold-to-overcharge).
// Usage: node scripts/smoke-controls-hub.mjs [http://localhost:5273/] [--shots]
// Requires `npm run dev` (or `npm run dev:all`). `--shots` writes PNGs to scripts/shots/.
//
// Timing: Engine clamps dt to 50 ms and the frame rate depends on the machine (swiftshader fallback = a few fps), so every wait
// is on simulation time (`waitSim`), never wall-clock. Key taps dispatch keydown+keyup in the same frame.
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith('http')) ?? 'http://localhost:5273/';
const SHOTS = args.includes('--shots');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
// Real GPU through ANGLE D3D11 by default (headless Chrome renders at full speed, CPU stays free). SMOKE_GL=swiftshader falls back to the CPU rasterizer (no GPU / CI).
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];
if (SHOTS) mkdirSync('scripts/shots', { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* page still loading */ }
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const errors = [];
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1680,900', '--no-sandbox',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 900 });
  // Never let headless Chrome take a real pointer lock: on Windows it calls ClipCursor and traps the OS cursor inside the
  // hidden 960×540 window at the top-left of the screen. Scripts fake `pointerLockElement` themselves where they need it.
  await page.evaluateOnNewDocument(() => {
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  // fresh profile / stash / bindings
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.removeItem('scav.stash'); localStorage.removeItem('scav.keybinds'); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => !!window.__game?.ctx, 'engine boot');

  const install = () => page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['implant:wieldChanged', 'implant:energyChanged', 'implant:grappleTargetChanged', 'implant:activated', 'input:bindingsChanged', 'inventory:stashChanged', 'ui:statsToggled', 'weapon:swapStarted']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  await install();
  // Dispatch on document.body like a real key press: an event dispatched *at* window runs its listeners in registration
  // order, which would let the game's Input see a key a capture-phase overlay handler meant to swallow.
  const keyDown = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true })), code);
  const keyUp = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true })), code);
  /** keydown + keyup inside one frame (a wait between them would read as a hold). */
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 240000, t0 + sec); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `scripts/shots/${name}.png` }); };
  const click = async (sel) => {
    const el = await page.$(sel);
    if (!el) throw new Error(`no element ${sel}`);
    await el.click();
  };

  /* ── 1. title: controls diagram ───────────────────────────────────── */
  const title = await page.evaluate(() => ({
    panel: !!document.querySelector('.menu.title .controls-panel'),
    // Scoped to the title menu since Phase 11: the 설정 side panel holds a second ControlsPanel instance.
    keys: document.querySelectorAll('.menu.title .ctl-key').length,
    bound: document.querySelectorAll('.menu.title .ctl-key.bound').length,
    mouseBound: document.querySelectorAll('.menu.title .ctl-mouse-svg .btn.bound').length,
    wasd: !!document.querySelector('.menu.title .ctl-key[data-code="KeyW"].bound') && !!document.querySelector('.menu.title .ctl-key[data-code="KeyQ"].bound'),
    rows: [...document.querySelectorAll('.menu.title .ctl-fn .fn')].map((n) => n.textContent),
    oldList: !!document.querySelector('.menu.title .controls'),
    btn: [...document.querySelectorAll('.menu.title .ui-btn')].some((b) => b.textContent === '키 설정 변경'),
    frame: (() => { const f = document.querySelector('.menu.title .frame'); return { sw: f.scrollWidth, cw: f.clientWidth }; })(),
  }));
  ok(title.panel && title.keys >= 60, `title shows the keyboard diagram (${title.keys} keys)`);
  ok(title.bound >= 18 && title.wasd, `${title.bound} bound keys lit (W, Q included)`);
  ok(title.mouseBound === 3, `mouse LMB / RMB / MMB lit (${title.mouseBound})`);
  ok(title.rows.includes('재장전 / (수류탄을 들고 있을 때) 코킹'), 'reload row carries the cook hint');
  ok(title.rows.includes('함선 호출'), 'ship call row is just 함선 호출');
  ok(!title.rows.some((r) => /수류탄:|아이템 버리기|회전/.test(r)), 'no grenade / inventory-internal rows on the title');
  ok(!title.oldList && title.btn, 'old text list gone, 키 설정 변경 button present');
  ok(title.frame.sw <= title.frame.cw, `title frame has no horizontal overflow (${title.frame.sw}/${title.frame.cw})`);
  await shot('01-title-controls');

  /* ── 2. key rebinding overlay ─────────────────────────────────────── */
  await page.evaluate(() => [...document.querySelectorAll('.menu.title .ui-btn')].find((b) => b.textContent === '키 설정 변경').click());
  ok(await page.evaluate(() => !document.querySelector('.menu.keybind-menu').hidden), 'key-settings overlay opened');
  const rowBtn = (label) => page.evaluateHandle((l) => [...document.querySelectorAll('.kb-row')].find((r) => r.querySelector('.kb-label').textContent === l)?.querySelector('.kb-key'), label);
  // rebind 앉기 → N
  await (await rowBtn('앉기')).asElement().click();
  ok(await page.evaluate(() => !!document.querySelector('.kb-key.capturing')), 'clicking a key button waits for input');
  await keyDown('KeyN'); await keyUp('KeyN');
  const afterBind = await page.evaluate(() => ({
    label: [...document.querySelectorAll('.kb-row')].find((r) => r.querySelector('.kb-label').textContent === '앉기').querySelector('.kb-key').textContent,
    saved: localStorage.getItem('scav.keybinds'),
    titleN: !!document.querySelector('.ctl-key[data-code="KeyN"].bound'),
    titleC: !!document.querySelector('.ctl-key[data-code="KeyC"].bound'),
  }));
  ok(afterBind.label === 'N', `앉기 rebound to N (${afterBind.label})`);
  ok(afterBind.saved && afterBind.saved.includes('"CROUCH":"KeyN"'), 'binding persisted to localStorage');
  ok(afterBind.titleN && !afterBind.titleC, 'title diagram followed the rebinding (N lit, C dark)');
  ok((await ev('input:bindingsChanged')).length >= 1, 'input:bindingsChanged emitted');
  // conflict: 엎드리기 → N as well
  await (await rowBtn('엎드리기')).asElement().click();
  await keyDown('KeyN'); await keyUp('KeyN');
  const conflict = await page.evaluate(() => document.querySelectorAll('.kb-row.conflict').length);
  ok(conflict === 2, `both rows flagged as conflicting (${conflict})`);
  // mouse-only action refuses a keyboard key
  await (await rowBtn('사격 · 사용')).asElement().click();
  await keyDown('KeyK'); await keyUp('KeyK');
  const fireLabel = await page.evaluate(() => [...document.querySelectorAll('.kb-row')].find((r) => r.querySelector('.kb-label').textContent === '사격 · 사용').querySelector('.kb-key').textContent);
  ok(fireLabel === 'LMB', `사격 stays on the mouse after a keyboard press (${fireLabel})`);
  await shot('02-keybinds-conflict');
  // reset
  await page.evaluate(() => [...document.querySelectorAll('.kb-foot .ui-btn')].find((b) => b.textContent.includes('초기화')).click());
  const reset = await page.evaluate(() => ({
    conflicts: document.querySelectorAll('.kb-row.conflict').length,
    crouch: [...document.querySelectorAll('.kb-row')].find((r) => r.querySelector('.kb-label').textContent === '앉기').querySelector('.kb-key').textContent,
    saved: localStorage.getItem('scav.keybinds'),
  }));
  ok(reset.conflicts === 0 && reset.crouch === 'C' && !reset.saved, 'reset restored the defaults and cleared the save');
  await keyDown('Escape'); await keyUp('Escape');
  ok(await page.evaluate(() => document.querySelector('.menu.keybind-menu').hidden && document.querySelector('.menu.title') && !document.querySelector('.menu.title').classList.contains('hidden')), 'Esc closed the overlay, title still up');

  /* ── 3. hub: Tab ship screen ──────────────────────────────────────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.3);
  await tap('Tab');
  try { await waitFor(page, () => window.__game.ctx.inventory.isOpen, 'inventory open in hub', 20000); }
  catch (e) { console.log('  diag', JSON.stringify(await page.evaluate(() => ({ phase: window.__game.ctx.phase, blockers: [...window.__game.ctx.uiBlockers], time: window.__game.ctx.time, down: window.__game.ctx.input.isDown('Tab'), hubMenu: !document.querySelector('.menu.hub-menu').hidden })))); throw e; }
  const hubScreen = await page.evaluate(() => {
    const root = document.querySelector('.inv-root');
    const order = [...root.querySelectorAll('.inv-layout > *')].filter((n) => !n.hidden).map((n) => getComputedStyle(n).order + ':' + n.className.split(' ').pop());
    return {
      hub: root.classList.contains('is-hub'),
      stash: !root.querySelector('.inv-panel-stash').hidden,
      stashCells: root.querySelectorAll('.inv-grid-stash .inv-cell').length,
      tabs: [...root.querySelectorAll('.scr-tab')].map((b) => `${b.textContent}${b.disabled ? '(off)' : ''}${b.classList.contains('is-on') ? '*' : ''}`).join(' '),
      implantSlot: !!root.querySelector('.inv-slot-implant'),
      order,
      hints: root.querySelector('.inv-hints').hidden,
      quickRight: (() => { const g = root.querySelector('.inv-grid-bag').getBoundingClientRect(); const q = root.querySelector('.inv-quick').getBoundingClientRect(); return q.left >= g.right - 4; })(),
      equipMid: (() => { const s = root.querySelector('.inv-panel-stash').getBoundingClientRect(); const e = root.querySelector('.inv-equip').getBoundingClientRect(); const b = root.querySelector('.inv-panel-bag').getBoundingClientRect(); return s.right <= e.left + 4 && e.right <= b.left + 4; })(),
    };
  });
  ok(hubScreen.hub && hubScreen.stash, 'hub Tab shows the ship screen with the stash');
  ok(hubScreen.stashCells === 240, `stash grid is 10×24 (${hubScreen.stashCells} cells)`);
  // Phase 8: 함선 joined the strip (시설 업그레이드 inside the Tab screen)
  ok(hubScreen.tabs === '인벤토리* 캐릭터 기업 함선', `screen tabs: ${hubScreen.tabs}` + ' (함선 added in Phase 8)');
  // Phase 9 UI pass: the 전술 임플란트 slot left the 장착 장비 column — it is a section of the 캐릭터 tab now
  ok(!hubScreen.implantSlot, '전술 임플란트 슬롯이 장비 칸에서 빠졌다 (캐릭터 탭으로 이동)');
  ok(hubScreen.equipMid, 'layout: stash | equipment | bag');
  ok(hubScreen.quickRight, 'quick-use rose sits right of the bag grid (≥ 1600 px)');
  ok(hubScreen.hints, 'inventory hint bar hidden in the ship');
  await shot('03-hub-tab-screen');

  // bag → stash via right-click quick move (API), persistence across reload
  const stashMove = await page.evaluate(() => {
    const inv = window.__game.getSystem('inventory');
    const item = inv.getAllItems().find((i) => i.defId.startsWith('ammo_')) ?? inv.getAllItems()[0];
    const before = inv.getStashItems().length;
    const r = inv.quickMove(item.uid, { kind: 'grid', grid: 'bag' });
    return { r, before, after: inv.getStashItems().length, defId: item.defId, dropRefused: (() => { const it = inv.getAllItems().find((i) => i.defId.startsWith('ammo_')) ?? inv.getAllItems()[0]; const n = inv.getStashItems().length; return inv.dropItem(it.uid) === true && inv.getStashItems().length === n + 1; })() };
  });
  ok(stashMove.r === 'ok' && stashMove.after === stashMove.before + 1, `right-click moved ${stashMove.defId} bag → stash`);
  ok(stashMove.dropRefused, 'dropping in the ship lands in the stash, not the world');
  await sleep(600); // debounced save
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('scav.stash') ?? 'null'));
  ok(saved && saved.items?.length === stashMove.after + 1, `stash saved to localStorage (${saved?.items?.length} stacks)`);

  /* 전술 임플란트 (Phase 9 UI pass): the modeless picker is gone — every implant is a card in the 캐릭터 tab */
  const toTab = (label) => page.evaluate((l) => {
    const b = [...document.querySelectorAll('.inv-root .scr-tab')].find((x) => x.textContent === l);
    b?.click();
    return !!b;
  }, label);
  ok(await toTab('캐릭터'), '캐릭터 탭으로 전환');
  await sleep(220);
  const impTab = await page.evaluate(() => ({
    cards: document.querySelectorAll('.cs-implants .cs-imp-card').length,
    picker: !!document.querySelector('.inv-implant-picker'),
    hint: document.querySelector('.cs-implants .hint')?.textContent ?? '',
  }));
  ok(impTab.cards === 6 && !impTab.picker, `캐릭터 탭이 임플란트 6종을 카드로 보여준다 (${impTab.cards}, 옛 picker ${impTab.picker})`);
  await shot('04-implant-cards');
  await page.evaluate(() => document.querySelector('.cs-imp-card[data-id="overcharge"]').click());
  ok(await page.evaluate(() => window.__game.ctx.implants.equipped === 'overcharge'), 'clicking a card equips it');
  // the 장착 중 label hangs under the description column, not off the right edge of the row
  const tag = await page.evaluate(() => {
    const card = document.querySelector('.cs-imp-card.is-equipped');
    if (!card) return null;
    return { body: getComputedStyle(card.querySelector('.body'), '::after').content,
      row: getComputedStyle(card, '::after').content, desc: !!card.querySelector('.desc') };
  });
  ok(!!tag && /장착 중/.test(tag.body) && !/장착 중/.test(tag.row) && tag.desc, `장착 중 label renders under the description (${tag?.body})`);
  await page.evaluate(() => document.querySelector('.cs-imp-card[data-id="overcharge"]').click());
  ok(await page.evaluate(() => window.__game.ctx.implants.equipped === null), 'clicking the equipped card unequips it');
  await page.evaluate(() => document.querySelector('.cs-imp-card[data-id="atlauncher"]').click());
  ok(await page.evaluate(() => window.__game.ctx.implants.equipped === 'atlauncher'
    && document.querySelector('.cs-imp-card[data-id="atlauncher"]').classList.contains('is-equipped')), '대전차포 장착 (카드가 켜진다)');
  ok(await toTab('인벤토리'), '인벤토리 탭으로 복귀');
  await sleep(200);

  // right-click repair on a worn equipped weapon
  const repairPrep = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const w = inv.getEquipped('primary');
    inv.updateItem(w.uid, { durability: 100 });
    inv.tryAddItem(ctx.loot.createItem('mat_scrap', 10));
    const sys = window.__game.getSystem('inventory');
    return { uid: w.uid, info: sys.repairInfo(w.uid), meta: document.querySelector('.inv-slot-primary .inv-slot-meta').textContent };
  });
  ok(repairPrep.info && repairPrep.info.cost.length > 0 && !repairPrep.info.short, `repair cost listed: ${repairPrep.info?.cost.map((c) => `${c.name}×${c.qty}`).join(',')}`);
  ok(/내구도 100\//.test(repairPrep.meta), `slot meta shows durability (${repairPrep.meta})`);
  const slotTile = await page.$('.inv-slot-primary .inv-tile');
  await slotTile.click({ button: 'right' });
  const menuItems = await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].map((n) => n.textContent));
  ok(menuItems.some((t) => t.startsWith('수리')), `context menu offers 수리: ${menuItems.join(' | ')}`);
  ok(!menuItems.some((t) => t.startsWith('버리기')), 'no 버리기 entry in the ship');
  await shot('05-repair-menu');
  await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].find((n) => n.textContent.startsWith('수리')).click());
  const repaired = await page.evaluate((uid) => window.__game.ctx.inventory.getDurability(uid), repairPrep.uid);
  ok(repaired.durability === repaired.max, `repaired to ${repaired.durability}/${repaired.max}`);

  // screen tabs (Phase 8): 캐릭터 / 기업 / 함선 render INSIDE the Tab screen, the window never closes
  await page.evaluate(() => [...document.querySelectorAll('.inv-root .scr-tab')].find((b) => b.textContent === '캐릭터').click());
  await waitFor(page, () => !!document.querySelector('.inv-root .inv-screen .cs-embed') && !document.querySelector('.inv-root .inv-screen').hidden && window.__game.ctx.inventory.isOpen, 'character view embedded in the Tab screen');
  ok(true, '캐릭터 tab renders inside the Tab screen without closing it');
  ok(await page.evaluate(() => document.querySelector('.menu.char-sheet')?.hidden !== false), 'the standalone character overlay stays closed');
  await shot('06-character-tabs');
  await page.evaluate(() => [...document.querySelectorAll('.inv-root .scr-tab')].find((b) => b.textContent === '함선').click());
  await waitFor(page, () => !!document.querySelector('.inv-root .inv-screen .hs-ship'), '함선 view embedded in the Tab screen');
  ok(true, '함선 tab renders the ship facilities inside the Tab screen');
  // Phase 8 UI pass: the embedded screens sit on their own opaque panel, and the 함선 tab is two columns
  const ship = await page.evaluate(() => {
    const host = document.querySelector('.inv-root .inv-screen');
    const cs = getComputedStyle(host);
    const btn = host.querySelector('.hs-manage-btn');
    return { bg: cs.backgroundImage, border: cs.borderTopWidth, cols: !!host.querySelector('.hs-ship-cols'),
      facilities: [...host.querySelectorAll('.hs-row.facility')].map((r) => r.dataset.facility),
      rooms: host.querySelectorAll('.hs-row.room').length,
      // Phase 9 UI pass: no 용도 드롭다운 in the 방 목록 any more, and room 1 offers no 제거 button
      pickers: host.querySelectorAll('.hs-row.room .purpose').length,
      workshopName: host.querySelector('.hs-row.room[data-room="0"] .name')?.textContent ?? '',
      workshopDel: !host.querySelector('.hs-row.room[data-room="0"] .hs-del')?.hidden,
      thumbs: host.querySelectorAll('.hs-row.room .hs-thumb, .hs-row.facility .hs-thumb').length,
      bar: !!host.querySelector('.hs-ship-bar'),
      // Phase 9 UI pass: the panel itself no longer scrolls (the 방 목록 does), so the bar is a plain bottom strip
      screenScroll: getComputedStyle(host).overflowY,
      roomsScroll: getComputedStyle(host.querySelector('.hs-list.rooms')).overflowY,
      subtitle: !!host.querySelector('.hs-ship .hs-head .subtitle'),
      buildBtns: [...host.querySelectorAll('.hs-row.room .hs-row-acts .ui-btn')].filter((b) => !b.hidden && /시설 증축/.test(b.textContent)).length,
      btn: btn?.textContent ?? null, sticky: btn ? getComputedStyle(btn.parentElement).position : null };
  });
  ok(ship.bg !== 'none' && ship.border !== '0px', `the Tab screen has its own panel background (${ship.border} border)`);
  ok(ship.cols && ship.facilities.join(',') === 'generator,storage' && ship.rooms === 10, `기본 시설 발전기 · 창고 left, 방 목록 (${ship.rooms}) right (${ship.facilities.join(',')})`);
  ok(ship.pickers === 0 && ship.workshopName === '작업실', `방 목록 has no 용도 드롭다운, rows read the purpose name ('${ship.workshopName}')`);
  ok(!ship.workshopDel, '방 1 (기본 작업실) offers no 시설 제거 button');
  ok(ship.thumbs === 12, `every 시설 / 방 row leads with the shared thumbnail (${ship.thumbs})`);
  ok(ship.bar && /시설 관리/.test(ship.btn ?? '') && ship.sticky === 'static', `separate bottom bar with the 시설 관리 (M) button on its right (${ship.btn})`);
  ok(ship.screenScroll === 'hidden' && ship.roomsScroll === 'auto' && !ship.subtitle,
    `패널은 스크롤하지 않고 방 목록만 스크롤한다, '용도가 정해진 방' 라벨 없음 (${ship.screenScroll} / ${ship.roomsScroll})`);
  ok(ship.buildBtns === 9, `빈 방 9개가 시설 증축 버튼을 가진다 (${ship.buildBtns})`);
  // 재료 요구 칩 hover card (ui/hud/ItemTip): any cost chip anywhere shows the item's info
  const tip = await page.evaluate(() => {
    const chip = document.querySelector('.inv-root .inv-screen .item-chip[data-def-id]');
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    chip.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 }));
    const tipEl = document.querySelector('#ui-root > .item-tip');
    return { defId: chip.dataset.defId, hidden: tipEl?.hidden ?? true, name: tipEl?.querySelector('.it-name')?.textContent ?? '',
      rows: tipEl?.querySelectorAll('.it-stats .k').length ?? 0, shown: window.__game.getSystem('hud').itemTipDefId };
  });
  ok(tip && !tip.hidden && tip.shown === tip.defId && tip.rows >= 3, `hovering a 재료 칩 shows the item card (${tip?.name} · ${tip?.rows} rows)`);
  await page.evaluate(() => {
    const chip = document.querySelector('.inv-root .inv-screen .item-chip[data-def-id]');
    chip.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
  });
  ok(await page.evaluate(() => document.querySelector('#ui-root > .item-tip').hidden && window.__game.getSystem('hud').itemTipDefId === null), 'leaving the chip hides the card');
  await page.evaluate(() => [...document.querySelectorAll('.inv-root .scr-tab')].find((b) => b.textContent === '인벤토리').click());
  await waitFor(page, () => document.querySelector('.inv-root .inv-screen').hidden && !document.querySelector('.inv-root .inv-layout').hidden && window.__game.ctx.inventory.isOpen, 'back to the bag view');
  ok(true, '인벤토리 tab returns to the bag / stash view');
  await keyDown('Escape'); await keyUp('Escape');
  await waitFor(page, () => !window.__game.ctx.inventory.isOpen, 'inventory closed');

  // reload: stash persists, bag resets (policy unchanged)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => !!window.__game?.ctx, 'engine boot (reload)');
  await install();
  const persisted = await page.evaluate((def) => {
    const sys = window.__game.getSystem('inventory');
    return { n: sys.getStashItems().length, has: sys.getStashItems().some((i) => i.defId === def), implant: window.__game.ctx.progression?.profile.implant };
  }, stashMove.defId);
  ok(persisted.n === stashMove.after + 1 && persisted.has, `stash survived a reload (${persisted.n} stacks, ${stashMove.defId} present)`);

  /* ── 4. terminal: no scrollbars, no implant / repair tabs ─────────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase (2)');
  await waitSim(0.3);
  // Phase 8: Escape in the ship opens the PAUSE menu now, so the terminal is opened through its interactable.
  await page.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_terminal').interact());
  await waitFor(page, () => !document.querySelector('.menu.hub-menu').hidden, 'terminal open');
  const term = await page.evaluate(() => {
    const f = document.querySelector('.menu.hub-menu .frame');
    return { sw: f.scrollWidth, cw: f.clientWidth, sh: f.scrollHeight, ch: f.clientHeight, ov: getComputedStyle(f).overflow, tabs: document.querySelectorAll('.hub-tab').length, panels: document.querySelectorAll('.imp-list, .rep-list').length };
  });
  ok(term.sw <= term.cw && term.sh <= term.ch, `terminal frame has no scroll overflow (${term.sw}/${term.cw} × ${term.sh}/${term.ch})`);
  ok(term.tabs === 0 && term.panels === 0, 'terminal has no 임플란트 / 정비 tabs any more');
  // Phase 10 cursor migration: the terminal takes the software cursor and KEEPS the pointer lock (no exitPointerLock).
  const termCursor = await page.evaluate(() => ({
    blocker: window.__game.ctx.uiBlockers.has('hub'),
    cursor: window.__game.ctx.input.isCursorMode,
  }));
  ok(termCursor.blocker && termCursor.cursor === true, `terminal holds the 'hub' blocker and the software cursor (cursor ${termCursor.cursor})`);
  await shot('07-terminal');
  await tap('Escape');
  await waitFor(page, () => document.querySelector('.menu.hub-menu').hidden, 'terminal closed');
  await waitSim(0.2);
  ok((await page.evaluate(() => window.__game.ctx.input.isCursorMode)) === false, 'closing the terminal releases the software cursor');

  /* ── 5. mission A: 대전차포 wielded → weapon key stows it ─────────── */
  const startMission = async (seed) => {
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.world?.ready === true, 'world ready');
    await waitFor(page, () => window.__game.ctx.isGameplayPhase(), 'gameplay phase');
    await waitFor(page, () => window.__game.ctx.player?.isDropping === false, 'drop-in finished', 90000);
    await waitSim(1.0);
  };
  const backToShip = async () => {
    await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
    await waitSim(0.3);
  };
  await page.evaluate(() => window.__game.ctx.implants.setEquipped('atlauncher'));
  await startMission(42);
  ok(await page.evaluate(() => !!document.querySelector('.implant-gauge') && !document.querySelector('.implant-gauge').hidden && document.querySelector('.implant-gauge').dataset.implant === 'atlauncher'), 'implant gauge shown for 대전차포');
  const gaugePos = await page.evaluate(() => { const r = document.querySelector('.implant-gauge').getBoundingClientRect(); return { right: r.right, cx: innerWidth / 2, cy: innerHeight / 2, top: r.top, bottom: r.bottom }; });
  ok(gaugePos.right < gaugePos.cx && gaugePos.top < gaugePos.cy && gaugePos.bottom > gaugePos.cy, 'gauge sits left of the crosshair, vertically centred');
  await tap('KeyQ');
  await waitSim(0.2);
  ok(await page.evaluate(() => window.__game.ctx.implants.wielded && window.__game.ctx.implants.blocksWeapons), 'Q wields the launcher (weapons holstered)');
  await tap('Digit3');
  await waitSim(0.3);
  const stowed = await page.evaluate(() => ({ wielded: window.__game.ctx.implants.wielded, swaps: window.__ev['weapon:swapStarted'].length }));
  ok(!stowed.wielded, 'pressing 3 stowed the launcher (the old bug: keys were ignored while wielded)');
  ok(stowed.swaps >= 1 && (await ev('weapon:swapStarted')).some((s) => s.slot === 'secondary'), 'and drew the secondary');
  await shot('08-gauge-launcher');

  /* ── 6. mission B: 오버차지 = hold Q, energy drains / refills ───────── */
  await backToShip();
  ok(await page.evaluate(() => window.__game.ctx.implants.setEquipped('overcharge')), 'overcharge equipped in the ship');
  await startMission(43);
  const e0 = await page.evaluate(() => ({ e: window.__game.ctx.implants.energy, max: window.__game.ctx.implants.energyMax, hp: window.__game.ctx.player.hp }));
  ok(e0.max > 0 && e0.e === e0.max, `overcharge starts with full energy (${e0.e}/${e0.max})`);
  await page.evaluate(() => window.__game.ctx.player.takeDamage(40));
  await keyDown('KeyQ');
  await waitSim(1.5);
  const held = await page.evaluate(() => ({ holding: window.__game.ctx.implants.holding, e: window.__game.ctx.implants.energy, hp: window.__game.ctx.player.hp, wielded: window.__game.ctx.implants.wielded, gaugeHold: document.querySelector('.implant-gauge').classList.contains('holding') }));
  ok(held.holding && !held.wielded, 'holding Q channels without holstering the gun');
  ok(held.e < e0.max - 1, `energy drained while held (${held.e.toFixed(2)})`);
  ok(held.hp > 60.5, `self heal ticked (hp 60 → ${held.hp.toFixed(1)})`);
  ok(held.gaugeHold, 'gauge shows the holding state');
  await shot('09-gauge-overcharge');
  await keyUp('KeyQ');
  // the screenshot above took wall time while Q was still down; sample right after the release, then let it refill
  const eRelease = await page.evaluate(() => window.__game.ctx.implants.energy);
  await waitSim(1.0);
  const released = await page.evaluate(() => ({ holding: window.__game.ctx.implants.holding, e: window.__game.ctx.implants.energy, n: window.__ev['implant:energyChanged'].length }));
  ok(!released.holding && released.e > eRelease + 0.2, `released: channel stopped, energy refilling (${eRelease.toFixed(2)} → ${released.e.toFixed(2)})`);
  ok(released.n >= 3, `implant:energyChanged emitted (${released.n})`);

  /* ── 7. mission C: 대시 = three segments, one refilling ───────────── */
  await backToShip();
  await page.evaluate(() => window.__game.ctx.implants.setEquipped('dash'));
  await startMission(44);
  const dash0 = await page.evaluate(() => ({ segs: [...document.querySelectorAll('.implant-gauge .seg')].filter((s) => !s.hidden).length, ready: document.querySelectorAll('.implant-gauge .seg.ready').length, read: document.querySelector('.implant-gauge .read').textContent }));
  ok(dash0.segs === 3 && dash0.ready === 3, `dash gauge: 3 segments, all ready (${dash0.read})`);
  await tap('KeyQ');
  await waitSim(0.6);
  const dash1 = await page.evaluate(() => ({ ready: document.querySelectorAll('.implant-gauge .seg.ready').length, filling: document.querySelectorAll('.implant-gauge .seg.filling').length, charges: window.__game.ctx.implants.charges }));
  ok(dash1.charges === 2 && dash1.ready === 2 && dash1.filling === 1, `after a dash: 2 ready, 1 refilling (charges ${dash1.charges})`);
  await shot('10-gauge-dash');

  /* ── 8. grapple: instant Q, target bracket ────────────────────────── */
  await backToShip();
  await page.evaluate(() => window.__game.ctx.implants.setEquipped('grapple'));
  await startMission(45);
  // look slightly down so the aim ray hits terrain within range
  await page.evaluate(() => { const p = window.__game.ctx.player; if (typeof p.addRecoil === 'function') p.addRecoil(-0.45, 0); });
  await waitSim(0.25);
  const gtarget = await page.evaluate(() => { const a = window.__ev['implant:grappleTargetChanged']; return { last: a[a.length - 1], hook: !document.querySelector('.reticle .hook').hidden, wielded: window.__game.ctx.implants.wielded }; });
  ok(gtarget.last?.valid === true && gtarget.hook && !gtarget.wielded, `grapple target valid without wielding (${gtarget.last?.distance?.toFixed(1)} m), bracket shown`);
  await tap('KeyQ');
  await waitSim(0.3);
  ok((await ev('implant:activated')).some((a) => a.id === 'grapple'), 'Q fired the grapple instantly');

  ok(errors.length === 0, 'no console errors', errors.slice(0, 6).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness: ${e.message}`);
  if (errors.length) console.log(`  console errors: ${errors.slice(0, 8).join(' | ')}`);
} finally {
  await browser.close();
}

console.log(`\nsmoke: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
