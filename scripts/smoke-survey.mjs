// 2026-09-21 (agent SURVEY-SMOKE) — the survey camera (`src/survey`, `weapons/parts/SurveyHand`, `data/survey_*.csv`).
//   ① unlock line in the ship: Raven `q_rv_1` complete → `npc_yoon_sia` contact → `q_at_1` offered → mail
//      `npc:npc_yoon_sia:q_at_1` carries `cam_survey_1` → claimed into the stash; `atlas` is off the corp rail
//   ② raid 1: the camera in a quick slot, in hand → `ctx.survey.active`, the frame HUD up, the reticle's dot + `×1 · %` hidden
//   ③ LMB held on a pinned scavenger → progress at `speedMul / seconds`; a second scavenger in the frame adds nothing
//      (one tick per kind); no `weapon:fired`; durability drops by the recorded seconds
//   ④ an empty frame gains nothing and wears nothing; the raid cap stops the gain (tag `이번 레이드 한도`, toast)
//   ⑤ RMB = zoom: R / E step `ctx.survey.zoom` inside 2..8, no reload starts, no interaction runs; a body crossing the
//      zoomed frame's border (`프레임 밖`) gains nothing
//   ⑥ `raidGains()` lists the subject; raid end stamps the planet into the saved record (`scav.s1.survey`)
//   ⑦ raid 2 on the same planet: `raidGains()` was cleared on `game:newMission`, the rate is ×`SURVEY_REPEAT_PLANET_MUL`;
//      recording to 100 % fills `q_at_1`'s objective; back in the ship the report opens `atlas` on the corp rail
//   ⑧ the quest card tags a survey objective `조사`; reload keeps the progress
// Usage: node scripts/smoke-survey.mjs [http://localhost:5273]   (needs `npm run dev`)
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

const SUBJ = 'sv_scavenger';
const MAIL_ID = 'npc:npc_yoon_sia:q_at_1';

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
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const P = (fn, arg) => page.evaluate(fn, arg);
  const boot = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.survey && !!window.__game.ctx.meta?.npc, 'boot');
    await P(() => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      window.__ev = { fired: 0, reload: 0, interact: 0, notify: [], progress: [] };
      const bus = window.__game.ctx.bus;
      bus.on('weapon:fired', () => { window.__ev.fired++; });
      bus.on('weapon:reloadStarted', () => { window.__ev.reload++; });
      bus.on('interact:performed', () => { window.__ev.interact++; });
      bus.on('ui:notify', (m) => { window.__ev.notify.push(m.text); });
      bus.on('survey:progress', (m) => { window.__ev.progress.push(m); });
    });
  };
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const tap = (code) => P((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const mDown = (b) => P((x) => document.body.dispatchEvent(new MouseEvent('mousedown', { button: x, bubbles: true })), b);
  const mUp = (b) => P((x) => document.body.dispatchEvent(new MouseEvent('mouseup', { button: x, bubbles: true })), b);
  const enterHub = async () => {
    await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
    await waitSim(0.5);
  };
  const startRaid = async (seed, planet) => {
    await P((a) => { const ctx = window.__game.ctx; ctx.missionMode = 'raid'; ctx.missionPlanet = a.planet; ctx.bus.emit('game:newMission', { seed: a.seed, mode: 'raid', planet: a.planet }); }, { seed, planet });
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
    await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
    await waitSim(0.3);
    await P(() => { const ctx = window.__game.ctx; ctx.enemies.killAll(); ctx.enemies.setThreatLevel(0); ctx.player.heal(1000); });
  };
  /** Survey state for SUBJ (+ the camera instance). */
  const sv = () => P((a) => {
    const ctx = window.__game.ctx, s = window.__game.getSystem('survey'), h = ctx.weapons.surveyHand;
    const e = s.views.get(a.id);
    const inst = h.uid ? ctx.inventory.findItem(h.uid) : null;
    const tag = [...document.querySelectorAll('.sv-tag.is-on')].map((t) => ({ name: t.querySelector('.sv-tag-name')?.textContent, note: t.querySelector('.sv-tag-note')?.textContent }));
    return {
      t: ctx.time, p: ctx.survey.progressOf(a.id), raid: s.raidGained.get(a.id) ?? 0, active: ctx.survey.active, zoom: ctx.survey.zoom,
      status: e && e.stamp === s.stamp ? e.status : 0, dur: inst?.durability ?? null, trigger: h.trigger, aimed: h.aimed,
      aiming: ctx.player.isAiming, tags: tag,
    };
  }, { id: SUBJ });

  await page.goto(BASE, { waitUntil: 'load' });
  await boot();
  const planet = await P(async () => (await import('/src/shared/index.ts')).PLANET_IDS[0]);

  /* ── ① the unlock line ─────────────────────────────────────────────── */
  console.log('① 레이븐 q_rv_1 → 윤시아 연락 → q_at_1 제안 + 우편 카메라');
  await enterHub();
  const rv = await P(async () => {
    const sh = await import('/src/shared/index.ts');
    const r = window.__game.ctx.meta.npc, sys = window.__game.getSystem('meta').npcQuests;
    if (!sys.getQuest('q_rv_1')) sys.forceOffer('q_rv_1');
    r.accept('q_rv_1');
    sh.NPC_QUEST_MAP.get('q_rv_1').objectives.forEach((o, i) => sys.devProgress('q_rv_1', i, o.target));
    const rep = r.report('q_rv_1');
    return { rep, state: r.getQuest('q_rv_1')?.state, blocked: r.getQuest('q_rv_1')?.blocked ?? null };
  });
  ok(rv.rep && rv.state === 'complete', 'q_rv_1 reported complete (console-style offer · accept · progress · report)', JSON.stringify(rv));
  const contact = await P(() => {
    const r = window.__game.ctx.meta.npc, sys = window.__game.getSystem('meta').npcQuests;
    sys.evaluate();
    const has = r.getContacts().some((c) => c.npc.id === 'npc_yoon_sia');
    const choices = r.getPendingChoices('npc_yoon_sia').length;
    if (choices > 0) r.chooseIntro('npc_yoon_sia', 0);
    sys.evaluate();
    const mail = window.__game.ctx.meta.mail.list().find((m) => m.id === 'npc:npc_yoon_sia:q_at_1');
    return { has, choices, q: r.getQuest('q_at_1')?.state ?? null, mail: mail ? { from: mail.from, items: mail.items, claimed: mail.claimed } : null };
  });
  ok(contact.has, 'evaluate() after q_rv_1 → npc_yoon_sia contacts', JSON.stringify(contact));
  ok(contact.q === 'offered', 'q_at_1 offered once the intro choice is answered', JSON.stringify(contact));
  ok(!!contact.mail && contact.mail.from === 'npc_yoon_sia' && contact.mail.items.length === 1 && contact.mail.items[0].defId === 'cam_survey_1' && contact.mail.items[0].qty === 1,
    `the offer mails ${MAIL_ID} with one cam_survey_1`, JSON.stringify(contact.mail));
  const resend = await P(() => window.__game.getSystem('meta').npcQuests.forceOffer('q_at_1'));
  const mailCount = await P((id) => window.__game.ctx.meta.mail.list().filter((m) => m.id === id).length, MAIL_ID);
  ok(resend === false && mailCount === 1, 'a second offer attempt mails nothing more', JSON.stringify({ resend, mailCount }));
  const claim = await P((id) => {
    const ctx = window.__game.ctx;
    const before = ctx.inventory.getStashItems().filter((i) => i.defId === 'cam_survey_1').length;
    const r = ctx.meta.mail.claim(id);
    const after = ctx.inventory.getStashItems().filter((i) => i.defId === 'cam_survey_1').length;
    return { r, before, after, claimed: ctx.meta.mail.list().find((m) => m.id === id)?.claimed };
  }, MAIL_ID);
  ok(claim.r === 'ok' && claim.after === claim.before + 1 && claim.claimed === true, 'claiming the mail puts the camera into the stash', JSON.stringify(claim));
  const accepted = await P(() => { const r = window.__game.ctx.meta.npc; return { ok: r.accept('q_at_1'), state: r.getQuest('q_at_1')?.state, ready: r.getQuest('q_at_1')?.ready }; });
  ok(accepted.ok && accepted.state === 'active' && !accepted.ready, 'q_at_1 accepted, not ready yet', JSON.stringify(accepted));
  const corpTab = () => P(() => {
    const meta = window.__game.ctx.meta;
    meta.openCorpMenu();
    const tab = document.querySelector('.corp-tab[data-corp="atlas"]');
    const res = { exists: !!tab, hidden: tab ? tab.hidden : null, state: meta.getQuestState('q_at_1') };
    return res;
  });
  const closeMenus = async () => { for (let i = 0; i < 3; i++) { if (await P(() => window.__game.ctx.uiBlockers.size === 0)) break; await tap('Escape'); await waitSim(0.2); } };
  // the 기업 tab opens only once some corp is at access level — lift helix (rep only) so the rail exists at all
  await P(() => { const m = window.__game.getSystem('meta'); if (m.getRep('helix').level < 1) m.addRep('helix', 500, 'console'); });
  const rail0 = await corpTab();
  await closeMenus();
  ok(rail0.exists && rail0.hidden === true, 'atlas is off the corp rail before q_at_1 is complete', JSON.stringify(rail0));
  // ⑧ (part) the quest card tag — a survey objective reads `조사`, not `함선`
  const card = await P(async () => {
    const m = await import('/src/ui/menus/messenger/QuestCard.ts');
    const q = window.__game.ctx.meta.npc.getQuest('q_at_1');
    const el = m.buildQuestCard(window.__game.ctx, q, 'detail', {});
    return [...el.querySelectorAll('.ms-qobj')].map((r) => ({ kind: r.dataset.kind, tag: r.querySelector('.ms-qokind')?.textContent }));
  });
  ok(card.length === 1 && card[0].kind === 'survey' && card[0].tag === '조사', 'QuestCard tags the survey objective 조사', JSON.stringify(card));

  /* ── ② raid 1 · the camera in hand ─────────────────────────────────── */
  console.log('② 레이드 1 — 카메라를 손에');
  await startRaid(11, planet);
  const cam = await P(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const it = ctx.loot.createItem('cam_survey_1', 1);
    inv.tryAddItem(it);
    const moved = inv.setQuickSlot(0, it.uid);
    window.__game.getSystem('weapons').equipQuick(0);
    return { moved, uid: it.uid, max: ctx.loot.getItemDef('cam_survey_1').durabilityMax };
  });
  ok(cam.moved, 'cam_survey_1 goes into quick slot 0', JSON.stringify(cam));
  await waitSim(0.6);
  const hand = await P(() => {
    const ctx = window.__game.ctx, hud = window.__game.getSystem('hud');
    const ret = hud?.reticle ?? hud?.hud?.reticle ?? null;
    const dot = document.querySelector('.reticle .dot'), qi = document.querySelector('.reticle .qinfo');
    return {
      held: ctx.weapons.remoteState.heldItemId, active: ctx.survey.active, hand: ctx.weapons.surveyHand.active,
      hud: !!document.querySelector('.sv-hud.is-on'), dotVis: dot ? getComputedStyle(dot).visibility : null, qVis: qi ? getComputedStyle(qi).visibility : null,
      retHidden: ret ? ret.surveyHidden : 'n/a',
    };
  });
  ok(hand.held === 'cam_survey_1' && hand.hand && hand.active && hand.hud, 'camera in hand → surveyHand.active · ctx.survey.active · .sv-hud.is-on', JSON.stringify(hand));
  ok(hand.dotVis === 'hidden' && hand.qVis === 'hidden' && hand.retHidden !== false, 'reticle dot and ×1 · % readout hidden while the survey frame is up', JSON.stringify(hand));

  /* ── ③ recording a pinned scavenger ────────────────────────────────── */
  console.log('③ 스캐빈저 기록 · 종류당 한 틱 · 내구도');
  const setup = await P(() => {
    const ctx = window.__game.ctx, world = ctx.world, es = window.__game.getSystem('enemies'), p = ctx.player.position;
    const V = p.constructor;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = p.x + Math.cos(a) * 12, z = p.z + Math.sin(a) * 12;
      if (!world.isInsideBounds(x, z)) continue;
      const y = world.getHeightAt(x, z);
      if (Math.abs(y - p.y) > 1.5) continue;
      const from = new V(p.x, p.y + 1.6, p.z), to = new V(x, y + 0.5, z);
      const dir = to.clone().sub(from); const d = dir.length(); dir.normalize();
      const hit = world.raycast(from, dir, d);
      if (hit && hit.distance < d - 0.6) continue;
      const e = es.debugSpawn('scavenger', { x, z }, false);
      if (!e) return { err: 'spawn failed' };
      window.__pin = { e, x, y: e.position.y, z, e2: null };
      window.__aim = { dy: 0, dp: 0, on: true };
      clearInterval(window.__pinT);
      window.__pinT = setInterval(() => {
        const pin = window.__pin; if (!pin) return;
        pin.e.position.set(pin.x, pin.y, pin.z);
        if (pin.e2) pin.e2.position.set(pin.x2, pin.y, pin.z2);
        const c = window.__game.ctx; c.player.heal?.(1000);
        if (!window.__aim.on) return;
        const rig = window.__game.getSystem('player').rig;
        const t = new V(pin.x, pin.y + pin.e.height * 0.5, pin.z).sub(c.camera.position).normalize();
        rig.yaw = Math.atan2(-t.x, -t.z) + window.__aim.dy; rig.pitch = Math.asin(t.y) + window.__aim.dp;
      }, 10);
      return { x, z, r: e.radius, h: e.height, type: e.type };
    }
    return { err: 'no clear spot' };
  });
  ok(!setup.err, 'a scavenger pinned 12 m away with a clear line', JSON.stringify(setup));
  if (setup.err) throw new Error(setup.err);
  await waitSim(0.4);
  const s0 = await sv();
  ok(s0.status === 2 && s0.tags.some((t) => t.name === '스캐빈저'), 'the scavenger is inside the frame (status 2) with its tag', JSON.stringify(s0));
  const fired0 = await P(() => window.__ev.fired);
  await mDown(0);
  await waitSim(0.3);
  const a0 = await sv();
  await waitSim(2);
  const a1 = await sv();
  await mUp(0);
  await waitSim(0.2);
  const aUp = await sv();
  const rate1 = (a1.p - a0.p) / (a1.t - a0.t);
  const expect = 1 / 40;   // cam_survey_1 speedMul 1 · sv_scavenger 40 s (data/survey_*.csv)
  ok(a0.trigger === true && aUp.trigger === false && a0.tags.some((t) => t.note === '기록 중') && !aUp.tags.some((t) => t.note === '기록 중'),
    'LMB held → surveyHand.trigger + tag 기록 중; released → neither', JSON.stringify({ a0, aUp }));
  ok(a1.p > a0.p && rate1 > expect * 0.85 && rate1 < expect * 1.1, `progress rises at speedMul/seconds (${rate1.toFixed(4)}/s ≈ ${expect})`, JSON.stringify({ a0, a1 }));
  ok(await P(() => window.__ev.fired) === fired0, 'LMB with the camera fires nothing');
  const durNow = await P((u) => window.__game.ctx.inventory.findItem(u)?.durability, cam.uid);
  ok(typeof durNow === 'number' && durNow < cam.max && cam.max - durNow <= 4, `durability dropped while recording (${cam.max} → ${durNow})`);
  ok(await P((id) => window.__ev.progress.some((m) => m.subjectId === id && m.percent >= 1), SUBJ), 'survey:progress emitted on whole-percent steps');

  // one tick per kind — a second scavenger beside the first
  const two = await P(() => {
    const es = window.__game.getSystem('enemies'), pin = window.__pin;
    const e2 = es.debugSpawn('scavenger', { x: pin.x + 1.2, z: pin.z }, false);
    if (!e2) return false;
    pin.e2 = e2; pin.x2 = pin.x + 1.2; pin.z2 = pin.z;
    return true;
  });
  ok(two, 'a second scavenger pinned beside the first');
  await waitSim(0.3);
  await mDown(0);
  await waitSim(0.3);
  const b0 = await sv();
  await waitSim(2);
  const b1 = await sv();
  await mUp(0);
  const rate2 = (b1.p - b0.p) / (b1.t - b0.t);
  ok(rate2 > expect * 0.85 && rate2 < expect * 1.1, `two scavengers in the frame record exactly as fast as one (${rate2.toFixed(4)}/s)`, JSON.stringify({ b0, b1 }));

  /* ── ④ empty frame · raid cap ──────────────────────────────────────── */
  console.log('④ 빈 프레임 · 레이드 한도');
  await P(() => { window.__aim.dy = Math.PI; window.__aim.dp = 0.25; });
  await waitSim(0.4);
  const c0 = await sv();
  await mDown(0);
  await waitSim(1.5);
  const c1 = await sv();
  await mUp(0);
  ok(c0.status === 0 && c1.p === c0.p && c1.dur === c0.dur, 'an empty frame gains nothing and wears nothing', JSON.stringify({ c0, c1 }));
  await P(() => { window.__aim.dy = 0; window.__aim.dp = 0; });
  await waitSim(0.4);
  const cap = await P((id) => { const s = window.__game.getSystem('survey'); const def = s.views.get(id).subject; s.raidGained.set(id, def.raidCap - 0.01); s.gainsDirty = true; window.__ev.notify = []; return def.raidCap; }, SUBJ);
  await mDown(0);
  await waitSim(1.2);
  const d0 = await sv();
  await waitSim(1);
  const d1 = await sv();
  await mUp(0);
  ok(Math.abs(d1.raid - cap) < 1e-6 && d1.p === d0.p, `the raid cap (${cap}) stops the gain`, JSON.stringify({ d0, d1 }));
  ok(d1.dur === d0.dur, 'a capped subject wears the camera no more', JSON.stringify({ d0: d0.dur, d1: d1.dur }));
  ok(d1.tags.some((t) => t.name === '스캐빈저' && t.note === '이번 레이드 한도'), 'the tag reads 이번 레이드 한도', JSON.stringify(d1.tags));
  ok(await P(() => window.__ev.notify.some((t) => t.includes('이번 레이드 조사 한도'))), 'the cap toast went out once');

  /* ── ⑤ zoom ────────────────────────────────────────────────────────── */
  console.log('⑤ 우클릭 줌 · R / E · 프레임 경계');
  const z0 = await P(() => ({ zoom: window.__game.ctx.survey.zoom, fov: window.__game.ctx.camera.fov, reload: window.__ev.reload, interact: window.__ev.interact }));
  await mDown(2);
  await waitSim(0.6);
  const zA = await sv();
  ok(zA.aimed && zA.aiming && !!(await P(() => document.querySelector('.sv-hud.is-zoom'))), 'RMB → aimed · player.isAiming · frame .is-zoom', JSON.stringify(zA));
  const zooms = [];
  for (let i = 0; i < 8; i++) { await tap('KeyR'); await waitSim(0.12); zooms.push(await P(() => window.__game.ctx.survey.zoom)); }
  const fovIn = await P(() => window.__game.ctx.camera.fov);
  for (let i = 0; i < 8; i++) { await tap('KeyE'); await waitSim(0.12); zooms.push(await P(() => window.__game.ctx.survey.zoom)); }
  const z1 = await P(() => ({ reload: window.__ev.reload, interact: window.__ev.interact }));
  ok(z0.zoom === 2 && zooms[0] === 3 && Math.max(...zooms) === 8 && zooms[7] === 8 && zooms[15] === 2 && zooms.every((z) => z >= 2 && z <= 8),
    'R steps the zoom in, E out, clamped to 2..8', JSON.stringify({ start: z0.zoom, zooms }));
  ok(z1.reload === z0.reload && z1.interact === z0.interact, 'R / E while zoomed start no reload and run no interaction', JSON.stringify({ z0, z1 }));
  ok(fovIn < z0.fov, `the rig narrows the fov at 8× (${z0.fov.toFixed(1)} → ${fovIn.toFixed(1)})`);
  // a crossing body: step the pitch until the scavenger's centre is in the zoomed frame but its box is not
  await P((id) => { const s = window.__game.getSystem('survey'); s.raidGained.set(id, 0); s.capNotified.clear(); }, SUBJ);
  await P(() => { const pin = window.__pin; if (pin.e2) { pin.e2.position.set(pin.x + 400, pin.y, pin.z); pin.x2 = pin.x + 400; } });
  let cross = null;
  for (let k = 0; k < 60 && !cross; k++) {
    await P((dp) => { window.__aim.dp = dp; }, 0.04 + k * 0.004);
    await waitSim(0.1);
    const st = await sv();
    if (st.status === 1) cross = { dp: 0.04 + k * 0.004, st };
  }
  ok(!!cross, 'found an aim where the scavenger crosses the zoomed frame border (status 1)', JSON.stringify(cross));
  if (cross) {
    await mDown(0);
    await waitSim(0.3);
    const e0 = await sv();
    await waitSim(1.2);
    const e1 = await sv();
    await mUp(0);
    ok(e0.status === 1 && e1.status === 1 && e1.p === e0.p && e1.raid === 0, 'a body crossing the zoomed border gains nothing', JSON.stringify({ e0, e1 }));
    ok(e1.tags.some((t) => t.name === '스캐빈저' && t.note === '프레임 밖'), 'its tag reads 프레임 밖', JSON.stringify(e1.tags));
  }
  await P(() => { window.__aim.dp = 0; });
  await mUp(2);
  await waitSim(0.4);

  /* ── ⑥ raidGains · raid end · persistence ─────────────────────────── */
  console.log('⑥ raidGains · 레이드 종료 · 저장');
  await P((id) => { const s = window.__game.getSystem('survey'); s.raidGained.set(id, 0.1); s.gainsDirty = true; }, SUBJ);
  const gains = await P(() => window.__game.ctx.survey.raidGains().map((g) => ({ ...g })));
  ok(gains.length === 1 && gains[0].subjectId === SUBJ && gains[0].name === '스캐빈저' && gains[0].gained > 0, 'raidGains() lists the subject gained this raid', JSON.stringify(gains));
  const pRaid1 = (await sv()).p;
  await P(() => { clearInterval(window.__pinT); window.__pin = null; window.__game.ctx.bus.emit('game:abort'); });
  await waitFor(page, () => window.__game.ctx.phase !== 'playing', 'raid end', 20000);
  const saved = await P((a) => {
    try { const raw = JSON.parse(localStorage.getItem('scav.s1.survey')); return { v: raw.v, rec: raw.s[a.id] }; } catch { return null; }
  }, { id: SUBJ });
  ok(!!saved && saved.v === 1 && Math.abs(saved.rec.p - pRaid1) < 1e-9 && saved.rec.pl.includes(planet), `scav.s1.survey saved at raid end with the planet stamped (${planet})`, JSON.stringify(saved));
  ok(await P(() => window.__game.ctx.survey.raidGains().length) === 1, 'raidGains() survives the raid end (the settlement reads it)');

  /* ── ⑦ raid 2 · ×1/4 · 100 % → q_at_1 ─────────────────────────────── */
  console.log('⑦ 레이드 2 — 같은 행성 ×1/4 · 100 % → q_at_1');
  await enterHub();
  await startRaid(12, planet);
  ok(await P(() => window.__game.ctx.survey.raidGains().length) === 0, 'game:newMission cleared raidGains()');
  await P(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const it = ctx.loot.createItem('cam_survey_1', 1);
    inv.tryAddItem(it);
    inv.setQuickSlot(0, it.uid);
    window.__game.getSystem('weapons').equipQuick(0);
  });
  await waitSim(0.6);
  const re = await P(() => {
    const ctx = window.__game.ctx, world = ctx.world, es = window.__game.getSystem('enemies'), p = ctx.player.position, V = p.constructor;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = p.x + Math.cos(a) * 12, z = p.z + Math.sin(a) * 12;
      if (!world.isInsideBounds(x, z)) continue;
      const y = world.getHeightAt(x, z);
      if (Math.abs(y - p.y) > 1.5) continue;
      const from = new V(p.x, p.y + 1.6, p.z), to = new V(x, y + 0.5, z);
      const dir = to.clone().sub(from); const d = dir.length(); dir.normalize();
      const hit = world.raycast(from, dir, d);
      if (hit && hit.distance < d - 0.6) continue;
      const e = es.debugSpawn('scavenger', { x, z }, false);
      if (!e) return false;
      window.__pin = { e, x, y: e.position.y, z, e2: null };
      window.__aim = { dy: 0, dp: 0, on: true };
      window.__pinT = setInterval(() => {
        const pin = window.__pin; if (!pin) return;
        pin.e.position.set(pin.x, pin.y, pin.z);
        const c = window.__game.ctx; c.player.heal?.(1000);
        const rig = window.__game.getSystem('player').rig;
        const t = new V(pin.x, pin.y + pin.e.height * 0.5, pin.z).sub(c.camera.position).normalize();
        rig.yaw = Math.atan2(-t.x, -t.z); rig.pitch = Math.asin(t.y);
      }, 10);
      return true;
    }
    return false;
  });
  ok(re, 'raid 2: camera in hand, a scavenger pinned again');
  await waitSim(0.4);
  await mDown(0);
  await waitSim(0.3);
  const f0 = await sv();
  await waitSim(2.5);
  const f1 = await sv();
  await mUp(0);
  const rate3 = (f1.p - f0.p) / (f1.t - f0.t);
  const mul = await P(async () => (await import('/src/shared/index.ts')).SURVEY_REPEAT_PLANET_MUL);
  ok(f0.status === 2 && rate3 > expect * mul * 0.85 && rate3 < expect * mul * 1.1, `same planet again → ×${mul} (${rate3.toFixed(5)}/s ≈ ${(expect * mul).toFixed(5)})`, JSON.stringify({ f0, f1 }));
  // finish the subject: account progress just under 1, then record to 100 %
  await P((id) => { const s = window.__game.getSystem('survey'); s.save.s[id].p = 0.998; window.__ev.notify = []; }, SUBJ);
  await mDown(0);
  await waitSim(1.5);
  await mUp(0);
  const done = await P((id) => {
    const ctx = window.__game.ctx, q = ctx.meta.npc.getQuest('q_at_1');
    return { p: ctx.survey.progressOf(id), toast: window.__ev.notify.filter((t) => t.includes('조사 완료')), q: q && { state: q.state, ready: q.ready, obj: q.objectives.map((o) => [o.progress, o.target, o.done]) } };
  }, SUBJ);
  ok(done.p === 1 && done.toast.length === 1, 'recording to 100 % → progress 1 + one 조사 완료 toast', JSON.stringify(done));
  ok(done.q && done.q.ready && done.q.obj[0][2] === true, 'q_at_1 objective (any subject 100 %) done, quest ready to report', JSON.stringify(done.q));
  await P(() => { clearInterval(window.__pinT); window.__pin = null; window.__game.ctx.bus.emit('game:abort'); });
  await waitFor(page, () => window.__game.ctx.phase !== 'playing', 'raid end', 20000);
  await enterHub();
  const rep = await P(() => { const r = window.__game.ctx.meta.npc; return { ok: r.report('q_at_1'), state: r.getQuest('q_at_1')?.state }; });
  ok(rep.ok && rep.state === 'complete', 'q_at_1 reported in the ship', JSON.stringify(rep));
  const rail1 = await corpTab();
  await closeMenus();
  ok(rail1.exists && rail1.hidden === false, 'atlas is on the corp rail after q_at_1', JSON.stringify(rail1));

  /* ── ⑧ reload keeps the progress ───────────────────────────────────── */
  console.log('⑧ 새로고침 후 진행도 유지');
  await sleep(300);
  await page.reload({ waitUntil: 'load' });
  await boot();
  const after = await P((id) => window.__game.ctx.survey.progressOf(id), SUBJ);
  ok(after === 1, 'reload restores the account progress from scav.s1.survey', String(after));

  const relevant = errors.filter((e) => !/WebSocket|ERR_CONNECTION|favicon|net::/i.test(e));
  ok(relevant.length === 0, 'no console errors', relevant.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e?.stack ?? e}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\nsmoke-survey: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
