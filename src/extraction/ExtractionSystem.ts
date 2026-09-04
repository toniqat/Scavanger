import * as THREE from 'three';
import type { GameContext, GameSystem, Interactable, ExtractionPointDef } from '@/shared';
import { EXTRACTION_COUNTDOWN } from '@/shared';
import { ExtractionConsole } from './Console';
import { Dropship } from './Ship';
import { FlareColumn, DustRing } from './Particles';

const SHIP_INCOMING_AT = 12;      // seconds remaining when the ship starts its approach
const APPROACH_DURATION = 8;      // approach phase; descent (4.2 s) follows → touchdown ≈ 0 s

interface PadEntry {
  def: ExtractionPointDef;
  console: ExtractionConsole;
  interactableId: string;
}

/**
 * Extraction flow: pad consoles → countdown + flare → ship flight-in / landing → boarding → interior switch → liftoff.
 * Emits the `extraction:*` events; GameFlowSystem owns the phase transitions.
 */
export class ExtractionSystem implements GameSystem {
  readonly name = 'extraction';
  private ctx!: GameContext;
  private pads: PadEntry[] = [];
  private ship: Dropship | null = null;
  private flare: FlareColumn | null = null;
  private dust: DustRing | null = null;
  private unsubs: Array<() => void> = [];
  /** Seed of the world the current pads were built for (guards against event-order races). */
  private padsSeed: number | null = null;

  private activePad: PadEntry | null = null;
  private countdown = 0;
  private counting = false;
  private shipCalled = false;
  private landed = false;
  private boarded = false;
  private lifting = false;
  private doorsClosedEmitted = false;
  private lastBeepSecond = -1;
  private shipLandPos = new THREE.Vector3();
  private shipYaw = 0;
  private dir = new THREE.Vector3();

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.ship = new Dropship();
    this.flare = new FlareColumn();
    this.dust = new DustRing();
    ctx.scene.add(this.ship.root, this.flare.group, this.dust.pool.points);

    this.unsubs.push(
      ctx.bus.on('world:ready', () => this.buildPads()),
      ctx.bus.on('game:abort', () => this.resetMission(true)),
      // NOTE: WorldSystem generates synchronously inside its own game:newMission handler, so world:ready
      // (and buildPads) has already run by the time this handler fires → keep pads that match the new seed.
      ctx.bus.on('game:newMission', () => this.resetMission(false)),
      ctx.bus.on('player:died', () => { this.flare?.stop(); }),
    );
  }

  /* ── Pads / consoles ─────────────────────────────────────────────────── */
  private buildPads(): void {
    this.clearPads();
    const world = this.ctx.world;
    if (!world) return;
    this.padsSeed = world.seed;
    for (const def of world.getExtractionPoints()) {
      const dir = new THREE.Vector3(Math.sin(def.yaw), 0, Math.cos(def.yaw));
      // def.position.y is the top of the (flat) landing platform — use it directly.
      const pos = def.position.clone().addScaledVector(dir, 5);
      const console = new ExtractionConsole(pos, def.yaw);
      this.ctx.scene.add(console.group);
      const id = `extract_${def.id}`;
      const interactable: Interactable = {
        id,
        position: console.interactPoint,
        radius: 2.6,
        holdTime: 1.2,
        getPrompt: () => (this.ctx.phase === 'playing' ? '탈출 신호 전송 (E 길게)' : null),
        canInteract: () => this.ctx.phase === 'playing' && !this.activePad,
        interact: () => this.activate(entry),
      };
      const entry: PadEntry = { def, console, interactableId: id };
      this.ctx.interactables.register(interactable);
      this.pads.push(entry);
    }
  }

  private clearPads(): void {
    for (const p of this.pads) {
      this.ctx.interactables.unregister(p.interactableId);
      p.console.dispose();
    }
    this.pads.length = 0;
    this.padsSeed = null;
  }

  /* ── Activation / countdown ──────────────────────────────────────────── */
  private activate(pad: PadEntry): void {
    if (this.activePad) return;
    this.activePad = pad;
    this.counting = true;
    this.countdown = EXTRACTION_COUNTDOWN;
    this.shipCalled = false;
    this.landed = false;
    this.lastBeepSecond = -1;
    pad.console.setState('active');
    for (const other of this.pads) if (other !== pad) other.console.setState('off');

    const center = pad.def.position.clone(); // platform top at pad center
    this.dir.set(Math.sin(pad.def.yaw), 0, Math.cos(pad.def.yaw));
    this.shipYaw = pad.def.yaw;
    // Ship root sits 5 m back from the pad center so the rear ramp opening lands at the center, facing the console.
    this.shipLandPos.copy(center).addScaledVector(this.dir, -5);
    this.shipLandPos.y = center.y;

    // Flare rises from the pad center (between console and ship landing spot).
    this.flare!.start(center.clone().addScaledVector(this.dir, 2.5));

    // EnemySystem subscribes to extraction:activated / extraction:liftoff itself (start/stop waves).
    this.ctx.bus.emit('extraction:activated', { pointId: pad.def.id, position: center, duration: EXTRACTION_COUNTDOWN });
    this.ctx.bus.emit('audio:play', { id: 'extract_activate', position: pad.console.interactPoint });
  }

  private callShip(): void {
    this.shipCalled = true;
    this.ship!.startApproach(this.shipLandPos, this.shipYaw, APPROACH_DURATION);
    this.ctx.bus.emit('extraction:shipIncoming', { position: this.shipLandPos.clone(), eta: SHIP_INCOMING_AT });
    this.ctx.bus.emit('audio:play', { id: 'ship_approach', position: this.shipLandPos });
  }

  private onShipLanded(): void {
    this.landed = true;
    this.counting = false;
    this.flare!.stop();
    const pos = this.shipLandPos.clone();
    this.ctx.bus.emit('camera:shake', { intensity: 0.9, duration: 0.7 });
    this.ctx.bus.emit('audio:play', { id: 'ship_land', position: pos });
    this.ctx.bus.emit('extraction:shipLanded', { position: pos });

    const ship = this.ship!;
    const sw: Interactable = {
      id: 'ship_liftoff_switch',
      position: ship.interiorSwitchWorld,
      radius: 2.4,
      holdTime: 1.0,
      getPrompt: () => (this.boarded && this.ctx.phase === 'shipLanded' ? '이륙 스위치 작동 (E 길게)' : null),
      canInteract: () => this.boarded && this.ctx.phase === 'shipLanded' && !this.lifting,
      interact: () => this.liftoff(),
    };
    this.ctx.interactables.register(sw);
  }

  private liftoff(): void {
    if (this.lifting) return;
    this.lifting = true;
    this.doorsClosedEmitted = false;
    const ship = this.ship!;
    const player = this.ctx.player;
    ship.beginLiftoff();
    this.ctx.interactables.unregister('ship_liftoff_switch');
    if (player) {
      player.setControlsEnabled(false);
      player.attachTo(ship.root);
    }
    this.ctx.bus.emit('extraction:liftoff', { position: ship.position.clone() });
    this.ctx.bus.emit('audio:play', { id: 'ship_liftoff', position: ship.position });
  }

  /* ── Frame update ────────────────────────────────────────────────────── */
  update(dt: number, ctx: GameContext): void {
    for (const p of this.pads) p.console.update(dt);
    this.flare?.update(dt);
    this.dust?.update(dt);
    const ship = this.ship;
    if (!ship) return;

    if (this.counting && ctx.isGameplayPhase()) {
      this.countdown = Math.max(0, this.countdown - dt);
      ctx.bus.emit('extraction:tick', { remaining: this.countdown, total: EXTRACTION_COUNTDOWN });
      if (this.countdown <= 10 && this.countdown > 0) {
        const sec = Math.ceil(this.countdown);
        if (sec !== this.lastBeepSecond) {
          this.lastBeepSecond = sec;
          ctx.bus.emit('audio:play', { id: 'countdown_beep', volume: sec <= 3 ? 1 : 0.7, pitch: sec <= 3 ? 1.25 : 1 });
        }
      }
      if (!this.shipCalled && this.countdown <= SHIP_INCOMING_AT) this.callShip();
    }

    const ev = ship.update(dt);
    if (ev.touchdown) this.onShipLanded();
    if (ev.rampClosed && this.lifting && !this.doorsClosedEmitted) {
      this.doorsClosedEmitted = true;
      ctx.bus.emit('extraction:doorsClosed', {});
    }

    // Dust while descending near the ground and during the first seconds of liftoff.
    if (ship.descending) {
      const h = ship.position.y - ship.getGroundY();
      const strength = THREE.MathUtils.clamp(1 - h / 18, 0, 1);
      this.dust!.emit(ship.position, ship.getGroundY(), strength, dt);
      if (h < 6) ctx.bus.emit('camera:shake', { intensity: 0.08 * (1 - h / 6), duration: 0.1 });
    } else if (ship.liftingOff) {
      const t = ship.liftoffTime;
      const h = ship.position.y - ship.getGroundY();
      if (t > 1.0 && h < 20) this.dust!.emit(this.shipLandPos, ship.getGroundY(), THREE.MathUtils.clamp(1 - h / 20, 0, 1), dt);
      if (t > 1.2) ctx.bus.emit('camera:shake', { intensity: 0.12, duration: 0.1 });
    }

    // Boarding volume
    const player = ctx.player;
    if (player && this.landed && !this.lifting && ctx.phase === 'shipLanded') {
      const inside = ship.containsWorldPoint(player.position);
      if (inside && !this.boarded) {
        this.boarded = true;
        player.setShipInterior(ship.getInteriorBounds());
        ctx.bus.emit('extraction:boarded', {});
      } else if (!inside && this.boarded) {
        this.boarded = false;
        player.setShipInterior(null);
      }
    }
  }

  /* ── Reset ───────────────────────────────────────────────────────────── */
  private resetMission(clearPads: boolean): void {
    const world = this.ctx.world;
    const padsAreCurrent = !!world && world.ready && this.padsSeed === world.seed;
    if (clearPads || !padsAreCurrent) this.clearPads();
    else for (const p of this.pads) p.console.setState('idle');
    this.ctx.interactables.unregister('ship_liftoff_switch');
    this.ship?.reset();
    this.flare?.reset();
    this.dust?.reset();
    this.activePad = null;
    this.counting = false;
    this.countdown = 0;
    this.shipCalled = false;
    this.landed = false;
    this.lifting = false;
    this.doorsClosedEmitted = false;
    this.lastBeepSecond = -1;
    if (this.boarded) {
      this.ctx.player?.setShipInterior(null);
      this.boarded = false;
    }
    // Player detachment / control re-enable is handled by PlayerSystem on respawn; be defensive anyway.
    this.ctx.player?.attachTo(null);
    this.ctx.player?.setControlsEnabled(true);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.clearPads();
    this.ctx.interactables.unregister('ship_liftoff_switch');
    this.ship?.dispose(); this.ship = null;
    this.flare?.dispose(); this.flare = null;
    this.dust?.dispose(); this.dust = null;
  }
}
