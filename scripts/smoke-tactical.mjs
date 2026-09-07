// Single-client smoke test for the tactical kit: boots the game, walks it into a mission and exercises
// implants, gadgets, gear/weight, melee, roll, gathering, field crafting and progression.
// Usage: node scripts/smoke-tactical.mjs [http://localhost:5273/]
// Requires `npm run dev` (or `npm run dev:all`) to be running.
//
// NOTE ON TIMING: Engine clamps dt to 0.05 s and the frame rate depends on the machine (swiftshader fallback ≈ 5 fps),
// so wall time is NOT game time. Anything with a cooldown or a duration must be advanced with
// `gameSleep`, which waits on `ctx.time`.
import puppeteer from 'puppeteer-core';
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
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
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
  ok((cat.byCat.gadget ?? 0) === 10, `10 gadget items (${cat.byCat.gadget})`);
  ok((cat.byCat.herb ?? 0) >= 3, `herb items (${cat.byCat.herb})`);
  ok(cat.recipes >= 10, `craft recipes: ${cat.recipes}`);
  ok(cat.weighted, 'every item def carries a weight');

  /* ── progression ──────────────────────────────────────────────────── */
  const prog = await page.evaluate(() => {
    const p = window.__game.ctx.progression, d = p.derived;
    return { stats: Object.keys(p.profile.stats).length, skills: Object.keys(p.profile.skills).length, carry: d.carryCapacity, recoilAR: d.recoilMul?.AR };
  });
  ok(prog.stats === 5, `5 stats`);
  ok(prog.skills === 14, `14 skills`);
  ok(prog.carry > 0 && prog.recoilAR > 0, `derived stats sane (carry ${prog.carry} kg)`);

  /* ── implants: equipping is a ship-only action ────────────────────── */
  const implantIds = await page.evaluate(() => window.__game.ctx.implants.getAllDefs().map((d) => d.id));
  ok(implantIds.length === 6, `6 implants: ${implantIds.join(',')}`);

  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  const inHub = await page.evaluate(() => {
    const im = window.__game.ctx.implants;
    return { set: im.setEquipped('dash'), equipped: im.equipped };
  });
  ok(inHub.set && inHub.equipped === 'dash', 'implant equipped in the ship');

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
  const gather = await page.evaluate(() => {
    const n = window.__game.ctx.world.getGatherNodes();
    return { n: n.length, defIds: [...new Set(n.map((g) => g.defId))] };
  });
  ok(gather.n >= 30, `gather nodes spawned: ${gather.n}`);
  ok(gather.defIds.every((id) => id.startsWith('herb_')), `gather nodes yield herbs: ${gather.defIds.join(',')}`);

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
    return { done, dr: ctx.player.damageReduction };
  });
  ok(armor.done && armor.dr > 0, `armor equipped, damage reduction ${(armor.dr * 100).toFixed(0)}%`);

  /* ── melee + roll ─────────────────────────────────────────────────── */
  ok(await page.evaluate(() => window.__game.ctx.player.startMelee()), 'startMelee() accepted');
  await gameSleep(page, 1.0);

  await page.evaluate(() => { window.__rollFrom = window.__game.ctx.player.position.clone(); });
  const rollStarted = await page.evaluate(() => window.__game.ctx.player.roll());
  await gameSleep(page, 1.2);
  const rolled = await page.evaluate(() => ({
    moved: window.__game.ctx.player.position.distanceTo(window.__rollFrom),
    rolling: window.__game.ctx.player.isRolling,
  }));
  ok(rollStarted && rolled.moved > 3.0, `roll covered ${rolled.moved.toFixed(2)} m of the 4.2 m arc`);
  ok(rolled.rolling === false, 'roll ended back in a standing stance');

  /* ── dash implant ─────────────────────────────────────────────────── */
  const dash = await page.evaluate(() => {
    const ctx = window.__game.ctx, im = ctx.implants;
    window.__dashFrom = ctx.player.position.clone();
    const before = im.charges;
    im.activate();
    return { before, after: im.charges, max: im.maxCharges };
  });
  await gameSleep(page, 0.3);
  const dashMoved = await page.evaluate(() => window.__game.ctx.player.position.distanceTo(window.__dashFrom));
  ok(dash.max === 3, 'dash carries 3 charges');
  ok(dash.after === dash.before - 1, `dash consumed a charge (${dash.before}→${dash.after})`);
  ok(dashMoved > 2, `dash teleported ${dashMoved.toFixed(2)} m`);

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
  // Full health on the spot first, and 화염수류탄 **last**: its fire zone is friendly-fire by design and lands a few
  // metres ahead of a standing player, so with the current starter gear the burn downed the player partway through
  // the loop — and a downed player is refused **silently** (`deny(null)`), so every later `use()` returned false.
  await page.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.player.respawnAt(ctx.player.position.clone(), ctx.player.yaw);
  });
  await gameSleep(page, 0.3);
  const thrown = {};
  for (const id of ['smokeGrenade', 'lureGrenade', 'domeShield', 'incendiary']) {
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
    });
    await gameSleep(page, 1.8);
    const launches = await page.evaluate(() => window.__launches);
    ok(launches.length === 1 && launches[0].y > 5, `jump pad launched the player exactly once in 1.8 s (impulse.y ${launches[0]?.y?.toFixed(2)}, ${launches.length} launches)`);
    // Phase 9: per-player re-trigger gate — standing on the pad again inside JUMP_PAD_RETRIGGER_S (2.5 s) does nothing
    await onPad();
    await gameSleep(page, 0.3);
    const inside = await page.evaluate(() => window.__launches.length);
    ok(inside === 1, `no re-launch inside JUMP_PAD_RETRIGGER_S (${inside} launches at ~2.1 s)`);
    await onPad();
    await gameSleep(page, 0.8);
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
  ok(programs1 - programs0 < 70, `shader programs ${programs0} → ${programs1} after every tactical FX fired`);

  ok(errors.length === 0, 'no console errors', errors.slice(0, 6).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness: ${e.message}`);
  if (errors.length) console.log(`  console errors: ${errors.slice(0, 8).join(' | ')}`);
} finally {
  await browser.close();
}

console.log(`\nsmoke: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
