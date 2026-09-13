// Single-player smoke test for the **pinned item tooltip** (2026-09-14 — inventory `ui/TipPin` · `parts/SocketDetach` ·
// `ui/GridView` durability gauge, ui `hud/CursorHoldGauge` · `hud/ItemTip`):
//   ① durability gauges on every durability tile in the 창고 (방탄복 50 % · 가방 0 % · 돌격소총 100 % / 10 %), the colour
//     green → yellow → orange → red by ratio (computed `background-color` of `.inv-dur-fill`), no `cur/max` number on a tile or an
//     equipment slot card, `buildItemTile` carries the gauge, weapon pips = the sockets the weapon accepts;
//   ② a still LMB hold on a tile → `ui:cursorHold` ring fills → the card pins (`.inv-tooltip.is-pinned` + `.inv-tt-pin` diamond), stays
//     where it is when the cursor moves, no duplicate floating card over its own tile, a normal floating card over another tile;
//   ③ unpin by a press outside the card · the diamond · Escape (window stays open) · closing the window · the item vanishing;
//   ④ a short press is a plain click (nothing pins), a press that moves past the threshold before the ring is full is a normal drag;
//   ⑤ the pinned weapon card: centred row of only the accepted sockets (empty = full Korean name), hover a socket = the attachment's
//     card, drag it out into a free bag cell / a free 창고 cell (socket emptied, item there, card redrawn, `inventory:socketChanged`),
//     onto an occupied cell = refused (still attached, red ghost), a world drop in the ship = refused;
//   ⑥ a weapon in an open crate: its pinned card is hover-only (no `.can-detach`), the API refuses;
//   ⑦ the 기업 tab's `TradeGrids`: hold pins the inventory card on `#ui-root` (`.tg-tip`), the tile opts out of `ItemTip`, Escape unpins,
//     a moved press still lifts the `.tg-ghost`.
// Optional: SMOKE_SHOT_DIR=<dir> saves `tip-pin-weapon.png` (pinned weapon card) and `tip-pin-gauges.png` (창고 tiles).
// Usage: node scripts/smoke-tip-pin.mjs [http://localhost:5273/]   (needs a vite dev server)
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SHOT_DIR = process.env.SMOKE_SHOT_DIR ?? '';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const note = (label) => console.log(`  note ${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}
async function waitOk(page, fn, label, timeout, arg) {
  try { await waitFor(page, fn, label, timeout, arg); ok(true, label); } catch { ok(false, label, '(timeout)'); }
}

const HOLD_MS = 1350;   // UI_HOLD_CONFIRM_S (1 s) + margin

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1680,900', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1680, height: 900 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const EVENTS = ['ui:cursorHold', 'ui:tipPinned', 'inventory:socketChanged'];
  const boot = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
    await page.evaluate((names) => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      window.__ev = {};
      const bus = window.__game.ctx.bus;
      for (const n of names) {
        window.__ev[n] = [];
        bus.on(n, (p) => {
          try {
            const flat = n === 'inventory:socketChanged' ? { weapon: p.weapon?.uid, socket: p.socket, attachment: p.attachment?.uid ?? null } : p;
            window.__ev[n].push(JSON.parse(JSON.stringify(flat)));
          } catch { window.__ev[n].push({}); }
        });
      }
    }, EVENTS);
  };
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const openInv = async () => {
    await page.evaluate(() => { const s = window.__game.getSystem('inventory'); if (!s._open) s.toggleBag(); });
    await waitFor(page, () => { const s = window.__game.getSystem('inventory'); const r = document.querySelector('.inv-root'); return s._open && r && !r.hidden; }, 'inventory window open', 10000);
    await sleep(250);
  };
  const tileSel = (grid, uid) => `.inv-grid-${grid} .inv-tile[data-uid="${uid}"]`;
  /** Scroll `sel` into view and return its centre (client px). */
  const center = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  /** Centre without scrolling (elements on a fixed card). */
  const spot = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  const pinState = () => page.evaluate(() => {
    const pin = window.__game.getSystem('inventory').ui.pin;
    const el = document.querySelector('.inv-root .inv-tooltip.is-pinned');
    const floating = document.querySelector('.inv-root .inv-tooltip:not(.is-pinned)');
    return {
      pinned: pin.isPinned, uid: pin.pinnedUid, holding: pin.isHolding, shown: !!el && !el.hidden, diamond: !!el?.querySelector('.inv-tt-pin'),
      cardUid: el?.dataset.uid ?? null, transform: el?.style.transform ?? '', ring: !!document.querySelector('.cursor-hold.show'),
      floating: !!floating && !floating.hidden, floatingName: floating && !floating.hidden ? floating.querySelector('.inv-tt-name')?.textContent ?? '' : '',
      escTop: window.__game.ctx.escape.topKey, open: window.__game.getSystem('inventory')._open,
    };
  });
  /** Press still on `sel` for the hold, then release. */
  const holdPin = async (sel) => {
    const c = await center(sel);
    if (!c) return null;
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await sleep(HOLD_MS);
    await page.mouse.up();
    await sleep(80);
    return c;
  };
  /** A point on the window that is outside the pinned card and not on a button / tile. */
  const outsidePoint = () => page.evaluate(() => {
    const card = document.querySelector('.inv-root .inv-tooltip.is-pinned');
    const cr = card && !card.hidden ? card.getBoundingClientRect() : null;
    for (const s of ['.inv-weight', '.inv-foot', '.inv-panel-stash .inv-title', '.inv-capacity', '.inv-slot-label']) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (cr && x > cr.left - 8 && x < cr.right + 8 && y > cr.top - 8 && y < cr.bottom + 8) continue;
        const under = document.elementFromPoint(x, y);
        if (!under || under.closest('button, .inv-tile, .inv-tooltip')) continue;
        return { x, y, sel: s };
      }
    }
    return null;
  });

  /* ── 0. fresh character + test items in the 창고 ─────────────────────────────────────────────────────────────── */
  console.log('setup');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { for (const k of ['scav.s1.loadout', 'scav.s1.stash', 'scav.s1.grant', 'scav.s1.sessionToken']) localStorage.removeItem(k); });
  await page.goto(BASE, { waitUntil: 'load' });
  await boot();
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.3);
  await sleep(1200);   // a relay welcome (if any) lands before we start editing

  const S = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, loot = ctx.loot;
    const defs = loot.getAllItemDefs();
    const armorDef = defs.find((d) => d.armorId && (d.durabilityMax ?? 0) > 0 && !d.retired);
    const bagDef = defs.find((d) => d.bag && (d.durabilityMax ?? 0) > 0 && !d.retired);
    const mk = (id) => loot.createItem(id, 1);
    const armor = mk(armorDef.id); armor.durability = armorDef.durabilityMax * 0.5;
    const bag = mk(bagDef.id); bag.durability = 0;
    const gun = mk('wpn_ar');
    const stats = inv.getStats(gun);
    gun.durability = stats.maxDurability;
    const worn = mk('wpn_ar'); worn.durability = Math.round(inv.getStats(worn).maxDurability * 0.1);
    // a plain 1×1 item that never stacks (a stackable one would merge into the starter stash stack and lose its uid)
    const plainDef = defs.find((d) => d.stackMax === 1 && !((d.durabilityMax ?? 0) > 0) && !d.weaponId && !d.bag && !d.armorId && !d.attachment
      && !d.implant && !d.pouch && !d.meal && !d.retired && d.width === 1 && d.height === 1);
    const scrap = mk(plainDef.id), scrap2 = mk(plainDef.id), scrap3 = mk(plainDef.id);
    const accepted = Array.isArray(stats.sockets) ? [...stats.sockets] : ['muzzle', 'grip', 'mag', 'stock', 'sight'];
    let att = null;
    for (const d of defs) {
      if (!d.attachment || d.retired || !accepted.includes(d.attachment.socket) || d.width * d.height > 2) continue;
      const a = mk(d.id);
      if (loot.canAttach(gun, a)) { att = a; break; }
    }
    const added = [armor, bag, gun, worn, scrap, scrap2, scrap3, att].map((it) => it && inv.tryAddToStash(it));
    const attached = !!att && inv.attachToWeapon(gun.uid, att.uid);
    const attDef = att ? loot.getItemDef(att.defId) : null;
    return {
      armor: armor.uid, armorDef: armorDef.id, armorMax: armorDef.durabilityMax, bag: bag.uid, gun: gun.uid, worn: worn.uid,
      scrap: scrap.uid, scrap2: scrap2.uid, scrap3: scrap3.uid, att: att?.uid ?? null, attDef: att?.defId ?? null, attName: attDef?.name ?? '',
      socket: attDef?.attachment?.socket ?? null, accepted, attached, added,
    };
  });
  ok(S.added.every(Boolean) && S.attached && !!S.socket, 'test items in the 창고, an attachment socketed into the 돌격소총', JSON.stringify(S));
  await openInv();

  /* ── 1. durability gauges ──────────────────────────────────────────────────────────────────────────────────────── */
  console.log('durability gauges');
  const G = await page.evaluate((s) => {
    const rgb = (str) => {
      const m = String(str).match(/-?[\d.]+/g);
      if (!m) return null;
      let v = m.map(Number).slice(0, 3);
      if (/^color\(/.test(str)) v = v.map((x) => x * 255);
      return v.map((x) => Math.round(x));
    };
    const info = (uid) => {
      const t = document.querySelector(`.inv-grid-stash .inv-tile[data-uid="${uid}"]`);
      if (!t) return null;
      const bar = t.querySelector('.inv-tile-dur');
      const fill = bar?.querySelector('.inv-dur-fill');
      const cs = fill ? getComputedStyle(fill).backgroundColor : '';
      return {
        bar: !!bar, ratio: bar ? Number(bar.dataset.ratio) : null, broken: !!bar?.classList.contains('is-broken'), color: fill ? rgb(cs) : null, raw: cs,
        fillFrac: fill ? fill.getBoundingClientRect().width / Math.max(1, bar.getBoundingClientRect().width) : null,
        number: /\d+\s*\/\s*\d+/.test(t.textContent ?? ''), pips: t.querySelectorAll('.inv-pip').length,
      };
    };
    const inv = window.__game.ctx.inventory;
    const standalone = inv.buildItemTile(s.armorDef, 1, { durability: s.armorMax * 0.25 });
    return {
      armor: info(s.armor), bag: info(s.bag), gun: info(s.gun), worn: info(s.worn), scrap: info(s.scrap),
      slotDurNums: document.querySelectorAll('.inv-slot-durnum').length,
      slotGauges: document.querySelectorAll('.inv-slot-card .inv-slot-dur .inv-dur-fill').length,
      slotNumbers: [...document.querySelectorAll('.inv-slot-card')].filter((c) => !c.classList.contains('is-weapon') && /\d+\s*\/\s*\d+/.test(c.textContent ?? '')).length,
      standalone: standalone.querySelector('.inv-tile-dur')?.dataset.ratio ?? null,
    };
  }, S);
  const c = (o) => o?.color ?? [0, 0, 0];
  ok(G.armor?.bar && Math.abs(G.armor.ratio - 0.5) < 0.01 && !G.armor.number, '방탄복 50 % in the 창고 wears a gauge (before it is equipped), no number', JSON.stringify(G.armor));
  ok(c(G.armor)[0] > 220 && c(G.armor)[1] > 150 && c(G.armor)[1] < 200 && c(G.armor)[2] < 95, '50 % = between yellow and orange', JSON.stringify(G.armor));
  ok(G.gun?.bar && G.gun.ratio === 1 && c(G.gun)[1] > 185 && c(G.gun)[0] < 120 && Math.abs(G.gun.fillFrac - 1) < 0.05, 'full weapon = a full green gauge', JSON.stringify(G.gun));
  ok(G.worn?.bar && G.worn.ratio < 0.12 && c(G.worn)[0] > 235 && c(G.worn)[1] < 125, '10 % weapon = red-orange gauge', JSON.stringify(G.worn));
  // a 가방 at 0 keeps working (C-36) — an empty gauge, but not the red 파손 look a broken weapon / 방탄복 gets
  ok(G.bag?.bar && !G.bag.broken && G.bag.fillFrac < 0.05 && G.bag.ratio === 0, '가방 at 0 = an empty gauge, not marked broken', JSON.stringify(G.bag));
  ok(G.scrap && !G.scrap.bar, 'an item without durability has no gauge', JSON.stringify(G.scrap));
  ok(G.gun?.pips === S.accepted.length, `weapon tile pips = the accepted sockets (${S.accepted.join(',')})`, JSON.stringify(G.gun));
  ok(G.slotDurNums === 0 && G.slotNumbers === 0 && G.slotGauges >= 1, 'equipment slot cards: gauge, no durability number', JSON.stringify(G));
  ok(G.standalone === '0.250', '`buildItemTile` (기업 화면 타일) carries the gauge too', String(G.standalone));
  if (SHOT_DIR) {
    try {
      mkdirSync(SHOT_DIR, { recursive: true });
      const clip = await page.evaluate((uid) => {
        const t = document.querySelector(`.inv-grid-stash .inv-tile[data-uid="${uid}"]`);
        t?.scrollIntoView({ block: 'center' });
        const p = document.querySelector('.inv-panel-stash').getBoundingClientRect();
        return { x: Math.max(0, p.left), y: Math.max(0, p.top), width: Math.min(p.width, innerWidth - p.left), height: Math.min(p.height, innerHeight - p.top) };
      }, S.armor);
      await page.screenshot({ path: `${SHOT_DIR}/tip-pin-gauges.png`, clip });
    } catch (e) { note(`gauge screenshot failed: ${e}`); }
  }

  /* ── 2. hold → ring → pin ───────────────────────────────────────────────────────────────────────────────────────── */
  console.log('hold → pin');
  const gc = await center(tileSel('stash', S.gun));
  await page.mouse.move(gc.x, gc.y);
  await page.mouse.down();
  await sleep(450);
  const mid = await page.evaluate(() => ({
    ring: !!document.querySelector('.cursor-hold.show'), holding: window.__game.getSystem('inventory').ui.pin.isHolding,
    last: window.__ev['ui:cursorHold'].slice(-1)[0] ?? null, pinned: window.__game.getSystem('inventory').ui.pin.isPinned,
  }));
  ok(mid.ring && mid.holding && !mid.pinned && mid.last && mid.last.progress > 0.2 && mid.last.progress < 0.9 && Math.abs(mid.last.x - gc.x) < 2,
    'holding still: the cursor ring shows and fills (`ui:cursorHold` with the cursor position)', JSON.stringify(mid));
  await sleep(HOLD_MS - 450);
  const p1 = await pinState();
  ok(p1.pinned && p1.uid === S.gun && p1.shown && p1.cardUid === S.gun && p1.diamond && !p1.ring && !p1.holding,
    'ring full → the weapon card pins with the diamond, the ring goes', JSON.stringify(p1));
  ok(!p1.floating, 'no second (floating) copy of the pinned card', JSON.stringify(p1));
  await page.mouse.up();
  await page.mouse.move(gc.x + 140, gc.y + 70, { steps: 5 });
  await sleep(120);
  const p2 = await pinState();
  ok(p2.pinned && p2.transform === p1.transform && p2.transform !== '', 'the pinned card stays where it is when the cursor moves', `${p1.transform} → ${p2.transform}`);
  const tipEv = await page.evaluate(() => window.__ev['ui:tipPinned'].slice(-1)[0]);
  ok(tipEv?.uid === S.gun, '`ui:tipPinned` names the pinned item', JSON.stringify(tipEv));
  if (SHOT_DIR) {
    try {
      const clip = await page.evaluate(() => {
        const r = document.querySelector('.inv-root .inv-tooltip.is-pinned').getBoundingClientRect();
        return { x: Math.max(0, r.left - 12), y: Math.max(0, r.top - 12), width: r.width + 24, height: r.height + 24 };
      });
      await page.screenshot({ path: `${SHOT_DIR}/tip-pin-weapon.png`, clip });
    } catch (e) { note(`card screenshot failed: ${e}`); }
  }
  // hovering another item while pinned: the normal floating card for that item
  const otherTile = await page.evaluate((s) => {
    const card = document.querySelector('.inv-root .inv-tooltip.is-pinned').getBoundingClientRect();
    for (const uid of [s.scrap, s.armor, s.worn, s.scrap2]) {
      const t = document.querySelector(`.inv-grid-stash .inv-tile[data-uid="${uid}"]`);
      if (!t) continue;
      const r = t.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x > card.left - 20 && x < card.right + 20 && y > card.top - 20 && y < card.bottom + 20) continue;
      if (y < 40 || y > innerHeight - 40) continue;
      return { uid, x, y };
    }
    return null;
  }, S);
  if (otherTile) {
    await page.mouse.move(otherTile.x, otherTile.y, { steps: 4 });
    await sleep(150);
    const p3 = await pinState();
    ok(p3.pinned && p3.floating && p3.uid === S.gun, 'hovering another item while pinned shows its floating card (compare), the pin stays', JSON.stringify(p3));
  } else note('no other tile outside the pinned card — floating compare check skipped');

  /* ── 3. unpin: outside press · diamond · Escape ────────────────────────────────────────────────────────────────── */
  console.log('unpin');
  const out = await outsidePoint();
  if (out) {
    await page.mouse.click(out.x, out.y);
    await sleep(120);
    const u1 = await pinState();
    ok(!u1.pinned && !u1.shown && u1.open, `a press outside the card unpins (${out.sel})`, JSON.stringify(u1));
  } else ok(false, 'found a point outside the pinned card');

  await holdPin(tileSel('stash', S.gun));
  const d0 = await pinState();
  const dia = await spot('.inv-root .inv-tooltip.is-pinned .inv-tt-pin');
  ok(d0.pinned && !!dia, 'pinned again');
  if (dia) {
    await page.mouse.click(dia.x, dia.y);
    await sleep(120);
    const u2 = await pinState();
    ok(!u2.pinned && !u2.shown && u2.open, 'pressing the diamond unpins', JSON.stringify(u2));
  }

  await holdPin(tileSel('stash', S.gun));
  const e0 = await pinState();
  ok(e0.pinned && /tipPin/.test(e0.escTop ?? ''), 'the pin is the top `ctx.escape` entry', JSON.stringify(e0));
  await page.keyboard.press('Escape');
  await waitOk(page, () => !window.__game.getSystem('inventory').ui.pin.isPinned, 'Escape unpins', 5000);
  const e1 = await pinState();
  ok(e1.open && !e1.shown, 'Escape closed only the pin — the inventory window stays open', JSON.stringify(e1));

  /* ── 4. short press = click · moved press = drag ───────────────────────────────────────────────────────────────── */
  console.log('click · drag semantics');
  const before = await page.evaluate((uid) => { const p = window.__game.getSystem('inventory').getStash().get(uid); return p ? `${p.x},${p.y}` : null; }, S.armor);
  const ac = await center(tileSel('stash', S.armor));
  await page.mouse.move(ac.x, ac.y);
  await page.mouse.down();
  await sleep(300);
  await page.mouse.up();
  await sleep(900);
  const click = await page.evaluate((uid) => {
    const sys = window.__game.getSystem('inventory'); const p = sys.getStash().get(uid);
    return { pinned: sys.ui.pin.isPinned, holding: sys.ui.pin.isHolding, ring: !!document.querySelector('.cursor-hold.show'), at: p ? `${p.x},${p.y}` : null, drag: !!sys.ui.drag };
  }, S.armor);
  ok(!click.pinned && !click.holding && !click.ring && !click.drag && click.at === before, 'a short press (released before full) is a plain click — nothing pins, nothing moves', JSON.stringify(click));

  const s3 = await center(tileSel('stash', S.scrap3));
  await page.mouse.click(s3.x, s3.y, { count: 2 });   // puppeteer ≥ 22: `count` = two real clicks (`clickCount` is only the event detail)
  await waitOk(page, (uid) => window.__game.getSystem('inventory').getGrid('bag').has(uid), 'double-click still quick-moves (창고 → 가방)', 5000, S.scrap3);

  const bagCell = await page.evaluate((uid) => {
    const sys = window.__game.getSystem('inventory');
    const item = sys.getStash().get(uid)?.item;
    const g = sys.getGrid('bag'); const el = document.querySelector('.inv-grid-bag');
    const spot = item && g.findFreeSlot(item, false);
    if (!spot) return null;
    el.parentElement.scrollTop = Math.max(0, spot.y * 56 - 40);
    const r = el.getBoundingClientRect();
    return { x: r.left + spot.x * 56 + 27, y: r.top + spot.y * 56 + 27, spot };
  }, S.scrap);
  const sc = await center(tileSel('stash', S.scrap));
  await page.mouse.move(sc.x, sc.y);
  await page.mouse.down();
  await sleep(120);
  await page.mouse.move(sc.x + 30, sc.y + 10, { steps: 4 });
  const dragging = await page.evaluate(() => {
    const ui = window.__game.getSystem('inventory').ui;
    return { started: !!ui.drag?.started, holding: ui.pin.isHolding, ring: !!document.querySelector('.cursor-hold.show') };
  });
  ok(dragging.started && !dragging.holding && !dragging.ring, 'moving past the threshold before the ring is full = a normal drag, the ring cancels', JSON.stringify(dragging));
  if (bagCell) await page.mouse.move(bagCell.x, bagCell.y, { steps: 8 });
  await sleep(60);
  await page.mouse.up();
  await sleep(1300);
  const dropped = await page.evaluate((uid) => { const sys = window.__game.getSystem('inventory'); return { bag: sys.getGrid('bag').has(uid), pinned: sys.ui.pin.isPinned }; }, S.scrap);
  ok(!!bagCell && dropped.bag && !dropped.pinned, 'the drag lands in the bag and nothing pins afterwards', JSON.stringify({ bagCell, dropped }));

  /* ── 5. sockets of the pinned weapon card ──────────────────────────────────────────────────────────────────────── */
  console.log('pinned weapon sockets');
  const sockSel = (s) => `.inv-root .inv-tooltip.is-pinned .inv-tt-sock[data-socket="${s}"]`;
  await holdPin(tileSel('stash', S.gun));
  const row = await page.evaluate((s) => {
    const card = document.querySelector('.inv-root .inv-tooltip.is-pinned');
    const r = card?.querySelector('.inv-tt-sockets');
    const squares = [...(r?.querySelectorAll('.inv-tt-sock') ?? [])];
    const rr = r?.getBoundingClientRect(), first = squares[0]?.getBoundingClientRect(), last = squares.at(-1)?.getBoundingClientRect();
    return {
      n: squares.length, ids: squares.map((q) => q.dataset.socket), justify: r ? getComputedStyle(r).justifyContent : '',
      leftGap: rr && first ? first.left - rr.left : null, rightGap: rr && last ? rr.right - last.right : null,
      filled: !!card?.querySelector(`.inv-tt-sock[data-socket="${s.socket}"].is-filled.can-detach`),
      caps: squares.filter((q) => !q.classList.contains('is-filled')).map((q) => q.querySelector('.cap')?.textContent ?? ''),
    };
  }, S);
  ok(row.n === S.accepted.length && JSON.stringify(row.ids) === JSON.stringify(S.accepted), 'the card lists only the accepted sockets', JSON.stringify(row));
  ok(row.justify === 'center' && row.leftGap !== null && Math.abs(row.leftGap - row.rightGap) < 3, 'the socket row is centred', JSON.stringify(row));
  ok(row.filled && row.caps.every((t) => t.length >= 2) && (!S.accepted.includes('stock') || S.socket === 'stock' || row.caps.includes('개머리판')),
    'filled socket is draggable; empty ones show the full Korean socket name', JSON.stringify(row));

  const sq = await spot(sockSel(S.socket));
  await page.mouse.move(sq.x - 30, sq.y, { steps: 2 });
  await page.mouse.move(sq.x, sq.y, { steps: 3 });
  await sleep(150);
  const hov = await pinState();
  ok(hov.pinned && hov.floating && hov.floatingName === S.attName, 'hovering the socket shows the attachment\'s own card', JSON.stringify(hov));

  /** Free (or occupied) cell of `grid` for the attachment, scrolled visible, pointer outside the pinned card. */
  const cellFor = (grid, free) => page.evaluate((a) => {
    const sys = window.__game.getSystem('inventory');
    const weapon = sys.locate(a.gun)?.item;
    const att = weapon?.sockets?.[a.socket] ?? sys.locate(a.att)?.item;
    const def = att && window.__game.ctx.loot.getItemDef(att.defId);
    const g = sys.getGrid(a.grid), gridEl = document.querySelector(`.inv-grid-${a.grid}`);
    if (!att || !def || !g || !gridEl) return null;
    const scroller = gridEl.parentElement;
    const card = document.querySelector('.inv-root .inv-tooltip.is-pinned');
    const cr = card && !card.hidden ? card.getBoundingClientRect() : null;
    const w = att.rotated ? def.height : def.width, h = att.rotated ? def.width : def.height;
    const half = { w: (w * 56 - 2) / 2, h: (h * 56 - 2) / 2 };
    const cands = [];
    if (a.free) { for (let y = 0; y + h <= g.rows; y++) for (let x = 0; x + w <= g.cols; x++) if (g.canPlace(att, x, y, att.rotated)) cands.push({ x, y }); }
    else for (const p of g.items()) { if (p.item.uid !== a.gun && p.x + w <= g.cols && p.y + h <= g.rows) cands.push({ x: p.x, y: p.y }); }
    const vis = (px, py) => { const v = scroller.getBoundingClientRect(); return px > v.left + 4 && px < v.right - 4 && py > Math.max(v.top, 40) + 4 && py < Math.min(v.bottom, innerHeight - 40) - 4; };
    const clear = (px, py) => !cr || px < cr.left - 10 || px > cr.right + 10 || py < cr.top - 10 || py > cr.bottom + 10;
    for (const cand of cands) {
      let r = gridEl.getBoundingClientRect();
      let px = r.left + cand.x * 56 + half.w, py = r.top + cand.y * 56 + half.h;
      if (!vis(px, py)) {
        const v = scroller.getBoundingClientRect();
        scroller.scrollTop += py - (v.top + scroller.clientHeight / 2);
        r = gridEl.getBoundingClientRect();
        px = r.left + cand.x * 56 + half.w; py = r.top + cand.y * 56 + half.h;
      }
      if (vis(px, py) && clear(px, py)) return { x: cand.x, y: cand.y, px, py };
    }
    return null;
  }, { ...S, grid, free });
  const dragSocket = async (target) => {
    const from = await spot(sockSel(S.socket));
    await page.mouse.move(from.x, from.y, { steps: 2 });
    await page.mouse.down();
    await page.mouse.move(from.x + 14, from.y + 14, { steps: 3 });
    await page.mouse.move(target.px, target.py, { steps: 12 });
    await sleep(100);
    const midDrag = await page.evaluate(() => {
      const g = document.querySelector('.inv-ghost-layer .inv-sock-ghost');
      return { ghost: !!g, ok: !!g?.classList.contains('is-ok'), bad: !!g?.classList.contains('is-bad'), dragging: window.__game.getSystem('inventory').ui.pin.isSocketDragging };
    });
    await page.mouse.up();
    await sleep(150);
    return midDrag;
  };
  const socketOf = () => page.evaluate((a) => {
    const sys = window.__game.getSystem('inventory');
    const w = sys.locate(a.gun)?.item;
    const loc = sys.locate(a.att);
    const card = document.querySelector('.inv-root .inv-tooltip.is-pinned');
    return {
      attached: w?.sockets?.[a.socket]?.uid === a.att, where: loc ? (loc.from.grid ?? loc.from.kind) : null, pinned: sys.ui.pin.isPinned,
      cardFilled: !!card?.querySelector(`.inv-tt-sock[data-socket="${a.socket}"].is-filled`), ghostLeft: !!document.querySelector('.inv-sock-ghost'),
      ev: window.__ev['inventory:socketChanged'].slice(-1)[0] ?? null,
    };
  }, S);

  const toBag = await cellFor('bag', true);
  ok(!!toBag, 'found a free bag cell outside the card', JSON.stringify(toBag));
  if (toBag) {
    const m1 = await dragSocket(toBag);
    ok(m1.ghost && m1.ok && m1.dragging, 'dragging the attachment out: green ghost over a free bag cell', JSON.stringify(m1));
    const r1 = await socketOf();
    ok(!r1.attached && r1.where === 'bag' && r1.pinned && !r1.cardFilled && !r1.ghostLeft,
      'dropped: the socket is empty, the attachment is in the bag, the pinned card redrew', JSON.stringify(r1));
    ok(r1.ev?.weapon === S.gun && r1.ev.socket === S.socket && r1.ev.attachment === null, '`inventory:socketChanged` with attachment null', JSON.stringify(r1.ev));
  }

  // back in, then onto an occupied bag cell — refused, nothing lost
  await page.evaluate((a) => window.__game.ctx.inventory.attachToWeapon(a.gun, a.att), S);
  await sleep(150);
  const reAttached = await socketOf();
  ok(reAttached.attached && reAttached.cardFilled, 're-attached through the API: the pinned card shows it again', JSON.stringify(reAttached));
  const occupied = await cellFor('bag', false);
  if (occupied) {
    const m2 = await dragSocket(occupied);
    ok(m2.ghost && m2.bad && !m2.ok, 'over an occupied bag cell the ghost is red', JSON.stringify(m2));
    const r2 = await socketOf();
    ok(r2.attached && r2.cardFilled, 'released on an occupied cell: refused, the attachment stays in its socket', JSON.stringify(r2));
  } else note('no occupied bag cell outside the card — refusal drag skipped');

  const toStash = await cellFor('stash', true);
  if (toStash) {
    const m3 = await dragSocket(toStash);
    const r3 = await socketOf();
    ok(m3.ok && !r3.attached && r3.where === 'stash', 'dragged out into a free 창고 cell', JSON.stringify({ m3, r3 }));
  } else ok(false, 'found a free 창고 cell outside the card');
  const api = await page.evaluate((a) => {
    const inv = window.__game.ctx.inventory;
    const re = inv.attachToWeapon(a.gun, a.att);
    const world = inv.detachSocket(a.gun, a.socket, { kind: 'world' });
    const still = window.__game.getSystem('inventory').locate(a.gun)?.item.sockets?.[a.socket]?.uid === a.att;
    return { re, world, still, can: inv.canDetachSockets(a.gun) };
  }, S);
  ok(api.re && api.world === 'fail' && api.still && api.can, 'API: no world drop in the ship (refused, still attached)', JSON.stringify(api));

  /* ── 6. item vanishes · window closes ──────────────────────────────────────────────────────────────────────────── */
  console.log('unpin on vanish / close');
  await page.keyboard.press('Escape');
  await sleep(200);
  await holdPin(tileSel('stash', S.scrap2));
  const v0 = await pinState();
  ok(v0.pinned && v0.uid === S.scrap2, 'pinned a stack');
  await page.evaluate((uid) => { const sys = window.__game.getSystem('inventory'); sys.getStash().remove(uid); sys.afterChange(); }, S.scrap2);
  await waitOk(page, () => !window.__game.getSystem('inventory').ui.pin.isPinned, 'the item disappearing unpins its card', 3000);
  await holdPin(tileSel('stash', S.armor));
  const w0 = await pinState();
  ok(w0.pinned, 'pinned the 방탄복');
  await page.evaluate(() => window.__game.getSystem('inventory').toggleBag());
  await sleep(300);
  const w1 = await pinState();
  ok(!w1.pinned && !w1.shown && !w1.open, 'closing the window unpins', JSON.stringify(w1));

  /* ── 7. a weapon in an open crate: hover only ──────────────────────────────────────────────────────────────────── */
  console.log('crate weapon');
  const crate = await page.evaluate((a) => {
    const ctx = window.__game.ctx, loot = ctx.loot;
    const w2 = loot.createItem('wpn_ar', 1);
    const a2 = loot.createItem(a.attDef, 1);
    w2.sockets = { [a.socket]: a2 };
    ctx.inventory.openContainerItems('smoke-tip-pin-crate', [w2], ctx.player.position.clone(), '시험 상자');
    return { uid: w2.uid };
  }, S);
  let crateReady = false;
  try {
    await waitFor(page, (uid) => {
      const sys = window.__game.getSystem('inventory');
      return sys._open && sys.getActiveContainer()?.grid.has(uid) && sys.unsearchedCount() === 0 && !!document.querySelector(`.inv-grid-container .inv-tile[data-uid="${uid}"]`);
    }, 'crate searched', 25000, crate.uid);
    crateReady = true;
  } catch { note('the crate did not finish its search in time — crate checks skipped'); }
  if (crateReady) {
    await holdPin(tileSel('container', crate.uid));
    const cz = await page.evaluate((a) => {
      const sys = window.__game.getSystem('inventory');
      const card = document.querySelector('.inv-root .inv-tooltip.is-pinned');
      return {
        pinned: sys.ui.pin.pinnedUid === a.uid, filled: !!card?.querySelector('.inv-tt-sock.is-filled'), draggable: !!card?.querySelector('.inv-tt-sock.can-detach'),
        can: window.__game.ctx.inventory.canDetachSockets(a.uid),
      };
    }, crate);
    ok(cz.pinned && cz.filled && !cz.draggable && !cz.can, 'a crate weapon pins, shows its socket, but nothing is draggable (API says no)', JSON.stringify(cz));
    const csq = await spot('.inv-root .inv-tooltip.is-pinned .inv-tt-sock.is-filled');
    if (csq) {
      await page.mouse.move(csq.x, csq.y, { steps: 3 });
      await page.mouse.down();
      await page.mouse.move(csq.x + 120, csq.y + 60, { steps: 8 });
      const noGhost = await page.evaluate(() => !document.querySelector('.inv-sock-ghost') && !window.__game.getSystem('inventory').ui.pin.isSocketDragging);
      await page.mouse.up();
      ok(noGhost, 'pressing a crate weapon\'s socket does not start a drag');
    }
    await page.evaluate(() => window.__game.getSystem('inventory').closeAll());
    await sleep(250);
  }

  /* ── 8. TradeGrids (기업 tab) ──────────────────────────────────────────────────────────────────────────────────── */
  console.log('TradeGrids pin');
  await openInv();
  const corpOk = await page.evaluate(() => window.__game.getSystem('inventory').ui.showScreenTab('corp'));
  let tgTile = null;
  if (corpOk) {
    try {
      tgTile = await waitFor(page, () => {
        for (const t of document.querySelectorAll('.inv-screen .trade-grids [data-tg-grid="stash"] .inv-tile[data-uid]')) {
          t.scrollIntoView({ block: 'center' });
          const r = t.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          if (r.width > 0 && document.elementFromPoint(x, y)?.closest('.inv-tile') === t) return { uid: t.dataset.uid, x, y };
        }
        return null;
      }, 'a 기업 화면 창고 tile', 10000);
    } catch { note('no TradeGrids tile reachable on the 기업 tab — TradeGrids checks skipped'); }
  } else note('the 기업 tab is unavailable — TradeGrids checks skipped');
  if (tgTile) {
    await page.mouse.move(tgTile.x, tgTile.y);
    await page.mouse.down();
    await sleep(HOLD_MS);
    await page.mouse.move(tgTile.x + 2, tgTile.y + 1);
    await sleep(150);
    const t1 = await page.evaluate((uid) => {
      const card = document.querySelector('#ui-root > .inv-tooltip.tg-tip.is-pinned') ?? document.querySelector('.inv-tooltip.tg-tip.is-pinned');
      const tile = document.querySelector(`.trade-grids .inv-tile[data-uid="${uid}"]`);
      return { shown: !!card && !card.hidden, uid: card?.dataset.uid ?? null, flagged: tile?.dataset.tipPinned !== undefined, itemTip: window.__game.getSystem('hud').itemTipDefId };
    }, tgTile.uid);
    await page.mouse.up();
    ok(t1.shown && t1.uid === tgTile.uid && t1.flagged && t1.itemTip === null, 'TradeGrids: a hold pins the inventory card on #ui-root, the tile opts out of ItemTip', JSON.stringify(t1));
    await page.keyboard.press('Escape');
    await waitOk(page, () => { const c = document.querySelector('.inv-tooltip.tg-tip.is-pinned'); return !c || c.hidden; }, 'TradeGrids: Escape unpins', 5000);
    const still = await page.evaluate(() => window.__game.getSystem('inventory').screenTab);
    ok(still === 'corp', 'the 기업 tab is still showing after that Escape', still);
    await page.mouse.move(tgTile.x, tgTile.y);
    await page.mouse.down();
    await page.mouse.move(tgTile.x + 40, tgTile.y + 12, { steps: 5 });
    await sleep(80);
    const lifted = await page.evaluate(() => !!document.querySelector('.tg-ghost'));
    await page.mouse.move(tgTile.x, tgTile.y, { steps: 4 });
    await page.mouse.up();
    ok(lifted, 'TradeGrids: a moved press still lifts the drag ghost');
  }

  const fatal = errors.filter((e) => !/WebSocket|ws:\/\/|net::ERR|Failed to load resource|favicon/i.test(e));
  ok(fatal.length === 0, 'no page errors', JSON.stringify(fatal.slice(0, 5)));
} catch (e) {
  fail++;
  console.log(`  FAIL crashed: ${e?.stack ?? e}`);
} finally {
  await browser.close();
}
console.log(`\nsmoke-tip-pin: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
