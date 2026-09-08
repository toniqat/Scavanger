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
| `ProgressionSystem.ts` | `GameSystem` + `ProgressionRef` (`name: 'progression'`). Profile ownership, bus subscriptions that train skills, `derived` recomputation, autosave, the character-sheet toggle; Phase 7: server profile document (`upload()` on every flush — **Phase 9: offline too**, `ProfileSync` queues it; `onProfileLoaded()` replace + `progress:*` re-emit), training gate in `addSkillXp`; Phase 8: `createSheetView(host)` + the `views` set (overlay **and** every embedded tab are repainted through `refreshSheets` / `refreshSheetSkill` / `refreshSheetStat`). |
| `defs.ts` | The 5 `StatDef` / 14 `SkillDef` (한국어 이름·설명), `WEAPON_CLASS_SKILL`, and the raw skill-XP each trained action is worth. |
| `derive.ts` | `computeDerived(profile, specialBackpack)` → `DerivedStats`, `xpForLevel(level)`, `DEFAULT_DERIVED`. All tuning constants live here. |
| `Profile.ts` | `localStorage` load / save / migrate / clear. Every access in `try/catch`. **2026-09-07**: `DEFAULT_IMPLANT` (`'grapple'`) — a fresh profile starts with 갈고리 in the 전술 임플란트 slot instead of an empty one (all six implants are owned from level 1, so an empty slot was just a missed default). Existing saves are untouched. |
| `ui/SheetBody.ts` | **공용 렌더러** (Phase 8): `CharacterSheetHost` 인터페이스 + `SheetBody` — 헤더 / XP 바 / 능력치 · 숙련도 2단 / 파생 능력치 그리드 / 푸터(캐릭터 초기화)를 넘겨받은 부모 요소 안에 만든다. blocker · 포인터 락 · Esc · `.scr-tabs` 는 **모른다** (껍데기의 몫). `el()` 헬퍼도 여기서 export. |
| `ui/CharacterSheet.ts` | 단독 오버레이 (`.menu.char-sheet`): `.scr-tabs` + `.frame` + `SheetBody`. Blocker token `'stats'`, 포인터 락, capture-phase Esc. |
| `ui/SheetView.ts` | 인벤토리 Tab 화면의 **캐릭터 탭** (`EmbeddedView`): `host` 안에 `.cs-embed` + 같은 `SheetBody`. blocker / 락 / Esc / 탭 pill 없음. |
| `ui/character.css` | Its styles (imported from `CharacterSheet.ts` / `SheetView.ts`); reuses `.menu` / `.ui-*` from `ui/styles/base.css`. |
| `index.ts` | Barrel. |

## 스탯 (5종)
`STAT_BASE` 5 로 시작, `STAT_MAX` 20, 레벨업마다 `STAT_POINTS_PER_LEVEL`(1, Phase 5 부터 — 이전 2) 포인트.
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

## 스탯 경험치 (2026-09-06)
레벨업 포인트(`spendStatPoint`)와 **별개로** 스탯마다 경험치 진행도가 있다: `profile.statProgress[id]` (0..1, 옵셔널 —
2026-09-06 이전 저장본은 `migrate` 가 0 으로 채우고 0..0.999999 로 클램프, `STAT_MAX` 인 스탯만 1 허용).
체육 기구 · 개발자 콘솔 `/stat` 같은 곳이 `addStatXp(id, ±xp)` 로 올리고 내린다.

```
statXpToNext(id) = round(STAT_XP_BASE × value^STAT_XP_EXPONENT)   // 5 → 1118, 10 → 3162 (shared/constants)
```
- `addStatXp(id, amount)`: 저장된 진행도를 현재 값 기준 raw XP 로 바꾼 뒤 `amount` 를 더한다.
  raw ≥ 필요량 → 스탯 +1, 남는 XP 는 **새 값의 필요량 기준**으로 이월. raw < 0 → 스탯 −1, 부족분을 새 값의 필요량에서
  뺀다 (예: 6 · 10 % 에서 −500 → 5 · 68 %). `STAT_MAX` 에서는 진행도 1 로 고정, `STAT_MIN`(1) 에서는 0 으로 고정.
  루프는 스탯 범위 폭으로 제한되어 있어 100만 XP 를 줘도 안전하다.
- 이벤트: 호출마다 `progress:statXp {id, value, progress, delta}` (`delta` = 넘겨준 XP). 값이 바뀌면
  `progress:statChanged {id, value, pointsLeft}` 도 emit (레벨업 포인트는 그대로), `derived` 재계산 + 즉시 저장.
  진행도만 움직이면 dirty 로 표시해 오토세이브 / `pagehide` 가 쓴다.
- `getStatProgress(id)` / `statXpToNext(id)` 는 시트·콘솔 표시용. `migrate` 는 스탯 자체도 `STAT_MIN..STAT_MAX` 로 클램프한다.
- 캐릭터 시트의 스탯 행에는 진행도 바(`.cs-stat .sp .bar`) 와 `xp / next XP` 텍스트가 붙고 (`refreshStat(id)` 부분 갱신), 최대치는 `최대`.

### raw 스킬 경험치 · 시설 보너스
- `addSkillXpRaw(id, ±amount)`: 지능·스탯·레벨·시설 스케일 **없이** 0..1 진행도에 부호 그대로 더한다 (`1` = 어느 레벨에서든 한 레벨).
  1 이상이면 레벨 +1 (상한 `SKILL_LEVEL_MAX`, 도달 시 진행도 0), 0 미만이면 레벨 −1 (하한 0, 도달 시 진행도 0).
  레벨이 바뀌면 (내려가도) `progress:skillUp {id, level}`, 항상 `progress:skillProgress`. 치트 / 디버프 전용 — 정상 훈련은 `addSkillXp`.
- `getSkillGainMul(id)`: `ctx.housing?.getSkillGainMul(id) ?? 1` (**사격장 × 서재** — `gun_*` × `1 + 0.1 × 사격장 level`, times the 서재 책장 bonus of every book of that skill, Phase 9; housing/ folds both into the one number). `addSkillXp` 가 **내부에서** 곱하므로 다른 폴더는
  이걸 다시 곱하지 않는다. housing 이 스켈레톤이거나 없으면 1. 시트의 스킬 행에 `시설 ×1.10` 배지로 표시 (1 이면 숨김).
- 스모크: `node scripts/smoke-progression.mjs` (`verify.mjs` `SMOKES` 의 `smoke-progression`, `folders: ['progression']`) — **119 / 119** on 2026-09-08 (Phase 12 임플란트 아이템 +51; 65 / 65 on 2026-09-06)
  (Phase 7: 감정 XP `container:itemRevealed`, 훈련장 `gun_*` 전용, 가짜 `ctx.net.profile` 로 `profile.set('progression')` / `net:profileLoaded` 대체 + 이벤트 재발행;
  릴레이 소켓을 막아 8787 의 릴레이가 실행 중이어도 결과가 같다).

## 스킬 (14종)
0..`SKILL_LEVEL_MAX`(100). 레벨 사이 진행도는 `profile.skillProgress[id]` (0..1).

```
gain = rawAmount × derived.skillGainMul × getSkillGainMul(skill) × statFactor(skill.stats) / (1 + level × 0.06)
```
`statFactor = max(0.4, 1 + 0.04 × (관련 스탯 평균 − STAT_BASE))`. 레벨이 오를수록 필요량이 늘어난다.
`getSkillGainMul` 은 함선 시설 배율 — 사격장 × 서재 책장 (Phase 9), 위 "스탯 경험치" 절 참고.

| 스킬 | 상승 트리거 (버스 이벤트) | 파생 |
|---|---|---|
| `carry` 운반 | 무게 상태가 `light` 이상일 때 이동한 거리 (`inventory:weightChanged` + 매 프레임 거리 누적) | `carryReliefFactor` |
| `appraisal` 감정 | `crate:open`, **`container:itemRevealed`** (등급별 가중 `APPRAISE_XP_BY_RARITY`; Phase 7 — 상자 검색이 아이템을 드러낼 때. `inventory:itemAdded` 는 더 이상 훈련하지 않는다) | `searchSpeedMul` |
| `grit` 인내 | `player:gritSaved` | `gritChance` (최대 35 %) |
| `gardening` 원예 | `gather:collected` | `gatherYieldMul` |
| `crafting` 제작 | `craft:completed` (레시피 `skill === 'crafting'`) | `craftSpeedMul` |
| `medicine` 의학 | `craft:completed` (레시피 `skill === 'medicine'`) | `healPowerMul` |
| `cryptography` 암호학 | `extraction:activated` | `shipCallSpeedMul` |
| `implant` 전술 임플란트 | `implant:activated` | `implantCooldownMul` |
| `gun_AR/SMG/SR/DMR/SG` 사격 | `weapon:hit` (`enemyId !== null`) — 무기 클래스는 직전 `weapon:fired` 의 `weaponId` → `ctx.loot.getWeaponDef` 로 판정 | `recoilMul[class]`, `reloadSpeedMul[class]` |
| `equipment` 장비 관리 | `repair:completed` | `durabilityLossMul` |

- 산탄총은 펠릿마다 `weapon:hit` 을 쏘므로 **한 발당 한 번만** 적립한다 (`weapon:fired` 로 리셋).
- **훈련장 (Phase 7)**: `ctx.isTraining()` 인 동안 `addSkillXp` 는 `gun_*` 만 받고 (`× TRAINING_SKILL_GAIN_MUL`, shared/constants), 나머지 스킬은 0.
  스탯 XP (`addStatXp`) · 캐릭터 XP (`addXp`) · `addSkillXpRaw` 는 그대로다 (훈련장은 `awardMissionXp` 를 부르지 않으므로 실질적으로 오르지 않는다).
- `PISTOL` 클래스는 `gun_SMG` 를 훈련한다 (`skillForWeaponClass`).
- 레시피의 `skill` 은 `ctx.loot.getAllRecipes()` 로 찾는다. items 가 아직 구현하지 않았으면 `crafting` 으로 폴백.

## `DerivedStats`
`computeDerived` 가 stats / skills / 장착 가방을 모두 반영해 한 번에 만든다. 재계산 시점:
프로필 로드, 스탯 소비, 스킬 레벨업, `equip:changed`, `loadout:changed`, `resetProfile`.

`implantCooldownMul` 에는 **특수 가방(전설) 퍼크 −50 %** 가 곱해져 있다
(`ctx.inventory.getEquipped('backpack')` → `ctx.loot.getItemDef(...).backpackId` → `getBackpackDef(...).perk === 'special'`).
inventory / items 의 신규 API 가 아직 없으면 `typeof` 체크 + `try/catch` 로 조용히 "퍼크 없음" 처리한다.

## 캐릭터 XP / 레벨
`xpToNext = round(XP_BASE × level^XP_EXPONENT)` (Phase 5 부터 `XP_BASE` 120: 120, 306, 536, …; 이전 240).
`addXp` 는 남는 XP 를 이월하며 레벨업마다 `progress:levelUp` 을 emit 하고 즉시 저장한다.
미션 종료 보상은 **`game/GameFlowSystem.awardMissionXp()`** 가 계산한다 (킬 · 생존 시간 · 탈출 보너스 · 전리품 가치).

## 영속화
`localStorage[PROFILE_STORAGE_KEY]`, `PROFILE_VERSION` 기반. **Phase 7 — 서버 프로필** (`ctx.net.profile`, 문서 키 `progression`):
- 모든 flush 는 localStorage 에 쓴 뒤 `profile.set('progression', 프로필 사본)` 도 큐에 넣는다 (`available` 이 false 면 no-op).
- `net:profileLoaded` → 서버 문서가 있으면 `migrate(doc)` 로 정규화해 로컬 프로필을 **대체**하고 (서버가 진실, localStorage 는 캐시로 갱신, 재업로드 없음),
  `progress:loaded` · `progress:xpGained {amount 0}` · 스탯 5개 `progress:statChanged` · 스킬 14개 `progress:skillProgress` 를 다시 emit 한다 (`levelUp` 은 내지 않는다).
  문서가 없으면 로컬 프로필을 업로드한다.

- 저장 시점: 레벨업, 스탯 소비, 스킬 레벨업, `implant:equipped`, 미션 종료(`GameFlow` 가 `save()` 호출),
  `game:abort`, `pagehide` / `beforeunload`, 그리고 변경이 있으면 15 초 주기 오토세이브.
- `save()` 는 dirty 플래그를 무시하고 강제로 쓴다 — GameFlow 가 `profile.raids` 를 직접 증가시킨 뒤 호출하기 때문.
- `migrate(raw)` 는 어떤 형태가 들어와도 현재 버전으로 정규화한다 (누락 필드 기본값, 모든 수치 클램프,
  알 수 없는 임플란트 id → `null`). 저장본 버전이 **더 높으면** 이름만 남기고 새 캐릭터로 시작한다.
- localStorage 자체가 없거나(프라이빗 모드) 쿼터가 차도 게임은 그대로 진행된다 — 모든 접근이 `try/catch`.

## 캐릭터 시트 — 단독 오버레이 (`ui/CharacterSheet.ts`)
- `ui:statsToggled {open}` 로 열고 닫는다. 편의상 **P** 키로도 토글되며,
  (Phase 8: 인벤토리 Tab 화면은 이 오버레이 대신 아래 임베드 뷰를 쓴다. 함선 터미널의 캐릭터 버튼도 Phase 8 에서 제거됐다.)
- 상단에 공용 화면 탭 `.scr-tabs` (인벤토리 · 캐릭터 · 기업 비활성; `ui/styles/base.css`) — **인벤토리** 탭은 시트를 닫고(`close(false)`) `ctx.inventory.toggleBag()` 을 부른다.
  게임플레이 / 함선 phase 에서 다른 blocker 가 없을 때만 열린다.
- `ctx.uiBlockers` 에 `'stats'` 토큰을 **먼저** 넣고 `ctx.input.setCursorMode(true, 'stats')` 로 인게임 커서를 켠다
  (**Phase 10**: 포인터 락은 그대로 유지한다 — `exitPointerLock()` 도, 닫을 때의 재잠금 마이크로태스크도 없다).
  닫을 때는 토큰을 지우고 `setCursorMode(false, 'stats')`. `close(relock)` 의 인자는 호출 시그니처 유지용으로만 남아 있다.
- Esc 는 capture-phase 리스너로 잡아 시트만 닫는다 (일시정지 메뉴로 새지 않는다).
- 내용: 레벨 + XP 바, 스탯 5종(설명 · 값 · `＋` 버튼 — 레이드 중 비활성) + 잔여 포인트, 스킬 14종 진행도 바,
  파생 능력치 18개 readout, 2단계 확인식 **캐릭터 초기화** 버튼(함선에서만). 이 본문 전체는 `ui/SheetBody.ts` 하나가 그린다.

### 임베드 뷰 `createSheetView(host)` (Phase 8)
인벤토리 Tab 화면의 **캐릭터 탭**이 부르는 진입점. 같은 `SheetBody` 를 `host` 안의 `.cs-embed` 래퍼에 만들고
`EmbeddedView {refresh, dispose}` 를 돌려준다. 오버레이와 **렌더러가 하나**라 표시 내용이 갈라지지 않는다.
- 임베드 뷰는 `'stats'` blocker 를 넣지 않고, 커서 모드 · 포인터 락을 건드리지 않으며, window Esc 리스너도 달지 않고,
  `.scr-tabs` pill 도 그리지 않는다 — 전부 인벤토리 창의 몫 (`src/shared/types.ts` `EmbeddedView` 계약).
- `ProgressionSystem` 은 넘겨준 뷰를 `views` 셋에 담아 스탯 · 스킬 · `derived` 가 바뀔 때마다 오버레이와 함께 갱신한다
  (`refreshSheets` / `refreshSheetSkill(id)` / `refreshSheetStat(id)`). `dispose()` 하면 셋에서 빠진다.
- `refresh()` 는 **캐릭터 초기화** 확인 단계를 항상 풀어 둔다 (탭을 다시 열었을 때 위험한 버튼이 눌린 채로 남지 않도록).

### 스크롤바 (Phase 8 수정)
`.menu .frame::before/::after` 코너 브래킷이 `-1px` 에 있어 `overflow-y: auto` 프레임에 가로·세로 1px 오버플로가
생기고 스크롤바가 상시 표시됐다. `character.css` 에서 브래킷을 안쪽(`left/top: 0`, `right/bottom: 0`)으로 당기고
`overflow-x: hidden; scrollbar-width: thin;` 을 명시, `min-width` 도 `min(820px, 100%)` 로 낮춰 좁은 창에서
가로 스크롤이 생기지 않게 했다 (`src/hub/hub.css` 5–13 줄과 같은 패턴). `.cs-embed` 도 같은 규칙을 쓴다.

## 다른 폴더가 쓰는 법
```ts
const d = ctx.progression?.derived;
const cd = base * (d?.implantCooldownMul ?? 1);
const cap = d?.carryCapacity ?? 39;          // 근력 5 기준값
ctx.progression?.addSkillXp('gardening', 0.35);
const implant = ctx.progression?.profile.implant ?? null;
```

## Phase 9 UI/UX 개선 pass (2026-09-07)

- **전술 임플란트 moved into the character sheet.** `ui/SheetBody` gained a `cs-implants` section between the XP bar
  and the 능력치 / 숙련도 columns: one `.cs-imp-card[data-id]` per `ctx.implants.getAllDefs()` (glyph, name, mode tag,
  description, cooldown / charges), the equipped one lit, a click equips it and a click on the lit one unequips.
  Raid-locked exactly as the old slot was (`ctx.isRaidActive()` → cards disabled + a 한국어 hint). It replaces the
  inventory window's 장착 장비 slot and its modeless picker, both of which are gone; the labels (`IMPLANT_TEXT`) live
  here now rather than in `inventory/ui/labels.ts`. Both shells (`CharacterSheet` overlay and the embedded
  `SheetView` = 캐릭터 tab) get it, since they share `SheetBody`.
- **CSS**: `.cs-implants(.is-empty) .h .hint`, `.cs-imp-key`, `.cs-imp-grid`,
  `.cs-imp-card(.is-equipped) .ico .body .line .nm .tag .desc .meta` in `ui/character.css`.

## Phase 10 UI 개선 pass (2026-09-07)

- **인게임 커서 (`docs/DECISIONS.md` Phase 10).** `ui/CharacterSheet.open()` 은 `'stats'` blocker 를 넣은 뒤
  `ctx.input.setCursorMode(true, 'stats')` 를 부른다 — **포인터 락을 풀지 않는다**. `close()` 는 토큰을 지우고
  `setCursorMode(false, 'stats')` 를 부르며, 예전의 재잠금 마이크로태스크(`isGameplayPhase / isHubPhase / isDead`
  가드 포함)는 삭제했다. `dispose()` 도 커서를 놓는다. `setCursorMode` 는 blocker 토큰 기준 ref-count 라서
  인벤토리 창 위에 시트가 겹쳐도 시트가 닫힐 때 커서를 빼앗지 않는다.
- **DOM 핸들러는 하나도 바꾸지 않았다.** 소프트 커서가 가상 좌표에서 실제로 버블링하는 `pointer*` / `mouse*` /
  `click` / `wheel` 이벤트를 합성하므로 시트 · `SheetBody` · 임플란트 카드의 클릭 · 호버 배선이 그대로 동작한다.
  이 폴더는 `input.mouseX / mouseY` 도 `document.elementFromPoint` 도 폴링하지 않으므로 그 외 이관 대상은 없다.
- 임베드 뷰(`createSheetView`)는 변함없이 blocker · 커서 · Esc 를 건드리지 않는다.

## 2026-09-07 UI/UX pass — 3열 본문 + 임플란트 모달리스 picker

- **`ui/SheetBody`** 의 본문이 **능력치 | 숙련도 | 전술 임플란트** 3열(`.cs-body`)이 되었다. 파생 능력치는 예전처럼
  그 아래 전체 폭이다.
- **전술 임플란트 열**은 카드 6장을 늘어놓는 대신 **장착 칸 하나**(`.cs-imp-slot`: 아이콘 · 이름 · 모드 · 설명)를
  보여주고, 누르면 **모달리스 picker**(`.cs-imp-pop`)가 떠서 그 안의 `.cs-imp-card` 목록에서 고른다. 고르면 장착
  하고 닫히며, 이미 장착한 카드를 누르면 해제한다. 바깥 클릭 · 닫기 · Esc(캡처 단계에서 삼킨다)로 닫힌다.
  레이드 중에는 예전처럼 잠긴다(칸을 누르면 경고 토스트).
- picker 는 `ctx.uiRoot` 의 직계 자식이다 — 임베드 탭이 사는 `.inv-screen` 이 `inv-pop` 애니메이션의 `scale:` 을
  남기므로 그 안에 두면 `position: fixed` 의 컨테이닝 블록이 되어 버린다. 두 shell 이 동시에 존재하므로 팝업은
  `.cs-imp-pop-overlay` / `.cs-imp-pop-embed` 로 구분한다(`SheetBodyOptions.variant`).
- **버그 수정**: 카드 목록을 생성자에서만 만들던 탓에, `ProgressionSystem` 이 `ImplantSystem` 보다 먼저 등록되는
  standalone 시트(`CharacterSheet`)는 `ctx.implants` 가 아직 없어 임플란트를 **영영 하나도 못 보여주고 있었다**.
  `refreshImplants` 가 목록이 비어 있고 `ctx.implants` 가 생겼으면 그때 만든다.
- **CSS**: `.cs-body` 3열(1280 px 아래 2열 + 임플란트가 전체 폭), `.cs-imp-slot(.is-filled/.is-open)`,
  `.cs-imp-pop(.cs-imp-pop-embed/-overlay)`, `.cs-imp-close` 를 `ui/character.css` 에 추가.

## 임플란트 아이템 (Phase 12, 2026-09-08)

Distinct from the 전술 임플란트 above: **items** of category `'implant'` (defs in `src/items/ImplantDefs.ts`,
`ItemDef.implant = {slots, stats, perk?, broken?, repairsTo?, repairCost?}`) slotted on the 캐릭터 tab. progression/ owns the
rules, the storage and the UI; items/ the defs and loot; meta/ (세레스 바이오) sales and repairs; player/ + weapons/ the perk effects.

- **Slots**: `implantSlots = min(IMPLANT_SLOTS_MAX 10, IMPLANT_SLOTS_BASE 4 + ⌊level / IMPLANT_SLOTS_PER_LEVELS 5⌋)` —
  level 1–4 → 4, 5 → 5, 10 → 6, 15 → 7, 20 → 8, 25 → 9, 30+ → 10. `implantSlotsUsed` = Σ `implant.slots` of the equipped
  (defs looked up through `ctx.loot`).
- **Storage**: `profile.implants: EquippedImplant[]` (`{uid, defId, durability?}`) — the item **instance leaves the grids**
  while equipped and lives in the profile, so it travels with the `progression` server document and comes back through
  `net:profileLoaded` (which re-emits `progress:implantsChanged`). `Profile.sanitizeImplants` normalises the array on
  load (missing → `[]`, non-objects / empty ids / duplicate uids dropped, cap 32); `PROFILE_VERSION` stays 1 — older saves
  simply get `[]`. `ProgressionSystem.pruneImplants` (inside `recompute`, once `ctx.loot` exists) silently drops an entry
  whose def id no longer resolves or is no longer an implant.
- **`equipImplant(uid)`** — ship only (`ctx.phase === 'hub'` and `!ctx.isRaidActive()`): `inventory.findItemAnywhere(uid)`
  → def must have `implant` and not `broken`, not already equipped, `slots` must fit → `inventory.takeItem(uid)` →
  push `{uid, defId, durability}` → `recompute` + save + `progress:implantsChanged {equipped, slots, used}`. false and
  nothing moves otherwise. **`unequipImplant(uid)`** — same gate: `loot.createItem(defId, 1, {durability})` with the
  **same uid** restored → `inventory.tryAddToStash` then `tryAddItemAnywhere`; refuses (stays equipped) when neither has
  room. `resetProfile` hands the equipped items back the same way (best effort) before wiping the character.
- **Derived**: `derive.ts` takes an `ImplantContribution {bonus, perks}` (`computeDerived(profile, specialBackpack,
  implants?)`); every stat formula reads `base + bonus` (`getStatWithImplants(id)` / `getImplantBonus(id)`), while
  `getStat(id)` stays the **base** — stat XP, `spendStatPoint` and `statFactor` are unaffected by implants.
  `derived.perks` has every `PerkId` (`emptyPerks()`), true when an equipped def carries it. `DEFAULT_DERIVED` = none.
- **캐릭터 tab UI** (`ui/SheetBody`, both shells): a `.cs-impitems` block under the 전술 임플란트 slot — header
  `임플란트 n / m칸` + a pip row (`.cs-impi-pips i.on` = used), one `.cs-impi-row[data-uid]` per equipped item (shared
  `buildItemChip` thumbnail → `ui/hud/ItemTip` hover card, name, `장착칸 k`, stat line `근력 +2` / perk name; click =
  unequip), an inline `.cs-impi-msg` line (`레이드 중에는 교체할 수 없습니다` / `함선에서만 교체할 수 있습니다` /
  `보관할 공간이 없습니다` / `<name> 장착` …) and a `+ 장착` button that raises a **second modeless picker**
  `.cs-impi-pop.cs-impi-pop-<variant>` (a `ctx.uiRoot` child like `.cs-imp-pop`, same anchoring) listing every implant
  item in the bag + 함선 창고 (`inventory.getAllItems()` + `getStashItems()`, working first, rarity high → low) with the
  chip, name, `장착칸 k`, rarity tag and stats / perk; rows that do not fit or are broken are dimmed + disabled with the
  reason (`장착칸 부족` / `망가짐 — 세레스 바이오에서 수리`). Stat rows show **`base (+bonus)`** (`.cs-stat .v > .base + .ib`,
  the bonus span empty when 0 so `.v` still reads the base). `closePicker()` / `isPickerOpen` now cover both pickers, and
  the standalone `CharacterSheet`'s Escape closes a raised picker **first** and the sheet on the next press.
  CSS: `.cs-impitems`, `.cs-impi-*`, `.cs-stat .v .ib` in `ui/character.css`.
- Smoke: `scripts/smoke-progression.mjs` — **119 / 119** (was 68): slots at level 1 / 5 / 30, the 46 defs + repair costs
  + spray gauge, loot rules, equip (bonus / derived / stash / event), overfill · broken · duplicate · unknown refusals,
  unequip back to the stash, legendary → `derived.perks.quick_heal`, raid / non-hub locks, the sheet block + picker DOM
  (dimmed rows, click-to-equip, Escape, raid line), reload round-trip, malformed-entry pruning, server document
  round-trip through a fake `ctx.net.profile`.

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **Phase 6** — **stat XP** (`profile.statProgress`, `addStatXp` ± with point gain/loss between `STAT_MIN`..`STAT_MAX`, `statXpToNext` = `STAT_XP_BASE × v^STAT_XP_EXPONENT`, `progress:statXp`), `addSkillXpRaw` (signed, unscaled), `getSkillGainMul` (× `ctx.housing.getSkillGainMul` inside `addSkillXp`), stat bars + 시설 badge in the sheet

- **Phase 7** — server `progression` document (`profile.set` on save, replace + `progress:*` re-emit on `net:profileLoaded`), 감정 XP from `container:itemRevealed`, training = `gun_*` skills only × `TRAINING_SKILL_GAIN_MUL`

- **Phase 8** — `createSheetView(host)` for the 캐릭터 tab (`ui/SheetBody` shared with the overlay) and the sheet's permanent scrollbars fixed

- **Phase 9** — the profile upload is no longer gated on a live connection (ProfileSync queues it) and `getSkillGainMul` is now 사격장 × **서재** (`ctx.housing.getBookBonus`)

- **Phase 9 UI/UX 개선** — `ui/SheetBody` 가 **전술 임플란트 카드**(`.cs-imp-card`, 장착 / 해제, 레이드 중 잠금)를 갖는다 — 인벤토리 장비 칸의 슬롯을 대체

- **2026-09-07 UI/UX pass** — 본문이 **능력치

- **2026-09-08 (UI/UX)** — **임플란트 UI 가 전부 빠졌다** — 전술 임플란트 열(`.cs-implants` · `.cs-imp-slot` · `.cs-imp-pop` · 카드)과 임플란트 아이템 블록(`.cs-impitems` · `.cs-impi-pop`)이 `inventory/ui/ImplantPanel.ts` 로 옮겨갔다. 본문은 **능력치 | 숙련도** 두 열이 되었고, `CharacterSheetHost` 에서 `implantSlots` / `implantSlotsUsed` / `getEquippedImplants` / `equipImplant` / `unequipImplant` 가 사라졌다 (`ProgressionRef` 는 그대로 — 이제 인벤토리가 부른다). 시트에 남은 임플란트 흔적은 능력치 줄의 `4 (+2)` 표시(`getImplantBonus`) 하나뿐이고, `SheetBody.closePicker` / `isPickerOpen` 도 함께 사라져 `ui/CharacterSheet` 의 Escape 사슬이 한 단 짧아졌다
