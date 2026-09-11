// Single-player smoke test for Phase 9 §6 (enemies): delta enemy snapshots (`es` keyframe / delta / `gone` / seq),
// the replica's `applyWire` path (delta on top of the latest sample, unknown ids ignored, hold, gone), burn-kill credit
// (`applyStatus(..., attacker)` → `enemy:killed.by`) and enemy fire stopped by a 배리어 (`raycastBarrier` pure query +
// `damageBarrier`). Drives `EnemySystem.debugSnapshot / debugApplySnapshot` directly — no relay needed.
// Usage: node scripts/smoke-enemy-delta.mjs [http://localhost:5273]   (needs a running vite; agents use a private port)
import puppeteer from 'puppeteer-core';
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

/** Contract values mirrored here (src/shared/net.ts): NET_ENEMY_KEYFRAME_S 2 × NET_ENEMY_SNAPSHOT_HZ 10. */
const KEYFRAME_EVERY = 20;

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
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // Park vite's HMR socket: another agent's save would otherwise full-reload the page mid-run (window.__game gone).
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr')) return new QuietSocket(args[0]);
        return new target(...args);
      },
    });
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.enemies, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['enemy:killed', 'enemy:shot', 'enemy:attacked', 'enemy:spawned']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
    window.__sys = window.__game.getSystem('enemies');
    window.__V = window.__game.ctx.camera.position.constructor;
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const untilSim = async (fn, sec, arg) => {
    const t0 = await P(() => window.__game.ctx.time);
    return waitFor(page, (a) => { const v = (0, eval)(a.src)(a.arg); return v || window.__game.ctx.time >= a.t; }, `poll or sim +${sec}s`, 600000, { src: `(${fn.toString()})`, arg, t: t0 + sec });
  };

  console.log('mission (seed 21)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 21 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  ok(await P(() => window.__sys.isAuthority && !window.__sys.replica), 'single-player: enemies run as the authority');

  /* ── host encoder: keyframe → deltas → gone → cadence ─────────────────── */
  console.log('host encoder (SnapshotCache)');
  const enc = await P((KF) => {
    const ctx = window.__game.ctx; const sys = window.__sys;
    const pp = ctx.player.position;
    const r = {};
    // three fresh enemies far from the player, not chasing (idle → wander only after a timer; all snapshots below run synchronously)
    const a = sys.debugSpawn('scavenger', { x: pp.x + 90, z: pp.z + 90 }, false);
    const b = sys.debugSpawn('scavenger', { x: pp.x + 95, z: pp.z + 90 }, false);
    const c = sys.debugSpawn('warrior', { x: pp.x + 90, z: pp.z + 95 }, false);
    if (!a || !b || !c) return { spawned: false };
    r.spawned = true; r.ids = [a.id, b.id, c.id];
    const fields = (w) => Object.keys(w).sort().join(',');
    const s0 = sys.debugSnapshot();
    r.first = { full: s0.full, seq: s0.seq, n: s0.e.length, gone: s0.gone ?? null, allFields: s0.e.every((w) => w.p && w.ty !== undefined && w.yaw !== undefined && w.hp !== undefined && w.st !== undefined), fieldsA: fields(s0.e.find((w) => w.id === a.id) ?? {}) };
    r.cached0 = sys.debugSnapshotState.cached;
    // nothing changed → an empty delta
    const s1 = sys.debugSnapshot();
    r.idle = { full: s1.full, seq: s1.seq, n: s1.e.length, gone: s1.gone ?? null };
    // move one → only `p`
    a.position.x += 3;
    const s2 = sys.debugSnapshot();
    r.moved = { full: s2.full, seq: s2.seq, n: s2.e.length, wire: s2.e[0] ?? null, fields: s2.e[0] ? fields(s2.e[0]) : '' };
    // rotate + move below the rounding step → yaw only.
    // `p` is quantised with `round(v, 2)`, so a 1 mm nudge still crosses a boundary whenever the
    // spawn happened to land in the top 10 % of a centimetre (350.4249 → 350.42, +0.001 → 350.43)
    // — that made this check fail about one run in ten. Snapping x onto the centimetre grid first
    // does not change its *rounded* value (so the cache still matches), and 0.001 from a grid point
    // cannot round anywhere else.
    b.position.x = Math.round(b.position.x * 100) / 100;
    b.yaw += 0.5; b.position.x += 0.001;
    const s3 = sys.debugSnapshot();
    r.yawed = { n: s3.e.length, wire: s3.e[0] ?? null, fields: s3.e[0] ? fields(s3.e[0]) : '' };
    // hp only
    c.hp -= 7;
    const s4 = sys.debugSnapshot();
    r.hurt = { n: s4.e.length, wire: s4.e[0] ?? null, fields: s4.e[0] ? fields(s4.e[0]) : '' };
    // hint on, then back to 0 → explicit 0 in a delta
    a.airborne = true;
    const s5 = sys.debugSnapshot();
    a.airborne = false;
    const s6 = sys.debugSnapshot();
    r.hint = { on: s5.e[0] ?? null, off: s6.e[0] ?? null, onFields: s5.e[0] ? fields(s5.e[0]) : '', offFields: s6.e[0] ? fields(s6.e[0]) : '' };
    // status bits on / off
    b.burnTimer = 1; b.burnDps = 1;
    const s7 = sys.debugSnapshot();
    b.burnTimer = 0; b.burnDps = 0;
    const s8 = sys.debugSnapshot();
    r.sb = { on: s7.e[0] ?? null, off: s8.e[0] ?? null };
    // state change + kill → st / hp, then the corpse leaves the snapshot after 1.5 s → gone
    c.hp = 0; c.kill(false);
    const s9 = sys.debugSnapshot();
    r.dead = { n: s9.e.length, wire: s9.e[0] ?? null, gone: s9.gone ?? null };
    c.deathTimer = 2;
    const s10 = sys.debugSnapshot();
    r.corpseGone = { n: s10.e.length, gone: s10.gone ?? null };
    // an explicit despawn (pool release) → gone
    sys.despawn(b);
    const s11 = sys.debugSnapshot();
    r.despawned = { n: s11.e.length, gone: s11.gone ?? null, cached: sys.debugSnapshotState.cached };
    // a brand-new enemy appears in a delta with its full field set (ty included)
    const d = sys.debugSpawn('hunter', { x: pp.x + 100, z: pp.z + 100 }, false);
    const s12 = sys.debugSnapshot();
    r.appeared = { n: s12.e.length, wire: s12.e.find((w) => w.id === (d ? d.id : -1)) ?? null, full: s12.full, seq: s12.seq };
    // cadence: keep encoding until the seq reaches a keyframe boundary; every one in between is a delta
    let seqs = [s12.seq]; let fulls = []; let last = s12;
    for (let i = 0; i < KF + 2; i++) { last = sys.debugSnapshot(); seqs.push(last.seq); fulls.push({ seq: last.seq, full: last.full, n: last.e.length }); }
    r.cadence = { seqs, fulls };
    const forced = sys.debugSnapshot(true);
    r.forced = { full: forced.full, seq: forced.seq, n: forced.e.length, allFields: forced.e.every((w) => w.p && w.ty !== undefined && w.yaw !== undefined && w.hp !== undefined && w.st !== undefined) };
    const after = sys.debugSnapshot();
    r.afterForced = { full: after.full, n: after.e.length };
    r.active = sys.active.filter((e) => e.active && !(e.state === 'dead' && e.deathTimer > 1.5)).length;
    if (d) d.kill(false);
    a.kill(false);
    return r;
  }, KEYFRAME_EVERY);
  ok(enc.spawned, 'debugSpawn placed three test enemies', JSON.stringify(enc));
  ok(enc.first && enc.first.full && enc.first.seq === 1 && enc.first.allFields, `first snapshot is a keyframe with every field (seq ${enc.first?.seq}, ${enc.first?.n} enemies, fields ${enc.first?.fieldsA})`, JSON.stringify(enc.first));
  ok(enc.first && enc.first.n === enc.active + 0 || enc.first.n >= 3, `keyframe lists every eligible enemy (${enc.first?.n})`);
  ok(enc.cached0 === enc.first?.n, `cache holds one entry per listed enemy (${enc.cached0})`);
  ok(enc.idle && !enc.idle.full && enc.idle.seq === 2 && enc.idle.n === 0 && enc.idle.gone === null, `idle enemies produce an empty delta (seq ${enc.idle?.seq}, ${enc.idle?.n} entries, gone ${JSON.stringify(enc.idle?.gone)})`);
  ok(enc.moved && !enc.moved.full && enc.moved.n === 1 && enc.moved.fields === 'id,p', `a moved enemy sends only p (${enc.moved?.fields})`, JSON.stringify(enc.moved));
  ok(enc.yawed && enc.yawed.n === 1 && enc.yawed.fields === 'id,yaw', `a turn below the 1 cm step sends only yaw (${enc.yawed?.fields})`, JSON.stringify(enc.yawed));
  ok(enc.hurt && enc.hurt.n === 1 && enc.hurt.fields === 'hp,id', `damage sends only hp (${enc.hurt?.fields})`, JSON.stringify(enc.hurt));
  ok(enc.hint && enc.hint.onFields === 'a,id' && enc.hint.on.a === 4, `hint change sends only a (${enc.hint?.onFields} = ${enc.hint?.on?.a})`);
  ok(enc.hint && enc.hint.offFields === 'a,id' && enc.hint.off.a === 0, `hint back to 0 is sent as an explicit 0 (${enc.hint?.offFields} = ${enc.hint?.off?.a})`);
  ok(enc.sb && enc.sb.on && enc.sb.on.sb === 1 && enc.sb.off && enc.sb.off.sb === 0, `status bits on → sb 1, off → explicit sb 0`, JSON.stringify(enc.sb));
  ok(enc.dead && enc.dead.n === 1 && enc.dead.wire.st === 'dead' && enc.dead.wire.hp === 0 && enc.dead.wire.p === undefined && enc.dead.gone === null, `a kill sends st dead + hp 0 (no gone yet)`, JSON.stringify(enc.dead));
  ok(enc.corpseGone && enc.corpseGone.n === 0 && Array.isArray(enc.corpseGone.gone) && enc.corpseGone.gone.includes(enc.ids[2]), `the settled corpse leaves through gone (${JSON.stringify(enc.corpseGone?.gone)})`);
  ok(enc.despawned && Array.isArray(enc.despawned.gone) && enc.despawned.gone.includes(enc.ids[1]) && enc.despawned.cached === enc.first.n - 2 + 0, `a despawn lands in gone and leaves the cache (${JSON.stringify(enc.despawned?.gone)}, cached ${enc.despawned?.cached})`);
  ok(enc.appeared && !enc.appeared.full && enc.appeared.wire && enc.appeared.wire.ty === 'hunter' && enc.appeared.wire.p && enc.appeared.wire.st !== undefined && enc.appeared.wire.hp !== undefined, 'a new enemy appears in a delta with ty / p / hp / st', JSON.stringify(enc.appeared));
  const seqs = enc.cadence?.seqs ?? [];
  ok(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), `seq is monotonic +1 (${seqs[0]} … ${seqs[seqs.length - 1]})`);
  const fulls = enc.cadence?.fulls ?? [];
  ok(fulls.every((f) => f.full === (f.seq % KEYFRAME_EVERY === 0)), `keyframes exactly on seq % ${KEYFRAME_EVERY} === 0`, JSON.stringify(fulls.filter((f) => f.full !== (f.seq % KEYFRAME_EVERY === 0))));
  ok(fulls.some((f) => f.full && f.n >= 1) && fulls.some((f) => !f.full && f.n === 0), 'the periodic keyframe relists the idle enemies, the deltas around it are empty');
  ok(enc.forced && enc.forced.full && enc.forced.allFields && enc.forced.seq % KEYFRAME_EVERY !== 0, `debugSnapshot(true) forces a keyframe off-cadence (seq ${enc.forced?.seq})`);
  ok(enc.afterForced && !enc.afterForced.full && enc.afterForced.n === 0, 'the snapshot after a forced keyframe is a normal empty delta');

  /* ── replica: applyWire on deltas, unknown ids, hold, gone, keyframe sweep ── */
  console.log('replica (applyWire)');
  const keyBefore = await P(() => window.__sys.debugSnapshot(true));
  await P(() => window.__sys.setAuthority(false));
  await waitSim(0.3);
  const rep = await P((key) => {
    const ctx = window.__game.ctx; const sys = window.__sys;
    const r = { replica: sys.replica };
    const pp = ctx.player.position;
    const y = ctx.world.getHeightAt(pp.x + 40, pp.z + 40);
    const live = key.e.filter((w) => w.st !== 'dead');
    // keyframe from "the host": the enemies we already have + a new id 9001
    const kf = { t: 'es', time: ctx.time, seq: 5000, full: true, e: [...live, { id: 9001, ty: 'scavenger', p: [pp.x + 40, y, pp.z + 40], yaw: 0.5, hp: 60, st: 'idle' }] };
    sys.debugApplySnapshot(kf);
    const n = sys.find(9001);
    r.created = !!n && n.active && n.type === 'scavenger';
    r.state = sys.debugSnapshotState;
    const before = n ? { x: n.netBuf.latest().x, hp: n.netBuf.latest().hp, st: n.netBuf.latest().st, count: n.netBuf.count } : null;
    // delta: only p for 9001
    sys.debugApplySnapshot({ t: 'es', time: ctx.time + 0.1, seq: 5001, full: false, e: [{ id: 9001, p: [pp.x + 42, y, pp.z + 40] }] });
    const l1 = n ? n.netBuf.latest() : null;
    r.deltaP = l1 ? { x: l1.x, dx: l1.x - before.x, hp: l1.hp, st: l1.st, count: n.netBuf.count } : null;
    // delta: hp + a + sb only
    sys.debugApplySnapshot({ t: 'es', time: ctx.time + 0.2, seq: 5002, full: false, e: [{ id: 9001, hp: 12, a: 4, sb: 1 }] });
    const l2 = n ? n.netBuf.latest() : null;
    r.deltaHp = l2 ? { x: l2.x, hp: l2.hp, a: l2.a, sb: l2.sb, st: l2.st } : null;
    // delta: explicit a 0 / sb 0 clears, missing keeps
    sys.debugApplySnapshot({ t: 'es', time: ctx.time + 0.3, seq: 5003, full: false, e: [{ id: 9001, a: 0 }] });
    const l3 = n ? n.netBuf.latest() : null;
    r.deltaClear = l3 ? { a: l3.a, sb: l3.sb, hp: l3.hp } : null;
    // hold: an enemy absent from a delta gets a repeated sample (count grows, pose unchanged)
    const other = live.length ? sys.find(live[0].id) : null;
    const oc = other && other.netBuf ? other.netBuf.count : -1;
    const ox = other && other.netBuf ? other.netBuf.latest().x : NaN;
    sys.debugApplySnapshot({ t: 'es', time: ctx.time + 0.4, seq: 5004, full: false, e: [] });
    r.hold = other && other.netBuf ? { before: oc, after: other.netBuf.count, sameX: other.netBuf.latest().x === ox, seenSeq: other.netBuf.seenSeq } : null;
    // unknown id without ty → ignored; unknown id with ty + p → created
    const ign0 = sys.debugSnapshotState.ignoredUnknown;
    sys.debugApplySnapshot({ t: 'es', time: ctx.time + 0.5, seq: 5005, full: false, e: [{ id: 9999, p: [pp.x, y, pp.z] }, { id: 9998, ty: 'warrior', p: [pp.x + 44, y, pp.z + 44], yaw: 0, hp: 320, st: 'chase' }] });
    r.unknown = { ignored: sys.debugSnapshotState.ignoredUnknown - ign0, has9999: !!sys.find(9999), has9998: !!sys.find(9998) && sys.find(9998).type === 'warrior' };
    // gone releases a live replica at once
    sys.debugApplySnapshot({ t: 'es', time: ctx.time + 0.6, seq: 5006, full: false, e: [], gone: [9998] });
    r.gone = { has9998: !!sys.find(9998) };
    // seq comes from the wire
    r.seq = sys.debugSnapshotState.replicaSeq;
    r.total = sys.active.filter((e) => e.active).length;
    return r;
  }, keyBefore);
  ok(rep.replica, 'setAuthority(false) → replica mode');
  ok(rep.created, 'a keyframe creates an unknown id (9001) from ty / p');
  ok(rep.state && rep.state.replicaSeq === 5000 && rep.state.replicaLastFull, `replica seq comes from the wire (${rep.state?.replicaSeq}, full ${rep.state?.replicaLastFull})`);
  ok(rep.deltaP && Math.abs(rep.deltaP.dx - 2) < 1e-6 && rep.deltaP.hp === 60 && rep.deltaP.st === 'idle' && rep.deltaP.count === 2, 'a p-only delta moves the sample and keeps hp / st', JSON.stringify(rep.deltaP));
  ok(rep.deltaHp && rep.deltaHp.hp === 12 && rep.deltaHp.a === 4 && rep.deltaHp.sb === 1 && Math.abs(rep.deltaHp.x - rep.deltaP.x) < 1e-6, 'an hp / a / sb delta keeps the position', JSON.stringify(rep.deltaHp));
  ok(rep.deltaClear && rep.deltaClear.a === 0 && rep.deltaClear.sb === 1 && rep.deltaClear.hp === 12, 'explicit a 0 clears the hint, the omitted sb stays', JSON.stringify(rep.deltaClear));
  ok(rep.hold && rep.hold.after === Math.min(8, rep.hold.before + 1) && rep.hold.sameX && rep.hold.seenSeq === 5004, `an enemy absent from a delta gets a hold sample (${rep.hold?.before} → ${rep.hold?.after}, seenSeq ${rep.hold?.seenSeq})`);
  ok(rep.unknown && rep.unknown.ignored === 1 && !rep.unknown.has9999 && rep.unknown.has9998, 'unknown id without ty is ignored; with ty + p it is created', JSON.stringify(rep.unknown));
  ok(rep.gone && !rep.gone.has9998, 'gone releases the replica at once');
  ok(rep.seq === 5006, `replica tracks the wire seq (${rep.seq})`);
  // frames: interpolation drives the replica toward the delta position; a dead st kills it; a keyframe sweeps the rest
  await waitSim(0.6);
  const rep2 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys;
    const n = sys.find(9001);
    const l = n ? n.netBuf.latest() : null;
    const r = { alive: !!n && n.active, dist: n && l ? Math.hypot(n.position.x - l.x, n.position.z - l.z) : -1, hp: n ? n.hp : -1, state: n ? n.state : '' };
    sys.debugApplySnapshot({ t: 'es', time: ctx.time, seq: 5007, full: false, e: [{ id: 9001, hp: 0, st: 'dead' }] });
    return r;
  });
  ok(rep2.alive && rep2.dist < 0.5 && rep2.hp === 12 && rep2.state === 'idle', `frames render the replica at the delta pose (Δ ${rep2.dist.toFixed(2)} m, hp ${rep2.hp}, ${rep2.state})`);
  await waitSim(0.3);
  const rep3 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys;
    const n = sys.find(9001);
    const r = { dead: !!n && n.state === 'dead' };
    sys.debugApplySnapshot({ t: 'es', time: ctx.time, seq: 5008, full: false, e: [], gone: [9001] });
    r.corpseKept = !!sys.find(9001) && sys.find(9001).active;
    const liveBefore = sys.active.filter((e) => e.active && e.state !== 'dead').length;
    // a keyframe that lists nobody sweeps every live replica (corpses stay)
    sys.debugApplySnapshot({ t: 'es', time: ctx.time, seq: 5009, full: true, e: [] });
    r.liveBefore = liveBefore;
    r.liveAfter = sys.active.filter((e) => e.active && e.state !== 'dead').length;
    r.corpseStill = !!sys.find(9001);
    return r;
  });
  ok(rep3.dead, 'a delta with st dead kills the replica on the next frame');
  ok(rep3.corpseKept, 'gone leaves a dead body to the corpse timer');
  ok(rep3.liveBefore >= 1 && rep3.liveAfter === 0 && rep3.corpseStill, `a keyframe sweeps unlisted live replicas (${rep3.liveBefore} → ${rep3.liveAfter}), corpses stay`);

  /* ── 2026-09-11: C 항목 배치 (리플리카 쪽) ─────────────────────────────────────────────────────────────
     C-1 · X-6 리플리카 pushBack = 적마다 HitRequest {dmg 0, kb} · C-48 `ee acidAt` 수신 = 산성 글롭 · C-51 리플리카
     `ee damaged` 로그 = hit_flesh, `ee attack` 타길라 = 타격음 없음 · C-23 · X-3 리플리카도 적 발소리 (거리 곡선은 audio/ —
     방출부 볼륨은 거리와 상관없이 타입 밑값). `net.send` 는 인스턴스에 덮어씌워 가로챘다가 되돌린다. */
  console.log('C batch (replica): pushBack request · acidAt · hurt / bite sound · footsteps');
  const cRep = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    const pp = ctx.player.position;
    const y = ctx.world.getHeightAt(pp.x + 30, pp.z + 30);
    sys.debugApplySnapshot({ t: 'es', seq: 5100, full: true, e: [
      { id: 9101, ty: 'warrior', p: [pp.x + 30, y, pp.z + 30], yaw: 0, hp: 640, st: 'idle' },
      { id: 9102, ty: 'rogue', p: [pp.x + 32.5, y, pp.z + 30], yaw: 0, hp: 280, st: 'idle' },
    ] });
    const net = ctx.net; const origSend = net.send; const sent = [];
    net.send = (m, to) => { sent.push({ m: JSON.parse(JSON.stringify(m)), to }); };
    const audio = []; const off = ctx.bus.on('audio:play', (a) => audio.push(a.id));
    const r = { replica: sys.replica };
    const n = sys.pushBack(new V(pp.x + 31.2, y, pp.z + 30), 2.5, 6, new V(0, 0, 1));
    r.push = { n, msgs: sent.filter((s) => s.m.t === 'hit').map((s) => ({ id: s.m.id, dmg: s.m.dmg, kb: s.m.kb, d: s.m.d, to: s.to })) };
    const globs = () => sys.acid.globs.filter((g) => g.active).length;
    const g0 = globs();
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'acidAt', id: 9101, from: [pp.x + 30, y + 1.5, pp.z + 30], to: [pp.x + 36, y, pp.z + 34] });
    r.acid = { g0, g1: globs() };
    audio.length = 0; sys.lastAudio.clear();
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'damaged', id: 9102, amount: 10, p: [pp.x + 32.5, y + 1, pp.z + 30] });
    r.hurtRogue = audio.slice();
    audio.length = 0; sys.lastAudio.clear();
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'damaged', id: 9101, amount: 10, p: [pp.x + 30, y + 1, pp.z + 30] });
    r.hurtBug = audio.slice();
    audio.length = 0; sys.lastAudio.clear();
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'attack', id: 9102, ty: 'rogue_hammer', target: 'peer-q', damage: 5, p: [pp.x + 32.5, y, pp.z + 30] });
    r.biteHammer = audio.slice();
    audio.length = 0; sys.lastAudio.clear();
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'attack', id: 9101, ty: 'warrior', target: 'peer-q', damage: 5, p: [pp.x + 30, y, pp.z + 30] });
    r.biteWarrior = audio.slice();
    net.send = origSend; off();
    window.__stepSeq = 5101;
    window.__steps = [];
    window.__stepOff = ctx.bus.on('audio:play', (a) => { if (a.id.startsWith('footstep_') && a.position) window.__steps.push({ id: a.id, v: a.volume, x: a.position.x }); });
    return r;
  });
  ok(cRep.replica && cRep.push.n === 2 && cRep.push.msgs.length === 2 && cRep.push.msgs.every((m) => m.dmg === 0 && m.kb > 0 && m.kb <= 6 && m.to === 'host' && Math.abs(m.d[2] - 1) < 1e-3),
    `C-1 · X-6: 리플리카 pushBack = 범위 안 적마다 HitRequest {dmg 0, kb} 를 호스트로 (${cRep.push.n}건)`, JSON.stringify(cRep.push));
  ok(cRep.acid.g1 === cRep.acid.g0 + 1, `C-48: 리플리카가 ee acidAt 을 받아 산성 글롭을 날린다 (${cRep.acid.g0} → ${cRep.acid.g1})`);
  ok(cRep.hurtRogue.includes('hit_flesh') && !cRep.hurtRogue.includes('bug_hit') && cRep.hurtBug.includes('bug_hit'),
    `C-51: 리플리카 ee damaged — 로그 hit_flesh · 벌레 bug_hit (${cRep.hurtRogue} / ${cRep.hurtBug})`);
  ok(!cRep.biteHammer.includes('bug_attack') && cRep.biteWarrior.includes('bug_attack'),
    `C-51: 리플리카 ee attack — 타길라는 bug_attack 을 내지 않는다 (${cRep.biteHammer} / ${cRep.biteWarrior})`);
  // 리플리카 전사를 4 m/s 로 걷게 한다 — 호스트처럼 0.1 s 마다 keyframe
  for (let i = 1; i <= 20; i++) {
    await P((k) => {
      const ctx = window.__game.ctx; const pp = ctx.player.position;
      const x = pp.x + 30 + k * 0.4, y = ctx.world.getHeightAt(x, pp.z + 30);
      window.__sys.debugApplySnapshot({ t: 'es', seq: ++window.__stepSeq, full: true, e: [{ id: 9101, ty: 'warrior', p: [x, y, pp.z + 30], yaw: Math.PI / 2, hp: 640, st: 'wander' }] });
    }, i);
    await waitSim(0.1);
  }
  const steps = await P(() => { window.__stepOff(); return window.__steps; });
  ok(steps.length >= 2 && steps.every((s) => /^footstep_[a-z]+$/.test(s.id)),
    `C-23 · X-3 · C-22: 걷는 리플리카 전사가 재질 발소리를 낸다 (${steps.length}걸음, ${[...new Set(steps.map((s) => s.id))].join(',')})`, JSON.stringify(steps.slice(0, 4)));
  ok(steps.length >= 1 && steps.every((s) => Math.abs(s.v - 0.55) < 1e-6),
    `C-23: 방출부 볼륨 = 타입 밑값(전사 0.55) — 거리 선형 감쇠를 곱하지 않는다 (${[...new Set(steps.map((s) => s.v))].join(',')})`);

  /* ── promotion: the new host's first snapshot is a keyframe past the replica seq ── */
  console.log('promotion → keyframe');
  await P(() => window.__sys.setAuthority(true));
  const prom = await P(() => {
    const sys = window.__sys;
    const st = sys.debugSnapshotState;
    const s = sys.debugSnapshot();
    return { auth: sys.isAuthority, forceFull: st.forceFull, seqBase: st.seq, full: s.full, seq: s.seq, n: s.e.length, next: sys.debugSnapshot().full };
  });
  ok(prom.auth && prom.forceFull, 'promotion resets the cache with forceFull');
  ok(prom.full && prom.seq > 5009 + 1000 - 1 && !prom.next, `first snapshot after promotion is a keyframe with seq past the replica's (${prom.seq}), the next a delta`);

  /* ── 2026-09-11: C 항목 배치 (호스트 쪽) ─────────────────────────────────────────────────────────────────
     C-1 · X-6 `onHitRequest` 가 kb 를 받는다 (상한 · 돌진 중 제외 · dmg 0 은 hitc 없음) · C-48 적 · 지점 표적 산성 = `ee acidAt`
     방송 · X-5 벌레 산성이 로그를 다치게 한다. `hosting` 은 `authority && multiplayer && net` 이라 잠깐 multiplayer 를 켠다. */
  console.log('C batch (host): knockback request · acidAt broadcast · acid hurts rogues');
  const cHost = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    const pp = ctx.player.position;
    const w = sys.debugSpawn('warrior', { x: pp.x + 60, z: pp.z - 60 }, false);
    const b = sys.debugSpawn('behemoth', { x: pp.x + 75, z: pp.z - 75 }, false);
    const rogue = sys.debugSpawn('rogue', { x: pp.x + 64, z: pp.z - 60 }, false);
    if (!w || !b || !rogue) return null;
    const net = ctx.net; const origSend = net.send; const sent = [];
    net.send = (m, to) => { sent.push({ m: JSON.parse(JSON.stringify(m)), to }); };
    const wasMp = sys.multiplayer; sys.multiplayer = true;
    const r = { hosting: sys.hosting };
    w.velocity.set(0, 0, 0);
    sys.onHitRequest({ t: 'hit', id: w.id, dmg: 0, p: [0, 0, 0], d: [1, 0, 0], kb: 6 }, 'peer-kb');
    r.kb = [+w.velocity.x.toFixed(3), +w.velocity.z.toFixed(3)];
    w.velocity.set(0, 0, 0);
    sys.onHitRequest({ t: 'hit', id: w.id, dmg: 0, p: [0, 0, 0], d: [0, 0, -1], kb: 999 }, 'peer-kb');
    r.clamped = +w.velocity.length().toFixed(3);
    w.velocity.set(0, 0, 0);
    sys.onHitRequest({ t: 'hit', id: w.id, dmg: 0, p: [0, 0, 0], d: [0, 0, -1] }, 'peer-kb');
    r.noKb = w.velocity.length();
    b.chargePhase = 2; b.velocity.set(0, 0, 0);
    sys.onHitRequest({ t: 'hit', id: b.id, dmg: 0, p: [0, 0, 0], d: [1, 0, 0], kb: 6 }, 'peer-kb');
    r.charging = b.velocity.length(); b.chargePhase = 0;
    r.hitc = sent.filter((s) => s.m.t === 'hitc').length;
    sent.length = 0;
    w.yaw = Math.PI / 2;
    const mouth = new V(w.position.x, w.position.y + 1.4, w.position.z);
    sys.fireAcid(mouth, w, rogue.asTarget);
    sys.fireAcidAt(mouth.clone(), new V(w.position.x - 3, w.position.y, w.position.z - 3), w);
    r.acidAt = sent.filter((s) => s.m.t === 'ee' && s.m.ev === 'acidAt').map((s) => ({ id: s.m.id, to: s.to, from: s.m.from, dest: s.m.to }));
    r.acidPlayer = sent.filter((s) => s.m.t === 'ee' && s.m.ev === 'acid').length;
    sys.multiplayer = wasMp; net.send = origSend;
    rogue.wanderTimer = 1e9;
    window.__cAcid = { rogue: rogue.id, hp: rogue.hp, w: w.id, b: b.id };
    return r;
  });
  ok(!!cHost && cHost.hosting, 'multiplayer 를 켜 호스트 경로를 탔다', JSON.stringify(cHost));
  ok(!!cHost && Math.abs(cHost.kb[0] - 6) < 1e-3 && Math.abs(cHost.kb[1]) < 1e-3 && cHost.noKb === 0,
    `C-1 · X-6: 호스트 onHitRequest 가 kb 를 d 방향 수평 속도로 준다 (${JSON.stringify(cHost?.kb)}), kb 없는 dmg 0 요청은 무시`);
  ok(!!cHost && cHost.clamped <= 20 + 1e-3 && cHost.clamped > 6, `C-1: 요청 넉백은 MAX_REQUEST_KNOCKBACK(20)으로 자른다 (${cHost?.clamped})`);
  ok(!!cHost && cHost.charging === 0 && cHost.hitc === 0, `C-1: 돌진 중 베헤모스는 밀리지 않고, dmg 0 넉백 요청에는 hitc 가 없다 (${cHost?.charging}, hitc ${cHost?.hitc})`);
  ok(!!cHost && cHost.acidAt.length === 2 && cHost.acidAt.every((a) => a.to === 'others' && a.from?.length === 3 && a.dest?.length === 3) && cHost.acidPlayer === 0,
    `C-48: 적 표적 · 지점 표적 산성이 ee acidAt 으로 방송된다 (${cHost?.acidAt.length}건)`, JSON.stringify(cHost?.acidAt));
  await waitSim(2);
  const cAcid = await P(() => {
    const sys = window.__sys; const a = window.__cAcid;
    const rogue = sys.active.find((x) => x.id === a.rogue);
    const r = { hp0: a.hp, hp1: rogue ? rogue.hp : -1, dead: rogue ? rogue.isDead : null };
    for (const id of [a.rogue, a.w, a.b]) { const e = sys.active.find((x) => x.id === id); if (e && !e.isDead) e.kill(false); }
    return r;
  });
  ok(cAcid.hp1 >= 0 && cAcid.hp1 < cAcid.hp0, `X-5: 벌레 산성이 로그를 다치게 한다 (hp ${cAcid.hp0} → ${cAcid.hp1})`, JSON.stringify(cAcid));

  console.log('C batch (host): enemy footsteps near the camera (C-23)');
  const stepHost = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const pp = ctx.player.position;
    const e = sys.debugSpawn('warrior', { x: pp.x + 18, z: pp.z + 18 }, false);
    if (!e) return null;
    e.state = 'wander'; e.stateTime = 0; e.hasMoveTarget = true;
    e.moveTarget.set(pp.x + 18, 0, pp.z + 40);
    window.__hostSteps = [];
    window.__hostStepOff = ctx.bus.on('audio:play', (a) => { if (a.id.startsWith('footstep_') && a.position) window.__hostSteps.push({ id: a.id, v: a.volume }); });
    return { id: e.id };
  });
  await waitSim(2.5);
  const hostSteps = await P((id) => { window.__hostStepOff(); const e = window.__sys.active.find((x) => x.id === id); if (e && !e.isDead) e.kill(false); return window.__hostSteps; }, stepHost?.id);
  ok(hostSteps.length >= 1 && hostSteps.every((s) => Math.abs(s.v - 0.55) < 1e-6),
    `C-23: 권위 적 발소리 = footstep_<재질> · 볼륨은 타입 밑값 (${hostSteps.length}걸음, ${[...new Set(hostSteps.map((s) => `${s.id}@${s.v}`))].join(',')})`);

  /* ── burn credit ──────────────────────────────────────────────────────── */
  console.log('burn credit (applyStatus attacker → enemy:killed.by)');
  await waitSim(0.2);
  const burn0 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys;
    const pp = ctx.player.position;
    const e = sys.debugSpawn('scavenger', { x: pp.x + 80, z: pp.z + 80 }, false);
    if (!e) return null;
    window.__ev['enemy:killed'].length = 0;
    const kills0 = ctx.stats.kills;
    sys.applyStatus(e.id, 'burning', 1000, 3, 'peer-x');
    return { id: e.id, attacker: e.burnAttacker, kills0, lastDamager: e.lastDamager };
  });
  ok(burn0 && burn0.attacker === 'peer-x', `applyStatus(..., 'peer-x') stores burnAttacker (${burn0?.attacker})`);
  const burnKill = await untilSim((id) => { const e = window.__sys.find(id); return !e || !e.active || e.state === 'dead'; }, 3, burn0.id);
  ok(burnKill, 'the burn DoT kills the enemy');
  const burn1 = await P((a) => { const ctx = window.__game.ctx; const ev = window.__ev['enemy:killed'].filter((k) => k.id === a.id); return { ev, kills: ctx.stats.kills }; }, burn0);
  ok(burn1.ev.length === 1 && burn1.ev[0].by === 'peer-x', `enemy:killed.by === 'peer-x' (${JSON.stringify(burn1.ev[0])})`);
  ok(burn1.kills === burn0.kills0, `a remote credit does not bump ctx.stats.kills (${burn0.kills0} → ${burn1.kills})`);
  const burn2 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys;
    const pp = ctx.player.position;
    const e = sys.debugSpawn('scavenger', { x: pp.x + 82, z: pp.z + 80 }, false);
    if (!e) return null;
    window.__ev['enemy:killed'].length = 0;
    const kills0 = ctx.stats.kills;
    // the local player's own id (other folders pass `ctx.net?.localId ?? 'local'`) — folded back to 'local'
    sys.applyStatus(e.id, 'burning', 1000, 3, ctx.net?.localId ?? 'local');
    return { id: e.id, attacker: e.burnAttacker, kills0 };
  });
  ok(burn2 && burn2.attacker === 'local', `the local player's own id is normalized to 'local' (${burn2?.attacker})`);
  await untilSim((id) => { const e = window.__sys.find(id); return !e || !e.active || e.state === 'dead'; }, 3, burn2.id);
  const burn3 = await P((a) => { const ctx = window.__game.ctx; const ev = window.__ev['enemy:killed'].filter((k) => k.id === a.id); return { ev, kills: ctx.stats.kills }; }, burn2);
  ok(burn3.ev.length === 1 && burn3.ev[0].by === 'local' && burn3.kills === burn2.kills0 + 1, `a local burn kill counts and reports by 'local' (${JSON.stringify(burn3.ev[0])}, kills ${burn2.kills0} → ${burn3.kills})`);
  const burn4 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys;
    const pp = ctx.player.position;
    const e = sys.debugSpawn('warrior', { x: pp.x + 84, z: pp.z + 80 }, false);
    if (!e) return null;
    sys.applyStatus(e.id, 'burning', 1, 0.3, 'peer-y');
    return { id: e.id, attacker: e.burnAttacker };
  });
  await waitSim(0.8);
  const burn5 = await P((id) => { const e = window.__sys.find(id); const r = { attacker: e ? e.burnAttacker : 'gone', burning: e ? e.burnTimer > 0 : null }; if (e) e.kill(false); return r; }, burn4.id);
  ok(burn4.attacker === 'peer-y' && burn5.attacker === null && burn5.burning === false, `burnAttacker clears when the burn ends (${burn4.attacker} → ${burn5.attacker})`);

  /* ── enemy fire vs 배리어 ─────────────────────────────────────────────── */
  console.log('enemy fire vs barrier (raycastBarrier pure + damageBarrier)');
  const hasImplants = await P(() => !!window.__game.ctx.implants && typeof window.__game.ctx.implants.raycastBarrier === 'function' && typeof window.__game.ctx.implants.damageBarrier === 'function');
  ok(hasImplants, 'ctx.implants exposes raycastBarrier + damageBarrier');
  if (hasImplants) {
    const bar = await P(() => {
      const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
      const imp = ctx.implants;
      const orig = { ray: imp.raycastBarrier, dmg: imp.damageBarrier };
      const calls = [];
      let block = true;
      imp.raycastBarrier = (o, d, max, fromEnemy) => {
        if (!block || !fromEnemy) return null;
        return { point: new V(o.x + d.x * 1.5, o.y + d.y * 1.5, o.z + d.z * 1.5), owner: 'local' };
      };
      imp.damageBarrier = (owner, point) => { calls.push({ owner, point: [point.x, point.y, point.z] }); };
      const pp = ctx.player.position;
      const t = sys.targets.local();
      const rogue = sys.debugSpawn('rogue', { x: pp.x + 10, z: pp.z }, false);
      const r = { target: !!t, rogue: !!rogue };
      if (!t || !rogue) { imp.raycastBarrier = orig.ray; imp.damageBarrier = orig.dmg; return r; }
      rogue.yaw = Math.atan2(pp.x - rogue.position.x, pp.z - rogue.position.z);
      window.__ev['enemy:shot'].length = 0;
      const hp0 = ctx.player.hp;
      sys.fireGun(rogue, t, 0, 1);
      r.gun = { calls: calls.length, hp0, hp1: ctx.player.hp, shot: window.__ev['enemy:shot'][0] ?? null };
      // artillery landing on the player's feet
      calls.length = 0;
      sys.onShellLanded(999, new V(pp.x + 1, pp.y, pp.z));
      r.shell = { calls: calls.length, hp: ctx.player.hp };
      // acid direct hit
      calls.length = 0;
      const spewer = sys.debugSpawn('spewer', { x: pp.x - 10, z: pp.z }, false);
      sys.damageTargetAcid(t, 10, new V(pp.x - 0.5, pp.y + 1, pp.z), spewer ? spewer.id : -1, { duration: 1, factor: 0.55 });
      r.acid = { calls: calls.length, hp: ctx.player.hp };
      // no barrier → the same shot lands
      block = false;
      calls.length = 0;
      /* 2026-09-10: 방탄복은 이제 실드(추가 체력)라 피해가 hp 보다 **먼저 실드**를 깎는다 — 실효 체력으로 잰다. */
      const hpA = ctx.player.hp + ctx.player.shield;
      sys.fireGun(rogue, t, 0, 1);
      r.open = { calls: calls.length, hpA, hpB: ctx.player.hp + ctx.player.shield, shield: ctx.player.shield, maxShield: ctx.player.maxShield, shot: window.__ev['enemy:shot'][window.__ev['enemy:shot'].length - 1] ?? null };
      imp.raycastBarrier = orig.ray; imp.damageBarrier = orig.dmg;
      rogue.kill(false); if (spewer) spewer.kill(false);
      return r;
    });
    ok(bar.target && bar.rogue, 'local target + rogue ready for the barrier test');
    ok(bar.gun && bar.gun.calls === 1 && bar.gun.hp1 === bar.gun.hp0 && bar.gun.shot && bar.gun.shot.hit === false, `rogue hitscan: damageBarrier ×1, player hp unchanged, tracer stops (hit false)`, JSON.stringify(bar.gun));
    ok(bar.gun && bar.gun.shot && Math.hypot(bar.gun.shot.to[0] - bar.gun.shot.from[0], bar.gun.shot.to[2] - bar.gun.shot.from[2]) < 2, 'the tracer ends at the barrier point (≈1.5 m from the muzzle)', JSON.stringify(bar.gun?.shot));
    ok(bar.shell && bar.shell.calls === 1 && bar.shell.hp === bar.gun.hp0, 'artillery landing: damageBarrier ×1, no player damage', JSON.stringify(bar.shell));
    ok(bar.acid && bar.acid.calls === 1 && bar.acid.hp === bar.gun.hp0, 'acid hit: damageBarrier ×1, no player damage', JSON.stringify(bar.acid));
    ok(bar.open && bar.open.calls === 0 && bar.open.hpB < bar.open.hpA && bar.open.shot && bar.open.shot.hit === true, `without a barrier the same shot lands — 실효 체력(hp + 실드) ${bar.open?.hpA} → ${bar.open?.hpB}`, JSON.stringify(bar.open));
  }

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));
  ok(gameErrors.length === 0, `no console errors (${gameErrors.length}; ${errors.length - gameErrors.length} relay socket errors ignored)`, gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log('  FAIL', e.message);
  if (errors.length) console.log('  console errors:', errors.slice(0, 5).join(' | '));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
