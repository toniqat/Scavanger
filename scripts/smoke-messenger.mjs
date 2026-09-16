// 2026-09-14 메신저 UI smoke (src/ui/menus/messenger — docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
//
// The P panel that replaced the 커뮤니티 panel: thumbnail unread badge, the three tabs (대화 · 친구 · 퀘스트), the 대화 tab's
// mixed list (NPC · 개인 대화 · 단체방, recency, filters, room invites), an NPC conversation with quest cards (수락 / 생각해보지),
// a 개인 대화 conversation (send · read), a 단체방 (history + older page, blocked lines hidden, say, members drawer, invite /
// rename / kick / leave with the 1초 홀드), 방 만들기, the 친구 tab's 개인 대화 jump, the 퀘스트 tab (납품 · 완료 보고 · 보류 수락 →
// 대화), `ui:openMessenger`, the NPC toast, Tab / Escape, ship-only gating, screenshots at 1280×720 and 1920×1080, and a last
// pass against the **real** `ctx.meta.npc` / `ctx.net.rooms` when they exist.
//
// Deterministic by default: `HudSystem.debugSocial` · `debugNpc` · `debugRooms` install in-page stubs that record every call.
//
// Usage: node scripts/smoke-messenger.mjs [http://localhost:5273/]   (screenshots → $SHOT_DIR or scripts/shots/messenger)
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SHOT_DIR = process.env.SHOT_DIR ?? 'scripts/shots/messenger';
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

mkdirSync(SHOT_DIR, { recursive: true });
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
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
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['ui:messengerToggled', 'ui:communityToggled']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p ?? {}))); });
    }
    window.__key = (code, type, target = document.body) => target.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }));
    window.__tap = (code) => { window.__key(code, 'keydown'); window.__key(code, 'keyup'); };
    window.__notifs = () => [...document.querySelectorAll('.notifs .notif .t')].map((e) => e.textContent);
    window.__hud = () => window.__game.getSystem('hud');
    window.__ms = () => window.__game.getSystem('hud').messenger;
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const click = (sel, i = 0) => P(([s, k]) => { const e = [...document.querySelectorAll(s)][k]; if (!e) return false; e.click(); return true; }, [sel, i]);
  const calls = () => P(() => window.__calls.slice());
  const socialLog = () => P(() => window.__hud().debugSocialLog.map((c) => `${c.m}:${c.args.join(',')}`));
  const hasCall = async (s) => (await calls()).includes(s);
  const type = (sel, text) => P(([s, t]) => {
    const i = document.querySelector(s);
    if (!i) return false;
    i.value = t;
    i.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  }, [sel, text]);

  console.log('ship');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub', 30000);
  await waitSim(0.3);

  /* ── stubs ─────────────────────────────────────────────────────────────── */
  await P(() => {
    const game = window.__game, bus = game.ctx.bus, hud = game.getSystem('hud');
    const NOW = Date.now();
    window.__calls = [];
    const call = (m, ...a) => window.__calls.push(`${m}:${a.join(',')}`);

    /* social: 3 friends, a request, a blocked player who also has a line */
    const snap = {
      me: { code: 'AB3D9KMN', name: '나', level: 12 },
      friends: [
        { code: 'CDEF2345', name: '친구하나', level: 8, presence: 'ship', squad: 0, joinable: true },
        { code: 'GHJK6789', name: '친구둘', level: 20, presence: 'raid', squad: 3, joinable: false },
        { code: 'LMNP2345', name: '친구셋', level: 1, presence: 'offline', squad: 0, joinable: false },
      ],
      incoming: [{ code: 'UVWX2345', name: '요청자', level: 3, presence: 'ship', squad: 0, joinable: true }],
      outgoing: [],
      recent: [{ code: 'YZ234567', name: '최근하나', level: 4, presence: 'ship', squad: 0, joinable: true, at: 1 }],
      blocked: [{ code: 'QRST6789', name: '차단됨', level: 5 }],
    };
    const history = {
      CDEF2345: [
        { code: 'CDEF2345', name: '친구하나', text: '오늘 출격해?', at: NOW - 120000, out: false },
        { code: 'CDEF2345', name: '친구하나', text: '조금 이따가', at: NOW - 60000, out: true, state: 'sent' },
      ],
      QRST6789: [{ code: 'QRST6789', name: '차단됨', text: '보이면 안 됨', at: NOW - 5000, out: false }],
    };
    hud.debugSocial(snap, [], 1, history);
    window.__snapFriends = snap.friends;

    /* NPC stub (real NPC ids so the toast can resolve names from data/npcs.csv) */
    const npcDef = (id, name, title, corp, role, color, glyph) => ({ id, name, title, corp, role, color, glyph, requires: {}, intro: [], bio: `${name} — 소개 한 줄.`, order: 0 });
    const NPCS = {
      npc_han_seojin: npcDef('npc_han_seojin', '한서진', '헬릭스 방산 조달실장', 'helix', 'executive', '#ff7a45', '한'),
      npc_raven: npcDef('npc_raven', '레이븐', '정보 브로커', null, 'independent', '#c79fff', 'R'),
    };
    const obj = (quest, index, kind, target, label) => ({
      def: { quest, index, kind, target }, label, progress: 0, target, done: false, raid: kind !== 'deliver', countsHere: false,
      blocked: kind === 'deliver' ? '보유한 아이템이 없습니다' : null, ...(kind === 'deliver' ? { have: 0 } : {}),
    });
    const Q = {};
    const mk = (id, npc, name, state, objectives, at) => {
      Q[id] = {
        def: {
          id, npc, name, summary: `${name} — 설명 한 단락입니다.`, requires: {}, objectives: objectives.map((o) => o.def),
          rewards: { credits: 300, xp: 500, rep: npc === 'npc_han_seojin' ? [{ corp: 'helix', amount: 120 }] : [], items: [{ defId: 'mat_scrap', qty: 2 }] },
          lines: { offer: [], accept: [], decline: [], brief: [], complete: [] }, order: 0,
        },
        npc: NPCS[npc], state, at, objectives, ready: false, blocked: null, progress: 0,
      };
    };
    mk('q_offer', 'npc_han_seojin', '폐금속 긴급 조달', 'offered', [obj('q_offer', 0, 'deliver', 5, '폐금속 5개 납품'), obj('q_offer', 1, 'kill', 3, '피로스 VII 에서 레이더 3명 처치')], NOW - 10000);
    mk('q_ready', 'npc_han_seojin', '시험 사격', 'active', [obj('q_ready', 0, 'kill', 1, '인간형 적 1명 처치')], NOW - 600000);
    Object.assign(Q.q_ready.objectives[0], { progress: 1, done: true });
    mk('q_active', 'npc_raven', '연구소 뒷조사', 'active', [obj('q_active', 0, 'deliver', 2, '회로 기판 2개 납품'), obj('q_active', 1, 'discover', 1, '연구소 발견')], NOW - 3600000);
    Object.assign(Q.q_active.objectives[0], { progress: 1, have: 3, blocked: null });
    Object.assign(Q.q_active.objectives[1], { progress: 1, done: true });
    // 2026-09-14 3차: 「생각해볼게」 은퇴 — 이 줄은 이제 **아직 수락하지 않은 제안**이고 대화창 카드로만 보인다.
    mk('q_def', 'npc_raven', '장부 복사', 'offered', [obj('q_def', 0, 'search', 3, '전진기지 컨테이너 3개 조사')], NOW - 7200000);
    mk('q_done', 'npc_han_seojin', '첫 거래', 'complete', [obj('q_done', 0, 'deliver', 1, '합금 판 1개 납품')], NOW - 86400000);
    Object.assign(Q.q_done.objectives[0], { progress: 1, done: true, blocked: null });
    const recompute = (q) => {
      q.ready = q.objectives.every((o) => o.done);
      q.progress = q.objectives.reduce((s, o) => s + Math.min(1, o.progress / o.target), 0) / q.objectives.length;
      q.blocked = q.state === 'active' && !q.ready ? '목표를 모두 채워야 보고할 수 있습니다' : null;
    };
    Object.values(Q).forEach(recompute);
    const MSG = {
      npc_han_seojin: [
        { at: NOW - 900000, from: 'npc', text: '헬릭스 조달실장 한서진입니다.' },
        { at: NOW - 899000, from: 'npc', text: '저는 숫자로 말합니다.' },
        { at: NOW - 600000, from: 'quest', questId: 'q_ready' },
        { at: NOW - 599000, from: 'me', text: '맡겠습니다.' },
        { at: NOW - 10000, from: 'npc', text: '급한 건이 하나 더 있습니다.' },
        { at: NOW - 10000, from: 'quest', questId: 'q_offer' },
      ],
      npc_raven: [
        { at: NOW - 7200000, from: 'npc', text: '레이븐입니다. 조용히 끝낼 일이 있어요.' },
        { at: NOW - 3600000, from: 'quest', questId: 'q_active' },
        { at: NOW - 3599000, from: 'me', text: '맡겠습니다.' },
        // 아직 수락하지 않은 제안 — 2026-09-14 3차부터 이 카드는 **대화창에만** 있다
        { at: NOW - 60000, from: 'quest', questId: 'q_def' },
      ],
    };
    const unread = { npc_han_seojin: 2, npc_raven: 0 };
    /** NPC → 아직 고르지 않은 대사 선택지 (2026-09-14). 이 스모크는 비워 둔다. */
    const CHOICES = {};
    const emitQ = (q, prev) => bus.emit('npc:questChanged', { id: q.def.id, npc: q.def.npc, state: q.state, prev });
    window.__npc = {
      getContacts() {
        return Object.keys(NPCS).map((id) => ({ npc: NPCS[id], at: MSG[id].at(-1).at, unread: unread[id], preview: '…' })).sort((a, b) => b.at - a.at);
      },
      getMessages(id) { return MSG[id] ?? []; },
      /* 2026-09-14 (대사 선택지): `NpcQuestRef` 에 둘이 늘었다 — 스텸에 없으면 `ChatTab.threadDataKey` 가
         던져 대화가 통째로 안 그려진다. 여기서는 선택지를 쓰지 않으므로 빈 목록이다. */
      getPendingChoices(id) { return CHOICES[id] ?? []; },
      chooseIntro(id, i) { call('npc.chooseIntro', `${id}:${i}`); if (!CHOICES[id]?.[i]) return false; CHOICES[id] = []; return true; },
      markRead(id) { call('npc.markRead', id); unread[id] = 0; bus.emit('npc:unreadChanged', { total: this.unreadTotal }); },
      get unreadTotal() { return Object.values(unread).reduce((s, n) => s + n, 0); },
      /* 2026-09-14 3차 (사용자 결정): 퀘스트 목록에는 **받은 것만** — offered · deferred 는 빠진다. */
      getQuests() { return Object.values(Q).filter((q) => q.state === 'active' || q.state === 'complete'); },
      getQuest(id) { return Q[id] ?? null; },
      accept(id) {
        call('npc.accept', id);
        const q = Q[id];
        if (!q || (q.state !== 'offered' && q.state !== 'deferred')) return false;
        const prev = q.state;
        q.state = 'active'; q.at = Date.now(); recompute(q);
        MSG[q.def.npc].push({ at: Date.now(), from: 'me', text: prev === 'deferred' ? '그 일, 아직 유효합니까?' : '맡겠습니다.' });
        MSG[q.def.npc].push({ at: Date.now(), from: 'npc', text: '좋아요, 짧게 설명하죠.' });
        emitQ(q, prev);
        bus.emit('npc:message', { npc: q.def.npc, entry: { at: Date.now(), e: prev === 'deferred' ? 'brief' : 'accept', q: id } });
        return true;
      },
      /* 은퇴 (2026-09-14 3차) — 계약에만 남는 이름이고 아무것도 하지 않는다. */
      defer(id) { call('npc.defer', id); return false; },
      deliver(id, index) {
        call('npc.deliver', id, index);
        const q = Q[id];
        const o = q?.objectives.find((x) => x.def.index === index);
        if (!o || o.def.kind !== 'deliver' || o.done) return 0;
        const n = Math.min(o.have ?? 0, o.target - o.progress);
        if (n <= 0) return 0;
        o.progress += n; o.have -= n; o.done = o.progress >= o.target; o.blocked = o.done ? null : o.blocked;
        recompute(q);
        bus.emit('npc:objectiveProgress', { questId: id, index, progress: o.progress, target: o.target, done: o.done, delta: n, raid: false });
        return n;
      },
      report(id) {
        call('npc.report', id);
        const q = Q[id];
        if (!q || q.state !== 'active' || !q.ready) return false;
        q.state = 'complete'; q.at = Date.now(); recompute(q);
        emitQ(q, 'active');
        return true;
      },
      getRaidTracks() { return []; },
    };
    hud.debugNpc(window.__npc);

    /* rooms stub */
    const me = { code: 'AB3D9KMN', name: '나', level: 12, presence: 'ship' };
    const m1 = { code: 'CDEF2345', name: '친구하나', level: 8, presence: 'ship' };
    const m3 = { code: 'LMNP2345', name: '친구셋', level: 1, presence: 'offline' };
    const mb = { code: 'QRST6789', name: '차단됨', level: 5, presence: 'ship' };
    const R = {
      r1: { id: 'r1', name: '원정대방', owner: 'AB3D9KMN', members: [me, m1, m3, mb], pending: [], createdAt: NOW - 86400000, lastAt: NOW - 20000, lastText: 'ㅎㅇ' },
      r2: { id: 'r2', name: '야간 사냥', owner: 'CDEF2345', members: [m1, me], pending: [], createdAt: NOW - 90000000, lastAt: NOW - 7300000, lastText: '내일 보자' },
    };
    const H = {
      r1: [
        { room: 'r1', code: 'AB3D9KMN', name: '나', text: '', at: NOW - 300000, system: 'create' },
        { room: 'r1', code: 'CDEF2345', name: '친구하나', text: '어서와', at: NOW - 30000 },
        { room: 'r1', code: 'QRST6789', name: '차단됨', text: '차단된 사람의 말', at: NOW - 25000 },
        { room: 'r1', code: 'AB3D9KMN', name: '나', text: 'ㅎㅇ', at: NOW - 20000 },
      ],
      r2: [{ room: 'r2', code: 'CDEF2345', name: '친구하나', text: '내일 보자', at: NOW - 7300000 }],
    };
    const more = { r1: true, r2: false };
    const unreadR = { r1: 1, r2: 0 };
    let invites = [{ room: 'r3', name: '야간 정찰조', from: 'GHJK6789', fromName: '친구둘', members: 4, at: NOW - 5000 }];
    let nonce = 0;
    const upd = () => bus.emit('room:updated', { first: false });
    window.__rooms = {
      available: true,
      get rooms() { return Object.values(R).sort((a, b) => b.lastAt - a.lastAt); },
      get invites() { return invites; },
      find(id) { return R[id]; },
      history(id) { return H[id] ?? []; },
      requestHistory(id, before) {
        call('rooms.requestHistory', id, before === undefined ? 'latest' : 'before');
        setTimeout(() => {
          if (before !== undefined && more[id]) {
            H[id] = [{ room: 'r1', code: 'LMNP2345', name: '친구셋', text: '예전 대화', at: NOW - 400000 }, ...H[id]];
            more[id] = false;
          }
          bus.emit('room:history', { room: id });
        }, 30);
      },
      hasMore(id) { return !!more[id]; },
      create(name, inv = []) {
        call('rooms.create', name, [...inv].join('+'));
        R.r9 = { id: 'r9', name, owner: 'AB3D9KMN', members: [me], pending: [], createdAt: Date.now(), lastAt: Date.now() };
        H.r9 = [{ room: 'r9', code: 'AB3D9KMN', name: '나', text: '', at: Date.now(), system: 'create' }];
        upd();
        return true;
      },
      invite(id, code) {
        call('rooms.invite', id, code);
        const f = window.__snapFriends.find((x) => x.code === code);
        R[id].pending.push({ code, name: f?.name ?? '', level: 1 });
        upd();
      },
      respond(id, accept) { call('rooms.respond', id, accept); invites = invites.filter((i) => i.room !== id); upd(); },
      leave(id) { call('rooms.leave', id); delete R[id]; upd(); },
      kick(id, code) {
        call('rooms.kick', id, code);
        const who = R[id].members.find((m) => m.code === code);
        R[id].members = R[id].members.filter((m) => m.code !== code);
        H[id].push({ room: id, code: 'AB3D9KMN', name: '나', text: '', at: Date.now(), system: 'kick', target: code, targetName: who?.name ?? '' });
        upd();
      },
      rename(id, name) { call('rooms.rename', id, name); R[id].name = name; upd(); },
      say(id, text) {
        call('rooms.say', id, text);
        const line = { room: id, code: 'AB3D9KMN', name: '나', text, at: Date.now(), nonce: ++nonce, state: 'pending' };
        H[id].push(line); R[id].lastAt = line.at; R[id].lastText = text;
        bus.emit('room:line', { line });
        return true;
      },
      unread(id) { return unreadR[id] ?? 0; },
      markRead(id) { call('rooms.markRead', id); unreadR[id] = 0; bus.emit('room:unreadChanged', { total: this.unreadTotal }); },
      get unreadTotal() { return Object.values(unreadR).reduce((s, n) => s + n, 0); },
    };
    hud.debugRooms(window.__rooms);
  });
  await waitSim(0.4);

  console.log('thumbnail badge');
  // npc 2 + 개인 대화 2 (친구하나 1 · 차단됨 1 — the mirror's own count) + 단체방 1 + 방 초대 1 + 친구 요청 1
  await waitFor(page, () => window.__hud().messengerUnreadBadge === 7, 'badge 7', 8000).catch(() => {});
  let th = await P(() => ({
    badge: window.__hud().messengerUnreadBadge, dot: document.querySelector('.cm-dot').textContent, hidden: document.querySelector('.cm-dot').hidden,
    tag: document.querySelector('.cm-tag').textContent, on: window.__hud().isCommunityOn,
  }));
  ok(th.on && th.tag === '메신저', 'the ship thumbnail reads 메신저', JSON.stringify(th));
  ok(th.badge === 7 && th.dot === '7' && !th.hidden, 'its badge = NPC + 개인 대화 + 단체방 unread + 방 초대 + 친구 요청', JSON.stringify(th));

  console.log('open (P)');
  await P(() => window.__tap('KeyP'));
  await waitSim(0.2);
  let op = await P(() => ({
    open: window.__hud().isCommunityOpen, tab: window.__ms().tab,
    tabs: [...document.querySelectorAll('.ms-tab')].map((b) => b.querySelector('.ms-tab-l').textContent),
    title: document.querySelector('.community-panel .cp-title').textContent,
    blocker: window.__game.ctx.uiBlockers.has('community'), ev: window.__ev['ui:messengerToggled'].map((e) => e.open),
  }));
  ok(op.open && op.blocker && op.title === '메신저', 'a P tap opens the 메신저 (COMMUNITY_BLOCKER)', JSON.stringify(op));
  ok(op.tabs.join('|') === '대화|친구|퀘스트' && op.tab === 'chat', 'three tabs 대화 · 친구 · 퀘스트, first open on 대화', JSON.stringify(op));
  ok(op.ev.at(-1) === true, 'ui:messengerToggled {open:true}', JSON.stringify(op.ev));

  console.log('대화 list');
  const rows = () => P(() => [...document.querySelectorAll('.ms-rows .ms-row')].map((r) => ({ key: r.dataset.key, unread: r.querySelector('.ms-unread')?.textContent ?? '' })));
  let list = await rows();
  ok(list.map((r) => r.key).join('|') === 'npc:npc_han_seojin|room:r1|pc:CDEF2345|npc:npc_raven|room:r2|pc:GHJK6789|pc:LMNP2345',
    'NPC · 단체방 · 개인 대화 mixed by recency (friends without history last, blocked player absent)', JSON.stringify(list.map((r) => r.key)));
  ok(list[0].unread === '2' && list[1].unread === '1', 'unread badges on the rows', JSON.stringify(list.slice(0, 3)));
  ok(await P(() => !document.querySelector('.ms-invites').hidden && !!document.querySelector('.ms-inv-row[data-room="r3"]')), 'a pending room invite sits above the list');
  await click('.ms-filter[data-filter="room"]');
  list = await rows();
  ok(list.map((r) => r.key).join('|') === 'room:r1|room:r2', 'the 단체방 filter keeps only rooms', JSON.stringify(list));
  await click('.ms-filter[data-filter="all"]');

  console.log('NPC conversation');
  await click('.ms-row[data-key="npc:npc_han_seojin"]');
  await waitSim(0.2);
  let npcView = await P(() => {
    const t = document.querySelector('.ms-thread');
    return {
      title: t.querySelector('.ms-thead-title')?.textContent, sub: t.querySelector('.ms-thead-sub')?.textContent,
      bubbles: [...t.querySelectorAll('.ms-tbody .ms-msg:not(.quest):not(.sys) .ms-bubble')].map((b) => b.textContent),
      cards: [...t.querySelectorAll('.ms-qcard')].map((c) => ({ id: c.dataset.quest, acts: [...c.querySelectorAll('.ms-qfoot [data-act]')].map((b) => b.dataset.act), state: c.querySelector('.ms-qstate').textContent, chips: c.querySelectorAll('.ms-qchips .item-chip').length })),
      input: document.querySelector('.ms-input-row').hidden, note: t.querySelector('.ms-note')?.textContent ?? null,
      bio: t.querySelector('.ms-thead-bio')?.textContent ?? null,
      ring: t.querySelectorAll('.ms-thead .ms-avwrap').length, lv: t.querySelector('.ms-thead .ms-avlv')?.textContent ?? null,
      trustRight: t.querySelectorAll('.ms-thead .ms-trust.in-right').length,
    };
  });
  ok(npcView.title === '한서진' && npcView.sub.includes('헬릭스'), 'the head names the NPC, title and corp', JSON.stringify(npcView));
  ok(npcView.bubbles.length === 4, 'NPC and my bubbles are drawn', JSON.stringify(npcView.bubbles));
  const offerCard = npcView.cards.find((c) => c.id === 'q_offer');
  // 2026-09-14 3차 (사용자 결정): 「생각해보지」 버튼이 없어졌다 — 카드에는 [수락] 하나뿐이다.
  ok(offerCard && offerCard.acts.join('|') === 'accept' && offerCard.chips === 4, 'the offered quest card carries 수락 only (생각해보지 retired) and its reward chips', JSON.stringify(npcView.cards));
  ok(npcView.cards.find((c) => c.id === 'q_ready')?.acts.join('|') === 'tab', 'an accepted quest card only links to the 퀘스트 tab', JSON.stringify(npcView.cards));
  // 2026-09-14 3차: 하단 안내(NPC 에게는 퀘스트 카드로 답합니다)와 머리의 bio 한 줄이 빠졌다
  ok(npcView.input && !npcView.note && npcView.bio === null, 'no input box, no 퀘스트 카드 note, no bio line', JSON.stringify(npcView));
  // 2026-09-14 3차: 초상 테두리 radial + 우하단 레벨 배지, 신뢰도 현황은 머리줄 중앙 우측
  ok(npcView.ring === 1 && npcView.lv !== null && npcView.trustRight === 1, 'the head portrait carries the trust radial + level badge, gauge moved centre-right', JSON.stringify(npcView));
  ok(await hasCall('npc.markRead:npc_han_seojin'), 'opening the conversation marks it read', JSON.stringify(await calls()));
  await waitFor(page, () => window.__hud().messengerUnreadBadge === 5, 'badge 5', 3000).catch(() => {});
  ok(await P(() => window.__hud().messengerUnreadBadge) === 5, 'and the thumbnail badge drops by 2', String(await P(() => window.__hud().messengerUnreadBadge)));
  ok(await P(() => window.__npc.defer('q_offer')) === false, 'defer() 는 은퇴했다 — 늘 false');

  console.log('개인 대화');
  await click('.ms-row[data-key="pc:CDEF2345"]');
  await waitSim(0.2);
  let pc = await P(() => ({
    msgs: [...document.querySelectorAll('.ms-tbody .ms-msg:not(.sys)')].map((m) => m.classList.contains('out') ? 'out' : 'in'),
    input: !document.querySelector('.ms-input-row').hidden, disabled: document.querySelector('.ms-input').disabled,
    ph: document.querySelector('.ms-input').placeholder,
  }));
  ok(pc.msgs.join(',') === 'in,out' && pc.input && !pc.disabled && pc.ph.includes('개인 대화'), 'the 개인 대화 conversation with its input', JSON.stringify(pc));
  ok((await socialLog()).includes('markWhisperRead:CDEF2345'), 'viewing it calls markWhisperRead');
  await type('.ms-input', '메신저에서 보냄');
  await waitSim(0.1);
  ok((await socialLog()).includes('whisper:CDEF2345,메신저에서 보냄'), 'Enter sends through social.whisper', JSON.stringify((await socialLog()).slice(-3)));
  await P(() => { const i = document.querySelector('.ms-input'); i.focus(); window.__key('KeyP', 'keydown', i); window.__key('KeyP', 'keyup', i); });
  await waitSim(0.2);
  ok(await P(() => window.__hud().isCommunityOpen), 'typing p in the field does not close the panel');

  console.log('단체방');
  await click('.ms-row[data-key="room:r1"]');
  await waitSim(0.3);
  await waitFor(page, () => [...document.querySelectorAll('.ms-tbody .ms-bubble')].some((b) => b.textContent === '예전 대화'), 'older page', 6000).catch(() => {});
  let room = await P(() => {
    const t = document.querySelector('.ms-thread');
    return {
      title: t.querySelector('.ms-thead-title').textContent,
      acts: [...t.querySelectorAll('.ms-thead-acts [data-act]')].map((b) => b.dataset.act),
      sys: [...t.querySelectorAll('.ms-tbody .ms-msg.sys')].map((s) => s.textContent),
      texts: [...t.querySelectorAll('.ms-tbody .ms-bubble')].map((b) => b.textContent),
    };
  });
  const rc = await calls();
  ok(rc.includes('rooms.requestHistory:r1,latest'), 'opening a room asks for its latest page', JSON.stringify(rc));
  ok(rc.includes('rooms.requestHistory:r1,before') && room.texts[0] === '예전 대화', 'a page too short to scroll pulls the older page on its own', JSON.stringify({ rc, texts: room.texts }));
  ok(room.sys.includes('나 님이 방을 만들었습니다'), 'system lines read as sentences', JSON.stringify(room.sys));
  ok(room.texts.includes('어서와') && !room.texts.includes('차단된 사람의 말'), 'a blocked member\'s line is hidden', JSON.stringify(room.texts));
  ok(room.acts.join('|') === 'members|invite|rename|leave', 'the owner gets 멤버 / 초대 / 이름 변경 / 나가기', JSON.stringify(room.acts));
  ok(rc.includes('rooms.markRead:r1'), 'viewing the room marks it read');
  await type('.ms-input', '단체방 메시지');
  await waitSim(0.15);
  let said = await P(() => { const m = [...document.querySelectorAll('.ms-tbody .ms-msg.out')].at(-1); return { txt: m?.querySelector('.ms-bubble').textContent, cls: m?.className, st: m?.querySelector('.ms-state')?.textContent }; });
  ok(await hasCall('rooms.say:r1,단체방 메시지') && /pending/.test(said.cls) && said.st === '전송 중…', 'Enter → rooms.say, the line shows pending', JSON.stringify(said));
  await click('.ms-thead-acts [data-act="members"]');
  await waitSim(0.15);
  let mem = await P(() => ({ rows: document.querySelectorAll('.ms-members .ms-member').length, kicks: document.querySelectorAll('.ms-members [data-act="kick"]').length, hidden: document.querySelector('.ms-members').hidden }));
  ok(!mem.hidden && mem.rows === 4 && mem.kicks === 3, 'the members drawer lists everyone, 내보내기 for the others', JSON.stringify(mem));
  await click('.ms-thead-acts [data-act="invite"]');
  await waitSim(0.1);
  let inv = await P(() => ({ kind: window.__ms().chat.popover.kind, picks: [...document.querySelectorAll('.ms-pop .ms-pick')].map((p) => p.dataset.code) }));
  ok(inv.kind === 'invite' && inv.picks.join('|') === 'GHJK6789', 'the invite picker offers friends who are not in the room', JSON.stringify(inv));
  await click('.ms-pop .ms-pick[data-code="GHJK6789"]');
  ok(await hasCall('rooms.invite:r1,GHJK6789'), 'picking a friend → rooms.invite');
  await P(() => window.__tap('Escape'));
  await waitSim(0.1);
  ok(await P(() => !window.__ms().chat.popover.isOpen && window.__hud().isCommunityOpen), 'Escape closes the popover only');
  await click('.ms-thead-acts [data-act="rename"]');
  await waitSim(0.1);
  ok(await P(() => document.querySelector('.ms-pop .ms-pop-input')?.value) === '원정대방', 'rename starts from the current name');
  await type('.ms-pop .ms-pop-input', '새 원정대');
  await waitSim(0.15);
  ok(await hasCall('rooms.rename:r1,새 원정대') && await P(() => document.querySelector('.ms-thead-title').textContent) === '새 원정대', 'Enter → rooms.rename and the head follows');
  await click('.ms-thead-acts [data-act="members"]');   // drawer was closed by the re-render? make sure it is open
  await waitSim(0.1);
  if (!(await P(() => !document.querySelector('.ms-members').hidden))) { await click('.ms-thead-acts [data-act="members"]'); await waitSim(0.1); }
  await click('.ms-members .ms-member[data-code="CDEF2345"] [data-act="kick"]');
  await waitSim(0.1);
  ok(await P(() => !!document.querySelector('.sh-ask[data-ask="room-kick"]')), '내보내기 asks first');
  await click('.sh-ask[data-ask="room-kick"] .sh-ask-btn.danger');
  await waitSim(0.2);
  ok(await hasCall('rooms.kick:r1,CDEF2345'), '확인 → rooms.kick');
  ok(await P(() => [...document.querySelectorAll('.ms-tbody .ms-msg.sys')].some((s) => s.textContent === '나 님이 친구하나 님을 내보냈습니다')), 'the kick line reads as a sentence');
  await click('.ms-thead-acts [data-act="leave"]');
  await waitSim(0.1);
  ok(await P(() => !!document.querySelector('.sh-ask[data-ask="room-leave"]')), '나가기 asks with a hold popup');
  await click('.sh-ask[data-ask="room-leave"] .sh-ask-btn.danger');
  await waitSim(0.2);
  ok(!(await hasCall('rooms.leave:r1')), 'a click does not leave (1초 홀드)');
  await P(() => document.querySelector('.sh-ask[data-ask="room-leave"] .sh-ask-btn.danger').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 })));
  await sleep(1400);
  await P(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 })));
  await waitSim(0.2);
  ok(await hasCall('rooms.leave:r1') && await P(() => window.__ms().chat.selectedKey) === null, 'holding 나가기 → rooms.leave and the conversation closes', JSON.stringify(await calls()));

  console.log('방 초대 · 방 만들기');
  await click('.ms-inv-row[data-room="r3"] [data-act="accept"]');
  await waitSim(0.15);
  ok(await hasCall('rooms.respond:r3,true') && await P(() => document.querySelector('.ms-invites').hidden), '수락 → rooms.respond(r3, true), the invite leaves');
  await click('[data-act="create-room"]');
  await waitSim(0.1);
  await P(() => { document.querySelector('.ms-pop .ms-pop-input').value = '테스트방'; });
  await click('.ms-pop .ms-pick[data-code="CDEF2345"]');
  await click('.ms-pop [data-act="create"]');
  await waitSim(0.15);
  ok(await hasCall('rooms.create:테스트방,CDEF2345') && await P(() => !window.__ms().chat.popover.isOpen), '만들기 → rooms.create(name, picked friends)', JSON.stringify((await calls()).slice(-3)));

  console.log('친구 tab');
  await click('.ms-tab[data-tab="friends"]');
  await waitSim(0.2);
  let fr = await P(() => ({ tab: window.__ms().tab, col: !!document.querySelector('.ms-page.friends:not([hidden]) .social-col'), cards: document.querySelectorAll('.ms-page.friends .sc-section.friends .sc-card').length }));
  ok(fr.tab === 'friends' && fr.col && fr.cards === 3, 'the 친구 tab hosts the social column', JSON.stringify(fr));
  await P(() => document.querySelector('.ms-page.friends .sc-section.friends .sc-card').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 400 })));
  let menu = await P(() => [...document.querySelectorAll('.sc-menu:not([hidden]) .sc-mi')].map((b) => `${b.dataset.act}:${b.querySelector('.l').textContent}`));
  // 2026-09-15 (분대 · 도킹 매칭): 같이 하기 → 분대 초대 (invite only)
  ok(menu.join('|') === 'play:분대 초대|whisper:개인 대화|remove:친구 삭제|block:차단', 'the card menu: 분대 초대 / 개인 대화 / 친구 삭제 / 차단', JSON.stringify(menu));
  await click('.sc-menu:not([hidden]) .sc-mi[data-act="whisper"]');
  await waitSim(0.2);
  ok(await P(() => window.__ms().tab === 'chat' && window.__ms().chat.selectedKey === 'pc:CDEF2345'), '개인 대화 → the 대화 tab on that friend');

  console.log('퀘스트 tab');
  await click('.ms-tab[data-tab="quests"]');
  await waitSim(0.2);
  let qt = await P(() => ({
    groups: [...document.querySelectorAll('.ms-qgroup-head')].map((g) => `${g.dataset.group}:${g.textContent.replace(/[▸▾]/g, '').trim()}`),
    rows: [...document.querySelectorAll('.ms-qrow')].map((r) => r.dataset.quest), sel: window.__ms().quests.selectedId,
    badge: document.querySelector('.ms-tab[data-tab="quests"] .ms-badge')?.textContent,
  }));
  // 2026-09-14 3차 (사용자 결정): 목록에는 **받은 것만** — 제안(offered) 은 대화창 카드에만 있다.
  ok(qt.groups.join('|') === 'active:진행 중 2|complete:완료 1', 'groups 진행 중 · 완료 (제안 · 보류 그룹 없음)', JSON.stringify(qt));
  ok(qt.rows.join('|') === 'q_ready|q_active' && qt.sel === 'q_ready', '보고 가능 first, 완료 collapsed, the first active one selected', JSON.stringify(qt));
  ok(!qt.rows.includes('q_offer') && !qt.rows.includes('q_def'), '제안 받은 퀘스트는 퀘스트 탭에 뜨지 않는다', JSON.stringify(qt.rows));
  let det = await P(() => { const b = document.querySelector('.ms-qdetail [data-act="report"]'); return { disabled: b?.disabled, head: document.querySelector('.ms-qdetail-head .ms-thead-title')?.textContent }; });
  ok(det.disabled === false && det.head === '한서진', 'a ready quest has an enabled 완료 보고 under its NPC head', JSON.stringify(det));
  await click('.ms-qdetail [data-act="report"]');
  await waitSim(0.2);
  ok(await hasCall('npc.report:q_ready'), '완료 보고 → npc.report');
  await click('.ms-qrow[data-quest="q_active"]');
  await waitSim(0.15);
  det = await P(() => {
    const d = document.querySelector('.ms-qdetail');
    return {
      report: d.querySelector('[data-act="report"]')?.disabled, why: d.querySelector('.ms-qwhy')?.textContent ?? '',
      deliver: d.querySelectorAll('[data-act="deliver"]').length, have: d.querySelector('.ms-qhave')?.textContent, abandon: d.querySelectorAll('[data-act="abandon"]').length,
      nums: [...d.querySelectorAll('.ms-qonum')].map((n) => n.textContent),
    };
  });
  ok(det.report === true && det.why.includes('목표') && det.deliver === 1 && det.have === '보유 3' && det.abandon === 0, 'not ready: 완료 보고 disabled with its reason, one 납품 with 보유, no 포기', JSON.stringify(det));
  ok(det.nums.join('|') === '1 / 2|1 / 1', 'objective progress p / t', JSON.stringify(det.nums));
  await click('.ms-qdetail [data-act="deliver"]');
  await waitSim(0.2);
  det = await P(() => ({ report: document.querySelector('.ms-qdetail [data-act="report"]')?.disabled, deliver: document.querySelectorAll('.ms-qdetail [data-act="deliver"]').length }));
  ok(await hasCall('npc.deliver:q_active,0') && det.report === false && det.deliver === 0, '납품 → npc.deliver, the objective fills and 완료 보고 wakes', JSON.stringify(det));
  /* ── 제안 수락은 **대화창 카드**로만 (2026-09-14 3차) + 타이핑 연출 ────────── */
  await click('.ms-tab[data-tab="chat"]');
  await waitSim(0.2);
  await click('.ms-row[data-key="npc:npc_raven"]');
  await waitSim(0.3);
  await click('.ms-qcard[data-quest="q_def"] [data-act="accept"]');
  await waitSim(0.2);
  ok(await hasCall('npc.accept:q_def'), '대화창 카드의 수락 → npc.accept');
  // 새 NPC 말풍선은 `...` 를 거쳐 나타난다 (최대 2초) — 글자가 붙을 때까지 기다린다
  await waitFor(page, () => [...document.querySelectorAll('.ms-tbody .ms-msg.in .ms-bubble')].at(-1)?.textContent === '좋아요, 짧게 설명하죠.', 'typing bubble resolves', 8000).catch(() => {});
  const acc = await P(() => ({
    mine: [...document.querySelectorAll('.ms-tbody .ms-msg.out .ms-bubble')].at(-1)?.textContent,
    last: [...document.querySelectorAll('.ms-tbody .ms-msg.in .ms-bubble')].at(-1)?.textContent,
    typing: document.querySelectorAll('.ms-bubble.ms-typing').length,
    acts: [...document.querySelectorAll('.ms-qcard[data-quest="q_def"] [data-act]')].map((b) => b.dataset.act),
  }));
  ok(acc.mine === '맡겠습니다.' && acc.acts.join('|') === 'tab', '수락하면 내 대답이 붙고 카드가 퀘스트 탭 링크로 바뀐다', JSON.stringify(acc));
  ok(acc.last === '좋아요, 짧게 설명하죠.' && acc.typing === 0, '새 NPC 말풍선은 타이핑 연출 뒤에 나타난다', JSON.stringify(acc));
  await click('.ms-tab[data-tab="quests"]');
  await waitSim(0.25);
  const afterRows = await P(() => [...document.querySelectorAll('.ms-qrow')].map((r) => r.dataset.quest));
  ok(afterRows.includes('q_def'), '수락한 뒤에야 퀘스트 탭 목록에 들어온다', JSON.stringify(afterRows));

  console.log('screenshots');
  for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    await page.setViewport({ width: w, height: h });
    await waitSim(0.3);
    const fit = await P(() => { const r = document.querySelector('.community-panel .cp-frame').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: window.innerWidth, h: window.innerHeight }; });
    ok(fit.l >= 0 && fit.t >= 0 && fit.r <= fit.w && fit.b <= fit.h, `the frame fits ${w}×${h}`, JSON.stringify(fit));
    await P(() => { window.__ms().openTarget({ npc: 'npc_han_seojin' }); });
    await waitSim(0.25);
    await page.screenshot({ path: join(SHOT_DIR, `messenger-chat-npc-${w}x${h}.png`) });
    await P(() => { window.__ms().openTarget({ code: 'CDEF2345' }); });
    await waitSim(0.25);
    await page.screenshot({ path: join(SHOT_DIR, `messenger-chat-pc-${w}x${h}.png`) });
    await P(() => { window.__ms().openTarget({ room: 'r2' }); });
    await waitSim(0.25);
    await page.screenshot({ path: join(SHOT_DIR, `messenger-chat-room-${w}x${h}.png`) });
    await P(() => window.__ms().setTab('friends'));
    await waitSim(0.25);
    await page.screenshot({ path: join(SHOT_DIR, `messenger-friends-${w}x${h}.png`) });
    await P(() => { window.__ms().setTab('quests'); window.__ms().quests.select('q_active'); });
    await waitSim(0.25);
    await page.screenshot({ path: join(SHOT_DIR, `messenger-quests-${w}x${h}.png`) });
    const over = await P(() => {
      const bad = [];
      for (const s of ['.ms-qdetail', '.ms-qlist']) { const e = document.querySelector(s); if (e && e.scrollWidth > e.clientWidth + 2) bad.push(s); }
      return bad;
    });
    ok(over.length === 0, `no horizontal overflow in the 퀘스트 tab at ${w}×${h}`, JSON.stringify(over));
  }
  console.log(`  (screenshots in ${SHOT_DIR})`);
  await page.setViewport({ width: 1600, height: 900 });
  await waitSim(0.2);

  console.log('close · ui:openMessenger · dot pop');
  await P(() => window.__tap('Tab'));
  await waitSim(0.2);
  ok(await P(() => !window.__hud().isCommunityOpen && !window.__game.ctx.uiBlockers.has('community')), 'Tab closes the messenger');
  await P(() => window.__game.ctx.bus.emit('ui:openMessenger', { tab: 'quests' }));
  await waitSim(0.15);
  ok(await P(() => window.__hud().isCommunityOpen && window.__ms().tab === 'quests'), 'ui:openMessenger {tab} opens onto that tab');
  await P(() => window.__tap('Escape'));
  await waitSim(0.2);
  ok(await P(() => !window.__hud().isCommunityOpen), 'Escape closes it');
  await P(() => window.__game.ctx.bus.emit('npc:message', { npc: 'npc_han_seojin', entry: { at: Date.now(), e: 'intro' } }));
  await waitSim(0.2);
  // 2026-09-16 (사용자 결정): 새 NPC 메시지는 토스트가 아니라 버튼의 빨간 점이 튀어오른다 (무슨 메시지인지는 열어야 안다)
  const popped = await P(() => ({ toasts: window.__notifs(), dotHidden: document.querySelector('.cm-dot').hidden, transform: document.querySelector('.cm-dot').style.transform }));
  ok(!popped.toasts.some((t) => t.startsWith('✉')), 'a new NPC message no longer toasts', JSON.stringify(popped.toasts));
  ok(popped.dotHidden || popped.transform !== '', 'the red dot pops instead (when there is an unread badge)', JSON.stringify(popped));
  await P(() => window.__tap('KeyP'));
  await waitSim(0.2);
  const n0 = (await P(() => window.__notifs())).filter((t) => t.startsWith('✉')).length;
  await P(() => window.__game.ctx.bus.emit('npc:message', { npc: 'npc_raven', entry: { at: Date.now(), e: 'offer', q: 'q_none' } }));
  await waitSim(0.2);
  ok((await P(() => window.__notifs())).filter((t) => t.startsWith('✉')).length === n0, 'and nothing toasts while it is open either');
  await P(() => window.__tap('KeyP'));
  await waitSim(0.2);

  console.log('real refs');
  await P(() => { const h = window.__hud(); h.debugNpc(null); h.debugRooms(null); h.debugSocial(null); });
  const real = await P(() => ({ npc: !!window.__game.ctx.meta?.npc, rooms: !!window.__game.ctx.net?.rooms }));
  console.log(`  (ctx.meta.npc ${real.npc ? 'present' : 'absent'} · ctx.net.rooms ${real.rooms ? 'present' : 'absent'})`);
  await P(() => window.__tap('KeyP'));
  await waitSim(0.3);
  const realView = await P(() => {
    window.__ms().setTab('chat');
    const rowsN = document.querySelectorAll('.ms-rows .ms-row').length;
    window.__ms().setTab('quests');
    return { open: window.__hud().isCommunityOpen, rowsN, qRows: document.querySelectorAll('.ms-qrow').length, empty: document.querySelector('.ms-qlist .ms-empty')?.textContent ?? '' };
  });
  await waitSim(0.3);
  ok(realView.open, 'the messenger opens against the real refs', JSON.stringify(realView));
  console.log(`  (real: ${realView.rowsN} conversation rows · ${realView.qRows} quest rows ${realView.empty ? `· "${realView.empty}"` : ''})`);
  await P(() => window.__tap('KeyP'));
  await waitSim(0.2);

  console.log('raid');
  await P(() => { window.__game.ctx.missionPlanet = 'amber'; window.__game.ctx.bus.emit('game:newMission', { seed: 777, planet: 'amber' }); });
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
  await waitSim(0.3);
  await P(() => window.__game.ctx.bus.emit('ui:openMessenger', { tab: 'chat' }));
  await waitSim(0.2);
  ok(await P(() => !window.__hud().isCommunityOpen && !document.querySelector('.community').classList.contains('show')), 'ship only: no thumbnail and ui:openMessenger is ignored in a raid');

  const realErrors = errors.filter((e) => !/\/ws\b|WebSocket|websocket/i.test(e));
  ok(realErrors.length === 0, 'no console / page errors', JSON.stringify(realErrors.slice(0, 3)));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${e.message}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);   // the tally format `scripts/verify.mjs` parses
process.exit(fail === 0 ? 0 : 1);
