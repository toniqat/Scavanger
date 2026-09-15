/**
 * `server/Console.ts` — **서버를 켠 사람이 창에 치는 명령** (운영 콘솔).
 *
 * 2026-09-11 (C-29) 에 배포용 서버 exe(`server/tool.ts`)에 처음 생겼고, **2026-09-15 에 여기로 옮겼다** — 빌드에서
 * 서버를 빼고(사용자 결정) 서버는 이 저장소의 `start-server.bat` 로만 켜기로 했으므로, 그 bat 가 띄우는
 * `npm run server`(`server/index.ts`)가 콘솔을 갖는다. 기본 모드(`npm run dev:all`)에서는 `scripts/dev-all.mjs` 가
 * 자기 창의 입력을 줄 단위로 릴레이 자식에게 넘긴다.
 *
 * 밴은 없다 — `kick` 은 지금 연결을 끊고 슬롯을 비울 뿐이고, 같은 사람이 다시 붙는 것은 막지 않는다 (게임 쪽은
 * `kicked` 를 받으면 자동 재접속만 멈춘다).
 *
 * ⚠ **stdin 이 없어도 서버를 막거나 죽이지 않는다.** verify 러너 · 스모크는 릴레이를 `stdio: ignore`(곧바로 EOF) 나
 * 쓰지 않는 파이프로 띄운다. readline 은 EOF 에 조용히 닫히고, 스트림 오류는 삼키고, 명령 하나가 던져도 한 줄만 찍는다.
 */
import { createInterface } from 'node:readline';
import type { RelayServer } from './RelayServer.ts';
import { formatPlayerCode } from '../src/shared/social.ts';

/** 명령 목록 한 줄 요약 — `index.ts` 의 시작 줄 · `start-server.bat` 배너와 같은 순서다. */
export const CONSOLE_COMMANDS_LINE = 'list · lobbies · kick <아이디> [사유] · max <인원> · gc · help';

const HELP = [
  '  list              접속 중인 사람 (아이디 · 이름 · 함선 · 접속 시간 · 주소)',
  '  lobbies           열린 함선(로비)과 대원 — 끊겨서 재접속을 기다리는 대원도 보인다',
  '  kick <아이디> [사유]  연결을 끊고 함선 슬롯을 곧바로 비운다 (재접속 유예 없음, 밴 아님)',
  '  max <인원>         새 접속 인원 제한 (0 · off = 무제한). 재접속 중인 대원은 막지 않는다',
  '  gc                프로필 정리를 지금 한 번 — 90일 안 온 프로필 삭제, 30일 지난 최근 목록 · 친구 요청 만료 (6시간마다 자동)',
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

/** One console line → the text to print ('' = print nothing). Pure apart from the operator API calls. */
export function runConsoleCommand(server: RelayServer, input: string): string {
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
        // 2026-09-15: 도킹 전 분대(초대만 오간 사이 — 각자 개인 함선에 있다)는 따로 적는다. 필드가 없는 로비는 도킹한 것이다.
        const undocked = (l as unknown as { docked?: boolean }).docked === false ? '  도킹 전 분대' : '';
        /* 2026-09-15: 안드로이드 분대원(봇 멤버)은 사람과 따로 센다 — 「N명」은 사람 수다. */
        const bots = l.botCount();
        lines.push(`  ${l.code}  ${mode}  ${l.humanCount()}명${bots ? ` + 안드로이드 ${bots}기` : ''}${l.isPublic ? '  공개' : ''}${undocked}${l.planet ? `  행성 ${l.planet}` : ''}`);
        for (const p of l.players.values()) {
          const code = server.store.card(p.id)?.code;
          const tags = [p.bot ? `안드로이드 (슬롯 ${p.bay ?? '?'})` : '', p.id === l.hostId ? '분대장' : '', p.bot || p.connected ? '' : '재접속 대기', p.inMission && l.started ? '임무 안' : '']
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
    case 'gc': {
      const r = server.collectGarbage();
      return `프로필 정리: 삭제 ${r.removed.length}개 · 사라진 아이디 ${r.danglingRefs}줄 · 오래된 최근 목록 ${r.expiredRecent}줄 · `
        + `오래된 친구 요청 ${r.expiredRequests}줄 (남은 프로필 ${server.store.size}개)`;
    }
    default:
      return `모르는 명령입니다: ${cmd}   (help)`;
  }
}

export interface ServerConsole {
  close(): void;
}

/**
 * stdin 을 줄 단위로 읽어 명령을 돌린다. 입력이 없는 실행(`stdio: ignore` · 서비스)에서는 readline 이 곧바로 닫히고
 * 서버는 그대로 돈다 — 콘솔만 없어진다. 파이프가 깨지는 오류(`EPIPE` · `ECONNRESET`)도 같은 뜻이다.
 */
export function startServerConsole(server: RelayServer, input: NodeJS.ReadableStream = process.stdin): ServerConsole | null {
  if (!(input as NodeJS.ReadStream).readable) return null;
  input.on('error', () => { /* 입력이 끊겼다 — 콘솔만 없어진다 */ });
  let rl;
  try {
    rl = createInterface({ input, terminal: false });
  } catch {
    return null;
  }
  rl.on('line', (line) => {
    try {
      const out = runConsoleCommand(server, line);
      if (out) console.log(out);
    } catch (e) {
      console.error(`[서버] 명령 실패: ${(e as Error).message}`);
    }
  });
  rl.on('close', () => { /* stdin EOF: no console, the relay keeps running */ });
  return { close: () => rl.close() };
}
