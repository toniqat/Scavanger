/*
 * smoke-pitch — whether the pitch wiki (`docs/pitch/`) actually loads.
 *
 * This document has no build step, so **breakage is silent**: when the `TREE` order in `app.js` and the file
 * numbers in `pages/` disagree the links 404, and `.nextnav` is wired by hand, so inserting a page breaks it.
 * So every page is opened one by one — neither vite nor the game is used, `docs/pitch` is served statically.
 *
 *   1. Every page loads with no console error (`[pitch]` self-check warnings included — a file name ↔ TREE
 *      mismatch is caught here).
 *   2. The sidebar draws every page and exactly one `a.active` sits on the open page.
 *   3. The `.nextnav` links point at files that exist.
 *   4. The card-flipping lightbox (2026-09-10): a `.shotrow` set flips with ◀ ▶, wraps at both ends and
 *      closes on ESC. A standalone image outside a `.shotrow` gets no flipping UI.
 *
 * 2026-09-11 (C-45): the repo path is found from `import.meta.url` (it used to be the absolute
 * `F:/Project/Scavanger`, so it did not run on another PC · another drive), the Chrome candidates are the same
 * three every other smoke uses, and the port comes from the OS (a fixed 8123 collides with parallel lanes).
 * The output is `verify.mjs`'s `summarize` shape — `FAIL …` lines plus a final `N passed, M failed`.
 *
 * Usage: node scripts/smoke-pitch.mjs
 */
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../docs/pitch/', import.meta.url));
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp' };
const server = createServer((req, res) => {
  const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!existsSync(p) || !extname(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const b = await puppeteer.launch({
  executablePath: CHROME,
  headless: true, args: ['--no-sandbox', '--window-size=1600,1000'],
});
const page = await b.newPage();
await page.setViewport({ width: 1600, height: 1000 });

let fails = 0, passes = 0, warns = 0;
const ok = (cond, msg, extra) => { if (cond) passes++; else { fails++; console.log(`  FAIL ${msg} ${extra ?? ''}`); } };

const files = readdirSync(join(ROOT, 'pages')).filter((f) => f.endsWith('.html')).sort();
console.log(`페이지 ${files.length}개\n`);
ok(files.length > 0, 'docs/pitch/pages 에 페이지가 하나도 없다', ROOT);

for (const f of files) {
  const errors = [];
  const missing = [];
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.removeAllListeners('requestfailed');
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
  page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('[pitch]')) errors.push(m.text()); });
  page.on('requestfailed', (r) => { const u = r.url(); if (/\.(png|webp)$/.test(u)) missing.push(u.split('/').pop()); });

  await page.goto(`${ORIGIN}/pages/${f}`, { waitUntil: 'networkidle0' });
  const st = await page.evaluate(() => ({
    tree: document.querySelectorAll('#tree a').length,
    toc: document.querySelectorAll('#toc a').length,
    cur: document.querySelectorAll('#tree a.active').length,
    imgs: document.querySelectorAll('figure.shot img').length,
    ph: document.querySelectorAll('figure.shot .ph').length,
    title: document.title,
    nav: [...document.querySelectorAll('.nextnav a')].map((a) => a.getAttribute('href')),
  }));
  ok(errors.length === 0, `${f} JS 오류`, errors.join(' | '));
  ok(st.tree === files.length, `${f} 사이드바 ${st.tree}/${files.length}`);
  ok(st.cur === 1, `${f} 현재 페이지 표시 ${st.cur}`);
  /* `.nextnav` is wired by hand — this checks that the file it points at really exists */
  for (const href of st.nav) ok(existsSync(join(ROOT, 'pages', href)), `${f} nextnav → 없는 파일`, href);
  /* A spot not filled in yet (`.ph`) is normal, so it is only counted, never failed */
  if (missing.length) warns += 1;
  console.log(`  ${errors.length ? '✘' : '✔'} ${f.padEnd(22)} 트리 ${st.tree} · 목차 ${st.toc} · 이미지 ${st.imgs} · 빈자리 ${st.ph}`);
}

/* ── card flipping ──────────────────────────────────────────────── */
console.log('\n카드 넘기기(라이트박스)');
await page.goto(`${ORIGIN}/pages/11-planets.html`, { waitUntil: 'networkidle0' });
const r = await page.evaluate(async () => {
  const wait = () => new Promise((res) => setTimeout(res, 260));
  const imgs = [...document.querySelectorAll('.shotrow figure.shot img')];
  if (imgs.length < 2) return { err: 'shotrow 에 이미지가 둘 미만 (' + imgs.length + ')' };
  imgs[0].click(); await wait();
  const box = document.querySelector('.lb');
  const first = box.querySelector('img').src;
  const multi = box.classList.contains('multi');
  const count = box.querySelector('.count').textContent;
  box.querySelector('.next').click(); await wait();
  const second = box.querySelector('img').src;
  const count2 = box.querySelector('.count').textContent;
  /* whether it wraps at both ends */
  box.querySelector('.prev').click(); await wait();
  box.querySelector('.prev').click(); await wait();
  const wrapped = box.querySelector('.count').textContent;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await wait();
  const closed = !box.classList.contains('on');
  return { n: imgs.length, multi, count, count2, changed: first !== second, wrapped, closed };
});
if (r.err) ok(false, r.err);
else {
  ok(r.multi, '.multi 가 안 붙었다 (화살표가 안 보인다)');
  ok(r.count === '1 / ' + r.n, '장수 표시', r.count);
  ok(r.changed, '▶ 를 눌러도 이미지가 안 바뀐다');
  ok(r.count2 === '2 / ' + r.n, '다음 장 표시', r.count2);
  ok(r.wrapped === r.n + ' / ' + r.n, '양끝 되돌기', r.wrapped);
  ok(r.closed, 'ESC 로 안 닫힌다');
  console.log(`  ✔ 묶음 ${r.n}장 · ${r.count} → ${r.count2} → 되돌아 ${r.wrapped} · ESC 닫힘 ${r.closed}`);
}

/* a standalone image must get no flipping UI */
await page.goto(`${ORIGIN}/pages/00-intro.html`, { waitUntil: 'networkidle0' });
const solo = await page.evaluate(async () => {
  const wait = () => new Promise((res) => setTimeout(res, 260));
  const img = document.querySelector('article > figure.shot img');   /* outside .shotrow */
  if (!img) return { skip: true };
  img.click(); await wait();
  const box = document.querySelector('.lb');
  return { multi: box.classList.contains('multi'), count: box.querySelector('.count').textContent };
});
if (!solo.skip) {
  ok(!solo.multi, '단독 이미지에 넘기기 UI 가 붙었다');
  ok(solo.count === '', '단독 이미지에 장수가 떴다', solo.count);
  console.log(`  ✔ 단독 이미지: 화살표 없음(${!solo.multi}) · 장수 표시 없음`);
}

await closeBrowser(b);
server.close();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
