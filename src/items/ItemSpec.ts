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
/* 2026-09-15 (땅굴벌레 · 진동 장치) */
import { THUMPER_HP, THUMPER_INTERVAL_S, THUMPER_STRIKES } from '@/shared';

/* ════════════════════════════════════════════════════════════════════════════
 * 아이템 **스펙 줄** (2026-09-15, 가젯 개편 · 사용자 결정)
 *
 * 「설명 글에 툴팁이 이미 보여 주는 숫자를 적지 않는다」(2026-09-12) 를 회복약 · 전투 소모품 · 가젯 ·
 * 수류탄까지 밀고 나간 결과다: `data/items.csv` 의 `description` 에서 수치를 전부 걷어내고, 그 수치를
 * 여기 한 곳이 문장으로 만든다. **두 툴팁이 같은 함수를 부른다** —
 * `ui/hud/ItemTip`(칩 · 재화 카드)와 `inventory/ui/Tooltip`(격자 카드). 두 곳이 각자 만들면 같은 아이템이
 * 화면마다 다른 숫자를 말한다 (2026-09-10 「같은 수식을 두 폴더가 쓰면 뽑아낸다」).
 *
 * **수치는 하나도 여기 적혀 있지 않다** — 전부 `data/constants.csv` → `@/shared` 의 상수이고,
 * 아이템 쪽 값(`gadgetUseTime` · `durabilityMax` · `heal*`)은 `data/items.csv` 의 칸이다.
 * `src/gadgets/GadgetDefs` 를 import 하지 않는 이유는 폴더 간 import 금지다 — 같은 상수를 읽으므로
 * 값은 언제나 같고, `GadgetDef` 는 **동작**을, 이 표는 **카드에 적히는 줄**을 갖는다.
 *
 * 값에 색을 반으로 가를 수 있도록 `SpecRow.v` 는 문자열 **또는 조각 목록**이다 (`SpecSeg[]`):
 * 「5초간 매 초 HP 4 회복, 총 20 회복」 에서 **숫자만 본문 색이고 나머지 글자는 흐리다**.
 * ════════════════════════════════════════════════════════════════════════════ */

/** 값의 한 조각. `dim` = 흐린 글자 (숫자가 아닌 설명 글자). */
export interface SpecSeg {
  readonly text: string;
  readonly dim?: boolean;
}

/** 값은 통짜 문자열이거나, 색이 갈리는 조각 목록이다. */
export type SpecValue = string | readonly SpecSeg[];

/** 줄의 성격 — 이득(초록) · 손해(빨강) · 보통. 실제 색은 부르는 툴팁이 자기 팔레트로 칠한다. */
export type SpecTone = 'good' | 'bad';

export interface SpecRow {
  readonly k: string;
  readonly v: SpecValue;
  readonly tone?: SpecTone;
}

/** 라벨 한 벌 — 두 툴팁이 같은 말을 쓴다. */
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
  /* 2026-09-15 (땅굴벌레 · 진동 장치) */
  interval: '타격 간격',
  summon: '땅굴벌레 호출',
} as const;

/** 소수점 꼬리 0 을 떼어 낸다 (`5.0` → `5`, `0.315` → `0.315`). */
function n(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return String(Number(v.toFixed(3)));
}
const sec = (v: number): string => `${n(v)} s`;
/** `사용 시간` 값 — 0 은 `0 s` 가 아니라 **`즉시`** 다 (던지는 수류탄 · 채널형 스프레이). */
const useTimeValue = (v: number): string => (v > 0 ? sec(v) : '즉시');
const metre = (v: number): string => `${n(v)} m`;
/**
 * 2단 계단 폭발물의 피해 줄 — `바깥-중심` (예: 파편 수류탄 `30-60`). 2026-09-17 (사용자 결정): 한 숫자만 적으면
 * 반경 안 어디서나 그만큼 아픈 것처럼 읽힌다. 범위 계산은 `shared/explosion.explosionDamageRange` 한 곳이다.
 */
function blastDamage(v: number): string {
  const r = explosionDamageRange(v);
  return `${n(r.min)}-${n(r.max)}`;
}
/** 배수 → `+30 %` / `−30 %` (1 보다 크면 늘어난 것) + 그것이 이득인지. */
function mulPct(mul: number, betterWhenUp = true): { text: string; tone: SpecTone } {
  const pct = Math.round((mul - 1) * 100);
  return { text: `${pct >= 0 ? '+' : '−'}${Math.abs(pct)} %`, tone: (pct >= 0) === betterWhenUp ? 'good' : 'bad' };
}

/** 숫자 조각 · 글자 조각을 섞어 한 값으로. 홀수 번째가 흐린 글자다. */
const num = (v: number | string): SpecSeg => ({ text: typeof v === 'number' ? n(v) : v });
const dim = (t: string): SpecSeg => ({ text: t, dim: true });

/* ── 가젯 · 수류탄 ──────────────────────────────────────────────────────────── */

/**
 * 가젯 하나의 스펙 줄 (사용 시간은 부르는 쪽이 이미 붙였다). `GadgetId` 를 모르면 빈 배열이라
 * 새 가젯을 만들어도 카드가 깨지지 않는다 (사용 시간 줄만 나온다).
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
    /* `incendiary` 줄은 없다 — 2026-09-15 에 아이템 `gad_incendiary` 가 사라지고 화염 수류탄
       (`grenade_incendiary`) 하나로 합쳐졌다. 그 카드는 `grenadeRows` 가 그린다. */
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
    /* 2026-09-15 (땅굴벌레 · 진동 장치): 회수 줄이 없다 — 회수할 수 없는 물건이다. */
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

/** 수류탄 2종 (`ItemDef.grenade`). 화염 수류탄은 「작은 폭발 + 화염 지대」라 두 묶음을 다 적는다. */
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

/* ── 회복약 ────────────────────────────────────────────────────────────────── */

/**
 * 「5초간 매 초 HP 4 회복, 총 20 회복」 — **숫자만 본문 색**이고 나머지는 흐리다.
 * 한 번에 다 회복하는 것(회복주사 = 1초)은 「매 초」 문장이 거짓말이 되므로 문장을 바꾼다.
 */
function healLine(total: number, overTime: number): SpecSeg[] {
  if (overTime <= 0) return [dim('즉시 HP '), num(total), dim(' 회복')];
  if (overTime <= 1) return [num(overTime), dim('초 만에 HP '), num(total), dim(' 회복')];
  return [
    num(overTime), dim('초간 매 초 HP '), num(Math.round((total / overTime) * 10) / 10),
    dim(' 회복, 총 '), num(total), dim(' 회복'),
  ];
}

/* ── 공개 API ──────────────────────────────────────────────────────────────── */

/**
 * 이 아이템이 카드에 적어야 하는 스펙 줄. **맨 위는 언제나 `사용 시간`** 이다 (사용자 결정) —
 * 회복약 · 실드 충전기 · 전투 소모품 · 가젯 · 수류탄이 전부 같은 「좌클릭 홀드」 틀이라 같은 자리에 선다.
 * 해당 없는 아이템은 빈 배열이므로 부르는 쪽에 분기가 필요 없다.
 */
export function itemSpecRows(def: ItemDef): SpecRow[] {
  const L = SPEC_LABEL_KO;
  const rows: SpecRow[] = [];

  /* 회복 소모품 */
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

  /* 실드 충전기 */
  const charge = shieldChargeOf(def.id);
  if (charge) {
    rows.push({ k: L.useTime, v: useTimeValue(charge.useTime) });
    rows.push({ k: L.shield, v: Number.isFinite(charge.amount) ? `+${n(charge.amount)}` : '최대치까지', tone: 'good' });
    return rows;
  }

  /* 전투 소모품 3종 — `사용 시간` · `지속 시간` 이 맨 위이고 옛 `지속 소모` 줄은 없앴다 (2026-09-15 사용자 결정) */
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

  /* 수류탄 · 가젯 — 던지는 것은 0 s, 제세동기는 csv 를 비워 `DEFIB_USE_TIME_S` 로 떨어진다 */
  const gadgetId = def.gadgetId as GadgetId | undefined;
  if (def.grenade || gadgetId) {
    const fallback = gadgetId === 'defib' ? DEFIB_USE_TIME_S : 0;
    rows.push({ k: L.useTime, v: useTimeValue(def.gadgetUseTime ?? fallback) });
    if (def.grenade) rows.push(...grenadeRows(def));
    else if (gadgetId) rows.push(...gadgetRows(gadgetId));
  }
  return rows;
}
