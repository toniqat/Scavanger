import type { GameContext, ItemDef, ItemInstance, UniqueWeaponKind, WeaponDef, WeaponSlot } from '@/shared';
import { Keys, UNIQUE_WEAPON_LABEL_KO, WEAPON_DEFAULT_DURABILITY, buildItemChip, createKeycap, paintKeycap } from '@/shared';
import { WEAPON_CLASS_LABEL_KO, weaponClassOf } from '@/items';

/**
 * 2026-09-15 (사용자 결정): the type tag of a weapon. A legendary unique names **its own kind** (`화염방사기` · `전격총` ·
 * `표창` · `컴포짓 보우` · `바주카` · `미니건`, `UNIQUE_WEAPON_LABEL_KO`) — its csv `class` (AR / DMR / SMG / SR) only picks
 * the shooting skill and must never reach the screen. Graded guns keep the class label.
 */
export function weaponTypeLabel(def: WeaponDef): string {
  return def.unique ? UNIQUE_WEAPON_LABEL_KO[def.unique] : WEAPON_CLASS_LABEL_KO[weaponClassOf(def)];
}
import { el, setText, toggleClass } from '../dom';
import '../styles/raidHud.css';

/** Durability ratio at/below which the bar turns amber (`.worn`). */
const DURABILITY_WORN = 0.3;

/** Thumbnail edge of the weapon chip in the bottom-right box (2026-09-10: 34 → 58, the name line that shared the box is gone). */
const WEAPON_THUMB_SIZE = 58;

/** 2026-09-16: thumbnail edge of the **other** primary left of the box (`.wp-side`) — `styles/raidHud.css` sizes nothing, the chip does. */
const SIDE_THUMB_SIZE = 40;

/** 2026-09-16: tag text of the empty panel (no primary equipped at all). */
const EMPTY_TYPE_TEXT = '주무기 없음';

/** Fixed `좌: … / 우: …` fire-mode texts per unique weapon kind (`WeaponDef.altFire` — RMB is an alternative fire, not ADS). */
const UNIQUE_MODES: Readonly<Record<UniqueWeaponKind, { l: string; r: string }>> = {
  flamethrower: { l: '넓은 화염', r: '긴 화염 제트' },
  shockgun: { l: '연쇄 전격', r: '충전 볼트' },
  shuriken: { l: '표창 1개', r: '표창 3개 (F 길게: 용검)' },
  bow: { l: '당겨 쏘기', r: '당기기 취소' },
  bazooka: { l: '착탄 로켓', r: '공중 폭발 (바닥 우클릭: 로켓 점프)' },
  minigun: { l: '예열 후 사격', r: '—' },
};

/** The two primary slots, in key order (1 → 2). */
type PrimarySlot = Extract<WeaponSlot, 'primary' | 'primary2'>;

/**
 * Bottom-right weapon readout: durability bar, then one row of **썸네일 ← → 잔탄 / 예비탄**, then the class tag,
 * plus the low / empty / broken states. The reload readout moved to the crosshair in Phase 10 (`hud/ReloadGauge`) —
 * this panel no longer owns an arc or a `재장전` pill.
 *
 * 2026-09-10 (레이드 HUD 개편, 사용자 결정): 패널 위의 슬롯 칸과 패널 아래의 주무기 키 · 무기 이름이 없어졌다.
 * 총기 표시는 **가로로 긴 한 상자**(`.wbox`) 안에 든다 — 좌측 썸네일 · `24 / 120` · 맨 오른쪽 분류 태그, 상자 바닥에
 * 내구도 바. `예비` 라벨은 없다 (base.css 의 `/ ` 구분자).
 *
 * 2026-09-16 (사용자 결정):
 * - 썸네일은 **등급색 정사각 틀 없이** 아이템 칩만 그린다 (칩 자신이 이미 등급색이다).
 * - 상자 **왼쪽 바깥**에 **다른 주무기**의 썸네일(`.wp-side`)과 그 슬롯의 키캡(주무기 I 을 들면 II 의 키)을 둔다.
 *   주무기가 하나뿐이면 없다. 키는 `Keys.PRIMARY` / `Keys.PRIMARY2` 를 그릴 때마다 읽는다 (리바인딩 규약).
 * - 주무기가 하나도 없어도 패널은 남고 **빈 상태**(`.wp-empty` — `—` · `주무기 없음`)로 그린다.
 * - 주무기가 아닌 것을 들면(빠른 사용 — 수류탄 · 붕대 · 자극제 · 가젯 · 기폭기, 근접 휘두르기, 임플란트 · 전투불능 홀스터)
 *   큰 패널은 **마지막으로 든 주무기**를 그대로 보여 주되 흐리게(`.wp-dim`) 한다. 옛 「소모품 모드」(큰 패널이 손에 든
 *   빠른 사용 아이템의 이름 · 개수 · 사용법으로 바뀌던 `.weapon.consumable`)는 없앴다 — 개수는 빠른 사용 썸네일
 *   (`hud/QuickStrip`)이, 사용법은 조준점 아래 힌트가 말한다.
 *
 * Data: `weapon:equipped` / `ammoChanged` / `durabilityChanged` / `broken` for the gun in hand, `loadout:changed` for both
 * primaries, and a per-frame poll of `ctx.weapons.activeSlot` / `primaryInHand` (`update`) — a swap or loadout change that
 * finishes while a quick-use item is in hand emits no `weapon:equipped`, so the slot is re-read here and the numbers
 * come from `ctx.weapons.ammoOf(slot)`.
 */
export class WeaponPanel {
  readonly root: HTMLElement;
  private magEl: HTMLElement;
  private reserveEl: HTMLElement;
  private typeEl: HTMLElement;
  private thumbEl: HTMLElement;
  private thumbIcon: HTMLElement;
  private duraEl: HTMLElement;
  private duraFill: HTMLElement;

  private modesEl: HTMLElement;
  private modeL: HTMLElement;
  private modeR: HTMLElement;

  /** 2026-09-16: the other primary (`.wp-side`): keycap over its thumbnail. */
  private sideEl: HTMLElement;
  private sideKeyEl: HTMLElement;
  private sideThumb: HTMLElement;
  /** `slot|defId` of the drawn side thumbnail ('' = hidden). */
  private sideStamp = '';

  private ctx: GameContext | null = null;
  /** Both primaries as the inventory last announced them (`loadout:changed`, seeded from `getLoadout()`). */
  private loadout: Record<PrimarySlot, ItemInstance | null> = { primary: null, primary2: null };
  /** Slot / uid the big panel is drawing (null slot = empty state). */
  private shownSlot: WeaponSlot | null = null;
  private shownUid = '';
  private dim = false;

  private weaponId = '';
  private weaponUid = '';
  private magSize = 1;
  /**
   * 2026-09-15: the bow 「롱혼」 is in hand. It has no magazine for the player (no reload — weapons/), so the readout is
   * **one number** = arrows carried (mag + reserve) and the `/ reserve` half hides (`.weapon.single-ammo`).
   */
  private singleAmmo = false;
  private lastDura = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'weapon wp-empty', parent });

    // `.wbox` stays the second child of `.weapon` (QuickStrip is prepended by HudSystem) — smokes read that order.
    const box = el('div', { cls: 'wbox', parent: this.root });
    // 2026-09-16: 다른 주무기는 상자 **안**의 절대 위치 요소로 둔다 — 상자의 왼쪽 바깥에 붙고, `.weapon` 의 자식 순서는 그대로다.
    this.sideEl = el('div', { cls: 'wp-side', parent: box });
    this.sideEl.hidden = true;
    this.sideKeyEl = createKeycap(Keys.PRIMARY2, { cls: 'wp-side-key', parent: this.sideEl });
    this.sideThumb = el('div', { cls: 'wp-side-thumb', parent: this.sideEl });

    const ammoRow = el('div', { cls: 'ammo-row', parent: box });
    this.thumbEl = el('div', { cls: 'wthumb is-empty', parent: ammoRow });
    this.thumbIcon = el('div', { cls: 'wt-icon', parent: this.thumbEl });
    const ammoNums = el('div', { cls: 'ammo-nums', parent: ammoRow });
    this.magEl = el('span', { cls: 'mag', text: '—', parent: ammoNums });
    this.reserveEl = el('span', { cls: 'reserve', text: '', parent: ammoNums });

    const tagRow = el('div', { cls: 'name-row', parent: ammoRow });
    this.typeEl = el('span', { cls: 'type', text: EMPTY_TYPE_TEXT, parent: tagRow });

    this.duraEl = el('div', { cls: 'dura', parent: box });
    this.duraFill = el('div', { cls: 'fill', parent: this.duraEl });

    // Unique-weapon fire modes (`.modes`, only for defs with `altFire` / `unique`): `좌: …` / `우: …`.
    this.modesEl = el('div', { cls: 'modes', parent: this.root });
    const rowL = el('div', { cls: 'mode', parent: this.modesEl });
    el('span', { cls: 'mk', text: '좌', parent: rowL });
    this.modeL = el('span', { cls: 'mv', text: '', parent: rowL });
    const rowR = el('div', { cls: 'mode', parent: this.modesEl });
    el('span', { cls: 'mk', text: '우', parent: rowR });
    this.modeR = el('span', { cls: 'mv', text: '', parent: rowR });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    // 2026-09-14 (튜토리얼 HUD 점진 노출): 시체에서 장비를 얻기 전까지 무기 패널은 없다. 게이트가 바뀔 만한 세 순간에만 다시 묻는다.
    //   튜토리얼이 꺼져 있으면 언제나 false 라 평소 화면이 한 글자도 바뀌지 않는다.
    const tutGate = (): void => {
      toggleClass(this.root, 'hud-tut-hidden', ctx.tutorial?.hides('hud', 'weapon') ?? false);
    };
    tutGate();
    this.pullLoadout();
    this.unsubs.push(
      b.on('tutorial:changed', tutGate),
      b.on('world:ready', () => { tutGate(); this.pullLoadout(); }),   // 새로고침으로 튜토리얼 레이드에 돌아온 경우 (단계가 안 바뀐다)
      b.on('game:phaseChanged', tutGate),
      b.on('input:bindingsChanged', () => { this.sideStamp = ''; }),   // 다음 update 가 키캡을 다시 칠한다
      b.on('weapon:equipped', (p) => {
        if (!p.weaponId) return;   // 빈 손 알림 — 빈 상태는 `update` 가 슬롯을 보고 정한다
        const inst = ctx.inventory?.getLoadout()[p.slot] ?? null;
        this.showWeapon(p.slot, inst, p.weaponId, p);
      }),
      b.on('weapon:ammoChanged', (p) => {
        if (!this.shownSlot || (p.weaponId !== this.weaponId && this.weaponId)) return;
        this.magSize = Math.max(1, p.magSize);
        this.setAmmo(p.ammoInMag, p.reserveRounds);
      }),
      b.on('weapon:durabilityChanged', (p) => {
        if (!this.shownSlot || !this.isActive(p.uid, p.weaponId)) return;
        this.setDurability(p.durability, p.max, false);
      }),
      b.on('weapon:broken', (p) => {
        if (!this.shownSlot || !this.isActive(p.uid, p.weaponId)) return;
        this.setDurability(0, 1, true);
      }),
      // 2026-09-10: 교체 타이머는 크로스헤어 링(`hud/ReloadGauge`)이고, 새 무기의 썸네일 · 잔탄은 곧 오는 `weapon:equipped` 가 갈아 끼운다.
      b.on('weapon:dryFire', () => {
        this.magEl.classList.remove('flash');
        void this.magEl.offsetWidth;
        this.magEl.classList.add('flash');
      }),
      b.on('loadout:changed', ({ primary, primary2 }) => {
        this.loadout.primary = primary;
        this.loadout.primary2 = primary2;
        if (!primary && !primary2) this.showEmpty();
      }),
    );
  }

  /** Seed both primaries straight from inventory (the event only arrives on a change). */
  private pullLoadout(): void {
    const inv = this.ctx?.inventory;
    if (!inv) return;
    try {
      const l = inv.getLoadout();
      this.loadout.primary = l.primary;
      this.loadout.primary2 = l.primary2;
    } catch { /* inventory not ready */ }
  }

  /**
   * Per frame while the raid HUD is up: follow `ctx.weapons.activeSlot` (re-draws the big panel when the slot or its
   * item changed without a `weapon:equipped`), dim it while the primary is not in hand, and keep the side thumbnail.
   */
  update(ctx: GameContext): void {
    // a stub `ctx.weapons` without the 2026-09-16 fields (smoke injectors) falls back to the event-driven slot
    const ref = ctx.weapons && typeof ctx.weapons.ammoOf === 'function' ? ctx.weapons : null;
    const slot = ref ? ref.activeSlot : this.shownSlot;
    if (ref) {
      if (slot === null) {
        if (this.shownSlot !== null) this.showEmpty();
      } else {
        const inst = this.itemIn(slot);
        if (slot !== this.shownSlot || (inst?.uid ?? '') !== this.shownUid) this.showFromRef(ctx, slot, inst);
      }
    }
    const dim = !!ref && slot !== null && !ref.primaryInHand;
    if (dim !== this.dim) { this.dim = dim; toggleClass(this.root, 'wp-dim', dim); }
    this.updateSide(slot);
  }

  private itemIn(slot: WeaponSlot): ItemInstance | null {
    return slot === 'primary' || slot === 'primary2' ? this.loadout[slot] : null;
  }

  /** Re-draw the big panel for `slot` from `ctx.weapons.ammoOf` (no `weapon:equipped` came for it). */
  private showFromRef(ctx: GameContext, slot: WeaponSlot, inst: ItemInstance | null): void {
    const ammo = ctx.weapons?.ammoOf(slot) ?? null;
    const itemDef = inst ? (ctx.inventory?.getDef(inst.defId) ?? ctx.loot?.getItemDef(inst.defId)) : undefined;
    const weaponId = ammo?.weaponId ?? itemDef?.weaponId ?? '';
    if (!weaponId) { this.showEmpty(); return; }
    this.showWeapon(slot, inst, weaponId, ammo ?? { magSize: 1, ammoInMag: 0, reserveRounds: 0 });
  }

  /** Draw one primary in the big panel (thumbnail, type, modes, ammo, durability). */
  private showWeapon(
    slot: WeaponSlot, inst: ItemInstance | null, weaponId: string,
    ammo: { magSize: number; ammoInMag: number; reserveRounds: number },
  ): void {
    const ctx = this.ctx;
    this.shownSlot = slot;
    this.shownUid = inst?.uid ?? '';
    toggleClass(this.root, 'wp-empty', false);
    this.weaponId = weaponId;
    this.weaponUid = inst?.uid ?? '';
    this.magSize = Math.max(1, ammo.magSize);
    const def = ctx?.loot?.getWeaponDef(weaponId);
    // 2026-09-15: a unique shows its own kind (`컴포짓 보우` …), never the csv class it borrows for the skill.
    setText(this.typeEl, def ? weaponTypeLabel(def) : '—');
    this.setSingleAmmo(def?.unique === 'bow');
    this.setModes(def);
    this.setAmmo(ammo.ammoInMag, ammo.reserveRounds);
    // the item def behind the equipped weapon (`wpn_<id>` for graded guns) drives the thumbnail
    const itemDefId = inst?.defId ?? `wpn_${weaponId}`;
    this.setThumb(ctx?.inventory?.getDef(itemDefId) ?? ctx?.loot?.getItemDef(itemDefId));
    // Seed the durability bar from the item instance (durabilityChanged only fires on change).
    const max = def?.maxDurability ?? WEAPON_DEFAULT_DURABILITY;
    this.setDurability(inst?.durability ?? max, max, false);
  }

  /** 2026-09-16: no primary equipped — the panel stays up as an empty frame (`.wp-empty`). */
  private showEmpty(): void {
    this.shownSlot = null;
    this.shownUid = '';
    this.weaponId = '';
    this.weaponUid = '';
    toggleClass(this.root, 'wp-empty', true);
    setText(this.typeEl, EMPTY_TYPE_TEXT);
    this.setThumb(undefined);
    this.setModes(undefined);
    this.setSingleAmmo(false);
    setText(this.magEl, '—');
    setText(this.reserveEl, '');
    toggleClass(this.magEl, 'empty', false);
    toggleClass(this.magEl, 'low', false);
    this.setDurability(1, 1, false);
    /* reload + swap state live in `hud/ReloadGauge` (it hides itself on death / reset / cancel) */
  }

  /** The other primary's thumbnail + its slot key, only when both primaries are equipped. */
  private updateSide(slot: WeaponSlot | null): void {
    const other: PrimarySlot | null = slot === 'primary' ? 'primary2' : slot === 'primary2' ? 'primary' : null;
    const inst = other ? this.loadout[other] : null;
    const stamp = other && inst ? `${other}|${inst.defId}` : '';
    if (stamp === this.sideStamp) return;
    this.sideStamp = stamp;
    this.sideEl.hidden = !stamp;
    this.sideThumb.replaceChildren();
    if (!other || !inst) return;
    // 키는 그릴 때마다 읽는다 — 리바인드는 `input:bindingsChanged` 가 stamp 를 지워 여기로 다시 들어온다
    paintKeycap(this.sideKeyEl, other === 'primary' ? Keys.PRIMARY : Keys.PRIMARY2);
    const def = this.ctx?.inventory?.getDef(inst.defId) ?? this.ctx?.loot?.getItemDef(inst.defId);
    this.sideThumb.appendChild(buildItemChip(def, { size: SIDE_THUMB_SIZE }));
  }

  /**
   * Rebuild the weapon thumbnail (the shared inventory chip, so icon + rarity colour match the bag).
   * 2026-09-16: 틀 없이 칩만 — 옛 등급색 정사각 배경(`--wrc`)은 없앴다.
   */
  private setThumb(def: ItemDef | undefined): void {
    this.thumbIcon.replaceChildren();
    if (def) this.thumbIcon.appendChild(buildItemChip(def, { size: WEAPON_THUMB_SIZE }));
    toggleClass(this.thumbEl, 'is-empty', !def);
  }

  private isActive(uid: string, weaponId: string): boolean {
    if (this.weaponUid) return uid === this.weaponUid;
    return weaponId === this.weaponId;
  }

  /** `좌: … / 우: …` mode lines for unique weapons (`.weapon.has-modes`); hidden for every graded weapon. */
  private setModes(def: WeaponDef | undefined): void {
    const modes = def && (def.altFire || def.unique) && def.unique ? UNIQUE_MODES[def.unique] : null;
    toggleClass(this.root, 'has-modes', !!modes);
    setText(this.modeL, modes ? modes.l : '');
    setText(this.modeR, modes ? modes.r : '');
  }

  /** Whether the unique fire-mode lines are showing (debug). */
  get hasModes(): boolean { return this.root.classList.contains('has-modes'); }

  /** 2026-09-16 (debug / smoke): big panel dimmed · empty state · side thumbnail def id + its key stamp. */
  get view(): { dim: boolean; empty: boolean; slot: WeaponSlot | null; side: string | null; sideKey: string | null } {
    const side = this.sideEl.hidden ? null : (this.sideThumb.querySelector<HTMLElement>('.item-chip')?.dataset.defId ?? null);
    return {
      dim: this.dim,
      empty: this.root.classList.contains('wp-empty'),
      slot: this.shownSlot,
      side,
      sideKey: this.sideEl.hidden ? null : (this.sideKeyEl.dataset.kc ?? null),
    };
  }

  private setAmmo(mag: number, reserve: number): void {
    if (this.singleAmmo) {
      // 2026-09-15 활: 탄창이 없다 — 가진 화살 전부 한 숫자. 「적다」는 마지막 한 탄창분(`magSize`) 이하.
      const total = Math.max(0, mag) + Math.max(0, reserve);
      setText(this.magEl, String(total));
      setText(this.reserveEl, '');
      toggleClass(this.magEl, 'empty', total <= 0);
      toggleClass(this.magEl, 'low', total > 0 && total <= this.magSize);
      return;
    }
    setText(this.magEl, String(mag));
    setText(this.reserveEl, String(reserve));
    const ratio = mag / this.magSize;
    toggleClass(this.magEl, 'empty', mag <= 0);
    toggleClass(this.magEl, 'low', mag > 0 && ratio <= 0.25);
  }

  /** Enter / leave the one-number ammo readout (the bow). */
  private setSingleAmmo(on: boolean): void {
    this.singleAmmo = on;
    toggleClass(this.root, 'single-ammo', on);
  }

  /** 2026-09-15: the ammo readout is one number (bow) (debug / smoke). */
  get isSingleAmmo(): boolean { return this.singleAmmo; }

  /** Durability bar: grey → amber (`.worn` < 30 %) → red (`.broken` at 0, flashes when `flash`). */
  private setDurability(value: number, max: number, flash: boolean): void {
    const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
    if (Math.abs(ratio - this.lastDura) > 0.002) {
      this.lastDura = ratio;
      this.duraFill.style.transform = `scaleX(${ratio.toFixed(3)})`;
    }
    const broken = value <= 0;
    toggleClass(this.duraEl, 'worn', !broken && ratio < DURABILITY_WORN);
    toggleClass(this.duraEl, 'broken', broken);
    toggleClass(this.root, 'broken', broken);
    if (flash) {
      this.root.classList.remove('broken-flash');
      void this.root.offsetWidth;
      this.root.classList.add('broken-flash');
    }
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
