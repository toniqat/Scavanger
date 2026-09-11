/*
 * smoke-pitch — 피칭 위키(`docs/pitch/`)가 실제로 뜨는지.
 *
 * 이 문서에는 빌드가 없어서 **깨져도 조용하다**: `app.js` 의 `TREE` 순서와 `pages/` 의 파일 번호가
 * 어긋나면 링크가 404 가 되고, `.nextnav` 는 손으로 잇는 값이라 페이지를 끼워 넣으면 끊긴다.
 * 그래서 페이지를 하나하나 열어 본다 — vite 도 게임도 쓰지 않고 `docs/pitch` 를 정적으로 서빙한다.
 *
 *   1. 모든 페이지가 콘솔 오류 없이 뜬다 (`[pitch]` 자기 점검 경고 포함 — 파일 이름 ↔ TREE 불일치가 여기 걸린다).
 *   2. 사이드바가 페이지 전부를 그리고, 열려 있는 페이지에 `a.active` 가 정확히 하나 붙는다.
 *   3. `.nextnav` 의 링크가 실제 파일을 가리킨다.
 *   4. 카드 넘기기 라이트박스(2026-09-10): `.shotrow` 한 벌이 ◀ ▶ 로 넘어가고 양끝에서 되돌며 ESC 로 닫힌다.
 *      `.shotrow` 밖의 단독 이미지에는 넘기기 UI 가 붙지 않는다.
 *
 * 2026-09-11 (C-45): 저장소 경로를 `import.meta.url` 에서 찾고(예전에는 `F:/Project/Scavanger` 절대경로라 다른 PC ·
 * 다른 드라이브에서는 돌지 않았다), Chrome 후보를 다른 스모크와 같은 셋으로 고르고, 포트는 OS 에게 받는다(8123
 * 고정은 병렬 레인과 부딪힌다). 출력은 `verify.mjs` 의 `summarize` 형식 — `FAIL …` 줄 + 마지막 `N passed, M failed`.
 *
 * Usage: node scripts/smoke-pitch.mjs
 */
import puppeteer from 'puppeteer-core';
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
  /* `.nextnav` 는 손으로 잇는 값이다 — 가리키는 파일이 실제로 있는지 본다 */
  for (const href of st.nav) ok(existsSync(join(ROOT, 'pages', href)), `${f} nextnav → 없는 파일`, href);
  /* 아직 안 채운 자리(`.ph`)는 정상이므로 실패가 아니라 셈만 한다 */
  if (missing.length) warns += 1;
  console.log(`  ${errors.length ? '✘' : '✔'} ${f.padEnd(22)} 트리 ${st.tree} · 목차 ${st.toc} · 이미지 ${st.imgs} · 빈자리 ${st.ph}`);
}

/* ── 카드 넘기기 ─────────────────────────────────────────────────────── */
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
  /* 양끝에서 되도는지 */
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

/* 단독 이미지는 넘기기 UI 가 없어야 한다 */
await page.goto(`${ORIGIN}/pages/00-intro.html`, { waitUntil: 'networkidle0' });
const solo = await page.evaluate(async () => {
  const wait = () => new Promise((res) => setTimeout(res, 260));
  const img = document.querySelector('article > figure.shot img');   /* .shotrow 밖 */
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

await b.close();
server.close();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
