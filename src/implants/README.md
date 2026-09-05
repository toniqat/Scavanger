# `src/implants/` — 전술 임플란트 (Tactical implants)

`ImplantSystem` 이 `ctx.implants` (`ImplantsRef`) 를 발행한다. 6종 중 **하나만** 장착해서 레이드에 들고 가며,
장착 변경은 함선에서만 가능하다 (`ctx.isRaidActive()` 면 `setEquipped` 가 `false` 를 돌려준다).

**Q** (`KEY_IMPLANT`) 가 즉발형을 시전하거나 wielded 형을 손에 들고/집어넣는다. wielded 인 동안
`blocksWeapons === true` 라서 `weapons/` 가 무기를 홀스터하고 발사를 막는다.

멀티플레이 방침: **로컬 계산 + 시각 브로드캐스트**. 모든 판정은 시전자 클라이언트에서 하고, 남들에게는
`imp` 메시지로 보여주기만 한다. 남의 캐릭터에 거는 우호 효과(회복/버프)만 `buff` 메시지로 보낸다.
서버는 수정이 필요 없다 (`GameMessage` 를 그대로 중계).

## 파일

| 파일 | 역할 |
|---|---|
| `ImplantSystem.ts` | `GameSystem` + `ImplantsRef`. 입력(Q/좌/우클릭), 충전·쿨타임, 6종 동작, 이벤트 emit, `imp`/`buff` 송수신, `raycastBarrier` |
| `ImplantDefs.ts` | `IMPLANT_DEFS` (한국어 이름/설명/아이콘/색), `getImplantDef`, `isImplantId`, `implantHex` |
| `RemoteImplants.ts` | 원격 시전자 시각화: 손의 장치, 갈고리 와이어, 배리어(복제본도 적탄을 막는다), 스캔 파동, 로켓 |
| `devices/ImplantDevice.ts` | 손에 드는 절차적 장치 모델(갈고리 런처 / 오버차지 이미터 / 스캐너 / 대전차포). 무기 소켓에 붙으며 **-Z 가 총구 방향**, `muzzle` 이 끝점 |
| `effects/Barrier.ts` | `BarrierField` — 헥사 CanvasTexture 실드 메시, 내구도, 선분 교차(`intersect`) |
| `effects/Grapple.ts` | `GrappleWire` — 와이어 빔 + 작살 헤드 |
| `effects/Overcharge.ts` | `OverchargeBeam` (2겹 빔 + 임팩트 디스크), `findAlly` / `allyPoint` (조준 원뿔 안의 아군 탐색) |
| `effects/Scan.ts` | `collectScanTargets` — 반경 안의 적/상자/채집물/목표/픽업/설치물을 `ScanTarget[]` 으로 수집 |
| `effects/AtLauncher.ts` | `RocketPool` — 풀링된 로켓, 스텝마다 스윕 레이캐스트(월드/인테리어 + 적) |
| `fx/ImplantFx.ts` | 풀링 FX: `BeamMesh`, 확장 셸(스캔), 폭발, 스트릭(대시/로켓 궤적), 스파크. **라이트 없음** |

## 6종

| id | 이름 | 방식 | 동작 | 쿨타임 |
|---|---|---|---|---|
| `grapple` | 갈고리 | wielded | 매 프레임 조준점 판정 → `implant:grappleTargetChanged`. 좌클릭 발사 → 부착 시 `player.setGrappleTarget(point)` 로 견인. 좌/우클릭·도착(2.6 m)·5초·집어넣기로 해제 | `IMPLANT_GRAPPLE_COOLDOWN` |
| `dash` | 대시 | instant | 전방 레이캐스트로 거리 산출 → 바닥 스냅 → `resolveCollision` → `ctx.player.position` 을 직접 갱신(순간이동). 충전 3 | `IMPLANT_DASH_COOLDOWN` (충전당) |
| `barrier` | 배리어 | instant(토글) | 정면 2.2 m 지점에 실드 전개. **적 발사체만** 차단, 1발당 30 hp 소모. 접었을 때 `IMPLANT_BARRIER_REGEN`/s 회복, 파괴 시 8초 잠금 | 0 (내구도가 자원) |
| `overcharge` | 오버차지 | wielded | 좌클릭 = 아군(없으면 자신) 회복 `IMPLANT_OVERCHARGE_HEAL_PER_SEC`/s. 우클릭 = 시전자+대상에 이동속도·연사속도 버프 | 0 |
| `scan` | 정찰 | wielded | 좌클릭 홀드 → 1초마다 파동, 반경 `pulse × IMPLANT_SCAN_RADIUS_STEP`, 최대 5회. 결과는 `implant:scanned` + `detect:reveal` (10초) | `IMPLANT_SCAN_COOLDOWN` (파동 종료 시 시작) |
| `atlauncher` | 대전차포 | wielded | 좌클릭 로켓 발사(조준점을 향해 보정). 착탄 시 `IMPLANT_AT_RADIUS` 광역 `IMPLANT_AT_DAMAGE` | `IMPLANT_AT_COOLDOWN` |

쿨타임에는 항상 `ctx.progression?.derived.implantCooldownMul` 를 곱한다 (특수 가방 50 % 퍼크가 이미 그 안에 있다).
`progression` 이 아직 없으면 배율 1 로 동작하고, 프로필이 없으면 첫 임플란트(`grapple`)를 임시로 장착한다.
`progress:loaded` 가 오면 프로필 값으로 교체한다.

## 다른 폴더와의 계약

**읽는 것 (전부 옵셔널 체이닝 + 기본값)**
- `ctx.player`: `position`(직접 갱신), `getForward` / `getEyePosition`, `getAimRay`·`getWeaponSocket`·`addRecoil`
  (`PlayerWeaponHost`, 런타임 `typeof` 체크), `setGrappleTarget`, `setSpeedModifier`, `heal`, `revive`, `interior`
- `ctx.world` / `player.interior`: `raycast`, `getHeightAt` / `getFloorAt`, `resolveCollision`, `isInsideBounds`, `getCrates`, `getExtractionPoints`, `getGatherNodes`(있으면)
- `ctx.enemies`: `raycast`, `queryNear`(있으면), `applyAreaDamage`(없으면 `applyExplosion`)
- `ctx.pickups`, `ctx.gadgets.getDeployables()`, `ctx.loot.getItemDef` — 스캔 결과용
- `ctx.progression.derived.implantCooldownMul`, `ctx.progression.profile.implant`
- `ctx.net`: `send` / `onMessage` / `getRemotePlayers` / `localId` / `playerName`

**쓰는 것 (emit)**
`implant:equipped`, `implant:activated`, `implant:cooldownChanged`, `implant:wieldChanged`,
`implant:grappleTargetChanged` / `grappleFired` / `grappleAttached` / `grappleReleased`,
`implant:dashed`, `implant:barrierChanged` / `barrierHit`, `implant:scanned`, `implant:overcharge`,
`implant:rocketExploded`, `detect:reveal`, `camera:shake`, `audio:play`, `ui:notify`.

**구독**: `progress:loaded`, `game:newMission`, `game:abort`, `hub:entered`, `game:phaseChanged`,
`player:died`, `player:downed`, `net:remotePlayerRemoved`.

**`raycastBarrier(origin, dir, maxDist, fromEnemy)`**
- `fromEnemy === false` → **항상 `null`** (아군 실드는 아군 탄을 막지 않는다). weapons 가 자기 탄을 이 규약으로 판정한다.
- `fromEnemy === true` → 로컬 배리어 + 복제된 원격 배리어 중 가장 가까운 교차점 `{ point, owner }`.
- **부작용 주의**: 로컬 배리어가 막으면 그 자리에서 내구도 30 을 깎고 `implant:barrierHit` 을 emit 한다.
  즉 "탄이 실제로 막혔다" 는 뜻으로만 호출해야 한다 (투기적 질의 금지).

**`buff` 메시지 수신자는 이 폴더 하나뿐이다.** `heal`/`boost`/`revive` 를 전부 여기서 로컬 플레이어에 적용한다
(gadgets 의 제세동기 `revive` 포함). gadgets 는 보내기만 할 것.

**오버차지 버프 규약**: 대상 플레이어에 `setSpeedModifier('overcharge', mul, duration)` 을 건다. player 는 이 키가
살아있는 동안 `isOvercharged === true` 로 만들고 스태미나 소모를 없애야 한다 (weapons 가 `isOvercharged` 로 연사속도 처리).

## 규칙 / 주의

- **라이트를 만들지 않는다.** 모든 발광은 emissive + additive `MeshBasicMaterial`. 씬 라이트 개수를 바꾸면 셰이더가 전부 재컴파일된다.
- FX·로켓·스파크는 전부 풀링. 핫 패스에서 `Vector3` 를 새로 만들지 않는다 (모듈 스크래치 재사용).
  `clone()` 은 버스 페이로드처럼 수신자가 보관할 수 있는 값에만 쓴다.
- `game:newMission` / `game:abort` / `hub:entered` 에서 `reset()` — FX, 로켓, 원격 시각화, 배리어, 와이어를 전부 정리한다.
  `dispose()` 는 자기가 만든 geometry/material 을 전부 dispose 한다 (공유 헥사 CanvasTexture 는 프로세스 수명 동안 유지).
- 원격 장치 모델은 `PlayerSnapshot.imp` (→ `RemotePlayerRef.implantId`) 로 구동한다. `imp wield` 는 즉시 반영용 보조.

## 필요한 SFX id (audio 담당)

`grapple_fire`, `grapple_attach`, `grapple_release`, `dash`, `barrier_deploy`, `barrier_stow`, `barrier_hit`,
`barrier_break`, `overcharge_beam`, `scan_pulse`, `rocket_fire`, `rocket_explode`, `implant_wield`, `implant_ready`.
(없는 id 는 AudioSystem 이 콘솔 경고만 내고 무시한다.)
