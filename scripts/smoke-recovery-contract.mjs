// 2026-09-12 (§5-2, 사용자 결정): 아이템 회수 계약 — **이번 레이드에서 얻은 아이템만** 센다.
//   ① 함선에서 계약 수락 + 가져온 크레딧 칩 2 (표식 없음) → 레이드: 범위(시드 · 계약 아이템) · 가져온 것은 0 개 · 그대로 정산하면 incomplete + 진행도 0
//   ② 실제 상자 굴림은 표식이 찍힌다 · 계약 아이템(표식)이 든 컨테이너 창에서 사선 띠 · 가방으로 가져오면 가져온 스택과 **안 합쳐진다**
//      (빠른 이동 · 드래그 미리보기 swap · mergeInto 0) · 띠는 표식 스택에만 · 개수 = 표식 단위만 · HUD 진행도
//   ③ 표식 칩을 주우면 표식 스택에 합쳐진다 · 나누기는 표식을 물려받는다 · 자동 정렬도 두 분류를 지킨다
//   ④ 레이드 blob 왕복 · 픽업 와이어(rf) 왕복 + 줍기 · 시체 와이어(rf) 왕복 · 로드아웃 문서에는 rf 가 없다
//   ⑤ 다른 아이템(폐금속): 표식 + 가져온 것은 합쳐지고 결과는 표식 없음 (양쪽 순서)
//   ⑥ 표식 5 개로 정산 → success · game:complete 가 표식을 지운다 → 함선: 합치기 가능 · 띠 없음 · 다시 수락하면 진행도 0 · 함선에서는 진행도가 0 으로 돌아온다
//   ⑦ 훈련장: 범위 없음 · 상자 굴림에 표식 없음
// Usage: node scripts/smoke-recovery-contract.mjs [http://localhost:5273/]   (vite dev server; the relay socket is parked)
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
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1600,900', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const P = (fn, arg) => page.evaluate(fn, arg);
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.meta && !!window.__game.ctx.inventory && !!window.__game.ctx.loot, 'boot');
  await P(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
  });
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const DEF = 'cred_chip';   // nomad_chips: 크레딧 칩 5 개, stackMax 5, 1×1, 신뢰도 0
  /** Every stack of `defId` on the body (bag + wheel + pouch) with its mark. */
  const stacks = (defId) => P((d) => {
    const inv = window.__game.getSystem('inventory');
    const all = [...inv.bag.items().map((p) => ({ it: p.item, where: 'bag' })), ...inv.quickSlots.filter(Boolean).map((it) => ({ it, where: 'quick' })),
      ...inv.pouch.items().map((p) => ({ it: p.item, where: 'pouch' }))];
    return all.filter((e) => e.it.defId === d).map((e) => ({ uid: e.it.uid, qty: e.it.qty, rf: e.it.raidFound ?? null, where: e.where }));
  }, defId);
  const clearDefs = (ids) => P((list) => {
    const inv = window.__game.getSystem('inventory');
    for (let pass = 0; pass < 3; pass++) {
      const items = [...inv.bag.items().map((p) => p.item), ...inv.stash.grid.items().map((p) => p.item), ...inv.quickSlots.filter(Boolean), ...inv.pouch.items().map((p) => p.item)];
      for (const it of items) if (list.includes(it.defId)) inv.takeItem(it.uid);
    }
  }, ids);
  const count = (seed) => P((s) => window.__game.getSystem('meta').carriedCount('cred_chip', s), seed);

  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await waitSim(0.3);

  /* ── ① ship: accept + brought stack ───────────────────────────────────── */
  console.log('① 함선 · 수락 · 가져온 스택');
  const accepted = await P(() => {
    const m = window.__game.ctx.meta;
    m.resetMeta();
    if (m.activeContract) m.abandonContract();
    window.__game.ctx.inventory.toggleFavorite('cred_chip', false);
    window.__game.ctx.inventory.toggleFavorite('mat_scrap', false);
    return m.acceptContract('nomad_chips');
  });
  ok(accepted, 'acceptContract(nomad_chips) in the ship');
  await clearDefs([DEF, 'mat_scrap']);
  const brought = await P(() => { const c = window.__game.ctx; const a = c.loot.createItem('cred_chip', 2); return c.inventory.tryAddItem(a) ? a.uid : null; });
  ok(!!brought, 'brought 크레딧 칩 ×2 in the bag');
  ok(await P(() => window.__game.getSystem('inventory').raidFoundScope()) === null, 'ship: no recovery scope');

  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 7 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 60000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 20000);
  await P(() => { const ctx = window.__game.ctx; ctx.enemies.killAll(); ctx.enemies.setThreatLevel(0); });
  await waitSim(0.3);

  const scope = await P(() => ({ scope: window.__game.getSystem('inventory').raidFoundScope(), world: window.__game.ctx.world.seed, stats: window.__game.ctx.stats.seed }));
  const SEED = scope.scope?.seed;
  ok(scope.scope && scope.scope.defId === DEF && SEED === (scope.world >>> 0) && SEED === (scope.stats >>> 0), 'raid: scope = { world seed, cred_chip }', JSON.stringify(scope));
  let s = await stacks(DEF);
  ok(s.length === 1 && s[0].uid === brought && s[0].qty === 2 && s[0].rf === null, 'the brought stack carries no mark', JSON.stringify(s));
  ok(await count() === 0, 'brought units count 0');
  let st = await P(() => window.__game.ctx.meta.settleMission({ ...window.__game.ctx.stats, extracted: true, mode: 'raid' }));
  ok(st && st.outcome === 'incomplete' && st.progress === 0, 'settled with only brought units → incomplete, progress 0', JSON.stringify(st));
  ok(await P(() => window.__game.ctx.meta.activeContract?.def.id === 'nomad_chips' && window.__game.ctx.meta.activeContract.progress === 0), '… contract kept at progress 0');

  /* ── ② crate marks · container ribbon · no merge with the brought stack ── */
  console.log('② 상자 표식 · 컨테이너 띠 · 가져온 스택과 분리');
  const crate = await P(() => {
    const ctx = window.__game.ctx, inv = window.__game.getSystem('inventory');
    const c = ctx.world.getCrates().find((k) => !k.opened);
    if (!c) return null;
    ctx.bus.emit('crate:open', { crateId: c.id, tier: c.tier, position: c.position });
    const cont = inv.containers.get(c.id);
    const items = cont ? cont.grid.items().map((p) => p.item.raidFound ?? null) : [];
    inv.closeAll();
    return { id: c.id, n: items.length, marks: [...new Set(items)] };
  });
  ok(crate && crate.n > 0 && crate.marks.length === 1 && crate.marks[0] === SEED, 'every item a real crate rolled carries this raid\'s seed', JSON.stringify(crate));

  const found = await P((seed) => {
    const ctx = window.__game.ctx, inv = window.__game.getSystem('inventory');
    const it = ctx.loot.createItem('cred_chip', 3);
    it.raidFound = seed;   // what a raid roll stamps (enemy corpse · structure container · gather do the same)
    inv.openContainerItems('smoke:recovery', [it], ctx.player.position.clone(), '회수');
    it.searched = true;
    inv.activeContainer.grid.version++;
    inv.ui.refresh();
    return it.uid;
  }, SEED);
  await waitSim(0.2);
  const contTile = await P((uid) => {
    const el = document.querySelector(`.inv-grid-container .inv-tile[data-uid="${uid}"]`);
    return el ? { rec: el.classList.contains('is-recovery-item'), fav: el.classList.contains('is-favorite'), ribbon: getComputedStyle(el, '::before').backgroundImage } : null;
  }, found);
  ok(contTile && contTile.rec && !contTile.fav && contTile.ribbon.includes('gradient'), 'container window: the counting stack draws the ribbon (not a favorite)', JSON.stringify(contTile));
  ok(await P((uid) => window.__game.getSystem('inventory').quickMove(uid, { kind: 'grid', grid: 'container' }), found) === 'ok', 'quick move container → bag');
  await waitSim(0.2);
  s = await stacks(DEF);
  const foundSt = s.find((x) => x.rf === SEED), broughtSt = s.find((x) => x.uid === brought);
  ok(s.length === 2 && foundSt?.qty === 3 && broughtSt?.qty === 2 && broughtSt.rf === null, 'found 3 and brought 2 sit in separate cells', JSON.stringify(s));
  ok(await count() === 3, 'carriedCount = 3 (found units only)');
  await waitFor(page, () => window.__game.ctx.meta.activeContract?.progress === 3, 'HUD progress 3', 5000).catch(() => null);
  ok(await P(() => window.__game.ctx.meta.activeContract?.progress) === 3, 'live contract progress = 3');

  const bagTiles = await P((a) => {
    const q = (uid) => document.querySelector(`.inv-grid-bag .inv-tile[data-uid="${uid}"]`);
    const f = q(a.found), b = q(a.brought);
    return { f: f?.classList.contains('is-recovery-item') ?? null, b: b?.classList.contains('is-recovery-item') ?? null,
      fRibbon: f ? getComputedStyle(f, '::before').backgroundImage : null, bRibbon: b ? getComputedStyle(b, '::before').backgroundImage : null };
  }, { found: foundSt?.uid, brought });
  ok(bagTiles.f === true && bagTiles.b === false && bagTiles.fRibbon.includes('gradient') && bagTiles.bRibbon === 'none', 'bag: ribbon on the found stack only', JSON.stringify(bagTiles));

  const drag = await P((a) => {
    const inv = window.__game.getSystem('inventory');
    const p = inv.bag.get(a.brought);
    const bag = { kind: 'grid', grid: 'bag' };
    const preview = inv.previewDrop(a.found, bag, { kind: 'grid', grid: 'bag', x: p.x, y: p.y, rotated: false });
    const direct = inv.bag.mergeInto(inv.bag.get(a.found).item, a.brought);
    return { preview, direct };
  }, { found: foundSt?.uid, brought });
  ok(drag.preview === 'swap' && drag.direct === 0, 'dragging found onto brought previews a swap, Grid.mergeInto moves 0', JSON.stringify(drag));

  /* ── ③ pick-up merge · split · sort ─────────────────────────────────────── */
  console.log('③ 줍기 · 나누기 · 정렬');
  await P((seed) => { const c = window.__game.ctx; const it = c.loot.createItem('cred_chip', 1); it.raidFound = seed; c.inventory.tryAddItem(it); }, SEED);
  s = await stacks(DEF);
  ok(s.length === 2 && s.find((x) => x.rf === SEED)?.qty === 4 && s.find((x) => x.uid === brought)?.qty === 2, 'a found chip tops up the found stack, not the brought one', JSON.stringify(s));
  const split = await P((uid) => window.__game.getSystem('inventory').splitItem(uid, 1), s.find((x) => x.rf === SEED)?.uid);
  s = await stacks(DEF);
  ok(split && s.length === 3 && s.filter((x) => x.rf === SEED).map((x) => x.qty).sort().join(',') === '1,3', 'split keeps the mark on both halves', JSON.stringify(s));
  ok(await P(() => window.__game.getSystem('inventory').sortGrid('bag')) !== 'fail', 'sort the bag');
  s = await stacks(DEF);
  ok(s.length === 2 && s.find((x) => x.rf === SEED)?.qty === 4 && s.find((x) => x.rf === null)?.qty === 2, 'sort folds the found halves together and leaves the brought stack apart', JSON.stringify(s));
  ok(await count() === 4, 'carriedCount = 4');

  /* ── ④ raid blob · pickup wire · corpse wire · no rf in documents ───────── */
  console.log('④ 레이드 blob · 픽업 와이어 · 시체 와이어');
  const blob = await P(() => {
    const inv = window.__game.getSystem('inventory');
    const state = JSON.parse(JSON.stringify(inv.captureRaidState()));
    const doc = JSON.stringify(inv.captureLoadoutSave());
    const tagged = state.bag.filter((e) => e.defId === 'cred_chip').map((e) => ({ qty: e.qty, rf: e.rf ?? null }));
    const applied = inv.applyRaidState(state);
    return { applied, tagged, docHasRf: doc.includes('"rf"') };
  });
  s = await stacks(DEF);
  ok(blob.applied && blob.tagged.some((e) => e.rf === SEED && e.qty === 4) && blob.tagged.some((e) => e.rf === null && e.qty === 2), 'raid blob carries rf on the found stack only', JSON.stringify(blob));
  ok(!blob.docHasRf, 'the loadout document never carries rf');
  ok(s.find((x) => x.rf === SEED)?.qty === 4 && s.find((x) => x.rf === null)?.qty === 2, 'restored from the blob: marks intact', JSON.stringify(s));

  const pick = await P((seed) => {
    const inv = window.__game.getSystem('inventory'), ps = window.__game.getSystem('pickups');
    const src = inv.bag.items().map((p) => p.item).find((it) => it.defId === 'cred_chip' && it.raidFound === seed);
    if (!src || !inv.splitItem(src.uid, 1)) return null;
    const one = inv.bag.items().map((p) => p.item).find((it) => it.defId === 'cred_chip' && it.raidFound === seed && it.qty === 1);
    if (!one || !inv.dropItem(one.uid)) return null;
    const p = [...ps.byId.values()].find((k) => k.item.uid === one.uid);
    if (!p) return { dropped: false };
    const w = ps.wireOf(p);
    const back = ps.itemFromWire(JSON.parse(JSON.stringify(w)));
    const plain = ps.itemFromWire({ ...w, rf: undefined, id: 'x' });
    ps.take(p);
    return { dropped: true, onGround: p.item.raidFound ?? null, wireRf: w.rf ?? null, backRf: back.raidFound ?? null, plainRf: plain.raidFound ?? null, gone: !ps.byId.has(p.id) };
  }, SEED);
  ok(pick && pick.dropped && pick.onGround === SEED && pick.wireRf === SEED && pick.backRf === SEED && pick.plainRf === null, 'dropped pickup keeps the mark; PickupWire.rf round-trips (omitted = unmarked)', JSON.stringify(pick));
  ok(pick?.gone && await count() === 4, 'picked back up: still counts (4)');

  const corpse = await P(async (seed) => {
    const ctx = window.__game.ctx, inv = window.__game.getSystem('inventory');
    const g = await import('/src/game/Corpses.ts');
    const cl = await import('/src/inventory/parts/CorpseLoot.ts');
    const a = ctx.loot.createItem('cred_chip', 2); a.raidFound = seed;
    const b = ctx.loot.createItem('cred_chip', 1);
    const wire = JSON.parse(JSON.stringify(g.itemsToWire([a, b])));
    const back = cl.corpseItemsFromWire(inv, wire);
    return { wire: wire.map((w) => w.rf ?? null), back: back.map((it) => it.raidFound ?? null) };
  }, SEED);
  ok(corpse.wire[0] === SEED && corpse.wire[1] === null && corpse.back[0] === SEED && corpse.back[1] === null, 'CorpseItemWire.rf round-trips (player corpse loot keeps the origin)', JSON.stringify(corpse));

  /* ── ⑤ another item: mixed marks merge, result unmarked ─────────────────── */
  console.log('⑤ 다른 아이템 — 섞이면 표식 없음');
  const scrapA = await P((seed) => {
    const c = window.__game.ctx, inv = window.__game.getSystem('inventory');
    const b0 = c.loot.createItem('mat_scrap', 1); inv.tryAddItem(b0);            // brought (unmarked) first
    const f = c.loot.createItem('mat_scrap', 1); f.raidFound = seed; inv.tryAddItem(f);   // found merges into it
    return inv.bag.items().map((p) => p.item).filter((it) => it.defId === 'mat_scrap').map((it) => ({ qty: it.qty, rf: it.raidFound ?? null }));
  }, SEED);
  ok(scrapA.length === 1 && scrapA[0].qty === 2 && scrapA[0].rf === null, 'found scrap merges into brought scrap → unmarked', JSON.stringify(scrapA));
  await clearDefs(['mat_scrap']);
  const scrapB = await P((seed) => {
    const c = window.__game.ctx, inv = window.__game.getSystem('inventory');
    const f = c.loot.createItem('mat_scrap', 1); f.raidFound = seed; inv.tryAddItem(f);   // found first
    const b0 = c.loot.createItem('mat_scrap', 1); inv.tryAddItem(b0);                      // brought merges into it
    return inv.bag.items().map((p) => p.item).filter((it) => it.defId === 'mat_scrap').map((it) => ({ qty: it.qty, rf: it.raidFound ?? null }));
  }, SEED);
  ok(scrapB.length === 1 && scrapB[0].qty === 2 && scrapB[0].rf === null, 'brought scrap merges into found scrap → unmarked (no laundering)', JSON.stringify(scrapB));
  const probe = await P((seed) => {
    const c = window.__game.ctx, inv = window.__game.getSystem('inventory');
    const f = c.loot.createItem('mat_scrap', 1); f.raidFound = seed;
    inv.bag.items().filter((p) => p.item.defId === 'mat_scrap').forEach((p) => inv.takeItem(p.item.uid));
    inv.tryAddItem(f);
    const fits = inv.canFit ? inv.canFit('mat_scrap', 1) : null;   // a dry run merges a fresh probe and rolls back
    return { fits, rf: f.raidFound ?? null };
  }, SEED);
  ok(probe.rf === SEED, 'a dry-run fit check (snapshot / restore) does not strip the mark', JSON.stringify(probe));

  /* ── ⑥ success · return to the ship ───────────────────────────────────── */
  console.log('⑥ 정산 · 함선 복귀');
  await P((seed) => { const c = window.__game.ctx; const it = c.loot.createItem('cred_chip', 1); it.raidFound = seed; c.inventory.tryAddItem(it); }, SEED);
  ok(await count() === 5, 'carriedCount = 5');
  st = await P(() => window.__game.ctx.meta.settleMission({ ...window.__game.ctx.stats, extracted: true, mode: 'raid' }));
  ok(st && st.outcome === 'success' && st.progress === 5 && st.credits > 0, '5 found units → success', JSON.stringify(st));
  await P(() => { const ctx = window.__game.ctx; ctx.bus.emit('game:complete', { stats: { ...ctx.stats, extracted: true } }); });
  s = await stacks(DEF);
  ok(s.length >= 2 && s.every((x) => x.rf === null), 'game:complete strips every mark', JSON.stringify(s));
  await P(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitFor(page, () => window.__game.ctx.phase === 'menu', 'abort', 20000);
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub again');
  await waitSim(0.3);
  s = await stacks(DEF);
  ok(s.reduce((n, x) => n + x.qty, 0) === 7 && s.every((x) => x.rf === null), 'ship: 7 chips, none marked', JSON.stringify(s));
  const shipMerge = await P(() => {
    const inv = window.__game.getSystem('inventory');
    const list = inv.bag.items().filter((p) => p.item.defId === 'cred_chip' && p.item.qty < 5);
    if (list.length < 2) return { preview: 'n/a', n: list.length };
    const [a, b] = list;
    return { preview: inv.previewDrop(a.item.uid, { kind: 'grid', grid: 'bag' }, { kind: 'grid', grid: 'bag', x: b.x, y: b.y, rotated: false }) };
  });
  ok(shipMerge.preview === 'merge' || shipMerge.preview === 'n/a', 'ship: two partial chip stacks merge again', JSON.stringify(shipMerge));
  ok(await P(() => window.__game.getSystem('inventory').sortGrid('bag')) !== 'fail', 'ship: sort the bag');
  s = await stacks(DEF);
  ok(s.length === 2 && s.map((x) => x.qty).sort().join(',') === '2,5', 'ship: sort folds them into 5 + 2', JSON.stringify(s));
  await P(() => { const inv = window.__game.ctx.inventory; if (!inv.isOpen) inv.toggleBag?.(); window.__game.getSystem('inventory').ui.refresh(); });
  await waitSim(0.2);
  ok(await P(() => document.querySelectorAll('.inv-tile.is-recovery-item').length) === 0, 'ship: no recovery ribbon anywhere');
  const reacc = await P(() => {
    const m = window.__game.ctx.meta;
    const okAcc = m.acceptContract('nomad_chips');
    return { okAcc, progress: m.activeContract?.progress ?? null };
  });
  ok(reacc.okAcc && reacc.progress === 0 && await count() === 0 && await count(7) === 0, 'ship: re-accepted at progress 0; nothing counts (marks gone)', JSON.stringify(reacc));
  const reset = await P(() => {
    const meta = window.__game.getSystem('meta');
    meta.store.data.activeContract.progress = 3;   // a stale count left from some raid
    window.__game.getSystem('inventory').afterChange();
    return window.__game.ctx.meta.activeContract.progress;
  });
  ok(reset === 0, 'ship: a stale item-contract progress snaps back to 0', String(reset));
  await P(() => { const inv = window.__game.ctx.inventory; if (inv.isOpen) inv.toggleBag?.(); });

  /* ── ⑦ training: no marks ───────────────────────────────────────────────── */
  console.log('⑦ 훈련장');
  const started = await P(() => window.__game.getSystem('hub').startTraining());
  ok(started, 'startTraining()');
  await waitFor(page, () => window.__game.ctx.world?.ready && window.__game.ctx.world.mode === 'training' && window.__game.ctx.isGameplayPhase(), 'training world', 60000);
  await waitSim(0.5);
  const tr = await P(() => {
    const ctx = window.__game.ctx, inv = window.__game.getSystem('inventory');
    ctx.bus.emit('crate:open', { crateId: 'smoke:training-crate', tier: 3, position: ctx.player.position.clone() });
    const cont = inv.containers.get('smoke:training-crate');
    const marks = cont ? cont.grid.items().map((p) => p.item.raidFound ?? null) : null;
    inv.closeAll();
    return { scope: inv.raidFoundScope(), seed: typeof inv.containers.raidMark === 'function' ? inv.containers.raidMark() : 'missing', marks };
  });
  ok(tr.scope === null && tr.seed === null && Array.isArray(tr.marks) && tr.marks.length > 0 && tr.marks.every((m) => m === null), 'training: no scope, crate rolls carry no mark', JSON.stringify(tr));
  await P(() => { const b = window.__game.ctx.bus; b.emit('game:abort', {}); b.emit('hub:enter', { ship: 'personal' }); });
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub after training', 30000);

  // clean up
  await clearDefs([DEF, 'mat_scrap']);
  await P(() => { const m = window.__game.ctx.meta; if (m.activeContract) m.abandonContract(); });

  const relevant = errors.filter((e) => !/WebSocket|ERR_CONNECTION|favicon|net::/i.test(e));
  ok(relevant.length === 0, 'no console errors', relevant.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e?.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(`\nsmoke-recovery-contract: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
