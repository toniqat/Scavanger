# `src/implants/` — 전술 임플란트 (Tactical implants)

`ImplantSystem` 이 `ctx.implants` (`ImplantsRef`) 를 발행한다. 6종 중 **하나만** 장착해서 레이드에 들고 가며,
장착 변경은 함선에서만 가능하다 (`ctx.isRaidActive()` 면 `setEquipped` 가 `false` 를 돌려준다).

**Q** (`Keys.IMPLANT`, 재할당 가능) 의 동작은 `ImplantDef.mode` 로 갈린다 (2026-09-06 개편):
- `instant` — 갈고리 / 대시 / 배리어: 누르면 바로 시전. 갈고리는 조준점 앵커가 유효할 때 즉시 발사, 다시 누르면 와이어를 끊는다. 총은 손에 그대로.
- `hold` — 정찰 / 오버차지: **누르고 있는 동안** 효과가 돈다 (정찰 파동 1초 간격, 오버차지 채널). 총은 손에 그대로, `holding === true`.
- `wielded` — 대전차포 (유일): Q 로 손에 들고(`blocksWeapons === true`, weapons 가 홀스터) 좌클릭 발사. Q 또는 **무기 키(1/2/3/V)** 로 집어넣는다
  (weapons 가 `stow()` 를 호출한 뒤 그 무기를 뽑는다 — 예전엔 장착형을 든 채로 무기 키가 먹지 않던 버그).

멀티플레이 방침: **로컬 계산 + 시각 브로드캐스트**. 모든 판정은 시전자 클라이언트에서 하고, 남들에게는
`imp` 메시지로 보여주기만 한다 (Phase 7 부터 오버차지 빔도 `imp beam` 으로 복제). 남의 캐릭터에 거는 우호 효과(회복/버프)만 `buff` 메시지로 보낸다.
서버는 수정이 필요 없다 (`GameMessage` 를 그대로 중계).

## 파일

| 파일 | 역할 |
|---|---|
| `ImplantSystem.ts` | `GameSystem` + `ImplantsRef`. 입력(Q/좌/우클릭), 충전·쿨타임, 6종 동작, 이벤트 emit, `imp`/`buff` 송수신, `raycastBarrier`(순수 질의) + `damageBarrier`(실제 피격), `flow rejoined` 에 배리어 재전송, e2e 훅 `debugBeam` |
| `ImplantDefs.ts` | `IMPLANT_DEFS` (한국어 이름/설명/아이콘/색), `getImplantDef`, `isImplantId`, `implantHex` |
| `RemoteImplants.ts` | 원격 시전자 시각화: 손의 장치, 갈고리 와이어, 배리어(복제본도 적탄을 막는다), 스캔 파동, 로켓, **오버차지 빔 / 자기 발광** (Phase 7, `imp beam`) |
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
| `grapple` | 갈고리 | instant | 장착 중 매 프레임 조준점 판정 → `implant:grappleTargetChanged` (Reticle 괄호). **Q** = 유효하면 즉시 발사 → 부착 시 `player.setGrappleTarget(point)` 로 견인; 도착(2.6 m)·5초·Q 재입력으로 해제. 와이어 원점은 무기 소켓(손) | `IMPLANT_GRAPPLE_COOLDOWN` |
| `dash` | 대시 | instant | 전방 레이캐스트로 거리 산출 → 바닥 스냅 → `resolveCollision` → `ctx.player.position` 을 직접 갱신(순간이동). 충전 3 | `IMPLANT_DASH_COOLDOWN` (충전당) |
| `barrier` | 배리어 | instant(토글) | 정면 2.2 m 지점에 실드 전개. **적 발사체만** 차단, 1발당 30 hp 소모. 접었을 때 `IMPLANT_BARRIER_REGEN`/s 회복. 파괴 시 `IMPLANT_BARRIER_BREAK_LOCKOUT` 10초 잠금 — 그 동안 내구도가 0 → 만충으로 정확히 차오르므로 HUD 내구도 게이지가 쿨타임 표시를 대신한다 (`barrierLockout`) | 0 (내구도가 자원) |
| `overcharge` | 오버차지 | hold | Q 를 누르고 있는 동안: 자신 `IMPLANT_OVERCHARGE_SELF_HEAL_PER_SEC`(10)/s 회복 + 조준 원뿔 안의 아군에게 `buff heal` `IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC`(25)/s (빔은 아군에게만). 체력 ≥ 90 %(`IMPLANT_OVERCHARGE_BUFF_HP_RATIO`) 인 대상(자신 / 아군)에게만 이동·연사 버프(`setSpeedModifier('overcharge')`, 짝 스태미나 버프는 없음). **에너지** `IMPLANT_OVERCHARGE_ENERGY` 6 s 를 소모하고 놓으면 `IMPLANT_OVERCHARGE_REGEN_TIME` 12 s 에 만충; 0.75 s 미만이면 시작 거부. `implant:energyChanged` | 0 (에너지가 자원) |
| `scan` | 정찰 | hold | Q 홀드 → 1초마다 파동, 반경 `pulse × IMPLANT_SCAN_RADIUS_STEP`, 최대 5회. 결과는 `implant:scanned` + `detect:reveal` (10초) | `IMPLANT_SCAN_COOLDOWN` (놓거나 5회 후 시작) |
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
- **순수 질의다 (Phase 9).** 더 이상 내구도를 깎거나 스파크를 튀기지 않는다 — 시선 판정 / 사선 검사처럼 매 틱 불러도 안전하다.
  (Phase 8 까지는 여기서 바로 30 을 깎았고, 그래서 "투기적 질의 금지" 경고가 붙어 있었다. 그 경고는 폐기.)

**`damageBarrier(owner, point, amount = BARRIER_BLOCK_DAMAGE)`** (Phase 9)
- 탄이 **실제로** 배리어에서 멈춘 지점에서 **한 번만** 부른다 (weapons 의 히트스캔 해석 · 투사체 세그먼트, enemies 의 로그 사격 / 곡사 / 산탄 착탄).
- `owner === 'local'` → `onBarrierBlocked` (내구도 −`amount`, `implant:barrierHit`, 붕괴 시 `barrier_break` + 잠금, `imp barrier` 동기화).
- 원격 소유자 → 스파크만. 그 배리어의 hp 는 소유자 클라이언트가 권위이고 `imp barrier` 로 방송한다.

**`buff` 수신은 종류마다 담당이 하나씩이다.** 오버차지의 `heal` / `boost` 는 여기서 로컬 플레이어에 적용하고,
제세동기 `revive` 와 `cloak` 은 gadgets 가 처리한다 (Phase 9 에서 여기 있던 중복 `revive` 분기를 제거했다).

**오버차지 버프 규약**: 대상 플레이어에 `setSpeedModifier('overcharge', mul, duration)` 을 건다 (채널 중 매 프레임 0.6 s 로 갱신). player 는 이 키가
살아있는 동안 `isOvercharged === true` 로 만든다 (weapons 가 `isOvercharged` 로 연사속도 처리). 스태미나 소모 감소는 2026-09-06 개편에서 제거됐다.

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

## 장착 UI (2026-09-06)
임플란트 장착은 함선 **Tab 화면**(inventory 폴더, 장비 열 아래의 임플란트 슬롯 → 클릭 → 6종 카드; 장착 중인 카드를 다시 누르면 해제)에서 한다.
터미널의 임플란트 탭과 `hub/ui/ImplantPanel` 은 삭제됐고, 함선의 임플란트 시술대(`hub_implant_bay`)는 그 Tab 화면을 연다.
HUD 는 `ui/hud/ImplantWidget` 의 크로스헤어 좌측 세로 게이지 (대시 3분할 · 배리어 내구도/잠금 · 오버차지 에너지 · 그 외 쿨타임).

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
  유니캐스트한다 (`sendBarrier(active, to)`).
- **`buff revive` 중복 제거.** `ImplantSystem.onBuff` 의 `'revive'` 분기를 삭제 — 제세동기는 gadgets 소유다 (예전에는
  두 폴더가 같은 `buff` 를 각자 적용해 부활이 두 번 걸렸다).
- **`debugBeam(peerId)`** → `{on, target, self, until} | null` (`RemoteImplants.debugBeam` 위임). `e2e:mp` 가 수신 측에서
  오버차지 빔이 실제로 그려지는지 확인하는 훅.
