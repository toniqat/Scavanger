import type { GameContext, ItemDef, ItemInstance, UniqueWeaponKind, WeaponDef } from '@/shared';
import { DEFIB_USE_TIME_S, Keys, WEAPON_DEFAULT_DURABILITY, keyLabel } from '@/shared';
import { buildItemChip } from '@/shared';
import { WEAPON_CLASS_LABEL_KO, weaponClassOf } from '@/items';
import { el, rarityColor, setText, toggleClass } from '../dom';
import '../styles/raidHud.css';

/** Durability ratio at/below which the bar turns amber (`.worn`). */
const DURABILITY_WORN = 0.3;

/** Thumbnail edge of the weapon chip in the bottom-right box (2026-09-10: 34 → 58, the name line that shared the box is gone). */
const WEAPON_THUMB_SIZE = 58;

/** Usage hint per consumable category (`.weapon.consumable .hint`). */
const CONSUMABLE_HINT: Record<string, string> = {
  // 2026-09-07: each 회복 소모품 states its own hold (`ItemDef.heal.useTime`), so the line is built per item
  // (`consumableHint`) and this is only the fallback per category. The ring itself is `hud/HealGauge`.
  stim: '좌클릭 홀드',
  grenade: '좌클릭 홀드 · R 코킹 · 우클릭 언더핸드',
};

/** Usage hint for the item in hand: the real hold time / 스프레이 channel when the def declares one. */
function consumableHint(def: ItemDef | undefined): string {
  const heal = def?.heal;
  if (heal?.spray) return '좌클릭 홀드 · 게이지 소모';
  if (heal) return `좌클릭 ${heal.useTime}초 홀드 · 이동 50 %`;
  if (def?.gadgetId === 'defib') return `좌클릭 ${DEFIB_USE_TIME_S}초 홀드 · 이동 50 %`;
  return CONSUMABLE_HINT[def?.category ?? ''] ?? '좌클릭 사용';
}

/** Fixed `좌: … / 우: …` fire-mode texts per unique weapon kind (`WeaponDef.altFire` — RMB is an alternative fire, not ADS). */
const UNIQUE_MODES: Readonly<Record<UniqueWeaponKind, { l: string; r: string }>> = {
  flamethrower: { l: '넓은 화염', r: '긴 화염 제트' },
  shockgun: { l: '연쇄 전격', r: '충전 볼트' },
  shuriken: { l: '표창 1개', r: '표창 3개 (F 길게: 용검)' },
  bow: { l: '화살', r: '정조준' },
  bazooka: { l: '착탄 로켓', r: '공중 폭발 (바닥 우클릭: 로켓 점프)' },
  minigun: { l: '예열 후 사격', r: '—' },
};

/**
 * Bottom-right weapon readout: durability bar, then one row of **썸네일 ← → 잔탄 / 예비탄**, then the class tag,
 * plus the low / empty / broken states. The reload readout moved to the crosshair in Phase 10 (`hud/ReloadGauge`) —
 * this panel no longer owns an arc or a `재장전` pill.
 *
 * 2026-09-10 (레이드 HUD 개편, 사용자 결정): 패널 **위**의 슬롯 칸(`hud/SlotStrip` 의 `1 · 2 · T`)과 패널 **아래**의
 * 주무기 키 · 무기 이름이 전부 없어졌다. 그 높이는 남은 것들이 가져간다 — 썸네일 34 → 58 px, 잔탄 40 → 64 px
 * (`styles/raidHud.css`). 무기 이름은 썸네일이 대신하므로 `.wthumb` 는 이름 없는 정사각형이 되고, 테두리 · 안쪽
 * 글로우가 **무기 등급색**(`--wrc` = `rarityColor(def.rarity)`)을 쓴다 — 아이템 칩 자체의 `--rc` 와 같은 색이라
 * 가방에서 보던 등급이 그대로 읽힌다.
 *
 * 2026-09-10 (2차, 사용자 결정): 그 총기 표시가 이제 **가로로 긴 한 상자**(`.wbox`, 어두운 반투명 + 얇은 테두리)
 * 안에 든다 — 아이콘만 떠 있는 것이 아니라 패널로 읽힌다. 좌측이 **등급색 정사각 배경**을 깐 썸네일이고
 * (`--wrc` 가 테두리 · 안쪽 글로우 · 바탕색 셋을 다 정한다), 그 오른쪽이 `24 / 120`, 맨 오른쪽이 분류 태그다.
 * `예비` 라벨은 없앴다 — base.css 의 `/ ` 구분자로 돌아간다. **내구도 바는 상자 바닥**으로 들어갔다:
 * 상자 밖 맨 위에 있을 때는 빠른 사용 칸과 무기 패널을 가르는 **흰 가로 구분선**으로 읽혔다.
 *
 * **Consumable mode** (`.weapon.consumable`, `quick:equipped {item}`): the gun rows are hidden and a `.cons` block shows
 * the item name + stack count (`quick:used.remaining` / `inventory:itemUpdated`) with a usage hint; back to gun mode on
 * `quick:equipped {item:null}` or the next `weapon:equipped`. Gun state keeps updating underneath, so the switch back is
 * just a class toggle.
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

  private consName: HTMLElement;
  private consKey: HTMLElement;
  private consCnt: HTMLElement;
  private consHint: HTMLElement;
  private consUid = '';
  private consumable = false;

  private weaponId = '';
  private weaponUid = '';
  private magSize = 1;
  private lastDura = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'weapon', parent });

    // 2026-09-10 (2차, 사용자 결정): 총기 표시는 **가로로 긴 한 상자**(`.wbox`) 안에 든다 —
    // 좌측 등급색 정사각 썸네일 · 잔탄 `24 / 120` · 맨 오른쪽 분류 태그, 그리고 상자 **바닥**에 내구도 바.
    // 내구도 바가 상자 밖 맨 위에 있을 때는 빠른 사용 칸과 무기 패널 사이를 가르는 **흰 구분선**으로 읽혔다.
    // `.cons` · `.modes` 는 상자 밖에 그대로 남는다 (base.css 의 `.weapon.consumable > …` 규칙을 지킨다).
    const box = el('div', { cls: 'wbox', parent: this.root });
    // Phase 10: the reload arc that used to sit left of this row is gone — `hud/ReloadGauge` draws it at the crosshair.
    // 2026-09-10: 썸네일이 **왼쪽**, 숫자가 오른쪽이다 (예전에는 반대였다).
    const ammoRow = el('div', { cls: 'ammo-row', parent: box });
    this.thumbEl = el('div', { cls: 'wthumb', parent: ammoRow });
    this.thumbIcon = el('div', { cls: 'wt-icon', parent: this.thumbEl });
    const ammoNums = el('div', { cls: 'ammo-nums', parent: ammoRow });
    this.magEl = el('span', { cls: 'mag', text: '0', parent: ammoNums });
    this.reserveEl = el('span', { cls: 'reserve', text: '0', parent: ammoNums });

    const tagRow = el('div', { cls: 'name-row', parent: ammoRow });
    this.typeEl = el('span', { cls: 'type', text: '—', parent: tagRow });

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

    // Consumable mode block (stim / grenade in hand) — shown instead of the gun rows via `.weapon.consumable`.
    const cons = el('div', { cls: 'cons', parent: this.root });
    const consRow = el('div', { cls: 'name-row', parent: cons });
    this.consKey = el('span', { cls: 'slot', text: keyLabel(Keys.QUICK), parent: consRow });
    el('span', { cls: 'slot-lbl', text: '빠른 사용', parent: consRow });
    this.consName = el('span', { cls: 'name', text: '—', parent: consRow });
    const consCntRow = el('div', { cls: 'ammo-row', parent: cons });
    this.consCnt = el('span', { cls: 'mag', text: '0', parent: consCntRow });
    el('span', { cls: 'cnt-lbl', text: '개', parent: consCntRow });
    this.consHint = el('div', { cls: 'hint', text: '', parent: cons });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('input:bindingsChanged', () => setText(this.consKey, keyLabel(Keys.QUICK))),
      b.on('quick:equipped', ({ item }) => {
        if (item) this.enterConsumable(item, ctx); else this.exitConsumable();
      }),
      b.on('quick:used', ({ item, remaining }) => {
        if (this.consumable && item.uid === this.consUid) this.setConsCount(remaining);
      }),
      // 2026-09-11: 기폭기 손의 개수 = 월드에 남은 내 원격 지뢰 — 설치 · 제거(기폭 포함)마다 다시 센다
      b.on('gadget:deployed', () => { if (this.isDetonator) this.setConsCount(ctx.gadgets?.liveRemoteMineCount?.() ?? 0); }),
      b.on('gadget:removed', () => { if (this.isDetonator) this.setConsCount(ctx.gadgets?.liveRemoteMineCount?.() ?? 0); }),
      b.on('inventory:itemUpdated', () => {
        if (!this.consumable || !this.consUid) return;
        const inst = ctx.inventory?.findItem(this.consUid);
        if (inst) this.setConsCount(inst.qty);
      }),
      b.on('weapon:equipped', (p) => {
        this.exitConsumable();
        this.weaponId = p.weaponId;
        this.magSize = Math.max(1, p.magSize);
        const def = ctx.loot?.getWeaponDef(p.weaponId);
        // Phase 9 UI pass: the slot word (주무기 …) and the calibre (준중량탄 …) are gone — the numbered chip and the class say enough.
        setText(this.typeEl, def ? WEAPON_CLASS_LABEL_KO[weaponClassOf(def)] : '—');
        this.setModes(def);
        this.setAmmo(p.ammoInMag, p.reserveRounds);
        // Seed the durability bar from the equipped item instance (durabilityChanged only fires on change).
        const inst = ctx.inventory?.getLoadout()[p.slot] ?? null;
        this.weaponUid = inst?.uid ?? '';
        // the item def behind the equipped weapon (`wpn_<id>` for graded guns) drives the thumbnail
        const itemDefId = inst?.defId ?? `wpn_${p.weaponId}`;
        this.setThumb(ctx.inventory?.getDef(itemDefId) ?? ctx.loot?.getItemDef(itemDefId));
        const max = def?.maxDurability ?? WEAPON_DEFAULT_DURABILITY;
        this.setDurability(inst?.durability ?? max, max, false);
      }),
      b.on('weapon:ammoChanged', (p) => {
        if (p.weaponId !== this.weaponId && this.weaponId) return;
        this.magSize = Math.max(1, p.magSize);
        this.setAmmo(p.ammoInMag, p.reserveRounds);
      }),
      b.on('weapon:durabilityChanged', (p) => {
        if (!this.isActive(p.uid, p.weaponId)) return;
        this.setDurability(p.durability, p.max, false);
      }),
      b.on('weapon:broken', (p) => {
        if (!this.isActive(p.uid, p.weaponId)) return;
        this.setDurability(0, 1, true);
      }),
      // 2026-09-10: 슬롯 칸이 없어져 교체는 이 패널에서 아무것도 하지 않는다 — 타이머는 크로스헤어 링
      // (`hud/ReloadGauge`) 이고, 새 무기의 썸네일 · 잔탄은 곧 오는 `weapon:equipped` 가 갈아 끼운다.
      b.on('weapon:dryFire', () => {
        this.magEl.classList.remove('flash');
        void this.magEl.offsetWidth;
        this.magEl.classList.add('flash');
      }),
      b.on('loadout:changed', ({ primary, primary2, secondary }) => {
        if (!primary && !primary2 && !secondary) {
          this.weaponId = '';
          this.weaponUid = '';
          setText(this.typeEl, '—');
          this.setThumb(undefined);
          this.setModes(undefined);
          this.setAmmo(0, 0);
          this.setDurability(1, 1, false);
          /* reload + swap state live in `hud/ReloadGauge` now (it hides itself on death / reset / cancel) */
        }
      }),
    );
  }

  /**
   * Rebuild the weapon thumbnail (the shared inventory chip, so icon + rarity colour match the bag).
   * 2026-09-10: 상자 자신도 **무기 등급색**으로 칠한다 — `--wrc` 는 칩이 쓰는 `--rc` 와 같은 값
   * (`rarityColor` → base.css 의 `--r-*`), 그래서 등급이 한눈에 읽힌다.
   */
  private setThumb(def: ItemDef | undefined): void {
    this.thumbIcon.replaceChildren();
    if (def) this.thumbIcon.appendChild(buildItemChip(def, { size: WEAPON_THUMB_SIZE }));
    const rc = def ? rarityColor(def.rarity) : '';
    if (this.thumbEl.style.getPropertyValue('--wrc') !== rc) this.thumbEl.style.setProperty('--wrc', rc);
    toggleClass(this.thumbEl, 'is-empty', !def);
  }

  private enterConsumable(item: ItemInstance, ctx: GameContext): void {
    const def = ctx.inventory?.getDef(item.defId) ?? ctx.loot?.getItemDef(item.defId);
    this.consUid = item.uid;
    this.consumable = true;
    // 2026-09-11: 기폭기 손 (weapons — 마지막 원격 지뢰를 놓은 뒤 슬롯 없이 남는 손, uid `detonator:<defId>`).
    // 개수 칸은 가방이 아니라 **월드에 남은 내 원격 지뢰** 수다.
    const det = this.isDetonator;
    setText(this.consName, det ? '기폭기' : (def?.name ?? item.defId));
    setText(this.consHint, det ? '우클릭 기폭' : consumableHint(def));
    this.setConsCount(det ? (ctx.gadgets?.liveRemoteMineCount?.() ?? 0) : item.qty);
    toggleClass(this.root, 'consumable', true);
  }

  /** 2026-09-11: 손에 든 것이 슬롯 없는 기폭기인가 (`quick:equipped.item.uid` 가 `detonator:` 로 시작). */
  private get isDetonator(): boolean { return this.consumable && this.consUid.startsWith('detonator:'); }

  private exitConsumable(): void {
    if (!this.consumable) return;
    this.consumable = false;
    this.consUid = '';
    toggleClass(this.root, 'consumable', false);
  }

  private setConsCount(n: number): void {
    setText(this.consCnt, String(Math.max(0, n)));
    toggleClass(this.consCnt, 'empty', n <= 0);
    toggleClass(this.consCnt, 'low', n === 1);
  }

  /** Whether a consumable (stim / grenade) is in hand instead of a gun. */
  get isConsumable(): boolean { return this.consumable; }

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

  private setAmmo(mag: number, reserve: number): void {
    setText(this.magEl, String(mag));
    setText(this.reserveEl, String(reserve));
    const ratio = mag / this.magSize;
    toggleClass(this.magEl, 'empty', mag <= 0);
    toggleClass(this.magEl, 'low', mag > 0 && ratio <= 0.25);
  }

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
