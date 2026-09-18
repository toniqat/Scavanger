import type { SocialErrorCode, WhisperLine } from '@/shared';
import { SOCIAL_ERROR_MESSAGE_KO } from '@/shared';

/**
 * A private chat line’s delivery state in one line (2026-09-11, B-4; it was called 귓속말 before 2026-09-14). It lives here alone
 * so the chat log (`hud/ChatLog`) and the messenger conversation (`menus/messenger/ChatTab`) use the **same words**. An empty string = nothing to add (an incoming line · a delivered line).
 */
const FAIL_SHORT_KO: Partial<Record<SocialErrorCode, string>> = {
  offline: '오프라인',
  not_found: '없는 아이디',
  unavailable: '연결 끊김',
  invalid: '잘못된 요청',
  self: '본인',
};

export function whisperStateText(line: WhisperLine): string {
  if (!line.out) return line.backlog ? '접속 전에 받음' : '';
  switch (line.state) {
    case 'pending': return '전송 중…';
    case 'stored': return '오프라인 보관 — 접속하면 전달';
    case 'failed': {
      const code = line.failCode ?? 'offline';
      return `전송 실패 — ${FAIL_SHORT_KO[code] ?? SOCIAL_ERROR_MESSAGE_KO[code] ?? '알 수 없음'}`;
    }
    default: return '';
  }
}

/** `.chat-line` / `.sc-logline` modifier for a line's delivery state (`pending` · `stored` · `failed`, '' otherwise). */
export function whisperStateClass(line: WhisperLine): string {
  if (!line.out) return line.backlog ? 'backlog' : '';
  return line.state === 'pending' || line.state === 'stored' || line.state === 'failed' ? line.state : '';
}
