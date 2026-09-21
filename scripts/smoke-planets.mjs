// Smoke test for 행성 선택 (Phase 11 §3-3, hub folder, 2026-09-07) — **solo path only**; the lobby path
// (host picks / guest mirrors / non-host refusal) is `npm run e2e:mp`'s.
//
// Covers: the full-screen terminal (three columns, the 승무원 이름 section and `.seed-hint` both gone, `닫기 (E)`,
// `hub:terminalToggled`, Phase 10 cursor etiquette), the 행성 홀로그램 canvas + its ◀ ▶ / arrow / A-D stepping
// (preview only — `ctx.hub.planet` does not move), 행성 이동 → `hub:travel start` → the warp cutscene →
// `hub:travel end` + `hub:planetChanged`, the window planet re-tinted to the destination, `PLANET_STORAGE_KEY`
// persistence across a reload, the terminal screen's `목표 <행성>` line, `setPlanet` refusals, the launch-slot gate
// (prompt + refusal while 목표 미지정, boarding allowed after) and `game:newMission {planet}` / `ctx.missionPlanet`.
//
// Usage: node scripts/smoke-planets.mjs [http://localhost:5299/]   (needs a vite instance, no relay required)
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:5273/';
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

/** The five planets, in `PLANET_IDS` order (kept in step with `src/shared/planets.ts` by the checks below). */
const PLANETS = [
  { id: 'amber', name: '아켈론 II', terrain: '호박빛 사막', threat: 1, hologram: 0xb89a68 },
  { id: 'tundra', name: '보레아스 IX', terrain: '동토 툰드라', threat: 2, hologram: 0xcbd0cc },
  { id: 'mossy', name: '베르단트 III', terrain: '이끼 습지', threat: 2, hologram: 0x66683c },
  { id: 'ashen', name: '피로스 VII', terrain: '잿빛 화산지대', threat: 3, hologram: 0x4c4c4e },
  { id: 'crimson', name: '카민 I', terrain: '적색 외계 평원', threat: 3, hologram: 0x8e3c4c },
];
const THREAT_LABELS = ['', '위협 낮음', '위협 보통', '위협 높음'];

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1600,900', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.evaluateOnNewDocument(() => {
    // 2026-09-08: this script does not check the tutorial. The tutorial starts by itself on a fresh profile and
    // locks room purposes · crafting · the terminal · boarding one after another, so here it is marked 「already
    // finished」 (the tutorial itself is smoke-tutorial.mjs's business).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // Park vite's HMR socket AND the relay socket: this script is the solo path, a real relay must not hand us a lobby.
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  /** Boot (or re-boot) the page with a driven frame loop and the event taps installed. */
  const boot = async (label) => {
    await page.goto(BASE, { waitUntil: 'load' });
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.hub, `boot (${label})`);
    await page.evaluate(() => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      window.__ev = {};
      const bus = window.__game.ctx.bus;
      for (const n of ['hub:entered', 'hub:left', 'hub:travel', 'hub:planetChanged', 'hub:terminalToggled',
        'ui:hubMenuToggled', 'ui:notify', 'game:newMission', 'world:ready', 'hub:launchCountdown']) {
        window.__ev[n] = [];
        bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
      }
    });
  };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  // headless rendering runs at a few fps and dt is clamped to 50 ms: wait on simulation time, not wall time
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const ev = (n) => P((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const screenText = () => P(() => window.__game.getSystem('hub').terminal?.def.screen.last ?? '');
  const openTerminal = async () => {
    await P(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_terminal').interact());
    await waitFor(page, () => !document.querySelector('.menu.hub-menu').hidden, 'terminal open');
    await waitSim(0.15);
  };
  const clickSel = (sel) => P((s) => {
    const b = document.querySelector(s);
    if (!b) return false;
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }, sel);
  const planetCard = () => P(() => ({
    name: document.querySelector('.hp-name')?.textContent ?? null,
    terrain: document.querySelector('.hp-terrain')?.textContent ?? null,
    threat: document.querySelector('.hp-threat')?.textContent ?? null,
    threatLv: document.querySelector('.hp-threat')?.dataset.threat ?? null,
    brief: document.querySelector('.hp-brief')?.textContent ?? null,
    dots: [...document.querySelectorAll('.hp-dots i')].map((d) => `${d.dataset.planet}${d.classList.contains('on') ? '*' : ''}${d.classList.contains('here') ? '!' : ''}`),
    travel: document.querySelector('.ui-btn.hp-travel')?.textContent ?? null,
    travelOff: document.querySelector('.ui-btn.hp-travel')?.disabled ?? null,
    current: document.querySelector('.hp-current')?.hidden ?? null,
    hubPlanet: window.__game.ctx.hub.planet,
  }));

  /* ── 1. 목표 미지정: state, terminal screen, launch-slot gate ─────────── */
  console.log('목표 미지정');
  await boot('fresh');
  await page.evaluate(() => { try { localStorage.removeItem('scav.s1.planet'); } catch {} });
  await boot('no planet');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.3);
  const s0 = await P(() => ({ planet: window.__game.ctx.hub.planet, travelling: window.__game.ctx.hub.travelling, mission: window.__game.ctx.missionPlanet }));
  ok(s0.planet === null, `fresh profile has no 목표 행성 (${s0.planet})`);
  ok(s0.travelling === false, 'ctx.hub.travelling false in the ship');
  ok(s0.mission === null, `ctx.missionPlanet starts null (${s0.mission})`);
  ok((await screenText()).includes('목표 목표 미지정'), `terminal screen reads 목표 미지정 (${(await screenText()).split('\n').join(' / ')})`);
  const pod0 = await P(() => {
    const ctx = window.__game.ctx;
    const it = ctx.interactables.all().find((i) => i.id === 'hub_pod_0');
    const n0 = window.__ev['ui:notify'].length;
    const prompt = it?.getPrompt() ?? null;
    const can = it?.canInteract() ?? null;
    it?.interact();
    return { prompt, can, inPod: ctx.player.isInPod, notes: window.__ev['ui:notify'].slice(n0).map((n) => n.text) };
  });
  ok(pod0.prompt === '목표 행성 미지정 — 터미널에서 지정', `pod prompt "${pod0.prompt}"`);
  ok(pod0.can === true, 'the pod stays interactable so the prompt (and the reason) is visible at all');
  ok(!pod0.inPod && pod0.notes.some((t) => /목표 행성이 없습니다/.test(t)), `boarding refused with a notice (${pod0.notes.join(' | ')})`);
  const noLaunch = await P(() => window.__game.ctx.player.isInPod);
  ok(noLaunch === false, 'no launch countdown can start while 목표 미지정');

  /* ── 2. the full-screen terminal ─────────────────────────────────────── */
  console.log('전체화면 터미널');
  await openTerminal();
  const term = await P(() => {
    const root = document.querySelector('.menu.hub-menu.fullscreen');
    const f = root.querySelector('.frame');
    const r = f.getBoundingClientRect();
    const rect = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
    // The header title · the status pill are measured by their **text** width (the blocks are stretched by flex)
    const textRect = (e) => { if (!e) return null; const rg = document.createRange(); rg.selectNodeContents(e); const b = rg.getBoundingClientRect(); return { l: b.left, r: b.right }; };
    const planet = rect(root.querySelector('.hub-planet'));
    // 2026-09-15 second pass (user's decision): the training button sits at the right end of its own row
    // (`.hub-train-row`) **above** the footer — the footer keeps nothing but `닫기 (E)`
    const train = root.querySelector('.hub-train-row .ui-btn.hub-train');
    return {
      footR: rect(root.querySelector('.hub-foot')),
      full: root.classList.contains('fullscreen'),
      w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight,
      sw: f.scrollWidth, cw: f.clientWidth, sh: f.scrollHeight, ch: f.clientHeight,
      // 2026-09-15 (squad · dock matching): the top tabs 행성 / 매칭 — the same `.scr-tabs > .scr-tab`
      // as the inventory Tab screen
      tabs: [...root.querySelectorAll('nav.scr-tabs.hub-tabs > button.scr-tab')].map((b) => `${b.textContent}${b.classList.contains('is-on') ? '*' : ''}${b.hidden ? '(hidden)' : ''}`),
      activeTab: window.__game.getSystem('hub').menu.activeTab,
      tabsR: rect(root.querySelector('.hub-tabs')),
      titleT: textRect(root.querySelector('.hub-head .title')),
      pillT: textRect(root.querySelector('.hub-head .status-pill')),
      matchPaneHidden: root.querySelector('.hub-pane-match')?.hidden ?? null,
      oldMatch: !!document.querySelector('.hub-matching, .hm-match, .crew-row'),
      cols: root.querySelectorAll('.hub-pane-planet .hub-grid > .hub-col').length,
      intelIn: root.querySelector('.hub-intel')?.closest('.hub-col')?.classList.contains('right') ?? null,
      planetIn: root.querySelector('.hub-planet')?.closest('.hub-col')?.classList.contains('centre') ?? null,
      planetCx: planet ? (planet.l + planet.r) / 2 : null, frameCx: (r.left + r.right) / 2,
      train: train ? { state: train.querySelector('.hub-train-state')?.textContent ?? null, disabled: train.disabled, hidden: train.hidden, r: rect(train) } : null,
      trainSection: [...root.querySelectorAll('.hub-section .ui-label')].some((n) => n.textContent === '시뮬레이션 훈련장'),
      trainHint: root.textContent.includes('개별 입장'),
      crewName: document.querySelectorAll('.hub-crew-name').length,
      nameInput: [...root.querySelectorAll('input')].filter((i) => i.placeholder === '호출명').length,
      seedHint: root.querySelector('.seed-hint')?.textContent ?? null,
      closeBtn: [...root.querySelectorAll('.hub-foot .ui-btn')].map((b) => b.querySelector('.hub-train-name')?.textContent ?? b.textContent),
      blocker: window.__game.ctx.uiBlockers.has('hub'),
      cursor: window.__game.ctx.input.isCursorMode,
      locked: !!document.pointerLockElement,
    };
  });
  ok(term.full, 'root carries .fullscreen');
  ok(term.w >= term.vw - 2 && term.h >= term.vh - 2, `the frame fills the viewport (${term.w}×${term.h} of ${term.vw}×${term.vh})`);
  ok(term.sw <= term.cw && term.sh <= term.ch, `the frame still has no scroll overflow (${term.sw}/${term.cw} × ${term.sh}/${term.ch})`);
  // 2026-09-15 (squad · dock matching, user's decision): the top tabs · the planet in the centre · the
  // training button bottom-right, and no header `📡 매칭` button or matchmaking popup
  ok(term.tabs.join(',') === '행성*,매칭', `top tabs 행성 / 매칭 with 행성 on (${term.tabs.join(',')})`);
  ok(term.activeTab === 'planet' && term.matchPaneHidden === true, `the terminal opens on the 행성 tab (${term.activeTab})`);
  ok(!!term.tabsR && !!term.titleT && !!term.pillT && term.tabsR.l > term.titleT.r && term.tabsR.r < term.pillT.l && Math.abs((term.tabsR.l + term.tabsR.r) / 2 - term.frameCx) <= 4,
    'the tabs sit at the top centre, between the title and the status pill', JSON.stringify({ tabs: term.tabsR, title: term.titleT, pill: term.pillT }));
  ok(term.oldMatch === false, 'no header 매칭 button, 매칭 popup or crew rows any more');
  ok(term.cols === 3, `planet pane = three grid cells (${term.cols})`);
  ok(term.intelIn === true, '정보상 패널 in the right column');
  ok(term.planetIn === true, '행성 카드 in the centre column');
  ok(term.planetCx !== null && Math.abs(term.planetCx - term.frameCx) <= 4, `the planet card is centred in the frame (${term.planetCx} vs ${term.frameCx})`);
  ok(!!term.train && term.train.state === '시작' && term.train.disabled === false && !term.train.hidden, `시뮬레이션 훈련장 button, solo → "${term.train?.state}"`);
  ok(!!term.train && !!term.footR && term.train.r.r >= term.vw - 60 && term.train.r.r <= term.vw && term.train.r.b <= term.footR.t && term.train.r.b >= term.footR.t - 40,
    `the training button sits right-aligned just above the footer line (${JSON.stringify(term.train?.r)} vs footer top ${term.footR?.t})`);
  ok(!term.trainSection && !term.trainHint, 'no 시뮬레이션 훈련장 section and no hint line');
  ok(term.crewName === 0 && term.nameInput === 0, `the 승무원 이름 section is gone (${term.crewName} label / ${term.nameInput} input)`);
  // 2026-09-08: `.seed-hint` is gone — the seed is still only touched from the dev console's `/seed`, but there
  // is no reason to print it on screen.
  ok(term.seedHint === null, `.seed-hint removed (${JSON.stringify(term.seedHint)})`);
  // 2026-09-09: 타이틀로 was taken out of the terminal — the pause menu already has it, and a destructive button
  // in a corner is a trap. 2026-09-15 second pass: the training button is outside the footer (the row above), so the
  // footer holds the single button `닫기 (E)`
  ok(term.closeBtn.join(',') === '닫기 (E)', `footer: ${term.closeBtn.join(' / ')}`);
  ok(term.blocker && term.cursor === true, `the 'hub' blocker + software cursor (Phase 10 etiquette, cursor ${term.cursor})`);
  ok(term.locked === true, 'the pointer lock is kept (no exitPointerLock)');
  const tog = await lastEv('hub:terminalToggled');
  ok(tog && tog.open === true, `hub:terminalToggled {open:true} (${JSON.stringify(tog)})`);
  ok((await ev('ui:hubMenuToggled')).slice(-1)[0]?.open === true, 'the legacy ui:hubMenuToggled still fires');

  /* ── 2b. The 매칭 tab · the 초대 modal (2026-09-15, docking) ──── */
  console.log('매칭 탭');
  await clickSel('.hub-tabs .scr-tab[data-tab="match"]');
  await waitSim(0.2);
  // **Pin the link state to offline** (on a runner with a relay up it is `connecting` at this moment, which shows
  // a disabled button + 「연결하는 중」) — inv1's finally below restores it with `delete net.status`
  await P(() => { Object.defineProperty(window.__game.getSystem('net'), 'status', { get: () => 'offline', configurable: true }); window.__game.getSystem('hub').menu.refresh(); });
  const mt = await P(() => {
    const st = (sel) => { const b = document.querySelector(sel); return b ? { hidden: b.hidden, disabled: b.disabled } : null; };
    const face = window.__game.ctx.player.snapshotFace?.({ accent: '#5fd7ff' }) ?? null;
    return {
      activeTab: window.__game.getSystem('hub').menu.activeTab,
      tabs: [...document.querySelectorAll('.hub-tabs .scr-tab')].map((b) => `${b.textContent}${b.classList.contains('is-on') ? '*' : ''}`),
      planetHidden: document.querySelector('.hub-pane-planet').hidden,
      trainHidden: document.querySelector('.hub-train').hidden,
      holoVis: document.querySelector('.hp-holo canvas')?.style.visibility ?? null,
      tiles: [...document.querySelectorAll('.hub-pane-match .hmt-row > .hmt-tile')].map((t) => {
        const inv = t.querySelector('.hmt-invite');
        return { cls: t.className, name: t.querySelector('.hmt-name')?.textContent ?? '', img: !!t.querySelector('.hmt-face img')?.getAttribute('src'), invite: inv && !inv.hidden ? (inv.disabled ? 'off' : 'on') : null };
      }),
      priv: st('.hmt-private'), pub: st('.hmt-public'), undock: st('.hmt-undock'), leave: st('.hmt-leave'), reconnect: st('.hmt-reconnect'),
      reconnectIn: document.querySelector('.hmt-reconnect')?.parentElement?.classList.contains('hmt-actions') ?? null,
      hint: document.querySelector('.hmt-hint')?.hidden === false ? document.querySelector('.hmt-hint').textContent : null,
      inviteOffline: [...document.querySelectorAll('.hmt-tile.is-empty .hmt-invite')].map((b) => b.classList.contains('is-offline')),
      face: face ? face.slice(0, 22) : null,
      faceCached: !!face && window.__game.ctx.player.snapshotFace({ accent: '#5fd7ff' }) === face,
    };
  });
  ok(mt.activeTab === 'match' && mt.tabs.join(',') === '행성,매칭*', `clicking 매칭 switches the tab (${mt.tabs.join(',')})`);
  ok(mt.planetHidden && mt.trainHidden, 'the planet pane and the training button are hidden on the 매칭 tab');
  ok(mt.holoVis === 'hidden', `the hologram stops drawing on the 매칭 tab (visibility ${mt.holoVis})`);
  ok(mt.tiles.length === 4, `4 square portrait tiles (${mt.tiles.length})`);
  ok(/\bis-me\b/.test(mt.tiles[0]?.cls ?? '') && mt.tiles[0].name.length > 0 && mt.tiles[0].img, `me first, with a face image (${JSON.stringify(mt.tiles[0])})`);
  ok(mt.tiles.slice(1).every((t) => /\bis-empty\b/.test(t.cls) && t.invite === 'on'), `solo: the other three are empty cells with an enabled 초대 (${mt.tiles.slice(1).map((t) => t.invite).join(',')})`);
  ok(mt.face === 'data:image/png;base64,' && mt.faceCached, `ctx.player.snapshotFace returns a PNG and caches it (${mt.face})`);
  // 2026-09-15 second pass (user's decision): with no link 비공개 / 공개 매칭 **disappear and `다시 연결` stands in
  // their place** (`.hmt-actions`); the reason line stays
  ok(!!mt.priv && !!mt.pub && mt.priv.hidden && mt.pub.hidden && mt.undock?.hidden === true && mt.leave?.hidden === true, 'offline → 비공개 / 공개 매칭 hidden, no 도킹 해제 / 분대 떠나기 without a lobby', JSON.stringify(mt));
  ok(mt.reconnect?.hidden === false && mt.reconnect.disabled === false && mt.reconnectIn === true && mt.hint === '서버에 연결되어 있지 않습니다', `offline → 다시 연결 in the action row with "${mt.hint}"`, JSON.stringify(mt));
  ok(mt.inviteOffline.length === 3 && mt.inviteOffline.every(Boolean), `offline: the empty cells' 초대 are dimmed (.is-offline) but enabled (${mt.inviteOffline.join(',')})`);

  // Clicking 초대 with no link: no modal opens and the reason line flashes (`.is-flash`)
  const invOff = await P(() => {
    document.querySelector('.hmt-tile.is-empty .hmt-invite')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const hint = document.querySelector('.hmt-hint');
    return { open: !document.querySelector('.menu.hub-menu.hinv-modal').hidden, flash: hint.classList.contains('is-flash'), hint: hint.hidden ? null : hint.textContent, top: window.__game.ctx.escape.topKey };
  });
  ok(!invOff.open && invOff.top === 'hub:terminal' && invOff.flash && /서버에 연결/.test(invOff.hint ?? ''), `offline 초대 opens nothing and flashes the hint (${JSON.stringify(invOff)})`);
  await waitSim(0.8);
  ok(await P(() => !document.querySelector('.hmt-hint').classList.contains('is-flash')), 'the flash class is gone after HINT_FLASH_MS');

  // The modal's own offline line is read by opening the modal directly (with no link the `초대` button opens nothing)
  await P(() => window.__game.getSystem('hub').menu.invite.open());
  await waitSim(0.1);
  const inv0 = await P(() => ({
    open: !document.querySelector('.menu.hub-menu.hinv-modal').hidden,
    top: window.__game.ctx.escape.topKey, blocker: window.__game.ctx.uiBlockers.has('hub:invite'),
    note: document.querySelector('.hinv-note')?.hidden === false ? document.querySelector('.hinv-note').textContent : null,
    guide: window.__game.getSystem('hud').keyGuideOwner ?? null,
  }));
  ok(inv0.open && inv0.top === 'hub:invite' && inv0.blocker, `the invite modal opens on its own token (${inv0.top})`);
  ok(inv0.guide === 'hub.invite', `the invite modal owns the key guide (${inv0.guide})`);
  ok(/서버에 연결/.test(inv0.note ?? ''), `offline → the modal says so ("${inv0.note}")`);
  // The link · social snapshot is overridden for a moment as an instance property so the rows are drawn (the
  // getters live on the prototype, so a delete restores them)
  const inv1 = await P(() => {
    const net = window.__game.getSystem('net');
    const now = net.serverNow();
    window.__played = null;
    Object.defineProperty(net, 'status', { get: () => 'connected', configurable: true });
    Object.defineProperty(net, 'social', {
      configurable: true, writable: true,
      value: {
        available: true,
        friends: [
          { code: 'AB3D9KMN', name: '친구하나', level: 12, presence: 'ship', squad: 0, joinable: true },
          { code: 'QW7E2RTY', name: '친구둘', level: 4, presence: 'raid', squad: 1, joinable: false },
        ],
        recent: [{ code: 'ZX4C8VBN', name: '최근', level: 0, presence: 'ship', squad: 0, joinable: true, inviteAt: now - 10000 }],
        playBlock: (c) => (c === 'QW7E2RTY' ? 'in_mission' : null),
        playWith: (c) => { window.__played = c; },
        refresh() {},
      },
    });
    try {
      window.__game.getSystem('hub').menu.refresh();
      const rows = [...document.querySelectorAll('.hinv-row')].map((r) => ({
        code: r.dataset.code, id: r.querySelector('.hinv-code')?.textContent, lv: r.querySelector('.hinv-lv')?.textContent,
        pres: r.querySelector('.hinv-presence')?.textContent, btn: r.querySelector('.hinv-btn')?.textContent, off: r.querySelector('.hinv-btn')?.disabled,
        section: r.closest('.hinv-section')?.querySelector('.ui-label')?.textContent,
      }));
      document.querySelector('.hinv-row[data-code="AB3D9KMN"] .hinv-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.querySelector('.hinv-row[data-code="QW7E2RTY"] .hinv-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { rows, played: window.__played };
    } finally {
      delete net.status; delete net.social;
      window.__game.getSystem('hub').menu.refresh();
    }
  });
  const rowOf = (c) => inv1.rows.find((r) => r.code === c);
  ok(inv1.rows.map((r) => r.code).join(',') === 'AB3D9KMN,QW7E2RTY,ZX4C8VBN' && rowOf('AB3D9KMN')?.section === '친구' && rowOf('ZX4C8VBN')?.section === '최근 만난 플레이어',
    'friends first, then recent players', JSON.stringify(inv1.rows));
  ok(rowOf('AB3D9KMN')?.id === 'AB3D-9KMN' && rowOf('AB3D9KMN')?.lv === 'Lv.12' && rowOf('AB3D9KMN')?.pres === '함선' && rowOf('AB3D9KMN')?.btn === '초대' && rowOf('AB3D9KMN')?.off === false,
    'a row shows name, 아이디, level, presence and an enabled 초대', JSON.stringify(rowOf('AB3D9KMN')));
  ok(rowOf('QW7E2RTY')?.btn === '임무 중' && rowOf('QW7E2RTY')?.off === true, `a blocked row shows PLAY_BLOCK_LABELS ("${rowOf('QW7E2RTY')?.btn}")`);
  ok(/^초대 중 · \d+초$/.test(rowOf('ZX4C8VBN')?.btn ?? '') && rowOf('ZX4C8VBN')?.off === true && rowOf('ZX4C8VBN')?.lv === 'Lv.—', `an open invite shows its countdown ("${rowOf('ZX4C8VBN')?.btn}")`);
  ok(inv1.played === 'AB3D9KMN', `초대 calls social.playWith with the row's code, a disabled row does nothing (${inv1.played})`);
  await tap('Tab');
  await waitSim(0.15);
  const inv2 = await P(() => ({
    open: !document.querySelector('.menu.hub-menu.hinv-modal').hidden,
    term: !document.querySelector('.menu.hub-menu.fullscreen').hidden,
    top: window.__game.ctx.escape.topKey, blocker: window.__game.ctx.uiBlockers.has('hub:invite'), hubBlocker: window.__game.ctx.uiBlockers.has('hub'),
    tab: window.__game.getSystem('hub').menu.activeTab,
  }));
  ok(!inv2.open && !inv2.blocker && inv2.term && inv2.hubBlocker && inv2.top === 'hub:terminal' && inv2.tab === 'match', 'Tab closes only the invite modal (terminal, its blocker and the 매칭 tab stay)', JSON.stringify(inv2));
  await clickSel('.hub-tabs .scr-tab[data-tab="planet"]');
  await waitSim(0.2);
  const back = await P(() => ({ tab: window.__game.getSystem('hub').menu.activeTab, planet: !document.querySelector('.hub-pane-planet').hidden, holoVis: document.querySelector('.hp-holo canvas')?.style.visibility ?? null }));
  ok(back.tab === 'planet' && back.planet && back.holoVis === '', `back on the 행성 tab, the hologram draws again (${JSON.stringify(back)})`);

  /* ── 2c. No frame overflow at three sizes (2026-09-15) ──── */
  for (const [vw, vh] of [[1280, 760], [1440, 900], [1920, 1080]]) {
    await page.setViewport({ width: vw, height: vh });
    await waitSim(0.2);
    const lay = await P(() => {
      const menu = window.__game.getSystem('hub').menu;
      const rect = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const f = document.querySelector('.menu.hub-menu.fullscreen .frame');
      const over = () => ({ sw: f.scrollWidth, cw: f.clientWidth, sh: f.scrollHeight, ch: f.clientHeight });
      menu.setTab('planet');
      const planet = { over: over(), travel: rect(document.querySelector('.hp-travel')), centre: rect(document.querySelector('.hub-col.centre')), train: rect(document.querySelector('.hub-train')), card: rect(document.querySelector('.hub-planet')), frame: rect(f) };
      menu.setTab('match');
      const match = { over: over(), row: rect(document.querySelector('.hmt-row')), actions: rect(document.querySelector('.hmt-actions')), pane: rect(document.querySelector('.hub-pane-match')) };
      menu.setTab('planet');
      return { planet, match };
    });
    const p = lay.planet, m = lay.match;
    const noOver = (o) => o.sw <= o.cw && o.sh <= o.ch;
    ok(noOver(p.over) && noOver(m.over), `${vw}×${vh}: no frame overflow on either tab`, JSON.stringify({ p: p.over, m: m.over }));
    ok(!!p.travel && !!p.centre && p.travel.b <= p.centre.b + 1 && p.travel.t >= p.centre.t - 1, `${vw}×${vh}: the planet card is not clipped (행성 이동 visible)`, JSON.stringify({ travel: p.travel, centre: p.centre }));
    ok(!!p.card && Math.abs((p.card.l + p.card.r) / 2 - (p.frame.l + p.frame.r) / 2) <= 4, `${vw}×${vh}: the planet card stays centred`);
    ok(!!p.train && p.train.r <= vw && p.train.b <= vh && p.train.r >= vw - 60, `${vw}×${vh}: the training button stays in the bottom-right corner`, JSON.stringify(p.train));
    ok(!!m.row && !!m.actions && !!m.pane && m.row.l >= m.pane.l && m.row.r <= m.pane.r && m.actions.b <= m.pane.b, `${vw}×${vh}: the tiles and matching buttons fit the 매칭 pane`, JSON.stringify(m));
  }
  await page.setViewport({ width: 1600, height: 900 });
  await waitSim(0.2);

  /* ── 3. the hologram + ◀ ▶ / arrows / A-D ────────────────────────────── */
  console.log('행성 홀로그램');
  const holo = await P(() => {
    const host = document.querySelector('.hp-holo');
    const c = host?.querySelector('canvas');
    const r = c?.getBoundingClientRect();
    return {
      canvas: !!c, cls: c?.className ?? null,
      w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
      gl: !!c && !!c.getContext && true,
      noHolo: document.querySelector('.menu.hub-menu').classList.contains('no-holo'),
      arrows: document.querySelectorAll('.ui-btn.hp-arrow').length,
    };
  });
  ok(holo.canvas && holo.cls === 'planet-canvas', 'the hologram built its own WebGL canvas');
  ok(!holo.noHolo, 'no .no-holo fallback (a second GL context was available)');
  ok(holo.w > 100 && Math.abs(holo.w - holo.h) <= 2, `the canvas is square (${holo.w}×${holo.h})`);
  ok(holo.arrows === 2, `◀ ▶ buttons present (${holo.arrows})`);
  const c0 = await planetCard();
  ok(c0.name === PLANETS[0].name, `목표 미지정 previews the first planet (${c0.name})`);
  ok(c0.terrain === PLANETS[0].terrain, `지형 line "${c0.terrain}"`);
  ok(c0.threat === THREAT_LABELS[PLANETS[0].threat] && c0.threatLv === '1', `위협 badge "${c0.threat}" (lv ${c0.threatLv})`);
  ok((c0.brief ?? '').length > 10, `one-line brief ("${(c0.brief ?? '').slice(0, 18)}…")`);
  ok(c0.dots.length === 5 && c0.dots[0].includes('*') && !c0.dots.some((d) => d.includes('!')), `5 dots, cursor on the first, none marked current (${c0.dots.join(' ')})`);
  ok(c0.travelOff === false && (c0.travel ?? '').includes(PLANETS[0].name), `행성 이동 enabled ("${c0.travel}")`);
  ok(c0.current === true, 'the 현재 목표 tag is hidden while nothing is picked');

  await clickSel('.ui-btn.hp-arrow.next');
  await waitSim(0.1);
  const c1 = await planetCard();
  ok(c1.name === PLANETS[1].name && c1.dots[1].includes('*'), `▶ steps to ${c1.name}`);
  ok(c1.threatLv === String(PLANETS[1].threat), `위협 badge follows (lv ${c1.threatLv})`);
  await tap('ArrowRight');
  await waitSim(0.1);
  ok((await planetCard()).name === PLANETS[2].name, '→ key steps right');
  await tap('KeyA');
  await waitSim(0.1);
  ok((await planetCard()).name === PLANETS[1].name, 'A key steps left');
  await tap('ArrowLeft');
  await waitSim(0.1);
  ok((await planetCard()).name === PLANETS[0].name, '← key steps left');
  await clickSel('.ui-btn.hp-arrow.prev');
  await waitSim(0.1);
  const cw = await planetCard();
  ok(cw.name === PLANETS[4].name, `◀ wraps around to ${cw.name}`);
  ok(cw.hubPlanet === null, 'stepping only previews — ctx.hub.planet is still null');
  ok((await ev('hub:travel')).length === 0, 'no hub:travel while only previewing');
  // back to 베르단트 III for the trip
  await tap('ArrowRight'); await tap('ArrowRight'); await tap('ArrowRight');
  await waitSim(0.1);
  ok((await planetCard()).name === PLANETS[2].name, `previewing ${PLANETS[2].name} for the trip`);

  /* ── 4. 행성 이동: the warp cutscene ─────────────────────────────────── */
  console.log('행성 이동');
  const glow = () => P(() => {
    const g = window.__game.ctx.scene.getObjectByName('PersonalShip');
    let hex = null;
    g?.traverse((o) => { if (o.name === 'HubPlanetBody' && hex === null) hex = o.material.color.getHex(); });
    return hex;
  });
  const beforeHex = await glow();
  ok(typeof beforeHex === 'number', `the window planet is readable (0x${(beforeHex ?? 0).toString(16)})`);
  await clickSel('.ui-btn.hp-travel');
  await waitFor(page, () => window.__game.ctx.hub.travelling === true, 'travelling');
  await waitSim(0.2);   // the status line is written by the next `HubSystem.update` frame, not by `startTravel`
  const t1 = await P(() => {
    const ctx = window.__game.ctx;
    // 2026-09-09: no cutscene any more — the 창문 워프 streaks live under the interior root and the player keeps control
    const cut = ctx.scene.getObjectByName('DockingCutscene');
    const ship = ctx.scene.getObjectByName('PersonalShip');
    let streaks = false;
    ship?.traverse((o) => { if (o.name === 'HubWarpStreaks') streaks = true; });
    return {
      start: window.__ev['hub:travel'].slice(-1)[0] ?? null,
      menuHidden: document.querySelector('.menu.hub-menu').hidden,
      blocker: ctx.uiBlockers.has('hub'), cursor: ctx.input.isCursorMode,
      phase: ctx.phase, cut: !!cut, streaks, controls: ctx.player.controlsEnabled !== false,
      interior: !!ctx.hub.collider && !!ctx.player.interior,
      status: document.querySelector('.hub-status')?.textContent ?? '',
      podCan: ctx.interactables.all().find((i) => i.id === 'hub_pod_0')?.canInteract() ?? null,
    };
  });
  ok(t1.start && t1.start.stage === 'start' && t1.start.planet === PLANETS[2].id, `hub:travel {stage:'start', planet:'${t1.start?.planet}'}`);
  ok(t1.menuHidden && !t1.blocker && t1.cursor === false, 'the terminal closed itself and released the blocker / cursor');
  ok(t1.phase === 'hub', `the phase stays 'hub' during a planet change (${t1.phase})`);
  ok(!t1.cut && t1.streaks, 'no cutscene object — the WarpStreaks layer lives under the ship interior (창문 워프)');
  ok(t1.controls, 'controls stay enabled while warping (the player walks the ship)');
  ok(t1.interior, 'the ship interior was NOT rebuilt (collider + player interior kept)');
  ok(/항로 이동 중/.test(t1.status), `status line "${t1.status.trim().slice(0, 30)}"`);
  ok(t1.podCan === false, 'launch slots are unavailable while travelling');
  const refused = await P(() => ({
    same: window.__game.ctx.hub.setPlanet('mossy'),
    other: window.__game.ctx.hub.setPlanet('ashen'),
  }));
  ok(refused.other === false, 'setPlanet is refused while travelling');
  await waitSim(5.2);
  await waitFor(page, () => window.__game.ctx.hub.travelling === false, 'travel finished');
  await waitSim(0.3);
  const t2 = await P(() => {
    const ctx = window.__game.ctx;
    return {
      travel: window.__ev['hub:travel'].slice(-1)[0] ?? null,
      changed: window.__ev['hub:planetChanged'].slice(-1)[0] ?? null,
      planet: ctx.hub.planet, travelling: ctx.hub.travelling,
      cut: !!ctx.scene.getObjectByName('DockingCutscene'),
      controls: ctx.player.controlsEnabled !== false,
      stored: (() => { try { return localStorage.getItem('scav.s1.planet'); } catch { return null; } })(),
      podPrompt: ctx.interactables.all().find((i) => i.id === 'hub_pod_0')?.getPrompt() ?? null,
      podCan: ctx.interactables.all().find((i) => i.id === 'hub_pod_0')?.canInteract() ?? null,
    };
  });
  ok(t2.travel && t2.travel.stage === 'end' && t2.travel.planet === PLANETS[2].id, `hub:travel {stage:'end'} (${JSON.stringify(t2.travel)})`);
  ok(t2.changed && t2.changed.planet === PLANETS[2].id && t2.changed.by === 'local', `hub:planetChanged {by:'local'} (${JSON.stringify(t2.changed)})`);
  ok(t2.planet === PLANETS[2].id && t2.travelling === false, `ctx.hub.planet = ${t2.planet}, travelling false`);
  ok(!t2.cut, 'the cutscene disposed itself');
  ok(t2.controls, 'controls handed back');
  ok(t2.stored === PLANETS[2].id, `the pick is persisted in scav.s1.planet (${t2.stored})`);
  ok((await glow()) === PLANETS[2].hologram, `the window planet took the destination colour (0x${(await glow()).toString(16)})`);
  ok((await screenText()).includes(`목표 ${PLANETS[2].name}`), `terminal screen reads 목표 ${PLANETS[2].name}`);
  ok(t2.podPrompt === '발사 슬롯 탑승' && t2.podCan === true, `the launch slot opened up ("${t2.podPrompt}")`);

  /* ── 4b. Launch-readiness warning (2026-09-08 · moved 2026-09-14) 
   * The default issue holds no primary weapon, so the warning is raised. **2026-09-14 (user's decision)**: the place
   * that warning appears is not boarding but **the moment the ready hold finishes** — sitting in a pod commits to
   * nothing, so it asks nothing; the popup only stands after Space is held for `UI_HOLD_CONFIRM_S` (1 s), and
   * readiness only turns on when `그래도 준비` is pressed. It never blocks, and it does not ask twice for the same
   * combination.
   * Once readiness is on, `HUB_LAUNCH_COUNTDOWN` (3 s) starts running at once even solo, so the pod is left **inside
   * the same evaluate** that finishes the confirmation (no frame runs in between). */
  console.log('출격 준비 경고');
  const warnIds = await P(() => window.__game.ctx.inventory.getLaunchWarnings().map((w) => w.id));
  ok(warnIds.includes('noPrimary'), `기본 지급품에는 주무기가 없어 경고가 잡힌다 (${warnIds.join(',')})`);
  /** The pod state in one row (the warning popup · boarded · ready · the blocker). */
  const podState = () => P(() => {
    const ctx = window.__game.ctx, hub = window.__game.getSystem('hub');
    const root = document.querySelector('.menu.hub-menu.launch-warn');
    return {
      warnHidden: root?.hidden ?? null, boarded: hub.boardedSlot, ready: hub.readyLocal,
      ack: hub.launchWarnAck, blocker: ctx.uiBlockers.has('hub'), cursor: ctx.input.isCursorMode,
      hold: hub.ready.holdProgress,
    };
  });
  /** Space held for 1 s = ready (`hub/ui/ReadyPanel.tickHold` sums dt — simulation time, not the wall clock). */
  const holdReady = async () => {
    await P(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })));
    await waitSim(1.4);   // UI_HOLD_CONFIRM_S 1 s + a frame of slack
    await P(() => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true })));
    await waitSim(0.1);
  };
  await P(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_pod_0').interact());
  await waitSim(0.2);
  const sat = await podState();
  ok(sat.warnHidden === true && sat.boarded === 0 && sat.ready === false && sat.blocker === false,
    '탑승 자체는 경고 없이 앉기만 한다 (준비 대기)', JSON.stringify(sat));
  const statusMain = await P(() => document.querySelector('.hub-status .main')?.textContent ?? '');
  ok(statusMain.includes('준비 대기'), `상태 줄이 준비 대기라고 말한다 ("${statusMain}")`);
  ok(sat.hold === 0, '스페이스를 누르기 전 준비 홀드 게이지는 0 이다');
  await holdReady();
  const popped = await P(() => {
    const ctx = window.__game.ctx, hub = window.__game.getSystem('hub');
    const root = document.querySelector('.menu.hub-menu.launch-warn');
    return {
      hidden: root?.hidden, rows: [...root.querySelectorAll('.lw-row')].map((r) => r.dataset.id),
      texts: [...root.querySelectorAll('.lw-row .nm')].map((e) => e.textContent),
      details: [...root.querySelectorAll('.lw-row .sub')].length,
      boarded: hub.boardedSlot, ready: hub.readyLocal, blocker: ctx.uiBlockers.has('hub'), cursor: ctx.input.isCursorMode,
    };
  });
  ok(popped.hidden === false && popped.boarded === 0 && popped.ready === false,
    '준비 홀드가 끝나면 경고 카드가 뜨고 아직 준비되지 않는다', JSON.stringify({ hidden: popped.hidden, boarded: popped.boarded, ready: popped.ready }));
  ok(popped.rows.join(',') === warnIds.join(',') && popped.details === popped.rows.length,
    `사유가 하나씩 전부 표시된다 (${popped.rows.join(',')})`, JSON.stringify(popped.texts));
  ok(popped.blocker && popped.cursor, '경고 카드가 hub 블로커 + 소프트 커서를 잡는다', JSON.stringify({ blocker: popped.blocker, cursor: popped.cursor }));
  const cancelled = await P(() => {
    const hub = window.__game.getSystem('hub');
    [...document.querySelectorAll('.launch-warn .hub-foot .ui-btn')].find((b) => b.textContent === '취소').click();
    return { hidden: document.querySelector('.launch-warn').hidden, boarded: hub.boardedSlot, ready: hub.readyLocal, ack: hub.launchWarnAck, blocker: window.__game.ctx.uiBlockers.has('hub') };
  });
  ok(cancelled.hidden && cancelled.boarded === 0 && cancelled.ready === false && cancelled.ack === '' && !cancelled.blocker,
    '취소하면 닫히고 준비되지 않으며 아무것도 기억하지 않는다 (포드에는 그대로 앉아 있다)', JSON.stringify(cancelled));
  await holdReady();
  const confirmed = await P(() => {
    const ctx = window.__game.ctx, hub = window.__game.getSystem('hub');
    const reopened = document.querySelector('.launch-warn').hidden === false;
    [...document.querySelectorAll('.launch-warn .hub-foot .ui-btn')].find((b) => b.textContent === '그래도 준비').click();
    const out = { reopened, hidden: document.querySelector('.launch-warn').hidden, ready: hub.readyLocal, ack: hub.launchWarnAck, blocker: ctx.uiBlockers.has('hub') };
    hub.leavePod(true);   // ready = the launch countdown starts — leave the pod before a frame runs
    out.after = hub.boardedSlot;
    return out;
  });
  ok(confirmed.reopened, '취소한 뒤 다시 꾹 누르면 경고가 또 뜬다');
  ok(confirmed.hidden && confirmed.ready === true && !confirmed.blocker && confirmed.after < 0,
    '그래도 준비 → 카드가 닫히고 준비가 켜진다', JSON.stringify(confirmed));
  ok(confirmed.ack === warnIds.join(','), `같은 조합을 기억한다 (${confirmed.ack})`);
  // It has just been left, so REBOARD_GRACE (0.5 s of simulation time) has to pass before boarding again — trying
  // to board again on the very frame it was left is refused silently by `podCanInteract` (it cannot be told apart
  // from leaving with E still held).
  await waitSim(0.6);
  await P(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_pod_0').interact());
  await waitSim(0.2);
  await holdReady();
  const second = await P(() => {
    const hub = window.__game.getSystem('hub');
    const out = { hidden: document.querySelector('.launch-warn').hidden, boarded: hub.boardedSlot, ready: hub.readyLocal };
    hub.leavePod(true);
    out.after = hub.boardedSlot;
    return out;
  });
  ok(second.hidden && second.boarded === 0 && second.ready === true && second.after < 0,
    '한 번 넘긴 조합은 다시 묻지 않고 홀드만으로 준비된다', JSON.stringify(second));
  /* With **no warning at all**: the hold alone readies at once and the acknowledgement record is wiped (the next
   * gap is asked about afresh). Rather than actually filling the loadout, `getLaunchWarnings` is emptied for the
   * duration of this check — what is being looked at is hub's branch. */
  await waitSim(0.6);
  await P(() => {
    const inv = window.__game.ctx.inventory;
    window.__warnOrig = inv.getLaunchWarnings.bind(inv);
    inv.getLaunchWarnings = () => [];
  });
  await P(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_pod_0').interact());
  await waitSim(0.2);
  await holdReady();
  const clean = await P(() => {
    const hub = window.__game.getSystem('hub'), inv = window.__game.ctx.inventory;
    const out = { hidden: document.querySelector('.launch-warn').hidden, ready: hub.readyLocal, ack: hub.launchWarnAck };
    hub.leavePod(true);
    inv.getLaunchWarnings = window.__warnOrig;
    return out;
  });
  ok(clean.hidden === true && clean.ready === true && clean.ack === '',
    '경고가 없으면 홀드만으로 곧바로 준비되고 승인 기록이 지워진다', JSON.stringify(clean));

  /* ── 5. refusals + the terminal on a chosen planet ───────────────────── */
  console.log('거부 규칙');
  const ref2 = await P(() => ({
    same: window.__game.ctx.hub.setPlanet('mossy'),
    unknown: window.__game.ctx.hub.setPlanet('nowhere'),
    planet: window.__game.ctx.hub.planet,
  }));
  ok(ref2.same === false, 'setPlanet on the current planet is refused (the button reads 현재 목표)');
  ok(ref2.unknown === false && ref2.planet === PLANETS[2].id, 'an unknown planet id is refused and changes nothing');
  await openTerminal();
  const c2 = await planetCard();
  ok(c2.name === PLANETS[2].name && c2.travel === '현재 목표' && c2.travelOff === true, `reopening previews the ship's planet, button "${c2.travel}" disabled`);
  ok(c2.current === false && c2.dots[2].includes('!'), `the 현재 목표 tag and the dot marker point at ${PLANETS[2].name}`);
  await tap('KeyE');   // 2026-09-08: the terminal closes on E (Escape is the 일시정지 메뉴)
  await waitFor(page, () => document.querySelector('.menu.hub-menu').hidden, 'terminal closed');
  await waitSim(0.2);
  const closed = await P(() => ({
    tog: window.__ev['hub:terminalToggled'].slice(-1)[0] ?? null,
    cursor: window.__game.ctx.input.isCursorMode, blocker: window.__game.ctx.uiBlockers.has('hub'),
  }));
  ok(closed.tog && closed.tog.open === false, 'hub:terminalToggled {open:false} on E');
  ok(closed.cursor === false && !closed.blocker, 'closing releases the software cursor and the blocker');

  /* ── 6. persistence across a reload ──────────────────────────────────── */
  console.log('저장 / 복원');
  await boot('reload');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase (reload)');
  await waitSim(0.3);
  const re = await P(() => ({
    planet: window.__game.ctx.hub.planet,
    hex: (() => {
      const g = window.__game.ctx.scene.getObjectByName('PersonalShip');
      let hex = null;
      g?.traverse((o) => { if (o.name === 'HubPlanetBody' && hex === null) hex = o.material.color.getHex(); });
      return hex;
    })(),
    travelEvents: window.__ev['hub:travel'].length,
  }));
  ok(re.planet === PLANETS[2].id, `the planet survives a reload (${re.planet})`);
  ok(re.hex === PLANETS[2].hologram, 'the ship is built with the stored planet colour, no cutscene');
  ok(re.travelEvents === 0, 'restoring a saved planet plays no travel cutscene');

  /* ── 7. launch: game:newMission carries the planet ───────────────────── */
  console.log('발사');
  // 2026-09-08: the reload started a new session, so the launch-readiness warning appears again — since
  // 2026-09-14 it comes after the **ready hold** rather than after boarding, so it takes sit down → hold → confirm
  // before the countdown runs.
  await P(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_pod_0').interact());
  await waitSim(0.2);
  ok(await P(() => window.__game.ctx.player.isInPod), 'boarded the launch slot');
  await holdReady();
  const boardedNow = await P(() => {
    const hub = window.__game.getSystem('hub');
    const warn = document.querySelector('.launch-warn');
    const warned = !!warn && !warn.hidden;
    if (warned) [...warn.querySelectorAll('.hub-foot .ui-btn')].find((b) => b.textContent === '그래도 준비').click();
    return { warned, boarded: hub.boardedSlot, ready: hub.readyLocal };
  });
  ok(boardedNow.warned && boardedNow.boarded === 0 && boardedNow.ready === true,
    '리로드 뒤에는 경고가 다시 뜨고, 확인하면 준비된다', JSON.stringify(boardedNow));
  await waitFor(page, () => window.__ev['game:newMission'].length > 0, 'launch', 60000);
  const nm = await lastEv('game:newMission');
  ok(nm && nm.planet === PLANETS[2].id, `game:newMission {planet:'${nm?.planet}'}`);
  ok(nm && nm.mode === 'raid' && typeof nm.seed === 'number', `…with mode 'raid' and a seed (${nm?.seed})`);
  ok(await P(() => window.__game.ctx.missionPlanet) === PLANETS[2].id, 'ctx.missionPlanet was set BEFORE the emit (the world can read it)');
  const cd = await ev('hub:launchCountdown');
  ok(cd.length > 0, `the countdown ran (${cd.length} ticks)`);
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.message}`);
} finally {
  await closeBrowser(browser);
}

const real = errors.filter((e) => !/WebSocket|websocket|favicon|404|net::ERR/.test(e));
if (real.length) { console.log(`\n  ${real.length} console error(s):`); for (const e of real.slice(0, 6)) console.log(`    ${e}`); }
console.log(`\n${pass} passed, ${fail} failed, ${real.length} console errors`);
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
