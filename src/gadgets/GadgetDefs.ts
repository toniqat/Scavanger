import {
  GADGET_BARRICADE_HP, GADGET_BARRICADE_RECOVER_TIME, GADGET_CLOAK_DURATION, GADGET_CLOAK_SHARE_RADIUS,
  GADGET_DEFUSE_TIME, GADGET_DOME_HP, GADGET_DOME_RADIUS,
  GADGET_LURE_DURATION, GADGET_LURE_RADIUS, GADGET_MINE_RADIUS, GADGET_SMOKE_DURATION, GADGET_SMOKE_RADIUS,
  GADGET_TURRET_DURATION, GADGET_TURRET_HP, GADGET_TURRET_RANGE,
  GADGET_BARRICADE_RADIUS, GADGET_DEFIB_RANGE, GADGET_JUMPPAD_HP, GADGET_JUMPPAD_RADIUS, GADGET_LURE_HP, GADGET_MINE_HP,
  type DeployableKind, type GadgetDef, type GadgetId,
} from '@/shared';
/* 2026-09-11: remote mine · drones */
import {
  DRONE_AIR_HP, DRONE_AIR_RANGE, DRONE_GROUND_HP, DRONE_GROUND_RANGE, DRONE_RECOVER_HOLD_S,
  GADGET_REMOTE_MINE_HP, GADGET_REMOTE_MINE_RADIUS,
} from '@/shared';
/* 2026-09-15 (the gadget rework, user's decision): dome shield recover time · fire zone numbers merged
   (the "fire merge" comment below) */
import { GADGET_DOME_RECOVER_TIME, GRENADE_INCENDIARY_DURATION, GRENADE_INCENDIARY_RADIUS } from '@/shared';
/* 2026-09-15 (the sandworm · the thumper) */
import { THUMPER_GROUND_R, THUMPER_HP } from '@/shared';

/**
 * Special gadget definitions. Owned by `src/gadgets/` — `items/` only references them through
 * `ItemDef.gadgetId`, and everyone else reads them via `ctx.gadgets.getDefs()`.
 *
 * `radius` is the gameplay radius the gadget advertises (blast / cloud / cloak share / turret range);
 * physical trigger and collider sizes are private tuning constants in `GadgetSystem` / `Deployable`.
 *
 * **2026-09-15 (the gadget rework, user's decision) — `description` carries no numbers.** Range · duration ·
 * durability · use time are drawn by the tooltip's **spec row**, which reads them from this definition
 * (`duration` · `hp` · `radius` · `recoverTime`) and from the item def. A description says only "what the
 * thing does" — the same number in two places means the prose does not follow when the table is fixed (the
 * same reason as 2026-09-12's "descriptions never repeat numbers the tooltip already shows").
 * The field values themselves are unchanged (the tooltip reads them).
 */
export const GADGET_DEFS: readonly GadgetDef[] = [
  {
    id: 'cloakVeil',
    name: '은폐 장막',
    description: '사용 즉시 자신과 주변 아군을 은폐시킨다. 사격·질주·구르기는 은폐를 깨뜨린다.',
    use: 'self',
    deployable: null,
    duration: GADGET_CLOAK_DURATION,
    hp: 0,
    radius: GADGET_CLOAK_SHARE_RADIUS,
    recoverTime: 0,
    icon: '◌',
    color: '#9fd8ff',
  },
  {
    /**
     * 2026-09-15 (user's decision): a **dome shield unit** stands where the canister landed and the shield
     * goes up around it. Holding on the unit recovers it (`GADGET_DOME_RECOVER_TIME`), and whatever the
     * shield lost stays as **item durability** (`wearsItemDurability` — max hp is that item's
     * `ItemDef.durabilityMax`, not the `hp` here).
     */
    id: 'domeShield',
    name: '돔 실드',
    description: '던진 자리에 방어막 발생기를 세운다. 돔은 적의 발사체만 막고, 발생기를 꾹 누르면 회수된다.',
    use: 'throw',
    deployable: 'domeShield',
    duration: 0,
    hp: GADGET_DOME_HP,
    radius: GADGET_DOME_RADIUS,
    recoverTime: GADGET_DOME_RECOVER_TIME,
    wearsItemDurability: true,
    icon: '⌒',
    color: '#6fe0ff',
  },
  {
    id: 'barricade',
    name: '바리케이드',
    description: '조준한 자리에 대형 차폐물을 설치한다. 총알과 벌레를 모두 막고, 누구나 꾹 눌러 회수할 수 있다.',
    use: 'place',
    deployable: 'barricade',
    duration: 0,
    hp: GADGET_BARRICADE_HP,
    radius: GADGET_BARRICADE_RADIUS,
    recoverTime: GADGET_BARRICADE_RECOVER_TIME,
    /* 2026-09-15 (user's decision): the same rule as the dome shield — the damage it took stays as item
       durability, so it needs a workbench repair. */
    wearsItemDurability: true,
    icon: '▤',
    color: '#c9a227',
  },
  {
    id: 'lureGrenade',
    name: '유인 수류탄',
    description: '착탄점에서 소음을 내 주변의 벌레를 끌어당긴다. 원거리 적은 이쪽을 쏜다.',
    use: 'throw',
    deployable: 'lure',
    duration: GADGET_LURE_DURATION,
    hp: GADGET_LURE_HP,
    radius: GADGET_LURE_RADIUS,
    recoverTime: 0,
    icon: '♪',
    color: '#ffd166',
  },
  {
    id: 'smokeGrenade',
    name: '연막탄',
    description: '연막을 피워 적의 시야를 가린다. 연막 안에서 사격하면 그 위치로 부정확한 대응사격이 날아온다.',
    use: 'throw',
    deployable: 'smoke',
    duration: GADGET_SMOKE_DURATION,
    hp: 0,
    radius: GADGET_SMOKE_RADIUS,
    recoverTime: 0,
    icon: '☁',
    color: '#b9c3cc',
  },
  {
    id: 'mine',
    name: '지뢰',
    description: '설치 후 활성화되고, 밟으면 폭발한다. 피아를 구분하지 않는다. 드론 위에 올리면 적에게만 반응한다.',
    use: 'place',
    deployable: 'mine',
    duration: 0,
    hp: GADGET_MINE_HP,
    radius: GADGET_MINE_RADIUS,
    recoverTime: GADGET_DEFUSE_TIME,
    icon: '◉',
    color: '#ff5a3c',
  },
  {
    /* 2026-09-15 (user's decision): renamed from `포탑 설치` to **`자동 사격 포탑`** (the item name in
       items.csv changed with it). */
    id: 'turret',
    name: '자동 사격 포탑',
    description: '조준한 자리에 자동 포탑을 세운다. 사거리 안의 적을 알아서 쏘지만 사선의 아군도 맞는다. 꾹 눌러 회수.',
    use: 'place',
    deployable: 'turret',
    duration: GADGET_TURRET_DURATION,
    hp: GADGET_TURRET_HP,
    radius: GADGET_TURRET_RANGE,
    recoverTime: GADGET_DEFUSE_TIME,
    icon: '⌖',
    color: '#7cf07a',
  },
  {
    id: 'defib',
    name: '제세동기',
    description: '쓰러진 아군을 즉시 회복시킨다. 좌클릭을 꾹 눌러 충전한 뒤 대상을 겨누고 놓는다.',
    use: 'target',
    deployable: null,
    duration: 0,
    hp: 0,
    radius: GADGET_DEFIB_RANGE,
    recoverTime: 0,
    icon: '⚡',
    color: '#ff5f8f',
  },
  {
    id: 'jumpPad',
    name: '점프대',
    description: '밟으면 높이 튀어오르고, 달리면서 밟으면 전방으로 크게 도약한다. 꾹 눌러 회수.',
    use: 'place',
    deployable: 'jumpPad',
    duration: 0,
    hp: GADGET_JUMPPAD_HP,
    radius: GADGET_JUMPPAD_RADIUS,
    recoverTime: GADGET_DEFUSE_TIME,
    icon: '⇧',
    color: '#5fd7ff',
  },
  /* ── 2026-09-11 ── */
  {
    id: 'remoteMine',
    name: '원격 지뢰',
    description: '설치하면 잠시 뒤 무장된다. 손에 들고 우클릭하면 내가 설치한 것이 한꺼번에 터진다. 밟아도 터지지 않고, 부서지면 불발로 사라진다. 꾹 눌러 회수하거나 드론 위에 올릴 수 있다.',
    use: 'place',
    deployable: 'remoteMine',
    duration: 0,
    hp: GADGET_REMOTE_MINE_HP,
    radius: GADGET_REMOTE_MINE_RADIUS,
    recoverTime: GADGET_DEFUSE_TIME,
    icon: '▣',
    color: '#ff9f40',
  },
  {
    id: 'droneGround',
    name: '지상 드론',
    description: '바닥에 내려놓는 정찰 드론. 손에 들고 R 을 꾹 누르면 드론 시점으로 조종한다. 달리면 빠르지만 소리가 나 적이 알아챈다. 위에 지뢰를 올릴 수 있다.',
    use: 'drone',
    deployable: null,
    duration: 0,
    hp: DRONE_GROUND_HP,
    radius: DRONE_GROUND_RANGE,
    recoverTime: DRONE_RECOVER_HOLD_S,
    icon: '⛭',
    color: '#8fd18a',
  },
  {
    id: 'droneAir',
    name: '공중 드론',
    description: '공중에 띄우는 정찰 드론. 손에 들고 R 을 꾹 누르면 조종한다 — Space 상승 · C 하강. 연결이 끊겨도 제자리에 떠 있고, 갈고리를 걸 수 있다.',
    use: 'drone',
    deployable: null,
    duration: 0,
    hp: DRONE_AIR_HP,
    radius: DRONE_AIR_RANGE,
    recoverTime: DRONE_RECOVER_HOLD_S,
    icon: '✈',
    color: '#7fc8ff',
  },
  /* ── 2026-09-15 (the sandworm · the thumper, user's decision — `src/gadgets/README.md` Decisions) ── */
  {
    /**
     * A Dune-style thumper. It strikes the ground every `THUMPER_INTERVAL_S`, and on strike `THUMPER_STRIKES`
     * the host emits `sandworm:summon` **once** (`parts/Thumper`). It keeps thumping forever after that — it
     * may be placed in a raid the worm has already appeared in (user's decision), and the director simply
     * ignores the summon then. **Not recoverable** (`recoverTime` 0 → no interaction and not in
     * `RECOVERABLE_KINDS`), one use.
     * An eruption destroys every device inside its radius (`sandworm:erupted` → `Thumper.onErupted`).
     * `radius` = `THUMPER_GROUND_R`: the radius of the placement test (`WorldRef.burrowGroundOk`), and the
     * ground ring is drawn that size too.
     * It does not mount on a drone (outside `MOUNTABLE_DEPLOYABLE_KINDS`) — it has to hit the ground.
     */
    id: 'thumper',
    name: '진동 장치',
    description: '땅에 박아 두면 일정한 박자로 바닥을 내리친다. 몇 번 두드리면 땅굴벌레가 그 자리로 찾아온다. 회수할 수 없고, 벌레가 솟구치면 부서진다.',
    use: 'place',
    deployable: 'thumper',
    duration: 0,
    hp: THUMPER_HP,
    radius: THUMPER_GROUND_R,
    recoverTime: 0,
    icon: '⏚',
    color: '#e0a458',
  },
];

/**
 * **Internal definitions, with no item behind them.** They appear in no `getDefs()`, no quick slot and no
 * console, and `use()` refuses them (`isInternalGadget` — the old parallel-development rule lets a gadget
 * with no matching item through without consuming anything, so without that refusal they would be free).
 *
 * ## The fire merge (2026-09-15, user's decision)
 *
 * There were **two** ways to make a fire zone — the thrown gadget `화염수류탄` (item `gad_incendiary`,
 * `GADGET_INCENDIARY_*`, radius 5 · 10 s) and the internal gadget `grenadeFire` left where a G-10 incendiary
 * grenade exploded (`GRENADE_INCENDIARY_*`, radius 3.5 · 6 s). Now there is one:
 *
 * - **The item `gad_incendiary` is gone** (items.csv · alias → `grenade_incendiary`). What survives is
 *   **`화염 수류탄` `grenade_incendiary`**, and it does **the explosion and the fire zone at once** (the
 *   explosion from weapons' `Grenade` via `GRENADE_INCENDIARY_BLAST_*`, the zone here).
 * - **The surviving numbers are `GRENADE_INCENDIARY_*`** — they are tuned as one "explosion + zone" set and
 *   belong to the same bundle as the blast numbers (`GRENADE_INCENDIARY_BLAST_*`). `GADGET_INCENDIARY_RADIUS` ·
 *   `GADGET_INCENDIARY_DURATION` are **retired** (the lead cleans the csv up). The damage per second
 *   `GADGET_INCENDIARY_DPS` is a value of the whole zone, so it **lives on unchanged**.
 * - **One gadget id is left, `incendiary`** — `GadgetId` is a contract, so `grenadeFire` is still in the type
 *   (a retired marker like `airstrike` · `secondary`) but **has no definition**. That makes exactly one
 *   definition produce `deployable: 'fire'`, and `gadgetForKind('fire')` answer unambiguously.
 * - **The `-gf` marker on the deployable id, built to resolve that ambiguity, is no longer needed**
 *   (`deployableIdFor` always writes `-g`, `defForWire` looks only at `kind` — an old `-gf` id still resolves
 *   to the same definition, so compatibility is unchanged).
 */
export const INTERNAL_GADGET_DEFS: readonly GadgetDef[] = [
  {
    id: 'incendiary',
    name: '화염 지대',
    description: '화염 수류탄이 터진 자리에 남는 불. 피아를 구분하지 않고 화상을 입힌다.',
    use: 'throw',
    deployable: 'fire',
    duration: GRENADE_INCENDIARY_DURATION,
    hp: 0,
    radius: GRENADE_INCENDIARY_RADIUS,
    recoverTime: 0,
    icon: '🔥',
    color: '#ff7a1a',
  },
];

const BY_ID = new Map<GadgetId, GadgetDef>([...GADGET_DEFS, ...INTERNAL_GADGET_DEFS].map((d) => [d.id, d]));
/** Public definitions first; an internal one only when nothing else produces that kind (today just `fire`). */
const BY_KIND = new Map<DeployableKind, GadgetDef>();
for (const d of [...GADGET_DEFS, ...INTERNAL_GADGET_DEFS]) if (d.deployable && !BY_KIND.has(d.deployable)) BY_KIND.set(d.deployable, d);
const INTERNAL_IDS = new Set<GadgetId>(INTERNAL_GADGET_DEFS.map((d) => d.id));

export function gadgetDef(id: GadgetId): GadgetDef | undefined { return BY_ID.get(id); }
/** Every deployable kind is produced by exactly one gadget, so the reverse lookup is unambiguous. */
export function gadgetForKind(kind: DeployableKind): GadgetDef | undefined { return BY_KIND.get(kind); }
/** Is this an internal gadget, stood up by code with no item (`use()` refuses it)? */
export function isInternalGadget(id: GadgetId): boolean { return INTERNAL_IDS.has(id); }

/**
 * The deployable id. The 2026-09-15 fire merge left exactly one definition producing `fire`, so the **`-gf`
 * marker is retired** (before it, `DeployableWire` had no gadget id field and the thrown `화염수류탄` had to
 * be told from the G-10 fire by id).
 * The `gadget` argument is kept so call sites stay as they are; it does not affect the shape of the id.
 */
export function deployableIdFor(base: string, seq: number, gadget?: GadgetId): string {
  void gadget;
  return `${base}-g${seq}`;
}
/** A deployable off the wire → its definition. `kind` alone decides it (an old `-gf` id resolves the same). */
export function defForWire(w: { id: string; kind: DeployableKind }): GadgetDef | undefined {
  return BY_KIND.get(w.kind);
}

/**
 * Deployables that hand an item back when someone finishes the recover interaction.
 * 2026-09-15: the dome shield joined them — holding on the central emitter recovers it, and the remaining hp
 * goes to the item's durability.
 */
export const RECOVERABLE_KINDS: readonly DeployableKind[] = ['barricade', 'turret', 'jumpPad',
  /* 2026-09-11: a remote mine is the owner's tool and never goes off when stepped on, so recovering it
     returns the item (a ground mine is still defused = nothing returned) */
  'remoteMine',
  /* 2026-09-15 (user's decision) */
  'domeShield'];
export function isRecoverable(kind: DeployableKind): boolean { return RECOVERABLE_KINDS.includes(kind); }

/** Deployables enemies should attack when they block or annoy them. */
export const ENEMY_TARGET_KINDS: readonly DeployableKind[] = ['barricade', 'turret', 'lure', 'domeShield'];

/** Deployables that stop projectiles (dome shields only stop hostile ones). */
export const SOLID_KINDS: readonly DeployableKind[] = ['barricade', 'domeShield'];
