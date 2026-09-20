// Screenshot helper for the pitch wiki (docs/pitch/ — one HTML file per page under pages/).
// Drives the running dev build with puppeteer-core and writes PNGs straight into docs/pitch/assets/,
// where the wiki pages pick them up automatically (each probes its `data-src` and swaps the placeholder).
// No assertions and no exit code — every shot is independent, a failure only skips that one.
//
// Usage: npm run dev, then:  node scripts/shots-pitch.mjs [http://localhost:5273/] [name ...]
//        (extra args filter which shots run, e.g. `node scripts/shots-pitch.mjs char-sheet corp-screen`)
import puppeteer from 'puppeteer-core';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const BASE = argv.find((a) => a.startsWith('http')) ?? 'http://localhost:5273/';
const ONLY = new Set(argv.filter((a) => !a.startsWith('http')));
const OUT = 'docs/pitch/assets';
/**
 * Shots are written to a staging dir OUTSIDE the repo first, then copied into `OUT` when the run ends.
 * Writing PNGs into the project while `npm run dev` is up makes Vite's watcher issue a full page reload,
 * which throws `window.__game` away mid-run and kills every shot after the first.
 */
const STAGE = join(tmpdir(), 'scav-pitch-shots');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--window-size=1920,1080', '--no-sandbox'],
});

let taken = 0, failed = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await quietViteHmr(page);   // 2026-09-11 (C-71): another editor's save must not reload the page mid-shoot
  await page.evaluateOnNewDocument(() => {
    // 2026-09-08: this script does not check the tutorial. A new profile starts the tutorial on its own and
    // it locks room purposes · crafting · the terminal · boarding in that order, so it is seeded here as
    // "already done" (the tutorial itself is what scripts/smoke-tutorial.mjs checks).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  page.on('pageerror', (e) => console.log('  pageerror', String(e).slice(0, 160)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 250 && !(await page.evaluate(() => !!window.__game?.ctx)); i++) await sleep(80);

  /* headless has no rAF pump once the tab backgrounds — drive the loop ourselves, like the other shot scripts */
  const inject = () => page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 16);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    /* three is not on window; borrow a Vector3 from the player and clone it */
    window.__V = (x, y, z) => { const v = window.__game.ctx.player.position.clone(); v.set(x, y, z); return v; };
    window.__pumped = true;
  });
  await inject();

  /** Survive a stray reload (Vite watcher, HMR): wait for the game and re-inject the pump. */
  const ready = async () => {
    for (let i = 0; i < 250; i++) {
      if (await page.evaluate(() => !!window.__game?.ctx)) break;
      await sleep(80);
    }
    if (!(await page.evaluate(() => !!window.__pumped))) { await inject(); await sleep(400); }
  };

  const P = (fn, ...a) => page.evaluate(fn, ...a);
  const shot = async (name) => { await page.screenshot({ path: join(STAGE, `${name}.png`) }); taken++; console.log('  ✔', name); };
  /** One shot, retried once — a stray page reload mid-step is recoverable, the state lives in localStorage. */
  const step = async (name, fn) => {
    if (ONLY.size && !ONLY.has(name)) return;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { await ready(); await fn(); await shot(name); return; }
      catch (e) {
        if (attempt === 1) { console.log('  ↻', name, String(e).slice(0, 90)); await sleep(800); continue; }
        failed.push(name); console.log('  ✘', name, String(e).slice(0, 140));
      }
    }
  };
  const tab = (label) => P((l) => [...document.querySelectorAll('.inv-root .scr-tab')].find((b) => b.textContent.replace('*', '') === l)?.click(), label);
  const enterHub = async () => {
    await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await sleep(1400);
  };
  const closeUi = async () => { await P(() => { window.__game.ctx.inventory?.closeAll?.(); window.__game.ctx.housing?.closeMenus?.(); }); await sleep(350); };

  /* ══ 0. the title — character select · create ═════════════════
     Taken **before `enterHub()`**. Once in the ship there is no way back to the title (the pause menu's
     `타이틀로` is a reload), and these two screens live only on top of the title. */
  await step('char-select', async () => {
    await P(() => {
      const t = window.__game.getSystem('hud')?.title;
      if (!t) throw new Error('no title menu');
      t.create.close(); t.select.open();
    });
    await sleep(700);
  });

  await step('char-create', async () => {
    await P(() => {
      const t = window.__game.getSystem('hud')?.title;
      if (!t) throw new Error('no title menu');
      /* the create screen only opens on an empty slot — number 2 is used */
      t.select.close(); t.create.open(2);
    });
    await sleep(1400);   /* time for the 3D preview to draw its first frame */
  });

  await P(() => {
    const t = window.__game.getSystem('hud')?.title;
    if (t) { t.create.close(); t.select.close(); }
  });
  await sleep(300);

  /* ══ setup: credits · trust · items · facilities ════════════ */
  await enterHub();
  await P(() => {
    const ctx = window.__game.ctx;
    ctx.meta.addCredits(60000, 'shot');
    for (const c of ['helix', 'bastion', 'nomad', 'ceres']) ctx.meta.addRep(c, 1600, 'shot');
    ctx.progression.addXp(9000);
    /* fills the bag and the stash so there is something to look at */
    const give = (id, n = 1) => { for (let i = 0; i < n; i++) { const it = ctx.loot.createItem(id); if (it) ctx.inventory.tryAddItemAnywhere(it); } };
    ['wpn_ar_g4', 'wpn_sr_g3', 'wpn_sg_g2', 'wpn_smg_g3'].forEach((id) => give(id));
    ['ammo_medium', 'ammo_heavy', 'ammo_shell', 'ammo_light'].forEach((id) => give(id, 3));
    ['heal_syringe', 'heal_bandage', 'grenade_frag', 'gad_turret', 'gad_barricade', 'gad_defib'].forEach((id) => give(id, 2));
    /* plenty of materials for facility building · furniture crafting (stacks of 20 at a time × 5) */
    for (const id of ['mat_scrap', 'mat_alloy', 'mat_circuit', 'mat_cable', 'mat_bio_sample', 'mat_power_cell', 'mat_cloth']) {
      for (let i = 0; i < 5; i++) { const it = ctx.loot.createItem(id, 20); if (it) ctx.inventory.tryAddItemAnywhere(it); }
    }
    ['att_scope4', 'att_brake', 'att_grip_angled'].forEach((id) => give(id));
    ['imp_strength_2', 'imp_perception_3', 'imp_intelligence_1', 'imp_perk_quick_heal'].forEach((id) => give(id));
    ['imp_broken_dexterity_3', 'imp_broken_endurance_2'].forEach((id) => give(id));
    /* the grid only looks like something once a big bag is full */
    const bag = ctx.loot.createItem('bag_legendary');
    if (bag) { ctx.inventory.tryAddItemAnywhere(bag); try { ctx.inventory.equip(bag.uid, 'bag'); } catch {} }
    /* with the primary slots filled the launch readiness warning stays away and the pod screen is caught as it is */
    for (const [id, slot] of [['wpn_ar_g4', 'primary'], ['wpn_sr_g3', 'primary2']]) {
      const it = ctx.inventory.getAllItems().find((x) => x.defId === id);
      if (it) { try { ctx.inventory.equip(it.uid, slot); } catch {} }
    }
  });
  await sleep(600);

  /* ══ 1. ship UI ═══════════════════════════════════════════════════════ */
  await step('weapon-inventory', async () => {
    await closeUi();
    await P(() => window.__game.ctx.inventory.openScreen('inventory'));
    await sleep(700);
  });

  await step('char-sheet', async () => {
    await P(() => window.__game.ctx.inventory.openScreen('character'));
    await sleep(700);
  });

  /* The implant slots are not on the character tab but in the **equipment column of the inventory tab**
     (ImplantPanel). The shot is taken with the picker left open. */
  await step('implant-slots', async () => {
    await P(() => window.__game.ctx.inventory.openScreen('inventory'));
    await sleep(600);
    /* two are really fitted from the equip list (calling by uid directly fails for anything in the stash) */
    for (let i = 0; i < 2; i++) {
      await P(() => document.querySelector('.inv-impi-add')?.click());
      await sleep(350);
      await P(() => document.querySelector('.inv-impi-pop .inv-impi-opt')?.click());
      await sleep(350);
    }
    await P(() => document.querySelector('.inv-impi-add')?.click());
    await sleep(700);
  });

  await step('corp-screen', async () => {
    await P(() => window.__game.ctx.inventory.openScreen('corp'));
    await sleep(600);
    await P(() => document.querySelector('.corp-tab[data-corp="ceres"]')?.click());
    await sleep(600);
  });

  await step('ship-manage', async () => {
    await P(() => window.__game.ctx.inventory.openScreen('ship'));
    await sleep(700);
  });

  await step('facility-workshop', async () => {
    await closeUi();
    await P(() => window.__game.ctx.inventory.openBenchCraft('gun', 2));
    await sleep(800);
  });

  /* ══ 2. the ship in 3D ════════════════════════════════════════════════ */
  await step('ship-interior', async () => {
    await closeUi();
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      /* a few facilities built so the corridor has something to look at */
      const h = ctx.housing;
      h.state.generatorLevel = Math.max(h.state.generatorLevel ?? 1, 5);   // 2026-09-13: Lv.1–5 per purpose, maxed
      ['workshop', 'greenhouse', 'library', 'range'].forEach((p, i) => { try { h.setRoomPurpose(i, p); } catch {} });
      const p = ctx.player;
      p.setCameraOverride(null);
      p.spawnStanding(V(0, 0, 6), Math.PI);
    });
    await sleep(1500);
  });

  /* the facility is really built and then the UI inside it is shot (the setup step put in plenty of materials) */
  const buildRoom = async (room, purpose, furnId) => {
    await closeUi();
    return P(({ room, purpose, furnId }) => {
      const h = window.__game.ctx.housing;
      h.closeMenus?.();
      /* building requires a generator level per purpose (2026-09-13 — workshop 1 … mining 5) */
      h.state.generatorLevel = Math.max(h.state.generatorLevel ?? 1, 5);   // 2026-09-13: Lv.1–5 per purpose, maxed
      if (h.getRoom(room).purpose !== purpose && !h.setRoomPurpose(room, purpose)) {
        throw new Error(`setRoomPurpose(${purpose}) refused: ${h.purposeBlock(room, purpose) ?? '?'}`);
      }
      let placed = h.getPlaced(room).find((f) => f.defId === furnId);
      if (!placed) {
        if (!h.getStored().some((e) => e.defId === furnId && e.qty > 0) && !h.craftFurniture(furnId)) {
          throw new Error(`craftFurniture(${furnId}) refused: ` + JSON.stringify(h.canCraftFurniture(furnId).missing));
        }
        for (let y = 0; y < 8 && !placed; y++) for (let x = 0; x < 8 && !placed; x++) {
          if (h.canPlace(room, furnId, x, y, 0)) placed = h.place(room, furnId, x, y, 0);
        }
      }
      if (!placed) throw new Error(`no room to place ${furnId}`);
      return placed.uid;
    }, { room, purpose, furnId });
  };

  await step('ship-housing-mode', async () => {
    await sleep(4200);   /* after the setup step's item-gained tickers have all gone */
    await buildRoom(0, 'workshop', 'furn_bench_gun');
    /* `enterHousingMode` needs standing in that room — the shot uses the ship management screen, which has no gate */
    await P(() => {
      const h = window.__game.ctx.housing;
      if (!h.openShipManage(0)) throw new Error('openShipManage refused');
      h.selectFurniture('furn_bench_gear');
    });
    await sleep(3000);   /* until the management camera settles */
    await P(() => window.__game.ctx.housing.closeShipManage());
  });

  await step('library-shelf', async () => {
    const uid = await buildRoom(2, 'library', 'furn_bookshelf');
    await P((u) => {
      const ctx = window.__game.ctx;
      /* the panel only looks like something with books to shelve */
      for (const id of ['book_carry_manual_1', 'book_appraisal_notes_1', 'book_field_medicine_1', 'book_field_crafting_1']) {
        const it = ctx.loot.createItem(id);
        if (it) ctx.inventory.tryAddItemAnywhere(it);
      }
    }, uid);
    await sleep(3600);   /* opened after the item-gained tickers have gone */
    await P((u) => window.__game.ctx.housing.openBookshelfMenu(u), uid);
    await sleep(900);
  });

  await step('facility-greenhouse', async () => {
    const uid = await buildRoom(1, 'greenhouse', 'furn_grow_rack');
    await P((u) => {
      const ctx = window.__game.ctx;
      for (const id of ['seed_bloodroot', 'seed_ashleaf', 'seed_glowcap']) {
        const it = ctx.loot.createItem(id, 3);
        if (it) ctx.inventory.tryAddItemAnywhere(it);
      }
    }, uid);
    await sleep(3600);
    await P((u) => window.__game.ctx.housing.openGrowMenu(u), uid);
    await sleep(900);
  });

  await step('hub-terminal', async () => {
    await closeUi();
    await P(() => {
      const t = window.__game.ctx.interactables.all().find((i) => i.id === 'hub_terminal');
      if (!t) throw new Error('hub_terminal not registered');
      t.interact();
    });
    await sleep(1600);
  });

  /* picking a planet warps the ship there — that cutscene is worth a shot of its own */
  await step('hub-warp', async () => {
    await closeUi();
    await P(() => window.__game.ctx.hub?.setPlanet?.('tundra'));
    await sleep(2200);
  });

  await step('hub-pod', async () => {
    await closeUi();
    /* the launch pod can only be boarded once the warp is over */
    for (let i = 0; i < 60 && (await P(() => !!window.__game.ctx.hub?.travelling)); i++) await sleep(300);
    await sleep(800);
    await P(() => {
      const pod = window.__game.ctx.interactables.all().find((i) => i.id.startsWith('hub_pod_'));
      if (!pod) throw new Error('no launch pod registered');
      const V = window.__V;
      /* standing in front of the pod is what gets the READY panel and the pod in one frame */
      window.__game.ctx.player.setCameraOverride(
        V(pod.position.x + 3.2, pod.position.y + 2.2, pod.position.z + 4.5),
        V(pod.position.x, pod.position.y + 1.1, pod.position.z), true,
      );
      pod.interact();
    });
    await sleep(1600);
  });

  /* ══ 3. the raid ═════════════════════════════════════════════════════ */
  /**
   * Start a raid straight from `game:newMission` — never through `hub.setPlanet`, whose warp cutscene
   * parents the player to the ship and leaves a camera override behind (flat-fog screenshots).
   */
  const startRaid = async (planet, seed) => {
    await closeUi();
    await P(() => { window.__game.ctx.player.setCameraOverride(null); });
    await P((s, pl) => window.__game.ctx.bus.emit('game:newMission', { seed: s, planet: pl }), seed, planet);
    await sleep(3500);
    /* the world must be up and the extraction pads placed, or the framing lands nowhere */
    const fine = await P(() => {
      const ctx = window.__game.ctx, p = ctx.player.position;
      const pads = ctx.interactables.all().filter((i) => i.id.startsWith('extract_'));
      const fin = (v) => v && [v.x, v.y, v.z].every(Number.isFinite);
      return ctx.phase === 'playing' && !!ctx.world && fin(p) && pads.length > 0 && pads.every((i) => fin(i.position));
    });
    if (!fine) throw new Error('raid did not settle (phase / world / pads)');
    await P(() => window.__game.ctx.enemies.setThreatLevel(1));
    await sleep(2500);
  };

  /* a distant view per planet — each biome's sky / terrain tone */
  for (const [pl, seed] of [['amber', 20260908], ['tundra', 771], ['mossy', 4242], ['ashen', 9001], ['crimson', 313]]) {
    await step(`planet-${pl}`, async () => {
      await startRaid(pl, seed);
      await P(() => {
        const ctx = window.__game.ctx, V = window.__V;
        const p = ctx.player.position.clone();
        const cx = p.x - 20, cz = p.z + 20;
        ctx.player.setCameraOverride(
          V(cx, ctx.world.getHeightAt(cx, cz) + 11, cz),
          V(p.x + 14, p.y + 3, p.z - 14), true,
        );
      });
      await sleep(1200);
    });
  }

  await step('hero-raid', async () => {
    await startRaid('ashen', 9001);
    await P(() => window.__game.ctx.enemies.setThreatLevel(1));
    await sleep(4000);
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      /* Moves the player to the centre of mass of the nearest pack and turns them toward it.
         A freshly spawned body can still have NaN coordinates, so only finite ones are counted. */
      const fin = (v) => v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
      const p0 = ctx.player.position;
      const es = ctx.enemies.getEnemies()
        .filter((e) => !e.isDead && fin(e.position))
        .sort((a, b) => a.position.distanceTo(p0) - b.position.distanceTo(p0));
      if (!es.length) throw new Error('no enemies alive');
      const n = Math.min(10, es.length);
      let cx = 0, cy = 0, cz = 0;
      es.slice(0, n).forEach((e) => { cx += e.position.x; cy += e.position.y; cz += e.position.z; });
      cx /= n; cy /= n; cz /= n;
      const fx = cx + 12, fz = cz + 12;
      const fy = ctx.world.getHeightAt(fx, fz);
      if (![cx, cy, cz, fy].every(Number.isFinite)) throw new Error('non-finite focus');
      const yaw = Math.atan2(cx - fx, cz - fz) + Math.PI;
      ctx.player.setCameraOverride(null);
      ctx.player.spawnStanding(V(fx, fy, fz), yaw);
    });
    await sleep(1600);
    const okPos = await P(() => { const p = window.__game.ctx.player.position; return [p.x, p.y, p.z].every(Number.isFinite); });
    if (!okPos) throw new Error('player position went non-finite');
  });

  await step('enemy-lineup', async () => {
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const p = ctx.player.position;
      const es = ctx.enemies.getEnemies().filter((e) => !e.isDead)
        .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p));
      if (!es.length) throw new Error('no enemies alive');
      const n = Math.min(8, es.length);
      const c = V(0, 0, 0);
      es.slice(0, n).forEach((e) => c.add(e.position));
      c.multiplyScalar(1 / n);
      const dx = c.x - p.x, dz = c.z - p.z, d = Math.hypot(dx, dz) || 1;
      const cam = V(c.x - (dx / d) * 13, c.y + 4.2, c.z - (dz / d) * 13);
      ctx.player.setCameraOverride(cam, V(c.x, c.y + 1.1, c.z), true);
    });
    await sleep(900);
  });

  /**
   * A tactical implant is swapped **only in the ship** (`setEquipped` refuses mid-raid), so each of these goes
   * hub → equip → fresh raid → walk into a swarm → Q.
   */
  const implantShot = async (id, planet, seed) => {
    await enterHub();
    const equipped = await P((i) => window.__game.ctx.implants.setEquipped(i), id);
    if (!equipped) throw new Error(`setEquipped(${id}) refused`);
    await startRaid(planet, seed);
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const fin = (v) => v && [v.x, v.y, v.z].every(Number.isFinite);
      const p0 = ctx.player.position;
      const es = ctx.enemies.getEnemies().filter((e) => !e.isDead && fin(e.position))
        .sort((a, b) => a.position.distanceTo(p0) - b.position.distanceTo(p0));
      if (!es.length) throw new Error('no enemies alive');
      const t = es[0].position;
      const fx = t.x + 14, fz = t.z + 14, fy = ctx.world.getHeightAt(fx, fz);
      if (!Number.isFinite(fy)) throw new Error('non-finite ground');
      ctx.player.setCameraOverride(null);
      ctx.player.spawnStanding(V(fx, fy, fz), Math.atan2(t.x - fx, t.z - fz) + Math.PI);
    });
    await sleep(700);
    await P(() => window.__game.ctx.implants.activate());
  };

  await step('tactical-scan', async () => {
    await implantShot('scan', 'mossy', 4242);
    await sleep(1000);
  });

  await step('tactical-barrier', async () => {
    await implantShot('barrier', 'ashen', 9001);
    await sleep(1400);
  });

  /* A ship call: top-view aim → the orbital barrage lands. `debugCall` is the same entry point the console
     cheat uses. */
  await step('stratagem-topview', async () => {
    await implantShot('scan', 'ashen', 9001);   /* it only needs a screen covered in enemies; any implant will do */
    await sleep(600);
    await P(() => {
      const sys = window.__game.getSystem('stratagems');
      if (!sys) throw new Error('no stratagem system');
      sys.arm('orbital_laser');
      sys.enterTopview(window.__game.ctx.player);
    });
    await sleep(1200);
  });

  await step('stratagem-laser', async () => {
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const sys = window.__game.getSystem('stratagems');
      sys.disarm?.();
      ctx.player.setCameraOverride(null);
      const fin = (v) => v && [v.x, v.y, v.z].every(Number.isFinite);
      const p0 = ctx.player.position;
      const es = ctx.enemies.getEnemies().filter((e) => !e.isDead && fin(e.position))
        .sort((a, b) => a.position.distanceTo(p0) - b.position.distanceTo(p0));
      if (!es.length) throw new Error('no enemies alive');
      const t = es[0].position;
      sys.debugCall('orbital_laser', V(t.x, ctx.world.getHeightAt(t.x, t.z), t.z));
    });
    /* the 5 s call delay + until the beam settles */
    await sleep(6500);
  });

  /* ── extraction: console → ship arrives (2026-09-10) ───────────
     The old single `extraction` shot (a defence cut with a barrier up) was split into these two. The
     countdown is 60 s, too long to wait out in real time, so `ctx.timeScale` winds it on — only the
     simulation speeds up, the rendering does not, so the screenshot quality is the same. */
  const goToPad = async (back) => P((b) => {
    const ctx = window.__game.ctx, V = window.__V;
    const pad = ctx.interactables.all().find((i) => i.id.startsWith('extract_'));
    if (!pad) throw new Error('no extraction console');
    const px = pad.position.x + b, pz = pad.position.z + b;
    ctx.player.setCameraOverride(null);
    ctx.player.spawnStanding(V(px, ctx.world.getHeightAt(px, pz), pz), Math.PI * 0.75);
    return true;
  }, back);

  await step('extraction-console', async () => {
    await startRaid('amber', 20260908);
    await goToPad(5);
    await sleep(400);
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const pad = ctx.interactables.all().find((i) => i.id.startsWith('extract_'));
      pad.interact();
      /* taken over the shoulder so the `신호소` sits in the middle of the frame */
      const cx = pad.position.x + 7, cz = pad.position.z + 7;
      ctx.player.setCameraOverride(
        V(cx, ctx.world.getHeightAt(cx, cz) + 3.2, cz),
        V(pad.position.x, pad.position.y + 1.4, pad.position.z), true,
      );
    });
    await sleep(2600);
  });

  await step('extraction-ship', async () => {
    /* Self-contained — a retry of an earlier step throws the state away.
       The 60 s countdown cannot be waited out in real time, so `ctx.timeScale` winds it on, but **it stops
       the moment the descent starts**: winding on to the landing buries the ship in dark terrain and the
       silhouette stops reading, and winding further lifts it off, ends the mission and takes the pad away.
       Mid-descent is the moment that reads best as 「the ship has arrived」. */
    await startRaid('amber', 20260908);
    await goToPad(5);
    await sleep(400);
    await P(() => {
      const ctx = window.__game.ctx;
      ctx.enemies.setThreatLevel(0);
      ctx.interactables.all().find((i) => i.id.startsWith('extract_')).interact();
      ctx.timeScale = 6;
    });
    let seen = false;
    for (let i = 0; i < 60; i++) {
      /* the extraction wave really kills people while it winds on at 6× — a heal happens on every poll */
      seen = await P(() => {
        window.__game.ctx.player.heal(999);
        const sh = window.__game.getSystem('extraction')?.ship;
        return sh?.state === 'descend' || sh?.state === 'landed';
      });
      if (seen) break;
      await sleep(220);
    }
    await P(() => { window.__game.ctx.timeScale = 1; });
    if (!seen) throw new Error('dropship never approached');
    await sleep(500);
    /* the ship against the sky, looked up at from beside the pad — aimed at the measured bounding box centre */
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const sh = window.__game.getSystem('extraction').ship;
      sh.root.updateMatrixWorld(true);
      const b = { x0: 1e9, y0: 1e9, z0: 1e9, x1: -1e9, y1: -1e9, z1: -1e9 };
      sh.root.traverse((o) => {
        if (!o.isMesh || !o.visible || !o.geometry) return;
        o.geometry.computeBoundingBox?.();
        const g = o.geometry.boundingBox; if (!g) return;
        for (const cx of [g.min.x, g.max.x]) for (const cy of [g.min.y, g.max.y]) for (const cz of [g.min.z, g.max.z]) {
          const v = V(cx, cy, cz).applyMatrix4(o.matrixWorld);
          b.x0 = Math.min(b.x0, v.x); b.y0 = Math.min(b.y0, v.y); b.z0 = Math.min(b.z0, v.z);
          b.x1 = Math.max(b.x1, v.x); b.y1 = Math.max(b.y1, v.y); b.z1 = Math.max(b.z1, v.z);
        }
      });
      const mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2, mz = (b.z0 + b.z1) / 2;
      if (![mx, my, mz].every(Number.isFinite)) throw new Error('no ship geometry');
      const cx = mx + 20, cz = mz + 20;
      ctx.player.setCameraOverride(V(cx, ctx.world.getHeightAt(cx, cz) + 2.2, cz), V(mx, my, mz), true);
    });
    await sleep(1200);
  });

  /* ── raid HUD · the armor shield · danger indicators ─────── */
  /** Builds a raid screen with the shield gauge and the weapon panel both filled.
   *  The gear has to go on **in the ship** — equipping mid-raid can leave a weapon slot empty. */
  const geared = async (planet, seed) => {
    await enterHub();
    await P(() => {
      const ctx = window.__game.ctx;
      const give = (id) => { const it = ctx.loot.createItem(id); if (it) ctx.inventory.tryAddItemAnywhere(it); return it; };
      const armor = give('armor_4');
      if (armor) { try { ctx.inventory.equip(armor.uid, 'armor'); } catch { /* it may already be worn */ } }
      for (const [id, slot] of [['wpn_ar_g4', 'primary'], ['wpn_sr_g3', 'primary2']]) {
        const it = ctx.inventory.getAllItems().find((x) => x.defId === id) ?? give(id);
        if (it) { try { ctx.inventory.equip(it.uid, slot); } catch { /* already equipped */ } }
      }
      for (let i = 0; i < 3; i++) { give('ammo_medium'); give('ammo_heavy'); }
    });
    await sleep(700);
    await startRaid(planet, seed);
  };

  await step('hud-raid', async () => {
    await geared('amber', 20260908);
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const fin = (v) => v && [v.x, v.y, v.z].every(Number.isFinite);
      const p0 = ctx.player.position;
      const es = ctx.enemies.getEnemies().filter((e) => !e.isDead && fin(e.position))
        .sort((a, b) => a.position.distanceTo(p0) - b.position.distanceTo(p0));
      if (!es.length) throw new Error('no enemies alive');
      const t = es[0].position;
      const fx = t.x + 13, fz = t.z + 13, fy = ctx.world.getHeightAt(fx, fz);
      if (!Number.isFinite(fy)) throw new Error('non-finite ground');
      ctx.player.setCameraOverride(null);
      ctx.player.spawnStanding(V(fx, fy, fz), Math.atan2(t.x - fx, t.z - fz) + Math.PI);
    });
    await sleep(600);
    /* spawnStanding fills health up, so the damage comes **after the framing**.
       An armor IV shield is 80, so only 30 may come off for the shield gauge to read as half left — take
       more than 80 off and the shield bar is empty and 「this game has a shield」 stops showing. */
    await P(() => window.__game.ctx.player.applyDamage?.(30, 'shot'));
    await sleep(700);
  });

  await step('armor-shield', async () => {
    /* the same state a little closer — used by the shield section of 06-weapons */
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const fin = (v) => v && [v.x, v.y, v.z].every(Number.isFinite);
      const p0 = ctx.player.position;
      const es = ctx.enemies.getEnemies().filter((e) => !e.isDead && fin(e.position))
        .sort((a, b) => a.position.distanceTo(p0) - b.position.distanceTo(p0));
      if (!es.length) throw new Error('no enemies alive');
      const t = es[0].position;
      const fx = t.x + 9, fz = t.z + 9, fy = ctx.world.getHeightAt(fx, fz);
      if (!Number.isFinite(fy)) throw new Error('non-finite ground');
      ctx.player.setCameraOverride(null);
      ctx.player.spawnStanding(V(fx, fy, fz), Math.atan2(t.x - fx, t.z - fz) + Math.PI);
    });
    await sleep(500);
    await P(() => window.__game.ctx.player.applyDamage?.(35, 'shot'));
    await sleep(700);
  });

  await step('hud-danger', async () => {
    /* a ship call's falling object is the surest indicator source — the marker is up while it is announced */
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const sys = window.__game.getSystem('stratagems');
      const p = ctx.player.position;
      const tx = p.x + 9, tz = p.z + 9;
      sys.debugCall('supply_drop', V(tx, ctx.world.getHeightAt(tx, tz), tz));
    });
    await sleep(1400);
  });

  /* ── the hangar is not shot automatically ───────────────────
     The shared ship's hangar (`Hangar`) is only built **with a lobby** — that needs a relay + two clients,
     so this script (a single page) cannot make one. `hangar.png` · `hangar-visit.png` are taken by hand or
     left as placeholders (the check that starts a relay too is `scripts/smoke-hangar.mjs`). */

  /* ── squad communication: the two wheels ────────────────────────
     Calling a widget's `setOpen` directly **closes it again on the next frame** — both wheels re-read 「is
     the key held」 every frame. So a real input goes in and the shot is taken **with the key held**. */
  await step('comms-wheel', async () => {
    await startRaid('amber', 20260908);
    /* the spawn spot is often blocked by props — one step over to an open spot */
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const spot = ctx.world.scatterPoints(ctx.player.position, 45, 1, 8)[0];
      if (!spot) return;
      ctx.player.setCameraOverride(null);
      ctx.player.spawnStanding(V(spot.x, ctx.world.getHeightAt(spot.x, spot.z), spot.z), Math.PI * 0.4);
    });
    await sleep(600);
    await page.keyboard.down('KeyH');
    await sleep(600);
    await page.mouse.move(1060, 470);          /* pointing at one cell turns hover on */
    await sleep(500);
    const open = await P(() => !!window.__game.getSystem('hud')?.isCommsWheelOpen);
    if (!open) { await page.keyboard.up('KeyH'); throw new Error('comms wheel did not open'); }
  });
  /* a run that skipped the step above (`ONLY`) never pressed it — the release passes quietly */
  try { await page.keyboard.up('KeyH'); } catch { /* not pressed */ }
  await sleep(200);

  await step('ping-wheel', async () => {
    await page.mouse.move(960, 540);
    await page.mouse.down({ button: 'middle' });
    await sleep(500);
    await page.mouse.move(1080, 545);          /* pushed right for 「저쪽으로 가자」 */
    await sleep(400);
    const open = await P(() => !!window.__game.getSystem('hud')?.isPingWheelOpen);
    if (!open) { await page.mouse.up({ button: 'middle' }); throw new Error('ping wheel did not open'); }
  });
  try { await page.mouse.up({ button: 'middle' }); } catch { /* not pressed */ }
  await sleep(200);

  /* ── abandoned structures ────────────────────────────────────────── */
  /** Rolls seeds until one really places structures — a map can come out with none. */
  const findStructure = async (planet, seeds, kind) => {
    for (const seed of seeds) {
      await startRaid(planet, seed);
      const hit = await P((k) => {
        const list = window.__game.ctx.world.getStructures().filter((s) => !k || s.kind === k);
        return list.length ? list[0].id : null;
      }, kind);
      if (hit) return hit;
    }
    throw new Error('no structure (' + (kind ?? 'any') + ') in ' + seeds.length + ' seed(s)');
  };

  await step('structure-outpost', async () => {
    const id = await findStructure('amber', [20260908, 771, 4242, 9001, 313], 'outpost');
    await P((sid) => {
      const ctx = window.__game.ctx, V = window.__V;
      const st = ctx.world.getStructures().find((s) => s.id === sid);
      const d = st.radius + 13;
      const cx = st.position.x + d, cz = st.position.z + d;
      ctx.player.setCameraOverride(
        V(cx, ctx.world.getHeightAt(cx, cz) + 9, cz),
        V(st.position.x, st.position.y + 2, st.position.z), true,
      );
    }, id);
    await sleep(1200);
  });

  await step('structure-basement', async () => {
    const id = await findStructure('amber', [20260908, 771, 4242, 9001, 313], null);
    await P((sid) => {
      const ctx = window.__game.ctx, V = window.__V;
      const st = ctx.world.getStructures().find((s) => s.id === sid);
      const door = st.basementDoor ?? st.position;
      const cx = door.x + 5, cz = door.z + 5;
      ctx.player.setCameraOverride(V(cx, door.y + 4.6, cz), V(door.x, door.y, door.z), true);
    }, id);
    await sleep(1000);
  });

  await step('rogue-drop', async () => {
    await P(() => {
      const ctx = window.__game.ctx;
      const st = ctx.world.getStructures()[0];
      if (!st) throw new Error('no structure to draw a drop to');
      ctx.player.setCameraOverride(null);
      ctx.enemies.callRogueDrop?.(st.position, st.id);
    });
    await sleep(2200);
  });

  /* ── rails · the tram ──────────────────────────────────────────────── */
  const findRail = async (planet, seeds) => {
    for (const seed of seeds) {
      await startRaid(planet, seed);
      const has = await P(() => window.__game.ctx.world.getTrams().length > 0);
      if (has) return true;
    }
    throw new Error('no rail line in any seed');
  };

  await step('rail-line', async () => {
    await findRail('tundra', [771, 20260908, 4242, 9001, 313]);
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const t = ctx.world.getTrams()[0];
      const cx = t.position.x + 26, cz = t.position.z + 26;
      ctx.player.setCameraOverride(
        V(cx, ctx.world.getHeightAt(cx, cz) + 16, cz),
        V(t.position.x, t.position.y, t.position.z), true,
      );
    });
    await sleep(1200);
  });

  await step('rail-tram', async () => {
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const t = ctx.world.getTrams()[0];
      const cx = t.position.x + 11, cz = t.position.z + 11;
      ctx.player.setCameraOverride(
        V(cx, t.position.y + 5.5, cz), V(t.position.x, t.position.y + 1, t.position.z), true,
      );
    });
    await sleep(1000);
  });

  /* ── the four environment hazards ─────────────────────────────────────
     The kind is a function of the seed, so seeds are rolled until the wanted hazard comes up. Its progress
     is a function of `ctx.missionTime`, so pushing that value in saves waiting six minutes. */
  const hazardShot = async (kind, planet, seeds, at) => {
    let ok = false;
    for (const seed of seeds) {
      await startRaid(planet, seed);
      ok = await P((k) => window.__game.ctx.world.hazard?.kind === k, kind);
      if (ok) break;
    }
    if (!ok) throw new Error('hazard ' + kind + ' did not roll on ' + planet);
    await P((frac) => {
      const ctx = window.__game.ctx, hz = ctx.world.hazard;
      /* wound past the start time only far enough for the hazard to cover the screen (1 = the whole map) */
      ctx.missionTime = hz.startsAt + 420 * frac;
    }, at);
    await sleep(1800);
    /* Looked at from a high spot so the front (or the wall of snow) comes into frame — the default spawn
       camera is blocked by a prop right in front of it and the hazard does not show. */
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const z = ctx.world.hazard.getZones()[0];
      const p = ctx.player.position;
      let tx, tz;
      if (!z) { tx = p.x + 60; tz = p.z + 60; }
      else if (z.shape === 'front') {
        /* for a front, the side **opposite** the normal `dir` is the one already swallowed — the front
           curtain stands there */
        tx = p.x - z.dirX * 80; tz = p.z - z.dirZ * 80;
      } else { /* a circle: it looks at the nearest point on the boundary */
        const dx = p.x - z.center.x, dz = p.z - z.center.z, d = Math.hypot(dx, dz) || 1;
        tx = z.center.x + (dx / d) * z.radius; tz = z.center.z + (dz / d) * z.radius;
      }
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz) || 1;
      /* the camera sits a little back from the player toward that side and looks level */
      const cx = p.x - (dx / d) * 9, cz = p.z - (dz / d) * 9;
      const cy = ctx.world.getHeightAt(cx, cz) + 13;
      const ty = ctx.world.getHeightAt(p.x, p.z) + 9;
      if (![cx, cy, cz, tx, ty, tz].every(Number.isFinite)) return;
      ctx.player.setCameraOverride(V(cx, cy, cz), V(p.x + (dx / d) * 40, ty, p.z + (dz / d) * 40), true);
    });
    await sleep(1000);
  };

  const HZ_SEEDS = [20260908, 771, 4242, 9001, 313, 5150, 8080, 1234, 60607];
  await step('hazard-sandstorm', async () => { await hazardShot('sandstorm', 'amber', HZ_SEEDS, 0.45); });
  await step('hazard-blizzard', async () => { await hazardShot('blizzard', 'tundra', HZ_SEEDS, 0.45); });
  await step('hazard-stormeye', async () => { await hazardShot('storm_eye', 'tundra', HZ_SEEDS, 0.78); });
  await step('hazard-spores', async () => { await hazardShot('spores', 'mossy', HZ_SEEDS, 0.5); });

  /* ── fog of war · the map ───────────────────────────────────────── */
  const openMap = (on) => P((o) => {
    const m = window.__game.getSystem('hud')?.map;
    if (!m) throw new Error('no map screen');
    if (o && !m.isOpen) m.open(); else if (!o && m.isOpen) m.close();
  }, on);

  await step('fog-map-early', async () => {
    await startRaid('mossy', 4242);
    await P(() => { window.__game.ctx.player.setCameraOverride(null); });
    await openMap(true);
    await sleep(1100);
  });

  await step('fog-map-late', async () => {
    /* the shape after four squadmates roamed apart — several scattered spots are painted directly */
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const fog = ctx.world.fog, p = ctx.player.position;
      /* `reveal` takes (x, z, radius) — not a Vector3 */
      const walk = (x0, z0, x1, z1) => {           /* painted as if walked between the two points */
        for (let t = 0; t <= 1; t += 0.06) fog.reveal(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, 55);
      };
      const legs = [[0, 0, 150, 70], [0, 0, -130, 120], [0, 0, 95, -160], [0, 0, -70, -100]];
      for (const [ax, az, bx, bz] of legs) walk(p.x + ax, p.z + az, p.x + bx, p.z + bz);
      /* the shape of four squadmates scattered further out at the ends */
      for (const [dx, dz] of [[210, 40], [-190, 170], [140, -230], [-110, -160]]) fog.reveal(p.x + dx, p.z + dz, 55);
    });
    await sleep(1000);
  });

  /* the map is left closed — a step added after this must not be covered by it */
  await openMap(false);

} finally {
  await browser.close();
  /* staging → repo, once the browser is gone: nothing can trigger a reload any more */
  for (const f of readdirSync(STAGE)) copyFileSync(join(STAGE, f), join(OUT, f));
  rmSync(STAGE, { recursive: true, force: true });
  console.log(`\n  ${taken} shot(s) → ${OUT}` + (failed.length ? `  ·  skipped: ${failed.join(', ')}` : ''));
}
