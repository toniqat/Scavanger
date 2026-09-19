import type { GadgetId, ItemDef } from '@/shared';
import {
  BOOST_ADRENALINE_DURATION_S, BOOST_STIMULANT_ADS_SPEED_MUL, BOOST_STIMULANT_AIM_SWAY_MUL,
  BOOST_STIMULANT_DURATION_S, BOOST_STIMULANT_RELOAD_SPEED_MUL, BOOST_STIMULANT_STAMINA_COST_MUL,
  DEFIB_USE_TIME_S,
  DRONE_AIR_HP, DRONE_AIR_RANGE, DRONE_GROUND_HP, DRONE_GROUND_RANGE, DRONE_RECOVER_HOLD_S,
  GADGET_BARRICADE_RADIUS, GADGET_BARRICADE_RECOVER_TIME, GADGET_CLOAK_DURATION, GADGET_CLOAK_SHARE_RADIUS,
  GADGET_DEFIB_RANGE, GADGET_DEFUSE_TIME, GADGET_DOME_RADIUS, GADGET_DOME_RECOVER_TIME,
  GADGET_INCENDIARY_DPS, GADGET_JUMPPAD_RADIUS, GADGET_LURE_DURATION, GADGET_LURE_RADIUS,
  GADGET_MINE_ARM_TIME, GADGET_MINE_DAMAGE, GADGET_MINE_RADIUS,
  GADGET_REMOTE_MINE_ARM_TIME, GADGET_REMOTE_MINE_DAMAGE, GADGET_REMOTE_MINE_MAX_LIVE, GADGET_REMOTE_MINE_RADIUS,
  GADGET_SMOKE_DURATION, GADGET_SMOKE_RADIUS, GADGET_TURRET_DPS, GADGET_TURRET_DURATION, GADGET_TURRET_RANGE,
  GRENADE_DAMAGE, GRENADE_FUSE, GRENADE_INCENDIARY_BLAST_DAMAGE, GRENADE_INCENDIARY_BLAST_RADIUS,
  GRENADE_INCENDIARY_DURATION, GRENADE_INCENDIARY_RADIUS, GRENADE_RADIUS,
  explosionDamageRange,
} from '@/shared';
import { boostItemOf, shieldChargeOf } from './ItemDefs';
/* 2026-09-15 (the sandworm · the thumper) */
import { THUMPER_HP, THUMPER_INTERVAL_S, THUMPER_STRIKES } from '@/shared';

/* ════════════════════════════════════════════════════════════════════════════
 * Item **spec rows** (2026-09-15, the gadget rework · user's decision)
 *
 * The result of pushing 「descriptions never repeat numbers the tooltip already shows」(2026-09-12) out to
 * healing items · combat consumables · gadgets · grenades: every number was taken out of `description` in
 * `data/items.csv`, and this one place turns those numbers into sentences. **Two tooltips call the same
 * function** — `ui/hud/ItemTip` (chip · currency card) and `inventory/ui/Tooltip` (grid card). If each built
 * its own, the same item would state different numbers on different screens (2026-09-10 「the same formula in
 * two folders moves to shared」).
 *
 * **Not one number is written here** — they all come from `data/constants.csv` → the constants of `@/shared`,
 * and the item-side values (`gadgetUseTime` · `durabilityMax` · `heal*`) are cells of `data/items.csv`.
 * `src/gadgets/GadgetDefs` is not imported because cross-folder imports are banned — both read the same
 * constants, so the values always agree; `GadgetDef` owns the **behaviour** and this table owns the **rows
 * drawn on the card**.
 *
 * So that a value can be split in two colours, `SpecRow.v` is a string **or a list of segments** (`SpecSeg[]`):
 * in 「5초간 매 초 HP 4 회복, 총 20 회복」 **only the numbers take the body colour, the rest is dim**.
 * ════════════════════════════════════════════════════════════════════════════ */

/** One segment of a value. `dim` = dim text (the wording around it, not the number). */
export interface SpecSeg {
  readonly text: string;
  readonly dim?: boolean;
}

/** A value is one whole string, or a list of segments whose colours differ. */
export type SpecValue = string | readonly SpecSeg[];

/** The row's tone — gain (green) · loss (red) · plain. The calling tooltip paints it from its own palette. */
export type SpecTone = 'good' | 'bad';

export interface SpecRow {
  readonly k: string;
  readonly v: SpecValue;
  readonly tone?: SpecTone;
}

/** One set of labels — both tooltips use the same words. */
export const SPEC_LABEL_KO = {
  useTime: '사용 시간',
  duration: '지속 시간',
  heal: '회복',
  radius: '반경',
  range: '사거리',
  damage: '피해',
  dps: '초당 피해',
  shield: '실드 회복',
  arm: '활성화',
  fuse: '신관',
  recover: '회수',
  defuse: '해체',
  fireZone: '화염 지대',
  maxLive: '동시 설치',
  droneRange: '조종 사거리',
  droneHp: '드론 내구도',
  deployHp: '설치물 내구도',
  blast: '폭발',
  /* 2026-09-15 (the sandworm · the thumper) */
  interval: '타격 간격',
  summon: '땅굴벌레 호출',
} as const;

/** Strips a trailing decimal zero (`5.0` → `5`, `0.315` → `0.315`). */
function n(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return String(Number(v.toFixed(3)));
}
const sec = (v: number): string => `${n(v)} s`;
/** The `사용 시간` value — 0 is not `0 s` but **`즉시`** (a thrown grenade · the channelled spray). */
const useTimeValue = (v: number): string => (v > 0 ? sec(v) : '즉시');
const metre = (v: number): string => `${n(v)} m`;
/**
 * The damage row of a two-step explosive — `outer-centre` (e.g. the frag grenade 파편 수류탄, `30-60`).
 * 2026-09-17 (user's decision): one number alone reads as if it hurt that much anywhere inside the radius. The
 * range is computed in one place, `shared/explosion.explosionDamageRange`.
 */
function blastDamage(v: number): string {
  const r = explosionDamageRange(v);
  return `${n(r.min)}-${n(r.max)}`;
}
/** A multiplier → `+30 %` / `−30 %` (above 1 = it went up) plus whether that is a gain. */
function mulPct(mul: number, betterWhenUp = true): { text: string; tone: SpecTone } {
  const pct = Math.round((mul - 1) * 100);
  return { text: `${pct >= 0 ? '+' : '−'}${Math.abs(pct)} %`, tone: (pct >= 0) === betterWhenUp ? 'good' : 'bad' };
}

/**
 * The two segment kinds a `SpecRow` value is mixed from: `num` is a highlighted number (or an already
 * formatted string), `dim` is the dim prose around it. The order is up to the sentence — a row may open with
 * either kind (`healLine` starts dim, the gadget rows start with the number).
 */
const num = (v: number | string): SpecSeg => ({ text: typeof v === 'number' ? n(v) : v });
const dim = (t: string): SpecSeg => ({ text: t, dim: true });

/* ── gadgets · grenades ────────────────────────────────────────────────────── */

/**
 * The spec rows of one gadget (the caller has already added the `사용 시간` row). An unknown `GadgetId` gives an
 * empty array, so a new gadget never breaks the card — only the `사용 시간` row shows.
 */
function gadgetRows(id: GadgetId): SpecRow[] {
  const L = SPEC_LABEL_KO;
  switch (id) {
    case 'cloakVeil':
      return [{ k: L.duration, v: sec(GADGET_CLOAK_DURATION) }, { k: L.radius, v: metre(GADGET_CLOAK_SHARE_RADIUS) }];
    case 'domeShield':
      return [{ k: L.radius, v: metre(GADGET_DOME_RADIUS) }, { k: L.recover, v: sec(GADGET_DOME_RECOVER_TIME) }];
    case 'barricade':
      return [{ k: L.radius, v: metre(GADGET_BARRICADE_RADIUS) }, { k: L.recover, v: sec(GADGET_BARRICADE_RECOVER_TIME) }];
    case 'lureGrenade':
      return [{ k: L.duration, v: sec(GADGET_LURE_DURATION) }, { k: L.radius, v: metre(GADGET_LURE_RADIUS) }];
    case 'smokeGrenade':
      return [{ k: L.duration, v: sec(GADGET_SMOKE_DURATION) }, { k: L.radius, v: metre(GADGET_SMOKE_RADIUS) }];
    case 'mine':
      return [
        { k: L.arm, v: sec(GADGET_MINE_ARM_TIME) },
        { k: L.radius, v: metre(GADGET_MINE_RADIUS) },
        { k: L.damage, v: blastDamage(GADGET_MINE_DAMAGE) },
        { k: L.defuse, v: sec(GADGET_DEFUSE_TIME) },
      ];
    case 'remoteMine':
      return [
        { k: L.arm, v: sec(GADGET_REMOTE_MINE_ARM_TIME) },
        { k: L.radius, v: metre(GADGET_REMOTE_MINE_RADIUS) },
        { k: L.damage, v: blastDamage(GADGET_REMOTE_MINE_DAMAGE) },
        { k: L.maxLive, v: [num(GADGET_REMOTE_MINE_MAX_LIVE), dim(' 개')] },
        { k: L.recover, v: sec(GADGET_DEFUSE_TIME) },
      ];
    case 'turret':
      return [
        { k: L.range, v: metre(GADGET_TURRET_RANGE) },
        { k: L.dps, v: n(GADGET_TURRET_DPS) },
        { k: L.duration, v: sec(GADGET_TURRET_DURATION) },
        { k: L.recover, v: sec(GADGET_DEFUSE_TIME) },
      ];
    /* There is no `incendiary` case — on 2026-09-15 the item `gad_incendiary` was dropped and folded into the
       one 화염 수류탄 (`grenade_incendiary`). Its card is drawn by `grenadeRows`. */
    case 'defib':
      return [{ k: L.range, v: metre(GADGET_DEFIB_RANGE) }];
    case 'jumpPad':
      return [{ k: L.radius, v: metre(GADGET_JUMPPAD_RADIUS) }, { k: L.recover, v: sec(GADGET_DEFUSE_TIME) }];
    case 'droneGround':
      return [
        { k: L.droneRange, v: metre(DRONE_GROUND_RANGE) },
        { k: L.droneHp, v: n(DRONE_GROUND_HP) },
        { k: L.recover, v: sec(DRONE_RECOVER_HOLD_S) },
      ];
    case 'droneAir':
      return [
        { k: L.droneRange, v: metre(DRONE_AIR_RANGE) },
        { k: L.droneHp, v: n(DRONE_AIR_HP) },
        { k: L.recover, v: sec(DRONE_RECOVER_HOLD_S) },
      ];
    /* 2026-09-15 (the sandworm · the thumper): no `회수` row — it cannot be picked back up. */
    case 'thumper':
      return [
        { k: L.interval, v: sec(THUMPER_INTERVAL_S) },
        { k: L.summon, v: [num(THUMPER_STRIKES), dim('번째 타격')] },
        { k: L.deployHp, v: n(THUMPER_HP) },
      ];
    default:
      return [];
  }
}

/** The two grenades (`ItemDef.grenade`). 화염 수류탄 is 「a small blast + a fire zone」, so it writes both sets. */
function grenadeRows(def: ItemDef): SpecRow[] {
  const L = SPEC_LABEL_KO;
  const rows: SpecRow[] = [{ k: L.fuse, v: sec(GRENADE_FUSE) }];
  if (def.grenade === 'fire') {
    rows.push({ k: L.blast, v: [num(GRENADE_INCENDIARY_BLAST_RADIUS), dim(' m · 피해 '), num(blastDamage(GRENADE_INCENDIARY_BLAST_DAMAGE))] });
    rows.push({ k: L.fireZone, v: [num(GRENADE_INCENDIARY_RADIUS), dim(' m · '), num(GRENADE_INCENDIARY_DURATION), dim('초')] });
    rows.push({ k: L.dps, v: n(GADGET_INCENDIARY_DPS) });
  } else {
    rows.push({ k: L.radius, v: metre(GRENADE_RADIUS) });
    rows.push({ k: L.damage, v: blastDamage(GRENADE_DAMAGE) });
  }
  return rows;
}

/* ── healing items ─────────────────────────────────────────────────────────── */

/**
 * 「5초간 매 초 HP 4 회복, 총 20 회복」 — **only the numbers take the body colour**, the rest is dim.
 * An item that heals it all at once (회복주사 = 1 s) makes the 「매 초」 sentence a lie, so the sentence changes.
 */
function healLine(total: number, overTime: number): SpecSeg[] {
  if (overTime <= 0) return [dim('즉시 HP '), num(total), dim(' 회복')];
  if (overTime <= 1) return [num(overTime), dim('초 만에 HP '), num(total), dim(' 회복')];
  return [
    num(overTime), dim('초간 매 초 HP '), num(Math.round((total / overTime) * 10) / 10),
    dim(' 회복, 총 '), num(total), dim(' 회복'),
  ];
}

/* ── public API ────────────────────────────────────────────────────────────── */

/**
 * The spec rows this item has to write on its card. **The top row is always `사용 시간`** (user's decision) —
 * healing items · shield chargers · combat consumables · gadgets · grenades all share the same 「hold left
 * click」 shape, so it stands in the same place. An item with none returns an empty array, so the caller needs
 * no branch.
 */
export function itemSpecRows(def: ItemDef): SpecRow[] {
  const L = SPEC_LABEL_KO;
  const rows: SpecRow[] = [];

  /* healing consumables */
  const heal = def.heal;
  if (heal) {
    rows.push({ k: L.useTime, v: useTimeValue(heal.useTime) });
    if (heal.spray) {
      const s = heal.spray;
      rows.push({ k: L.heal, v: [dim('누르는 동안 '), num(s.tick), dim('초마다 HP '), num(s.healPerTick), dim(' 회복')] });
      rows.push({ k: L.radius, v: metre(s.radius) });
    } else if (heal.amount > 0) {
      rows.push({ k: L.heal, v: healLine(heal.amount, heal.overTime) });
    }
    return rows;
  }

  /* shield chargers */
  const charge = shieldChargeOf(def.id);
  if (charge) {
    rows.push({ k: L.useTime, v: useTimeValue(charge.useTime) });
    rows.push({ k: L.shield, v: Number.isFinite(charge.amount) ? `+${n(charge.amount)}` : '최대치까지', tone: 'good' });
    return rows;
  }

  /* The three combat consumables — `사용 시간` · `지속 시간` on top; the old `지속 소모` row is gone
     (2026-09-15, user's decision) */
  const boost = boostItemOf(def.id);
  if (boost) {
    rows.push({ k: L.useTime, v: useTimeValue(boost.useTime) });
    if (boost.effect === 'adrenaline') {
      rows.push({ k: L.duration, v: sec(BOOST_ADRENALINE_DURATION_S) });
      rows.push({ k: '스태미나', v: '전부 회복', tone: 'good' });
    } else if (boost.effect === 'stimulant') {
      rows.push({ k: L.duration, v: sec(BOOST_STIMULANT_DURATION_S) });
      const reload = mulPct(BOOST_STIMULANT_RELOAD_SPEED_MUL);
      const ads = mulPct(BOOST_STIMULANT_ADS_SPEED_MUL);
      const sway = mulPct(BOOST_STIMULANT_AIM_SWAY_MUL, false);
      const cost = mulPct(BOOST_STIMULANT_STAMINA_COST_MUL, false);
      rows.push({ k: '장전 속도', v: reload.text, tone: reload.tone });
      rows.push({ k: '정조준 전환', v: ads.text, tone: ads.tone });
      rows.push({ k: '조준 흔들림', v: sway.text, tone: sway.tone });
      rows.push({ k: '스태미나 소모', v: cost.text, tone: cost.tone });
    } else {
      rows.push({ k: '전술 임플란트', v: '전부 충전 · 쿨타임 초기화', tone: 'good' });
    }
    return rows;
  }

  /* grenades · gadgets — a thrown one is 0 s; the defibrillator leaves the csv cell blank and falls back to
     `DEFIB_USE_TIME_S` */
  const gadgetId = def.gadgetId as GadgetId | undefined;
  if (def.grenade || gadgetId) {
    const fallback = gadgetId === 'defib' ? DEFIB_USE_TIME_S : 0;
    rows.push({ k: L.useTime, v: useTimeValue(def.gadgetUseTime ?? fallback) });
    if (def.grenade) rows.push(...grenadeRows(def));
    else if (gadgetId) rows.push(...gadgetRows(gadgetId));
  }
  return rows;
}
