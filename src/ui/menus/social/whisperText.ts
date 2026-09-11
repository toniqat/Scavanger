import type { SocialErrorCode, WhisperLine } from '@/shared';
import { SOCIAL_ERROR_MESSAGE_KO } from '@/shared';

/**
 * 귓속말 전송 상태를 한 줄로 (2026-09-11, B-4). 채팅 로그(`hud/ChatLog`)와 대화 기록 화면(`SocialPages`)이 **같은
 * 문구**를 쓰도록 여기 하나에 둔다. 빈 문자열 = 덧붙일 말 없음 (받은 줄 · 전달된 줄).
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
