// 2026-09-14 단체 메신저방 · 개인 대화 읽지 않음 smoke (src/net — docs/plans/messenger-quests.md §4).
//
// No relay: the script builds fresh `RoomSync` / `SocialSync` instances from the running game's constructors, wires a
// recording `send` and a recording bus, and feeds them relay frames by hand (same pattern as smoke-social's
// `__mkSync`). It checks the client half of the contract — `ctx.net.rooms` wiring, sanitising, sort order, invite
// announcements, pending → ack, history merge, unread counts + read markers under the slot key, disconnect — and the
// `SocialSync` unread additions (`whisperUnread` · `markWhisperRead` · `whisperUnreadTotal` · `social:unreadChanged`).
// The relay half (permissions, persistence, GC) is `server/selftest.ts` part 14.
//
// Usage: node scripts/smoke-rooms.mjs [http://localhost:5273/]
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
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--window-size=1280,800', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.getSystem('net'), 'boot');
  const P = (fn, arg) => page.evaluate(fn, arg);

  await P(() => {
    localStorage.removeItem('scav.s1.roomRead');
    localStorage.removeItem('scav.s1.whispers');
    const net = window.__game.getSystem('net');
    window.__R = {
      ME: { code: 'AB3D9KMN', name: '나', level: 3 },
      FRIEND: 'CDEF2345', OTHER: 'GHJK6789', BLOCKED: 'LMNP2345',
      R1: 'room1AAAAAAA', R2: 'room2BBBBBBB', R3: 'room3CCCCCCC',
    };
    window.__mkBus = () => {
      const ev = [];
      return { ev, emit: (n, p) => ev.push([n, JSON.parse(JSON.stringify(p ?? {}))]), count: (n) => ev.filter((e) => e[0] === n).length, last: (n) => ev.filter((e) => e[0] === n).at(-1)?.[1] ?? null };
    };
    window.__mkRooms = () => {
      const s = new (net.roomSync.constructor)();
      const bus = window.__mkBus();
      const sent = [];
      s.bus = bus;
      s.send = (m) => { sent.push(JSON.parse(JSON.stringify(m))); return true; };
      s.me = () => window.__R.ME;
      s.isBlocked = (c) => c === window.__R.BLOCKED;
      s.serverNow = () => Date.now();
      return { s, bus, sent };
    };
    const { R1, R2, ME, FRIEND, OTHER, BLOCKED } = window.__R;
    const member = (code, name, presence = 'ship') => ({ code, name, level: 1, presence });
    window.__state = (opts = {}) => ({
      t: 'room:state',
      rooms: {
        rooms: [
          { id: R1, name: '원정대', owner: ME.code, members: [member(ME.code, '나'), member(FRIEND, '친구'), member(BLOCKED, '차단한사람', 'offline')], pending: [{ code: OTHER, name: '초대받음', level: 2 }], createdAt: 1000, lastAt: 2000, lastText: '안녕', lastCode: FRIEND },
          ...(opts.dropR2 ? [] : [{ id: R2, name: '<b>둘째</b>방', owner: FRIEND, members: [member(FRIEND, '친구'), member(ME.code, '나')], pending: [], createdAt: 1500, lastAt: 5000, lastText: 'x', lastCode: ME.code }]),
          { id: 'bad id!', name: 'x', owner: ME.code, members: [], pending: [], createdAt: 1, lastAt: 1 },
        ],
        invites: [
          { room: 'room9ZZZZZZZ', name: '초대방', from: FRIEND, fromName: '친구', members: 3, at: 7000 },
          { room: 'room8YYYYYYY', name: '차단방', from: BLOCKED, fromName: '차단', members: 2, at: 7100 },
        ],
      },
    });
  });

  console.log('ctx.net.rooms wiring');
  const wired = await P(() => {
    const net = window.__game.getSystem('net');
    return { same: window.__game.ctx.net.rooms === net.roomSync, available: net.roomSync.available, total: net.roomSync.unreadTotal, social: typeof net.socialSync.whisperUnread };
  });
  ok(wired.same && wired.available === false && wired.total === 0 && wired.social === 'function', 'ctx.net.rooms is the RoomSync, unavailable offline, SocialSync has whisperUnread', JSON.stringify(wired));

  console.log('unavailable');
  let r = await P(() => {
    const { s, sent } = window.__mkRooms();
    const res = { create: s.create('방'), say: s.say(window.__R.R1, 'hi'), hist: (s.requestHistory(window.__R.R1), 0) };
    return { ...res, sent: sent.length, rooms: s.rooms.length };
  });
  ok(r.create === false && r.say === false && r.sent === 0 && r.rooms === 0, 'before a room:state nothing is sent (create / say false)', JSON.stringify(r));

  console.log('room:state');
  r = await P(() => {
    const t = window.__mkRooms();
    window.__T = t;
    t.s.onState(window.__state());
    return {
      available: t.s.available, ids: t.s.rooms.map((x) => x.id), r2name: t.s.find(window.__R.R2)?.name,
      invites: t.s.invites.map((i) => i.room), updated: t.bus.last('room:updated'), invited: t.bus.count('room:invited'),
      unread: [t.s.unread(window.__R.R1), t.s.unread(window.__R.R2)], stored: JSON.parse(localStorage.getItem('scav.s1.roomRead') ?? 'null'),
    };
  });
  ok(r.available && same(r.ids, ['room2BBBBBBB', 'room1AAAAAAA']), 'rooms sanitized (bad id dropped) and sorted by last line, newest first', JSON.stringify(r.ids));
  ok(r.r2name === 'b둘째/b방', 'room names lose markup', r.r2name);
  ok(same(r.invites, ['room9ZZZZZZZ']) && r.invited === 1, 'an invite from a blocked player is hidden; the other is announced once (room:invited)', JSON.stringify(r));
  ok(r.updated?.first === true, 'room:updated {first:true} on the first snapshot', JSON.stringify(r.updated));
  ok(same(r.unread, [0, 0]) && r.stored?.v === 1 && r.stored.rooms.room1AAAAAAA === 2000 && r.stored.rooms.room2BBBBBBB === 5000,
    'rooms seen for the first time start read up to their last line (scav.s1.roomRead)', JSON.stringify(r));
  r = await P(() => { window.__T.s.onState(window.__state()); return { invited: window.__T.bus.count('room:invited'), first: window.__T.bus.last('room:updated').first }; });
  ok(r.invited === 1 && r.first === false, 'the same snapshot again announces nothing new (first:false)', JSON.stringify(r));

  console.log('room:line · unread');
  r = await P(() => {
    const { s, bus } = window.__T;
    const { R1, FRIEND, BLOCKED, ME } = window.__R;
    s.onLine({ line: { room: R1, code: FRIEND, name: '친구', text: '새 소식', at: 6000 } });
    const a = { unread: s.unread(R1), total: s.unreadTotal, first: s.rooms[0].id, last: s.find(R1).lastText, ev: bus.last('room:unreadChanged'), line: bus.last('room:line')?.line?.text };
    s.onLine({ line: { room: R1, code: BLOCKED, name: '차단', text: '안 셈', at: 6100 } });
    s.onLine({ line: { room: R1, code: ME.code, name: '나', text: '다른 창에서 보냄', at: 6200 } });
    s.onLine({ line: { room: R1, code: FRIEND, name: '친구', text: '', at: 6300, system: 'join', target: FRIEND, targetName: '친구' } });
    s.onLine({ line: { room: R1, code: FRIEND, name: '친구', text: '새 소식', at: 6000 } });   // duplicate
    s.onLine({ line: { room: 'nope', code: FRIEND, text: 'x', at: 1 } });
    return { a, unread: s.unread(R1), cache: s.history(R1).length, lastSystem: s.find(R1).lastSystem, lastText: s.find(R1).lastText };
  });
  ok(r.a.unread === 1 && r.a.total === 1 && r.a.ev?.total === 1 && r.a.line === '새 소식', 'a friend\'s line → unread 1 + room:unreadChanged {total:1} + room:line', JSON.stringify(r.a));
  ok(r.a.first === 'room1AAAAAAA' && r.a.last === '새 소식', 'the room moves to the top with the new preview', JSON.stringify(r.a));
  ok(r.unread === 1 && r.cache === 4, 'blocked authors, my own lines and system lines never count; duplicates / bad frames are dropped', JSON.stringify(r));
  ok(r.lastSystem === 'join' && r.lastText === '친구 님이 들어왔습니다', 'a system line previews as its Korean sentence', JSON.stringify(r));
  r = await P(() => {
    const { s, bus } = window.__T;
    s.markRead(window.__R.R1);
    const fresh = window.__mkRooms();
    fresh.s.onState(window.__state());
    return { unread: s.unread(window.__R.R1), ev: bus.last('room:unreadChanged'), freshUnread: fresh.s.unreadTotal, stored: JSON.parse(localStorage.getItem('scav.s1.roomRead')).rooms.room1AAAAAAA };
  });
  ok(r.unread === 0 && r.ev?.total === 0 && r.stored === 6300 && r.freshUnread === 0, 'markRead → 0 (persisted up to the newest line; a fresh mirror reads it back)', JSON.stringify(r));
  r = await P(() => {
    const t = window.__mkRooms();
    localStorage.setItem('scav.s1.roomRead', JSON.stringify({ v: 1, rooms: { room1AAAAAAA: 1000, room2BBBBBBB: 5000 } }));
    t.s.onState(window.__state());
    return [t.s.unread(window.__R.R1), t.s.unread(window.__R.R2)];
  });
  ok(same(r, [1, 0]), 'with no cached lines, a newer last line by someone else counts as one (my own last line does not)', JSON.stringify(r));
  await P(() => localStorage.setItem('scav.s1.roomRead', JSON.stringify({ v: 1, rooms: { room1AAAAAAA: 6300, room2BBBBBBB: 5000 } })));

  console.log('say · ack');
  r = await P(() => {
    const { s, bus, sent } = window.__T;
    const { R1 } = window.__R;
    const okSay = s.say(R1, '  <i>반가워</i>  ');
    const frame = sent.at(-1);
    const pendingLine = s.history(R1).at(-1);
    const ev = bus.last('room:line').line;
    s.onAck({ t: 'room:ack', nonce: frame.nonce, ok: true, room: R1, at: 9000 });
    const settled = s.history(R1).at(-1);
    s.say(R1, '막힌 줄');
    const f2 = sent.at(-1);
    s.onAck({ t: 'room:ack', nonce: f2.nonce, ok: false, code: 'limit' });
    const failed = s.history(R1).at(-1);
    return {
      okSay, frame, pending: { state: pendingLine.state, text: pendingLine.text, code: pendingLine.code }, ev: ev.state,
      settled: { state: settled.state, at: settled.at }, updated: bus.last('room:lineUpdated').line.state,
      failed: { state: failed.state, failCode: failed.failCode }, empty: s.say(R1, '   '), unknown: s.say('roomXXXXXXXX', 'x'), unread: s.unread(R1),
    };
  });
  ok(r.okSay && r.frame.t === 'room:say' && r.frame.text === 'i반가워/i' && typeof r.frame.nonce === 'number', 'say → room:say {text sanitized, nonce}', JSON.stringify(r.frame));
  ok(r.pending.state === 'pending' && r.pending.code === 'AB3D9KMN' && r.ev === 'pending', 'the line is cached at once as pending (room:line)', JSON.stringify(r));
  ok(r.settled.state === 'sent' && r.settled.at === 9000 && r.updated === 'failed' && r.failed.state === 'failed' && r.failed.failCode === 'limit',
    'room:ack ok → sent at the relay time; ok:false → failed with its code (room:lineUpdated)', JSON.stringify(r));
  ok(r.empty === false && r.unknown === false && r.unread === 0, 'an empty line / an unknown room is not sent; my own lines leave the room read', JSON.stringify(r));

  console.log('history');
  r = await P(() => {
    const { s, bus, sent } = window.__T;
    const { R1, FRIEND } = window.__R;
    s.requestHistory(R1, 6000);
    const frame = sent.at(-1);
    const before = s.hasMore(R1);
    s.onHistory({ t: 'room:history', room: R1, more: false, lines: [
      { room: R1, code: FRIEND, name: '친구', text: '', at: 1000, system: 'create' },
      { room: R1, code: FRIEND, name: '친구', text: '안녕', at: 2000 },
      { room: R1, code: FRIEND, name: '친구', text: '새 소식', at: 6000 },
      { room: 'room2BBBBBBB', code: FRIEND, name: '친구', text: '다른 방', at: 2500 },
    ] });
    const hist = s.history(R1).map((l) => l.at);
    return { frame, before, after: s.hasMore(R1), hist, ev: bus.last('room:history') };
  });
  ok(same(r.frame, { t: 'room:history', room: 'room1AAAAAAA', before: 6000 }) && r.before === true, 'requestHistory → room:history {room, before}; hasMore is true until a page says otherwise', JSON.stringify(r));
  ok(same(r.hist, [1000, 2000, 6000, 6100, 6200, 6300, 9000, r.hist.at(-1)]) && r.after === false && r.ev?.room === 'room1AAAAAAA',
    'a page merges by time, overlapping lines are deduped, foreign-room lines ignored, more:false', JSON.stringify(r));

  console.log('requests');
  r = await P(() => {
    const { s, bus, sent } = window.__T;
    const { R1, FRIEND, ME } = window.__R;
    const n0 = sent.length;
    const created = s.create('  새   방 이름  ', [FRIEND, 'nope', ME.code, FRIEND]);
    const cf = sent.at(-1);
    s.onAck({ t: 'room:ack', nonce: cf.nonce, ok: false, code: 'room_limit' });
    const err = bus.last('room:error');
    s.invite(R1, 'gh jk-6789');
    const inv = sent.at(-1);
    s.invite('roomXXXXXXXX', FRIEND);
    s.kick(R1, FRIEND);
    const kick = sent.at(-1);
    s.rename(R1, '  ');
    s.rename(R1, '바뀐 이름');
    const ren = sent.at(-1);
    s.leave(R1);
    const lv = sent.at(-1);
    const u0 = bus.count('room:updated');
    s.respond('room9ZZZZZZZ', true);
    const rep = sent.at(-1);
    s.respond('room9ZZZZZZZ', true);
    return { created, cf, err, inv, kick, ren, lv, rep, n: sent.length - n0, invites: s.invites.length, updated: bus.count('room:updated') - u0 };
  });
  ok(r.created && same({ ...r.cf, nonce: 0 }, { t: 'room:create', name: '새 방 이름', invite: ['CDEF2345'], nonce: 0 }), 'create → room:create {name squashed, invite = valid codes without me / duplicates}', JSON.stringify(r.cf));
  ok(r.err?.code === 'room_limit' && r.err.message === '더 이상 방에 들어갈 수 없습니다', 'a refused create ack → room:error with the Korean message', JSON.stringify(r.err));
  ok(same(r.inv, { t: 'room:invite', room: 'room1AAAAAAA', code: 'GHJK6789' }) && same(r.kick, { t: 'room:kick', room: 'room1AAAAAAA', code: 'CDEF2345' }), 'invite (typed code normalized) · kick frames; an unknown room sends nothing', JSON.stringify(r));
  ok(same(r.ren, { t: 'room:rename', room: 'room1AAAAAAA', name: '바뀐 이름' }) && same(r.lv, { t: 'room:leave', room: 'room1AAAAAAA' }), 'rename (blank refused locally) · leave frames', JSON.stringify(r));
  ok(same(r.rep, { t: 'room:reply', room: 'room9ZZZZZZZ', accept: true }) && r.invites === 0 && r.updated === 1 && r.n === 6, 'respond → room:reply, the invite leaves the list at once, a second answer sends nothing', JSON.stringify(r));

  console.log('rename line · kicked · malformed');
  r = await P(() => {
    const { s } = window.__T;
    const { R2, FRIEND } = window.__R;
    s.onLine({ line: { room: R2, code: FRIEND, name: '친구', text: '새<이름>', at: 12000, system: 'rename' } });
    const name = s.find(R2).name;
    s.onState({ t: 'room:state', rooms: 'garbage' });
    const stillThere = s.rooms.length;
    s.onState(window.__state({ dropR2: true }));
    return { name, stillThere, ids: s.rooms.map((x) => x.id), hist: s.history(R2).length, read: Object.keys(JSON.parse(localStorage.getItem('scav.s1.roomRead')).rooms) };
  });
  ok(r.name === '새이름', 'a rename line renames the room locally (sanitized)', r.name);
  ok(r.stillThere === 2, 'a malformed room:state is dropped whole', String(r.stillThere));
  ok(same(r.ids, ['room1AAAAAAA']) && r.hist === 0 && same(r.read, ['room1AAAAAAA']), 'a room missing from the next snapshot (kicked / left) loses its cache and read marker', JSON.stringify(r));

  console.log('disconnect');
  r = await P(() => {
    const { s, bus } = window.__T;
    s.say(window.__R.R1, '끊기기 직전');
    const u0 = bus.count('room:updated');
    s.onDisconnected();
    return { available: s.available, rooms: s.rooms.length, invites: s.invites.length, updated: bus.count('room:updated') - u0, line: bus.last('room:lineUpdated').line, total: s.unreadTotal };
  });
  ok(!r.available && r.rooms === 0 && r.invites === 0 && r.updated === 1 && r.total === 0, 'onDisconnected → unavailable, lists emptied, one room:updated', JSON.stringify(r));
  ok(r.line.state === 'failed' && r.line.failCode === 'unavailable' && r.line.text === '끊기기 직전', 'a pending line fails with unavailable', JSON.stringify(r.line));

  console.log('개인 대화 읽지 않음 (SocialSync)');
  r = await P(async () => {
    localStorage.removeItem('scav.s1.whispers');
    const net = window.__game.getSystem('net');
    const mk = () => {
      const s = new (net.socialSync.constructor)();
      const bus = window.__mkBus();
      s.bus = bus;
      s.send = () => true;
      return { s, bus };
    };
    const { s, bus } = mk();
    const snap = { me: window.__R.ME, friends: [{ code: window.__R.FRIEND, name: '친구', level: 1, presence: 'ship', squad: 0, joinable: true }], incoming: [], outgoing: [], recent: [] };
    s.onWelcome(snap);
    const F = window.__R.FRIEND;
    const now = Date.now();
    s.onWhisper({ t: 'social:whisper', code: F, name: '친구', text: '하나', at: now - 3000 });
    const a = { u: s.whisperUnread(F), total: s.whisperUnreadTotal, ev: bus.last('social:unreadChanged') };
    s.onWhisperBacklog({ lines: [{ code: 'QRST6789', name: '넷', text: '없는 동안', at: now - 9000 }] });
    const b = { total: s.whisperUnreadTotal, ev: bus.last('social:unreadChanged') };
    s.markWhisperRead(F);
    const c = { u: s.whisperUnread(F), total: s.whisperUnreadTotal, ev: bus.last('social:unreadChanged'), n: bus.count('social:unreadChanged') };
    s.markWhisperRead(F);
    const d = bus.count('social:unreadChanged');
    s.onWhisper({ t: 'social:whisper', code: 'QRST6789', name: '넷', text: '또', at: now - 1000 });
    s.whisper('QRST6789', '답장');   // my own line reads the conversation
    const e = { u: s.whisperUnread('QRST6789'), total: s.whisperUnreadTotal };
    await new Promise((res) => setTimeout(res, 0));   // SocialSync writes the 대화 기록 in a microtask
    const doc = JSON.parse(localStorage.getItem('scav.s1.whispers'));
    const fresh = mk().s;
    const f = { total: fresh.whisperUnreadTotal, readAt: doc.peers.map((p) => typeof p.readAt) };
    // a history saved before read markers existed reads as all read
    localStorage.setItem('scav.s1.whispers', JSON.stringify({ v: 1, peers: [{ code: F, name: '친구', at: now, lines: [{ name: '친구', text: '옛날', at: now, out: false }] }] }));
    const legacy = mk().s.whisperUnreadTotal;
    localStorage.removeItem('scav.s1.whispers');
    return { a, b, c, d, e, f, legacy };
  });
  ok(r.a.u === 1 && r.a.total === 1 && r.a.ev?.total === 1, 'an incoming 개인 대화 → whisperUnread 1 + social:unreadChanged {total:1}', JSON.stringify(r.a));
  ok(r.b.total === 2 && r.b.ev?.total === 2, 'a backlog line counts too (one event for the batch)', JSON.stringify(r.b));
  ok(r.c.u === 0 && r.c.total === 1 && r.c.ev?.total === 1 && r.d === r.c.n, 'markWhisperRead → that partner 0, total 1; marking again emits nothing', JSON.stringify({ c: r.c, d: r.d }));
  ok(r.e.u === 0 && r.e.total === 0, 'sending to a partner marks their lines read', JSON.stringify(r.e));
  ok(r.f.total === 0 && r.f.readAt.every((t) => t === 'number'), 'readAt is saved with the 대화 기록 and read back by a fresh mirror', JSON.stringify(r.f));
  ok(r.legacy === 0, 'an old 대화 기록 without read markers shows no unread badge', String(r.legacy));

  ok(errors.length === 0, 'no page errors / console errors', JSON.stringify(errors.slice(0, 5)));
} catch (e) {
  fail++;
  console.log(`  FAIL unexpected: ${e?.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(`\nsmoke-rooms: ${pass}/${pass + fail} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
