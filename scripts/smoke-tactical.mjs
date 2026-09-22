// Single-client smoke test for the tactical kit: boots the game, walks it into a mission and exercises
// implants, gadgets, gear/weight, melee, roll, gathering, field crafting and progression (91 checks; Phase 12 added the
// 3.2 m shield width, `resolveBarrierCollision` / `absorbFrontalAttack`, the shield bash via a synthetic LMB and the
// one-shot recon in a third mission; 2026-09-11 the explicit overcharge flag (C-3) and the bash knockback through the
// contract `EnemyManagerRef.pushBack` (C-1); 2026-09-12 → 115: ready moments / sounds, dash 11.25 m + wall clamp,
// `refillAll`, and a fourth mission for the grapple cooldown refund; 2026-09-14 → 119: grapple cooldown 31.2 s / cancel floor
// 3.9 s, and the body-swept dash — a ground-floor window intact + broken stops it inside, a front doorway and a low box step pass,
// each compared with a real PlayerController walking the same line; 2026-09-16: the crouched "low roll" ends crouched with the
// crouch blend held, no roll while prone / standing up from prone (API and V key), and `selfMovedMeters` + `운반` hauling XP count walking
// and the own roll but not an attached carrier (liftoff), an impulse flight or the dash).
// Usage: node scripts/smoke-tactical.mjs [http://localhost:5273/]
// Requires `npm run dev` (or `npm run dev:all`) to be running.
//
// NOTE ON TIMING: Engine clamps dt to 0.05 s and the frame rate depends on the machine (swiftshader fallback ≈ 5 fps),
// so wall time is NOT game time. Anything with a cooldown or a duration must be advanced with
// `gameSleep`, which waits on `ctx.time`.
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
// Real GPU through ANGLE D3D11 by default (headless Chrome renders at full speed, CPU stays free). SMOKE_GL=swiftshader falls back to the CPU rasterizer (no GPU / CI).
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, label, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn); if (v) return v; } catch { /* page still loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}
/** Advance `seconds` of game time (ctx.time), which under swiftshader takes far longer in wall time. */
async function gameSleep(page, seconds) {
  const t0 = await page.evaluate(() => window.__game.ctx.time);
  const deadline = Date.now() + seconds * 1000 * 60;
  while (Date.now() < deadline) {
    const t = await page.evaluate(() => window.__game.ctx.time);
    if (t - t0 >= seconds) return t - t0;
    await sleep(60);
  }
  throw new Error(`game time did not advance ${seconds}s`);
}

const errors = [];
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required', '--window-size=960,540', '--no-sandbox',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  // Never let headless Chrome take a real pointer lock: on Windows it calls ClipCursor and traps the OS cursor inside the
  // hidden 960×540 window at the top-left of the screen. Scripts fake `pointerLockElement` themselves where they need it.
  await page.evaluateOnNewDocument(() => {
    // 2026-09-08: this script does not check the tutorial. The tutorial starts by itself on a new profile and locks
    // room purposes · crafting · the terminal · boarding in that order, so it is marked "already done" here
    // (the tutorial itself is what scripts/smoke-tutorial.mjs looks at).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // 2026-09-11: park vite's HMR socket — with several agents saving into the same tree a full reload mid-run reset the
  // page to the title and the script timed out on 'gameplay phase'.
  await quietViteHmr(page);
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  /* ── boot / refs ──────────────────────────────────────────────────── */
  await waitFor(page, () => !!window.__game?.ctx, 'engine boot');
  const programs0 = await page.evaluate(() => window.__game.ctx.renderer.info.programs?.length ?? -1);
  const refs = await page.evaluate(() => {
    const c = window.__game.ctx;
    return { progression: !!c.progression, implants: !!c.implants, gadgets: !!c.gadgets, inventory: !!c.inventory, loot: !!c.loot };
  });
  ok(refs.progression, 'ctx.progression published');
  ok(refs.implants, 'ctx.implants published');
  ok(refs.gadgets, 'ctx.gadgets published');
  ok(refs.inventory && refs.loot, 'ctx.inventory / ctx.loot published');

  /* ── item catalogue ───────────────────────────────────────────────── */
  const cat = await page.evaluate(() => {
    const loot = window.__game.ctx.loot;
    const defs = loot.getAllItemDefs();
    const byCat = {};
    for (const d of defs) byCat[d.category] = (byCat[d.category] ?? 0) + 1;
    const armor = defs.filter((d) => d.category === 'armor').map((d) => loot.getArmorDef(d.armorId)).filter(Boolean);
    const packs = defs.filter((d) => d.category === 'bag').map((d) => d.bag).filter(Boolean);
    return {
      byCat,
      armorCount: armor.length,
      armorPerks: [...new Set(armor.map((a) => a.perk))].sort(),
      packCount: packs.length,
      packPerks: [...new Set(packs.map((b) => (b.tactical ? 'tactical' : 'none')))].sort(),
      quickSlotMax: Math.max(...packs.map((b) => b.quickSlots)),
      recipes: loot.getAllRecipes().length,
      weighted: defs.every((d) => typeof d.weight === 'number'),
    };
  });
  ok(cat.armorCount >= 8, `armor defs: ${cat.armorCount}`);
  ok(JSON.stringify(cat.armorPerks) === '["none","optical","regen","ultralight"]', `armor perks ${JSON.stringify(cat.armorPerks)}`);
  ok(cat.packCount >= 8, `bag defs: ${cat.packCount}`);
  ok(JSON.stringify(cat.packPerks) === '["none","tactical"]', `bag perks ${JSON.stringify(cat.packPerks)}`);
  ok(cat.quickSlotMax >= 8, `tactical bag grants 8+ quick slots (${cat.quickSlotMax})`);
  // 2026-09-11: +3 (the remote mine · the ground drone · the air drone)
  /* 2026-09-15, 2nd pass: the old gadget 「화염수류탄」 (gad_incendiary) was merged into the incendiary grenade, which
     takes one away (-1), and dropping `ItemCategory 'grenade'` brought the two grenades into this category (+2). */
  /* 2026-09-15 (the sandworm): the thumper `gad_thumper` is the 13th gadget */
  /* 2026-09-21 (the survey camera): the five camera grades `cam_survey_1…5` are `gadget` items without a `gadgetId` (+5) */
  ok((cat.byCat.gadget ?? 0) === 20, `20 gadget items — 가젯 13 + 수류탄 2 + 조사 카메라 5 (${cat.byCat.gadget})`);
  ok((cat.byCat.herb ?? 0) >= 3, `herb items (${cat.byCat.herb})`);
  ok(cat.recipes >= 10, `craft recipes: ${cat.recipes}`);
  ok(cat.weighted, 'every item def carries a weight');

  /* ── progression ──────────────────────────────────────────────────── */
  // 2026-09-16 (user's decision 「채광 숙련」): pinning the skill count down turns this red every time a skill is added —
  // `shared/progression.STAT_IDS` · `SKILL_IDS` are the source, so this looks at whether the profile filled **exactly** those lists.
  const prog = await page.evaluate(async () => {
    const { STAT_IDS, SKILL_IDS } = await import('/src/shared/progression.ts');
    const p = window.__game.ctx.progression, d = p.derived;
    return { stats: Object.keys(p.profile.stats).sort(), skills: Object.keys(p.profile.skills).sort(),
      statIds: [...STAT_IDS].sort(), skillIds: [...SKILL_IDS].sort(), carry: d.carryCapacity, recoilAR: d.recoilMul?.AR };
  });
  ok(JSON.stringify(prog.stats) === JSON.stringify(prog.statIds), `${prog.statIds.length} stats (STAT_IDS)`, JSON.stringify(prog.stats));
  ok(JSON.stringify(prog.skills) === JSON.stringify(prog.skillIds), `${prog.skillIds.length} skills (SKILL_IDS — 2026-09-16 채광 포함)`, JSON.stringify(prog.skills));
  ok(prog.carry > 0 && prog.recoilAR > 0, `derived stats sane (carry ${prog.carry} kg)`);

  /* ── implants: equipping is a ship-only action ────────────────────── */
  const implantIds = await page.evaluate(() => window.__game.ctx.implants.getAllDefs().map((d) => d.id));
  // 2026-09-15: the `대전차포` (`atlauncher`) retired — five selectable implants, and the retired id is not among them
  ok(implantIds.length === 5 && !implantIds.includes('atlauncher'), `5 implants (no atlauncher): ${implantIds.join(',')}`);

  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  const inHub = await page.evaluate(() => {
    const ctx = window.__game.ctx, im = ctx.implants;
    // 2026-09-12: every ready moment and every ready / refund sound request from here on (the sounds are recorded at
    // AudioSystem.play, before its "is the AudioContext running" gate, so a headless page still sees them)
    window.__ready = [];
    ctx.bus.on('implant:ready', (e) => window.__ready.push({ full: e.full, refill: e.refill, charges: e.charges, phase: ctx.phase }));
    window.__snd = [];
    const audio = window.__game.getSystem('audio');
    const play = audio.play.bind(audio);
    audio.play = (id, pos, vol, pitch, ...rest) => {
      if (id === 'implant_ready' || id === 'stratagem_ready') window.__snd.push({ id, vol, pitch });
      return play(id, pos, vol, pitch, ...rest);
    };
    return { set: im.setEquipped('dash'), equipped: im.equipped };
  });
  ok(inHub.set && inHub.equipped === 'dash', 'implant equipped in the ship');
  const soundIds = await page.evaluate(async () => {
    const m = await import('/src/audio/Synth.ts');
    return { implant: typeof m.SOUNDS.implant_ready === 'function', strat: typeof m.SOUNDS.stratagem_ready === 'function' };
  });
  ok(soundIds.implant && soundIds.strat, `SOUNDS defines implant_ready (${soundIds.implant}) and stratagem_ready (${soundIds.strat})`);

  /* ── mission ──────────────────────────────────────────────────────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 42 }));
  await waitFor(page, () => window.__game.ctx.world?.ready === true, 'world ready');
  await waitFor(page, () => window.__game.ctx.isGameplayPhase(), 'gameplay phase');
  await waitFor(page, () => window.__game.ctx.player?.isDropping === false, 'drop-in finished');
  await gameSleep(page, 1.0);

  const locked = await page.evaluate(() => {
    const im = window.__game.ctx.implants;
    return { refused: im.setEquipped('barrier') === false, still: im.equipped };
  });
  ok(locked.refused && locked.still === 'dash', 'implant swap refused during a raid');

  /* ── gather nodes ─────────────────────────────────────────────────── */
  // 2026-09-08: the node list now also carries salvage piles (`kind: 'salvage'`, `mat_scrap`) — check both families
  const gather = await page.evaluate(() => {
    const n = window.__game.ctx.world.getGatherNodes();
    // 2026-09-11 (the lab): soil · seeds · samples are on the same list — the `herb_` assertion below means only herbs are picked
    const herbs = n.filter((g) => g.kind === 'herb');
    const salvage = n.filter((g) => g.kind === 'salvage');
    return {
      n: herbs.length,
      defIds: [...new Set(herbs.map((g) => g.defId))],
      salvage: salvage.length,
      salvageDefIds: [...new Set(salvage.map((g) => g.defId))],
    };
  });
  ok(gather.n >= 30, `herb nodes spawned: ${gather.n}`);
  ok(gather.defIds.every((id) => id.startsWith('herb_')), `gather nodes yield herbs: ${gather.defIds.join(',')}`);
  ok(gather.salvage >= 1, `고철 더미 spawned: ${gather.salvage}`);
  ok(gather.salvageDefIds.every((id) => id === 'mat_scrap'), `고철 더미 yields 폐금속: ${gather.salvageDefIds.join(',')}`);

  /* ── weight + armor ──────────────────────────────────────────────── */
  const weight = await page.evaluate(() => {
    const inv = window.__game.ctx.inventory, w = inv.getWeight();
    return { ...w, quick: inv.getQuickSlots().length };
  });
  ok(weight.capacity > 0 && ['normal', 'light', 'heavy', 'over'].includes(weight.state),
    `weight ${weight.weight.toFixed(1)}/${weight.capacity.toFixed(1)} kg → ${weight.state}`);
  ok(weight.quick >= 4, `quick slots: ${weight.quick}`);

  const armor = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, loot = ctx.loot;
    const itemDef = loot.getAllItemDefs().find((d) => d.category === 'armor');
    const item = loot.createItem(itemDef.id, 1);
    inv.tryAddItem(item);
    const done = inv.equip(item.uid, 'armor');
    ctx.player.update(0.6, ctx);   // PlayerGear re-reads the inventory on the next tick
    /* 2026-09-10: armor gives a shield (extra hp), not damage reduction — `damageReduction` survives as a contract field only and is always 0. */
    return { done, shield: ctx.player.maxShield };
  });
  ok(armor.done && armor.shield > 0, `armor equipped, shield +${armor.shield}`);

  /* ── melee + roll ─────────────────────────────────────────────────── */
  ok(await page.evaluate(() => window.__game.ctx.player.startMelee()), 'startMelee() accepted');
  await gameSleep(page, 1.0);

  await page.evaluate(() => { window.__rollFrom = window.__game.ctx.player.position.clone(); });
  const rollStarted = await page.evaluate(() => window.__game.ctx.player.roll());
  await gameSleep(page, 1.2);
  const rolled = await page.evaluate(() => ({
    moved: window.__game.ctx.player.position.distanceTo(window.__rollFrom),
    rolling: window.__game.ctx.player.isRolling,
    stance: window.__game.ctx.player.stance,
  }));
  ok(rollStarted && rolled.moved > 3.0, `roll covered ${rolled.moved.toFixed(2)} m of the 4.2 m arc`);
  ok(rolled.rolling === false && rolled.stance === 'stand', `roll ended back in a standing stance (${rolled.stance})`);

  /* ── 2026-09-16: the low roll · no roll while prone · self-propelled metres ────── */
  // A per-frame trace around PlayerSystem.update (Engine calls `s.update(dt, ctx)` on the instance); `__pre` runs before it.
  await page.evaluate(() => {
    const G = window.__game, ps = G.getSystem('player');
    window.__trace = []; window.__pre = null;
    const base = Object.getPrototypeOf(ps).update;
    ps.update = function (dt, c) {
      if (window.__pre) window.__pre(dt);
      base.call(this, dt, c);
      const k = this.controller;
      window.__trace.push({ t: c.time, g: k.grounded, odo: this.selfMovedMeters, roll: k.rolling, cb: this.crouchBlend, st: this._stance, x: k.position.x, z: k.position.z });
    };
    // `운반` hauling XP accrues only at `조금 무거움` or worse — progression reads the state straight off this event
    G.ctx.bus.emit('inventory:weightChanged', { weight: 1, capacity: 1, ratio: 0.8, state: 'light' });
  });
  // a global (a `const` inside eval stays local to that eval): later `__carry(...)` calls resolve to window.__carry
  const carryOf = 'window.__carry = (pg) => pg.getSkill("carry") + pg.getSkillProgress("carry");';
  await gameSleep(page, 1.2);   // ROLL_DURATION + ROLL_COOLDOWN
  await page.evaluate(() => { const ps = window.__game.getSystem('player'); ps.setStance('crouch'); ps.stamina = ps.maxStamina; });
  await gameSleep(page, 0.6);   // crouch blend settles
  const lowStart = await page.evaluate((src) => {
    eval(src);
    const G = window.__game, p = G.ctx.player, ps = G.getSystem('player');
    window.__lowMark = window.__trace.length;
    window.__lowFrom = p.position.clone();
    const odo = p.selfMovedMeters, carry = __carry(G.ctx.progression);
    return { odo, carry, started: p.roll(), stance: p.stance, cb: ps.crouchBlend };
  }, carryOf);
  await gameSleep(page, 1.2);
  const low = await page.evaluate((src) => {
    eval(src);
    const G = window.__game, p = G.ctx.player, ps = G.getSystem('player');
    const tr = window.__trace.slice(window.__lowMark);
    return {
      moved: Math.hypot(p.position.x - window.__lowFrom.x, p.position.z - window.__lowFrom.z), rolling: p.isRolling, stance: p.stance,
      rollFrames: tr.filter((f) => f.roll).length, minCb: tr.length ? Math.min(...tr.map((f) => f.cb)) : -1, stances: [...new Set(tr.map((f) => f.st))],
      odo: p.selfMovedMeters, carry: __carry(G.ctx.progression), cbNow: ps.crouchBlend,
    };
  }, carryOf);
  ok(typeof lowStart.odo === 'number' && Number.isFinite(lowStart.odo), `ctx.player.selfMovedMeters published (${lowStart.odo})`);
  ok(lowStart.started && lowStart.stance === 'crouch' && lowStart.cb > 0.9, `crouched roll accepted without standing up (stance ${lowStart.stance}, crouch blend ${lowStart.cb?.toFixed(2)})`);
  ok(low.moved > 3.0 && low.rolling === false, `low roll covered the same arc (${low.moved.toFixed(2)} m)`);
  ok(low.stance === 'crouch' && low.stances.length === 1 && low.stances[0] === 'crouch', `low roll ended still crouched — stance never left crouch (${low.stances.join(',')})`);
  ok(low.rollFrames > 0 && low.minCb > 0.9, `crouch blend held through the tumble (min ${low.minCb.toFixed(3)} over ${low.rollFrames} rolling frames) — no stand-up flicker`);
  const lowOdo = low.odo - lowStart.odo;
  ok(lowOdo > low.moved - 0.5 && lowOdo <= low.moved + 0.05, `own roll is self-propelled: odometer +${lowOdo.toFixed(2)} m for ${low.moved.toFixed(2)} m`);
  ok(low.carry > lowStart.carry, `운반 XP grew from the roll at 조금 무거움 (${lowStart.carry.toFixed(5)} → ${low.carry.toFixed(5)})`);

  // prone: refused through PlayerRef.roll, during the prone → crouch stand-up, and from the V key
  await gameSleep(page, 1.2);
  const prone = await page.evaluate(() => {
    const G = window.__game, p = G.ctx.player, ps = G.getSystem('player');
    ps.stamina = ps.maxStamina; ps.rollCooldown = 0;
    ps.setStance('prone'); ps.standUpTimer = 0;
    const fromProne = { rolled: p.roll(), rolling: p.isRolling, stance: p.stance };
    ps.setStance('crouch');   // prone → crouch starts the STAND_UP_TIME transition
    const during = { timer: ps.standUpTimer, rolled: p.roll(), rolling: p.isRolling, stance: p.stance };
    return { fromProne, during };
  });
  ok(!prone.fromProne.rolled && !prone.fromProne.rolling && prone.fromProne.stance === 'prone', 'roll refused while prone (PlayerRef.roll → false, still prone)', JSON.stringify(prone.fromProne));
  ok(prone.during.timer > 0 && !prone.during.rolled && !prone.during.rolling, `roll refused during the prone → crouch stand-up (${prone.during.timer?.toFixed(2)} s left)`, JSON.stringify(prone.during));
  const diveKey = await page.evaluate(async () => {
    const G = window.__game, ps = G.getSystem('player');
    const { Keys } = await import('/src/shared/constants.ts');
    ps.setStance('prone'); ps.standUpTimer = 0; ps.rollCooldown = 0;
    window.__proneMark = window.__trace.length;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: Keys.DIVE, bubbles: true }));
    return Keys.DIVE;
  });
  await gameSleep(page, 0.3);
  const proneKey = await page.evaluate((code) => {
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    const ps = window.__game.getSystem('player');
    const tr = window.__trace.slice(window.__proneMark);
    return { frames: tr.length, rolled: tr.some((f) => f.roll), stance: ps._stance, cd: ps.rollCooldown };
  }, diveKey);
  ok(proneKey.frames > 0 && !proneKey.rolled && proneKey.stance === 'prone' && proneKey.cd <= 0, `${diveKey} while prone: no roll over ${proneKey.frames} frames`, JSON.stringify(proneKey));
  await page.evaluate(() => { window.__game.getSystem('player').setStance('crouch'); });
  await gameSleep(page, 0.6);   // > STAND_UP_TIME
  const afterStandUp = await page.evaluate(() => {
    const G = window.__game, p = G.ctx.player, ps = G.getSystem('player');
    ps.rollCooldown = 0; ps.stamina = ps.maxStamina;
    return { timer: ps.standUpTimer, rolled: p.roll(), stance: p.stance };
  });
  ok(afterStandUp.timer <= 0 && afterStandUp.rolled && afterStandUp.stance === 'crouch', 'after the stand-up transition the crouched roll is accepted again', JSON.stringify(afterStandUp));
  await gameSleep(page, 1.3);

  // riding an attached carrier (the extraction liftoff path — `attachTo`): the body moves, nothing counts
  const ride = await page.evaluate(async (src) => {
    eval(src);
    const G = window.__game, ctx = G.ctx, p = ctx.player, ps = G.getSystem('player'), pg = ctx.progression;
    ps.setStance('stand'); ps.standUpTimer = 0;
    const Object3D = Object.getPrototypeOf(ctx.scene.constructor.prototype).constructor;
    const carrier = new Object3D();
    carrier.position.copy(p.position);
    ctx.scene.add(carrier); carrier.updateMatrixWorld(true);
    p.attachTo(carrier);
    const from = p.position.clone(), odo0 = p.selfMovedMeters, carry0 = __carry(pg);
    window.__pre = (dt) => { carrier.position.x += 8 * dt; carrier.position.y += 2 * dt; carrier.updateMatrixWorld(true); };
    const t0 = ctx.time;
    await new Promise((r) => { const iv = setInterval(() => { if (ctx.time - t0 >= 1.0) { clearInterval(iv); r(); } }, 20); });
    window.__pre = null;
    const out = { moved: Math.hypot(p.position.x - from.x, p.position.z - from.z), odo: p.selfMovedMeters - odo0, carry: __carry(pg) - carry0 };
    p.attachTo(null);
    ctx.scene.remove(carrier);
    p.teleport(from, undefined, true);
    return out;
  }, carryOf);
  ok(ride.moved > 4 && ride.odo === 0 && ride.carry === 0, `carried ${ride.moved.toFixed(2)} m on an attached carrier: odometer +${ride.odo}, 운반 XP +${ride.carry}`, JSON.stringify(ride));
  await gameSleep(page, 0.4);

  // walking (W held) counts; a jump-pad style impulse flight with W still held adds nothing; walking after landing counts again
  await page.evaluate(async (src) => {
    eval(src);
    const G = window.__game, ctx = G.ctx, p = ctx.player, ps = G.getSystem('player');
    const { Keys } = await import('/src/shared/constants.ts');
    ps.rig.yaw += Math.PI;   // walk back along the two rolls (known clear ground)
    window.__walkKey = Keys.FORWARD;
    window.__walk0 = { odo: p.selfMovedMeters, carry: __carry(ctx.progression), x: p.position.x, z: p.position.z };
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: Keys.FORWARD, bubbles: true }));
  }, carryOf);
  await gameSleep(page, 1.0);
  const walk = await page.evaluate((src) => {
    eval(src);
    const G = window.__game, ctx = G.ctx, p = ctx.player, w0 = window.__walk0;
    const out = { odo: p.selfMovedMeters - w0.odo, carry: __carry(ctx.progression) - w0.carry, moved: Math.hypot(p.position.x - w0.x, p.position.z - w0.z) };
    const V = p.position.constructor, yaw = G.getSystem('player').rig.yaw;
    window.__impMark = window.__trace.length;
    p.applyImpulse(new V(-Math.sin(yaw) * 4, 8, -Math.cos(yaw) * 4));
    return out;
  }, carryOf);
  await gameSleep(page, 3.0);
  const flight = await page.evaluate(() => {
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: window.__walkKey, bubbles: true }));
    const mark = window.__impMark, tr = window.__trace.slice(mark), base = window.__trace[mark - 1];
    const air = tr.findIndex((f) => !f.g);
    const land = air < 0 ? -1 : tr.findIndex((f, i) => i > air && f.g);
    if (!base || air < 0 || land < 0) return { air, land, frames: tr.length };
    const end = tr[land];
    return { air, land, frames: tr.length, flightOdo: end.odo - base.odo, flightDist: Math.hypot(end.x - base.x, end.z - base.z), after: tr[tr.length - 1].odo - end.odo };
  });
  ok(walk.moved > 1.5 && walk.odo > walk.moved - 0.3 && walk.odo <= walk.moved + 0.05, `walking (W held): odometer +${walk.odo.toFixed(2)} m for ${walk.moved.toFixed(2)} m`, JSON.stringify(walk));
  ok(walk.carry > 0, `walking at 조금 무거움 trains 운반 (+${walk.carry.toFixed(5)})`);
  ok(flight.land > 0 && flight.flightDist > 1.5 && flight.flightOdo < 0.02, `impulse flight with W held: ${flight.flightDist?.toFixed(2)} m through the air, odometer +${flight.flightOdo?.toFixed(3)} m`, JSON.stringify(flight));
  ok(flight.after > 0.2, `walking after the landing counts again (+${flight.after?.toFixed(2)} m)`, JSON.stringify(flight));
  await gameSleep(page, 0.5);

  /* ── dash implant ─────────────────────────────────────────────────── */
  const dash = await page.evaluate(() => {
    const ctx = window.__game.ctx, im = ctx.implants;
    window.__dashFrom = ctx.player.position.clone();
    window.__dashOdo = { odo: ctx.player.selfMovedMeters, carry: ctx.progression.getSkill('carry') + ctx.progression.getSkillProgress('carry') };
    const before = im.charges;
    im.activate();
    return { before, after: im.charges, max: im.maxCharges };
  });
  await gameSleep(page, 0.3);
  const dashMoved = await page.evaluate(() => window.__game.ctx.player.position.distanceTo(window.__dashFrom));
  ok(dash.max === 3, 'dash carries 3 charges');
  ok(dash.after === dash.before - 1, `dash consumed a charge (${dash.before}→${dash.after})`);
  ok(dashMoved > 2, `dash teleported ${dashMoved.toFixed(2)} m`);
  // 2026-09-16: the dash is implant movement — no self-propelled metres, no `운반` hauling XP; then drop the trace and the fake weight state
  const dashOdo = await page.evaluate(() => {
    const G = window.__game, ctx = G.ctx, d = window.__dashOdo;
    const out = { odo: ctx.player.selfMovedMeters - d.odo, carry: ctx.progression.getSkill('carry') + ctx.progression.getSkillProgress('carry') - d.carry };
    delete G.getSystem('player').update; window.__pre = null;
    const w = ctx.inventory.getWeight();
    ctx.bus.emit('inventory:weightChanged', { ...w, ratio: w.capacity > 0 ? w.weight / w.capacity : 0 });
    return out;
  });
  ok(dashOdo.odo < 0.02 && dashOdo.carry === 0, `the dash adds no self-propelled metres (+${dashOdo.odo.toFixed(3)}) and no 운반 XP (+${dashOdo.carry})`, JSON.stringify(dashOdo));
  ok((await page.evaluate(() => window.__ready.length)) === 0, 'no implant:ready from the ship equip / the mission start / a dash (things start full)');

  /* ── 2026-09-12: dash ×1.5 = 11.25 m on a clear line, still clamped in front of a wall ── */
  // CameraRig.getForward = (−sin yaw, 0, −cos yaw); respawnAt(pos, yaw) snaps the rig to that yaw.
  const dClear = await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, w = ctx.world;
    const V = p.position.constructor;
    const base = p.position.clone(), o = new V(), d = new V();
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      d.set(-Math.sin(a), 0, -Math.cos(a));
      o.copy(base); o.y += 1.0;
      const end = base.clone().addScaledVector(d, 11.25);
      if (w.raycast(o, d, 12.5) || !w.isInsideBounds(end.x, end.z) || Math.abs(w.getHeightAt(end.x, end.z) - base.y) >= 1.5) continue;
      // 2026-09-14: the dash now sweeps the body, so a knee-high rock under the 1 m ray also stops it — the line must be empty for a body
      let bodyClear = true;
      for (let s = 0.5; s <= 11.75 && bodyClear; s += 0.5) { const q = base.clone().addScaledVector(d, s); if (w.getObstaclesNear(q.x, q.z, 1.0).length) bodyClear = false; }
      if (!bodyClear) continue;
      p.respawnAt(base, a);
      const f = new V(); p.getForward(f);
      const from = p.position.clone(), c0 = ctx.implants.charges;
      ctx.implants.activate();
      const moved = Math.hypot(p.position.x - from.x, p.position.z - from.z);
      return { found: true, yawOk: f.distanceTo(d) < 1e-3, used: c0 - ctx.implants.charges, moved };
    }
    return { found: false };
  });
  ok(dClear.found && dClear.yawOk && dClear.used === 1 && Math.abs(dClear.moved - 11.25) < 0.35, `clear line: the dash covers IMPLANT_DASH_DISTANCE 11.25 m (${dClear.moved?.toFixed(2)} m)`, JSON.stringify(dClear));
  await gameSleep(page, 0.2);
  // a wall 3–10 m ahead: stand 6 m off a tall prop / wall (nearest first), face it, dash — it must stop in front
  const dWall = await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, w = ctx.world, im = ctx.implants;
    const V = p.position.constructor;
    const me = p.position.clone(), o = new V(), d = new V();
    const obs = w.getObstacles().filter((ob) => ob.height >= 2.5 && !ob.velocity && !ob.fragile && !ob.destructible)
      .sort((a, b) => a.position.distanceToSquared(me) - b.position.distanceToSquared(me)).slice(0, 80);
    for (const ob of obs) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const out = new V(Math.cos(a), 0, Math.sin(a));
        const spot = ob.position.clone().addScaledVector(out, ob.radius + 6);
        if (!w.isInsideBounds(spot.x, spot.z) || w.getObstaclesNear(spot.x, spot.z, 1.5).length) continue;
        spot.y = w.getHeightAt(spot.x, spot.z);
        d.set(-out.x, 0, -out.z);
        o.copy(spot); o.y += 1.0;
        const hit = w.raycast(o, d, 12.5);
        if (!hit || hit.distance < 3 || hit.distance > 10) continue;
        p.respawnAt(spot, Math.atan2(-d.x, -d.z));
        const f = new V(); p.getForward(f);
        const from = p.position.clone(), c0 = im.charges;
        im.activate();
        const moved = Math.hypot(p.position.x - from.x, p.position.z - from.z);
        return { found: true, yawOk: f.distanceTo(d) < 1e-3, used: c0 - im.charges, moved, wallAt: hit.distance, kind: ob.box ? 'box' : ob.hull ? 'hull' : 'cyl' };
      }
    }
    return { found: false };
  });
  ok(dWall.found && dWall.yawOk && dWall.used === 1 && dWall.moved < 11 && dWall.moved <= dWall.wallAt - 0.45 + 0.3,
    `wall ${dWall.wallAt?.toFixed(2)} m ahead (${dWall.kind}): the longer dash still stops in front of it (${dWall.moved?.toFixed(2)} m)`, JSON.stringify(dWall));

  /* ── 2026-09-14: the dash sweeps the body like walking — a window (intact or broken) stops it inside, a doorway and a low step pass ── */
  // Compared against a real PlayerController walking the same straight line (the reach smoke's trick): the dash ends where walking gets.
  await gameSleep(page, 0.2);
  const dStruct = await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, w = ctx.world, im = ctx.implants;
    const sys = window.__game.getSystem('implants'), ws = window.__game.getSystem('world');
    const V = p.position.constructor;
    const home = p.position.clone();
    const R = 0.45;
    const Ctl = window.__game.getSystem('player').controller.constructor;
    const walk = (from, dir, dist) => {
      const ctl = new Ctl(); ctl.reset(from.clone());
      const mv = { x: 0, z: 1, sprint: false, jump: false, stance: 'stand', aiming: false };
      const res = { footstep: false, landed: 0, jumped: false, rollEnded: false, rung: false, climbEnded: null };
      const yaw = Math.atan2(-dir.x, -dir.z);
      let best = 0;
      for (let it = 0; it < 600; it++) {
        ctl.update(1 / 60, mv, yaw, w, res);
        best = Math.max(best, (ctl.position.x - from.x) * dir.x + (ctl.position.z - from.z) * dir.z);
        if (best >= dist) break;
      }
      return Math.min(best, dist);
    };
    const free = (q) => { const c = q.clone(); w.resolveCollision(c, R); return Math.hypot(c.x - q.x, c.z - q.z) < 0.02; };
    const dashFrom = (from, dir) => {
      p.respawnAt(from, Math.atan2(-dir.x, -dir.z));
      sys.chargesLeft = 3; sys.cdRemaining = 0;
      const c0 = im.charges;
      im.activate();
      return { used: c0 - im.charges, along: (p.position.x - from.x) * dir.x + (p.position.z - from.z) * dir.z, y: p.position.y, end: p.position.clone() };
    };
    const res = { structures: 0, window: null, broken: null, door: null, step: null };
    const navs = ws.structures.debugNav(), panes = ws.structures.glassSet.panes;
    res.structures = navs.length;
    // ── a ground-floor window: stand 2.5 m inside, face it, dash — then break that pane (rays pass it now) and dash again
    for (const s of navs) {
      if (res.window) break;
      const nav = s.nav, y0 = nav.levels[0];
      for (const pn of panes) {
        const sp = pn.spec;
        if (pn.structureId !== s.id || pn.broken || Math.abs(sp.y - (y0 + 1.0)) > 0.05) continue;
        const inward = new V(-Math.sin(sp.yaw), 0, Math.cos(sp.yaw));
        if (inward.x * (nav.cx - sp.x) + inward.z * (nav.cz - sp.z) < 0) inward.negate();
        const spot = new V(sp.x + inward.x * 2.5, 0, sp.z + inward.z * 2.5);
        spot.y = w.getSurfaceY(spot.x, spot.z, y0 + 0.3);
        if (Math.abs(spot.y - y0) > 0.1 || !free(spot)) continue;
        const dir = inward.clone().negate();
        const plane = (q) => (q.x - sp.x) * inward.x + (q.z - sp.z) * inward.z;   // > 0 = inside the wall
        const intact = dashFrom(spot, dir);
        const walked = walk(spot, dir, 11.25);
        ws.structures.breakGlass(s.id, pn.index, true);
        const eye = spot.clone(); eye.y = sp.y + sp.height / 2;
        const ray = w.raycast(eye, dir, 12.5);
        const broken = dashFrom(spot, dir);
        res.window = { id: s.id, pane: pn.index, y0, walked, used: intact.used, along: intact.along, y: intact.y, inside: plane(intact.end) };
        res.broken = { broken: pn.broken, rayAt: ray ? ray.distance : null, used: broken.used, along: broken.along, y: broken.y, inside: plane(broken.end) };
        break;
      }
    }
    // ── the front door: 3 m outside the outer step, face in, dash
    for (const s of navs) {
      if (s.kind === 'wreck') continue;
      const nav = s.nav, y0 = nav.levels[0];
      const c = Math.cos(nav.yaw), sn = Math.sin(nav.yaw);
      const toW = (lx, lz) => new V(nav.cx + lx * c - lz * sn, 0, nav.cz + lx * sn + lz * c);
      const di = toW(nav.doorIn[0], nav.doorIn[1]), dout = toW(nav.doorOut[0], nav.doorOut[1]);
      const dir = di.clone().sub(dout).normalize();
      const from = dout.clone().addScaledVector(dir, -3);
      if (!w.isInsideBounds(from.x, from.z)) continue;
      from.y = w.getSurfaceY(from.x, from.z, y0 + 0.3);
      if (Math.abs(from.y - y0) > 0.85 || !free(from)) continue;
      const r = dashFrom(from, dir);
      const dx = r.end.x - nav.cx, dz = r.end.z - nav.cz;
      const lx = dx * c + dz * sn, lz = -dx * sn + dz * c;
      res.door = { id: s.id, used: r.used, along: r.along, walked: walk(from, dir, 11.25), inFootprint: Math.abs(lx) < nav.halfW && Math.abs(lz) < nav.halfD, dy: r.y - y0 };
      break;
    }
    // ── a low box (0.25–0.85 m, e.g. a rail deck plank): approach 2.5 m off a face over empty ground, dash onto it
    const boxes = w.getObstacles().filter((ob) => ob.box && !ob.ramp && !ob.velocity && !ob.fragile && !ob.destructible)
      .map((ob) => ({ ob, top: ob.position.y + ob.height }))
      .sort((a, b) => a.ob.position.distanceToSquared(home) - b.ob.position.distanceToSquared(home));
    search: for (const q of boxes) {
      const b = q.ob.box;
      for (let k = 0; k < 4 && q.top - w.getHeightAt(q.ob.position.x, q.ob.position.z) < 1.2; k++) {
        const alongX = k % 2 === 0;
        const face = alongX ? new V(Math.cos(b.yaw), 0, Math.sin(b.yaw)) : new V(-Math.sin(b.yaw), 0, Math.cos(b.yaw));
        if (k >= 2) face.negate();
        const half = alongX ? b.halfX : b.halfZ, cross = alongX ? b.halfZ : b.halfX;
        if (half < 0.6 || cross < 0.6) continue;
        const spot = q.ob.position.clone().addScaledVector(face, half + 2.5);
        if (!w.isInsideBounds(spot.x, spot.z)) continue;
        spot.y = w.getHeightAt(spot.x, spot.z);
        const rise = q.top - spot.y;
        if (rise < 0.25 || rise > 0.85 || w.getSurfaceY(spot.x, spot.z, spot.y + 0.1) > spot.y + 0.05 || !free(spot)) continue;
        const dir = face.clone().negate();
        // nothing else on the approach but steppable boxes (so the step itself is what is tested)
        let clear = true;
        for (let st = 0; st <= 2.5 && clear; st += 0.5) {
          const qq = spot.clone().addScaledVector(dir, st);
          for (const o of w.getObstaclesNear(qq.x, qq.z, 0.9)) {
            if (o === q.ob || (o.box && !o.ramp && !o.velocity && o.position.y + o.height <= spot.y + 0.85)) continue;
            clear = false; break;
          }
          if (Math.abs(w.getHeightAt(qq.x, qq.z) - spot.y) > 0.3) clear = false;
        }
        if (!clear) continue;
        const onTop = sys.dashReach(spot, dir, half + 2.5, new V());
        const walked = walk(spot, dir, half + 2.5);
        const r = dashFrom(spot, dir);
        res.step = { rise, top: q.top, reach: half + 2.5, used: r.used, along: r.along, walked,
          topY: onTop.y, topGap: Math.hypot(onTop.x - q.ob.position.x, onTop.z - q.ob.position.z) };
        break search;
      }
    }
    p.respawnAt(home);
    return res;
  });
  {
    const s = dStruct, wn = s.window, br = s.broken, dr = s.door, st = s.step;
    ok(!!wn && wn.used === 1 && wn.along < 2.5 && wn.inside >= 0.4 && Math.abs(wn.y - wn.y0) < 0.05 && Math.abs(wn.along - wn.walked) < 0.35,
      `window 2.5 m ahead (intact glass): the dash stops inside in front of the wall (${wn?.along?.toFixed(2)} m, ${wn?.inside?.toFixed(2)} m off the pane, walking ${wn?.walked?.toFixed(2)} m)`, JSON.stringify(s));
    ok(!!br && br.broken && br.used === 1 && br.along < 2.5 && br.inside >= 0.4,
      `the same window broken (ray through the pane: ${br?.rayAt === null ? 'none' : br?.rayAt?.toFixed(2) + ' m'}): the dash still stops inside (${br?.along?.toFixed(2)} m)`, JSON.stringify(br));
    ok(!!dr && dr.used === 1 && dr.along > 3.5 && dr.inFootprint && Math.abs(dr.along - dr.walked) < 0.4,
      `front doorway (${dr?.id}): the dash passes into the building (${dr?.along?.toFixed(2)} m, walking ${dr?.walked?.toFixed(2)} m)`, JSON.stringify(dr));
    ok(!!st && st.used === 1 && Math.abs(st.topY - st.top) < 0.05 && st.topGap < 0.3 && st.along >= st.reach - 0.3 && st.walked >= st.reach - 0.3,
      `low step ${st?.rise?.toFixed(2)} m: the dash steps up onto it (top ${st?.topY?.toFixed(2)} / ${st?.top?.toFixed(2)}, ${st?.along?.toFixed(2)} m ≥ ${st?.reach?.toFixed(2)})`, JSON.stringify(st));
  }

  /* ── 2026-09-12: ready moments — every dash charge back flashes (intermediate weak, last full) + implant_ready ── */
  await gameSleep(page, 0.2);
  const cooling = await page.evaluate(() => {
    const ctx = window.__game.ctx, sys = window.__game.getSystem('implants');
    sys.chargesLeft = 0; sys.cdRemaining = 2; sys.cdTotal = 5;   // pin a known empty state
    window.__readyMark = window.__ready.length; window.__sndMark = window.__snd.length;
    return true;
  });
  await gameSleep(page, 0.2);
  const empty = await page.evaluate(() => { const h = document.querySelector('.imp-hud'); return { dim: h.classList.contains('dim'), ready: h.classList.contains('is-ready') }; });
  ok(cooling && empty.dim && !empty.ready, `dash with no charge: dimmed, no ready glow (${JSON.stringify(empty)})`);
  const flashes = [];
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => { window.__game.getSystem('implants').cdRemaining = 0.05; });
    await gameSleep(page, 0.25);
    flashes.push(await page.evaluate(() => {
      const h = document.querySelector('.imp-hud');
      return { charges: window.__game.ctx.implants.charges, major: h.classList.contains('rdy-major'), minor: h.classList.contains('rdy-minor'), ready: h.classList.contains('is-ready') };
    }));
  }
  const rd = await page.evaluate(() => ({ ev: window.__ready.slice(window.__readyMark), snd: window.__snd.slice(window.__sndMark) }));
  ok(rd.ev.length === 3 && rd.ev.map((e) => e.full).join() === 'false,false,true' && rd.ev.map((e) => e.charges).join() === '1,2,3' && rd.ev.every((e) => !e.refill),
    `implant:ready per charge back: full ${rd.ev.map((e) => e.full).join('/')}, charges ${rd.ev.map((e) => e.charges).join('/')}`);
  ok(flashes[0].minor && !flashes[0].major && flashes[1].minor && flashes[2].major && !flashes[2].minor && flashes.every((f) => f.ready),
    `.imp-hud flashes .rdy-minor, .rdy-minor, .rdy-major and holds .is-ready (${JSON.stringify(flashes)})`);
  ok(rd.snd.length === 3 && rd.snd.every((s) => s.id === 'implant_ready') && rd.snd[0].vol < rd.snd[2].vol && rd.snd[1].vol < rd.snd[2].vol,
    `implant_ready per charge, intermediate quieter (${rd.snd.map((s) => s.vol).join(' / ')})`);

  /* ── gadgets: throwables, then place-types from separate spots ────── */
  await page.evaluate(() => {
    const ctx = window.__game.ctx;
    // the starter bag (5×6) cannot hold every gadget: swap in the legendary 10×6 bag first
    const bag = ctx.loot.createItem('bag_legendary', 1);
    ctx.inventory.tryAddItem(bag);
    ctx.inventory.equip(bag.uid, 'bag');
    for (const d of ctx.loot.getAllItemDefs()) {
      if (d.category === 'gadget') ctx.inventory.tryAddItem(ctx.loot.createItem(d.id, 3));
    }
  });
  // Full health on the spot first, and the `화염수류탄` **last**: its fire zone is friendly-fire by design and lands a few
  // metres ahead of a standing player, so with the current starter gear the burn downed the player partway through
  // the loop — and a downed player is refused **silently** (`deny(null)`), so every later `use()` returned false.
  await page.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.player.respawnAt(ctx.player.position.clone(), ctx.player.yaw);
  });
  await gameSleep(page, 0.3);
  const thrown = {};
  /* 2026-09-15, 2nd pass: `incendiary` became an internal def with no item, so `use()` refuses it — only the three thrown gadgets are looked at. */
  for (const id of ['smokeGrenade', 'lureGrenade', 'domeShield']) {
    thrown[id] = await page.evaluate((g) => {
      const ctx = window.__game.ctx;
      return { used: ctx.gadgets.use(g, false), downed: ctx.player.isDowned, hp: Math.round(ctx.player.hp) };
    }, id);
    await gameSleep(page, 1.1);   // USE_COOLDOWN is game time
  }
  ok(Object.values(thrown).every((r) => r.used), `throwable gadgets used: ${JSON.stringify(thrown)}`);

  // Place-type gadgets refuse to stack (PLACE_CLEARANCE), so move between placements.
  const placeIds = ['turret', 'barricade', 'jumpPad', 'mine'];
  const placed = {};
  for (let i = 0; i < placeIds.length; i++) {
    await page.evaluate((k) => {
      const ctx = window.__game.ctx, spawn = ctx.world.getPlayerSpawn();
      const a = (k / 4) * Math.PI * 2;
      const x = spawn.x + Math.cos(a) * 16, z = spawn.z + Math.sin(a) * 16;
      ctx.player.respawnAt(new (ctx.player.position.constructor)(x, ctx.world.getHeightAt(x, z), z), a);
    }, i);
    await gameSleep(page, 1.2);
    const res = await page.evaluate((g) => {
      const ctx = window.__game.ctx;
      const msgs = [];
      const off = ctx.bus.on('ui:notify', (n) => msgs.push(n.text));
      const ok = ctx.gadgets.use(g, false);
      off();
      return { ok, msgs, pos: [ctx.player.position.x, ctx.player.position.z], inside: ctx.world.isInsideBounds(ctx.player.position.x, ctx.player.position.z) };
    }, placeIds[i]);
    if (!res.ok) console.log(`  [smoke] ${placeIds[i]} refused: ${res.msgs.join(' / ')} at ${res.pos.map((v) => v.toFixed(1))} inside=${res.inside}`);
    placed[placeIds[i]] = res.ok;
    await gameSleep(page, 1.2);
  }
  ok(Object.values(placed).every(Boolean), `place-type gadgets deployed: ${JSON.stringify(placed)}`);

  await gameSleep(page, 4.0);   // GADGET_MINE_ARM_TIME + settle
  const mine = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const m = ctx.gadgets.getDeployables().find((d) => d.kind === 'mine');
    if (!m) return null;
    const it = ctx.interactables.all().find((i) => i.id === `gadget:${m.id}`);
    return { armed: m.armed, prompt: it?.getPrompt() ?? null, hold: it?.holdTime ?? null };
  });
  ok(mine?.armed === true, 'mine armed after its 3 s delay');
  ok(!!mine?.prompt, `mine defusable: "${mine?.prompt}" (${mine?.hold} s hold)`);

  const recovered = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const t = ctx.gadgets.getDeployables().find((d) => d.kind === 'turret');
    const item = t ? ctx.gadgets.recover(t.id) : null;
    return item?.defId ?? null;
  });
  ok(!!recovered, `turret recovered as an item (${recovered})`);

  /* ── jump pad actually launches ───────────────────────────────────── */
  const pad = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const p = ctx.gadgets.getDeployables().find((d) => d.kind === 'jumpPad');
    if (!p) return null;
    window.__launches = [];
    ctx.bus.on('player:launched', (e) => window.__launches.push({ y: e.impulse.y, t: ctx.time }));
    ctx.player.respawnAt(new (ctx.player.position.constructor)(p.position.x, p.position.y, p.position.z), 0);
    return true;
  });
  ok(!!pad, 'jump pad present');
  if (pad) {
    const onPad = () => page.evaluate(() => {
      const ctx = window.__game.ctx, p = ctx.gadgets.getDeployables().find((d) => d.kind === 'jumpPad');
      ctx.player.respawnAt(new (ctx.player.position.constructor)(p.position.x, p.position.y, p.position.z), 0);
      return ctx.time;
    });
    // 1.0 s, not 1.8 (2026-09-22, E-12): the re-stand below must land inside the 2.5 s window, and 1.8 s plus two
    // overshooting waits reached 2.44 s under 6 lanes
    await gameSleep(page, 1.0);
    const launches = await page.evaluate(() => window.__launches);
    ok(launches.length === 1 && launches[0].y > 5, `jump pad launched the player exactly once in 1.0 s (impulse.y ${launches[0]?.y?.toFixed(2)}, ${launches.length} launches)`);
    // Phase 9: per-player re-trigger gate — standing on the pad again inside JUMP_PAD_RETRIGGER_S (2.5 s) does nothing
    /* 2026-09-22 (E-12 ⓐ): judged on the launch **timestamps**, not on a count read 「at ~2.1 s」. The two `gameSleep`s
       overshoot under a loaded page (a frame is up to 4 sub-steps of 50 ms), and a count read past 2.5 s saw the
       legitimate second launch. What the gate promises: back on the pad inside the window, the next launch is not
       before the window ends. */
    const standT = await onPad();
    await gameSleep(page, 0.3);
    const inside = await page.evaluate(() => window.__launches);
    const firstT = inside[0]?.t ?? 0;
    ok(standT - firstT < 2.4 && inside.slice(1).every((l) => l.t - firstT >= 2.4),
      `no re-launch inside JUMP_PAD_RETRIGGER_S (back on the pad ${(standT - firstT).toFixed(2)} s after the launch; later launches at ${inside.slice(1).map((l) => (l.t - firstT).toFixed(2)).join(', ') || '—'} s)`);
    await onPad();
    await gameSleep(page, 1.6);   // 1.0 + 0.3 + 1.6 s ends past the 2.5 s window (the first wait was 1.8 before 2026-09-22)
    const later = await page.evaluate(() => window.__launches);
    ok(later.length >= 2 && later[1].t - later[0].t >= 2.4, `second launch after the retrigger window (${later.length} launches, gap ${later[1] ? (later[1].t - later[0].t).toFixed(2) : '-'} s)`);
  }

  /* ── field crafting ───────────────────────────────────────────────── */
  const craft = await page.evaluate(async () => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const recipes = inv.getRecipes('field');
    if (!recipes.length) return { recipes: 0 };
    const r = recipes[0];
    for (const i of r.inputs) inv.tryAddItem(ctx.loot.createItem(i.defId, i.qty * 2));
    const can = inv.canCraft(r.id);
    const made = await inv.craft(r.id);
    return { recipes: recipes.length, id: r.id, can, made: made?.defId ?? null };
  });
  ok(craft.recipes > 0, `field recipes available: ${craft.recipes}`);
  ok(craft.can && craft.made, `crafted ${craft.id} → ${craft.made}`);

  /* ── enemy API used by the tactical kit ───────────────────────────── */
  const enemyApi = await page.evaluate(() => {
    const e = window.__game.ctx.enemies;
    return ['queryNear', 'addDistraction', 'applyStatus', 'applyAreaDamage'].every((k) => typeof e[k] === 'function');
  });
  ok(enemyApi, 'EnemyManagerRef tactical-kit methods present');

  /* ── 2026-09-11 (C-3): overcharge is an explicit flag applyBoost also sets ────────────── */
  const oc = await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.player, im = ctx.implants;
    const before = p.isOvercharged;
    // a bare `overcharge*` speed modifier no longer turns the flag on (the old key-name inference is gone)
    p.setSpeedModifier('overcharge_probe', 1.1, 5);
    const fromKey = p.isOvercharged;
    p.setSpeedModifier('overcharge_probe', 1);
    im.applyBoost(p, 1.2, 0.4);
    const boosted = p.isOvercharged;
    return { hasSetter: typeof p.setOvercharged === 'function', before, fromKey, boosted };
  });
  ok(oc.hasSetter && oc.before === false && oc.fromKey === false, `PlayerRef.setOvercharged exists; a bare overcharge* speed modifier does not set isOvercharged (${oc.fromKey})`);
  ok(oc.boosted === true, 'implants.applyBoost(p, mul, 0.4) → isOvercharged true at once');
  await gameSleep(page, 0.6);
  const ocEnd = await page.evaluate(() => {
    const p = window.__game.ctx.player;
    const expired = p.isOvercharged;
    p.setOvercharged(5);
    const set = p.isOvercharged;
    p.setOvercharged(0);
    return { expired, set, cleared: p.isOvercharged };
  });
  ok(ocEnd.expired === false && ocEnd.set === true && ocEnd.cleared === false, `isOvercharged expires with the boost duration, setOvercharged(5) sets it, setOvercharged(0) clears it (${JSON.stringify(ocEnd)})`);

  /* ── barrier (Phase 10): a shield carried in hand; raycastBarrier stays a pure query, damageBarrier applies the hit ── */
  // equipping is ship-only: back to the ship, swap dash → barrier, drop into a fresh mission
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase (barrier)');
  const eqBarrier = await page.evaluate(() => { const im = window.__game.ctx.implants; return im.setEquipped('barrier') && im.equipped === 'barrier'; });
  ok(eqBarrier, 'barrier implant equipped in the ship');
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 43 }));
  await waitFor(page, () => window.__game.ctx.world?.ready === true && window.__game.ctx.isGameplayPhase() && window.__game.ctx.player?.isDropping === false, 'second mission (barrier)');
  await gameSleep(page, 1.0);
  const bar = await page.evaluate(() => {
    const ctx = window.__game.ctx, im = ctx.implants;
    window.__barrierHits = [];
    window.__carried = [];
    ctx.bus.on('implant:barrierHit', (e) => window.__barrierHits.push(e.damage));
    ctx.bus.on('implant:barrierCarried', (e) => window.__carried.push(e.up));
    im.activate();                                  // wielded mode: Q raises the shield
    const V = ctx.player.position.constructor;
    const fwd = new V(); ctx.player.getForward(fwd); fwd.y = 0; fwd.normalize();
    const pose = new V();
    const yaw = im.getBarrierPose(pose)?.yaw ?? null;
    const feet = ctx.player.position.clone();
    // the panel plane sits in front of the body axis, its bottom edge above the feet
    const ahead = new V().subVectors(pose, feet);
    const front = ahead.x * fwd.x + ahead.z * fwd.z;
    const side = Math.abs(ahead.x * -fwd.z + ahead.z * fwd.x);
    const origin = pose.clone().addScaledVector(fwd, 5); origin.y = pose.y + 1.2;
    const dir = fwd.clone().negate();
    const hp0 = im.barrierHp;
    const friendly = im.raycastBarrier(origin, dir, 12, false);
    const q1 = im.raycastBarrier(origin, dir, 12, true);
    const q2 = im.raycastBarrier(origin, dir, 12, true);
    // arc gate: a shot travelling with the carrier's forward comes from behind the shield and passes by
    const behind = origin.clone().addScaledVector(fwd, -12); behind.y = origin.y;
    const fromBack = im.raycastBarrier(behind, fwd, 20, true);
    const hp1 = im.barrierHp, hits1 = window.__barrierHits.length;
    if (q1) im.damageBarrier(q1.owner, q1.point);
    const hp2 = im.barrierHp;
    if (q1) im.damageBarrier('local', q1.point, 100);
    const hp3 = im.barrierHp;
    im.damageBarrier('SOMEPEER', origin);   // a peer's barrier only sparks here
    const hp4 = im.barrierHp;
    return {
      active: im.barrierActive, carried: im.barrierCarried, wielded: im.wielded, blocks: im.blocksWeapons,
      max: im.barrierMaxHp, hp0, yaw, playerYaw: ctx.player.yaw, front, side, lift: pose.y - feet.y,
      friendly, q1: q1 && { owner: q1.owner, d: q1.point.distanceTo(pose) }, q2: !!q2, fromBack,
      hp1, hits1, hp2, hp3, hp4, hits: window.__barrierHits, events: window.__carried.slice(),
    };
  });
  ok(bar.active && bar.carried && bar.hp0 > 0, `배리어 방패 raised in hand (${bar.hp0}/${bar.max} hp)`);
  ok(bar.wielded && bar.blocks, 'the shield is a wielded implant: blocksWeapons holsters the gun');
  ok(bar.events.length === 1 && bar.events[0] === true, 'implant:barrierCarried {up:true} emitted on raise');
  ok(bar.yaw !== null && Math.abs(bar.yaw - bar.playerYaw) < 1e-3, 'getBarrierPose() reports the carrier facing');
  ok(bar.front > 0.3 && bar.front < 1.5 && bar.side < 0.05 && bar.lift > 0.2, `the panel sits ${bar.front?.toFixed(2)} m in front of the feet, lifted ${bar.lift?.toFixed(2)} m`);
  ok(bar.friendly === null, 'raycastBarrier(fromEnemy = false) never blocks');
  ok(bar.q1 && bar.q1.owner === 'local' && bar.q2, `raycastBarrier(fromEnemy = true) reports the local shield (${bar.q1?.d?.toFixed(2)} m from the panel centre)`);
  ok(bar.fromBack === null, 'IMPLANT_BARRIER_CARRY_ARC: a shot from behind the carrier passes through');
  ok(bar.hp1 === bar.hp0 && bar.hits1 === 0, 'LOS queries leave barrierHp unchanged and emit no implant:barrierHit (pure query)');
  ok(bar.hp2 === bar.hp0 - 30 && bar.hits[0] === 30, `damageBarrier(owner, point) takes the block damage 30 (${bar.hp0} → ${bar.hp2}) + implant:barrierHit`);
  ok(bar.hp3 === bar.hp2 - 100 && bar.hits[1] === 100, 'damageBarrier(local, point, 100) applies the explicit amount');
  ok(bar.hp4 === bar.hp3 && bar.hits.length === 2, 'damageBarrier on a peer barrier does not touch the local hp');

  /* ── Phase 12: wide shield (3.2 m), bug collision push-out, frontal melee absorption ── */
  const wide = await page.evaluate(() => {
    const ctx = window.__game.ctx, im = ctx.implants;
    const V = ctx.player.position.constructor;
    const fwd = new V(); ctx.player.getForward(fwd); fwd.y = 0; fwd.normalize();
    const right = new V(-fwd.z, 0, fwd.x);
    const pose = new V(); im.getBarrierPose(pose);
    const dir = fwd.clone().negate();
    const feet = ctx.player.position.clone();
    const shot = (lat) => { const o = pose.clone().addScaledVector(right, lat).addScaledVector(fwd, 4); o.y = pose.y + 0.7; return im.raycastBarrier(o, dir, 10, true); };
    const hp0 = im.barrierHp;
    // collision: a bug (radius 0.5) whose centre is 0.3 m ahead of the panel plane → pushed out along the normal only;
    // one 3 m to the side or one behind the carrier is not touched
    const bug = pose.clone().addScaledVector(fwd, 0.3); bug.y = feet.y;
    const bug0 = bug.clone();
    const owner = im.resolveBarrierCollision(bug, 0.5);
    const push = new V().subVectors(bug, bug0);
    const along = push.x * fwd.x + push.z * fwd.z, lat = push.x * right.x + push.z * right.z;
    const side = pose.clone().addScaledVector(right, 3.0).addScaledVector(fwd, 0.3); side.y = feet.y;
    const side0 = side.clone();
    const sideOwner = im.resolveBarrierCollision(side, 0.5);
    const back = feet.clone().addScaledVector(fwd, -1.2);
    const back0 = back.clone();
    const backOwner = im.resolveBarrierCollision(back, 0.5);
    // frontal absorption: a melee attack from 1.5 m ahead lands on the shield (hp − amount, implant:barrierHit); from behind it does not
    const hits0 = window.__barrierHits.length;
    const absorbed = im.absorbFrontalAttack('local', feet.clone().addScaledVector(fwd, 1.5), 40);
    const hpA = im.barrierHp;
    const notAbsorbed = im.absorbFrontalAttack('local', feet.clone().addScaledVector(fwd, -1.5), 40);
    const hpB = im.barrierHp;
    const peer = im.absorbFrontalAttack('NOPEER', feet.clone().addScaledVector(fwd, 1.5), 40);
    return {
      in14: !!shot(1.4), inNeg14: !!shot(-1.4), out19: shot(1.9),
      hp0, owner, along, lat, sideOwner, sideMoved: side.distanceTo(side0), backOwner, backMoved: back.distanceTo(back0),
      absorbed, hpA, notAbsorbed, hpB, peer, hits: window.__barrierHits.length - hits0, stillUp: im.barrierActive && im.barrierCarried,
    };
  });
  ok(wide.in14 && wide.inNeg14 && wide.out19 === null, 'IMPLANT_BARRIER_CARRY_WIDTH 3.2: shots 1.4 m off-centre are blocked, 1.9 m passes');
  ok(wide.owner === 'local' && wide.along > 0.4 && wide.along < 0.5 && Math.abs(wide.lat) < 1e-6, `resolveBarrierCollision pushes an overlapping bug out to the front face (${wide.along?.toFixed(2)} m along the normal, ${wide.lat?.toFixed(3)} lateral)`);
  ok(wide.sideOwner === null && wide.sideMoved === 0 && wide.backOwner === null && wide.backMoved === 0, 'resolveBarrierCollision ignores a bug beside the panel or behind the carrier');
  ok(wide.absorbed === true && wide.hpA === wide.hp0 - 40 && wide.hits === 1, `absorbFrontalAttack from the front: shield takes the hit (${wide.hp0} → ${wide.hpA}) + implant:barrierHit`);
  ok(wide.notAbsorbed === false && wide.hpB === wide.hpA, 'absorbFrontalAttack from behind: not absorbed, hp unchanged');
  ok(wide.peer === false, 'absorbFrontalAttack for an unknown peer owner → false');
  ok(wide.stillUp, 'the shield is still raised after the absorbed hit');

  /* ── Phase 12: the shield bash — LMB, shield up ──────── */
  const bashArm = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    // gameplay mouse input is gated on the pointer lock: fake it (see the requestPointerLock stub above)
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__bashed = [];
    ctx.bus.on('implant:bashed', (e) => window.__bashed.push(e.hits));
    const V = ctx.player.position.constructor;
    const fwd = new V(); ctx.player.getForward(fwd); fwd.y = 0; fwd.normalize();
    const at = ctx.player.position.clone().addScaledVector(fwd, 0.7 + 1.0);   // 1 m past the panel plane
    const en = window.__game.getSystem('enemies').debugSpawn('scavenger', { x: at.x, z: at.z }, false);
    if (!en) return null;
    window.__bashTarget = en.id;
    // 2026-09-11 (C-1 · X-6): the bash knocks back through the contract `EnemyManagerRef.pushBack` — wrap it on the
    // instance to record the call and the target's velocity change along the push direction
    const em = ctx.enemies, orig = em.pushBack.bind(em);
    window.__push = [];
    em.pushBack = (c, r, s, d) => {
      const t = em.getEnemies().find((e) => e.id === window.__bashTarget);
      const along = (v) => (v && d ? v.x * d.x + v.z * d.z : null);
      const v0 = along(t?.velocity);
      const n = orig(c, r, s, d);
      const v1 = along(t?.velocity);
      window.__push.push({ n, speed: s, dv: v0 !== null && v1 !== null ? v1 - v0 : null, replica: !!window.__game.getSystem('enemies').replica });
      return n;
    };
    return { hp: en.hp, stamina: ctx.player.stamina, locked: ctx.input.isPointerLocked, active: ctx.isGameplayActive(), bashing: ctx.implants.bashing };
  });
  ok(bashArm && bashArm.locked && bashArm.active && bashArm.bashing === false, `bash probe armed: bug 1 m in front (hp ${bashArm?.hp}), stamina ${bashArm?.stamina?.toFixed(0)}, lock faked`);
  await gameSleep(page, 0.15);
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown', { button: 0 })));
  await gameSleep(page, 0.12);
  const bash = await page.evaluate(() => {
    const ctx = window.__game.ctx, im = ctx.implants;
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    const en = ctx.enemies.getEnemies().find((e) => e.id === window.__bashTarget);
    delete ctx.enemies.pushBack;                    // back to the class method
    return { bashing: im.bashing, stamina: ctx.player.stamina, hp: en?.hp ?? null, dead: en?.isDead ?? null, events: window.__bashed.slice(), up: im.barrierActive && im.barrierCarried, meleeing: ctx.player.isMeleeing, push: window.__push.slice() };
  });
  {
    const p = bash.push[0];
    // falloff is linear to 40 % at the rim of `radius + enemy radius`, so the struck bug gains 0.4 … 1 × speed
    ok(bash.push.length === 1 && p.n >= 1 && p.speed > 0 && !p.replica && p.dv !== null && p.dv >= p.speed * 0.4 - 1e-3 && p.dv <= p.speed + 1e-3,
      `bash knockback: enemies.pushBack called once (${p?.n} pushed), the bug gained ${p?.dv?.toFixed(2)} m/s along the push (speed ${p?.speed})`);
  }
  ok(bash.bashing === true && bash.events.length === 1, `LMB with the shield raised → bashing (implant:bashed hits=${bash.events[0]})`);
  ok(bash.stamina < bashArm.stamina - 10, `bash spent stamina (${bashArm.stamina?.toFixed(0)} → ${bash.stamina?.toFixed(0)})`);
  ok(bash.events[0] >= 1 && (bash.dead === true || (bash.hp !== null && bash.hp < bashArm.hp)), `the bug in front took bash damage (hp ${bashArm.hp} → ${bash.hp}${bash.dead ? ', dead' : ''})`);
  ok(bash.up && bash.meleeing, 'the shield stays raised through the bash and the heavy swing pose plays');
  await gameSleep(page, 0.4);
  const bashEnd = await page.evaluate(() => window.__game.ctx.implants.bashing);
  ok(bashEnd === false, 'bashing clears after IMPLANT_SHIELD_BASH_SWING_S');

  // the panel is carried, so it moves with the player instead of standing where it was raised
  const follow = await page.evaluate(() => {
    const ctx = window.__game.ctx, im = ctx.implants;
    const V = ctx.player.position.constructor;
    const panel0 = new V(); im.getBarrierPose(panel0);
    const feet0 = ctx.player.position.clone();
    ctx.player.position.x += 4;                     // teleport (the dash writes the position the same way)
    window.__followRef = { panel0: [panel0.x, panel0.z], feet0: [feet0.x, feet0.z] };
    return true;
  });
  ok(follow === true, 'shield-follow probe armed');
  await gameSleep(page, 0.2);
  const follow2 = await page.evaluate(() => {
    const ctx = window.__game.ctx, im = ctx.implants;
    const V = ctx.player.position.constructor;
    const ref = window.__followRef;
    const panel = new V();
    const pose = im.getBarrierPose(panel);
    const feet = ctx.player.position;
    const panelMoved = Math.hypot(panel.x - ref.panel0[0], panel.z - ref.panel0[1]);
    const feetMoved = Math.hypot(feet.x - ref.feet0[0], feet.z - ref.feet0[1]);
    const near = Math.hypot(panel.x - feet.x, panel.z - feet.z);
    im.activate();                                  // Q again lowers it
    const down = new V();
    return { pose: !!pose, panelMoved, feetMoved, near, down: im.getBarrierPose(down), active: im.barrierActive, carried: im.barrierCarried, events: window.__carried.slice() };
  });
  ok(follow2.pose && follow2.feetMoved > 1 && Math.abs(follow2.panelMoved - follow2.feetMoved) < 0.5 && follow2.near < 1.5,
    `the shield follows the carrier (feet +${follow2.feetMoved?.toFixed(2)} m, panel +${follow2.panelMoved?.toFixed(2)} m, still ${follow2.near?.toFixed(2)} m from the feet)`);
  ok(follow2.active === false && follow2.carried === false && follow2.down === null, 'Q again lowers the shield (getBarrierPose → null)');
  ok(follow2.events[follow2.events.length - 1] === false, 'implant:barrierCarried {up:false} emitted on lower');

  /* ── 2026-09-12: ImplantsRef.refillAll (`안정제`) lifts a collapse lockout, fills the shield (+ overcharge pool) ────── */
  const refillBar = await page.evaluate(async () => {
    const ctx = window.__game.ctx, im = ctx.implants, sys = window.__game.getSystem('implants');
    const K = await import('/src/shared/constants.ts');
    im.activate();                                  // raise again
    const V = ctx.player.position.constructor;
    const pose = new V(); im.getBarrierPose(pose);
    im.damageBarrier('local', pose, 1e6);           // collapse → lockout, shield put away
    const locked = { lockout: im.barrierLockout, hp: im.barrierHp, charges: im.charges, carried: im.barrierCarried };
    const n0 = window.__ready.length;
    sys.ocEnergy = 1;
    im.refillAll();
    const after = { lockout: im.barrierLockout, hp: im.barrierHp, max: im.barrierMaxHp, charges: im.charges, cd: im.cooldownRemaining, oc: sys.ocEnergy, ocMax: K.IMPLANT_OVERCHARGE_ENERGY };
    const major = document.querySelector('.imp-hud').classList.contains('rdy-major');
    im.activate();                                  // no longer refused as `재충전 중`
    const up = im.barrierCarried;
    im.activate();
    return { locked, after, ready: window.__ready.slice(n0), major, up, down: !im.barrierCarried };
  });
  ok(refillBar.locked.lockout > 0 && refillBar.locked.hp === 0 && refillBar.locked.charges === 0 && !refillBar.locked.carried, `barrier collapsed: lockout ${refillBar.locked.lockout?.toFixed(1)} s, shield put away`);
  ok(refillBar.after.lockout === 0 && refillBar.after.cd === 0 && refillBar.after.charges === 1 && refillBar.after.hp === refillBar.after.max && refillBar.after.oc === refillBar.after.ocMax,
    `refillAll: lockout lifted, shield ${refillBar.after.hp}/${refillBar.after.max}, charge back, overcharge pool full (${refillBar.after.oc})`);
  ok(refillBar.ready.length === 1 && refillBar.ready[0].refill === true && refillBar.ready[0].full === true && refillBar.major, `refillAll is a ready moment: implant:ready {refill, full} + .rdy-major (${JSON.stringify(refillBar.ready)})`);
  ok(refillBar.up && refillBar.down, 'the refilled shield can be raised again at once');

  /* ── recon (Phase 12): instant, one wide pulse, shared with the squad ──── */
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase (scan)');
  const eqScan = await page.evaluate(() => {
    const im = window.__game.ctx.implants;
    return { set: im.setEquipped('scan') && im.equipped === 'scan', mode: im.getDef('scan').mode, cd: im.getDef('scan').cooldown };
  });
  ok(eqScan.set && eqScan.mode === 'instant' && eqScan.cd === 30, `정찰 equipped in the ship; mode ${eqScan.mode}, cooldown ${eqScan.cd} s (Phase 12 one-shot)`);
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 44 }));
  await waitFor(page, () => window.__game.ctx.world?.ready === true && window.__game.ctx.isGameplayPhase() && window.__game.ctx.player?.isDropping === false, 'third mission (scan)');
  await gameSleep(page, 1.0);
  const scanArm = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    window.__scan = { casts: [], reveals: [], activated: [], scanned: [] };
    ctx.bus.on('scan:cast', (e) => window.__scan.casts.push({ radius: e.radius, duration: e.duration, byLocal: e.byLocal, n: e.targets.length, kinds: [...new Set(e.targets.map((t) => t.kind))], ids: e.targets.filter((t) => t.kind === 'enemy').map((t) => t.id) }));
    ctx.bus.on('detect:reveal', (e) => window.__scan.reveals.push({ duration: e.duration, n: e.targets.length }));
    ctx.bus.on('implant:activated', (e) => window.__scan.activated.push(e.id));
    ctx.bus.on('implant:scanned', (e) => window.__scan.scanned.push(e.pulse));
    const feet = ctx.player.position;
    // a bug 25 m away in the first direction that stays inside the map (it becomes `active` on its first tick)
    let en = null;
    for (let k = 0; k < 8 && !en; k++) {
      const a = (k / 8) * Math.PI * 2;
      const x = feet.x + Math.cos(a) * 25, z = feet.z + Math.sin(a) * 25;
      if (!ctx.world.isInsideBounds(x, z)) continue;
      en = window.__game.getSystem('enemies').debugSpawn('warrior', { x, z }, false);
    }
    return { spawned: !!en, enemyId: en ? String(en.id) : null };
  });
  ok(scanArm.spawned, 'scan probe: a bug spawned 25 m away');
  await gameSleep(page, 0.15);
  const scan = await page.evaluate(() => {
    const ctx = window.__game.ctx, im = ctx.implants;
    const feet = ctx.player.position;
    const interactables = ctx.interactables.all().filter((i) => i.position.distanceTo(feet) <= 70 && i.canInteract()).length;
    const charges0 = im.charges;
    im.activate();
    const after = { cd: im.cooldownRemaining, total: im.cooldownTotal, holding: im.holding, charges: im.charges };
    im.activate();   // on cooldown: denied, no second cast
    return { ...window.__scan, interactables, charges0, after, mul: ctx.progression?.derived?.implantCooldownMul ?? 1 };
  });
  scan.enemyId = scanArm.enemyId;
  ok(scan.casts.length === 1 && scan.casts[0].byLocal === true && scan.casts[0].radius === 70 && scan.casts[0].duration === 15,
    `one scan:cast {byLocal, radius 70, duration 15} per Q (${scan.casts.length} cast(s), second press on cooldown denied)`);
  ok(scan.casts[0]?.ids.includes(scan.enemyId) && scan.casts[0]?.kinds.includes('enemy'), `the bug is in the reveal (enemy ids ${scan.casts[0]?.ids.join(',')})`);
  ok(scan.casts[0] && scan.casts[0].n - scan.casts[0].ids.length === Math.min(scan.interactables, 120 - scan.casts[0].ids.length),
    `every usable interactable inside 70 m is revealed (${scan.casts[0]?.n - scan.casts[0]?.ids.length} of ${scan.interactables}; kinds ${scan.casts[0]?.kinds.join(',')})`);
  ok(scan.reveals.length === 1 && scan.reveals[0].duration === 15 && scan.reveals[0].n === scan.casts[0]?.n, 'detect:reveal carries the same targets for 15 s');
  ok(scan.activated.length === 1 && scan.activated[0] === 'scan' && scan.scanned.length === 1 && scan.scanned[0] === 1, 'implant:activated (skill XP hook) + implant:scanned fire exactly once per cast');
  ok(scan.charges0 === 1 && scan.after.charges === 0 && scan.after.holding === false && scan.after.cd > 20 && Math.abs(scan.after.total - 30 * scan.mul) < 1e-6,
    `instant cast: no hold, charge spent, cooldown ${scan.after.total.toFixed(1)} s running (${scan.after.cd.toFixed(1)} s left)`);

  /* ── 2026-09-12: refillAll mid-cooldown → the scan can be cast again at once ── */
  const scanRefill = await page.evaluate(() => {
    const im = window.__game.ctx.implants;
    const cd0 = im.cooldownRemaining, n0 = window.__ready.length;
    im.refillAll();
    const after = { cd: im.cooldownRemaining, charges: im.charges };
    im.activate();
    return { cd0, after, casts: window.__scan.casts.length, ready: window.__ready.slice(n0) };
  });
  ok(scanRefill.cd0 > 20 && scanRefill.after.cd === 0 && scanRefill.after.charges === 1 && scanRefill.casts === 2 && scanRefill.ready.length === 1 && scanRefill.ready[0].refill,
    `refillAll on a 정찰 cooling ${scanRefill.cd0.toFixed(1)} s: cooldown 0, charge back, second cast goes out (${scanRefill.casts} casts)`);

  /* ── 2026-09-12: the grapple — cooldown 24 s, refund on use end, `안정제` ──────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase (grapple)');
  ok(await page.evaluate(() => { const im = window.__game.ctx.implants; return im.setEquipped('grapple') && im.equipped === 'grapple'; }), '갈고리 equipped in the ship');
  await page.evaluate(() => { window.__readyMark = window.__ready.length; window.__game.ctx.bus.emit('game:newMission', { seed: 44 }); });
  await waitFor(page, () => window.__game.ctx.world?.ready === true && window.__game.ctx.isGameplayPhase() && window.__game.ctx.player?.isDropping === false, 'fourth mission (grapple)');
  await gameSleep(page, 1.0);
  const g = await page.evaluate(() => {
    const ctx = window.__game.ctx, im = ctx.implants, sys = window.__game.getSystem('implants'), p = ctx.player;
    const refunds = [];
    const off = ctx.bus.on('implant:cooldownRefunded', (e) => refunds.push({ seconds: e.seconds, ratio: e.ratio, id: e.id }));
    const readyAtStart = window.__ready.length - window.__readyMark;
    const fresh = () => { sys.cdRemaining = 0; sys.chargesLeft = 1; };
    // A. Q while the hook is still flying (castGrapple → releaseGrapple(false)) → 90 %, at least 3 s left.
    //    The multiplier is read before the fire: its `implant:activated` awards implant-skill XP, which can lower it.
    fresh();
    const mul0 = ctx.progression?.derived?.implantCooldownMul ?? 1;
    sys.fireGrapple();
    const A = { flying: sys.grappleState === 'flying', before: im.cooldownRemaining, total: im.cooldownTotal };
    im.activate();
    A.after = im.cooldownRemaining; A.idle = sys.grappleState === 'idle'; A.ev = refunds.slice();
    // B. attached (as updateGrapple does it), pulled `m` metres, released → 0.5 × max(0, 1 − m / 15)
    const pull = (m) => {
      fresh(); sys.fireGrapple();
      sys.grappleState = 'attached'; sys.grappleAttachPos.copy(p.position);
      const before = im.cooldownRemaining, total = im.cooldownTotal, n = refunds.length;
      const x0 = p.position.x;
      p.position.x += m;
      sys.releaseGrapple(false);
      p.position.x = x0;
      return { before, total, after: im.cooldownRemaining, ev: refunds.slice(n) };
    };
    const B0 = pull(0), B20 = pull(20), B6 = pull(6);
    const hud = { text: document.querySelector('.imp-refund')?.textContent ?? null, rf: document.querySelector('.imp-hud').classList.contains('rf-flash') };
    // C. the `안정제` while the hook flies: cooldown 0, the hook keeps flying, the release after it refunds nothing
    fresh(); sys.fireGrapple();
    const nC = refunds.length;
    im.refillAll();
    const C = { flying: sys.grappleState === 'flying', cd: im.cooldownRemaining, charges: im.charges };
    im.activate();
    C.after = im.cooldownRemaining; C.idle = sys.grappleState === 'idle'; C.ev = refunds.length - nC;
    // D. a cancel leaves 3 s — wait for them below
    fresh(); sys.fireGrapple(); im.activate();
    const D = { cd: im.cooldownRemaining };
    window.__readyMarkD = window.__ready.length;
    off();
    return { def: im.getDef('grapple').cooldown, mul: mul0, readyAtStart, A, B0, B6, B20, C, D, hud };
  });
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  // 2026-09-14: the grapple +30 % — 24 → 31.2 s, the cancel floor 3 → 3.9 s (refund ratios unchanged)
  ok(near(g.def, 31.2) && near(g.A.total, 31.2 * g.mul) && near(g.A.before, g.A.total),
    `IMPLANT_GRAPPLE_COOLDOWN 31.2: right after the fire ${g.A.before?.toFixed(2)} s of ${g.A.total?.toFixed(2)} s (×${g.mul?.toFixed(3)})`);
  ok(g.readyAtStart === 0, `no implant:ready from the ship / the grapple mission start (${g.readyAtStart})`);
  ok(g.A.flying && g.A.idle && near(g.A.after, Math.max(Math.min(g.A.before, 3.9), g.A.before - 0.9 * g.A.total)) && g.A.after >= 3.9 - 1e-6
    && g.A.ev.length === 1 && g.A.ev[0].ratio === 0.9 && near(g.A.ev[0].seconds, g.A.before - g.A.after),
    `cancel before attaching: 90 % refund floored at 3.9 s (${g.A.before.toFixed(2)} → ${g.A.after.toFixed(2)} s, −${g.A.ev[0]?.seconds?.toFixed(2)})`);
  ok(near(g.B0.after, g.B0.before - 0.5 * g.B0.total) && g.B0.ev.length === 1 && g.B0.ev[0].ratio === 0.5,
    `attached, no pull: 50 % refund (${g.B0.before.toFixed(2)} → ${g.B0.after.toFixed(2)} s)`);
  ok(near(g.B6.after, g.B6.before - 0.3 * g.B6.total) && g.B6.ev.length === 1 && near(g.B6.ev[0].ratio, 0.3),
    `attached, 6 m pull: 0.5 × (1 − 6/15) = 30 % (${g.B6.before.toFixed(2)} → ${g.B6.after.toFixed(2)} s)`);
  ok(near(g.B20.after, g.B20.before) && g.B20.ev.length === 0, 'attached, 20 m pull (≥ 15 m): no refund, no event');
  {
    const s = g.B6.ev[0]?.seconds ?? 0;
    const want = `−${s.toFixed(s < 10 ? 1 : 0)}초`;
    ok(g.hud.text === want && g.hud.rf, `HUD: green "${want}" beside the thumbnail + .rf-flash (${g.hud.text})`);
  }
  ok(g.C.flying && g.C.cd === 0 && g.C.charges === 1 && g.C.idle && g.C.after === 0 && g.C.ev === 0, `refillAll with the hook out: keeps flying, cooldown 0, the release refunds nothing (${JSON.stringify(g.C)})`);
  await gameSleep(page, 0.2);
  const gCool = await page.evaluate(() => { const h = document.querySelector('.imp-hud'); return { dim: h.classList.contains('dim'), ready: h.classList.contains('is-ready') }; });
  ok(near(g.D.cd, 3.9) && gCool.dim && !gCool.ready, `after a cancel: 3.9 s left, dimmed, no ready glow (${JSON.stringify(gCool)})`);
  await gameSleep(page, 4.1);
  const gReady = await page.evaluate(() => {
    const h = document.querySelector('.imp-hud');
    return { ev: window.__ready.slice(window.__readyMarkD), major: h.classList.contains('rdy-major'), ready: h.classList.contains('is-ready'), dim: h.classList.contains('dim'), snd: window.__snd.slice(-1)[0] };
  });
  ok(gReady.ev.length === 1 && gReady.ev[0].full && !gReady.ev[0].refill && gReady.major && gReady.ready && !gReady.dim && gReady.snd?.id === 'implant_ready',
    `the grapple cooldown runs out: implant:ready {full} → .rdy-major + .is-ready + implant_ready (${JSON.stringify(gReady)})`);

  /* ── HUD widgets ──────────────────────────────────────────────────── */
  const hud = await page.evaluate(() => {
    const all = [...document.querySelectorAll('[class]')].map((n) => n.className).join(' ');
    return { implant: /implant/i.test(all), quick: /quick/i.test(all), weight: /weight/i.test(all) };
  });
  ok(hud.implant, 'implant widget in the DOM');
  ok(hud.quick, 'quick bar in the DOM');
  ok(hud.weight, 'weight bar in the DOM');

  /* ── shader programs must not keep growing (the old grenade hitch) ─ */
  const programs1 = await page.evaluate(() => window.__game.ctx.renderer.info.programs?.length ?? -1);
  // Phase 12 raised the bound 70 → 95: the script now runs three missions and spawns two bug types (scavenger, warrior)
  // whose materials compile on first sight (~71 measured). The check still catches unbounded growth (the old grenade hitch).
  // 2026-09-15 95 → 100: the sandworm director no longer pre-rolls — its base chance is > 0 on every threat, so the worm rig is
  // prewarmed (`Director.prewarm`) in every planet raid and its 3 programs always count (98 measured, was 95).
  ok(programs1 - programs0 < 100, `shader programs ${programs0} → ${programs1} after every tactical FX fired`);

  ok(errors.length === 0, 'no console errors', errors.slice(0, 6).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness: ${e.message}`);
  if (errors.length) console.log(`  console errors: ${errors.slice(0, 8).join(' | ')}`);
} finally {
  await closeBrowser(browser);
}

console.log(`\nsmoke: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
