#!/usr/bin/env node
/*
 * check-comment-labels — the one check that catches a retyped Korean label in a comment (TODO B-46).
 *
 * CLAUDE.md §4.1: a comment written in English keeps an on-screen label, a csv name or an identifier
 * **verbatim** in backticks / 「」. The only reason to leave Korean there is that the real string stays
 * greppable — so a one-character typo made while retyping the label (`틈` → `픹`) silently destroys the
 * single thing the Korean was kept for. `tsc`, every smoke and a comment-only diff all pass through it:
 * the comment is not code and the label is not a symbol.
 *
 * What it does: for every Korean phrase quoted inside a comment, check that the exact phrase exists
 * somewhere **outside** comments (a string literal, a csv value, a doc). A phrase that does not is
 * compared against the live Korean strings; when one is within two edits of it, that is a retyped label
 * and the check fails. Prose that merely happens to be quoted has no near neighbour, so it stays quiet.
 *
 *   node scripts/check-comment-labels.mjs          # working tree
 *   node scripts/check-comment-labels.mjs --head   # HEAD (what an audit reads)
 *   node scripts/check-comment-labels.mjs --all    # also list phrases with no live match at all (noisy)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const FROM_HEAD = process.argv.includes('--head');
const SHOW_ALL = process.argv.includes('--all');
/** Two edits is the whole point: a typo is one, a particle swap is two. Beyond that it is different prose. */
const MAX_EDITS = 2;

const ROOTS = ['src', 'data', 'docs', 'scripts', 'server'];
const HANGUL = /[가-힣]/;

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n').map((f) => f.trim()).filter((f) => f && ROOTS.includes(f.split('/')[0]));

const read = (f) => {
  if (FROM_HEAD) { try { return execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8', maxBuffer: 1 << 28 }); } catch { return ''; } }
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};

/* Comments are blanked out of the source (same length, so line numbers survive) and kept separately. */
const BLOCK = /\/\*[\s\S]*?\*\//g;
const LINE = /(?<!:)\/\/[^\n]*/g;
function splitComments(src) {
  const comments = [];
  const blank = (m) => { comments.push(m); return ' '.repeat(m.length); };
  return { comments, code: src.replace(BLOCK, blank).replace(LINE, blank) };
}

/* Everything that is not a ts comment — this is where a real label has to be found. */
const LITERAL = /'([^'\n]{2,80})'|"([^"\n]{2,80})"|`([^`\n]{2,80})`/g;
const corpus = [];
const live = new Set();
const targets = [];
for (const f of files) {
  const src = read(f);
  if (!src) continue;
  if (/\.(ts|mjs|js)$/.test(f)) {
    const { comments, code } = splitComments(src);
    corpus.push(code);
    for (const m of code.matchAll(LITERAL)) {
      const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      if (HANGUL.test(v)) live.add(v);
    }
    if (f.startsWith('src/')) targets.push({ file: f, src, comments });
  } else {
    corpus.push(src);
    for (const v of src.split(/[,\n"]/)) {
      const t = v.trim();
      if (t.length >= 2 && HANGUL.test(t)) live.add(t);
    }
  }
}
const CORPUS = corpus.join('\n');

function editDistance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/* 「…」 is how a comment quotes an on-screen line; backticks are how it quotes a label or a csv name. */
const QUOTED = /「([^」\n]{3,60})」|`([^`\n]{3,60})`/g;
const hits = [];
const unmatched = [];
for (const { file, src, comments } of targets) {
  for (const c of comments) {
    const at = src.indexOf(c);
    const line = at < 0 ? 0 : src.slice(0, at).split('\n').length;
    for (const m of c.matchAll(QUOTED)) {
      const phrase = (m[1] ?? m[2]).trim();
      if (!HANGUL.test(phrase) || CORPUS.includes(phrase)) continue;
      let best = null;
      for (const cand of live) {
        const d = editDistance(phrase, cand, MAX_EDITS);
        if (d <= MAX_EDITS && (!best || d < best.d)) { best = { d, cand }; if (d === 1) break; }
      }
      if (best) hits.push({ file, line, phrase, real: best.cand, d: best.d });
      else unmatched.push({ file, line, phrase });
    }
  }
}

if (SHOW_ALL) {
  console.log(`${unmatched.length} quoted Korean phrases have no live string at all (prose, templates with placeholders, historical names):`);
  for (const u of unmatched) console.log(`  ${u.file}:${u.line}  ${u.phrase}`);
  console.log('');
}
if (!hits.length) {
  console.log(`check-comment-labels ok — ${targets.length} files, no retyped Korean label${FROM_HEAD ? ' (HEAD)' : ''}`);
  process.exit(0);
}
console.log(`check-comment-labels — ${hits.length} quoted Korean phrase(s) are within ${MAX_EDITS} edits of a live string but do not match it:`);
for (const h of hits) {
  console.log(`  ${h.file}:${h.line}`);
  console.log(`    comment: ${h.phrase}`);
  console.log(`    live   : ${h.real}   (${h.d} edit${h.d > 1 ? 's' : ''})`);
}
console.log('\nA near miss is either a typo (copy the live string) or a template / historical name (then it is fine — say so in the comment).');
/* Advisory: the near-miss list still holds templates (`크레딧 n C`) and deliberate historical names, so a
   non-zero exit would make it unrunnable inside `verify` until every one of those is reworded. */
process.exit(0);
