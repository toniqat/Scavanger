import * as THREE from 'three';
import type { GameContext, GameSystem, HubLaunchSlot, HubRef, HubShipKind, InteriorCollider, LobbyState, PeerId } from '@/shared';
import { HUB_DOCKING_DURATION, HUB_LAUNCH_COUNTDOWN, Keys, NET_SLOT_COLORS } from '@/shared';
import { PersonalShip } from './interiors/PersonalShip';
import { SharedShip } from './interiors/SharedShip';
import type { ShipInterior } from './interiors/types';
import { LaunchPod } from './LaunchPod';
import { Terminal } from './Terminal';
import { DockingCutscene, type DockDirection } from './DockingCutscene';
import { HubMenu } from './ui/HubMenu';
import { HubStatus } from './ui/HubStatus';
import { randomSeed } from './ui/dom';
import './hub.css';

/** A pointer-lock exit this soon after a lock request is a denied request, not the user pressing Esc. */
const LOCK_REQUEST_GRACE_MS = 300;
/** Seconds after boarding before E can un-board (the boarding hold-release must not immediately leave). */
const UNBOARD_GRACE = 0.6;
/** Seconds after `setReady(true)` before a server-side `ready=false` is treated as a lobby reset. */
const READY_ECHO_GRACE = 1.5;

const _camPos = new THREE.Vector3();
const _camLook = new THREE.Vector3();
const _front = new THREE.Vector3();

/**
 * Ship hub (Helldivers-style ship interior between missions). Publishes `ctx.hub`.
 *
 * Flow: `hub:enter {personal}` → walk the personal ship → terminal (menu: quick match / code / broadcast) →
 * lobby appears → `docking` cutscene → shared ship (up to 4) → each player boards their launch pod (`setReady`) →
 * every connected member ready → host runs `HUB_LAUNCH_COUNTDOWN` → `ctx.net.startGame(seed)` → `game:newMission`
 * tears the hub down (`hub:left`). Solo: the personal pod launches `game:newMission` directly after the countdown.
 * Phases owned here: 'hub' and 'docking'. Not a gameplay phase (no world, no enemies, no weapons).
 */
export class HubSystem implements GameSystem, HubRef {
  readonly name = 'hub';
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];

  /* HubRef */
  ship: HubShipKind | null = null;
  collider: InteriorCollider | null = null;
  missionSeed: number | null = null;
  get active(): boolean { return this.ctx?.phase === 'hub' || this.ctx?.phase === 'docking'; }
  getLaunchSlots(): readonly HubLaunchSlot[] { return this.slots; }

  private interior: ShipInterior | null = null;
  private pods: LaunchPod[] = [];
  private terminal: Terminal | null = null;
  private slots: HubLaunchSlot[] = [];
  private cutscene: DockingCutscene | null = null;
  private menu!: HubMenu;
  private status!: HubStatus;

  private boardedSlot = -1;
  private boardedAt = 0;
  private readySentAt = -Infinity;
  private countdown = -1;
  private lastCountdownSecond = -1;
  private launched = false;

  private onPointerLockChange = (): void => {
    const ctx = this.ctx;
    if (ctx.input.isPointerLocked || ctx.phase !== 'hub' || ctx.uiBlockers.size > 0) return;
    if (performance.now() - ctx.input.lastLockRequest < LOCK_REQUEST_GRACE_MS) return;
    this.menu.open();     // hub has no pause: a lost lock just opens the terminal menu
  };

  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.hub = this;
    this.menu = new HubMenu(ctx, {
      getMissionSeed: () => this.missionSeed,
      setMissionSeed: (s) => { this.missionSeed = s; this.updateTerminalScreen(); },
      toTitle: () => this.toTitle(),
      onClosed: () => this.relock(),
    });
    this.status = new HubStatus(ctx);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('hub:enter', ({ ship }) => this.enter(ship)),
      b.on('game:newMission', () => this.teardown('mission')),
      b.on('game:abort', () => { if (this.interior || this.cutscene) this.teardown('menu'); }),
      b.on('net:lobbyUpdated', ({ lobby }) => this.onLobbyUpdated(lobby)),
      b.on('net:lobbyLeft', () => this.onLobbyLeft()),
      b.on('net:resumed', ({ inProgress }) => this.onResumed(inProgress)),
      b.on('net:peerJoined', ({ name }) => { if (this.active) b.emit('ui:notify', { text: `${name} 함선 합류`, kind: 'info' }); }),
      b.on('net:peerLeft', ({ name }) => { if (this.active) b.emit('ui:notify', { text: `${name} 함선 이탈`, kind: 'warning' }); }),
      b.on('net:statusChanged', () => this.updateTerminalScreen()),
    );
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  dispose(): void {
    this.teardown('menu');
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.menu.dispose();
    this.status.dispose();
    if (this.ctx?.hub === this) this.ctx.hub = null;
  }

  /* ── enter / build / teardown ──────────────────────────────────────────── */
  private enter(requested: HubShipKind): void {
    const ctx = this.ctx;
    // 'shared' needs a lobby; conversely, while a lobby exists the squad lives in the shared ship.
    const ship: HubShipKind = ctx.net?.lobby ? 'shared' : 'personal';
    if (requested !== ship) console.info(`[hub] hub:enter ${requested} → ${ship} (lobby ${ctx.net?.lobby ? 'present' : 'absent'})`);
    const phase = ctx.phase;
    if (phase !== 'menu' && phase !== 'hub' && phase !== 'docking') ctx.bus.emit('game:abort', {});   // abort the mission / result screen first
    if (this.cutscene) { this.cutscene.dispose(); this.cutscene = null; }
    if (this.interior && this.ship === ship && ctx.phase === 'hub') return;      // idempotent
    this.disposeInterior();
    const spawn = this.build(ship, false);
    ctx.setPhase('hub');
    ctx.bus.emit('hub:entered', { ship, spawn: spawn.clone() });
    ctx.input.requestPointerLock();
    if (ship === 'personal') this.tryResume();
  }

  /** Personal ship: connect in the background; a lobby on `welcome` (resume) moves us straight to the shared ship. */
  private tryResume(): void {
    const net = this.ctx.net;
    if (!net || typeof net.ensureConnected !== 'function') return;
    net.ensureConnected().then((ok) => {
      if (!ok || !net.lobby) return;
      if (this.ship === 'personal' && this.ctx.phase === 'hub' && !this.cutscene) this.swapDirect('shared');
    }).catch(() => { /* offline personal ship */ });
  }

  private build(ship: HubShipKind, viaAirlock: boolean): THREE.Vector3 {
    const ctx = this.ctx;
    const interior: ShipInterior = ship === 'personal' ? new PersonalShip() : new SharedShip();
    ctx.scene.add(interior.root);
    this.interior = interior;
    this.ship = ship;
    this.collider = interior.collider;
    this.pods = interior.pods.map((def) => new LaunchPod(ctx, def, NET_SLOT_COLORS[def.slot % NET_SLOT_COLORS.length], interior.collider, {
      getPrompt: () => this.podPrompt(def.slot),
      canInteract: () => this.podCanInteract(def.slot),
      interact: () => this.boardPod(def.slot),
    }));
    this.slots = interior.pods.map((d) => ({ slot: d.slot, position: d.position.clone(), yaw: d.yaw, occupant: null }));
    this.terminal = new Terminal(ctx, interior.terminal, () => this.menu.open(), () => ctx.phase === 'hub' && !this.menu.isOpen && this.boardedSlot < 0);

    const spawn = viaAirlock ? interior.airlock : interior.spawn;
    const yaw = viaAirlock ? interior.airlockYaw : interior.spawnYaw;
    const p = ctx.player;
    if (p) {
      p.setInPod(false);
      p.setCameraOverride(null);
      p.setInterior(interior.collider);
      p.spawnStanding(spawn, yaw);
      p.setControlsEnabled(true);
    }
    this.setSpaceMode(true);
    this.countdown = -1; this.launched = false; this.lastCountdownSecond = -1;
    this.syncPods();
    this.updateTerminalScreen();
    return spawn;
  }

  private disposeInterior(): void {
    for (const pod of this.pods) pod.dispose();
    this.pods = [];
    this.terminal?.dispose(); this.terminal = null;
    this.interior?.dispose(); this.interior = null;
    this.collider = null;
    this.ship = null;
    this.slots = [];
  }

  /**
   * Leave the hub. 'mission': `game:newMission` arrived (World already generated, Player already respawned — only
   * release our hooks). 'menu': back to the title (`game:abort` or 타이틀로) — also restores the planet atmosphere.
   */
  private teardown(reason: 'mission' | 'menu'): void {
    if (!this.interior && !this.cutscene) return;
    const ctx = this.ctx;
    if (this.boardedSlot >= 0) this.leavePod(false, false);
    this.menu.close(false);
    this.status.hide();
    this.cutscene?.dispose(); this.cutscene = null;
    this.disposeInterior();
    this.countdown = -1; this.launched = false;
    const p = ctx.player;
    if (p) {
      p.setInterior(null);
      p.setCameraOverride(null);
      p.setInPod(false);
      if (reason === 'menu') p.setControlsEnabled(true);
    }
    if (reason === 'menu') this.setSpaceMode(false);
    ctx.bus.emit('hub:left', {});
  }

  /** 타이틀로: leave the lobby (if any), tear down, phase 'menu' (the title shows because `ctx.net.lobby` is null). */
  private toTitle(): void {
    const ctx = this.ctx;
    if (ctx.net?.lobby) ctx.net.leaveLobby();
    this.teardown('menu');
    ctx.setPhase('menu');
  }

  private setSpaceMode(on: boolean): void {
    const atmo = this.ctx.scene.userData.atmosphere as { setSpaceMode?: (on: boolean) => void } | undefined;
    atmo?.setSpaceMode?.(on);
  }

  private relock(): void {
    queueMicrotask(() => {
      const ctx = this.ctx;
      if (ctx.phase !== 'hub' || ctx.uiBlockers.size > 0) return;
      ctx.input.requestPointerLock();
    });
  }

  /* ── docking transitions ───────────────────────────────────────────────── */
  private startTransition(direction: DockDirection): void {
    const ctx = this.ctx;
    if (this.cutscene) {
      if (this.cutscene.direction === direction) return;
      this.cutscene.dispose(); this.cutscene = null;
    }
    if (this.boardedSlot >= 0) this.leavePod(false, false);
    this.menu.close(false);
    this.disposeInterior();          // the player keeps the old collider reference until the new ship is built
    ctx.setPhase('docking');
    ctx.bus.emit('hub:docking', { stage: 'start', direction });
    ctx.bus.emit('ui:notify', { text: direction === 'dock' ? '도킹 절차 시작' : '도킹 해제 — 개인 함선으로 복귀', kind: 'info' });
    const duration = direction === 'dock' ? HUB_DOCKING_DURATION : HUB_DOCKING_DURATION * 0.5;
    this.cutscene = new DockingCutscene(ctx, direction, duration, () => this.finishTransition(direction));
  }

  private finishTransition(direction: DockDirection): void {
    const ctx = this.ctx;
    this.cutscene?.dispose(); this.cutscene = null;
    const target: HubShipKind = direction === 'dock' && ctx.net?.lobby ? 'shared' : 'personal';
    const spawn = this.build(target, target === 'shared');
    ctx.setPhase('hub');
    ctx.bus.emit('hub:docking', { stage: 'end', direction });
    ctx.bus.emit('hub:entered', { ship: target, spawn: spawn.clone() });
    this.relock();
  }

  /** Swap interiors without a cutscene (resume after reload / seamless cases). */
  private swapDirect(target: HubShipKind): void {
    const ctx = this.ctx;
    this.cutscene?.dispose(); this.cutscene = null;
    if (this.boardedSlot >= 0) this.leavePod(false, false);
    this.menu.close(false);
    this.disposeInterior();
    const spawn = this.build(target, target === 'shared');
    ctx.setPhase('hub');
    ctx.bus.emit('hub:entered', { ship: target, spawn: spawn.clone() });
  }

  /* ── net events ────────────────────────────────────────────────────────── */
  private onLobbyUpdated(lobby: LobbyState): void {
    if (!this.active) return;
    if (this.ship === 'personal' && this.ctx.phase === 'hub' && !this.cutscene) {
      if (lobby.started) this.swapDirect('shared');     // resumed into a running mission: no cutscene
      else this.startTransition('dock');
      return;
    }
    this.syncPods();
    this.updateTerminalScreen();
  }

  private onLobbyLeft(): void {
    if (!this.active) return;
    if (this.ship === 'shared' || (this.cutscene && this.cutscene.direction === 'dock')) this.startTransition('undock');
    else { this.syncPods(); this.updateTerminalScreen(); }
  }

  private onResumed(inProgress: boolean): void {
    if (!this.active) return;
    if (this.ship !== 'shared') this.swapDirect('shared');
    this.ctx.bus.emit('ui:notify', {
      text: inProgress ? '분대가 임무 중입니다 — 발사 슬롯에 탑승하면 재투입됩니다' : '함선에 재접속했습니다',
      kind: inProgress ? 'warning' : 'success', duration: 5,
    });
  }

  /* ── pods ──────────────────────────────────────────────────────────────── */
  private localSlot(): number { return this.ctx.net?.lobby ? this.ctx.net.localSlot : 0; }

  private podPrompt(slot: number): string | null {
    if (!this.podCanInteract(slot)) return null;
    return this.ctx.net?.lobby && this.ctx.net.missionInProgress ? '임무 진행 중 — 재투입' : '발사 슬롯 탑승';
  }

  private podCanInteract(slot: number): boolean {
    const ctx = this.ctx;
    if (ctx.phase !== 'hub' || this.cutscene || this.boardedSlot >= 0 || this.menu.isOpen) return false;
    if (slot !== this.localSlot()) return false;
    const pod = this.pods[slot];
    return !!pod && pod.occupant === null;
  }

  private boardPod(slot: number): void {
    const ctx = this.ctx;
    if (!this.podCanInteract(slot)) return;
    const net = ctx.net;
    if (net?.lobby && net.missionInProgress) {
      ctx.bus.emit('ui:notify', { text: '임무에 재투입합니다', kind: 'warning' });
      net.rejoinMission();          // → net:gameStarting + game:newMission → teardown('mission')
      return;
    }
    const pod = this.pods[slot];
    this.boardedSlot = slot;
    this.boardedAt = ctx.time;
    const p = ctx.player;
    if (p) {
      p.spawnStanding(pod.def.position, pod.def.yaw);
      p.setInPod(true);
      p.setControlsEnabled(false);
      pod.getCameraShot(_camPos, _camLook);
      p.setCameraOverride(_camPos, _camLook);
    }
    if (net?.lobby) { net.setReady(true); this.readySentAt = ctx.time; }
    ctx.bus.emit('audio:play', { id: 'ui_equip' });
    this.syncPods();
  }

  /** Un-board. `sendReady` false when the lobby state already changed (reset / mission start / leaving the ship). */
  private leavePod(sendReady: boolean, placeOutside = true): void {
    if (this.boardedSlot < 0) return;
    const ctx = this.ctx;
    const pod = this.pods[this.boardedSlot];
    this.boardedSlot = -1;
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
    if (this.countdown >= 0) { this.countdown = -1; ctx.bus.emit('ui:notify', { text: '발사 취소', kind: 'warning' }); }
    this.syncPods();
  }

  /** Mirror lobby ready flags into pod occupancy / tags; emits `hub:slotChanged` on changes. */
  private syncPods(): void {
    const ctx = this.ctx;
    const net = ctx.net;
    const lobby = net?.lobby ?? null;
    const localId: PeerId = net?.localId ?? 'local';
    const localSlot = this.localSlot();
    const me = lobby ? lobby.players.find((q) => q.id === localId) : undefined;

    // server dropped our ready flag (lobby reset / kick-back) while we sit in the pod → step out
    if (this.boardedSlot >= 0 && lobby && me && !me.ready && !lobby.started && ctx.time - this.readySentAt > READY_ECHO_GRACE) {
      this.leavePod(false, true);
      ctx.bus.emit('ui:notify', { text: '발사 슬롯이 초기화되었습니다', kind: 'warning' });
      return;   // leavePod re-runs syncPods
    }

    for (let i = 0; i < this.pods.length; i++) {
      const pod = this.pods[i];
      const slot = pod.slot;
      let occupant: PeerId | null = null;
      let name = '빈 슬롯', state = '—', local = false;
      if (slot === localSlot && (!lobby || me)) {
        local = true;
        name = net?.playerName ?? '스캐빈저';
        if (this.boardedSlot === slot) { occupant = localId; state = '탑승 완료'; }
        else state = net?.missionInProgress ? '임무 진행 중 — 재투입' : '대기 중';
      } else if (lobby) {
        const q = lobby.players.find((pl) => pl.slot === slot);
        if (q) {
          name = q.name;
          if (!q.connected) state = '연결 끊김';
          else if (q.ready) { occupant = q.id; state = lobby.started ? '임무 중' : '탑승 완료'; }
          else state = '대기 중';
        }
      }
      const changed = pod.setDisplay({ occupant, name, state, local, closed: occupant !== null });
      if (this.slots[i]) this.slots[i].occupant = occupant;
      if (changed) ctx.bus.emit('hub:slotChanged', { slot, peerId: occupant, local });
    }
  }

  private updateTerminalScreen(): void {
    if (!this.terminal) return;
    const net = this.ctx.net;
    const lobby = net?.lobby ?? null;
    const seed = lobby ? lobby.seed : this.missionSeed;
    const seedText = seed === null ? '시드 무작위' : `시드 ${seed}`;
    const status = net?.status === 'connected' ? '네트워크 연결됨' : net?.status === 'connecting' ? '연결 중…' : '오프라인';
    if (lobby) this.terminal.setScreen([`함선 ${lobby.code}`, `승무원 ${lobby.players.length}/4 · ${lobby.isPublic ? '공개' : '비공개'}`, seedText], '#5fd7ff');
    else this.terminal.setScreen(['개인 함선', status, seedText], '#5fd7ff');
  }

  /* ── launch countdown ──────────────────────────────────────────────────── */
  private resolveSeed(): number {
    const lobby = this.ctx.net?.lobby;
    if (lobby && lobby.seed !== null) return lobby.seed >>> 0;
    return (this.missionSeed ?? randomSeed()) >>> 0;
  }

  private launch(): void {
    const ctx = this.ctx;
    const net = ctx.net;
    const seed = this.resolveSeed();
    if (net?.lobby && net.isHost) {
      this.launched = true;
      net.startGame(seed);               // server → game:start → net emits game:newMission → teardown('mission')
    } else if (!net?.lobby) {
      ctx.bus.emit('game:newMission', { seed });
    }
  }

  private tickCountdown(dt: number): void {
    const ctx = this.ctx;
    const net = ctx.net;
    const lobby = net?.lobby ?? null;
    const boarded = this.boardedSlot >= 0;
    let ready = boarded ? 1 : 0, total = 1, allReady = boarded;
    if (lobby) {
      const connected = lobby.players.filter((p) => p.connected);
      total = Math.max(1, connected.length);
      ready = connected.filter((p) => p.ready).length;
      allReady = boarded && !lobby.started && connected.length > 0 && ready === connected.length;
    }
    const authority = !lobby || (net?.isHost ?? false);

    if (allReady && this.countdown < 0 && !this.launched) {
      this.countdown = HUB_LAUNCH_COUNTDOWN;
      this.lastCountdownSecond = -1;
      ctx.bus.emit('audio:play', { id: 'ui_equip' });
    } else if (!allReady) {
      this.launched = false;
      if (this.countdown >= 0) { this.countdown = -1; if (lobby) ctx.bus.emit('ui:notify', { text: '발사 취소 — 승무원 대기', kind: 'warning' }); }
    }

    if (this.countdown >= 0) {
      this.countdown -= dt;
      const sec = Math.max(0, Math.ceil(this.countdown));
      if (sec !== this.lastCountdownSecond) {
        this.lastCountdownSecond = sec;
        // Clients mirror the host's countdown locally (same ready state, same length) so HUD/audio/chat react everywhere.
        ctx.bus.emit('hub:launchCountdown', { seconds: sec, ready, total });
        if (sec > 0) ctx.bus.emit('audio:play', { id: 'ui_click' });
      }
      if (this.countdown <= 0) {
        this.countdown = -1;
        if (authority) this.launch();
        return;
      }
    }

    // status line
    if (boarded) {
      if (this.countdown >= 0) this.status.set(String(Math.max(0, Math.ceil(this.countdown))), '발사 준비 완료', { count: true, progress: 1 - this.countdown / HUB_LAUNCH_COUNTDOWN });
      else if (lobby) this.status.set(`탑승 대기 중 (${ready}/${total})`, '슬롯에서 내리기', { keycap: 'E' });
      else this.status.set('발사 준비', '슬롯에서 내리기', { keycap: 'E' });
    } else if (lobby && net?.missionInProgress) {
      this.status.set('임무 진행 중', '발사 슬롯에 탑승하면 재투입됩니다');
    } else {
      this.status.hide();
    }
  }

  /* ── frame ─────────────────────────────────────────────────────────────── */
  update(dt: number, ctx: GameContext): void {
    this.menu.update();
    if (this.cutscene) {
      this.cutscene.update(dt);
      if (this.cutscene) this.status.set(this.cutscene.direction === 'dock' ? '도킹 절차 진행 중' : '도킹 해제 중', null);
      return;
    }
    if (ctx.phase !== 'hub' || !this.interior) return;

    this.interior.update(dt, ctx.time);
    for (const pod of this.pods) pod.update(dt, ctx.time);

    // Esc: menu toggle / un-board (no pause in the hub). E while boarded: un-board.
    if (ctx.input.wasPressed(Keys.MENU)) {
      if (this.menu.isOpen) this.menu.close();
      else if (ctx.uiBlockers.size === 0) {
        if (this.boardedSlot >= 0) this.leavePod(true);
        else this.menu.open();
      }
    }
    if (this.boardedSlot >= 0 && ctx.uiBlockers.size === 0 && ctx.input.wasPressed(Keys.INTERACT) && ctx.time - this.boardedAt > UNBOARD_GRACE) {
      this.leavePod(true);
    }

    this.tickCountdown(dt);
  }
}
