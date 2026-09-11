/**
 * src/inventory/parts/LaunchCheck.ts — **출격 준비 점검** (2026-09-08).
 *
 * 발사 슬롯에 타기 직전 `hub/` 가 부르는 읽기 전용 점검. 아홉 가지를 훑고 각각의 이유를 한국어 두 줄
 * (`text` 표제 + `detail` 상세)로 돌려준다. 아무것도 바꾸지 않고, 아무것도 막지 않는다 — 팝업은 경고일 뿐이다.
 * 순서는 `LaunchWarningId` 의 열거 순서 그대로다 (계약에 적힌 규약 — 팝업이 매번 같은 순서로 읽힌다).
 *
 *   1. **주무기 없음** — 주무기 I · II 둘 다 비었다 (보조무기만으로는 통과하지 못한다).
 *   2. **탄약 부족** — 장착한 무기 하나하나의 구경마다, 가지고 있는 총 탄수가 **한 세트**(그 구경의 스택 한 칸,
 *      `AMMO_STACK_ROUNDS` — 중량탄이면 25발) 미만이면 걸린다. 총 탄수 = 가방 + 함선 창고의 탄약 아이템 +
 *      그 무기 탄창에 든 것. 무기를 안 들었으면 이 항목은 건너뛴다 (1번이 이미 말해 준다).
 *   3. **가방 없음** · 4. **방탄복 없음** — 해당 장비 칸이 비었다.
 *   5. **전술 임플란트 없음** — `ctx.implants.equipped` 가 null.
 *   6. **회복 아이템 없음** — 가방에 `category: 'stim'` 이 하나도 없다 (창고에 있는 건 못 들고 나간다).
 *   7. **준비물 없음** (2026-09-11, A-13) — 목표 행성에 상시 환경이 있는데 그것을 막는 준비물을 안 실었다.
 *      목표 행성을 아는 곳은 `ctx.hub.planet` 하나뿐이고, 실린 준비물은 `ctx.progression.hasEnvPrep(env)` 다.
 *      다른 여섯과 똑같이 **막지 않는다** — 맨몸으로 들어가면 체력이 계속 깎일 뿐이다 (사용자 결정: 소프트 게이트).
 *   8. **식사 없음** (2026-09-11, A-3c) — `ctx.progression.getMeal()` 이 비었다. 역시 **막지 않는다**.
 *      2026-09-12 (사용자 결정): **주방(조리대)이 있는 함선에서만** 올라온다 — `ctx.housing.getBenchLevel('cook')`.
 *   9. **기업 계약 없음** (2026-09-12, 사용자 결정) — `ctx.meta.activeContract` 가 null. 역시 **막지 않는다**.
 */
import type { AmmoType, ItemDef, LaunchWarning } from '@/shared';
import { AMMO_STACK_ROUNDS, ENV_DESC_KO, ENV_LABEL_KO, getPlanet } from '@/shared';
import { ITEM_DEF_MAP, getWeaponDef, shieldChargeOf } from '@/items';
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

  /* 6. 회복 아이템 (가방에 든 것만 — 창고에 있는 건 못 들고 나간다)
   *    2026-09-10: 실드 충전기도 `category: 'stim'` 이지만 체력을 채우지 않으므로 여기서는 세지 않는다. */
  let heals = 0;
  try { heals = sys.countWhere((d) => d.category === 'stim' && !shieldChargeOf(d.id)); } catch { heals = 0; }
  if (heals <= 0) out.push({ id: 'noHeal', text: '회복 아이템이 없습니다', detail: '가방에 붕대나 주사기를 넣어 두세요.' });

  /* 7. 준비물 — 목표 행성의 상시 환경을 막을 것을 실었나 (2026-09-11, A-13).
   *    ref 둘 다 선택적으로 만진다: 훈련장 · 스모크처럼 hub 나 progression 이 없는 트리에서도 점검이 돌아야 한다. */
  try {
    const env = getPlanet(sys.ctx.hub?.planet ?? null)?.env ?? null;
    if (env && sys.ctx.progression?.hasEnvPrep?.(env) !== true) {
      out.push({
        id: 'noEnvPrep',
        text: `이 행성은 ${ENV_LABEL_KO[env]} 환경입니다`,
        detail: `${ENV_DESC_KO[env]} 연구실 조합대에서 준비물을 만들어 함선에서 쓰세요.`,
      });
    }
  } catch { /* hub · progression 이 아직 없다 — 경고를 남발하지 않는다 */ }

  /* 8. 식사 — 주방 식탁에서 요리를 먹어 두면 다음 레이드 1회분이 실린다 (2026-09-11, A-3c).
   *    `noEnvPrep` 과 똑같이 **막지 않는다**: 소프트 게이트이고 팝업의 한 줄일 뿐이다. progression 이 없는
   *    트리(훈련장 · 스모크)에서는 조용히 건너뛴다.
   *
   *    2026-09-12 (사용자 결정): **주방이 있는 함선에서만** 올라온다. 조리대가 없으면 요리를 만들 수조차 없으니
   *    「식사를 차리지 않았습니다」는 고칠 길이 없는 잔소리다 — 경고는 플레이어가 지금 할 수 있는 일이어야 한다.
   *    질의는 `ctx.housing.getBenchLevel('cook')`(배치된 조리대 중 가장 높은 레벨, 없으면 0) 하나다. 식탁까지
   *    보지 않는 이유: 조리대를 지은 사람은 식탁도 지을 수 있고, 공유 함선에는 붙박이 식탁이 있어 조리대만으로
   *    먹을 길이 열린다 — 게이트는 「만들 수 있느냐」 한 겹이면 된다. */
  try {
    const prog = sys.ctx.progression;
    const kitchen = (sys.ctx.housing?.getBenchLevel?.('cook') ?? 0) > 0;
    if (kitchen && prog && typeof prog.getMeal === 'function' && !prog.getMeal()) {
      out.push({
        id: 'noMeal',
        text: '식사를 차리지 않았습니다',
        detail: '주방 식탁에서 요리를 먹어 두면 다음 레이드 1회분이 실립니다.',
      });
    }
  } catch { /* progression · housing 이 아직 없다 */ }

  /* 9. 기업 계약 — 수락한 계약 없이 나가려 한다 (2026-09-12, 사용자 결정).
   *    다른 여덟과 똑같이 **막지 않는다**. 계약 없이 도는 레이드도 정상이지만 한 판은 길고, 돌아와서야
   *    「계약을 안 걸었네」를 깨닫는 것이 가장 아깝다 — 그래서 나가기 전에 한 번 묻는다.
   *    `ctx.meta.activeContract` 가 유일한 질의다(수락한 계약 하나뿐이고, 없으면 null). */
  try {
    const meta = sys.ctx.meta;
    if (meta && !meta.activeContract) {
      out.push({
        id: 'noContract',
        text: '진행 중인 기업 계약이 없습니다',
        detail: '함선 컴퓨터의 기업 네트워크에서 계약을 하나 수락하면 이번 레이드의 전리품이 곧바로 보상이 됩니다.',
      });
    }
  } catch { /* meta 가 아직 없다 — 훈련장 · 스모크 */ }

  return out;
}
