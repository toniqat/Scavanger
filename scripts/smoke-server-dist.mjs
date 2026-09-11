#!/usr/bin/env node
/**
 * 배포용 서버 빌드(`npm run server:dist`)와 **주소 규약**을 브라우저 없이 검사한다.
 *
 * 여기서 굽는 것은 exe 가 아니라 그 앞 단계인 **번들**(`dist-server/server.cjs`)이다 — 86 MB 짜리 node.exe
 * 사본을 매 검증마다 만들 이유가 없고, 배포에서 깨질 수 있는 것은 전부 그 앞에 있다: CJS 로 묶였는지
 * (top-level await 이 섞이면 여기서 죽는다), `ws` 가 번들에 들어갔는지, 저장 폴더 · 포트 인자가 먹는지,
 * 그리고 릴레이가 실제로 말을 하는지. exe 단계는 postject 주입뿐이라 한 번 확인하면 회귀하지 않는다.
 *
 * 마지막으로 `shared/net` 의 순수 함수 둘(`relayUrlFrom` · `lanAddresses`)을 검사한다 — 설정 화면 · 렌더러 ·
 * 데스크톱 셸 · 서버 배너가 **모두** 이 둘을 부르므로, 여기가 틀리면 "설정에서 초록불인데 다른 데 붙는다"가 된다.
 *
 * Usage: node scripts/smoke-server-dist.mjs   (vite 도 릴레이도 필요 없다; 인자는 무시한다)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const bundle = join(root, 'dist-server', 'server.cjs');
// 8787(릴레이) · 8790-8799(데스크톱 창 서버)를 피한 대역. 병렬 레인이 겹쳐도 안전하다.
// 예약표 (2026-09-11 E-3): 8820–8829 · 9340–9341 = smoke-desktop (창 8820 · 임베디드 릴레이 8821 · 두 번째 창 8822 ·
// 프록시 모드 외부 릴레이 8823 · 렌더러 원격 디버깅 9340 · 메인 프로세스 인스펙터 9341) · 8830–8869 = 이 스크립트.
const PORT = 8830 + Math.floor(Math.random() * 40);

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── ① 번들 ─────────────────────────────────────────────────────────── */
console.log('server-dist: bundle');
const build = spawnSync(process.execPath, [join(here, 'build-server.mjs'), '--bundle-only'], { encoding: 'utf8' });
ok(build.status === 0, 'server:bundle 이 성공한다', build.stderr?.slice(0, 300) ?? '');
ok(existsSync(bundle), 'dist-server/server.cjs 가 생겼다');
const code = existsSync(bundle) ? readFileSync(bundle, 'utf8') : '';
// CJS 규약: require 로 돌고, top-level await 이 없어야 한다 (SEA main 은 CommonJS 다).
ok(/require\(/.test(code), '번들이 CJS 다 (require 가 있다)');
/* 2026-09-11: 예전 검사는 `^\s*await` 줄 정규식이라 **함수 안의** await 줄(`Store.ts` 의 비동기 쓰기)까지 걸렸다.
   진짜 기준은 "CommonJS 로 파싱되는가" 이다 — `.cjs` 를 `node --check` 하면 top-level await 은 SyntaxError 다. */
const cjsCheck = spawnSync(process.execPath, ['--check', bundle], { encoding: 'utf8' });
ok(cjsCheck.status === 0, 'top-level await 이 없다 (CommonJS 로 파싱된다)', cjsCheck.stderr?.slice(0, 300) ?? '');
// ws 가 번들에 들어갔는지: 없으면 배포한 PC 에서 MODULE_NOT_FOUND 로 죽는다.
ok(/WebSocketServer/.test(code) && !/require\(["']ws["']\)/.test(code), 'ws 가 번들 안에 있다 (외부 require 아님)');
// 반대로 선택적 네이티브 가속은 external 로 남아 있어야 한다 (ws 가 try/catch 로 감싸 부른다).
ok(/require\(["']bufferutil["']\)/.test(code), 'bufferutil 은 external 로 남았다');

/* ── ② 그 번들로 서버를 켠다 ────────────────────────────────────────── */
console.log('server-dist: boot');
const dataDir = mkdtempSync(join(tmpdir(), 'scav-srv-'));
// stdin 을 파이프로 연다 — ⑤ 가 서버 콘솔 명령(C-29)을 친다.
const proc = spawn(process.execPath, [bundle, `--port=${PORT}`, `--data=${dataDir}`], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
proc.stdout.on('data', (d) => { out += d.toString(); });
proc.stderr.on('data', (d) => { out += d.toString(); });

let health = null;
for (let i = 0; i < 60 && !health; i++) {
  await sleep(150);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (res.ok) health = await res.json();
  } catch { /* 아직 안 떴다 */ }
}
ok(!!health?.ok, `GET /health 가 답한다 (포트 ${PORT})`, out.slice(0, 300));
ok(out.includes('SCAVANGER 서버가 켜졌습니다'), '배너를 찍는다');
ok(out.includes(`ws://`) && out.includes(`:${PORT}/ws`), '배너에 접속 주소가 있다');
ok(out.includes(dataDir), '배너에 저장 폴더가 있다 (--data 가 먹었다)');

/* ── ③ 실제 릴레이 프로토콜 (welcome → 로비 생성) ──────────────────── */
const wire = await new Promise((resolve) => {
  const got = [];
  let ws;
  try { ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); } catch { resolve(got); return; }
  const done = setTimeout(() => { try { ws.close(); } catch { /* already gone */ } resolve(got); }, 4000);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'lobby:create', name: '검사원' }));
  ws.onmessage = (ev) => {
    try { got.push(JSON.parse(String(ev.data))); } catch { /* not json */ }
    if (got.some((m) => m.t === 'lobby:state')) { clearTimeout(done); ws.close(); resolve(got); }
  };
  ws.onerror = () => { clearTimeout(done); resolve(got); };
});
ok(wire.some((m) => m.t === 'welcome' && typeof m.id === 'string'), 'welcome 이 온다');
const state = wire.find((m) => m.t === 'lobby:state');
ok(!!state?.lobby?.code && state.lobby.code.length === 6, '로비가 만들어지고 6자 코드가 온다');

/* ── ③b 서버 크레딧 검증 (2026-09-11, E-4) — 경제 표가 번들 안에 있고, 배포 exe 는 dev 사유를 거절한다 ──── */
console.log('server-dist: credits (E-4)');
const econ = JSON.parse(readFileSync(join(root, 'server', 'economy.gen.json'), 'utf8'));
const credits = await import('../src/shared/credits.ts');
ok(typeof econ.hash === 'string' && econ.hash.length > 0 && code.includes(econ.hash), `경제 표(economy.gen.json, hash ${econ.hash})가 번들에 인라인됐다`);
const [cheapId, cheapIt] = Object.entries(econ.items).find(([, it]) => credits.tableMinBuyPrice(econ, it.value) <= 500);
const cheapPrice = credits.tableMinBuyPrice(econ, cheapIt.value);
const txs = await new Promise((resolve) => {
  const got = {};
  let ws;
  try { ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${'k'.repeat(24)}&n=dist`); } catch { resolve(got); return; }
  const done = setTimeout(() => { try { ws.close(); } catch { /* gone */ } resolve(got); }, 4000);
  const plan = [
    { txId: 1, delta: 1_000, reason: 'migrate' },
    { txId: 2, delta: 5, reason: 'smoke:dist' },
    { txId: 3, delta: -cheapPrice, reason: `buy:${cheapId}` },
    { txId: 4, delta: 1, reason: 'console' },
  ];
  ws.onmessage = (ev) => {
    let m = null; try { m = JSON.parse(String(ev.data)); } catch { /* not json */ }
    if (m?.t === 'welcome') for (const p of plan) ws.send(JSON.stringify({ t: 'credits:tx', ...p }));
    if (m?.t === 'credits:result') got[m.txId] = m;
    if (Object.keys(got).length === plan.length) { clearTimeout(done); ws.close(); resolve(got); }
  };
  ws.onerror = () => { clearTimeout(done); resolve(got); };
});
ok(txs[1]?.ok === true && txs[1].credits === 1_000 && txs[3]?.ok === true && txs[3].credits === 1_000 - cheapPrice,
  `정상 사유(migrate · buy:${cheapId} −${cheapPrice})는 받는다`, JSON.stringify(txs));
ok(txs[2]?.ok === false && txs[2].reason === credits.CREDIT_TX_INVALID_KO && txs[4]?.ok === false && txs[4].reason === credits.CREDIT_TX_INVALID_KO,
  '배포 exe 는 dev 사유(smoke:* · console)를 거절한다 (SCAV_DEV_ECONOMY 를 읽지 않는다)', JSON.stringify(txs));
await sleep(200);   // the socket above must be gone before ⑤ counts connections against `max 1`

/* ── ⑤ 서버 콘솔 (2026-09-11, C-29) — 번들 그대로, stdin 으로 명령을 친다 ─────────────── */
console.log('server-dist: console');
const typed = async (line, expect, ms = 3000) => {
  const from = out.length;
  proc.stdin.write(`${line}\n`);
  for (let t = 0; t < ms; t += 50) { if (expect.test(out.slice(from))) return out.slice(from); await sleep(50); }
  return out.slice(from);
};
/** Anonymous socket: resolves with every frame it saw until it closed (or `ms`). */
const dial = (onWelcome) => new Promise((resolve) => {
  const frames = []; let code = 0;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const done = setTimeout(() => { try { ws.close(); } catch { /* gone */ } resolve({ frames, code }); }, 4000);
  ws.onmessage = (ev) => {
    let m = null; try { m = JSON.parse(String(ev.data)); } catch { /* not json */ }
    if (m) frames.push(m);
    if (m?.t === 'welcome') onWelcome?.(m, ws);
  };
  ws.onclose = (ev) => { code = ev.code; clearTimeout(done); resolve({ frames, code }); };
  ws.onerror = () => { /* onclose follows */ };
});
ok(/kick <아이디>/.test(await typed('help', /max <인원>/)), 'help 가 명령 목록을 찍는다');
/* 2026-09-11 (B-2): 새로 켠 저장소라 지울 것이 없다 — 명령이 번들 안에서 돌고 결과 줄을 찍는지만 본다. */
ok(/프로필 정리: 삭제 0개/.test(await typed('gc', /프로필 정리/)), 'gc 가 프로필 정리 결과를 찍는다');
ok(/접속 인원 제한: 1명/.test(await typed('max 1', /접속 인원 제한/)), 'max 1 이 먹는다');
let firstId = '';
const firstSocket = dial((m) => { firstId = m.id; });
for (let t = 0; t < 3000 && !firstId; t += 50) await sleep(50);
ok(!!firstId, '제한 안의 첫 접속은 welcome 을 받는다');
const second = await dial();
ok(second.frames[0]?.t === 'lobby:error' && second.frames[0]?.code === 'server_full' && second.code === 4003
  && !second.frames.some((f) => f.t === 'welcome'), '제한을 넘은 접속은 welcome 없이 server_full → 4003 으로 닫힌다', JSON.stringify(second));
const listed = await typed('list', /접속 1명/);
ok(listed.includes('접속 1명 (제한 1명)') && listed.includes(firstId), 'list 가 인원 · 제한 · 익명 아이디를 찍는다', listed.slice(0, 300));
ok(/없는 아이디/.test(await typed('kick ZZZZ-ZZZZ', /없는 아이디|내보냈/)), '없는 아이디 kick 은 거절한다');
const kickedOut = await typed(`kick ${firstId} 콘솔검사`, /내보냈|없는 아이디/);
const first = await firstSocket;
ok(/내보냈습니다/.test(kickedOut) && first.frames.some((f) => f.t === 'lobby:error' && f.code === 'kicked' && String(f.message).includes('콘솔검사'))
  && first.code === 4002, 'kick <아이디> [사유] 가 그 소켓을 kicked → 4002 로 닫는다', `${kickedOut.slice(0, 200)} ${JSON.stringify(first)}`);
ok(/무제한/.test(await typed('max off', /접속 인원 제한/)), 'max off = 무제한');
ok(/모르는 명령/.test(await typed('nope', /모르는 명령/)), '모르는 명령은 help 를 가리킨다');
proc.kill();
await sleep(300);
try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 잠겨 있으면 임시 폴더로 남는다 */ }

/* ── ④ 주소 규약 (모든 폴더가 같은 함수를 본다) ────────────────────── */
console.log('server-dist: address rules');
const { relayUrlFrom, lanAddresses, NET_DEFAULT_PORT, NET_WS_PATH } = await import('../src/shared/net.ts');
ok(relayUrlFrom('192.168.0.12') === `ws://192.168.0.12:${NET_DEFAULT_PORT}${NET_WS_PATH}`, '맨 주소에 포트 · 경로를 채운다');
ok(relayUrlFrom('192.168.0.12:9000') === `ws://192.168.0.12:9000${NET_WS_PATH}`, '포트만 적어도 경로를 채운다');
ok(relayUrlFrom(' ws://a.b:1/ws ') === 'ws://a.b:1/ws', '완전한 주소는 그대로 (공백만 떼고)');
ok(relayUrlFrom('wss://host/ws') === 'wss://host:8787/ws', 'wss 도 받는다');
ok(relayUrlFrom('') === null && relayUrlFrom('   ') === null, '빈 값 = null (= 기본값을 쓴다)');
ok(relayUrlFrom('ws://') === null && relayUrlFrom('::::') === null, '형식이 아니면 null');
ok(!relayUrlFrom('192.168.0.12?t=abc')?.includes('?'), '쿼리는 떼어 낸다 (세션 토큰은 접속할 때 붙는다)');

const ranked = lanAddresses(networkInterfaces());
ok(Array.isArray(ranked), 'lanAddresses 가 배열을 돌려준다');
ok(ranked.every((c) => /^\d+\.\d+\.\d+\.\d+$/.test(c.address)), 'IPv4 만 남는다');
ok(!ranked.some((c) => c.address.startsWith('127.')), '루프백은 빠진다');
const fake = lanAddresses({
  'vEthernet (WSL)': [{ address: '172.20.0.1', family: 'IPv4', internal: false }],
  'Ethernet': [{ address: '192.168.0.12', family: 'IPv4', internal: false }],
  'Loopback': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
});
ok(fake[0]?.address === '192.168.0.12', '가상 어댑터보다 실제 LAN 이 먼저다', JSON.stringify(fake));

// verify.mjs 의 `summarize` 가 읽는 형식 (C-46): FAIL 줄 + 마지막 `N passed, M failed`.
console.log(`\nserver-dist: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
