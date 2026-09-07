import type { GameContext, PlayBlock, PlayerCode, SocialPlayer, SocialRef, SocialSnapshot, SquadInvite } from '@/shared';
import { NET_MAX_PLAYERS, playBlockReason } from '@/shared';

/**
 * The one place the ui folder reads the social mirror from (Phase 11).
 *
 * Everything social is owned by `net/SocialSync` and published as `ctx.net.social`; the ESC column, the community
 * panel and the invite stack only ever read it. This module exists so a headless smoke can feed a **synthetic**
 * snapshot without a relay (`HudSystem.debugSocial`), exactly the way `debugRemotes` fakes remote players: while a
 * debug ref is installed every ui component sees it instead of `ctx.net.social`, and every mutation it receives is
 * recorded in `debugSocialCalls` so the test can assert that 같이 하기 / 친구 삭제 / 초대 수락 actually fired.
 *
 * With no relay (offline / solo) the real ref reports `available === false` — the callers then draw the single
 * `소셜 기능을 사용할 수 없습니다` line and nothing else.
 */

let debugRef: SocialRef | null = null;

/** Mutations the synthetic ref received, newest last (debug only; always empty in a real session). */
export const debugSocialCalls: { m: string; args: unknown[] }[] = [];

/** The social mirror to draw, or null when there is none at all (no net system). */
export function socialOf(ctx: GameContext): SocialRef | null {
  return debugRef ?? ctx.net?.social ?? null;
}

/** Whether a usable social mirror exists (a ref with `available === false` counts as "no"). */
export function socialReady(ctx: GameContext): boolean {
  const s = socialOf(ctx);
  return !!s && s.available;
}

export const SOCIAL_UNAVAILABLE_KO = '소셜 기능을 사용할 수 없습니다';

/**
 * Smoke hook: install a synthetic `SocialRef` built from `snapshot` (null clears it and hands the ui back to
 * `ctx.net.social`). The mutators are real enough for a UI test — `acceptInvite` / `dismissInvite` drop the invite,
 * `respondFriend(code, true)` moves the row into `friends` — and every call is appended to `debugSocialCalls`.
 */
export function setDebugSocial(
  snapshot: SocialSnapshot | null, invites: readonly SquadInvite[] = [], mySquad = 1,
): void {
  debugSocialCalls.length = 0;
  if (!snapshot) { debugRef = null; return; }
  const snap: SocialSnapshot = {
    me: snapshot.me,
    friends: [...(snapshot.friends ?? [])],
    incoming: [...(snapshot.incoming ?? [])],
    outgoing: [...(snapshot.outgoing ?? [])],
    recent: [...(snapshot.recent ?? [])],
  };
  const live: SquadInvite[] = [...invites];
  const log = (m: string, ...args: unknown[]): void => { debugSocialCalls.push({ m, args }); };
  const all = (): SocialPlayer[] => [...snap.friends, ...snap.incoming, ...snap.outgoing, ...snap.recent];
  const drop = (from: PlayerCode): void => {
    const i = live.findIndex((v) => v.from === from);
    if (i >= 0) live.splice(i, 1);
  };
  debugRef = {
    available: true,
    get me() { return snap.me; },
    get friends() { return snap.friends; },
    get incoming() { return snap.incoming; },
    get outgoing() { return snap.outgoing; },
    get recent() { return snap.recent; },
    get invites() { return live; },
    get onlineFriends() { return snap.friends.filter((f) => f.presence !== 'offline').length; },
    get hasNews() { return snap.incoming.length > 0; },
    refresh() { log('refresh'); },
    requestFriend(code) { log('requestFriend', code); },
    respondFriend(code, accept) {
      log('respondFriend', code, accept);
      const i = snap.incoming.findIndex((v) => v.code === code);
      if (i < 0) return;
      const [row] = snap.incoming.splice(i, 1);
      if (accept) snap.friends.push(row);
    },
    removeFriend(code) {
      log('removeFriend', code);
      const i = snap.friends.findIndex((v) => v.code === code);
      if (i >= 0) snap.friends.splice(i, 1);
    },
    playWith(code) { log('playWith', code); },
    acceptInvite(from) { log('acceptInvite', from); drop(from); },
    dismissInvite(from) { log('dismissInvite', from); drop(from); },
    whisper(code, text) { log('whisper', code, text); return true; },
    setLevel(level) { log('setLevel', level); },
    find(code) { return all().find((v) => v.code === code); },
    playBlock(code) {
      const row = all().find((v) => v.code === code);
      if (!row) return 'offline' as PlayBlock;
      return playBlockReason(row, mySquad, NET_MAX_PLAYERS, code === snap.me.code);
    },
  };
}
