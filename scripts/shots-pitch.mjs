// Screenshot helper for the pitch wiki (docs/pitch/ — one HTML file per page under pages/).
// Drives the running dev build with puppeteer-core and writes PNGs straight into docs/pitch/assets/,
// where the wiki pages pick them up automatically (each probes its `data-src` and swaps the placeholder).
// No assertions and no exit code — every shot is independent, a failure only skips that one.
//
// Usage: npm run dev, then:  node scripts/shots-pitch.mjs [http://localhost:5273/] [name ...]
//        (extra args filter which shots run, e.g. `node scripts/shots-pitch.mjs char-sheet corp-screen`)
import puppeteer from 'puppeteer-core';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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
  await page.evaluateOnNewDocument(() => {
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

  /* ══ 준비: 크레딧 · 신뢰도 · 아이템 · 시설 ═══════════════════════════════ */
  await enterHub();
  await P(() => {
    const ctx = window.__game.ctx;
    ctx.meta.addCredits(60000, 'shot');
    for (const c of ['helix', 'bastion', 'nomad', 'ceres']) ctx.meta.addRep(c, 1600, 'shot');
    ctx.progression.addXp(9000);
    /* 가방과 창고를 볼거리 있게 채운다 */
    const give = (id, n = 1) => { for (let i = 0; i < n; i++) { const it = ctx.loot.createItem(id); if (it) ctx.inventory.tryAddItemAnywhere(it); } };
    ['wpn_ar_g4', 'wpn_sr_g3', 'wpn_sg_g2', 'wpn_hg_g3'].forEach((id) => give(id));
    ['ammo_medium', 'ammo_heavy', 'ammo_shell', 'ammo_light'].forEach((id) => give(id, 3));
    ['heal_syringe', 'heal_bandage', 'grenade_frag', 'gad_turret', 'gad_barricade', 'gad_defib'].forEach((id) => give(id, 2));
    /* 시설 증축 · 가구 제작에 쓸 재료는 넉넉히 (한 번에 20개짜리 묶음 × 5) */
    for (const id of ['mat_scrap', 'mat_alloy', 'mat_circuit', 'mat_cable', 'mat_bio_sample', 'mat_power_cell', 'mat_cloth']) {
      for (let i = 0; i < 5; i++) { const it = ctx.loot.createItem(id, 20); if (it) ctx.inventory.tryAddItemAnywhere(it); }
    }
    ['att_scope4', 'att_brake', 'att_grip_angled'].forEach((id) => give(id));
    ['imp_strength_2', 'imp_perception_3', 'imp_intelligence_1', 'imp_perk_quick_heal'].forEach((id) => give(id));
    ['imp_broken_dexterity_3', 'imp_broken_endurance_2'].forEach((id) => give(id));
    /* 큰 가방을 채워야 격자가 볼거리가 있다 */
    const bag = ctx.loot.createItem('bag_legendary');
    if (bag) { ctx.inventory.tryAddItemAnywhere(bag); try { ctx.inventory.equip(bag.uid, 'bag'); } catch {} }
    /* 주무기를 채워야 출격 준비 확인 창이 뜨지 않고 포드 화면이 그대로 잡힌다 */
    for (const [id, slot] of [['wpn_ar_g4', 'primary'], ['wpn_sr_g3', 'primary2']]) {
      const it = ctx.inventory.getAllItems().find((x) => x.defId === id);
      if (it) { try { ctx.inventory.equip(it.uid, slot); } catch {} }
    }
  });
  await sleep(600);

  /* ══ 1. 함선 UI ═════════════════════════════════════════════════════════ */
  await step('weapon-inventory', async () => {
    await closeUi();
    await P(() => window.__game.ctx.inventory.openScreen('inventory'));
    await sleep(700);
  });

  await step('char-sheet', async () => {
    await P(() => window.__game.ctx.inventory.openScreen('character'));
    await sleep(700);
  });

  /* 임플란트 장착칸은 캐릭터 탭이 아니라 **인벤토리 탭의 장비 열**(ImplantPanel)에 있다. 피커를 열어 둔 채로 찍는다. */
  await step('implant-slots', async () => {
    await P(() => window.__game.ctx.inventory.openScreen('inventory'));
    await sleep(600);
    /* 장착 목록에서 두 개를 실제로 끼운다 (uid 로 직접 부르면 창고에 있는 것은 실패한다) */
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

  /* ══ 2. 함선 3D ═════════════════════════════════════════════════════════ */
  await step('ship-interior', async () => {
    await closeUi();
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      /* 시설을 몇 개 지어 복도가 볼거리 있게 */
      const h = ctx.housing;
      for (let i = 0; i < 3 && h.getFacility('generator').level < 1; i++) h.upgrade('generator');
      ['workshop', 'greenhouse', 'library', 'range'].forEach((p, i) => { try { h.setRoomPurpose(i, p); } catch {} });
      const p = ctx.player;
      p.setCameraOverride(null);
      p.spawnStanding(V(0, 0, 6), Math.PI);
    });
    await sleep(1500);
  });

  /* 시설을 실제로 지어 두고 그 안의 UI 를 찍는다 (재료는 준비 단계에서 넉넉히 넣었다) */
  const buildRoom = async (room, purpose, furnId) => {
    await closeUi();
    return P(({ room, purpose, furnId }) => {
      const h = window.__game.ctx.housing;
      h.closeMenus?.();
      /* 증축은 발전기 Lv.1 이상을 요구한다 */
      for (let i = 0; i < 3 && h.getFacility('generator').level < 1; i++) h.upgrade('generator');
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
    await sleep(4200);   /* 준비 단계의 획득 토스트가 다 사라진 뒤 */
    await buildRoom(0, 'workshop', 'furn_bench_gun');
    /* `enterHousingMode` 는 그 방에 서 있어야 한다 — 스크린샷은 게이트가 없는 함선 관리 화면을 쓴다 */
    await P(() => {
      const h = window.__game.ctx.housing;
      if (!h.openShipManage(0)) throw new Error('openShipManage refused');
      h.selectFurniture('furn_bench_gear');
    });
    await sleep(3000);   /* 관리 카메라가 자리를 잡을 때까지 */
    await P(() => window.__game.ctx.housing.closeShipManage());
  });

  await step('library-shelf', async () => {
    const uid = await buildRoom(2, 'library', 'furn_bookshelf');
    await P((u) => {
      const ctx = window.__game.ctx;
      /* 꽂을 책이 있어야 패널이 볼거리가 있다 */
      for (const id of ['book_carry', 'book_appraisal', 'book_medicine', 'book_crafting']) {
        const it = ctx.loot.createItem(id);
        if (it) ctx.inventory.tryAddItemAnywhere(it);
      }
    }, uid);
    await sleep(3600);   /* 획득 토스트가 사라진 뒤에 연다 */
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

  /* 행성을 고르면 함선이 그리로 워프한다 — 그 컷씬 자체가 한 장 값을 한다 */
  await step('hub-warp', async () => {
    await closeUi();
    await P(() => window.__game.ctx.hub?.setPlanet?.('tundra'));
    await sleep(2200);
  });

  await step('hub-pod', async () => {
    await closeUi();
    /* 워프가 끝나야 발사 포드에 탈 수 있다 */
    for (let i = 0; i < 60 && (await P(() => !!window.__game.ctx.hub?.travelling)); i++) await sleep(300);
    await sleep(800);
    await P(() => {
      const pod = window.__game.ctx.interactables.all().find((i) => i.id.startsWith('hub_pod_'));
      if (!pod) throw new Error('no launch pod registered');
      const V = window.__V;
      /* 포드 앞에 서서 잡아야 준비 패널과 포드가 같이 잡힌다 */
      window.__game.ctx.player.setCameraOverride(
        V(pod.position.x + 3.2, pod.position.y + 2.2, pod.position.z + 4.5),
        V(pod.position.x, pod.position.y + 1.1, pod.position.z), true,
      );
      pod.interact();
    });
    await sleep(1600);
  });

  /* ══ 3. 레이드 ══════════════════════════════════════════════════════════ */
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

  /* 행성별 원경 — 각 바이옴의 하늘 / 지형 톤 */
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
      /* 가장 가까운 무리의 무게중심으로 플레이어를 옮기고 그쪽을 보게 한다.
         갓 스폰된 개체는 좌표가 아직 NaN 일 수 있으므로 유한한 것만 센다. */
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
   * 전술 임플란트는 **함선에서만** 교체된다 (`setEquipped` refuses mid-raid), so each of these goes
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

  /* 함선 호출: 상단 시점 조준 → 궤도 폭격 착탄. `debugCall` 은 콘솔 치트가 쓰는 것과 같은 진입점이다. */
  await step('stratagem-topview', async () => {
    await implantShot('scan', 'ashen', 9001);   /* 적이 깔린 화면이 필요할 뿐, 임플란트는 무엇이든 좋다 */
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
    /* 호출 지연 5초 + 빔이 자리를 잡을 때까지 */
    await sleep(6500);
  });

  await step('extraction', async () => {
    await P(() => {
      const ctx = window.__game.ctx;
      const pad = ctx.interactables.all().find((i) => i.id.startsWith('extract_'));
      if (!pad) throw new Error('no extraction console');
      const V = window.__V;
      const px = pad.position.x + 5, pz = pad.position.z + 5;
      ctx.player.setCameraOverride(null);
      ctx.player.spawnStanding(V(px, ctx.world.getHeightAt(px, pz), pz), Math.PI * 0.75);
      pad.interact();
    });
    await sleep(2600);
  });

} finally {
  await browser.close();
  /* staging → repo, once the browser is gone: nothing can trigger a reload any more */
  for (const f of readdirSync(STAGE)) copyFileSync(join(STAGE, f), join(OUT, f));
  rmSync(STAGE, { recursive: true, force: true });
  console.log(`\n  ${taken} shot(s) → ${OUT}` + (failed.length ? `  ·  skipped: ${failed.join(', ')}` : ''));
}
