# 전술 키트 (Tactical Kit) — 구현 사양

> **병합 메모 (2026-09-06)**: 이 문서는 `feature/tactical-kit` 브랜치 작업 당시의 브리프다. main 에 병합할 때 Phase 1~4 설계를 우선했으므로
> 가방(`BackpackDef` → 무기 패키지의 `BagDef`), 빠른 사용(3~0 슬롯 → T 휠), 다운/부활(Phase 2), 무기 내구도(사격당 1) 은 여기 적힌 것과 다르다.
> 현재 동작의 기준은 항상 `CLAUDE.md` 와 각 폴더 README 다.


브랜치 `feature/tactical-kit`. `src/shared/` 계약은 **이미 확정**되어 커밋되어 있다
(`gear.ts`, `implants.ts`, `gadgets.ts`, `progression.ts`, 그리고 `types.ts` / `events.ts` /
`constants.ts` / `net.ts` 안의 `appended: tactical kit` 블록). 각 폴더는 이 계약을 구현한다.

## 모든 담당자 공통 규칙

1. **`src/shared/` 와 `src/main.ts` 는 수정 금지.** 계약 변경이 꼭 필요하면 직접 고치지 말고
   최종 보고서에 "shared 변경 요청"으로 적는다. 새 시스템의 main.ts 등록은 통합 담당자가 한다.
2. **담당 폴더 밖의 파일은 건드리지 않는다.** 다른 feature 폴더의 내부를 import 하지 않는다.
   `@/shared` 만 import 하고, 런타임 질의는 `ctx.*Ref` 로 한다.
3. **외부 에셋 금지.** 모든 모델·아이콘·텍스처는 Three.js 지오메트리 / CanvasTexture / 셰이더로
   코드에서 절차적으로 생성한다.
4. **UI 텍스트는 한국어.** HTML UI 는 `ctx.uiRoot` 아래 DOM 으로 만들고 CSS 로 스타일링한다 (React 없음).
5. `ctx.implants` / `ctx.gadgets` / `ctx.progression` 등 신규 ref 는 다른 에이전트가 동시에 만드는 중이며
   main.ts 등록도 마지막에 이뤄진다. **항상 null 체크**(`ctx.progression?.derived`)하고 없으면
   합리적인 기본값(배율 1, 보너스 0)으로 동작해야 한다.
6. 여러 에이전트가 동시에 작업하므로 `npm run typecheck` 전체는 아직 실패한다.
   **자기 폴더의 에러만 0** 이면 된다: `npx tsc --noEmit 2>&1 | grep "^src/<폴더>"`.
   다른 폴더의 에러는 무시하고 절대 수정하지 않는다.
7. 핫 패스에서 `THREE.Vector3` 등을 매 프레임 새로 만들지 않는다 (스크래치 객체 재사용).
   미션 리셋(`game:abort`, `game:newMission`)에서 자기가 만든 geometry/material 을 dispose 한다.
8. **런타임에 라이트 개수를 바꾸지 않는다** (셰이더 재컴파일로 프레임 히치 발생 — 과거에 수류탄에서 겪음).
   빛이 필요하면 emissive / 펄스 메시로 처리한다.
9. 끝나면 담당 폴더의 `README.md` 를 갱신한다.

## 멀티플레이 방침 (이번 라운드)

- **호스트 권위 동기화**: 월드에 남는 것 — 포탑, 바리케이드, 지뢰, 돔 실드, 점프대, 연막/화염/유인 구역,
  채집물. 배치는 클라이언트가 `gadq`/`harvq` 로 요청하고 호스트가 `gad`/`harv` 로 방송한다.
- **로컬 + 시각 브로드캐스트**: 대시, 배리어, 갈고리, 오버차지, 정찰, 대전차포, 근접, 무게, 스탯/스킬.
  본인 클라이언트에서 계산하고 `imp` / `melee` / `buff` 메시지로 남에게 보여주기만 한다.
- `PlayerSnapshot` 에 `imp` / `ar` / `bp` 필드와 `CLOAKED`/`BARRIER`/`DOWNED`/`MELEE`/`ROLL`/`HOVER`/
  `OVERCHARGED` 플래그가 이미 추가되어 있고 `net/` 이 채워 보낸다. 받는 쪽은 `RemotePlayerRef.implantId`,
  `.armorId`, `.backpackId`, `.isCloaked`, `.isDowned`, `.flags` 로 읽는다.
- 서버(`server/`)는 `GameMessage` 를 그대로 중계하므로 **서버 수정은 필요 없다**.

## 키 배치 변경 (이미 `constants.ts` 에 반영됨)

| 키 | 이전 | 현재 |
|---|---|---|
| `Q` | 무기 교체 | **전술 임플란트** (`KEY_IMPLANT`) |
| `V` | — | 무기 교체 (`Keys.SWAP`) |
| `F` | 스팀 | **근접 공격** (`KEY_MELEE`) |
| `H` | — | 스팀 (`Keys.STIM`) |
| `Alt` | 다이빙 | **구르기** (`KEY_ROLL`, `Keys.DIVE` 와 같은 키) |
| `3`~`0` | — | 빠른 사용 슬롯 (`QUICK_SLOT_KEYS`, 앞에서 `BackpackDef.quickSlots` 개만 활성) |
| `B` | — | 오버/언더 스로 전환 (`KEY_THROW_MODE`) |

---

# 폴더별 담당 범위

## `src/progression/` (신규) + `src/game/`

`ProgressionSystem` (`GameSystem` + `ProgressionRef`, `init` 에서 `ctx.progression = this`).

- **프로필 영속화**: `localStorage` 의 `PROFILE_STORAGE_KEY`. `PROFILE_VERSION` 기반 마이그레이션,
  모든 접근을 try/catch (프라이빗 모드 대비). 저장 시점: 레벨업, 스탯 소비, 임플란트 변경, 미션 종료.
- **스탯 5종** (근력/지구력/인지력/지능/재주), 기본 `STAT_BASE`, 최대 `STAT_MAX`,
  레벨업마다 `STAT_POINTS_PER_LEVEL` 포인트. `spendStatPoint` 는 `ctx.isRaidActive()` 면 거부.
- **스킬 14종** (`SKILL_IDS`), 0..`SKILL_LEVEL_MAX`. 행동으로 서서히 상승하며 상승량은 관련 스탯과
  지능(`skillGainMul`)에 비례한다. 버스 이벤트를 구독해서 올린다:
  - 사격(`gun_*`): `weapon:hit` — 명중 발당 상승량 저격 > 산탄 > 지정사수 > 돌격 > 기관단총
  - 인내 `grit`: `player:gritSaved`
  - 원예 `gardening`: `gather:collected`
  - 제작 `crafting` / 의학 `medicine`: `craft:completed` (레시피의 `skill` 필드)
  - 장비 관리 `equipment`: `repair:completed`
  - 전술 임플란트 `implant`: `implant:activated`
  - 암호학 `cryptography`: `extraction:activated`
  - 감정 `appraisal`: 상자 서치 (`crate:open` / `inventory:itemAdded`)
  - 운반 `carry`: 무게 70 % 이상(`inventory:weightChanged` 의 state가 'light' 이상)에서 이동한 거리 누적
- **`DerivedStats` 전 필드 계산** — 다른 폴더는 절대 공식을 재구현하지 않고 `ctx.progression.derived` 만 읽는다.
  `implantCooldownMul` 에는 특수 가방(전설) 퍼크 50 % 감소까지 합쳐 넣는다
  (`ctx.inventory?.getEquipped('backpack')` → `ctx.loot.getBackpackDef` 로 `perk === 'special'` 확인).
- **캐릭터 시트 UI**: `src/progression/ui/CharacterSheet.ts` — `ui:statsToggled` 로 열고 닫으며
  `ctx.uiBlockers` 에 `'stats'` 토큰을 넣고 `ctx.input.exitPointerLock()` 을 호출한다 (닫을 때 반대).
  레벨/경험치 바, 스탯 5종 + 남은 포인트 + `＋` 버튼(함선에서만 활성), 스킬 14종 진행도 바.
  CSS 는 `src/progression/ui/` 안에 두고 TS 에서 import 한다.
- **`src/game/GameFlowSystem`**: 미션 종료(`game:complete` / `game:over`)에 경험치 지급
  (킬·전리품 가치·탈출 보너스), `raids`/`extractions` 증가, `save()`. `player:downed` 상태의 플레이어는
  사망으로 세지 않도록 `checkAllDead` 를 보정한다 (다운은 `player:died` 가 아니다).

## `src/implants/` (신규)

`ImplantSystem` (`GameSystem` + `ImplantsRef`, `ctx.implants = this`). 6종:

| id | 이름 | 방식 | 동작 |
|---|---|---|---|
| `grapple` | 갈고리 | wielded | 좌클릭으로 와이어 발사, 지형/지물에 걸리면 그 지점으로 끌려간다. 매 프레임 조준점이 걸 수 있는지 판정해 `implant:grappleTargetChanged` 로 알린다 (크로스헤어 표시용) |
| `dash` | 대시 | instant | 3충전, Q 로 정면 짧은 순간이동 (`IMPLANT_DASH_DISTANCE`, 충돌 해소 후 이동) |
| `barrier` | 배리어 | instant(토글) | 정면 넓은 실드 전개, 내구도 `IMPLANT_BARRIER_HP`, 적대적 **발사체만** 차단. 비전개 시 `IMPLANT_BARRIER_REGEN`/s 회복 |
| `overcharge` | 오버차지 | wielded | 좌클릭 아군 회복, 우클릭 시전자+대상 이동속도↑·스태미나 소모 없음·연사속도↑ |
| `scan` | 정찰 | wielded | 좌클릭 홀드 시 1초마다 파동, 파동마다 반경 증가(최대 5회). 벽 너머 상자/적/목표/채집물/설치물을 10초간 표시 |
| `atlauncher` | 대전차포 | wielded | 좌클릭 로켓 발사, 착탄 시 큰 폭발 |

- 장착은 함선에서만: `setEquipped` 는 `ctx.isRaidActive()` 면 `false` 반환. 초기값은
  `ctx.progression?.profile.implant`, 변경 시 `implant:equipped` 이벤트로 progression 이 저장한다.
- 쿨타임에 `ctx.progression?.derived.implantCooldownMul` 을 곱한다.
- `blocksWeapons` 가 true 인 동안 무기는 발사되지 않는다 (weapons 가 읽는다). Q 로 넣고 뺀다.
- `raycastBarrier` 는 배리어 + (돔 실드는 gadgets 가 별도로) 판정한다. 적 발사체만 막는다.
- 정찰 결과는 `implant:scanned` + `detect:reveal` 두 이벤트로 보낸다 (UI 가 그린다).
- 오버차지 버프는 로컬은 `ctx.player.setSpeedModifier`, 원격 대상은 `buff` 메시지.
  연사속도 증가는 `ctx.player.isOvercharged` 를 weapons 가 읽어 처리한다.
- 원격 시전자의 갈고리 와이어 / 배리어 / 스캔 파동 / 로켓은 `imp` 메시지를 받아 직접 시각화한다.
- 모든 활성화 시 `implant:activated`, 쿨타임 변화 시 `implant:cooldownChanged` 를 emit (HUD 용).

## `src/gadgets/` (신규)

`GadgetSystem` (`GameSystem` + `GadgetsRef`, `ctx.gadgets = this`). `GADGET_DEFS` 는 이 폴더가 소유하고
`getDefs()` 로 노출한다 (items 는 `ItemDef.gadgetId` 문자열로만 참조).

| id | 이름 | 동작 |
|---|---|---|
| `cloakVeil` | 은폐 장막 | 자신 + 반경 내 아군을 `GADGET_CLOAK_DURATION` 초 은폐 (`player.setCloak`) |
| `domeShield` | 돔 실드 | 던져서 착탄점에 돔 전개, 내구도 1000, 오버/언더 스로 전환 가능 |
| `barricade` | 바리케이드 | 정면에 거대 바리케이드 설치, 누구나 3초 상호작용으로 해체·아이템화 (루팅 가능) |
| `lureGrenade` | 유인 수류탄 | 소음으로 버그 어그로 유인 (`ctx.enemies.addDistraction`), 원거리 적은 이쪽을 쏜다 |
| `smokeGrenade` | 연막탄 | 연막 생성. 적이 인지 못함(`visionFactor`), 안에서 사격하면 그 위치로 매우 부정확한 대응사격 |
| `mine` | 지뢰 | 3초 후 활성, 밟으면 광역 폭발. **피아 구분 없음**. 모두에게 인디케이터 표시, 해체 가능 |
| `turret` | 포탑 설치 | 정면에 자동 포탑. 적을 조준하나 사이의 아군도 맞는다. 상호작용으로 해체 |
| `incendiary` | 화염수류탄 | 착탄점에 10초 화염지대, 피아 구분 없이 화상 (`player.setBurning` / `enemies.applyStatus`) |
| `defib` | 제세동기 | 쓰러진(다운) 아군을 즉시 만피 부활 (`player.revive` / `buff` revive) |
| `jumpPad` | 점프대 | 밟으면 높이 점프, 달리면서 밟으면 전방으로 크게 도약. 상호작용으로 해체 |

- 배치형은 호스트 권위: 클라이언트는 `gadq place`, 호스트가 `gad spawn` 방송. 비호스트는 방송을 받아 복제만 한다.
  재접속 클라이언트는 `gadq sync` → `gad sync`.
- 해체/해제는 `Interactable` (`holdTime = GADGET_DEFUSE_TIME`, 진행 속도에 `derived.interactSpeedMul`).
  회수형(바리케이드/포탑/점프대)은 `gadget:recovered` 로 아이템을 돌려준다.
- 사용은 `use(id, underhand)`; 아이템 소비는 `ctx.inventory.consumeDef`. 투척 사거리에 `derived.throwRangeMul`,
  사용 속도에 `derived.useSpeedMul`.
- 인디케이터가 필요한 지뢰는 `gadget:deployed` 로 알리고 UI 가 그린다.

## `src/items/` + `src/inventory/`

**items**
- `ItemCategory` 신규 4종(`armor`, `backpack`, `gadget`, `herb`)의 라벨/색/아이콘/무게를 채운다.
  기존 `CATEGORY_LABEL_KO` 등 `Record<ItemCategory, …>` 맵을 모두 보완한다.
- 모든 기존 아이템에 `weight` 부여 (칸 수와 무게가 비례하지 않는 물건을 일부러 섞는다).
- 무기 `ItemDef.durabilityMax` + 일부 주무기에 `WeaponDef.meleeMul`(개머리판) 부여.
- **방탄복**: 넘버링 I~V (`ARMOR_DR_BY_TIER`) + 유니크 3종
  - 재생 방탄복 — V 보다 약간 낮은 댐감, 스태미나 풀일 때 초당 체력 1 회복 (`perk: 'regen'`)
  - 초경량 방탄복 — 낮은 댐감, 스태미나 회복속도 + 이동속도 증가 (`perk: 'ultralight'`)
  - 광학미채 방탄복 — 낮은 댐감, 상시 은폐 (`perk: 'optical'`)
- **가방**: 넘버링 I~V (칸 확장, 빠른 사용 4칸) + 전설 유니크 3종
  - 전술 가방 — 희귀급 칸, 빠른 사용 8칸, 주무기 교체 50 % 단축, 점프/공중에서 점프 홀드 시 호버(낙사 방지)
  - 특수 가방 — 희귀급 칸, 빠른 사용 4칸, 임플란트 쿨타임 50 % 감소
  - 점프 가방 — 희귀급 칸, 빠른 사용 4칸, 점프 후 재점프 시 전방 돌진(스태 50 %, 12초 쿨타임)
- **가젯 아이템 10종** (`category: 'gadget'`, `gadgetId` 는 위 표의 id).
- **채집물/제작 재료**: 약초 3종(`herb`), 화약(`material`).
- **레시피** (`getAllRecipes`): 탄약 분해 → 화약, 화약 → 원하는 탄약, 약초 → 회복 아이템(의학).
- `LootRef.getArmorDef` / `getBackpackDef` / `getAllRecipes` 구현, 루트 테이블에 신규 아이템 편입.

**inventory**
- 장비 슬롯 4칸(`primary`/`secondary`/`armor`/`backpack`) — `getEquipped` / `equip`,
  `equip:changed` + `loadout:changed`(armor/backpack 포함) emit.
- **가방 그리드 크기를 장착한 가방이 결정**한다 (미장착 시 기본 작은 그리드). 가방 교체로 칸이 줄어
  들어가지 않는 아이템은 바닥에 떨어뜨린다(`dropItem`).
- **무게 시스템**: `getWeight()` → `WeightInfo`. 용량 = `derived.carryCapacity` + 가방 `capacityBonus`.
  70 % 조금 무거움 / 90 % 무거움 / 100 % 과적. 변할 때마다 `inventory:weightChanged`.
  (실제 이동·스태미나 반영은 player 담당.)
- **빠른 사용 바**: `getQuickSlots` / `setQuickSlot` / `useQuickSlot`. 슬롯 수 = 가방의 `quickSlots`.
  키 입력(`QUICK_SLOT_KEYS`)도 여기서 처리하고 `quickbar:changed` / `quickbar:used` emit.
  가젯은 `ctx.gadgets?.use(...)`, 스팀은 회복, 탄약은 보급으로 연결한다.
- **필드 제작 UI**: 인벤토리 안의 버튼 → 제작 패널 (`ui:craftToggled`). 홀드 3초(`derived.craftSpeedMul`,
  `useSpeedMul`) 후 완성. `craft:started/completed/failed` emit.
- **내구도**: `getDurability` / `damageDurability` / `repair`(함선에서만). `durability:changed`,
  `durability:broken`, `repair:completed` emit. 아이템 툴팁·격자에 내구도 바 표시.
- 아이템 서치 연출(감정 스킬): 상자 루팅 시 아이템이 서서히 드러나고, 등급이 높을수록 오래 걸린다
  (`derived.searchSpeedMul`).

## `src/player/`

`PlayerRef` 에 추가된 멤버를 전부 구현한다.

- **구르기(`roll`)가 다이빙을 대체**: Alt → 이동 방향(입력 없으면 전방)으로 구른다.
  `ROLL_*` 상수, `player:rolled` emit, `isDiving` 은 와이어 호환을 위해 `isRolling` 을 그대로 반영.
  무거움(90 %) 이상이면 사용 불가.
- **근접 공격**: `startMelee()` — 스태미나 `MELEE_STAMINA_COST` 소모, `MELEE_COOLDOWN`,
  `isMeleeing` 동안 스윙 포즈. 실제 판정/피해는 weapons 가 한다 (`melee:swing` 을 weapons 가 듣는다).
- **무게 반영**: `ctx.inventory?.getWeight()` 의 `state` 로 이동속도·스태미나 회복을 조정하고,
  '무거움' 이상이면 구르기 금지, '과적'이면 이동 불가.
- **방탄복 댐감 + 내구도**: 피격 시 `ctx.inventory.getEquipped('armor')` → `ctx.loot.getArmorDef` 로
  `damageReduction` 적용 후 `ctx.inventory.damageDurability` 로 방탄복/가방 내구도를 깎는다.
  파손(내구도 0) 시 댐감 0.
- **인내**: 치명타로 hp 가 0 이하가 될 때 `derived.gritChance` 확률로 hp 1 로 버틴다.
  **DoT(화상·독)로는 발동하지 않는다.** 발동 시 `player:gritSaved`.
- **다운/부활**: 멀티플레이에서 치명상 시 `player:died` 대신 다운(`player:downed`, `DOWNED_BLEEDOUT` 초).
  `revive()` 로 만피 부활(`player:revived`). 싱글플레이는 기존대로 즉시 사망.
- **은폐**: `setCloak` / `isCloaked` / `getStealthFactor()`. 은폐 중 사격·달리기·구르기 또는
  경계 중인 적과 `CLOAK_REVEAL_DISTANCE` 이내 초근접 시 `CLOAK_BREAK_TIME` 동안 발각되고,
  거리가 벌어지면 다시 은폐된다. 광학미채 방탄복은 상시 은폐(duration Infinity).
- **가방 퍼크**: 전술 가방 호버(`setHovering`, 낙하 감속 + 착지 전 1회 호버로 낙사 방지),
  점프 가방 공중 재점프 전방 돌진(스태 50 %, 12초 쿨), 초경량 방탄복 이동속도/스태 회복.
- **갈고리 견인**(`setGrappleTarget`), **임펄스**(`applyImpulse`, 점프대·로켓), **화상**(`setBurning`).
- **속도 배율 스택**(`setSpeedModifier(key, mul, duration?)`) — 오버차지/초경량/슬로우가 서로 덮어쓰지 않게.
- `src/player/RemotePlayerSystem.ts`: 원격 아바타에 은폐(반투명), 다운(엎드림+표식), 구르기, 근접 스윙,
  호버 포즈를 반영하고 `DebugRemoteRef` 를 새 `RemotePlayerRef` 필드에 맞춘다.

## `src/weapons/`

- **근접 공격 판정**: `KEY_MELEE`(F)를 읽어 `ctx.player.startMelee()` 가 true 면 짧은 윈드업 뒤
  `MELEE_RANGE` 원뿔/구 판정으로 적과 설치물에 피해. 피해량은
  `MELEE_DAMAGE × (WeaponDef.meleeMul ?? MELEE_STOCK_MUL_DEFAULT) × derived.meleeDamageMul`.
  모든 무기의 기본 근접 피해는 동일하고 개머리판이 있는 주무기만 배율이 높다.
  `melee:swing` / `melee:hit` emit, 멀티에서는 `melee` 메시지 + 적 피해는 `hit` 요청.
- **무기 내구도**: 사격마다 `WEAPON_DURABILITY_PER_SHOT × derived.durabilityLossMul` 만큼
  `ctx.inventory.damageDurability`. 파손 시 연사속도 `BROKEN_WEAPON_FIRERATE_MUL`.
- **스킬 반영**: 사격 스킬(`derived.recoilMul[class]`, `reloadSpeedMul[class]`)로 반동·재장전 조정.
- **오버차지**: `ctx.player.isOvercharged` 면 연사속도 `IMPLANT_OVERCHARGE_FIRERATE_MUL`.
- **임플란트 연동**: `ctx.implants?.blocksWeapons` 면 발사/조준 금지, 임플란트를 드는 동안 무기 홀스터.
- **가방 퍼크**: 전술 가방이면 무기 교체 시간 50 % 단축. 교체 키는 `V`(`Keys.SWAP`)로 이동했다.
- **탄 차단**: 발사 판정 전에 `ctx.implants?.raycastBarrier` 와 `ctx.gadgets?.blocksProjectile` 로
  실드/바리케이드에 막히는지 확인한다 (아군 실드는 아군 탄을 막지 않는다 — 적 발사체 전용).

## `src/world/` + `src/enemies/`

**world**
- **채집물**: 미션 생성 시 `GATHER_NODES_PER_MISSION` 개를 지형에 배치, `getGatherNodes()` 구현.
  절차적 식물 메시 + `Interactable`(`GATHER_INTERACT_TIME`, `derived.interactSpeedMul`).
  수확 시 `gather:collected` emit 후 `ctx.inventory.tryAddItem` (수량에 `derived.gatherYieldMul`).
  멀티는 호스트 권위(`harv`/`harvq`), 재접속 시 `harvq sync`.

**enemies**
- `queryNear` / `addDistraction` / `applyStatus` / `applyAreaDamage` 구현.
- **인지 판정 개편**: 탐지 거리에 `target.getStealthFactor()`(은폐)와
  `ctx.gadgets?.visionFactor(from, to)`(연막)를 곱한다. 연막 안에서 플레이어가 사격하면 그 위치로
  **매우 부정확한** 대응사격을 한다.
- **유인**: 주 목표가 없거나 유인 강도가 높으면 `ctx.gadgets?.findDistraction` 위치로 향한다.
  원거리형(스퓨어)은 유인 수류탄/바리케이드/포탑을 쏴서 파괴하려 한다 (`findEnemyTarget` → `takeDamage`).
- **상태이상**: 화염지대의 `burning` DoT 를 `applyStatus` 로 받아 처리하고 시각 효과를 준다.
- 설치물(바리케이드/돔 실드)이 경로를 막으면 근접형은 그것을 때린다.

## `src/ui/` + `src/audio/`

**ui** (`.hud.gameplay` / `.hud.social` 레이어 구분 유지)
- **임플란트 위젯**: 아이콘 + 쿨타임 링 + 충전 수 + 배리어 내구도 바 (`implant:*` 이벤트).
- **갈고리 크로스헤어**: `implant:grappleTargetChanged` 로 걸 수 있을 때 레티클 상태 변경.
- **빠른 사용 바**: 4/8칸, 키 번호, 수량, 쿨다운 (`quickbar:*`).
- **무게 바**: 현재/최대 kg + 상태 라벨(`WEIGHT_STATE_LABEL_KO`), 90 %/100 % 경고.
- **감지 시스템**: `derived.detectRadius` 안의 상호작용 오브젝트(상자·채집물·픽업·설치물)에
  프레넬 강조 셸을 씌운다. 화면 밖 적은 `derived.enemyDetectRadius` 안에서 빨간 화살표 인디케이터.
  풀링 필수 — 매 프레임 메시를 만들지 않는다.
- **스캔 표시**: `detect:reveal` 대상 10초간 벽 너머 아웃라인.
- **다운/부활**: 다운 오버레이 + 남은 시간, 아군 다운 위치 표식과 부활 프롬프트.
- **지뢰 인디케이터**(모두에게 표시), 설치물/채집물 맵 아이콘.
- 근접·구르기 피드백, 내구도 경고, 레벨업/스킬업 토스트(`progress:*`).
- **캐릭터 시트는 progression 담당**이므로 만들지 말고, 필요하면 `ui:statsToggled` 만 emit 한다.

**audio**: 신규 절차적 SFX — 갈고리 발사/부착, 대시, 배리어 전개/피격/파괴, 오버차지 빔, 스캔 파동,
로켓 발사/폭발, 근접 스윙/타격, 구르기, 점프대, 포탑 사격, 지뢰 활성/폭발, 화염, 제세동기,
채집, 제작 완료, 내구도 파손, 레벨업.

## `src/hub/`

함선 터미널(`ui/HubMenu`)에 항목 추가 + 대응 함선 시설(절차적 메시 + `Interactable`):

- **전술 임플란트 장착**: 6종 목록, 설명, 선택 → `ctx.implants?.setEquipped`. 레이드 중 변경 불가 안내.
- **캐릭터**: `ui:statsToggled` emit (패널 자체는 progression 소유).
- **장비 수리**: 내구도가 닳은 장비 목록과 수리 버튼 → `ctx.inventory?.repair(uid)`.
- **약초 재배(원예)**: 함선 수경 재배 스테이션. 심기/수확 상호작용으로 약초를 얻고 원예 스킬이 오른다.
- 개인 함선/공유 함선 양쪽 인테리어에 스테이션을 배치하되 draw call 이 크게 늘지 않게 한다.
