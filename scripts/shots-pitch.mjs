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
  await quietViteHmr(page);   // 2026-09-11 (C-71): 촬영 도중 남의 저장으로 페이지가 새로고침되지 않게
  await page.evaluateOnNewDocument(() => {
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
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

  /* ══ 0. 타이틀 — 캐릭터 선택 · 생성 ═════════════════════════════════════
     **`enterHub()` 보다 먼저** 찍는다. 함선에 들어간 뒤에는 타이틀로 돌아갈 길이
     없고(일시정지 메뉴의 `타이틀로` 는 새로고침이다), 이 두 화면은 타이틀 위에서만 산다. */
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
      /* 비어 있는 슬롯이라야 생성창이 열린다 — 2번을 쓴다 */
      t.select.close(); t.create.open(2);
    });
    await sleep(1400);   /* 3D 프리뷰가 첫 프레임을 그릴 시간 */
  });

  await P(() => {
    const t = window.__game.getSystem('hud')?.title;
    if (t) { t.create.close(); t.select.close(); }
  });
  await sleep(300);

  /* ══ 준비: 크레딧 · 신뢰도 · 아이템 · 시설 ═══════════════════════════════ */
  await enterHub();
  await P(() => {
    const ctx = window.__game.ctx;
    ctx.meta.addCredits(60000, 'shot');
    for (const c of ['helix', 'bastion', 'nomad', 'ceres']) ctx.meta.addRep(c, 1600, 'shot');
    ctx.progression.addXp(9000);
    /* 가방과 창고를 볼거리 있게 채운다 */
    const give = (id, n = 1) => { for (let i = 0; i < n; i++) { const it = ctx.loot.createItem(id); if (it) ctx.inventory.tryAddItemAnywhere(it); } };
    ['wpn_ar_g4', 'wpn_sr_g3', 'wpn_sg_g2', 'wpn_smg_g3'].forEach((id) => give(id));
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

  /* ── 탈출: 콘솔 작동 → 함선 도착 (2026-09-10) ────────────────────────────
     예전 `extraction` 한 장(배리어를 든 방어 컷)을 이 둘로 갈랐다. 카운트다운이
     60 초라 실시간으로는 기다릴 수 없어 `ctx.timeScale` 로 감는다 — 시뮬레이션만
     빨라지고 렌더는 그대로라 스크린샷 품질은 같다. */
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
      /* 신호소가 프레임 한가운데 오도록 어깨 너머에서 잡는다 */
      const cx = pad.position.x + 7, cz = pad.position.z + 7;
      ctx.player.setCameraOverride(
        V(cx, ctx.world.getHeightAt(cx, cz) + 3.2, cz),
        V(pad.position.x, pad.position.y + 1.4, pad.position.z), true,
      );
    });
    await sleep(2600);
  });

  await step('extraction-ship', async () => {
    /* 자기 완결형으로 간다 — 앞 단계가 재시도로 다시 돌면 상태가 날아간다.
       카운트다운 60 초를 실시간으로 기다릴 수 없어 `ctx.timeScale` 로 감되,
       **하강이 시작되는 순간 멈춘다**: 착륙까지 감으면 함선이 어두운 지형에
       묻혀 실루엣이 안 읽히고, 더 감으면 이륙해 미션이 끝나고 패드가 사라진다.
       내려오는 중이 「함선이 도착했을 때」가 가장 잘 읽히는 순간이다. */
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
      /* 6배로 감는 동안 탈출 웨이브가 실제로 사람을 죽인다 — 폴링할 때마다 회복시켜 둔다 */
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
    /* 하늘을 등진 함선을 패드 옆에서 올려다본다 — 실측 바운딩 박스 중심을 겨눈다 */
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

  /* ── 레이드 HUD · 방탄복 실드 · 위험 인디케이터 ─────────────────────────── */
  /** 실드 게이지 · 무기 패널이 둘 다 채워진 레이드 화면을 만든다.
   *  장비는 **함선에서** 갖춰야 한다 — 레이드 한복판에서 끼우면 무기 칸이 비는 수가 있다. */
  const geared = async (planet, seed) => {
    await enterHub();
    await P(() => {
      const ctx = window.__game.ctx;
      const give = (id) => { const it = ctx.loot.createItem(id); if (it) ctx.inventory.tryAddItemAnywhere(it); return it; };
      const armor = give('armor_4');
      if (armor) { try { ctx.inventory.equip(armor.uid, 'armor'); } catch { /* 이미 입었을 수 있다 */ } }
      for (const [id, slot] of [['wpn_ar_g4', 'primary'], ['wpn_sr_g3', 'primary2']]) {
        const it = ctx.inventory.getAllItems().find((x) => x.defId === id) ?? give(id);
        if (it) { try { ctx.inventory.equip(it.uid, slot); } catch { /* 이미 장착 */ } }
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
    /* spawnStanding 은 체력을 가득 채우므로 **프레이밍 뒤에** 깎는다.
       방탄복 IV 의 실드는 80 이라 30 만 깎아야 실드 게이지가 반쯤 남아 읽힌다 —
       80 을 넘겨 깎으면 실드 줄이 비어 「이 게임에 실드가 있다」가 안 보인다. */
    await P(() => window.__game.ctx.player.applyDamage?.(30, 'shot'));
    await sleep(700);
  });

  await step('armor-shield', async () => {
    /* 같은 상태를 조금 더 가까이 — 06-weapons 의 실드 절이 쓴다 */
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
    /* 함선 호출 낙하물이 가장 확실한 인디케이터 소스다 — 예고 동안 마커가 떠 있다 */
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const sys = window.__game.getSystem('stratagems');
      const p = ctx.player.position;
      const tx = p.x + 9, tz = p.z + 9;
      sys.debugCall('supply_drop', V(tx, ctx.world.getHeightAt(tx, tz), tz));
    });
    await sleep(1400);
  });

  /* ── 격납고는 자동 촬영하지 않는다 ───────────────────────────────────────
     공유 함선 격납고(`Hangar`)는 **로비가 있어야** 지어진다 — 릴레이 + 클라이언트
     둘이 필요하므로 이 스크립트(단일 페이지)로는 만들 수 없다. `hangar.png` ·
     `hangar-visit.png` 는 손으로 찍거나 플레이스홀더로 남는다
     (릴레이까지 띄우는 검사는 `scripts/smoke-hangar.mjs` 가 한다). */

  /* ── 분대 커뮤니케이션: 두 휠 ─────────────────────────────────────────────
     위젯의 `setOpen` 을 직접 부르면 **다음 프레임에 도로 닫힌다** — 두 휠 모두
     매 프레임 「키가 눌려 있는가」를 다시 보기 때문이다. 그래서 진짜 입력을
     넣고 **누른 채로** 찍는다. */
  await step('comms-wheel', async () => {
    await startRaid('amber', 20260908);
    /* 스폰 자리는 소품에 막혀 있을 때가 많다 — 트인 자리로 한 발 옮긴다 */
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
    await page.mouse.move(1060, 470);          /* 한 칸을 가리켜 hover 를 켠다 */
    await sleep(500);
    const open = await P(() => !!window.__game.getSystem('hud')?.isCommsWheelOpen);
    if (!open) { await page.keyboard.up('KeyH'); throw new Error('comms wheel did not open'); }
  });
  /* 위 단계를 건너뛴 실행(`ONLY`)에서는 누른 적이 없다 — 놓기는 조용히 넘어간다 */
  try { await page.keyboard.up('KeyH'); } catch { /* not pressed */ }
  await sleep(200);

  await step('ping-wheel', async () => {
    await page.mouse.move(960, 540);
    await page.mouse.down({ button: 'middle' });
    await sleep(500);
    await page.mouse.move(1080, 545);          /* 오른쪽으로 밀어 「저쪽으로 가자」 */
    await sleep(400);
    const open = await P(() => !!window.__game.getSystem('hud')?.isPingWheelOpen);
    if (!open) { await page.mouse.up({ button: 'middle' }); throw new Error('ping wheel did not open'); }
  });
  try { await page.mouse.up({ button: 'middle' }); } catch { /* not pressed */ }
  await sleep(200);

  /* ── 버려진 구조물 ─────────────────────────────────────────────────────── */
  /** 구조물이 실제로 놓인 시드를 찾을 때까지 굴린다 — 개수가 0 인 맵이 나올 수 있다. */
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

  /* ── 선로 · 전차 ───────────────────────────────────────────────────────── */
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

  /* ── 환경 재해 4종 ─────────────────────────────────────────────────────────
     종류는 시드의 함수라 원하는 재해가 나올 때까지 시드를 굴린다. 진행은
     `ctx.missionTime` 의 함수이므로 그 값을 밀어 넣으면 6분을 기다리지 않는다. */
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
      /* 시작 시각을 지나 재해가 화면을 덮을 만큼만 감는다 (1 = 맵 전체) */
      ctx.missionTime = hz.startsAt + 420 * frac;
    }, at);
    await sleep(1800);
    /* 전선(또는 눈의 벽)이 프레임에 들어오도록 높은 자리에서 그쪽을 본다 —
       기본 스폰 카메라는 코앞의 소품에 막혀 재해가 안 보인다. */
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const z = ctx.world.hazard.getZones()[0];
      const p = ctx.player.position;
      let tx, tz;
      if (!z) { tx = p.x + 60; tz = p.z + 60; }
      else if (z.shape === 'front') {
        /* front 는 법선 `dir` **반대편**이 이미 삼켜진 쪽이다 — 전선 커튼은 그쪽에 서 있다 */
        tx = p.x - z.dirX * 80; tz = p.z - z.dirZ * 80;
      } else { /* 원: 경계 위의 가장 가까운 점을 본다 */
        const dx = p.x - z.center.x, dz = p.z - z.center.z, d = Math.hypot(dx, dz) || 1;
        tx = z.center.x + (dx / d) * z.radius; tz = z.center.z + (dz / d) * z.radius;
      }
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz) || 1;
      /* 플레이어에서 그쪽으로 조금 물러선 자리에 카메라를 두고 수평으로 본다 */
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

  /* ── 전장의 안개 · 지도 ────────────────────────────────────────────────── */
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
    /* 분대 넷이 흩어져 돌아다닌 뒤의 모양 — 흩어진 지점 여럿을 직접 칠한다 */
    await P(() => {
      const ctx = window.__game.ctx, V = window.__V;
      const fog = ctx.world.fog, p = ctx.player.position;
      /* `reveal` 은 (x, z, radius) 를 받는다 — Vector3 가 아니다 */
      const walk = (x0, z0, x1, z1) => {           /* 두 점 사이를 걸어간 것처럼 칠한다 */
        for (let t = 0; t <= 1; t += 0.06) fog.reveal(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, 55);
      };
      const legs = [[0, 0, 150, 70], [0, 0, -130, 120], [0, 0, 95, -160], [0, 0, -70, -100]];
      for (const [ax, az, bx, bz] of legs) walk(p.x + ax, p.z + az, p.x + bx, p.z + bz);
      /* 분대원 넷이 끝에서 더 흩어진 모양 */
      for (const [dx, dz] of [[210, 40], [-190, 170], [140, -230], [-110, -160]]) fog.reveal(p.x + dx, p.z + dz, 55);
    });
    await sleep(1000);
  });

  /* 지도를 닫아 둔다 — 뒤에 단계를 더 붙일 때 지도가 덮고 있으면 안 된다 */
  await openMap(false);

} finally {
  await browser.close();
  /* staging → repo, once the browser is gone: nothing can trigger a reload any more */
  for (const f of readdirSync(STAGE)) copyFileSync(join(STAGE, f), join(OUT, f));
  rmSync(STAGE, { recursive: true, force: true });
  console.log(`\n  ${taken} shot(s) → ${OUT}` + (failed.length ? `  ·  skipped: ${failed.join(', ')}` : ''));
}
