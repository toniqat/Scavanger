import type { DroneKind, DroneRef, DroneReleaseReason, GameContext } from '@/shared';
import {
  DRONE_AIR_MAX_ALTITUDE, DRONE_AIR_RANGE, DRONE_GROUND_RANGE, DRONE_LINK_WARN_RATIO,
  Keys, keyLabel, onKeybindsChanged,
} from '@/shared';
import { el, setText, toggleClass, clamp01 } from '../dom';
import '../styles/drone.css';

/** 드론 종류 표시 이름 (프레임 좌측 상단 태그). */
const KIND_NAME: Record<DroneKind, string> = { ground: '지상 드론', air: '공중 드론' };

/** 조종 전환 홀드 링 — `hud/HoldGauge` 와 같은 모양, 반지름만 바깥(60 vs 48)이라 두 링이 겹치지 않는다. */
const RING_SIZE = 144;
const RING_R = 60;

/** 외곽 노이즈 캔버스 해상도 (CSS 가 `pixelated` 로 화면 전체에 늘린다) 와 갱신 주기. */
const NOISE_W = 160;
const NOISE_H = 90;
const NOISE_INTERVAL_S = 1 / 18;

/** 연결 해제 알림이 떠 있는 시간 — `styles/drone.css` 의 `drAlert` 1.5s 와 같다. */
const ALERT_S = 1.5;
/** 전체 화면 노이즈 번쩍: 사거리 이탈로 끊겼을 때 / 드론 시점으로 막 들어갔을 때. */
const BURST_RANGE_S = 0.7;
const BURST_BOOT_S = 0.35;
const BURST_BOOT_PEAK = 0.7;
/** 피격 번쩍 (프레임 브래킷 붉게). */
const HIT_FLASH_S = 0.22;
/** 체력 바가 붉어지는 비율. */
const HP_LOW_RATIO = 0.35;
/** 고도 게이지가 "최고 고도" 로 읽히는 여유(m). */
const ALT_TOP_EPS = 0.25;

const ALERT_TEXT: Partial<Record<DroneReleaseReason, string>> = {
  range: '신호 끊김',
  destroyed: '드론 파괴됨',
  damage: '피격 — 연결 해제',
};

type KeyId = 'JUMP' | 'CROUCH' | 'SPRINT' | 'RELOAD';
interface KeyRow { cap: HTMLElement; key: KeyId }

/**
 * **드론 조종 HUD** (2026-09-11). 데이터는 `ctx.drones`(`controlled` · `controlHold` · `DroneRef`)와 `drone:*` 이벤트뿐이다.
 *
 *  - **드론 시점 모드**: `ctx.drones.controlled` 가 있으면 게임플레이 HUD 루트(`this.root.parentElement`)에
 *    `drone-view` 를 켠다 — CSS 가 무기 패널(+ 퀵 스트립) · 임플란트 · 함선 호출 · 스태미나 · 총 크로스헤어 ·
 *    크로스헤어 게이지들을 숨기고 체력은 작게 남긴다. 이 위젯은 가운데 뷰파인더 브래킷 · `● DRONE 공중 드론` 태그 ·
 *    드론 체력 바 · 작은 조준점을 그린다.
 *  - **하단 사거리 게이지**: 스태미나 자리 · 같은 문법. 채움 = `linkRatio`(멀어질수록 꽉 찬다). `DRONE_LINK_WARN_RATIO`
 *    이상이면 붉게 깜빡이며 `신호 약함`, 1 이상(`linkLost`)이면 `신호 끊김`. 아래 줄에 `현재 / 최대 m`.
 *  - **화면 외곽 지지직**: 경고 비율 → 1 에서 강도 0 → 1. 절차 캔버스 노이즈(160×90, 18 Hz, 켜져 있을 때만 그린다)를
 *    외곽 마스크로 깎고 스캔라인 · 색수차 · 찢어지는 띠를 CSS 로 얹는다. 게임플레이 레이어 **맨 아래**에 prepend 해
 *    HUD 글자를 덮지 않는다.
 *  - **공중 드론**: 크로스헤어 좌측 `고도 12 m` (= 드론 y − `world.getSurfaceY(x, z, y)`) + 최대 고도 대비 세로 게이지,
 *    우측 `Space 상승` / `C 하강`. **지상 드론**: 우측 `Space 점프` / `Shift 질주` + 질주 중 `소음` 배지
 *    (멈춘 뒤에도 `aggroable` 이면 흐리게 남는다).
 *  - **공통**: 우측 맨 아래 `R`(꾹) `복귀`, 드론 피격(`drone:damaged` own) 시 체력 바 · 브래킷 번쩍.
 *  - **조종 전환 홀드 링**: `controlHold > 0` 이면 조종 전이든 조종 중이든 크로스헤어 둘레에 뜬다(라벨 `드론 조종` / `복귀`).
 *  - **끊김 알림**: `drone:controlChanged {id: null}` 의 `reason` — `range` = 전체 노이즈 번쩍 + `신호 끊김`,
 *    `destroyed` = `드론 파괴됨`, `damage` = `피격 — 연결 해제`, `manual` · `reset` = 조용히. 1.5 초.
 *
 * 키 가이드(`ui:keyGuide`)에는 올리지 않는다: 가이드는 `Tab · Esc 닫기` 를 스스로 붙이는데 드론 시점은 그 키로
 * 닫히지 않는다(`hud/CommsWheel` 과 같은 이유). 조작 안내는 크로스헤어 우측 열이 맡는다.
 * 키 라벨은 사용 시점에 `keyLabel(Keys.X)` 로 읽고 `input:bindingsChanged` · `onKeybindsChanged` 에 다시 쓴다.
 * DOM 쓰기는 값이 바뀔 때만 한다(키 문자열 비교).
 */
export class DroneHud {
  readonly root: HTMLElement;
  private parent: HTMLElement;

  /* 조종 중 층 */
  private view: HTMLElement;
  private kindEl: HTMLElement;
  private hpRoot: HTMLElement;
  private hpFill: HTMLElement;
  private altRoot: HTMLElement;
  private altVal: HTMLElement;
  private altFill: HTMLElement;
  private noiseBadge: HTMLElement;
  private keyRows: KeyRow[] = [];
  private linkRoot: HTMLElement;
  private linkFill: HTMLElement;
  private linkState: HTMLElement;
  private linkDist: HTMLElement;

  /* 홀드 링 */
  private ring: HTMLElement;
  private ringFill: SVGCircleElement;
  private ringLbl: HTMLElement;
  private circumference: number;
  private lastRingT = -1;
  private lastRingLbl = '';

  /* 알림 */
  private alertEl: HTMLElement;
  private alertT = 0;

  /* 외곽 노이즈 */
  private staticRoot: HTMLElement;
  private g2d: CanvasRenderingContext2D | null = null;
  private img: ImageData | null = null;
  private seed = 0x9e3779b9 | 0;
  private noiseClock = 0;
  private burstT = 0;
  private burstDur = 0;
  private burstPeak = 1;
  private lastSi = -1;
  private lastBurst = false;

  /* 상태 */
  private controlledId = '';
  private controlledKind: DroneKind | null = null;
  private hitT = 0;
  private lastLinkKey = '';
  private lastHpKey = '';
  private lastAltKey = '';
  private lastNoiseKey = '';
  private edgeT = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.parent = parent;
    this.root = el('div', { cls: 'drone-hud', parent });

    // ── 외곽 노이즈: 게임플레이 레이어 맨 아래 (다른 위젯의 글자 밑) ──
    this.staticRoot = el('div', { cls: 'dr-static' });
    parent.prepend(this.staticRoot);
    const canvas = el('canvas', { parent: this.staticRoot });
    canvas.width = NOISE_W;
    canvas.height = NOISE_H;
    try {
      this.g2d = canvas.getContext('2d');
      this.img = this.g2d ? this.g2d.createImageData(NOISE_W, NOISE_H) : null;
    } catch { this.g2d = null; this.img = null; }
    el('div', { cls: 'dr-scan', parent: this.staticRoot });
    el('div', { cls: 'dr-fringe', parent: this.staticRoot });
    el('div', { cls: 'dr-tear', parent: this.staticRoot });

    // ── 조종 중 층 ──
    this.view = el('div', { cls: 'dr-view', parent: this.root });
    const frame = el('div', { cls: 'dr-frame', parent: this.view });
    for (let i = 0; i < 4; i++) el('i', { parent: frame });

    const tag = el('div', { cls: 'dr-tag', parent: this.view });
    el('span', { cls: 'rec', parent: tag });
    el('span', { cls: 'lbl', text: 'DRONE', parent: tag });
    this.kindEl = el('span', { cls: 'kind', text: '', parent: tag });

    this.hpRoot = el('div', { cls: 'dr-hp', parent: this.view });
    el('span', { cls: 'ui-label', text: '기체', parent: this.hpRoot });
    const hpBar = el('div', { cls: 'bar', parent: this.hpRoot });
    this.hpFill = el('div', { cls: 'fill', parent: hpBar });

    const aim = el('div', { cls: 'dr-aim', parent: this.view });
    el('i', { parent: aim });
    el('i', { parent: aim });

    // 크로스헤어 좌측: 고도 (공중 드론)
    this.altRoot = el('div', { cls: 'dr-alt', parent: this.view });
    const altTxt = el('div', { cls: 'txt', parent: this.altRoot });
    el('span', { cls: 'ui-label', text: '고도', parent: altTxt });
    const altLine = el('div', { parent: altTxt });
    this.altVal = el('span', { cls: 'val', text: '0', parent: altLine });
    el('span', { cls: 'unit', text: 'm', parent: altLine });
    const ladder = el('div', { cls: 'ladder', parent: this.altRoot });
    this.altFill = el('i', { parent: ladder });
    this.altFill.style.transform = 'scaleY(0)';

    // 크로스헤어 우측: 조작 안내
    const keys = el('div', { cls: 'dr-keys', parent: this.view });
    this.keyRow(keys, 'air', 'JUMP', '상승');
    this.keyRow(keys, 'air', 'CROUCH', '하강');
    this.keyRow(keys, 'ground', 'JUMP', '점프');
    const sprintRow = this.keyRow(keys, 'ground', 'SPRINT', '질주');
    this.noiseBadge = el('span', { cls: 'dr-noise', text: '소음', parent: sprintRow });
    this.keyRow(keys, 'back', 'RELOAD', '복귀', true);

    // 하단 사거리 게이지 (스태미나 자리)
    this.linkRoot = el('div', { cls: 'dr-link', parent: this.view });
    this.linkState = el('div', { cls: 'state', text: '', parent: this.linkRoot });
    const linkBar = el('div', { cls: 'bar', parent: this.linkRoot });
    this.linkFill = el('div', { cls: 'fill', parent: linkBar });
    this.linkFill.style.transform = 'scaleX(0)';
    const mark = el('div', { cls: 'mark', parent: linkBar });
    mark.style.left = `${(clamp01(DRONE_LINK_WARN_RATIO) * 100).toFixed(2)}%`;
    const linkRow = el('div', { cls: 'row', parent: this.linkRoot });
    el('span', { cls: 'ui-label', text: '신호 거리', parent: linkRow });
    this.linkDist = el('span', { cls: 'dist ui-mono', text: '', parent: linkRow });

    // ── 조종 전환 홀드 링 (조종 전에도 뜬다) ──
    this.ring = el('div', { cls: 'dr-ring', parent: this.root });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${RING_SIZE} ${RING_SIZE}`);
    const mk = (cls: string): SVGCircleElement => {
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('cx', String(RING_SIZE / 2)); c.setAttribute('cy', String(RING_SIZE / 2)); c.setAttribute('r', String(RING_R));
      svg.appendChild(c);
      return c;
    };
    mk('track');
    this.ringFill = mk('fill');
    this.circumference = 2 * Math.PI * RING_R;
    this.ringFill.style.strokeDasharray = `0 ${this.circumference.toFixed(2)}`;
    this.ring.appendChild(svg);
    this.ringLbl = el('div', { cls: 'lbl', text: '', parent: this.ring });

    // ── 연결 해제 알림 ──
    this.alertEl = el('div', { cls: 'dr-alert', text: '', parent: this.root });
  }

  /** 조작 안내 한 줄: 키캡(실제 바인딩) + 한국어 동작. `group` 은 종류별 표시(`air` / `ground`) 또는 `back`. */
  private keyRow(parent: HTMLElement, group: 'air' | 'ground' | 'back', key: KeyId, label: string, hold = false): HTMLElement {
    const row = el('div', { cls: `dr-key ${group}`, parent });
    const cap = el('kbd', { cls: hold ? 'keycap kc-hold' : 'keycap', text: keyLabel(Keys[key]), parent: row });
    el('span', { text: label, parent: row });
    this.keyRows.push({ cap, key });
    return row;
  }

  private refreshKeys(): void {
    for (const r of this.keyRows) setText(r.cap, keyLabel(Keys[r.key]));
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('drone:controlChanged', ({ id, reason }) => {
        if (id) { this.setControlled(ctx.drones?.controlled ?? null); return; }
        this.setControlled(null);
        this.showAlert(reason);
      }),
      b.on('drone:damaged', ({ id, own }) => {
        if (own && id === this.controlledId) this.flashHit();
      }),
      b.on('input:bindingsChanged', () => this.refreshKeys()),
      onKeybindsChanged(() => this.refreshKeys()),
      b.on('game:newMission', () => this.reset()),
      b.on('game:abort', () => this.reset()),
    );
    this.refreshKeys();
  }

  update(dt: number, ctx: GameContext): void {
    const drones = ctx.drones;
    const d = drones?.controlled ?? null;
    this.setControlled(d);
    this.updateRing(drones?.controlHold ?? 0, d !== null);

    if (d) {
      this.updateLink(d);
      this.updateHp(d);
      if (d.kind === 'air') this.updateAltitude(d, ctx);
      else this.updateNoise(d);
    } else {
      this.edgeT = 0;
    }

    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) toggleClass(this.view, 'hit', false);
    }
    if (this.alertT > 0) {
      this.alertT -= dt;
      if (this.alertT <= 0) toggleClass(this.alertEl, 'show', false);
    }
    this.updateStatic(dt);
  }

  /** 조종 대상이 바뀌었을 때만 레이어 클래스 · 종류 이름을 다시 쓴다 (폴링과 이벤트가 같은 길로 온다). */
  private setControlled(d: DroneRef | null): void {
    const id = d?.id ?? '';
    const kind = d?.kind ?? null;
    if (id === this.controlledId && kind === this.controlledKind) return;
    const entering = this.controlledId === '' && id !== '';
    this.controlledId = id;
    this.controlledKind = kind;
    toggleClass(this.parent, 'drone-view', d !== null);
    toggleClass(this.view, 'show', d !== null);
    toggleClass(this.view, 'is-air', kind === 'air');
    toggleClass(this.view, 'is-ground', kind === 'ground');
    setText(this.kindEl, kind ? KIND_NAME[kind] : '');
    this.lastLinkKey = this.lastHpKey = this.lastAltKey = this.lastNoiseKey = '';
    if (!d) { this.edgeT = 0; toggleClass(this.view, 'hit', false); this.hitT = 0; }
    // 시점 전환의 한 박자: 드론 카메라로 들어가는 순간 짧은 전체 노이즈
    if (entering) this.burst(BURST_BOOT_S, BURST_BOOT_PEAK);
  }

  /* ── 사거리 게이지 ─────────────────────────────────────────────────────── */

  private updateLink(d: DroneRef): void {
    const ratio = Math.max(0, Number.isFinite(d.linkRatio) ? d.linkRatio : 0);
    const fill = Math.min(1, ratio);
    const lost = d.linkLost || ratio >= 1;
    const warn = lost || ratio >= DRONE_LINK_WARN_RATIO;
    const range = d.kind === 'air' ? DRONE_AIR_RANGE : DRONE_GROUND_RANGE;
    const distText = range > 0
      ? `${Math.round(ratio * range)} / ${Math.round(range)} m`
      : `${Math.round(ratio * 100)}%`;
    // 외곽 지지직 강도: 경고 비율 → 1 에서 0 → 1
    const span = Math.max(1e-3, 1 - DRONE_LINK_WARN_RATIO);
    this.edgeT = clamp01((ratio - DRONE_LINK_WARN_RATIO) / span);

    const key = `${fill.toFixed(3)}|${warn ? 1 : 0}|${lost ? 1 : 0}|${distText}`;
    if (key === this.lastLinkKey) return;
    this.lastLinkKey = key;
    this.linkFill.style.transform = `scaleX(${fill.toFixed(3)})`;
    toggleClass(this.linkRoot, 'warn', warn);
    toggleClass(this.linkRoot, 'lost', lost);
    setText(this.linkState, lost ? '신호 끊김' : warn ? '신호 약함' : '');
    setText(this.linkDist, distText);
  }

  /* ── 드론 체력 ─────────────────────────────────────────────────────────── */

  private updateHp(d: DroneRef): void {
    const r = d.maxHp > 0 ? clamp01(d.hp / d.maxHp) : 0;
    const key = r.toFixed(3);
    if (key === this.lastHpKey) return;
    this.lastHpKey = key;
    this.hpFill.style.transform = `scaleX(${key})`;
    toggleClass(this.hpRoot, 'low', r < HP_LOW_RATIO);
  }

  private flashHit(): void {
    this.hpRoot.classList.remove('hit');
    void this.hpRoot.offsetWidth; // 애니메이션 재시작
    this.hpRoot.classList.add('hit');
    toggleClass(this.view, 'hit', true);
    this.hitT = HIT_FLASH_S;
  }

  /* ── 공중 드론: 고도 ───────────────────────────────────────────────────── */

  private updateAltitude(d: DroneRef, ctx: GameContext): void {
    const p = d.position;
    const world = ctx.world;
    let text = '—';
    let fill = 0;
    let atMax = false;
    if (world) {
      const surface = world.getSurfaceY(p.x, p.z, p.y);
      const alt = Number.isFinite(surface) ? Math.max(0, p.y - surface) : 0;
      text = alt < 10 ? alt.toFixed(1) : String(Math.round(alt));
      if (DRONE_AIR_MAX_ALTITUDE > 0) {
        fill = clamp01(alt / DRONE_AIR_MAX_ALTITUDE);
        atMax = alt >= DRONE_AIR_MAX_ALTITUDE - ALT_TOP_EPS;
      }
    }
    const key = `${text}|${fill.toFixed(2)}|${atMax ? 1 : 0}`;
    if (key === this.lastAltKey) return;
    this.lastAltKey = key;
    setText(this.altVal, text);
    this.altFill.style.transform = `scaleY(${fill.toFixed(2)})`;
    toggleClass(this.altRoot, 'at-max', atMax);
  }

  /* ── 지상 드론: 소음 배지 ──────────────────────────────────────────────── */

  private updateNoise(d: DroneRef): void {
    const on = d.sprinting;
    const linger = !on && d.aggroable;
    const key = `${on ? 1 : 0}|${linger ? 1 : 0}`;
    if (key === this.lastNoiseKey) return;
    this.lastNoiseKey = key;
    toggleClass(this.noiseBadge, 'on', on);
    toggleClass(this.noiseBadge, 'linger', linger);
  }

  /* ── 조종 전환 홀드 링 ─────────────────────────────────────────────────── */

  private updateRing(hold: number, controlled: boolean): void {
    const t = clamp01(Number.isFinite(hold) ? hold : 0);
    const show = t > 0.001;
    toggleClass(this.ring, 'show', show);
    const lbl = show ? (controlled ? '복귀' : '드론 조종') : this.lastRingLbl;
    if (lbl !== this.lastRingLbl) { this.lastRingLbl = lbl; setText(this.ringLbl, lbl); }
    const v = show ? t : 0;
    if (Math.abs(v - this.lastRingT) < 0.003) return;
    this.lastRingT = v;
    this.ringFill.style.strokeDasharray = `${(v * this.circumference).toFixed(2)} ${this.circumference.toFixed(2)}`;
  }

  /* ── 연결 해제 알림 ────────────────────────────────────────────────────── */

  private showAlert(reason: DroneReleaseReason | null): void {
    const text = reason ? ALERT_TEXT[reason] : undefined;
    if (!text) return; // manual · reset = 조용히
    setText(this.alertEl, text);
    this.alertEl.classList.remove('show');
    void this.alertEl.offsetWidth; // 애니메이션 재시작
    this.alertEl.classList.add('show');
    this.alertT = ALERT_S;
    if (reason === 'range') this.burst(BURST_RANGE_S, 1);
  }

  /* ── 외곽 노이즈 ───────────────────────────────────────────────────────── */

  private burst(duration: number, peak: number): void {
    this.burstDur = duration;
    this.burstT = duration;
    this.burstPeak = peak;
    this.noiseClock = 0; // 첫 프레임에 바로 그린다
  }

  private updateStatic(dt: number): void {
    let burstI = 0;
    if (this.burstT > 0) {
      this.burstT -= dt;
      burstI = this.burstT > 0 ? this.burstPeak * (this.burstT / Math.max(1e-3, this.burstDur)) : 0;
    }
    const bursting = burstI > this.edgeT;
    const si = Math.max(this.edgeT, burstI);
    const q = Math.round(si * 50) / 50; // 0.02 단위로만 다시 쓴다
    if (q !== this.lastSi) {
      this.lastSi = q;
      this.staticRoot.style.setProperty('--si', q.toFixed(2));
      toggleClass(this.staticRoot, 'on', q > 0);
    }
    if (bursting !== this.lastBurst) {
      this.lastBurst = bursting;
      toggleClass(this.staticRoot, 'burst', bursting);
    }
    if (q <= 0) return;
    this.noiseClock -= dt;
    if (this.noiseClock > 0) return;
    this.noiseClock = NOISE_INTERVAL_S;
    this.drawNoise();
  }

  /** 흑백 눈 노이즈 + 가끔 밝은 가로 줄. xorshift32 — `Math.random` 보다 싸고 할당이 없다. */
  private drawNoise(): void {
    const g = this.g2d;
    const img = this.img;
    if (!g || !img) return;
    const data = img.data;
    let s = this.seed;
    let i = 0;
    for (let y = 0; y < NOISE_H; y++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      const streak = ((s >>> 11) & 31) === 0;
      for (let x = 0; x < NOISE_W; x++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        const v = s & 255;
        const a = (s >>> 8) & 255;
        const c = streak ? 200 + (v >> 3) : v;
        data[i] = c; data[i + 1] = c; data[i + 2] = c;
        data[i + 3] = streak ? 230 : (a > 120 ? 255 : 0);
        i += 4;
      }
    }
    this.seed = s;
    g.putImageData(img, 0, 0);
  }

  private reset(): void {
    this.setControlled(null);
    this.alertT = 0;
    toggleClass(this.alertEl, 'show', false);
    this.burstT = 0;
    this.edgeT = 0;
    this.updateRing(0, false);
    this.updateStatic(0);
  }

  /* ── debug / smoke ─────────────────────────────────────────────────────── */

  /** 드론 시점 모드인가. */
  get isDroneView(): boolean { return this.controlledId !== ''; }
  /** 사거리 게이지 상태: 'off' | 'ok' | 'warn' | 'lost'. */
  get linkStatus(): 'off' | 'ok' | 'warn' | 'lost' {
    if (!this.isDroneView) return 'off';
    if (this.linkRoot.classList.contains('lost')) return 'lost';
    return this.linkRoot.classList.contains('warn') ? 'warn' : 'ok';
  }
  /** 외곽 노이즈 강도 0..1 (마지막으로 쓴 값). */
  get staticIntensity(): number { return Math.max(0, this.lastSi); }
  /** 떠 있는 알림 문구, 없으면 ''. */
  get alertText(): string { return this.alertEl.classList.contains('show') ? (this.alertEl.textContent ?? '') : ''; }
  /** 홀드 링이 보이는가. */
  get isHoldShowing(): boolean { return this.ring.classList.contains('show'); }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.parent.classList.remove('drone-view');
    this.staticRoot.remove();
    this.root.remove();
  }
}
