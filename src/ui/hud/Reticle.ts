import type { GameContext, ImplantId, ItemInstance, Stance } from '@/shared';
import { Keys, createKeycap, onKeybindsChanged, paintKeycap } from '@/shared';
/* 2026-09-16: how long the crosshair takes to appear after the intro wake cutscene */
import { TUTORIAL_RETICLE_FADE_S } from '@/shared';
import { el, setText, toggleClass, damp } from '../dom';
import '../styles/implant.css';

/** Base reticle gap (px) per stance, [hip, ADS]. */
const STANCE_GAP: Record<Stance, [number, number]> = {
  stand: [14, 7],
  crouch: [10, 5],
  prone: [8, 4],
};
const SPRINT_GAP = 18;
/** Fallback glyph for the grapple chip when `ctx.implants` is not up yet (`IMPLANT_DEFS.grapple.icon`). */
const GRAPPLE_GLYPH = '⚓';
const MOVE_BONUS = 2;
const MOVE_SPEED_EPS = 0.5; // m/s of horizontal velocity that counts as "moving"
/**
 * Bow mode (2026-09-14): the two static guide bars' offsets below the centre (px, [upper, lower]). The moving draw bar
 * parks on the **lower** one and rises to 0 (= the centre) at full draw — this array is the one source of those
 * positions (the CSS only gives widths).
 */
const BOW_TIER_Y: readonly [number, number] = [12, 24];
const BOW_LOW_Y = BOW_TIER_Y[1];
/** Damp rates for the draw bar: following the live draw `t`, and settling back to the lower tier on release. */
const BOW_FOLLOW_LAMBDA = 30;
const BOW_RETURN_LAMBDA = 12;
/** Smoothed draw above this (with the live `t` at 1) lights the full-draw glow. */
const BOW_FULL_EPS = 0.985;
/**
 * Defib mode (2026-09-15): the small circle's scale at charge 0 — at 1 it overlaps the big circle exactly (CSS draws
 * both at the same real diameter). Being a transform scale, the border thickens with it = 「the circle gets thicker」.
 */
const DEFIB_MIN_SCALE = 0.25;
/** Damp rate following the charge gauge (the same way as the bow draw — it smooths values arriving at 30 Hz). */
const DEFIB_LAMBDA = 26;

/**
 * Minimal 4-tick crosshair. Gap depends on stance / aim / sprint / movement, blooms on fire,
 * flashes hitmarkers. Hidden entirely while the scope overlay is showing (and via CSS while `.hud.targeting`); dimmed to
 * 25 % while the quick-use or ship-call wheel is open.
 *
 * Grapple (갈고리, tactical kit): with the grapple implant equipped (it is an instant Q cast, the gun stays in hand)
 * the reticle grows a bracket ring with the anchor distance whenever `implant:grappleTargetChanged {valid}` says the
 * point under the crosshair can be hooked, and keeps it (green) while the wire is attached.
 *
 * **Consumable mode (2026-09-09):** while a quick-use consumable is in the hands (`quick:equipped {item}` — grenades ·
 * gadgets · healing consumables) the four ticks hide (`.reticle.consumable`, CSS) and only the dot stays, with a small
 * mono readout to its **right** (`.qinfo`): the stack count `×n` and, for an item with its own gauge (`회복 스프레이` —
 * `ItemDef.durabilityMax` on the def, `ItemInstance.durability` on the instance), the remaining gauge as `n%`
 * (`×2 · 62%` when both apply). The live instance is re-read from `ctx.inventory.findItem(uid)` only when something
 * that can change it fires (`quick:used` · `inventory:itemUpdated` · `inventory:quickSlotsChanged` · `durability:changed`),
 * never per frame. `quick:equipped {item: null}` (the gun is back) restores the normal crosshair; so does a mission reset.
 *
 * **Grapple chip (2026-09-10):** a grapple icon + the use key (`Keys.IMPLANT`) sit **left** of the crosshair — with a
 * hookable point in the aimed direction the icon is bright and the keycap shows, without one **the key hides and only
 * the dimmed icon** stays, and with no grapple equipped there is nothing at all. The UI never imitates the judgement:
 * the one and only ground is **`implant:grappleTargetChanged {valid}`**, which implants/'s `updateGrapple` computes
 * every frame from its own aim ray (= the same value `castGrapple` reads as `grappleTargetValid`), and not one raycast
 * is fired here. Implant cooldown · charges are not on this chip — all of that went down to the
 * `hud/ImplantWidget` thumbnail at the bottom centre of the screen.
 *
 * **Blocked muzzle (2026-09-12):** when the muzzle catches a wall · window frame · cover a few m ahead so the shot will
 * not follow the crosshair, the dot and ticks turn red (`.reticle.blocked`). The ground is weapons/'s single
 * **`weapon:aimBlocked {blocked}`** — the same judgement (`weapons/parts/AimLine`) the wall's red circle and real fire use.
 *
 * **Bow mode (2026-09-14):** with the bow in hand (`WeaponDef.unique === 'bow'`, 「롱혼」) the four ticks hide, the dot stays
 * (`.reticle.bowmode`) and **below** it stand two short horizontal guide bars (`.rbow-tier`) and a moving bar (`.rbow-draw`).
 * The bar rests dim on the lower tier and, as the string is drawn, rises with weapons/'s `weapon:chargeChanged {kind:'draw', t}`
 * until at `t = 1` (full draw = the arrow flies along the crosshair) it lands exactly **on the dot** and glows (`.full`).
 * At `t = −1` (release · cancel) it eases back to the lower tier. The bow is recognised by `weapon:equipped`'s
 * `ctx.loot.getWeaponDef(id).unique` and, against a missed equip event, by the `draw` event itself. Consumable mode wins
 * (it turns off while `quick:equipped {item}`).
 *
 * **Defib mode (2026-09-15, user's decision):** when the consumable in hand is the defibrillator
 * (`ItemDef.gadgetId === 'defib'`) two circles stand in place of the four ticks (`.reticle.defibmode`) — a **small white
 * circle** in the middle (`.rdf-inner`) and a **big translucent one** (`.rdf-outer`). Holding LMB grows the small circle
 * until it overlaps the big one and its border thickens (= armed); putting a downed ally on the crosshair in that state
 * turns both circles to the **accent colour (orange)** — releasing then revives them. The UI never imitates the
 * judgement: the one ground is **`gadget:defibAim {armed, charge, target}`** sent by weapons/'s `parts/Defib`. The mode
 * itself is decided by what is in hand (`quick:equipped`), so the circles stand even if no event ever arrives.
 *
 * **Intro wake (2026-09-16, user's decision):** while the tutorial opening's wake cutscene runs (`PlayerRef.introWaking` —
 * before the camera is fully back to the usual back view) the crosshair is **invisible**, and once it ends it appears
 * over `TUTORIAL_RETICLE_FADE_S` (the same trick as `hud/Compass` — raised here with `dt`, not a CSS transition; under
 * reduced motion CSS transitions are clipped to 0.01 ms). It **multiplies** the opacity the blocker · wheel rules above
 * decided. The respawn cutscene (`respawn`) never sets `introWaking`, so it does not apply. Hiding during the liftoff
 * cutscene (`ui:cinematic`) is CSS — `.hud.cinematic .reticle` (`styles/raidHud.css`, instant, no transition).
 */
export class Reticle {
  readonly root: HTMLElement;
  private ticks: HTMLElement[] = [];
  private hitmarker: HTMLElement;
  private hook: HTMLElement;
  private hookDist: HTMLElement;
  /** Grapple chip (2026-09-10): icon + use key, left of the crosshair. */
  private grap: HTMLElement;
  private grapIco: HTMLElement;
  private grapKey: HTMLElement;
  private lastGrapKey = '';
  private qinfo: HTMLElement;
  private implant: ImplantId | null = null;
  private wielded = false;
  private grappleValid = false;
  private grappleDist = 0;
  private lastHookKey = '';
  /** Consumable in hand (`quick:equipped.item`), null while a gun is out. */
  private quickItem: ItemInstance | null = null;
  private quickDirty = false;
  private lastQuickText = '';
  private gap = 14;
  private targetGap = 14;
  private bloom = 0;
  private aiming = false;
  private scope = false;
  private wheelOpen = false;
  private stratOpen = false;
  /** 2026-09-09: the communication wheel (H hold) is open — dimmed to the same 25 % as its sibling wheels. */
  private commsOpen = false;
  private hitTimer = 0;
  private lastGap = -1;
  /** Bow mode (2026-09-14): static guide bars + the moving draw bar. */
  private bowDrawEl: HTMLElement;
  /** The weapon in hand is the bow (`WeaponDef.unique === 'bow'`); the mode itself also needs no consumable in hand. */
  private bowWeapon = false;
  private bowOn = false;
  /** LMB draw in progress (`weapon:chargeChanged kind:'draw'` with t ≥ 0). */
  private bowDrawing = false;
  /** Live draw `t` (0..1) from weapons/. */
  private bowTarget = 0;
  /** Smoothed draw actually drawn (0 = lower tier, 1 = centre). */
  private bowShown = 0;
  private lastBowY = -1;
  /** Defib mode (2026-09-15): the thing in hand is the defibrillator (decided from `quick:equipped`'s def). */
  private defibHand = false;
  private defibOn = false;
  /** The last state weapons/ sent (`gadget:defibAim`). */
  private defibCharge = 0;
  private defibArmed = false;
  private defibTarget = false;
  /** The charge actually drawn (damped), 0..1. */
  private defibShown = 0;
  private lastDefibScale = -1;
  private innerEl: HTMLElement;
  /** 2026-09-16: how far the reveal after the intro wake has come, 0..1 (always 1 without the cutscene). */
  private reveal = 1;
  /** Whether code is stepping `reveal` right now (i.e. `.reticle`'s CSS transition is off). */
  private revealStepping = false;
  private ctx: GameContext | null = null;
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
    // Grapple chip left of the crosshair: icon (+ the implant key while the aim point can actually be hooked).
    this.grap = el('div', { cls: 'rgrap', parent: this.root });
    this.grap.hidden = true;
    this.grapIco = el('span', { cls: 'rg-ico', text: GRAPPLE_GLYPH, parent: this.grap });
    this.grapKey = createKeycap(Keys.IMPLANT, { tag: 'kbd', parent: this.grap });   // 2026-09-15: the shared keycap
    // Consumable readout right of the dot (only rendered in `.consumable` mode).
    this.qinfo = el('span', { cls: 'qinfo ui-mono', text: '', parent: this.root });
    // Bow-mode guide bars below the dot (only rendered in `.bowmode`); positions come from BOW_TIER_Y, set once.
    for (let i = 0; i < BOW_TIER_Y.length; i++) {
      const y = BOW_TIER_Y[i];
      const tier = el('div', { cls: i === 0 ? 'rbow-tier' : 'rbow-tier rbow-low', parent: this.root });
      tier.style.transform = `translate(0, ${y}px)`;
    }
    this.bowDrawEl = el('div', { cls: 'rbow-draw', parent: this.root });
    // Defib mode: the big translucent circle + the small white one growing inside it (visible only in CSS `.reticle.defibmode`).
    el('div', { cls: 'rdf-outer', parent: this.root });
    this.innerEl = el('div', { cls: 'rdf-inner', parent: this.root });
    this.apply(14);
    this.applyBow();
    this.applyDefib();
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    const touch = (): void => { if (this.quickItem) this.quickDirty = true; };
    this.unsubs.push(
      b.on('weapon:fired', () => { this.bloom = Math.min(this.bloom + 6, 22); }),
      b.on('player:aimChanged', ({ aiming }) => { this.aiming = aiming; }),
      b.on('weapon:scopeChanged', ({ scope }) => { this.scope = scope; }),
      b.on('quick:wheelChanged', ({ open }) => { this.wheelOpen = open; }),
      b.on('stratagem:wheelChanged', ({ open }) => { this.stratOpen = open; }),
      // 2026-09-09: the communication wheel (H) dims the aim point like its sibling wheels — this is talking, not aiming.
      b.on('comms:wheelChanged', ({ open }) => { this.commsOpen = open; }),
      b.on('ui:hitmarker', ({ kill, headshot }) => {
        this.hitmarker.classList.remove('show', 'kill', 'head');
        // force restart of transition
        void this.hitmarker.offsetWidth;
        this.hitmarker.classList.add('show');
        if (kill) this.hitmarker.classList.add('kill');
        // 2026-09-09: a headshot draws the same X at 1.6× (the colour is unchanged — only a kill has its own red).
        if (headshot) this.hitmarker.classList.add('head');
        this.hitTimer = kill ? 0.22 : 0.12;
      }),
      // ── Consumable mode (2026-09-09) ──
      b.on('quick:equipped', ({ item }) => { this.setQuick(item); }),
      b.on('quick:used', ({ item, remaining }) => {
        // the emitter already knows the stack left; a 0 keeps the mode until weapons/ un-equips (`quick:equipped null`)
        if (this.quickItem && item.uid === this.quickItem.uid) { this.quickItem = { ...this.quickItem, qty: remaining }; }
        this.quickDirty = true;
      }),
      b.on('inventory:itemUpdated', touch),
      b.on('inventory:quickSlotsChanged', touch),
      b.on('durability:changed', touch),
      // 2026-09-11: the detonator hand's `기폭 n` is the remote-mine count in the world, so it is rewritten on every place · remove
      b.on('gadget:deployed', touch),
      b.on('gadget:removed', touch),
      // ── grapple crosshair state ──
      b.on('implant:equipped', ({ id }) => { this.implant = id; this.syncHook(); }),
      b.on('implant:wieldChanged', ({ id, wielded }) => { this.implant = id; this.wielded = wielded; this.syncHook(); }),
      b.on('implant:grappleTargetChanged', ({ valid, distance }) => {
        this.grappleValid = valid; this.grappleDist = distance;
        this.syncHook();
      }),
      // The key is read at use time (never cached in a module constant) — a rebinding follows through to the chip's keycap.
      b.on('input:bindingsChanged', () => paintKeycap(this.grapKey, Keys.IMPLANT)),
      onKeybindsChanged(() => paintKeycap(this.grapKey, Keys.IMPLANT)),
      b.on('implant:grappleAttached', () => { toggleClass(this.hook, 'attached', true); this.lastHookKey = ''; this.syncHook(); }),
      b.on('implant:grappleReleased', () => { toggleClass(this.hook, 'attached', false); this.lastHookKey = ''; this.syncHook(); }),
      // 2026-09-12 blocked muzzle: exactly the judgement weapons/ raises its red circle on — no raycast here, only a colour change
      b.on('weapon:aimBlocked', ({ blocked }) => toggleClass(this.root, 'blocked', blocked)),
      // ── Bow mode (2026-09-14) ──
      b.on('weapon:equipped', ({ weaponId }) => {
        this.bowWeapon = ctx.loot?.getWeaponDef(weaponId)?.unique === 'bow';
        this.resetBowDraw();
        this.syncBow();
      }),
      b.on('weapon:chargeChanged', ({ kind, t }) => {
        // a live draw (t ≥ 0) is itself proof the bow is in hand (robust to a missed `weapon:equipped`); a release
        // `t = −1` is not (it may trail a swap away). The other kinds (`charge` · `spinup` · `slash`) belong to other uniques.
        if (kind !== 'draw') { this.bowWeapon = false; this.resetBowDraw(); }
        else if (t >= 0) { this.bowWeapon = true; this.bowDrawing = true; this.bowTarget = Math.min(1, t); }
        else this.resetBowDraw();
        this.syncBow();
      }),
      // ── Defib mode (2026-09-15) ──
      b.on('gadget:defibAim', ({ armed, charge, target }) => {
        this.defibArmed = armed;
        this.defibCharge = armed ? 1 : Math.max(0, Math.min(1, charge));
        this.defibTarget = target;
        this.applyDefib();
      }),
      b.on('player:died', () => { this.resetBowDraw(); this.resetDefib(); }),
      b.on('player:downed', () => { this.resetBowDraw(); this.resetDefib(); }),
      b.on('game:newMission', () => { this.wielded = false; this.grappleValid = false; this.syncHook(); this.clearBow(); this.resetDefib(); this.setQuick(null); toggleClass(this.root, 'blocked', false); }),
      b.on('game:abort', () => { this.wielded = false; this.grappleValid = false; this.syncHook(); this.clearBow(); this.resetDefib(); this.setQuick(null); toggleClass(this.root, 'blocked', false); }),
    );
  }

  /** Release / cancel: the bar heads back to the lower tier (smoothly, via `update`). */
  private resetBowDraw(): void { this.bowDrawing = false; this.bowTarget = 0; }

  /** Mission reset: no bow in hand, bar snapped to the lower tier. */
  private clearBow(): void {
    this.bowWeapon = false;
    this.resetBowDraw();
    this.bowShown = 0;
  }

  /** Enter / leave bow mode — the bow in hand and no consumable (consumable mode wins). */
  private syncBow(): void {
    const on = this.bowWeapon && !this.quickItem;
    if (on === this.bowOn) return;
    this.bowOn = on;
    toggleClass(this.root, 'bowmode', on);
    if (!on) { this.resetBowDraw(); this.bowShown = 0; }
    this.lastBowY = -1;
    this.applyBow();
  }

  /** Write the draw bar's offset / state classes — only when they change. */
  private applyBow(): void {
    const y = BOW_LOW_Y * (1 - this.bowShown);
    if (Math.abs(y - this.lastBowY) >= 0.05) {
      this.lastBowY = y;
      this.bowDrawEl.style.transform = `translate(0, ${y.toFixed(2)}px)`;
    }
    toggleClass(this.bowDrawEl, 'drawing', this.bowDrawing);
    toggleClass(this.bowDrawEl, 'full', this.bowDrawing && this.bowTarget >= 1 && this.bowShown >= BOW_FULL_EPS);
  }

  private syncHook(): void {
    // The grapple is an instant implant (gun in hand): the bracket appears only while the anchor is hookable
    // or the wire is attached, so the crosshair stays clean otherwise.
    const show = this.implant === 'grapple' && (this.grappleValid || this.hook.classList.contains('attached'));
    const key = `${show ? 1 : 0}|${this.grappleValid ? 1 : 0}|${show && this.grappleValid ? Math.round(this.grappleDist) : -1}`;
    if (key === this.lastHookKey) { this.syncGrapple(); return; }
    this.lastHookKey = key;
    if (this.hook.hidden === show) this.hook.hidden = !show;
    if (show) {
      toggleClass(this.hook, 'valid', this.grappleValid);
      setText(this.hookDist, this.grappleValid ? `${Math.round(this.grappleDist)}m` : '');
    }
    this.syncGrapple();
  }

  /**
   * Grapple chip: equipped → the icon, plus the use key when it can be hooked. Not a second judgement —
   * `this.grappleValid` is the `implant:grappleTargetChanged {valid}` implants/ computes with the ray it would fire.
   */
  private syncGrapple(): void {
    const equipped = this.implant === 'grapple';
    const can = equipped && this.grappleValid;
    const key = `${equipped ? 1 : 0}|${can ? 1 : 0}`;
    if (key === this.lastGrapKey) return;
    this.lastGrapKey = key;
    if (this.grap.hidden === equipped) this.grap.hidden = !equipped;
    if (!equipped) return;
    const def = this.ctx?.implants?.getDef('grapple');
    setText(this.grapIco, def?.icon ?? GRAPPLE_GLYPH);
    if (def?.color) this.grap.style.setProperty('--gc', def.color);
    paintKeycap(this.grapKey, Keys.IMPLANT);
    toggleClass(this.grap, 'can', can);
    // Not hookable → the key hides — a key that cannot be pressed is never shown (only the dimmed icon stays).
    if (this.grapKey.hidden !== !can) this.grapKey.hidden = !can;
  }

  /** Grapple chip state (debug / smoke): 'off' = not equipped, 'dim' = not hookable, 'ready' = hookable. */
  get grappleChip(): 'off' | 'dim' | 'ready' {
    if (this.grap.hidden) return 'off';
    return this.grap.classList.contains('can') ? 'ready' : 'dim';
  }

  /** Enter / leave consumable mode: ticks hide, the dot stays, the count readout appears to its right. */
  private setQuick(item: ItemInstance | null): void {
    this.quickItem = item;
    toggleClass(this.root, 'consumable', !!item);
    if (item) { this.quickDirty = true; this.syncQuick(); }
    else if (this.lastQuickText !== '') { this.lastQuickText = ''; setText(this.qinfo, ''); }
    // Taking the defibrillator changes the whole crosshair — what is in hand decides the mode, `gadget:defibAim` only moves the state inside it.
    const inv = this.ctx?.inventory;
    const def = item ? (inv?.getDef(item.defId) ?? this.ctx?.loot?.getItemDef(item.defId)) : null;
    const hand = def?.gadgetId === 'defib';
    if (hand !== this.defibHand) { this.defibHand = hand; this.resetDefib(); }
    this.syncDefib();
    this.syncBow();
  }

  /** Hold ended / hands changed / died: the gauge goes to 0 (the mode itself is decided by what is in hand). */
  private resetDefib(): void {
    this.defibCharge = 0; this.defibArmed = false; this.defibTarget = false; this.defibShown = 0;
    this.applyDefib();
  }

  /** Enter / leave defib mode — only with the defibrillator in hand. */
  private syncDefib(): void {
    if (this.defibHand === this.defibOn) return;
    this.defibOn = this.defibHand;
    toggleClass(this.root, 'defibmode', this.defibOn);
    this.lastDefibScale = -1;
    this.applyDefib();
  }

  /** The small circle's scale · state classes — written only when they change. */
  private applyDefib(): void {
    const scale = DEFIB_MIN_SCALE + (1 - DEFIB_MIN_SCALE) * this.defibShown;
    if (Math.abs(scale - this.lastDefibScale) >= 0.004) {
      this.lastDefibScale = scale;
      this.innerEl.style.transform = `scale(${scale.toFixed(3)})`;
    }
    toggleClass(this.root, 'defib-armed', this.defibArmed);
    toggleClass(this.root, 'defib-target', this.defibArmed && this.defibTarget);
  }

  /** 2026-09-15: the defib crosshair is up (debug / smoke). */
  get defibMode(): boolean { return this.defibOn; }
  /** The charge being drawn, 0..1 (debug / smoke). */
  get defibGauge(): number { return this.defibShown; }
  /** A target that releasing now would revive is on the crosshair, so the accent colour is on (debug / smoke). */
  get defibOnTarget(): boolean { return this.root.classList.contains('defib-target'); }

  /** Re-read the live instance and rewrite the readout (only when an event marked it dirty). */
  private syncQuick(): void {
    if (!this.quickDirty || !this.quickItem) return;
    this.quickDirty = false;
    const ctx = this.ctx;
    const inv = ctx?.inventory;
    // the inventory copy is the truth for qty / durability; the event copy is the fallback (smokes, missing item)
    const live = inv?.findItem(this.quickItem.uid) ?? this.quickItem;
    const def = inv?.getDef(live.defId) ?? ctx?.loot?.getItemDef(live.defId);
    const parts: string[] = [];
    // 2026-09-11: the detonator hand (no slot, uid `detonator:`) — one's own remote mines left in the world, not a bag count
    if (this.quickItem.uid.startsWith('detonator:')) parts.push(`기폭 ${ctx?.gadgets?.liveRemoteMineCount?.() ?? 0}`);
    else parts.push(`×${Math.max(0, live.qty)}`);
    const max = def?.durabilityMax ?? 0;
    if (max > 0 && typeof live.durability === 'number') {
      parts.push(`${Math.round(Math.max(0, Math.min(1, live.durability / max)) * 100)}%`);
    }
    const text = parts.join(' · ');
    if (text === this.lastQuickText) return;
    this.lastQuickText = text;
    setText(this.qinfo, text);
  }

  /** 2026-09-12: the crosshair is in its blocked-muzzle warning colour (`weapon:aimBlocked`) (debug / smoke). */
  get isBlocked(): boolean { return this.root.classList.contains('blocked'); }

  /** Whether the reticle is in consumable mode (dot only + count) (debug / smoke). */
  get isConsumable(): boolean { return this.quickItem !== null; }
  /** The readout right of the dot while in consumable mode, '' otherwise (debug / smoke). */
  get consumableText(): string { return this.lastQuickText; }

  /** 2026-09-14: bow mode is showing (guide bars + draw bar instead of the ticks) (debug / smoke). */
  get bowMode(): boolean { return this.bowOn; }
  /** Smoothed draw bar position, 0 = lower tier … 1 = on the centre (debug / smoke). */
  get bowDraw(): number { return this.bowShown; }
  /** The draw bar is in its full-draw glow (debug / smoke). */
  get bowFull(): boolean { return this.bowDrawEl.classList.contains('full'); }

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
    // Consumable readout: rewritten only after an event marked it dirty (one boolean per frame otherwise).
    if (this.quickDirty) this.syncQuick();
    // Bow mode: the draw bar follows the live draw `t` (fast) or settles back to the lower tier (slower).
    if (this.bowOn) {
      const target = this.bowDrawing ? this.bowTarget : 0;
      if (this.bowShown !== target) {
        this.bowShown = damp(this.bowShown, target, this.bowDrawing ? BOW_FOLLOW_LAMBDA : BOW_RETURN_LAMBDA, dt);
        if (Math.abs(this.bowShown - target) < 0.002) this.bowShown = target;
      }
      this.applyBow();
    }
    // Defib: the charge arriving at 30 Hz is carried across frames (the same way as the bow draw).
    if (this.defibOn && this.defibShown !== this.defibCharge) {
      this.defibShown = damp(this.defibShown, this.defibCharge, DEFIB_LAMBDA, dt);
      if (Math.abs(this.defibShown - this.defibCharge) < 0.002) this.defibShown = this.defibCharge;
      this.applyDefib();
    }

    const scoped = this.scope && this.aiming;
    // Hidden behind blockers / the scope; dimmed while the quick-use wheel is open.
    const shown = ctx.uiBlockers.size > 0 || scoped ? 0 : (this.wheelOpen || this.stratOpen || this.commsOpen) ? 0.25 : 1;
    // 2026-09-16: × the reveal after the intro wake (0 during the cutscene → 1 over `TUTORIAL_RETICLE_FADE_S`)
    const o = shown * this.updateReveal(ctx, dt);
    const opacity = o >= 1 ? '1' : o <= 0 ? '0' : o.toFixed(3);
    if (this.root.style.opacity !== opacity) this.root.style.opacity = opacity;
  }

  /**
   * 0 during the intro wake, then to 1 over `TUTORIAL_RETICLE_FADE_S` (simulation dt — it stops on a pause · shader hold).
   *
   * While it steps, `.reticle`'s CSS transition (`--t-fast`) is turned off (`.reveal-step`) — fades that carry the story
   * are stepped in code (CLAUDE.md §4.2). Without that, on the frame the cutscene starts the crosshair **blinks away
   * from 1 over `--t-fast`** (visible for real on a tutorial boot), and on the way back a transition lies over the steps.
   */
  private updateReveal(ctx: GameContext, dt: number): number {
    if (ctx.player?.introWaking ?? false) this.reveal = 0;
    else if (this.reveal < 1) this.reveal = TUTORIAL_RETICLE_FADE_S > 0 ? Math.min(1, this.reveal + Math.max(0, dt) / TUTORIAL_RETICLE_FADE_S) : 1;
    const stepping = this.reveal < 1;
    if (stepping !== this.revealStepping) {
      this.revealStepping = stepping;
      this.root.classList.toggle('reveal-step', stepping);
    }
    return this.reveal;
  }

  /** How far the reveal after the intro wake has come, 0..1 (debug / smoke). */
  get revealAmount(): number { return this.reveal; }

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
