import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import '../styles/named.css';

/** 동시에 추적하는 조준경 반짝임 수 — 네임드는 레이드당 한 명이라 여유분이다. */
const MAX_GLINTS = 3;
/** |NDC| 가 이보다 크면 화면 밖으로 본다 (`DangerIndicators` 와 같은 값). */
const EDGE_NDC = 0.94;
/** 남은 조준 시간이 전체의 이 비율 아래면 빠르게 깜빡인다. */
const GLINT_HOT_SHARE = 0.45;
/** 노출 칸 수 방어선 (계약 밖 값이 와도 DOM 이 폭주하지 않게). */
const MAX_PIPS = 12;

interface Glint { enemyId: number; pos: THREE.Vector3; mine: boolean; left: number; dur: number; active: boolean }
interface GlintView { head: HTMLElement; arc: HTMLElement; headKey: string; arcKey: string }

/**
 * **로든 스캔 · 저격 경고** (`.named-scan`, 게임플레이 레이어, 2026-09-11).
 *
 * 세 부분이다:
 *   - **노출 배너** (`.ns-banner`, 상단 중앙 — 재해 배너 블록 아래): `named:scanExposure {count, total}` 에서
 *     count > 0 이면 `스캔에 노출되고 있음` + 칸 `count / total`. 칸이 절반을 넘으면 `.warm`, `total − 1` 이상이면
 *     `.crit`(더 짙은 빨강 · 빠른 맥동 + 부제 `엄폐하라`). count 0 이면 사라진다. 수치(음파 횟수)는 이벤트가 싣고
 *     오므로 여기에는 없다.
 *   - **음파 훑기** (`.ns-sweep`): `named:scanPulse` 가 `exposedLocal` 일 때만, 화면 가장자리 붉은 비네트 +
 *     바깥으로 퍼지는 링이 한 번(짧게) 지나간다. 노출되지 않은 음파는 조용하다 — 경고의 뜻이 "지금 네가 찍혔다" 다.
 *   - **조준경 반짝임** (`named:sniperGlint`): `DangerIndicators` 와 같은 시각 문법 — 화면 안이면 적 자리에
 *     반짝임 마커(`.ns-head`), 밖이면 크로스헤어를 감싸는 붉은 방향 호(`.ns-arc`, 카메라 기준 상대 방위,
 *     0° = 정면 · 시계방향). 둘은 같이 뜨지 않는다. **표적이 나(`targetLocal`)면** 호 + 큰 마커 + 문구 `저격 조준!`,
 *     **표적이 내가 아니면 화면 안의 작은 반짝임만** 그린다(호 · 문구 없음) — 분대원이 노려지는 것도 보여야
 *     "저기 저격수" 를 부를 수 있지만, 내 화면 가장자리에 붉은 호가 뜨면 내가 노려지는 것으로 읽힌다.
 *     방위는 플레이어가 아니라 **카메라 위치**에서 잰다 — 드론 조종 중에도 호가 화면과 맞는다.
 *
 * 드론 조종 중에도 숨지 않는다 (PC 는 그대로 노출 · 저격된다). 메뉴 / 지도 / 사망 / 페이즈 밖이면 통째로 숨고,
 * `game:abort` · `game:newMission` · `hub:entered` · `player:died` 에서 비운다. DOM 은 풀링이고 key 가 바뀔 때만
 * 쓴다. 프레임당 할당 없음 (스크래치 벡터 재사용).
 */
export class NamedScanWarning {
  readonly root: HTMLElement;
  private sweep: HTMLElement;
  private banner: HTMLElement;
  private countEl: HTMLElement;
  private pipsEl: HTMLElement;
  private pips: HTMLElement[] = [];
  private aimEl: HTMLElement;
  private arcsRoot: HTMLElement;
  private views: GlintView[] = [];
  private glints: Glint[] = [];

  private count = 0;
  private total = 0;
  private drawnCount = -1;
  private drawnTotal = -1;
  private off = false;
  private aimShown = false;
  private readonly v = new THREE.Vector3();
  private readonly camF = new THREE.Vector3();
  private readonly camP = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'named-scan', parent });

    this.sweep = el('div', { cls: 'ns-sweep', parent: this.root });
    el('i', { cls: 'ring', parent: this.sweep });

    this.banner = el('div', { cls: 'ns-banner', parent: this.root });
    const row = el('div', { cls: 'row', parent: this.banner });
    el('i', { cls: 'ico', parent: row });
    el('span', { cls: 'ttl', text: '스캔에 노출되고 있음', parent: row });
    this.countEl = el('span', { cls: 'cnt ui-mono', text: '', parent: row });
    this.pipsEl = el('div', { cls: 'ns-pips', parent: this.banner });
    el('div', { cls: 'ns-sub', text: '엄폐하라', parent: this.banner });

    this.aimEl = el('div', { cls: 'ns-aim', text: '저격 조준!', parent: this.root });

    const glintRoot = el('div', { cls: 'ns-glints', parent: this.root });
    this.arcsRoot = el('div', { cls: 'ns-arcs', parent: glintRoot });
    for (let i = 0; i < MAX_GLINTS; i++) {
      const head = el('div', { cls: 'ns-head', parent: glintRoot });
      head.hidden = true;
      el('i', { cls: 'ring', parent: head });
      el('i', { cls: 'flare', parent: head });
      el('span', { cls: 'lbl', text: '저격', parent: head });
      const arc = el('div', { cls: 'ns-arc', parent: this.arcsRoot });
      arc.hidden = true;
      el('i', { cls: 'wedge', parent: arc });
      const tag = el('div', { cls: 'tag', parent: arc });
      el('span', { cls: 'ico', text: '✦', parent: tag });
      el('span', { cls: 'lbl', text: '저격', parent: tag });
      this.views.push({ head, arc, headKey: '', arcKey: '' });
      this.glints.push({ enemyId: -1, pos: new THREE.Vector3(), mine: false, left: 0, dur: 1, active: false });
    }
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('named:scanExposure', ({ count, total }) => this.setExposure(count, total)),
      b.on('named:scanPulse', ({ exposedLocal }) => { if (exposedLocal && !this.off) this.sweepOnce(); }),
      b.on('named:sniperGlint', ({ enemyId, position, targetLocal, duration }) => this.addGlint(enemyId, position, targetLocal, duration)),
      b.on('player:died', () => this.reset()),
      b.on('game:abort', () => this.reset()),
      b.on('game:newMission', () => this.reset()),
      b.on('hub:entered', () => this.reset()),
    );
  }

  /* ── 노출 배너 ──────────────────────────────────────────────────────────── */

  private setExposure(count: number, total: number): void {
    const t = Math.max(1, Math.min(MAX_PIPS, Math.round(total) || 1));
    const c = Math.max(0, Math.min(t, Math.round(count) || 0));
    const rose = c > this.count;
    this.count = c;
    this.total = t;
    this.drawBanner();
    if (rose && c > 0) {
      toggleClass(this.pipsEl, 'bump', false);
      void this.pipsEl.offsetWidth;   // 애니메이션 재시작
      toggleClass(this.pipsEl, 'bump', true);
    }
  }

  private drawBanner(): void {
    const on = this.count > 0;
    toggleClass(this.banner, 'show', on);
    if (!on) return;
    if (this.total !== this.drawnTotal) {
      this.drawnTotal = this.total;
      this.drawnCount = -1;
      this.pipsEl.replaceChildren();
      this.pips = [];
      for (let i = 0; i < this.total; i++) this.pips.push(el('i', { parent: this.pipsEl }));
    }
    if (this.count === this.drawnCount) return;
    this.drawnCount = this.count;
    for (let i = 0; i < this.pips.length; i++) toggleClass(this.pips[i], 'on', i < this.count);
    setText(this.countEl, `${this.count} / ${this.total}`);
    const crit = this.count >= this.total || (this.total >= 2 && this.count >= this.total - 1);
    toggleClass(this.banner, 'warm', !crit && this.count * 2 >= this.total);
    toggleClass(this.banner, 'crit', crit);
  }

  private sweepOnce(): void {
    toggleClass(this.sweep, 'go', false);
    void this.sweep.offsetWidth;   // 같은 애니메이션을 처음부터 다시
    toggleClass(this.sweep, 'go', true);
  }

  /* ── 조준경 반짝임 ──────────────────────────────────────────────────────── */

  private addGlint(enemyId: number, position: THREE.Vector3, mine: boolean, duration: number): void {
    let slot: Glint | null = null;
    for (const g of this.glints) if (g.active && g.enemyId === enemyId) { slot = g; break; }
    if (!slot) for (const g of this.glints) if (!g.active) { slot = g; break; }
    if (!slot) { slot = this.glints[0]; for (const g of this.glints) if (g.left < slot.left) slot = g; }
    slot.enemyId = enemyId;
    slot.pos.copy(position);
    slot.mine = mine;
    slot.dur = Math.max(0.1, duration);
    slot.left = slot.dur;
    slot.active = true;
  }

  private reset(): void {
    this.count = 0;
    this.drawBanner();
    toggleClass(this.sweep, 'go', false);
    toggleClass(this.pipsEl, 'bump', false);
    for (const g of this.glints) g.active = false;
    this.hideGlints();
  }

  private hideGlints(): void {
    for (const v of this.views) {
      if (!v.head.hidden) { v.head.hidden = true; v.headKey = ''; }
      if (!v.arc.hidden) { v.arc.hidden = true; v.arcKey = ''; }
    }
    if (this.aimShown) { this.aimShown = false; toggleClass(this.aimEl, 'show', false); }
  }

  update(dt: number, ctx: GameContext): void {
    for (const g of this.glints) {
      if (!g.active) continue;
      g.left -= dt;
      if (g.left <= 0) g.active = false;
    }
    const p = ctx.player;
    const active = ctx.isGameplayPhase() && !!p && !p.isDead
      && !ctx.uiBlockers.has('menu') && !ctx.uiBlockers.has('map');
    if (active === this.off) { this.off = !active; toggleClass(this.root, 'off', this.off); }
    if (!active) { this.hideGlints(); return; }

    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    if (w <= 0 || h <= 0) return;
    const cam = ctx.camera;
    cam.getWorldDirection(this.camF);
    cam.getWorldPosition(this.camP);
    const camYaw = Math.atan2(this.camF.x, -this.camF.z);
    let aim = false;

    for (let i = 0; i < this.glints.length; i++) {
      const g = this.glints[i];
      const view = this.views[i];
      let showHead = false, showArc = false;
      if (g.active) {
        const hot = g.left < g.dur * GLINT_HOT_SHARE;
        if (g.mine) aim = true;
        this.v.copy(g.pos).project(cam);
        const behind = this.v.z > 1 || this.v.z < -1;
        const offScreen = behind || Math.abs(this.v.x) > EDGE_NDC || Math.abs(this.v.y) > EDGE_NDC;
        if (!offScreen) {
          showHead = true;
          const px = Math.round((this.v.x * 0.5 + 0.5) * w);
          const py = Math.round((-this.v.y * 0.5 + 0.5) * h);
          const key = `${px}|${py}|${g.mine ? 1 : 0}|${hot ? 1 : 0}`;
          if (view.head.hidden) view.head.hidden = false;
          if (key !== view.headKey) {
            view.headKey = key;
            view.head.style.transform = `translate(${px}px, ${py}px)`;
            toggleClass(view.head, 'mine', g.mine);
            toggleClass(view.head, 'hot', hot);
          }
        } else if (g.mine) {
          showArc = true;
          const toYaw = Math.atan2(g.pos.x - this.camP.x, -(g.pos.z - this.camP.z));
          const d = toYaw - camYaw;
          const deg = Math.round((Math.atan2(Math.sin(d), Math.cos(d)) * 180) / Math.PI);
          const key = `${deg}|${hot ? 1 : 0}`;
          if (view.arc.hidden) view.arc.hidden = false;
          if (key !== view.arcKey) {
            view.arcKey = key;
            view.arc.style.setProperty('--rot', `${deg}deg`);
            toggleClass(view.arc, 'hot', hot);
          }
        }
      }
      if (!showHead && !view.head.hidden) { view.head.hidden = true; view.headKey = ''; }
      if (!showArc && !view.arc.hidden) { view.arc.hidden = true; view.arcKey = ''; }
    }
    if (aim !== this.aimShown) { this.aimShown = aim; toggleClass(this.aimEl, 'show', aim); }
  }

  /** 노출 칸 수 (0 = 배너 없음) · 배너가 떠 있나 · 살아 있는 반짝임 수 · `저격 조준!` 문구 (debug / smoke). */
  get exposureCount(): number { return this.count; }
  get isBannerOn(): boolean { return this.banner.classList.contains('show'); }
  get glintCount(): number { let n = 0; for (const g of this.glints) if (g.active) n++; return n; }
  get isAimWarningOn(): boolean { return this.aimShown; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
  }
}
