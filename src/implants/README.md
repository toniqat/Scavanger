# `src/implants/` — 전술 임플란트 (Tactical implants)

`ImplantSystem` 이 `ctx.implants` (`ImplantsRef`) 를 발행한다. 6종 중 **하나만** 장착해서 레이드에 들고 가며,
장착 변경은 함선에서만 가능하다 (`ctx.isRaidActive()` 면 `setEquipped` 가 `false` 를 돌려준다).

**Q** (`Keys.IMPLANT`, 재할당 가능) 의 동작은 `ImplantDef.mode` 로 갈린다 (2026-09-06 개편, Phase 10 · Phase 12 수정):
- `instant` — 갈고리 / 대시 / **정찰**(Phase 12): 누르면 바로 시전. 갈고리는 조준점 앵커가 유효할 때 즉시 발사, 다시 누르면 와이어를 끊는다. 정찰은 이동 중에도 한 번에 넓은 파동 하나. 총은 손에 그대로.
- `hold` — 오버차지: **누르고 있는 동안** 효과가 돈다 (오버차지 채널). 총은 손에 그대로, `holding === true`.
- `wielded` — 대전차포 · **배리어**(Phase 10): Q 로 손에 들고(`blocksWeapons === true`, weapons 가 홀스터) 대전차포는 좌클릭 발사, 배리어는 막으면서 **좌클릭 / 근접키로 실드 배쉬**(Phase 12).
  Q 또는 **무기 키(1/2/3/V)** 로 집어넣는다 (weapons 가 `stow()` 를 호출한 뒤 그 무기를 뽑는다 — 예전엔 장착형을 든 채로 무기 키가 먹지 않던 버그).

들쳐메기 게이트 (Phase 10): 부상자를 어깨에 메고 있으면(`ctx.player.carrying !== null`) Q 는 `dropCarried('action')` 만 호출하고 그 프레임에는 아무것도 시전하지 않는다.

멀티플레이 방침: **로컬 계산 + 시각 브로드캐스트**. 모든 판정은 시전자 클라이언트에서 하고, 남들에게는
`imp` 메시지로 보여주기만 한다 (Phase 7 부터 오버차지 빔도 `imp beam` 으로 복제). 남의 캐릭터에 거는 우호 효과(회복/버프)만 `buff` 메시지로 보낸다.
서버는 수정이 필요 없다 (`GameMessage` 를 그대로 중계).

## 파일

| 파일 | 역할 |
|---|---|
| `ImplantSystem.ts` | `GameSystem` + `ImplantsRef`. 입력(Q/좌/우클릭/근접키), 충전·쿨타임, 6종 동작, 이벤트 emit, `imp`/`buff` 송수신, `raycastBarrier`(순수 질의) + `damageBarrier`(실제 피격), 방패 들기/내리기 + 추종 + `imp shield` 송신(`flow rejoined` 재전송), **Phase 12**: `resolveBarrierCollision` / `absorbFrontalAttack` / `bashing` + `tryBash`(실드 배쉬, `imp bash`), `castScan`(one-shot 정찰, `imp scanCast`), `implant:barrierBumped` 스파크, e2e 훅 `debugBeam` |
| `model.ts` | 폴더 공용 어휘 — `ImplantSystem` 에서 떼어낸 상수 · 타입 · 스크래치. 클래스를 참조하지 않으므로 `parts/*` 가 순환 import 없이 쓴다. `ImplantSystem.ts` 가 재수출하므로 기존 import 경로는 그대로다 |
| `parts/Barrier.ts` | **배리어 방패** (Phase 10 손에 드는 형태 → Phase 12 벽 + 실드 배쉬). 방패는 세 가지를 동시에 한다: 적 발사체를 **막고**(`onBarrierBlocked`), 지상 적이 통과하지 못하는 **벽**이며(`resolveBarrierCollision` — 부딪힌 적은 잠시 방패를 든 사람을 노린다), 정면 근접을 플레이어 대신 **받는다**(`absorbFrontalAttack`). 들고 좌클릭하면 **실드 배쉬**(`tryBash`). `IMPLANT_BARRIER_CARRY_OFFSET` 은 `PLAYER_RADIUS` 보다 커야 한다 — 그보다 작으면 적 히트스캔이 방패보다 먼저 플레이어 캡슐에 닿아 방패가 조용히 동작하지 않는다. |
| `parts/Devices.ts` | **갈고리 · 대시 · 정찰 · 오버차지 · 대전차포**. 배리어를 뺀 나머지 임플란트 다섯 종의 실제 동작. 각각 `instant` / `hold` / `wielded` 중 하나의 사용 방식을 갖고 Q 하나로 구동된다. 정찰은 Phase 12 에서 홀드 채널이 아니라 **한 번 누르는 광역 스캔**이 되어 이동 중에도 쓸 수 있다. |
| `parts/Charges.ts` | **쿨다운 · 충전 · 에너지 풀**. 임플란트를 쓸 수 있는지, 얼마나 남았는지 하나로 관리한다: 대시의 3충전, 오버차지의 에너지 풀, 배리어 붕괴 후의 잠금, 그리고 `derived.implantCooldownMul` 이 곱해지는 지점. HUD 썸네일이 읽는 이벤트(`implant:cooldownChanged` / `energyChanged`)도 여기서 나간다. **2026-09-12**: 충전이 돌아오는 지점 `finishCooldown`, 준비 순간 `emitReady`(`implant:ready`, 게임플레이 페이즈만), 안정제용 `refillAll`. |
| `parts/Wield.ts` | **손에 드는 임플란트**와 프로필 연동. 대전차포와 방패는 손에 들리므로 총을 홀스터해야 하고(`blocksWeapons`), 무기 키를 누르면 집어넣어야 한다(`stow`). 어떤 임플란트를 장착했는지는 진행도 프로필이 갖고 있으므로 그 적용도 여기서 한다. |
| `parts/Wire.ts` | **임플란트의 네트워크 경로** (`imp` / `buff`). 방패 상태 · 오버차지 빔 · 실드 배쉬 · 정찰 스캔을 분대에 알리고, 남이 보낸 것을 우리 월드에 적용한다. 정찰은 결과가 아니라 **시전 사실**만 보내고(`imp scanCast`) 각 피어가 자기 월드에서 드러낸다. 받은 `buff heal/boost` 는 `buffGuard` 를 통과해야 적용된다 (2026-09-11 E-4). |
| `ImplantDefs.ts` | `IMPLANT_DEFS` (한국어 이름/설명/아이콘/색), `getImplantDef`, `isImplantId`, `implantHex` |
| `RemoteImplants.ts` | 원격 시전자 시각화: 손의 장치, 갈고리 와이어, **방패**(스냅샷 `isBarrierUp` / `barrierHp` + `imp shield`, 피어 위치·yaw 를 매 프레임 추종하며 복제본도 적탄을 막고 **벌레를 밀어낸다**), 스캔 파동(구버전 `imp scan` 은 FX 만), **`imp scanCast`** → 내 월드에서 `revealScan` (Phase 12), **`imp bash`** 스윙 스트릭 (Phase 12), 로켓, **오버차지 빔 / 자기 발광** (Phase 7, `imp beam`) |
| `devices/ImplantDevice.ts` | 손에 드는 절차적 장치 모델(갈고리 런처 / 오버차지 이미터 / 스캐너 / 대전차포 / **방패 손잡이**). 무기 소켓에 붙으며 **-Z 가 총구 방향**, `muzzle` 이 끝점. 방패 분기는 손잡이·프레임만 만들고(이미터 바 · 프레임 팔 폭은 `IMPLANT_BARRIER_CARRY_WIDTH × 0.14`) 막는 패널은 `BarrierField` 가 그린다 |
| `effects/Barrier.ts` | `BarrierField` — 헥사 CanvasTexture 실드 메시, 내구도, 선분 교차(`intersect`, 정면 각도 게이트). Phase 10 부터 **추종형**: `raise()` / `lower()` + 매 프레임 `follow(feet, yaw)`. **Phase 12**: `pushOut(pos, radius, height?)` (두께 `BARRIER_COLLIDE_THICKNESS` 0.5 m 슬랩 밖 정면으로 밀어냄), `facing(fromPos, maxDist)` (정면 `_ARC` 판정), `contactPoint(fromPos, out)` |
| `effects/Grapple.ts` | `GrappleWire` — 와이어 빔 + 작살 헤드 |
| `effects/Overcharge.ts` | `OverchargeBeam` (2겹 빔 + 임팩트 디스크), `findAlly` / `allyPoint` (조준 원뿔 안의 아군 탐색 — 2026-09-11 E-4: 벽 · 지형 뒤의 아군은 건너뛴다, `shared/buffLineClear`) |
| `effects/Scan.ts` | `collectScanTargets` — 반경 안의 **적(`queryNear`) + `ctx.interactables.all()` 전부**를 `ScanTarget[]` 으로 (`canInteract()` 가 false 면 제외, 상한 120). kind 는 **`Interactable.kind` 가 먼저**(`kindOf` — `corpse` · `playerCorpse`(`아군 시체`) · `crate` · `container` → crate, `gather`, `pickup`, `deployable` · `drone` → deployable, `extract` · `revive` · `console` · `objective` → objective, 2026-09-11 C-4)이고 kind 가 없는 등록물만 id 접두어로 판정한다 (`crate` / `corpse` / `pcorpse` → crate, `gather`, `pickup`, `gadget` → deployable, `extract` · `revive` · 그 외 → objective). `revealScan(ctx, center, radius, dur, byLocal)` — 수집 + `detect:reveal` + `scan:cast` + `enemies.setXray` 를 한 번에 (로컬 시전과 `imp scanCast` 수신이 공유) |
| `effects/AtLauncher.ts` | `RocketPool` — 풀링된 로켓, 스텝마다 스윕 레이캐스트(월드/인테리어 + 적) |
| `fx/ImplantFx.ts` | 풀링 FX: `BeamMesh`, 확장 셸(스캔), 폭발, 스트릭(대시/로켓 궤적), 스파크. **라이트 없음** |

## 6종

| id | 이름 | 방식 | 동작 | 쿨타임 |
|---|---|---|---|---|
| `grapple` | 갈고리 | instant | 장착 중 매 프레임 조준점 판정 → `implant:grappleTargetChanged` (Reticle 괄호). **Q** = 유효하면 즉시 발사 → 부착 시 `player.setGrappleTarget(point)` 로 견인; 도착(2.6 m)·5초·Q 재입력으로 해제. 와이어 원점은 무기 소켓(손). 쿨타임은 발사에 시작하고 **끝날 때 환급**(2026-09-12 — 붙은 뒤: 당겨진 거리로 `IMPLANT_GRAPPLE_REFUND_*`, 붙기 전: `IMPLANT_GRAPPLE_CANCEL_*`, 아래 변경 이력) | `IMPLANT_GRAPPLE_COOLDOWN` (24) |
| `dash` | 대시 | instant | 전방 레이캐스트(`IMPLANT_DASH_DISTANCE` 11.25 m + 반경)로 거리 산출 → 바닥 스냅 → `resolveCollision` → `ctx.player.position` 을 직접 갱신(순간이동). 충전 3 | `IMPLANT_DASH_COOLDOWN` (충전당) |

| `barrier` | 배리어 | wielded | Q 로 **방패를 손에 든다**(총 홀스터, 이동속도 × `IMPLANT_BARRIER_CARRY_SPEED_MUL`). 패널은 발 위치 + 정면 `IMPLANT_BARRIER_CARRY_OFFSET` 에서 몸을 따라오고 크기는 `IMPLANT_BARRIER_CARRY_WIDTH`(Phase 12: **3.2 m**) `× _HEIGHT`, 밑단은 `_BASE_Y`. **적 발사체만** · **정면 `_ARC` 안에서만** 차단, 1발당 `IMPLANT_BARRIER_BLOCK_DAMAGE` 30 소모. **Phase 12**: 벌레가 통과하지 못하고(`resolveBarrierCollision`), 정면 근접공격은 방패가 대신 맞으며(`absorbFrontalAttack`), 든 채로 **좌클릭 / 근접키 = 실드 배쉬**(스태미나 `IMPLANT_SHIELD_BASH_STAMINA`, 방패 폭 × `_RANGE` 상자 안의 적에게 `_DAMAGE × meleeDamageMul`, `_COOLDOWN`, 포즈는 `player.startMelee('heavy')`). 든 상태에서도 `_REGEN_DELAY` 3초 무피격 후 `_REGEN` 40/s 회복, 내렸으면 `IMPLANT_BARRIER_REGEN` 120/s. 파괴 시 자동으로 손에서 내려가고 `IMPLANT_BARRIER_BREAK_LOCKOUT` 10초 잠금 — 그 동안 내구도가 0 → 만충으로 정확히 차오르므로 HUD 내구도 게이지가 쿨타임 표시를 대신한다 (`barrierLockout`), 잠긴 동안 Q 는 `배리어 재충전 중` 으로 거부 | 0 (내구도가 자원) |
| `overcharge` | 오버차지 | hold | Q 를 누르고 있는 동안: 자신 `IMPLANT_OVERCHARGE_SELF_HEAL_PER_SEC`(10)/s 회복 + 조준 원뿔 안의 아군에게 `buff heal` `IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC`(25)/s (빔은 아군에게만). 체력 ≥ 90 %(`IMPLANT_OVERCHARGE_BUFF_HP_RATIO`) 인 대상(자신 / 아군)에게만 이동·연사 버프(`setSpeedModifier('overcharge')`, 짝 스태미나 버프는 없음). **에너지** `IMPLANT_OVERCHARGE_ENERGY` 6 s 를 소모하고 놓으면 `IMPLANT_OVERCHARGE_REGEN_TIME` 12 s 에 만충; 0.75 s 미만이면 시작 거부. `implant:energyChanged` | 0 (에너지가 자원) |
| `scan` | 정찰 | instant | Q → 이동 중에도 **한 번에** 반경 `IMPLANT_SCAN_RADIUS` 70 m 파동 (Phase 12). 반경 안의 모든 상호작용물 + 살아 있는 적을 `IMPLANT_SCAN_REVEAL_TIME_V2` 15초 동안 `detect:reveal`(벽 너머 기둥) + `scan:cast`(나침반 · 인디케이터) + `enemies.setXray`(적색 실루엣) 로 드러내고, `imp scanCast {p, radius, dur}` 로 분대에도 같은 파동을 건다 (수신자는 **자기 월드에서** 다시 수집). `implant:scanned {pulse:1}` 은 오디오용으로 유지 | `IMPLANT_SCAN_COOLDOWN_V2` 30 |
| `atlauncher` | 대전차포 | wielded | 좌클릭 로켓 발사(조준점을 향해 보정). 착탄 시 `IMPLANT_AT_RADIUS` 광역 `IMPLANT_AT_DAMAGE` | `IMPLANT_AT_COOLDOWN` |

쿨타임에는 항상 `ctx.progression?.derived.implantCooldownMul` 를 곱한다 (특수 가방 50 % 퍼크가 이미 그 안에 있다).
`progression` 이 아직 없으면 배율 1 로 동작하고, 프로필이 없으면 첫 임플란트(`grapple`)를 임시로 장착한다.
`progress:loaded` 가 오면 프로필 값으로 교체한다.

**충전 재보급 (2026-09-08 수정).** 충전형 임플란트는 재충전이 도는 중에도 남은 충전을 쓸 수 있는데(`cdRemainingBlocking`),
`useCharge()` 가 조건 없이 `startCooldown()` 을 불러 **진행 중이던 재충전 타이머를 매번 처음으로 되돌렸다** — 한 칸을 쓰면서
충전 중이던 칸의 진척까지 같이 버린 것이다. 이제 `cdRemaining <= 0` 일 때만 새로 시작한다(단일 충전 임플란트는 `ready` 가
이미 `cdRemaining > 0` 을 막으므로 동작이 바뀌지 않는다).

## 다른 폴더와의 계약

**읽는 것 (전부 옵셔널 체이닝 + 기본값)**
- `ctx.player`: `position`(직접 갱신), `getForward` / `getEyePosition`, `getAimRay`·`getWeaponSocket`·`addRecoil`
  (`PlayerWeaponHost`, 런타임 `typeof` 체크), `setGrappleTarget`, `setSpeedModifier`, `heal`, `revive`, `interior`
- `ctx.world` / `player.interior`: `raycast`, `getHeightAt` / `getFloorAt`, `resolveCollision`, `isInsideBounds`, `getCrates`, `getExtractionPoints`, `getGatherNodes`(있으면)
- `ctx.enemies`: `raycast`, `queryNear` · `setXray` · **`pushBack`**(2026-09-11 계약 — 존재 검사 없이 부른다), `applyAreaDamage`(없으면 `applyExplosion`)
- `ctx.pickups`, `ctx.gadgets.getDeployables()`, `ctx.loot.getItemDef` — 스캔 결과용
- `ctx.progression.derived.implantCooldownMul`, `ctx.progression.profile.implant`
- `ctx.net`: `send` / `onMessage` / `getRemotePlayers` / `localId` / `playerName`

**쓰는 것 (emit)**
`implant:equipped`, `implant:activated`, `implant:cooldownChanged`, `implant:wieldChanged`,
`implant:grappleTargetChanged` / `grappleFired` / `grappleAttached` / `grappleReleased`,
`implant:dashed`, `implant:barrierChanged` / `barrierHit` / **`barrierCarried`**, `implant:scanned`, `implant:overcharge`,
`implant:rocketExploded`, `detect:reveal`, `camera:shake`, `audio:play`, `ui:notify`, **Phase 12**: `implant:bashed`, `scan:cast`.

**구독**: `progress:loaded`, `game:newMission`, `game:abort`, `hub:entered`, `game:phaseChanged`,
`player:died`, `player:downed`, `net:remotePlayerRemoved`, **Phase 12**: `implant:barrierBumped` (enemies 가 emit — 스파크만).

**`raycastBarrier(origin, dir, maxDist, fromEnemy)`**
- `fromEnemy === false` → **항상 `null`** (아군 실드는 아군 탄을 막지 않는다). weapons 가 자기 탄을 이 규약으로 판정한다.
- `fromEnemy === true` → 로컬 방패 + 복제된 원격 방패 중 가장 가까운 교차점 `{ point, owner }`. Phase 10 부터 **정면 게이트**가 붙어
  (`IMPLANT_BARRIER_CARRY_ARC` 반각) 뒤·측후방에서 온 탄은 그냥 통과한다. 시그니처는 그대로다.
- **순수 질의다 (Phase 9).** 더 이상 내구도를 깎거나 스파크를 튀기지 않는다 — 시선 판정 / 사선 검사처럼 매 틱 불러도 안전하다.
  (Phase 8 까지는 여기서 바로 30 을 깎았고, 그래서 "투기적 질의 금지" 경고가 붙어 있었다. 그 경고는 폐기.)

**`damageBarrier(owner, point, amount = IMPLANT_BARRIER_BLOCK_DAMAGE)`** (Phase 9)
- 탄이 **실제로** 배리어에서 멈춘 지점에서 **한 번만** 부른다 (weapons 의 히트스캔 해석 · 투사체 세그먼트, enemies 의 로그 사격 / 곡사 / 산탄 착탄).
- `owner === 'local'` → `onBarrierBlocked` (내구도 −`amount`, `implant:barrierHit`, 붕괴 시 `barrier_break` + 잠금 + 자동 `stow()`, `imp shield` 동기화).
- 원격 소유자 → 스파크만. 그 방패의 hp 는 소유자 클라이언트가 권위이고 스냅샷 `bhp` + `imp shield` 로 방송한다.

**`buff` 수신은 종류마다 담당이 하나씩이다.** 오버차지의 `heal` / `boost` 는 여기서 로컬 플레이어에 적용하고,
제세동기 `revive` 와 `cloak` 은 gadgets 가 처리한다 (Phase 9 에서 여기 있던 중복 `revive` 분기를 제거했다).

**오버차지 버프 규약**: 대상 플레이어에 `setSpeedModifier('overcharge', mul, duration)` **과** `setOvercharged(duration)` 을 같은 길이로 건다
(`applyBoost`, 채널 중 매 프레임 0.6 s 로 갱신). `isOvercharged` 는 **그 타이머**다 — 2026-09-11 (C-3) 까지는 player 가 속도 수정자 키가
`overcharge` 로 시작하는지로 추론했다. weapons 가 `isOvercharged` 로 연사속도를, net 이 `PlayerFlags.OVERCHARGED` 를 처리한다. 스태미나 소모 감소는 2026-09-06 개편에서 제거됐다.

## 규칙 / 주의

- **라이트를 만들지 않는다.** 모든 발광은 emissive + additive `MeshBasicMaterial`. 씬 라이트 개수를 바꾸면 셰이더가 전부 재컴파일된다.
- FX·로켓·스파크는 전부 풀링. 핫 패스에서 `Vector3` 를 새로 만들지 않는다 (모듈 스크래치 재사용).
  `clone()` 은 버스 페이로드처럼 수신자가 보관할 수 있는 값에만 쓴다.
- `game:newMission` / `game:abort` / `hub:entered` 에서 `reset()` — FX, 로켓, 원격 시각화, 배리어, 와이어를 전부 정리한다.
  `dispose()` 는 자기가 만든 geometry/material 을 전부 dispose 한다 (공유 헥사 CanvasTexture 는 프로세스 수명 동안 유지).
- 원격 장치 모델은 `PlayerSnapshot.imp` (→ `RemotePlayerRef.implantId`) 로 구동한다. `imp wield` 는 즉시 반영용 보조.

## 필요한 SFX id (audio 담당)

`grapple_fire`, `grapple_attach`, `grapple_release`, `dash`, `barrier_deploy`, `barrier_stow`, `barrier_hit`,
`barrier_break`, `overcharge_beam`, `scan_pulse`, `rocket_fire`, `rocket_explode`, `implant_wield`.
(없는 id 는 AudioSystem 이 콘솔 경고만 내고 무시한다.) `implant_ready` 는 2026-09-12 부터 이 폴더가 보내지 않는다 —
audio/ 가 `implant:ready` 를 듣고 낸다 (그 전에는 `audio:play` 를 보냈지만 `SOUNDS` 에 정의가 없어 한 번도 울리지 않았다).

## 장착 UI (2026-09-06)
임플란트 장착은 함선 **Tab 화면**(inventory 폴더, 장비 열 아래의 임플란트 슬롯 → 클릭 → 6종 카드; 장착 중인 카드를 다시 누르면 해제)에서 한다.
터미널의 임플란트 탭과 `hub/ui/ImplantPanel` 은 삭제됐고, 함선의 임플란트 시술대(`hub_implant_bay`)는 그 Tab 화면을 연다.
HUD 는 `ui/hud/ImplantWidget` — **2026-09-10 부터 화면 중앙 하단(스태미나 바 아래)의 가로 썸네일**이다 (그 전에는
크로스헤어 좌측 세로 게이지였다). 이름은 적지 않고 글리프 + 아래의 `Keys.IMPLANT` 키캡만 두며, 상태는 셋으로 갈린다:
**쿨타임형**(갈고리 · 정찰 · 대전차포) 딤드 + 아래에서 위로 밝아짐 + 중앙 남은 초, **충전형**(대시) 우하단 충전 수
(0 = 쿨타임형 연출, 1 이상 = 강조색 차오름, 최대 = 정상), **게이지형**(배리어 내구도 · 오버차지 에너지) 썸네일 안
중앙 하단 게이지 — 배리어 붕괴 잠금은 내구도가 잠금 시간에 맞춰 0 → 만충으로 차오르므로 그대로 쿨타임 표시를 겸한다.
UI 는 **`ImplantsRef` 의 기존 값만** 읽는다 (`cooldownRemaining` / `cooldownTotal` / `charges` / `maxCharges` /
`barrierHp` / `barrierMaxHp` / `barrierLockout` / `energy` / `energyMax`) — 이 폴더에 새 질의를 추가하지 않았다.
갈고리는 크로스헤어 **좌측**에 아이콘 + 사용 키가 따로 붙는데(`ui/hud/Reticle` 의 `.rgrap`), 그 판정도 새 API 가
아니라 `updateGrapple` 이 이미 매 프레임 보내는 **`implant:grappleTargetChanged {valid, distance}`** 하나다
(= `castGrapple` 이 보는 `grappleTargetValid`). 걸 수 없으면 키캡을 숨기고 아이콘만 딤드로 남긴다.

## Phase 7 (2026-09-06): 오버차지 빔 복제 (`imp beam`)

계약: `ImplantMessage` += `{ t: 'imp', ev: 'beam', target: PeerId | null, self: boolean }` (`src/shared/net.ts`).

**송신 (`ImplantSystem`)** — `updateOvercharge` 가 매 프레임 `syncBeamNet(dt, targetId, !ally)` 를 부른다: 채널 시작, 잠긴 아군(`findAlly`) 변경, 그리고 켜져 있는 동안 `BEAM_SEND_INTERVAL` 0.25 s (≤ 4 Hz) 마다 `{target, self}` 를 `others` 에 보낸다. `self` = 아군 없이 자기만 회복 중. `setOvercharge(false)` (Q 놓음 / 에너지 0 / `stow` / 사망 / 페이즈 변경 — 모든 경로가 여기로 온다) 는 즉시 `sendBeamOff` → `{target: null, self: false}`. 늦게 합류한 클라이언트는 다음 0.25 s 갱신에서 빔을 본다.

**수신 (`RemoteImplants`)** — `beam` 이벤트는 peer 상태(`beamOn / beamTarget / beamSelf / beamUntil`)만 갱신하고 시작 시 `overcharge_beam` 을 시전자 위치에서 재생한다. `update` 가 매 프레임 그린다:
- 원점 = 시전자 아바타의 무기 소켓(없으면 가슴).
- `target` 이 있으면 끝점 = 그 ref 의 가슴(`allyPoint`), **나 자신이 대상이면 로컬 플레이어 가슴** (`net.localId`). 대상의 hp ≥ `IMPLANT_OVERCHARGE_BUFF_HP_RATIO` 면 `boost` 색, 아니면 `heal` 색 (`OverchargeBeam` 재사용). 알 수 없는 / 끊긴 / 죽은 대상이면 아무것도 그리지 않는다 (상태는 유지).
- `self` 면 시전자 가슴에 가산 합성 구(`glowGeo` 공유, peer 당 재질 하나)가 맥동한다. 라이트 없음.
- `BEAM_TIMEOUT` 1 s 안에 갱신이 없으면 꺼진 것으로 본다(off 유실 대비). off / `net:remotePlayerRemoved` (`remove`) / 미션 리셋 (`clear`) 에서 빔·발광을 숨기거나 dispose 한다.

검증: `npm run typecheck` (implants 폴더 0 오류). 빔은 멀티 전용이라 단일 클라이언트 smoke 로는 못 보고, `e2e:mp` 확장은 net 담당에게 위임 (실제 두 클라이언트 확인은 리드 `verify:all` 이후 권장).

## Phase 9 (2026-09-06): 순수 배리어 질의 · 늦은 합류 · 빔 디버그 훅

계약: `ImplantsRef.damageBarrier(owner, point, amount?)` (`src/shared/implants.ts`), `raycastBarrier` 는 순수 질의.

- **배리어 판정 분리.** `raycastBarrier` 에서 `onBarrierBlocked` / 스파크를 들어내고 `damageBarrier` 로 옮겼다. 이제
  weapons 의 `lineOfSight` / `Blocking.raycastBlockers`, enemies 의 사선 검사처럼 **투기적 질의**를 마음껏 해도 실드가
  닳지 않는다. 탄이 실제로 멈춘 호출부(weapons 히트스캔 · 투사체, enemies 로그 사격 · 포탄 폭발 · 산성탄)만
  `damageBarrier(owner, point)` 를 정확히 한 번 부른다.
- **늦은 합류.** 스냅샷은 `PlayerFlags.BARRIER` 만 나르므로 나중에 합류한 클라이언트는 이미 세워진 배리어의 위치 / hp 를
  모른다. `flow rejoined` 를 받으면 배리어가 활성인 소유자가 그 피어에게만 `imp barrier {active:true, p, yaw, hp}` 를
  유니캐스트한다 (`sendBarrier(active, to)`). **Phase 10 에서 `sendShield(up, to)` + `imp shield` 로 대체됐다.**
- **`buff revive` 중복 제거.** `ImplantSystem.onBuff` 의 `'revive'` 분기를 삭제 — 제세동기는 gadgets 소유다 (예전에는
  두 폴더가 같은 `buff` 를 각자 적용해 부활이 두 번 걸렸다).
- **`debugBeam(peerId)`** → `{on, target, self, until} | null` (`RemoteImplants.debugBeam` 위임). `e2e:mp` 가 수신 측에서
  오버차지 빔이 실제로 그려지는지 확인하는 훅.

## Phase 10 (2026-09-07): 배리어 = 들고 다니는 방패

계약: `ImplantsRef.barrierCarried` / `getBarrierPose(out)` (`src/shared/implants.ts`),
`IMPLANT_BARRIER_CARRY_WIDTH / _HEIGHT / _OFFSET / _BASE_Y / _SPEED_MUL / _ARC / _REGEN / _REGEN_DELAY` +
`IMPLANT_BARRIER_BLOCK_DAMAGE` (`constants.ts`), `imp shield {up, hp}` + `PlayerSnapshot.bhp` +
`RemotePlayerRef.isBarrierUp / barrierHp` (`net.ts`), `implant:barrierCarried {up}` (`events.ts`).

지면에 세우는 7 × 3.2 m 벽이 **손에 드는 1.5 × 1.35 m 방패**로 바뀌었다.

- **`ImplantDefs.barrier.mode = 'wielded'`.** Q 가 대전차포와 똑같은 흐름을 탄다: `wield()` 로 들면
  `blocksWeapons === true` 라서 weapons 가 총을 홀스터하고, Q 또는 무기 키가 `stow()` 를 부르면 내려간다.
  `toggleBarrier` / `dropBarrier` / `BARRIER_OFFSET` 지면 스냅은 삭제됐다.
- **`BarrierField` 는 추종형.** `deploy(pos, yaw)` 1회 언폴드 대신 `raise()` / `lower()` + 매 프레임
  `follow(feet, yaw)`. `position` 은 **패널 밑단 중심**(= 발 + 정면 `_OFFSET`, y = 발 + `_BASE_Y`) 이고
  `intersect` 가 그 y 부터 dy 를 잰다. `intersect` 에 정면 각도 게이트(`_ARC`) 가 붙어 뒤에서 온 탄은 통과한다
  (예전 벽은 양면이었다). 헥사 CanvasTexture 싱글턴의 `repeat` 는 새 치수 ÷ `HEX_TILE_M` 로 다시 구웠다 —
  이제 모든 방패가 같은 크기라 재질별 repeat 가 필요 없다.
- **회복 규칙.** 든 상태: `_REGEN_DELAY` 3초 무피격 후 `_REGEN` 40/s. 내린 상태: 기존 `IMPLANT_BARRIER_REGEN` 120/s.
  파괴 잠금 중: 0 → 만충을 잠금 시간에 정확히 맞춰 채운다(HUD 게이지 = 쿨타임). 파괴되면 패널이 내려가는 것으로
  끝내지 않고 `stow()` 까지 불러 손잡이도 집어넣는다 (안 그러면 총이 계속 홀스터된 채로 남는다).
- **이동 페널티**: 든 동안 `player.setSpeedModifier('shield', IMPLANT_BARRIER_CARRY_SPEED_MUL)`, 내리면 `(…, 1)` 로 제거.
- **`devices/ImplantDevice`** 에 `barrier` 분기 추가 — 예전엔 `default: buildScanner` 라서 스캐너 접시가 조용히
  손에 붙었다. 손잡이 + 팔뚝 브레이스 + 프로젝터 헤드만 만들고 막는 패널은 `BarrierField` 몫이다.
- **복제.** 손 장치는 `mode === 'wielded'` 판정으로 공짜로 따라온다. 상태는 스냅샷(`isBarrierUp` / `barrierHp`) 이
  권위이고 `imp shield` 는 즉시 반영 + 늦은 합류(`flow rejoined` 유니캐스트) 용이다. 피어 방패는 매 프레임
  `ref.position` / `ref.yaw` 로 `follow` 한다. 옛 `imp barrier` 는 `active` / `hp` 만 읽어 같은 경로로 흘린다
  (`p` / `yaw` 무시) — 구버전 피어 호환.
- **들쳐메기 게이트**: `activate()` 맨 앞에서 `ctx.player.carrying !== null` 이면 `dropCarried('action')` 만 하고 반환.
- `raycastBarrier` / `damageBarrier` 시그니처는 그대로. `barrierActive` 의 의미는 "손에 들려 있음" 이 됐고
  `barrierCarried` 는 그것 + `equipped === 'barrier'` 다. `getBarrierPose(out)` 은 패널 밑단 중심 + yaw.

검증: `npm run typecheck` 0. `scripts/smoke-tactical.mjs` 의 배리어 검사군을 방패 기준으로 갱신했다
(들기 → `barrierCarried` / `blocksWeapons` / 포즈 오프셋 / 정면 게이트 / 추종 / Q 로 내리기).
**리드 확인 필요**: `smoke-weapons.mjs` (`:296-345`) 는 플레이어 자기 위치에서 정면으로 쏴서 자기 방패에 막히는 것을
전제하므로 정면 게이트에 걸려 실패한다 (아래 리포트 참고). `smoke-enemy-delta.mjs` 는 `raycastBarrier` 를 스텁으로
갈아끼우므로 영향 없다.

## Phase 12 (2026-09-08): 넓은 방패 · 벌레 충돌 · 정면 흡수 · 실드 배쉬 · one-shot 정찰

계약: `ImplantsRef.resolveBarrierCollision(pos, radius)` / `absorbFrontalAttack(owner, fromPos, amount)` / `bashing`
(`src/shared/implants.ts` 마지막 절), `imp bash {p, yaw}` · `imp scanCast {p, radius, dur}` · `ee barrierHit` (`net.ts`),
`implant:bashed` · `implant:barrierBumped` · `scan:cast` (`events.ts`), `IMPLANT_SHIELD_BASH_*` · `IMPLANT_SCAN_RADIUS` ·
`IMPLANT_SCAN_REVEAL_TIME_V2` · `IMPLANT_SCAN_COOLDOWN_V2` (`constants.ts`). 이 폴더가 바꾼 계약 값은 하나 —
**`IMPLANT_BARRIER_CARRY_WIDTH` 1.5 → 3.2** (높이 · 오프셋 · 아크는 그대로, `_OFFSET` 0.7 > `PLAYER_RADIUS` 0.45 유지).

- **넓은 방패.** 폭은 상수 하나에서 나오므로 패널 지오메트리 · 헥사 텍스처 repeat · `intersect` · `pushOut` · 배쉬 상자 ·
  원격 복제본이 모두 따라온다. 손 장치의 이미터 바 / 프레임 팔만 `× 0.14` 로 폭을 반영한다.
- **`resolveBarrierCollision(pos, radius)`** — enemies/ 가 시뮬레이션하는 벌레마다 매 틱 부른다. 로컬 방패 → 피어 방패 순으로
  `BarrierField.pushOut`: 패널을 폭 `_CARRY_WIDTH` × 두께 `BARRIER_COLLIDE_THICKNESS` 0.5 m 의 XZ 슬랩으로 보고, 세로 범위
  (`pos.y … pos.y + 1`) 가 패널과 겹치고 원이 슬랩과 겹치면 **정면 노멀 방향으로** 밖으로 민 뒤 소유자(`'local'` / PeerId)를
  돌려준다. 중심이 뒷면 뒤에 있는 몸(이미 지나간 것)은 건드리지 않는다. 할당 0, `pos` 만 쓴다. 플레이어는 여전히 통과한다
  (아군이 뒤로 들어와야 한다). enemies 가 emit 하는 `implant:barrierBumped` 는 여기서 `BUMP_FX_INTERVAL` 0.12 s 로 죄어 스파크만.
- **`absorbFrontalAttack(owner, fromPos, amount)`** — 호스트의 enemies/ 가 근접 피해를 넣기 **전에** 부른다. 그 소유자의 방패가
  올라가 있고 `fromPos` 가 시전자 정면 `_ARC` 안 · `ABSORB_RANGE` 3 m 안이면 true. 로컬이면 `onBarrierBlocked(contactPoint,
  amount)` — 기존 차단 경로 그대로(`implant:barrierHit`, 붕괴 → 잠금 + `stow()`, `imp shield` 동기화). 피어 소유자면 스파크만
  내고 true — enemies 가 `ee barrierHit` 을 그 피어에게 보내고, 그 피어의 enemies 가 `damageBarrier('local', p, amount)` 를
  부른다 (`damageBarrier('local')` 은 Phase 10 부터 들고 있는 방패에 그대로 먹는다).
- **실드 배쉬.** 방패를 든 채 **좌클릭(`Keys.FIRE`) 또는 근접키(`Keys.MELEE`)** → `tryBash`: `IMPLANT_SHIELD_BASH_COOLDOWN` 0.8 s
  지났고 `player.consumeStamina(_STAMINA 25)` 가 성공하면 `bashing` = true (`_SWING_S` 0.35 s), 포즈는 `player.startMelee('heavy')`
  (용검 스윕 — 와이어의 MELEE_HEAVY 로 복제본 포즈는 공짜), `queryNear` 의 살아 있는 적 중 시전자 기준 정면 `0 < fwd ≤
  _OFFSET + _RANGE + 반경`, `|측면| ≤ 폭/2 + 반경` 인 것에 `takeDamage(_DAMAGE 55 × derived.meleeDamageMul, 가슴점, 정면)`.
  무기 · 개머리판 보너스 없음. 리플리카는 스스로 `hit` 을 호스트에 보낸다. `implant:bashed {position, yaw, hits}` +
  `imp bash` 송신, 정면 가로 스트릭 FX, `melee_swing` / `barrier_hit` SFX. 방패는 내려가지 않는다. 근접키는 처리 뒤
  `input.consume(Keys.MELEE)` — weapons 는 `blocksWeapons` 동안 홀스터라 원래 스윙하지 않지만 이중 안전장치다.
  **적 넉백은 없다**: `EnemyRef` 에 임펄스 API 가 없다 (`IMPLANT_SHIELD_BASH_KNOCKBACK` 미사용, follow-up).
  → 같은 배치 뒤 `EnemySystem.pushBack` 캐스트로 붙었고, **2026-09-11 (C-1 · X-6)** 부터 `EnemyManagerRef.pushBack` 계약 한 줄이다
  (리플리카는 enemies/ 가 `HitRequest {dmg: 0, kb}` 로 호스트에 넘긴다 — 비호스트 배쉬 넉백이 0 이던 문제).
- **정찰 rework.** `mode: 'instant'`, 쿨타임 `IMPLANT_SCAN_COOLDOWN_V2` 30 s. Q → `castScan`: `useCharge()` → 발 + 1.1 m 중심으로
  `revealScan(ctx, center, 70, 15, true)` (= `collectScanTargets` + `detect:reveal` + `scan:cast` + `enemies.setXray(ids, 15)`) →
  파동 FX(`SCAN_PULSE_FX_S` 1.6 s 에 70 m) → `implant:scanned {pulse:1}`(오디오) → `implant:activated`(임플란트 숙련 XP, 시전당 1회)
  → `imp scanCast {p, radius, dur}`. 수신(`RemoteImplants`)은 값을 클램프한 뒤 **자기 월드**에서 `revealScan(…, false)` —
  타겟은 와이어를 타지 않는다. 옛 홀드 상태(`scanning` / `scanTimer` / `scanPulses`, `stopScan`)는 삭제, 옛 상수는 미사용으로 남는다.
  `collectScanTargets` 는 이제 적 + **`ctx.interactables.all()`** 이 전부다 (상자 / 시체 / 채집물 / 픽업 / 설치물 / 탈출 콘솔 /
  구조 대상은 모두 등록된 상호작용물이므로 폴더별 getter 를 더듬지 않는다).

검증: `npm run typecheck` 0 (implants). `scripts/smoke-tactical.mjs` **85 checks** (+21): 폭 3.2 (1.4 m 옆은 막고 1.9 m 는
통과), `resolveBarrierCollision` 정면 밀어내기 / 옆 · 뒤 무시, `absorbFrontalAttack` 정면 −40 · 후방 무시 · 미지 피어 false,
합성 LMB 실드 배쉬(`bashing`, 스태미나, 1 m 앞 벌레 피해, 방패 유지, 0.35 s 뒤 해제), 세 번째 임무에서 one-shot 정찰
(`scan:cast` 1회 · 25 m 벌레 포함 · 상호작용물 전부 · `detect:reveal` 15 s · XP 훅 1회 · 쿨타임 30 × mul · 재입력 거부).
`smoke-controls-hub` 99/99 무변경.


## 파일 분할 규약 (`model.ts` + `parts/`, 2026-09-08)

`ImplantSystem.ts` 는 한 파일에 다 있기에는 너무 커져서 **동작을 바꾸지 않고** 갈랐다. 규칙은 세 줄이다.

1. **`model.ts`** — 폴더 공용 어휘(타입 · 상수 · 스크래치 객체, 상태 없는 보조 클래스).
   `ImplantSystem.ts` 이 `export * from './model'` 로 재수출하므로 **기존 import 경로는 전부 그대로 동작한다.**
2. **`parts/*.ts`** — 클래스에서 떼어낸 메서드 묶음. 각 함수는 인스턴스를 첫 인자 `sys` 로 받는다:
   ```ts
   export function foo(sys: ImplantSystem, …) { … }   // 예전의 this → sys
   ```
   클래스에는 같은 이름의 **한 줄 위임 메서드**가 남아 있으므로 호출부는 하나도 바뀌지 않았다.
3. `parts/` 가 닿는 클래스 멤버는 `private` 이 벗겨져 있다. **폴더 밖에서 쓰라는 뜻이 아니다** —
   외부와의 계약은 `@/shared` 의 `*Ref` 인터페이스가 전부다.

새 `parts/` 파일은 맨 위 doc 주석에 **그 파일이 답하는 질문 한 줄**을 적고 위 표에 행을 추가한다.
순환 import 를 만들지 않으려면 `parts/` 는 `ImplantSystem.ts` 에서 **타입만** 가져와야 한다 — 값은 `model.ts` 로.

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-12 (갈고리 환급 · 쿨 2배 · 대시 1.5배 · `refillAll` · 준비 순간 — docs/plans/consumables-keys-favorites.md §2, 에이전트 B)** —
  계약: `ImplantsRef.refillAll?()` (`shared/implants.ts` 끝 절), `implant:ready {id, charges, maxCharges, full, refill}` ·
  `implant:cooldownRefunded {id, seconds, ratio}` (`events.ts` [B]), `IMPLANT_GRAPPLE_REFUND_MAX` 0.5 · `_REFUND_DIST` 15 ·
  `IMPLANT_GRAPPLE_CANCEL_REFUND` 0.9 · `_CANCEL_MIN_S` 3 (`constants.csv` [B]). 수치 변경: `IMPLANT_GRAPPLE_COOLDOWN` 12 → **24**,
  `IMPLANT_DASH_DISTANCE` 7.5 → **11.25** (코드 무변경 — 앞 벽은 원래대로 1 m 높이 레이캐스트 − 반경 − 0.15 로 자르고 `resolveCollision` ·
  `isInsideBounds` 가 뒤를 받친다. 스모크가 트인 방향 11.25 m · 벽 앞 정지를 둘 다 잰다).
  - **갈고리 환급** (`parts/Devices.refundGrapple`). 쿨타임은 여전히 발사(`fireGrapple` 의 `useCharge`)에서 시작하고, `releaseGrapple(false)` 가
    끝에 부른다. 붙은 뒤 놓았으면 `grappleAttachPos`(붙는 순간의 발, `updateGrapple` 이 기록) → 놓는 순간의 발 사이 거리 d 로
    `0.5 × max(0, 1 − d/15)` × `cdTotal`, 붙기 전에 끝났으면(날아가는 중 Q · 드론 앵커 소실) 0.9 × `cdTotal` 이되 남은 쿨타임은 3 초 이상(원래
    남은 것보다 늘리지는 않는다). 두 위치를 둘 다 동기적으로 읽으므로 놓은 뒤의 관성은 들어가지 않는다. **조용한 해제(`silent` — `stow` 경유의
    사망 · 페이즈 변경 · 리셋 · 드론 조종)는 환급하지 않는다**: 리셋이 어차피 쿨타임을 0 으로 만들고, 미션 시작에 `−N초` 가 뜨면 안 된다.
    남은 쿨타임을 전부 먹는 환급은 틱과 같은 `finishCooldown` 으로 끝난다. 비행 중 타임아웃 규칙은 코드에 없다(비행은 늘 도착한다) — 명세의
    "시간 초과" 는 붙은 뒤의 `GRAPPLE_MAX_TIME` 으로, 그것은 거리 규칙을 탄다.
  - **준비 순간** (`parts/Charges.finishCooldown` · `emitReady`). `tickCooldown` 의 0 도달 가지를 `finishCooldown` 으로 떼어 **충전 하나가
    돌아올 때마다** `implant:ready` 를 낸다 — 대시의 중간 충전은 `full: false`, 마지막 · 단일 충전 · 배리어 잠금 해제는 `full: true`.
    오버차지 에너지가 가득 차는 순간도 `full: true`. **게임플레이 페이즈에서만** 나간다 (`resetRuntime` 은 틱 없이 채우므로 장착 · 미션 시작 ·
    함선은 원래 여기를 지나지 않는다 — 게이트는 이중 안전장치). 소리 `implant_ready` 는 audio/ 가 이 이벤트로 낸다.
  - **`refillAll`** (`parts/Charges.refillAll`, 안정제용): 충전 가득 · 쿨타임 0 · `cdTotal` = 실효값 · 배리어 잠금 해제 + 내구도 가득 · 오버차지
    에너지 가득 → `emitCooldown` · `emitBarrier` · `emitEnergy` → `implant:ready {refill: true}`(이미 가득이어도 — 아이템을 쓴 피드백).
    `resetRuntime` 을 쓰지 않는다 — 날아가는 갈고리 · 들고 있는 방패 · 오버차지 채널을 끊기 때문이다. 비행 중에 쓰면 그 뒤 해제는 남은
    쿨타임이 없어 환급하지 않는다.
  - `ImplantDefs` 갈고리 설명에 환급 한 문장(숫자 없음). 위임 메서드 `finishCooldown` · `refillAll` · `refundGrapple` 을 `ImplantSystem` 에 추가.
  - 검증: `smoke-tactical` — 소리 id 2종, 미션 시작 · 장착 · 대시로는 `implant:ready` 가 없다, 대시 11.25 m · 벽 앞 정지, 대시 충전 셋이 차며
    `full` false/false/true + `.rdy-minor/.rdy-minor/.rdy-major` + `.is-ready` + 중간이 더 작은 `implant_ready`, 배리어 붕괴 뒤 `refillAll`,
    정찰 쿨타임 중 `refillAll` → 즉시 재시전, 네 번째 미션(갈고리): 쿨타임 24 · 날아가는 중 Q = 3 초 남음 · 붙은 뒤 0 m = 50 % · 6 m = 30 % ·
    20 m = 환급 없음 · HUD `−N초` · 비행 중 `refillAll` 뒤 해제 = 환급 없음 · 취소 뒤 3 초가 지나면 `.rdy-major`.

- **2026-09-11 (E-4 — 받는 쪽 버프 상한 · 벽 뒤 빔)** — `ImplantSystem.buffGuard`(`shared/createBuffGuard`) 하나와 디버그용
  `lastBuffVerdict`. `parts/Wire.onBuff` 는 `heal` · `boost` 만 보고, 죽음/전투불능 검사를 먼저 한 뒤 `buffSenderOf(net, from, 내 위치)` 로
  판정한다: 보낸 사람이 연결된 로비 멤버 · 스냅샷 거리 ≤ 사거리 + `BUFF_RANGE_SLACK` · `heal` 은 보낸 사람별 + 전체 토큰 버킷으로 깎고
  (`(스프레이 최대 초당 치유 + IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC) × BUFF_HEAL_RATE_MARGIN`, 크기 × `BUFF_HEAL_BURST_S`) ·
  `boost` 배수는 `[1, IMPLANT_OVERCHARGE_SPEED_MUL]`(느리게 만드는 ×0.01 도 막는다) · 지속은 `IMPLANT_OVERCHARGE_DURATION` 이하.
  **받는 쪽 시야 검사는 없다.** 보내는 쪽 `effects/Overcharge.findAlly` 는 원뿔 후보마다 내 가슴 → 그 가슴을 `shared/buffLineClear` 로
  보고 막힌 분대원은 건너뛴다(다음으로 가까운 트인 분대원을 잡는다). 검사: `scripts/smoke-trust.mjs`.

- **2026-09-11 (C 항목 배치 — 배쉬 넉백 계약 · 오버차지 플래그 · 정찰 kind · 원격 장치 재부착)** — 계약은 읽기만 했다
  (`EnemyManagerRef.pushBack`, `PlayerRef.setOvercharged?`, `Interactable.kind`).
  - **C-1 · X-6 배쉬 넉백.** `parts/Barrier.tryBash` 가 `(enemies as unknown as {pushBack?}).pushBack` 캐스트 + typeof + try/catch 대신
    `enemies.pushBack(center, radius, IMPLANT_SHIELD_BASH_KNOCKBACK, forward)` **한 줄**을 부른다. 역할을 가르지 않는다 — 리플리카에서는
    enemies/ 가 적마다 `HitRequest {dmg: 0, kb}` 를 호스트에 보낸다(implants 는 와이어를 보내지 않는다). 같은 모양의 불필요한 존재 검사도
    걷어냈다: `tryBash` · `collectScanTargets` 의 `queryNear` 검사(없으면 `getEnemies()`), `revealScan` 의 `setXray` 검사 — 셋 다 계약 멤버다.
  - **C-3 오버차지.** `parts/Wire.applyBoost` 가 `setSpeedModifier('overcharge', …)` 옆에서 `setOvercharged?.(duration)` 을 같이 부른다
    (자기 버프 `Devices.updateOvercharge` 와 아군 `buff boost` 수신이 모두 이 함수다). player 쪽 키 이름 추론은 사라졌다.
  - **C-4 정찰 분류.** `effects/Scan.kindOf(it)` 가 `Interactable.kind` 를 먼저 보고 접두어는 폴백이다. 접두어 표에 **`pcorpse`** 가 없어
    `pcorpse:<owner>:<n>` 분대원 시체가 `objective`(1.4 배 높이 기둥)로 드러나던 버그를 같이 고쳤다 (`crate` · `아군 시체`).
  - **C-43 원격 장치.** `RemoteImplants` 의 `deviceAttached` 불리언을 지우고 매 프레임 `device.root.parent !== r.avatar.weaponSocket`
    이면 다시 붙인다(아바타가 없으면 떼어 낸다). 아바타는 다시 만들어질 때마다 새 `weaponSocket` 을 주는데(링거 안 재접속 · ref 재생성 ·
    `game:abort` / `hub:entered` 일괄 정리) 옛 불리언은 그것을 몰라, 임플란트가 바뀔 때까지 장치가 버려진 소켓에 남아 손에서 사라졌다.
  - 검증: `smoke-tactical` **91** (+4 — `applyBoost` 뒤 `isOvercharged` · 수정자 키만으로는 안 켜짐 · 만료 / `setOvercharged(0)`,
    배쉬가 `pushBack` 을 한 번 불러 맞은 벌레가 0.4–1 × 속도를 얻음), `smoke-raidflow` 의 C-4 정찰 kind 단언, `e2e-multiplayer` 에
    원격 대전차포 장치 재부착 단언(아바타 강제 재생성 → 새 `weaponSocket` 아래 `Implant:atlauncher`). 스모크 하네스가 vite HMR 소켓을
    막아 두게 했다 (여러 에이전트가 같은 트리에 저장하면 중간에 새로고침돼 `gameplay phase` 에서 멈췄다).

- **2026-09-11 (갈고리 ↔ 공중 드론 · 드론 조종 중 Q 차단)** — 계약은 읽기만 했다 (`shared/drones` 의
  `DronesRef.raycast` · `getDrone`, `PlayerRef.droneControl`, `drone:controlChanged` · `drone:removed`).
  - **조준.** `updateGrapple` 의 idle 판정이 월드(또는 실내) 레이캐스트와 함께 `ctx.drones.raycast(o, d,
    IMPLANT_GRAPPLE_RANGE, 'air')` 를 보고 **더 가까운 쪽**을 앵커로 삼는다 — 벽 뒤 드론은 벽이 가린다. 실내에서는
    드론을 보지 않는다. 드론이면 `grappleDroneId` + 몸체 중심 기준 오프셋(`grappleDroneOffset`)을 기억하고
    `implant:grappleTargetChanged` 는 추가 필드 없이 `valid: true` 로 나간다. 지상 드론은 대상이 아니다.
  - **움직이는 앵커.** `flying` · `attached` 동안 매 프레임 `grapplePoint = drone.position + offset` 으로 다시 앉히고,
    붙은 뒤에는 `grappleTip` 과 `setGrapplePull` 을 매 프레임 다시 준다 — `player.setGrappleTarget` 이 점을
    **복사**하기 때문이다. `getDrone` 이 null · hp ≤ 0 이거나 `drone:removed` 가 그 id 로 오면 즉시
    `releaseGrapple(false)`.
  - **도착하면 끝.** 매달리기 없음 — 기존 `GRAPPLE_ARRIVE_DIST` · `GRAPPLE_MAX_TIME` 규칙 그대로이고, 드론 앵커만
    도착 거리에 `drone.radius` 를 더해 몸체에 끼기 전에 풀린다.
  - **원격.** 드론에 붙어 있는 동안 `GRAPPLE_SEND_INTERVAL`(= `BEAM_SEND_INTERVAL`, ≤ 4 Hz)마다 `imp grapple {o, p}` 를
    다시 보낸다. `RemoteImplants` 는 와이어가 이미 켜져 있을 때 온 것을 **갱신**으로 읽어 스파크 · 부착음을 다시
    내지 않고, 그 점이 몸 위(`radius + height` 안)에 있는 공중 드론 복제본에 끝을 묶어 **갱신 사이에도 드론을 따라가게**
    한다. 묶는 것은 갱신 메시지에서만 한다 — 벽 앵커는 한 번만 보내므로 옆에 뜬 드론에 잘못 묶이지 않는다.
  - **드론 조종 중.** `ImplantSystem.piloting`(= `player.droneControl`, 없으면 `drones.controlled`) 이면 `active` 가
    false 라 Q · 좌클릭 · 근접키를 읽지 않고 오버차지 채널이 끊기며, `activate()` 도 거부한다. `drone:controlChanged
    {id ≠ null}` 에서 `stow()`(장착형 대전차포 · 방패 집어넣기 + 갈고리 해제 + 채널 종료), 이벤트를 놓쳐도
    `update` 가 조종 중에 들고 있는 것을 발견하면 같은 `stow()` 를 부른다.

- **2026-09-10 (임플란트 HUD 이전 · 크로스헤어 갈고리 표시)** — **이 폴더의 코드는 한 줄도 바뀌지 않았다.**
  HUD 가 크로스헤어 좌측 세로 게이지에서 **화면 중앙 하단의 가로 썸네일**(`ui/hud/ImplantWidget`, `.imp-hud`)로
  옮겨 가고 갈고리 표시가 크로스헤어 좌측에 생겼는데(`ui/hud/Reticle` 의 `.rgrap`), 둘 다 **기존 `ImplantsRef`
  값과 기존 이벤트만** 읽어서 그린다 — 읽기 질의를 새로 열 필요가 없었다 (`implant:grappleTargetChanged` 가 이미
  `castGrapple` 과 같은 판정을 매 프레임 내보내고 있다). 표시 유형 분류는 `장착 UI` 절에 적어 두었다.
- **2026-09-09 (갈고리 쿨타임 2배)** — `IMPLANT_GRAPPLE_COOLDOWN` 6 → 12 s (`data/constants.csv` 만 바뀌었다, 코드 무변경).
- **Phase 7** — overcharge beam replicated over `imp beam {target, self}` (≤ 4 Hz, immediate off) and drawn by `RemoteImplants` (caster socket → target chest, self glow)

- **Phase 9** — `raycastBarrier` is a **pure** query and `damageBarrier(owner, point, amount?)` is the single damage entry point (a per-tick line-of-sight test no longer chews the shield), the owner re-sends `imp barrier` on `flow rejoined` so a late joiner sees a standing shield, the duplicate `'revive'` buff branch moved out (gadgets own it), `debugBeam(peerId)` for the tests

- **Phase 10** — the 배리어 is a **shield carried in hand** (`mode: 'wielded'`, so Q takes it out, `blocksWeapons` holsters the gun and Q or a weapon key puts it away — the 대전차포 flow, and remote hand-device replication comes free from `PlayerSnapshot.imp`). `BarrierField` follows the carrier (`raise` / `lower` / `follow`, `IMPLANT_BARRIER_CARRY_*` sizing, panel plane at `IMPLANT_BARRIER_CARRY_OFFSET` — which **must** stay > `PLAYER_RADIUS` or enemy hitscan clamps to the capsule first), `intersect` gained an `IMPLANT_BARRIER_CARRY_ARC` front gate (it was double-sided), a raised shield regenerates after `IMPLANT_BARRIER_CARRY_REGEN_DELAY`, `ImplantDevice` finally has a real `barrier` branch (it was falling through to the scanner dish), `imp shield {up, hp}` replaces `imp barrier`, and `barrierCarried` / `getBarrierPose` are published

- **Phase 12 (2026-09-08)** — 방패 **3.2 m 폭**(`IMPLANT_BARRIER_CARRY_WIDTH`), `resolveBarrierCollision`(버그를 로컬 · 피어 방패의 앞면으로 밀어내고 소유자를 돌려준다), `absorbFrontalAttack`(`_ARC` 안 3 m 이내의 정면 근접은 방패가 받는다 — 로컬은 여기서 hp 차감, 피어는 `ee barrierHit`), **실드 배쉬**(`bashing`; 방패를 든 채 LMB / `Keys.MELEE` → `consumeStamina` 25, `startMelee('heavy')` 포즈, 방패 폭 상자 안 모든 적에게 `55 × meleeDamageMul`, `EnemySystem.pushBack` 넉백, `implant:bashed` + `imp bash`), **정찰 = 즉발 1회**(이동 중 사용, 70 m, 15초, 쿨 30; `revealScan` = `detect:reveal` + `scan:cast` + `enemies.setXray`, `imp scanCast` 로 각 피어가 자기 월드에서 드러낸다)
