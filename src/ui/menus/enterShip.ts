import type { GameContext } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * The one path into the ship (2026-09-09).
 *
 * The title's `함선 탑승` button (`TitleMenu.board()`) used to do this job itself. With the character select screen
 * there are now **two** doors in:
 *
 *   1. pressing the card of the current slot on the character select screen (straight to the ship, no reload),
 *   2. **right after** picking another slot and reloading (`markAutoStart` → `takeAutoStart`, the title is skipped).
 *
 * If the invite-link flow (`?lobby=CODE` → `ctx.net.inviteCode`) hung off only one of the two, an invited player who
 * switched slot on the way in would land in the personal ship instead of the shared one. So it is the **path**, not
 * the door, that is kept single.
 *
 * The behaviour is the old `TitleMenu.board()` as it was: with an invite code, `ensureConnected()` first, and on
 * success the personal ship is entered and then `joinLobby(code)` (the hub docks into the shared ship). On failure it
 * leaves a notice and goes to the offline personal ship **from the next attempt on**.
 * ──────────────────────────────────────────────────────────────────────────── */

/* ── appended (2026-09-14, the tutorial rework) ────────────────────────
 *
 * **A new character does not go through the ship.** While tutorial track ① (`raid`) is not done, this path goes to
 * the **tutorial raid** instead of `hub:enter` — waking on the hand-built tutorial planet, learning the controls and
 * extracting on an abandoned ship **is** acquiring the ship. The `hub:enter {ship:'personal'}` after the extraction
 * settlement is the usual route of the result screen · `game/`, so there is no new code for it here (track ② is
 * started by `tutorial/` on that first entry).
 *
 * The fork is here for the reason this file's head comment gives — there are two **doors** in (a card click · the auto
 * start after a slot switch) but only one **path**. Putting the judgement in `TitleMenu` would drop only a new
 * character that came in by auto start into the ship.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** An invite that failed once is not tried again (the old `TitleMenu.inviteFailed`; the title flow is single, so it is module state). */
let inviteFailed = false;

/** Does this screen hold an invite code — decides whether the button label becomes `초대 수락 · 함선 탑승`. */
export function hasPendingInvite(ctx: GameContext): boolean {
  return !!ctx.net?.inviteCode && !inviteFailed;
}

export interface EnterShipHooks {
  /** True while connecting to the server (the label is `서버 연결 중…`), false once it ends. */
  setBusy?(busy: boolean): void;
  /** The notice for a failed invite accept. */
  showMessage?(text: string, kind: 'info' | 'warning' | 'danger'): void;
  /** 2026-09-15: waiting turned up a raid to resume — back to the title instead of the ship (the calling screen closes itself). */
  onResumeOffer?(): void;
}

/**
 * Enters the ship. With no invite code it is one frame of `hub:enter {ship:'personal'}` straight away.
 * If the phase changes while waiting (another route already went in), it steps back silently.
 */
export async function enterShip(ctx: GameContext, hooks: EnterShipHooks = {}): Promise<void> {
  /*
   * 2026-09-15 (타이틀 이어하기 · 레이드 포기): **with a raid remaining it is the title, not the ship.** A squad raid
   * has to be asked of the server, so it waits until that question (`ctx.raidResume.checking` — only when the boot
   * marker exists) is done. This file is the path, not a door (head comment), so the character card · the auto start
   * after a slot switch both pass through here.
   */
  const rr = ctx.raidResume;
  if (rr?.checking) {
    hooks.setBusy?.(true);
    try { await rr.settled(); } catch { /* not knowing, go in as before */ }
    hooks.setBusy?.(false);
    if (ctx.phase !== 'menu') return;
  }
  if (rr?.offer) { hooks.onResumeOffer?.(); return; }

  const net = ctx.net;
  const code = net?.inviteCode ?? null;

  if (net && code && !inviteFailed) {
    hooks.setBusy?.(true);
    let ok = false;
    try { ok = await net.ensureConnected(); } catch { ok = false; }
    hooks.setBusy?.(false);
    if (ctx.phase !== 'menu') return;
    if (!ok) {
      inviteFailed = true;
      hooks.showMessage?.('서버에 연결할 수 없습니다 — 초대를 수락하지 못했습니다. 다시 누르면 개인 함선(오프라인)으로 탑승합니다.', 'danger');
      return;
    }
    ctx.bus.emit('hub:enter', { ship: 'personal' });
    net.joinLobby(code);
    ctx.bus.emit('ui:notify', { text: `초대 코드 ${code} — 공유 함선에 합류 중`, kind: 'info' });
    return;
  }

  // 2026-09-14: with no invite and a new character whose track ① is not done, go to the tutorial raid, not the ship.
  if (startTutorialRaid(ctx)) return;

  ctx.bus.emit('hub:enter', { ship: 'personal' });
}

/**
 * Is it the tutorial raid's turn — true when it went.
 *
 * **The invite comes before the tutorial** (the order at the call site above). The less surprising of the two was
 * chosen: an invite is **a promise somebody is waiting on right now**, while the tutorial waits just the same for a
 * later solo entry (the track does not count as skipped — `skipTrack` is not called, so the next solo entry stands at
 * this fork again). The other way round, 「the tutorial first, the invite after」, the first ship entry after the
 * extraction settlement is `game/`'s route, so this file would have no place left to carry the invite on, and the friend would
 * be looking at an empty ship all the while.
 *
 * **Forced solo**: the tutorial raid has no matchmaking · lobby. If a lobby has already been joined (an invite · a
 * reconnect) it does nothing and hands over to the usual route — emitting `game:newMission` alone here would go out
 * of step with the squad.
 */
function startTutorialRaid(ctx: GameContext): boolean {
  const tut = ctx.tutorial;
  if (!tut || typeof tut.isTrackDone !== 'function' || tut.isTrackDone('raid')) return false;
  if (ctx.net?.lobby) return false;

  /*
   * **Exactly the contract** of `missionPlanet` · `missionIntel`: whoever emits `game:newMission` sets them **before**
   * the emit (`hub/parts/Pods.launch` · `hub/parts/Crew.startTraining` are the examples). The tutorial planet is a
   * hand-built world, so it has no target planet and no intel gimmick — handled like the training range.
   */
  ctx.missionMode = 'tutorial';
  ctx.missionPlanet = null;
  ctx.missionIntel = null;
  // The world uses no seed (a fixed layout), but the contract wants a number, so one is rolled and handed over.
  ctx.bus.emit('game:newMission', { seed: (Math.random() * 0xffffffff) >>> 0, mode: 'tutorial' });
  return true;
}
