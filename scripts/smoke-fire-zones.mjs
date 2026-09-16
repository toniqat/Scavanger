// Smoke: player fire zones (docs/TODO.md B-16 · 사용자 버그 「플레이어 소이 가젯에도 불 대지가 안 만들어진다」, 2026-09-15).
//
// Solo raid. 2026-09-15 2차 (화염 통합): 화염을 만드는 것은 **화염 수류탄 하나**(`grenade_incendiary`)뿐이고 옛 가젯
// 아이템 `gad_incendiary` 는 사라졌다 — `fire` 배치물의 정의도 내부 정의 `incendiary` 하나다. Throws it through the normal
// quick-use hand (T slot → LMB), then checks: a `fire` zone at the landing spot with the right radius / duration
// (`ctx.gadgets.getFireZones()`), it burns an enemy, the local player and a ground drone standing in it, `fire_ignite` /
// `fire_crackle` go out on the bus, it expires. A plain G-12 frag makes no zone and keeps its 6 m blast; the G-10 blast is the
// small `GRENADE_INCENDIARY_BLAST_*` one (also on a visual-only replica, which never lights a zone itself).
// Root-cause regression: a canister landing on a structure **roof** must burn on the roof, not on the terrain under it.
//
// Usage: node scripts/smoke-fire-zones.mjs [http://localhost:5273/]
// Timing: headless dt is clamped to 50 ms — every wait is on `ctx.time` (sim seconds), never wall time.
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
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 90000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* page still loading */ }
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const errors = [];
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required', '--window-size=960,540', '--no-sandbox'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // solo raid: park the relay too so a server profile cannot land mid-run
  await quietViteHmr(page, { parkRelay: true });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game?.ctx?.inventory && !!window.__game.ctx.gadgets, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    // fake pointer lock so gameplay input (quick-use LMB) is accepted
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
  });
  const waitSim = async (sec) => {
    const t0 = await page.evaluate(() => window.__game.ctx.time);
    await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec);
  };

  /* ── catalogue / contract ─────────────────────────────────────────── */
  const cat = await page.evaluate(() => {
    const { loot, gadgets } = window.__game.ctx;
    /* 2026-09-15 2차: `fire` 를 만드는 정의는 `incendiary` 하나이고 **아이템이 없는 내부 정의**다 (옛 `grenadeFire` 는 은퇴). */
    const inc = gadgets.getDef('incendiary'), gone = gadgets.getDef('grenadeFire');
    return {
      g10: loot.getItemDef('grenade_incendiary')?.grenadeFire === true,
      frag: loot.getItemDef('grenade_frag')?.grenadeFire,
      listed: gadgets.getDefs().some((d) => d.id === 'incendiary' || d.id === 'grenadeFire'),
      retired: gone === undefined,
      aliased: loot.getItemDef('gad_incendiary')?.id,
      defs: gadgets.getDefs().length,
      gf: inc ? { use: inc.use, dep: inc.deployable, r: inc.radius, dur: inc.duration, hp: inc.hp } : null,
      apis: typeof gadgets.getFireZones === 'function' && typeof gadgets.igniteGrenadeFire === 'function',
    };
  });
  ok(cat.g10 && cat.frag === undefined, `items.csv grenadeFire: G-10 true, G-12 unset (${cat.g10}/${cat.frag})`);
  /* 2026-09-15 (땅굴벌레): 진동 장치가 들어와 공개 정의는 13개다 */
  ok(!cat.listed && cat.defs === 13, `화염 지대는 내부 정의라 getDefs() 밖이다 (${cat.defs} defs)`);
  /* `gad_incendiary` 는 지운 것이 아니라 `item_aliases.csv` 로 화염 수류탄에 흡수됐다 — 가진 사람이 잃지 않는다. */
  ok(cat.retired && cat.aliased === 'grenade_incendiary', `옛 'grenadeFire' 정의 은퇴 · gad_incendiary → ${cat.aliased}`);
  ok(cat.gf && cat.gf.use === 'throw' && cat.gf.dep === 'fire' && cat.gf.r === 3.5 && cat.gf.dur === 6 && cat.gf.hp === 0,
    `화염 지대 정의 = throw · fire · r 3.5 · 6 s · hp 0 (${JSON.stringify(cat.gf)})`);
  ok(cat.apis, 'GadgetsRef.getFireZones / igniteGrenadeFire published');

  /* ── mission ──────────────────────────────────────────────────────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 42 }));
  await waitFor(page, () => { const c = window.__game.ctx; return c.world?.ready && c.isGameplayPhase() && c.player?.isDropping === false; }, 'mission + drop-in');
  await waitSim(0.5);

  await page.evaluate(() => {
    const ctx = window.__game.ctx;
    window.__snd = [];
    window.__ev = { exploded: [], deployed: [], removed: [], burning: [] };
    ctx.bus.on('audio:play', (e) => { if (e.id === 'fire_ignite' || e.id === 'fire_crackle') window.__snd.push({ id: e.id, t: ctx.time, p: e.position ? [e.position.x, e.position.y, e.position.z] : null }); });
    ctx.bus.on('grenade:exploded', (e) => window.__ev.exploded.push({ r: e.radius, p: [e.position.x, e.position.y, e.position.z], t: ctx.time }));
    ctx.bus.on('gadget:deployed', (e) => window.__ev.deployed.push({ id: e.id, kind: e.kind, t: ctx.time }));
    ctx.bus.on('gadget:removed', (e) => window.__ev.removed.push({ id: e.id, reason: e.reason, t: ctx.time }));
    ctx.bus.on('player:burning', (e) => window.__ev.burning.push({ active: e.active, t: ctx.time }));
    // the legendary bag carries plenty of quick slots; a fresh body for every section
    const bag = ctx.loot.createItem('bag_legendary', 1);
    ctx.inventory.tryAddItem(bag);
    ctx.inventory.equip(bag.uid, 'bag');
    window.__spawn = ctx.player.position.clone();
    window.__yaw = ctx.player.yaw;
    window.__reset = () => { ctx.player.respawnAt(window.__spawn.clone(), window.__yaw); };
    window.__zones = () => ctx.gadgets.getFireZones().map((z) => ({ id: z.id, r: z.radius, rem: z.remaining, hostile: z.hostile, p: [z.position.x, z.position.y, z.position.z] }));
  });
  ok((await page.evaluate(() => window.__zones().length)) === 0, 'no fire zones at mission start');

  /** Put `defId` into a quick slot, take it into the hand and click LMB (a grenade throws on release). */
  const throwFromHand = async (defId) => {
    const slot = await page.evaluate((id) => {
      const ctx = window.__game.ctx;
      window.__reset();
      const it = ctx.loot.createItem(id, 2);
      if (!ctx.inventory.tryAddItem(it)) return -2;
      const n = ctx.inventory.getQuickSlots().length;
      for (let i = 0; i < n; i++) if (ctx.inventory.setQuickSlot(i, it.uid)) return i;
      return -1;
    }, defId);
    if (slot < 0) return { slot };
    await waitSim(0.3);
    await page.evaluate((i) => window.__game.getSystem('weapons').equipQuick(i), slot);
    await waitSim(0.5);
    const held = await page.evaluate(() => window.__game.ctx.weapons.remoteState.heldItemId);
    const t = await page.evaluate(() => window.__game.ctx.time);
    await page.evaluate(() => document.body.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })));
    await waitSim(0.15);
    await page.evaluate(() => document.body.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true })));
    return { slot, held, t };
  };
  const sinceT = (arr, t) => arr.filter((e) => e.t >= t);

  /* ── 1. G-12 frag: 7.2 m blast, no zone ───────────────────────────── */
  const frag = await throwFromHand('grenade_frag');
  ok(frag.held === 'grenade_frag', `frag taken into the hand (slot ${frag.slot}, held ${frag.held})`);
  await waitSim(3.6);
  const fragOut = await page.evaluate((t) => ({ ex: window.__ev.exploded.filter((e) => e.t >= t), zones: window.__zones(), dep: window.__ev.deployed.filter((e) => e.t >= t) }), frag.t);
  // 2026-09-15 (사용자 결정): 고폭 반경 6 → 7.2 (×1.2) — `data/constants.csv` 의 GRENADE_RADIUS
  ok(fragOut.ex.length === 1 && Math.abs(fragOut.ex[0].r - 7.2) < 1e-6, `G-12 exploded once with the 7.2 m frag blast (${JSON.stringify(fragOut.ex.map((e) => e.r))})`);
  ok(fragOut.zones.length === 0 && fragOut.dep.length === 0, `G-12 makes no fire zone (${fragOut.zones.length} zones, ${fragOut.dep.length} deployed)`);

  /* ── 2. G-10 소이 수류탄 via the hand: small blast + 3.5 m / 6 s zone ── */
  const g10 = await throwFromHand('grenade_incendiary');
  ok(g10.held === 'grenade_incendiary', `G-10 taken into the hand (held ${g10.held})`);
  await waitFor(page, (t) => window.__ev.exploded.some((e) => e.t >= t), 'G-10 explosion', 180000, g10.t);
  await waitSim(0.2);
  const g10Out = await page.evaluate((t) => {
    const ctx = window.__game.ctx;
    const ex = window.__ev.exploded.filter((e) => e.t >= t);
    const zones = window.__zones();
    const z = zones[0];
    const surf = z ? ctx.world.getSurfaceY(z.p[0], z.p[2], z.p[1] + 0.3) : null;
    const d = window.__game.getSystem('gadgets').deployables.find((x) => x.kind === 'fire');
    return { ex, zones, surf, ign: window.__snd.filter((s) => s.t >= t && s.id === 'fire_ignite'), dep: window.__ev.deployed.filter((e) => e.t >= t),
      fx: { visible: !!d?.visual.root.visible, gadget: d?.gadgetId } };
  }, g10.t);
  const z10 = g10Out.zones[0];
  ok(g10Out.ex.length === 1 && g10Out.ex[0].r === 3, `G-10 blast is the small one: radius ${g10Out.ex[0]?.r} (GRENADE_INCENDIARY_BLAST_RADIUS 3, frag 7.2)`);
  ok(g10Out.zones.length === 1 && z10.r === 3.5 && z10.rem > 5 && z10.rem <= 6 && z10.hostile === false,
    `G-10 lit one fire zone r 3.5 · ${z10?.rem?.toFixed(2)} s left of 6 · hostile false (${JSON.stringify(g10Out.zones)})`);
  if (z10) {
    const dxz = Math.hypot(z10.p[0] - g10Out.ex[0].p[0], z10.p[2] - g10Out.ex[0].p[2]);
    ok(dxz < 0.05 && Math.abs(z10.p[1] - g10Out.surf) < 0.05, `zone sits at the explosion XZ (${dxz.toFixed(3)} m) on the surface (y ${z10.p[1].toFixed(2)} vs ${g10Out.surf?.toFixed(2)})`);
    /* 2026-09-15 2차: 정의가 하나가 되면서 `-gf` 표식이 은퇴했다 — 평범한 `-g` id 다. */
    ok(/-g\d+$/.test(z10.id) && !/-gf\d+$/.test(z10.id) && g10Out.dep.some((d) => d.id === z10.id && d.kind === 'fire'), `zone id is the plain one: ${z10.id}`);
    ok(g10Out.fx.visible && g10Out.fx.gadget === 'incendiary', `zone visual is shown (${JSON.stringify(g10Out.fx)})`);
    ok(g10Out.ign.length === 1 && Math.hypot(g10Out.ign[0].p[0] - z10.p[0], g10Out.ign[0].p[2] - z10.p[2]) < 0.1, `fire_ignite once at the zone (${g10Out.ign.length})`);
  }
  // enemy / local player / ground drone inside the G-10 zone
  const burn = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const z = ctx.gadgets.getFireZones()[0];
    const V = ctx.player.position.constructor;
    // enemy at the zone centre, player 1.2 m off it (inside) facing away, drone 1.5 m the other side
    const enemies = window.__game.getSystem('enemies');
    const e = enemies.debugSpawn('scavenger', { x: z.position.x, z: z.position.z }, false);
    window.__burnEnemy = e;
    ctx.player.respawnAt(new V(z.position.x + 1.2, z.position.y, z.position.z), 0);
    ctx.player.heal(1000);
    return { enemy: !!e, ehp: e?.hp ?? null, emax: e?.maxHp ?? null, hp: ctx.player.hp + ctx.player.shield, zid: z.id };
  });
  ok(burn.enemy, `enemy spawned in the zone (hp ${burn.ehp}/${burn.emax})`);
  // the drone is taken out from beside the player, then parked inside the zone
  const drone = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const okDeploy = ctx.drones?.deploy('ground');
    const d = ctx.drones?.getDrones().find((x) => x.kind === 'ground' && x.owner === 'local');
    if (!d) return { okDeploy, id: null };
    const z = ctx.gadgets.getFireZones()[0];
    d.position.set(z.position.x - 1.5, z.position.y, z.position.z);
    // every hp change / removal of this drone from here on (a 30 hp ground drone can burn out inside the 1 s window)
    window.__droneEv = { dmg: [], removed: [] };
    ctx.bus.on('drone:damaged', (e) => { if (e.id === d.id) window.__droneEv.dmg.push({ hp: e.hp, t: ctx.time }); });
    ctx.bus.on('drone:removed', (e) => { if (e.id === d.id) window.__droneEv.removed.push({ reason: e.reason, t: ctx.time }); });
    return { okDeploy, id: d.id, hp: d.hp, max: d.maxHp };
  });
  ok(!!drone.id, `ground drone deployed (${drone.okDeploy}, ${drone.id} hp ${drone.hp})`);
  await waitSim(1.0);
  const burnOut = await page.evaluate((d0) => {
    const ctx = window.__game.ctx;
    const e = window.__burnEnemy;
    const dr = d0.id ? ctx.drones.getDrones().find((x) => x.id === d0.id) : null;
    const z = ctx.gadgets.getFireZones()[0];
    const dist = dr && z ? Math.hypot(dr.position.x - z.position.x, dr.position.z - z.position.z) : null;
    const out = { ehp: e ? (e.isDead ? 0 : e.hp) : null, edead: e?.isDead ?? null, hp: ctx.player.hp + ctx.player.shield,
      burning: window.__ev.burning.some((b) => b.active), dhp: dr ? dr.hp : 'gone', ddist: dist };
    // get the player out and put the fire on them out, so the rest of the run starts healthy
    ctx.player.setBurning?.(0, 0);
    window.__reset();
    ctx.player.heal(1000);
    return out;
  }, drone);
  ok(burnOut.ehp !== null && burnOut.ehp < burn.ehp, `enemy in the zone burns: hp ${burn.ehp} → ${burnOut.ehp}${burnOut.edead ? ' (dead)' : ''}`);
  ok(burnOut.burning && burnOut.hp < burn.hp, `local player in the zone burns: player:burning + hp/shield ${burn.hp} → ${burnOut.hp.toFixed(1)}`);
  const dEv = await page.evaluate(() => window.__droneEv ?? { dmg: [], removed: [] });
  const burnedDown = dEv.dmg.length > 0 && dEv.dmg[0].hp < drone.hp;
  const destroyedByFire = dEv.removed.length === 0 || (dEv.removed[0].reason === 'destroyed' && dEv.dmg.some((x) => x.hp <= 0));
  ok(burnedDown && destroyedByFire && (burnOut.dhp === 'gone' ? dEv.removed.length === 1 : burnOut.dhp < drone.hp),
    `ground drone in the zone burns: hp ${drone.hp} → ${dEv.dmg.map((x) => Math.round(x.hp)).join(' → ')}${dEv.removed.length ? ` → removed (${dEv.removed[0].reason})` : ` (${burnOut.ddist?.toFixed(2)} m from centre)`}`);
  const crackle = await page.evaluate((t) => window.__snd.filter((s) => s.id === 'fire_crackle' && s.t >= t).length, g10.t);
  ok(crackle >= 1, `fire_crackle repeats while it burns (${crackle} so far)`);
  // expiry: 6 s after it lit
  await waitFor(page, (id) => !window.__game.ctx.gadgets.getFireZones().some((z) => z.id === id), 'G-10 zone expiry', 180000, burn.zid);
  const exp = await page.evaluate((id) => {
    const rm = window.__ev.removed.find((r) => r.id === id);
    const dep = window.__ev.deployed.find((d) => d.id === id);
    const cr = window.__snd.filter((s) => s.id === 'fire_crackle' && dep && s.t >= dep.t && rm && s.t <= rm.t + 0.01).length;
    return { reason: rm?.reason, life: rm && dep ? rm.t - dep.t : null, crackles: cr };
  }, burn.zid);
  ok(exp.reason === 'expired' && exp.life > 5.8 && exp.life < 6.6, `G-10 zone expired after ${exp.life?.toFixed(2)} s (reason ${exp.reason})`);
  ok(exp.crackles >= 6 && exp.crackles <= 9, `fire_crackle every FIRE_ZONE_CRACKLE_S (0.7) over its life: ${exp.crackles}`);
  await page.evaluate(() => { const ctx = window.__game.ctx; const d = ctx.drones?.getDrones().find((x) => x.owner === 'local'); if (d) ctx.drones.damageDrone(d.id, 1e6); });

  /* ── 3. (은퇴) 옛 가젯 「화염수류탄」(gad_incendiary) 투척 절 — 2026-09-15 2차 화염 통합으로 그 아이템이 사라졌다.
     반경 · 지속 · id · 지대 비주얼 검사는 위 2절(화염 수류탄)이 그대로 덮는다. */

  /* ── 4. root cause: a canister landing on a structure roof burns ON the roof ── */
  const roof = await page.evaluate(() => {
    const ctx = window.__game.ctx, w = ctx.world, g = window.__game.getSystem('gadgets');
    const V = ctx.player.position.constructor;
    for (const s of w.getStructures()) {
      for (const [ox, oz] of [[1.3, 0.7], [-1.1, 1.4], [0.6, -1.6], [2.2, 0]]) {
        const x = s.position.x + ox, z = s.position.z + oz;
        const terrain = w.getHeightAt(x, z), top = w.getSurfaceY(x, z);
        if (top - terrain < 2.5) continue;
        const before = new Set(g.deployables.map((d) => d.id));
        g.thrown.throw('incendiary', '#ff7a1a', new V(x, top + 2.5, z), new V(0, -1, 0));   // the real canister: gravity → land → onImpact
        return { kind: s.kind, x, z, terrain, top, before: [...before] };
      }
    }
    return null;
  });
  ok(!!roof, `found a structure roof above terrain (${roof ? `${roof.kind}: roof ${roof.top.toFixed(2)} / terrain ${roof.terrain.toFixed(2)}` : 'none'})`);
  if (roof) {
    await waitSim(1.0);
    const r = await page.evaluate((info) => {
      const ctx = window.__game.ctx, g = window.__game.getSystem('gadgets');
      const d = g.deployables.find((x) => !info.before.includes(x.id) && x.kind === 'fire');
      const V = ctx.player.position.constructor;
      return d ? { y: d.position.y, dps: g.fireDamageAt(new V(info.x, info.top, info.z)) } : null;
    }, roof);
    ok(r && Math.abs(r.y - roof.top) < 0.05 && r.dps > 0, `roof canister burns on the roof: zone y ${r?.y?.toFixed(2)} (roof ${roof.top.toFixed(2)}, terrain ${roof.terrain.toFixed(2)}), dps there ${r?.dps}`);
    // a G-10 going off in the air above the roof drops its fire on the roof too
    const air = await page.evaluate((info) => {
      const ctx = window.__game.ctx, g = window.__game.getSystem('gadgets');
      const before = new Set(g.deployables.map((d) => d.id));
      const V = ctx.player.position.constructor;
      ctx.gadgets.igniteGrenadeFire(new V(info.x + 0.4, info.top + 1.4, info.z));
      const d = g.deployables.find((x) => !before.has(x.id));
      return d ? { y: d.position.y, r: d.radius, id: d.id } : null;
    }, roof);
    ok(air && Math.abs(air.y - roof.top) < 0.1 && air.r === 3.5, `airborne G-10 over the roof → zone on the roof (y ${air?.y?.toFixed(2)}, r ${air?.r})`);
  }

  /* ── 5. replicas: small G-10 blast, never a zone of their own; internal gadget refuses use() ── */
  const rep = await page.evaluate(() => {
    const ctx = window.__game.ctx, w = window.__game.getSystem('weapons');
    const V = ctx.player.position.constructor;
    const p = ctx.player;
    window.__reset();
    p.heal(1000);
    return { hp: p.hp + p.shield, zones: ctx.gadgets.getFireZones().length, used: ctx.gadgets.use('incendiary', false), n: w.grenades.activeCount, pos: [p.position.x, p.position.y, p.position.z] };
  });
  ok(rep.used === false, `내부 가젯 ctx.gadgets.use('incendiary') 는 거절된다 (${rep.used})`);
  await page.evaluate(() => {
    const ctx = window.__game.ctx, w = window.__game.getSystem('weapons');
    const p = ctx.player.position;
    w.grenades.throw(new p.constructor(p.x + 1.5, p.y + 0.9, p.z), new p.constructor(0, 0, 0), true, 0.05, true);
  });
  await waitSim(0.4);
  const repG10 = await page.evaluate(() => { const c = window.__game.ctx; return { hp: c.player.hp + c.player.shield, zones: c.gadgets.getFireZones().length }; });
  await page.evaluate(() => {
    const ctx = window.__game.ctx, w = window.__game.getSystem('weapons');
    ctx.player.heal(1000);
    window.__hpFragBefore = ctx.player.hp + ctx.player.shield;
    const p = ctx.player.position;
    w.grenades.throw(new p.constructor(p.x + 1.5, p.y + 0.9, p.z), new p.constructor(0, 0, 0), true, 0.05, false);
  });
  await waitSim(0.4);
  const repFrag = await page.evaluate(() => { const c = window.__game.ctx; return { before: window.__hpFragBefore, hp: c.player.hp + c.player.shield }; });
  const g10Dmg = rep.hp - repG10.hp, fragDmg = repFrag.before - repFrag.hp;
  // 1.5 m: G-10 40 × 0.5 × 0.6 = 12 · frag 250 × 0.75 × 0.6 = 112 (clamped by the pool)
  ok(g10Dmg > 5 && g10Dmg < 20 && fragDmg > g10Dmg * 3, `replica blast at 1.5 m: G-10 ${g10Dmg.toFixed(1)} vs frag ${fragDmg.toFixed(1)}`);
  ok(repG10.zones === rep.zones, `a visual-only G-10 replica lights no zone (${rep.zones} → ${repG10.zones})`);

  ok(errors.length === 0, 'no console errors', errors.slice(0, 6).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness: ${e.message}`);
  if (errors.length) console.log(`  console errors: ${errors.slice(0, 8).join(' | ')}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\nsmoke: ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
