/**
 * src/hub/parts/Pods.ts — **발사 포드 · 준비 · 카운트다운 · 출격**.
 *
 * **2026-09-14 (발사 슬롯 UI 대개편): 탑승과 준비를 가른다.** 포드에 타는 것(E)은 `setReady(false)` 로 들어가는
 * 것이고, 앉은 채 **스페이스를 `UI_HOLD_CONFIRM_S` 동안 꾹** 눌러야 준비가 된다 (`toggleReady` — 다시 꾹 누르면
 * 해제). 출격 준비 경고 팝업도 탑승 시점이 아니라 **그 홀드가 끝난 순간**에 뜬다. 접속한 전원이 준비되면
 * `HUB_LAUNCH_COUNTDOWN` 뒤 호스트가 `startGame` 한다.
 *
 * 로컬 준비 상태의 원본은 `HubSystem.readyLocal` 하나다 — 서버의 `LobbyPlayer.ready` 는 그것의 메아리이고,
 * 메아리가 `READY_ECHO_GRACE` 안에 안 오면 `syncPods` 가 준비만 풀고 포드에서 내리지는 않는다.
 *
 * 임무가 진행 중이면 포드는 재합류 입구가 된다. 탑승을 막는 이유(`podBlockReason`)는 프롬프트로
 * 보여 준다 — `canInteract:false` 로 막으면 프롬프트 자체가 사라져 이유를 알 수 없다.
 */
import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import { getPlanet, isPlanetId, planetLabel, HUB_TRAVEL_DURATION, PLANET_NONE_LABEL, PLANET_STORAGE_KEY } from '@/shared';
/* 2026-09-14: 정보상 — 산 지역 · 산 기믹을 출격에 싣는다 (docs/plans/intel-broker.md) */
import type { IntelPick } from '@/shared';
import { resolveIntelEffects } from '@/shared';
import type { CrewCardWire, GameContext, GameSystem, HubLaunchSlot, HubRef, HubShipKind, Interactable, InteriorCollider, LaunchWarning, LoadoutSlot, LobbyState, PeerId, RoomPurpose } from '@/shared';
import { CREW_CARD_MIN_INTERVAL_S, CREW_LOADOUT_COOLDOWN_S, HUB_DOCKING_DURATION, HUB_LAUNCH_COUNTDOWN, HUB_READY_BLOCKER, HUB_READY_CELLS, Keys, NET_SLOT_COLORS, ROOM_PURPOSE_LABEL_KO } from '@/shared';
import { PersonalShip } from '../interiors/PersonalShip';
import { SharedShip } from '../interiors/SharedShip';
import type { StationDef } from '../interiors/stations';
import type { ShipInterior } from '../interiors/types';
import { FurnitureLayer } from '../interiors/Furniture';
import { roomAtWorld } from '../interiors/RoomLayout';
import { HousingMode } from '../HousingMode';
import { LaunchPod } from '../LaunchPod';
import { LaunchWarnPanel } from '../ui/LaunchWarnPanel';
import { Terminal } from '../Terminal';
import { Computer } from '../Computer';
import { DockingCutscene, type DockDirection } from '../DockingCutscene';
import { HubMenu } from '../ui/HubMenu';
import { HubStatus } from '../ui/HubStatus';
import { ReadyPanel, type ReadyCellInfo } from '../ui/ReadyPanel';
import { randomSeed } from '../ui/dom';
import { type DockTransition, LOCK_REQUEST_GRACE_MS, READY_ECHO_GRACE, REBOARD_GRACE, UNBOARD_GRACE, _camLook, _camPos, _front } from '../model';
/* 격납고 (2026-09-08): the visit status line lives with the rest of the hangar logic. */
import * as Hangar from './Hangar';
import type { HubSystem } from '../HubSystem';

export function getLaunchSlots(sys: HubSystem): readonly HubLaunchSlot[] { return sys.slots; }

/* ── pods ──────────────────────────────────────────────────────────────── */
export function localSlot(sys: HubSystem): number { return sys.ctx.net?.lobby ? sys.ctx.net.localSlot : 0; }

export function podPrompt(sys: HubSystem, slot: number): string | null {
  if (!sys.podCanInteract(slot)) return null;
  return sys.podBlockReason(slot) ?? (sys.ctx.net?.lobby && sys.ctx.net.missionInProgress ? '임무 진행 중 — 재투입' : '발사 슬롯 탑승');
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
 * a training runs in the lobby (join from the terminal instead), or the ship has no 목표 행성 (Phase 11).
 */
export function podBlockReason(sys: HubSystem, slot: number): string | null {
  void slot;
  // 2026-09-08: 튜토리얼이 아직 출격 단계에 오지 않았으면 지금 해야 할 일을 프롬프트에 그대로 띄운다
  const tut = sys.ctx.tutorial?.blockReason('board') ?? null;
  if (tut) return tut;
  if (sys.trainingRunning()) return '훈련 진행 중 — 터미널에서 합류';
  if (sys.planet === null) return '목표 행성 미지정 — 터미널에서 지정';
  return null;
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
  if (sys.trainingRunning()) {
    // pods stay closed while a training runs: the terminal's 시뮬레이션 훈련장 entry joins it
    ctx.bus.emit('ui:notify', { text: '훈련 진행 중 — 터미널에서 합류할 수 있습니다', kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
    return;
  }
  if (sys.planet === null) {
    // 목표 행성 미지정: nothing to launch at (the server refuses a raid start with `no_planet` as well)
    ctx.bus.emit('ui:notify', { text: '목표 행성이 없습니다 — 터미널에서 행성을 지정하세요', kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
    return;
  }
  if (net?.lobby && net.missionInProgress) {
    ctx.bus.emit('ui:notify', { text: '임무에 재투입합니다', kind: 'warning' });
    net.rejoinMission();          // → net:gameStarting + game:newMission → teardown('mission')
    return;
  }
  /*
   * 2026-09-14: 출격 준비 경고는 여기서 **사라졌다** — 이제는 준비 홀드가 끝난 순간에 뜬다 (`toggleReady`).
   * 포드에 앉는 것 자체는 아무것도 확정하지 않으므로 묻지 않는다.
   */
  const pod = sys.pods[slot];
  sys.boardedSlot = slot;
  sys.boardedAt = ctx.time;
  sys.readyLocal = false;          // 탑승 ≠ 준비 (스페이스 1초 홀드가 준비다)
  const p = ctx.player;
  if (p) {
    p.spawnStanding(pod.def.position, pod.def.yaw);
    p.setInPod(true);
    p.setControlsEnabled(false);
    pod.getCameraShot(_camPos, _camLook);
    p.setCameraOverride(_camPos, _camLook);
  }
  // 앉기만 한 것은 준비가 아니므로 서버에도 그렇게 말한다 (앞선 준비가 남아 있으면 지운다)
  if (net?.lobby) { net.setReady(false); sys.readySentAt = ctx.time; }
  ctx.bus.emit('audio:play', { id: 'ui_equip' });
  sys.syncPods();
  }

/**
 * 준비 / 준비 해제 (스페이스 `UI_HOLD_CONFIRM_S` 홀드, `ui/ReadyPanel` 이 키를 잰다).
 *
 * 준비로 가는 길에만 **출격 준비 경고**(`ctx.inventory.getLaunchWarnings()`)가 선다: 걸리는 것이 있고 그 서명이
 * 지난번에 승인한 것과 다르면 팝업이 먼저 뜨고, `그래도 준비` 를 눌러야 `setReady(true)` 가 나간다. 경고가 없거나
 * 이미 승인한 조합이면 곧바로 준비된다. 해제에는 아무것도 묻지 않는다.
 */
export function toggleReady(sys: HubSystem): void {
  const ctx = sys.ctx;
  if (sys.boardedSlot < 0 || ctx.phase !== 'hub' || sys.cutscene) return;
  if (sys.launchWarn.isOpen) return;
  if (sys.readyLocal) {
    sys.readyLocal = false;
    if (ctx.net?.lobby) { ctx.net.setReady(false); sys.readySentAt = ctx.time; }
    ctx.bus.emit('ui:notify', { text: '준비를 해제했습니다', kind: 'info' });
    ctx.bus.emit('audio:play', { id: 'ui_click' });
    sys.syncPods();
    return;
  }
  // 2026-09-09: a throw in the check must not eat the ready. `player/perform` swallows an `interact()` exception
  // into a console line, so an inventory hiccup here would look exactly like "스페이스를 눌러도 아무 일도 없다".
  let warnings: readonly LaunchWarning[] = [];
  try { warnings = ctx.inventory?.getLaunchWarnings?.() ?? []; } catch (e) { console.error('[hub] getLaunchWarnings threw', e); warnings = []; }
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
  if (net?.lobby) {
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
  sys.readyLocal = false;        // 2026-09-14: 포드에서 내리면 준비도 풀린다
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
  if (sendReady && ctx.net?.lobby) ctx.net.setReady(false);
  if (sys.countdown >= 0) { sys.countdown = -1; ctx.bus.emit('ui:notify', { text: '발사 취소', kind: 'warning' }); }
  sys.syncPods();
  }

/** Mirror lobby ready flags into pod occupancy / tags; emits `hub:slotChanged` on changes. */
export function syncPods(sys: HubSystem): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const lobby = net?.lobby ?? null;
  const localId: PeerId = net?.localId ?? 'local';
  const localSlot = sys.localSlot();
  const me = lobby ? lobby.players.find((q) => q.id === localId) : undefined;
  const training = sys.trainingRunning();

  /*
   * Server dropped our ready flag (lobby reset / kick-back) while we sit in the pod.
   * 2026-09-09: only while the socket is actually up. `lobby` is the **last snapshot**, so a dropped connection
   * freezes it at `ready:false` (our `setReady(true)` was never sent) and this used to eject the player from the
   * pod every 1.5 s with no way to stay in it — the reconnect re-sends the flag instead.
   * 2026-09-14: 탑승과 준비가 갈라졌으므로 **포드에서 내리지 않는다** — 준비만 풀고 앉아 있게 둔다.
   */
  if (sys.boardedSlot >= 0 && sys.readyLocal && lobby && me && !me.ready && !lobby.started && (net?.connected ?? true)
    && ctx.time - sys.readySentAt > READY_ECHO_GRACE) {
    sys.readyLocal = false;
    ctx.bus.emit('ui:notify', { text: '준비 상태가 초기화되었습니다', kind: 'warning' });
  }

  // 발사 준비 패널 cells, filled while we walk the pods below (`null` = no member in that slot at all)
  const cells: (ReadyCellInfo | null)[] = new Array(HUB_READY_CELLS).fill(null);

  for (let i = 0; i < sys.pods.length; i++) {
    const pod = sys.pods[i];
    const slot = pod.slot;
    let occupant: PeerId | null = null;
    let name = '빈 슬롯', state = '—', local = false;
    let present = false, connected = true, peerId: PeerId | null = null;
    /*
     * 2026-09-14: `inSlot` = 발사 슬롯에 있다(카드가 몸을 그린다), `confirmed` = 준비까지 마쳤다.
     * 로컬은 둘이 갈라지고(탑승 → 홀드), 원격은 와이어에 탑승이 없어 `LobbyPlayer.ready` 하나가 둘을 겸한다.
     */
    let inSlot = false, confirmed = false;
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
        if (!q.connected) state = '연결 끊김';
        else if (training) state = q.inMission ? '훈련 중' : '대기 중';      // a training never closes a pod door
        else if (q.ready) { inSlot = true; confirmed = true; occupant = q.id; state = lobby.started ? '임무 중' : '준비 완료'; }
        else state = '대기 중';
      }
    }
    if (present && slot < HUB_READY_CELLS) {
      cells[slot] = {
        slot, peerId, name, ready: inSlot, confirmed, local, connected, state,
        ...sys.crewLook(local, peerId),
      };
    }
    const changed = pod.setDisplay({ occupant, name, state, local, closed: occupant !== null });
    if (sys.slots[i]) sys.slots[i].occupant = occupant;
    if (changed) ctx.bus.emit('hub:slotChanged', { slot, peerId: occupant, local });
  }
  // interactive (blocker + software cursor) only while WE are boarded — see `ui/ReadyPanel`
  sys.ready.sync(cells, sys.boardedSlot >= 0 && ctx.phase === 'hub' && !sys.cutscene);
  }

/* ── launch countdown ──────────────────────────────────────────────────── */

/**
 * 2026-09-14 (정보상) — 지금 목표 행성에 **쓸 수 있는** 보유 정보. 행성이 다르면 null 이다: 정보는 버려지지 않고
 * 그대로 남아 (`IntelRef.get()` 은 여전히 그것을 돌려준다 — 화면이 「다른 행성의 정보」라고 적는다) 그 행성으로
 * 다시 가면 유효하다. 분대원은 자기 것이 없으므로 분대장이 올려 둔 `lobby.intel` 을 쓴다 (호스트만 출격시키므로
 * 실제로 실어 보내는 것은 분대장의 것뿐이다).
 */
function usableIntel(sys: HubSystem, planet: PlanetId): { seed: number; picks: IntelPick[] } | null {
  const spec = sys.ctx.meta?.intel?.get?.() ?? null;
  if (!spec || spec.planet !== planet || spec.picks.length === 0) return null;
  return { seed: spec.seed >>> 0, picks: spec.picks };
}

export function resolveSeed(sys: HubSystem): number {
  /* 2026-09-14: 산 정보가 있으면 **그 지역으로 간다** — 정보의 시드가 로비 시드보다 먼저다 (그러지 않으면
   * 돈을 내고 고정한 기믹이 다른 맵에 얹힌다). 행성이 다르면 쓰지 않는다. */
  const planet = sys.planet;
  if (planet !== null) {
    const intel = usableIntel(sys, planet);
    if (intel) return intel.seed;
  }
  const lobby = sys.ctx.net?.lobby;
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
  if (net?.lobby && net.isHost) {
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

export function tickCountdown(sys: HubSystem, dt: number): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const lobby = net?.lobby ?? null;
  const boarded = sys.boardedSlot >= 0;
  // 2026-09-14: 카운트다운을 여는 것은 탑승이 아니라 **준비**다 (솔로도 스페이스 홀드를 해야 뜬다).
  const meReady = boarded && sys.readyLocal;
  let ready = meReady ? 1 : 0, total = 1, allReady = meReady;
  if (lobby) {
    const connected = lobby.players.filter((p) => p.connected);
    total = Math.max(1, connected.length);
    ready = connected.filter((p) => p.ready).length;
    allReady = meReady && !lobby.started && connected.length > 0 && ready === connected.length;
  }
  const authority = !lobby || (net?.isHost ?? false);

  if (allReady && sys.countdown < 0 && !sys.launched) {
    sys.countdown = HUB_LAUNCH_COUNTDOWN;
    sys.lastCountdownSecond = -1;
    ctx.bus.emit('audio:play', { id: 'ui_equip' });
  } else if (!allReady) {
    sys.launched = false;
    if (sys.countdown >= 0) { sys.countdown = -1; if (lobby) ctx.bus.emit('ui:notify', { text: '발사 취소 — 승무원 대기', kind: 'warning' }); }
  }

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
      if (authority) sys.launch();
      return;
    }
  }

  // status line
  const visit = Hangar.visitStatus(sys);
  if (boarded) {
    if (sys.countdown >= 0) sys.status.set(String(Math.max(0, Math.ceil(sys.countdown))), '발사 준비 완료', { count: true, progress: 1 - sys.countdown / HUB_LAUNCH_COUNTDOWN });
    // 2026-09-14: 홀드 게이지는 내 카드 하단에 있고, 여기서는 남은 인원과 내리는 키만 말한다
    else if (sys.readyLocal) sys.status.set(lobby ? `준비 완료 (${ready}/${total})` : '준비 완료', '슬롯에서 내리기', { keycap: 'E' });
    else if (lobby) sys.status.set(`준비 대기 (${ready}/${total})`, '슬롯에서 내리기', { keycap: 'E' });
    else sys.status.set('준비 대기', '슬롯에서 내리기', { keycap: 'E' });
  } else if (lobby && net?.missionInProgress) {
    if (sys.trainingRunning()) sys.status.set(`훈련 진행 중 (${sys.trainingCount()}명)`, '터미널에서 합류할 수 있습니다');
    else sys.status.set('임무 진행 중', '발사 슬롯에 탑승하면 재투입됩니다');
  } else if (visit) {
    // 격납고 (2026-09-08): inside a bay's ship — the only reminder of how to get back out (and that it is read-only)
    sys.status.set(visit.main, visit.sub);
  } else {
    sys.status.hide();
  }
  }
