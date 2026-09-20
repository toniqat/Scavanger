import type { DroneKind, DroneRef, DroneReleaseReason, DronesRef, GameContext } from '@/shared';
import {
  DRONE_AIR_MAX_ALTITUDE, DRONE_AIR_RANGE, DRONE_GROUND_RANGE, DRONE_LINK_WARN_RATIO,
  DRONE_SCAN_RANGE,
  Keys, createKeycap, onKeybindsChanged, paintKeycap,
} from '@/shared';
import { clamp01, el, restartAnim, setText, toggleClass } from '../dom';
/* appended (2026-09-12): world labels for drone scan results — this widget holds them and projects in `lateUpdate` */
import { DroneScanLabels } from './DroneScanLabels';
import '../styles/drone.css';

/** Scan hold ring — around the aim point (radius 36), inside the control-switch ring (60) so the two never overlap. */
const SCAN_RING_SIZE = 96;
const SCAN_RING_R = 36;

/** Display name per drone kind (the frame's top-left tag). */
const KIND_NAME: Record<DroneKind, string> = { ground: '지상 드론', air: '공중 드론' };

/** Control-switch hold ring — `hud/HoldGauge`'s shape, radius further out (60 vs 48) so the two rings never overlap. */
const RING_SIZE = 144;
const RING_R = 60;

/** Edge noise canvas resolution (CSS stretches it over the whole screen with `pixelated`) and its update interval. */
const NOISE_W = 160;
const NOISE_H = 90;
const NOISE_INTERVAL_S = 1 / 18;

/** How long the disconnect notice stays up — the same as `drAlert` 1.5s in `styles/drone.css`. */
const ALERT_S = 1.5;
/** Full-screen noise flash: when the link broke by leaving range / just after entering the drone view. */
const BURST_RANGE_S = 0.7;
const BURST_BOOT_S = 0.35;
const BURST_BOOT_PEAK = 0.7;
/** Hit flash (the frame brackets go red). */
const HIT_FLASH_S = 0.22;
/** Ratio below which the hp bar turns red. */
const HP_LOW_RATIO = 0.35;
/** Slack (m) within which the altitude gauge reads as "at max altitude". */
const ALT_TOP_EPS = 0.25;

const ALERT_TEXT: Partial<Record<DroneReleaseReason, string>> = {
  range: '신호 끊김',
  destroyed: '드론 파괴됨',
  damage: '피격 — 연결 해제',
};

type KeyId = 'JUMP' | 'CROUCH' | 'SPRINT' | 'RELOAD';
interface KeyRow { cap: HTMLElement; key: KeyId; hold: boolean }

/**
 * **Drone-control HUD** (2026-09-11). Its only data is `ctx.drones` (`controlled` · `controlHold` · `DroneRef`) and `drone:*` events.
 *
 *  - **Drone view mode**: with a `ctx.drones.controlled` it turns `drone-view` on at the gameplay HUD root
 *    (`this.root.parentElement`) — CSS hides the weapon panel (+ quick strip) · implant · ship call · stamina · the gun
 *    crosshair · the crosshair gauges and leaves hp small. This widget draws the centre viewfinder brackets, the
 *    `● DRONE 공중 드론` tag, the drone hp bar and a small aim point.
 *  - **Bottom range gauge**: the stamina spot · the same grammar. Fill = `linkRatio` (fuller the further away). At
 *    `DRONE_LINK_WARN_RATIO` or more it blinks red with `신호 약함`, at 1 or more (`linkLost`) `신호 끊김`. Below: `현재 / 최대 m`.
 *  - **Screen-edge static**: intensity 0 → 1 over warn ratio → 1. Procedural canvas noise (160×90, 18 Hz, drawn only while
 *    it is on) is cut by an edge mask and CSS lays scanlines · chromatic fringing · tearing bands on top. Prepended to the
 *    **bottom** of the gameplay layer so it never covers HUD text.
 *  - **Air drone**: left of the crosshair `고도 12 m` (= drone y − `world.getSurfaceY(x, z, y)`) + a vertical gauge against
 *    max altitude, on the right `Space 상승` / `C 하강`. **Ground drone**: on the right `Space 점프` / `Shift 질주` + a
 *    `소음` badge while sprinting (it stays dim after stopping while `aggroable`).
 *  - **Both**: bottom right `R` (hold) `복귀`; on a drone hit (`drone:damaged` own) the hp bar · brackets flash.
 *  - **Control-switch hold ring**: with `controlHold > 0` it appears around the crosshair, before or during control (label `드론 조종` / `복귀`).
 *  - **Disconnect notice**: the `reason` of `drone:controlChanged {id: null}` — `range` = a full noise flash + `신호 끊김`,
 *    `destroyed` = `드론 파괴됨`, `damage` = `피격 — 연결 해제`, `manual` · `reset` = silently. 1.5 s.
 *
 * It is never put on the key guide (`ui:keyGuide`): the guide appends `Tab · Esc 닫기` itself and the drone view does not
 * close with those keys (the same reason as `hud/CommsWheel`). The control notice is the crosshair's right column.
 * Key labels are read at use time with `keyLabel(Keys.X)` and rewritten on `input:bindingsChanged` · `onKeybindsChanged`.
 * The DOM is written only when a value changed (key string comparison).
 */
export class DroneHud {
  readonly root: HTMLElement;
  private parent: HTMLElement;

  /* Controlling layer */
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

  /* Hold ring */
  private ring: HTMLElement;
  private ringFill: SVGCircleElement;
  private ringLbl: HTMLElement;
  private circumference: number;
  private lastRingT = -1;
  private lastRingLbl = '';

  /* 2026-09-12: ground drone scan — hold ring around the aim point · the notice below · world labels */
  private scanRing: HTMLElement;
  private scanFill: SVGCircleElement;
  private scanCirc: number;
  private lastScanT = -1;
  private scanHint: HTMLElement;
  private scanTgt: HTMLElement;
  private scanDist: HTMLElement;
  private scanAct: HTMLElement;
  private lastScanKey = '';
  private readonly scanLabels: DroneScanLabels;

  /* Notice */
  private alertEl: HTMLElement;
  private alertT = 0;

  /* Edge noise */
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

  /* State */
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

    // ── Edge noise: the bottom of the gameplay layer (under the other widgets' text) ──
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

    // ── Controlling layer ──
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

    // Left of the crosshair: altitude (air drone)
    this.altRoot = el('div', { cls: 'dr-alt', parent: this.view });
    const altTxt = el('div', { cls: 'txt', parent: this.altRoot });
    el('span', { cls: 'ui-label', text: '고도', parent: altTxt });
    const altLine = el('div', { parent: altTxt });
    this.altVal = el('span', { cls: 'val', text: '0', parent: altLine });
    el('span', { cls: 'unit', text: 'm', parent: altLine });
    const ladder = el('div', { cls: 'ladder', parent: this.altRoot });
    this.altFill = el('i', { parent: ladder });
    this.altFill.style.transform = 'scaleY(0)';

    // Right of the crosshair: the control notice
    const keys = el('div', { cls: 'dr-keys', parent: this.view });
    this.keyRow(keys, 'air', 'JUMP', '상승');
    this.keyRow(keys, 'air', 'CROUCH', '하강');
    this.keyRow(keys, 'ground', 'JUMP', '점프');
    const sprintRow = this.keyRow(keys, 'ground', 'SPRINT', '질주');
    this.noiseBadge = el('span', { cls: 'dr-noise', text: '소음', parent: sprintRow });
    this.keyRow(keys, 'back', 'RELOAD', '복귀', true);

    // Bottom range gauge (the stamina spot)
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

    // ── Control-switch hold ring (it appears before control too) ──
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

    // ── Disconnect notice ──
    this.alertEl = el('div', { cls: 'dr-alert', text: '', parent: this.root });

    // ── 2026-09-12: ground drone scan (inside the controlling layer) ──
    this.scanRing = el('div', { cls: 'dsc-ring', parent: this.view });
    const scanSvg = document.createElementNS(svgNS, 'svg');
    scanSvg.setAttribute('viewBox', `0 0 ${SCAN_RING_SIZE} ${SCAN_RING_SIZE}`);
    const mkScan = (cls: string): SVGCircleElement => {
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('cx', String(SCAN_RING_SIZE / 2)); c.setAttribute('cy', String(SCAN_RING_SIZE / 2)); c.setAttribute('r', String(SCAN_RING_R));
      scanSvg.appendChild(c);
      return c;
    };
    mkScan('track');
    this.scanFill = mkScan('fill');
    this.scanCirc = 2 * Math.PI * SCAN_RING_R;
    this.scanFill.style.strokeDasharray = `0 ${this.scanCirc.toFixed(2)}`;
    this.scanRing.appendChild(scanSvg);
    this.scanHint = el('div', { cls: 'dsc-hint', parent: this.view });
    const tgt = el('div', { cls: 'tgt', parent: this.scanHint });
    this.scanTgt = el('span', { text: '', parent: tgt });
    this.scanDist = el('span', { cls: 'dist', text: '', parent: tgt });
    this.scanAct = el('div', { cls: 'act', text: '', parent: this.scanHint });
    this.scanLabels = new DroneScanLabels(parent);
  }

  /** One control-notice row: keycap (the real binding) + the Korean action. `group` is per kind (`air` / `ground`) or `back`. */
  private keyRow(parent: HTMLElement, group: 'air' | 'ground' | 'back', key: KeyId, label: string, hold = false): HTMLElement {
    const row = el('div', { cls: `dr-key ${group}`, parent });
    // 2026-09-15: the shared keycap (`shared/keycap`) — the hold chevron sits inside the cap, a mouse rebinding draws the glyph
    const cap = createKeycap(Keys[key], { tag: 'kbd', hold, parent: row });
    el('span', { text: label, parent: row });
    this.keyRows.push({ cap, key, hold });
    return row;
  }

  private refreshKeys(): void {
    for (const r of this.keyRows) paintKeycap(r.cap, Keys[r.key], { hold: r.hold });
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
    this.scanLabels.bind(ctx);
    this.refreshKeys();
  }

  /** `HudSystem.lateUpdate` (after the camera matrix update) — projects the scan-result world labels. */
  lateUpdate(ctx: GameContext): void {
    this.scanLabels.lateUpdate(ctx);
  }

  update(dt: number, ctx: GameContext): void {
    const drones = ctx.drones;
    const d = drones?.controlled ?? null;
    this.setControlled(d);
    this.updateRing(drones?.controlHold ?? 0, d !== null);
    this.updateScan(d?.kind === 'ground' ? drones : null);

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

  /** Rewrites the layer class · kind name only when the controlled drone changed (polling and events take the same path). */
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
    // A beat for the view switch: a short full-screen noise the moment the drone camera takes over
    if (entering) this.burst(BURST_BOOT_S, BURST_BOOT_PEAK);
  }

  /* ── Range gauge ───────────────────────────────────────────────────────── */

  private updateLink(d: DroneRef): void {
    const ratio = Math.max(0, Number.isFinite(d.linkRatio) ? d.linkRatio : 0);
    const fill = Math.min(1, ratio);
    const lost = d.linkLost || ratio >= 1;
    const warn = lost || ratio >= DRONE_LINK_WARN_RATIO;
    const range = d.kind === 'air' ? DRONE_AIR_RANGE : DRONE_GROUND_RANGE;
    const distText = range > 0
      ? `${Math.round(ratio * range)} / ${Math.round(range)} m`
      : `${Math.round(ratio * 100)}%`;
    // Edge static intensity: 0 → 1 over warn ratio → 1
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

  /* ── Drone hp ──────────────────────────────────────────────────────────── */

  private updateHp(d: DroneRef): void {
    const r = d.maxHp > 0 ? clamp01(d.hp / d.maxHp) : 0;
    const key = r.toFixed(3);
    if (key === this.lastHpKey) return;
    this.lastHpKey = key;
    this.hpFill.style.transform = `scaleX(${key})`;
    toggleClass(this.hpRoot, 'low', r < HP_LOW_RATIO);
  }

  private flashHit(): void {
    restartAnim(this.hpRoot, 'hit');
    toggleClass(this.view, 'hit', true);
    this.hitT = HIT_FLASH_S;
  }

  /* ── Air drone: altitude ───────────────────────────────────────────────── */

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

  /* ── Ground drone: noise badge ─────────────────────────────────────────── */

  private updateNoise(d: DroneRef): void {
    const on = d.sprinting;
    const linger = !on && d.aggroable;
    const key = `${on ? 1 : 0}|${linger ? 1 : 0}`;
    if (key === this.lastNoiseKey) return;
    this.lastNoiseKey = key;
    toggleClass(this.noiseBadge, 'on', on);
    toggleClass(this.noiseBadge, 'linger', linger);
  }

  /* ── Control-switch hold ring ──────────────────────────────────────────── */

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

  /* ── Ground drone scan: hold ring · notice (2026-09-12) ───────────────── */

  /** `drones` null = no ground drone is being controlled → both hide. */
  private updateScan(drones: DronesRef | null): void {
    const hold = drones ? clamp01(Number.isFinite(drones.scanHold) ? (drones.scanHold ?? 0) : 0) : 0;
    const show = hold > 0.001;
    toggleClass(this.scanRing, 'show', show);
    const v = show ? hold : 0;
    if (Math.abs(v - this.lastScanT) >= 0.003) {
      this.lastScanT = v;
      this.scanFill.style.strokeDasharray = `${(v * this.scanCirc).toFixed(2)} ${this.scanCirc.toFixed(2)}`;
    }
    const aim = drones?.scanAim ?? null;
    const key = aim ? `${aim.id}|${aim.name}|${aim.distance.toFixed(1)}|${aim.inRange ? 1 : 0}` : '';
    if (key === this.lastScanKey) return;
    this.lastScanKey = key;
    toggleClass(this.scanHint, 'show', aim !== null);
    if (!aim) return;
    toggleClass(this.scanHint, 'far', !aim.inRange);
    setText(this.scanTgt, aim.name);
    setText(this.scanDist, `${aim.distance.toFixed(1)} m`);
    setText(this.scanAct, aim.inRange ? '좌클릭 꾹 — 내용물 스캔' : `더 가까이 — ${Math.round(DRONE_SCAN_RANGE)} m 안`);
  }

  /* ── Disconnect notice ─────────────────────────────────────────────────── */

  private showAlert(reason: DroneReleaseReason | null): void {
    const text = reason ? ALERT_TEXT[reason] : undefined;
    if (!text) return; // manual · reset = silently
    setText(this.alertEl, text);
    restartAnim(this.alertEl, 'show');
    this.alertT = ALERT_S;
    if (reason === 'range') this.burst(BURST_RANGE_S, 1);
  }

  /* ── Edge noise ────────────────────────────────────────────────────────── */

  private burst(duration: number, peak: number): void {
    this.burstDur = duration;
    this.burstT = duration;
    this.burstPeak = peak;
    this.noiseClock = 0; // draw on the very next frame
  }

  private updateStatic(dt: number): void {
    let burstI = 0;
    if (this.burstT > 0) {
      this.burstT -= dt;
      burstI = this.burstT > 0 ? this.burstPeak * (this.burstT / Math.max(1e-3, this.burstDur)) : 0;
    }
    const bursting = burstI > this.edgeT;
    const si = Math.max(this.edgeT, burstI);
    const q = Math.round(si * 50) / 50; // rewritten only in steps of 0.02
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

  /** Monochrome snow + the occasional bright horizontal streak. xorshift32 — cheaper than `Math.random`, no allocation. */
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

  /** Whether the drone view mode is on. */
  get isDroneView(): boolean { return this.controlledId !== ''; }
  /** Range gauge state: 'off' | 'ok' | 'warn' | 'lost'. */
  get linkStatus(): 'off' | 'ok' | 'warn' | 'lost' {
    if (!this.isDroneView) return 'off';
    if (this.linkRoot.classList.contains('lost')) return 'lost';
    return this.linkRoot.classList.contains('warn') ? 'warn' : 'ok';
  }
  /** Edge noise intensity 0..1 (the last value written). */
  get staticIntensity(): number { return Math.max(0, this.lastSi); }
  /** The notice text on screen, '' when there is none. */
  get alertText(): string { return this.alertEl.classList.contains('show') ? (this.alertEl.textContent ?? '') : ''; }
  /** Whether the hold ring is visible. */
  get isHoldShowing(): boolean { return this.ring.classList.contains('show'); }
  /** 2026-09-12: whether the scan hold ring is visible · the scan notice text ('' with none) · how many scan labels are up. */
  get isScanRingShowing(): boolean { return this.scanRing.classList.contains('show'); }
  get scanHintText(): string { return this.scanHint.classList.contains('show') ? (this.scanHint.textContent ?? '') : ''; }
  get scanLabelCount(): number { return this.scanLabels.count; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.scanLabels.dispose();
    this.parent.classList.remove('drone-view');
    this.staticRoot.remove();
    this.root.remove();
  }
}
