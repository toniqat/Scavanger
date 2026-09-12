import * as THREE from 'three';
import {
  DRONE_SCAN_LABEL_HEIGHT, DRONE_SCAN_LABEL_MAX_DIST, RARITY_COLORS, RARITY_LABEL_KO,
  type DroneScanResult, type GameContext,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';

interface Label {
  res: DroneScanResult;
  root: HTMLElement;
  rarity: HTMLElement;
  name: HTMLElement;
  lastKey: string;
}

const EMPTY: readonly DroneScanResult[] = [];
/** 새 결과 · 갱신된 결과가 한 번 튀는 연출 길이 — `styles/drone.css` 의 `dslPop` 과 같다. */
const POP_MS = 600;
/** 최대 거리의 이 비율부터 흐려진다. */
const FADE_FROM = 0.75;

const _cam = new THREE.Vector3();

/**
 * **드론 스캔 결과 월드 라벨** (2026-09-12). 데이터는 `ctx.drones.getScanResults()` 하나다 — 내 스캔과 분대원 스캔이
 * 같은 목록에 있고, 레이드 리셋(`game:newMission/abort` · `hub:entered` · `world:ready`)에 `gadgets/drones` 가 비운다.
 *
 *  - 대상 자리(살아 있는 벡터 — 전차 위 컨테이너 · 시체도 따라간다) + `DRONE_SCAN_LABEL_HEIGHT` 를 **`lateUpdate`** 에서
 *    투영한다 (CLAUDE.md: 화면 투영은 `HudSystem.lateUpdate`). 카메라 뒤 · 화면 밖 · `DRONE_SCAN_LABEL_MAX_DIST` 밖은 숨긴다.
 *  - 라벨 = 등급색 마름모 + `서사` (비었으면 회색 `비어 있음`) + 아래 작은 대상 이름. 가림 검사는 없다 (탈출 신호소 마커와 같다).
 *  - 목록 배열이 바뀔 때만 DOM 을 맞추고(`DroneSystem.scanList` 는 바뀔 때만 새 배열), 위치 · 투명도는 반올림 키가 바뀔 때만 쓴다.
 *
 * 루트는 게임플레이 레이어 **맨 아래**에 prepend 한다 — HUD 글자를 덮지 않는다. CSS 접두사 `.dsl-`.
 */
export class DroneScanLabels {
  readonly root: HTMLElement;
  private readonly labels = new Map<string, Label>();
  private lastList: readonly DroneScanResult[] = EMPTY;
  private readonly v = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'dsl-root' });
    parent.prepend(this.root);
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', () => this.clear()),
      b.on('game:abort', () => this.clear()),
      b.on('hub:entered', () => this.clear()),
    );
  }

  /** `HudSystem.lateUpdate` (카메라 행렬 갱신 뒤). */
  lateUpdate(ctx: GameContext): void {
    const list = ctx.drones?.getScanResults?.() ?? EMPTY;
    if (list !== this.lastList) this.sync(list);
    if (this.labels.size === 0) return;
    const cam = ctx.camera;
    _cam.setFromMatrixPosition(cam.matrixWorld);
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    const maxD = Math.max(1, DRONE_SCAN_LABEL_MAX_DIST);
    for (const l of this.labels.values()) {
      const p = l.res.position;
      this.v.set(p.x, p.y + DRONE_SCAN_LABEL_HEIGHT, p.z);
      const dist = this.v.distanceTo(_cam);
      if (dist > maxD) { this.hide(l); continue; }
      this.v.project(cam);
      if (this.v.z > 1 || this.v.z < -1) { this.hide(l); continue; }
      const sx = (this.v.x * 0.5 + 0.5) * w;
      const sy = (-this.v.y * 0.5 + 0.5) * h;
      if (sx < -80 || sx > w + 80 || sy < -40 || sy > h + 40) { this.hide(l); continue; }
      const fade = dist > maxD * FADE_FROM ? Math.max(0, 1 - (dist - maxD * FADE_FROM) / (maxD * (1 - FADE_FROM))) : 1;
      const key = `${Math.round(sx)}|${Math.round(sy)}|${fade.toFixed(2)}`;
      if (key === l.lastKey) continue;
      l.lastKey = key;
      l.root.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -100%)`;
      l.root.style.opacity = fade.toFixed(2);
    }
  }

  private sync(list: readonly DroneScanResult[]): void {
    this.lastList = list;
    const seen = new Set<string>();
    for (const r of list) {
      seen.add(r.id);
      const l = this.labels.get(r.id);
      if (!l) this.create(r);
      else if (l.res !== r) this.fill(l, r, true);
    }
    for (const [id, l] of this.labels) {
      if (seen.has(id)) continue;
      l.root.remove();
      this.labels.delete(id);
    }
  }

  private create(r: DroneScanResult): void {
    const root = el('div', { cls: 'dsl-label', parent: this.root });
    const rarity = el('span', { cls: 'r', parent: root });
    const name = el('span', { cls: 'n', parent: root });
    const l: Label = { res: r, root, rarity, name, lastKey: '' };
    root.style.opacity = '0';
    this.labels.set(r.id, l);
    this.fill(l, r, true);
  }

  private fill(l: Label, r: DroneScanResult, pop: boolean): void {
    l.res = r;
    l.root.dataset.target = r.id;
    l.root.dataset.rarity = r.rarity ?? 'empty';
    toggleClass(l.root, 'empty', r.rarity === null);
    toggleClass(l.root, 'remote', !r.local);
    l.root.style.setProperty('--rc', r.rarity ? RARITY_COLORS[r.rarity] : RARITY_COLORS.common);
    setText(l.rarity, r.rarity ? RARITY_LABEL_KO[r.rarity] : '비어 있음');
    setText(l.name, r.local ? r.name : `${r.name} · ${r.byName}`);
    l.lastKey = '';
    if (!pop) return;
    l.root.classList.remove('pop');
    void l.root.offsetWidth; // 애니메이션 재시작
    l.root.classList.add('pop');
    window.setTimeout(() => l.root.classList.remove('pop'), POP_MS);
  }

  private hide(l: Label): void {
    if (l.lastKey !== 'hidden') { l.lastKey = 'hidden'; l.root.style.opacity = '0'; }
  }

  private clear(): void {
    for (const l of this.labels.values()) l.root.remove();
    this.labels.clear();
    this.lastList = EMPTY;
  }

  /* ── debug / smoke ── */
  /** 떠 있는 라벨 수 (보이든 숨었든). */
  get count(): number { return this.labels.size; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.clear();
    this.root.remove();
  }
}
