import type { GameContext, ImplantId, ItemInstance, Stance } from '@/shared';
import { Keys, keyLabel, onKeybindsChanged } from '@/shared';
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
    this.grapKey = el('kbd', { cls: 'keycap', text: keyLabel(Keys.IMPLANT), parent: this.grap });
    // 소모품 readout right of the dot (only rendered in `.consumable` mode).
    this.qinfo = el('span', { cls: 'qinfo ui-mono', text: '', parent: this.root });
    this.apply(14);
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
      b.on('input:bindingsChanged', () => setText(this.grapKey, keyLabel(Keys.IMPLANT))),
      onKeybindsChanged(() => setText(this.grapKey, keyLabel(Keys.IMPLANT))),
      b.on('implant:grappleAttached', () => { toggleClass(this.hook, 'attached', true); this.lastHookKey = ''; this.syncHook(); }),
      b.on('implant:grappleReleased', () => { toggleClass(this.hook, 'attached', false); this.lastHookKey = ''; this.syncHook(); }),
      // 2026-09-12 총구 막힘: weapons/ 가 빨간 원을 띄우는 바로 그 판정 — 여기서는 레이캐스트를 쏘지 않고 색만 바꾼다
      b.on('weapon:aimBlocked', ({ blocked }) => toggleClass(this.root, 'blocked', blocked)),
      b.on('game:newMission', () => { this.wielded = false; this.grappleValid = false; this.syncHook(); this.setQuick(null); toggleClass(this.root, 'blocked', false); }),
      b.on('game:abort', () => { this.wielded = false; this.grappleValid = false; this.syncHook(); this.setQuick(null); toggleClass(this.root, 'blocked', false); }),
    );
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
    setText(this.grapKey, keyLabel(Keys.IMPLANT));
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
