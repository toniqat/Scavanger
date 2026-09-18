import type { RoomLine } from '@/shared';
import { formatPlayerCode, roomSystemTextKo } from '@/shared';

/** Messenger text helpers (2026-09-14). No DOM. */

const two = (n: number): string => n.toString().padStart(2, '0');

/** A bubble’s time: `HH:MM` today, `MM-DD HH:MM` otherwise. 0 or less gives ''. */
export function clockText(at: number, now = Date.now()): string {
  if (!(at > 0)) return '';
  const d = new Date(at);
  const n = new Date(now);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
}

/* 2026-09-14 3rd pass: the list row's `방금 · n분` (`agoText`) is gone — a conversation row is the name + the last line only (user's decision). */

/** Clips to one line (with an ellipsis). */
export function clip(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
}

/**
 * A group room's system line as a sentence (`RoomLine.system`). The sentence has one source, `shared/social.roomSystemTextKo`
 * (the same sentence as net's list preview) — this only fills the 아이디 in when a name is empty before handing it over.
 */
export function roomSystemText(line: RoomLine): string {
  return roomSystemTextKo({
    ...line,
    name: line.name || formatPlayerCode(line.code),
    ...(line.targetName || !line.target ? {} : { targetName: formatPlayerCode(line.target) }),
  });
}

/** The name’s first character (the avatar’s stand-in glyph). */
export function initialOf(name: string): string {
  const t = (name ?? '').trim();
  return t ? Array.from(t)[0] : '?';
}
