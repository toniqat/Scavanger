import * as THREE from 'three';
import type { GameContext, PeerId, RemotePlayerRef } from '@/shared';
import { NET_SLOT_COLORS_CSS, PLAYER_DOWN_HP, PlayerFlags, SUSPENDED_LABEL_KO } from '@/shared';
import { el, rarityColor, setText, toggleClass } from '../dom';

const HEAD_OFFSET = 0.35;   // metres above the avatar head
const MAX_DIST = 150;       // hidden beyond this
const FADE_FROM = 110;      // starts fading here
const EMPTY: readonly RemotePlayerRef[] = [];
/** Slot colour replacement for a suspended member (matches `.srow.suspended` / the map's grey). */
const SUSPENDED_CSS = '#9aa0aa';
/** Tag under the name of a suspended member whose host ghost bled out (`ghostState === 2`). */
export const GHOST_DEAD_LABEL_KO = '사망';

interface Plate {
  root: HTMLElement; name: HTMLElement; tag: HTMLElement; fill: HTMLElement; bleed: HTMLElement;
  /** 2026-09-11 (C-19): thin shield bar above the hp bar, and its fill. */
  sh: HTMLElement; shFill: HTMLElement;
  color: string; lastKey: string; lastName: string; lastTag: string;
  /** `ref.armorId` the shield colour was last resolved for (`undefined` = never). */
  lastArmor: string | null | undefined;
}

/**
 * Remote-player nameplates: name + tiny hp bar in the slot colour, projected from `avatar.getHeadPosition()`
 * each `lateUpdate`. One pooled element per peer; hidden when behind the camera, off-screen, stale, dropping,
 * boarded in a launch pod (`IN_POD`), disconnected or farther than MAX_DIST. Same projection pattern as `WorldMarkers`.
 * Works in a mission and in the shared ship (hub / docking phases), where avatars also exist.
 *
 * Phase 7: a **suspended** member (`RemotePlayerRef.suspended` — socket down, body kept as a host ghost) stays visible:
 * grey plate (`.suspended`) with a `연결 끊김` tag (`SUSPENDED_LABEL_KO`) under the name, even though the ref is `stale`.
 * `setDebugRefs` lets smoke tests feed refs from `remotePlayers.debugSpawn` (rendered in addition to `ctx.net`'s list).
 * Phase 9: while the ghost is downed (`ref.ghostState === 1`) a red bleed bar (`.bleeding`, `ghostDownHp / PLAYER_DOWN_HP`)
 * overlays the greyed hp bar; a bled-out ghost (`ghostState === 2`) reads `사망` (`.tag.dead`, strike-through name).
 * 2026-09-11 (C-19): a thin **shield bar** (`.sh`, shown by `.has-shield`) sits above the hp bar — `ref.shield / maxShield`
 * (`PlayerSnapshot.sh / shm`, only sent while the peer wears armour; a missing `shield` next to a known max reads full).
 * Drawn only when `maxShield > 0` and the peer is neither downed, dead nor suspended (a host ghost carries no shield —
 * `applyGhost` clears it). A separate bar, not a segment stacked onto the hp bar, so a full shield never hides how hurt
 * the body under it is. Colour = the armour's rarity (`ctx.loot`), like the local `Vitals` shield cells; `.far` hides it.
 */
export class Nameplates {
  readonly root: HTMLElement;
  private plates = new Map<PeerId, Plate>();
  private v = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private unsubs: Array<() => void> = [];
  private debugRefs: readonly RemotePlayerRef[] | null = null;

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

  /** Smoke-test hook: extra refs (e.g. `remotePlayers.debugSpawn`) rendered like real peers; `null` clears. */
  setDebugRefs(refs: readonly RemotePlayerRef[] | null): void {
    this.debugRefs = refs && refs.length ? refs : null;
    if (!this.debugRefs) this.clear();
  }

  lateUpdate(ctx: GameContext): void {
    const net = ctx.net;
    const hub = ctx.phase === 'hub' || ctx.phase === 'docking';
    const debug = this.debugRefs;
    if (!debug && (!net || !(ctx.isMultiplayer || hub))) { if (this.plates.size) this.clear(); return; }
    const cam = ctx.camera;
    cam.getWorldPosition(this.camPos);
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;

    const live = net?.getRemotePlayers() ?? EMPTY;
    for (let pass = 0; pass < 2; pass++) {
      const refs = pass === 0 ? live : (debug ?? EMPTY);
      for (const ref of refs) this.place(ctx, ref, cam, w, h);
    }
  }

  private place(ctx: GameContext, ref: RemotePlayerRef, cam: THREE.Camera, w: number, h: number): void {
    const plate = this.plates.get(ref.id) ?? this.create(ref.id, ref.slot);
    if (plate.lastName !== ref.name) { plate.lastName = ref.name; setText(plate.name, ref.name); }
    const suspended = ref.suspended === true;
    // A suspended member's ref is stale by definition (no snapshots) — keep the plate on its ghost body.
    const gone = suspended ? (!ref.avatar || (ref.flags & PlayerFlags.IN_POD) !== 0)
      : (!ref.avatar || !ref.connected || ref.stale || (ref.flags & (PlayerFlags.DROPPING | PlayerFlags.IN_POD)) !== 0);
    if (gone) { this.hide(plate); return; }

    ref.avatar!.getHeadPosition(this.v);
    this.v.y += HEAD_OFFSET;
    const dist = this.v.distanceTo(this.camPos);
    if (dist > MAX_DIST) { this.hide(plate); return; }
    this.v.project(cam);
    if (this.v.z > 1 || this.v.z < -1) { this.hide(plate); return; }
    const sx = (this.v.x * 0.5 + 0.5) * w;
    const sy = (-this.v.y * 0.5 + 0.5) * h;
    if (sx < -60 || sx > w + 60 || sy < -40 || sy > h + 40) { this.hide(plate); return; }

    let alpha = 1;
    if (dist > FADE_FROM) alpha = Math.max(0.25, 1 - (dist - FADE_FROM) / (MAX_DIST - FADE_FROM));
    if (dist < 2.5) alpha *= Math.max(0.2, (dist - 0.8) / 1.7);
    const hp = Math.min(1, Math.max(0, ref.hp / Math.max(1, ref.maxHp)));
    const far = dist > 60;
    // Phase 9: host-ghost state on the ref (net fills it while suspended)
    const ghostDowned = suspended && ref.ghostState === 1;
    const ghostDead = suspended && ref.ghostState === 2;
    const bleed = ghostDowned ? Math.min(1, Math.max(0, (ref.ghostDownHp ?? PLAYER_DOWN_HP) / PLAYER_DOWN_HP)) : 0;
    const dead = ref.isDead || ghostDead;
    // C-19: shield bar — only for a standing, connected, armoured peer
    const maxShield = ref.maxShield ?? 0;
    const shieldOn = maxShield > 0 && !ref.isDowned && (ref.flags & PlayerFlags.DOWNED) === 0 && !dead && !suspended;
    const shield = shieldOn ? Math.min(1, Math.max(0, (ref.shield ?? maxShield) / maxShield)) : 0;
    if (shieldOn && plate.lastArmor !== ref.armorId) {
      plate.lastArmor = ref.armorId;
      const rarity = ref.armorId ? ctx.loot?.getItemDef(ref.armorId)?.rarity : undefined;
      plate.sh.style.setProperty('--shc', rarityColor(rarity ?? 'common'));
    }
    const key = `${Math.round(sx)}|${Math.round(sy)}|${hp.toFixed(2)}|${alpha.toFixed(2)}|${dead ? 1 : 0}|${far ? 1 : 0}|${suspended ? 1 : 0}|${ghostDowned ? bleed.toFixed(2) : ghostDead ? 'x' : '-'}|${shieldOn ? shield.toFixed(2) : '-'}`;
    if (key === plate.lastKey) return;
    plate.lastKey = key;
    plate.root.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -100%)`;
    plate.root.style.opacity = alpha.toFixed(2);
    plate.fill.style.transform = `scaleX(${hp.toFixed(3)})`;
    toggleClass(plate.root, 'dead', dead);
    toggleClass(plate.root, 'far', far);
    toggleClass(plate.root, 'suspended', suspended);
    toggleClass(plate.root, 'bleeding', ghostDowned);
    plate.bleed.style.transform = `scaleX(${bleed.toFixed(3)})`;
    toggleClass(plate.root, 'has-shield', shieldOn);
    plate.shFill.style.transform = `scaleX(${shield.toFixed(3)})`;
    // the slot colour is an inline custom property, so the grey has to be written inline too
    plate.root.style.setProperty('--sc', suspended ? SUSPENDED_CSS : plate.color);
    plate.tag.hidden = !suspended;
    const tag = ghostDead ? GHOST_DEAD_LABEL_KO : SUSPENDED_LABEL_KO;
    if (tag !== plate.lastTag) { plate.lastTag = tag; setText(plate.tag, tag); toggleClass(plate.tag, 'dead', ghostDead); }
  }

  private create(id: PeerId, slot: number): Plate {
    const root = el('div', { cls: 'nameplate', parent: this.root });
    const color = NET_SLOT_COLORS_CSS[slot] ?? '#fff';
    root.style.setProperty('--sc', color);
    const name = el('div', { cls: 'name', text: '', parent: root });
    const tag = el('div', { cls: 'tag', text: SUSPENDED_LABEL_KO, parent: root });
    tag.hidden = true;
    const sh = el('div', { cls: 'sh', parent: root });
    const shFill = el('div', { cls: 'fill', parent: sh });
    const hp = el('div', { cls: 'hp', parent: root });
    const fill = el('div', { cls: 'fill', parent: hp });
    const bleed = el('div', { cls: 'bleed', parent: hp });
    const plate: Plate = { root, name, tag, fill, bleed, sh, shFill, color, lastKey: '', lastName: '', lastTag: SUSPENDED_LABEL_KO, lastArmor: undefined };
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
