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
  const thrown = {};
  for (const id of ['incendiary', 'smokeGrenade', 'lureGrenade', 'domeShield']) {
    thrown[id] = await page.evaluate((g) => window.__game.ctx.gadgets.use(g, false), id);
    await gameSleep(page, 1.1);   // USE_COOLDOWN is game time
  }
  ok(Object.values(thrown).every(Boolean), `throwable gadgets used: ${JSON.stringify(thrown)}`);

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
    ctx.bus.on('player:launched', (e) => window.__launches.push(e.impulse.y));
    ctx.player.respawnAt(new (ctx.player.position.constructor)(p.position.x, p.position.y, p.position.z), 0);
    return true;
  });
  ok(!!pad, 'jump pad present');
  if (pad) {
    await gameSleep(page, 2.0);
    const launches = await page.evaluate(() => window.__launches);
    ok(launches.length > 0 && launches[0] > 5, `jump pad launched the player (impulse.y ${launches[0]?.toFixed(2)})`);
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
