/**
 * src/hub/parts/Pods.ts — **launch pod · ready · countdown · launch**.
 *
 * **2026-09-14 (the launch-slot UI rework): boarding and readiness are split.** Boarding a pod (E) enters at
 * `setReady(false)`; readiness needs **Space held for `UI_HOLD_CONFIRM_S`** while seated (`toggleReady` — holding
 * again un-readies). So the launch warning popup appears at **the end of that hold**, not on boarding. Once every
 * connected member is ready the host calls `startGame` after `HUB_LAUNCH_COUNTDOWN`.
 *
 * The single source of the local ready flag is `HubSystem.readyLocal` — the server's `LobbyPlayer.ready` is its echo,
 * and with no echo within `READY_ECHO_GRACE` `syncPods` only clears readiness, it does not un-board the player.
 *
 * While a mission runs the pod becomes a rejoin entrance. The reason boarding is refused (`podBlockReason`) is shown
 * as the prompt — refusing with `canInteract:false` would take the prompt away, and with it the reason.
 */
import type { PlanetId } from '@/shared';
/* 2026-09-14: the intel broker — the bought region · bought gimmicks ride along on launch (docs/DECISIONS.md 「2026-09-14 — 정보상」) */
import type { IntelPick } from '@/shared';
import { resolveIntelEffects } from '@/shared';
import type { HubLaunchSlot, LaunchWarning, PeerId } from '@/shared';
import { HUB_LAUNCH_COUNTDOWN, HUB_READY_CELLS } from '@/shared';
/* 2026-09-15: android bot members (launch slots) · the raid-entry loading fade to black */
import { RAID_LOAD_FADE_OUT_S, RAID_LOAD_START_GRACE_S, androidNameOf, isBotPlayer } from '@/shared';
import type {  } from '../interiors/stations';
import type {  } from '../interiors/types';
import { LaunchWarnPanel } from '../ui/LaunchWarnPanel';
import { type ReadyCellInfo } from '../ui/ReadyPanel';
import { randomSeed } from '../ui/dom';
import { READY_ECHO_GRACE, REBOARD_GRACE, _camLook, _camPos, _front } from '../model';
/* Hangar (2026-09-08): the visit status line lives with the rest of the hangar logic. */
import * as Hangar from './Hangar';
/* 2026-09-15: squads · dock matchmaking — the personal launch slot is locked in an undocked squad */
import { squadLockReason } from './SquadDock';
import type { HubSystem } from '../HubSystem';

export function getLaunchSlots(sys: HubSystem): readonly HubLaunchSlot[] { return sys.slots; }

/* ── pods ──────────────────────────────────────────────────────────────── */
/* 2026-09-15 (squads · dock matchmaking): "in a lobby" is not "in the shared ship" any more — pods read `sys.squadLobby()`, the
   lobby whose shared ship we actually stand in. A member of an undocked squad sees the personal ship's slot 0, locked. */
export function localSlot(sys: HubSystem): number { return sys.squadLobby() && sys.ctx.net ? sys.ctx.net.localSlot : 0; }

export function podPrompt(sys: HubSystem, slot: number): string | null {
  if (!sys.podCanInteract(slot)) return null;
  return sys.podBlockReason(slot) ?? (sys.squadLobby() && sys.ctx.net?.missionInProgress ? '임무 진행 중 — 재투입' : '발사 슬롯 탑승');
  }

/**
 * Basic pod availability: the pod is reachable and free. The **reasons boarding is refused anyway** live in
 * `podBlockReason` — they keep `canInteract` true on purpose, because `ctx.interactables.findBest` skips an
 * interactable that answers false and the player would then see no prompt at all (and no reason).
 */
export function podCanInteract(sys: HubSystem, slot: number): boolean {
  const ctx = sys.ctx;
  if (ctx.phase !== 'hub' || sys.cutscene || sys.travelling || sys.boardedSlot >= 0 || sys.menu.isOpen
    || sys.launchWarn.isOpen || sys.housingMode.active || sys.corpMenuOpen()) return false;
  // 2026-09-09: the E that just un-boarded is still held — see `REBOARD_GRACE`. Without this the player steps out
  // and the very same press walks them back in 0.4 s later, which reads as "the pod ignores me".
  if (ctx.time - sys.leftPodAt < REBOARD_GRACE) return false;
  if (slot !== sys.localSlot()) return false;
  const pod = sys.pods[slot];
  return !!pod && pod.occupant === null;
  }

/**
 * Why boarding is refused right now (also the pod's prompt text), or null when the slot takes us:
 * a training runs in the lobby (join from the terminal instead), or the ship has no target planet (Phase 11).
 */
export function podBlockReason(sys: HubSystem, slot: number): string | null {
  void slot;
  // 2026-09-08: while the tutorial has not reached its launch step, the prompt shows what it wants done instead
  const tut = sys.ctx.tutorial?.blockReason('board') ?? null;
  if (tut) return tut;
  // 2026-09-15 (squads · dock matchmaking): an undocked squad launches nobody from a personal ship — the leader docks first
  const squad = squadLockReason(sys, 'launch');
  if (squad) return squad;
  if (sys.trainingRunning()) return '훈련 진행 중 — 터미널에서 합류';
  // 2026-09-15 (abandoning a raid from the title): an abandoned raid has no rejoin (the relay refuses it as `drifted` too)
  if (driftedFromRaid(sys)) return '표류 — 포기한 임무에는 다시 들어갈 수 없습니다';
  if (sys.planet === null) return '목표 행성 미지정 — 터미널에서 지정';
  return null;
  }

/** 2026-09-15: did I abandon the squad raid that runs now, from the title (`LobbyPlayer.drifted`)? */
export function driftedFromRaid(sys: HubSystem): boolean {
  const net = sys.ctx.net;
  const lobby = net?.lobby;
  const id = net?.localId;
  if (!net?.missionInProgress || !lobby || !id || (lobby.mode ?? 'raid') !== 'raid') return false;
  return lobby.players.some((p) => p.id === id && p.drifted === true);
  }

export function boardPod(sys: HubSystem, slot: number): void {
  const ctx = sys.ctx;
  /*
   * 2026-09-09: **never fail silently.** A player standing in front of an open pod, with `발사 슬롯 탑승` on the
   * screen, pressing E and getting *nothing* — no toast, no sound, no reason — is unreportable and undebuggable
   * (a user hit exactly that). `podCanInteract` is normally true here (the prompt would be gone otherwise), so
   * reaching this branch means the state moved under us; say so instead of returning into the void.
   */
  if (!sys.podCanInteract(slot)) {
    if (ctx.time - sys.leftPodAt < REBOARD_GRACE) return;   // the un-boarding press, still held — silence is correct
    ctx.bus.emit('ui:notify', { text: '지금은 발사 슬롯에 탈 수 없습니다', kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
    return;
  }
  const net = ctx.net;
  const squadLock = squadLockReason(sys, 'launch');
  if (squadLock) {
    // 2026-09-15 (squads · dock matchmaking): the prompt already says it — the press says it once more instead of doing nothing
    ctx.bus.emit('ui:notify', { text: squadLock, kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
    return;
  }
  if (sys.trainingRunning()) {
    // pods stay closed while a training runs: the terminal's 시뮬레이션 훈련장 entry joins it
    ctx.bus.emit('ui:notify', { text: '훈련 진행 중 — 터미널에서 합류할 수 있습니다', kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
    return;
  }
  if (sys.planet === null) {
    // No target planet: nothing to launch at (the server refuses a raid start with `no_planet` as well)
    ctx.bus.emit('ui:notify', { text: '목표 행성이 없습니다 — 터미널에서 행성을 지정하세요', kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
    return;
  }
  const squad = sys.squadLobby();
  if (net && squad && net.missionInProgress) {
    if (driftedFromRaid(sys)) {
      ctx.bus.emit('ui:notify', { text: '포기한 임무에는 다시 들어갈 수 없습니다', kind: 'warning' });
      ctx.bus.emit('audio:play', { id: 'ui_deny' });
      return;
    }
    ctx.bus.emit('ui:notify', { text: '임무에 재투입합니다', kind: 'warning' });
    net.rejoinMission();          // → net:gameStarting + game:newMission → teardown('mission')
    return;
  }
  /*
   * 2026-09-14: the launch warning **left this place** — it now stands at the end of the ready hold (`toggleReady`).
   * Sitting down in a pod commits nothing by itself, so nothing is asked here.
   */
  const pod = sys.pods[slot];
  sys.boardedSlot = slot;
  sys.boardedAt = ctx.time;
  sys.readyLocal = false;          // boarding ≠ ready (the one-second Space hold is what readies)
  const p = ctx.player;
  if (p) {
    p.spawnStanding(pod.def.position, pod.def.yaw);
    p.setInPod(true);
    p.setControlsEnabled(false);
    pod.getCameraShot(_camPos, _camLook);
    p.setCameraOverride(_camPos, _camLook);
  }
  // merely sitting down is not readiness, and the server is told as much (any earlier ready flag is cleared)
  if (net && squad) { net.setReady(false); sys.readySentAt = ctx.time; }
  ctx.bus.emit('audio:play', { id: 'ui_equip' });
  sys.syncPods();
  }

/**
 * Ready / un-ready (Space held for `UI_HOLD_CONFIRM_S`, the key measured by `ui/ReadyPanel`).
 *
 * Only the way **into** readiness raises the **launch warnings** (`ctx.inventory.getLaunchWarnings()`): something
 * flagged whose signature differs from the one acknowledged last time opens the popup first, and `그래도 준비` is what
 * sends `setReady(true)`. Nothing flagged, or an acknowledged combination, readies at once. Un-readying asks nothing.
 */
export function toggleReady(sys: HubSystem): void {
  const ctx = sys.ctx;
  if (sys.boardedSlot < 0 || ctx.phase !== 'hub' || sys.cutscene) return;
  if (sys.launchWarn.isOpen) return;
  if (sys.raidLaunch) return;   // 2026-09-15: readiness cannot change once the fade began (the launch is committed)
  if (sys.readyLocal) {
    sys.readyLocal = false;
    if (ctx.net && sys.squadLobby()) { ctx.net.setReady(false); sys.readySentAt = ctx.time; }
    ctx.bus.emit('ui:notify', { text: '준비를 해제했습니다', kind: 'info' });
    ctx.bus.emit('audio:play', { id: 'ui_click' });
    sys.syncPods();
    return;
  }
  // 2026-09-09: a throw in the check must not eat the ready. `player/perform` swallows an `interact()` exception
  // into a console line, so an inventory hiccup here would look exactly like "스페이스를 눌러도 아무 일도 없다".
  let warnings: readonly LaunchWarning[] = [];
  try { warnings = ctx.inventory?.getLaunchWarnings?.() ?? []; } catch (e) { console.error('[hub] getLaunchWarnings threw', e); warnings = []; }
  // 2026-09-17 (user's decision): the tutorial `증축 안내` track raises no launch warning (contract · armor …) — it readies at once
  if (ctx.tutorial?.hides('launchWarn')) warnings = [];
  const sig = LaunchWarnPanel.signatureOf(warnings);
  if (warnings.length === 0) sys.launchWarnAck = '';   // fully kitted out again → the next lapse asks afresh
  else if (sig !== sys.launchWarnAck) {
    sys.launchWarn.open(warnings, () => { sys.launchWarnAck = sig; sys.setReadyLocal(true); });
    return;
  }
  sys.setReadyLocal(true);
  }

/** Commit the local ready flag (after the launch check, or straight away when it had nothing to say). */
export function setReadyLocal(sys: HubSystem, ready: boolean): void {
  const ctx = sys.ctx;
  if (sys.boardedSlot < 0 && ready) return;
  sys.readyLocal = ready;
  const net = ctx.net;
  if (net && sys.squadLobby()) {
    net.setReady(ready); sys.readySentAt = ctx.time;
    /*
     * 2026-09-09: `NetClient.send` **drops** a message while the socket is not OPEN and nobody looks at the return
     * value, so a reconnect swallows the ready flag: the squad would wait for a member the server never marked ready.
     * The flag is re-sent from `HubSystem`'s `net:statusChanged` when the socket comes back; until then, say so.
     */
    if (ready && !net.connected) ctx.bus.emit('ui:notify', { text: '연결이 끊겨 있습니다 — 복구되면 준비 상태를 다시 보냅니다', kind: 'warning' });
  }
  if (ready) ctx.bus.emit('audio:play', { id: 'ui_equip' });
  sys.syncPods();
  }

/** Un-board. `sendReady` false when the lobby state already changed (reset / mission start / leaving the ship). */
export function leavePod(sys: HubSystem, sendReady: boolean, placeOutside = true): void {
  if (sys.boardedSlot < 0) return;
  const ctx = sys.ctx;
  const pod = sys.pods[sys.boardedSlot];
  sys.boardedSlot = -1;
  sys.readyLocal = false;        // 2026-09-14: leaving the pod clears readiness too
  sys.leftPodAt = ctx.time;      // REBOARD_GRACE: the un-boarding press must not walk straight back in
  const p = ctx.player;
  if (p) {
    p.setInPod(false);
    p.setCameraOverride(null);
    p.setControlsEnabled(true);
    if (placeOutside && pod) {
      _front.copy(pod.def.position).addScaledVector(pod.def.door, 1.3);
      p.spawnStanding(_front, pod.def.yaw);
    }
  }
  if (sendReady && ctx.net && sys.squadLobby()) ctx.net.setReady(false);
  if (sys.countdown >= 0) { sys.countdown = -1; ctx.bus.emit('ui:notify', { text: '발사 취소', kind: 'warning' }); }
  sys.syncPods();
  }

/** Mirror lobby ready flags into pod occupancy / tags; emits `hub:slotChanged` on changes. */
export function syncPods(sys: HubSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const lobby = sys.squadLobby();   // 2026-09-15: the squad whose shared ship we stand in (null = the personal ship's own pod)
  const localId: PeerId = net?.localId ?? 'local';
  const localSlot = sys.localSlot();
  const me = lobby ? lobby.players.find((q) => q.id === localId) : undefined;
  const training = sys.trainingRunning();

  /*
   * Server dropped our ready flag (lobby reset / kick-back) while we sit in the pod.
   * 2026-09-09: only while the socket is actually up. `lobby` is the **last snapshot**, so a dropped connection
   * freezes it at `ready:false` (our `setReady(true)` was never sent) and this used to eject the player from the
   * pod every 1.5 s with no way to stay in it — the reconnect re-sends the flag instead.
   * 2026-09-14: boarding and readiness are separate now, so it **does not un-board** — readiness is cleared, the seat kept.
   */
  if (sys.boardedSlot >= 0 && sys.readyLocal && lobby && me && !me.ready && !lobby.started && (net?.connected ?? true)
    && ctx.time - sys.readySentAt > READY_ECHO_GRACE) {
    sys.readyLocal = false;
    ctx.bus.emit('ui:notify', { text: '준비 상태가 초기화되었습니다', kind: 'warning' });
  }

  // Ready-panel cells, filled while the pods below are walked (`null` = no member in that slot at all)
  const cells: (ReadyCellInfo | null)[] = new Array(HUB_READY_CELLS).fill(null);

  for (let i = 0; i < sys.pods.length; i++) {
    const pod = sys.pods[i];
    const slot = pod.slot;
    let occupant: PeerId | null = null;
    let name = '빈 슬롯', state = '—', local = false;
    let present = false, connected = true, peerId: PeerId | null = null;
    /*
     * 2026-09-14: `inSlot` = sits in the launch slot (the cell draws a body), `confirmed` = has finished readying.
     * Locally the two split (board → hold); remotely the wire carries no boarding, so `LobbyPlayer.ready` is both.
     */
    let inSlot = false, confirmed = false;
    /* 2026-09-15: is this cell an android bot member · its cockpit bay index (the ready panel draws portrait · gear differently) */
    let bot = false, bay = 0;
    if (slot === localSlot && (!lobby || me)) {
      local = true; present = true; peerId = localId;
      name = net?.playerName ?? '스캐빈저';
      if (sys.boardedSlot === slot) {
        inSlot = true; occupant = localId;
        confirmed = sys.readyLocal;
        state = confirmed ? '준비 완료' : '탑승 · 준비 대기';
      } else state = training ? '훈련 진행 중' : net?.missionInProgress ? '임무 진행 중 — 재투입' : '대기 중';
    } else if (lobby) {
      const q = lobby.players.find((pl) => pl.slot === slot);
      if (q) {
        name = q.name; present = true; peerId = q.id; connected = q.connected;
        /*
         * 2026-09-15 (android squadmates): a bot member has no socket and the relay holds it at `ready: true` — it is
         * drawn as **seated and ready** without waiting for a remote avatar (allies/ stands the body **in front of** the
         * pod). They do not follow into the training arena, so during one they read `대기 중` with an open door, as people do.
         */
        if (isBotPlayer(q)) {
          bot = true; bay = q.bay ?? slot; connected = true;
          name = androidNameOf(bay);
          if (training) state = '대기 중';
          else { inSlot = true; confirmed = true; occupant = q.id; state = lobby.started ? '임무 중' : '준비 완료'; }
        } else if (!q.connected) state = '연결 끊김';
        else if (training) state = q.inMission ? '훈련 중' : '대기 중';      // a training never closes a pod door
        else if (q.ready) { inSlot = true; confirmed = true; occupant = q.id; state = lobby.started ? '임무 중' : '준비 완료'; }
        else state = '대기 중';
      }
    }
    if (present && slot < HUB_READY_CELLS) {
      cells[slot] = {
        slot, peerId, name, ready: inSlot, confirmed, local, connected, state, bot, bay,
        ...(bot ? { level: null, implant: null, armorId: null } : sys.crewLook(local, peerId)),
      };
    }
    const changed = pod.setDisplay({ occupant, name, state, local, closed: occupant !== null });
    if (sys.slots[i]) sys.slots[i].occupant = occupant;
    if (changed) ctx.bus.emit('hub:slotChanged', { slot, peerId: occupant, local });
  }
  /*
   * 2026-09-16 (user's decision): this one value is the ready panel's **visibility and its interactivity at once** —
   * only while I actually sit in a launch slot. It used to be 「any cell is `ready`」, and then recruiting an android made
   * a bot cell `ready` at once (`inSlot = true` above), so the panel covered mid-screen for the whole walk of the shared ship.
   */
  sys.ready.sync(cells, sys.boardedSlot >= 0 && ctx.phase === 'hub' && !sys.cutscene);
  }

/* ── launch countdown ──────────────────────────────────────────────────── */

/**
 * 2026-09-14 (the intel broker) — the held intel that is **usable** on the current target planet. A different planet
 * gives null: the intel is not discarded, it stays (`IntelRef.get()` still returns it — the screen writes
 * 「다른 행성의 정보」) and is valid again on returning to that planet. A squadmate has none of their own and uses the
 * `lobby.intel` the leader put up (only the host launches, so the leader's is the only one that ever rides along).
 */
function usableIntel(sys: HubSystem, planet: PlanetId): { seed: number; picks: IntelPick[] } | null {
  const spec = sys.ctx.meta?.intel?.get?.() ?? null;
  if (!spec || spec.planet !== planet || spec.picks.length === 0) return null;
  return { seed: spec.seed >>> 0, picks: spec.picks };
}

export function resolveSeed(sys: HubSystem): number {
  /* 2026-09-14: bought intel **decides the region** — its seed comes before the lobby seed (otherwise the gimmicks
   * that were paid for land on a different map). A different planet does not use it. */
  const planet = sys.planet;
  if (planet !== null) {
    const intel = usableIntel(sys, planet);
    if (intel) return intel.seed;
  }
  const lobby = sys.squadLobby();
  if (lobby && lobby.seed !== null) return lobby.seed >>> 0;
  return (sys.missionSeed ?? randomSeed()) >>> 0;
  }

export function launch(sys: HubSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const seed = sys.resolveSeed();
  const planet = sys.planet;
  if (planet === null) return;         // the pod gate should have caught this (server: `no_planet`)
  const intel = usableIntel(sys, planet);
  // 2026-09-15: a lobby we are not standing in the shared ship of (undocked squad · dock countdown) launches nothing
  if (net?.lobby && !sys.squadLobby()) return;
  if (net && sys.squadLobby() && net.isHost) {
    sys.launched = true;
    // server → game:start {planet, intel} → net emits game:newMission → teardown('mission')
    net.startGame(seed, 'raid', planet, intel);
  } else if (!net?.lobby) {
    // the emitter sets the mode AND the planet **and the intel** before `game:newMission` (Phase 7 / 11 / 2026-09-14 contract)
    ctx.missionMode = 'raid';
    ctx.missionPlanet = planet;
    ctx.missionIntel = intel ? resolveIntelEffects(intel.picks) : null;
    ctx.bus.emit('game:newMission', { seed, mode: 'raid', planet });
  }
  }

/* ── raid-entry loading (2026-09-15) ──────────────────────────────────────
 * User's decision: 「발사 슬롯에 준비를 완료하여 3초 카운트 이후, 화면 암전(페이드아웃), 이후 암전된 상태에서 …
 * 모든 플레이어가 로딩 완료되면 이후 암전 풀리면서(페이드인) 강하 시퀀스 재생.」
 *
 * The hub's share is **the start only**: at countdown 0 everyone (host · squadmate · solo) begins the fade on the same
 * frame and emits `raid:loadBegin`. The authority launches **after** `RAID_LOAD_FADE_OUT_S` — otherwise the first frame
 * of the drop scene lands over a ship that is still lit. The ring gauge · the wait · the fade in after it belong to
 * game/`parts/LoadGate` and ui/. Once the fade started the launch is **committed** (un-readying and E do not cancel it
 * — `HubSystem.raidLaunch`).
 */
export function beginRaidLoad(sys: HubSystem): void {
  const ctx = sys.ctx;
  if (sys.raidLaunch) return;
  const lobby = sys.squadLobby();
  const authority = !lobby || (ctx.net?.isHost ?? false);
  sys.raidLaunch = { dueMs: performance.now() + RAID_LOAD_FADE_OUT_S * 1000, authority, launched: false, timer: null };
  arm(sys, RAID_LOAD_FADE_OUT_S);
  sys.ready.setLaunching(true);
  ctx.bus.emit('ui:screenFade', { opacity: 1, durationS: RAID_LOAD_FADE_OUT_S, hold: true });
  ctx.bus.emit('raid:loadBegin', {});
  if (RAID_LOAD_FADE_OUT_S <= 0) tickRaidLaunch(sys);
}

/** Re-arm the wall-clock backup timer of the committed launch. */
function arm(sys: HubSystem, seconds: number): void {
  const st = sys.raidLaunch;
  if (!st) return;
  if (st.timer !== null) clearTimeout(st.timer);
  st.timer = setTimeout(() => { if (sys.raidLaunch) tickRaidLaunch(sys); }, Math.max(0, seconds) * 1000);
}

/** Drop a committed launch (ship teardown / rebuild) — the timer never outlives the interior. */
export function clearRaidLaunch(sys: HubSystem): void {
  const st = sys.raidLaunch;
  if (!st) return;
  if (st.timer !== null) clearTimeout(st.timer);
  sys.raidLaunch = null;
}

/**
 * One frame of the committed launch. At the end of the fade the authority launches; after that everyone waits for
 * `game:newMission` (which tears the hub down). If nothing happened by `RAID_LOAD_START_GRACE_S` past the fade — the
 * host left, the server refused — the screen fades back in and the pod returns to its normal state.
 */
export function tickRaidLaunch(sys: HubSystem): void {
  const st = sys.raidLaunch;
  if (!st) return;
  const ctx = sys.ctx;
  const now = performance.now();
  if (now < st.dueMs) return;
  if (!st.launched) {
    st.launched = true;
    st.dueMs = now + RAID_LOAD_START_GRACE_S * 1000;
    arm(sys, RAID_LOAD_START_GRACE_S);
    if (st.authority) sys.launch();
    return;
  }
  // Nobody launched (the host left · the server refused) — lift the fade and come back to the ship
  clearRaidLaunch(sys);
  ctx.bus.emit('ui:screenFade', { opacity: 0, durationS: RAID_LOAD_FADE_OUT_S });
  ctx.bus.emit('ui:notify', { text: '발사하지 못했습니다 — 함선으로 돌아갑니다', kind: 'warning' });
  sys.launched = false;
  sys.syncPods();
}

export function tickCountdown(sys: HubSystem, dt: number): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const lobby = sys.squadLobby();   // 2026-09-15: only the squad whose shared ship we stand in counts down together
  // 2026-09-15: once the fade began the ready flags are not read again — the launch is committed
  if (sys.raidLaunch) { tickRaidLaunch(sys); return; }
  const boarded = sys.boardedSlot >= 0;
  // 2026-09-14: what opens the countdown is **readiness**, not boarding (solo needs the Space hold too).
  const meReady = boarded && sys.readyLocal;
  let ready = meReady ? 1 : 0, total = 1, allReady = meReady;
  if (lobby) {
    const connected = lobby.players.filter((p) => p.connected);
    total = Math.max(1, connected.length);
    ready = connected.filter((p) => p.ready).length;
    allReady = meReady && !lobby.started && connected.length > 0 && ready === connected.length;
  }
  /* 2026-09-15: 「who launches」 is looked at again by `beginRaidLoad` once the fade ended, never settled ahead here. */

  if (allReady && sys.countdown < 0 && !sys.launched) {
    sys.countdown = HUB_LAUNCH_COUNTDOWN;
    sys.lastCountdownSecond = -1;
    ctx.bus.emit('audio:play', { id: 'ui_equip' });
  } else if (!allReady) {
    sys.launched = false;
    if (sys.countdown >= 0) { sys.countdown = -1; if (lobby) ctx.bus.emit('ui:notify', { text: '발사 취소 — 승무원 대기', kind: 'warning' }); }
  }

  /*
   * 2026-09-14 2nd pass: the bottom-right key guide (`'pod'`) goes down while the countdown runs — nothing can be
   * un-boarded and readiness cannot change then. The rule for raising and dropping it lives only in `ui/ReadyPanel.syncGuide`.
   */
  sys.ready.setLaunching(sys.countdown >= 0);

  if (sys.countdown >= 0) {
    sys.countdown -= dt;
    const sec = Math.max(0, Math.ceil(sys.countdown));
    if (sec !== sys.lastCountdownSecond) {
      sys.lastCountdownSecond = sec;
      // Clients mirror the host's countdown locally (same ready state, same length) so HUD/audio/chat react everywhere.
      ctx.bus.emit('hub:launchCountdown', { seconds: sec, ready, total });
      if (sec > 0) ctx.bus.emit('audio:play', { id: 'ui_click' });
    }
    if (sys.countdown <= 0) {
      sys.countdown = -1;
      // 2026-09-15 (raid-entry loading): the **fade** comes before the launch — the authority launches `RAID_LOAD_FADE_OUT_S` later
      beginRaidLoad(sys);
      return;
    }
  }

  // status line
  const visit = Hangar.visitStatus(sys);
  if (boarded) {
    if (sys.countdown >= 0) sys.status.set(String(Math.max(0, Math.ceil(sys.countdown))), '발사 준비 완료', { count: true, progress: 1 - sys.countdown / HUB_LAUNCH_COUNTDOWN });
    /*
     * 2026-09-14 2nd pass (user's decision): the hold gauge sits at the bottom of my own cell, **the keys sit in the
     * bottom-right key guide** (owner `'pod'`, `ui/ReadyPanel.syncGuide`). Only the status text and the countdown are
     * left on this bottom-centre line — the old `E 슬롯에서 내리기` sub-line moved where every other screen has it.
     */
    else if (sys.readyLocal) sys.status.set(lobby ? `준비 완료 (${ready}/${total})` : '준비 완료');
    else if (lobby) sys.status.set(`준비 대기 (${ready}/${total})`);
    else sys.status.set('준비 대기');
  } else if (lobby && net?.missionInProgress) {
    if (sys.trainingRunning()) sys.status.set(`훈련 진행 중 (${sys.trainingCount()}명)`, '터미널에서 합류할 수 있습니다');
    else if (driftedFromRaid(sys)) sys.status.set('임무 진행 중 — 표류', '포기한 임무에는 다시 들어갈 수 없습니다');
    else sys.status.set('임무 진행 중', '발사 슬롯에 탑승하면 재투입됩니다');
  } else if (visit) {
    // Hangar (2026-09-08): inside a bay's ship — the only reminder of how to get back out (and that it is read-only)
    sys.status.set(visit.main, visit.sub);
  } else {
    sys.status.hide();
  }
  }
