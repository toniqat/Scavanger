#!/usr/bin/env node
/**
 * `npm run icon` — draws the app icon `electron/resources/icon.ico` **in code**.
 *
 * This project has no assets on disk (`CLAUDE.md` §4 — every model · texture is generated procedurally). The
 * icon follows the same rule: it is drawn here with SDFs, encoded as a PNG and put into an ICO container.
 * There is no external image library and no hand-made source file — to change the shape, edit the numbers in
 * `MARK` and run it again.
 *
 * The mark: a dark rounded plate + an **orange hex ring** (the same hexagon as the HUD's currency chip ·
 * implant thumbnails) + **a chevron pointing down inside it (the drop · the arrow on a hold keycap)**. It
 * stops at three elements so that it still reads at 16 px.
 *
 * The colour is the game's own highlight — `--c-accent` = `#ffb347` in `src/ui/styles/base.css`.
 *
 * The output sizes are `SIZES`. Every entry inside the ICO is a PNG (the post-Vista format), which is how
 * electron-builder · Explorer · the taskbar all read it. `scripts/pack-release.mjs` (the stub launcher) uses
 * the same file.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'electron', 'resources', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** The mark's proportions (every value is relative to one side = 1). Change them here and every size follows. */
const MARK = {
  plateInset: 0.02,      // plate inset
  plateRadius: 0.17,     // corner radius
  hexRadius: 0.355,      // hex ring radius
  hexThick: 0.055,       // hex ring thickness
  chevWidth: 0.175,      // chevron half-width
  chevRise: 0.100,       // chevron height (half)
  chevThick: 0.064,      // chevron thickness
  chevDrop: 0.02,        // the chevron sits a little above the centre (optical-centre correction)
  glow: 0.34,            // orange bleed around the mark (0 = none)
};

/**
 * Per-size correction. Using the 256 px proportions at 16 px leaves the ring and the chevron **under one pixel**
 * wide, so they smear (and the glow swallows that one pixel). A small icon goes thicker and larger, with no
 * glow — standard icon practice, and these are the sizes most often seen in the taskbar · the Explorer list.
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

/* ── a small set of SDFs (distance < 0 = inside) ─────────────── */
const len = (x, y) => Math.hypot(x, y);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** A rounded rectangle. */
function sdRoundRect(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** A regular hexagon (vertices top and bottom = pointy-top). iq's sdHexagon with only the axes swapped. */
function sdHexagon(px, py, r) {
  // x and y go in swapped to make it pointy-top.
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

/** A segment (capsule). */
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return len(pax - bax * h, pay - bay * h);
}

/** One point's colour (RGBA 0..255). `u, v` run -0.5..0.5, origin at the centre. `m` = `markFor(size)`. */
function shade(u, v, m) {
  let r = 0, g = 0, b = 0, a = 0;

  // ① the plate
  const plate = sdRoundRect(u, v, 0.5 - m.plateInset, 0.5 - m.plateInset, m.plateRadius);
  if (plate < 0) {
    // A very faint top-to-bottom gradient — it reads as an object rather than a flat rectangle.
    const t = clamp(v + 0.5, 0, 1);
    r = PLATE[0] + 10 * (1 - t); g = PLATE[1] + 10 * (1 - t); b = PLATE[2] + 12 * (1 - t);
    a = 255;
    // The plate's inner border (a warm line)
    const edge = Math.abs(plate + 0.012) - 0.006;
    if (edge < 0) { r = PLATE_EDGE[0]; g = PLATE_EDGE[1]; b = PLATE_EDGE[2]; }
  }

  // ② the hex ring + ③ the chevron — both in the highlight colour, with the glow laid over them.
  const ring = Math.abs(sdHexagon(u, v, m.hexRadius)) - m.hexThick * 0.5;
  const cy = v + m.chevDrop;
  const chev = Math.min(
    sdSegment(u, cy, -m.chevWidth, -m.chevRise, 0, m.chevRise),
    sdSegment(u, cy, m.chevWidth, -m.chevRise, 0, m.chevRise),
  ) - m.chevThick * 0.5;
  const mark = Math.min(ring, chev);

  // The glow: it tints the area around the mark orange (the game's emissive look).
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

/** An RGBA buffer `size` on a side. 4×4 supersampling removes the stair-stepping (it matters most at 16 px). */
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
          // Accumulating premultiplied keeps a black fringe out where it blends with the transparent outside.
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

/* ── PNG encoding (zlib is node's own, only the CRC is by hand)  */
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
    raw[y * (size * 4 + 1)] = 0;   // filter: none — the icon is small, and simplicity beats compression ratio
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── the ICO container ───────────────────────────────────────────── */
const images = SIZES.map((s) => ({ size: s, data: png(s, render(s)) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);                 // type 1 = icon
header.writeUInt16LE(images.length, 4);
let offset = 6 + images.length * 16;
const dir = [];
for (const img of images) {
  const e = Buffer.alloc(16);
  e[0] = img.size >= 256 ? 0 : img.size;    // writing 256 as 0 is what the format says
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
  /* For looking at it only (it never goes into a build). Whether the small sizes read is the whole point, so
     16 · 32 · 48 are blown up nearest-neighbour and laid out on one sheet beside 256 — eyeballing a shrunk
     picture never shows the truth of 16 px. */
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

/** PNG for the preview sheet, which is not square. */
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
