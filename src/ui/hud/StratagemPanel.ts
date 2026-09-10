import type { GameContext, StratagemId } from '@/shared';
import { Keys, RESCUE_DROPS_PER_RAID, STRATAGEM_ORDER, keyLabel, onKeybindsChanged } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { STRATAGEM_COLOR, STRATAGEM_GLYPH } from './stratagemGlyphs';
import '../styles/shipCall.css';

/**
 * 함선 호출 썸네일 (`.scall`) — **전술 임플란트 바로 왼쪽**, 화면 중앙 하단.
 *
 * 2026-09-10 (2차, 사용자 결정): 우측 하단 무기 열의 텍스트 패널(`.strat-panel` — `G` 키캡 + 호출 이름 +
 * 설명 한 줄 + 조작 힌트 + 가로 쿨다운 바)을 통째로 걷어내고 **정사각 썸네일 하나**로 바꿨다. 글자는 전부
 * 없앴다 — 썸네일 + 그 아래 `G` 키캡뿐이고, 무장하면 썸네일 테두리 · 키캡이 그 호출의 색(`STRATAGEM_COLOR`)
 * 으로 밝아진다. 조작 힌트가 필요하면 `G` 를 꾹 눌러 휠을 열면 된다(휠 가운데가 설명을 그린다).
 *
 * **쿨타임은 임플란트와 똑같이 그린다** (`hud/ImplantWidget.renderCooldown` 와 같은 규칙): 쿨타임 중에는
 * 썸네일이 딤드되고 `--fill` 이 아래에서 위로 차오르며 밝아지고, 한가운데에 남은 초가 뜬다 (10초 미만은
 * 소수 한 자리 — `secs`). 함선 호출은 **네 종류가 하나의 쿨타임을 공유**하므로(`StratagemSystem._cooldown`)
 * 썸네일 하나가 곧 전체 상태다. 쿨타임 길이는 `data/stratagems.csv` 의 `cooldown` 이고, 마지막으로 쓴
 * 호출의 값이 넷 모두를 잠근다 (2026-09-10: 구조선 30 · 보급품/트라이포드 90 · 궤도 폭격 120).
 *
 * **어느 글리프를 그리나.** 무장 중이면 그 호출, 아니면 **마지막으로 무장했던 호출**이다 — `G` 탭이 바로
 * 그것을 다시 무장하기 때문이다 (`stratagems/parts/Targeting`: `sys.arm(sys.lastArmed)`). 처음 값은 시스템과
 * 같은 `STRATAGEM_ORDER[0]` 이고, `stratagem:armed` 의 null 이 아닌 id 를 볼 때마다 갱신한다 — `lastArmed`
 * 를 `StratagemsRef` 에 새로 뚫지 않고 이미 흐르는 이벤트로 같은 값을 만든다.
 *
 * 구조선을 손에 들었을 때만 우측 하단에 **분대 공용 잔여 횟수**(`rescue:countChanged`)가 붙는다.
 * `ctx.stratagems` 가 없고 이벤트도 아직 없으면 통째로 숨는다(`.off`).
 */
export class StratagemPanel {
  readonly root: HTMLElement;
  private thumb: HTMLElement;
  private faceBase: HTMLElement;
  private reveal: HTMLElement;
  private faceLit: HTMLElement;
  private cdEl: HTMLElement;
  private chEl: HTMLElement;
  private keyEl: HTMLElement;

  private armed: StratagemId | null = null;
  /** `G` 탭이 무장할 호출 — 시스템의 `lastArmed` 와 같은 값을 이벤트로 따라 만든다. */
  private lastArmed: StratagemId = STRATAGEM_ORDER[0];
  private targeting = false;
  private remaining = 0;
  private total = 0;
  private seen = false;
  private fill = 0;
  private dimmed = false;
  private lastKey = '';
  private unsubs: Array<() => void> = [];
  /** 2026-09-09: 분대 공용 구조선 잔여 횟수 (`rescue:countChanged`, 없으면 만재로 본다). */
  private rescueLeft = RESCUE_DROPS_PER_RAID;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'scall off', parent });
    this.thumb = el('div', { cls: 'sc-thumb', parent: this.root });
    // 같은 얼굴 두 장: 딤드된 바탕과, 밑에서부터 잘려 드러나는 밝은 사본 (implant.css 와 같은 수법)
    this.faceBase = el('div', { cls: 'sb-face', text: '', parent: this.thumb });
    this.reveal = el('div', { cls: 'sb-reveal', parent: this.thumb });
    this.faceLit = el('div', { cls: 'sb-face lit', text: '', parent: this.reveal });
    this.cdEl = el('div', { cls: 'sc-cd ui-mono', text: '', parent: this.thumb });
    this.chEl = el('div', { cls: 'sc-ch ui-mono', text: '', parent: this.thumb });
    this.keyEl = el('kbd', { cls: 'keycap sc-key', text: keyLabel(Keys.SHIP_CALL), parent: this.root });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    const syncKey = (): void => setText(this.keyEl, keyLabel(Keys.SHIP_CALL));
    this.unsubs.push(
      b.on('input:bindingsChanged', syncKey),
      onKeybindsChanged(syncKey),
      b.on('stratagem:armed', ({ id }) => {
        this.armed = id;
        if (id) { this.lastArmed = id; this.flash(); }
        this.seen = true; this.render();
      }),
      b.on('stratagem:targeting', ({ active }) => { this.targeting = active; this.render(); }),
      b.on('stratagem:cooldown', ({ remaining, total }) => {
        this.seen = true;
        this.remaining = Math.max(0, remaining); this.total = Math.max(this.total, total, 0);
        if (remaining <= 0) this.total = total;
        this.render();
      }),
      b.on('rescue:countChanged', ({ left }) => { this.rescueLeft = Math.max(0, left); this.seen = true; this.render(); }),
      b.on('game:newMission', () => this.resetTransient()),
      b.on('game:abort', () => this.resetTransient()),
      b.on('player:died', () => { this.armed = null; this.targeting = false; this.render(); }),
    );
  }

  private resetTransient(): void {
    this.armed = null; this.targeting = false;
    this.rescueLeft = RESCUE_DROPS_PER_RAID;
    this.render();
  }

  /** Restart the one-shot arm animation (remove → reflow → add is the only reliable way). */
  private flash(): void {
    this.root.classList.remove('pulse');
    void this.root.offsetWidth;
    this.root.classList.add('pulse');
  }

  update(ctx: GameContext): void {
    const s = ctx.stratagems;
    if (s) {
      if (!this.seen) { this.seen = true; this.render(); }
      // Smooth the fill between the 0.5 s cooldown events.
      const rem = Math.max(0, s.cooldown), tot = s.cooldownTotal > 0 ? s.cooldownTotal : this.total;
      if (Math.abs(rem - this.remaining) > 0.01 || tot !== this.total) {
        this.remaining = rem; this.total = tot;
        this.render();
      }
      if (s.rescueLeft !== this.rescueLeft) { this.rescueLeft = Math.max(0, s.rescueLeft); this.render(); }
    }
    // hidden with the other crosshair widgets while any UI blocker is up
    const blocked = ctx.uiBlockers.size > 0;
    if (this.root.classList.contains('blocked') !== blocked) toggleClass(this.root, 'blocked', blocked);
  }

  /** Seconds text: one decimal under 10 s, whole seconds above — the same rule as `hud/ImplantWidget`. */
  private secs(t: number): string { return t.toFixed(t < 10 ? 1 : 0); }

  private render(): void {
    const id = this.armed ?? this.lastArmed;
    const ready = this.remaining <= 0.001;
    const fill = ready ? 0 : this.total > 0 ? 1 - Math.min(1, this.remaining / this.total) : 1;
    const cd = ready ? '' : this.secs(this.remaining);
    // 잔여 횟수는 구조선을 손에 들었을 때만 — 다른 호출을 든 채로 남의 숫자를 보여 주지 않는다.
    const ch = this.armed === 'rescue_drop' ? `${this.rescueLeft}/${RESCUE_DROPS_PER_RAID}` : '';
    const key = `${this.seen ? 1 : 0}|${id}|${this.armed ? 1 : 0}|${this.targeting ? 1 : 0}|${fill.toFixed(3)}|${cd}|${ch}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.fill = fill; this.dimmed = !ready;

    toggleClass(this.root, 'off', !this.seen);
    toggleClass(this.root, 'armed', this.armed !== null);
    toggleClass(this.root, 'targeting', this.targeting);
    toggleClass(this.root, 'dim', !ready);
    toggleClass(this.root, 'spent', ch !== '' && this.rescueLeft <= 0);
    this.root.style.setProperty('--sc', STRATAGEM_COLOR[id]);
    this.root.style.setProperty('--fill', fill.toFixed(3));
    this.root.dataset.call = id;
    const glyph = STRATAGEM_GLYPH[id];
    setText(this.faceBase, glyph);
    setText(this.faceLit, glyph);
    setText(this.cdEl, cd);
    setText(this.chEl, ch);
  }

  /** Whether a call is armed (debug). */
  get armedId(): StratagemId | null { return this.armed; }
  /** Call whose glyph the thumbnail is drawing right now (debug / smoke). */
  get shownId(): StratagemId { return this.armed ?? this.lastArmed; }
  /** 0…1 bottom-up cooldown fill (debug / smoke). */
  get fillAmount(): number { return this.fill; }
  /** Whether the thumbnail is dimmed = on cooldown (debug / smoke). */
  get isDimmed(): boolean { return this.dimmed; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
