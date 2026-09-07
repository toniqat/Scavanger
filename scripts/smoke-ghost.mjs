// Single-player smoke test for the Phase 7 player package (src/player): `restoreState` states 0 / 1 / 2 (no hellpod,
// no `player:died`), the `world:ready` drop skipped while `ctx.rejoinPending`, `isMeleeHeavy`, knockback (ignored while
// downed, cancels a roll, lifts off the ground), remote avatar poses driven by the new PlayerFlags through
// `remotePlayers.debugSpawn` (THROWING / COOKING / CHARGING / SPRAYING / HEAVY / MELEE_HEAVY / OVERCHARGED, held-item
// mesh from `heldItemId`, armor plates from `armorId`), and host-side ghosts of suspended members via `debugSuspend`
// (creation, `ghost:damage` → downed → bleed → dead, knockback nudge, revive through the interactable, host
// demotion / promotion rebuild, rejoin restore wire). Phase 9: a ghost built from a downed ref inherits `ref.downHp`
// (clamped 1..PLAYER_DOWN_HP), `ref.ghostState / ghostDownHp` mirror the ghost, and **parked ghosts** — a member that
// left the mission (`net:missionMembership {inMission:false}`) or whose socket came back without `flow rejoined`
// keeps a non-simulated body for NET_GHOST_PARK_S (`getParkedGhosts`), restored by a rejoin inside the window, expired
// after it (`debugExpireParked`), cleared by demotion / `game:abort`.
// Phase 10: the soldier model's `shoulderSocket` (weaponSocket still at -PI/2, `SoldierPose.carry`) and
// **부상자 들쳐메기** — `findCarriable` / `carry` / the revive prompt following the socket / the automatic drop when
// the body is revived / `setCarriedBy` riding along on a carrier's shoulder (`debugCarryLocal`).
// Usage: node scripts/smoke-ghost.mjs [http://localhost:5273]   (needs `npm run dev` or a private `npx vite --port 5303`)
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
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch (e) { /* loading */ }
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
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // Park vite's HMR socket: a save in another editor would otherwise full-reload the page mid-run and wipe the
    // test state (window.__V / __rp). The game's own relay socket (no 'vite-hmr' protocol) is untouched.
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
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.player, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['player:spawned', 'player:died', 'player:downed', 'player:downHpChanged', 'player:healthChanged', 'player:landed',
      'player:launched', 'net:remoteHeldItem', 'net:ghostState', 'world:ready', 'player:carryStarted', 'player:carryEnded']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
    window.__rp = window.__game.getSystem('remotePlayers');
    window.__ps = window.__game.getSystem('player');
    window.__V = window.__game.ctx.player.position.constructor;
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const evCount = async (n) => (await ev(n)).length;
  const P = (fn, arg) => page.evaluate(fn, arg);

  console.log('mission (seed 21)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 21 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);

  console.log('isMeleeHeavy / dive pose removed');
  const mh = await P(() => { const p = window.__game.ctx.player; const a = p.isMeleeHeavy; const started = p.startMelee('heavy'); return { a, started, b: p.isMeleeHeavy, meleeing: p.isMeleeing }; });
  ok(mh.a === false && mh.started && mh.b === true && mh.meleeing, 'startMelee(heavy) → isMeleeHeavy true', JSON.stringify(mh));
  await waitSim(0.8);
  const mh2 = await P(() => ({ heavy: window.__game.ctx.player.isMeleeHeavy, meleeing: window.__game.ctx.player.isMeleeing }));
  ok(!mh2.heavy && !mh2.meleeing, 'isMeleeHeavy false after SLASH_DURATION', JSON.stringify(mh2));
  await waitSim(0.6);
  const ml = await P(() => { const p = window.__game.ctx.player; const s = p.startMelee('light'); return { s, heavy: p.isMeleeHeavy, meleeing: p.isMeleeing }; });
  ok(ml.s && !ml.heavy && ml.meleeing, 'light swing → isMeleeHeavy stays false', JSON.stringify(ml));
  await waitSim(0.8);
  const poseKeys = await P(() => Object.keys(window.__ps.pose));
  ok(!poseKeys.includes('dive') && poseKeys.includes('cooking'), 'SoldierPose has no `dive` field any more (and has `cooking`)', poseKeys.join(','));

  console.log('restoreState 0 (alive, no hellpod)');
  const r0 = await P(() => {
    const ctx = window.__game.ctx; const p = ctx.player; const V = window.__V;
    const base = p.position.clone(); const target = new V(base.x + 6, 0, base.z + 4);
    target.y = ctx.world.getHeightAt(target.x, target.z);
    const spawnedBefore = window.__ev['player:spawned'].length;
    p.restoreState({ position: target, yaw: 1.2, hp: 55, downHp: 0, state: 0 });
    return { spawnedBefore, spawned: window.__ev['player:spawned'].length, target: [target.x, target.y, target.z], pos: [p.position.x, p.position.y, p.position.z],
      hp: p.hp, downed: p.isDowned, dead: p.isDead, dropping: p.isDropping, yaw: p.yaw, stance: p.stance, canUse: p.canUseWeapons(), visible: p.object.visible };
  });
  ok(r0.spawned === r0.spawnedBefore + 1, 'player:spawned emitted once', JSON.stringify(r0));
  ok(Math.hypot(r0.pos[0] - r0.target[0], r0.pos[2] - r0.target[2]) < 0.05 && Math.abs(r0.pos[1] - r0.target[1]) < 0.3, 'stands at the restored position', JSON.stringify(r0));
  ok(r0.hp === 55 && !r0.downed && !r0.dead && !r0.dropping && r0.stance === 'stand' && r0.canUse && r0.visible, 'hp 55, alive, not dropping, weapons usable, visible', JSON.stringify(r0));
  ok(Math.abs(r0.yaw - 1.2) < 0.01, 'camera yaw = restored yaw', String(r0.yaw));
  await waitSim(0.5);
  const r0b = await P(() => ({ dropping: window.__game.ctx.player.isDropping, landed: window.__ev['player:landed'].length }));
  ok(!r0b.dropping, 'no hellpod after restore', JSON.stringify(r0b));

  console.log('restoreState 1 (downed with downHp)');
  const r1 = await P(() => {
    const ctx = window.__game.ctx; const p = ctx.player;
    const downedBefore = window.__ev['player:downed'].length; const spawnedBefore = window.__ev['player:spawned'].length;
    p.restoreState({ position: p.position.clone(), yaw: 0.4, hp: 0, downHp: 40, state: 1 });
    return { downedEv: window.__ev['player:downed'].length - downedBefore, spawnedEv: window.__ev['player:spawned'].length - spawnedBefore,
      downed: p.isDowned, dead: p.isDead, downHp: p.downHp, hp: p.hp, stance: p.stance, canUse: p.canUseWeapons(), died: window.__ev['player:died'].length };
  });
  ok(r1.downed && !r1.dead && r1.downHp === 40 && r1.hp === 0 && r1.stance === 'prone' && !r1.canUse, 'downed, downHp 40, prone, weapons off', JSON.stringify(r1));
  ok(r1.downedEv === 1 && r1.spawnedEv === 1, 'player:downed + player:spawned emitted', JSON.stringify(r1));
  await waitSim(2.2);
  const r1b = await P(() => ({ downHp: window.__game.ctx.player.downHp, downed: window.__game.ctx.player.isDowned }));
  ok(r1b.downed && r1b.downHp <= 38 && r1b.downHp >= 36, 'bleeds after the restore', JSON.stringify(r1b));

  console.log('knockback while downed is ignored');
  const kbDown = await P(() => { const p = window.__game.ctx.player; const V = window.__V; const v0 = p.velocity.length(); p.applyKnockback(new V(1, 0.3, 0), 14); return { v0, v1: p.velocity.length(), grounded: p.isGrounded }; });
  ok(kbDown.v1 < 0.5 && kbDown.grounded, 'applyKnockback ignored while downed', JSON.stringify(kbDown));

  console.log('restoreState 2 (dead, no player:died)');
  const r2 = await P(() => {
    const ctx = window.__game.ctx; const p = ctx.player;
    const diedBefore = window.__ev['player:died'].length; const spawnedBefore = window.__ev['player:spawned'].length;
    p.restoreState({ position: p.position.clone(), yaw: 0, hp: 0, downHp: 0, state: 2 });
    return { diedEv: window.__ev['player:died'].length - diedBefore, spawnedEv: window.__ev['player:spawned'].length - spawnedBefore,
      dead: p.isDead, downed: p.isDowned, hp: p.hp, canUse: p.canUseWeapons(), visible: p.object.visible, phase: ctx.phase };
  });
  ok(r2.dead && !r2.downed && r2.hp === 0 && !r2.canUse && r2.visible, 'dead flag set, weapons off, body visible', JSON.stringify(r2));
  ok(r2.diedEv === 0 && r2.spawnedEv === 0, 'no player:died / player:spawned re-emitted (game/ owns the flow)', JSON.stringify(r2));
  const kbDead = await P(() => { const p = window.__game.ctx.player; const V = window.__V; const v0 = p.velocity.length(); p.applyKnockback(new V(1, 0.3, 0), 14); return { v0, v1: p.velocity.length() }; });
  ok(kbDead.v1 < 0.5, 'applyKnockback ignored while dead', JSON.stringify(kbDead));
  // back to life the normal way (game/ would run its respawn flow)
  await P(() => { const ctx = window.__game.ctx; ctx.player.respawn(ctx.world.getPlayerSpawn()); });
  await waitFor(page, () => !window.__game.ctx.player.isDropping && !window.__game.ctx.player.isDead, 'respawn landed', 15000);
  await waitSim(0.5);

  console.log('knockback: lift-off + roll cancel');
  const kbUp = await P(() => { const p = window.__game.ctx.player; const V = window.__V; const g0 = p.isGrounded; p.applyKnockback(new V(0, 0, 1), 10); return { g0, g1: p.isGrounded, vy: p.velocity.y, vz: p.velocity.z, launched: window.__ev['player:launched'].length }; });
  ok(kbUp.g0 && !kbUp.g1 && kbUp.vy >= 1.4 && kbUp.vz > 8, 'flat knockback lifts off (grounded cleared, min lift) and shoves', JSON.stringify(kbUp));
  ok(kbUp.launched === 0, 'no player:launched for a knockback', String(kbUp.launched));
  await waitFor(page, () => window.__game.ctx.player.isGrounded, 'landed again', 10000);
  await waitSim(0.5);
  const kbRoll = await P(() => { const p = window.__game.ctx.player; const V = window.__V; const rolled = p.roll(new V(0, 0, -1)); const r0 = p.isRolling; p.applyKnockback(new V(1, 0.2, 0), 8); return { rolled, r0, r1: p.isRolling }; });
  ok(kbRoll.rolled && kbRoll.r0 && !kbRoll.r1, 'knockback cancels an in-flight roll', JSON.stringify(kbRoll));
  await waitSim(1.5);

  console.log('world:ready while rejoinPending → no hellpod drop');
  const rj = await P(() => {
    const ctx = window.__game.ctx;
    ctx.rejoinPending = true;
    const spawnedBefore = window.__ev['player:spawned'].length;
    ctx.bus.emit('game:newMission', { seed: 22 });
    const p = ctx.player;
    return { ready: ctx.world && ctx.world.ready && ctx.world.seed === 22, spawnedDelta: window.__ev['player:spawned'].length - spawnedBefore, dropping: p.isDropping, visible: p.object.visible, canUse: p.canUseWeapons() };
  });
  ok(rj.ready && rj.spawnedDelta === 0 && !rj.dropping && !rj.visible && !rj.canUse, 'new world generated, player parked (hidden, no drop, no spawned)', JSON.stringify(rj));
  await waitSim(0.6);
  const rj2 = await P(() => {
    const ctx = window.__game.ctx; const p = ctx.player;
    const s = ctx.world.getPlayerSpawn().clone(); s.x += 3; s.y = ctx.world.getHeightAt(s.x, s.z);
    p.restoreState({ position: s, yaw: 0, hp: 80, downHp: 0, state: 0 });
    ctx.rejoinPending = false;
    ctx.setPhase('playing');
    return { dropping: p.isDropping, visible: p.object.visible, hp: p.hp, canUse: p.canUseWeapons(), inHub: !!p.interior };
  });
  ok(!rj2.dropping && rj2.visible && rj2.hp === 80 && rj2.canUse && !rj2.inHub, 'restoreState after the rejoin world: visible, hp 80, no interior', JSON.stringify(rj2));
  await waitSim(0.3);

  console.log('remote avatar: Phase 7 poses');
  const flags = await P(() => import('/src/shared/index.ts').then((m) => m.PlayerFlags).catch(() => null));
  const PF = flags ?? { HAS_WEAPON: 1 << 6, TWO_HANDED: 1 << 7, HOLDING_ITEM: 1 << 12, OVERCHARGED: 1 << 19, THROWING: 1 << 20, COOKING: 1 << 21, CHARGING: 1 << 22, SPRAYING: 1 << 23, HEAVY: 1 << 24, MELEE_HEAVY: 1 << 25, MELEE: 1 << 17 };
  ok(flags && flags.THROWING === (1 << 20) && flags.MELEE_HEAVY === (1 << 25), 'PlayerFlags Phase 7 bits present', JSON.stringify(flags && { T: flags.THROWING, MH: flags.MELEE_HEAVY }));
  const av0 = await P((pf) => {
    const rp = window.__rp; const ref = rp.debugSpawn({ id: 'dbg-a', slot: 1, flags: pf.HOLDING_ITEM | pf.THROWING, heldItemId: 'grenade_frag' });
    window.__refA = ref; return { id: ref.id };
  }, PF);
  await waitSim(0.6);
  const av1 = await P(() => { const av = window.__rp.getAvatar('dbg-a'); const kids = av.weaponSocket.children.map((c) => c.name); return { held: av.heldItemId, kids, throw: av.poseView.throw, hold: av.poseView.holdItem, shown: av.isShown, events: window.__ev['net:remoteHeldItem'] }; });
  ok(av1.shown && av1.held === 'grenade_frag' && av1.kids.some((n) => n === 'HeldItem:grenade'), 'held grenade → sphere mesh in the hand', JSON.stringify(av1));
  ok(av1.throw > 0.6, 'THROWING → wind-up pose', String(av1.throw));
  ok(av1.events.some((e) => e.id === 'dbg-a' && e.defId === 'grenade_frag'), 'net:remoteHeldItem emitted', JSON.stringify(av1.events));
  await P((pf) => { window.__refA.flags = pf.HOLDING_ITEM | pf.COOKING; window.__refA.heldItemId = 'stim'; }, PF);
  await waitSim(0.6);
  const av2 = await P(() => { const av = window.__rp.getAvatar('dbg-a'); return { held: av.heldItemId, kids: av.weaponSocket.children.map((c) => c.name), cooking: av.poseView.cooking, throw: av.poseView.throw }; });
  ok(av2.held === 'stim' && av2.kids.some((n) => n === 'HeldItem:stim') && !av2.kids.some((n) => n === 'HeldItem:grenade'), 'held stim → cylinder replaces the grenade', JSON.stringify(av2));
  ok(av2.cooking > 0.6 && av2.throw < 0.2, 'COOKING → pin-pull pose', JSON.stringify(av2));
  await P((pf) => { window.__refA.flags = pf.HAS_WEAPON | pf.CHARGING; window.__refA.heldItemId = null; }, PF);
  await waitSim(0.6);
  const av3 = await P(() => { const av = window.__rp.getAvatar('dbg-a'); const ev = window.__ev['net:remoteHeldItem']; return { held: av.heldItemId, kids: av.weaponSocket.children.map((c) => c.name), charging: av.poseView.charging, last: ev[ev.length - 1] }; });
  ok(av3.held === null && !av3.kids.some((n) => n.startsWith('HeldItem')) && av3.last && av3.last.defId === null, 'weapon back → held mesh removed + null event', JSON.stringify(av3));
  ok(av3.charging > 0.6, 'CHARGING → braced pose', String(av3.charging));
  await P((pf) => { window.__refA.flags = pf.HAS_WEAPON | pf.SPRAYING; }, PF);
  await waitSim(0.5);
  const av4 = await P(() => { const av = window.__rp.getAvatar('dbg-a'); return { spraying: av.poseView.spraying, charging: av.poseView.charging }; });
  ok(av4.spraying > 0.6 && av4.charging < 0.2, 'SPRAYING → hip spray pose', JSON.stringify(av4));
  await P((pf) => { window.__refA.flags = pf.HAS_WEAPON | pf.HEAVY; }, PF);
  await waitSim(0.6);
  const av5 = await P(() => { const av = window.__rp.getAvatar('dbg-a'); return { heavy: av.poseView.heavyCarry, spraying: av.poseView.spraying }; });
  ok(av5.heavy > 0.6 && av5.spraying < 0.2, 'HEAVY → heavy carry pose', JSON.stringify(av5));
  await P((pf) => { window.__refA.flags = pf.HAS_WEAPON | pf.MELEE | pf.MELEE_HEAVY; }, PF);
  await waitSim(0.25);
  const av6 = await P(() => { const av = window.__rp.getAvatar('dbg-a'); return { prog: av.heavySlashProgress, heavy: av.poseView.meleeHeavy, melee: av.poseView.melee }; });
  ok(av6.prog > 0.1 && av6.prog < 0.9 && av6.heavy === 1 && av6.melee > 0, 'MELEE_HEAVY → 용검 sweep in progress', JSON.stringify(av6));
  await waitSim(0.7);
  const av7 = await P(() => { const av = window.__rp.getAvatar('dbg-a'); return { prog: av.heavySlashProgress, heavy: av.poseView.meleeHeavy, melee: av.poseView.melee }; });
  ok(av7.prog === 0 && av7.heavy === 0 && av7.melee === 0, 'sweep ends after SLASH_DURATION', JSON.stringify(av7));
  await P((pf) => { window.__refA.flags = pf.HAS_WEAPON | pf.OVERCHARGED; window.__refA.armorId = 'armor_2'; }, PF);
  await waitSim(0.6);
  const av8 = await P(() => { const av = window.__rp.getAvatar('dbg-a'); const ctx = window.__game.ctx; const def = ctx.loot.getItemDef('armor_2'); const plate = av.root.getObjectByName(`ArmorPlate:${def ? def.armorId : 'armor_2'}`) || av.root.getObjectByName('ArmorPlate:armor_2'); return { armor: av.armorId, plate: !!plate, link: def ? def.armorId : null, glow: av.model.glowAmount }; });
  ok(av8.armor !== null && av8.plate, 'ar armor_2 → armor plate group on the torso', JSON.stringify(av8));
  ok(av8.glow > 0.3, 'OVERCHARGED → rim glow', String(av8.glow));
  await P(() => { window.__refA.armorId = null; window.__refA.flags = 0; });
  await waitSim(0.5);
  const av9 = await P(() => { const av = window.__rp.getAvatar('dbg-a'); return { armor: av.armorId, plates: av.root.children.length && !av.root.getObjectByName('ArmorPlate:' + (av.armorId || 'x')), glow: av.model.glowAmount }; });
  ok(av9.armor === null && av9.glow < 0.1, 'armor cleared + glow fades', JSON.stringify(av9));
  const local = await P(() => { const ps = window.__ps; const ctx = window.__game.ctx; const eq = ctx.inventory.getEquipped('armor'); return { armor: ps.model.armorId, equipped: eq ? eq.defId : null }; });
  ok(local.equipped ? local.armor !== null : local.armor === null, 'local soldier shows the equipped armor plate (same helper)', JSON.stringify(local));

  console.log('ghosts (host simulation of a suspended member)');
  const g0 = await P(() => {
    const rp = window.__rp; const ref = rp.debugSpawn({ id: 'dbg-b', slot: 2 }); window.__refB = ref;
    ref.hp = 100;
    return { ghosts: rp.getGhosts().size };
  });
  await waitSim(0.2);
  const g1 = await P(() => {
    const rp = window.__rp; const before = window.__ev['net:ghostState'].length;
    const g = rp.debugSuspend('dbg-b', true);
    const av = rp.getAvatar('dbg-b');
    return { created: !!g, st: g && g.state, hp: g && g.hp, suspended: window.__refB.suspended, stale: window.__refB.stale, ev: window.__ev['net:ghostState'].length - before, ghosts: rp.getGhosts().size };
  });
  ok(g0.ghosts === 0 && g1.created && g1.st === 0 && g1.hp === 100 && g1.ghosts === 1, 'net:peerSuspended → ghost (st 0, hp 100)', JSON.stringify(g1));
  ok(g1.ev === 1, 'net:ghostState emitted on creation', String(g1.ev));
  await waitSim(0.4);
  const g2 = await P(() => { const av = window.__rp.getAvatar('dbg-b'); return { shown: av.isShown, greyed: av.isGreyed, sil: av.model.silhouetteVisible, stale: window.__refB.stale }; });
  ok(g2.shown && g2.stale, 'suspended avatar stays visible while stale', JSON.stringify(g2));
  ok(g2.greyed && !g2.sil, 'grey tint, no silhouette', JSON.stringify(g2));
  const g3 = await P(() => {
    const rp = window.__rp; const V = window.__V; const g = rp.getGhost('dbg-b'); const x0 = g.position.x;
    window.__game.ctx.bus.emit('ghost:damage', { id: 'dbg-b', amount: 120, kb: { direction: new V(1, 0, 0), speed: 10 } });
    return { st: g.state, hp: g.hp, downHp: g.downHp, dx: g.position.x - x0, refDowned: window.__refB.isDowned, refHp: window.__refB.hp, revives: rp.getReviveTargets() };
  });
  ok(g3.st === 1 && g3.hp === 0 && g3.downHp === 100, 'ghost:damage 120 → downed with downHp 100', JSON.stringify(g3));
  ok(g3.dx > 0.5 && g3.dx <= 2.01, 'knockback nudges the ghost', String(g3.dx));
  ok(g3.refDowned && g3.refHp === 0, 'host ref mirrors the ghost (downed, hp 0)', JSON.stringify(g3));
  const g3s = await P(() => ({ st: window.__refB.ghostState, dhp: window.__refB.ghostDownHp }));
  ok(g3s.st === 1 && g3s.dhp === 100, 'Phase 9: ref.ghostState 1 / ghostDownHp 100 (the wipe check reads the ref)', JSON.stringify(g3s));
  await waitSim(0.5);
  const g3b = await P(() => { const av = window.__rp.getAvatar('dbg-b'); return { prone: av.poseView.prone, shown: av.isShown, revives: window.__rp.getReviveTargets() }; });
  ok(g3b.shown && g3b.prone > 0.5, 'downed ghost → prone pose on the grey avatar', JSON.stringify(g3b));
  ok(g3b.revives.includes('dbg-b'), 'revive interactable offered on the suspended body (next frame)', JSON.stringify(g3b.revives));
  await waitSim(2.2);
  const g4 = await P(() => { const g = window.__rp.getGhost('dbg-b'); return { downHp: g.downHp, st: g.state, ev: window.__ev['net:ghostState'].length }; });
  ok(g4.st === 1 && g4.downHp <= 98 && g4.downHp >= 96, 'ghost bleeds GHOST_BLEED_PER_SEC', JSON.stringify(g4));
  ok(g4.ev >= 6, 'ghost state broadcast at NET_GHOST_STATE_HZ (+ changes)', String(g4.ev));
  const g5 = await P(() => {
    const rp = window.__rp; const entry = rp.revives.get('dbg-b');
    if (!entry) return { noEntry: true };
    entry.interactable.interact();
    const g = rp.getGhost('dbg-b');
    return { st: g.state, hp: g.hp, downHp: g.downHp, refDowned: window.__refB.isDowned, refHp: window.__refB.hp };
  });
  ok(!g5.noEntry && g5.st === 0 && g5.hp === 10 && g5.downHp === 0 && !g5.refDowned, 'revive interactable on the suspended body → ghost back up with PLAYER_REVIVE_HP', JSON.stringify(g5));
  const g6 = await P(() => {
    const bus = window.__game.ctx.bus; const rp = window.__rp;
    bus.emit('ghost:damage', { id: 'dbg-b', amount: 50 });
    const a = { st: rp.getGhost('dbg-b').state };
    bus.emit('ghost:damage', { id: 'dbg-b', amount: 500 });
    const g = rp.getGhost('dbg-b');
    return { a: a.st, st: g.state, hp: g.hp, refDead: window.__refB.isDead, refDowned: window.__refB.isDowned, revives: rp.getReviveTargets() };
  });
  ok(g6.a === 1 && g6.st === 2 && g6.hp === 0 && g6.refDead && !g6.refDowned && !g6.revives.includes('dbg-b'), 'damage → downed → dead; ref dead, no revive offered', JSON.stringify(g6));
  await waitSim(1.2);
  const g7 = await P(() => { const av = window.__rp.getAvatar('dbg-b'); return { dead: av.poseView.dead, shown: av.isShown, greyed: av.isGreyed }; });
  ok(g7.shown && g7.dead >= 0.99 && g7.greyed, 'dead ghost → death pose on the grey avatar', JSON.stringify(g7));
  const g8 = await P(() => { const rp = window.__rp; const wire = rp.debugRejoin('dbg-b'); return { wire, ghosts: rp.getGhosts().size, last: rp.getLastGhostStates().has('dbg-b') }; });
  ok(g8.wire && g8.wire.st === 2 && g8.wire.id === 'dbg-b' && g8.ghosts === 0 && !g8.last, 'flow rejoined → restore wire (st 2) and the ghost is gone', JSON.stringify(g8));

  console.log('ghost from a downed ref + host demotion / promotion');
  const h0 = await P(() => {
    const rp = window.__rp; const ref = rp.debugSpawn({ id: 'dbg-c', slot: 3, isDowned: true, downHp: 37 }); ref.hp = 0; window.__refC = ref;
    const g = rp.debugSuspend('dbg-c', true);
    return { st: g && g.state, downHp: g && g.downHp, refSt: ref.ghostState, refDhp: ref.ghostDownHp };
  });
  ok(h0.st === 1 && h0.downHp === 37, 'Phase 9: suspending a downed ref → ghost st 1 inherits its down pool (downHp 37)', JSON.stringify(h0));
  ok(h0.refSt === 1 && h0.refDhp === 37, 'ref.ghostState 1 / ghostDownHp 37 written by applyToRef', JSON.stringify(h0));
  const h0b = await P(() => {
    const rp = window.__rp; rp.debugClear('dbg-c');
    const ref = rp.debugSpawn({ id: 'dbg-c', slot: 3, isDowned: true, downHp: 999 }); ref.hp = 0; window.__refC = ref;
    const a = rp.debugSuspend('dbg-c', true); const clampedHi = a && a.downHp;
    rp.debugClear('dbg-c');
    const ref2 = rp.debugSpawn({ id: 'dbg-c', slot: 3, isDowned: true, downHp: 0 }); ref2.hp = 0; window.__refC = ref2;
    const b = rp.debugSuspend('dbg-c', true); const clampedLo = b && b.downHp;
    rp.debugClear('dbg-c');
    const ref3 = rp.debugSpawn({ id: 'dbg-c', slot: 3, isDowned: true }); ref3.hp = 0; window.__refC = ref3;
    const c = rp.debugSuspend('dbg-c', true); const unknown = c && c.downHp;
    return { clampedHi, clampedLo, unknown };
  });
  ok(h0b.clampedHi === 100 && h0b.clampedLo === 1 && h0b.unknown === 100, 'downHp clamped 1..PLAYER_DOWN_HP, unknown → full pool', JSON.stringify(h0b));
  const h1 = await P(() => {
    const rp = window.__rp; const bus = window.__game.ctx.bus;
    bus.emit('ghost:damage', { id: 'dbg-c', amount: 30 });
    const before = { downHp: rp.getGhost('dbg-c').downHp };
    bus.emit('net:hostChanged', { hostId: 'other', prev: 'me', isLocalHost: false });
    const demoted = rp.getGhosts().size;
    bus.emit('net:hostChanged', { hostId: 'me', prev: 'other', isLocalHost: true });
    const g = rp.getGhost('dbg-c');
    return { before, demoted, rebuilt: !!g, st: g && g.state, downHp: g && g.downHp };
  });
  ok(h1.demoted === 0, 'demotion drops the ghosts', String(h1.demoted));
  ok(h1.rebuilt && h1.st === 1 && h1.downHp === h1.before.downHp, 'promotion rebuilds the ghost from the last state (downHp kept)', JSON.stringify(h1));
  await P(() => { window.__rp.debugClear(); });
  await waitSim(0.2);
  const cleared = await P(() => ({ ghosts: window.__rp.getGhosts().size, avatars: window.__rp.getAvatars().size, revives: window.__rp.getReviveTargets().length }));
  ok(cleared.ghosts === 0 && cleared.avatars === 0 && cleared.revives === 0, 'debugClear removes ghosts, avatars and revive prompts', JSON.stringify(cleared));

  console.log('Phase 9: parked ghosts (member left the mission without rejoining)');
  const k0 = await P(() => {
    const rp = window.__rp; const bus = window.__game.ctx.bus; const ctx = window.__game.ctx;
    const ref = rp.debugSpawn({ id: 'dbg-d', slot: 2 }); ref.hp = 80; window.__refD = ref;
    rp.debugSuspend('dbg-d', true);
    bus.emit('ghost:damage', { id: 'dbg-d', amount: 30 });
    const active = { st: rp.getGhost('dbg-d').state, hp: rp.getGhost('dbg-d').hp, refSt: ref.ghostState };
    const evBefore = window.__ev['net:ghostState'].length;
    bus.emit('net:missionMembership', { id: 'dbg-d', inMission: false });
    const p = rp.getParkedGhosts().get('dbg-d');
    window.__parkEv = window.__ev['net:ghostState'].length;
    return { active, ghosts: rp.getGhosts().size, parked: rp.getParkedGhosts().size, wireHp: p && p.wire.hp, wireSt: p && p.wire.st, window: p && (p.until - ctx.time),
      last: rp.getLastGhostStates().has('dbg-d'), refSt: ref.ghostState, refDhp: ref.ghostDownHp, refHp: ref.hp, evDelta: window.__ev['net:ghostState'].length - evBefore };
  });
  ok(k0.active.st === 0 && k0.active.hp === 50 && k0.active.refSt === 0, 'active ghost hp 50 before parking (ref.ghostState 0)', JSON.stringify(k0.active));
  ok(k0.ghosts === 0 && k0.parked === 1 && k0.wireHp === 50 && k0.wireSt === 0, 'net:missionMembership {inMission:false} → ghost parked with its last wire (hp 50)', JSON.stringify(k0));
  ok(k0.window > 119 && k0.window <= 120.01, 'parked until ctx.time + NET_GHOST_PARK_S (120 s)', String(k0.window));
  ok(!k0.last && k0.refSt === undefined && k0.refDhp === undefined && k0.evDelta === 0, 'lastGhost dropped, ref.ghostState cleared, no net:ghostState on parking', JSON.stringify(k0));
  await waitSim(1.5);
  const k1 = await P(() => {
    const rp = window.__rp; const bus = window.__game.ctx.bus;
    const ev = window.__ev['net:ghostState'].length - window.__parkEv;
    bus.emit('ghost:damage', { id: 'dbg-d', amount: 500 });
    const p = rp.getParkedGhosts().get('dbg-d');
    return { ev, parked: rp.getParkedGhosts().size, wireHp: p && p.wire.hp, wireSt: p && p.wire.st, ghosts: rp.getGhosts().size };
  });
  ok(k1.ev === 0 && k1.parked === 1 && k1.wireHp === 50 && k1.wireSt === 0 && k1.ghosts === 0, 'parked ghost is not simulated: no broadcasts, ghost:damage ignored', JSON.stringify(k1));
  const k2 = await P(() => { const rp = window.__rp; const wire = rp.debugRejoin('dbg-d'); return { wire, parked: rp.getParkedGhosts().size, ghosts: rp.getGhosts().size, again: rp.debugRejoin('dbg-d') }; });
  ok(k2.wire && k2.wire.id === 'dbg-d' && k2.wire.hp === 50 && k2.wire.st === 0 && k2.parked === 0 && k2.ghosts === 0, 'flow rejoined inside the window → ghost restore from the parked wire, entry forgotten', JSON.stringify(k2));
  ok(k2.again === null, 'a second rejoin has nothing to restore', JSON.stringify(k2.again));
  const k3 = await P(() => {
    const rp = window.__rp; const bus = window.__game.ctx.bus;
    window.__refD.hp = 64;
    rp.debugSuspend('dbg-d', true);
    bus.emit('ghost:damage', { id: 'dbg-d', amount: 70 });
    const active = { st: rp.getGhost('dbg-d').state, dhp: rp.getGhost('dbg-d').downHp };
    rp.debugSuspend('dbg-d', false);   // socket back without `flow rejoined` → parked
    const p = rp.getParkedGhosts().get('dbg-d');
    return { active, ghosts: rp.getGhosts().size, parked: rp.getParkedGhosts().size, wireSt: p && p.wire.st, wireDhp: p && p.wire.dhp, expired: rp.debugExpireParked('dbg-d') };
  });
  ok(k3.active.st === 1 && k3.active.dhp === 100, 'a fresh suspension makes a new ghost (downed by damage)', JSON.stringify(k3.active));
  ok(k3.ghosts === 0 && k3.parked === 1 && k3.wireSt === 1 && k3.wireDhp === 100, 'net:peerSuspended {suspended:false} with a ghost → parked (st 1, dhp 100)', JSON.stringify(k3));
  await waitSim(0.3);
  const k4 = await P(() => { const rp = window.__rp; return { parked: rp.getParkedGhosts().size, rejoin: rp.debugRejoin('dbg-d'), ghosts: rp.getGhosts().size }; });
  ok(k3.expired && k4.parked === 0 && k4.rejoin === null && k4.ghosts === 0, 'expiry (until reached) forgets the parked body: a late rejoin restores nothing', JSON.stringify(k4));
  const k5 = await P(() => {
    const rp = window.__rp; const bus = window.__game.ctx.bus;
    rp.debugSuspend('dbg-d', true);
    bus.emit('net:missionMembership', { id: 'dbg-d', inMission: false });
    window.__refD.suspended = false;   // net: inMission false ⇒ not suspended (no rebuild on promotion)
    const parkedBefore = rp.getParkedGhosts().size;
    bus.emit('net:hostChanged', { hostId: 'other', prev: 'me', isLocalHost: false });
    const afterDemotion = rp.getParkedGhosts().size;
    bus.emit('net:hostChanged', { hostId: 'me', prev: 'other', isLocalHost: true });
    return { parkedBefore, afterDemotion, ghosts: rp.getGhosts().size, parked: rp.getParkedGhosts().size };
  });
  ok(k5.parkedBefore === 1 && k5.afterDemotion === 0 && k5.parked === 0 && k5.ghosts === 0, 'demotion clears parked bodies; promotion does not resurrect them', JSON.stringify(k5));
  const k6 = await P(() => {
    const rp = window.__rp; const bus = window.__game.ctx.bus;
    rp.debugSuspend('dbg-d', true);
    bus.emit('net:missionMembership', { id: 'dbg-d', inMission: false });
    const parkedBefore = rp.getParkedGhosts().size;
    bus.emit('game:abort', {});
    return { parkedBefore, parked: rp.getParkedGhosts().size, ghosts: rp.getGhosts().size };
  });
  ok(k6.parkedBefore === 1 && k6.parked === 0 && k6.ghosts === 0, 'game:abort clears parked bodies', JSON.stringify(k6));
  await P(() => { window.__rp.debugClear(); });

  console.log('Phase 10: 어깨 소켓 · 부상자 들쳐메기 (모델은 헬다이버즈식으로 롤백)');
  await P(() => { const ctx = window.__game.ctx; ctx.rejoinPending = false; ctx.bus.emit('game:newMission', { seed: 21 }); });
  await waitFor(page, () => !!window.__game.ctx.world && window.__game.ctx.world.ready, 'world ready (2)', 25000);
  await P(() => { const ctx = window.__game.ctx; if (ctx.phase !== 'playing') ctx.setPhase('playing'); });
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit (2)', 20000);
  await waitSim(0.4);
  const sock = await P(() => {
    const ps = window.__ps; const m = ps.model; const p = window.__game.ctx.player;
    return {
      shoulder: !!m.shoulderSocket,
      weaponRotX: +m.weaponSocket.rotation.x.toFixed(4),
      hostSocket: typeof p.getShoulderSocket === 'function' && p.getShoulderSocket() === m.shoulderSocket,
      poseCarry: Object.keys(ps.pose).includes('carry'),
      carrying: p.carrying, isCarried: p.isCarried,
      cape: 'capeSegs' in m,   // rolled back to the armoured trooper: the cape is part of the look again
    };
  });
  ok(sock.shoulder && sock.hostSocket, 'SoldierModel.shoulderSocket exposed through getShoulderSocket()', JSON.stringify(sock));
  ok(Math.abs(sock.weaponRotX + Math.PI / 2) < 1e-3, 'weaponSocket keeps the -PI/2 (weapon -Z) contract', String(sock.weaponRotX));
  ok(sock.poseCarry && sock.cape, 'SoldierPose has `carry`; the armoured trooper look (cape) is restored', JSON.stringify(sock));
  ok(sock.carrying === null && sock.isCarried === false, 'nobody is carried at mission start', JSON.stringify(sock));

  await P(() => {
    const rp = window.__rp; const p = window.__game.ctx.player;
    const ref = rp.debugSpawn({ id: 'dbg-e', slot: 1, isDowned: true });
    ref.position.copy(p.position); ref.position.x += 1.2;
    window.__refE = ref;
  });
  await waitSim(0.3);
  const c1 = await P(() => {
    const rp = window.__rp; const p = window.__game.ctx.player;
    const found = rp.findCarriable(p.position, 2.2);
    const far = rp.findCarriable(new window.__V(p.position.x + 40, p.position.y, p.position.z), 2.2);
    const okCarry = p.carry('dbg-e');
    const twice = p.carry('dbg-e');
    const av = rp.getAvatar('dbg-e');
    return {
      found: found && found.id, far, okCarry, twice, carrying: p.carrying, carried: av.carried,
      shoulder: av.root.parent === p.getShoulderSocket(),
      started: window.__ev['player:carryStarted'].slice(-1)[0],
    };
  });
  ok(c1.found === 'dbg-e' && c1.far === null, 'findCarriable finds the downed squadmate in range only', JSON.stringify(c1));
  ok(c1.okCarry && !c1.twice && c1.carrying === 'dbg-e' && c1.carried && c1.shoulder, 'carry() parents the body into the shoulder socket (and never twice)', JSON.stringify(c1));
  ok(c1.started && c1.started.id === 'dbg-e', 'player:carryStarted emitted', JSON.stringify(c1.started));
  // `syncRevive` re-aims the prompt once per frame, so let a frame run before reading it back
  await waitSim(0.2);
  const c2 = await P(() => {
    const rp = window.__rp; const entry = rp.revives.get('dbg-e');
    const av = rp.getAvatar('dbg-e');
    const wp = av.root.getWorldPosition(new window.__V());
    return {
      has: !!entry,
      dSocket: entry ? entry.interactable.position.distanceTo(wp) : -1,
      dRef: entry ? entry.interactable.position.distanceTo(window.__refE.position) : -1,
      carried: av.carried,
    };
  });
  ok(c2.has && c2.dSocket < 0.05, 'the revive prompt follows the shoulder socket while the body is carried', JSON.stringify(c2));
  ok(c2.dRef > 0.4, 'the prompt no longer sits at the stale ref position', JSON.stringify(c2));
  const c3 = await P(() => {
    const p = window.__game.ctx.player;
    window.__refE.isDowned = false;              // somebody else revived the body
    return { carrying: p.carrying };
  });
  await waitSim(0.3);
  const c4 = await P(() => {
    const p = window.__game.ctx.player; const av = window.__rp.getAvatar('dbg-e');
    return { carrying: p.carrying, carried: av.carried, inScene: av.root.parent === window.__game.ctx.scene, ended: window.__ev['player:carryEnded'].slice(-1)[0] };
  });
  ok(c3.carrying === 'dbg-e' && c4.carrying === null && !c4.carried && c4.inScene, 'a revived body is put down automatically', JSON.stringify(c4));
  ok(c4.ended && c4.ended.reason === 'revived', "player:carryEnded reason 'revived'", JSON.stringify(c4.ended));

  const c5 = await P(() => {
    const rp = window.__rp; const p = window.__game.ctx.player;
    const on = rp.debugCarryLocal('dbg-e', true);
    return { on, isCarried: p.isCarried, shoulder: p.object.parent === rp.getAvatar('dbg-e').shoulderSocket, x: p.position.x };
  });
  ok(c5.on && c5.isCarried && c5.shoulder, 'setCarriedBy hangs the LOCAL body on the carrier socket', JSON.stringify(c5));
  await P(() => { window.__refE.position.x += 5; });
  await waitSim(0.3);
  const c6b = await P((x0) => {
    const p = window.__game.ctx.player; const av = window.__rp.getAvatar('dbg-e');
    const wp = av.root.getWorldPosition(new window.__V());
    return { moved: p.position.x - x0, d: Math.hypot(p.position.x - wp.x, p.position.z - wp.z), isCarried: p.isCarried };
  }, c5.x);
  ok(c6b.moved > 4 && c6b.d < 1.2, 'the carried body rides along with the carrier (controller position follows the socket)', JSON.stringify(c6b));
  const c7 = await P(() => {
    const rp = window.__rp; rp.debugCarryLocal('dbg-e', false);
    const p = window.__game.ctx.player;
    return { isCarried: p.isCarried, inScene: p.object.parent === window.__game.ctx.scene };
  });
  ok(!c7.isCarried && c7.inScene, 'setCarriedBy(null) puts the local body back into the scene', JSON.stringify(c7));
  await P(() => { window.__rp.debugClear(); });
  await waitSim(0.2);

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));
  ok(gameErrors.length === 0, `no console errors (${gameErrors.length}; ${errors.length - gameErrors.length} relay socket errors ignored)`, gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log('  FAIL', e.message);
  if (errors.length) console.log('  console errors:', errors.slice(0, 5).join(' | '));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
