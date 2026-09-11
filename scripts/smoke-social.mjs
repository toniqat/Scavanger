// Phase 11 소셜 UI smoke (src/ui): the ESC screen (2026-09-08: it parks itself so the viewport centre — where
// Escape leaves the OS cursor — lands inside 게임으로 돌아가기, right of that button's middle), the
// profile cards + right-click menu (같이 하기 gating, 귓속말하기, 친구 추가 / 친구 삭제 with its confirm card), the
// 설정 side panel with a real ControlsPanel inside 키 설정, the ship-only 커뮤니티 thumbnail (online count inside its
// bottom-right, red dot for a pending request) and its panel, the 분대 초대 stack with the P-hold gauge, the chat
// log's whisper mode, and the planet line / planet-carrying 다시 배치 on the result screens.
//
// No relay is involved: `HudSystem.debugSocial(snapshot, invites, mySquad)` installs a synthetic `SocialRef` for every
// ui component that reads the mirror (same pattern as `debugRemotes`), and `HudSystem.debugSocialLog` records the
// mutations the UI asked for. `debugSocial(null)` hands the UI back to the real (offline) `ctx.net.social`, which is
// how the 소셜 기능을 사용할 수 없습니다 fallback and the failed whisper are checked.
//
// Usage: node scripts/smoke-social.mjs [http://localhost:5273/]   (needs a vite; the relay is optional — without it
// the hub's `ensureConnected` logs one `ws://…/ws` error, which the final console check tolerates).
import puppeteer from 'puppeteer-core';
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
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

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
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr')) return new QuietSocket(args[0]);
        return new target(...args);
      },
    });
  });
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
    for (const n of ['ui:communityToggled', 'chat:whisperTo', 'game:newMission', 'ui:settingsToggled',
      'social:inviteClosed', 'social:inviteResult', 'social:whisperUpdated', 'social:error', 'social:invited']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p ?? {}))); });
    }
    /* One synthetic snapshot reused by most of the run (codes use the real PLAYER_CODE_ALPHABET — no I/O/0/1). */
    window.__snap = () => ({
      me: { code: 'AB3D9KMN', name: '나', level: 12 },
      friends: [
        { code: 'CDEF2345', name: '친구하나', level: 8, presence: 'ship', squad: 0, joinable: true },
        { code: 'GHJK6789', name: '친구둘', level: 20, presence: 'raid', squad: 3, joinable: false },
        { code: 'LMNP2345', name: '친구셋', level: 1, presence: 'offline', squad: 0, joinable: false },
        { code: 'QRST6789', name: '친구넷', level: 5, presence: 'ship', squad: 4, joinable: false },
      ],
      incoming: [{ code: 'UVWX2345', name: '요청자', level: 3, presence: 'ship', squad: 0, joinable: true }],
      outgoing: [],
      recent: [
        { code: 'YZ234567', name: '최근하나', level: 4, presence: 'ship', squad: 0, joinable: true, at: 1 },
        { code: 'ABCD2345', name: '최근둘', level: 9, presence: 'offline', squad: 0, joinable: false, at: 2 },
        { code: 'EFGH3456', name: '최근셋', level: 2, presence: 'training', squad: 1, joinable: false, at: 3 },
        { code: 'JKLM4567', name: '최근넷', level: 6, presence: 'ship', squad: 2, joinable: true, at: 4 },
        { code: 'NPQR5678', name: '최근다섯', level: 7, presence: 'ship', squad: 0, joinable: true, at: 5 },
      ],
    });
    window.__setSocial = (snap, invites = [], mySquad = 1) => window.__game.getSystem('hud').debugSocial(snap, invites, mySquad);
    window.__log = () => window.__game.getSystem('hud').debugSocialLog.map((c) => `${c.m}:${c.args.join(',')}`);
    window.__ctxMenu = (sel, i = 0) => {
      const cards = [...document.querySelectorAll(sel)];
      const c = cards[i];
      if (!c) return false;
      c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 400 }));
      return true;
    };
    /* Two SocialColumns live in the DOM (the ESC one and the community one), so each query targets the visible one. */
    window.__menuEl = () => [...document.querySelectorAll('.sc-menu')].find((m) => !m.hidden) ?? null;
    window.__confirmEl = () => [...document.querySelectorAll('.sc-confirm')].find((m) => !m.hidden) ?? null;
    window.__menu = () => ({
      open: !!window.__menuEl(),
      items: [...document.querySelectorAll('.sc-menu:not([hidden]) .sc-mi')].map((b) => ({
        act: b.dataset.act, off: b.disabled, label: b.querySelector('.l').textContent, why: b.querySelector('.w')?.textContent ?? '',
      })),
    });
    window.__key = (code, type) => document.body.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }));
    window.__tap = (code) => { window.__key(code, 'keydown'); window.__key(code, 'keyup'); };
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const emit = (name, payload) => P(([n, p]) => window.__game.ctx.bus.emit(n, p), [name, payload]);
  const hud = (expr) => P((e) => window.__game.getSystem('hud')[e], expr);
  const click = (sel, i = 0) => P(([s, k]) => {
    const e = [...document.querySelectorAll(s)][k];
    if (!e) return false;
    e.click();
    return true;
  }, [sel, i]);
  const text = (sel) => P((s) => document.querySelector(s)?.textContent ?? null, sel);
  const count = (sel) => P((s) => document.querySelectorAll(s).length, sel);

  console.log('ship');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub', 30000);
  await waitSim(0.3);

  console.log('ESC layout (ship)');
  await emit('game:paused', { paused: true, freeze: false });
  await waitSim(0.1);
  let layout = await P(() => {
    const menu = document.querySelector('.menu.pause');
    const frame = menu.querySelector('.frame');
    const fr = frame.getBoundingClientRect();
    const rb = [...frame.querySelectorAll('.actions .ui-btn')][0].getBoundingClientRect();
    return {
      shown: !menu.classList.contains('hidden'),
      justify: getComputedStyle(menu).justifyContent,
      frameLeft: Math.round(fr.left), frameRight: Math.round(fr.right),
      // 2026-09-08: the menu parks itself so the viewport centre lands **inside** 게임으로 돌아가기, right of
      // its middle — that is where Escape leaves the OS cursor, so the resume click needs no aiming.
      resume: { l: Math.round(rb.left), r: Math.round(rb.right), t: Math.round(rb.top), b: Math.round(rb.bottom), cx: Math.round(rb.left + rb.width / 2) },
      cx: Math.round(window.innerWidth / 2), cy: Math.round(window.innerHeight / 2),
      w: window.innerWidth,
      social: !!menu.querySelector('.community-panel'),
      title: frame.querySelector('.title')?.textContent ?? '',
      subtitle: !!frame.querySelector('.subtitle'), mpNote: !!frame.querySelector('.mp-note'), hint: !!frame.querySelector('.hint'),
      buttons: [...frame.querySelectorAll('.actions .ui-btn')].map((b) => ({ t: b.textContent, d: b.style.display })),
      hubVariant: window.__game.getSystem('hud').isPauseHubVariant,
    };
  });
  ok(layout.shown, 'ESC opens the pause menu in the ship');
  const r = layout.resume;
  // 2026-09-09: 메뉴는 더 이상 커서를 찾아가지 않는다 — 세로 중앙 · 가로는 **왼쪽 절반** 고정 (사용자 결정).
  const frameMidX = (r.l + r.r) / 2, frameMidY = (r.t + r.b) / 2;
  ok(frameMidX < layout.cx, '일시정지 메뉴가 화면 왼쪽 절반에 있다', JSON.stringify([frameMidX, layout.cx]));
  ok(Math.abs(frameMidY - layout.cy) <= layout.cy * 0.5,
    '세로로는 화면 중앙 근처다', JSON.stringify([frameMidY, layout.cy]));
  ok(layout.cx > r.cx, '그 점은 버튼 중앙보다 **오른쪽**이다 (클릭하기 여유롭게)', JSON.stringify([layout.cx, r.cx]));
  ok(!layout.social, '2026-09-08: no 소셜 열 on the ESC screen (social is the 커뮤니티 panel alone)');
  // 2026-09-08: the `일시 정지` heading is gone too — Escape does not actually freeze anything, so the word was a lie.
  ok(layout.title === '' && !layout.subtitle && !layout.mpNote && !layout.hint,
    'the ship variant is a bare button column (no title, no subtitle / note / hint)', JSON.stringify(layout));
  ok(layout.hubVariant, 'the pause menu is in its ship variant');
  ok(layout.buttons.map((b) => b.t).join('|') === '게임으로 돌아가기 (Tab)|설정|함선으로 귀환|파티 떠나기|타이틀로|게임 종료',
    'buttons: 돌아가기 (Tab) / 설정 / 귀환 / 파티 떠나기 / 타이틀로 / 게임 종료', JSON.stringify(layout.buttons.map((b) => b.t)));
  const hidden = layout.buttons.filter((b) => b.d === 'none').map((b) => b.t);
  ok(hidden.join('|') === '함선으로 귀환|파티 떠나기',
    '함선으로 귀환 (임무 없음) 과 파티 떠나기 (로비 없음) 는 함선에서 숨는다', JSON.stringify(hidden));

  /* 타이틀로 / 게임 종료 는 경고 팝업을 거친다 — 한 번의 클릭으로 진행이 날아가면 안 된다. */
  const ask = await P(() => {
    const frame = document.querySelector('.menu.pause .frame');
    const btn = [...frame.querySelectorAll('.actions .ui-btn')].find((b) => b.textContent === '타이틀로');
    btn.click();
    const card = document.querySelector('.menu.pause .pause-ask');
    const open = !card.hidden;
    const title = card.querySelector('.pause-ask-title')?.textContent ?? '';
    const okLabel = card.querySelector('.pause-ask-foot .ui-btn.danger')?.textContent ?? '';
    card.querySelector('.pause-ask-foot .ui-btn:not(.danger)').click();   // 취소
    return { open, title, okLabel, closed: card.hidden, phase: window.__game.ctx.phase, askOpen: window.__game.getSystem('hud').isPauseAskOpen };
  });
  ok(ask.open && ask.title === '타이틀로' && ask.okLabel === '타이틀로', '타이틀로 는 경고 팝업을 먼저 띄운다', JSON.stringify(ask));
  ok(ask.closed && ask.phase === 'hub', '취소 는 팝업만 닫고 아무것도 하지 않는다', JSON.stringify(ask));
  ok(layout.buttons[2].d === 'none', '함선으로 귀환 stays display:none in the ship', layout.buttons[2].d);
  // 2026-09-08: Escape never closes the pause menu — only 게임으로 돌아가기 does (that click is also the user
  // gesture Chrome demands before it hands the pointer lock back after an Escape exit).
  await P(() => window.__tap('Escape'));
  await waitSim(0.1);
  ok(await P(() => !document.querySelector('.menu.pause').classList.contains('hidden')), 'Escape does NOT close the pause menu');
  await click('.menu.pause .actions .ui-btn', 0);
  await waitSim(0.2);
  ok(await P(() => document.querySelector('.menu.pause').classList.contains('hidden') && !window.__game.ctx.uiBlockers.has('menu')),
    '게임으로 돌아가기 is what closes it (blocker released)');

  console.log('offline fallback');
  // Forced, not assumed: a relay may well be up (the net / server lanes are live), so ask for the unavailable state.
  // 2026-09-08: the one social surface left is the 커뮤니티 panel, so every column check below runs inside it.
  await P(() => window.__setSocial('offline'));
  await waitSim(0.3);
  await click('.cm-btn');
  await waitSim(0.15);
  let off = await P(() => ({
    off: document.querySelector('.community-panel .sc-off').hidden,
    body: document.querySelector('.community-panel .sc-body').hidden,
    txt: document.querySelector('.community-panel .sc-off').textContent,
  }));
  ok(!off.off && off.body, 'with no relay the column is only the unavailable line', JSON.stringify(off));
  ok(off.txt === '소셜 기능을 사용할 수 없습니다', 'the unavailable line reads 소셜 기능을 사용할 수 없습니다', off.txt);

  console.log('social column');
  await P(() => window.__setSocial(window.__snap()));
  let col = await P(() => {
    const wrap = document.querySelector('.community-panel');
    const fg = wrap.querySelector('.sc-section.friends .sc-grid');
    const rg = wrap.querySelector('.sc-section.recent .sc-grid');
    const cs = getComputedStyle(fg);
    return {
      off: wrap.querySelector('.sc-off').hidden,
      friends: fg.querySelectorAll('.sc-card').length,
      recent: rg.querySelectorAll('.sc-card').length,
      cols: cs.gridTemplateColumns.split(' ').length,
      fRows: cs.getPropertyValue('--rows').trim(),
      rRows: getComputedStyle(rg).getPropertyValue('--rows').trim(),
      scroll: cs.overflowY,
      head: wrap.querySelector('.sc-section.friends .ui-label').textContent,
      squadHidden: wrap.querySelector('.sc-section.squad').hidden,
      reqShown: !wrap.querySelector('.sc-section.reqs').hidden,
      reqCards: wrap.querySelectorAll('.sc-section.reqs .sc-card.is-request').length,
      reqActs: [...wrap.querySelectorAll('.sc-section.reqs .sc-act')].map((b) => b.textContent),
    };
  });
  ok(col.off, 'a snapshot hides the unavailable line');
  ok(col.friends === 4, '4 친구 cards', String(col.friends));
  ok(col.recent === 5, '5 최근 플레이어 cards', String(col.recent));
  ok(col.cols === 2, 'SOCIAL_CARDS_PER_ROW = 2 columns per row', String(col.cols));
  ok(col.fRows === '3.50' && col.rRows === '5.50', 'grids carry SOCIAL_FRIEND_ROWS / SOCIAL_RECENT_ROWS', `${col.fRows}/${col.rRows}`);
  ok(col.scroll === 'auto', 'the friend grid scrolls vertically', col.scroll);
  ok(col.head === '친구 4 · 접속 3', 'friend head counts total + online', col.head);
  ok(col.squadHidden, '분대원 is hidden with no lobby', String(col.squadHidden));
  ok(col.reqShown && col.reqCards === 1, 'the incoming friend request has its own card', JSON.stringify(col));
  ok(col.reqActs.join('|') === '수락|거절', 'a request card carries 수락 / 거절', JSON.stringify(col.reqActs));

  /* 2026-09-08 — 고정 크기: the frame keeps its box, and the 친구 / 최근 grids keep theirs, whatever the lists hold. */
  await P(() => {
    window.__box = (sel) => {
      const wrap = document.querySelector('.community-panel');
      const r = wrap.querySelector(sel).getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    window.__boxes = () => ({ frame: window.__box('.cp-frame'), fg: window.__box('.sc-section.friends .sc-grid'), rg: window.__box('.sc-section.recent .sc-grid') });
  });
  const boxFull = await P(() => window.__boxes());
  const squadCols = await P(() => Number(getComputedStyle(document.querySelector('.community-panel .sc-squad')).getPropertyValue('--cols').trim()));
  await P(() => window.__setSocial({ ...window.__snap(), friends: [], recent: [], incoming: [] }));
  await sleep(80);
  const boxEmpty = await P(() => window.__box('.cp-frame'));
  await P(() => window.__setSocial(window.__snap()));
  await sleep(80);
  ok(boxFull.frame.w === boxEmpty.w && boxFull.frame.h === boxEmpty.h,
    `커뮤니티 패널 keeps its size when the lists empty (${boxFull.frame.w}×${boxFull.frame.h})`, JSON.stringify({ boxFull, boxEmpty }));
  ok(boxFull.fg.h === Math.round(3.5 * 56) && boxFull.rg.h === Math.round(5.5 * 56),
    `친구 3.5줄 / 최근 5.5줄 fixed boxes (${boxFull.fg.h} / ${boxFull.rg.h} px)`, JSON.stringify(boxFull));
  ok(squadCols === 4, '분대원 is a 1×4 grid', String(squadCols));

  let card = await P(() => {
    const c = document.querySelector('.community-panel .sc-section.friends .sc-card');
    return {
      code: c.dataset.code, id: c.querySelector('.sc-id').textContent, lv: c.querySelector('.sc-lv').textContent,
      name: c.querySelector('.sc-name').textContent, pres: c.querySelector('.sc-pres .t').textContent,
      offlineCls: [...document.querySelectorAll('.community-panel .sc-section.friends .sc-card')][2].className,
    };
  });
  ok(card.id === 'CDEF-2345', 'the card shows the formatted PlayerCode', card.id);
  ok(card.code === 'CDEF2345', 'the bare 8-char code is what the DOM carries as data', card.code);
  ok(card.lv === 'Lv. 8' && card.name === '친구하나', 'name + level on the card', `${card.lv} ${card.name}`);
  ok(card.pres === '함선', 'presence label from PRESENCE_LABELS', card.pres);
  ok(card.offlineCls.includes('is-offline'), 'an offline friend is dimmed (.is-offline)', card.offlineCls);

  console.log('context menu');
  await P(() => window.__ctxMenu('.community-panel .sc-section.friends .sc-card', 0));
  let menu = await P(() => window.__menu());
  ok(menu.open, 'right-click opens the profile context menu');
  // 2026-09-11 (B-4): 대화 기록 and 차단 joined the menu.
  ok(menu.items.map((i) => i.act).join('|') === 'play|whisper|history|remove|block',
    'a friend gets 같이 하기 / 귓속말하기 / 대화 기록 / 친구 삭제 / 차단', JSON.stringify(menu.items.map((i) => i.label)));
  ok(!menu.items[0].off && menu.items[0].why === '', '같이 하기 enabled for a friend in the ship with no squad', JSON.stringify(menu.items[0]));
  await P(() => window.__ctxMenu('.community-panel .sc-section.friends .sc-card', 1));
  menu = await P(() => window.__menu());
  ok(menu.items[0].off && menu.items[0].why === '임무 중', '같이 하기 disabled with 임무 중 for a friend in a raid', JSON.stringify(menu.items[0]));
  await P(() => window.__ctxMenu('.community-panel .sc-section.friends .sc-card', 2));
  menu = await P(() => window.__menu());
  ok(menu.items[0].off && menu.items[0].why === '오프라인', '같이 하기 disabled with 오프라인', JSON.stringify(menu.items[0]));
  await P(() => window.__ctxMenu('.community-panel .sc-section.friends .sc-card', 3));
  menu = await P(() => window.__menu());
  ok(menu.items[0].off && menu.items[0].why === '상대 분대가 가득 참', '같이 하기 disabled with 상대 분대가 가득 참', JSON.stringify(menu.items[0]));
  await P(() => window.__ctxMenu('.community-panel .sc-section.recent .sc-card', 0));
  menu = await P(() => window.__menu());
  ok(menu.items.map((i) => i.act).join('|') === 'play|whisper|history|add|block', 'a non-friend gets 친구 추가 instead of 친구 삭제', JSON.stringify(menu.items.map((i) => i.label)));
  ok(menu.items[3].label === '친구 추가', 'the fourth entry reads 친구 추가', menu.items[3].label);

  // 친구 추가 → requestFriend
  await click('.sc-menu:not([hidden]) .sc-mi[data-act="add"]');
  let log = await P(() => window.__log());
  ok(log.at(-1) === 'requestFriend:YZ234567', '친구 추가 calls requestFriend with the 아이디', JSON.stringify(log.slice(-2)));
  ok(await P(() => !window.__menuEl()), 'the menu closes after an action');

  // 같이 하기 → playWith
  await P(() => window.__ctxMenu('.community-panel .sc-section.friends .sc-card', 0));
  await click('.sc-menu:not([hidden]) .sc-mi[data-act="play"]');
  log = await P(() => window.__log());
  ok(log.at(-1) === 'playWith:CDEF2345', '같이 하기 calls playWith', JSON.stringify(log.slice(-2)));

  // a disabled entry does nothing
  await P(() => window.__ctxMenu('.community-panel .sc-section.friends .sc-card', 2));
  await click('.sc-menu:not([hidden]) .sc-mi[data-act="play"]');
  log = await P(() => window.__log());
  ok(log.at(-1) === 'playWith:CDEF2345', 'a disabled 같이 하기 fires nothing', JSON.stringify(log.slice(-2)));

  console.log('친구 삭제 confirm');
  await P(() => window.__ctxMenu('.community-panel .sc-section.friends .sc-card', 0));
  await click('.sc-menu:not([hidden]) .sc-mi[data-act="remove"]');
  let conf = await P(() => ({
    open: !!window.__confirmEl(),
    body: window.__confirmEl()?.querySelector('.sc-confirm-body').textContent ?? '',
    menu: !window.__menuEl(),
  }));
  ok(conf.open, '친구 삭제 opens a confirm popup instead of removing at once');
  ok(conf.body.includes('CDEF-2345') && conf.body.includes('친구하나'), 'the confirm names the friend + 아이디', conf.body);
  ok(conf.menu, 'the context menu closed behind the confirm');
  log = await P(() => window.__log());
  ok(!log.some((l) => l.startsWith('removeFriend')), 'nothing was removed yet', JSON.stringify(log.slice(-2)));
  await click('.sc-confirm:not([hidden]) .sc-confirm-foot .ui-btn', 0); // 취소
  ok(await P(() => !window.__confirmEl()), '취소 closes the confirm');
  log = await P(() => window.__log());
  ok(!log.some((l) => l.startsWith('removeFriend')), '취소 removes nothing', JSON.stringify(log.slice(-2)));
  await P(() => window.__ctxMenu('.community-panel .sc-section.friends .sc-card', 0));
  await click('.sc-menu:not([hidden]) .sc-mi[data-act="remove"]');
  await click('.sc-confirm:not([hidden]) .sc-confirm-foot .ui-btn.danger');
  log = await P(() => window.__log());
  ok(log.at(-1) === 'removeFriend:CDEF2345', '삭제 calls removeFriend', JSON.stringify(log.slice(-2)));
  ok(await count('.community-panel .sc-section.friends .sc-card') === 3, 'the friend list repainted to 3 cards');

  console.log('friend request 수락');
  await click('.community-panel .sc-section.reqs .sc-act.ok');
  log = await P(() => window.__log());
  ok(log.at(-1) === 'respondFriend:UVWX2345,true', '수락 calls respondFriend(code, true)', JSON.stringify(log.slice(-2)));
  let after = await P(() => ({
    reqs: document.querySelector('.community-panel .sc-section.reqs').hidden,
    friends: document.querySelectorAll('.community-panel .sc-section.friends .sc-card').length,
  }));
  ok(after.reqs && after.friends === 4, 'the accepted request became a friend card', JSON.stringify(after));

  console.log('Escape: the context menu first, then the 일시정지 메뉴');
  await P(() => window.__ctxMenu('.community-panel .sc-section.friends .sc-card', 0));
  await P(() => window.__tap('Escape'));
  await waitSim(0.1);
  let esc = await P(() => ({
    menu: !window.__menuEl(),
    pause: !document.querySelector('.menu.pause').classList.contains('hidden'),
    panel: !document.querySelector('.community-panel').hidden,
  }));
  ok(esc.menu && !esc.pause, 'Escape cancels the context menu without opening the 일시정지 메뉴', JSON.stringify(esc));
  ok(esc.panel, 'the 커뮤니티 panel behind it stays open');
  // 2026-09-09 (ESC 닫기): with nothing innermost left, the next Escape closes the **커뮤니티 panel** itself
  // (열린 화면 중 맨 위 하나), and only the press after that — with nothing open — opens the 일시정지 메뉴.
  await P(() => window.__tap('Escape'));
  await waitSim(0.15);
  let esc2 = await P(() => ({
    pause: !document.querySelector('.menu.pause').classList.contains('hidden'),
    panel: !document.querySelector('.community-panel').hidden,
    open: window.__game.getSystem('hud').isCommunityOpen,
  }));
  ok(!esc2.panel && !esc2.open, 'the next Escape closes the 커뮤니티 panel (맨 위 하나)', JSON.stringify(esc2));
  ok(!esc2.pause, 'and it does not open the 일시정지 메뉴 in the same press', JSON.stringify(esc2));
  await P(() => window.__tap('Escape'));
  await waitSim(0.15);
  const esc3 = await P(() => ({
    pause: !document.querySelector('.menu.pause').classList.contains('hidden'),
    esc: window.__game.ctx.escape.size,
  }));
  ok(esc3.pause && esc3.esc === 0, '닫을 화면이 없어진 다음 Escape 가 일시정지 메뉴를 연다', JSON.stringify(esc3));

  console.log('설정 side panel');
  await click('.menu.pause .actions .ui-btn', 1);
  await waitSim(0.1);
  let set = await P(() => {
    const root = document.querySelector('.menu.settings-menu');
    const frame = root.querySelector('.frame');
    const fr = frame.getBoundingClientRect();
    const nav = [...root.querySelectorAll('.set-nav-btn')];
    const paneBox = root.querySelector('.set-pane').getBoundingClientRect();
    return {
      open: window.__game.getSystem('hud').isSettingsOpen,
      side: root.classList.contains('side'),
      justify: getComputedStyle(root).justifyContent,
      left: Math.round(fr.left), right: Math.round(fr.right), w: window.innerWidth,
      nav: nav.map((b) => b.textContent),
      on: nav.filter((b) => b.classList.contains('is-on')).map((b) => b.textContent),
      section: window.__game.getSystem('hud').settingsSection,
      shownPanes: [...root.querySelectorAll('.set-body')].filter((e) => !e.hidden).map((e) => e.className),
      frameH: Math.round(frame.getBoundingClientRect().height),
      paneScroll: getComputedStyle(root.querySelector('.set-body.display')).overflowY,
      displayRows: [...root.querySelectorAll('.set-body.display .set-row-label')].map((e) => e.textContent),
      toggles: root.querySelectorAll('.set-body.display .set-toggle').length,
      segs: [...root.querySelectorAll('.set-body.display .set-seg')].map((b) => b.textContent),
      keys: root.querySelectorAll('.set-body.keys .controls-panel').length,
      keycaps: root.querySelectorAll('.set-body.keys .ctl-keyboard .ctl-key').length,
      bound: root.querySelectorAll('.set-body.keys .ctl-key.bound').length,
      mouse: root.querySelectorAll('.set-body.keys .ctl-mouse-svg').length,
      groups: root.querySelectorAll('.set-body.keys .ctl-list .ctl-group').length,
      btn: root.querySelector('.set-key-btn')?.textContent,
      vols: [...root.querySelectorAll('.set-row.vol .set-row-label')].map((e) => e.textContent),
      sliders: root.querySelectorAll('.set-row.vol .set-slider').length,
    };
  });
  ok(set.open, '설정 opens from the pause menu');
  // 2026-09-09: 설정은 **화면 중앙**에 오고 좌우로 넓어졌다 (ESC 가 왼쪽 절반으로 옮겨 가 피할 것이 없다).
  ok(set.justify === 'center', 'the 설정 overlay is centred', `${set.side} ${set.justify}`);
  ok(set.right > set.w * 0.6, 'the 설정 panel reaches past the middle (it is centred, not a left rail)', JSON.stringify([set.right, set.w]));
  // 2026-09-10: 서버 설정(접속할 릴레이 주소)이 네 번째로 붙었다.
  ok(set.nav.join('|') === '화면 설정|오디오 설정|키 설정|서버 설정', 'the left rail lists the four sections in order', JSON.stringify(set.nav));
  ok(set.on.join('|') === '화면 설정' && set.section === 'display', '화면 설정 is selected by default', JSON.stringify([set.on, set.section]));
  ok(set.shownPanes.length === 1 && /display/.test(set.shownPanes[0]), 'exactly one pane is visible at a time', JSON.stringify(set.shownPanes));
  ok(set.paneScroll === 'auto', 'the right pane scrolls vertically', set.paneScroll);
  ok(set.displayRows.join('|') === '전체화면|화면 효과|그림자|해상도 배율', '화면 설정 rows', JSON.stringify(set.displayRows));
  ok(set.toggles === 3 && set.segs.join('|') === '75%|100%|125%', 'three on/off pills + the 해상도 배율 steps', JSON.stringify([set.toggles, set.segs]));
  ok(set.vols.join('|') === '전체|효과음' && set.sliders === 2, '오디오 keeps 전체 · 효과음 sliders', JSON.stringify(set.vols));
  ok(set.keys === 1, '키 설정 holds one real ControlsPanel instance', String(set.keys));
  ok(set.keycaps > 50, 'the keyboard diagram rendered its keys', String(set.keycaps));
  ok(set.bound > 8, 'bound keys are lit in the diagram', String(set.bound));
  ok(set.mouse === 1, 'the mouse diagram is there too', String(set.mouse));
  ok(set.groups >= 3, 'the per-function list is grouped', String(set.groups));
  ok(set.btn === '키 설정 변경', 'the KEYBIND_BUTTON_LABEL button sits under the diagram', String(set.btn));
  // switching sections must not resize the frame — the pane box is fixed
  const paneSwap = await P((before) => {
    const root = document.querySelector('.menu.settings-menu');
    [...root.querySelectorAll('.set-nav-btn')][2].click();
    return {
      before, after: Math.round(root.querySelector('.frame').getBoundingClientRect().height),
      section: window.__game.getSystem('hud').settingsSection,
      keysShown: !root.querySelector('.set-body.keys').hidden,
      displayShown: !root.querySelector('.set-body.display').hidden,
    };
  }, set.frameH);
  ok(paneSwap.section === 'keys' && paneSwap.keysShown && !paneSwap.displayShown, 'clicking 키 설정 swaps the pane', JSON.stringify(paneSwap));
  ok(paneSwap.before === paneSwap.after, 'the panel does not resize between sections', JSON.stringify(paneSwap));
  await P(() => window.__tap('Escape'));
  let closed = await P(() => ({
    set: window.__game.getSystem('hud').isSettingsOpen,
    pause: !document.querySelector('.menu.pause').classList.contains('hidden'),
    ev: window.__ev['ui:settingsToggled'].map((e) => e.open),
  }));
  ok(!closed.set && closed.pause, 'Escape closes 설정 and leaves the pause menu (blocker etiquette unchanged)', JSON.stringify(closed));
  ok(closed.ev.join(',') === 'true,false', 'ui:settingsToggled open → close', JSON.stringify(closed.ev));

  console.log('커뮤니티 thumbnail');
  await emit('game:paused', { paused: false });
  await waitSim(0.1);
  // 2026-09-09: the panel is already gone — the Escape above closed it (2026-09-08 left it open for a P tap here).
  ok(await P(() => !window.__game.getSystem('hud').isCommunityOpen), '커뮤니티 panel 은 위의 Escape 로 이미 닫혔다');
  await P(() => window.__setSocial(window.__snap()));
  await waitSim(0.3);
  let cm = await P(() => {
    const root = document.querySelector('.community');
    const r = root.getBoundingClientRect();
    return {
      show: root.classList.contains('show'),
      right: Math.round(window.innerWidth - r.right), top: Math.round(r.top),
      count: document.querySelector('.cm-count').textContent,
      dot: document.querySelector('.cm-dot').hidden,
      cheatTop: getComputedStyle(document.querySelector('.hud.social .cheat-tag')).top,
      on: window.__game.getSystem('hud').isCommunityOn,
    };
  });
  ok(cm.show && cm.on, 'the 커뮤니티 widget shows in the ship', JSON.stringify(cm));
  ok(cm.right === 32 && cm.top === 28, 'anchored top-right at 32 / 28 px', JSON.stringify([cm.right, cm.top]));
  ok(cm.count === '3', 'the online-friend count sits inside the thumbnail', cm.count);
  ok(!cm.dot, 'a pending friend request raises the red dot');
  ok(cm.cheatTop === '108px', 'the MOVE CHEAT tag moves below the thumbnail in the ship', cm.cheatTop);
  await P(() => { const s = window.__snap(); s.incoming = []; window.__setSocial(s); });
  await waitSim(0.2);
  ok(await P(() => document.querySelector('.cm-dot').hidden), 'no pending request → no red dot');

  console.log('커뮤니티 panel');
  await click('.cm-btn');
  await waitSim(0.1);
  let panel = await P(() => ({
    open: window.__game.getSystem('hud').isCommunityOpen,
    shown: !document.querySelector('.community-panel').hidden,
    blocker: window.__game.ctx.uiBlockers.has('community'),
    cursor: window.__game.ctx.input.isCursorMode,
    col: document.querySelectorAll('.community-panel .social-col').length,
    friends: document.querySelectorAll('.community-panel .sc-section.friends .sc-card').length,
    code: document.querySelector('.cp-code').textContent,
    ev: window.__ev['ui:communityToggled'].map((e) => e.open),
  }));
  ok(panel.open && panel.shown, 'clicking the thumbnail opens the community panel');
  ok(panel.blocker, 'the panel holds the COMMUNITY_BLOCKER token');
  ok(panel.cursor === true, 'and switches on the software cursor (never exitPointerLock)', String(panel.cursor));
  ok(panel.col === 1 && panel.friends === 4, 'the panel reuses the same SocialColumn component', JSON.stringify(panel));
  ok(panel.code.includes('AB3D-9KMN'), 'the panel head shows my own 아이디', panel.code);
  ok(panel.ev.slice(-1)[0] === true, 'ui:communityToggled {open:true}', JSON.stringify(panel.ev));
  // P closes it, and so does Escape / Tab (2026-09-09); the close button reads the live P key label.
  ok(await P(() => (document.querySelector('.cp-close')?.textContent ?? '') === '닫기 (P)'), 'the close button names the P key');
  await P(() => window.__tap('KeyP'));
  await waitSim(0.2);
  let cclosed = await P(() => ({
    open: window.__game.getSystem('hud').isCommunityOpen,
    blocker: window.__game.ctx.uiBlockers.has('community'),
    cursor: window.__game.ctx.input.isCursorMode,
    ev: window.__ev['ui:communityToggled'].map((e) => e.open),
  }));
  ok(!cclosed.open && !cclosed.blocker && !cclosed.cursor, 'a P tap closes it and releases blocker + cursor mode', JSON.stringify(cclosed));
  ok(cclosed.ev.slice(-1)[0] === false, 'ui:communityToggled open → close', JSON.stringify(cclosed.ev));

  console.log('분대 초대 stack');
  await P(() => {
    const s = window.__snap();
    s.incoming = [];
    const inv = [
      { from: 'YZ234567', name: '초대하나', lobby: 'AAA111', at: 1 },
      { from: 'ABCD2345', name: '초대둘', lobby: 'BBB222', at: 2 },
      { from: 'EFGH3456', name: '초대셋', lobby: 'CCC333', at: 3 },
      { from: 'JKLM4567', name: '초대넷', lobby: 'DDD444', at: 4 },
    ];
    window.__setSocial(s, inv);
  });
  await waitSim(0.3);
  let inv = await P(() => {
    const cards = [...document.querySelectorAll('.cm-invite')];
    const wrap = document.querySelector('.cm-invites').getBoundingClientRect();
    const btn = document.querySelector('.cm-btn').getBoundingClientRect();
    return {
      n: cards.length,
      order: cards.map((c) => c.dataset.from),
      active: cards[0]?.classList.contains('is-active'),
      hint: cards[0]?.querySelector('.ci-hint').textContent,
      id: cards[0]?.querySelector('.ci-id').textContent,
      name: cards[0]?.querySelector('.ci-name').textContent,
      below: wrap.top >= btn.bottom - 1,
      hudCount: window.__game.getSystem('hud').communityInviteCount,
    };
  });
  ok(inv.n === 3 && inv.hudCount === 3, 'the stack is capped at SQUAD_INVITE_MAX = 3', JSON.stringify([inv.n, inv.hudCount]));
  ok(inv.order.join('|') === 'JKLM4567|EFGH3456|ABCD2345', 'newest invite first, oldest dropped', JSON.stringify(inv.order));
  ok(inv.below, 'the invite panels stack below the thumbnail');
  ok(inv.active, 'only the newest card is the active hold target');
  ok(inv.hint === 'P 홀드로 참여', 'the hint reads the live Keys.INVITE label', String(inv.hint));
  ok(inv.id === 'JKLM-4567' && inv.name === '초대넷 분대 초대', 'the card shows 아이디 + 이름', `${inv.id} / ${inv.name}`);

  console.log('P hold');
  await P(() => window.__key('KeyP', 'keydown'));
  await waitSim(1.2);
  let held = await P(() => ({
    t: window.__game.getSystem('hud').communityHoldProgress,
    fill: document.querySelector('.cm-invite .ci-bar i').style.transform,
    second: [...document.querySelectorAll('.cm-invite .ci-bar i')][1].style.transform,
  }));
  ok(held.t > 0.2 && held.t < 0.95, 'holding P fills the gauge', String(held.t));
  ok(/scaleX\(0\.[1-9]/.test(held.fill), 'the active card bar is scaled', held.fill);
  ok(held.second === 'scaleX(0)', 'the other cards stay at 0', held.second);
  await P(() => window.__key('KeyP', 'keyup'));
  await waitSim(0.3);
  ok(await hud('communityHoldProgress') === 0, 'releasing P resets the gauge');
  await P(() => window.__key('KeyP', 'keydown'));
  await waitSim(3.4);
  await P(() => window.__key('KeyP', 'keyup'));
  await waitSim(0.2);
  let acc = await P(() => ({
    log: window.__log(), n: window.__game.getSystem('hud').communityInviteCount,
    order: [...document.querySelectorAll('.cm-invite')].map((c) => c.dataset.from),
  }));
  ok(acc.log.at(-1) === 'acceptInvite:JKLM4567', 'a full P hold accepts the newest invite', JSON.stringify(acc.log.slice(-2)));
  ok(!acc.order.includes('JKLM4567'), 'the accepted invite left the stack', JSON.stringify(acc.order));
  ok(acc.n === 3 && acc.order[0] === 'EFGH3456', 'the 4th invite that was capped out takes its place', JSON.stringify(acc.order));
  await click('.cm-invite .ci-x');
  await waitSim(0.2);
  let dis = await P(() => ({
    log: window.__log(), n: window.__game.getSystem('hud').communityInviteCount,
    order: [...document.querySelectorAll('.cm-invite')].map((c) => c.dataset.from),
  }));
  // 2026-09-11 (B-3): × is a real 거절 (the inviter is told) — `declineInvite`, not the old local dismiss.
  ok(dis.log.at(-1) === 'declineInvite:EFGH3456', 'the × declines the invite', JSON.stringify(dis.log.slice(-2)));
  ok(dis.n === 2 && !dis.order.includes('EFGH3456'), 'the dismissed invite left the stack', JSON.stringify(dis.order));

  console.log('귓속말');
  await P(() => window.__setSocial(window.__snap()));
  await emit('chat:whisperTo', { code: 'CDEF2345', name: '친구하나' });
  await waitSim(0.2);
  let w = await P(() => ({
    open: window.__game.getSystem('hud').isChatOpen,
    target: window.__game.getSystem('hud').chatWhisperTarget,
    chipHidden: document.querySelector('.chat-target').hidden,
    chip: document.querySelector('.chat-target .t').textContent,
    col: document.querySelector('.hud-bl').classList.contains('whispering'),
    ph: document.querySelector('.chat-input').placeholder,
  }));
  ok(w.open, 'chat:whisperTo opens the chat input');
  ok(w.target === 'CDEF2345', 'the input is aimed at that 아이디', String(w.target));
  ok(!w.chipHidden && w.chip === '→ 친구하나', 'a → 이름 chip marks the whisper target', `${w.chipHidden} ${w.chip}`);
  ok(w.col, 'the bottom-left column moves to mid-left (.hud-bl.whispering)');
  ok(w.ph.includes('귓속말'), 'the placeholder says 귓속말', w.ph);
  await P(() => { document.querySelector('.chat-input').value = '거기 있나'; window.__key('Enter', 'keydown'); });
  await waitSim(0.2);
  let sent = await P(() => ({ log: window.__log(), open: window.__game.getSystem('hud').isChatOpen, target: window.__game.getSystem('hud').chatWhisperTarget }));
  ok(sent.log.at(-1) === 'whisper:CDEF2345,거기 있나', 'Enter sends through social.whisper(code, text)', JSON.stringify(sent.log.slice(-2)));
  ok(sent.open, 'the input stays open after sending (2026-09-09: Enter sends, Tab / Esc close)');
  ok(sent.target === 'CDEF2345', 'the target survives the close (the next Enter whispers too)', String(sent.target));
  let lines = await P(() => document.querySelectorAll('.chat-line.whisper').length);
  ok(lines === 0, 'the sender writes no local echo — the mirror answers with social:whisper', String(lines));
  await emit('social:whisper', { line: { code: 'CDEF2345', name: '친구하나', text: '거기 있나', at: 1, out: true } });
  await emit('social:whisper', { line: { code: 'CDEF2345', name: '친구하나', text: '여기 있다', at: 2, out: false } });
  await waitSim(0.2);
  let drawn = await P(() => [...document.querySelectorAll('.chat-line.whisper')].map((l) => ({
    who: l.querySelector('.who').textContent, txt: l.querySelector('.txt').textContent, me: l.classList.contains('me'),
  })));
  ok(drawn.length === 2, 'both directions draw a .chat-line.whisper', String(drawn.length));
  ok(drawn[0].who === '귓속말 → 친구하나:' && drawn[0].me, 'an outgoing whisper is prefixed 귓속말 →', JSON.stringify(drawn[0]));
  ok(drawn[1].who === '귓속말 친구하나:' && !drawn[1].me, 'an incoming whisper is prefixed 귓속말', JSON.stringify(drawn[1]));
  await P(() => { window.__key('Enter', 'keydown'); });
  await waitSim(0.1);
  await click('.chat-target .x');
  await waitSim(0.1);
  let cleared = await P(() => ({
    target: window.__game.getSystem('hud').chatWhisperTarget,
    chip: document.querySelector('.chat-target').hidden,
    col: document.querySelector('.hud-bl').classList.contains('whispering'),
  }));
  ok(cleared.target === null && cleared.chip && !cleared.col, 'the chip × drops the target and the column comes back down', JSON.stringify(cleared));
  await P(() => { window.__key('Escape', 'keydown'); window.__key('Escape', 'keyup'); });

  console.log('귓속말 without a relay');
  await P(() => window.__setSocial('offline'));
  await emit('chat:whisperTo', { code: 'CDEF2345', name: '친구하나' });
  await waitSim(0.1);
  await P(() => { document.querySelector('.chat-input').value = '들리나'; window.__key('Enter', 'keydown'); });
  await waitSim(0.2);
  let failed = await P(() => {
    const l = [...document.querySelectorAll('.chat-line.system .txt')].map((e) => e.textContent);
    return { last: l.at(-1), whispers: document.querySelectorAll('.chat-line.whisper').length };
  });
  ok(String(failed.last).startsWith('귓속말 전송 실패'), 'an unavailable mirror leaves a failure line', JSON.stringify(failed));
  ok(failed.whispers === 2, 'and no new whisper line', String(failed.whispers));
  await emit('game:paused', { paused: true, freeze: false });
  await waitSim(0.1);
  let offCol = await P(() => ({
    off: !document.querySelector('.community-panel .sc-off').hidden,
    body: document.querySelector('.community-panel .sc-body').hidden,
  }));
  ok(offCol.off && offCol.body, 'losing the mirror collapses the column back to the one line', JSON.stringify(offCol));
  await emit('game:paused', { paused: false });

  /* ══ 2026-09-11 (B-3 · B-4): a detached **real** SocialSync, fed server frames by hand, drives the real ui ══
     (`HudSystem.debugSocialRef`). The shared relay runs older code, so nothing here goes over a socket: `send` records
     every frame into `__sent`, and the relay's answers (`social:inviteClosed` · `inviteResult` · `whisperAck` ·
     `whisperBacklog` · `social:state`) are the method calls NetSystem would make. */
  console.log('B-3 · B-4: real SocialSync, hand-fed frames');
  for (let i = 0; i < 3 && await hud('isChatOpen'); i++) { await P(() => window.__tap('Escape')); await waitSim(0.05); }
  await P(() => {
    localStorage.removeItem('scav.s1.whispers');
    localStorage.removeItem('scav.whispers');
    const S = window.__game.getSystem('net').socialSync.constructor;
    window.__sent = [];
    window.__mkSync = () => {
      const s = new S();
      s.bus = window.__game.ctx.bus;
      s.send = (m) => { window.__sent.push(JSON.parse(JSON.stringify(m))); return true; };
      s.joinLobby = (code) => { window.__sent.push({ t: 'JOIN', code }); };
      return s;
    };
    window.__ss = window.__mkSync();
    window.__ss.onWelcome(window.__snap());
    window.__game.getSystem('hud').debugSocialRef(window.__ss);
    window.__notifs = () => [...document.querySelectorAll('.notifs .notif .t')].map((e) => e.textContent);
  });
  await waitSim(0.2);
  const lastSent = () => P(() => window.__sent.at(-1) ?? null);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const holdP = async () => { await P(() => window.__key('KeyP', 'keydown')); await waitSim(3.4); await P(() => window.__key('KeyP', 'keyup')); await waitSim(0.2); };

  console.log('초대 id 경로');
  await P(() => window.__ss.onInvited({ from: 'CDEF2345', name: '친구하나', lobby: 'AAA222', at: Date.now(), id: 'inv-1' }));
  await waitSim(0.3);
  ok(await hud('communityInviteCount') === 1, 'an invite carrying a server id shows its card');
  await holdP();
  let ir = await P(() => ({ sent: window.__sent.slice(), closed: window.__ev['social:inviteClosed'].at(-1), n: window.__game.getSystem('hud').communityInviteCount }));
  ok(same(ir.sent.at(-1), { t: 'social:inviteReply', id: 'inv-1', accept: true }), 'P hold on an id invite → social:inviteReply {id, accept:true}', JSON.stringify(ir.sent));
  ok(!ir.sent.some((m) => m.t === 'JOIN'), 'and no lobby:join — the relay moves me itself', JSON.stringify(ir.sent));
  ok(ir.closed?.reason === 'accepted' && ir.closed?.id === 'inv-1' && ir.n === 0, 'the card closes as accepted (with its id)', JSON.stringify(ir));
  await P(() => window.__ss.onInvited({ from: 'YZ234567', name: '최근하나', lobby: 'BBB222', at: Date.now(), id: 'inv-2' }));
  await waitSim(0.3);
  await click('.cm-invite .ci-x');
  await waitSim(0.1);
  ir = await P(() => ({ last: window.__sent.at(-1), closed: window.__ev['social:inviteClosed'].at(-1), n: window.__game.getSystem('hud').communityInviteCount }));
  ok(same(ir.last, { t: 'social:inviteReply', id: 'inv-2', accept: false }), 'the card × → social:inviteReply {accept:false}', JSON.stringify(ir.last));
  ok(ir.closed?.reason === 'declined' && ir.n === 0, 'and closes as declined', JSON.stringify(ir.closed));

  console.log('옛 서버 초대 (id 없음) 폴백');
  await P(() => window.__ss.onInvited({ from: 'JKLM4567', name: '최근넷', lobby: 'DDD444', at: Date.now() }));
  await waitSim(0.3);
  await holdP();
  ok(same(await lastSent(), { t: 'JOIN', code: 'DDD444' }), 'an invite without an id is accepted with the Phase 11 lobby:join', JSON.stringify(await lastSent()));
  await P(() => window.__ss.onInvited({ from: 'NPQR5678', name: '최근다섯', lobby: 'EEE555', at: Date.now() }));
  await waitSim(0.3);
  const sentBeforeX = await P(() => window.__sent.length);
  await click('.cm-invite .ci-x');
  await waitSim(0.1);
  ir = await P(() => ({ n: window.__sent.length, closed: window.__ev['social:inviteClosed'].at(-1) }));
  ok(ir.n === sentBeforeX && ir.closed?.reason === 'dismissed', 'its × sends nothing (the old relay has no reply) and just dismisses', JSON.stringify(ir));

  console.log('서버가 닫은 초대');
  await P(() => window.__ss.onInvited({ from: 'QRST6789', name: '친구넷', lobby: 'FFF666', at: Date.now(), id: 'inv-3' }));
  await waitSim(0.3);
  await P(() => window.__ss.onInviteClosed({ id: 'inv-3', outcome: 'failed', reason: 'full' }));
  await waitSim(0.2);
  ir = await P(() => ({ n: window.__game.getSystem('hud').communityInviteCount, closed: window.__ev['social:inviteClosed'].at(-1), toasts: window.__notifs() }));
  ok(ir.n === 0 && ir.closed?.reason === 'failed' && ir.closed?.detail === 'full' && ir.closed?.from === 'QRST6789',
    'social:inviteClosed from the relay closes the card → bus {from, reason, id, detail}', JSON.stringify(ir.closed));
  ok(ir.toasts.some((t) => t.startsWith('분대 초대가 취소되었습니다')), 'and says the invite was cancelled', JSON.stringify(ir.toasts));
  await P(() => window.__ss.onInviteClosed({ id: 'inv-3', outcome: 'expired' }));   // already gone → nothing

  console.log('재접속 때 같은 id 로 다시 온 초대 · limit 정리');
  await P(() => window.__ss.onInvited({ from: 'GHJK6789', name: '친구둘', lobby: 'GGG777', at: Date.now(), id: 'inv-4' }));
  await P(() => { window.__ss.onDisconnected(); window.__ss.onWelcome(window.__snap()); });
  await P(() => window.__ss.onInvited({ from: 'GHJK6789', name: '친구둘', lobby: 'GGG777', at: Date.now(), id: 'inv-4' }));
  await waitSim(0.3);
  ir = await P(() => ({ n: window.__game.getSystem('hud').communityInviteCount, announced: window.__ev['social:invited'].filter((e) => e.invite?.id === 'inv-4').length }));
  ok(ir.n === 1 && ir.announced === 1, 'the relay re-sending an open invite (same id) after a reconnect brings the card back without a second announcement', JSON.stringify(ir));
  const cancelToasts = () => P(() => window.__notifs().filter((t) => t.startsWith('분대 초대가 취소되었습니다')).length);
  const c0 = await cancelToasts();
  await P(() => window.__ss.onInviteClosed({ id: 'inv-4', outcome: 'failed', reason: 'limit' }));
  await waitSim(0.2);
  ok(await hud('communityInviteCount') === 0 && await cancelToasts() === c0, 'a `failed · limit` close (the relay trimming my stack) removes the card quietly');

  console.log('초대 결과 토스트 (거절 ≠ 만료)');
  await P(() => window.__ss.onInviteResult({ id: 'r1', code: 'GHJK6789', name: '친구둘', outcome: 'declined' }));
  await P(() => window.__ss.onInviteResult({ id: 'r2', code: 'LMNP2345', name: '친구셋', outcome: 'expired' }));
  await P(() => window.__ss.onInviteResult({ id: 'r3', code: 'QRST6789', name: '친구넷', outcome: 'superseded' }));
  await waitSim(0.2);
  let toasts = await P(() => window.__notifs());
  const tDecl = toasts.find((t) => t.startsWith('친구둘 님'));
  const tExp = toasts.find((t) => t.startsWith('친구셋 님'));
  ok(tDecl === '친구둘 님이 초대를 거절했습니다', '거절 → "OO 님이 초대를 거절했습니다"', JSON.stringify(toasts));
  ok(tExp === '친구셋 님이 초대에 응답하지 않았습니다' && tExp !== tDecl, '만료 reads differently from 거절', JSON.stringify(toasts));
  ok(!toasts.some((t) => t.startsWith('친구넷 님')), 'superseded toasts nothing', JSON.stringify(toasts));
  ok(await P(() => window.__ev['social:inviteResult'].map((e) => e.outcome).join(',')) === 'declined,expired,superseded', 'social:inviteResult reaches the bus for each');

  console.log('초대 중 배지');
  await P(() => {
    const s = window.__snap();
    const now = window.__game.ctx.net.serverNow();
    s.friends[0].inviteAt = now - 10000;    // CDEF2345: 80 s left
    s.friends[1].inviteAt = now - 89300;    // GHJK6789: under a second left
    window.__ss.onState(s);
  });
  await click('.cm-btn');
  await waitSim(0.3);
  const badge = () => P(() => {
    const q = (c) => document.querySelector(`.community-panel .sc-section.friends .sc-card[data-code="${c}"] .sc-inv`);
    const a = q('CDEF2345'), b = q('GHJK6789'), c = q('LMNP2345');
    return { a: a ? (a.hidden ? 'hidden' : a.textContent) : null, b: b ? (b.hidden ? 'hidden' : b.textContent) : null, c: !!c };
  });
  let bd = await badge();
  const secs0 = Number(/초대 중 · (\d+)초/.exec(bd.a ?? '')?.[1]);
  ok(secs0 >= 78 && secs0 <= 80, `a row with an open invite carries 초대 중 · n초 (${bd.a})`, JSON.stringify(bd));
  ok(!bd.c, 'a row with no invite has no badge', JSON.stringify(bd));
  await sleep(1600);
  await waitSim(0.1);
  bd = await badge();
  const secs1 = Number(/초대 중 · (\d+)초/.exec(bd.a ?? '')?.[1]);
  ok(secs1 < secs0, `the badge counts down on the relay clock (${secs0} → ${secs1})`, JSON.stringify(bd));
  ok(bd.b === 'hidden', 'a badge whose invite ran out hides itself', JSON.stringify(bd));
  await P(() => window.__ss.onInviteResult({ id: 'r4', code: 'CDEF2345', name: '친구하나', outcome: 'accepted' }));
  await waitSim(0.2);
  bd = await badge();
  ok(bd.a === null, 'social:inviteResult drops the badge at once (no waiting for the next snapshot)', JSON.stringify(bd));
  toasts = await P(() => window.__notifs());
  // 리드 통합: 수락 토스트는 `net:peerJoined` 의 `<이름> 합류` 와 겹쳐 뺐다.
  ok(!toasts.some((t) => t.includes('님이 분대에 합류했습니다')), '수락 → 따로 토스트 없음 (합류 토스트가 대신한다)', JSON.stringify(toasts));

  console.log('차단');
  await P(() => window.__ctxMenu('.community-panel .sc-section.friends .sc-card', 1));   // GHJK6789 친구둘
  await click('.sc-menu:not([hidden]) .sc-mi[data-act="block"]');
  let bl = await P(() => ({ open: !!window.__confirmEl(), body: window.__confirmEl()?.querySelector('.sc-confirm-body').textContent ?? '', sent: window.__sent.filter((m) => m.t === 'social:block').length }));
  ok(bl.open && bl.body.includes('친구둘') && bl.sent === 0, '차단 asks first (a plain confirm — it can be undone)', JSON.stringify(bl));
  await click('.sc-confirm:not([hidden]) .sc-confirm-foot .ui-btn.danger');
  ok(same(await lastSent(), { t: 'social:block', code: 'GHJK6789', blocked: true }), '확인 → social:block {code, blocked:true}', JSON.stringify(await lastSent()));
  await P(() => {   // the relay's answer: off my friends, onto my blocked list
    const s = window.__snap();
    s.friends = s.friends.filter((f) => f.code !== 'GHJK6789');
    s.blocked = [{ code: 'GHJK6789', name: '친구둘', level: 20 }];
    window.__ss.onState(s);
  });
  await waitSim(0.3);
  bl = await P(() => ({
    isBlocked: window.__ss.isBlocked('GHJK6789'),
    friends: document.querySelectorAll('.community-panel .sc-section.friends .sc-card').length,
    btn: document.querySelector('.cp-blocked')?.textContent, btnHidden: document.querySelector('.cp-blocked')?.hidden,
  }));
  ok(bl.isBlocked && bl.friends === 3 && bl.btn === '차단 목록 1' && !bl.btnHidden, 'the snapshot moves them to 차단 목록 (head button counts it)', JSON.stringify(bl));
  await click('.cp-blocked');
  await waitSim(0.1);
  bl = await P(() => {
    const pg = document.querySelector('.community-panel .sc-page');
    return { open: !pg.hidden, title: pg.querySelector('.sc-page-title').textContent, cards: [...pg.querySelectorAll('.sc-card')].map((c) => c.dataset.code), esc: window.__game.ctx.escape.has('community:page') };
  });
  ok(bl.open && bl.title === '차단 목록' && same(bl.cards, ['GHJK6789']) && bl.esc, '차단 목록 page lists the blocked 아이디 (on the Escape stack)', JSON.stringify(bl));
  await P(() => window.__ctxMenu('.community-panel .sc-page .sc-card', 0));
  menu = await P(() => window.__menu());
  ok(menu.items.map((i) => i.act).join('|') === 'history|unblock', 'a blocked row\'s menu: 대화 기록 / 차단 해제 only', JSON.stringify(menu.items));
  await P(() => window.__tap('Escape'));
  await click('.community-panel .sc-page .sc-unblock');
  ok(same(await lastSent(), { t: 'social:block', code: 'GHJK6789', blocked: false }), '차단 해제 → social:block {blocked:false}', JSON.stringify(await lastSent()));
  await P(() => window.__tap('Escape'));
  await waitSim(0.15);
  bl = await P(() => ({ page: !document.querySelector('.community-panel .sc-page').hidden, panel: window.__game.getSystem('hud').isCommunityOpen, pause: !document.querySelector('.menu.pause').classList.contains('hidden') }));
  ok(!bl.page && bl.panel && !bl.pause, 'Escape closes the page first — the panel stays', JSON.stringify(bl));
  // still blocked (the relay has not answered the 해제): the relay would answer these with a bare `invalid` — say why instead
  const nB = await P(() => window.__sent.length);
  bl = await P(() => {
    window.__ss.playWith('GHJK6789');
    window.__ss.requestFriend('GHJK6789');
    const drew = window.__ss.whisper('GHJK6789', '차단한 상대에게');
    return { drew, sent: window.__sent.length, errs: window.__ev['social:error'].slice(-3).map((e) => e.message) };
  });
  ok(bl.sent === nB && bl.errs.length === 3 && bl.errs.every((m) => m.startsWith('차단한 상대입니다')),
    '같이 하기 / 친구 추가 / 귓속말 to a blocked player send nothing and say 차단한 상대입니다', JSON.stringify({ nB, bl }));

  console.log('차단한 분대원의 분대 채팅');
  const chatHide = await P(() => {
    const net = window.__game.getSystem('net');
    const prev = net._lobby;
    net._lobby = { code: 'CHAT01', hostId: 'peer-b', isPublic: false, started: false, seed: null, players: [
      { id: 'peer-b', name: '친구둘', slot: 1, ready: false, isHost: true, connected: true, code: 'GHJK6789' },
      { id: 'peer-c', name: '친구하나', slot: 2, ready: false, isHost: false, connected: true, code: 'CDEF2345' },
    ] };
    const bus = window.__game.ctx.bus;
    const has = (t) => [...document.querySelectorAll('.chat-line .txt')].some((e) => e.textContent === t);
    const msgs = [];
    const off = bus.on('chat:message', (m) => msgs.push(m.text));
    bus.emit('net:chat', { id: 'peer-b', name: '친구둘', text: '차단된 사람의 말', kind: 'text' });
    bus.emit('net:chat', { id: 'peer-b', name: '친구둘', text: '적 발견 (차단된 사람의 핑)', kind: 'ping' });
    bus.emit('net:chat', { id: 'peer-c', name: '친구하나', text: '막히지 않은 말', kind: 'text' });
    off();
    net._lobby = prev;   // same task — no frame ever saw the fake lobby
    return { msgs, blockedText: has('차단된 사람의 말'), ping: has('적 발견 (차단된 사람의 핑)'), other: has('막히지 않은 말') };
  });
  ok(!chatHide.blockedText && !chatHide.msgs.includes('차단된 사람의 말'), 'a blocked squad-mate\'s typed line is not drawn', JSON.stringify(chatHide));
  ok(chatHide.ping, 'their ping line still is (pings / comms wheel stay)', JSON.stringify(chatHide));
  ok(chatHide.other, 'an unblocked squad-mate\'s line is drawn', JSON.stringify(chatHide));

  console.log('귓속말 전송 확인');
  await click('.cp-close');
  await waitSim(0.15);
  const sendChat = (t) => P((x) => { document.querySelector('.chat-input').value = x; window.__key('Enter', 'keydown'); }, t);
  const lastWhisper = () => P(() => {
    const r = [...document.querySelectorAll('.chat-line.whisper')].at(-1);
    const w = r?.querySelector('.wst');
    return r ? { cls: r.className, txt: r.querySelector('.txt').textContent, who: r.querySelector('.who').textContent, wst: w && !w.hidden ? w.textContent : '' } : null;
  });
  const errCount = () => P(() => window.__ev['social:error'].length);
  await emit('chat:whisperTo', { code: 'CDEF2345', name: '친구하나' });
  await waitSim(0.15);
  await sendChat('옛 서버 실패');
  await waitSim(0.1);
  let sentW = await lastSent();
  let wl = await lastWhisper();
  ok(sentW?.t === 'social:whisper' && sentW.code === 'CDEF2345' && sentW.text === '옛 서버 실패' && typeof sentW.nonce === 'number', 'a whisper goes out with a nonce', JSON.stringify(sentW));
  ok(wl?.txt === '옛 서버 실패' && / pending/.test(wl.cls) && wl.wst === '전송 중…', 'and is drawn dimmed as pending', JSON.stringify(wl));
  const e0 = await errCount();
  await P(() => window.__ss.onError({ t: 'social:error', code: 'offline', message: '상대가 접속 중이 아닙니다' }));
  await waitSim(0.1);
  wl = await lastWhisper();
  ok(/ failed/.test(wl.cls) && !/pending/.test(wl.cls) && wl.wst === '전송 실패 — 오프라인', 'old relay (no ack): its social:error turns THAT line failed', JSON.stringify(wl));
  ok(await errCount() === e0 && !(await P(() => window.__notifs())).some((t) => t.includes('상대가 접속 중이 아닙니다')), 'and raises no separate error toast', String(await errCount()));
  await sendChat('확인되는 줄');
  sentW = await lastSent();
  await P((n) => window.__ss.onWhisperAck({ nonce: n, ok: true, at: Date.now() }), sentW.nonce);
  await waitSim(0.1);
  wl = await lastWhisper();
  ok(wl.txt === '확인되는 줄' && !/pending|failed|stored/.test(wl.cls) && wl.wst === '', 'social:whisperAck ok → the pending line settles as sent', JSON.stringify(wl));
  ok(await P(() => window.__ev['social:whisperUpdated'].at(-1)?.line?.state) === 'sent', 'social:whisperUpdated {state:sent}');
  await sendChat('실패하는 줄');
  sentW = await lastSent();
  await P((n) => window.__ss.onWhisperAck({ nonce: n, ok: false, code: 'offline' }), sentW.nonce);
  await waitSim(0.1);
  wl = await lastWhisper();
  const rowsNow = await P(() => [...document.querySelectorAll('.chat-line.whisper .txt')].filter((e) => e.textContent === '실패하는 줄').length);
  ok(/ failed/.test(wl.cls) && wl.txt === '실패하는 줄' && wl.wst === '전송 실패 — 오프라인' && rowsNow === 1, 'ack !ok → the same row turns failed (no second line)', JSON.stringify({ wl, rowsNow }));
  ok(await errCount() === e0, 'still no social:error / toast for a failed whisper', String(await errCount()));
  await emit('chat:whisperTo', { code: 'LMNP2345', name: '친구셋' });   // an offline FRIEND: the relay may keep it
  await waitSim(0.1);
  await sendChat('나중에 봐');
  sentW = await lastSent();
  ok(sentW?.code === 'LMNP2345' && sentW.text === '나중에 봐', 'a whisper to an offline friend still goes out', JSON.stringify(sentW));
  await P((n) => window.__ss.onWhisperAck({ nonce: n, ok: true, stored: true }), sentW.nonce);
  await waitSim(0.1);
  wl = await lastWhisper();
  ok(/ stored/.test(wl.cls) && wl.wst === '오프라인 보관 — 접속하면 전달', 'ack stored → 오프라인 보관', JSON.stringify(wl));
  await emit('chat:whisperTo', { code: 'ABCD2345', name: '최근둘' });   // offline and NOT a friend: nowhere to keep it
  await waitSim(0.1);
  const nSent = await P(() => window.__sent.length);
  await sendChat('안 가는 줄');
  await waitSim(0.1);
  wl = await lastWhisper();
  ok(await P(() => window.__sent.length) === nSent && wl.txt === '안 가는 줄' && / failed/.test(wl.cls) && wl.wst === '전송 실패 — 오프라인',
    'an offline non-friend fails on the spot — as a drawn failed line, nothing sent', JSON.stringify(wl));

  console.log('대화 기록 저장 (슬롯 키) · backlog · /r');
  let hist = await P(() => {
    const raw = localStorage.getItem('scav.s1.whispers');
    const doc = raw ? JSON.parse(raw) : null;
    const fresh = new (window.__game.getSystem('net').socialSync.constructor)();
    const fmt = (l) => `${l.out ? '>' : '<'}${l.text}:${l.state ?? ''}`;
    return {
      unslotted: localStorage.getItem('scav.whispers'), v: doc?.v, peers: (doc?.peers ?? []).map((p) => p.code),
      mem: window.__ss.whisperHistory('CDEF2345').map(fmt), reload: fresh.whisperHistory('CDEF2345').map(fmt),
      last: window.__ss.lastWhisperPeer, peerList: window.__ss.whisperPeers().map((p) => p.code),
    };
  });
  ok(hist.unslotted === null && hist.v === 1, 'the 대화 기록 lives under the slot key scav.s1.whispers', JSON.stringify(hist));
  ok(same(hist.mem, ['>옛 서버 실패:failed', '>확인되는 줄:sent', '>실패하는 줄:failed']), 'per-partner lines with their final states', JSON.stringify(hist.mem));
  ok(same(hist.reload, hist.mem), 'a fresh SocialSync reads the same conversation back from storage', JSON.stringify(hist.reload));
  ok(hist.last === 'ABCD2345' && same(hist.peerList, ['ABCD2345', 'LMNP2345', 'CDEF2345']), 'partners most recent first; lastWhisperPeer = the latest', JSON.stringify(hist));
  await P(() => window.__ss.onWhisperBacklog({ lines: [{ code: 'QRST6789', name: '친구넷', text: '없는 동안 보낸 말', at: Date.now() - 60000 }] }));
  await waitSim(0.1);
  wl = await lastWhisper();
  ok(wl.who === '귓속말 친구넷:' && / backlog/.test(wl.cls) && wl.wst === '접속 전에 받음', 'a backlog line is drawn and tagged 접속 전에 받음', JSON.stringify(wl));
  hist = await P(() => ({ last: window.__ss.lastWhisperPeer, line: window.__ss.whisperHistory('QRST6789').at(-1) }));
  ok(hist.last === 'QRST6789' && hist.line?.backlog === true && hist.line?.out === false, 'and recorded (backlog:true) — its sender is the /r target now', JSON.stringify(hist));
  await click('.chat-target .x');
  await waitSim(0.05);
  await sendChat('/r 답장이다');
  await waitSim(0.1);
  sentW = await lastSent();
  ok(sentW?.t === 'social:whisper' && sentW.code === 'QRST6789' && sentW.text === '답장이다', '/r <텍스트> whispers the last partner from squad chat', JSON.stringify(sentW));
  await sendChat('/r');
  await waitSim(0.1);
  ok(await hud('chatWhisperTarget') === 'QRST6789', '/r alone aims the input at the last partner', String(await hud('chatWhisperTarget')));
  for (let i = 0; i < 3 && await hud('isChatOpen'); i++) { await P(() => window.__tap('Escape')); await waitSim(0.05); }

  console.log('대화 기록 화면');
  await click('.cm-btn');
  await waitSim(0.2);
  await P(() => window.__ctxMenu('.community-panel .sc-section.friends .sc-card', 0));   // CDEF2345
  await click('.sc-menu:not([hidden]) .sc-mi[data-act="history"]');
  await waitSim(0.1);
  const pageState = () => P(() => {
    const pg = document.querySelector('.community-panel .sc-page');
    return {
      open: !pg.hidden, title: pg.querySelector('.sc-page-title').textContent, sub: pg.querySelector('.sc-page-sub').textContent,
      lines: [...pg.querySelectorAll('.sc-logline')].map((l) => ({ cls: l.className, txt: l.querySelector('.txt').textContent, st: l.querySelector('.st')?.textContent ?? '' })),
      focus: document.activeElement === pg.querySelector('.sc-log-input'),
      panel: window.__game.getSystem('hud').isCommunityOpen,
    };
  });
  let hp = await pageState();
  ok(hp.open && hp.title === '대화 기록' && hp.sub.includes('CDEF-2345') && hp.focus, '대화 기록 opens over the column with its field focused', JSON.stringify(hp));
  ok(hp.lines.length === 3 && /failed/.test(hp.lines[0].cls) && hp.lines[0].st === '전송 실패 — 오프라인' && hp.lines[1].st === '',
    'the page lists the saved lines with their states', JSON.stringify(hp.lines));
  await P(() => { const i = document.querySelector('.community-panel .sc-log-input'); i.value = '기록에서 보냄'; i.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true })); });
  await waitSim(0.1);
  sentW = await lastSent();
  hp = await pageState();
  ok(sentW?.code === 'CDEF2345' && sentW.text === '기록에서 보냄', 'Enter in the page field whispers that partner', JSON.stringify(sentW));
  ok(hp.lines.length === 4 && /pending/.test(hp.lines[3].cls), 'the new line appears on the page, pending', JSON.stringify(hp.lines.at(-1)));
  await P((n) => window.__ss.onWhisperAck({ nonce: n, ok: true }), sentW.nonce);
  await waitSim(0.1);
  hp = await pageState();
  ok(!/pending/.test(hp.lines[3].cls), 'and settles there on its ack', JSON.stringify(hp.lines.at(-1)));
  await P(() => document.querySelector('.community-panel .sc-log-input').dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true })));
  await waitSim(0.1);
  hp = await pageState();
  ok(!hp.open && hp.panel && !(await P(() => window.__game.ctx.escape.has('community:page'))), 'Escape in the field closes the page, the panel stays', JSON.stringify(hp));
  await P(() => window.__ctxMenu('.community-panel .sc-section.friends .sc-card', 0));
  await click('.sc-menu:not([hidden]) .sc-mi[data-act="history"]');
  await waitSim(0.1);
  await P(() => document.querySelector('.community-panel .sc-log-input').dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', bubbles: true })));
  await waitSim(0.15);
  hp = await pageState();
  ok(!hp.open && !hp.panel && !(await P(() => window.__game.ctx.uiBlockers.has('community'))), 'Tab in the field closes the whole panel (Tab = 공용 닫기)', JSON.stringify(hp));

  console.log('옛 서버: ack 가 없으면 잠시 뒤 sent');
  const grace = await P(async () => {
    const s2 = window.__mkSync();
    s2.bus = null;
    s2.onWelcome(window.__snap());
    s2.whisper('CDEF2345', '옛 서버 무응답');
    const before = s2.whisperHistory('CDEF2345').at(-1)?.state;
    await new Promise((r) => setTimeout(r, 5400));
    return [before, s2.whisperHistory('CDEF2345').at(-1)?.state];
  });
  ok(grace[0] === 'pending' && grace[1] === 'sent', 'a line an older relay never acks counts as sent after the grace', JSON.stringify(grace));
  await P(() => { window.__game.getSystem('hud').debugSocialRef(null); localStorage.removeItem('scav.s1.whispers'); });

  console.log('raid ESC + 결과 화면 행성');
  await P(() => { window.__game.ctx.missionPlanet = 'mossy'; window.__game.ctx.bus.emit('game:newMission', { seed: 4242, planet: 'mossy' }); });
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
  await waitSim(0.4);
  await emit('game:paused', { paused: true, freeze: true });
  await waitSim(0.1);
  let raid = await P(() => ({
    social: document.querySelector('.community-panel').hidden,
    ret: [...document.querySelectorAll('.menu.pause .actions .ui-btn')][2].style.display,
    hub: window.__game.getSystem('hud').isPauseHubVariant,
    community: document.querySelector('.community').classList.contains('show'),
  }));
  ok(raid.social, 'the ESC social column is hidden in a raid');
  ok(raid.ret !== 'none', '함선으로 귀환 is back in a raid', String(raid.ret));
  ok(!raid.hub, 'the pause menu left its ship variant');
  ok(!raid.community, 'the 커뮤니티 widget is hidden outside the ship');
  await emit('game:paused', { paused: false });

  await P(() => window.__game.ctx.bus.emit('game:over', { stats: window.__game.ctx.stats }));
  await waitSim(0.1);
  ok(await text('.menu.death .planet-line') === '행성 · 베르단트 III', 'the death screen names the planet', await text('.menu.death .planet-line'));
  await P(() => { window.__game.ctx.missionPlanet = null; window.__game.ctx.bus.emit('game:over', { stats: window.__game.ctx.stats }); });
  await waitSim(0.1);
  ok(await text('.menu.death .planet-line') === '행성 · 목표 미지정', 'no planet → PLANET_NONE_LABEL', await text('.menu.death .planet-line'));
  await P(() => { window.__game.ctx.missionPlanet = 'mossy'; });
  await emit('game:phaseChanged', { phase: 'playing' });
  await P(() => window.__game.ctx.bus.emit('game:complete', { stats: { ...window.__game.ctx.stats, seed: 4242 } }));
  await waitSim(0.1);
  let comp = await P(() => ({
    line: document.querySelector('.menu.complete .planet-line')?.textContent,
    order: (() => {
      const s = document.querySelector('.menu.complete .subtitle');
      const p = document.querySelector('.menu.complete .planet-line');
      return !!(s.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
    })(),
  }));
  ok(comp.line === '행성 · 베르단트 III', 'the result screen names the planet', String(comp.line));
  ok(comp.order, 'the planet line sits under the subtitle');
  await click('.menu.complete .actions .ui-btn', 1);
  await waitSim(0.2);
  let re = await P(() => window.__ev['game:newMission'].at(-1));
  ok(re && re.seed === 4242 && re.planet === 'mossy', '다시 배치 re-emits the same seed AND ctx.missionPlanet', JSON.stringify(re));

  const real = errors.filter((e) => !/\/ws\b|WebSocket|websocket/i.test(e));
  ok(real.length === 0, 'no console / page errors', JSON.stringify(real.slice(0, 3)));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${e.message}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);   // the tally format `scripts/verify.mjs` parses
process.exit(fail === 0 ? 0 : 1);
