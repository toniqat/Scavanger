/**
 * src/hub/parts/SquadDock.ts — **the squad docking flow** (2026-09-15).
 *
 * A squad (a lobby) is not the same thing as the shared ship. An invite creates an undocked squad and everyone stays in
 * their own personal ship. When the leader docks from the terminal's `매칭` tab (`lobby:dock`, `LobbyState.docked`):
 *   - **a dock I pressed myself** (`NetRef.dockPending` true inside the event that brought that lobby — the old
 *     entrances create · join · quickmatch alike) goes straight → cancel everything → fade out `HUB_DOCK_FADE_S` →
 *     docking cutscene + fade in.
 *   - anyone else (a squadmate, someone who accepted an invite into a docked lobby) takes the same road after the
 *     right-side countdown `HUB_SQUAD_DOCK_COUNTDOWN_S`.
 *   - being moved into an undocked squad while standing in a shared ship returns to the personal ship by undock cutscene.
 *
 * **It is judged from state, not from events** (`reconcile`, every frame + `net:lobbyUpdated`). 「a dock arriving while
 * not in the ship counts down once back」 · 「a lobby that disappears mid-countdown cancels it」 · 「a dock right after an
 * undock cutscene」 all fall out of the one line 「is where we stand where the squad should be」. An event is used only to
 * catch 「is this dock mine」 (`dockMine`) — `dockPending` goes out the moment that `net:lobbyUpdated` ends.
 *
 * The single source of 「where we stand」 is `HubSystem.shipLobbyCode`: the shared ship writes its lobby's code as it is
 * built (`parts/Interior.build`), a personal ship entered from the hangar inherits it, a plain personal ship is null.
 */
import type { LobbyState } from '@/shared';
import { HUB_DOCK_FADE_S, HUB_SQUAD_DOCK_COUNTDOWN_S, MENU_BLOCKER, isDockedLobby } from '@/shared';
import type { HubSystem } from '../HubSystem';

/** Launch-slot prompt · refusal toast — an undocked squad locks the personal launch (the server says `not_docked` too). */
export const SQUAD_UNDOCKED_LAUNCH_KO = '분대 대기 중 — 분대장이 매칭해야 출격할 수 있습니다';
/** Training refusal toast — an undocked squad locks the training arena as well. */
export const SQUAD_UNDOCKED_TRAINING_KO = '분대 대기 중 — 분대장이 매칭해야 훈련장에 들어갈 수 있습니다';
/** The squad has docked but we are still in the personal ship (mid countdown · fade). */
export const SQUAD_DOCKING_KO = '공용 함선으로 이동 중';

/** Stop after this many `closeTop()` calls in a row that made no progress — the infinite-loop guard. */
const ESCAPE_STALL_LIMIT = 3;
/** The most `closeTop()` calls one cancellation makes (the guard for a screen that opens another as it closes). */
const ESCAPE_GUARD = 32;

/**
 * The lobby whose shared ship we stand in (deck · hangar · a bay's personal ship), or null — personal ship, an undocked
 * squad, or a docked squad we have not arrived in yet (countdown / fade / cutscene). Everything that used to read
 * "has a lobby" as "in the shared ship" (pods, crew cards, ship visits, planet, leader handoff) reads this instead.
 */
export function squadLobby(sys: HubSystem): LobbyState | null {
  /* 2026-09-15 (smoke · debug): the way to stand in a shared ship with no relay — `HubSystem.debugLobby` (smoke only;
     it is never installed while a real `ctx.net.lobby` exists). Every other rule matches the real lobby below. */
  const fake = sys.debugLobby;
  if (fake) return sys.shipLobbyCode === fake.code ? fake : null;
  const lobby = sys.ctx?.net?.lobby ?? null;
  return lobby && isDockedLobby(lobby) && sys.shipLobbyCode === lobby.code ? lobby : null;
}

/**
 * Why the squad locks the **personal** launch pod / the training range right now, or null. Undocked squad → the
 * `분대 대기 중` line; a docked squad we have not reached yet → `SQUAD_DOCKING_KO`. Ship management, inventory and
 * crafting are never locked here (user's decision).
 */
export function squadLockReason(sys: HubSystem, what: 'launch' | 'training'): string | null {
  const lobby = sys.ctx?.net?.lobby ?? null;
  if (!lobby || squadLobby(sys)) return null;
  if (!isDockedLobby(lobby)) return what === 'launch' ? SQUAD_UNDOCKED_LAUNCH_KO : SQUAD_UNDOCKED_TRAINING_KO;
  return SQUAD_DOCKING_KO;
}

/**
 * The state rule, run every hub frame and on `net:lobbyUpdated`:
 *   - a docked lobby whose shared ship we are not in (`shipLobbyCode !== lobby.code`) → my own dock fades at once,
 *     anyone else counts down; a **started** one (resume into a running mission) swaps straight in.
 *   - an undocked lobby while we stand in a shared ship (or a bay's ship behind it) → undock cutscene.
 *   - anything else → no countdown, no fade.
 * Waits (keeps a countdown, starts nothing) while a `moved` waits for its lobby, a cutscene runs, or we are not in `hub`.
 */
export function reconcile(sys: HubSystem): void {
  const ctx = sys.ctx;
  if (!sys.active) return;
  const lobby = ctx.net?.lobby ?? null;
  const docked = isDockedLobby(lobby);
  const needDock = !!lobby && docked && sys.shipLobbyCode !== lobby.code;
  if (sys.dockMine !== null && (!lobby || lobby.code !== sys.dockMine || !docked)) sys.dockMine = null;
  if (!needDock || sys.pendingMove) clearDockState(sys);
  if (sys.pendingMove || sys.cutscene || ctx.phase !== 'hub' || !sys.interior || !lobby) return;
  if (!docked) {
    if (sys.ship === 'shared' || sys.visit !== null) sys.startTransition('undock');
    return;
  }
  if (!needDock) return;
  if (lobby.started) { sys.dockMine = null; sys.swapDirect('shared'); return; }   // resumed into a running mission: no cutscene
  if (sys.dockFade) return;
  if (sys.dockMine === lobby.code) { beginFade(sys, lobby.code); return; }
  if (!sys.squadDock || sys.squadDock.code !== lobby.code) startCountdown(sys, lobby.code);
}

/** One hub frame (`HubSystem.update`, phases `hub` / `docking`): the rule, then the countdown and the fade clocks. */
export function tick(sys: HubSystem, dt: number): void {
  reconcile(sys);
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
  const cd = sys.squadDock;
  if (cd) {
    // counts only while we walk the ship — a member who is not in `hub` starts counting once back (the rule above keeps it)
    const live = sys.ctx.phase === 'hub' && !sys.cutscene;
    if (live) cd.left -= step;
    if (live) sys.dockCountdown.show(Math.max(0, Math.ceil(cd.left)));
    else sys.dockCountdown.hide();
    if (live && cd.left <= 0) beginFade(sys, cd.code);
  }
  const fade = sys.dockFade;
  if (fade) {
    fade.left -= step;
    if (fade.left <= 0) finishFade(sys);
  }
}

function startCountdown(sys: HubSystem, code: string): void {
  if (HUB_SQUAD_DOCK_COUNTDOWN_S <= 0) { beginFade(sys, code); return; }
  sys.squadDock = { code, left: HUB_SQUAD_DOCK_COUNTDOWN_S };
  sys.dockCountdown.show(Math.ceil(HUB_SQUAD_DOCK_COUNTDOWN_S));
  sys.ctx.bus.emit('audio:play', { id: 'ui_open' });
}

/** Everything the player was doing ends, the screen goes black (`hold`: no phase guard lifts it), controls off. */
function beginFade(sys: HubSystem, code: string): void {
  const ctx = sys.ctx;
  if (sys.squadDock) { sys.squadDock = null; sys.dockCountdown.hide(); }
  sys.dockMine = null;
  cancelEverything(sys);
  sys.dockFade = { code, left: HUB_DOCK_FADE_S };
  ctx.player?.setControlsEnabled(false);
  ctx.bus.emit('ui:screenFade', { opacity: 1, durationS: HUB_DOCK_FADE_S, hold: true });
  if (HUB_DOCK_FADE_S <= 0) finishFade(sys);
}

/** Black: the docking cutscene starts (`startTransition` cancels everything once more) and the screen fades back in. */
function finishFade(sys: HubSystem): void {
  const ctx = sys.ctx;
  const fade = sys.dockFade;
  sys.dockFade = null;
  const lobby = ctx.net?.lobby ?? null;
  const still = !!fade && !!lobby && isDockedLobby(lobby) && lobby.code === fade.code && ctx.phase === 'hub' && !sys.cutscene;
  if (still) {
    if (lobby.started) sys.swapDirect('shared');
    else sys.startTransition('dock');
  } else if (ctx.phase === 'hub' && sys.boardedSlot < 0 && !sys.housingMode.active) {
    ctx.player?.setControlsEnabled(true);
  }
  // fade in "as the cutscene starts" — its shader hold pauses the fade clock too, so the first frame shown is compiled
  ctx.bus.emit('ui:screenFade', { opacity: 0, durationS: HUB_DOCK_FADE_S });
}

/**
 * Drop a pending countdown / fade (lobby left or changed, a transition took over, re-entry, teardown). A fade in progress
 * fades back in and hands the controls back when the ship is still up.
 */
export function clearDockState(sys: HubSystem): void {
  const ctx = sys.ctx;
  if (sys.squadDock) { sys.squadDock = null; sys.dockCountdown.hide(); }
  if (sys.dockFade) {
    sys.dockFade = null;
    ctx.bus.emit('ui:screenFade', { opacity: 0, durationS: HUB_DOCK_FADE_S });
    if (ctx.phase === 'hub' && sys.interior && sys.boardedSlot < 0 && !sys.housingMode.active) ctx.player?.setControlsEnabled(true);
  }
}

/**
 * "Cancel everything": whatever the player was doing right before a ship transition ends and every screen closes — the pod,
 * the window warp, ship management / housing mode, a furniture pose, every screen on `ctx.escape` (LIFO, `closeTop` until
 * empty with a guard), the inventory (drag / held item included — `closeAll`), the hub's own panels and the pause menu.
 * Chat input, the community panel and the rest close on the phase change to `docking` right after (their own
 * `game:phaseChanged` rules). Idempotent — `beginFade` and `startTransition` both call it.
 */
export function cancelEverything(sys: HubSystem): void {
  const ctx = sys.ctx;
  if (sys.boardedSlot >= 0) sys.leavePod(false, false);
  sys.cancelTravel();
  if (sys.housingMode.active) { try { sys.housingMode.exit(); } catch (e) { console.warn('[hub] housing mode exit failed', e); } }
  try { if (ctx.player?.furniturePose) ctx.player.setFurniturePose?.(null); } catch (e) { console.warn('[hub] furniture pose release failed', e); }
  if (sys.launchWarn.isOpen) sys.launchWarn.close();
  sys.ready.closePopup();
  sys.menu.close(false);
  let stalled = 0;
  for (let guard = 0; guard < ESCAPE_GUARD && ctx.escape.size > 0 && stalled < ESCAPE_STALL_LIMIT; guard++) {
    const before = ctx.escape.size;
    try { ctx.escape.closeTop(); } catch (e) { console.warn('[hub] escape close failed', e); ctx.escape.remove(ctx.escape.topKey ?? ''); }
    stalled = ctx.escape.size < before ? 0 : stalled + 1;
  }
  try { ctx.inventory?.closeAll(); } catch (e) { console.warn('[hub] inventory closeAll failed', e); }
  // the pause menu is not on the escape stack (it owns its own Escape) — the same event GameFlow reacts to; its `설정` sub-screen
  // closes on that event too (`ui/menus/SettingsMenu`)
  if (ctx.uiBlockers.has(MENU_BLOCKER)) ctx.bus.emit('game:paused', { paused: false, freeze: false });
  // the dev console owns its own Escape as well (dev hosts only; `enabled` false elsewhere)
  try { if (ctx.console?.isOpen) ctx.console.close(); } catch (e) { console.warn('[hub] console close failed', e); }
}
