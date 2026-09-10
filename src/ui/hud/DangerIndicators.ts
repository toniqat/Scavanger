import * as THREE from 'three';
import type { GameContext, GrenadeView, StratagemId } from '@/shared';
import { DANGER_NEAR_RADIUS, DETECT_ENEMY_BASE_RADIUS, shellLaunchVelocity, shellPositionAt } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { STRATAGEM_COLOR, STRATAGEM_GLYPH, stratagemDef } from './stratagemGlyphs';
import '../styles/danger.css';

/** Pooled indicators (heads and arcs alike) — two mortars, a squad's grenades and a couple of calls fit. */
const MAX = 10;
/** Candidate slots collected before the nearest `MAX` win. */
const MAX_CANDIDATES = 28;
/** Seconds to impact under which an indicator pulses fast. */
const HOT_S = 1.5;
/** Safety net past `flightTime` if neither landed nor intercepted arrives (mirrors `ShellProjectile`'s timeout). */
const TIMEOUT_PAD_S = 2.5;
/** |NDC| beyond this counts as off-screen (the projected point is at / past the viewport edge). */
const EDGE_NDC = 0.94;

type Cat = 'shell' | 'grenade' | 'call';

interface Shell {
  sid: number;
  from: THREE.Vector3;
  vel0: THREE.Vector3;
  /** Where the arc ends — the 인지력 override is judged on this, not on where the shell is right now. */
  impact: THREE.Vector3;
  flight: number;
  life: number;
  active: boolean;
}
interface Call { id: string; kind: StratagemId; pos: THREE.Vector3; landsAt: number; landed: boolean }

/** One thing to draw this frame (pooled — the fields are overwritten, never re-allocated). */
interface Item {
  cat: Cat;
  pos: THREE.Vector3;
  color: string;
  icon: string;
  label: string;
  hot: boolean;
  d2: number;
}
interface Slot { el: HTMLElement; ico: HTMLElement; lbl: HTMLElement; lastKey: string }

const CAT_NAME: Record<Cat, string> = { shell: '포탄', grenade: '수류탄', call: '낙하물' };
const CAT_ICON: Record<Cat, string> = { shell: '◆', grenade: '●', call: '▣' };
/** Hoisted so sorting the candidates allocates nothing (it runs only when more than `MAX` are live). */
const byNear = (a: Item, b: Item): number => a.d2 - b.d2;
/*
 * 색이 **누구 것인가**를, `hot` 클래스(빠른 맥동 + 라벨)가 **얼마나 임박했는가**를 말한다 (2026-09-10).
 * 그래서 아군 수류탄은 임박해도 붉어지지 않고 짙은 호박으로만 간다 — 발치에 떨어진 게 내 것인지 로그 것인지가
 * 피할지 주울지를 가르는데, 둘 다 빨개지면 그 구분이 사라진다. 적 위험은 포탄과 같은 빨강이다.
 */
const SHELL_COLOR = '#ff4d4d';
const GRENADE_COLOR = '#ffb347';
const GRENADE_HOT_COLOR = '#ff8c1a';
const GRENADE_HOSTILE_COLOR = '#ff4d4d';
const GRENADE_HOSTILE_HOT_COLOR = '#ff2020';

/**
 * 위험 인디케이터 (`.dgr`, 게임플레이 레이어, 2026-09-10).
 *
 * "지금 날아오고 있는 것" 하나마다 **화면 안이면 머리 인디케이터, 화면 밖이면 방향 호**를 그린다 — 둘은
 * 절대 같이 뜨지 않는다(한 목표는 정확히 한 요소를 쓴다). 방향 호는 피격 방향 호(`hud/DamageOverlay` 의
 * `.dmg-arc`)와 같은 언어다: 크로스헤어를 감싸는 굵은 링의 한 쐐기, 각도는 **카메라 기준 상대 방위**
 * (0° = 정면, 시계방향) 로 그쪽에서 온다는 것만 말한다.
 *
 * 대상 셋 (사용자 확정):
 *   - **적 곡사포탄** — `enemy:shellFired {sid, from, target, flightTime}` 를 받아 `@/shared/ballistics` 의
 *     `shellLaunchVelocity` / `shellPositionAt` 로 **실제 포탄과 같은 포물선**을 적분한다 (수식을 베끼지 않는다 —
 *     `enemies/fx/ShellProjectile` 도 같은 함수를 부르고, 중력 `SHELL_ARC_GRAVITY` 는 csv 값이다).
 *     `enemy:shellLanded` / `enemy:shellIntercepted` 에 지운다.
 *   - **수류탄** — `ctx.weapons.getGrenades()` (아군 — 내 것 + 원격 분대원의 복제본) 과
 *     `ctx.enemies.getEnemyGrenades()` (적 — 로그가 던진 것) 둘 다. 라벨은 남은 신관이고, **색이 누구 것인지를
 *     말한다** (아군 호박 · 적 빨강; `hot` 은 임박만 나타낸다).
 *   - **함선 호출 낙하물** — `stratagem:called` → `landed` / `ended`. 궤도 폭격 · 보급품 · 트라이포드 · 구조선.
 *
 * **인지력 반경 게이트 (결정, 2026-09-10).** 포탄에 걸려 있던 `derived.enemyDetectRadius` 게이트는 유지하되
 * **착탄 지점이 `DANGER_NEAR_RADIUS` 안이면 무조건** 보여 준다 — 인디케이터의 목적이 "날아오는 줄도 모르는
 * 것" 을 알리는 것이라, 내 머리 위로 떨어지는 포탄이 인지력 부족으로 안 보이면 그 목적이 무너진다. 수류탄과
 * 낙하물에는 게이트가 없다: 둘 다 분대가 방금 만든 사건이고 이미 눈앞에 있다.
 *
 * **전장의 안개 게이트는 걸지 않는다** — `hud/OffscreenIndicators` 상단의 2026-09-09 근거 그대로다. 여기서
 * 그리는 것은 발견된 오브젝트가 아니라 지금 벌어지는 사건이다.
 *
 * DOM 은 전부 풀링(`MAX` 머리 + `MAX` 호)이고, 반올림한 key 가 바뀔 때만 쓴다. 프레임당 할당 없음
 * (`THREE.Vector3` 스크래치 재사용, 후보 `Item` 도 풀). 메뉴 / 지도가 열려 있거나 죽어 있으면 전부 숨고,
 * `game:abort` / `game:newMission` / `hub:entered` 에서 비운다. 직접 만든 지오메트리 · 머티리얼은 없다.
 */
export class DangerIndicators {
  readonly root: HTMLElement;
  private arcsRoot: HTMLElement;
  private heads: Slot[] = [];
  private arcs: Slot[] = [];
  private shells: Shell[] = [];
  private calls: Call[] = [];
  private pool: Item[] = [];
  private items: Item[] = [];
  private readonly p = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly camF = new THREE.Vector3();
  private shown = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'dgr', parent });
    // heads sit in screen space, arcs share one centred 0×0 anchor (like `.dmg-arcs`)
    for (let i = 0; i < MAX; i++) {
      const h = el('div', { cls: 'dgr-head', parent: this.root });
      h.hidden = true;
      el('i', { cls: 'ring', parent: h });
      const ico = el('span', { cls: 'ico', text: '', parent: h });
      const lbl = el('span', { cls: 'lbl ui-mono', text: '', parent: h });
      this.heads.push({ el: h, ico, lbl, lastKey: '' });
    }
    this.arcsRoot = el('div', { cls: 'dgr-arcs', parent: this.root });
    for (let i = 0; i < MAX; i++) {
      const a = el('div', { cls: 'dgr-arc', parent: this.arcsRoot });
      a.hidden = true;
      el('i', { cls: 'wedge', parent: a });
      const tag = el('div', { cls: 'tag', parent: a });
      const ico = el('span', { cls: 'ico', text: '', parent: tag });
      const lbl = el('span', { cls: 'lbl ui-mono', text: '', parent: tag });
      this.arcs.push({ el: a, ico, lbl, lastKey: '' });
    }
    for (let i = 0; i < MAX_CANDIDATES; i++) {
      this.pool.push({ cat: 'shell', pos: new THREE.Vector3(), color: SHELL_COLOR, icon: '', label: '', hot: false, d2: 0 });
    }
    for (let i = 0; i < MAX; i++) {
      this.shells.push({ sid: 0, from: new THREE.Vector3(), vel0: new THREE.Vector3(), impact: new THREE.Vector3(), flight: 0, life: 0, active: false });
    }
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('enemy:shellFired', ({ sid, from, target, flightTime }) => this.trackShell(sid, from, target, flightTime)),
      b.on('enemy:shellLanded', ({ sid }) => this.untrackShell(sid)),
      b.on('enemy:shellIntercepted', ({ sid }) => this.untrackShell(sid)),
      b.on('stratagem:called', ({ callId, kind, position, landsAt }) => {
        this.calls = this.calls.filter((c) => c.id !== callId);
        this.calls.push({ id: callId, kind, pos: position, landsAt, landed: false });
      }),
      b.on('stratagem:landed', ({ callId, kind }) => {
        // the laser keeps burning after it lands — everything else is over the moment it touches down
        if (kind === 'orbital_laser') { const c = this.calls.find((x) => x.id === callId); if (c) c.landed = true; }
        else this.calls = this.calls.filter((c) => c.id !== callId);
      }),
      b.on('stratagem:ended', ({ callId }) => { this.calls = this.calls.filter((c) => c.id !== callId); }),
      b.on('game:abort', () => this.clear()),
      b.on('game:newMission', () => this.clear()),
      b.on('hub:entered', () => this.clear()),
    );
  }

  private trackShell(sid: number, from: THREE.Vector3, target: THREE.Vector3, flightTime: number): void {
    // re-fired id (host migration re-sends) → refresh in place; else a free slot; else the oldest
    let slot: Shell | null = null;
    for (const s of this.shells) if (s.active && s.sid === sid) { slot = s; break; }
    if (!slot) for (const s of this.shells) if (!s.active) { slot = s; break; }
    if (!slot) { slot = this.shells[0]; for (const s of this.shells) if (s.life > slot.life) slot = s; }
    const T = Math.max(0.5, flightTime);
    slot.sid = sid;
    slot.from.copy(from);
    slot.impact.copy(target);
    shellLaunchVelocity(from, target, T, slot.vel0);
    slot.flight = T;
    slot.life = 0;
    slot.active = true;
  }

  private untrackShell(sid: number): void {
    for (const s of this.shells) if (s.active && s.sid === sid) s.active = false;
  }

  private clear(): void {
    for (const s of this.shells) s.active = false;
    this.calls.length = 0;
    this.hideAll();
  }

  private hideAll(): void {
    for (const h of this.heads) if (!h.el.hidden) { h.el.hidden = true; h.lastKey = ''; }
    for (const a of this.arcs) if (!a.el.hidden) { a.el.hidden = true; a.lastKey = ''; toggleClass(a.el, 'show', false); }
    this.shown = 0;
  }

  /** 인지력 반경 (진행도가 없으면 기본값) — `hud/Detection` 의 적 화살표와 같은 반경이다. */
  private detectRadius(ctx: GameContext): number {
    const r = ctx.progression?.derived?.enemyDetectRadius;
    return typeof r === 'number' && r > 0 ? r : DETECT_ENEMY_BASE_RADIUS;
  }

  /** Seconds label: one decimal under 10 s so a 2.4 s fuse reads, whole seconds above. */
  private etaLabel(eta: number, cat: Cat, name: string): string {
    if (eta <= 0.05) return name || CAT_NAME[cat];
    return eta < 10 ? `${eta.toFixed(1)}초` : `${Math.ceil(eta)}초`;
  }

  /**
   * 수류탄 한 무리를 목록에 올린다. 아군 것과 적 것이 **같은 `GrenadeView` 모양**이라 한 함수로 받는다.
   * `hostile` 이면 색을 적 위험 색으로 바꾸고 라벨에 표시를 붙인다 — 발치에 떨어진 게 내 것인지 로그 것인지는
   * 피할지 주울지를 가르므로 한눈에 갈라져야 한다.
   */
  private pushGrenades(list: readonly GrenadeView[] | undefined, from: THREE.Vector3, hostile: boolean): void {
    if (!list || list.length === 0) return;
    for (const g of list) {
      const hot = g.fuse < 1;
      const dx = g.position.x - from.x, dz = g.position.z - from.z;
      const color = hostile
        ? (hot ? GRENADE_HOSTILE_HOT_COLOR : GRENADE_HOSTILE_COLOR)
        : (hot ? GRENADE_HOT_COLOR : GRENADE_COLOR);
      this.push('grenade', g.position, color, CAT_ICON.grenade,
        this.etaLabel(g.fuse, 'grenade', hostile ? '적 수류탄' : ''), hot, dx * dx + dz * dz);
    }
  }

  private push(cat: Cat, pos: THREE.Vector3, color: string, icon: string, label: string, hot: boolean, d2: number): void {
    if (this.items.length >= MAX_CANDIDATES) return;
    const it = this.pool[this.items.length];
    it.cat = cat; it.pos.copy(pos); it.color = color; it.icon = icon; it.label = label; it.hot = hot; it.d2 = d2;
    this.items.push(it);
  }

  private collect(ctx: GameContext, from: THREE.Vector3): void {
    this.items.length = 0;
    const t = ctx.time;
    // (a) 곡사포탄 — the 인지력 gate with the "it is landing on me" override
    const detect = this.detectRadius(ctx);
    const detect2 = detect * detect;
    const near2 = DANGER_NEAR_RADIUS * DANGER_NEAR_RADIUS;
    for (const s of this.shells) {
      if (!s.active) continue;
      shellPositionAt(s.from, s.vel0, s.life, this.p);
      const dxi = s.impact.x - from.x, dzi = s.impact.z - from.z;
      const dx = this.p.x - from.x, dz = this.p.z - from.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > detect2 && dxi * dxi + dzi * dzi > near2) continue;
      const eta = s.flight - s.life;
      this.push('shell', this.p, SHELL_COLOR, CAT_ICON.shell, this.etaLabel(eta, 'shell', ''), eta < HOT_S, d2);
    }
    // (b) 수류탄 — 아군(내 것 + 원격 분대원의 복제본)과 **적(로그)** 것 모두. 게이트 없음: 이미 발치에 있다.
    this.pushGrenades(ctx.weapons?.getGrenades?.(), from, false);
    this.pushGrenades(ctx.enemies?.getEnemyGrenades?.(), from, true);
    // (c) 함선 호출 낙하물 — somebody in the squad called it, so no gate either
    for (const c of this.calls) {
      const eta = c.landed ? 0 : c.landsAt - t;
      const def = stratagemDef(c.kind);
      const dx = c.pos.x - from.x, dz = c.pos.z - from.z;
      this.push('call', c.pos, STRATAGEM_COLOR[c.kind] ?? '#ffb347', STRATAGEM_GLYPH[c.kind] ?? CAT_ICON.call,
        this.etaLabel(eta, 'call', def?.name ?? ''), !c.landed && eta > 0 && eta < HOT_S, dx * dx + dz * dz);
    }
    if (this.items.length > MAX) {
      this.items.sort(byNear);   // 가까운 것부터
      this.items.length = MAX;
    }
  }

  /** Called from `HudSystem.lateUpdate` so the projection matches the camera of the frame being drawn. */
  lateUpdate(dt: number, ctx: GameContext): void {
    // advance every tracked shell even while hidden, so an indicator that reappears is where the shell is
    for (const s of this.shells) {
      if (!s.active) continue;
      s.life += dt;
      if (s.life > s.flight + TIMEOUT_PAD_S) s.active = false;
    }
    const player = ctx.player;
    const active = ctx.isGameplayPhase() && !!player && !player.isDead
      && !ctx.uiBlockers.has('menu') && !ctx.uiBlockers.has('map');
    if (!active) { if (this.shown) this.hideAll(); return; }
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    if (w <= 0 || h <= 0) return;

    this.collect(ctx, player!.position);
    const cam = ctx.camera;
    cam.getWorldDirection(this.camF);
    const camYaw = Math.atan2(this.camF.x, -this.camF.z);
    let heads = 0, arcs = 0;
    for (const it of this.items) {
      this.v.copy(it.pos).project(cam);
      const behind = this.v.z > 1 || this.v.z < -1;
      const off = behind || Math.abs(this.v.x) > EDGE_NDC || Math.abs(this.v.y) > EDGE_NDC;
      if (!off) {
        if (heads >= MAX) continue;
        const px = (this.v.x * 0.5 + 0.5) * w;
        const py = (-this.v.y * 0.5 + 0.5) * h;
        this.drawHead(this.heads[heads++], it, px, py);
        continue;
      }
      if (arcs >= MAX) continue;
      // Screen-relative bearing, exactly like the damage arc: 0° = ahead (top of the ring), clockwise.
      const toYaw = Math.atan2(it.pos.x - player!.position.x, -(it.pos.z - player!.position.z));
      const d = toYaw - camYaw;
      const rel = Math.atan2(Math.sin(d), Math.cos(d));
      this.drawArc(this.arcs[arcs++], it, (rel * 180) / Math.PI);
    }
    for (let i = heads; i < MAX; i++) { const s = this.heads[i]; if (!s.el.hidden) { s.el.hidden = true; s.lastKey = ''; } }
    for (let i = arcs; i < MAX; i++) { const s = this.arcs[i]; if (!s.el.hidden) { s.el.hidden = true; s.lastKey = ''; toggleClass(s.el, 'show', false); } }
    this.shown = heads + arcs;
  }

  private drawHead(s: Slot, it: Item, x: number, y: number): void {
    const key = `${it.cat}|${Math.round(x)}|${Math.round(y)}|${it.label}|${it.hot ? 1 : 0}|${it.color}`;
    if (s.el.hidden) s.el.hidden = false;
    if (key === s.lastKey) return;
    s.lastKey = key;
    s.el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
    s.el.style.setProperty('--dc', it.color);
    s.el.classList.toggle('hot', it.hot);
    setText(s.ico, it.icon);
    setText(s.lbl, it.label);
  }

  private drawArc(s: Slot, it: Item, deg: number): void {
    const key = `${it.cat}|${Math.round(deg)}|${it.label}|${it.hot ? 1 : 0}|${it.color}`;
    if (s.el.hidden) { s.el.hidden = false; toggleClass(s.el, 'show', true); }
    if (key === s.lastKey) return;
    s.lastKey = key;
    s.el.style.setProperty('--rot', `${deg.toFixed(0)}deg`);
    s.el.style.setProperty('--dc', it.color);
    s.el.classList.toggle('hot', it.hot);
    setText(s.ico, it.icon);
    setText(s.lbl, it.label);
  }

  /** Head indicators + direction arcs currently visible (debug / smoke). */
  get visibleCount(): number { return this.shown; }
  /** Dangers being tracked — shells in flight + live ship calls (debug / smoke). */
  get trackedCount(): number { let n = 0; for (const s of this.shells) if (s.active) n++; return n + this.calls.length; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
  }
}
