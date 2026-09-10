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
import { startRelayServer } from './RelayServer.ts';
import { NET_DEFAULT_PORT, NET_WS_PATH, lanAddresses } from '../src/shared/net.ts';

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
  let server: Awaited<ReturnType<typeof startRelayServer>>;
  try {
    server = await startRelayServer({ port, host, dataDir });
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

  const shutdown = (signal: string): void => {
    console.log(`\n[서버] ${signal} → 종료합니다`);
    clearInterval(beat);
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
