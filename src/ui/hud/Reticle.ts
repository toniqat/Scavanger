import type { GameContext, ImplantId, Stance } from '@/shared';
import { el, setText, toggleClass, damp } from '../dom';

/** Base reticle gap (px) per stance, [hip, ADS]. */
const STANCE_GAP: Record<Stance, [number, number]> = {
  stand: [14, 7],
  crouch: [10, 5],
  prone: [8, 4],
};
const SPRINT_GAP = 18;
const MOVE_BONUS = 2;
const MOVE_SPEED_EPS = 0.5; // m/s of horizontal velocity that counts as "moving"

/**
 * Minimal 4-tick crosshair. Gap depends on stance / aim / sprint / movement, blooms on fire,
 * flashes hitmarkers. Hidden entirely while the scope overlay is showing (and via CSS while `.hud.targeting`); dimmed to
 * 25 % while the quick-use or ship-call wheel is open.
 *
 * Grapple (갈고리, tactical kit): with the grapple implant equipped (it is an instant Q cast, the gun stays in hand)
 * the reticle grows a bracket ring with the anchor distance whenever `implant:grappleTargetChanged {valid}` says the
 * point under the crosshair can be hooked, and keeps it (green) while the wire is attached.
 */
export class Reticle {
  readonly root: HTMLElement;
  private ticks: HTMLElement[] = [];
  private hitmarker: HTMLElement;
  private hook: HTMLElement;
  private hookDist: HTMLElement;
  private implant: ImplantId | null = null;
  private wielded = false;
  private grappleValid = false;
  private grappleDist = 0;
  private lastHookKey = '';
  private gap = 14;
  private targetGap = 14;
  private bloom = 0;
  private aiming = false;
  private scope = false;
  private wheelOpen = false;
  private stratOpen = false;
  private hitTimer = 0;
  private lastGap = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'reticle', parent });
    el('div', { cls: 'dot', parent: this.root });
    // top, bottom (vertical), left, right (horizontal)
    for (let i = 0; i < 4; i++) {
      this.ticks.push(el('div', { cls: `tick ${i < 2 ? 'v' : 'h'}`, parent: this.root }));
    }
    this.hitmarker = el('div', { cls: 'hitmarker', parent: this.root });
    for (let i = 0; i < 4; i++) el('span', { parent: this.hitmarker });
    // Grapple bracket ring (hidden unless the grapple implant is in hand).
    this.hook = el('div', { cls: 'hook', parent: this.root });
    this.hook.hidden = true;
    for (let i = 0; i < 4; i++) el('i', { parent: this.hook });
    this.hookDist = el('span', { cls: 'gdist ui-mono', text: '', parent: this.hook });
    this.apply(14);
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('weapon:fired', () => { this.bloom = Math.min(this.bloom + 6, 22); }),
      b.on('player:aimChanged', ({ aiming }) => { this.aiming = aiming; }),
      b.on('weapon:scopeChanged', ({ scope }) => { this.scope = scope; }),
      b.on('quick:wheelChanged', ({ open }) => { this.wheelOpen = open; }),
      b.on('stratagem:wheelChanged', ({ open }) => { this.stratOpen = open; }),
      b.on('ui:hitmarker', ({ kill }) => {
        this.hitmarker.classList.remove('show', 'kill');
        // force restart of transition
        void this.hitmarker.offsetWidth;
        this.hitmarker.classList.add('show');
        if (kill) this.hitmarker.classList.add('kill');
        this.hitTimer = kill ? 0.22 : 0.12;
      }),
      // ── grapple crosshair state ──
      b.on('implant:equipped', ({ id }) => { this.implant = id; this.syncHook(); }),
      b.on('implant:wieldChanged', ({ id, wielded }) => { this.implant = id; this.wielded = wielded; this.syncHook(); }),
      b.on('implant:grappleTargetChanged', ({ valid, distance }) => {
        this.grappleValid = valid; this.grappleDist = distance;
        this.syncHook();
      }),
      b.on('implant:grappleAttached', () => { toggleClass(this.hook, 'attached', true); this.lastHookKey = ''; this.syncHook(); }),
      b.on('implant:grappleReleased', () => { toggleClass(this.hook, 'attached', false); this.lastHookKey = ''; this.syncHook(); }),
      b.on('game:newMission', () => { this.wielded = false; this.grappleValid = false; this.syncHook(); }),
      b.on('game:abort', () => { this.wielded = false; this.grappleValid = false; this.syncHook(); }),
    );
  }

  private syncHook(): void {
    // The grapple is an instant implant (gun in hand): the bracket appears only while the anchor is hookable
    // or the wire is attached, so the crosshair stays clean otherwise.
    const show = this.implant === 'grapple' && (this.grappleValid || this.hook.classList.contains('attached'));
    const key = `${show ? 1 : 0}|${this.grappleValid ? 1 : 0}|${show && this.grappleValid ? Math.round(this.grappleDist) : -1}`;
    if (key === this.lastHookKey) return;
    this.lastHookKey = key;
    if (this.hook.hidden === show) this.hook.hidden = !show;
    if (!show) return;
    toggleClass(this.hook, 'valid', this.grappleValid);
    setText(this.hookDist, this.grappleValid ? `${Math.round(this.grappleDist)}m` : '');
  }

  update(dt: number, ctx: GameContext): void {
    const p = ctx.player;
    const sprinting = p?.isSprinting ?? false;
    const stance: Stance = p?.stance ?? 'stand';
    const v = p?.velocity;
    const moving = !!v && (v.x * v.x + v.z * v.z) > MOVE_SPEED_EPS * MOVE_SPEED_EPS;

    let base: number;
    if (sprinting && !this.aiming) base = SPRINT_GAP;
    else {
      const g = STANCE_GAP[stance] ?? STANCE_GAP.stand;
      base = this.aiming ? g[1] : g[0];
      if (moving) base += MOVE_BONUS;
    }
    this.bloom = damp(this.bloom, 0, 9, dt);
    this.targetGap = base + this.bloom;
    this.gap = damp(this.gap, this.targetGap, 18, dt);
    this.apply(this.gap);

    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitmarker.classList.remove('show');
    }
    // Late-registered implant system / missed events: adopt the live state.
    const imp = ctx.implants;
    if (imp && (imp.equipped !== this.implant || imp.wielded !== this.wielded)) {
      this.implant = imp.equipped; this.wielded = imp.wielded;
      this.syncHook();
    }

    const scoped = this.scope && this.aiming;
    // Hidden behind blockers / the scope; dimmed while the quick-use wheel is open.
    const opacity = ctx.uiBlockers.size > 0 || scoped ? '0' : (this.wheelOpen || this.stratOpen) ? '0.25' : '1';
    if (this.root.style.opacity !== opacity) this.root.style.opacity = opacity;
  }

  private apply(gap: number): void {
    if (Math.abs(gap - this.lastGap) < 0.05) return;
    this.lastGap = gap;
    const g = gap.toFixed(2);
    this.ticks[0].style.transform = `translate(0, ${-gap - 8}px)`;
    this.ticks[1].style.transform = `translate(0, ${g}px)`;
    this.ticks[2].style.transform = `translate(${-gap - 8}px, 0)`;
    this.ticks[3].style.transform = `translate(${g}px, 0)`;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
