import * as THREE from 'three';
import type { GameContext, PeerId } from '@/shared';
import { NET_SLOT_COLORS_CSS, PlayerFlags } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const HEAD_OFFSET = 0.35;   // metres above the avatar head
const MAX_DIST = 150;       // hidden beyond this
const FADE_FROM = 110;      // starts fading here

interface Plate { root: HTMLElement; name: HTMLElement; fill: HTMLElement; lastKey: string; lastName: string }

/**
 * Remote-player nameplates: name + tiny hp bar in the slot colour, projected from `avatar.getHeadPosition()`
 * each `lateUpdate`. One pooled element per peer; hidden when behind the camera, off-screen, stale, dropping,
 * boarded in a launch pod (`IN_POD`), disconnected or farther than MAX_DIST. Same projection pattern as `WorldMarkers`.
 * Works in a mission and in the shared ship (hub / docking phases), where avatars also exist.
 */
export class Nameplates {
  readonly root: HTMLElement;
  private plates = new Map<PeerId, Plate>();
  private v = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'nameplates', parent });
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('net:remotePlayerRemoved', ({ id }) => this.remove(id)),
      ctx.bus.on('net:lobbyLeft', () => this.clear()),
      ctx.bus.on('game:abort', () => this.clear()),
      ctx.bus.on('game:newMission', () => this.clear()),
    );
  }

  lateUpdate(ctx: GameContext): void {
    const net = ctx.net;
    const hub = ctx.phase === 'hub' || ctx.phase === 'docking';
    if (!net || !(ctx.isMultiplayer || hub)) { if (this.plates.size) this.clear(); return; }
    const cam = ctx.camera;
    cam.getWorldPosition(this.camPos);
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;

    for (const ref of net.getRemotePlayers()) {
      const plate = this.plates.get(ref.id) ?? this.create(ref.id, ref.slot);
      if (plate.lastName !== ref.name) { plate.lastName = ref.name; setText(plate.name, ref.name); }
      if (!ref.avatar || !ref.connected || ref.stale || (ref.flags & (PlayerFlags.DROPPING | PlayerFlags.IN_POD))) { this.hide(plate); continue; }

      ref.avatar.getHeadPosition(this.v);
      this.v.y += HEAD_OFFSET;
      const dist = this.v.distanceTo(this.camPos);
      if (dist > MAX_DIST) { this.hide(plate); continue; }
      this.v.project(cam);
      if (this.v.z > 1 || this.v.z < -1) { this.hide(plate); continue; }
      const sx = (this.v.x * 0.5 + 0.5) * w;
      const sy = (-this.v.y * 0.5 + 0.5) * h;
      if (sx < -60 || sx > w + 60 || sy < -40 || sy > h + 40) { this.hide(plate); continue; }

      let alpha = 1;
      if (dist > FADE_FROM) alpha = Math.max(0.25, 1 - (dist - FADE_FROM) / (MAX_DIST - FADE_FROM));
      if (dist < 2.5) alpha *= Math.max(0.2, (dist - 0.8) / 1.7);
      const hp = Math.min(1, Math.max(0, ref.hp / Math.max(1, ref.maxHp)));
      const far = dist > 60;
      const key = `${Math.round(sx)}|${Math.round(sy)}|${hp.toFixed(2)}|${alpha.toFixed(2)}|${ref.isDead ? 1 : 0}|${far ? 1 : 0}`;
      if (key === plate.lastKey) continue;
      plate.lastKey = key;
      plate.root.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -100%)`;
      plate.root.style.opacity = alpha.toFixed(2);
      plate.fill.style.transform = `scaleX(${hp.toFixed(3)})`;
      toggleClass(plate.root, 'dead', ref.isDead);
      toggleClass(plate.root, 'far', far);
    }
  }

  private create(id: PeerId, slot: number): Plate {
    const root = el('div', { cls: 'nameplate', parent: this.root });
    root.style.setProperty('--sc', NET_SLOT_COLORS_CSS[slot] ?? '#fff');
    const name = el('div', { cls: 'name', text: '', parent: root });
    const hp = el('div', { cls: 'hp', parent: root });
    const fill = el('div', { cls: 'fill', parent: hp });
    const plate: Plate = { root, name, fill, lastKey: '', lastName: '' };
    this.plates.set(id, plate);
    return plate;
  }

  private hide(p: Plate): void {
    if (p.lastKey !== 'hidden') { p.lastKey = 'hidden'; p.root.style.opacity = '0'; }
  }

  private remove(id: PeerId): void {
    const p = this.plates.get(id);
    if (p) { p.root.remove(); this.plates.delete(id); }
  }

  private clear(): void {
    for (const p of this.plates.values()) p.root.remove();
    this.plates.clear();
  }

  dispose(): void { for (const u of this.unsubs) u(); this.clear(); this.root.remove(); }
}
