# Phase 6 계획서 — 개발자 콘솔(치트) · 유니크 무기 · 함선 꾸미기 (2026-09-06)

기획 원문을 구현 단위로 정리한 브리프. `src/shared` 계약은 **이미 작성·커밋되어 있다** (`shared/console.ts`,
`shared/housing.ts`, 그리고 `constants / types / events / net / gear / progression / GameContext / Keybinds` 의
`appended (2026-09-06)` 구역). 각 에이전트는 자기 폴더만 소유하고, 계약은 읽기만 한다 (append 가 꼭 필요하면 리드에게 보고).

## 0. 사용자 결정 (AskUserQuestion, 2026-09-06)
| 항목 | 결정 |
|---|---|
| 치트 권한 | **페이지 호스트가 localhost** 일 때만 (`isDevHost()` — `DEV_HOSTS`). 서버 검증 없음. 다른 클라이언트는 콘솔 자체가 없다 (`ctx.console.enabled === false`). |
| 스탯 경험치 | **스탯 경험치 모델 추가** (`profile.statProgress`, `addStatXp`). 레벨업 포인트 방식은 그대로 유지. 0 미만 → 스탯 −1 (하한 `STAT_MIN`), 1 이상 → +1 (상한 `STAT_MAX`). |
| 함선 꾸미기 범위 | **프레임워크 + 핵심 방**: 조종석-복도-10개 방 구조, 발전기/창고 업그레이드, 하우징 모드(그리드 배치·90° 회전·회수·가구 창고), 방 용도 확정, **작업실**(4 작업대 + 업그레이드 + 수리), **사격장**(로드아웃 프리셋 + 사격 숙련 상승 보너스). 나머지 7개 방은 용도 확정과 장식 배치만 가능, 기능은 다음 세션. |
| 유니크 무기 획득 | **전설 루트 + 치트 상자**: 4/5 티어 상자와 로그 보스 시체 테이블에 낮은 확률로 등장, `/items` 무한 상자에서도 획득. 주무기 슬롯 사용, 전용 탄약. **우클릭 = 보조 발사이므로 정조준(ADS) 없음.** |

## 1. 개발자 콘솔 (`src/console/`, 신규 — 스켈레톤 `ConsoleSystem.ts` 가 `main.ts` 에 이미 등록됨)
- ` (`Keys.CONSOLE`, `Backquote`) 로 열고 닫는다. **dev 클라이언트에서만** (`isDevHost()`); 아니면 키·DOM 모두 없음.
- 언리얼 스타일: 화면 **최하단** 가로 한 줄 입력칸 (`ctx.uiRoot` 아래 `.dev-console`), 그 위에 최근 출력 로그 (최대 `CONSOLE_MAX_LINES`, 반투명).
  입력 중에는 입력 글자로 시작하는 커맨드 목록이 입력칸 위에 미리보기로 뜬다 (`CONSOLE_SUGGESTIONS_MAX`); **↑/↓ 로 목록 커서 이동**, Tab/Enter 로 선택.
  입력칸이 비어 있을 때 ↑/↓ 는 **최근 입력 히스토리** (`CONSOLE_HISTORY_KEY`, 최대 `CONSOLE_HISTORY_MAX`, localStorage) 를 탐색한다.
- 열려 있는 동안 `ctx.uiBlockers` 토큰 `'console'` 을 **먼저** 넣고 `ctx.input.exitPointerLock()`; 닫으면 토큰 제거 후 blocker 가 없고 gameplay/hub 면 마이크로태스크에서 재잠금 (인벤토리와 동일 예절). Esc 는 capture-phase 리스너로 콘솔만 닫는다. Backquote 문자가 입력칸에 찍히지 않게 `preventDefault`.
- 커맨드 등록: `ctx.console.register({ name, usage, description, run, complete? })`. 입력은 `/move …` 와 `move …` 모두 허용, 대소문자 무시. 알 수 없는 커맨드 → 빨간 줄. 모든 출력 한국어. `console:toggled`, `console:executed` emit.
- 내장 커맨드 (모두 `console/commands/*.ts`):
  - `help [name]` — 목록/설명. `clear`.
  - `seed <숫자|문구|random>` — `ctx.hub.setMissionSeed(seed)` (문구는 hub `parseSeed` 와 같은 FNV-1a 로 uint32 변환; `random` = null). 함선(hub) 페이즈에서만. 로비 비호스트면 오류. `cheat:seed` emit.
  - `move <x>,<y>,<z>` — **행성(gameplay 페이즈)에서만**. `ctx.world.isInsideBounds(x, z)` 가 false 면 오류 `맵 범위를 벗어났습니다 (±MAP_SIZE/2)`. y 는 지형 높이 아래면 지형 높이로 스냅 (`ctx.player.teleport(pos)`). 좌표 파싱은 쉼표/공백 모두 허용.
  - `movecheat <0|1>` — 토글. 켜져 있고 `Keys.MOVE_CHEAT`(Home) 를 누르고 있는 동안 `update()` 에서 카메라 forward 방향으로 `MOVE_CHEAT_SPEED × dt` 만큼 `teleport` (행성·함선 모두, `isControlActive()` 일 때). `cheat:moveCheat` emit.
  - `items` — `ctx.inventory.openCatalog()` (무한 상자 창은 inventory 소유).
  - `stat <id|한국어이름> <±xp>` — `ctx.progression.addStatXp(id, n)`; id 는 `str/end/per/int/dex` 별칭과 `strength …` 전체 이름, 한국어 이름(근력…) 모두 허용. 결과 줄에 `근력 7 (312/1852)` 식 현재값·진행도 출력.
  - `skill <id|한국어> <±xp>` — `ctx.progression.addSkillXpRaw(id, n)`; `gun_AR` 등 14종 + 한국어 이름. `complete()` 로 id 자동완성.
  - `pos` — 현재 좌표/페이즈 출력 (디버그 편의).
- 스모크: `scripts/smoke-console.mjs` — dev host 판정(`localhost` → enabled, 스크립트가 `?` 로 host 를 바꿀 수 없으니 `isDevHost('example.com') === false` 를 evaluate 로 확인), ` 로 열림/blocker, `mo` 입력 → 제안 목록에 `move`/`movecheat`, ↑↓ 커서, `/move 0,0,0` 은 함선에서 오류·행성에서 성공, 맵 밖 오류, `/movecheat 1` + Home 홀드 → 위치 전진, `/items` → 카탈로그 열림, `/stat str 100000` → 스탯 상승, `/stat str -999999` → 하락(하한), `/skill gun_AR 50`, 히스토리 localStorage. `scripts/verify.mjs` 의 `SMOKES` 에 등록 (`folders: ['console', 'progression', 'inventory', 'player', 'hub']`).

## 2. 스탯 경험치 (`src/progression/`)
- `profile.statProgress` (마이그레이션: 없으면 0으로), `PROFILE_VERSION` 은 필드가 optional 이므로 올리지 않아도 되지만 `migrate` 에서 클램프.
- `addStatXp(id, amount)`: `statXpToNext = round(STAT_XP_BASE × value^STAT_XP_EXPONENT)`. 진행도 ≥ 1 → 스탯 +1 (STAT_MAX 에서는 진행도 1 로 고정), 진행도 < 0 → 스탯 −1 (STAT_MIN 에서는 0 으로 고정) 하고 진행도는 새 값 기준으로 이월. `progress:statXp` + 값이 바뀌면 `progress:statChanged` (pointsLeft 는 그대로), `recompute()`, 저장.
- `addSkillXpRaw(id, amount)`: 스케일 없이 부호 그대로; 음수로 진행도 < 0 이면 레벨 −1 (0 미만 불가). `progress:skillProgress` / `progress:skillUp` (레벨이 내려가도 같은 이벤트로 알림 — 페이로드에 `level`).
- `getSkillGainMul(id)`: `ctx.housing?.getSkillGainMul(id) ?? 1` 을 **`addSkillXp` 내부에서 곱한다** (사격장 보너스). 시트에 표시.
- `ui/CharacterSheet`: 스탯 행에 진행도 바 + `xp/next` 텍스트. README 갱신. 스모크: 콘솔 에이전트의 `smoke-console` 이 `/stat` 을 검증하므로 여기서는 `scripts/smoke-progression.mjs` (작게: addStatXp 상승/하락/클램프, addSkillXpRaw 하락, 마이그레이션, 시트 DOM) 를 추가하고 `SMOKES` 에 등록.

## 3. 유니크 무기
### 3-a 데이터 (`src/items/`)
- `WeaponDefs.ts`: `UNIQUE_WEAPON_DEFS` 6종 (`WeaponDef.unique`, `altFire: true`, `grade: 5`, `family` 없음, `maxDurability` 넉넉히), `WEAPON_DEFS` 에 포함하되 **`buildGrades` 대상이 아님** (등급 파생 없음). 클래스: 화염방사기 `SG`? → **아니다**: 사격 숙련은 `weaponClass` 로 정해지므로 `flamethrower/minigun → 'AR'`, `shockgun/bow → 'DMR'`, `shuriken → 'SMG'`, `bazooka → 'SR'` 로 둔다 (`AMMO_FOR_CLASS` 는 무시하고 `ammoType` 을 전용 탄약으로 명시).
  이름/id: `u_flame` 「인페르노」 화염방사기, `u_shock` 「테슬라 코일」 전격총, `u_shuriken` 「카게」 표창, `u_bow` 「롱혼」 컴포짓 보우, `u_bazooka` 「해머헤드」 바주카, `u_minigun` 「사이클론」 미니건. 수치는 `constants.ts` 의 `FLAME_* / SHOCK_* / SHURIKEN_* / SLASH_* / BOW_* / BAZOOKA_* / MINIGUN_*` 를 그대로 def 에 옮긴다 (`damage`, `fireRate`, `magSize`, `range`, `projectileSpeed`, `altDamage`, `chargeTime`, `ammoPerSec`).
- 전용 탄약 `ammo_fuel / ammo_cell / ammo_shuriken / ammo_arrow / ammo_rocket / ammo_belt` (`AMMO_STACK_ROUNDS` 에 이미 있음, `AMMO_LABEL_KO` 에 라벨 있음, `AMMO_TYPES_V2` 에 추가, 무게 `AMMO_ROUND_WEIGHT`). 유니크가 등장하는 상자에 같이 등장.
- `ItemDefs`: 유니크 6종의 `wpn_u_*` 아이템 (rarity legendary, 크기 5×2 등), 설명에 좌/우클릭 동작. 새 재료 `mat_cable` 전력 케이블 (common), `mat_circuit` 회로 기판 (rare) — 함선 시설 비용용, 2~4 티어 상자에 등장.
- `WeaponStats.ts`: `unique` 면 등급 스케일 없음, `canAttach → false`, `computeWeaponStats` 는 def 값을 그대로. `repairCost` 는 전설 기준.
- `LootTables.ts`: 티어 4 (`legendary` 가중치 내에서 유니크 6종 합계 ~15 %), 티어 5 보급 (낮게), `CORPSE_TABLES` 의 `rogue_boss` 에 유니크 1종 20 %. `rollCorpse` 는 그대로.
- `Recipes.ts`: 기존 `station: 'ship'` 레시피에 `bench` 부여 (`make_mine → gadget`, `make_defib_charge → gadget`, `grow_* → medical`), 새 작업실 레시피 (총기: `make_ammo_*` 대량판 `bench: 'gun'`, `att_*` 부착물 몇 종 `benchLevel 2`, 유니크 전용 탄약 `benchLevel 3`; 장비: `armor_1/2` `bag_*` 하위 등급 `bench: 'gear'`; 가젯: 수류탄/연막 `bench: 'gadget'`; 의학: `make_stim_advanced` `bench: 'medical'`). README 갱신. 단위 확인은 `inventory/__selftest__` 가 아니라 콘솔/무기 스모크에서.

### 3-b 동작 (`src/weapons/`) — items 가 끝난 뒤 시작 (2차 웨이브)
- `WeaponDef.unique` 로 분기하는 `unique/*.ts` 핸들러 (`Flamethrower.ts`, `Shockgun.ts`, `Shuriken.ts`, `Bow.ts`, `Bazooka.ts`, `Minigun.ts`), 공통 인터페이스 `UniqueHandler { update(dt, host, w, input) ; onEquip/onUnequip }`. **RMB 는 ADS 가 아니라 보조 발사** (`host.setAimZoom(1,false)`, `isAiming` 무시). `weapon:altFired`, `weapon:beamChanged`, `weapon:chargeChanged` emit.
- 화염방사기: LMB 홀드 → 원뿔(`FLAME_RANGE`/`FLAME_CONE_DEG`) 안 적에게 `FLAME_DPS × dt` (`queryNear` + 각도/LOS), 매 틱 `applyStatus('burning', FLAME_AFTERBURN_DPS, FLAME_AFTERBURN_DURATION)`, 적별 heat 누적(`Map<id, heat>`, `BURNOUT_DECAY_PER_SEC`) → `BURNOUT_THRESHOLD` 도달 시 `applyStatus('incinerated', 0, BURNOUT_DURATION)` 후 heat 0. RMB 홀드 → 긴 가는 제트 (`FLAME_ALT_*`). 연료 `ammoPerSec` 소모(`ammoInMag` 를 소수 누적으로 차감), 파티클/빛 없이 additive 메시 콘. 플레이어 자신에게는 피해 없음.
- 전격총: LMB 홀드 → 시야 원뿔 내 가까운 적 `SHOCK_MAX_TARGETS` 마리에게 동시에 `SHOCK_DPS` + `applyStatus('shocked', SHOCK_SLOW_FACTOR, SHOCK_SLOW_DURATION)`, 번개 라인 메시(지그재그 `Line`/얇은 박스, 매 프레임 갱신). RMB 홀드 → 충전 (`weapon:chargeChanged kind:'charge'`), 놓으면 히트스캔 볼트 `SHOCK_CHARGE_DAMAGE × lerp(MIN_RATIO,1,t)`, `SHOCK_CHARGE_CELLS` 소모. 연사 제한 = 충전 시간.
- 표창: LMB → 투사체 1 (`Projectile` 재사용, 회전하는 별 메시), RMB → 3개 부채꼴 (`SHURIKEN_TRIPLE_*`). **근접 변경**: 이 무기 장착 중 `Keys.MELEE` 짧게 → 기존 `startMelee()`; `SLASH_HOLD_TIME` 이상 홀드 후 떼면 `player.consumeStamina(maxStamina × SLASH_STAMINA_RATIO)` 성공 시 `player.setViewWiden(true)` → `startMelee('heavy')` → `SLASH_ARC_DEG`/`SLASH_RANGE` 안 모든 적에 `SLASH_DAMAGE` (`queryNear`), `player:slashed`, `SLASH_DURATION` 후 `setViewWiden(false)`. 홀드 중 `weapon:chargeChanged kind:'slash'`.
- 컴포짓 보우: 투사체 화살 (`BOW_*`), 중량탄급 낙차 없음(직선), RMB 없음 → `altFire: false` 여도 되지만 ADS 는 허용 (기획: 저격보다 짧은 사거리, DMR 연사). 유일하게 ADS 를 쓰는 유니크.
- 바주카: LMB → 착탄 폭발 로켓 (`applyExplosion` 또는 `applyAreaDamage`, 구조물 피해 포함). RMB → `BAZOOKA_ALT_FUSE` 후 공중 폭발. **자가 피해**: 폭발 반경 안이면 `player.takeDamage(BAZOOKA_SELF_DAMAGE)` + `applyKnockback(away, BAZOOKA_KNOCKBACK)`; 공중(`!isGrounded`)이고 폭발점이 발 아래면 `applyImpulse(0, BAZOOKA_SUPER_JUMP, 0)` 추가 + `player:blastJump`. 로켓 메시 + 배기 트레일.
- 미니건: LMB 홀드 → `MINIGUN_SPINUP_TIME` 동안 `weapon:chargeChanged kind:'spinup'` + 총열 회전 애니, 완료 후 `MINIGUN_FIRE_RATE` 히트스캔 (`MINIGUN_SPREAD_DEG`), 놓으면 `MINIGUN_SPINDOWN_TIME` 동안 감속. 회전 중 `player.setSpeedModifier('minigun', MINIGUN_MOVE_MUL)`.
- 모델: `WeaponModel.ts` 에 6종 절차적 메시 (`unique` 별 실루엣 — 연료통, 코일, 팔 보호구+표창 홀더, 활+시위, 튜브, 6총열).
- 네트: `fire` 메시지에 `m`(0/1), `c`; 연속 무기는 ≤ 10 Hz 로 보내고 끝에 `c: -1`. `RemoteWeapons` 가 유니크 FX 를 재생(콘/번개/트레일). 적 피해는 기존 `hit` 요청 경로; 전소/감전은 `HitRequest.st` 비트(`ENEMY_STATUS_BITS`) + `dur` 로 호스트에 전달 (`ctx.enemies.applyStatus` 가 replica 면 스스로 전달하므로 weapons 는 그냥 호출).
- HUD 는 ui 소유: `weapon:chargeChanged` 게이지, 무기 패널의 `좌 …/우 …` 모드 표기 (`WeaponDef.altFire`). README 갱신. 스모크 `scripts/smoke-uniques.mjs`: `/items` 없이 `ctx.loot.createItem('wpn_u_flame')` + `inventory.tryAddItem` + `equip` 으로 6종 장착, 적을 `debug` 스폰(`enemies` 스모크 참고) 후 각 발사 모드가 피해/상태/이벤트를 내는지, 표창 용검이 스태미나 50 % 소모, 바주카 슈퍼 점프가 y 속도를 올리는지, 미니건 예열 이벤트. `SMOKES` 등록 (`folders: ['weapons', 'items', 'enemies', 'player', 'ui']`).

### 3-c 적 상태 + 플레이어 훅 (`src/enemies/` + `src/player/`, 한 에이전트)
- enemies: `applyStatus('incinerated' | 'shocked')` 실제 구현 (스텁 제거). 전소: `e.incapacitatedTimer`, AI 상태 `stagger` 계열로 이동 정지·공격 불가, **몸부림 애니**(rig 를 좌우로 뒤틀고 다리를 버둥거리는 절차적 포즈, 불꽃 additive 파편 재사용), `isIncapacitated` getter, `enemy:incinerated` emit, 끝나면 복귀. 감전: `slowed` 와 같은 감속 + 짧은 청백 스파크, `enemy:shocked`. 호스트: `HitRequest.st/dur` 처리 (`ENEMY_STATUS_BITS`), replica: `applyStatus` 를 `hit {dmg:0, st, dur}` 로 전달. `EnemyWire.sb` 로 상태 비트 송신 → replica 가 시각 재현 (기존 burning 도 여기에 실어 알려진 follow-up 하나를 해소). Targets/AI 는 전소 중인 적을 `isCombatant=false` 로 취급. README.
- player: 스텁 교체 — `teleport(pos, yaw?, snap)` (지형/데크 높이 스냅, 헬포드 없음, `player:spawned` 안 냄, 카메라 즉시 따라감), `setViewWiden` (CameraRig 에 `fovMul` 목표값, damp), `consumeStamina`, `startMelee('heavy')` (용검 포즈: 양손 크게 휘두르기, `SLASH_DURATION`, `isMeleeing` 유지, weapons 가 판정), `setWeaponState` 의 `charging/spraying/heavy` 포즈 (버팀 자세·허리 사격). 원격 아바타는 `PlayerFlags` 추가 없이 기존 FIRING/TWO_HANDED 로 충분. README. 검증은 `smoke-uniques` (weapons 에이전트) 와 `smoke-console` 이 하므로, 이 에이전트는 `scripts/smoke-phase4.mjs` 를 돌려 회귀 없음을 확인하고 자기 훅은 짧은 인라인 puppeteer 체크로 검증.

## 4. 함선 꾸미기
### 4-a 규칙·상태·DOM (`src/housing/`, 신규 — 스켈레톤 `HousingSystem.ts` 가 `main.ts` 에 등록됨, `ProgressionSystem` 다음)
- `ShipState` 로드/저장 (`SHIP_STORAGE_KEY`, 디바운스 350 ms, pagehide flush, try/catch, 마이그레이션). 새 상태: 방 10개 `empty`, 발전기 0, 창고 0, 가구 창고 비움, 프리셋 없음. **초기 편의**: 첫 실행 시 가구 창고에 `furn_bench_gun` 1개를 넣어 준다 (작업실을 만들면 바로 설치 가능).
- 시설 규칙: 모든 시설/작업대 업그레이드는 **발전기 레벨 ≥ 목표 레벨** 이 선행 (발전기 자신 제외). 창고 레벨 → `getStashSize()` = `STASH_COLS × STASH_ROWS_BY_STORAGE_LEVEL[level]` → `housing:stashSizeChanged`. 작업실/사격장 레벨은 해당 용도의 방이 있어야 하며 용도 확정 시 1 부터. 비용은 `constants` 의 `*_UPGRADE_COST` (재료는 `ctx.inventory.countDefAll/consumeDefAll` — 가방 + 창고). `FacilityInfo.blocked` 에 한국어 사유.
- 방: `setRoomPurpose` (가구가 있으면 `room:'any'` 가 아닌 가구가 남아 있을 때 거부, `lab` 은 온실 필요). 용도 변경 시 레벨 1. `empty` 로 되돌리면 가구 전부 회수.
- 가구: `FURNITURE_DEFS` (계약). `canPlace` = 방 용도 일치(또는 any) + 그리드 안 + 겹침 없음. `place/move/rotate/recover/craftFurniture/upgradeFurniture`. uid `f-<n>`. `getBenchLevel(kind)` = 설치된 해당 작업대 최고 레벨. `getCraftCostMul()` = `1 − WORKSHOP_COST_DISCOUNT_PER_LEVEL × (workshopLevel − 1)`.
- 사격장: `getPresetCount()` = `PRESETS_BY_RANGE_LEVEL[rangeLevel]`, `getSkillGainMul(gun_*)` = `1 + RANGE_SKILL_GAIN_PER_LEVEL × rangeLevel`. `applyPreset` → `ctx.inventory.applyLoadout` (함선에서만) + `housing:presetApplied`. 프리셋 저장은 `ctx.inventory.captureLoadout()` + 이름.
- 하우징 모드 상태 (`enterHousingMode/exitHousingMode/selectFurniture/rotateSelection`) — 함선 hub 페이즈, 개인 함선, 해당 방에 있을 때만. hub 가 카메라/커서를 담당하고 `place/move/recover` 를 호출한다. 진입 시 `ctx.uiBlockers` 는 넣지 **않는다** (이동 가능해야 함); hub 가 조작을 가로챈다.
- DOM 패널 (`housing/ui/`, `.menu.housing-menu`, `hub.css` 와 같은 `.menu .frame .ui-btn` 재사용, 블로커 토큰 `'housing'`, 포인터락 예절 동일):
  - **방 메뉴** `openRoomMenu(room)`: 용도 선택(활성 3종 강조, 나머지 "다음 업데이트" 배지), 방 레벨 업그레이드 버튼(작업실/사격장), 가구 창고 목록(설치 가능 여부·수량), 제작 가능 가구 목록(재료 표시·부족 시 빨간색), **하우징 모드** 버튼 → `enterHousingMode(room)` + 메뉴 닫기.
  - **시설 메뉴** `openFacilityMenu()`: 발전기·창고(+ 작업실/사격장 요약) 레벨/비용/업그레이드.
  - **프리셋 메뉴** `openPresetMenu()`: 슬롯 n개 — 이름 편집, `현재 장비 저장`, `적용`, `삭제`; 적용 결과(장착 n · 없음 목록) 표시.
  - `ui:housingToggled` emit. Esc capture 로 닫기.
- 하우징 모드 HUD 힌트는 ui 소유 (`housing:modeChanged`, `housing:selectionChanged`, `housing:cursorChanged` 구독).
- README. 스모크 `scripts/smoke-housing.mjs`: 새 상태 로드 → 방 0 `workshop` 확정 → `furn_bench_gun` 설치(`place`)·회전·이동·회수·재설치, `canPlace` 겹침/범위/용도 거부, `/items` 없이 `ctx.loot.createItem('mat_scrap', 30)` 등을 `tryAddItem` 으로 넣고 발전기 1 → 창고 1 → `getStashSize().rows === 30` + `inventory.getStashSize()` 동기화, 작업실 업그레이드 선행조건(발전기) 거부/성공, 가구 제작·업그레이드, 사격장 방 + 콘솔 설치 → 프리셋 저장/적용(`applyLoadout` 결과), 리로드 후 상태 유지, DOM 패널 3종 열림/닫힘/blocker. `SMOKES` 등록 (`folders: ['housing', 'hub', 'inventory', 'progression']`).

### 4-b 개인 함선 재구성 + 3D 하우징 (`src/hub/`)
- `interiors/PersonalShip.ts` 를 **조종석 → 복도 → 방 10개 → 에어락** 구조로 재작성. 제안 치수: 조종석 8×6 m (−Z 끝, 기존 대시보드·시트·터미널·포드·정비 벤치·임플란트 시술대·수경 재배 랙·창고 프롭·**시설 콘솔**), 복도 폭 3 m 가 +Z 로 5칸 × 5 m = 25 m, 좌우에 4×4 m 방 (내부 그리드 `ROOM_GRID_COLS × ROOM_GRID_ROWS × HOUSING_CELL_SIZE`), 각 방은 복도 쪽 문(1.6 m 개구), 방 앞 복도 벽에 방 번호 사인(`TextPlane`) + 용도 라벨(변경 시 갱신), 끝에 에어락(도킹 시 공유 함선 입구 — 현재는 장식 + `airlock` 스폰). 방 인덱스: 0..4 = −X 쪽 앞→뒤, 5..9 = +X 쪽. 조명은 `fixture()` 개수 고정 (예: 조종석 4 + 복도 5 + 방당 0, 방은 emissive 스트립) — **런타임 라이트 토글 금지**.
  성능: 방 벽/바닥은 `GeoBatch` 로 재질별 병합 (drawcall ~ 재질 수), 가구는 방마다 별도 `Group` (설치/회수 시 add/remove).
- `HubRef.currentRoom` + `hub:roomEntered` (플레이어 XZ 가 방 AABB 안). 방마다 `Interactable` `hub_room_<i>` (문 옆 콘솔, 즉시, `방 n · <용도>`) → `ctx.housing.openRoomMenu(i)`; 조종석 `hub_facility` → `openFacilityMenu()`. 셀 ↔ 월드 변환 헬퍼 `roomCellToWorld(room, x, y)`, `worldToRoomCell`.
- 가구 렌더: `interiors/Furniture.ts` — `FurnitureModelKind` 별 절차적 메시 빌더 (작업대 4종은 기존 `Parts.workbench()`/`stations.ts` 스타일에 색 차이, 콘솔·표적 레인·사물함·테이블·선반·상자·램프(emissive)·화분·의자·침상). 설치된 가구 = 콜라이더 블로커(`BoxInteriorCollider` 에 추가/제거 API 필요하면 hub 내부에서 확장) + 상호작용(`interaction !== 'none'`): 작업대 → `ctx.inventory.openBenchCraft(kind, item.level)`, 사격장 콘솔 → `ctx.housing.openPresetMenu()`. 레벨 표시 사인(`Lv.n`).
- **하우징 모드** (`housing:modeChanged {active:true}`): `ctx.player.setControlsEnabled(false)` + `setCameraOverride` 로 방 위 비스듬한 부감(문 쪽에서 방을 내려다봄, 즉시 스냅 아님), 마우스 이동(포인터락 유지, `Input` delta)으로 방 그리드 위 커서 셀 이동 (또는 포인터락 해제 + 레이캐스트 중 하나를 골라 README 에 기록), 선택 가구의 반투명 고스트 (`canPlace` 결과로 초록/빨강), LMB = `place`(선택 있음) 또는 설치된 가구 집기→내려놓기(`move`), R = `rotateSelection`, X = 커서 아래 가구 `recover`, 마우스 휠/`[ ]` = 가구 창고에서 선택 순환 (`selectFurniture`), Esc = `exitHousingMode`. `housing:cursorChanged` emit. 종료 시 카메라/조작 복구. 하우징 모드 중엔 터미널/포드/E 상호작용 비활성.
- `ui/HubMenu.ts`: **임무 시드 섹션 제거** (`parseSeed`/`randomSeed` 는 남겨 `HubSystem` 이 씀), 힌트 문구에 "시드는 개발자 콘솔 `/seed` 로만 설정" 한 줄. `HubSystem` 의 `setMissionSeed`/`currentRoom` 스텁 교체.
- 공유 함선은 변경 없음. 기존 스모크 `smoke-controls-hub` (터미널·창고·임플란트·수리) 와 `hub` README 의 검증 절차가 계속 통과해야 한다 — 조종석에 기존 인터랙터블 id (`hub_terminal`, `hub_workbench`, `hub_implant_bay`, `hub_garden`, `hub_pod_0`) 를 그대로 유지. README 갱신 (파일 표 + 방 좌표 표). 스모크: `smoke-housing` (housing 에이전트) 이 3D 를 포함하므로 hub 에이전트는 `scripts/smoke-ship-rooms.mjs` (개인 함선 진입 → 스폰 → 복도로 걸어가 `currentRoom` 0 → `hub:roomEntered`, `hub_room_0` E → `ui:housingToggled`, `enterHousingMode(0)` 후 카메라 오버라이드·커서 이벤트·`place` 호출로 가구 메시가 씬에 생기는지·콜라이더 push-out, Esc 종료, 시드 섹션이 DOM 에 없음, 기존 인터랙터블 5종 등록) 를 추가하고 `SMOKES` 등록 (`folders: ['hub', 'housing']`).

### 4-c 인벤토리 (`src/inventory/`)
- 스텁 교체: `openCatalog/closeCatalog/isCatalogOpen` — **무한 상자**: 컨테이너 창 자리에 스크롤되는 카탈로그 그리드 (카테고리 탭: 전체/무기/탄약/부착물/가방/방탄복/가젯/소모품/재료/약초), 타일은 `ItemDef` 당 1개(무기는 등급 I~V 각각), 드래그 → 가방/창고/슬롯에 `ctx.loot.createItem(defId, stackMax 또는 1)` 새 인스턴스, 더블클릭 = 가방에 넣기, 타일은 사라지지 않음. 검색 입력(한국어 이름 부분 일치). blocker `'inventory'`, `ui:catalogToggled`.
- `getStashSize/setStashSize` (Stash.ts: 저장 파일에 `cols/rows` 포함, `Grid.resize` — 축소 시 넘치면 false), 시작 시 `ctx.housing?.getStashSize()` 적용, `housing:stashSizeChanged` 구독. Tab 함선 화면의 창고 그리드가 새 크기로 렌더.
- `countDefAll/consumeDefAll` (가방 → 창고 순).
- `captureLoadout/applyLoadout` (계약 주석대로; 임플란트는 `implant:equipped` 흐름 — 현재 Tab 화면이 쓰는 API 로 장착).
- `openBenchCraft(bench, level)`: 기존 `ui/CraftPanel` 을 작업대 모드로 — 제목 `WORKBENCH_LABEL_KO[bench] Lv.n`, `getRecipes('ship', bench, level)` 목록, 재료 비용에 `ctx.housing.getCraftCostMul()` 적용(표시·소모 모두, 올림), 하단에 **수리 목록**(gun: 무기+부착물 소켓 무기, gear: 방탄복+가방 — `repair(uid)`), 레벨 부족 레시피는 잠금 표시.
- `getRecipes(station, bench?, level?)` 스텁을 확정. README 갱신. 스모크: `scripts/smoke-inventory-p6.mjs` (카탈로그 열기/탭/검색/드래그 real-mouse 로 가방에 생성/더블클릭, 창고 resize 30행 후 리로드 유지, countDefAll/consumeDefAll 가방+창고 합산, captureLoadout/applyLoadout 누락 슬롯 비움, openBenchCraft DOM + 수리 목록 + 비용 배율). `SMOKES` 등록 (`folders: ['inventory', 'housing', 'items']`).

### 4-d HUD (`src/ui/`) — 작게
- `hud/ChargeGauge` 재사용 또는 새 `hud/WeaponChargeGauge`: `weapon:chargeChanged` (charge/spinup/slash 별 색), 레티클 옆 원호.
- `hud/WeaponPanel`: `WeaponDef.altFire` 무기에 `좌: … / 우: …` 두 줄 모드 텍스트(유니크 종류별 고정 문구), 탄약 라벨은 `AMMO_LABEL_KO`.
- 전소 표시: `enemy:incinerated` 위치에 짧은 `🔥 전소` 월드 마커(기존 `WorldMarkers`/hitmarker 스타일), `enemy:shocked` 는 스파크 마커.
- `cheat:moveCheat` → 화면 구석 `MOVE CHEAT` 태그, `console:toggled` 동안 HUD 힌트 숨김 필요 없음.
- 하우징 모드 힌트 바 (`.hud.housing`): `housing:modeChanged` 로 표시, 선택 가구 이름/회전, 커서 셀 + 가능/불가, 키 힌트 (`LMB 설치 · R 회전 · X 회수 · 휠 선택 · Esc 종료`).
- 방 진입 라벨: `hub:roomEntered` → 상단 중앙에 `방 n · 용도` 1.5 s 페이드.
- README 갱신. 검증: 위 이벤트를 `ctx.bus.emit` 으로 흉내 내는 짧은 puppeteer 체크 (`scripts/smoke-ui-p6.mjs`, `SMOKES` 등록 `folders: ['ui']`).

## 5. 웨이브 · 에이전트
| 웨이브 | 에이전트 (폴더) | 비고 |
|---|---|---|
| 1 | console · progression · items · enemies+player · housing · hub · inventory · ui | 병렬 8개 |
| 2 | weapons | items 의 유니크 def 가 있어야 테스트 가능 |
| 리드 | `src/shared` 계약(완료), `main.ts` 등록(완료), 통합 검증 `npm run verify:all`, `CLAUDE.md` / `docs/ROADMAP.md` / `docs/VERIFICATION.md` 갱신, 커밋 | |

## 6. 공통 규칙 (모든 에이전트)
1. 시작할 때 `CLAUDE.md` → 이 문서 → 자기 폴더 `README.md` → `src/shared/README.md` 마지막 구역 순으로 읽는다. 계약 파일은 **수정 금지** (필요하면 보고).
2. 다른 폴더의 파일은 수정하지 않는다. 다른 시스템은 `ctx.*Ref` 로만 쓰고, 아직 스텁이면 `typeof fn === 'function'` / 옵셔널 체이닝으로 방어한다.
3. 끝내기 전 `npm run typecheck` 0 오류, 자기 스모크 통과 (`node scripts/<smoke>.mjs`, vite 는 `npm run dev` 가 이미 떠 있으면 재사용, 아니면 직접 띄우고 종료), 자기 폴더 `README.md` 갱신. `scripts/verify.mjs` 의 `SMOKES` 표에 새 스모크 등록 + `scripts/README.md` 한 줄.
4. 스모크 스크립트 규칙: `scripts/smoke-weapons.mjs` 머리 부분(GL_ARGS, 포인터락 스텁, `waitFor` 60 s) 을 복사, 키는 `document.body` 에 keydown+keyup 을 같은 evaluate 안에서 dispatch, 대기는 `ctx.time` 기준 `waitSim`. 콘솔 오류 0 이어야 한다.
5. 한국어 UI 텍스트, 절차적 지오메트리만, 라이트 개수 고정, 핫패스 할당 금지, `game:abort`/`game:newMission` 에서 dispose.
6. 커밋하지 않는다 (리드가 통합 후 커밋). 완료 보고에 **변경 파일 목록·스모크 결과 수치·남은 이슈** 를 적는다.
