import type { RoomLine } from '@/shared';
import { formatPlayerCode, roomSystemTextKo } from '@/shared';

/** 메신저 글자 도우미 (2026-09-14). DOM 없음. */

const two = (n: number): string => n.toString().padStart(2, '0');

/** 말풍선 시각: 오늘이면 `HH:MM`, 아니면 `MM-DD HH:MM`. 0 이하는 ''. */
export function clockText(at: number, now = Date.now()): string {
  if (!(at > 0)) return '';
  const d = new Date(at);
  const n = new Date(now);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
}

/** 목록 한 줄의 시각: 방금 · n분 · n시간 · n일. 0 이하는 ''. */
export function agoText(at: number, now = Date.now()): string {
  if (!(at > 0)) return '';
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간`;
  return `${Math.floor(s / 86400)}일`;
}

/** 한 줄로 자른다 (말줄임표). */
export function clip(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
}

/**
 * 단체방 시스템 줄을 문장으로 (`RoomLine.system`). 문장의 원본은 `shared/social.roomSystemTextKo` 하나다 (net 의 목록 미리보기와
 * 같은 문장) — 여기서는 이름이 비었을 때 아이디를 채워 넘길 뿐이다.
 */
export function roomSystemText(line: RoomLine): string {
  return roomSystemTextKo({
    ...line,
    name: line.name || formatPlayerCode(line.code),
    ...(line.targetName || !line.target ? {} : { targetName: formatPlayerCode(line.target) }),
  });
}

/** 이름의 첫 글자 (초상 대체 글자). */
export function initialOf(name: string): string {
  const t = (name ?? '').trim();
  return t ? Array.from(t)[0] : '?';
}
