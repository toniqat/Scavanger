import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';

interface Marker {
  el: HTMLElement;
  dist: HTMLElement;
  pos: THREE.Vector3;
  lastKey: string;
}

/**
 * Projects extraction pads to screen-space diamond markers.
 *
 * **2026-09-09 — 발견 게이트.** A pad you have not walked near yet does not exist for the HUD: the marker is built
 * at `world:ready` as before but stays hidden until `ctx.world.fog.isDiscovered(position)` is true (the fog reveals
 * on the whole squad's positions, so a squadmate finding it counts). The **active** pad is exempt — once the
 * countdown runs everybody knows where to go. No fog (훈련장 / an older world) → everything shows as before.
 *
 * **2026-09-14 (튜토리얼)** — 이것이 계약이 말하는 「월드(3D) 마커」다 (`hides('hud','shipMarker')`). 튜토리얼
 * 레이드에서는 마지막 `extract` 단계 전까지 탈출 함선 마름모를 **아예 그리지 않는다**; 그 단계에 들어서면
 * 게이트가 풀려 평소처럼 나타난다. 화면 고정 표시(나침반)는 별개 이름(`shipScreenMarker`)이라 레이드 내내 없다.
 * 튜토리얼이 아니면 질의가 언제나 false 라 평소 화면은 한 글자도 바뀌지 않는다.
 *
 * **2026-09-17 (사용자 결정 — 「함선 입구 위 허공의 초록 반투명 구 제거」)** — 착륙한 함선의 월드 마커(`탈출 함선`,
 * `.wmarker.ship` 초록 원)를 **모든 레이드에서** 그리지 않는다. 함선 위치 + 2.2 m 에 투영되어 램프 입구 바로 위에
 * 떠 있었고, 가까이 가면 알파가 0.15 까지만 줄어 반투명 구슬 + 흐린 「탈출 함선」 글씨로 보였다. 함선은 그 자체로
 * 거대한 표지이고, 지도(`ui/map/MapScreen`) · 나침반(`Compass`) 의 함선 마커는 그대로다. 함선이 내려앉으면 활성 패드
 * 마름모도 계속 숨긴다 — 패드 중심이 곧 램프 입구라 같은 자리에 다시 떠오르기 때문이다.
 */
export class WorldMarkers {
  readonly root: HTMLElement;
  private markers = new Map<string, Marker>();
  private activeId: string | null = null;
  /** 함선이 착륙해 있다 — 활성 패드 마름모를 숨기는 데만 쓴다 (함선 마커 자체는 그리지 않는다). */
  private shipLanded = false;
  private v = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'world-markers', parent });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('world:ready', () => {
        this.clear();
        if (ctx.missionMode === 'training' || ctx.world?.mode === 'training') return; // Phase 7: no extraction in the arena
        for (const p of ctx.world?.getExtractionPoints() ?? []) this.add(p.id, p.position, '탈출 지점', 'wmarker');
      }),
      b.on('extraction:activated', ({ pointId }) => {
        this.activeId = pointId;
        for (const [id, m] of this.markers) toggleClass(m.el, 'active', id === pointId);
      }),
      b.on('extraction:shipLanded', () => { this.shipLanded = true; }),
      // 2026-09-13: the ship left without us — back to plain (fog-gated) pad markers
      b.on('extraction:reset', () => {
        this.activeId = null;
        this.shipLanded = false;
        for (const m of this.markers.values()) toggleClass(m.el, 'active', false);
      }),
      b.on('game:abort', () => this.clear()),
    );
  }

  private add(id: string, pos: THREE.Vector3, label: string, cls: string): void {
    this.remove(id);
    const m = el('div', { cls, parent: this.root });
    el('i', { cls: 'ico', parent: m });
    el('span', { cls: 'lbl', text: label, parent: m });
    const dist = el('span', { cls: 'dist', text: '', parent: m });
    this.markers.set(id, { el: m, dist, pos, lastKey: '' });
  }
  private remove(id: string): void {
    const m = this.markers.get(id);
    if (m) { m.el.remove(); this.markers.delete(id); }
  }
  private clear(): void {
    for (const m of this.markers.values()) m.el.remove();
    this.markers.clear();
    this.activeId = null; this.shipLanded = false;
  }

  lateUpdate(ctx: GameContext): void {
    const cam = ctx.camera;
    const player = ctx.player;
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    const fog = ctx.world?.fog ?? null;
    for (const [id, m] of this.markers) {
      // The ship stands on the active pad: its diamond would float right over the ramp — hide it once landed.
      if (this.shipLanded && id === this.activeId) { this.hide(m); continue; }
      // 발견 게이트 (2026-09-09): 아직 못 본 신호소는 아예 뜨지 않는다 (활성 신호소는 예외)
      if (fog && id !== this.activeId && !fog.isDiscovered(m.pos)) { this.hide(m); continue; }
      this.v.copy(m.pos); this.v.y += 2.2;
      this.v.project(cam);
      const behind = this.v.z > 1 || this.v.z < -1;
      if (behind) { this.hide(m); continue; }
      const sx = (this.v.x * 0.5 + 0.5) * w;
      const sy = (-this.v.y * 0.5 + 0.5) * h;
      if (sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) { this.hide(m); continue; }
      const dist = player ? Math.hypot(m.pos.x - player.position.x, m.pos.z - player.position.z) : 0;
      let alpha = 1;
      if (dist < 12) alpha = Math.max(0.15, (dist - 4) / 8);
      if (dist > 400) alpha *= 0.6;
      const key = `${Math.round(sx)}|${Math.round(sy)}|${Math.round(dist)}|${alpha.toFixed(2)}`;
      if (key === m.lastKey) continue;
      m.lastKey = key;
      m.el.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -50%)`;
      m.el.style.opacity = alpha.toFixed(2);
      setText(m.dist, `${Math.round(dist)}m`);
    }
  }

  private hide(m: Marker): void {
    if (m.lastKey !== 'hidden') { m.lastKey = 'hidden'; m.el.style.opacity = '0'; }
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
