import type { GameContext, ImplantId, ItemInstance, Stance } from '@/shared';
import { Keys, createKeycap, onKeybindsChanged, paintKeycap } from '@/shared';
import { el, setText, toggleClass, damp } from '../dom';
import '../styles/implant.css';

/** Base reticle gap (px) per stance, [hip, ADS]. */
const STANCE_GAP: Record<Stance, [number, number]> = {
  stand: [14, 7],
  crouch: [10, 5],
  prone: [8, 4],
};
const SPRINT_GAP = 18;
/** Fallback glyph for the 갈고리 chip when `ctx.implants` is not up yet (`IMPLANT_DEFS.grapple.icon`). */
const GRAPPLE_GLYPH = '⚓';
const MOVE_BONUS = 2;
const MOVE_SPEED_EPS = 0.5; // m/s of horizontal velocity that counts as "moving"
/**
 * 활 모드 (2026-09-14): the two static guide bars' offsets below the centre (px, [upper, lower]). The moving draw bar
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
 * Minimal 4-tick crosshair. Gap depends on stance / aim / sprint / movement, blooms on fire,
 * flashes hitmarkers. Hidden entirely while the scope overlay is showing (and via CSS while `.hud.targeting`); dimmed to
 * 25 % while the quick-use or ship-call wheel is open.
 *
 * Grapple (갈고리, tactical kit): with the grapple implant equipped (it is an instant Q cast, the gun stays in hand)
 * the reticle grows a bracket ring with the anchor distance whenever `implant:grappleTargetChanged {valid}` says the
 * point under the crosshair can be hooked, and keeps it (green) while the wire is attached.
 *
 * **소모품 모드 (2026-09-09):** while a quick-use consumable is in the hands (`quick:equipped {item}` — 수류탄 · 가젯 ·
 * 회복 소모품) the four ticks hide (`.reticle.consumable`, CSS) and only the dot stays, with a small mono readout to
 * its **right** (`.qinfo`): the stack count `×n` and, for an item with its own gauge (회복 스프레이 —
 * `ItemDef.durabilityMax` on the def, `ItemInstance.durability` on the instance), the remaining gauge as `n%`
 * (`×2 · 62%` when both apply). The live instance is re-read from `ctx.inventory.findItem(uid)` only when something
 * that can change it fires (`quick:used` · `inventory:itemUpdated` · `inventory:quickSlotsChanged` · `durability:changed`),
 * never per frame. `quick:equipped {item: null}` (the gun is back) restores the normal crosshair; so does a mission reset.
 *
 * **갈고리 칩 (2026-09-10):** 크로스헤어 **좌측**에 갈고리 아이콘 + 사용 키(`Keys.IMPLANT`)를 붙인다 —
 * 지금 조준한 방향에 갈고리를 걸 수 있으면 아이콘이 밝고 키캡이 보이고, 걸 수 없으면 **키는 숨고 아이콘만
 * 딤드**로 남으며, 갈고리를 장착하지 않았으면 아예 없다. 판정은 UI 가 흉내내지 않는다: implants/ 의
 * `updateGrapple` 이 매 프레임 자기 조준 광선으로 계산해 보내는 **`implant:grappleTargetChanged {valid}`**
 * 하나가 유일한 근거이고 (= `castGrapple` 이 보는 `grappleTargetValid` 와 같은 값), 여기서는 레이캐스트를
 * 한 번도 쏘지 않는다. 임플란트 쿨타임 · 충전 수는 이 칩에 없다 — 그것은 전부 화면 중앙 하단의
 * `hud/ImplantWidget` 썸네일로 내려갔다.
 *
 * **총구 막힘 (2026-09-12):** 총구가 앞 몇 m 안의 벽 · 창틀 · 엄폐물에 걸려 크로스헤어대로 나가지 않을 때 점과 틱이
 * 빨갛게 바뀐다 (`.reticle.blocked`). 근거는 weapons/ 의 **`weapon:aimBlocked {blocked}`** 하나 — 벽의 빨간 원과 실제
 * 사격이 쓰는 같은 판정(`weapons/parts/AimLine`)이다.
 *
 * **활 모드 (2026-09-14):** 손에 든 무기가 활(`WeaponDef.unique === 'bow'`, 「롱혼」)이면 네 틱이 숨고 점은 남으며
 * (`.reticle.bowmode`) 점 **아래**에 짧은 가로 안내선 두 단(`.rbow-tier`)과 움직이는 가로 바(`.rbow-draw`)가 선다.
 * 바는 평소 아래 단에 흐리게 머물고, 시위를 당기면 weapons/ 의 `weapon:chargeChanged {kind:'draw', t}` 를 따라 올라가
 * `t = 1`(완전히 당김 = 화살이 크로스헤어대로 날아간다)에서 정확히 **점 위**에 닿아 밝게 빛난다(`.full`). `t = −1`
 * (놓기 · 취소)이면 아래 단으로 부드럽게 돌아간다. 활인지는 `weapon:equipped` 의 `ctx.loot.getWeaponDef(id).unique` 와,
 * 놓친 장착 이벤트에 대비해 `draw` 이벤트 자체로 판단한다. 소모품 모드가 이긴다(`quick:equipped {item}` 동안 꺼진다).
 */
export class Reticle {
  readonly root: HTMLElement;
  private ticks: HTMLElement[] = [];
  private hitmarker: HTMLElement;
  private hook: HTMLElement;
  private hookDist: HTMLElement;
  /** 갈고리 칩 (2026-09-10): 아이콘 + 사용 키, 크로스헤어 좌측. */
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
  /** 2026-09-09: 의사소통 휠(H 홀드)이 열려 있다 — 형제 휠들과 같은 25 % 로 흐린다. */
  private commsOpen = false;
  private hitTimer = 0;
  private lastGap = -1;
  /** 활 모드 (2026-09-14): static guide bars + the moving draw bar. */
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
    // 갈고리 칩 left of the crosshair: icon (+ the implant key while the aim point can actually be hooked).
    this.grap = el('div', { cls: 'rgrap', parent: this.root });
    this.grap.hidden = true;
    this.grapIco = el('span', { cls: 'rg-ico', text: GRAPPLE_GLYPH, parent: this.grap });
    this.grapKey = createKeycap(Keys.IMPLANT, { tag: 'kbd', parent: this.grap });   // 2026-09-15: 공용 키캡
    // 소모품 readout right of the dot (only rendered in `.consumable` mode).
    this.qinfo = el('span', { cls: 'qinfo ui-mono', text: '', parent: this.root });
    // 활 모드 guide bars below the dot (only rendered in `.bowmode`); positions come from BOW_TIER_Y, set once.
    for (let i = 0; i < BOW_TIER_Y.length; i++) {
      const y = BOW_TIER_Y[i];
      const tier = el('div', { cls: i === 0 ? 'rbow-tier' : 'rbow-tier rbow-low', parent: this.root });
      tier.style.transform = `translate(0, ${y}px)`;
    }
    this.bowDrawEl = el('div', { cls: 'rbow-draw', parent: this.root });
    this.apply(14);
    this.applyBow();
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
      // 2026-09-09: 의사소통 휠(H)도 형제 휠들과 같이 조준점을 흐린다 — 지금은 조준이 아니라 말하는 중이다.
      b.on('comms:wheelChanged', ({ open }) => { this.commsOpen = open; }),
      b.on('ui:hitmarker', ({ kill, headshot }) => {
        this.hitmarker.classList.remove('show', 'kill', 'head');
        // force restart of transition
        void this.hitmarker.offsetWidth;
        this.hitmarker.classList.add('show');
        if (kill) this.hitmarker.classList.add('kill');
        // 2026-09-09: 헤드샷은 같은 X 를 1.6배로 그린다 (색은 그대로 — 처치의 빨강만 따로다).
        if (headshot) this.hitmarker.classList.add('head');
        this.hitTimer = kill ? 0.22 : 0.12;
      }),
      // ── 소모품 모드 (2026-09-09) ──
      b.on('quick:equipped', ({ item }) => { this.setQuick(item); }),
      b.on('quick:used', ({ item, remaining }) => {
        // the emitter already knows the stack left; a 0 keeps the mode until weapons/ un-equips (`quick:equipped null`)
        if (this.quickItem && item.uid === this.quickItem.uid) { this.quickItem = { ...this.quickItem, qty: remaining }; }
        this.quickDirty = true;
      }),
      b.on('inventory:itemUpdated', touch),
      b.on('inventory:quickSlotsChanged', touch),
      b.on('durability:changed', touch),
      // 2026-09-11: 기폭기 손의 `기폭 n` 은 월드의 원격 지뢰 수라 설치 · 제거마다 다시 쓴다
      b.on('gadget:deployed', touch),
      b.on('gadget:removed', touch),
      // ── grapple crosshair state ──
      b.on('implant:equipped', ({ id }) => { this.implant = id; this.syncHook(); }),
      b.on('implant:wieldChanged', ({ id, wielded }) => { this.implant = id; this.wielded = wielded; this.syncHook(); }),
      b.on('implant:grappleTargetChanged', ({ valid, distance }) => {
        this.grappleValid = valid; this.grappleDist = distance;
        this.syncHook();
      }),
      // 키는 사용 시점에 읽는다 (모듈 상수로 캐시하지 않는다) — 리바인딩되면 칩의 키캡도 따라간다.
      b.on('input:bindingsChanged', () => paintKeycap(this.grapKey, Keys.IMPLANT)),
      onKeybindsChanged(() => paintKeycap(this.grapKey, Keys.IMPLANT)),
      b.on('implant:grappleAttached', () => { toggleClass(this.hook, 'attached', true); this.lastHookKey = ''; this.syncHook(); }),
      b.on('implant:grappleReleased', () => { toggleClass(this.hook, 'attached', false); this.lastHookKey = ''; this.syncHook(); }),
      // 2026-09-12 총구 막힘: weapons/ 가 빨간 원을 띄우는 바로 그 판정 — 여기서는 레이캐스트를 쏘지 않고 색만 바꾼다
      b.on('weapon:aimBlocked', ({ blocked }) => toggleClass(this.root, 'blocked', blocked)),
      // ── 활 모드 (2026-09-14) ──
      b.on('weapon:equipped', ({ weaponId }) => {
        this.bowWeapon = ctx.loot?.getWeaponDef(weaponId)?.unique === 'bow';
        this.resetBowDraw();
        this.syncBow();
      }),
      b.on('weapon:chargeChanged', ({ kind, t }) => {
        // a live draw (t ≥ 0) is itself proof the bow is in hand (robust to a missed `weapon:equipped`); a release
        // `t = −1` is not (it may trail a swap away). The other kinds (충전 · 예열 · 용검) belong to other unique weapons.
        if (kind !== 'draw') { this.bowWeapon = false; this.resetBowDraw(); }
        else if (t >= 0) { this.bowWeapon = true; this.bowDrawing = true; this.bowTarget = Math.min(1, t); }
        else this.resetBowDraw();
        this.syncBow();
      }),
      b.on('player:died', () => this.resetBowDraw()),
      b.on('player:downed', () => this.resetBowDraw()),
      b.on('game:newMission', () => { this.wielded = false; this.grappleValid = false; this.syncHook(); this.clearBow(); this.setQuick(null); toggleClass(this.root, 'blocked', false); }),
      b.on('game:abort', () => { this.wielded = false; this.grappleValid = false; this.syncHook(); this.clearBow(); this.setQuick(null); toggleClass(this.root, 'blocked', false); }),
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

  /** Enter / leave 활 모드 — the bow in hand and no consumable (소모품 모드 wins). */
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
   * 갈고리 칩: equipped → 아이콘, 걸 수 있으면 + 사용 키. Not a second judgement — `this.grappleValid` is the
   * `implant:grappleTargetChanged {valid}` that implants/ computes with the ray it would actually fire.
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
    // 걸 수 없으면 키는 숨긴다 — 누를 수 없는 키를 보여 주지 않는다 (아이콘만 딤드로 남는다).
    if (this.grapKey.hidden !== !can) this.grapKey.hidden = !can;
  }

  /** 갈고리 칩 상태 (debug / smoke): 'off' = 미장착, 'dim' = 걸 수 없음, 'ready' = 걸 수 있음. */
  get grappleChip(): 'off' | 'dim' | 'ready' {
    if (this.grap.hidden) return 'off';
    return this.grap.classList.contains('can') ? 'ready' : 'dim';
  }

  /** Enter / leave 소모품 모드: ticks hide, the dot stays, the count readout appears to its right. */
  private setQuick(item: ItemInstance | null): void {
    this.quickItem = item;
    toggleClass(this.root, 'consumable', !!item);
    if (item) { this.quickDirty = true; this.syncQuick(); }
    else if (this.lastQuickText !== '') { this.lastQuickText = ''; setText(this.qinfo, ''); }
    this.syncBow();
  }

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
    // 2026-09-11: 기폭기 손 (슬롯 없음, uid `detonator:`) — 가방 수량 대신 월드에 남은 내 원격 지뢰 수
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

  /** 2026-09-12: the crosshair is in its 총구 막힘 warning colour (`weapon:aimBlocked`) (debug / smoke). */
  get isBlocked(): boolean { return this.root.classList.contains('blocked'); }

  /** Whether the reticle is in 소모품 모드 (dot only + count) (debug / smoke). */
  get isConsumable(): boolean { return this.quickItem !== null; }
  /** The readout right of the dot while in 소모품 모드, '' otherwise (debug / smoke). */
  get consumableText(): string { return this.lastQuickText; }

  /** 2026-09-14: 활 모드 is showing (guide bars + draw bar instead of the ticks) (debug / smoke). */
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
    // 소모품 readout: rewritten only after an event marked it dirty (one boolean per frame otherwise).
    if (this.quickDirty) this.syncQuick();
    // 활 모드: the draw bar follows the live draw `t` (fast) or settles back to the lower tier (slower).
    if (this.bowOn) {
      const target = this.bowDrawing ? this.bowTarget : 0;
      if (this.bowShown !== target) {
        this.bowShown = damp(this.bowShown, target, this.bowDrawing ? BOW_FOLLOW_LAMBDA : BOW_RETURN_LAMBDA, dt);
        if (Math.abs(this.bowShown - target) < 0.002) this.bowShown = target;
      }
      this.applyBow();
    }

    const scoped = this.scope && this.aiming;
    // Hidden behind blockers / the scope; dimmed while the quick-use wheel is open.
    const opacity = ctx.uiBlockers.size > 0 || scoped ? '0' : (this.wheelOpen || this.stratOpen || this.commsOpen) ? '0.25' : '1';
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
