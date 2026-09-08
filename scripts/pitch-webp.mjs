// WebP encoder for the pitch wiki (docs/pitch/assets/).
// The pitch site is served as-is (GitHub Pages, no build step), so the *files in the repo* are what
// a visitor downloads — 30 MB of PNG screenshots is a slow first paint over mobile. This writes a
// `<name>.webp` next to every `<name>.png`; `docs/pitch/app.js` probes the .webp first and falls back
// to the .png, so the PNGs stay in the repo as the originals (and as what `shots-pitch.mjs` writes).
//
// No new dependency: the encoding is done by the same local Chrome the shot scripts already drive
// (canvas.toDataURL('image/webp')). ImageMagick/cwebp/sharp are not installed, and on Windows
// `convert` is the FAT->NTFS tool, not ImageMagick.
//
// Usage:  node scripts/pitch-webp.mjs [--quality 0.85] [--force] [name ...]
//         (extra names filter which files run, e.g. `node scripts/pitch-webp.mjs planet-amber`)
import puppeteer from 'puppeteer-core';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const qi = argv.indexOf('--quality');
const QUALITY = qi >= 0 ? Number(argv[qi + 1]) : 0.85;
const ONLY = new Set(argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--quality'));
const DIR = 'docs/pitch/assets';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }

const kb = (n) => (n / 1024).toFixed(0).padStart(5) + ' KB';

/* .png 하나마다 같은 이름의 .webp — 원본이 더 새것일 때만 다시 만든다 (--force 로 무시) */
const jobs = readdirSync(DIR)
  .filter((f) => f.toLowerCase().endsWith('.png'))
  .filter((f) => !ONLY.size || ONLY.has(f.replace(/\.png$/i, '')))
  .map((f) => ({ png: join(DIR, f), webp: join(DIR, f.replace(/\.png$/i, '.webp')), name: f }))
  .filter((j) => FORCE || !existsSync(j.webp) || statSync(j.png).mtimeMs > statSync(j.webp).mtimeMs);

if (!jobs.length) { console.log('nothing to do (모든 .png 에 최신 .webp 가 있다)'); process.exit(0); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
let before = 0, after = 0, wrote = 0, skipped = 0;

try {
  const page = await browser.newPage();
  await page.goto('about:blank');

  for (const j of jobs) {
    const src = readFileSync(j.png);
    /* PNG 를 data: URL 로 넘긴다 — file:// 이미지는 캔버스를 오염시켜 toDataURL 이 막힌다 */
    const out = await page.evaluate(async (b64, quality) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      const url = c.toDataURL('image/webp', quality);
      if (!url.startsWith('data:image/webp')) throw new Error('webp encoding unsupported');
      return { b64: url.slice(url.indexOf(',') + 1), w: c.width, h: c.height };
    }, src.toString('base64'), QUALITY);

    const buf = Buffer.from(out.b64, 'base64');
    before += src.length;
    /* 더 작을 때만 쓴다 — 아니면 app.js 의 폴백이 원본 .png 를 그대로 쓴다 */
    if (buf.length >= src.length) {
      after += src.length; skipped++;
      console.log(`  skip  ${j.name.padEnd(26)} ${kb(src.length)} → webp 가 더 큼`);
      continue;
    }
    writeFileSync(j.webp, buf);
    after += buf.length; wrote++;
    const pct = (100 - (buf.length / src.length) * 100).toFixed(0);
    console.log(`  ok    ${j.name.padEnd(26)} ${kb(src.length)} → ${kb(buf.length)}  (-${pct}%)  ${out.w}×${out.h}`);
  }
} finally {
  await browser.close();
}

console.log(`\n${wrote} 개 변환${skipped ? `, ${skipped} 개 건너뜀` : ''} — ${kb(before)} → ${kb(after)} ` +
  `(-${(100 - (after / before) * 100).toFixed(0)}%)  quality ${QUALITY}`);
