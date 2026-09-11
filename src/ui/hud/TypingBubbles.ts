import * as THREE from 'three';
import type { GameContext, PeerId, RemotePlayerRef } from '@/shared';
import { PlayerFlags } from '@/shared';
import { el } from '../dom';
import { isPeerBlocked } from '../menus/social/socialSource';

/** Metres above the avatar head — Nameplates sits at 0.35, the bubble rides 0.35 m higher so the two never overlap. */
const HEAD_OFFSET = 0.35 + 0.35;
const MAX_DIST = 150;       // hidden beyond this (same as Nameplates)
const FADE_FROM = 110;      // starts fading here
const EMPTY: readonly RemotePlayerRef[] = [];

interface Bubble { root: HTMLElement; lastKey: string }

/**
 * Typing speech bubbles (2026-09-09): a small dark rounded bubble with three bobbing dots over the head of every
 * **remote** player whose snapshot carries `PlayerFlags.TYPING` (net raises it on the local snapshot while the chat input
 * is open). Never drawn for the local player. Projection = `Nameplates` (`avatar.getHeadPosition()` + `HEAD_OFFSET`,
 * hidden behind the camera / off-screen / beyond `MAX_DIST`, fading from `FADE_FROM`), placed just above the nameplate.
 * The dots animate in CSS (`.tbubble i`, staggered `animation-delay`), so the only per-frame DOM write is the transform
 * when the rounded position changes. Works in missions and in the shared ship (both have avatars).
 *
 * One pooled element per peer; removed on `net:remotePlayerRemoved`, cleared on `net:lobbyLeft` / `game:abort` /
 * `game:newMission`. Styles: `.typing-bubbles`, `.tbubble`, `.tbubble i` in `styles/base.css`.
 *
 * **차단 (2026-09-11, B-11).** A squad-mate whose 아이디 is on my 차단 목록 never gets a bubble — the same gate that drops
 * their typed chat line (`socialSource.isPeerBlocked`, shared with `hud/ChatLog`). It is read **before** an element is
 * created, so a blocked peer costs no DOM at all. 이름표 · 핑 · 월드 마커 are untouched: where a squad-mate stands is
 * gameplay information (the same line as the `ping` / `request` chat lines `ChatLog` keeps drawing).
 *
 * `setDebugRefs(refs)` = smoke hook, the `Nameplates` one: extra refs (`remotePlayers.debugSpawn`) drawn next to
 * `ctx.net`'s list.
 */
export class TypingBubbles {
  readonly root: HTMLElement;
  private bubbles = new Map<PeerId, Bubble>();
  private v = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private unsubs: Array<() => void> = [];
  private debugRefs: readonly RemotePlayerRef[] | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'typing-bubbles', parent });
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('net:remotePlayerRemoved', ({ id }) => this.remove(id)),
      ctx.bus.on('net:lobbyLeft', () => this.clear()),
      ctx.bus.on('game:abort', () => this.clear()),
      ctx.bus.on('game:newMission', () => this.clear()),
    );
  }

  /** Smoke-test hook: extra refs (e.g. `remotePlayers.debugSpawn`) drawn like real peers; `null` clears. */
  setDebugRefs(refs: readonly RemotePlayerRef[] | null): void {
    this.debugRefs = refs && refs.length ? refs : null;
    if (!this.debugRefs) this.clear();
  }

  lateUpdate(ctx: GameContext): void {
    const net = ctx.net;
    const hub = ctx.phase === 'hub' || ctx.phase === 'docking';
    const debug = this.debugRefs;
    if (!debug && (!net || !(ctx.isMultiplayer || hub))) { if (this.bubbles.size) this.clear(); return; }
    const cam = ctx.camera;
    cam.getWorldPosition(this.camPos);
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    for (let pass = 0; pass < 2; pass++) {
      const refs = pass === 0 ? (net?.getRemotePlayers() ?? EMPTY) : (debug ?? EMPTY);
      for (const ref of refs) this.place(ctx, ref, cam, w, h);
    }
  }

  private place(ctx: GameContext, ref: RemotePlayerRef, cam: THREE.Camera, w: number, h: number): void {
    const typing = (ref.flags & PlayerFlags.TYPING) !== 0;
    const existing = this.bubbles.get(ref.id);
    // no element until the peer actually types — most peers never need one, and a blocked peer never gets one at all
    // (2026-09-11 B-11: the same 차단 gate `hud/ChatLog` uses on their typed lines; only asked for someone who IS typing)
    if (!typing || isPeerBlocked(ctx, ref.id)) { if (existing) this.hide(existing); return; }
    const b = existing ?? this.create(ref.id);
    const gone = !ref.avatar || !ref.connected || ref.stale || (ref.flags & (PlayerFlags.DROPPING | PlayerFlags.IN_POD)) !== 0;
    if (gone) { this.hide(b); return; }

    ref.avatar!.getHeadPosition(this.v);
    this.v.y += HEAD_OFFSET;
    const dist = this.v.distanceTo(this.camPos);
    if (dist > MAX_DIST) { this.hide(b); return; }
    this.v.project(cam);
    if (this.v.z > 1 || this.v.z < -1) { this.hide(b); return; }
    const sx = (this.v.x * 0.5 + 0.5) * w;
    const sy = (-this.v.y * 0.5 + 0.5) * h;
    if (sx < -60 || sx > w + 60 || sy < -40 || sy > h + 40) { this.hide(b); return; }

    let alpha = 1;
    if (dist > FADE_FROM) alpha = Math.max(0.25, 1 - (dist - FADE_FROM) / (MAX_DIST - FADE_FROM));
    if (dist < 2.5) alpha *= Math.max(0.2, (dist - 0.8) / 1.7);
    const key = `${Math.round(sx)}|${Math.round(sy)}|${alpha.toFixed(2)}`;
    if (key === b.lastKey) return;
    b.lastKey = key;
    b.root.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -100%)`;
    b.root.style.opacity = alpha.toFixed(2);
  }

  private create(id: PeerId): Bubble {
    const root = el('div', { cls: 'tbubble', parent: this.root });
    root.style.opacity = '0';
    for (let i = 0; i < 3; i++) el('i', { parent: root });
    const b: Bubble = { root, lastKey: 'hidden' };
    this.bubbles.set(id, b);
    return b;
  }

  private hide(b: Bubble): void {
    if (b.lastKey !== 'hidden') { b.lastKey = 'hidden'; b.root.style.opacity = '0'; }
  }

  private remove(id: PeerId): void {
    const b = this.bubbles.get(id);
    if (b) { b.root.remove(); this.bubbles.delete(id); }
  }

  private clear(): void {
    for (const b of this.bubbles.values()) b.root.remove();
    this.bubbles.clear();
  }

  /** Bubbles currently showing (debug / smoke). */
  get visibleCount(): number { let n = 0; for (const b of this.bubbles.values()) if (b.lastKey !== 'hidden') n++; return n; }
  /** Peer ids whose bubble is showing (debug / smoke — B-11 checks *whose* bubble was hidden, not just how many). */
  get visibleIds(): PeerId[] {
    const out: PeerId[] = [];
    for (const [id, b] of this.bubbles) if (b.lastKey !== 'hidden') out.push(id);
    return out;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.clear(); this.root.remove(); }
}
