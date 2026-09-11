/**
 * `server/tool.ts` — **배포용 서버 툴의 엔트리**.
 *
 * `index.ts` 는 저장소에서 `npm run server` 로 도는 개발용 엔트리다. 이 파일은 그것과 **같은 릴레이**를
 * (`startRelayServer`) 다른 껍데기로 감싼다: 받는 사람이 저장소도 Node 도 없이 `SCAVANGER-Server.exe` 를
 * 더블클릭하는 상황이 전부이므로,
 *
 *   ① 친구에게 그대로 불러 줄 **주소를 큰 배너로** 찍는다 (LAN IPv4 는 `shared/net.lanAddresses` 순위로 고른다),
 *   ② 프로필 저장소를 **exe 옆이 아니라 사용자 폴더**(`%LOCALAPPDATA%\\SCAVANGER\\server`)에 둔다 — 배포
 *      폴더에는 사람이 고치는 `server.txt` 하나만 있어야 한다는 결정 때문이다 (`scripts/pack-release.mjs`),
 *   ③ 죽을 때 **창을 닫지 않는다** — 더블클릭으로 띄운 콘솔은 에러 한 줄과 함께 사라지면 아무 정보도 남지 않는다,
 *   ④ 사람 수 · 로비 수가 **변할 때만** 한 줄 찍는다 (조용한 서버는 조용하게).
 *
 * 이 파일은 SEA(단독 exe)로 구워지므로 `import.meta` 를 쓰지 않는다 — 번들이 CJS 다 (`scripts/build-server.mjs`).
 * `server/` 의 규칙(erasable TypeScript · 상대 import 에 `.ts` · 타입은 `import type`)은 그대로 지킨다.
 */
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { startRelayServer, type RelayServer } from './RelayServer.ts';
import { NET_DEFAULT_PORT, NET_WS_PATH, lanAddresses } from '../src/shared/net.ts';
import { formatPlayerCode } from '../src/shared/social.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const port = Number(flag('port') ?? process.env.PORT ?? NET_DEFAULT_PORT) || NET_DEFAULT_PORT;
const host = flag('host') ?? process.env.HOST ?? '0.0.0.0';

/**
 * 프로필 · 소셜 저장소가 사는 곳. 기본은 사용자 폴더이고 `--data=<dir>` 로 옮긴다 (USB 로 서버를 들고
 * 다니는 사람은 `--data=.\\data`). 지우면 그 서버의 모든 계정이 사라지는 폴더라 배너에 경로를 찍는다.
 */
function defaultDataDir(): string {
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA ?? process.env.APPDATA ?? process.cwd())
    : (process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? process.cwd(), '.local', 'share'));
  return process.platform === 'win32' ? join(base, 'SCAVANGER', 'server') : join(base, 'scavanger-server');
}
const dataDir = flag('data') ?? process.env.SCAV_DATA_DIR ?? defaultDataDir();
/** 2026-09-11 (C-29): 시작할 때의 접속 인원 제한 (`--max=<n>` · `SCAV_MAX_CLIENTS`). 없으면 무제한 — 콘솔 `max` 로 바꾼다. */
const maxClients = Number(flag('max') ?? process.env.SCAV_MAX_CLIENTS ?? 0) || null;

/* ── 서버 콘솔 (2026-09-11, C-29) ─────────────────────────────────────────
 * 서버를 켠 사람이 창에 명령을 친다. 밴은 없다 — `kick` 은 지금 연결을 끊고 슬롯을 비울 뿐이고, 같은 사람이
 * 다시 붙는 것은 막지 않는다 (게임 쪽은 `kicked` 를 받으면 자동 재접속만 멈춘다). stdin 이 없는 실행
 * (서비스 · 스모크의 `stdio: ignore`)에서는 readline 이 곧바로 닫히고, 그래도 서버는 계속 돈다.
 */
const HELP = [
  '  list              접속 중인 사람 (아이디 · 이름 · 함선 · 접속 시간 · 주소)',
  '  lobbies           열린 함선(로비)과 대원 — 끊겨서 재접속을 기다리는 대원도 보인다',
  '  kick <아이디> [사유]  연결을 끊고 함선 슬롯을 곧바로 비운다 (재접속 유예 없음, 밴 아님)',
  '  max <인원>         새 접속 인원 제한 (0 · off = 무제한). 재접속 중인 대원은 막지 않는다',
  '  help              이 목록',
].join('\n');

function since(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
}

/** Pad by display width (한글 = 2 columns), so the table lines up in a Windows console. */
function pad(text: string, width: number): string {
  let w = 0;
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
  return text + ' '.repeat(Math.max(1, width - w));
}

function runConsoleCommand(server: RelayServer, input: string): string {
  const [cmd = '', ...rest] = input.trim().split(/\s+/);
  switch (cmd.toLowerCase()) {
    case '':
      return '';
    case 'help': case '?': case '도움말':
      return HELP;
    case 'list': case 'ls': {
      const rows = server.listClients();
      const cap = server.maxClients;
      const head = `접속 ${rows.length}명${cap !== null ? ` (제한 ${cap}명)` : ''}`;
      if (rows.length === 0) return head;
      const lines = [head, `  ${pad('아이디', 11)}${pad('이름', 18)}${pad('함선', 9)}${pad('접속', 10)}주소`];
      for (const r of rows) {
        const id = r.code ? formatPlayerCode(r.code) : `(${r.id})`;
        const ship = r.lobby ? `${r.lobby}${r.host ? '*' : ''}` : '-';
        const state = r.inMission ? ' 임무 중' : '';
        lines.push(`  ${pad(id, 11)}${pad(r.name || '(이름 없음)', 18)}${pad(ship, 9)}${pad(since(r.connectedAt), 10)}${r.remote}${state}`);
      }
      lines.push('  (* = 분대장. 아이디가 괄호면 익명 접속 — kick 에는 괄호 안의 값을 쓴다)');
      return lines.join('\n');
    }
    case 'lobbies': case 'lobby': {
      const all = [...server.lobbies.lobbies.values()];
      if (all.length === 0) return '열린 함선 없음';
      const lines = [`함선 ${all.length}개`];
      for (const l of all) {
        const mode = l.started ? (l.mode === 'training' ? '훈련 중' : '임무 중') : '대기';
        lines.push(`  ${l.code}  ${mode}  ${l.size}명${l.isPublic ? '  공개' : ''}${l.planet ? `  행성 ${l.planet}` : ''}`);
        for (const p of l.players.values()) {
          const code = server.store.card(p.id)?.code;
          const tags = [p.id === l.hostId ? '분대장' : '', p.connected ? '' : '재접속 대기', p.inMission && l.started ? '임무 안' : '']
            .filter(Boolean).join(' · ');
          lines.push(`      ${pad(code ? formatPlayerCode(code) : `(${p.id})`, 11)}${pad(p.name || '(이름 없음)', 18)}${tags}`);
        }
      }
      return lines.join('\n');
    }
    case 'kick': {
      const target = rest[0];
      if (!target) return '사용법: kick <아이디> [사유]   (아이디는 list 로 확인)';
      const res = server.kick(target, rest.slice(1).join(' ') || undefined);
      if (!res.ok) return `없는 아이디입니다: ${target}   (list · lobbies 로 확인)`;
      const where = res.lobby ? ` · 함선 ${res.lobby} 에서 뺐습니다` : '';
      return `${res.name || res.id} 을(를) 내보냈습니다${where}${res.connected ? '' : ' (이미 끊겨 있던 대원 — 슬롯만 비움)'}`;
    }
    case 'max': {
      const raw = rest[0];
      if (raw === undefined) return `접속 인원 제한: ${server.maxClients ?? '무제한'} (지금 ${server.clientCount()}명)`;
      const off = /^(0|off|none|무제한)$/i.test(raw);
      const n = Number(raw);
      if (!off && (!Number.isInteger(n) || n < 1)) return '사용법: max <인원>   (0 또는 off = 무제한)';
      server.setMaxClients(off ? null : n);
      const now = server.clientCount();
      const over = !off && now > n ? ` — 이미 접속한 ${now}명은 그대로 두고, 새 접속만 막습니다` : '';
      return `접속 인원 제한: ${off ? '무제한' : `${n}명`}${over}`;
    }
    default:
      return `모르는 명령입니다: ${cmd}   (help)`;
  }
}

function startConsole(server: RelayServer): ReadlineInterface | null {
  if (!process.stdin.readable) return null;
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    try {
      const out = runConsoleCommand(server, line);
      if (out) console.log(out);
    } catch (e) {
      console.error(`[서버] 명령 실패: ${(e as Error).message}`);
    }
  });
  // stdin 이 닫혀도(서비스 · 파이프) 서버는 계속 돈다 — 콘솔만 없어진다.
  rl.on('close', () => { /* no console */ });
  return rl;
}

/** 창을 닫지 않고 기다린다 (더블클릭으로 띄운 콘솔에서 에러를 읽을 수 있게). */
function holdOpen(): void {
  if (!process.stdin.isTTY) return;
  console.log('\n이 창은 아무 키를 누르면 닫힙니다.');
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  } catch {
    // raw 모드가 없는 콘솔이면 그냥 그대로 남는다 (사용자가 창을 닫는다).
  }
}

/**
 * SEA 번들은 **CJS** 다 (`scripts/build-server.mjs`) — top-level await 이 없다. 그래서 부팅 전체를 한 함수에
 * 담고 마지막에 한 번 부른다. `index.ts` 쪽은 여전히 top-level await 로 둔다 (그건 ESM 으로만 돈다).
 */
async function main(): Promise<void> {
  let server: RelayServer;
  try {
    server = await startRelayServer({ port, host, dataDir, maxClients });
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    console.error(`\n[서버] 시작하지 못했습니다: ${msg}`);
    if (/EADDRINUSE/i.test(msg)) {
      console.error(`  포트 ${port} 를 이미 다른 프로그램이 쓰고 있습니다.`);
      console.error(`  다른 포트로 켜려면: SCAVANGER-Server.exe --port=${port + 1}`);
      console.error('  (그 경우 접속하는 사람도 주소 끝에 같은 포트를 적어야 합니다)');
    }
    holdOpen();
    if (!process.stdin.isTTY) process.exit(1);
    return;
  }

  const lan = lanAddresses(networkInterfaces());
  const addr = lan[0]?.address ?? '이_PC_의_IP';
  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log('  SCAVANGER 서버가 켜졌습니다.');
  console.log('');
  console.log('  게임에서 [설정 › 서버 설정] 에 이 주소를 적으세요');
  console.log(`      ${addr}${port === NET_DEFAULT_PORT ? '' : `:${port}`}`);
  console.log('');
  console.log(`  전체 주소 : ws://${addr}:${port}${NET_WS_PATH}`);
  console.log(`  상태 확인 : http://${addr}:${port}/health`);
  console.log(`  저장 폴더 : ${dataDir}`);
  if (lan.length > 1) {
    console.log('');
    console.log('  이 PC 의 다른 주소 (위 주소로 안 되면 아래를 차례로 시도)');
    for (const c of lan.slice(1)) console.log(`      ${c.address.padEnd(16)} ${c.name}`);
  }
  console.log('');
  console.log('  처음 켜면 Windows 방화벽 창이 뜹니다 — 허용해야 다른 PC 가 붙습니다.');
  console.log('  인터넷(외부)에서 붙게 하려면 공유기에서 이 포트를 포워딩하세요.');
  console.log('  이 창을 닫거나 Ctrl+C 를 누르면 서버가 꺼집니다.');
  console.log('  명령: list · lobbies · kick <아이디> · max <인원> · help');
  console.log(`${line}\n`);

  /* 조용한 서버는 조용하게: 숫자가 바뀔 때만 한 줄. `/health` 와 같은 값을 본다. */
  let last = '접속 0명 · 로비 0개';   // 아무도 없는 상태는 이미 배너가 말했다 — 첫 손님부터 찍는다.
  const beat = setInterval(() => {
    const now = `접속 ${server.clientCount()}명 · 로비 ${server.lobbies.count}개`;
    if (now === last) return;
    last = now;
    console.log(`[서버] ${new Date().toLocaleTimeString('ko-KR')}  ${now}`);
  }, 5000);
  beat.unref();

  const consoleInput = startConsole(server);

  const shutdown = (signal: string): void => {
    console.log(`\n[서버] ${signal} → 종료합니다`);
    clearInterval(beat);
    consoleInput?.close();
    void server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

process.on('uncaughtException', (e) => { console.error('[서버] uncaughtException', e); });
process.on('unhandledRejection', (e) => { console.error('[서버] unhandledRejection', e); });

void main();
