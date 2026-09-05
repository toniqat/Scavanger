# src/progression — 캐릭터 성장 (`ProgressionSystem`)

Persistent character: 5 stats, 14 skills, level/XP, and **every number derived from them**.
Publishes `ctx.progression` (`ProgressionRef`, see `shared/progression.ts`) in `init`.

> **다른 폴더는 공식을 다시 구현하지 않는다.** 필요한 값은 전부 `ctx.progression?.derived` 에 있다.
> ref 가 아직 없을 수 있으므로 항상 옵셔널 체이닝 + 중립 기본값(배율 1, 보너스 0)으로 방어할 것.

Import via `@/progression` → `ProgressionSystem`. Registered in `main.ts` by the integration owner
(**before** the systems that read `derived` — inventory / player / weapons / implants / ui — so the first
frame already has real numbers; `NetSystem` still goes first).

| File | Purpose |
|---|---|
| `ProgressionSystem.ts` | `GameSystem` + `ProgressionRef` (`name: 'progression'`). Profile ownership, bus subscriptions that train skills, `derived` recomputation, autosave, the character-sheet toggle. |
| `defs.ts` | The 5 `StatDef` / 14 `SkillDef` (한국어 이름·설명), `WEAPON_CLASS_SKILL`, and the raw skill-XP each trained action is worth. |
| `derive.ts` | `computeDerived(profile, specialBackpack)` → `DerivedStats`, `xpForLevel(level)`, `DEFAULT_DERIVED`. All tuning constants live here. |
| `Profile.ts` | `localStorage` load / save / migrate / clear. Every access in `try/catch`. |
| `ui/CharacterSheet.ts` | 캐릭터 시트 패널 (`.menu.char-sheet`). Blocker token `'stats'`. |
| `ui/character.css` | Its styles (imported from `CharacterSheet.ts`); reuses `.menu` / `.ui-*` from `ui/styles/base.css`. |
| `index.ts` | Barrel. |

## 스탯 (5종)
`STAT_BASE` 5 로 시작, `STAT_MAX` 20, 레벨업마다 `STAT_POINTS_PER_LEVEL`(2) 포인트.
`spendStatPoint(id)` 는 **함선에서만** — `ctx.isRaidActive()` 이면 `false` 를 돌려주고 아무것도 바꾸지 않는다.

| id | 이름 | 파생 |
|---|---|---|
| `strength` | 근력 | `carryCapacity`(=28 + 2.2×근력), `meleeDamageMul`, `jumpHeightMul`, `throwRangeMul` |
| `endurance` | 지구력 | `maxStamina`(+5/pt), `staminaRegenMul` |
| `perception` | 인지력 | `detectRadius`, `enemyDetectRadius` |
| `intelligence` | 지능 | `skillGainMul` (모든 숙련 상승량 배율) |
| `dexterity` | 재주 | `useSpeedMul`, `interactSpeedMul` |

스탯 효과는 **`STAT_BASE` 기준**으로 계산한다 (레벨 1 캐릭터 = 배율 1). 적재량·감지 반경만
`constants.ts` 의 정의대로 스탯 값에 직접 비례한다.

## 스킬 (14종)
0..`SKILL_LEVEL_MAX`(100). 레벨 사이 진행도는 `profile.skillProgress[id]` (0..1).

```
gain = rawAmount × derived.skillGainMul × statFactor(skill.stats) / (1 + level × 0.06)
```
`statFactor = max(0.4, 1 + 0.04 × (관련 스탯 평균 − STAT_BASE))`. 레벨이 오를수록 필요량이 늘어난다.

| 스킬 | 상승 트리거 (버스 이벤트) | 파생 |
|---|---|---|
| `carry` 운반 | 무게 상태가 `light` 이상일 때 이동한 거리 (`inventory:weightChanged` + 매 프레임 거리 누적) | `carryReliefFactor` |
| `appraisal` 감정 | `crate:open`, `inventory:itemAdded` (등급별 가중) | `searchSpeedMul` |
| `grit` 인내 | `player:gritSaved` | `gritChance` (최대 35 %) |
| `gardening` 원예 | `gather:collected` | `gatherYieldMul` |
| `crafting` 제작 | `craft:completed` (레시피 `skill === 'crafting'`) | `craftSpeedMul` |
| `medicine` 의학 | `craft:completed` (레시피 `skill === 'medicine'`) | `healPowerMul` |
| `cryptography` 암호학 | `extraction:activated` | `shipCallSpeedMul` |
| `implant` 전술 임플란트 | `implant:activated` | `implantCooldownMul` |
| `gun_AR/SMG/SR/DMR/SG` 사격 | `weapon:hit` (`enemyId !== null`) — 무기 클래스는 직전 `weapon:fired` 의 `weaponId` → `ctx.loot.getWeaponDef` 로 판정 | `recoilMul[class]`, `reloadSpeedMul[class]` |
| `equipment` 장비 관리 | `repair:completed` | `durabilityLossMul` |

- 산탄총은 펠릿마다 `weapon:hit` 을 쏘므로 **한 발당 한 번만** 적립한다 (`weapon:fired` 로 리셋).
- `PISTOL` 클래스는 `gun_SMG` 를 훈련한다 (`skillForWeaponClass`).
- 레시피의 `skill` 은 `ctx.loot.getAllRecipes()` 로 찾는다. items 가 아직 구현하지 않았으면 `crafting` 으로 폴백.

## `DerivedStats`
`computeDerived` 가 stats / skills / 장착 가방을 모두 반영해 한 번에 만든다. 재계산 시점:
프로필 로드, 스탯 소비, 스킬 레벨업, `equip:changed`, `loadout:changed`, `resetProfile`.

`implantCooldownMul` 에는 **특수 가방(전설) 퍼크 −50 %** 가 곱해져 있다
(`ctx.inventory.getEquipped('backpack')` → `ctx.loot.getItemDef(...).backpackId` → `getBackpackDef(...).perk === 'special'`).
inventory / items 의 신규 API 가 아직 없으면 `typeof` 체크 + `try/catch` 로 조용히 "퍼크 없음" 처리한다.

## 캐릭터 XP / 레벨
`xpToNext = round(XP_BASE × level^XP_EXPONENT)` (240, 612, 1071, …).
`addXp` 는 남는 XP 를 이월하며 레벨업마다 `progress:levelUp` 을 emit 하고 즉시 저장한다.
미션 종료 보상은 **`game/GameFlowSystem.awardMissionXp()`** 가 계산한다 (킬 · 생존 시간 · 탈출 보너스 · 전리품 가치).

## 영속화
`localStorage[PROFILE_STORAGE_KEY]`, `PROFILE_VERSION` 기반.

- 저장 시점: 레벨업, 스탯 소비, 스킬 레벨업, `implant:equipped`, 미션 종료(`GameFlow` 가 `save()` 호출),
  `game:abort`, `pagehide` / `beforeunload`, 그리고 변경이 있으면 15 초 주기 오토세이브.
- `save()` 는 dirty 플래그를 무시하고 강제로 쓴다 — GameFlow 가 `profile.raids` 를 직접 증가시킨 뒤 호출하기 때문.
- `migrate(raw)` 는 어떤 형태가 들어와도 현재 버전으로 정규화한다 (누락 필드 기본값, 모든 수치 클램프,
  알 수 없는 임플란트 id → `null`). 저장본 버전이 **더 높으면** 이름만 남기고 새 캐릭터로 시작한다.
- localStorage 자체가 없거나(프라이빗 모드) 쿼터가 차도 게임은 그대로 진행된다 — 모든 접근이 `try/catch`.

## 캐릭터 시트 (`ui/CharacterSheet.ts`)
- `ui:statsToggled {open}` 로 열고 닫는다 (함선 터미널의 **캐릭터** 항목이 emit). 편의상 **P** 키로도 토글되며,
  게임플레이 / 함선 phase 에서 다른 blocker 가 없을 때만 열린다.
- `ctx.uiBlockers` 에 `'stats'` 토큰을 **먼저** 넣고 `ctx.input.exitPointerLock()` 을 호출한다
  (GameFlow 가 의도된 lock 해제로 인식하도록). 닫을 때는 토큰을 지우고, blocker 가 없으면 마이크로태스크에서 재잠금.
- Esc 는 capture-phase 리스너로 잡아 시트만 닫는다 (일시정지 메뉴로 새지 않는다).
- 내용: 레벨 + XP 바, 스탯 5종(설명 · 값 · `＋` 버튼 — 레이드 중 비활성) + 잔여 포인트, 스킬 14종 진행도 바,
  파생 능력치 18개 readout, 2단계 확인식 **캐릭터 초기화** 버튼(함선에서만).

## 다른 폴더가 쓰는 법
```ts
const d = ctx.progression?.derived;
const cd = base * (d?.implantCooldownMul ?? 1);
const cap = d?.carryCapacity ?? 39;          // 근력 5 기준값
ctx.progression?.addSkillXp('gardening', 0.35);
const implant = ctx.progression?.profile.implant ?? null;
```
