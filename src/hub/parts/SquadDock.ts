/**
 * src/hub/parts/SquadDock.ts — **분대 도킹 흐름** (2026-09-15, docs/DECISIONS.md 「2026-09-15 — 분대 · 도킹 매칭」).
 *
 * 분대(로비)가 곧 공용 함선이 아니다. 초대를 보내면 미도킹 분대가 생기고 모두 제 개인 함선에 남는다. 분대장이 터미널 >
 * 매칭에서 도킹하면(`lobby:dock`, `LobbyState.docked`):
 *   - **내가 누른 도킹**(`NetRef.dockPending` 이 그 로비를 가져온 이벤트 안에서 true — 옛 입구 create · join · quickmatch 도
 *     같다)은 곧장 → 모든 것 취소 → 페이드 아웃 `HUB_DOCK_FADE_S` → 도킹 컷씬 + 페이드 인.
 *   - 그 밖(분대원, 도킹된 로비로 초대를 수락한 사람)은 우측 카운트다운 `HUB_SQUAD_DOCK_COUNTDOWN_S` 뒤 같은 길.
 *   - 미도킹 분대로 옮겨졌는데 공용 함선에 서 있으면 도킹 해제 컷씬으로 개인 함선에 돌아간다.
 *
 * **이벤트가 아니라 상태로 판정한다** (`reconcile`, 매 프레임 + `net:lobbyUpdated`). 「함선이 아닐 때 도킹이 오면 함선에
 * 돌아온 뒤 카운트다운」 · 「카운트다운 중 로비가 사라지면 취소」 · 「도킹 해제 컷씬이 끝난 뒤의 도킹」이 전부 같은 한 줄
 * 「지금 서 있는 곳이 분대가 있어야 할 곳인가」 에서 나온다. 이벤트는 「내 도킹인가」(`dockMine`)를 붙잡는 데만 쓴다 —
 * `dockPending` 은 그 `net:lobbyUpdated` 가 끝나는 순간 꺼진다.
 *
 * 「지금 서 있는 곳」의 원본은 `HubSystem.shipLobbyCode` 하나다: 공용 함선을 지을 때(`parts/Interior.build`) 그 로비의
 * 코드를 적고, 격납고에서 들어간 개인 함선은 물려받고, 그냥 개인 함선이면 null 이다.
 */
import type { LobbyState } from '@/shared';
import { HUB_DOCK_FADE_S, HUB_SQUAD_DOCK_COUNTDOWN_S, MENU_BLOCKER, isDockedLobby } from '@/shared';
import type { HubSystem } from '../HubSystem';

/** 발사 슬롯 프롬프트 · 거절 토스트 — 미도킹 분대에서는 개인 발사가 잠긴다 (서버도 `not_docked`). */
export const SQUAD_UNDOCKED_LAUNCH_KO = '분대 대기 중 — 분대장이 매칭해야 출격할 수 있습니다';
/** 훈련장 거절 토스트 — 미도킹 분대에서는 훈련장도 잠긴다. */
export const SQUAD_UNDOCKED_TRAINING_KO = '분대 대기 중 — 분대장이 매칭해야 훈련장에 들어갈 수 있습니다';
/** 분대는 도킹했는데 나는 아직 개인 함선이다 (카운트다운 · 페이드 중). */
export const SQUAD_DOCKING_KO = '공용 함선으로 이동 중';

/** `closeTop()` 이 제자리걸음(`false` = 한 걸음만 되돌림)을 이만큼 연달아 하면 멈춘다 — 무한 루프 방지. */
const ESCAPE_STALL_LIMIT = 3;
/** 한 번의 취소에서 `closeTop()` 을 부르는 최대 횟수 (화면이 닫히며 다른 화면을 여는 경우의 방어). */
const ESCAPE_GUARD = 32;

/**
 * The lobby whose shared ship we stand in (deck · hangar · a bay's personal ship), or null — personal ship, an undocked
 * squad, or a docked squad we have not arrived in yet (countdown / fade / cutscene). Everything that used to read
 * "has a lobby" as "in the shared ship" (pods, crew cards, ship visits, planet, leader handoff) reads this instead.
 */
export function squadLobby(sys: HubSystem): LobbyState | null {
  /* 2026-09-15 (스모크 · 디버그): 릴레이 없이 공용 함선에 서 보는 길 — `HubSystem.debugLobby` (스모크 전용, 실제
     `ctx.net.lobby` 가 있으면 설치되지 않는다). 나머지 규칙은 아래 진짜 로비와 똑같다. */
  const fake = sys.debugLobby;
  if (fake) return sys.shipLobbyCode === fake.code ? fake : null;
  const lobby = sys.ctx?.net?.lobby ?? null;
  return lobby && isDockedLobby(lobby) && sys.shipLobbyCode === lobby.code ? lobby : null;
}

/**
 * Why the squad locks the **personal** launch pod / the training range right now, or null. Undocked squad → the
 * "분대 대기 중" line; a docked squad we have not reached yet → `SQUAD_DOCKING_KO`. Ship management, inventory and
 * crafting are never locked here (user decision).
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
 * 「모든 것 취소」: whatever the player was doing right before a ship transition ends and every screen closes — the pod,
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
  // the pause menu is not on the escape stack (it owns its own Escape) — the same event GameFlow reacts to; its 설정 sub-screen
  // closes on that event too (`ui/menus/SettingsMenu`)
  if (ctx.uiBlockers.has(MENU_BLOCKER)) ctx.bus.emit('game:paused', { paused: false, freeze: false });
  // the dev console owns its own Escape as well (dev hosts only; `enabled` false elsewhere)
  try { if (ctx.console?.isOpen) ctx.console.close(); } catch (e) { console.warn('[hub] console close failed', e); }
}
