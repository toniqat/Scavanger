// The paged raid result screen (src/ui/menus/results, 2026-09-21): ① 전리품 → ② 경험치 → ③ 분대 계약 → ④ 분대원.
// Part A feeds synthetic `game:complete` / `game:over` payloads with full `MissionRewards` (cards incl. trust cards with a
// `peer`, `deathMul`, `contracts` rows, squad entries) and checks page order and skipping (solo skips ④, no rewards → ①
// only), the step strip, one horizontal card row that scrolls sideways, card XP summing to `xpEarned`, the `사망 ×0.4` tag,
// Space advancing (repeat ignored), `함선으로 귀환` on the last page only, and the squad page's 좋아요 button against a
// stubbed `ctx.net.trust` (like → check mark + the bar runs on by PLAYER_TRUST_LIKE_GAIN; canLike false → disabled; no
// trust → button and bar hidden). Part B runs the real settlement (`game/parts/Death.awardMissionXp` → `RaidXp`): a solo
// raid with gather / fog / kill counters and a stubbed survey gain, extracted (`gameflow.complete()`) and then died
// (`gameflow.gameOver()`), and checks the cards the producer built add up and land in the progression.
// Usage: node scripts/smoke-results.mjs [http://localhost:5273]   (needs `npm run dev`; the relay only for the ship's link)
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

// data/tables.csv PLAYER_TRUST_TABLE · data/constants.csv PLAYER_TRUST_LIKE_GAIN / XP_DEATH_MUL / RAID_XP_* — mirrored for
// the stub and the expectations; a csv retune turns the matching check red with both numbers in the payload.
const TRUST_TABLE = [0, 20, 60, 130, 240, 400];
const LIKE_GAIN = 5;
const DEATH_MUL = 0.4;
const XP_PER_GATHER = 6, XP_DISCOVER_PLATFORM = 20, XP_MAP_FULL = 150, XP_SURVEY_PER_PCT = 3;

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
    '--window-size=960,540', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true }, raid2: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
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
    window.__ev = { 'audio:play': [] };
    window.__game.ctx.bus.on('audio:play', (p) => window.__ev['audio:play'].push(p));
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const emit = (name, payload) => P(([n, p]) => window.__game.ctx.bus.emit(n, p), [name, payload]);
  const sel = (w) => (w === 'complete' ? '.menu.complete' : '.menu.death');
  const state = (w) => P(([w, s]) => {
    const h = window.__game.getSystem('hud')[w];
    const b = h.resultBody; const m = document.querySelector(s);
    return {
      shown: !m.classList.contains('hidden'), id: b.pageId, idx: b.pageIndex, order: [...b.pageOrder], last: b.onLastPage,
      navHidden: m.querySelector('.rs-nav').hidden, actionsHidden: m.querySelector('.actions').hidden,
      actions: [...m.querySelectorAll('.actions .ui-btn')].map((e) => e.textContent),
      next: m.querySelector('.rs-nav .rs-next')?.textContent ?? '',
      steps: [...m.querySelectorAll('.rs-step')].filter((e) => !e.hidden).map((e) => e.textContent), stepsHidden: m.querySelector('.rs-steps').hidden,
      on: m.querySelector('.rs-step.is-on .rs-step-t')?.textContent ?? '',
      shownPages: [...m.querySelectorAll('.rs-pages > *')].filter((e) => !e.hidden).map((e) => e.className),
    };
  }, [w, sel(w)]);
  const nextPage = (w) => P((w) => window.__game.getSystem('hud')[w].resultBody.next(), w);
  const space = (repeat = false) => P((repeat) => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', repeat, bubbles: true, cancelable: true })); }, repeat);
  const hideAll = async () => { await emit('game:phaseChanged', { phase: 'playing', prev: 'complete' }); };

  /* ── trust stub: `ctx.net.trust` shadowed on the instance (NetSystem has it as a prototype getter) ── */
  const installTrust = (spec) => P(([spec, table]) => {
    const info = (points) => {
      const p = Math.max(0, Math.floor(points || 0));
      let level = 0; for (let i = 1; i < table.length; i++) if (p >= table[i]) level = i;
      const next = level >= table.length - 1 ? null : table[level + 1];
      return { points: p, level, next, frac: next === null ? 1 : (p - table[level]) / (next - table[level]) };
    };
    window.__likes = [];
    const liked = new Set(spec.liked);
    const stub = spec.none ? null : {
      get: (c) => info(spec.points?.[c] ?? 0), beforeRaid: (c) => info(spec.points?.[c] ?? 0), infoOf: info,
      canLike: (c) => !liked.has(c) && spec.canLike.includes(c),
      hasLiked: (c) => liked.has(c),
      like: (c) => { window.__likes.push(c); if (liked.has(c) || !spec.canLike.includes(c)) return false; liked.add(c); return true; },
    };
    Object.defineProperty(window.__game.ctx.net, 'trust', { value: stub, configurable: true, writable: true });
  }, [spec, TRUST_TABLE]);
  const removeTrust = () => P(() => { delete window.__game.ctx.net.trust; });

  console.log('into a solo raid');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 23 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
  const base = await P(() => JSON.parse(JSON.stringify(window.__game.ctx.stats)));
  ok(!!base && base.seed !== undefined, 'raid running', JSON.stringify(base));

  /* ══ A1. full squad payload on the complete screen ══ */
  console.log('A1 squad complete — every page');
  const cards = [
    { kind: 'kill', id: 'kill', title: '처치', detail: '12마리', xp: 120 },
    { kind: 'gather', id: 'gather', title: '채집', detail: '3회', xp: 18 },
    { kind: 'discover', id: 'discover', title: '구조물 발견', detail: '2곳', xp: 60 },
    { kind: 'mapReveal', id: 'mapReveal', title: '지도 탐사', detail: '40 %', xp: 60 },
    { kind: 'survey', id: 'survey:beetle', title: '갑충', detail: '+10 %', xp: 30 },
    { kind: 'trust', id: 'trust:AAAA-1111', title: '알파', detail: '신뢰도 Lv.0', xp: 10, peer: { code: 'AAAA-1111', name: '알파', accent: '#4fc3f7' } },
    { kind: 'trust', id: 'trust:BBBB-2222', title: '브라보', detail: '신뢰도 Lv.1', xp: 20, peer: { code: 'BBBB-2222', name: '브라보' } },
    { kind: 'trust', id: 'trust:CCCC-3333', title: '찰리', detail: '신뢰도 Lv.2', xp: 30, peer: { code: 'CCCC-3333', name: '찰리', accent: '#ff7043' } },
    { kind: 'contract', id: 'contract', title: '계약', detail: '소탕 작전 I', xp: 150 },
  ];
  const cardSum = cards.reduce((a, c) => a + c.xp, 0);   // 498
  const squad = [
    { peerId: 'p-a', code: 'AAAA-1111', name: '알파', accent: '#4fc3f7', level: 4, trustBefore: 15, trustRaidGain: 10 },
    { peerId: 'p-b', code: 'BBBB-2222', name: '브라보', level: 7, trustBefore: 30, trustRaidGain: 10 },
    { peerId: 'p-c', code: 'CCCC-3333', name: '찰리', accent: '#ff7043', trustBefore: 70, trustRaidGain: 10 },
  ];
  const contracts = [
    { name: '브라보', self: false, label: '회수 임무 I', success: false, progress: 3, target: 15 },
    { name: '나자신', self: true, label: '소탕 작전 I', success: true, progress: 25, target: 25 },
    { name: '알파', self: false, label: null, success: false, progress: 0, target: 0 },
    { name: '찰리', self: false, label: '정찰 임무', success: true, progress: 4, target: 4 },
  ];
  const settle = { id: 'helix_1', corp: 'helix', name: '소탕 작전 I', success: true, outcome: 'success', progress: 25, target: 25, rep: 60, xp: 150, credits: 120 };
  await installTrust({ points: { 'AAAA-1111': 15, 'BBBB-2222': 30, 'CCCC-3333': 70 }, canLike: ['AAAA-1111', 'CCCC-3333'], liked: ['CCCC-3333'] });
  await P(() => { window.__ev['audio:play'].length = 0; });
  await emit('game:complete', { stats: { ...base, extracted: true, lootValue: 1200, rewards: { xpEarned: cardSum, levelBefore: 3, levelAfter: 3, xp: 100 + cardSum, xpToNext: 5000, contract: settle, cards, deathMul: 1, squad, contracts } } });
  let st = await state('complete');
  ok(st.shown && st.id === 'loot' && st.order.join() === 'loot,xp,contracts,squad', 'squad raid → pages loot · xp · contracts · squad, opens on ①', JSON.stringify(st));
  ok(!st.stepsHidden && st.steps.join('|') === '1전리품|2경험치|3분대 계약|4분대원' && st.on === '전리품', 'step strip numbers the four pages, ① lit', JSON.stringify(st.steps));
  ok(st.shownPages.length === 1 && /\bstats\b/.test(st.shownPages[0]), 'only the ① page (.stats) is visible', JSON.stringify(st.shownPages));
  ok(!st.navHidden && st.actionsHidden && /다음/.test(st.next) && /Space/i.test(st.next), '다음 (with a Space keycap) shown, 함선으로 귀환 hidden on ①', JSON.stringify(st));
  let rw = await P(() => ({ counting: window.__game.getSystem('hud').completeRewards.isCounting, cards: window.__game.getSystem('hud').completeRewards.cardViews.map((c) => c.state) }));
  ok(!rw.counting && rw.cards.every((s) => s === 'wait'), 'XP cards wait (no counting) until page ② is entered', JSON.stringify(rw));

  // Space → ②; a key repeat does not skip a page
  await space();
  st = await state('complete');
  ok(st.id === 'xp' && st.idx === 1 && st.on === '경험치', 'Space → page ② 경험치', JSON.stringify(st));
  await space(true);
  st = await state('complete');
  ok(st.id === 'xp', 'a repeated Space keydown does not advance', st.id);
  const xpDom = await P(() => {
    const r = document.querySelector('.menu.complete .rewards');
    const row = r.querySelector('.rs-cards');
    const cs = getComputedStyle(row);
    const els = [...row.querySelectorAll('.rs-card')];
    const tops = new Set(els.map((e) => e.offsetTop));
    const trust = els.filter((e) => e.classList.contains('k-trust'));
    return {
      hidden: r.hidden, n: els.length, ids: els.map((e) => e.dataset.id), display: cs.display, dir: cs.flexDirection, wrap: cs.flexWrap, ox: cs.overflowX,
      tops: tops.size, sw: row.scrollWidth, cw: row.clientWidth,
      trustSc: trust.map((e) => e.style.getPropertyValue('--sc')), titles: els.map((e) => e.querySelector('.rs-card-title').textContent),
      details: els.map((e) => e.querySelector('.rs-card-detail')?.textContent ?? ''), tag: window.__game.getSystem('hud').completeRewards.deathTag,
      mulHidden: r.querySelector('.rs-xp-mul').hidden,
    };
  });
  ok(!xpDom.hidden && xpDom.n === cards.length && xpDom.ids.join() === cards.map((c) => c.id).join(), `page ② draws one card per rewards.cards entry in order (${xpDom.n})`, JSON.stringify(xpDom.ids));
  ok(xpDom.display === 'flex' && xpDom.dir === 'row' && xpDom.wrap === 'nowrap' && xpDom.tops === 1, 'cards sit in ONE horizontal row (flex row, nowrap, one offsetTop)', JSON.stringify(xpDom));
  ok((xpDom.ox === 'auto' || xpDom.ox === 'scroll') && xpDom.sw > xpDom.cw, `the row scrolls sideways when it overflows (scrollWidth ${xpDom.sw} > clientWidth ${xpDom.cw})`, JSON.stringify(xpDom));
  ok(xpDom.trustSc.length === 3 && xpDom.trustSc[0] === '#4fc3f7' && xpDom.trustSc[2] === '#ff7043' && xpDom.trustSc[1] !== '', 'trust cards take the peer accent as their frame colour (fallback slot colour when absent)', JSON.stringify(xpDom.trustSc));
  ok(xpDom.titles[5] === '알파' && xpDom.details[5] === '신뢰도 Lv.0' && xpDom.details[0] === '12마리', 'card title / detail lines', JSON.stringify(xpDom.titles));
  ok(xpDom.tag === '' && xpDom.mulHidden, 'deathMul 1 → no 사망 tag', xpDom.tag);
  // one card at a time: while counting there is at most one live card
  const live = await waitFor(page, () => { const v = window.__game.getSystem('hud').completeRewards.cardViews; const l = v.filter((c) => c.state === 'live'); return l.length ? { live: l.length, first: v[0].state } : null; }, 'a live card', 10000);
  ok(live.live === 1, 'cards count up one after another (one live card at a time)', JSON.stringify(live));
  await waitFor(page, () => !window.__game.getSystem('hud').completeRewards.isCounting, 'count-up end', 60000);
  rw = await P(() => { const r = document.querySelector('.menu.complete .rewards'); return { views: window.__game.getSystem('hud').completeRewards.cardViews, gain: r.querySelector('.xp-gain').textContent, num: r.querySelector('.xp-num').textContent }; });
  const shownSum = rw.views.reduce((a, c) => a + Number(c.xp.replace(/[^\d]/g, '')), 0);
  ok(rw.views.every((c) => c.state === 'done') && rw.views.map((c) => c.xp).join() === cards.map((c) => `+${c.xp}`).join(), 'every card ends done on its own +xp', JSON.stringify(rw.views.map((c) => c.xp)));
  ok(shownSum === cardSum && rw.gain === `+${cardSum}`, `card XP counts sum to xpEarned (+${cardSum})`, `${shownSum} ${rw.gain}`);
  ok(rw.num.startsWith(`${100 + cardSum} / `) && rw.num.endsWith(' XP'), `bar numbers end on the final xp / xpToNext (${rw.num})`, rw.num);

  // ③ contracts
  ok(await nextPage('complete'), 'next() → page ③');
  st = await state('complete');
  const ct = await P(() => [...document.querySelectorAll('.menu.complete .rs-ct')].map((r) => ({ cls: r.className, name: r.querySelector('.rs-ct-name').textContent, tag: r.querySelector('.rs-ct-tag').textContent, label: r.querySelector('.rs-ct-label').textContent, prog: r.querySelector('.rs-ct-prog')?.textContent ?? null, pay: r.querySelector('.rs-ct-pay')?.textContent ?? null, barHidden: r.querySelector('.rs-ct-bar').hidden })));
  ok(st.id === 'contracts' && !st.last && !st.navHidden && st.actionsHidden, 'page ③ is not the last in a squad — 다음 still shown, no 함선으로 귀환', JSON.stringify(st));
  ok(ct.length === 4 && ct[0].name === '나' && /\bis-me\b/.test(ct[0].cls), 'one row per member, mine first as 나', JSON.stringify(ct.map((c) => c.name)));
  ok(/\bis-success\b/.test(ct[0].cls) && ct[0].tag === '계약 성공' && ct[0].prog === '25 / 25' && ct[0].pay === '신뢰도 +60 · 크레딧 +120 C', 'my row reads the settlement (계약 성공, 25 / 25, 신뢰도 +60 · 크레딧 +120 C)', JSON.stringify(ct[0]));
  const byName = Object.fromEntries(ct.map((c) => [c.name, c]));
  ok(byName['브라보'] && /\bis-keep\b/.test(byName['브라보'].cls) && byName['브라보'].tag === '계약 미완' && byName['브라보'].prog === '3 / 15' && byName['브라보'].pay === null, 'a squadmate still under target → 계약 미완 3 / 15, no pay line', JSON.stringify(byName['브라보']));
  ok(byName['찰리'] && /\bis-success\b/.test(byName['찰리'].cls) && byName['찰리'].tag === '계약 성공', 'a squadmate over target → 계약 성공', JSON.stringify(byName['찰리']));
  ok(byName['알파'] && /\bis-none\b/.test(byName['알파'].cls) && byName['알파'].label === '계약 없음' && byName['알파'].barHidden, 'a squadmate with no contract → 계약 없음, no bar', JSON.stringify(byName['알파']));
  ok(await P(() => document.querySelector('.menu.complete .rs-ct-empty').hidden), '진행 중인 계약이 없었습니다 stays hidden when someone had one');

  // ④ squad (the chime count starts here — equipping in the raid plays ui_equip too)
  await P(() => { window.__ev['audio:play'].length = 0; });
  await space();
  st = await state('complete');
  ok(st.id === 'squad' && st.last && st.navHidden && !st.actionsHidden && st.actions.join() === '함선으로 귀환', 'Space → page ④ is last: 다음 gone, 함선으로 귀환 shown', JSON.stringify(st));
  await space();
  ok((await state('complete')).id === 'squad', 'Space on the last page does nothing');
  const tiles = () => P(() => ({
    views: window.__game.getSystem('hud').complete.resultBody.squad.tileViews,
    dom: [...document.querySelectorAll('.menu.complete .rs-sq')].map((t) => ({
      name: t.querySelector('.rs-sq-name').textContent, lv: t.querySelector('.rs-sq-lv')?.textContent ?? null, sc: t.style.getPropertyValue('--sc'),
      likeHidden: t.querySelector('.rs-sq-like').hidden, likeDisabled: t.querySelector('.rs-sq-like').disabled, liked: t.querySelector('.rs-sq-like').classList.contains('is-liked'),
      trustHidden: t.querySelector('.rs-sq-trust').hidden, tlv: t.querySelector('.rs-sq-tlv').textContent, gain: t.querySelector('.rs-sq-tgain').textContent,
      fill: t.querySelector('.rs-sq-tfill').style.transform, up: t.classList.contains('is-up'),
    })),
    animating: window.__game.getSystem('hud').complete.resultBody.squad.isAnimating,
  }));
  let tv = await tiles();
  ok(tv.dom.length === 3 && tv.dom.map((d) => d.name).join() === '알파,브라보,찰리' && tv.dom[0].lv === 'Lv.4' && tv.dom[2].lv === null, 'three squad tiles, name + Lv.n (no level → no chip)', JSON.stringify(tv.dom));
  ok(tv.dom[0].sc === '#4fc3f7' && tv.dom[1].sc !== '', 'tile accent from the entry (slot colour fallback)', JSON.stringify(tv.dom.map((d) => d.sc)));
  ok(!tv.dom[0].likeHidden && !tv.dom[0].likeDisabled && !tv.dom[0].liked, 'canLike → 좋아요 enabled', JSON.stringify(tv.dom[0]));
  ok(!tv.dom[1].likeHidden && tv.dom[1].likeDisabled && !tv.dom[1].liked, 'canLike false → 좋아요 disabled', JSON.stringify(tv.dom[1]));
  ok(tv.dom[2].liked && tv.dom[2].likeDisabled, 'already liked (hasLiked) → check mark, disabled', JSON.stringify(tv.dom[2]));
  ok(tv.dom.every((d) => !d.trustHidden) && tv.dom[0].tlv === '신뢰 Lv.0', 'trust bars shown with 신뢰 Lv.n (알파 starts at Lv.0)', JSON.stringify(tv.dom.map((d) => d.tlv)));
  await waitSim(1.8);
  tv = await tiles();
  ok(tv.views[0].points === 25 && tv.dom[0].gain === '+10' && tv.dom[0].tlv === '신뢰 Lv.1' && tv.dom[0].up, '알파 15 → 25 crosses Lv.1 (20): bar wraps, tile flashes .is-up, +10', JSON.stringify(tv.views[0]) + JSON.stringify(tv.dom[0]));
  ok(tv.views[2].points === 70 + 10 + LIKE_GAIN && tv.dom[2].gain === `+${10 + LIKE_GAIN}`, `an already-liked tile runs to before + raid + like (${70 + 10 + LIKE_GAIN})`, JSON.stringify(tv.views[2]));
  ok(tv.views[1].points === 40 && /scaleX\(0\.5/.test(tv.dom[1].fill), '브라보 30 → 40 = half of the Lv.1 band (20 … 60)', JSON.stringify(tv.dom[1]));
  const upAudio = await P(() => window.__ev['audio:play'].filter((a) => a.id === 'ui_equip').length);
  ok(upAudio === 1, 'one trust level-up chime (ui_equip) for the one crossing', String(upAudio));
  // like 알파 by a real click
  await P(() => document.querySelectorAll('.menu.complete .rs-sq .rs-sq-like')[0].click());
  // the disabled one refuses even a scripted click (never reaches like())
  await P(() => document.querySelectorAll('.menu.complete .rs-sq .rs-sq-like')[1].click());
  tv = await tiles();
  const likes = await P(() => [...window.__likes]);
  ok(likes.join() === 'AAAA-1111', 'click → trust.like(code) once for 알파, nothing for the disabled tile', JSON.stringify(likes));
  ok(tv.dom[0].liked && tv.dom[0].likeDisabled && tv.animating, 'liked → check mark, disabled, the bar moves again', JSON.stringify(tv.dom[0]));
  await waitSim(1.4);
  tv = await tiles();
  ok(tv.views[0].points === 25 + LIKE_GAIN && tv.dom[0].gain === `+${10 + LIKE_GAIN}`, `the like runs the bar on by PLAYER_TRUST_LIKE_GAIN (${25 + LIKE_GAIN}, +${10 + LIKE_GAIN})`, JSON.stringify(tv.views[0]));
  await P(() => document.querySelectorAll('.menu.complete .rs-sq .rs-sq-like')[0].click());
  ok((await P(() => window.__likes.length)) === 1, 'a second click on a liked tile sends nothing');
  // 함선으로 귀환 → ui:shipReturn (listened, not followed — the button is the contract)
  const ret = await P(() => { const b = [...document.querySelectorAll('.menu.complete .actions .ui-btn')].find((x) => x.textContent === '함선으로 귀환'); return !!b && !b.closest('[hidden]') && b.offsetParent !== null; });
  ok(ret, '함선으로 귀환 is the visible button on the last page');
  await hideAll();

  /* ══ A2. no trust at all ══ */
  console.log('A2 no ctx.net.trust');
  await installTrust({ none: true });
  await emit('game:complete', { stats: { ...base, extracted: true, rewards: { xpEarned: cardSum, levelBefore: 3, levelAfter: 3, xp: 100 + cardSum, xpToNext: 5000, contract: settle, cards, deathMul: 1, squad, contracts } } });
  await nextPage('complete'); await nextPage('complete'); await nextPage('complete');
  tv = await tiles();
  ok(tv.dom.length === 3 && tv.dom.every((d) => d.likeHidden && d.trustHidden), 'no ctx.net.trust → 좋아요 and the trust bar are hidden', JSON.stringify(tv.dom));
  await hideAll();
  await removeTrust();

  /* ══ A3. solo death payload ══ */
  console.log('A3 solo death — ×0.4, squad skipped');
  const deathCards = [
    { kind: 'kill', id: 'kill', title: '처치', detail: '5마리', xp: 20 },
    { kind: 'gather', id: 'gather', title: '채집', detail: '4회', xp: 10 },
    { kind: 'mapReveal', id: 'mapReveal', title: '지도 탐사', detail: '20 %', xp: 12 },
  ];
  const deathSum = deathCards.reduce((a, c) => a + c.xp, 0);
  await emit('game:over', { stats: { ...base, extracted: false, rewards: { xpEarned: deathSum, levelBefore: 3, levelAfter: 3, xp: 200, xpToNext: 5000, contract: null, cards: deathCards, deathMul: DEATH_MUL, squad: [], contracts: [{ name: '나자신', self: true, label: null, success: false, progress: 0, target: 0 }] } } });
  st = await state('death');
  ok(st.shown && st.order.join() === 'loot,xp,contracts' && st.steps.length === 3, 'solo → squad page skipped (loot · xp · contracts, three steps)', JSON.stringify(st));
  await space();
  const dx = await P(() => ({ tag: window.__game.getSystem('hud').deathRewards.deathTag, hidden: document.querySelector('.menu.death .rs-xp-mul').hidden }));
  ok(dx.tag === `사망 ×${DEATH_MUL}` && !dx.hidden, `deathMul ${DEATH_MUL} → 사망 ×${DEATH_MUL} tag`, JSON.stringify(dx));
  await space();
  st = await state('death');
  const drow = await P(() => [...document.querySelectorAll('.menu.death .rs-ct')].map((r) => ({ cls: r.className, name: r.querySelector('.rs-ct-name').textContent, label: r.querySelector('.rs-ct-label').textContent })));
  ok(st.id === 'contracts' && st.last && !st.actionsHidden && st.navHidden, 'solo: ③ is the last page, 함선으로 귀환 shown', JSON.stringify(st));
  ok(drow.length === 1 && drow[0].name === '나' && drow[0].label === '계약 없음', 'my no-contract row reads 계약 없음', JSON.stringify(drow));
  ok(await P(() => !document.querySelector('.menu.death .rs-ct-empty').hidden), 'nobody had a contract → 진행 중인 계약이 없었습니다');
  await emit('game:phaseChanged', { phase: 'playing', prev: 'dead' });

  /* ══ A4. no rewards ══ */
  console.log('A4 no rewards — page ① only');
  await emit('game:complete', { stats: { ...base, extracted: true } });
  st = await state('complete');
  ok(st.order.join() === 'loot' && st.last && st.stepsHidden && st.navHidden && !st.actionsHidden, 'no rewards → ① only, no step strip, 함선으로 귀환 right away', JSON.stringify(st));
  await space();
  ok((await state('complete')).id === 'loot', 'Space with one page does nothing');
  await hideAll();
  // squad entries but an empty cards list → one card built from xpEarned, squad page shown
  await installTrust({ points: {}, canLike: [], liked: [] });
  await emit('game:complete', { stats: { ...base, extracted: true, rewards: { xpEarned: 42, levelBefore: 3, levelAfter: 3, xp: 142, xpToNext: 5000, contract: null, cards: [], squad: squad.slice(0, 1) } } });
  st = await state('complete');
  const one = await P(() => window.__game.getSystem('hud').completeRewards.cardViews.map((c) => c.id));
  ok(st.order.join() === 'loot,xp,contracts,squad' && one.join() === 'total', 'empty cards → one total card; a single squadmate still shows ④', JSON.stringify({ o: st.order, one }));
  await hideAll();
  await removeTrust();

  /* ══ B. the real settlement ══ */
  console.log('B1 real settlement — extraction');
  const lib = await P(() => { const h = window.__game.ctx.housing; const a = Number(h?.getLibraryEffects?.()?.raidXp ?? 0); return 1 + (Number.isFinite(a) && a > 0 ? a : 0); });
  const seedCounters = async () => P(() => {
    const ctx = window.__game.ctx;
    // survey gain stubbed on the instance (the camera is its own smoke); the kill total is what enemies/ would have summed
    if (ctx.survey) Object.defineProperty(ctx.survey, 'raidGains', { value: () => [{ subjectId: 'smoke_subject', name: '스모크 대상', gained: 0.1 }], configurable: true, writable: true });
    ctx.stats.killXp = 37; ctx.stats.kills = 4;
    for (let i = 0; i < 3; i++) ctx.bus.emit('gather:collected', { nodeId: `smoke-node-${i}`, defId: 'herb', qty: 1 });
    ctx.bus.emit('fog:discovered', { kind: 'rail', id: 'smoke-rail-a', position: ctx.player.position.clone() });
    ctx.bus.emit('fog:discovered', { kind: 'rail', id: 'smoke-rail-b', position: ctx.player.position.clone() });
    ctx.bus.emit('fog:discovered', { kind: 'rail', id: 'smoke-rail-a', position: ctx.player.position.clone() });   // a re-announce after a resume is deduped
    ctx.bus.emit('fog:revealed', { revision: 999, explored: 0.25 });
    return { gathers: ctx.stats.gathers, found: [...(ctx.stats.structuresFound ?? [])], map: ctx.stats.mapExplored, survey: !!ctx.survey };
  });
  let seeded = await seedCounters();
  ok(seeded.gathers === 3 && seeded.found.join() === 'platform:smoke-rail-a,platform:smoke-rail-b' && seeded.map >= 0.25, 'raid counters: gathers 3, two platforms (deduped), explored ≥ 25 %', JSON.stringify(seeded));
  const before1 = await P(() => { const p = window.__game.ctx.progression; return { level: p.level, xp: p.xp, raids: p.profile.raids, extractions: p.profile.extractions }; });
  await P(() => { const gf = window.__game.getSystem('gameflow'); gf.aboardAtLiftoff = true; gf.complete(); });
  await waitFor(page, () => window.__game.ctx.phase === 'complete', 'phase complete', 10000);
  const expectCards = (s, mul) => {
    const out = { kill: Math.round(37 * mul), gather: Math.round(3 * XP_PER_GATHER * mul), discover: Math.round(2 * XP_DISCOVER_PLATFORM * mul), mapReveal: Math.round(s.mapExplored * XP_MAP_FULL * mul) };
    if (seeded.survey) out['survey:smoke_subject'] = Math.round(10 * XP_SURVEY_PER_PCT * mul);
    return out;
  };
  const settled = async (w) => P((w) => {
    const ctx = window.__game.ctx; const r = ctx.stats.rewards; const p = ctx.progression;
    return { r: JSON.parse(JSON.stringify(r ?? null)), mapExplored: ctx.stats.mapExplored, raidFoundValue: ctx.stats.raidFoundValue, level: p.level, xp: p.xp, raids: p.profile.raids, extractions: p.profile.extractions, order: [...window.__game.getSystem('hud')[w].resultBody.pageOrder] };
  }, w);
  let s1 = await settled('complete');
  let exp = expectCards(s1, lib);
  let got = Object.fromEntries((s1.r?.cards ?? []).map((c) => [c.id, c.xp]));
  ok(!!s1.r && s1.r.deathMul === 1, 'extracted → rewards.deathMul 1', JSON.stringify(s1.r?.deathMul));
  ok(Object.keys(exp).every((k) => got[k] === exp[k]), `producer cards = counters × csv rates × library ${lib} (${JSON.stringify(exp)})`, JSON.stringify(got));
  ok((s1.r?.cards ?? []).reduce((a, c) => a + c.xp, 0) === s1.r?.xpEarned && s1.r.xpEarned > 0, `the cards sum to xpEarned (${s1.r?.xpEarned})`, JSON.stringify(s1.r?.cards));
  ok(!(s1.r?.cards ?? []).some((c) => c.kind === 'trust') && (s1.r?.squad ?? []).length === 0 && s1.order.join() === 'loot,xp,contracts', 'solo: no trust card, no squad rows, no ④', JSON.stringify(s1.order));
  ok(Array.isArray(s1.r?.contracts) && s1.r.contracts[0]?.self === true, 'rewards.contracts carries my row first', JSON.stringify(s1.r?.contracts));
  ok(s1.raids === before1.raids + 1 && s1.extractions === before1.extractions + 1, 'profile raids / extractions bumped', JSON.stringify({ before1, s1: { raids: s1.raids, ex: s1.extractions } }));
  ok(s1.level > before1.level || s1.xp === before1.xp + s1.r.xpEarned, 'progression got exactly xpEarned', JSON.stringify({ before1, level: s1.level, xp: s1.xp, earned: s1.r?.xpEarned }));
  ok(typeof s1.raidFoundValue === 'number' && s1.raidFoundValue >= 0, `page ① reading raidFoundValue filled (${s1.raidFoundValue})`);
  const ui1 = await P(() => { const b = window.__game.getSystem('hud').complete.resultBody; b.next(); return window.__game.getSystem('hud').completeRewards.cardViews.map((c) => c.id); });
  ok(ui1.join() === (s1.r?.cards ?? []).map((c) => c.id).join(), 'page ② draws the producer cards', JSON.stringify(ui1));

  console.log('B2 real settlement — death (×0.4)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub again', 30000);
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 29 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing 2', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit 2', 15000);
  const fresh = await P(() => ({ g: window.__game.ctx.stats.gathers ?? 0, f: (window.__game.ctx.stats.structuresFound ?? []).length, k: window.__game.ctx.stats.killXp ?? 0 }));
  ok(fresh.g === 0 && fresh.f === 0 && fresh.k === 0, 'a new raid starts the counters at zero', JSON.stringify(fresh));
  seeded = await seedCounters();
  await P(() => window.__game.getSystem('gameflow').gameOver());
  await waitFor(page, () => window.__game.ctx.phase === 'dead', 'phase dead', 10000);
  const s2 = await settled('death');
  exp = expectCards(s2, DEATH_MUL * lib);
  got = Object.fromEntries((s2.r?.cards ?? []).map((c) => [c.id, c.xp]));
  ok(s2.r?.deathMul === DEATH_MUL, `died → rewards.deathMul ${DEATH_MUL}`, JSON.stringify(s2.r?.deathMul));
  ok(Object.keys(exp).every((k) => got[k] === exp[k]), `every card × ${DEATH_MUL} (${JSON.stringify(exp)})`, JSON.stringify(got));
  ok((s2.r?.cards ?? []).reduce((a, c) => a + c.xp, 0) === s2.r?.xpEarned, `death cards sum to xpEarned (${s2.r?.xpEarned})`);
  const ui2 = await P(() => { const b = window.__game.getSystem('hud').death.resultBody; b.next(); return { tag: window.__game.getSystem('hud').deathRewards.deathTag, page: b.pageId, shown: !document.querySelector('.menu.death').classList.contains('hidden') }; });
  ok(ui2.shown && ui2.page === 'xp' && ui2.tag === `사망 ×${DEATH_MUL}`, 'the death screen shows page ② with the 사망 tag', JSON.stringify(ui2));

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
