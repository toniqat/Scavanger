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
| `GadgetDefs.ts` | `GADGET_DEFS` (10 gadgets, 한국어 이름/설명), `gadgetDef(id)`, `gadgetForKind(kind)`, `RECOVERABLE_KINDS` / `isRecoverable`, `ENEMY_TARGET_KINDS`, `SOLID_KINDS`. |
| `Deployable.ts` | `Deployable implements DeployableRef` — hp/armed/expires/yaw + per-kind runtime state (`fireTimer`, `targetId`, `headYaw`, `tickTimer`, `padCooldown` = 같은 프레임 가드, `padNext` = 플레이어별 재발동 시각(Phase 9), `netCooldown`) and `takeDamage()` (routes to the authority). Also the physical sizes: `BARRICADE_HALF`, `MINE_TRIGGER_RADIUS`, `JUMPPAD_TRIGGER_RADIUS`, `DOME_UNFOLD_TIME`. |
| `GadgetVisuals.ts` | `GadgetVisualPool`: pooled procedural meshes per `DeployableKind` + a 12-slot expanding ring-pulse FX pool. Shared geometry, per-visual materials, recoloured on reuse. **No lights anywhere** (constant scene light count → no shader recompiles). `warm()` pre-builds one visual per kind. |
| `ThrownGadget.ts` | `ThrownGadgetManager`: 8 pooled canisters with a gravity arc + obstacle push-out; deploys on the first ground contact (or after 4 s). |
| `index.ts` | Barrel. |

## 10종 가젯

| id | 이름 | use | deployable | 동작 |
|---|---|---|---|---|
| `cloakVeil` | 은폐 장막 | self | — | `player.setCloak(12, 'gadget')` + 링 펄스 FX |
| `domeShield` | 돔 실드 | throw | `domeShield` | 착탄점에 반경 5 m 돔 (hp 1000). 0.6 초 전개 후 **적 발사체만** 차단 |
| `barricade` | 바리케이드 | place | `barricade` | 정면 2.8 m 에 4.2×1.9 m 벽 (hp 1800). 피아 구분 없이 탄을 막고, 3 초 상호작용으로 회수 |
| `lureGrenade` | 유인 수류탄 | throw | `lure` | 0.5 초마다 `enemies.addDistraction(pos, 40 m, weight 0.85)`. 12 초 |
| `smokeGrenade` | 연막탄 | throw | `smoke` | 16 초 연막. `visionFactor` 로 적 탐지거리를 최대 ×0.08 까지 깎는다 |
| `mine` | 지뢰 | place | `mine` | 3 초 후 무장, 1.5 m 안에 **적·아군 누구든** 들어오면 반경 6.5 m / 220 피해 폭발. 3 초 해체(아이템 반환 없음) |
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

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **Phase 9** — a jump pad re-launches the **same player** only after `JUMP_PAD_RETRIGGER_S` (`Deployable.padNext` per peer), the fire zone credits its owner (`applyStatus(..., d.owner)`), `gadq sync` re-requested on `net:hostChanged`
