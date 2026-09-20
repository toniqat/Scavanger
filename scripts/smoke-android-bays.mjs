// Cockpit android bays · the bot launch slot · the raid-entry fade smoke (2026-09-15, hub —
// docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」). One headless client, **no relay lobby**:
// standing in the shared ship on the docked lobby `HubSystem.debugSharedShip(lobby)` (a smoke-only hook) makes up:
//   1. The three cockpit bays — position (the bridge half) · a yaw facing the deck · the one-step `exit` outside the
//      capsule · the capsule collider (a body cannot walk in) · three `hub_android_<bay>` interactables with the
//      `ALLY_BAY_HOLD_S` hold.
//   2. Prompts — the leader is offered `들이기` / a bay that is already a squadmate `슬롯으로 돌려보내기`; for anyone
//      else the refusal reason is shown **as the prompt** and the interactable stays taken (the launch-pod rule).
//   3. The bot launch slot — seated and ready with no remote avatar (door shut · slot occupied), the ready panel's
//      cell is `is-bot` · the android's name · `준비 완료`, the right-click gear window is refused, and
//      `getPodStandPose(slot)` gives the spot in front of that pod.
//   4. The match tab — a bot tile carries the `안드로이드` tag and no invite button, and the crew line counts the
//      humans plus `안드로이드 n`.
//   5. Raid entry — readying up in the personal ship → once the countdown reaches 0, `ui:screenFade {1, hold}` +
//      `raid:loadBegin` go out first and `game:newMission` only follows `RAID_LOAD_FADE_OUT_S` later. Un-readying
//      after the fade has begun cannot cancel the launch.
// Usage: node scripts/smoke-android-bays.mjs [http://localhost:5273/]   (needs `npm run dev`; no relay needed)
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.hub, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    const bus = window.__game.ctx.bus;
    window.__marks = [];
    for (const n of ['raid:loadBegin', 'game:newMission', 'hub:entered', 'hub:launchCountdown']) {
      bus.on(n, () => window.__marks.push({ n, t: performance.now(), phase: window.__game.ctx.phase }));
    }
    window.__fades = [];
    bus.on('ui:screenFade', (e) => window.__fades.push({ o: e.opacity, hold: !!e.hold, t: performance.now() }));
  });
  const S = (fn, arg) => page.evaluate(fn, arg);

  /* ── Standing in the shared ship (no relay-made lobby) ────
   * `HubSystem.debugSharedShip` fakes 「the squad I am standing on」, and for the screens that read the **squad**
   * (`ctx.net.lobby`) — the match tab, the terminal's header row — it plants the same object into `NetSystem._lobby`
   * as well (inside the smoke only; restored before section 5). The leader test has to use the real `localId`, so
   * this is made only once the relay is connected. */
  await S(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__game.getSystem('hub').ship === 'personal', 'personal ship');
  await waitFor(page, () => !!window.__game.ctx.net?.localId, 'relay connected (the leader test needs a real localId)', 30000);
  const installed = await S(() => {
    const ctx = window.__game.ctx, hub = window.__game.getSystem('hub');
    const me = ctx.net?.localId ?? 'local';
    window.__botId = 'android:SMOKE:1';
    window.__lobby = {
      code: 'SMOKE', hostId: me, started: false, seed: null, isPublic: false, docked: true,
      players: [
        { id: me, name: '나', slot: 0, ready: false, isHost: true, connected: true },
        { id: window.__botId, name: '안드로이드 베타', slot: 1, ready: true, isHost: false, connected: true, bot: true, bay: 1, recruitedAt: Date.now() },
      ],
    };
    return hub.debugSharedShip(window.__lobby);
  });
  ok(installed, 'debugSharedShip installed the made-up docked lobby');
  await waitFor(page, () => window.__game.getSystem('hub').ship === 'shared', 'shared ship');
  await S(() => { window.__game.getSystem('net')._lobby = window.__lobby; window.__game.getSystem('hub').syncPods(); });

  /* ── 1. The three bays ──────────────────────────────────────────────── */
  const bays = await S(() => window.__game.ctx.hub.getAndroidBays().map((b) => ({
    bay: b.bay, x: b.position.x, y: b.position.y, z: b.position.z, yaw: b.yaw, ex: b.exit.x, ez: b.exit.z,
  })));
  ok(bays.length === 3, `3 android bays (${bays.length})`, JSON.stringify(bays));
  ok(bays.every((b, i) => b.bay === i) && new Set(bays.map((b) => b.z)).size === 3,
    'bays are numbered 0..2 and stand apart along Z', JSON.stringify(bays.map((b) => b.z)));
  ok(bays.every((b) => b.x < -9 && b.y === 0 && Math.abs(b.z) < 7),
    'every bay is on the bridge half of the deck, feet on the floor', JSON.stringify(bays.map((b) => [b.x, b.z])));
  // yaw convention: a body's front = (−sin yaw, −cos yaw). It must face the deck (+X), and `exit` is one step
  // out in front of it.
  ok(bays.every((b) => Math.abs(-Math.sin(b.yaw) - 1) < 0.01 && Math.abs(Math.cos(b.yaw)) < 0.01),
    'bays face +X (out onto the deck)', JSON.stringify(bays.map((b) => b.yaw)));
  ok(bays.every((b) => b.ex > b.x + 0.5 && Math.abs(b.ez - b.z) < 0.01), 'exit is one step out in front of each capsule');

  const pushed = await S(() => {
    const hub = window.__game.ctx.hub;
    const out = [];
    for (const b of hub.getAndroidBays()) {
      const v = b.position.clone();
      v.y = 0;
      hub.collider.resolveCollision(v, 0.35);
      out.push(Math.hypot(v.x - b.position.x, v.z - b.position.z));
    }
    return out;
  });
  ok(pushed.every((d) => d > 0.3), 'the capsules are solid — a body at the bay centre is pushed out', JSON.stringify(pushed));

  const its = await S(() => window.__game.ctx.interactables.all()
    .filter((i) => i.id.startsWith('hub_android_'))
    .map((i) => ({ id: i.id, hold: i.holdTime, r: i.radius })));
  ok(its.length === 3 && its.every((i) => i.hold === 3), `3 hub_android_<bay> interactables, 3 s hold (${JSON.stringify(its)})`);

  /* ── 2. Prompts ─────────────────────────────────────────────────────── */
  const asLeader = await S(() => {
    const hub = window.__game.getSystem('hub');
    return { p0: hub.androidPrompt(0), p1: hub.androidPrompt(1), c0: hub.androidCanInteract(0) };
  });
  ok(/안드로이드 알파/.test(asLeader.p0 ?? '') && /분대원으로 들이기/.test(asLeader.p0 ?? ''), `empty bay: "${asLeader.p0}"`);
  ok(/안드로이드 베타/.test(asLeader.p1 ?? '') && /슬롯으로 돌려보내기/.test(asLeader.p1 ?? ''), `recruited bay: "${asLeader.p1}"`);
  ok(asLeader.c0 === true, 'a usable bay is interactable');

  const asMember = await S(() => {
    const hub = window.__game.getSystem('hub');
    hub.debugLobby.hostId = 'someone-else';
    const out = { prompt: hub.androidPrompt(0), can: hub.androidCanInteract(0) };
    hub.debugLobby.hostId = window.__game.ctx.net?.localId ?? 'local';
    return out;
  });
  ok(/분대장만 안드로이드를 들일 수 있습니다/.test(asMember.prompt ?? ''), `not the leader: "${asMember.prompt}"`);
  ok(asMember.can === true, 'a refused bay stays interactable (the reason is the prompt)');

  /* ── 3. The bot launch slot · the spot in front of the pod ───── */
  await S(() => window.__game.getSystem('hub').syncPods());
  await sleep(200);
  const pods = await S(() => {
    const hub = window.__game.getSystem('hub');
    const slots = hub.getLaunchSlots().map((s) => ({ slot: s.slot, occ: s.occupant }));
    const stand = hub.getPodStandPose(1);
    const pod1 = hub.getLaunchSlots()[1];
    return {
      slots,
      standAway: stand ? Math.hypot(stand.position.x - pod1.position.x, stand.position.z - pod1.position.z) : -1,
      standZ: stand ? stand.position.z - pod1.position.z : 0,
      standElsewhere: hub.getPodStandPose(9),
    };
  });
  ok(pods.slots[1]?.occ === 'android:SMOKE:1', `the bot occupies its lobby slot's pod (${JSON.stringify(pods.slots)})`);
  ok(pods.standAway > 1.2 && pods.standAway < 2.2 && pods.standZ > 1, `pod stand pose is in front of pod 1 (${pods.standAway.toFixed(2)} m)`);
  ok(pods.standElsewhere === null, 'getPodStandPose(9) = null (no such pod)');

  const cell = await S(() => {
    const c = document.querySelector('.hr-cell[data-slot="1"]');
    if (!c) return null;
    return {
      bot: c.classList.contains('is-bot'), ready: c.classList.contains('is-ready'),
      name: c.querySelector('.hr-name')?.textContent ?? '', state: c.querySelector('.hr-state')?.textContent ?? '',
      gearHidden: !!c.querySelector('.hr-gear')?.hidden,
    };
  });
  ok(!!cell && cell.bot && cell.ready, `ready panel cell 1 is a bot cell, in the slot (${JSON.stringify(cell)})`);
  ok(!!cell && cell.name === '안드로이드 베타' && cell.state === '준비 완료', `cell reads the android's name / state (${cell?.name} · ${cell?.state})`);
  ok(!!cell && !cell.gearHidden, 'the bot cell draws a gear board (ANDROID_KIT while allies/ has no loadout yet)');
  const popup = await S(() => {
    const c = document.querySelector('.hr-cell[data-slot="1"]');
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    return !!document.querySelector('.hub-crew-loadout:not([hidden])');
  });
  ok(popup === false, 'right-clicking a bot cell opens no crew-loadout popup');

  /* ── 4. The match tab ────────────────────────────────────────────────── */
  const match = await S(() => {
    const hub = window.__game.getSystem('hub');
    hub.menu.open();
    hub.menu.setTab('match');
    const tiles = [...document.querySelectorAll('.hmt-tile')].map((t) => ({
      bot: t.classList.contains('is-bot'), empty: t.classList.contains('is-empty'),
      name: t.querySelector('.hmt-name')?.textContent ?? '',
      state: t.querySelector('.hmt-state')?.hidden ? '' : (t.querySelector('.hmt-state')?.textContent ?? ''),
      invite: !t.querySelector('.hmt-invite')?.hidden,
    }));
    const status = document.querySelector('.hmt-status')?.textContent ?? '';
    const subtitle = document.querySelector('.hub-menu .subtitle')?.textContent ?? '';
    hub.menu.close(false);
    return { tiles, status, subtitle };
  });
  const botTile = match.tiles.find((t) => t.bot);
  ok(!!botTile && botTile.name === '안드로이드 베타' && botTile.state === '안드로이드' && !botTile.invite,
    `match tab bot tile: face + name + 안드로이드 tag, no 초대 (${JSON.stringify(botTile)})`);
  ok(/1\/4/.test(match.status) && /안드로이드 1/.test(match.status), `crew count is humans + androids separately ("${match.status}")`);
  ok(/안드로이드 1/.test(match.subtitle), `terminal subtitle counts androids separately ("${match.subtitle}")`);
  ok(match.tiles.filter((t) => t.empty && t.invite).length === 2, 'the two free slots still offer 초대 (a human may replace an android)');

  /* ── 5. The raid-entry fade (personal ship · solo) ──────────── */
  await S(() => { window.__game.getSystem('net')._lobby = null; window.__game.getSystem('hub').debugSharedShip(null); });
  await waitFor(page, () => window.__game.getSystem('hub').ship === 'personal' && !window.__game.getSystem('hub').cutscene, 'back in the personal ship');
  const planet = await S(() => {
    const hub = window.__game.getSystem('hub');
    hub.menu.open();
    const id = document.querySelector('.hp-dots i')?.dataset.planet ?? null;
    hub.menu.close(false);
    if (!id) return null;
    // only the target is set, without running the window warp (a pod refuses during a warp — not this smoke's subject)
    hub.localPlanet = id;
    hub.applyPlanetLook();
    hub.syncPods();
    return hub.planet;
  });
  ok(!!planet, `a target planet is set (${planet})`);
  const boarded = await S(() => {
    const hub = window.__game.getSystem('hub');
    window.__marks = []; window.__fades = [];
    hub.boardPod(0);
    if (hub.boardedSlot !== 0) return { boarded: false, reason: hub.podBlockReason(0) };
    hub.setReadyLocal(true);
    return { boarded: true, ready: hub.readyLocal };
  });
  ok(boarded.boarded && boarded.ready, `boarded slot 0 and readied up (${JSON.stringify(boarded)})`);

  await waitFor(page, () => window.__marks.some((m) => m.n === 'raid:loadBegin'), 'raid:loadBegin after the countdown', 20000);
  const atFade = await S(() => {
    const hub = window.__game.getSystem('hub');
    const before = hub.readyLocal;
    hub.toggleReady();                      // un-readying after the fade must not take
    return {
      launching: hub.raidLaunching, readyBefore: before, readyAfter: hub.readyLocal,
      phase: window.__game.ctx.phase,
      fades: window.__fades.slice(), marks: window.__marks.slice(),
    };
  });
  const fade1 = atFade.fades.find((f) => f.o === 1);
  ok(!!fade1 && fade1.hold === true, `the screen fades to black and holds (${JSON.stringify(atFade.fades)})`);
  ok(atFade.launching === true && atFade.phase === 'hub', 'the launch is committed while the ship is still up');
  ok(atFade.readyBefore === true && atFade.readyAfter === true, 'un-readying no longer cancels a committed launch');
  ok(!atFade.marks.some((m) => m.n === 'game:newMission'), 'nothing launched during the fade yet');

  await waitFor(page, () => window.__marks.some((m) => m.n === 'game:newMission'), 'game:newMission after the fade', 30000);
  const order = await S(() => {
    const m = window.__marks;
    const b = m.find((x) => x.n === 'raid:loadBegin');
    const n = m.find((x) => x.n === 'game:newMission');
    return { gap: n && b ? n.t - b.t : -1, beginPhase: b?.phase ?? '' };
  });
  ok(order.beginPhase === 'hub', 'raid:loadBegin is emitted from the ship, before the mission starts');
  ok(order.gap >= 600, `the authority launched only after the fade (${Math.round(order.gap)} ms ≥ RAID_LOAD_FADE_OUT_S)`);

  /* What another system threw in its `update` is not this smoke's business (that folder's smoke checks it) — only
     hub's own are kept. */
  const real = errors.filter((e) => !/\/ws\b|WebSocket|websocket|ERR_CONNECTION_REFUSED/i.test(e))
    .filter((e) => !/update failed in (?!hub\b)\w+/i.test(e));
  ok(real.length === 0, 'no console / page errors', JSON.stringify(real.slice(0, 3)));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${e.message}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
