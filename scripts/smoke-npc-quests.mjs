// 2026-09-14 메신저 · NPC 퀘스트 엔진 (`ctx.meta.npc`, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」) — 싱글 플레이, 릴레이 소켓은 막는다.
//   ① 함선: 첫 연락(intro) · 조건 없는 NPC 의 첫 퀘스트 제안 · 대화 말풍선 풀이 · 읽음
//   ② 보류(생각해보지) → 퀘스트 탭 수락(brief) · 중복 수락/보류 거절
//   ③ 나눠 납품 · 미완 보고 거절 · 완료 보고 보상(크레딧 · 아이템 · 시스템 줄) · 다음 제안(선행 퀘스트)
//   ④ 목표 문구 (계열 · 행성)
//   ⑤ 레이드: 추적 목록(행성 조건) · 막타 계열 · 남의 킬 무시 · 상호작용 · 발견+조사 chain · 탈출 회수 · 레이드 끝 되돌림
//      + 실제 배관: `withLocalGunHit` → Enemy.takeDamage → `enemy:killed.weaponClass` (총기 / 계열 없음 / 지속 피해),
//        스캐너 상호작용 → `world:interacted`, 구조물 컨테이너 → `crate:open.zoneKind`
//   ⑥ 함선에서 보고 · 채굴 인가 퀘스트 → getQuestState 대응 · 코인 해금
//   ⑦ 저장 v2 · 새로고침 · 깨진 npc 저장 정리
// Usage: node scripts/smoke-npc-quests.mjs [http://localhost:5273/]
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

let pass = 0, fail = 0, skip = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const skipped = (label, why = '') => { skip++; console.log(`  skip ${label} ${why}`); };
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const EVENTS = ['npc:message', 'npc:questChanged', 'npc:objectiveProgress', 'npc:questReady', 'npc:unreadChanged', 'enemy:killed', 'world:interacted', 'crate:open'];
  const P = (fn, arg) => page.evaluate(fn, arg);
  const boot = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.meta?.npc && !!window.__game.ctx.inventory && !!window.__game.ctx.loot, 'boot');
    await P((names) => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      window.__ev = {};
      for (const n of names) { window.__ev[n] = []; window.__game.ctx.bus.on(n, (p) => { try { window.__ev[n].push(JSON.parse(JSON.stringify(p))); } catch { window.__ev[n].push({}); } }); }
    }, EVENTS);
  };
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const ev = (n) => P((k) => window.__ev[k], n);
  const clearEv = () => P(() => { for (const k of Object.keys(window.__ev)) window.__ev[k] = []; });
  const quest = (id) => P((q) => window.__game.ctx.meta.npc.getQuest(q), id);
  const enterHub = async () => {
    await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
    await waitSim(0.3);
  };
  /** Take `ids` out of the bag, stash, wheel and pouch. */
  const clearDefs = (ids) => P((list) => {
    const inv = window.__game.getSystem('inventory');
    for (let pass = 0; pass < 3; pass++) {
      const items = [...inv.bag.items().map((p) => p.item), ...inv.stash.grid.items().map((p) => p.item), ...inv.quickSlots.filter(Boolean), ...inv.pouch.items().map((p) => p.item)];
      for (const it of items) if (list.includes(it.defId)) inv.takeItem(it.uid);
    }
  }, ids);
  const give = (defId, qty) => P((a) => { const c = window.__game.ctx; const it = c.loot.createItem(a.defId, a.qty); return c.inventory.tryAddItemAnywhere(it); }, { defId, qty });

  await page.goto(BASE, { waitUntil: 'load' });
  await boot();
  await enterHub();

  /* ── ① 연락 · 제안 ─────────────────────────────────────────────────────── */
  console.log('① 첫 연락 · 제안');
  const tables = await P(async () => {
    const sh = await import('/src/shared/index.ts');
    return { npcs: sh.NPC_DEFS.length, quests: sh.NPC_QUEST_DEFS.length };
  });
  ok(tables.npcs >= 1 && tables.quests >= 1, `NPC 표가 읽힌다 (NPC ${tables.npcs} · 퀘스트 ${tables.quests})`);
  await P(() => { const m = window.__game.ctx.meta; m.resetMeta(); if (m.activeContract) m.abandonContract(); });
  await clearEv();
  ok(await P(() => window.__game.getSystem('meta').npcQuests.evaluate()) === true, 'evaluate() in the ship attaches contacts / offers');
  const first = await P(async () => {
    const sh = await import('/src/shared/index.ts');
    const lv = window.__game.ctx.progression?.level ?? 1;
    const free = (req) => (req.level ?? 1) <= lv && !req.rep?.length && !req.quests?.length && !req.flags?.length;
    const npc = sh.NPC_DEFS.find((n) => free(n.requires)
      && (() => { const q = sh.NPC_QUEST_DEFS.find((x) => x.npc === n.id); return q && free(q.requires); })());
    if (!npc) return null;
    const q = sh.NPC_QUEST_DEFS.find((x) => x.npc === npc.id);
    const r = window.__game.ctx.meta.npc;
    /* 2026-09-14 3차: 첫 연락은 인사 → **선택지** → 본론 → 제안이다. 답하기 전에는 제안이 오지 않는다. */
    const pending = r.getPendingChoices(npc.id);
    const beforeChoice = r.getQuest(q.id)?.state ?? null;
    const chose = pending.length ? r.chooseIntro(npc.id, 0) : false;
    return { npc: npc.id, intro: npc.intro.length, after: npc.introAfter?.length ?? 0, quest: q.id,
      contacts: r.getContacts().map((c) => c.npc.id), pending: pending.length, beforeChoice, chose,
      state: r.getQuest(q.id)?.state ?? null, unread: r.unreadTotal, msgs: r.getMessages(npc.id) };
  });
  if (!first) { ok(false, 'content has an NPC reachable at level 1 with no other requirement, and a first quest with none'); throw new Error('no starter NPC'); }
  const Q0 = first.quest, NPC0 = first.npc;
  ok(first.contacts.includes(NPC0) && first.pending > 0 && first.beforeChoice === null,
    `${NPC0}: contacted, intro choices pending, **no offer yet**`, JSON.stringify({ c: first.contacts, p: first.pending, s: first.beforeChoice }));
  ok(first.chose && first.state === 'offered', `chooseIntro → 본론(introAfter ${first.after}줄) → first quest ${Q0} offered`, JSON.stringify({ chose: first.chose, s: first.state }));
  const introMsgs = first.msgs.slice(0, first.intro);
  const lastMsg = first.msgs[first.msgs.length - 1];
  ok(introMsgs.every((m) => m.from === 'npc') && lastMsg?.from === 'quest' && lastMsg.questId === Q0, 'messages: intro bubbles → offer bubbles → quest card', JSON.stringify(first.msgs.map((m) => m.from)));
  const msgEv = await ev('npc:message');
  ok(msgEv.some((e) => e.npc === NPC0 && e.entry.e === 'intro') && msgEv.some((e) => e.npc === NPC0 && e.entry.e === 'offer' && e.entry.q === Q0), 'npc:message intro + offer');
  ok((await ev('npc:questChanged')).some((e) => e.id === Q0 && e.state === 'offered' && e.prev === null), 'npc:questChanged {offered, prev null}');
  ok(first.unread > 0, `unreadTotal ${first.unread} > 0`);
  const readRes = await P((n) => { const r = window.__game.ctx.meta.npc; r.markRead(n); return { contact: r.getContacts().find((c) => c.npc.id === n)?.unread, total: r.unreadTotal }; }, NPC0);
  ok(readRes.contact === 0 && readRes.total < first.unread, 'markRead → that contact 0 unread', JSON.stringify(readRes));
  ok((await ev('npc:unreadChanged')).length > 0, 'npc:unreadChanged emitted');
  ok(await P(() => window.__game.getSystem('meta').npcQuests.evaluate()) === false, 'a second evaluate adds nothing (one pending offer per NPC)');

  /* ── ② 「생각해볼게」 은퇴 · 수락 ─────────────────────────────────────────
   * 2026-09-14 3차 (사용자 결정): 선택지가 없어져 `defer()` 는 아무것도 하지 않는다 (계약에만 남는 이름).
   * 퀘스트 목록(`getQuests()`)도 `offered` 를 그리지 않는다 — 대화창 카드가 그 자리다. */
  console.log('② 「생각해보지」 은퇴 · 수락');
  const defer = await P((q) => {
    const r = window.__game.ctx.meta.npc;
    const okD = r.defer(q);
    const npc = r.getQuest(q).npc.id;
    return { okD, state: r.getQuest(q).state, tail: r.getMessages(npc).slice(-3),
      listed: r.getQuests().some((x) => x.def.id === q) };
  }, Q0);
  ok(defer.okD === false && defer.state === 'offered', 'defer() 는 은퇴했다 — 늘 false 이고 상태는 offered 그대로', JSON.stringify(defer));
  ok(!defer.tail.some((m) => m.from === 'me' && m.text === '생각해보지.'), '대화에 「생각해보지.」 가 붙지 않는다');
  ok(defer.listed === false, 'getQuests() 는 offered 를 그리지 않는다 (받은 것만 표시)');
  const reacc = await P((q) => {
    const r = window.__game.ctx.meta.npc;
    const okA = r.accept(q);
    return { okA, state: r.getQuest(q).state, listed: r.getQuests().some((x) => x.def.id === q), again: r.accept(q), deferActive: r.defer(q) };
  }, Q0);
  ok(reacc.okA && reacc.state === 'active' && reacc.listed, 'accept → active, 그때 비로소 퀘스트 목록에 뜬다', JSON.stringify(reacc));
  ok(reacc.again === false && reacc.deferActive === false, 'accept / defer on an active quest → false (no abandon path)');
  ok((await ev('npc:questChanged')).some((e) => e.id === Q0 && e.state === 'active' && e.prev === 'offered'), 'npc:questChanged {active, prev offered}');

  /* ── ③ 납품 · 보고 ─────────────────────────────────────────────────────── */
  console.log('③ 나눠 납품 · 완료 보고');
  const QD = await P(async () => {
    const sh = await import('/src/shared/index.ts');
    const q = sh.NPC_QUEST_DEFS.find((x) => x.objectives.length >= 2 && x.objectives.every((o) => o.kind === 'deliver' && !o.item.startsWith('weapon:')));
    return q ? { id: q.id, npc: q.npc, objs: q.objectives.map((o) => ({ item: o.item, target: o.target })), credits: q.rewards.credits, items: q.rewards.items } : null;
  });
  if (!QD) skipped('deliver quest', 'no all-deliver quest in the tables');
  else {
    await P((q) => { const r = window.__game.ctx.meta.npc; const sys = window.__game.getSystem('meta').npcQuests; if (!r.getQuest(q)) sys.forceOffer(q); if (r.getQuest(q).state !== 'active') r.accept(q); }, QD.id);
    await clearDefs([...QD.objs.map((o) => o.item), ...QD.items.map((i) => i.defId)]);
    const half = Math.max(1, Math.floor(QD.objs[0].target / 2));
    ok(await give(QD.objs[0].item, half) !== null, `gave ${QD.objs[0].item} ×${half}`);
    const d1 = await P((a) => { const r = window.__game.ctx.meta.npc; const n = r.deliver(a.id, 0); const q = r.getQuest(a.id); return { n, p: q.objectives[0].progress, done: q.objectives[0].done, ready: q.ready, blocked: q.blocked, report: r.report(a.id) }; }, QD);
    ok(d1.n === half && d1.p === half && !d1.done && !d1.ready, `partial deliver → ${half}/${QD.objs[0].target}`, JSON.stringify(d1));
    ok(d1.report === false && typeof d1.blocked === 'string' && d1.blocked.length > 0, 'report before every objective is filled → false with a reason', JSON.stringify(d1));
    ok(await P((a) => window.__game.ctx.meta.npc.getQuest(a.id).objectives[1].blocked, QD) !== null, 'nothing held → deliver button blocked');
    await give(QD.objs[0].item, QD.objs[0].target - half);
    for (let i = 1; i < QD.objs.length; i++) await give(QD.objs[i].item, QD.objs[i].target);
    await clearEv();
    const before = await P(() => ({ credits: window.__game.ctx.meta.credits, done: window.__game.getSystem('meta').store.data.stats.questsDone }));
    const d2 = await P((a) => { const r = window.__game.ctx.meta.npc; return a.objs.map((_, i) => r.deliver(a.id, i)); }, QD);
    ok(d2[0] === QD.objs[0].target - half && d2.slice(1).every((n, i) => n === QD.objs[i + 1].target), 'the rest delivered', JSON.stringify(d2));
    ok((await ev('npc:questReady')).some((e) => e.id === QD.id), 'npc:questReady once everything is in');
    const itemBefore = QD.items[0] ? await P((d) => window.__game.ctx.inventory.countDefAll(d), QD.items[0].defId) : 0;
    const rep = await P((a) => { const r = window.__game.ctx.meta.npc; const okR = r.report(a.id); const q = r.getQuest(a.id); const msgs = r.getMessages(a.npc); return { okR, state: q.state, sys: msgs[msgs.length - 1], credits: window.__game.ctx.meta.credits, done: window.__game.getSystem('meta').store.data.stats.questsDone }; }, QD);
    ok(rep.okR && rep.state === 'complete', 'report → complete', JSON.stringify(rep));
    ok(rep.credits === before.credits + QD.credits && rep.done === before.done + 1, `credits +${QD.credits} · questsDone +1`, JSON.stringify({ before, after: rep }));
    ok(rep.sys?.from === 'system' && rep.sys.text.startsWith('보상 —'), 'conversation ends with the reward system line', JSON.stringify(rep.sys));
    if (QD.items[0]) ok(await P((d) => window.__game.ctx.inventory.countDefAll(d), QD.items[0].defId) === itemBefore + QD.items[0].qty, `reward item ${QD.items[0].defId} ×${QD.items[0].qty}`);
    ok((await ev('npc:questChanged')).some((e) => e.id === QD.id && e.state === 'complete' && e.prev === 'active'), 'npc:questChanged {complete}');
    const next = await P(async (id) => {
      const sh = await import('/src/shared/index.ts');
      const r = window.__game.ctx.meta.npc;
      const nq = sh.NPC_QUEST_DEFS.find((x) => x.requires.quests?.length === 1 && x.requires.quests[0] === id && !x.requires.level && !x.requires.rep?.length);
      return nq ? { id: nq.id, state: r.getQuest(nq.id)?.state ?? null } : null;
    }, QD.id);
    if (next) ok(next.state === 'offered', `completing ${QD.id} unlocks the next offer ${next.id}`, JSON.stringify(next));
    else skipped('next offer', 'no quest requires only this one');
    ok(await P((a) => window.__game.ctx.meta.npc.report(a.id), QD) === false, 'a completed quest cannot be reported twice');
  }

  /* ── ④ 목표 문구 ──────────────────────────────────────────────────────── */
  console.log('④ 목표 문구');
  const labels = await P(async () => {
    const sh = await import('/src/shared/index.ts');
    const sys = window.__game.getSystem('meta').npcQuests;
    const weap = sh.NPC_QUEST_DEFS.find((q) => q.objectives.some((o) => o.kind === 'kill' && o.weapon && !o.planet));
    const plan = sh.NPC_QUEST_DEFS.find((q) => q.objectives.some((o) => o.planet));
    const lab = (q, pred) => { if (!q) return null; if (!sys.getQuest(q.id)) sys.forceOffer(q.id); const info = sys.getQuest(q.id); const i = q.objectives.findIndex(pred); return { label: info.objectives[i].label, planet: q.objectives[i].planet ? sh.planetLabel(q.objectives[i].planet) : null }; };
    return { weap: lab(weap, (o) => o.kind === 'kill' && o.weapon), plan: lab(plan, (o) => !!o.planet) };
  });
  if (labels.weap) ok(/(으로|로) .+ \d+(명|마리) 처치$/.test(labels.weap.label), `kill label: ${labels.weap.label}`);
  if (labels.plan) ok(labels.plan.label.startsWith(`${labels.plan.planet} · `), `planet label: ${labels.plan.label}`);

  /* ── ⑤ 레이드 목표 ─────────────────────────────────────────────────────── */
  console.log('⑤ 레이드 목표');
  const picks = await P(async () => {
    const sh = await import('/src/shared/index.ts');
    const defs = sh.NPC_QUEST_DEFS;
    const noPlanet = (q) => q.objectives.every((o) => !o.planet);
    const find = (pred) => defs.find((q) => pred(q))?.id ?? null;
    return {
      // kill with a weapon class + recover of that class
      kw: find((q) => noPlanet(q) && q.objectives.some((o) => o.kind === 'kill' && o.weapon && o.enemy === 'humanoid') && q.objectives.some((o) => o.kind === 'recover' && o.item.startsWith('weapon:'))),
      // interact + kill without a weapon
      ik: find((q) => noPlanet(q) && q.objectives.some((o) => o.kind === 'interact' && o.interact === 'scanner') && q.objectives.some((o) => o.kind === 'kill' && !o.weapon && o.enemy === 'humanoid')),
      // chains (discover + search) per site, no planet
      chains: defs.filter((q) => noPlanet(q) && q.objectives.some((o) => o.kind === 'discover' && o.chain) && q.objectives.some((o) => o.kind === 'search' && o.chain)).map((q) => ({ id: q.id, site: q.objectives.find((o) => o.kind === 'discover').site })),
      // planet-restricted kill (not amber)
      pl: find((q) => q.objectives.some((o) => o.kind === 'kill' && o.planet && o.planet !== 'amber')),
      // raider kill with SG, no planet (reset test)
      sg: find((q) => noPlanet(q) && q.objectives.some((o) => o.kind === 'kill' && o.weapon === 'SG')),
    };
  });
  ok(picks.kw && picks.ik && picks.sg, 'content has kill+weapon / interact+kill / shotgun-kill quests', JSON.stringify(picks));
  const accepted = await P((ids) => {
    const r = window.__game.ctx.meta.npc; const sys = window.__game.getSystem('meta').npcQuests;
    return ids.filter(Boolean).map((id) => { if (!r.getQuest(id)) sys.forceOffer(id); const q = r.getQuest(id); if (q.state !== 'active') r.accept(id); return [id, r.getQuest(id).state]; });
  }, [picks.kw, picks.ik, picks.pl, picks.sg, ...picks.chains.map((c) => c.id)]);
  ok(accepted.every(([, s]) => s === 'active'), 'raid quests accepted in the ship', JSON.stringify(accepted));
  ok(await P(() => window.__game.ctx.meta.npc.getRaidTracks().length) === 0, 'getRaidTracks() is empty in the ship');

  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 7, planet: 'amber' }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 60000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 20000);
  await P(() => { const ctx = window.__game.ctx; ctx.enemies.killAll(); ctx.enemies.setThreatLevel(0); if (!ctx.missionPlanet) ctx.missionPlanet = 'amber'; });
  await waitSim(0.3);
  await clearEv();
  const tracks = await P((pl) => { const t = window.__game.ctx.meta.npc.getRaidTracks().map((q) => q.def.id); return { t, planet: window.__game.ctx.missionPlanet, hasPl: pl ? t.includes(pl) : null }; }, picks.pl);
  ok(tracks.t.includes(picks.kw) && tracks.t.includes(picks.ik), 'getRaidTracks() lists the raid quests', JSON.stringify(tracks));
  if (picks.pl) ok(tracks.hasPl === false, `the ${picks.pl} quest (other planet) is not tracked on ${tracks.planet}`, JSON.stringify(tracks));

  const kwInfo = await quest(picks.kw);
  const kwKill = kwInfo.def.objectives.findIndex((o) => o.kind === 'kill');
  const kwRec = kwInfo.def.objectives.findIndex((o) => o.kind === 'recover');
  const kwClass = kwInfo.def.objectives[kwKill].weapon;
  const kwTarget = kwInfo.def.objectives[kwKill].target;
  const kill = (arg) => P((a) => { const c = window.__game.ctx; for (let i = 0; i < a.n; i++) c.bus.emit('enemy:killed', { id: 900000 + Math.floor(Math.random() * 1e5), type: a.type, position: c.player.position.clone(), by: a.by, weaponClass: a.cls }); }, arg);
  await kill({ n: 2, type: 'raider', by: 'local', cls: null });
  ok((await quest(picks.kw)).objectives[kwKill].progress === 0, 'kills with no weapon class do not count for a class objective');
  await kill({ n: 3, type: 'raider', by: 'somePeer', cls: kwClass });
  ok((await quest(picks.kw)).objectives[kwKill].progress === 0, "a squad-mate's kill does not count");
  await kill({ n: kwTarget, type: 'raider', by: 'local', cls: kwClass });
  const kwAfter = await quest(picks.kw);
  ok(kwAfter.objectives[kwKill].done && kwAfter.objectives[kwKill].progress === kwTarget, `${kwTarget} ${kwClass} kills → confirmed at once`, JSON.stringify(kwAfter.objectives[kwKill]));
  ok((await ev('npc:objectiveProgress')).some((e) => e.questId === picks.kw && e.index === kwKill && e.done), 'npc:objectiveProgress {done:true} on the confirm');
  const ikInfo = await quest(picks.ik);
  const ikKill = ikInfo.def.objectives.findIndex((o) => o.kind === 'kill');
  ok(ikInfo.objectives[ikKill].progress >= Math.min(ikInfo.objectives[ikKill].target, kwTarget + 2), 'the same kills also fed the plain humanoid objective', JSON.stringify(ikInfo.objectives[ikKill]));
  if (picks.pl) ok((await quest(picks.pl)).objectives.every((o) => o.progress === 0), 'the other-planet quest counted nothing');

  // 실제 배관: withLocalGunHit → takeDamage → enemy:killed.weaponClass
  const plumb = await P(async () => {
    const ctx = window.__game.ctx;
    const es = window.__game.getSystem('enemies');
    const ds = await import('/src/shared/damageSource.ts');
    const p = ctx.player.position;
    const at = (dx) => ({ x: p.x + dx, z: p.z + 12 });
    const out = {};
    window.__ev['enemy:killed'] = [];
    const a = es.debugSpawn('raider', at(4));
    if (!a) return { error: 'debugSpawn failed' };
    ds.withLocalGunHit('SG', () => a.takeDamage(1e7, a.position.clone()));
    out.gun = window.__ev['enemy:killed'].find((e) => e.id === a.id)?.weaponClass;
    const b = es.debugSpawn('raider', at(-4));
    b.takeDamage(1e7);
    out.plain = window.__ev['enemy:killed'].find((e) => e.id === b.id)?.weaponClass;
    const c = es.debugSpawn('raider', at(0));
    ds.withLocalGunHit('AR', () => c.takeDamage(1));
    c.applyDot(1e7, 'local');
    out.dot = window.__ev['enemy:killed'].find((e) => e.id === c.id)?.weaponClass;
    out.scopeAfter = ds.localGunHitClass();
    return out;
  });
  ok(plumb.gun === 'SG', 'real kill inside withLocalGunHit(SG) → enemy:killed.weaponClass SG', JSON.stringify(plumb));
  ok(plumb.plain === null && plumb.dot === null && plumb.scopeAfter === null, 'no scope → null · a DoT finishing blow → null · scope restored', JSON.stringify(plumb));

  // 상호작용: 실제 스캐너 → world:interacted, 그리고 목표
  const ikInt = ikInfo.def.objectives.findIndex((o) => o.kind === 'interact');
  const scan = await P(() => {
    const it = window.__game.ctx.interactables.all().find((i) => /^struct:.+:scan$/.test(i.id));
    if (!it) return null;
    window.__ev['world:interacted'] = [];
    it.interact();
    return window.__ev['world:interacted'];
  });
  if (scan === null) {
    skipped('real scanner interaction', 'no scanner on seed 7');
    await P(() => window.__game.ctx.bus.emit('world:interacted', { kind: 'scanner', id: 'smoke' }));
  } else ok(scan.some((e) => e.kind === 'scanner'), 'a real scanner interaction emits world:interacted {scanner}', JSON.stringify(scan));
  const ikAfter = await quest(picks.ik);
  ok(ikAfter.objectives[ikInt].done, 'interact objective confirmed', JSON.stringify(ikAfter.objectives[ikInt]));
  if (ikAfter.objectives.every((o) => o.done)) ok((await ev('npc:questReady')).some((e) => e.id === picks.ik), `${picks.ik} ready (npc:questReady)`);

  // 발견 + 조사 chain
  const chain = await P((chains) => {
    const ctx = window.__game.ctx;
    const sts = ctx.world.getStructures();
    for (const c of chains) { const st = sts.find((s) => s.kind === c.site); if (st) return { quest: c.id, site: c.site, st: st.id }; }
    return null;
  }, picks.chains);
  if (!chain) skipped('discover + search chain', 'no structure of a chained site on seed 7');
  else {
    const cinfo = await quest(chain.quest);
    const di = cinfo.def.objectives.findIndex((o) => o.kind === 'discover');
    const si = cinfo.def.objectives.findIndex((o) => o.kind === 'search');
    const sTarget = cinfo.def.objectives[si].target;
    await P((a) => window.__game.ctx.bus.emit('fog:discovered', { kind: 'structure', id: a.st, position: window.__game.ctx.player.position.clone() }), chain);
    let c1 = await quest(chain.quest);
    ok(c1.objectives[di].progress === 1 && !c1.objectives[di].done, 'discover filled but not confirmed while its chain partner is empty', JSON.stringify(c1.objectives[di]));
    const real = await P((a) => {
      const ctx = window.__game.ctx;
      // 구조물 컨테이너의 상호작용 id = `container:<구조물 id>_<c|b|l><n>` (world/structures/parts/Containers)
      const it = ctx.interactables.all().find((i) => i.id.startsWith(`container:${a.st}_`) && typeof i.interact === 'function');
      if (!it) return null;
      window.__ev['crate:open'] = [];
      it.interact();
      window.__game.ctx.inventory.closeAll?.();
      return window.__ev['crate:open'].map((e) => ({ id: e.crateId, zoneKind: e.zoneKind ?? null, zoneId: e.zoneId ?? null }));
    }, chain);
    let opened = 0;
    if (real && real.length) {
      ok(real[0].zoneKind === chain.site && real[0].zoneId === chain.st, 'a real structure container emits crate:open with zoneId / zoneKind', JSON.stringify(real));
      opened = 1;
    } else skipped('real container open', 'no container interactable found');
    // the same container again does not count; distinct ones do
    await P((a) => { const b = window.__game.ctx.bus; b.emit('crate:open', { crateId: 'smoke-c0', tier: 1, position: window.__game.ctx.player.position.clone(), zoneId: a.st, zoneKind: a.site }); b.emit('crate:open', { crateId: 'smoke-c0', tier: 1, position: window.__game.ctx.player.position.clone(), zoneId: a.st, zoneKind: a.site }); }, chain);
    c1 = await quest(chain.quest);
    ok(c1.objectives[si].progress === opened + 1, `re-opening a container counts once (${c1.objectives[si].progress})`, JSON.stringify(c1.objectives[si]));
    await P((a) => { const b = window.__game.ctx.bus; for (let i = 1; i < a.n; i++) b.emit('crate:open', { crateId: `smoke-c${i}`, tier: 1, position: window.__game.ctx.player.position.clone(), zoneId: a.st, zoneKind: a.site }); }, { ...chain, n: sTarget });
    c1 = await quest(chain.quest);
    ok(c1.objectives[di].done && c1.objectives[si].done, 'the last search confirms discover + search together', JSON.stringify(c1.objectives));
  }

  // 회수: 이 레이드에서 얻은 계열 총기
  const recDef = await P((cls) => {
    const l = window.__game.ctx.loot;
    return l.getAllItemDefs().find((d) => d.weaponId && !d.retired && l.getWeaponDef(d.weaponId)?.weaponClass === cls && !l.getWeaponDef(d.weaponId)?.unique)?.id ?? null;
  }, kwInfo.def.objectives[kwRec].item.slice('weapon:'.length));
  ok(!!recDef, `a ${kwClass} weapon def exists (${recDef})`);
  const rec = await P((d) => {
    const ctx = window.__game.ctx;
    const seed = ctx.world.seed >>> 0;
    const brought = ctx.loot.createItem(d, 1);
    const found = ctx.loot.createItem(d, 1); found.raidFound = seed;
    const a = ctx.inventory.tryAddItemAnywhere(brought), b = ctx.inventory.tryAddItem(found) ? 'bag' : null;
    return { a, b, uid: found.uid };
  }, recDef);
  ok(rec.b === 'bag', 'a raid-found weapon in the bag (+ a brought one)', JSON.stringify(rec));
  await waitSim(0.1);
  const rec1 = (await quest(picks.kw)).objectives[kwRec];
  ok(rec1.progress === 1 && !rec1.done, 'recover shows 1 (found only) but is not confirmed before extraction', JSON.stringify(rec1));

  // 레이드 끝 되돌림 대상: SG 킬 일부
  const sgInfo = await quest(picks.sg);
  const sgKill = sgInfo.def.objectives.findIndex((o) => o.kind === 'kill' && o.weapon === 'SG');
  const sgEnemy = sgInfo.def.objectives[sgKill].enemy === 'humanoid' ? 'raider' : sgInfo.def.objectives[sgKill].enemy === 'bug' ? 'warrior' : (sgInfo.def.objectives[sgKill].enemy === 'named' ? 'rogue_heavy' : sgInfo.def.objectives[sgKill].enemy);
  const sgBefore = (await quest(picks.sg)).objectives[sgKill].progress;
  await kill({ n: 2, type: sgEnemy, by: 'local', cls: 'SG' });
  const sgMid = (await quest(picks.sg)).objectives[sgKill];
  ok(sgMid.progress === Math.min(sgMid.target, sgBefore + 2) && !sgMid.done, `SG kills in progress (${sgMid.progress}/${sgMid.target})`, JSON.stringify(sgMid));

  // 탈출 정산
  await clearEv();
  await P(() => window.__game.ctx.meta.settleMission({ ...window.__game.ctx.stats, extracted: true, mode: 'raid' }));
  const kwSettled = await quest(picks.kw);
  ok(kwSettled.objectives[kwRec].done, 'extraction settlement confirms the recover objective', JSON.stringify(kwSettled.objectives[kwRec]));
  ok(kwSettled.ready && (await ev('npc:questReady')).some((e) => e.id === picks.kw), `${picks.kw} ready after extraction`);
  await P(() => { const ctx = window.__game.ctx; ctx.bus.emit('game:complete', { stats: { ...ctx.stats, extracted: true } }); });
  const resetEv = (await ev('npc:objectiveProgress')).filter((e) => e.questId === picks.sg && e.index === sgKill);
  const sgSave = await P((a) => window.__game.getSystem('meta').npcQuests.save.quests[a.q].p[a.i], { q: picks.sg, i: sgKill });
  ok(resetEv.some((e) => e.progress === 0 && e.delta < 0) && sgSave === 0 && await P(() => window.__game.getSystem('meta').npcQuests.raidProgress.size) === 0,
    'game:complete rolls unconfirmed progress back to 0 (negative delta), confirmed stays', JSON.stringify({ resetEv, sgSave }));
  ok((await quest(picks.kw)).objectives.every((o) => o.done), 'confirmed objectives survive the raid end');

  await P(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitFor(page, () => window.__game.ctx.phase === 'menu', 'abort', 20000);
  await enterHub();
  await P((uid) => window.__game.ctx.inventory.takeItem?.(uid), rec.uid);

  /* ── ⑥ 보고 · 채굴 인가 ──────────────────────────────────────────────── */
  console.log('⑥ 함선 보고 · 채굴 인가');
  const repKw = await P((id) => { const r = window.__game.ctx.meta.npc; return { ok: r.report(id), state: r.getQuest(id).state }; }, picks.kw);
  ok(repKw.ok && repKw.state === 'complete', `report ${picks.kw} in the ship`, JSON.stringify(repKw));
  const permit = await P(async () => {
    const sh = await import('/src/shared/index.ts');
    const coin = sh.CRYPTO_COIN_DEFS.find((c) => c.unlockQuest && sh.NPC_QUEST_MAP.has(c.unlockQuest));
    if (!coin) return null;
    const id = coin.unlockQuest;
    const m = window.__game.ctx.meta; const sys = window.__game.getSystem('meta').npcQuests;
    const states = [m.getQuestState(id)];
    if (!sys.getQuest(id)) sys.forceOffer(id);
    states.push(m.getQuestState(id));
    sys.accept(id);
    states.push(m.getQuestState(id));
    sh.NPC_QUEST_MAP.get(id).objectives.forEach((o, i) => sys.devProgress(id, i, o.target));
    const reported = sys.report(id);
    states.push(m.getQuestState(id));
    const coins = window.__game.ctx.housing?.getCryptoCoins?.();
    return { id, coin: coin.id, states, reported, unlocked: coins ? coins.find((c) => c.def.id === coin.id)?.unlocked ?? null : 'n/a' };
  });
  if (!permit) skipped('mining permit', 'no coin unlock quest in the tables');
  else {
    ok(permit.states.join(',') === 'locked,available,accepted,complete' && permit.reported, `getQuestState(${permit.id}) locked → available → accepted → complete`, JSON.stringify(permit));
    if (permit.unlocked !== 'n/a') ok(permit.unlocked === true, `coin ${permit.coin} unlocked by the NPC permit quest`, JSON.stringify(permit));
  }

  /* ── ⑦ 저장 · 새로고침 · 정리 ────────────────────────────────────────── */
  console.log('⑦ 저장 · 새로고침');
  const snap = await P((n) => { const r = window.__game.ctx.meta.npc; window.__game.ctx.meta.save(); return { msgs: r.getMessages(n).length, quests: r.getQuests().map((q) => `${q.def.id}:${q.state}`).sort(), unread: r.unreadTotal }; }, NPC0);
  const saved = await P(() => { try { return JSON.parse(localStorage.getItem('scav.s1.meta')); } catch { return null; } });
  // 2026-09-14 3차: `getQuests()` 는 offered 를 빼므로 저장된 퀘스트 수는 그보다 **크거나 같다**
  ok(saved && saved.v === 2 && saved.npc && Object.keys(saved.npc.quests).length >= snap.quests.length && Array.isArray(saved.npc.log[NPC0]), 'localStorage meta v2 carries npc contacts / log / quests',
    JSON.stringify(saved && { v: saved.v, quests: Object.keys(saved.npc?.quests ?? {}).length }));
  await page.reload({ waitUntil: 'load' });
  await boot();
  const after = await P((n) => { const r = window.__game.ctx.meta.npc; return { msgs: r.getMessages(n).length, quests: r.getQuests().map((q) => `${q.def.id}:${q.state}`).sort(), unread: r.unreadTotal }; }, NPC0);
  ok(after.msgs === snap.msgs && after.quests.join('|') === snap.quests.join('|') && after.unread === snap.unread, 'reload restores the conversation, quest states and unread count', JSON.stringify({ snap, after }));

  await sleep(600);
  await P((a) => {
    const raw = JSON.parse(localStorage.getItem('scav.s1.meta'));
    raw.npc = {
      contacts: { nope: { at: 1 }, [a.npc]: { at: 'x', readAt: -5 } },
      quests: { zzz: { s: 'active', at: 1, p: [] }, [a.q0]: { s: 'bogus', at: 1, p: [] }, [a.kw]: { s: 'active', at: 1, p: [999, -3, 'x'] } },
      log: { [a.npc]: [{ at: 1, e: 'weird' }, { at: 2, e: 'offer', q: 'zzz' }, { at: 3, e: 'intro' }], nope: [{ at: 1, e: 'intro' }] },
    };
    localStorage.setItem('scav.s1.meta', JSON.stringify(raw));
  }, { npc: NPC0, q0: Q0, kw: picks.kw });
  await page.reload({ waitUntil: 'load' });
  await boot();
  const san = await P((a) => {
    const s = window.__game.getSystem('meta').npcQuests.save;
    const kw = s.quests[a.kw];
    return { contacts: Object.keys(s.contacts).sort(), readAt: s.contacts[a.npc]?.readAt, quests: Object.keys(s.quests).sort(), kw, log: s.log[a.npc], nopeLog: !!s.log.nope, phase: window.__game.ctx.phase };
  }, { npc: NPC0, kw: picks.kw });
  const kwTargets = kwInfo.def.objectives.map((o) => o.target);
  ok(!san.contacts.includes('nope') && san.contacts.includes(NPC0) && san.readAt === 0, 'unknown NPC dropped, bad numbers → 0', JSON.stringify(san));
  ok(san.quests.length === 1 && san.quests[0] === picks.kw && san.kw.p[0] === kwTargets[0] && san.kw.p.slice(1).every((v) => v === 0), 'unknown / bad-state quests dropped, progress clamped to [0, target]', JSON.stringify(san));
  ok(Array.isArray(san.log) && san.log.length === 1 && san.log[0].e === 'intro' && !san.nopeLog, 'log keeps only valid entries of contacted NPCs', JSON.stringify(san.log));

  const relevant = errors.filter((e) => !/WebSocket|ERR_CONNECTION|favicon|net::/i.test(e));
  ok(relevant.length === 0, 'no console errors', relevant.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e?.stack ?? e}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\nsmoke-npc-quests: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail > 0 ? 1 : 0);
