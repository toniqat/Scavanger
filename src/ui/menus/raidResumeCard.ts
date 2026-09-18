import type { GameContext, RaidResumeMember, RaidResumeOffer } from '@/shared';
import { NET_MAX_PLAYERS, NET_SLOT_COLORS_CSS, planetLabel } from '@/shared';
import { el, fmtTime } from '../dom';

/* ────────────────────────────────────────────────────────────────────────────
 * The body of the title's abandon-raid popup (2026-09-15, user's decision — docs/DECISIONS.md 「2026-09-15 — 타이틀 이어하기 · 레이드 포기」).
 *
 * 「매칭 시 화면 구조」 as it is: a one-line summary → **four square portrait tiles** (me → squadmates by slot → empty
 * tiles; the same order · the same face source `PlayerRef.snapshotFace` as the terminal match tab `hub/ui/MatchTab`) →
 * what is lost. The confirm row (`닫기` · the 1 s hold `레이드 포기`) belongs to `menus/askPopup`, which takes this node
 * as `content`. It is a static card, built once when the popup opens.
 *
 * CSS prefix `.trs-` (`ui/styles/title.css`). The match tab's `.hmt-` belongs to the hub folder, so only the look was
 * copied over.
 * ──────────────────────────────────────────────────────────────────────────── */

const KIND_LABEL: Record<RaidResumeOffer['kind'], string> = { solo: '솔로 레이드', squad: '분대 레이드', tutorial: '튜토리얼' };

export function buildRaidResumeCard(ctx: GameContext, offer: RaidResumeOffer): HTMLElement {
  const root = el('div', { cls: 'trs-body' });
  const parts = [KIND_LABEL[offer.kind]];
  if (offer.kind !== 'tutorial') parts.push(planetLabel(offer.planet));
  parts.push(`경과 ${fmtTime(offer.missionTime)}`);
  el('div', { cls: 'trs-sub', text: parts.join(' · '), parent: root });
  const row = el('div', { cls: 'trs-row', parent: root });
  for (let i = 0; i < NET_MAX_PLAYERS; i++) tile(ctx, row, offer.members[i] ?? null);
  el('div', { cls: 'trs-warn', text: warning(offer), parent: root });
  return root;
}

function warning(offer: RaidResumeOffer): string {
  switch (offer.kind) {
    case 'tutorial':
      return '튜토리얼을 포기하면 지금까지의 진행이 사라지고, 다음에 시작할 때 처음부터 다시 진행합니다.\n캐릭터는 그대로 남습니다.';
    case 'squad':
      return '레이드를 포기하면 캐릭터가 그 자리에서 사망하고 표류 처리됩니다.\n'
        + '장비 · 가방 · 장착 임플란트는 시체에 남고, 분대원의 구조선으로도 되살릴 수 없으며 이 임무에 다시 들어갈 수 없습니다.';
    default:
      return '레이드를 포기하면 캐릭터가 그 자리에서 사망합니다.\n장비 · 가방 · 장착 임플란트를 모두 잃으며, 되돌릴 수 없습니다.';
  }
}

function tile(ctx: GameContext, parent: HTMLElement, m: RaidResumeMember | null): void {
  const root = el('div', { cls: 'trs-tile', parent });
  if (!m) { root.classList.add('is-empty'); return; }
  const accent = m.accent ?? NET_SLOT_COLORS_CSS[m.slot] ?? NET_SLOT_COLORS_CSS[0];
  root.style.setProperty('--sc', accent);
  if (m.me) root.classList.add('is-me');
  if (m.bot) root.classList.add('is-bot');
  if (!m.connected || m.drifted) root.classList.add('is-off');
  const face = el('div', { cls: 'trs-face', parent: root });
  let url: string | null = null;
  const p = ctx.player;
  // An android gets the android face — with no GL context the snapshot is null and only the name's first character
  // is left (the same as the match tab)
  try { url = (m.bot ? p?.snapshotAndroidFace?.({ accent }) : p?.snapshotFace?.({ accent })) ?? null; } catch { url = null; }
  if (url) {
    const img = el('img', { parent: face });
    img.alt = '';
    img.draggable = false;
    img.src = url;
  } else {
    root.classList.add('no-face');
    el('div', { cls: 'trs-initial', text: m.name.slice(0, 1), parent: face });
  }
  if (m.isHost) el('div', { cls: 'trs-badge', text: '분대장', parent: root });
  const tag = m.drifted ? '표류' : m.bot ? '안드로이드' : !m.connected ? '연결 끊김' : '';
  if (tag) el('div', { cls: 'trs-state', text: tag, parent: root });
  const info = el('div', { cls: 'trs-info', parent: root });
  el('div', { cls: 'trs-name', text: m.name, parent: info });
  if (m.level !== null) el('div', { cls: 'trs-lv', text: `Lv.${m.level}`, parent: info });
}
