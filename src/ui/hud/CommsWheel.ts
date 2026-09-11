import type { CommsDef, CommsId, CommsMessage, GameContext, PeerId } from '@/shared';
import {
  COMMS_COOLDOWN_S, COMMS_DEF_MAP, COMMS_WHEEL_DEAD_PX, COMMS_WHEEL_HOLD_S,
  Keys, commsLayout, fillCommsLine, keyLabel,
} from '@/shared';
import '../styles/wheels.css';
import { el, setText, toggleClass } from '../dom';

/** SVG geometry (viewBox units = px) — the `StratagemWheel` ring, one size down. */
const SIZE = 280;
const R_IN = 62;
const R_OUT = 126;
const SECTOR_GAP_DEG = 3;
const LABEL_RADIUS = (R_IN + R_OUT) / 2;

/** 방향 → 각도(도, 0 = 위, 시계방향). `CommsDir` 의 여섯 값을 전부 덮는다. */
const DIR_DEG: Readonly<Record<string, number>> = { N: 0, E: 90, S: 180, W: 270, L: 270, R: 90 };

/** 한 칸이 차지하는 각(도): 4칸이면 90°, 2칸이면 180°. */
function spreadOf(count: number): number { return count >= 4 ? 90 : 180; }

interface Sector { arc: SVGPathElement; root: HTMLElement; label: HTMLElement; dir: HTMLElement }

/** `toggleClass` for SVG elements (not HTMLElement). */
function tc(e: Element, cls: string, on: boolean): void { if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on); }

/** Annular sector path; angles in degrees, 0 = up, clockwise. */
function sectorPath(a0: number, a1: number): string {
  const c = SIZE / 2;
  const pt = (r: number, a: number): string => {
    const t = ((a - 90) * Math.PI) / 180;
    return `${(c + r * Math.cos(t)).toFixed(2)} ${(c + r * Math.sin(t)).toFixed(2)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${pt(R_OUT, a0)} A${R_OUT} ${R_OUT} 0 ${large} 1 ${pt(R_OUT, a1)} L${pt(R_IN, a1)} A${R_IN} ${R_IN} 0 ${large} 0 ${pt(R_IN, a0)} Z`;
}

/**
 * **의사소통 휠 (`H` 홀드, 2026-09-09).** `.cwheel`, 게임플레이 레이어, `pointer-events:none`.
 *
 * 다른 두 휠(`QuickWheel` · `StratagemWheel`)과 성격이 같지만 **입력까지 여기서 본다** — 의사소통에는 소유
 * 시스템 폴더가 따로 없고 계약(`shared/comms.ts`)과 채팅 · 네트워크만으로 완결되기 때문이다. 그래서 이 파일
 * 하나가 (1) `Keys.COMMS` 홀드 제스처, (2) 휠 그리기, (3) 한 마디 보내기 · 받기, (4) 채팅 한 줄 · 토스트를
 * 전부 맡는다.
 *
 * **제스처.** `Keys.COMMS`(기본 H)를 누르면 홀드 타이머가 시작되고 `COMMS_WHEEL_HOLD_S` 를 넘기면 휠이 열린다.
 * 열려 있는 동안 포인터 락 델타(`input.mouseDX/DY`)를 누적해 중심에서 `COMMS_WHEEL_DEAD_PX` 를 넘으면 그 방향의
 * 칸이 hover 가 되고, 키를 놓으면 그 한 마디가 나간다. **짧게 톡 누르면 아무 일도 없다** (이 키는 오직 휠이다).
 * 열려 있는 동안 `ctx.player.setLookLocked(true)` 로 카메라를 묶는다 — 다른 두 휠과 같은 방식이고, 우리가 건
 * 락만 우리가 푼다(`lookLocked` 플래그). `PlayerWeaponHost` 를 import 하지 않고 `ctx.player` 를 duck-type 한다.
 *
 * **배치는 상태가 정한다** (`shared/comms.ts` 의 `commsLayout`): 서 있으면 4칸(N/E/S/W), 전투불능이면 2칸(좌/우).
 * 전투불능 여부는 매 프레임 다시 보므로 휠이 열린 채 쓰러져도 그 자리에서 배치가 바뀐다. **문구는 이 파일이
 * 쓰지 않는다** — `CommsDef.label` / `.line` 그대로이고, `{n}` · `{name}` 이 든 `contract` 만 `ctx.meta`
 * (`activeContract`, `CONTRACT_MAX_ACTIVE` 가 1이라 "가장 가까운 하나" = 그 하나)에서 이름과 남은 건수를 읽어
 * `fillCommsLine` 으로 채운다. 계약이 없으면 `CommsDef.fallback` 이 나간다.
 *
 * **보내기 · 받기.** 로컬에서 `comms:sent {id, text, by:null, byName, slot, position}` 를 발행하고, 로비가 있으면
 * `CommsMessage {t:'comm', id, text}` 를 `'others'` 로 보낸다. 원격 `comm` 은 `id` 를 `COMMS_DEF_MAP` 으로 검증하고
 * `text` 를 잘라 같은 `comms:sent` 를 (`by`/`byName`/`slot`/`position` 채워서) 발행한다.
 *
 * **채팅 · 토스트.** `comms:sent` 하나만 듣는다. **로컬**(`by === null`)이면 `chat:post {kind:'request'}` 를
 * 발행한다 — `ChatLog` 가 내 이름을 앞에 붙여 한 줄을 쓰고 그 줄을 분대에 중계하므로 원격에서도 `<이름>: 문장`
 * 이 그대로 보인다 (핑 v3 의 콜아웃과 **같은 경로**다). **원격**이면 채팅을 다시 쏘지 않고(중계본이 이미 온다)
 * `ui:notify` 토스트만 띄운다. 효과음은 `chat:message {kind:'request'}` 를 듣는 `audio/` 가 낸다.
 *
 * **쿨다운.** `COMMS_COOLDOWN_S`. 재충전 중에도 휠은 열리지만 중앙이 `재충전 n초` 가 되고 칸이 흐려지며
 * (`.cooling`), 놓아도 `ui_deny` 만 난다.
 *
 * **blocker 를 잡지 않는다.** 포인터 락도 풀지 않고 ESC 스택에도 올라가지 않는다 — 두 형제 휠과 같다. 그래서
 * 우측 하단 키 가이드에도 올리지 않는다(가이드는 `Tab · Esc 닫기` 를 스스로 붙이는데, 이 휠은 키를 **놓아서**
 * 닫히지 Tab 으로 닫히지 않는다). 안내는 형제들처럼 휠 중앙 한 줄(`마우스로 선택 · H 놓기`)이 맡는다.
 */
export class CommsWheel {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private items: HTMLElement;
  private nameEl: HTMLElement;
  private subEl: HTMLElement;
  private cdEl: HTMLElement;
  private sectors: Sector[] = [];
  private layout: readonly CommsDef[] = [];

  private ctx: GameContext | null = null;
  private held = false;
  private holdT = 0;
  private open = false;
  private downed = false;
  private hover: number | null = null;
  private dx = 0;
  private dy = 0;
  private lookLocked = false;
  private lastSent = -Infinity;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'cwheel', parent });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    this.svg.setAttribute('class', 'ring');
    this.root.appendChild(this.svg);
    this.items = el('div', { cls: 'items', parent: this.root });

    const centre = el('div', { cls: 'centre', parent: this.root });
    el('div', { cls: 'ui-label', text: '의사소통', parent: centre });
    this.nameEl = el('div', { cls: 'cname', text: '—', parent: centre });
    this.cdEl = el('div', { cls: 'ccd', text: '', parent: centre });
    this.subEl = el('div', { cls: 'csub', text: '', parent: centre });

    this.build(false);
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('comms:sent', (e) => this.announce(ctx, e)),
      b.on('input:bindingsChanged', () => this.applyHover()),
      b.on('player:died', () => this.cancel()),
      b.on('game:newMission', () => { this.cancel(); this.lastSent = -Infinity; }),
      b.on('game:abort', () => { this.cancel(); this.lastSent = -Infinity; }),
    );
    if (ctx.net) this.unsubs.push(ctx.net.onMessage('comm', (msg, from) => this.onRemote(msg, from)));
  }

  /** Whether the wheel is showing (debug / smoke). */
  get isOpen(): boolean { return this.open; }
  /** Hovered sector index, null when the drag has not left the dead zone (debug / smoke). */
  get hoverIndex(): number | null { return this.hover; }
  /** Which layout is drawn right now: 4 (서 있을 때) or 2 (전투불능) (debug / smoke). */
  get slotCount(): number { return this.layout.length; }

  /* ── 제스처 ─────────────────────────────────────────────────────────────── */

  update(dt: number, ctx: GameContext): void {
    const input = ctx.input;
    // 전투불능이어도 말은 할 수 있어야 한다 — 그래서 `isDowned` 는 배치만 바꾸고 게이트가 아니다.
    // 2026-09-11: 드론 조종 중에는 열리지 않는다 (열려 있으면 아래 `!usable` 이 아무것도 보내지 않고 접는다) —
    // 마우스가 드론 시점이다. 핑(`hud/Pings`)은 막지 않는다.
    const usable = ctx.isGameplayActive() && input.isPointerLocked && !(ctx.player?.isDead ?? false)
      && !(ctx.player?.droneControl ?? false);

    if (!this.held) {
      if (usable && input.wasPressed(Keys.COMMS)) { this.held = true; this.holdT = 0; }
      return;
    }
    if (!usable) { this.cancel(); return; }

    if (!input.isDown(Keys.COMMS)) {
      this.held = false;
      if (!this.open) return;                       // 톡 누름 = 아무 일도 없다
      const pick = this.hover;
      this.setOpen(false);
      if (pick !== null) this.send(ctx, this.layout[pick]);
      return;
    }

    this.holdT += dt;
    if (!this.open) {
      if (this.holdT < COMMS_WHEEL_HOLD_S) return;
      this.setOpen(true);
      ctx.bus.emit('audio:play', { id: 'ui_open', volume: 0.35 });
      return;
    }

    // 휠이 열린 채 쓰러졌다 / 일어났다 → 배치를 그 자리에서 갈아 끼운다
    const downed = ctx.player?.isDowned ?? false;
    if (downed !== this.downed) { this.build(downed); this.dx = 0; this.dy = 0; this.setHover(null, ctx); }

    this.dx += input.mouseDX; this.dy += input.mouseDY;
    this.setHover(this.pick(), ctx);
    this.applyCooldown(ctx);
  }

  /** 누적 델타 → 칸 index (dead zone 안이면 null). 4칸은 가장 가까운 사분면, 2칸은 좌/우 우세 방향. */
  private pick(): number | null {
    if (this.dx * this.dx + this.dy * this.dy < COMMS_WHEEL_DEAD_PX * COMMS_WHEEL_DEAD_PX) return null;
    if (this.layout.length >= 4) {
      // 0 = N (위), 시계방향 — `COMMS_ALIVE` 의 배열 순서가 정확히 N/E/S/W 다
      const ang = Math.atan2(this.dx, -this.dy);
      const n = this.layout.length;
      return ((Math.round(ang / (Math.PI / 2)) % n) + n) % n;
    }
    // 2칸: 좌/우 가로 드래그만 고른다 (세로가 우세하면 아무것도 안 고른다 — 실수로 나가는 것보다 낫다)
    if (Math.abs(this.dx) < Math.abs(this.dy)) return null;
    const want = this.dx > 0 ? 'R' : 'L';
    const i = this.layout.findIndex((d) => d.dir === want);
    return i >= 0 ? i : null;
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    const ctx = this.ctx;
    this.open = open;
    if (open) {
      this.build(ctx?.player?.isDowned ?? false);
      this.dx = 0; this.dy = 0; this.hover = null;
      this.setLookLocked(true);
    } else {
      this.hover = null;
      this.setLookLocked(false);
    }
    toggleClass(this.root, 'show', open);
    this.applyHover();
    if (ctx) {
      this.applyCooldown(ctx);
      ctx.bus.emit('comms:wheelChanged', { open, downed: this.downed, hover: null });
    }
  }

  private setHover(hover: number | null, ctx: GameContext): void {
    if (hover === this.hover) return;
    this.hover = hover;
    this.applyHover();
    ctx.bus.emit('comms:wheelChanged', { open: true, downed: this.downed, hover });
    if (hover !== null) ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.3 });
  }

  /** 키를 놓지 않았는데 쓸 수 없게 됐다 (사망 · 화면 열림 · 미션 리셋): 아무것도 보내지 않고 접는다. */
  private cancel(): void {
    this.held = false;
    this.setOpen(false);
  }

  /**
   * 카메라를 묶는다. `setLookLocked` 는 `PlayerWeaponHost` 의 메서드라 `ctx.player` 에 duck-type 으로 붙는다
   * (그 인터페이스를 import 하면 player/ 를 들여다보는 셈이다). **우리가 건 락만 우리가 푼다.**
   */
  private setLookLocked(locked: boolean): void {
    if (locked === this.lookLocked) return;
    const p = this.ctx?.player as ({ setLookLocked?(v: boolean): void } | null | undefined);
    if (!p || typeof p.setLookLocked !== 'function') return;
    this.lookLocked = locked;
    p.setLookLocked(locked);
  }

  /* ── 보내기 · 받기 ──────────────────────────────────────────────────────── */

  private send(ctx: GameContext, def: CommsDef | undefined): void {
    if (!def) return;
    if (ctx.time - this.lastSent < COMMS_COOLDOWN_S) { ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 }); return; }
    this.lastSent = ctx.time;

    const text = fillCommsLine(def, this.varsFor(ctx, def.id));
    const net = ctx.net;
    ctx.bus.emit('comms:sent', {
      id: def.id, text, by: null,
      byName: net?.playerName ?? '나',
      slot: net?.localSlot ?? 0,
      position: ctx.player ? ctx.player.position.clone() : null,
    });
    if (net && (ctx.isMultiplayer || net.lobby)) {
      const msg: CommsMessage = { t: 'comm', id: def.id, text };
      net.send(msg, 'others');
    }
  }

  /**
   * `{n}` · `{name}` 채우기. 지금 그런 항목은 `contract` 하나뿐 — `ctx.meta.activeContract` 에서 계약 이름과
   * 남은 건수를 읽는다 (`CONTRACT_MAX_ACTIVE` 가 1이라 진행 중인 계약은 최대 하나다). 없으면 undefined 를
   * 돌려주고 `fillCommsLine` 이 `fallback` 을 고른다. meta/ 폴더 내부는 보지 않는다 — `ctx.meta` 계약만이다.
   */
  private varsFor(ctx: GameContext, id: CommsId): { n?: number; name?: string } | undefined {
    if (id !== 'contract') return undefined;
    const info = ctx.meta?.activeContract ?? null;
    if (!info) return undefined;
    return { name: info.def.name, n: Math.max(0, info.def.target - info.progress) };
  }

  private onRemote(msg: CommsMessage, from: PeerId): void {
    const ctx = this.ctx;
    const net = ctx?.net;
    if (!ctx || !net) return;
    const def = typeof msg.id === 'string' ? COMMS_DEF_MAP.get(msg.id) : undefined;
    if (!def) return;
    const text = typeof msg.text === 'string' && msg.text.length ? msg.text.slice(0, 120) : def.fallback ?? def.line;
    const lp = net.getLobbyPlayer(from);
    const ref = net.getRemotePlayer(from);
    ctx.bus.emit('comms:sent', {
      id: def.id, text, by: from,
      byName: lp?.name ?? ref?.name ?? '분대원',
      slot: lp?.slot ?? ref?.slot ?? 0,
      position: ref ? ref.position.clone() : null,
    });
  }

  /**
   * `comms:sent` 하나에서 채팅 한 줄과 토스트를 만든다. 로컬만 `chat:post` 를 쏜다 — `ChatLog` 가 내 이름을
   * 붙이고 그 줄을 분대에 중계하므로, 원격에서 또 쏘면 같은 문장이 두 줄이 된다 (핑 v3 와 같은 규약).
   */
  private announce(ctx: GameContext, e: { text: string; by: PeerId | null; byName: string }): void {
    if (e.by === null) { ctx.bus.emit('chat:post', { text: e.text, kind: 'request' }); return; }
    ctx.bus.emit('ui:notify', { text: `${e.byName}: ${e.text}`, kind: 'warning', duration: 2.4 });
  }

  /* ── 그리기 ─────────────────────────────────────────────────────────────── */

  /** 배치가 바뀔 때만 부른다 (열 때 · 전투불능 전환). 칸 수가 2 ↔ 4 로 갈리므로 DOM 을 다시 만든다. */
  private build(downed: boolean): void {
    const next = commsLayout(downed);
    if (this.layout === next && this.sectors.length) { this.downed = downed; return; }
    this.downed = downed;
    this.layout = next;
    toggleClass(this.root, 'downed', downed);

    const svgNS = 'http://www.w3.org/2000/svg';
    this.svg.replaceChildren();
    this.items.replaceChildren();
    this.sectors = [];
    const half = spreadOf(next.length) / 2;

    for (const def of next) {
      const a = DIR_DEG[def.dir] ?? 0;
      const arc = document.createElementNS(svgNS, 'path');
      arc.setAttribute('class', 'carc');
      arc.setAttribute('d', sectorPath(a - half + SECTOR_GAP_DEG / 2, a + half - SECTOR_GAP_DEG / 2));
      this.svg.appendChild(arc);

      const t = ((a - 90) * Math.PI) / 180;
      const root = el('div', { cls: `csector ${def.id}`, parent: this.items });
      root.style.left = `${(50 + (LABEL_RADIUS * Math.cos(t) * 100) / SIZE).toFixed(2)}%`;
      root.style.top = `${(50 + (LABEL_RADIUS * Math.sin(t) * 100) / SIZE).toFixed(2)}%`;
      root.style.setProperty('--cc', def.color);
      const label = el('span', { cls: 'nm', text: def.label, parent: root });
      const dir = el('span', { cls: 'dir', text: def.dir === 'L' ? '◄' : def.dir === 'R' ? '►' : def.dir, parent: root });
      this.sectors.push({ arc, root, label, dir });
    }
    this.applyHover();
  }

  private applyHover(): void {
    for (let i = 0; i < this.sectors.length; i++) {
      const on = this.hover === i;
      toggleClass(this.sectors[i].root, 'hover', on);
      tc(this.sectors[i].arc, 'hover', on);
    }
    const def = this.hover !== null ? this.layout[this.hover] : null;
    setText(this.nameEl, def ? def.label : '—');
    toggleClass(this.nameEl, 'dim', !def);
    setText(this.subEl, `마우스로 선택 · ${keyLabel(Keys.COMMS)} 놓기`);
  }

  private applyCooldown(ctx: GameContext): void {
    const left = COMMS_COOLDOWN_S - (ctx.time - this.lastSent);
    const cooling = this.open && left > 0;
    toggleClass(this.root, 'cooling', cooling);
    setText(this.cdEl, cooling ? `재충전 ${Math.ceil(left)}초` : '');
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.setLookLocked(false);
    this.root.remove();
  }
}
