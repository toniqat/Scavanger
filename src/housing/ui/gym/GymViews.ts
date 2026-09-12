/**
 * src/housing/ui/gym/GymViews.ts — 운동 미니게임 3종의 **무대**(`.gym-stage`). 판정 객체(`parts/GymGames`)를 그리기만 한다.
 *
 * 매 틱 `paint()` 는 스타일 속성 몇 개(`left` · `--x` · `--f`)와 클래스만 고쳐 쓴다 — DOM 은 만들 때 한 번 짓는다.
 *   • 벤치프레스: 굵은 가로 바 + 성공 구역(가운데) + 완벽 구역 + 왕복하는 원형 커서 + 회차 칸.
 *   • 호흡 달리기 · 사이클링: 오른쪽에서 흘러와 판정선에 닿는 표식 (호흡 = 한 줄, 「하」 는 길이가 있는 알약 ·
 *     사이클 = 왼발 / 오른발 두 줄, 줄 머리에 키캡).
 * 키 이름은 사용 시점에 `Keys` 에서 읽는다 (`relabel` — `input:bindingsChanged`).
 */
import { GYM_PRESS_PERFECT, GYM_PRESS_ZONE, Keys, keyLabel } from '@/shared';
import { BreathGame, CycleGame, GYM_LEAD_BEATS, PressGame } from '../../parts/GymGames';
import type { BeatNote, GymAction, GymGame, GymQuality } from '../../parts/GymGames';
import { el, setText, toggleClass } from '../dom';

export interface GymView {
  readonly root: HTMLElement;
  paint(): void;
  judged(quality: GymQuality, index: number): void;
  input(action: GymAction, down: boolean): void;
  relabel(): void;
  dispose(): void;
}

const QUALITY_CLASSES = ['is-perfect', 'is-good', 'is-miss'];

/** 한 번 켜는 CSS 애니메이션을 처음부터 다시 튼다. */
export function replayClass(e: HTMLElement, cls: string): void {
  e.classList.remove(cls);
  void e.offsetWidth;
  e.classList.add(cls);
}

function setQuality(e: HTMLElement, q: GymQuality | null): void {
  const want = q ? `is-${q}` : '';
  for (const c of QUALITY_CLASSES) toggleClass(e, c, c === want);
}

/* ── 벤치프레스 ──────────────────────────────────────────────────────────── */
class PressView implements GymView {
  readonly root: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly cursor: HTMLElement;
  private readonly pips: HTMLElement[] = [];
  private lastLeft = '';

  constructor(private readonly game: PressGame, parent: HTMLElement) {
    this.root = el('div', { cls: 'gym-stage gym-press', parent });
    this.bar = el('div', { cls: 'gym-press-bar', parent: this.root });
    el('i', { cls: 'gym-press-zone', parent: this.bar }).style.width = `${(GYM_PRESS_ZONE * 200).toFixed(2)}%`;
    el('i', { cls: 'gym-press-perfect', parent: this.bar }).style.width = `${(GYM_PRESS_PERFECT * 200).toFixed(2)}%`;
    el('i', { cls: 'gym-press-mid', parent: this.bar });
    this.cursor = el('i', { cls: 'gym-press-cursor', parent: this.bar });
    const row = el('div', { cls: 'gym-pips', parent: this.root });
    for (let i = 0; i < game.total; i++) this.pips.push(el('i', { cls: 'gym-pip', parent: row }));
    this.paint();
  }

  paint(): void {
    const g = this.game;
    const left = `${(g.pos * 100).toFixed(2)}%`;
    if (left !== this.lastLeft) { this.cursor.style.left = left; this.lastLeft = left; }
    toggleClass(this.cursor, 'in-zone', Math.abs(g.pos - 0.5) <= GYM_PRESS_ZONE);
    const now = g.judgements.length;
    this.pips.forEach((p, i) => toggleClass(p, 'is-now', i === now && !g.done));
  }

  judged(q: GymQuality, index: number): void {
    const p = this.pips[index];
    if (p) setQuality(p, q);
    for (const c of ['hit-perfect', 'hit-good', 'hit-miss']) this.bar.classList.remove(c);
    replayClass(this.bar, `hit-${q}`);
  }

  input(action: GymAction, down: boolean): void {
    if (action === 'jump') toggleClass(this.cursor, 'is-down', down);
  }

  relabel(): void { /* 키캡 없음 — 키 이름은 머리줄 · 키 가이드가 말한다 */ }
  dispose(): void { this.root.remove(); }
}

/* ── 박자 게임 (호흡 · 사이클) ───────────────────────────────────────────── */
interface LaneEls { lane: HTMLElement; key: HTMLElement; action: GymAction }
interface NoteEls { note: BeatNote; el: HTMLElement; label: HTMLElement; q: GymQuality | null; off: boolean }

class BeatView implements GymView {
  readonly root: HTMLElement;
  private readonly lanes: LaneEls[] = [];
  private readonly notes: NoteEls[] = [];
  /** 판정선에서 오른쪽 끝까지 몇 초인가 — 첫 표식이 시작하자마자 오른쪽 끝 가까이에 보이게 예비 박자 + 1 박. */
  private readonly look: number;
  private readonly holdLen: number;

  constructor(private readonly game: BreathGame | CycleGame, parent: HTMLElement) {
    const breath = game instanceof BreathGame;
    this.root = el('div', { cls: `gym-stage gym-beat ${breath ? 'gym-breath' : 'gym-cycle'}`, parent });
    this.look = game.beat * (GYM_LEAD_BEATS + 1);
    this.holdLen = breath ? (game as BreathGame).holdS / this.look : 0;
    const track = el('div', { cls: 'gym-lanes', parent: this.root });
    const laneDefs: Array<{ id: string; action: GymAction }> = breath
      ? [{ id: 'breath', action: 'jump' }]
      : [{ id: 'left', action: 'left' }, { id: 'right', action: 'right' }];
    for (const d of laneDefs) {
      const row = el('div', { cls: 'gym-lane-row', parent: track });
      const key = el('span', { cls: 'keycap gym-lane-key', parent: row });
      const lane = el('div', { cls: 'gym-lane', parent: row });
      lane.dataset.lane = d.id;
      el('i', { cls: 'gym-judge', parent: lane });
      this.lanes.push({ lane, key, action: d.action });
    }
    for (const n of game.notes) {
      const host = breath ? this.lanes[0].lane : this.lanes[n.lane === 'right' ? 1 : 0].lane;
      const e = el('div', { cls: `gym-note${n.hold ? ' is-hold' : ''}`, parent: host });
      if (n.hold) { e.style.setProperty('--len', this.holdLen.toFixed(4)); el('i', { cls: 'gym-note-fill', parent: e }); }
      const label = el('span', { cls: 'gym-note-label', parent: e });
      this.notes.push({ note: n, el: e, label, q: null, off: false });
    }
    this.relabel();
    this.paint();
  }

  paint(): void {
    const g = this.game;
    const t = g.time;
    const next = g.upcoming;
    for (const ne of this.notes) {
      const n = ne.note;
      const x = (n.t - t) / this.look;
      const off = x + (n.hold ? this.holdLen : 0) < -0.12 || x > 1.02;
      if (off !== ne.off) { ne.off = off; toggleClass(ne.el, 'is-off', off); }
      if (off) continue;
      ne.el.style.setProperty('--x', x.toFixed(4));
      if (ne.q !== n.q) { ne.q = n.q; setQuality(ne.el, n.q); }
      toggleClass(ne.el, 'is-next', n === next);
      if (n.hold) {
        const holding = n.q === null && n.start !== null;
        toggleClass(ne.el, 'is-holding', holding);
        const f = holding ? Math.max(0, Math.min(1, (t - n.t) / (g as BreathGame).holdS)) : n.q && n.q !== 'miss' ? 1 : 0;
        ne.el.style.setProperty('--f', f.toFixed(3));
      }
    }
  }

  judged(q: GymQuality): void {
    for (const l of this.lanes) {
      for (const c of ['hit-perfect', 'hit-good', 'hit-miss']) l.lane.classList.remove(c);
      replayClass(l.lane, `hit-${q}`);
    }
  }

  input(action: GymAction, down: boolean): void {
    for (const l of this.lanes) if (l.action === action) toggleClass(l.key, 'is-down', down);
  }

  relabel(): void {
    const keyOf = (a: GymAction): string => keyLabel(a === 'jump' ? Keys.JUMP : a === 'left' ? Keys.LEFT : Keys.RIGHT);
    for (const l of this.lanes) setText(l.key, keyOf(l.action));
    for (const ne of this.notes) {
      const n = ne.note;
      setText(ne.label, n.lane ? keyOf(n.lane) : n.hold ? '하' : '후');
    }
  }

  dispose(): void { this.root.remove(); }
}

export function createGymView(game: GymGame, parent: HTMLElement): GymView {
  if (game instanceof PressGame) return new PressView(game, parent);
  if (game instanceof BreathGame || game instanceof CycleGame) return new BeatView(game, parent);
  throw new Error(`[housing] unknown gym game ${game.minigame}`);
}
