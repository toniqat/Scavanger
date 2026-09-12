// 2026-09-12 (agent D) — 지상 드론 스캔 (docs/plans/consumables-keys-favorites.md §4).
//   ① 맵 상자 옆에 지상 드론을 세우고 조종 · 조준 → `ctx.drones.scanAim` + `.dsc-hint` 안내
//   ② 좌클릭 홀드: 게이지가 차고, 조준을 빼면 0 으로, 다시 조준해 3 초 → 결과 · 월드 라벨(등급) · 채팅 한 줄
//   ③ 채운 뒤 계속 눌러도 다시 세지 않는다 · 좌클릭이 총으로 새지 않는다(`weapon:fired` 0) · 상자는 열리지도 굴려지지도 않았다
//   ④ 등급 = 미리보기 = 실제로 열었을 때의 내용물 (defId × qty 전부) · 연 뒤의 미리보기 = 지금 내용물
//   ⑤ 적 시체 · 보급 상자(확정된 남의 가져가기 포함) · 구조물 컨테이너(`WorldRef.previewContainerItems` 가 있으면)의 미리보기 ≡ 열기
//   ⑥ `game:abort` → 결과 · 라벨이 사라진다
// Usage: node scripts/smoke-drone-scan.mjs [http://localhost:5273]   (needs `npm run dev`)
import puppeteer from 'puppeteer-core';
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
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.drones, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = { fired: 0, chat: [], scanned: [] };
    const bus = window.__game.ctx.bus;
    bus.on('weapon:fired', () => { window.__ev.fired++; });
    bus.on('chat:message', (m) => window.__ev.chat.push(m.text));
    bus.on('drone:scanned', (m) => window.__ev.scanned.push({ id: m.id, rarity: m.rarity, local: m.local }));
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const mDown = () => page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown', { button: 0 })));
  const mUp = () => page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 0 })));
  const calm = () => page.evaluate(() => { const ctx = window.__game.ctx; ctx.enemies.killAll(); ctx.enemies.setThreatLevel(0); const p = ctx.player; if (p.isDowned) p.revive(); p.heal(1000); });
  const state = () => page.evaluate(() => {
    const dr = window.__game.ctx.drones; const a = dr.scanAim;
    return {
      aim: a ? { id: a.id, name: a.name, d: +a.distance.toFixed(2), inRange: a.inRange } : null,
      hold: +dr.scanHold.toFixed(3), controlled: dr.controlled ? dr.controlled.id : null,
      results: dr.getScanResults().map((r) => ({ id: r.id, rarity: r.rarity, local: r.local, name: r.name })),
    };
  });
  const aimYaw = (delta) => page.evaluate((dy) => { const d = window.__game.getSystem('drones').controlled; if (d) d.lookYaw = window.__aimYaw + dy; }, delta);

  console.log('mission');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await sleep(1200);
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 7 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
  await sleep(300);
  await calm();

  console.log('① 상자 옆 지상 드론 · 조준');
  const setup = await page.evaluate(() => {
    const ctx = window.__game.ctx, world = ctx.world, V = ctx.player.position.constructor;
    for (const c of world.getCrates()) {
      if (c.opened) continue;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const sx = c.position.x + Math.cos(a) * 3.4, sz = c.position.z + Math.sin(a) * 3.4;
        if (!world.isInsideBounds(sx, sz)) continue;
        const sy = world.getSurfaceY(sx, sz, c.position.y + 1.0);
        if (Math.abs(sy - c.position.y) > 0.6) continue;
        // 드론 몸(반지름 0.35)이 밀려나지 않는 자리여야 한다 — 밀리면 조준선이 옆 바위에 가린다
        const probe = new V(sx, sy, sz);
        world.resolveCollision(probe, 0.35);
        if (Math.hypot(probe.x - sx, probe.z - sz) > 0.05) continue;
        const lens = new V(sx, sy + 0.345, sz);
        const center = new V(c.position.x, c.position.y + 0.45, c.position.z);
        const dir = center.clone().sub(lens); const dist = dir.length(); dir.normalize();
        const hit = world.raycast(lens, dir, dist);
        if (hit && hit.distance < dist - 0.35) {
          const o = hit.obstacle;
          if (!o || Math.hypot(o.position.x - c.position.x, o.position.z - c.position.z) >= 0.3) continue;
        }
        // PC 는 드론 뒤 2 m (조준선 밖, 신호 범위 안)
        const px = c.position.x + Math.cos(a) * 5.4, pz = c.position.z + Math.sin(a) * 5.4;
        ctx.player.teleport(new V(px, world.getSurfaceY(px, pz, c.position.y + 1.0), pz), undefined, true);
        return { id: c.id, tier: c.tier, spot: [sx, sy, sz], center: [center.x, center.y, center.z] };
      }
    }
    return null;
  });
  ok(!!setup, 'found an unopened crate with a clear 3.4 m approach', JSON.stringify(setup));
  if (!setup) throw new Error('no crate');
  await waitSim(0.3);
  const ctl = await page.evaluate((s) => {
    const ctx = window.__game.ctx, V = ctx.player.position.constructor;
    const sys = window.__game.getSystem('drones');
    if (!ctx.drones.deploy('ground')) return { deployed: false };
    const d = sys.drones.find((x) => x.isLocal && x.kind === 'ground');
    const yaw = Math.atan2(s.center[0] - s.spot[0], s.center[2] - s.spot[2]);
    d.body.reset(new V(s.spot[0], s.spot[1], s.spot[2]), yaw, ctx);
    const ok = sys.debugControl(d.id);
    const lensY = s.spot[1] + 0.345;
    const horiz = Math.hypot(s.center[0] - s.spot[0], s.center[2] - s.spot[2]);
    window.__aimYaw = yaw;
    d.lookYaw = yaw;
    d.lookPitch = Math.atan2(s.center[1] - lensY, horiz);
    return { deployed: true, controlled: ok, id: d.id, pc: ctx.player.droneControl };
  }, setup);
  ok(ctl.deployed && ctl.controlled && ctl.pc === true, 'ground drone deployed and under control (PC in drone view)', JSON.stringify(ctl));
  await waitSim(0.3);
  // 몸이 자리를 잡은 뒤 실제 렌즈 자리에서 다시 조준한다 (렌즈 = 몸 + 코 방향 0.2 m, 높이 0.345)
  const reaim = () => page.evaluate((s) => {
    const d = window.__game.getSystem('drones').controlled;
    if (!d) return null;
    const p = d.body.position;
    let yaw = Math.atan2(s.center[0] - p.x, s.center[2] - p.z);
    for (let i = 0; i < 2; i++) {
      const lx = p.x + Math.sin(yaw) * 0.2, lz = p.z + Math.cos(yaw) * 0.2;
      yaw = Math.atan2(s.center[0] - lx, s.center[2] - lz);
    }
    const lx = p.x + Math.sin(yaw) * 0.2, lz = p.z + Math.cos(yaw) * 0.2, ly = p.y + 0.345;
    window.__aimYaw = yaw;
    d.lookYaw = yaw;
    d.lookPitch = Math.atan2(s.center[1] - ly, Math.hypot(s.center[0] - lx, s.center[2] - lz));
    return { yaw, pitch: d.lookPitch };
  }, setup);
  await reaim();
  await waitSim(0.3);
  await reaim();
  await waitSim(0.3);
  const diag = await page.evaluate((s) => {
    const ctx = window.__game.ctx, V = ctx.player.position.constructor, sys = window.__game.getSystem('drones');
    const d = sys.controlled;
    if (!d) return { controlled: false };
    const pos = new V(), look = new V();
    d.body.getCameraPose(d.lookPitch, pos, look);
    const dir = look.clone().sub(pos).normalize();
    const c = new V(s.center[0], s.center[1], s.center[2]);
    const toC = c.clone().sub(pos);
    const hit = ctx.world.raycast(pos, dir, toC.length());
    const it = ctx.interactables.all().find((i) => i.id === s.id);
    return {
      active: ctx.isGameplayActive(), blockers: [...ctx.uiBlockers], phase: ctx.phase, ready: ctx.world.ready,
      body: [d.body.position.x, d.body.position.y, d.body.position.z].map((v) => +v.toFixed(2)), yaw: +d.body.yaw.toFixed(2),
      lookYaw: +d.lookYaw.toFixed(2), lookPitch: +d.lookPitch.toFixed(2), lens: [pos.x, pos.y, pos.z].map((v) => +v.toFixed(2)),
      miss: +toC.clone().sub(dir.clone().multiplyScalar(toC.dot(dir))).length().toFixed(3), dist: +toC.length().toFixed(2),
      hit: hit ? { d: +hit.distance.toFixed(2), obs: hit.obstacle ? [hit.obstacle.position.x, hit.obstacle.position.z].map((v) => +v.toFixed(2)) : null } : null,
      interactable: it ? [it.position.x, it.position.y, it.position.z].map((v) => +v.toFixed(2)) : null,
      spot: s.spot,
    };
  }, setup);
  console.log('  diag', JSON.stringify(diag));
  const s0 = await state();
  ok(s0.aim && s0.aim.id === setup.id && s0.aim.inRange && s0.aim.name === '상자' && s0.hold === 0,
    'scanAim = the crate (in range, 상자), no hold yet', JSON.stringify(s0));
  const hint0 = await page.evaluate(() => document.querySelector('.dsc-hint.show')?.textContent ?? '');
  ok(hint0.includes('상자') && hint0.includes('좌클릭 꾹 — 내용물 스캔'), 'HUD hint names the target + 좌클릭 꾹 — 내용물 스캔', JSON.stringify(hint0));
  const pre = await page.evaluate((id) => {
    const sys = window.__game.getSystem('drones'), inv = window.__game.getSystem('inventory');
    return { preview: sys.scanPreview(id), rolled: !!inv.containers.get(id) };
  }, setup.id);
  ok(!!pre.preview && !pre.rolled, 'scanPreview works without rolling the crate into the container cache', JSON.stringify(pre));

  console.log('② 좌클릭 홀드 · 조준 이탈 · 완료');
  const fired0 = await page.evaluate(() => window.__ev.fired);
  await mDown();
  await waitSim(1.2);
  const s1 = await state();
  ok(s1.hold > 0.15 && s1.hold < 0.8 && s1.results.length === 0, `gauge rises while held on target (hold=${s1.hold})`, JSON.stringify(s1));
  ok(await page.evaluate(() => !!document.querySelector('.dsc-ring.show')), 'scan ring shows while holding');
  await aimYaw(1.4);
  await waitSim(0.3);
  const s2 = await state();
  ok(s2.hold === 0 && (!s2.aim || s2.aim.id !== setup.id) && s2.results.length === 0, 'aiming away resets the gauge to 0', JSON.stringify(s2));
  await aimYaw(0);
  await waitSim(1.0);
  const s3 = await state();
  ok(s3.hold > 0.1 && s3.hold < 0.7 && s3.results.length === 0, `re-aimed: counts again from 0 (hold=${s3.hold})`, JSON.stringify(s3));
  await waitSim(2.6);
  const s4 = await state();
  const res = s4.results.find((r) => r.id === setup.id);
  ok(!!res && res.local && res.rarity === pre.preview.rarity, `scan completes: result rarity ${res?.rarity} = preview ${pre.preview.rarity}`, JSON.stringify(s4));
  await waitSim(0.3);
  const lbl = await page.evaluate((id) => {
    const el = document.querySelector(`.dsl-label[data-target="${id}"]`);
    return el ? { rarity: el.dataset.rarity, text: el.textContent, opacity: el.style.opacity } : null;
  }, setup.id);
  ok(!!lbl && lbl.rarity === (pre.preview.rarity ?? 'empty') && lbl.opacity !== '0' && lbl.opacity !== '',
    'world label above the crate carries the rarity and is visible', JSON.stringify(lbl));
  const chat = await page.evaluate(() => window.__ev.chat.slice());
  ok(chat.some((t) => t.startsWith('드론 스캔: 상자 — ')), 'one chat line 드론 스캔: 상자 — …', JSON.stringify(chat));

  console.log('③ 래치 · 좌클릭이 총으로 새지 않는다 · 상자는 그대로');
  await waitSim(0.8);
  const s5 = await state();
  ok(s5.hold === 0 && s5.results.length === 1, 'still holding after the scan: latched, no second count', JSON.stringify(s5));
  await mUp();
  await waitSim(0.2);
  const after = await page.evaluate((id) => ({
    fired: window.__ev.fired, rolled: !!window.__game.getSystem('inventory').containers.get(id),
    opened: window.__game.ctx.world.getCrates().find((c) => c.id === id)?.opened ?? null,
    scanned: window.__ev.scanned.length,
  }), setup.id);
  ok(after.fired === fired0, 'LMB held through the whole scan fired no shot (weapon:fired unchanged)', JSON.stringify({ fired0, ...after }));
  ok(!after.rolled && after.opened === false, 'the crate was neither rolled nor opened by the scan', JSON.stringify(after));
  ok(after.scanned === 1, 'drone:scanned emitted once', JSON.stringify(after));
  // 조종 해제 중 홀드는 취소된다
  await mDown();
  await waitSim(0.6);
  const midHold = (await state()).hold;
  await page.evaluate(() => window.__game.ctx.drones.releaseControl('manual'));
  await waitSim(0.2);
  const s6 = await state();
  await mUp();
  ok(midHold > 0 && s6.hold === 0 && s6.controlled === null && s6.aim === null, 'releasing control mid-hold cancels the gauge', JSON.stringify({ midHold, s6 }));

  console.log('④ 미리보기 ≡ 실제 내용물');
  const opened = await page.evaluate((id) => {
    const ctx = window.__game.ctx, inv = window.__game.getSystem('inventory');
    const c = ctx.world.getCrates().find((k) => k.id === id);
    ctx.bus.emit('crate:open', { crateId: id, tier: c.tier, position: c.position });
    const cont = inv.containers.get(id);
    const list = cont ? cont.grid.items().filter((p) => p.item.qty > 0).map((p) => `${p.item.defId}x${p.item.qty}`).sort() : null;
    ctx.inventory.closeAll();
    return { list, post: window.__game.getSystem('drones').scanPreview(id) };
  }, setup.id);
  ok(sameList(opened.list, pre.preview.defIds), 'opening the crate yields exactly the previewed items', JSON.stringify({ opened: opened.list, preview: pre.preview.defIds }));
  ok(opened.post && sameList(opened.post.defIds, opened.list), 'after opening, the preview reads the current contents', JSON.stringify(opened.post));

  console.log('⑤ 적 시체 · 보급 상자 · 구조물 컨테이너');
  await calm();
  const corpse = await page.evaluate(() => {
    const ctx = window.__game.ctx, V = ctx.player.position.constructor, inv = window.__game.getSystem('inventory');
    const es = window.__game.getSystem('enemies');
    const p = ctx.player.position;
    const c = es.corpses.add(900001, 'rogue', new V(p.x + 1, p.y, p.z), undefined, ctx.world.seed);
    if (!c) return null;
    const preview = window.__game.getSystem('drones').scanPreview(c.id);
    const rolled = !!inv.containers.get(c.id);
    c.interact();
    const cont = inv.containers.get(c.id);
    const list = cont ? cont.grid.items().filter((q) => q.item.qty > 0).map((q) => `${q.item.defId}x${q.item.qty}`).sort() : null;
    ctx.inventory.closeAll();
    es.corpses.remove(900001);
    return { id: c.id, preview, rolled, list };
  });
  ok(!!corpse && !!corpse.preview && !corpse.rolled && sameList(corpse.list, corpse.preview.defIds),
    'enemy corpse: preview ≡ what searching it opens', JSON.stringify(corpse));
  const supply = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = window.__game.getSystem('inventory'), sys = window.__game.getSystem('drones');
    const p = ctx.player.position;
    const id = 'supply:smoke-scan';
    // 이 클라이언트가 열기 전에 확정된 남의 가져가기 — 미리보기도 열기도 똑같이 빼야 한다
    inv.containers.recordPending(id, 0, 1);
    const raw = inv.peekContainerItems(id, 5).map((i) => `${i.defId}x${i.qty}`);
    const preview = sys.scanPreview(id);
    inv.openContainer(id, 5, p.clone());
    const cont = inv.containers.get(id);
    const list = cont ? cont.grid.items().filter((q) => q.item.qty > 0).map((q) => `${q.item.defId}x${q.item.qty}`).sort() : null;
    ctx.inventory.closeAll();
    return { raw, preview, list };
  });
  ok(!!supply.preview && supply.preview.defIds.length > 0 && sameList(supply.list, supply.preview.defIds),
    'supply crate (tier 5, a pending take of idx 0): preview ≡ open', JSON.stringify(supply));
  const struct = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = window.__game.getSystem('inventory'), sys = window.__game.getSystem('drones');
    if (typeof ctx.world.previewContainerItems !== 'function') return { skip: 'WorldRef.previewContainerItems not published yet (agent C)' };
    const it = ctx.interactables.all().find((i) => i.id.startsWith('container:') && !inv.containers.get(i.id.slice(10)));
    if (!it) return { skip: 'no unopened structure container on this map' };
    const specId = it.id.slice(10);
    let preview;
    try { preview = sys.scanPreview(it.id); } catch (e) { return { skip: `world preview threw: ${e.message}` }; }
    if (!preview) return { skip: 'world preview returned null' };
    it.interact();
    const cont = inv.containers.get(specId);
    const list = cont ? cont.grid.items().filter((q) => q.item.qty > 0).map((q) => `${q.item.defId}x${q.item.qty}`).sort() : null;
    ctx.inventory.closeAll();
    return { id: it.id, preview, list };
  });
  if (struct.skip) console.log(`  skip structure container: ${struct.skip}`);
  else ok(!!struct.preview && sameList(struct.list, struct.preview.defIds), 'structure container: preview ≡ open (world preview incl. key bonus)', JSON.stringify(struct));

  console.log('⑥ 레이드 리셋');
  await page.evaluate(() => window.__game.ctx.bus.emit('game:abort'));
  await waitFor(page, () => window.__game.ctx.drones.getScanResults().length === 0, 'scan results cleared', 15000);
  await sleep(400);
  const gone = await page.evaluate(() => ({ results: window.__game.ctx.drones.getScanResults().length, labels: document.querySelectorAll('.dsl-label').length }));
  ok(gone.results === 0 && gone.labels === 0, 'game:abort clears scan results and their world labels', JSON.stringify(gone));

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
