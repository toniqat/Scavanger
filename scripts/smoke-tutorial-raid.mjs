// Single-player smoke for the tutorial **raid track** (E-12 part, 2026-09-15). Complements `smoke-tutorial.mjs` (build track).
//
// A fresh character goes through the real entry path (`markAutoStart` → `TitleMenu` → `enterShip` → `startTutorialRaid`) and
// the raid track is driven end to end. Sections are joined by **teleports**; anything that is a judgement uses **real input**
// (keys dispatched on `document.body` → `shared/Input`): walking off a ledge, the sprint jump over cliff 1, crouching, the
// corpse interaction and the ship switch hold. Enemy kills go through `EnemyRef.takeDamage` (aiming a third-person camera at
// a burrowing bug is not what this smoke is about — the kill still arrives as the real `enemy:killed`).
//
//   1. entry        — `missionMode === 'tutorial'`, raid track at `wake`, no hellpod, intro wake plays and hands over to `move`.
//   2. kill volume  — walk off cliff 1 → `player:fell {rule:'kill'}` → death with **no** `game:over` / phase `dead` /
//                     `game:respawnAvailable` → respawn after `TUTORIAL_RESPAWN_DELAY_S` at the **last safe ground**, which the
//                     cliff-1 run-up exclusion (`CHASM_RUNUP_M`) keeps ≥ 12 m from the edge. Full HP.
//   3. checkpoint   — `gotoCheckpoint('cliff')` (clears the safe-ground record) → die → respawn exactly on the checkpoint pose.
//   4. sprint jump  — real Shift+W+Space over cliff 1 → `corpse` checkpoint → `corpseLoot`.
//   5. safe ground  — walk back into cliff 1 from the far side → respawn at the last safe ground (x kept, 1.5 m margin),
//                     **not** the `corpse` checkpoint; the checkpoint index does not regress.
//   6. corpse       — E on `corpse:tut_gear` → equip the SMG → close → `advance1` (HUD gear gate opens).
//   7. bugs         — walk into the ambush → `enemy:spawned` → `shoot` → two kills → `advance2`.
//   8. crawl        — `crawl` checkpoint → real C → `crouchAim` → two android kills → `advance3`.
//      (2026-09-15: the crouch / prone control lines follow the stance **through `crouchAim` too**, and the one-shot crouch-aim
//       TIP toast sits right under the controls panel.)
//   9. clamp volume — `drop` checkpoint, HP 5, walk off cliff 2 → `player:fell {rule:'clamp'}` → alive at HP 1; `fallRule` probes.
//  9b. supply loot  — (2026-09-15) the drop opens `supplyLoot`, **not** `heal`: bandage (required) + grenade (optional) shown
//                     together, optional line not greyed; open `corpse:tut_supply`, a bandage in the bag ticks the required
//                     line, closing the window → `heal` (only 「붕대 장착」 visible — 「붕대 사용」 is revealed after it).
//                     Heal / grenade control lines: `빠른 사용 꺼내기` and `휠 열기` are separate rows; grenade has token rows.
//  10. extract      — `wall` / `ship` checkpoints → hold E on the ship switch → **instant** liftoff (no departure grace), scene
//                     lock (damage ignored), `tutorial:finished {raid}` → result screen → `rewards.xpEarned === TUTORIAL_RAID_XP`
//                     (csv), level 2 → `함선으로 귀환` → personal ship, ship track at `levelUp`, raid track done, solo save cleared.
//   The recorded `tutorial:changed` trail must equal the raid track's 15 steps in order.
//
// Usage: node scripts/smoke-tutorial-raid.mjs [http://localhost:5273/]   (needs `npm run dev`; no relay needed)
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

/* Numbers come from the csv, never from this file (the lead may retune them). */
const CONST = Object.fromEntries(readFileSync(new URL('../data/constants.csv', import.meta.url), 'utf8').split(/\r?\n/)
  .map((l) => l.split(',')).filter((c) => c.length >= 2 && /^[A-Z_0-9]+$/.test(c[0])).map((c) => [c[0], Number(c[1])]));
const K = (k) => { if (!Number.isFinite(CONST[k])) throw new Error(`constants.csv: ${k} missing`); return CONST[k]; };
const TUTORIAL_RAID_XP = K('TUTORIAL_RAID_XP');
const RESPAWN_DELAY = K('TUTORIAL_RESPAWN_DELAY_S');
/** Level reached from level 1 with `xp` (progression/derive: xpToNext = round(XP_BASE × level^XP_EXPONENT)). */
function levelFromXp(xp) {
  let level = 1, left = xp;
  for (;;) { const need = Math.max(1, Math.round(K('XP_BASE') * Math.pow(level, K('XP_EXPONENT')))); if (left < need) return level; left -= need; level++; }
}
/* Map shape (world/tutorial/model.ts) — geometry, not balance, so it lives in code there too. Only used for expectations. */
const CHASM_NEAR_Z = 82, CHASM_GAP_Z = 3.6, CHASM_RUNUP_M = 12, TILT = Math.tan((20 * Math.PI) / 180), SAFE_CHASM_MARGIN = 1.5;
const nearZ = (x) => CHASM_NEAR_Z - x * TILT;
const farZ = (x) => nearZ(x) - CHASM_GAP_Z;
const RAID_STEPS = ['wake', 'move', 'sprintJump', 'corpseLoot', 'advance1', 'shoot', 'advance2', 'crouch', 'crouchAim', 'advance3', 'drop', 'supplyLoot', 'heal', 'grenade', 'extract'];

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const s = Date.now();
  while (Date.now() - s < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1280,760', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  await page.evaluateOnNewDocument(() => {
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // a fresh browser profile = a fresh character; `markAutoStart` skips the title exactly like a slot switch does
    try { if (!sessionStorage.getItem('smoke.booted')) { sessionStorage.setItem('smoke.booted', '1'); sessionStorage.setItem('scav.autostart', '1'); } } catch { /* off */ }
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .*\/ws|\/ws\b.*failed/.test(m.text())) errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.tutorial && !!window.__game.ctx.player, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    const G = window.__game, ctx = G.ctx;
    window.__ev = {};
    const ser = (p) => JSON.parse(JSON.stringify(p ?? null, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : (v && v.isObject3D) ? undefined : v));
    for (const n of ['tutorial:changed', 'tutorial:checkpoint', 'tutorial:finished', 'player:fell', 'player:died', 'player:spawned', 'player:introWakeDone',
      'game:over', 'game:complete', 'game:respawnAvailable', 'game:phaseChanged', 'enemy:spawned', 'enemy:killed', 'extraction:liftoff',
      'extraction:departureStarted', 'extraction:boarded', 'inventory:containerOpened', 'hub:entered', 'interact:performed']) {
      window.__ev[n] = [];
      ctx.bus.on(n, (p) => { window.__ev[n].push({ t: ctx.time, p: ser(p) }); });
    }
    window.__trail = ctx.tutorial.step ? [ctx.tutorial.step] : [];
    ctx.bus.on('tutorial:changed', ({ active, step }) => { if (active && step && window.__trail[window.__trail.length - 1] !== step) window.__trail.push(step); });
    window.__key = (code, down) => {
      const key = code === 'Space' ? ' ' : code.replace(/^Key/, '').toLowerCase();
      document.body.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key, bubbles: true, cancelable: true }));
    };
    window.__keysUp = () => { for (const c of ['KeyW', 'KeyS', 'ShiftLeft', 'Space', 'KeyE', 'KeyC']) window.__key(c, false); };
    /** Resolve once `ctx.time` advanced by `s` seconds of simulation (dt is clamped — never wait on the wall clock). */
    window.__waitSim = (s, cap = 60000) => new Promise((res) => {
      const start = ctx.time, w0 = performance.now();
      (function poll() { if (ctx.time - start >= s || performance.now() - w0 > cap) res(ctx.time - start); else setTimeout(poll, 16); })();
    });
    window.__pose = () => { const p = ctx.player; return { x: p.position.x, y: p.position.y, z: p.position.z, hp: p.hp, maxHp: p.maxHp, dead: p.isDead, grounded: p.isGrounded }; };
    /** Teleport onto the tutorial deck (never `snap` — the terrain under the decks is the canyon floor). */
    window.__tp = (x, y, z, yaw) => { ctx.player.teleport(ctx.player.position.clone().set(x, y, z), yaw, false); };
    window.__killNear = (x, z, r) => {
      let n = 0;
      for (const e of ctx.enemies.getEnemies()) {
        if (e.isDead || Math.hypot(e.position.x - x, e.position.z - z) > r) continue;
        e.takeDamage(1e6); n++;
      }
      return n;
    };
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const step = () => P(() => window.__game.ctx.tutorial.step);
  const waitStep = (s, timeout = 30000) => waitFor(page, (want) => window.__game.ctx.tutorial.step === want, `step ${s}`, timeout, s);
  const waitSim = (s) => P((x) => window.__waitSim(x), s);
  const blockers = () => P(() => [...window.__game.ctx.uiBlockers]);

  /* ── 1. 새 캐릭터 → 튜토리얼 레이드 ─────────────────────────────────── */
  console.log('진입');
  // The pre-landed ship turns 'playing' into 'extracting' → 'shipLanded' on the first playing frame (extraction/README).
  await waitFor(page, () => { const c = window.__game.ctx; return c.missionMode === 'tutorial' && c.world?.ready && c.isGameplayPhase() && c.player.spawned; }, 'tutorial raid in a gameplay phase', 90000);
  const entry = await P(() => {
    const c = window.__game.ctx, t = c.tutorial;
    return {
      mode: c.missionMode, phase: c.phase, track: t.track, step: t.step, raidDone: t.isTrackDone('raid'),
      tw: !!c.world.tutorial, cp: c.world.tutorial?.checkpoint, level: c.progression.level, hellpod: c.player.isDropping ?? false,
      hudWeaponHidden: t.hides('hud', 'weapon'), blockers: [...c.uiBlockers],
    };
  });
  ok(entry.mode === 'tutorial' && ['playing', 'extracting', 'shipLanded'].includes(entry.phase) && entry.tw,
    '새 캐릭터는 함선이 아니라 튜토리얼 레이드에서 시작한다 (강하 없이 곧장 게임플레이 — 버려진 함선이 이미 착륙해 있다)', JSON.stringify(entry));
  ok(entry.track === 'raid' && entry.step === 'wake' && entry.raidDone === false && entry.cp === 'wake' && entry.level === 1,
    '레이드 트랙이 wake 에서 돈다 (레벨 1 · 체크포인트 wake)', JSON.stringify(entry));
  ok(entry.hudWeaponHidden === true && entry.hellpod === false, '무기 HUD 는 시체 단계 전까지 숨고 헬포드는 없다', JSON.stringify(entry));
  // The wake lasts TUTORIAL_INTRO_WAKE_S of sim; give it that plus a margin, then judge.
  const wakeS = K('TUTORIAL_INTRO_WAKE_S');
  await P(() => window.__waitSim(0)); // make sure the clock runs
  await waitFor(page, (s) => window.__ev['player:introWakeDone'].length > 0 || window.__game.ctx.time > s, 'intro wake window', 90000, wakeS + 1.5);
  const woke = await P(() => {
    const ps = window.__game.getSystem('player');
    return { waking: ps.introWaking, wakeT: ps.introWakeT, done: window.__ev['player:introWakeDone'].length, step: window.__game.ctx.tutorial.step, time: window.__game.ctx.time };
  });
  ok(woke.done === 1 && woke.waking === false, `기상 연출이 TUTORIAL_INTRO_WAKE_S(${wakeS}) 안에 끝나고 player:introWakeDone 을 낸다`, JSON.stringify(woke));
  if (woke.done === 0) {
    /* Known bug (2026-09-15, src/player/parts/IntroWake.ts): the last frame's dt overshoots zero, `introWakeT` goes slightly
       negative and `endIntroWake`'s `if (introWakeT < 0) return` guard swallows the end — no `player:introWakeDone`, the wake
       camera override and fade stay. Unblock the rest of the run by finishing it the way `endIntroWake` would; the FAIL above stays. */
    console.log('  note intro wake did not end — finishing it by hand so the rest of the track can be checked');
    await P(() => {
      const ps = window.__game.getSystem('player');
      ps.introWakeT = -1; ps.introWakeDur = 0;
      ps.setCameraOverride(null, undefined, true);
      window.__game.ctx.bus.emit('ui:screenFade', { opacity: 0, durationS: 0 });
      window.__game.ctx.bus.emit('player:introWakeDone', {});
    });
  }
  await waitStep('move', 10000);
  ok(await step() === 'move', 'player:introWakeDone 이 wake → move 로 넘긴다');
  if ((await blockers()).length) console.log(`  note ui blockers at start: ${JSON.stringify(await blockers())}`);

  /* ── 2. 절벽 1 kill 볼륨 + 도움닫기 제외 띠 ───────────────────────────── */
  console.log('절벽 1: kill 볼륨 · 도움닫기 제외');
  await P(() => { window.__tp(0, 0, 103, 0); });
  await waitSim(0.3);
  await P(() => window.__key('KeyW', true));
  await waitFor(page, () => window.__ev['tutorial:checkpoint'].some((e) => e.p.id === 'cliff'), 'cliff checkpoint', 20000);
  ok(await step() === 'sprintJump', 'cliff 체크포인트를 걸어서 지나면 sprintJump');
  await waitFor(page, () => window.__ev['player:died'].length >= 1, 'fall death in chasm 1', 30000);
  await P(() => window.__keysUp());
  const died1 = await P(() => ({
    fell: window.__ev['player:fell'].slice(-1)[0]?.p ?? null, dieT: window.__ev['player:died'].slice(-1)[0].t,
    phase: window.__game.ctx.phase, track: window.__game.ctx.tutorial.track,
    pcorpse: window.__game.ctx.interactables.all().some((i) => i.id.startsWith('pcorpse:')),
  }));
  ok(died1.fell?.rule === 'kill' && died1.fell.damage > 0, `협곡 바닥에 닿으면 kill 규칙으로 즉사한다 (${JSON.stringify(died1.fell)})`);
  ok(['playing', 'extracting', 'shipLanded'].includes(died1.phase) && died1.track === 'raid', '사망해도 게임플레이 페이즈 · 트랙이 그대로다 (레이드 실패 · dead 페이즈 없음)', JSON.stringify(died1));
  ok(died1.pcorpse, '튜토리얼 사망에도 시체가 선다 (pcorpse:)');
  await waitFor(page, () => { const p = window.__game.ctx.player; return !p.isDead && window.__ev['player:spawned'].some((e) => e.t > window.__ev['player:died'].slice(-1)[0].t); }, 'respawn 1', 20000);
  const resp1 = await P(() => ({ ...window.__pose(), t: window.__ev['player:spawned'].slice(-1)[0].t }));
  ok(Math.abs(resp1.t - died1.dieT - RESPAWN_DELAY) < 0.35, `TUTORIAL_RESPAWN_DELAY_S(${RESPAWN_DELAY}) 뒤에 선다 (${(resp1.t - died1.dieT).toFixed(2)} s)`);
  ok(resp1.hp === resp1.maxHp, `체력 가득으로 선다 (${resp1.hp}/${resp1.maxHp})`);
  ok(resp1.z >= nearZ(resp1.x) + CHASM_RUNUP_M - 0.05 && resp1.z < nearZ(resp1.x) + CHASM_RUNUP_M + 1.5 && Math.abs(resp1.y) < 0.4,
    `도움닫기 띠 안에서는 기록하지 않는다 — 가장자리에서 ${(resp1.z - nearZ(resp1.x)).toFixed(2)} m (≥ ${CHASM_RUNUP_M}) 떨어진 마지막 땅`, JSON.stringify(resp1));

  /* ── 3. 체크포인트 부활 ─────────────────────────────────────────────────── */
  console.log('체크포인트 부활');
  const gone = await P(() => window.__game.ctx.world.tutorial.gotoCheckpoint('cliff'));
  await waitSim(0.4);
  const nDied = await P(() => window.__ev['player:died'].length);
  await P(() => window.__game.ctx.player.die());
  await waitFor(page, (n) => window.__ev['player:died'].length > n && !window.__game.ctx.player.isDead, 'respawn 2', 20000, nDied);
  const resp2 = await P(() => ({ ...window.__pose(), yaw: window.__game.getSystem('player').bodyYaw, over: window.__ev['game:over'].length, avail: window.__ev['game:respawnAvailable'].length, cp: window.__game.ctx.world.tutorial.checkpoint }));
  ok(gone === true && Math.hypot(resp2.x - 0, resp2.z - (CHASM_NEAR_Z + CHASM_RUNUP_M)) < 0.3 && Math.abs(resp2.y) < 0.2 && resp2.cp === 'cliff',
    `기록이 없으면 체크포인트 자리(cliff 0,0,${CHASM_NEAR_Z + CHASM_RUNUP_M})에서 선다`, JSON.stringify(resp2));
  ok(resp2.hp === resp2.maxHp && Math.abs(resp2.yaw) < 0.05, '체크포인트 부활도 체력 가득 · 앞(yaw 0)을 본다', JSON.stringify(resp2));
  ok(resp2.over === 0 && resp2.avail === 0, '튜토리얼 사망은 game:over · game:respawnAvailable 을 내지 않는다 (자동 부활 규칙은 본편에서 그대로)', JSON.stringify(resp2));

  /* ── 4. 달려서 절벽 1 넘기 (실제 입력) ──────────────────────────────────── */
  console.log('달려 뛰기');
  // 부활 기상 연출(2026-09-15) 동안은 입력이 잠긴다 — 달리기 입력 전에 끝나기를 기다린다
  await waitFor(page, () => window.__game.getSystem('player').introWakeT < 0, 'respawn 2 get-up done', 10000);
  await waitSim(0.3);
  const jump = await P(async () => {
    const ctx = window.__game.ctx, p = ctx.player;
    const tilt = Math.tan((20 * Math.PI) / 180);
    window.__key('ShiftLeft', true); window.__key('KeyW', true);
    let jumped = null;
    const w0 = performance.now();
    await new Promise((res) => {
      (function frame() {
        if (!jumped && p.isGrounded && p.position.z <= 82 - p.position.x * tilt + 0.55) {
          jumped = { z: p.position.z, x: p.position.x };
          window.__key('Space', true);
          setTimeout(() => window.__key('Space', false), 120);
        }
        const crossed = ctx.world.tutorial.checkpoint === 'corpse';
        if (crossed || p.isDead || performance.now() - w0 > 20000) return res();
        requestAnimationFrame(frame);
      })();
    });
    window.__keysUp();
    return { jumped, dead: p.isDead, cp: ctx.world.tutorial.checkpoint, pose: window.__pose() };
  });
  ok(!!jump.jumped && !jump.dead && jump.cp === 'corpse', `달리며 뛰면 절벽 1 을 넘어 corpse 체크포인트에 닿는다 (도약 z ${jump.jumped?.z.toFixed(2)})`, JSON.stringify(jump));
  await waitStep('corpseLoot', 10000);

  /* ── 5. 건너편에서 되돌아 떨어지기 → 마지막으로 서 있던 자리 ───────────── */
  console.log('마지막으로 서 있던 자리');
  await P(() => window.__tp(3, 0, 70, Math.PI));
  await waitSim(0.5);
  const nDied5 = await P(() => window.__ev['player:died'].length);
  await P(() => window.__key('KeyW', true));
  await waitFor(page, (n) => window.__ev['player:died'].length > n, 'far-side fall death', 30000, nDied5);
  await P(() => window.__keysUp());
  await waitFor(page, () => !window.__game.ctx.player.isDead, 'respawn 3', 20000);
  const resp3 = await P(() => ({ ...window.__pose(), cp: window.__game.ctx.world.tutorial.checkpoint, rule: window.__ev['player:fell'].slice(-1)[0]?.p?.rule }));
  // 2026-09-15 (사용자 결정): 튜토리얼 부활은 서 있는 채 나타나지 않고 **쓰러졌다 일어난다** — 그 동안 입력이 잠기므로
  //   다음 행동(시체 E) 전에 기상 연출이 끝나기를 기다린다. 오프닝과 달리 나침반 · Tab 잠금(`introWaking`)은 걸지 않는다.
  const wake3 = await P(() => { const ps = window.__game.getSystem('player'); return { t: ps.introWakeT, respawn: ps.introWakeRespawn, introWaking: window.__game.ctx.player.introWaking === true }; });
  ok(wake3.t >= 0 && wake3.respawn && !wake3.introWaking, '부활하면 쓰러졌다 일어나는 연출이 돈다 (부활 연출 · 오프닝 잠금 없음)', JSON.stringify(wake3));
  await waitFor(page, () => window.__game.getSystem('player').introWakeT < 0, 'respawn get-up done', 10000);
  const wantZ = farZ(3) - SAFE_CHASM_MARGIN;
  ok(resp3.rule === 'kill' && resp3.cp === 'corpse', '건너편에서 떨어져도 kill 이고 체크포인트 번호는 되돌아가지 않는다', JSON.stringify(resp3));
  ok(Math.abs(resp3.x - 3) < 0.3 && resp3.z <= wantZ + 0.1 && resp3.z > wantZ - 0.6 && Math.abs(resp3.y) < 0.4,
    `체크포인트(0,0,72)가 아니라 마지막으로 서 있던 땅(x 3, z ≈ ${wantZ.toFixed(2)})에서 선다`, JSON.stringify(resp3));
  ok(resp3.hp === resp3.maxHp, '낙사 부활도 체력 가득');
  ok(await step() === 'corpseLoot', '되돌아 떨어져도 단계는 그대로다');

  /* ── 6. 시체 뒤지기 → 무기 장착 → 닫기 ─────────────────────────────────── */
  console.log('시체');
  await P(() => window.__tp(2, 0, 68.2, 0));
  await waitSim(0.4);
  await P(() => window.__key('KeyE', true));
  await waitSim(0.15);
  await P(() => window.__key('KeyE', false));
  await waitFor(page, () => window.__ev['inventory:containerOpened'].some((e) => e.p.containerId === 'corpse:tut_gear'), 'corpse opened (E)', 10000);
  // corpse contents start `searched: false` and are revealed one by one while the window stays open (inventory/README) —
  // the SMG can only be taken once it is revealed, exactly like a player would have to wait
  await waitFor(page, () => {
    const g = window.__game.getSystem('inventory').getGrid('container');
    const smg = (g?.items() ?? []).map((p) => p.item).find((it) => it?.defId === 'wpn_smg');
    return !!smg && smg.searched !== false;
  }, 'SMG revealed by the corpse search', 30000);
  const equipped = await P(() => {
    const inv = window.__game.getSystem('inventory');
    const grid = inv.getGrid('container');
    const list = [];
    try { for (const pl of grid?.items() ?? []) list.push(pl.item); } catch { /* shape */ }
    const smg = list.find((it) => it?.defId === 'wpn_smg');
    const okEquip = smg ? window.__game.ctx.inventory.equip(smg.uid, 'primary') : false;
    return { ids: list.map((i) => i?.defId), okEquip, primary: window.__game.ctx.inventory.getLoadout().primary?.defId ?? null };
  });
  ok(equipped.okEquip && equipped.primary === 'wpn_smg', `E 로 연 분대원 시체에서 기관단총을 장착한다 (${equipped.ids.join(',')})`, JSON.stringify(equipped));
  ok(await step() === 'corpseLoot', '총을 들어도 창을 닫기 전에는 넘어가지 않는다');
  await P(() => window.__game.ctx.inventory.closeAll());
  await waitStep('advance1', 10000);
  ok(await P(() => window.__game.ctx.tutorial.hides('hud', 'weapon')) === false, '창을 닫으면 advance1 이고 무기 HUD 가 나타난다');

  /* ── 7. 벌레: 솟는 순간 shoot → 둘 처치 ─────────────────────────────────── */
  console.log('벌레');
  await P(() => window.__tp(0, 0, 58, 0));
  await waitSim(0.3);
  ok(await P(() => window.__game.ctx.world.tutorial.checkpoint) === 'bugs' && await step() === 'advance1', 'bugs 체크포인트는 advance1 에 머문다 (벌레는 아직 땅속)');
  await P(() => window.__key('KeyW', true));
  await waitFor(page, () => window.__ev['enemy:spawned'].length >= 1, 'first bug emerges', 20000);
  const firstSpawnZ = await P(() => window.__game.ctx.player.position.z);
  ok(await step() === 'shoot', `벌레가 솟는 순간 shoot 으로 넘어간다 (플레이어 z ${firstSpawnZ.toFixed(1)})`);
  await waitFor(page, () => window.__ev['enemy:spawned'].length >= 2 || window.__game.ctx.player.position.z < 38, 'second bug', 20000);
  await P(() => window.__keysUp());
  await waitSim(1.2);   // BURROW_EMERGE_S
  const bugKills = await P(() => window.__killNear(0, 31, 16));
  await waitStep('advance2', 10000);
  ok(bugKills === 2, `벌레 둘을 처치하면 advance2 (${bugKills})`);

  /* ── 8. 포복 구간 → 앉기 → 안드로이드 ───────────────────────────────────── */
  console.log('앉기 · 안드로이드');
  await P(() => window.__tp(0, 0, -8, 0));
  await waitStep('crouch', 10000);
  await P(() => window.__key('KeyC', true));
  await waitSim(0.1);
  await P(() => window.__key('KeyC', false));
  await waitStep('crouchAim', 10000);
  ok(await P(() => window.__game.ctx.player.stance) !== 'stand', 'C 로 앉으면 crouchAim');
  /* 2026-09-15: 앉기 · 포복 줄의 라벨은 crouchAim 에서도 자세를 따라간다 (옛 버그 — crouch 는 앉는 순간 끝나 라벨이 얼었다) */
  const ctlLabel = (id) => P((h) => document.querySelector(`.tut-controls .tut-ctl[data-hint="${h}"] .tut-ctl-label`)?.textContent ?? null, id);
  const waitLabels = (c, z, label) => waitFor(page, ([a, b]) => {
    const q = (h) => document.querySelector(`.tut-controls .tut-ctl[data-hint="${h}"] .tut-ctl-label`)?.textContent ?? null;
    return q('crouch') === a && q('prone') === b;
  }, label, 5000, [c, z]).then(() => true).catch(() => false);
  ok(await waitLabels('일어서기', '포복', 'crouched labels'), `앉은 채 crouchAim: C 일어서기 · Z 포복 (${await ctlLabel('crouch')} / ${await ctlLabel('prone')})`);
  // TIP 토스트 — 판정 입력(정조준)은 player 몫이라 트리거 함수를 직접 부른다: 조작 가이드 바로 아래에 코드 페이드로 선다
  await P(() => window.__game.getSystem('tutorial').maybeCrouchTip(true));
  await waitSim(0.6);
  const tip = await P(() => {
    const t = document.querySelector('.tut-tip'), c = document.querySelector('.tut-controls');
    const tr = t?.getBoundingClientRect(), cr = c?.getBoundingClientRect();
    return { shown: !!t && !t.hidden, op: Number(t?.style.opacity ?? 0), text: t?.textContent ?? '', below: !!tr && !!cr && tr.top >= cr.bottom - 0.5 && tr.top - cr.bottom < 24 };
  });
  ok(tip.shown && tip.op > 0.9 && tip.below && /명중률이 높아집니다/.test(tip.text), '앉아 조준 TIP 이 조작 가이드 바로 아래에 뜬다', JSON.stringify(tip));
  await P(() => window.__tp(0, 0, -32, 0));
  await waitSim(0.3);
  await P(() => window.__key('KeyZ', true));
  await waitSim(0.1);
  await P(() => window.__key('KeyZ', false));
  ok(await waitLabels('앉기', '일어서기', 'prone labels'), `엎드리면 C 앉기 · Z 일어서기 (${await ctlLabel('crouch')} / ${await ctlLabel('prone')})`);
  await P(() => window.__key('KeyZ', true));
  await waitSim(0.1);
  await P(() => window.__key('KeyZ', false));
  ok(await waitLabels('앉기', '포복', 'standing labels'), `일어서면 C 앉기 · Z 포복 (${await ctlLabel('crouch')} / ${await ctlLabel('prone')})`);
  const androidKills = await P(() => window.__killNear(0, -51, 12));
  await waitStep('advance3', 10000);
  ok(androidKills === 2, `안드로이드 둘을 처치하면 advance3 (${androidKills})`);
  if (await P(() => window.__game.ctx.player.stance) !== 'stand') {
    await P(() => window.__key('KeyC', true));
    await waitSim(0.1);
    await P(() => window.__key('KeyC', false));
  }

  /* ── 9. 절벽 2 clamp 볼륨 ───────────────────────────────────────────────── */
  console.log('절벽 2: clamp 볼륨');
  const probes = await P(() => {
    const tw = window.__game.ctx.world.tutorial, v = window.__game.ctx.player.position.clone();
    return {
      chasmFloor: tw.fallRule(v.set(0, -34, 80)), landing: tw.fallRule(v.set(0, -10, -80)),
      upper: tw.fallRule(v.set(0, 0, 60)), lowerEnd: tw.fallRule(v.set(0, -10, -130)),
    };
  });
  ok(probes.chasmFloor === 'kill' && probes.landing === 'clamp' && probes.upper === 'normal' && probes.lowerEnd === 'normal',
    'fallRule: 협곡 바닥 kill · 절벽 2 착지 clamp · 그 밖 normal', JSON.stringify(probes));
  await P(() => window.__tp(0, 0, -72, 0));
  await waitStep('drop', 10000);
  await P(() => window.__game.ctx.player.setHp(5));
  await waitSim(0.2);
  const nFell = await P(() => window.__ev['player:fell'].length);
  await P(() => window.__key('KeyW', true));
  await waitFor(page, (n) => window.__ev['player:fell'].length > n || window.__ev['player:died'].length > 3, 'cliff 2 landing', 20000, nFell);
  await P(() => window.__keysUp());
  await waitSim(0.3);
  const drop = await P(() => ({ fell: window.__ev['player:fell'].slice(-1)[0].p, ...window.__pose() }));
  ok(drop.fell.rule === 'clamp' && !drop.dead && drop.hp === 1 && Math.abs(drop.y + 10) < 0.4,
    `체력 5 로 10 m 를 떨어져도 clamp 가 체력 1 을 남긴다 (${JSON.stringify(drop.fell)})`, JSON.stringify(drop));
  /* ── 9b. 보급품 시체 → 붕대 → 창 닫기 → 회복 (2026-09-15) ─────────────────── */
  console.log('보급품 시체');
  await waitStep('supplyLoot', 10000);
  ok(await step() === 'supplyLoot', '낙하 피해가 들어가면 drop → supplyLoot (붕대를 줍기 전에 「붕대 사용」이 뜨지 않는다)');
  const objRows = () => P(() => [...document.querySelectorAll('.tut-panel .tut-obj')].map((r) => ({
    id: r.dataset.obj, done: r.classList.contains('is-done'), color: getComputedStyle(r.querySelector('.tut-obj-txt')).color,
  })));
  await waitFor(page, () => [...document.querySelectorAll('.tut-panel .tut-obj')].some((r) => r.dataset.obj === 'supplyBandage'), 'supplyLoot rows', 5000);
  const sup0 = await objRows();
  ok(sup0.map((r) => r.id).join(',') === 'supplyBandage,supplyGrenade', `목표 두 줄이 함께 보인다 (${sup0.map((r) => r.id).join(',')})`);
  ok(sup0.length === 2 && sup0[0].color === sup0[1].color, '선택 목표도 달성 전에는 회색이 아니다 (필수와 같은 색)', JSON.stringify(sup0));
  const supply = await P(() => window.__game.ctx.interactables.all().find((i) => i.id === 'corpse:tut_supply')?.position.toArray() ?? null);
  ok(!!supply, '보급품 시체(corpse:tut_supply)가 있다', JSON.stringify(supply));
  if (supply) {
    await P((s) => { window.__tp(s[0] + 1, s[1], s[2], 0); window.__game.ctx.interactables.all().find((i) => i.id === 'corpse:tut_supply').interact(); }, supply);
    await waitFor(page, () => window.__ev['inventory:containerOpened'].some((e) => e.p.containerId === 'corpse:tut_supply'), 'supply corpse opened', 10000);
  }
  // 시체에서 붕대를 꺼낸 것과 같은 결과 — 가방에 붕대 한 개 (검색 연출 · 드래그는 corpse 구간이 이미 본다)
  await P(() => { const c = window.__game.ctx; c.inventory.tryAddItemAnywhere(c.loot.createItem('heal_bandage', 1)); });
  await waitFor(page, () => document.querySelector('.tut-panel .tut-obj[data-obj="supplyBandage"]')?.classList.contains('is-done'), 'bandage ticked', 5000).catch(() => null);
  ok(await step() === 'supplyLoot' && (await objRows()).find((r) => r.id === 'supplyBandage')?.done === true, '붕대를 얻으면 필수 줄이 체크되지만 창을 닫기 전에는 넘어가지 않는다');
  await P(() => window.__game.ctx.inventory.closeAll());
  await waitStep('heal', 10000);
  ok(true, '붕대를 얻고 창을 닫으면 supplyLoot → heal (체력이 가득이 아니라 머문다)');
  await waitFor(page, () => [...document.querySelectorAll('.tut-panel .tut-obj')].some((r) => r.dataset.obj === 'healHold'), 'heal rows', 5000);
  const healRows = await objRows();
  ok(healRows.map((r) => r.id).join(',') === 'healHold', `회복은 순차 공개 — 처음에는 「붕대 장착」 한 줄 (${healRows.map((r) => r.id).join(',')})`);
  ok(await P(() => (document.querySelector('.tut-panel .tut-obj[data-obj="healHold"] .tut-obj-txt')?.querySelectorAll('.keycap').length ?? 0) === 1),
    '목표 줄 안에 키캡이 그려진다 ({QUICK:hold})');
  const healCtl = await P(() => [...document.querySelectorAll('.tut-controls .tut-ctl')].map((r) => r.dataset.hint));
  ok(healCtl.includes('quick') && healCtl.includes('quickWheel'), `빠른 사용 꺼내기 · 휠 열기가 서로 다른 줄이다 (${healCtl.join(',')})`);

  /* ── 10. 벽 → 함선 → 즉시 이륙 → 정산 → 함선 ──────────────────────────── */
  console.log('탈출');
  await P(() => window.__tp(0, -10, -106, 0));
  await waitStep('grenade', 10000);
  const nadeCtl = await P(() => [...document.querySelectorAll('.tut-controls .tut-ctl')].map((r) => ({ id: r.dataset.hint, caps: r.querySelectorAll('.keycap').length, text: r.classList.contains('is-text') })));
  ok(['quick', 'quickWheel', 'grenadeThrow', 'grenadePin'].every((id) => nadeCtl.some((r) => r.id === id))
    && nadeCtl.find((r) => r.id === 'grenadeThrow')?.text && nadeCtl.find((r) => r.id === 'grenadeThrow')?.caps === 2 && nadeCtl.find((r) => r.id === 'grenadePin')?.caps === 2,
  '수류탄 단계 조작 가이드: 꺼내기 · 휠 열기 두 줄 + 토큰 문장 줄 둘 (장착 후 던지기 · 핀 뽑기)', JSON.stringify(nadeCtl));
  // 2026-09-15 맵 5차: 마지막 안드로이드 둘은 사선 방벽 뒤 (0.90,−144.88)·(3.09,−142.83), 함선은 (−8.5,−158) yaw −10°.
  //   램프 축 위(`ship` 띠 안)에 세우고 W 로 걸어 올라간다 — 옛 (0,−143) 에서 W 는 함선 오른쪽을 지나 절벽으로 떨어진다.
  await P(() => window.__killNear(2.0, -143.9, 8));
  await P(() => window.__tp(-9.76, -10, -150.86, -0.1745));
  await waitStep('extract', 10000);
  // the switch only answers someone who is aboard (`switchReady` → `boarded`) — walk up the ramp into the bay for real
  await waitSim(0.3);
  await P(() => window.__key('KeyW', true));
  await waitFor(page, () => window.__ev['extraction:boarded'].length >= 1, 'boarded (walked up the ramp)', 20000)
    .catch(async (e) => { await P(() => window.__keysUp()); console.log(`  note ${JSON.stringify(await P(() => window.__pose()))}`); throw e; });
  await P(() => window.__keysUp());
  ok(true, '램프를 걸어 올라가면 화물칸 탑승으로 친다 (extraction:boarded)');
  await waitFor(page, () => window.__game.ctx.interactables.all().some((i) => i.id === 'ship_liftoff_switch' && i.canInteract()), 'ship switch ready', 15000);
  const spot = await P(() => {
    const ctx = window.__game.ctx;
    const sw = ctx.interactables.all().find((i) => i.id === 'ship_liftoff_switch');
    const s = sw.position, p = ctx.player.position;
    // stay aboard: stand on the line from where we boarded (inside the bay) to the switch, ≤ 1.6 m from it, facing it —
    // boarding is a per-frame volume test, so a spot outside the bay would un-board us again
    const dx = p.x - s.x, dz = p.z - s.z, d = Math.hypot(dx, dz) || 1, k = Math.min(1.6, d) / d;
    const x = s.x + dx * k, z = s.z + dz * k;
    const y = p.y;
    window.__tp(x, y, z, Math.atan2(-(s.x - x), -(s.z - z)));
    return { sw: [s.x, s.y, s.z], at: [x, y, z] };
  });
  await waitSim(0.4);
  ok(await P(() => window.__game.getSystem('extraction').boarded === true), '스위치 앞에 서도 여전히 화물칸 안이다', JSON.stringify(spot));
  const prompt = await P(() => { const sw = window.__game.ctx.interactables.all().find((i) => i.id === 'ship_liftoff_switch'); return { text: sw?.getPrompt() ?? null, hp: window.__game.ctx.player.hp, lvl: window.__game.ctx.progression.level }; });
  ok(/즉시 이륙/.test(prompt.text ?? ''), `튜토리얼 함선 스위치는 즉시 이륙이라고 말한다 ("${prompt.text}")`, JSON.stringify(spot));
  const pressT = await P(() => { window.__key('KeyE', true); return window.__game.ctx.time; });
  await waitFor(page, () => window.__ev['extraction:liftoff'].length >= 1, 'liftoff', 15000).catch(async (e) => { console.log(`  note ${JSON.stringify(await P(() => ({ pose: window.__pose(), best: window.__game.getSystem('player').interactTarget?.id ?? null, blockers: [...window.__game.ctx.uiBlockers] })))}`); throw e; });
  await P(() => window.__key('KeyE', false));
  const lift = await P((t) => {
    const ctx = window.__game.ctx, ps = window.__game.getSystem('player');
    const ev = window.__ev['extraction:liftoff'][0];
    const hp0 = ctx.player.hp;
    ps.applyDamage(50, undefined, false);
    const fin = window.__ev['tutorial:finished'].slice(-1)[0]?.p ?? null;
    let saved = null; try { saved = JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'); } catch { /* */ }
    return {
      dt: ev.t - t, aboard: ev.p.aboard, squadDone: ev.p.squadDone, departs: window.__ev['extraction:departureStarted'].length,
      lock: ps._sceneLock, hp0, hp1: ctx.player.hp, dead: ctx.player.isDead, phase: ctx.phase, fin, active: ctx.tutorial.active,
      raidSave: saved?.tracks?.raid ?? null, pendingShip: saved?.pendingShip ?? null,
    };
  }, pressT);
  ok(lift.aboard === true && lift.departs === 0 && lift.dt < 2.5, `스위치를 누르면 유예 없이 곧장 뜬다 (E 누름 → 이륙 ${lift.dt.toFixed(2)} s, departureStarted ${lift.departs})`, JSON.stringify(lift));
  ok(lift.lock === true && lift.hp1 === lift.hp0 && !lift.dead && lift.phase === 'liftoff', '이륙 중에는 각본 잠금 — 피해가 들어가지 않는다', JSON.stringify(lift));
  ok(lift.fin && lift.fin.track === 'raid' && lift.fin.skipped === false && lift.active === false && lift.raidSave?.done === true && lift.pendingShip === true,
    '레이드 트랙이 완주로 끝나고 함선 트랙 예약(pendingShip)이 남는다', JSON.stringify(lift));
  const trail = await P(() => window.__trail);
  ok(trail.join(' ') === RAID_STEPS.join(' '), `밟은 단계가 레이드 트랙 ${RAID_STEPS.length}단계 그대로다 (${trail.join(' → ')})`);

  await waitFor(page, () => window.__ev['game:complete'].length >= 1, 'game:complete', 30000);
  const done = await P(() => {
    const ctx = window.__game.ctx;
    const s = window.__ev['game:complete'][0].p.stats;
    const screen = [...document.querySelectorAll('.menu')].find((m) => !m.classList.contains('hidden') && /탈출 성공/.test(m.textContent ?? ''));
    return { extracted: s.extracted, mode: s.mode, rewards: s.rewards, level: ctx.progression.level, xp: ctx.progression.xp, phase: ctx.phase, screen: !!screen, over: window.__ev['game:over'].length };
  });
  const wantLevel = levelFromXp(TUTORIAL_RAID_XP);
  ok(done.extracted === true && done.mode === 'tutorial' && done.phase === 'complete' && done.screen && done.over === 0,
    '결과 화면(탈출 성공)이 뜨고 탈출로 정산된다', JSON.stringify({ ...done, rewards: undefined }));
  ok(done.rewards?.xpEarned === TUTORIAL_RAID_XP && done.rewards?.contract === null,
    `튜토리얼 완주 XP 는 정산식이 아니라 TUTORIAL_RAID_XP 고정 (${done.rewards?.xpEarned} = ${TUTORIAL_RAID_XP}, 계약 정산 없음)`, JSON.stringify(done.rewards));
  ok(done.rewards?.levelBefore === 1 && done.rewards?.levelAfter === wantLevel && done.level === wantLevel,
    `레벨 1 → ${wantLevel} (csv 곡선으로 계산)`, JSON.stringify(done.rewards));
  ok(wantLevel === 2 && done.level === 2, `정확히 레벨 2 다 (TUTORIAL_RAID_XP ${TUTORIAL_RAID_XP} · XP_BASE ${K('XP_BASE')})`);

  const back = await P(() => {
    const b = [...document.querySelectorAll('.menu:not(.hidden) .ui-btn')].find((x) => x.textContent === '함선으로 귀환');
    b?.click();
    return !!b;
  });
  ok(back, '결과 화면의 `함선으로 귀환` 버튼');
  await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__ev['hub:entered'].length >= 1, 'personal ship', 30000);
  await waitSim(0.3);
  const hub = await P(() => {
    const ctx = window.__game.ctx, t = ctx.tutorial;
    let saved = null, solo = null;
    try { saved = JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'); solo = localStorage.getItem('scav.s1.soloraid'); } catch { /* */ }
    return {
      ship: window.__ev['hub:entered'].slice(-1)[0].p.ship, track: t.track, step: t.step, raidDone: t.isTrackDone('raid'),
      pendingShip: saved?.pendingShip ?? null, solo, level: ctx.progression.level, mode: ctx.missionMode,
    };
  });
  ok(hub.ship === 'personal' && hub.track === 'ship' && hub.step === 'levelUp' && hub.raidDone === true,
    '개인 함선에 들어서면 함선 트랙이 levelUp 에서 시작한다 (레이드 트랙은 끝)', JSON.stringify(hub));
  ok(hub.pendingShip === false && hub.solo === null && hub.level === 2, '예약은 소비되고 솔로 레이드 세이브는 지워지고 레벨 2 가 남는다', JSON.stringify(hub));

  ok(errors.length === 0, `no console errors (${errors.length})`, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.message}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed, ${errors.length} console errors (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(fail === 0 ? 0 : 1);
