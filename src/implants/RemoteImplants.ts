import * as THREE from 'three';
import {
  IMPLANT_AT_RADIUS, IMPLANT_SCAN_PULSE_INTERVAL, IMPLANT_OVERCHARGE_BUFF_HP_RATIO, Layers,
  type GameContext, type ImplantId, type ImplantMessage, type PeerId,
} from '@/shared';
import { getImplantDef, implantHex, isImplantId } from './ImplantDefs';
import { ImplantDevice } from './devices/ImplantDevice';
import { BarrierField } from './effects/Barrier';
import { GrappleWire } from './effects/Grapple';
import { OverchargeBeam, allyPoint } from './effects/Overcharge';
import type { RocketPool } from './effects/AtLauncher';
import type { ImplantFx } from './fx/ImplantFx';

interface PeerVis {
  device: ImplantDevice | null;
  deviceId: ImplantId | null;
  deviceAttached: boolean;
  wire: GrappleWire | null;
  wireActive: boolean;
  readonly wireFrom: THREE.Vector3;
  readonly wireTo: THREE.Vector3;
  barrier: BarrierField | null;
  /* Phase 7: overcharge beam replication (`imp beam`) */
  beam: OverchargeBeam | null;
  beamOn: boolean;
  beamTarget: PeerId | null;
  beamSelf: boolean;
  /** ctx.time after which a beam without a refresh is dropped (the sender refreshes ≤ 4 Hz, `BEAM_TIMEOUT` covers a lost off). */
  beamUntil: number;
  /** Self-channel glow at the caster's chest (additive sphere, no light). */
  glow: THREE.Mesh | null;
  glowMat: THREE.MeshBasicMaterial | null;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3();
/** Chest height above the feet for beam endpoints on the local player (allyPoint covers remotes). */
const CHEST_Y = 1.15;
/** A remote beam not refreshed within this long is treated as ended (sender refreshes every 0.25 s while on). */
const BEAM_TIMEOUT = 1.0;

/**
 * Everything a *remote* caster's implants look like on this client: the device in their hands, their
 * grapple wire, their barrier (which also blocks hostile fire here — see `ImplantSystem.raycastBarrier`),
 * their scan pulses and their rockets.
 *
 * Devices are driven by `PlayerSnapshot.imp` (via `RemotePlayerRef.implantId`) so a late joiner still
 * sees them; the discrete `imp` messages carry the one-shot FX.
 */
export class RemoteImplants {
  private readonly peers = new Map<PeerId, PeerVis>();
  /** Shared glow sphere geometry (one material per peer for independent pulsing). */
  private readonly glowGeo = new THREE.SphereGeometry(0.55, 14, 10);
  private phase = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly fx: ImplantFx,
    private readonly rockets: RocketPool,
  ) {}

  /** Barriers owned by peers (queried by `raycastBarrier` together with the local one). */
  getBarriers(out: BarrierField[]): BarrierField[] {
    out.length = 0;
    for (const v of this.peers.values()) if (v.barrier && v.barrier.active) out.push(v.barrier);
    return out;
  }

  handle(msg: ImplantMessage, from: PeerId): void {
    const v = this.get(from);
    switch (msg.ev) {
      case 'wield':
        // snapshots drive the device; this only makes the change instant
        if (!msg.wielded && v.deviceId === msg.id) this.setDevice(v, null);
        else if (msg.wielded && isImplantId(msg.id)) this.setDevice(v, msg.id);
        break;
      case 'grapple': {
        if (!msg.p) {
          if (v.wireActive) { v.wireActive = false; v.wire?.hide(); }
          break;
        }
        v.wireFrom.set(msg.o[0], msg.o[1], msg.o[2]);
        v.wireTo.set(msg.p[0], msg.p[1], msg.p[2]);
        if (!v.wire) v.wire = new GrappleWire(this.ctx.scene, this.fx, implantHex('grapple'));
        v.wireActive = true;
        v.wire.set(v.wireFrom, v.wireTo, true);
        this.fx.spark(v.wireTo, implantHex('grapple'), 0.3);
        this.ctx.bus.emit('audio:play', { id: 'grapple_attach', position: v.wireTo, volume: 0.5 });
        break;
      }
      case 'dash': {
        _a.set(msg.o[0], msg.o[1], msg.o[2]);
        _b.set(msg.d[0], msg.d[1], msg.d[2]);
        _b.add(_a);
        _a.y += 0.9; _b.y += 0.9;
        this.fx.streak(_a, _b, implantHex('dash'), 0.3, 0.35);
        this.ctx.bus.emit('audio:play', { id: 'dash', position: _a, volume: 0.5 });
        break;
      }
      case 'barrier': {
        if (!msg.active) {
          if (v.barrier?.active) {
            this.ctx.bus.emit('audio:play', { id: 'barrier_stow', position: v.barrier.position, volume: 0.4 });
            v.barrier.stow();
          }
          break;
        }
        if (!v.barrier) v.barrier = new BarrierField(this.ctx.scene, implantHex('barrier'), from);
        _a.set(msg.p[0], msg.p[1], msg.p[2]);
        if (v.barrier.active) {
          // durability update for a shield that is already standing — do not replay the unfold
          v.barrier.setHp(msg.hp);
        } else {
          v.barrier.deploy(_a, msg.yaw, msg.hp);
          this.ctx.bus.emit('audio:play', { id: 'barrier_deploy', position: _a, volume: 0.6 });
        }
        break;
      }
      case 'scan': {
        _a.set(msg.p[0], msg.p[1], msg.p[2]);
        this.fx.pulse(_a, msg.radius, IMPLANT_SCAN_PULSE_INTERVAL * 1.4, implantHex('scan'), _a.y);
        this.ctx.bus.emit('audio:play', { id: 'scan_pulse', position: _a, volume: 0.4 });
        break;
      }
      case 'rocket': {
        _a.set(msg.o[0], msg.o[1], msg.o[2]);
        _b.set(msg.d[0], msg.d[1], msg.d[2]);
        this.rockets.fire(_a, _b, true);
        this.ctx.bus.emit('audio:play', { id: 'rocket_fire', position: _a, volume: 0.7 });
        break;
      }
      case 'rocketHit': {
        _a.set(msg.p[0], msg.p[1], msg.p[2]);
        this.fx.blast(_a, IMPLANT_AT_RADIUS);
        this.ctx.bus.emit('camera:shake', { intensity: 0.3, duration: 0.25 });
        this.ctx.bus.emit('audio:play', { id: 'rocket_explode', position: _a, volume: 0.9 });
        break;
      }
      case 'beam': {
        // Phase 7: overcharge channel — `target` = the ally the beam locks onto (may be us), `self` = healing themselves
        if (!msg.target && !msg.self) { this.endBeam(v); break; }
        const starting = !v.beamOn;
        v.beamOn = true; v.beamTarget = msg.target; v.beamSelf = msg.self;
        v.beamUntil = this.ctx.time + BEAM_TIMEOUT;
        if (starting) {
          const ref = this.ctx.net?.getRemotePlayer(from);
          if (ref) { _a.copy(ref.position); _a.y += CHEST_Y; }
          this.ctx.bus.emit('audio:play', { id: 'overcharge_beam', position: ref ? _a : undefined, volume: 0.35 });
        }
        break;
      }
    }
  }

  /** e2e hook (Phase 9): the beam state replicated for `peerId`, or null when that peer has no visuals here. */
  debugBeam(peerId: PeerId): { on: boolean; target: PeerId | null; self: boolean; until: number } | null {
    const v = this.peers.get(peerId);
    if (!v) return null;
    return { on: v.beamOn, target: v.beamTarget, self: v.beamSelf, until: v.beamUntil };
  }

  update(dt: number): void {
    const net = this.ctx.net;
    // devices follow the snapshot field so they survive a missed `imp wield`
    if (net) {
      for (const r of net.getRemotePlayers()) {
        const id = r.implantId;
        const wielded = id && getImplantDef(id)?.mode === 'wielded' ? id : null;
        const v = this.peers.get(r.id);
        if (!wielded && !v) continue;
        const vv = v ?? this.get(r.id);
        if (vv.deviceId !== wielded) this.setDevice(vv, wielded);
        // (re)attach once the avatar exists
        if (vv.device && !vv.deviceAttached) {
          const socket = r.avatar?.weaponSocket;
          if (socket) { socket.add(vv.device.root); vv.deviceAttached = true; }
        }
        vv.device?.update(dt, 1);
      }
    }
    this.phase += dt;
    for (const [id, v] of this.peers) {
      if (v.barrier) v.barrier.update(dt);
      if (v.beamOn) this.updateBeam(v, id, dt);
      if (v.wire) {
        v.wire.update(dt);
        if (v.wireActive) {
          const ref = net?.getRemotePlayer(id);
          const socket = ref?.avatar?.weaponSocket;
          if (socket) { socket.updateWorldMatrix(true, false); _a.setFromMatrixPosition(socket.matrixWorld); }
          else if (ref) { _a.copy(ref.position); _a.y += 1.2; }
          else _a.copy(v.wireFrom);
          v.wire.set(_a, v.wireTo, true);
        }
      }
    }
  }

  remove(id: PeerId): void {
    const v = this.peers.get(id);
    if (!v) return;
    this.disposePeer(v);
    this.peers.delete(id);
  }

  clear(): void {
    for (const v of this.peers.values()) this.disposePeer(v);
    this.peers.clear();
  }

  dispose(): void { this.clear(); this.glowGeo.dispose(); }

  /* ─────────────────────────── internals ─────────────────────────── */
  private get(id: PeerId): PeerVis {
    let v = this.peers.get(id);
    if (!v) {
      v = {
        device: null, deviceId: null, deviceAttached: false,
        wire: null, wireActive: false, wireFrom: new THREE.Vector3(), wireTo: new THREE.Vector3(),
        barrier: null,
        beam: null, beamOn: false, beamTarget: null, beamSelf: false, beamUntil: 0, glow: null, glowMat: null,
      };
      this.peers.set(id, v);
    }
    return v;
  }

  /* ── Phase 7: overcharge beam / self glow of a remote caster ── */
  private updateBeam(v: PeerVis, id: PeerId, dt: number): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (ctx.time > v.beamUntil) { this.endBeam(v); return; }
    const caster = net?.getRemotePlayer(id);
    if (!caster) { this.hideBeamVisuals(v); return; }
    // origin: the caster's hand (weapon socket), else the chest
    const socket = caster.avatar?.weaponSocket;
    if (socket) { socket.updateWorldMatrix(true, false); _a.setFromMatrixPosition(socket.matrixWorld); }
    else { _a.copy(caster.position); _a.y += CHEST_Y; }

    if (v.beamTarget) {
      // endpoint: the locked ally's chest — a remote ref, or the local player when the beam is aimed at us
      let healthy = false;
      if (net && v.beamTarget === net.localId) {
        const me = ctx.player;
        if (!me || me.isDead) { this.hideBeamVisuals(v); return; }
        _b.copy(me.position); _b.y += CHEST_Y;
        healthy = me.hp >= me.maxHp * IMPLANT_OVERCHARGE_BUFF_HP_RATIO;
      } else {
        const ref = net?.getRemotePlayer(v.beamTarget);
        if (!ref || !ref.connected || ref.isDead) { this.hideBeamVisuals(v); return; }   // unknown / gone target: nothing to draw
        allyPoint(ref, _b);
        healthy = ref.maxHp > 0 && ref.hp >= ref.maxHp * IMPLANT_OVERCHARGE_BUFF_HP_RATIO;
      }
      if (!v.beam) v.beam = new OverchargeBeam(ctx.scene, this.fx, implantHex('overcharge'), implantHex('dash'));
      v.beam.update(dt);
      v.beam.set(_a, _b, healthy ? 'boost' : 'heal', ctx.camera);
      if (v.glow) v.glow.visible = false;
      return;
    }
    // self channel: pulsing glow around the caster's chest
    v.beam?.hide();
    if (!v.glow) {
      v.glowMat = new THREE.MeshBasicMaterial({
        color: implantHex('overcharge'), transparent: true, opacity: 0.22, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false,
      });
      v.glow = new THREE.Mesh(this.glowGeo, v.glowMat);
      v.glow.layers.enable(Layers.NO_RAYCAST);
      ctx.scene.add(v.glow);
    }
    _b.copy(caster.position); _b.y += CHEST_Y * 0.85;
    v.glow.visible = true;
    v.glow.position.copy(_b);
    const pulse = 0.5 + Math.sin(this.phase * 9) * 0.5;
    v.glow.scale.setScalar(0.85 + pulse * 0.35);
    if (v.glowMat) v.glowMat.opacity = 0.14 + pulse * 0.16;
  }

  private hideBeamVisuals(v: PeerVis): void {
    v.beam?.hide();
    if (v.glow) v.glow.visible = false;
  }

  private endBeam(v: PeerVis): void {
    v.beamOn = false; v.beamTarget = null; v.beamSelf = false;
    this.hideBeamVisuals(v);
  }

  private setDevice(v: PeerVis, id: ImplantId | null): void {
    if (v.device) { v.device.dispose(); v.device = null; }
    v.deviceId = id;
    v.deviceAttached = false;
    if (id) v.device = new ImplantDevice(id);
  }

  private disposePeer(v: PeerVis): void {
    v.device?.dispose();
    v.wire?.dispose();
    v.barrier?.dispose();
    v.beam?.dispose();
    if (v.glow) { v.glow.removeFromParent(); v.glowMat?.dispose(); }
    v.device = null; v.wire = null; v.barrier = null; v.beam = null; v.glow = null; v.glowMat = null;
    v.deviceId = null; v.deviceAttached = false; v.wireActive = false;
    v.beamOn = false; v.beamTarget = null; v.beamSelf = false;
  }
}
