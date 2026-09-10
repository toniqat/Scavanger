#!/usr/bin/env node
/**
 * `npm run icon` — 앱 아이콘 `electron/resources/icon.ico` 를 **코드에서** 그린다.
 *
 * 이 프로젝트에는 디스크 에셋이 없다 (`CLAUDE.md` §4 — 모델 · 텍스처를 전부 절차 생성한다). 아이콘도 같은
 * 규칙을 따른다: 여기서 SDF 로 그리고 PNG 로 인코딩해 ICO 컨테이너에 담는다. 외부 이미지 라이브러리도,
 * 손으로 만든 원본 파일도 없다 — 모양을 바꾸고 싶으면 `MARK` 의 숫자를 고치고 다시 돌린다.
 *
 * 마크: 어두운 라운드 플레이트 + **주황 육각 링**(HUD 의 재화 칩 · 임플란트 썸네일과 같은 육각) + 그 안의
 * **아래를 향한 갈매기(강하 · 홀드 키캡의 그 화살표)**. 16 px 에서도 구분되도록 요소는 셋으로 끝낸다.
 *
 * 색은 게임의 하이라이트 그대로다 — `src/ui/styles/base.css` 의 `--c-accent` = `#ffb347`.
 *
 * 출력 크기는 `SIZES`. ICO 안의 각 항목은 PNG 이고(Vista 이후 규격) electron-builder · 탐색기 · 작업 표시줄이
 * 모두 그렇게 읽는다. `scripts/build-server.mjs` 와 `scripts/pack-release.mjs` 도 같은 파일을 쓴다.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'electron', 'resources', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** 마크의 비율 (모든 값은 한 변 = 1 기준). 여기만 고치면 모든 크기가 같이 바뀐다. */
const MARK = {
  plateInset: 0.02,      // 플레이트 여백
  plateRadius: 0.17,     // 라운드 코너
  hexRadius: 0.355,      // 육각 링 반지름
  hexThick: 0.055,       // 육각 링 두께
  chevWidth: 0.175,      // 갈매기 반폭
  chevRise: 0.100,       // 갈매기 높이(반)
  chevThick: 0.064,      // 갈매기 두께
  chevDrop: 0.02,        // 갈매기를 중심보다 조금 위로 (시각 중심 보정)
  glow: 0.34,            // 마크 주변 주황 번짐 (0 = 없음)
};

/**
 * 크기별 보정. 16 px 에서 256 px 의 비율을 그대로 쓰면 링과 갈매기가 **한 픽셀 이하**가 되어 뭉개진다
 * (그리고 글로우가 그 한 픽셀을 덮는다). 작은 아이콘은 굵고 크게, 글로우 없이 — 아이콘 작업의 정석이고
 * 작업 표시줄 · 탐색기 목록에서 이 크기가 제일 많이 보인다.
 */
function markFor(size) {
  if (size <= 24) {
    return { ...MARK, plateRadius: 0.14, hexRadius: 0.40, hexThick: 0.105,
      chevWidth: 0.185, chevRise: 0.105, chevThick: 0.105, glow: 0 };
  }
  if (size <= 48) {
    return { ...MARK, plateRadius: 0.155, hexRadius: 0.385, hexThick: 0.078,
      chevWidth: 0.180, chevRise: 0.103, chevThick: 0.080, glow: 0.14 };
  }
  return MARK;
}

const ACCENT = [0xff, 0xb3, 0x47];
const PLATE = [0x0e, 0x11, 0x16];
const PLATE_EDGE = [0x2a, 0x22, 0x14];

/* ── 작은 SDF 모음 (거리 < 0 = 안쪽) ─────────────────────────────────── */
const len = (x, y) => Math.hypot(x, y);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 라운드 사각형. */
function sdRoundRect(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 정육각형 (꼭짓점이 위아래 = pointy-top). iq 의 sdHexagon 을 축만 바꿔 쓴다. */
function sdHexagon(px, py, r) {
  // pointy-top 으로 만들려고 x/y 를 맞바꿔 넣는다.
  let x = Math.abs(py);
  let y = Math.abs(px);
  const kx = -0.866025404, ky = 0.5, kz = 0.577350269;
  const d = Math.min(kx * x + ky * y, 0);
  x -= 2 * d * kx;
  y -= 2 * d * ky;
  x -= clamp(x, -kz * r, kz * r);
  y -= r;
  return len(x, y) * Math.sign(y);
}

/** 선분(캡슐). */
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return len(pax - bax * h, pay - bay * h);
}

/** 한 점의 색 (RGBA 0..255). `u, v` 는 -0.5..0.5, 원점이 가운데. `m` = `markFor(size)`. */
function shade(u, v, m) {
  let r = 0, g = 0, b = 0, a = 0;

  // ① 플레이트
  const plate = sdRoundRect(u, v, 0.5 - m.plateInset, 0.5 - m.plateInset, m.plateRadius);
  if (plate < 0) {
    // 위에서 아래로 아주 옅은 그라데이션 — 단색 사각형보다 물체처럼 보인다.
    const t = clamp(v + 0.5, 0, 1);
    r = PLATE[0] + 10 * (1 - t); g = PLATE[1] + 10 * (1 - t); b = PLATE[2] + 12 * (1 - t);
    a = 255;
    // 플레이트 안쪽 테두리 (따뜻한 선)
    const edge = Math.abs(plate + 0.012) - 0.006;
    if (edge < 0) { r = PLATE_EDGE[0]; g = PLATE_EDGE[1]; b = PLATE_EDGE[2]; }
  }

  // ② 육각 링 + ③ 갈매기 — 둘 다 하이라이트 색, 글로우를 얹는다.
  const ring = Math.abs(sdHexagon(u, v, m.hexRadius)) - m.hexThick * 0.5;
  const cy = v + m.chevDrop;
  const chev = Math.min(
    sdSegment(u, cy, -m.chevWidth, -m.chevRise, 0, m.chevRise),
    sdSegment(u, cy, m.chevWidth, -m.chevRise, 0, m.chevRise),
  ) - m.chevThick * 0.5;
  const mark = Math.min(ring, chev);

  // 글로우: 마크 주변을 주황빛으로 물들인다 (게임의 emissive 룩).
  if (mark > 0 && a > 0 && m.glow > 0) {
    const glow = Math.exp(-mark * 30) * m.glow;
    r += (ACCENT[0] - r) * glow; g += (ACCENT[1] - g) * glow; b += (ACCENT[2] - b) * glow;
  }
  if (mark < 0) {
    r = ACCENT[0]; g = ACCENT[1]; b = ACCENT[2];
    a = 255;
  }
  return [r, g, b, a];
}

/** 한 변 `size` 의 RGBA 버퍼. 4×4 슈퍼샘플링으로 계단을 없앤다 (16 px 에서 특히 중요하다). */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const m = markFor(size);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size - 0.5;
          const v = (y + (sy + 0.5) / S) / size - 0.5;
          const c = shade(u, v, m);
          // 프리멀티플라이드로 누적해야 투명한 바깥과 섞일 때 검은 테가 생기지 않는다.
          const al = c[3] / 255;
          r += c[0] * al; g += c[1] * al; b += c[2] * al; a += al;
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      const al = a / n;
      px[o] = al > 0 ? clamp(Math.round(r / n / al), 0, 255) : 0;
      px[o + 1] = al > 0 ? clamp(Math.round(g / n / al), 0, 255) : 0;
      px[o + 2] = al > 0 ? clamp(Math.round(b / n / al), 0, 255) : 0;
      px[o + 3] = clamp(Math.round(al * 255), 0, 255);
    }
  }
  return px;
}

/* ── PNG 인코딩 (zlib 은 node 내장, CRC 만 직접) ──────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;            // bit depth
  ihdr[9] = 6;            // colour type: RGBA
  // 10..12 = compression / filter / interlace = 0
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;   // filter: none — 아이콘은 작고, 압축률보다 단순함이 낫다
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── ICO 컨테이너 ────────────────────────────────────────────────────── */
const images = SIZES.map((s) => ({ size: s, data: png(s, render(s)) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);                 // type 1 = icon
header.writeUInt16LE(images.length, 4);
let offset = 6 + images.length * 16;
const dir = [];
for (const img of images) {
  const e = Buffer.alloc(16);
  e[0] = img.size >= 256 ? 0 : img.size;    // 256 은 0 으로 적는 것이 규격이다
  e[1] = img.size >= 256 ? 0 : img.size;
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4);                    // planes
  e.writeUInt16LE(32, 6);                   // bpp
  e.writeUInt32LE(img.data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += img.data.length;
  dir.push(e);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, ...dir, ...images.map((i) => i.data)]));
console.log(`[icon] ${out}  ${SIZES.join('/')} px  (${(offset / 1024).toFixed(1)} KB)`);

if (process.argv.includes('--png')) {
  /* 눈으로 확인할 때만 (배포물에는 들어가지 않는다). 작은 크기가 읽히는지가 전부이므로 16 · 32 · 48 을
     최근접으로 확대해 256 과 한 장에 늘어놓는다 — 축소된 그림을 눈대중하면 16 px 의 진실을 못 본다. */
  const strip = [[16, 8], [32, 4], [48, 4], [256, 1]];
  const W = strip.reduce((a, [s, k]) => a + s * k + 16, 16);
  const H = 288;
  const sheet = Buffer.alloc(W * H * 4);
  let x0 = 16;
  for (const [size, k] of strip) {
    const src = render(size);
    for (let y = 0; y < size * k; y++) {
      for (let x = 0; x < size * k; x++) {
        const so = (Math.floor(y / k) * size + Math.floor(x / k)) * 4;
        const dy = 16 + y, dx = x0 + x;
        if (dy >= H || dx >= W) continue;
        src.copy(sheet, (dy * W + dx) * 4, so, so + 4);
      }
    }
    x0 += size * k + 16;
  }
  const p = join(dirname(out), 'icon-preview.png');
  writeFileSync(p, png2(W, H, sheet));
  console.log(`[icon] ${p}  (16/32/48 확대 + 256)`);
}

/** 정사각이 아닌 미리보기 시트용 PNG. */
function png2(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
