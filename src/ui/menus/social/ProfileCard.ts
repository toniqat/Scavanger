import type { PlayerCode, SocialPlayer } from '@/shared';
import { PRESENCE_LABELS, formatPlayerCode } from '@/shared';
import { el } from '../../dom';

/** What a card reports back to its owning column. */
export interface ProfileCardHandlers {
  /** Right-click (or a left click, which opens the same menu) on the card. */
  onContext(p: SocialPlayer, ev: MouseEvent): void;
  /** Only used by incoming friend requests (수락 / 거절). */
  onRespond?(code: PlayerCode, accept: boolean): void;
}

/**
 * One profile card (`.sc-card`, `SOCIAL_CARDS_PER_ROW` of them per row): the 아이디 (`formatPlayerCode`) and the
 * player's level on top, the name and the presence dot + `PRESENCE_LABELS` underneath. Identity is **always** the
 * `PlayerCode` — a PeerId never reaches the UI (Phase 11 contract).
 *
 * `request: true` renders an incoming friend request: the same card plus a 수락 / 거절 row.
 * Right-clicking (or left-clicking) a card raises the column's context menu; the card itself has no state.
 */
export function buildProfileCard(p: SocialPlayer, h: ProfileCardHandlers, request = false): HTMLElement {
  const card = el('div', { cls: `sc-card is-${p.presence}${request ? ' is-request' : ''}` });
  card.dataset.code = p.code;
  const top = el('div', { cls: 'sc-top', parent: card });
  el('span', { cls: 'sc-id ui-mono', text: formatPlayerCode(p.code), parent: top });
  el('span', { cls: 'sc-lv ui-mono', text: p.level > 0 ? `Lv. ${p.level}` : 'Lv. —', parent: top });
  const bot = el('div', { cls: 'sc-bot', parent: card });
  el('span', { cls: 'sc-name', text: p.name || '이름 없음', parent: bot });
  const pres = el('span', { cls: 'sc-pres', parent: bot });
  el('i', { cls: 'dot', parent: pres });
  el('span', { cls: 't', text: PRESENCE_LABELS[p.presence] ?? '오프라인', parent: pres });

  if (request && h.onRespond) {
    const acts = el('div', { cls: 'sc-acts', parent: card });
    const yes = el('button', { cls: 'sc-act ok', text: '수락', parent: acts });
    const no = el('button', { cls: 'sc-act', text: '거절', parent: acts });
    yes.addEventListener('click', (e) => { e.stopPropagation(); h.onRespond!(p.code, true); });
    no.addEventListener('click', (e) => { e.stopPropagation(); h.onRespond!(p.code, false); });
  }

  const open = (e: MouseEvent): void => { e.preventDefault(); e.stopPropagation(); h.onContext(p, e); };
  card.addEventListener('contextmenu', open);
  card.addEventListener('click', open);
  return card;
}
