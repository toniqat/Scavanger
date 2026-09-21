// The mailbox (2026-09-21): `ctx.meta.mail` (meta/parts/Mail.ts), its HUD button left of the messenger's and its window
// (ui/menus/mail/MailWindow, hosted by ui/hud/Community). In the personal ship: `send` (and the dev console's `/mail send`)
// → the button's unread badge; the window opens / closes by the button, Escape and Tab and never shares the screen with
// the messenger; the list (newest first, unread dot, 첨부 mark) and the detail (subject · body · attachment tiles · 받기);
// 받기 into the stash; a full stash → `no_space`, one free cell → `partial` (the rest stays in the mail, nothing lost);
// 모두 받기; 읽은 메일 삭제 removes read **and** claimed mail only; `send` is idempotent by id, a deleted id included; and
// the mailbox survives a reload (meta document → localStorage + the relay's profile document).
// Usage: node scripts/smoke-mail.mjs [http://localhost:5273]   (needs `npm run dev` + the relay for the profile half)
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
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1280,720', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => {
    try { if (!localStorage.getItem('scav.s1.tutorial')) localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true }, raid2: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const P = (fn, arg) => page.evaluate(fn, arg);
  const boot = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.meta, 'boot');
    await P(() => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      window.__key = (code, type) => document.body.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }));
      window.__tap = (code) => { window.__key(code, 'keydown'); window.__key(code, 'keyup'); };
      window.__cm = () => window.__game.getSystem('hud').community;
      window.__mail = () => window.__game.ctx.meta.mail;
      window.__notifs = () => [...document.querySelectorAll('.notifs .notif')].map((e) => e.textContent);
      window.__stashCount = (defId) => window.__game.ctx.inventory.getStashItems().filter((i) => i.defId === defId).reduce((a, i) => a + i.qty, 0);
    });
  };
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const toShip = async () => {
    await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub', 30000);
    await waitSim(0.5);
  };
  const btn = () => P(() => {
    const b = document.querySelector('.ml-btn'); const d = b?.querySelector('.cm-dot');
    return { exists: !!b, hidden: !b || b.hidden, shown: !!document.querySelector('.community.show'), dot: d ? !d.hidden : false, num: d?.textContent ?? '', badge: window.__cm().mailBadge };
  });
  const win = () => P(() => {
    const p = document.querySelector('.ml-panel');
    const rows = [...p.querySelectorAll('.ml-row')].map((r) => ({ id: r.dataset.mailId, on: r.classList.contains('is-on'), unread: r.classList.contains('is-unread'), dot: !!r.querySelector('.ml-rdot'), clip: !!r.querySelector('.ml-rclip'), from: r.querySelector('.ml-rfrom')?.textContent ?? '', subj: r.querySelector('.ml-rsubj')?.textContent ?? '' }));
    const v = p.querySelector('.ml-view');
    return {
      open: window.__cm().isMailOpen, hidden: p.hidden, blocker: window.__game.ctx.uiBlockers.has('community'), selected: window.__cm().mailWindow.selectedId,
      count: p.querySelector('.ml-count').textContent, rows,
      subj: v.querySelector('.ml-vsubj')?.textContent ?? null, body: v.querySelector('.ml-vbody')?.textContent ?? null, from: v.querySelector('.ml-vfrom span')?.textContent ?? null,
      tiles: [...v.querySelectorAll('.ml-tile')].length, tip: [...v.querySelectorAll('.ml-tile')].every((t) => t.hasAttribute('data-item-tip') || !!t.querySelector('[data-item-tip]')),
      take: !!v.querySelector('.ml-take'), none: v.querySelector('.ml-anone')?.textContent ?? null,
      delDisabled: p.querySelector('.ml-bar .ms-btn:not(.primary)').disabled, allDisabled: p.querySelector('.ml-bar .ms-btn.primary').disabled,
      bar: [...p.querySelectorAll('.ml-bar .ms-btn')].map((b) => b.textContent),
    };
  });
  const clickBtn = () => P(() => document.querySelector('.ml-btn').click());
  const box = () => P(() => window.__mail().list().map((m) => ({ id: m.id, read: m.read, claimed: m.claimed, items: m.items.map((i) => `${i.defId}×${i.qty}`).join(','), from: m.fromName })));

  await page.goto(BASE, { waitUntil: 'load' });
  await boot();
  console.log('ship · empty mailbox');
  await toShip();
  await P(() => { try { window.__game.getSystem('meta').mailPart.reset(); } catch { /* fresh anyway */ } });
  await waitSim(0.2);
  let b = await btn();
  ok(b.exists && !b.hidden && b.shown && !b.dot, 'the mail button shows in the ship, no badge on an empty box', JSON.stringify(b));
  const pos = await P(() => { const m = document.querySelector('.ml-btn').getBoundingClientRect(); const c = [...document.querySelectorAll('.community .cm-btn')].find((e) => !e.classList.contains('ml-btn'))?.getBoundingClientRect(); return c ? { mail: m.right, msg: c.left, mt: m.top, ct: c.top } : null; });
  ok(pos && pos.mail <= pos.msg + 1 && Math.abs(pos.mt - pos.ct) < 4, 'it stands left of the messenger button', JSON.stringify(pos));

  console.log('send → badge');
  const npc = await P(() => ({ id: 'npc_park_doyun' }));
  const sent = await P((npc) => {
    const m = window.__mail();
    return [
      m.send({ id: 'smoke:a', from: npc.id, subject: '보급품 A', body: '첫 번째 소포입니다.', items: [{ defId: 'herb_bloodroot', qty: 20 }] }),
      m.send({ id: 'smoke:b', from: '시스템', subject: '공지 B', body: '첨부 없는 안내문.' }),
      m.send({ id: 'smoke:c', from: npc.id, subject: '보급품 C', body: '세 번째 소포.\n두 줄.', items: [{ defId: 'herb_ashleaf', qty: 2 }, { defId: 'herb_glowcap', qty: 1 }] }),
    ];
  }, npc);
  ok(sent.join() === 'true,true,true', 'mail.send → true for three new ids', JSON.stringify(sent));
  const cons = await P(() => { const c = window.__game.ctx.console; if (!c?.enabled) return null; const before = window.__mail().list().length; c.run('/mail send herb_frostmoss 3'); return { before, after: window.__mail().list().length, last: window.__mail().list()[0] }; });
  ok(cons && cons.after === cons.before + 1 && cons.last.id.startsWith('dev:') && cons.last.items[0]?.defId === 'herb_frostmoss' && cons.last.items[0]?.qty === 3 && cons.last.fromName === '시스템', 'console /mail send herb_frostmoss 3 delivers a dev: mail', JSON.stringify(cons));
  const devId = cons?.last.id;
  await waitSim(0.2);
  b = await btn();
  ok(b.dot && b.num === '4' && b.badge === 4, 'badge counts 4 unread', JSON.stringify(b));
  ok(await P(() => window.__cm().mailWindow && !window.__cm().isMailOpen), 'sending never opens the window (no toast either)');
  const dup = await P(() => { const m = window.__mail(); const n = m.list().length; return { again: m.send({ id: 'smoke:a', from: 'x', subject: 'dup', body: '' }), n0: n, n1: m.list().length, subj: m.list().find((x) => x.id === 'smoke:a').subject }; });
  ok(dup.again === false && dup.n0 === dup.n1 && dup.subj === '보급품 A', 'resending an existing id is a no-op (false, nothing replaced)', JSON.stringify(dup));
  let bx = await box();
  ok(bx.map((m) => m.id).join() === `${devId},smoke:c,smoke:b,smoke:a` && bx[1].from === '박도윤' && bx[2].from === '시스템', 'list() is newest first; an NPC sender resolves to its name', JSON.stringify(bx));

  console.log('window · list · detail');
  await clickBtn();
  await waitSim(0.1);
  let w = await win();
  ok(w.open && !w.hidden && w.blocker, 'button → window open, COMMUNITY blocker held', JSON.stringify({ open: w.open, hidden: w.hidden, blocker: w.blocker }));
  ok(w.selected === devId && w.rows.length === 4 && w.rows[0].on && !w.rows[0].unread, 'opens on the newest unread mail and marks it read', JSON.stringify(w.rows));
  ok(w.rows.map((r) => r.unread).join() === 'false,true,true,true' && w.rows.filter((r) => r.dot).length === 3, 'unread rows carry the dot', JSON.stringify(w.rows));
  ok(w.rows.map((r) => r.clip).join() === 'true,true,false,true', '첨부 mark only on mail with attachments', JSON.stringify(w.rows));
  ok(w.count === '4통 · 읽지 않음 3', `header count ${w.count}`);
  ok(w.bar.join() === '읽은 메일 삭제,모두 받기' && w.delDisabled && !w.allDisabled, 'bottom bar: 읽은 메일 삭제 (disabled: nothing read+claimed) · 모두 받기', JSON.stringify(w.bar));
  await waitSim(0.1);
  b = await btn();
  ok(b.num === '3', 'badge follows the read mark (3)', JSON.stringify(b));
  await P(() => document.querySelector('.ml-row[data-mail-id="smoke:c"]').click());
  w = await win();
  ok(w.selected === 'smoke:c' && w.subj === '보급품 C' && w.body === '세 번째 소포.\n두 줄.' && w.from === '박도윤', 'row click → detail subject · body · sender', JSON.stringify({ s: w.subj, b: w.body, f: w.from }));
  ok(w.tiles === 2 && w.take && w.tip, 'two attachment tiles (inventory tiles with an item tip) + 받기', JSON.stringify({ tiles: w.tiles, take: w.take, tip: w.tip }));
  await P(() => document.querySelector('.ml-row[data-mail-id="smoke:b"]').click());
  w = await win();
  ok(w.tiles === 0 && !w.take && w.none !== null, `no attachments → no tiles, no 받기 (${w.none})`, JSON.stringify(w));

  console.log('Escape · Tab · messenger exclusion');
  await P(() => window.__tap('Escape'));
  await waitSim(0.2);
  w = await win();
  ok(!w.open && w.hidden && !w.blocker, 'Escape closes the window and drops the blocker', JSON.stringify({ open: w.open, blocker: w.blocker }));
  ok(await P(() => window.__game.ctx.phase === 'hub' && !document.querySelector('.menu.pause:not(.hidden)')), 'that Escape did not also open the pause menu');
  await clickBtn();
  await waitSim(0.1);
  ok((await win()).open, 'button reopens it');
  ok((await win()).selected === 'smoke:b', 'the last selection is kept');
  await P(() => window.__tap('Tab'));
  await waitSim(0.2);
  w = await win();
  ok(!w.open && !w.blocker && !(await P(() => window.__game.ctx.inventory.isOpen)), 'Tab closes the window (and does not open the Tab screen)', JSON.stringify({ open: w.open }));
  await clickBtn();
  await waitSim(0.1);
  await P(() => window.__game.ctx.bus.emit('ui:openMessenger', { tab: 'chat' }));
  await waitSim(0.1);
  let ex = await P(() => ({ mail: window.__cm().isMailOpen, msg: window.__cm().isOpen, blocker: window.__game.ctx.uiBlockers.has('community') }));
  ok(!ex.mail && ex.msg && ex.blocker, 'opening the messenger closes the mail window', JSON.stringify(ex));
  await clickBtn();
  await waitSim(0.1);
  ex = await P(() => ({ mail: window.__cm().isMailOpen, msg: window.__cm().isOpen, blocker: window.__game.ctx.uiBlockers.has('community') }));
  ok(ex.mail && !ex.msg && ex.blocker, 'the mail button closes the messenger (never both)', JSON.stringify(ex));

  console.log('받기 · no space · partial · 모두 받기');
  let before = await P(() => ({ ash: window.__stashCount('herb_ashleaf'), glow: window.__stashCount('herb_glowcap') }));
  await P(() => document.querySelector('.ml-row[data-mail-id="smoke:c"]').click());
  await P(() => document.querySelector('.ml-take').click());
  await waitSim(0.2);
  let after = await P(() => ({ ash: window.__stashCount('herb_ashleaf'), glow: window.__stashCount('herb_glowcap') }));
  let mc = (await box()).find((m) => m.id === 'smoke:c');
  w = await win();
  ok(after.ash === before.ash + 2 && after.glow === before.glow + 1, '받기 puts both attachments into the stash', JSON.stringify({ before, after }));
  ok(mc.claimed && mc.read && mc.items === '' && !w.rows.find((r) => r.id === 'smoke:c').clip && w.tiles === 0, 'the mail is claimed: no items, no 첨부 mark, no tiles', JSON.stringify({ mc, tiles: w.tiles }));
  ok((await P(() => window.__notifs())).some((t) => t.includes('창고로 옮겼습니다')), 'success notice (ui:notify)');
  ok(!w.delDisabled, '읽은 메일 삭제 is enabled once something is read + claimed');

  // fill the stash to the brim with herb_ironleaf stacks, then free exactly one cell
  const fill = await P(() => {
    const inv = window.__game.ctx.inventory, loot = window.__game.ctx.loot;
    let n = 0;
    while (n < 5000 && inv.tryAddToStash(loot.createItem('herb_ironleaf', 6))) n++;
    return { n, full: !inv.tryAddToStash(loot.createItem('herb_ironleaf', 1)) };
  });
  ok(fill.n > 0 && fill.full, `stash filled (${fill.n} stacks of herb_ironleaf)`, JSON.stringify(fill));
  let r = await P(() => window.__mail().claim('smoke:a'));
  let ma = (await box()).find((m) => m.id === 'smoke:a');
  ok(r === 'no_space' && ma.items === 'herb_bloodroot×20' && !ma.claimed, 'full stash → claim no_space, the mail keeps all 20', JSON.stringify({ r, ma }));
  ok((await P(() => window.__notifs())).some((t) => t.includes('빈 자리가 없습니다')), 'no-space notice');
  const blood0 = await P(() => window.__stashCount('herb_bloodroot'));
  await P(() => { const inv = window.__game.ctx.inventory; const it = inv.getStashItems().find((i) => i.defId === 'herb_ironleaf'); inv.takeItem(it.uid); });
  r = await P(() => window.__mail().claimAll());
  ma = (await box()).find((m) => m.id === 'smoke:a');
  const blood1 = await P(() => window.__stashCount('herb_bloodroot'));
  ok(r === 'partial' && blood1 - blood0 === 8 && ma.items === 'herb_bloodroot×12' && !ma.claimed, '모두 받기 with one free cell → partial: one stack of 8 in, 12 stay in the mail', JSON.stringify({ r, got: blood1 - blood0, ma }));
  ok((await P(() => window.__notifs())).some((t) => t.includes('일부만 받았습니다')), 'partial notice');
  const dev0 = (await box()).find((m) => m.id === devId);
  ok(dev0.items === 'herb_frostmoss×3' && !dev0.claimed, '모두 받기 stopped at the first mail that did not fit (the newer one untouched)', JSON.stringify(dev0));
  // make room: drop every ironleaf stack, then 모두 받기 by the button
  await P(() => { const inv = window.__game.ctx.inventory; for (const it of inv.getStashItems().filter((i) => i.defId === 'herb_ironleaf')) inv.takeItem(it.uid); });
  const fm0 = await P(() => window.__stashCount('herb_frostmoss'));
  await waitSim(0.1);
  ok(!(await win()).allDisabled, '모두 받기 stays enabled while attachments are left');
  await P(() => document.querySelector('.ml-bar .ms-btn.primary').click());
  await waitSim(0.2);
  bx = await box();
  ok(bx.every((m) => m.claimed && m.items === ''), 'button 모두 받기 → every mail claimed', JSON.stringify(bx));
  ok((await P(() => window.__stashCount('herb_bloodroot'))) - blood0 === 20 && (await P(() => window.__stashCount('herb_frostmoss'))) - fm0 === 3, 'all 20 bloodroot and the 3 frostmoss reached the stash — nothing lost');
  w = await win();
  ok(w.allDisabled, '모두 받기 disables when nothing is left');
  r = await P(() => window.__mail().claimAll());
  ok(r === 'nothing', `claimAll on an empty box → nothing (${r})`);

  console.log('읽은 메일 삭제');
  await P((npc) => {
    const m = window.__mail();
    m.send({ id: 'smoke:d', from: npc.id, subject: '미확인 D', body: '안 읽음, 첨부 없음' });
    m.send({ id: 'smoke:e', from: npc.id, subject: '소포 E', body: '읽었지만 첨부 남음', items: [{ defId: 'herb_bloodroot', qty: 1 }] });
    m.markRead('smoke:e');
  }, npc);
  await waitSim(0.1);
  bx = await box();
  const expectGone = bx.filter((m) => m.read && m.claimed).map((m) => m.id).sort();
  await P(() => document.querySelector('.ml-bar .ms-btn:not(.primary)').click());
  await waitSim(0.1);
  const left = (await box()).map((m) => m.id).sort();
  ok(expectGone.length >= 3 && left.join() === 'smoke:d,smoke:e', `읽은 메일 삭제 removes read+claimed only (${expectGone.join(' ')}) — unread D and read-but-unclaimed E stay`, JSON.stringify({ expectGone, left }));
  w = await win();
  ok(w.rows.length === 2 && w.delDisabled && w.selected !== null && left.includes(w.selected), 'the list redraws; the selection falls on a mail that still exists', JSON.stringify({ rows: w.rows.map((x) => x.id), sel: w.selected }));
  const resend = await P(() => window.__mail().send({ id: 'smoke:b', from: '시스템', subject: '다시', body: '' }));
  ok(resend === false && !(await box()).some((m) => m.id === 'smoke:b'), 'a deleted id cannot be delivered again (seen list)');
  await P(() => window.__tap('Escape'));
  await waitSim(0.2);

  console.log('reload');
  await P(() => { window.__game.getSystem('meta').store.flush(); });
  await sleep(600);
  const snap = await box();
  await page.reload({ waitUntil: 'load' });
  await boot();
  let re = await box();
  ok(JSON.stringify(re) === JSON.stringify(snap), 'mailbox restored from the meta save after a reload (title)', JSON.stringify({ snap, re }));
  await toShip();
  await waitSim(1.5);
  re = await box();
  ok(JSON.stringify(re) === JSON.stringify(snap), 'still the same after the ship link loads the profile', JSON.stringify({ snap, re }));
  ok((await P(() => window.__mail().send({ id: 'smoke:a', from: 'x', subject: 'x', body: '' }))) === false, 'the seen list survives the reload too (deleted smoke:a stays undeliverable)');
  b = await btn();
  ok(b.dot && b.num === '1', 'badge after reload = 1 (unread D)', JSON.stringify(b));

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
