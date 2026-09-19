/**
 * src/inventory/parts/LaunchCheck.ts — **the launch readiness check** (2026-09-08).
 *
 * A read-only check `hub/` calls right before boarding a launch pod. It sweeps every `LaunchWarningId` and gives each
 * one's reason as two Korean lines (`text` headline + `detail`). It changes nothing and blocks nothing — the popup is a warning.
 * The order is exactly the `LaunchWarningId` enum order (a contract rule — the popup always reads in the same order).
 *
 *   1. **No primary** — 주무기 I · II are both empty (a secondary alone does not pass).
 *   2. **Low ammo** — for each calibre of the equipped weapons, held when the total rounds held are under **one set**
 *      (one grid cell of that calibre's stack, `AMMO_STACK_ROUNDS`). Total rounds =
 *      the ammo items in the bag + the stash + that weapon's magazine. With no weapon this item is skipped (1 already says it).
 *   3. **No bag** · 4. **No armor** — that equipment slot is empty.
 *   5. **No tactical implant** — `ctx.implants.equipped` is null.
 *   6. **No healing item** — not one `category: 'stim'` in the bag (what sits in the stash cannot be taken out).
 *   7. **No preparation** (2026-09-11, A-13) — the target planet has a permanent environment and nothing that blocks
 *      it is loaded. The target planet is known only to `ctx.hub.planet`, the loaded preparation only to
 *      `ctx.progression.hasEnvPrep(env)`. Like every other item it **does not block** — going in bare only drains hp (user's decision: a soft gate).
 *   8. **No meal** (2026-09-11, A-3c) — `ctx.progression.getMeal()` is empty. It **does not block** either.
 *      2026-09-12 (user's decision): it comes up **only on a ship that has a kitchen (a cook bench)** — `ctx.housing.getBenchLevel('cook')`.
 *   9. **No corporation contract** (2026-09-12, user's decision) — `ctx.meta.activeContract` is null. It **does not block** either.
 *  10. **A plate about to be cleared** (2026-09-16, the plate model) — the dining table holds an uneaten plate and another meal is already loaded (`plateDiscard`).
 *      With the meal empty, 8 says it instead as 「식탁의 요리를 먹지 않았습니다」. It **does not block** either.
 */
import type { AmmoType, ItemDef, LaunchWarning } from '@/shared';
import { AMMO_STACK_ROUNDS, ENV_DESC_KO, ENV_LABEL_KO, getMealDef, getPlanet, mealQualityStars, normalizeMealQuality } from '@/shared';
import { ITEM_DEF_MAP, boostItemOf, getWeaponDef, shieldChargeOf } from '@/items';
import { WEAPON_SLOT_IDS } from '../model';
import type { InventorySystem } from '../InventorySystem';

/** One set = one grid cell of that calibre's stack. An unregistered calibre is read conservatively as 1 round (no warning spam). */
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

  /* 1. Primary */
  if (!loadout.primary && !loadout.primary2) {
    out.push({ id: 'noPrimary', text: '주무기가 없습니다', detail: '주무기 칸이 둘 다 비어 있습니다 — 보조무기만으로는 버티기 어렵습니다.' });
  }

  /* 2. Ammo — at least one set per calibre of the equipped weapons */
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
    // Total rounds held: ammo items (bag + stash) + what sits in the magazines of the weapons of this calibre
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

  /* 3 · 4. Bag · armor */
  if (!loadout.bag) out.push({ id: 'noBag', text: '가방이 없습니다', detail: '가방 없이는 전리품을 거의 못 담습니다.' });
  if (!loadout.armor) out.push({ id: 'noArmor', text: '방탄복이 없습니다', detail: '피해 감소가 하나도 없습니다.' });

  /* 5. Tactical implant */
  let implant: string | null = null;
  try { implant = sys.ctx.implants?.equipped ?? null; } catch { implant = null; }
  if (!implant) out.push({ id: 'noImplant', text: '전술 임플란트가 없습니다', detail: '인벤토리 장착 장비 칸에서 하나 고르세요.' });

  /* 6. Healing items (only what is in the bag — what sits in the stash cannot be taken out)
   *    2026-09-10: a shield charger is `category: 'stim'` too, but it refills no hp, so it is not counted here.
   *    2026-09-12: the three combat consumables (`boostItemOf` — 아드레날린 · 각성제 · 안정제) are left out for the same reason. */
  let heals = 0;
  try { heals = sys.countWhere((d) => d.category === 'stim' && !shieldChargeOf(d.id) && !boostItemOf(d.id)); } catch { heals = 0; }
  if (heals <= 0) out.push({ id: 'noHeal', text: '회복 아이템이 없습니다', detail: '가방에 붕대나 주사기를 넣어 두세요.' });

  /* 7. Preparation — is something loaded that blocks the target planet's permanent environment (2026-09-11, A-13).
   *    Both refs are touched optionally: the check has to run on a tree with no hub or progression too (the training range · smokes). */
  try {
    const env = getPlanet(sys.ctx.hub?.planet ?? null)?.env ?? null;
    if (env && sys.ctx.progression?.hasEnvPrep?.(env) !== true) {
      out.push({
        id: 'noEnvPrep',
        text: `이 행성은 ${ENV_LABEL_KO[env]} 환경입니다`,
        detail: `${ENV_DESC_KO[env]} 연구실 조합대에서 준비물을 만들어 함선에서 쓰세요.`,
      });
    }
  } catch { /* hub · progression not there yet — no warning spam */ }

  /* 8. Meal — a dish eaten at the kitchen's dining table loads one raid's worth for the next raid (2026-09-11, A-3c).
   *    Exactly like `noEnvPrep` it **does not block**: a soft gate, and one line of the popup. On a tree with no
   *    progression (the training range · smokes) it is silently skipped.
   *
   *    2026-09-12 (user's decision): it comes up **only on a ship that has a kitchen**. With no cook bench a dish cannot
   *    even be made, so 「식사를 차리지 않았습니다」 is nagging with no way to fix it — a warning has to be something the
   *    player can do right now. The query is `ctx.housing.getBenchLevel('cook')` alone (the highest level among the placed
   *    cook benches, 0 with none). The dining table is not read too because whoever built a cook bench can build a table,
   *    and the shared ship has a built-in one — one layer of gate, 「can it be made」, is enough. */
  /*  2026-09-16 (the plate model, user's decision): a dish is the dining table's plate and **is cleared away on launch**. 「Eaten」 =
   *  the pending meal is the plate's dish at the plate's quality; an uneaten plate says 「먹지 않은 요리가 사라진다」 — with the meal
   *  empty as `noMeal` (that is exactly the thing to do), with another meal already loaded as `plateDiscard`, last (`LaunchWarningId` order). */
  let plateUneaten: { name: string; stars: string } | null = null;
  try {
    const prog = sys.ctx.progression;
    const housing = sys.ctx.housing;
    const kitchen = (housing?.getBenchLevel?.('cook') ?? 0) > 0;
    const plate = housing?.getPlate?.() ?? null;
    const pending = prog && typeof prog.getMeal === 'function' ? prog.getMeal() : null;
    const pendingQ = pending && typeof prog?.getMealQuality === 'function' ? prog.getMealQuality() : 0;
    if (plate && !(pending === plate.mealDefId && pendingQ === normalizeMealQuality(plate.quality))) {
      const q = normalizeMealQuality(plate.quality);
      plateUneaten = { name: getMealDef(plate.mealDefId)?.name ?? plate.mealDefId, stars: q > 0 ? ` ${mealQualityStars(q)}` : '' };
    }
    if (prog && typeof prog.getMeal === 'function' && !pending && plateUneaten) {
      out.push({
        id: 'noMeal',
        text: '식탁의 요리를 먹지 않았습니다',
        detail: `출격하면 식탁의 「${plateUneaten.name}${plateUneaten.stars}」 이(가) 치워집니다 — 먹어 두면 다음 레이드 1회분이 실립니다.`,
      });
      plateUneaten = null;                              // the same thing is not said a second time at the end of the list
    } else if (kitchen && prog && typeof prog.getMeal === 'function' && !pending) {
      out.push({
        id: 'noMeal',
        text: '식사를 차리지 않았습니다',
        detail: '조리대에서 요리하면 식탁에 차려집니다 — 식탁에서 먹어 두면 다음 레이드 1회분이 실립니다.',
      });
    }
  } catch { /* progression · housing not there yet */ plateUneaten = null; }

  /* 9. Corporation contract — launching with no accepted contract (2026-09-12, user's decision).
   *    Exactly like every other item it **does not block**. A raid run with no contract is normal, but one run is long, and
   *    realising 「I never took a contract」 only after coming back is the biggest waste — so it asks once before the launch.
   *    `ctx.meta.activeContract` is the only query (there is exactly one accepted contract, null with none). */
  try {
    const meta = sys.ctx.meta;
    if (meta && !meta.activeContract) {
      out.push({
        id: 'noContract',
        text: '진행 중인 기업 계약이 없습니다',
        detail: '함선 컴퓨터의 기업 네트워크에서 계약을 하나 수락하면 이번 레이드의 전리품이 곧바로 보상이 됩니다.',
      });
    }
  } catch { /* meta not there yet — the training range · smokes */ }

  /* 10. A plate about to be cleared (2026-09-16, the plate model) — another meal is loaded and an uneaten dish is left on the table. Does not block. */
  if (plateUneaten) {
    out.push({
      id: 'plateDiscard',
      text: '식탁의 요리가 치워집니다',
      detail: `먹지 않은 「${plateUneaten.name}${plateUneaten.stars}」 은(는) 출격할 때 사라집니다 — 지금 실린 식사는 그대로입니다.`,
    });
  }

  return out;
}
