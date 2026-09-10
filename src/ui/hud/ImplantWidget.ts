import type { GameContext, ImplantDef, ImplantId } from '@/shared';
import { Keys, keyLabel, onKeybindsChanged } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import '../styles/implant.css';

/** How the thumbnail draws the implant's state. */
export type ImplantHudKind = 'cooldown' | 'charges' | 'gauge';

/**
 * 전술 임플란트 썸네일 — **화면 중앙 하단, 스태미나 바 아래** (`.imp-hud`, 2026-09-10).
 *
 * 2026-09-06 의 크로스헤어 좌측 세로 게이지(`.implant-gauge`)를 대신한다. 조준점 주위에서 쿨타임 · 충전 수를
 * 읽게 하지 않는다는 사용자 결정이라 **숫자 · 게이지가 전부 이리로 내려왔고** 크로스헤어에는 갈고리 표시만
 * 남는다 (`hud/Reticle`). **이름은 적지 않는다** — 가로로 긴 썸네일 + 그 아래 사용 키(`Keys.IMPLANT`)뿐이다.
 *
 * 표시 유형은 셋이고, 어느 임플란트가 어디에 속하는지는 **`ctx.implants` 가 주는 값**으로 정한다
 * (`maxCharges` · `barrierMaxHp` · `energyMax` — 코드에 수치를 적지 않는다):
 *
 *   - **쿨타임형** (갈고리 · 정찰 · 대전차포): 쿨타임 중에는 썸네일이 딤드되고 `--fill` 이 아래에서 위로
 *     차오르며 밝아진다. 중앙에 남은 초.
 *   - **충전형** (대시): 우측 하단에 충전 수. 0 이면 쿨타임형과 같은 딤드 + 밝아짐(중앙에 남은 초),
 *     1 개 이상이면 딤드 없이 **강조색이 아래에서 위로** 차오르며 다음 충전을 보여 주고, 최대면 정상 표기.
 *   - **게이지형** (배리어 내구도 · 오버차지 에너지): 썸네일 안 중앙 하단의 가로 게이지. 배리어가 붕괴해
 *     잠긴 동안은(`barrierLockout`) 쿨타임형과 같은 딤드 + 밝아짐 + 남은 초로 그린다 — 잠금 시간에 맞춰
 *     내구도가 0 → 만충으로 차오르므로 게이지가 그대로 진행도다.
 *
 * 값은 매 프레임 `ctx.implants` 에서 읽고 이벤트(`implant:*`)는 늦은 등록 · 연출(플래시 · 피격)에만 쓴다.
 * 아무것도 장착하지 않았거나 전투불능이면 숨는다 (전투불능 화면은 출혈 / 포기 링의 것이다, 2026-09-08).
 */
export class ImplantWidget {
  readonly root: HTMLElement;
  private thumb: HTMLElement;
  private reveal: HTMLElement;
  private cdEl: HTMLElement;
  private chEl: HTMLElement;
  private gauge: HTMLElement;
  private gaugeFill: HTMLElement;
  private faceBase: HTMLElement;
  private faceLit: HTMLElement;
  private keyEl: HTMLElement;

  private ctx!: GameContext;
  private equipped: ImplantId | null = null;
  private def: ImplantDef | null = null;
  private remaining = 0;
  private total = 0;
  private charges = 1;
  private maxCharges = 1;
  private wielded = false;
  private holding = false;
  private barrierHp = 0;
  private barrierMax = 0;
  private barrierLockout = 0;
  private energy = 0;
  private energyMax = 0;
  private kind: ImplantHudKind = 'cooldown';
  private fill = 0;
  private dimmed = false;
  private lastKey = '';
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'imp-hud', parent });
    this.root.hidden = true;
    this.thumb = el('div', { cls: 'imp-thumb', parent: this.root });
    // two copies of the same face: the dim base and the bright one the reveal clips from the bottom up
    this.faceBase = el('div', { cls: 'ib-face', text: '◈', parent: this.thumb });
    this.reveal = el('div', { cls: 'ib-reveal', parent: this.thumb });
    this.faceLit = el('div', { cls: 'ib-face lit', text: '◈', parent: this.reveal });
    this.cdEl = el('div', { cls: 'ib-cd ui-mono', text: '', parent: this.thumb });
    this.chEl = el('div', { cls: 'ib-ch ui-mono', text: '', parent: this.thumb });
    this.gauge = el('div', { cls: 'ib-gauge', parent: this.thumb });
    this.gauge.hidden = true;
    this.gaugeFill = el('i', { parent: this.gauge });
    this.keyEl = el('kbd', { cls: 'keycap imp-key', text: keyLabel(Keys.IMPLANT), parent: this.root });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    const syncKey = (): void => setText(this.keyEl, keyLabel(Keys.IMPLANT));
    this.unsubs.push(
      b.on('implant:equipped', ({ id }) => this.setEquipped(id)),
      b.on('implant:cooldownChanged', ({ id, remaining, total, charges, maxCharges }) => {
        if (this.equipped === null) this.setEquipped(id);
        this.remaining = remaining; this.total = total;
        this.charges = charges; this.maxCharges = maxCharges;
      }),
      b.on('implant:wieldChanged', ({ wielded }) => { this.wielded = wielded; toggleClass(this.root, 'wielded', wielded); }),
      b.on('implant:activated', () => this.flash('pulse')),
      b.on('implant:barrierChanged', ({ hp, maxHp }) => { this.barrierHp = hp; this.barrierMax = maxHp; }),
      b.on('implant:barrierHit', () => this.flash('hit')),
      b.on('implant:energyChanged', ({ energy, max }) => { this.energy = energy; this.energyMax = max; }),
      b.on('game:newMission', () => this.resetTransient()),
      b.on('game:abort', () => this.resetTransient()),
      b.on('input:bindingsChanged', syncKey),
      onKeybindsChanged(syncKey),
    );
  }

  /** Restart a one-shot CSS animation (remove → reflow → add is the only reliable way). */
  private flash(cls: 'pulse' | 'hit'): void {
    this.root.classList.remove(cls);
    void this.root.offsetWidth;
    this.root.classList.add(cls);
  }

  private resetTransient(): void {
    this.wielded = false; this.holding = false;
    toggleClass(this.root, 'wielded', false);
    toggleClass(this.root, 'holding', false);
    this.barrierHp = 0; this.barrierMax = 0; this.barrierLockout = 0;
    this.lastKey = '';
  }

  private setEquipped(id: ImplantId | null): void {
    this.equipped = id;
    this.def = id ? (this.ctx.implants?.getDef(id) ?? null) : null;
    this.lastKey = '';
    if (!id) { this.root.hidden = true; return; }
    const icon = this.def?.icon ?? '◈';
    setText(this.faceBase, icon);
    setText(this.faceLit, icon);
    this.root.style.setProperty('--ic', this.def?.color ?? 'var(--c-info)');
    this.root.dataset.implant = id;
    this.root.hidden = false;
  }

  /**
   * Which of the three presentations this implant uses. Decided from the live ref (a charge implant has
   * `maxCharges > 1`, a gauge implant publishes a pool) so a data-only change to `data/implants.csv` follows.
   */
  private kindOf(): ImplantHudKind {
    if (this.equipped === 'barrier' || this.equipped === 'overcharge') return 'gauge';
    const n = this.maxCharges > 0 ? this.maxCharges : (this.def?.charges ?? 1);
    return n > 1 ? 'charges' : 'cooldown';
  }

  update(_dt: number, ctx: GameContext): void {
    const imp = ctx.implants;
    // Late registration: pick the equipped implant up as soon as the system exists.
    if (imp && imp.equipped !== this.equipped) this.setEquipped(imp.equipped);
    if (this.equipped === null) { if (!this.root.hidden) this.root.hidden = true; return; }
    // 2026-09-08: nothing while 전투불능 — the implant is unusable there and that screen belongs to the
    //   bleed-out / 포기 ring. (The widget moved to the bottom centre in 2026-09-10; the rule did not change.)
    if (ctx.player?.isDowned) { if (!this.root.hidden) this.root.hidden = true; return; }
    if (this.root.hidden) this.root.hidden = false;
    if (!this.def && imp) this.def = imp.getDef(this.equipped) ?? null;

    if (imp) {
      this.remaining = imp.cooldownRemaining;
      this.total = imp.cooldownTotal;
      this.charges = imp.charges;
      this.maxCharges = imp.maxCharges;
      this.barrierHp = imp.barrierHp;
      this.barrierMax = imp.barrierMaxHp;
      this.barrierLockout = imp.barrierLockout;
      this.energy = imp.energy;
      this.energyMax = imp.energyMax;
      if (imp.wielded !== this.wielded) { this.wielded = imp.wielded; toggleClass(this.root, 'wielded', this.wielded); }
      if (imp.holding !== this.holding) { this.holding = imp.holding; toggleClass(this.root, 'holding', this.holding); }
    }

    // hidden with the reticle while any UI blocker is up
    const blocked = ctx.uiBlockers.size > 0;
    if (this.root.classList.contains('blocked') !== blocked) toggleClass(this.root, 'blocked', blocked);

    this.kind = this.kindOf();
    if (this.kind === 'charges') this.renderCharges();
    else if (this.kind === 'gauge') this.renderGauge();
    else this.renderCooldown();
  }

  /** Seconds text: one decimal under 10 s, whole seconds above (the old gauge's rule). */
  private secs(t: number): string { return t.toFixed(t < 10 ? 1 : 0); }

  /** Write the whole thumbnail in one go; a rounded key keeps the DOM untouched between real changes. */
  private paint(fill: number, dim: boolean, accent: boolean, cd: string, ch: string, gauge: number, low: boolean): void {
    const f = Math.min(1, Math.max(0, fill));
    const key = `${f.toFixed(3)}|${dim ? 1 : 0}|${accent ? 1 : 0}|${cd}|${ch}|${gauge < 0 ? -1 : gauge.toFixed(3)}|${low ? 1 : 0}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.fill = f; this.dimmed = dim;
    this.root.style.setProperty('--fill', f.toFixed(3));
    toggleClass(this.root, 'dim', dim);
    toggleClass(this.root, 'accent', accent);
    toggleClass(this.root, 'low', low);
    toggleClass(this.root, 'empty', ch === '0');
    setText(this.cdEl, cd);
    setText(this.chEl, ch);
    if (gauge < 0) {
      if (!this.gauge.hidden) this.gauge.hidden = true;
    } else {
      if (this.gauge.hidden) this.gauge.hidden = false;
      this.gaugeFill.style.transform = `scaleX(${Math.min(1, Math.max(0, gauge)).toFixed(3)})`;
    }
  }

  /** 갈고리 / 정찰 / 대전차포: dim + brighten from the bottom while the cooldown runs, seconds in the middle. */
  private renderCooldown(): void {
    const ready = this.charges > 0 && this.remaining <= 0.001;
    const f = ready ? 1 : this.total > 0 ? 1 - Math.min(1, this.remaining / this.total) : 1;
    this.paint(ready ? 0 : f, !ready, false, ready ? '' : this.secs(this.remaining), '', -1, false);
  }

  /** 대시: charge count bottom-right; 0 = the cooldown look, 1…max−1 = accent rising, max = plain. */
  private renderCharges(): void {
    const n = Math.max(1, this.maxCharges);
    const refill = this.total > 0 && this.remaining > 0 ? 1 - Math.min(1, this.remaining / this.total) : 0;
    const ch = `${Math.max(0, this.charges)}`;
    if (this.charges <= 0) { this.paint(refill, true, false, this.secs(this.remaining), ch, -1, false); return; }
    if (this.charges >= n) { this.paint(0, false, false, '', ch, -1, false); return; }
    this.paint(refill, false, true, '', ch, -1, false);
  }

  /** 배리어 내구도 / 오버차지 에너지: a gauge at the bottom centre of the thumbnail. */
  private renderGauge(): void {
    if (this.equipped === 'barrier') {
      const max = this.barrierMax > 0 ? this.barrierMax : 1;
      const r = Math.min(1, Math.max(0, this.barrierHp / max));
      const locked = this.barrierLockout > 0.001;
      // 붕괴 잠금 중에는 내구도가 잠금 시간에 맞춰 0 → 만충으로 차오른다 = 그대로 쿨타임 진행도.
      this.paint(locked ? r : 0, locked, false, locked ? this.secs(this.barrierLockout) : '', '', r, !locked && r < 0.25);
      return;
    }
    const max = this.energyMax > 0 ? this.energyMax : 1;
    const r = Math.min(1, Math.max(0, this.energy / max));
    const empty = r < 0.02;
    this.paint(empty ? r : 0, empty, false, '', '', r, r < 0.15 && !this.holding);
  }

  /** Implant drawn right now, null while hidden (debug / smoke). */
  get shownId(): ImplantId | null { return this.root.hidden ? null : this.equipped; }
  /** Which presentation the thumbnail is using (debug / smoke). */
  get displayKind(): ImplantHudKind { return this.kind; }
  /** 0…1 bottom-up brightening / accent fill (debug / smoke). */
  get fillAmount(): number { return this.fill; }
  /** Whether the thumbnail is dimmed (cooldown / no charge / barrier lockout) (debug / smoke). */
  get isDimmed(): boolean { return this.dimmed; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
