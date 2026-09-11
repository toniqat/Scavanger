# src/gadgets — 특수 가젯 (`ctx.gadgets`)

Owner: `GadgetSystem` (`name: 'gadgets'`), publishes `ctx.gadgets` (`GadgetsRef`) and **owns `GADGET_DEFS`**
(`items/` only references gadgets through `ItemDef.gadgetId`). Register it after `InventorySystem` /
`PickupSystem` and before `HudSystem` — it needs `ctx.inventory`, `ctx.loot`, `ctx.enemies` and `ctx.net`
at update time only, so the exact slot is flexible.

```ts
import { GadgetSystem } from '@/gadgets/GadgetSystem';   // ← main.ts registration
engine.addSystem(new GadgetSystem());
```

| File | Purpose |
|---|---|
| `GadgetSystem.ts` | The system + `GadgetsRef` impl. Use paths, host-authoritative deployable lifecycle, `gad`/`gadq` protocol, recover/defuse `Interactable`s, turret / mine / fire / lure simulation, jump pad launches, query API. |
| `model.ts` | 폴더 공용 어휘 — `GadgetSystem` 에서 떼어낸 상수 · 타입 · 스크래치. 클래스를 참조하지 않으므로 `parts/*` 가 순환 import 없이 쓴다. `GadgetSystem.ts` 가 재수출하므로 기존 import 경로는 그대로다 |
| `parts/Deploy.ts` | **가젯을 놓고 회수하기**. 배치물은 **호스트 권한**이다: 클라이언트는 `gadq` 로 요청하고 호스트가 `gad` 로 확정한다. 설치 위치 판정, 회수 / 해체 홀드, 되돌려주는 아이템까지가 이 파일의 범위다. |
| `parts/Simulate.ts` | **배치물이 매 프레임 하는 일**. 지뢰 · 포탑 · 화염지대 · 유인탄 · 점프대의 동작. 화염지대는 **피아를 구분하지 않고**(설계대로) 자기 주인에게 킬 크레딧을 준다. 점프대는 같은 사람을 `JUMP_PAD_RETRIGGER_S` 안에 다시 쏘지 않는다. |
| `parts/Queries.ts` | **다른 폴더가 배치물에게 묻는 것**. 적 AI(`findEnemyTarget` / `findDistraction` / `visionFactor`), 무기(`blocksProjectile` — 돔 실드와 바리케이드가 탄을 멈춘다), 플레이어(`fireDamageAt` / `jumpPadAt`). 전부 **순수 질의**이고 상태를 바꾸지 않는다. |
| `parts/Wire.ts` | **`gad` / `gadq` / `buff` 네트워크 경로**. 호스트가 배치물 목록의 진실이고, 늦게 합류한 클라이언트와 호스트 이관 뒤에는 전체를 다시 보낸다. |
| `parts/Remote.ts` | **원격 지뢰(C4)는 언제 · 어떻게 터지는가** (2026-09-11). `detonateRemoteMines` / `liveRemoteMineCount`, 호스트의 `gadq detonate` 처리, **중첩 피해**(대상마다 가장 센 한 발 100 % + 나머지 각각 `GADGET_REMOTE_MINE_STACK_MUL`, 합산 1회 적용), 소유자당 상한 `GADGET_REMOTE_MINE_MAX_LIVE`, 설치음 · 무장 중 삑. 근접으로는 절대 안 터진다. |
| `parts/Preview.ts` | **손에 든 설치형 가젯을 지금 놓으면 어디에 서고, 설 수 있나** (2026-09-11). 판정은 `computePlacement` **하나** — 매 프레임 미리보기(고스트 + `GadgetsRef.placement` + 바뀔 때만 `gadget:placementChanged`)와 좌클릭 설치(`use()` 가 그 순간 다시 돌린다)가 같은 함수를 쓴다. 조준 광선(`getAimRay`)을 발 수평 `GADGET_PLACE_RANGE` 원에서 끊고, 드론 몸체(`ctx.drones.raycast`)가 더 가까우면 드론 위. 사유: 맵 밖 · 움직이는 발판 `설치할 수 없는 곳이다` / 위아래 `PLACE_VERTICAL_REACH` 초과 `너무 멀다` / 법선 `바닥이 너무 기울었다` / 대형 발자국 샘플 높이차 `바닥이 고르지 않다` / 발자국 원 vs 장애물(원기둥 · OBB · 볼록 윤곽, 밟은 바닥과 머리 위 슬래브 제외) `공간이 부족하다` / `PLACE_CLEARANCE` `다른 설치물과 겹친다` / 대형을 드론에 `드론 위에는 올릴 수 없다` / `이미 드론에 설치물이 있다`. 호스트의 `gadq place` 재검증 `resolveRemotePlace`. |
| `parts/Mount.ts` | **드론 위 설치물은 언제까지, 어떻게 드론을 따라가나** (2026-09-11). `Deployable.mount` 가 있으면 매 프레임 `getMountPoint` 로 옮긴다(각자 로컬 — 드론 복제본이 이미 있다). 드론이 사라지면 아래 표면으로 떨어져 바닥 설치물로 남는다 — 아래 `드론 탑재` 절. |
| `GadgetDefs.ts` | `GADGET_DEFS` (10 gadgets, 한국어 이름/설명), `gadgetDef(id)`, `gadgetForKind(kind)`, `RECOVERABLE_KINDS` / `isRecoverable`, `ENEMY_TARGET_KINDS`, `SOLID_KINDS`. |
| `Deployable.ts` | `Deployable implements DeployableRef` — hp/armed/expires/yaw + per-kind runtime state (`fireTimer`, `targetId`, `headYaw`, `tickTimer`, `padCooldown` = 같은 프레임 가드, `padNext` = 플레이어별 재발동 시각(Phase 9), `netCooldown`) and `takeDamage()` (routes to the authority). Also the physical sizes: `BARRICADE_HALF`, `MINE_TRIGGER_RADIUS`, `JUMPPAD_TRIGGER_RADIUS`, `DOME_UNFOLD_TIME`. |
| `GadgetVisuals.ts` | `GadgetVisualPool`: pooled procedural meshes per `DeployableKind` + a 12-slot expanding ring-pulse FX pool. Shared geometry, per-visual materials, recoloured on reuse. **No lights anywhere** (constant scene light count → no shader recompiles). `warm()` pre-builds one visual per kind. |
| `ThrownGadget.ts` | `ThrownGadgetManager`: 8 pooled canisters with a gravity arc + obstacle push-out; deploys on the first ground contact (or after 4 s). **2026-09-11**: 창문 유리를 깨고 지나가고(`shared/fragile`), 땅 = `getSurfaceY`(건물 2층 · 옥상). 설치물의 배치 높이는 아직 지형이다. |
| `index.ts` | Barrel. |

## 10종 가젯

| id | 이름 | use | deployable | 동작 |
|---|---|---|---|---|
| `cloakVeil` | 은폐 장막 | self | — | `player.setCloak(12, 'gadget')` + 링 펄스 FX |
| `domeShield` | 돔 실드 | throw | `domeShield` | 착탄점에 반경 5 m 돔 (hp 1000). 0.6 초 전개 후 **적 발사체만** 차단 |
| `barricade` | 바리케이드 | place | `barricade` | 조준점(발에서 `GADGET_PLACE_RANGE` 안, 설치 미리보기)에 4.2×1.9 m 벽 (hp 1800). 피아 구분 없이 탄을 막고, 3 초 상호작용으로 회수 |
| `lureGrenade` | 유인 수류탄 | throw | `lure` | 0.5 초마다 `enemies.addDistraction(pos, 40 m, weight 0.85)`. 12 초 |
| `smokeGrenade` | 연막탄 | throw | `smoke` | 16 초 연막. `visionFactor` 로 적 탐지거리를 최대 ×0.08 까지 깎는다 |
| `mine` | 지뢰 | place | `mine` | 3 초 후 무장, 1.5 m 안에 **적·아군 누구든** 들어오면 반경 6.5 m / 220 피해 폭발. 3 초 해체(아이템 반환 없음). **드론 위에 올리면(`mount`) 적만** `GADGET_MOUNTED_MINE_TRIGGER_RADIUS`(3D, 탑재점 기준) 안에서 터진다. 폭발은 `ctx.drones.applyExplosion` 도 부른다 |
| `remoteMine` | 원격 지뢰 (C4) | place | `remoteMine` | `GADGET_REMOTE_MINE_ARM_TIME` 뒤 무장(`c4_arm`, 무장 중 드문 `c4_beep`). **근접으로는 절대 안 터진다** — 소유자가 손에 들고 우클릭(`detonateRemoteMines`)해야 내 무장된 것 전부가 터진다. 중첩 피해 = 대상마다 가장 센 한 발 + 나머지 각각 × `GADGET_REMOTE_MINE_STACK_MUL`. hp `GADGET_REMOTE_MINE_HP` 가 다 닳으면 **불발**로 사라진다. 소유자당 `GADGET_REMOTE_MINE_MAX_LIVE` 개(넘으면 가장 오래된 것부터 `expired`). **3 초 회수 = 아이템 반환**(`RECOVERABLE_KINDS`, 누구나) — 바닥 지뢰의 해체와 달리 밟아도 안 터지는 소유자 도구라서 |
| `turret` | 포탑 설치 | place | `turret` | 90 초, hp 600, 사거리 32 m, 4 발/초 × 15 피해. **사선의 플레이어를 먼저 맞힌다**. 3 초 회수 |
| `incendiary` | 화염수류탄 | throw | `fire` | 10 초 화염지대. 적은 `applyStatus('burning', 45)`, 플레이어는 `setBurning` / 원격은 `dmg` |
| `defib` | 제세동기 | target | — | 5 m 안의 **다운된 원격 아군**에게 `buff {kind:'revive'}` 전송 |
| `jumpPad` | 점프대 | place | `jumpPad` | 밟으면 +13 임펄스, 질주 중이면 진행 방향으로 +9 추가. 3 초 회수. **재발동은 플레이어별** (`Deployable.padNext: Map<PeerId\|'local', number>`, `JUMP_PAD_RETRIGGER_S`) — Phase 9 이전의 0.7 초 공용 쿨다운은 착지할 때마다 다시 튀어 2.5 초에 3연발이 나왔다. `padCooldown` 은 이제 같은 프레임 중복 발사만 막는다 |

수치는 전부 `shared/constants.ts` 의 `GADGET_*` 상수를 그대로 쓴다 (이 폴더에서 재정의하지 않는다).

## 다른 폴더가 쓰는 계약 (`GadgetsRef`)

```ts
ctx.gadgets?.use(id, underhand?)                       // 인벤토리 빠른 사용 바 / UI
ctx.gadgets?.blocksProjectile(from, to, fromEnemy)     // weapons: 탄 차단 (막힌 지점 or null)
ctx.gadgets?.visionFactor(from, to)                    // enemies: 탐지거리 배율 0..1 (연막)
ctx.gadgets?.findEnemyTarget(pos, radius)              // enemies: 부술 설치물 (바리케이드/포탑/유인/돔)
ctx.gadgets?.findDistraction(pos, radius)              // enemies: 유인 지점
ctx.gadgets?.fireDamageAt(pos)                         // 화염지대 dps (0 = 없음)
ctx.gadgets?.jumpPadAt(pos)                            // 점프대 (player 가 직접 발사해도 된다)
ctx.gadgets?.getDeployables()                          // DeployableRef[] — `takeDamage(amount, from?)` 로 파괴
ctx.gadgets?.recover(id)                               // 회수 (호스트/싱글은 즉시 아이템, 클라는 요청)
```

- `blocksProjectile(from, to, false)` (아군 탄) → **바리케이드만** 막는다. 돔 실드는 `fromEnemy === true` 일 때만
  막고, 돔 **안에서** 쏘는 탄은 그대로 나간다.
- `DeployableRef.takeDamage()` 는 근접 공격·총탄·폭발 어디서 불러도 안전하다. 비호스트에서 호출하면 로컬에는
  적용하지 않고 `gadq damage` 요청만 보내고, 호스트가 `gad update` / `gad remove` 로 결과를 방송한다.
- 지뢰 인디케이터는 `gadget:deployed {id, kind:'mine', position, owner}` 를 UI 가 받아서 그린다
  (모든 클라이언트에서 replica 스폰 시에도 emit 된다).

## 이벤트

| 이벤트 | 언제 |
|---|---|
| `gadget:used {id, position}` | `use()` 가 아이템을 소모하고 성공했을 때 |
| `gadget:deployed {id, kind, position, owner}` | 설치물이 월드에 생겼을 때 (복제 스폰 포함). `position` 은 살아있는 Vector3 |
| `gadget:damaged {id, hp, maxHp}` | 호스트가 피해를 적용했을 때 / 클라가 `gad update` 를 받았을 때 |
| `gadget:removed {id, kind, reason}` | 파괴·회수·만료·`clear()` — 모든 제거에서 발생 |
| `gadget:recovered {id, item}` | 회수 아이템이 실제로 가방에 들어갔을 때 |
| `gadget:throwModeChanged {underhand}` | `B` (`KEY_THROW_MODE`) 토글 |

부수적으로 `ui:notify`, `camera:shake`, `chat:post`(제세동기), `audio:play` 를 emit 한다.
오디오 id: `gadget_deploy`, `gadget_cloak`, `gadget_defib`, `gadget_recover`, `gadget_break`, `mine_place`,
`mine_arm`, `turret_fire`, `lure_beep`, `jumppad`, `shield_hit`, `explosion`, `grenade_throw`, `ui_click`, `ui_deny`.

## 호스트 권위 프로토콜 (`shared/net.ts`: `GadgetMessage` 호스트→클라, `GadgetRequest` 클라→호스트)

id 는 `${peerId | 'sp'}-g${n}`. 호스트가 만든 것은 호스트 id, 클라 요청은 호스트가 `${from}-g${n}` 로 새로 부여한다
(픽업과 달리 클라가 id 를 제안하지 않는다 — 낙관적 스폰이 없기 때문).

```
싱글 / 호스트                              클라이언트
──────────────                            ─────────────
use() → spawnDeployable                   use() → gadq place {gadget,p,yaw} ─► host
      → gad spawn ────────────► others            host: spawnDeployable → gad spawn ─► others

takeDamage()                              takeDamage()
  hp 감소 → gadget:damaged                  → gadq damage {id,dmg} ─► host   (로컬 hp 변화 없음)
  → gad update (0.2 s 스로틀)                 host: 적용 → gad update / gad remove
  hp 0 → 폭발/파괴 → gad remove

recover(id) → 아이템 지급 + gad remove      recover(id) → gadq recover {id} ─► host
                                                  host: gad remove {reason:'recovered'} ─► others
                                                  요청자: pendingRecover 에 있으면 그때 아이템 지급

포탑 발사 → gad fire {id, target}          gad fire → 헤드 조준 + 머즐 플래시 + 사격음
지뢰 폭발 → gad remove {destroyed}         gad remove {destroyed} → 폭발 FX (피해는 host 의 dmg 로 따로 온다)

재접속 / 늦게 합류
──────────────────
client world:ready (멀티, !host) → gadq sync ─► host → gad sync {items} ─► 그 피어 (전부 재구축)
host 는 `flow rejoined` 에도 gad sync 로 답한다
호스트 이전 (Phase 9): net:hostChanged {isLocalHost:false} + ctx.world.ready → gadq sync 재요청
  (승격된 호스트가 우리가 못 본 설치물이나 다른 hp 를 들고 있을 수 있다)
```

- **시뮬레이션은 `ctx.isAuthority` 뿐**이다. 비호스트는 무장 타이머(지뢰 3 초 / 돔 0.6 초)만 로컬로 돌려
  시각을 매끄럽게 하고, 값은 호스트의 `gad update` 가 덮어쓴다.
- 원격 플레이어 피해는 `ctx.net.send({t:'dmg', amount, from}, peerId)` 로 보낸다 (지뢰 폭발, 포탑 오사, 화염지대).
- **화염지대의 로컬 플레이어 화상은 각 클라이언트가 스스로 적용**한다 (`setBurning`). 존은 이미 복제돼 있으므로
  왕복 지연 없이 반응하고, 원격 플레이어분만 호스트가 `dmg` 로 처리한다.
- `buff` 수신은 **`kind === 'revive'` 만** 처리한다 (`heal` / `boost` 는 implants 소유 — 이중 적용 방지).
  Phase 9 에서 implants 쪽에 남아 있던 `revive` 중복 분기를 지웠으므로, 제세동기 부활은 이제 정확히 한 번만 적용된다.
- **화염지대 킬 크레딧 (Phase 9)**: `updateFireZone` 이 `enemies.applyStatus(id, 'burning', dps, dur, d.owner)` 로
  불을 놓은 사람을 넘긴다 → 화상으로 죽은 적의 `enemy:killed.by` 가 마지막 타격자가 아니라 설치자를 가리킨다.

## 성능 / 리소스 규칙

- 라이트 0개. 발광은 전부 emissive / additive 머티리얼과 풀링된 링 펄스.
- 지오메트리는 kind 별 공유, 머티리얼은 visual 별(펄스가 독립적이어야 해서) — 재사용 시 색만 바꾼다.
- 매 프레임 `THREE.Vector3` 할당 없음. 모듈 스크래치를 쓰되 **용도별로 분리**했다:
  `_a.._fwd`(범용) / `_r0.._r4`(`playerAlongRay` 전용) / `_g0.._g2`(순수 기하 헬퍼 전용).
  `playerAlongRay` 는 호출자가 `_a` / `_b` 를 인자로 넘기므로 같은 스크래치를 쓰면 광선이 깨진다 (실제로 잡은 버그).
- 동시 설치물 상한 `MAX_DEPLOYABLES = 40` (넘으면 가장 오래된 것부터 제거), 투척체 8개 풀.
- `game:newMission` / `game:abort` / `hub:entered` / `world:ready` 에서 `clear()`, `dispose()` 에서 모든
  geometry/material 을 dispose 한다.

## 방어적 코딩 (병렬 개발)

다른 폴더의 새 API 는 아직 없을 수 있어 전부 옵셔널 체이닝 + `typeof … === 'function'` 로 감쌌다:
`enemies.queryNear/addDistraction/applyStatus/applyAreaDamage` (없으면 `getEnemies()` 스캔 / `applyExplosion` 폴백),
`player.setCloak/setBurning/applyImpulse/revive/isDowned`, `inventory.consumeDef` (없으면 `consumeWhere` 폴백),
`progression.derived.{useSpeedMul, interactSpeedMul, throwRangeMul}` (없으면 1).
`items/` 가 아직 가젯 아이템을 만들지 않았다면 (`ItemDef.gadgetId` 매칭 실패) 소모 없이 사용을 허용한다 —
아이템이 붙는 순간 자동으로 소모 경로로 전환된다.

## 검증

`npx tsc --noEmit | grep "^src/gadgets"` → 0건.

헤드리스 로직 테스트 (esbuild 번들 → node, WebGL/DOM 없이 스텁 컨텍스트로 `GadgetSystem` 을 직접 구동) **72/72**:
정의 10종, `ctx.gadgets` 게시, 바리케이드 설치(정면 2.8 m·회수 Interactable holdTime 3 s)·`blocksProjectile`
(적/아군 모두 차단, 빈 공간 통과), 돔 실드 투척→전개→적 탄 차단·아군 탄 통과·내부에서 밖으로 사격 가능,
지뢰 3 초 무장→접촉 폭발→`applyAreaDamage` 220·적 피해, 포탑 자동 사격·**사선의 플레이어 오사**,
회수(아이템 가방 추가 + `gadget:recovered` + Interactable 해제), 연막 `visionFactor` 0.08 / 청천 1.0,
화염지대 `fireDamageAt` 45 dps·적 `burning` 상태·로컬 `setBurning`, 유인 `addDistraction`·`findDistraction`·
`findEnemyTarget`, 점프대 임펄스 13·재발동 쿨다운·질주 시 전방 도약, 은폐 장막 12 초, 다운된 아군 없을 때
제세동기 거부, `B` 오버/언더 토글, 피해→파괴→`gadget:removed{destroyed}`, `clear()`,
멀티 클라(`gadq place/recover/damage` 전송·로컬 미적용·`gad spawn/update/remove` 복제·회수 에코로 아이템 지급),
멀티 호스트(`gadq place` 스폰 + `gad spawn` 방송, `gadq sync` / `flow rejoined` → `gad sync`),
`buff revive` 적용 / `buff heal` 무시, `dispose()`.

브라우저 실제 플레이 검증은 아직 못 했다 (동시 작업 중인 다른 폴더 때문에 전체 빌드가 아직 통과하지 않는다).
특히 시각(돔/연막/화염 셰이딩, 포탑 실루엣)과 지형 경사에서의 설치 판정은 실기 확인이 필요하다.


## 설치 미리보기 · 드론 탑재 (2026-09-11)

- **판정은 하나다** (`parts/Preview.computePlacement`). 미리보기가 초록이면 좌클릭이 그 자리에 세우고, 빨강이면
  같은 사유로 거부된다. 대형(바리케이드 · 점프대 · 포탑)은 `GADGET_PLACE_LARGE_*`(법선 · 발자국 높이차)와 발자국
  공간을 보고 드론 위에 못 올린다. 소형(지뢰 · 원격 지뢰)은 `GADGET_PLACE_SMALL_MIN_NORMAL_Y` 만 보고 **드론 하나에
  하나** 올릴 수 있다. yaw = 플레이어 yaw. 움직이는 발판(`Obstacle.velocity` — 전차 데크)에는 세우지 않는다.
- **드론 탑재** (`parts/Mount`): `Deployable.mount` 동안 위치 = `DroneRef.getMountPoint` (각자 로컬). 드론이
  사라지면 아래 표면으로 떨어져 바닥 설치물로 남고, 호스트가 같은 id 의 `gad spawn` 을 재방송해 착지 자리를 맞춘다
  (받는 쪽은 이미 있는 id 면 상태만 덮어쓴다). 드론 위 지뢰의 적 전용 감지는 `Simulate`/`Remote` 쪽이다.

## 드론 (`drones/`, 2026-09-11)

| 파일 | 역할 |
|---|---|
| `drones/AirDrone.ts` | **공중 드론 몸체** (`DroneBody`). `position` = 몸체 중심, `radius` 0.5 · `height` 0.26 (모델 실측). **호버 비행** — 입력 방향 × `DRONE_AIR_SPEED` 지수 가감속, `vertical` × `DRONE_AIR_CLIMB_SPEED`, `input === null` 이면 제자리에 멈춰 떠 있다(흔들림은 `animate` 의 시각 오프셋이라 와이어가 떨리지 않는다). yaw 는 `drones/model.ts` 의 드론 규약(코 = 로컬 +Z, 앞 = `(sin, cos)`, 오른쪽 = `(−cos, sin)`)이고 조종 중 입력 yaw 를 그대로 받는다 — 부드럽게 따라가는 것은 보이는 몸체뿐. **고도** = `getSurfaceY(몸 밑 + 0.25 − PROP_STEP_UP_MAX)` 위 여유 0.25 ~ `DRONE_AIR_MAX_ALTITUDE`(넘으면 서서히 내린다), 진행 방향 앞 지형도 본다. **충돌은 `resolveCollision` 을 쓰지 않는다**(걷는 몸 기준 머리 위 2.1 m 가 천장 밑 드론을 순간이동시킨다) — `getObstaclesNear` 캐시(1 m · 0.3 s)에 대해 원기둥(`shotRadius`) · `box`(+`ramp`) · `hull` 을 옆 · 윗면 · (떠 있는 상자만) 아래 중 가장 얕은 쪽으로 빼낸다. 0.2 m 서브스텝 + 긴 프레임은 `world.raycast` 가드, 맵 경계는 축별 되돌림. 모델: 몸통 · X 암 · 모터 · 프롭 가드 · 로터(블레이드는 22 rad/s 까지만 돌고 그 위는 블러 원판) · 짐벌 카메라 · 항법 LED(빨강 왼쪽 / 초록 오른쪽, 두 번 번쩍) · 상태 LED(대기 파랑 · 조종 청록 · `LINK_LOST` 호박 점멸) · 탑재판. **광원 없음**, 지오메트리 · 공용 머티리얼은 모듈 캐시, 인스턴스 머티리얼 4개(블러 · LED 3)만 `dispose`. `getMountPoint` = 탑재판 윗면(기울기 · 흔들림 포함), `raycast` = 납작한 타원체(원점이 안이면 −1), `setOwnerView` 는 짐벌 · 요크 · 기수 센서 · 다리를 숨긴다. 소리는 `drone_rotor` 만 — 소유자 `simulate` 에서 조종 중이거나 움직일 때 0.55 → 0.3 s 간격. |

### 드론 코어 (`DroneSystem`, `ctx.drones`)

`main.ts` 에서 `GadgetSystem` 바로 뒤 — `PlayerSystem` · `WeaponSystem` 뒤라서 R 을 읽는 순서와, `update` 에서 건
`setCameraOverride` 가 같은 프레임 `PlayerSystem.lateUpdate`(카메라 리그)에 들어가는 순서가 맞다.

| 파일 | 역할 |
|---|---|
| `drones/DroneSystem.ts` | 상태 + `DronesRef` 한 줄 위임. 이벤트 구독(리셋 · `player:damaged/downed/died` · `net:remotePlayerRemoved`)과 매 프레임 순서: 조종 입력 → 드론마다 (소유자 시뮬레이션 / 복제본 보간) → 사거리 → `animate` → 소리 → 소음(권한) → `state` 송신 → 강제 끊김 · 카메라 · 지지직. |
| `drones/model.ts` | 공용 어휘 — `DroneBody` / `DroneInput`(계약 단계 모양 그대로), **yaw 규약**(코 = 모델 +Z, forward `(sin, cos)`, right `(−cos, sin)`, pitch + = 위, PC 방향으로 꺼내려면 `droneYawFromPlayer` = `+π`), `Drone implements DroneRef`(소유자 = 늘 `'local'`, 복제본 = PeerId · 보간 버퍼 · 소음/네트 타이머 · 회수 `Interactable`), 종류별 사거리 · 체력 · 이름, 조작감/오디오 박자 보조값, 스크래치. |
| `drones/GroundDrone.ts` | **지상 드론 몸체**. 4륜 로버(차체 · 바퀴 · 센서 헤드 렌즈 · 안테나 · emissive LED · 탑재판, 광원 없음, 인스턴스별 지오메트리 · 머티리얼을 `dispose`). 물리: 걷기 `PLAYER_WALK_SPEED × DRONE_GROUND_WALK_MUL` · 질주 `PLAYER_SPRINT_SPEED × DRONE_GROUND_SPRINT_MUL` · 가감속 · 제동, 점프 `sqrt(2·GRAVITY·DRONE_GROUND_JUMP_HEIGHT)`, 천장 레이, **표면을 먼저 잡고**(`getSurfaceY(x,z,feetY)` — 낮은 턱은 오른다) `resolveCollision(radius)`, `SNAP_DOWN` 접지. `sprinting` = 질주 입력 + 실제 이동. 소리: 소유자 쪽 `drone_jump` · `drone_land`(위치), 조종자 전용 `drone_move`(위치 없음 · 아주 작게 — "걷기는 소리가 안 난다"). 렌즈 카메라(몸체 반경 안쪽 0.2 m), `raycast` = 해석적 구, `setOwnerView` = 센서 헤드 숨김. |
| `drones/parts/Control.ts` | **누가 언제 드론 시점으로 들어가고 나오는가.** R 홀드(`DRONE_CONTROL_HOLD_S`, 이번 누름에서만 시작 · R `consume`) → `controlHold`, 조종 시작(`setDroneControl(true)` 뒤 `player.droneControl` 이 false 면 거절) · 복귀(`setCameraOverride(null, undefined, true)` = 즉시 컷), 조종 입력 → `DroneInput`(마우스 = 리그와 같은 감도 0.0022, WASD · Shift · Space(점프 `wasPressed` / 상승 `isDown`) · C), 매 프레임 카메라, `linkRatio`(소유자 PC ↔ 드론 3D ÷ 사거리 — 복제본은 소유자 원격 위치 + `LINK_LOST`), ≥ `DRONE_LINK_WARN_RATIO` 동안 `drone_static`, ≥ 1 이면 `releaseControl('range')`. |
| `drones/parts/Lifecycle.ts` | **드론이 생기고, 움직이고, 맞고, 사라지는 것.** `deploy`(게임플레이 · 레이드 · 생존 · 사다리 아님 · 종류당 1대, 지상 = 정면 1.25 m 표면(벽이 가까우면 그 앞), 공중 = 눈 앞 1.4 m 위 0.8 m(천장 아래)), 소유자 시뮬레이션 · 질주 소음 기억, 질주음 `drone_sprint`(위치 · 소유자와 복제본 모두) · 복제본 점프/착지음, **권한만** `world:noise`, `damageDrone`(비소유자 → `droneq damage`) · 파괴(파티클 풀 폭발 · `drone_destroyed` · **그때 소유자 `consumeWhere(gadgetId)` 1개 — 퀵슬롯 포함**) · `applyExplosion`(선형 감쇠), E 홀드 회수 `drone:<id>`(무소모, 조종 중 불가), `raycast`(모든 몸체, kind 필터), `clear`. |
| `drones/parts/Wire.ts` | **소유자 권한 동기화.** `drone spawn/state/remove/sync` · `droneq damage/sync`, 복제본 보간(지금 그려진 자세 → 새 샘플을 샘플 간격 동안, 8 m 넘게 뛰면 순간이동), 모르는 드론의 `state` 는 그 소유자에게 `droneq sync` (2 초에 한 번). |

**계약 요약** (`shared/drones.ts`)

- 아이템은 꺼낼 때 **소모되지 않는다**(`gadgets/parts/Deploy.use` 가 `deploy(kind)` 로 넘긴다) — 파괴될 때 하나. 회수는 무소모.
- 조종 끊김 이유: `manual`(R 홀드) · `damage`(로컬 `player:damaged`) · `range` · `destroyed` · `reset`(전투불능 · 사망 ·
  `game:abort/newMission` · `hub:entered` · `world:ready` · 페이즈 이탈 · 플레이어가 `droneControl` 을 스스로 풀었을 때).
  이유마다 `drone:controlChanged {id:null, kind:null, reason}` 하나 + `drone_link_off`.
- `DroneRef.aggroable`: 지상 = 최근 `DRONE_NOISE_MEMORY_S` 안에 질주(복제본은 `NOISY`), 공중 = 늘 true.
- `DroneRef.mountedDeployableId` 는 **getter** 다 — `ctx.gadgets.getDeployables()` 중 `mount === id` 를 찾는다(대입하지 않는다).
- `raycast` 가 돌려주는 `DroneRayHit` 객체는 **다음 호출에서 재사용**된다 (할당 없음). `point` 는 몸체 표면이다.
- `applyExplosion` 은 **피해를 소유한 쪽에서 한 번만** 부른다 (권한의 적 · 설치물 폭발, 던진 사람의 수류탄) — 비소유 드론은
  자동으로 `droneq damage` 가 된다.

**네트워크 규약 (소유자 권한)**

```
소유자                                         남 (호스트 포함)
deploy → drone spawn {d} ─────► others        spawnReplica (+ drone_deploy)
매 1/DRONE_NET_HZ (피해 · 조종 전환은 즉시)
      → drone state {id,p,yaw,hp,fl} ─► others 보간 · hp 변화 → drone:damaged{own:false} + drone_hit
파괴 / 회수 / clear → drone remove ─► others   destroyed = 폭발 FX, recovered = drone_recover, 제거

damageDrone(비소유) → droneq damage {id,dmg} ─► 소유자 → applyOwnDamage (clamp 0..maxHp)

늦게 합류: world:ready → clear → droneq sync ─► others;  각 소유자 → drone sync {items} ─► 그 피어 (그 소유자 몫 전부 교체)
net:remotePlayerRemoved {id} → 그 소유자 드론 제거 (방송 없음)
```

- 복제본은 레이드 월드가 서 있을 때만 받는다 (`world.ready && isRaidActive`). 그 전 것은 `world:ready` 의 sync 가 채운다.
- `fl` = `DroneFlags` — CONTROLLED · SPRINTING · AIRBORNE · LINK_LOST · NOISY. 호스트는 복제본의 NOISY 로 소음을 낸다.
- `clear()` 는 내 드론의 `remove` 를 방송한다 — 먼저 탈출한 사람의 드론이 남은 분대원 화면에 남지 않게.

## 파일 분할 규약 (`model.ts` + `parts/`, 2026-09-08)

`GadgetSystem.ts` 는 한 파일에 다 있기에는 너무 커져서 **동작을 바꾸지 않고** 갈랐다. 규칙은 세 줄이다.

1. **`model.ts`** — 폴더 공용 어휘(타입 · 상수 · 스크래치 객체, 상태 없는 보조 클래스).
   `GadgetSystem.ts` 이 `export * from './model'` 로 재수출하므로 **기존 import 경로는 전부 그대로 동작한다.**
2. **`parts/*.ts`** — 클래스에서 떼어낸 메서드 묶음. 각 함수는 인스턴스를 첫 인자 `sys` 로 받는다:
   ```ts
   export function foo(sys: GadgetSystem, …) { … }   // 예전의 this → sys
   ```
   클래스에는 같은 이름의 **한 줄 위임 메서드**가 남아 있으므로 호출부는 하나도 바뀌지 않았다.
3. `parts/` 가 닿는 클래스 멤버는 `private` 이 벗겨져 있다. **폴더 밖에서 쓰라는 뜻이 아니다** —
   외부와의 계약은 `@/shared` 의 `*Ref` 인터페이스가 전부다.

새 `parts/` 파일은 맨 위 doc 주석에 **그 파일이 답하는 질문 한 줄**을 적고 위 표에 행을 추가한다.
순환 import 를 만들지 않으려면 `parts/` 는 `GadgetSystem.ts` 에서 **타입만** 가져와야 한다 — 값은 `model.ts` 로.

---

## 변경 이력

- **2026-09-11 (드론 코어 · 지상 드론)** — `drones/DroneSystem.ts` 스텁을 채우고 `drones/parts/Control.ts` ·
  `Lifecycle.ts` · `Wire.ts` 로 갈랐다. 꺼내기(무소모 · 종류당 1대) · R 홀드 조종/복귀 · 드론 카메라(`update` 에서
  `setCameraOverride(…, true)`, 복귀는 `null + snap` 즉시 컷 · `droneControl` 이 풀리면 `reset`) · 사거리 끊김/지지직 ·
  PC 피해로 끊김 · 파괴 시 소유자 가방/퀵슬롯에서 아이템 1개 · E 홀드 회수 · 권한 클라이언트의 `world:noise` ·
  소유자 권한 `drone`/`droneq` 동기화 + 보간 복제본 · 늦게 합류 sync. `drones/GroundDrone.ts` 지상 로버 몸체(절차 모델 ·
  물리 · 렌즈 카메라 · 해석적 광선). `model.ts` 는 **추가만**: yaw 규약 · `Drone implements DroneRef` · 보조값 · 스크래치.
  조작감 값 몇 개를 `model.ts` 에 `TODO(csv)` 로 뒀다 — 꺼내는 거리(1.25 / 1.4 m · 공중 +0.8 m), 지상 가속 18 · 제동 24 ·
  공중 가속 3 m/s², 공중 드론 회수 반경 +1.5 m.
- **2026-09-11 (공중 드론 몸체)** — `drones/AirDrone.ts` 스텁을 채웠다: 호버 비행(입력 없으면 제자리) · 발밑 표면 기준
  고도 여유/상한 · `resolveCollision` 대신 3D 밀어내기(원기둥 · `box`/`ramp` · `hull`, 천장 밑 비행 가능) · 서브스텝 +
  `raycast` 가드 · 절차 쿼드콥터(광원 없음) · 짐벌 렌즈 자세 · 탑재판 · 타원체 광선 판정 · `drone_rotor` 박자.
  yaw 는 `model.ts` 규약(코 = +Z). 조작감 후보 `DRONE_AIR_ACCEL` · `DRONE_AIR_MIN_CLEARANCE` 는 `TODO(csv)`.
- **2026-09-11** — `ThrownGadget` 이 창문 유리를 깨고 건물 바닥판에 떨어진다 (world 의 창문 · 2층 건물).
- **2026-09-11 (원격 지뢰 · 드론 위 지뢰)** — 새 `parts/Remote.ts`: C4 기폭(`detonateRemoteMines` — 호스트/싱글은 바로,
  클라는 `gadq detonate`, 호스트는 relay `from` 소유의 **무장된** 것만) · `liveRemoteMineCount` · 소유자당 상한 ·
  설치음(`c4_place`, 첫 프레임 `Remote.initRemoteMine` — `gad sync` 로 받은 이미 무장된 것은 조용) · 무장 중 삑.
  **중첩 피해**는 대상(적 · 로컬/원격 플레이어 · 드론 · 다른 설치물)마다 C4 별 선형 감쇠 피해를 모아 `최대 + (합 − 최대) ×
  STACK_MUL` 을 **한 번** 적용한다 — 드론은 `damageDrone(합산)` 이고 `applyExplosion` 은 부르지 않는다(이중 적용).
  FX · 흔들림 · `explosion` 은 C4 마다. 적 킬 크레딧은 `Enemy.takeDamage` 의 4번째 인자(공격자)로 넘긴다 —
  `EnemyRef` 계약에는 없는 인자라 모르는 구현은 무시한다. **부서진 C4 는 불발**: 호스트가 `gad update {hp:0}` 을
  제거 직전에 보내고, 클라의 `gad remove {destroyed}` 는 hp 로 불발(작은 파편)과 기폭(전체 폭발)을 가른다.
  C4 는 회수 가능(`RECOVERABLE_KINDS`, 아이템 반환). 드론 위 `mine`(`mount`)은 **적만** 감지. 바닥 지뢰 폭발이
  `ctx.drones.applyExplosion` 을 부르고, 킬 크레딧을 로비 표시 이름이 아니라 **소유자 id** 로 넘긴다(화염지대와 같다 —
  예전 이름 전달은 `normalizeAttacker` 가 풀지 못했다). `GadgetVisuals` 에 C4 모델(벽돌 · 테이프 · 수신기 · 안테나 ·
  LED — 무장 전 호박색 호흡, 무장 후 빨강 깜빡임, 광원 없음).
- **2026-09-11 (설치 미리보기 · 드론 탑재)** — 새 `parts/Preview.ts` · `parts/Mount.ts`. 설치형 가젯의 **정면 2.8 m 고정
  자리(`placementSpot`)를 걷어내고** 조준점 판정 `computePlacement` 하나로 바꿨다 — 매 프레임 미리보기와 좌클릭 설치가
  같은 함수를 돌린다(`use()` 는 설치 순간 `placeUse` 스크래치로 다시 돌리고, invalid 면 그 사유로 `deny`). `placementSpot`
  은 그 판정의 얇은 포장으로만 남았다. `GadgetsRef.placement` getter, `gadget:placementChanged` 는 (gadget · valid ·
  reason · mount) 가 바뀔 때만. `GadgetVisuals` 에 고스트 API(`warmGhosts` · `showGhost` · `hideGhost`) — 종류마다
  `create` 로 한 벌 만들어 모든 메시를 공용 반투명 머티리얼 둘(초록 0x4dff88 / 빨강 0xff5a4d, 맥동, depthWrite off)로
  바꿔 끼우고 `visible` 만 토글, 대형은 발자국 링. **설치 높이**: `spawnDeployable` 이 place 경로와 복제본(`wire`)에서는
  준 y 를 그대로 쓰고(표면 · 건물 바닥 · 드론 윗면), 지형으로 내리는 것은 권위자의 투척형 스폰뿐이다. 호스트는 클라의
  `gadq place` 를 `resolveRemotePlace` 로 가볍게 다시 본다(맵 밖이면 거부, 드론 탑재는 드론이 있고 비어 있고
  `MOUNT_TOLERANCE` 안이면 탑재점으로, 아니면 요청 자리 아래 표면). 새 `Deployable.mount` · `DeployableWire.mount` ·
  `gadq place.mount`. 게임플레이 수치 하나를 임시로 `model.ts` 에 뒀다: `PLACE_VERTICAL_REACH`(2.5, TODO(csv)).
  **드론 탑재 수명** — 위치는 각자 로컬로 매 프레임 `getMountPoint`(드론 복제본이 이미 있으므로 위치 메시지 없음).
  드론이 사라지면 탑재물은 그 아래 표면으로 떨어져 **바닥 설치물로 남는다**: 모두가 `drone:removed` 로 로컬에서
  떨어뜨리고, **호스트는 같은 id 로 `gad spawn` 을 다시 방송**한다(계약에 위치 갱신 메시지가 없어 고른 방법 — 받는 쪽
  `Wire` 의 spawn 은 이미 있는 id 면 새로 만들지 않고 위치 · yaw · hp · 무장 · mount 만 덮어쓴다, 설치음 · FX 없음).
  비호스트는 `getDrone` 이 null 인 것만으로는 떼지 않는다 — 늦게 합류하면 `gad sync` 가 `drone sync` 보다 먼저 올 수 있다.
  `DroneRef.mountedDeployableId` 는 쓰기 가능한 구현일 때만 채운다(getter 뿐이면 대입이 조용히 실패한다).
  **기폭기 손**(마지막 C4 를 놓은 뒤 weapons 가 남기는 손 — `heldItemId` 는 C4 그대로)에서는 미리보기가 null 이고
  `use()` 가 설치를 거부한다. 판별은 계약 밖 필드 `remoteState.detonator` 를 캐스트로 읽는 `Preview.isDetonatorHand`.
프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-09 (수치 csv 이관)** — `GadgetDefs.ts` 의 표는 **TS 에 남는다**: 설명문이 `GADGET_*` 상수를 그대로
  찍기 때문에 csv 로 옮기면 설명문의 숫자가 수치와 따로 놀게 된다. 대신 표 안에 리터럴로 박혀 있던 여섯 값이
  상수가 되어 `data/constants.csv` 로 갔다 — `GADGET_BARRICADE_RADIUS`(2.4) · `GADGET_LURE_HP`(140) ·
  `GADGET_MINE_HP`(60) · `GADGET_DEFIB_RANGE`(5) · `GADGET_JUMPPAD_HP`(150) · `GADGET_JUMPPAD_RADIUS`(1.7).
  이제 이 폴더의 수치는 전부 csv 한 곳에서 조정된다

- **Phase 9** — a jump pad re-launches the **same player** only after `JUMP_PAD_RETRIGGER_S` (`Deployable.padNext` per peer), the fire zone credits its owner (`applyStatus(..., d.owner)`), `gadq sync` re-requested on `net:hostChanged`
