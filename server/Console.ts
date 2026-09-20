/**
 * `server/Console.ts` — **what the person who started the server types into its window** (the operator console).
 *
 * It first appeared on 2026-09-11 (C-29) in the shipped server exe (`server/tool.ts`) and **moved here on
 * 2026-09-15** — builds ship no server (user's decision) and a server is started only from this repo's
 * `start-server.bat`, so the `npm run server` (`server/index.ts`) that bat launches is the one that owns the console.
 * In the default mode (`npm run dev:all`), `scripts/dev-all.mjs` forwards its window's input to the relay child.
 *
 * There is no ban — `kick` only drops the current connection and frees the slot; it does not stop the same person
 * from connecting again (the game side merely stops auto-reconnecting once it is told `kicked`).
 *
 * ⚠ **No stdin must never block or kill the server.** The verify runner · the smokes start the relay with
 * `stdio: ignore` (EOF at once) or with a pipe nobody reads. readline closes quietly on EOF, stream errors are
 * swallowed, and a command that throws prints one line.
 */
import { createInterface } from 'node:readline';
import type { RelayServer } from './RelayServer.ts';
import { formatPlayerCode } from '../src/shared/social.ts';

/** One-line summary of the command list — the same order as `index.ts`'s startup line and the bat's banner. */
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

/** Pad by display width (Hangul = 2 columns), so the table lines up in a Windows console. */
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
        // 2026-09-15: an undocked squad (only an invite passed — each member is in their own personal ship) is
        // marked separately. A lobby with no such field is a docked one.
        const undocked = (l as unknown as { docked?: boolean }).docked === false ? '  도킹 전 분대' : '';
        /* 2026-09-15: android squadmates (bot members) are counted apart from humans — the 「N명」 is the humans. */
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
 * Reads stdin line by line and runs the commands. With no input (`stdio: ignore` · a service) readline closes at once
 * and the server carries on — only the console is gone. A broken pipe (`EPIPE` · `ECONNRESET`) means the same.
 */
export function startServerConsole(server: RelayServer, input: NodeJS.ReadableStream = process.stdin): ServerConsole | null {
  if (!(input as NodeJS.ReadStream).readable) return null;
  input.on('error', () => { /* the input is gone — only the console is lost */ });
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
