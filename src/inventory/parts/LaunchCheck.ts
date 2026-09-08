/**
 * src/inventory/parts/LaunchCheck.ts — **출격 준비 점검** (2026-09-08).
 *
 * 발사 슬롯에 타기 직전 `hub/` 가 부르는 읽기 전용 점검. 여섯 가지를 훑고 각각의 이유를 한국어 두 줄
 * (`text` 표제 + `detail` 상세)로 돌려준다. 아무것도 바꾸지 않고, 아무것도 막지 않는다 — 팝업은 경고일 뿐이다.
 *
 *   1. **주무기 없음** — 주무기 I · II 둘 다 비었다 (보조무기만으로는 통과하지 못한다).
 *   2. **탄약 부족** — 장착한 무기 하나하나의 구경마다, 가지고 있는 총 탄수가 **한 세트**(그 구경의 스택 한 칸,
 *      `AMMO_STACK_ROUNDS` — 중량탄이면 25발) 미만이면 걸린다. 총 탄수 = 가방 + 함선 창고의 탄약 아이템 +
 *      그 무기 탄창에 든 것. 무기를 안 들었으면 이 항목은 건너뛴다 (1번이 이미 말해 준다).
 *   3. **가방 없음** · 4. **방탄복 없음** — 해당 장비 칸이 비었다.
 *   5. **전술 임플란트 없음** — `ctx.implants.equipped` 가 null.
 *   6. **회복 아이템 없음** — 가방에 `category: 'stim'` 이 하나도 없다 (창고에 있는 건 못 들고 나간다).
 */
import type { AmmoType, ItemDef, LaunchWarning } from '@/shared';
import { AMMO_STACK_ROUNDS } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef } from '@/items';
import { WEAPON_SLOT_IDS } from '../model';
import type { InventorySystem } from '../InventorySystem';

/** 한 세트 = 그 구경의 스택 한 칸. 미등록 구경은 보수적으로 1발로 본다 (경고를 남발하지 않는다). */
function setSizeOf(ammo: AmmoType): number {
  const n = AMMO_STACK_ROUNDS[ammo];
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function ammoName(ammo: AmmoType): string {
  return ITEM_DEF_MAP.get(`ammo_${ammo}`)?.name ?? String(ammo);
}

export function getLaunchWarnings(sys: InventorySystem): LaunchWarning[] {
  const out: LaunchWarning[] = [];
  const loadout = sys.getLoadout();
  const def = (id: string | undefined): ItemDef | undefined => (id ? ITEM_DEF_MAP.get(id) : undefined);

  /* 1. 주무기 */
  if (!loadout.primary && !loadout.primary2) {
    out.push({ id: 'noPrimary', text: '주무기가 없습니다', detail: '주무기 칸이 둘 다 비어 있습니다 — 보조무기만으로는 버티기 어렵습니다.' });
  }

  /* 2. 탄약 — 장착한 무기의 구경마다 한 세트 이상 */
  const shortages: string[] = [];
  const seen = new Set<AmmoType>();
  for (const slot of WEAPON_SLOT_IDS) {
    const item = loadout[slot];
    if (!item) continue;
    const d = def(item.defId);
    const weapon = d?.weaponId ? getWeaponDef(d.weaponId) : undefined;
    const ammo = weapon?.ammoType;
    if (!ammo || seen.has(ammo)) continue;
    seen.add(ammo);
    const need = setSizeOf(ammo);
    // 소지한 총 탄수: 탄약 아이템(가방 + 창고) + 이 구경 무기들의 탄창에 든 것
    let have = sys.countDefAll(`ammo_${ammo}`);
    for (const s2 of WEAPON_SLOT_IDS) {
      const it = loadout[s2];
      if (!it) continue;
      const wd = def(it.defId)?.weaponId;
      if (wd && getWeaponDef(wd)?.ammoType === ammo) have += Math.max(0, it.ammoInMag ?? 0);
    }
    if (have < need) shortages.push(`${ammoName(ammo)} ${have} / ${need}발`);
  }
  if (shortages.length > 0) {
    out.push({ id: 'lowAmmo', text: '탄약이 한 세트도 안 됩니다', detail: shortages.join(' · ') });
  }

  /* 3 · 4. 가방 · 방탄복 */
  if (!loadout.bag) out.push({ id: 'noBag', text: '가방이 없습니다', detail: '가방 없이는 전리품을 거의 못 담습니다.' });
  if (!loadout.armor) out.push({ id: 'noArmor', text: '방탄복이 없습니다', detail: '피해 감소가 하나도 없습니다.' });

  /* 5. 전술 임플란트 */
  let implant: string | null = null;
  try { implant = sys.ctx.implants?.equipped ?? null; } catch { implant = null; }
  if (!implant) out.push({ id: 'noImplant', text: '전술 임플란트가 없습니다', detail: '인벤토리 장착 장비 칸에서 하나 고르세요.' });

  /* 6. 회복 아이템 (가방에 든 것만 — 창고에 있는 건 못 들고 나간다) */
  let heals = 0;
  try { heals = sys.countWhere((d) => d.category === 'stim'); } catch { heals = 0; }
  if (heals <= 0) out.push({ id: 'noHeal', text: '회복 아이템이 없습니다', detail: '가방에 붕대나 주사기를 넣어 두세요.' });

  return out;
}
