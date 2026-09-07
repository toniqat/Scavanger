// Screenshot-only helper for the 2026-09-07 UI/UX pass: 캐릭터 3열 + 임플란트 picker, 제작 열 (함선 / 레이드),
// 기업 화면 (거래 / 계약 / 퀘스트). Writes PNGs to scripts/shots/uiux-*.png — no assertions, no exit code.
// Usage: node scripts/shots-uiux.mjs [http://localhost:5273/]   (needs `npm run dev`)
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const BASE = process.argv.slice(2).find((a) => a.startsWith('http')) ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
mkdirSync('scripts/shots', { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--window-size=1920,1080', '--no-sandbox'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.evaluateOnNewDocument(() => {
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  page.on('pageerror', (e) => console.log('  pageerror', String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 200 && !(await page.evaluate(() => !!window.__game?.ctx)); i++) await sleep(80);
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
  });
  const shot = async (n) => { await page.screenshot({ path: `scripts/shots/uiux-${n}.png` }); console.log('  shot', n); };
  const tab = (label) => page.evaluate((l) => [...document.querySelectorAll('.inv-root .scr-tab')].find((b) => b.textContent === l)?.click(), label);

  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await sleep(1200);

  /* 1. 캐릭터 탭 3열 + 임플란트 picker */
  await page.evaluate(() => window.__game.ctx.inventory.toggleBag());
  await sleep(400);
  await shot('01-ship-inventory');
  await tab('캐릭터');
  await sleep(400);
  await shot('02-character-3col');
  await page.evaluate(() => document.querySelector('.inv-screen .cs-imp-slot')?.click());
  await sleep(300);
  await shot('03-implant-picker');
  await page.evaluate(() => document.querySelector('.cs-imp-pop-embed .cs-imp-card[data-id="dash"]')?.click());
  await sleep(200);

  /* 2. 기업 탭 */
  await tab('기업');
  await sleep(500);
  await page.evaluate(() => { const m = window.__game.ctx.meta; m.addCredits(20000, 'shot'); m.addRep('helix', 900, 'shot'); });
  await sleep(300);
  await page.evaluate(() => document.querySelector('.corp-tab[data-corp="helix"]')?.click());
  await sleep(300);
  await shot('04-corp-trade');
  await page.evaluate(() => {
    for (const c of [...document.querySelectorAll('.ct-shop-list .ct-cell.shop.is-draggable')].slice(0, 3)) c.click();
    const inv = window.__game.ctx.inventory;
    const first = inv.getAllItems()[0];
    return first?.uid;
  });
  await sleep(300);
  await shot('05-corp-trade-staged');
  await page.evaluate(() => document.querySelector('.corp-subtabs .scr-tab[data-page="contracts"]')?.click());
  await sleep(300);
  await shot('06-corp-contracts');
  await page.evaluate(() => document.querySelector('.corp-subtabs .scr-tab[data-page="quests"]')?.click());
  await sleep(300);
  await shot('07-corp-quests');

  /* 3. 제작 열 (함선) */
  await tab('인벤토리');
  await sleep(300);
  await page.evaluate(() => window.__game.ctx.inventory.openBenchCraft('gun', 2));
  await sleep(500);
  await shot('08-craft-ship');
  await page.evaluate(() => window.__game.getSystem('inventory').closeBench());
  await sleep(200);
  await page.evaluate(() => window.__game.ctx.inventory.closeAll());
  await sleep(200);

  /* 4. 제작 열 (레이드) */
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 12345 }));
  await sleep(2500);
  await page.evaluate(() => window.__game.ctx.inventory.toggleBag());
  await sleep(400);
  await page.evaluate(() => window.__game.getSystem('inventory')['ui'].toggleCraft());
  await sleep(500);
  await shot('09-craft-raid');
} finally {
  await browser.close();
}
