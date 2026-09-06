# Phase 7 계획서 — Known follow-ups 해결 (2026-09-06)

`CLAUDE.md` 의 **Known follow-ups** 를 실제로 구현하고 메모를 지우는 페이즈. `src/shared` 계약은 **이미 작성·커밋되어 있다**
(`shared/profile.ts`, `shared/labels.ts` 신규 + `net / events / types / meta / housing / constants / GameContext / index` 의
`appended (Phase 7)` 구역, `src/shared/README.md` 마지막 절). 각 에이전트는 자기 폴더만 소유하고 계약은 읽기만 한다
(append 가 꼭 필요하면 리드에게 보고). 스켈레톤(`/* Phase 7 skeleton */` 표시)은 typecheck 를 통과시키기 위한 자리이며 **구현으로 교체**한다.

## 0. 사용자 결정 (AskUserQuestion, 2026-09-06)
| 항목 | 결정 |
|---|---|
| 서버 저장소 | **서버 프로필 + 레이드 세션**. 릴레이 서버에 토큰(PeerId)별 저장소(JSON 파일) 추가. 크레딧은 서버 소유(구매 = 서버 트랜잭션, 공간은 클라이언트 `canFit` 선확인). 메타·창고·로드아웃·프로그레션·함선 문서는 불투명 블롭으로 서버 보관, localStorage 는 캐시/오프라인 폴백. 레이드 중 인벤토리 블롭도 서버 보관. 서버 없는 싱글은 로컬 폴백 |
| 라벨 중복 | `RARITY_LABEL_KO` / `CATEGORY_LABEL_KO`(+색·아이콘·순서) → **`src/shared/labels.ts`**. items 는 재수출(이미 됨), meta 는 shared 를 import |
| 훈련장 입장 | **카운트다운 없음, 즉시 입장, 개별 합류**. 개인 함선: 사격장의 `furn_sim_hub`. 공유 함선: **터미널** 메뉴에서 시작 / 진행 중인 훈련장 합류. 좌측 파티 패널에 각 플레이어의 `훈련장` 진입 여부 표시. 탄약·내구도 미소모(종료 시 복원), `gun_*` 숙련만 상승 |
| 전멸 규칙 | **전멸 = 실패 + 부활 유지**. 스쿼드: 생존·다운·살아있는 고스트가 한 명도 없으면 실패(30초 부활 대기 중인 사망자는 사망으로 계산). 솔로: 사망 즉시 실패. 결과 화면 후 전원 함선 복귀, 로드아웃 스타터 초기화(기존 `game:over` 정책) |
| 로그 AI 2차 | **사선 차단 엄폐 + 측면 각도**, **수류탄 투척**, **재장전 주기** (저체력 후퇴 없음). 보스 체력 / 진영 HUD 없음 |

### 조사 결과 (해당 없음 → 메모만 정리)
- 가구는 이미 아이템이 아니라 `furnitureStorage` 에만 들어간다 → 메모 삭제, "가구는 아이템이 아니다" 를 원칙으로 기록.
- 구르기: 다이브 코드는 없고 구르기 하나뿐(별칭만 남음). 성능은 일반 이동보다 저렴. → 별도 구현 불필요. 정리: `player:dived` 에 `dive` + `roll` 효과음 **둘 다 재생되는 버그**(audio), 죽은 슈퍼맨 다이브 포즈 삭제(player).
- 계약 정산은 이미 "추출 실패 시 조건을 만족해도 신뢰도 없음" 규칙 → `outcome` 필드 추가 + 문구 통일만.
- 스킬북: 코드 없음. 메모 삭제, 서재 책장 수집 콘텐츠(책 장착 → 해당 스킬 상승량 증가)는 `docs/ROADMAP.md` 다음 항목으로 기록.

## 1. 계약 요약 (읽기 전용)
- `shared/profile.ts`: `ProfileDocKey` (`meta | stash | loadout | progression | ship`), `ProfileRecord {credits|null, docs, updatedAt}`,
  `RaidSessionBlob {seed, missionTime, stats, inventory, savedAt}`, `CreditsTxResult`, **`ProfileRef`** (`ctx.net.profile`: `available`, `credits`, `get/set/flush`, `addCredits(delta, reason) → Promise<CreditsTxResult>`),
  `PROFILE_SYNC_DEBOUNCE_MS` 1500, `PROFILE_DOC_MAX_BYTES`, `RAID_SAVE_INTERVAL_S` 5, `RAID_BLOB_MAX_BYTES`.
- `shared/labels.ts`: 라벨/색/아이콘/순서 (items 가 재수출).
- `net.ts`: `LobbyPlayer.inMission?`, `LobbyState.mode?`, `LobbyErrorCode` += `too_large | in_mission`; C→S `lobby:start {seed, mode?}`, `lobby:mission {inMission}`, `profile:get`, `profile:set {key, doc}`, `credits:tx {txId, delta, reason}`, `raid:save {blob}`;
  S→C `welcome.profile? / raid?`, `game:start.mode?`, `profile:docs`, `credits:result`; `NET_HOST_MIGRATE_DELAY_MS` 4000, `NET_GHOST_STATE_HZ` 2, `NET_GHOST_RESTORE_TIMEOUT_S` 3, `SUSPENDED_LABEL_KO`;
  `PlayerFlags` += `THROWING / COOKING / CHARGING / SPRAYING / HEAVY / MELEE_HEAVY`; `PlayerSnapshot.h? / att?`; `DamageMessage.kb?`; `EnemyWire.a` 12 재장전 / 13 투척; `ee grenade / grenadeHit`;
  `flow takeover`; **`GhostMessage`** (`state / sync / restore / gone`, `GhostWire {id,p,yaw,hp,dhp,st}`) + `GhostRequest` (`sync / revive`); **`ContainerMessage`** (`taken / denied / sync`) + `ContainerRequest` (`take / sync`); `imp beam {target, self}`;
  `RemotePlayerRef.suspended / inMission`; `NetRef.profile / raidBlob / saveRaid / missionMode / startGame(seed, mode?) / leaveMission / tookOver`.
- `types.ts`: `MissionMode`, `MissionStats.mode?`, `PlayerRestoreState`, `PlayerRef.restoreState / isMeleeHeavy`, `WeaponRemoteState` + `WeaponsRef.remoteState`,
  `InventoryRef.canFit / captureRaidState / applyRaidState`, `WorldRef.mode`, `EnemyManagerRef.setAuthority`, `ItemInstance.searched?`.
- `events.ts`: `game:newMission.mode?`, `training:exitRequested`, `game:raidFailed`, `net:profileLoaded / raidLoaded / hostChanged / peerSuspended / ghostState / ghostRestore / missionMembership`, `net:gameStarting.rejoin? / mode?`,
  `container:searchProgress / itemRevealed / searchDone`, `ghost:damage`, `net:remoteHeldItem`.
- `meta.ts`: `ContractSettlement.outcome?`. `housing.ts`: `FurnitureModelKind / FurnitureInteraction` += `sim_hub`, `FURNITURE_DEFS` += `furn_sim_hub`.
- `constants.ts`: `BEHEMOTH_SCALE` 3, `RAID_FAILED_AUTO_RETURN_S`, `SEARCH_TIME_BY_RARITY`, `SEARCH_MAX_DISTANCE`, `TRAINING_*`, `ROGUE_MAG_ROUNDS / RELOAD_TIME / COVER_FLANK_WEIGHT / GRENADE_*`, `GHOST_BLEED_PER_SEC`.
- `GameContext.ts`: `ctx.missionMode`, `ctx.rejoinPending`, `isTraining()`.

## 2. 서버 + 네트 (`server/`, `src/net/`) — 한 에이전트
### 서버
- **프로필 저장소** `server/Store.ts`: `ProfileStore` (PeerId → `ProfileRecord`), `dataDir` 옵션(기본 `server/data/`, `null` = 메모리; selftest 는 메모리), `profiles.json` 디바운스 저장(1 s) + 종료 시 flush. `welcome.profile` 에 레코드 첨부(없으면 `{credits: null, docs: {}}` 를 만들어 보냄).
  `profile:get` → `profile:docs`; `profile:set` (키 검증, `PROFILE_DOC_MAX_BYTES` 초과 → `too_large`); `credits:tx` → 원자 적용, 잔액 < 0 이면 `ok:false, reason:'크레딧 부족'`; `credits === null` 상태에서 첫 `credits:tx` 는 `reason 'migrate'` 로 오면 delta 를 초기 잔액으로 받아들인다(로컬 → 서버 이관).
- **레이드 세션**: `Lobby.raid: Map<PeerId, RaidSessionBlob>`. `raid:save` 는 `lobby.started && mode !== 'training' && blob.seed === lobby.seed` 일 때만 저장(아니면 무시, 크기 초과 → `too_large`). `welcome` 시 같은 조건이면 `raid` 로 돌려준다. `lobby:reset`, leave, 유예 만료, 새 `lobby:start` 에서 삭제.
- **호스트 이관**: 호스트 소켓이 `started` 중 끊기면 `NET_HOST_MIGRATE_DELAY_MS` 뒤 `migrateHost()` (연결된 `inMission` 멤버 우선, 없으면 연결된 멤버) + `lobby:state`. 그 안에 돌아오면 유지. 돌아온 옛 호스트는 `welcome.lobby.hostId` 로 자기가 클라이언트임을 안다.
- **`inMission`**: `lobby:start` 레이드 → 연결된 전원 true; 훈련 → 시작자만 true. `lobby:mission {inMission}` → 갱신 + 브로드캐스트; `inMission:true` 는 `started` 일 때만(`in_mission` 에러). 훈련에서 마지막 멤버가 나가면(전원 false) 서버가 `reset()` 후 `lobby:state`. `lobby:reset` 은 전원 false.
- **`lobby:start {mode:'training'}`**: 호스트가 아니어도 허용, ready 게이팅 없음, `started=true, mode='training'`. 레이드는 기존 규칙(호스트 + 전원 ready). 이미 started 면 `started` 에러.
- `selftest.ts` 에 새 검사 추가(프로필 get/set/too_large, credits tx 거절/이관, raid save/return, 훈련 start by non-host + inMission + auto reset, 호스트 이관 지연). README 갱신.
### 클라이언트 (`NetSystem`)
- `profile: ProfileRef` 구현(`ProfileSync.ts` 권장): welcome 의 `profile` 로 `available/credits/docs` 채움 → `net:profileLoaded`. `credits === null` 이면 `migrated:true` 로 알리고 meta 가 `addCredits(local, 'migrate')` 를 부른다. `set` 디바운스 + `flush` (`pagehide`). `addCredits` 는 `txId` 로 Promise 매칭.
- `raidBlob` (welcome.raid) → `net:raidLoaded`. `saveRaid` = `raid:save` (세션 중에만).
- `startGame(seed, mode)`, `leaveMission()` (`_inSession=false`, remotes clear, `lobby:mission false`, `net:lobbyUpdated`).
- `game:start {mode:'training'}` 수신: 내 `inMission` 이 false 면 **`game:newMission` 을 내지 않는다**(로비만 갱신, `missionInProgress` true). `rejoinMission()` 은 훈련 합류에도 쓰인다(`lobby:mission true` 전송 + `beginSession`). `net:gameStarting {rejoin, mode}`.
- **suspended**: `lobby:state` 에서 `connected` 가 false 로 바뀐 세션 멤버 → `RemotePlayerRef.suspended=true` (ref 유지, 제거 안 함) + `net:peerSuspended`; 돌아오면 false. `inMission` 미러 + `net:missionMembership`.
- **ghost** 메시지: `ghost state/sync` → 해당 ref 의 `position/yaw/hp/isDowned/isDead` 를 고스트 값으로 덮어쓴다(`RemotePlayer.applyGhost`), `net:ghostState`. `ghost restore` → `net:ghostRestore {state}` (Vector3 로 변환). `ghost gone` → 스냅샷 모드로 복귀.
- **hostChanged**: `lobby:state` 의 `hostId` 변화(세션 중) → `net:hostChanged {hostId, prev, isLocalHost}`; 내가 새 호스트면 `tookOver=true` + `flow takeover` 를 others 에 전송. `flow takeover` 수신 → 각 시스템이 sync 를 다시 요청하도록 `net:hostChanged {isLocalHost:false}` 를 낸다.
- `Snapshotter`: `ctx.weapons.remoteState` 에서 `h`, `att`, `THROWING/COOKING/CHARGING/SPRAYING/HEAVY`, `ctx.player.isMeleeHeavy` → `MELEE_HEAVY`.
- `dmg.kb` → `ctx.player.applyKnockback(d, s)`. `e2e:mp` 스크립트에 프로필 + 고스트 + 이관 검사 추가 가능하면 추가.

## 3. 게임 흐름 + 추출 (`src/game/`, `src/extraction/`) — 한 에이전트
- **전멸 = 실패**: `MISSION_FAILS_WHEN_ALL_DEAD = true`. 판정(호스트): 로컬 `isDead && !isDowned` 이고, 모든 원격 ref 중 `inMission && !(flags & IN_HUB)` 인 것들이 `suspended ? ghost st === 2 : (isDead && !isDowned)` 이면 전멸. 부활 대기 중인 사망자도 사망. 솔로: `player:died` → 2.5 s 뒤 `game:raidFailed` + `game:over` (부활 없음). 스쿼드: 호스트가 `flow over` → 모두 `game:raidFailed` + `game:over` (phase `dead`). `RAID_FAILED_AUTO_RETURN_S` 뒤 자동 `hub:enter`. 개인 부활(30 s)은 전멸 전까지 유지.
- **레이드 세션 저장**: 레이드 중(`ctx.missionMode==='raid'`, 멀티) `RAID_SAVE_INTERVAL_S` 마다 + `inventory:itemAdded` / `crate:looted` 직후 `ctx.net.saveRaid({seed, missionTime, stats, inventory: inventory.captureRaidState(), savedAt})`.
- **재합류**: `net:raidLoaded {blob}` 보관. `net:gameStarting {rejoin:true}` → `ctx.rejoinPending = true`; `world:ready` 후 `inventory.applyRaidState(blob.inventory)`, `ctx.stats = blob.stats`, `missionTime = blob.missionTime`, `ghostq sync` 요청은 net 가 `flow rejoined` 로 대신함. `net:ghostRestore` → `player.restoreState(state)`, `rejoinPending=false`, phase `playing`. `NET_GHOST_RESTORE_TIMEOUT_S` 안에 안 오면 `player.respawn(spawn)` 폴백. state 2(사망) 면 사망 흐름(부활 타이머).
- **훈련장**: `game:newMission {mode}` → `ctx.missionMode = mode` (world 보다 먼저: GameFlow 는 world 보다 늦게 등록되므로 **hub/net 가 `game:newMission` 을 emit 하기 직전에 `ctx.missionMode` 를 세팅**하도록 계약함 — game 은 `game:newMission` 핸들러에서 재확인만). 훈련 진입 시 `inventory.captureRaidState()` 를 `trainingSnapshot` 에 보관, `training:exitRequested` → `game:abort` + `applyRaidState(snapshot)` + 멀티면 `net.leaveMission()` + `hub:enter`. 훈련에서는 `awardMissionXp` / `settleMission` / 위협도 / 웨이브 없음, 사망 시 즉시 훈련 스폰에 재배치(실패 아님). `MissionStats.mode` 채움.
- **호스트 이관**: `net:hostChanged {isLocalHost:true}` → 이후 `flow` 메시지 송신 주체. `checkAllDead` 는 새 호스트가 이어받는다.
- **레벨업**: `awardMissionXp` 는 그대로; ui 가 결과 화면에서 연출.
- **추출**: `required` 에서 `suspended` 제외(고스트는 탑승 불가 → 미추출). 훈련장에서는 pad 없음(`getExtractionPoints()` 빈 배열이면 콘솔 없음). 새 호스트는 마지막 `ex` 상태에서 권위 재개(`applySyncState` 데이터를 권위 상태로 승격).

## 4. 플레이어 (`src/player/`)
- `restoreState(state)`: 헬포드 없이 `position/yaw` 에 세우고 `hp`; `state 1` → 다운 상태 진입(`downHp`); `state 2` → 사망 상태(`player:died` 없이 사망 플래그, 부활 흐름은 game). `world:ready` 에서 `ctx.rejoinPending` 이면 자동 드롭 금지.
- **고스트 시뮬레이션 (호스트, `RemotePlayerSystem`)**: `net:peerSuspended {suspended:true}` 이고 `ctx.isAuthority` 이며 세션 중이면 그 ref 의 마지막 위치/yaw/hp/다운 상태로 `Ghost` 를 만든다. enemies 는 suspended 대상을 때릴 때 `dmg` 를 보내는 대신 **`ghost:damage {id, amount, from?, kb?}`** 를 emit 하고, 호스트의 `RemotePlayerSystem` 이 받아 고스트의 hp/다운(`downHp`)/출혈(`GHOST_BLEED_PER_SEC`)/사망을 계산한 뒤 `ghost state` 를 브로드캐스트한다(변경 시 + `NET_GHOST_STATE_HZ`). `ghostq revive` → hp `PLAYER_REVIVE_HP`, st 0. `ghostq sync` / `flow rejoined` → `ghost sync`. 되돌아온 멤버가 `flow rejoined` 를 보내면 그 peer 에게 `ghost restore` 를 보내고 고스트를 제거 + `ghost gone`. 고스트의 `revive:<id>` 상호작용은 유지하되 완료 시 `revive done` 대신 `ghostq revive` 를 호스트에 보낸다. 호스트 이관 시 새 호스트는 마지막 `ghost state` 로 고스트를 재구성(`net:hostChanged {isLocalHost:true}`).
- **원격 아바타**: `suspended` → 보이게 유지(stale 여도), 회색 틴트 + 실루엣 끔, 고스트 st 에 따라 다운/사망 포즈. `THROWING` → 투척 준비 포즈, `COOKING` 손 포즈, `h` → 손에 절차적 소모품 메시(스팀 실린더 / 수류탄 구 / 가젯 상자, 카테고리는 `ctx.loot.getItemDef(h).category`), `net:remoteHeldItem` emit. `CHARGING/SPRAYING/HEAVY` → `SoldierPose.charging/spraying/heavyCarry`. `MELEE_HEAVY` → `meleeHeavy` 스윕 `SLASH_DURATION`. `ar` → 방탄복 플레이트 메시(로컬과 같은 규칙, `PlayerGear` 의 look 을 공유 헬퍼로). `OVERCHARGED` 플래그 → 아바타 발광 림.
- `applyKnockback`: 다운 중 무시, `applyImpulse` 경로(grounded 해제), 구르기 취소.
- `isMeleeHeavy` 게터. 죽은 슈퍼맨 다이브 포즈(`SoldierPose.dive`, `dvW`…) 삭제(로컬/원격 모두 0 만 씀). `player:dived` 이벤트/DIVE 비트는 유지(별칭).
- 훈련장: `training` 월드에서도 `world:ready` 드롭인은 동일(짧게), 사망 시 game 이 `respawn` 호출.

## 5. 무기 + 임플란트 (`src/weapons/`, `src/implants/`) — 한 에이전트
- `ctx.weapons.remoteState` 를 매 프레임 갱신(`heldItemId`, `throwing`, `cooking`, `charging`, `spraying`, `heavy`, `attachments` — 소켓 변경 시에만 새 배열).
- `RemoteWeapons`: 스냅샷 `att` → `WeaponModel.setAttachments` (변경 시), `HOLDING_ITEM && h` 는 player 가 손 메시를 그리므로 총 숨김 유지.
- **원격 수류탄 피해**: 복제 수류탄(visual-only)도 폭발 시 **로컬 플레이어**에게 반경 피해(자기 수류탄과 같은 규칙, 아군 피해 적용) + 카메라 흔들림. 적 피해는 기존대로 투척자 클라이언트 → 호스트.
- **로그 수류탄 시각**: enemies 가 `ee grenade` 를 처리(자기 폴더), weapons 는 관여 없음.
- 훈련장 표적: `WorldRef.raycast` 가 표적을 장애물처럼 반환하므로 명중 시 `world` 가 노출한 `DestructibleRef` 경로(Phase 3 구조물과 동일)로 피해 → 추가 작업 없음(확인만).
- **임플란트**: 오버차지 빔 켜짐/대상 변경/꺼짐 시 `imp beam {target, self}` (≤ 4 Hz 갱신 + 즉시 off). `RemoteImplants`: 빔 시각(송신자 소켓 → 대상 ref 가슴, self 면 자기 몸 발광), 대상 ref 없으면 무시. 늦게 합류한 클라이언트: 활성 빔은 다음 갱신에 자연히 보임.

## 6. 적 (`src/enemies/`)
- **로그 AI v2** (`ai/RogueAI.ts`, `ai/RogueCover.ts` 신규 권장):
  - 엄폐 선택: 후보 지점에서 표적까지 `world.raycast` 가 **장애물에 막혀야** 후보. 점수 = 거리 + `ROGUE_COVER_FLANK_WEIGHT × (1 − |sin θ|)` (θ = 표적의 시선 방향과 표적→지점 벡터의 각; 측면일수록 좋음). 기존 거리/leash 필터 유지.
  - 재장전: `magRounds` 시작 `ROGUE_MAG_ROUNDS`, 발사마다 −1, 0 이면 phase 와 무관하게 `ROGUE_RELOAD_TIME` 동안 사격 금지 + 웅크림, `a: 12`, `enemy:reloading` 없이 오디오는 `ee shoot` 대신 신규 SFX 없음(기존 `reload` 재생: `playAudio('reload', pos)`).
  - 수류탄: 표적이 `ROGUE_GRENADE_HOLD_S` 이상 LOS 밖(엄폐 뒤)이고 거리 ≤ `ROGUE_GRENADE_RANGE`, 쿨다운 0 → `ROGUE_GRENADE_WINDUP` 투척 포즈(`a: 13`) 후 포물선 투척(`RogueGrenade.ts`: 위치·속도 적분, 바운스 1회, `ROGUE_GRENADE_FUSE`). 호스트: `ee grenade` 브로드캐스트, 폭발 시 반경 `ROGUE_GRENADE_RADIUS` 안 플레이어에게 `ROGUE_GRENADE_DAMAGE` 선형 감쇠(로컬 직접, 원격 `dmg {kb}`, suspended → `ghost:damage`), 다른 진영 적에게도 피해, `ee grenadeHit`. 복제: `ee grenade` 로 시각 수류탄 비행 + `grenadeHit` FX. 모델: 로그 손의 작은 구.
- **베히모스**: `BEHEMOTH_SCALE` 3 반영(모델/히트박스 자동). `chargeHit` 원격 대상 → `dmg` 에 `kb: {d: knockDir, s: BEHEMOTH_KNOCKBACK}`.
- **고스트 표적**: `Targets.ts` 필터를 `!r.connected || (r.stale && !r.suspended) || DROPPING` 로 — suspended 는 표적 유지(hp/다운/사망은 ref 가 고스트 값). `applyDamage` 대상이 `suspended` 면 `net.send(dmg)` 대신 `ctx.bus.emit('ghost:damage', {id, amount, from, kb})` (kb 는 `{direction, speed}`).
- **호스트 이관**: `net:hostChanged` → `setAuthority(isLocalHost)`. 승격: 복제 → `Enemy` 생성(타입/위치/yaw/hp, state `idle` 이지만 `aware`), 스포너/웨이브 `ctx.missionTime` 기준 재개(추출 중이면 `startExtractionWaves` 는 extraction 이 다시 부른다), 시체 채택, `ee` 송신 시작. 강등: 시뮬 적 → 복제(다음 `es full` 에 없는 id 는 despawn). `authority` 캐시를 이 경로에서만 갱신.
- 훈련장(`ctx.isTraining()`): 스폰 없음(`world:ready` 에서 `mode==='training'` 이면 스포너 비활성).

## 7. 인벤토리 (`src/inventory/`)
- **상자 검색(타르코프)**: 컨테이너 첫 오픈 시 모든 아이템 `searched=false` (시체/보급 포함). 창이 열려 있고 플레이어가 `SEARCH_MAX_DISTANCE` 안이면 **그리드 순서(좌상→우하)로 하나씩** 검색: 시간 = `SEARCH_TIME_BY_RARITY[rarity] × (1 + (w·h−1)×0.05) ÷ derived.searchSpeedMul` (`Gear.searchTimeFor` 활용). 미검색 타일: 아이콘/이름 숨김, 칸(발자국)만 보임(`.is-hidden-item`), 검색 중 타일에 아래→위로 차는 게이지(`.inv-tile-scan`, `--p`). `container:searchProgress`(≤ 20 Hz) / `container:itemRevealed` / `container:searchDone`. 미검색 아이템은 드래그·더블클릭·컨텍스트·툴팁·모두 가져가기 불가. 창을 닫으면 진행 중이던 아이템의 진행도는 유지(재개). 검색된 아이템은 `searched=true` 로 인스턴스에 남아 재검색 없음; 가방으로 옮긴 아이템은 항상 `searched=true`; 직렬화(`Serialize.ts`)와 `PickupWire.ex` 는 `searched` 를 **싣지 않는다**(드롭된 픽업은 검색 완료로 취급).
- **호스트 권위 컨테이너**: `Container` 가 `uid → idx`(roll 순서) 를 보관. 멀티(`ctx.isMultiplayer`)에서 컨테이너→가방 이동/모두 가져가기/분할은 **요청 후 적용**: `contq take {id, idx, qty}` → 호스트가 `taken` 맵 검증 후 `cont taken` 브로드캐스트 → 요청자는 그때 가방에 넣고, 타인은 자기 사본에서 제거(열려 있으면 갱신), 아직 안 연 컨테이너는 `taken` 기록 후 첫 오픈에 적용. `cont denied` → 흔들기. 호스트 자신은 즉시 적용 + 브로드캐스트. `contq sync` / `flow rejoined` / `net:hostChanged{isLocalHost:false}` → `cont sync`. 새 호스트는 자기 `taken` 맵으로 권위 시작. 싱글은 기존 즉시 경로.
- `canFit(defId, qty)`: `canStow` 공개(가방 → hub 면 창고). `captureRaidState()` / `applyRaidState()`: `Loadout.ts` 의 직렬화 재사용(가방 배치 + 5 슬롯 + 퀵슬롯, 인스턴스 전 필드 + `searched`).
- **프로필 동기화**: `Stash.ts` / `Loadout.ts` 저장 시 `ctx.net.profile.set('stash' | 'loadout', save)`; `net:profileLoaded` 에서 해당 doc 이 있으면 로컬을 대체하고 그리드 재구성(`inventory:stashChanged`, `loadout:changed`). 훈련장 중에는 hub 저장 트리거 없음(phase 가 hub 가 아님).
- 스켈레톤(`canFit / captureRaidState / applyRaidState`) 교체.

## 8. 메타 + 프로그레션 + 하우징 프로필 훅 (`src/meta/`, `src/progression/`, `src/housing/`) — 한 에이전트
- `CorpMenu.ts` 의 사본 `RARITY_LABEL / CATEGORY_LABEL` 삭제 → `@/shared` 의 `RARITY_LABEL_KO / CATEGORY_LABEL_KO`.
- **구매 트랜잭션**: `buy` = ① `inventory.canFit(defId)` 가 null 이면 실패(`공간 없음`) ② `ctx.net.profile.available` 이면 `await profile.addCredits(-price, 'buy:'+defId)` 결과 `ok` 일 때만 아이템 생성·배치(배치 실패 시 `addCredits(+price, 'refund')`), 잔액은 서버 값으로 덮어씀; 오프라인이면 기존 로컬 경로(환불 없이 사전 체크). `buy` 는 `Promise<boolean>` 로 바꾸지 말고 **동기 false/true + 비동기 완료는 `meta:purchase` 이벤트**로 알린다(UI 는 이벤트로 갱신). `ShopItem.blocked` 에 `REASON.space` 를 `canFit` 로 채운다. `sell`/보상/판매의 `addCredits` 도 서버 tx(비동기, 로컬 낙관 적용 후 서버 잔액으로 보정).
- **프로필**: `Storage.ts` 저장 시 `profile.set('meta', save)`; `net:profileLoaded` → doc 있으면 대체(`meta:loaded`), `credits` 는 서버 값; `migrated` 면 `addCredits(local, 'migrate')`.
- `settleMission`: `outcome` 채움(`success / incomplete / failed`), `stats.extracted` 대신 `stats.mode !== 'training'` 확인(훈련장은 정산 없음 → null). 계약 목표 카운터는 훈련장에서 증가하지 않음(`ctx.isTraining()`).
- **프로그레션**: `net:profileLoaded` → `progression` doc 대체 + `progress:*` 재발행; 저장 시 `profile.set('progression', …)`. 감정 XP: `inventory:itemAdded` 대신 **`container:itemRevealed`** 로 지급. 훈련장: `addSkillXp` 는 `gun_*` 만 × `TRAINING_SKILL_GAIN_MUL`(그 외 0). `ProgressToasts` 는 ui.
- **하우징**: `ShipState.ts` 저장 시 `profile.set('ship', state)`; `net:profileLoaded` → 대체 + `housing:loaded` 재발행(hub 가 재구성). `furn_sim_hub` 는 데이터만(계약에 있음); `RoomMenu` 카탈로그에 자동 노출되는지 확인.

## 9. 월드 + 허브 (`src/world/`, `src/hub/`) — 한 에이전트
- **월드 `mode`**: `game:newMission {seed, mode}` 에서 `mode==='training'` 이면 `generateTraining(seed)`: 평평한 바닥(`TRAINING_ARENA_SIZE`), 사방 벽(장애물), 남쪽 스폰, 3 개 레인 + `TRAINING_TARGET_COUNT` 개 팝업 표적(`Obstacle.destructible`, hp `TRAINING_TARGET_HP`, 쓰러지면 `TRAINING_TARGET_RESPAWN_S` 후 복귀, 명중/쓰러짐 FX), 실내 조명 느낌의 emissive 스트립, 상자·둥지·채집·추출 없음(`getExtractionPoints()` `[]`, `getCrates()` `[]`), 출구 콘솔 `Interactable 'training_exit'` → `training:exitRequested`. `world:ready` 동일. `WorldRef.mode` 노출(스켈레톤 교체). 레이캐스트/충돌/높이 질의는 arena 용 단순 구현.
- **허브**: `furn_sim_hub` 절차 모델(홀로 받침대 + 회전 링, 발광), 상호작용 `'sim_hub'` → `startTraining()`: 로비 있으면 `net.startGame(seed, 'training')`(누구나), 없으면 `ctx.missionMode='training'` 세팅 후 `game:newMission {seed, mode:'training'}`; 이미 훈련이 진행 중(`net.missionMode==='training' && missionInProgress`)이면 `net.rejoinMission()`(합류). **`game:newMission` 을 emit 하기 직전에 `ctx.missionMode` 를 세팅**한다(솔로 경로; 멀티는 net 가 `beginSession` 에서 세팅). 공유 함선: **터미널 메뉴에 `시뮬레이션 훈련장` 항목**(`시작` / `합류 (n명 훈련 중)`; 레이드 진행 중이면 비활성 `임무 진행 중`). 발사 포드는 훈련 진행 중이면 `훈련 진행 중 — 터미널에서 합류` 안내 + 비활성. `hub:enter` 후 훈련에서 돌아온 경우 도킹 컷신 없이 공유 함선. 프리셋 콘솔은 그대로.
- 훈련장 진입 시 hub 가 함선을 teardown 하는 기존 `game:newMission` 경로 그대로.

## 10. UI (`src/ui/`)
- **결과 화면**: `RewardsBlock` 카운트업이 레벨 경계를 넘는 순간 `레벨 업` 배지 + 빛 번짐 연출 + `audio:play level_up` (유일한 재생 지점). `ProgressToasts` 의 `progress:levelUp` 토스트 제거(결과 화면이 담당). `RewardsBlock` / `MetaToasts` 의 계약 문구는 `settlement.outcome` 으로 통일(`계약 성공 / 계약 미완 · 계속 / 계약 실패 · 진척 유지 안 됨`).
- **레이드 실패**: `game:raidFailed` → `DeathScreen` 을 `레이드 실패` 모드(부활 버튼 없음, `함선으로 귀환` + `n초 후 자동 귀환`). 스쿼드 사망 관전 오버레이는 전멸 전까지 유지.
- **연결 끊김**: `Nameplates` / `Squad` 에 `suspended` → `연결 끊김` 태그(`SUSPENDED_LABEL_KO`) + 회색; `Squad` 에 `inMission`/`lobby.mode` 로 `훈련장` / `임무 중` / `함선` 배지(`net:missionMembership`, `net:lobbyUpdated`). 맵 아이콘도 회색.
- **컨테이너 검색**: DOM 은 inventory 소유 — ui 는 손대지 않음. `ChatLog`/`Notifications`: 호스트 이관 시 `호스트 변경: 이름` 시스템 라인(`net:hostChanged`), 훈련장 진입/퇴장 라인.
- 훈련장 HUD: 목표 텍스트 `시뮬레이션 훈련장 · 출구 콘솔로 종료`, 나침반/추출 마커 없음, 표적 명중 카운터(`ui:objective` subText 로 world 가 갱신).
- 기업 상점: `blocked === '공간 없음'` 회색 표시(`ShopItem.blocked` 로 자동), 구매 결과는 `meta:purchase` 이벤트로 갱신(meta 가 비동기).

## 11. 오디오 (리드)
- `player:dived` 의 `dive` 핸들러 제거(구르기 이중 재생). `progress:levelUp` 자동 재생 제거(결과 화면이 `audio:play`). 로그 재장전/수류탄은 기존 `reload` / `grenade_*` 재사용.

## 12. 검증
- `npm run typecheck` / `typecheck:server` 매 수정 후. 에이전트 완료 후 `npm run verify` (변경 폴더 매핑) → 리드가 `npm run verify:all`. 새 smoke: `scripts/smoke-search.mjs` (컨테이너 검색 게이지·searched 유지·모두 가져가기 게이팅), `scripts/smoke-training.mjs` (훈련장 생성·표적·출구·로드아웃 복원), `e2e:mp` 확장(프로필·고스트·이관·컨테이너 권위) — 각 폴더 에이전트가 자기 것을 쓰고 `scripts/verify.mjs` 에 등록.
- 문서: 폴더 README, `CLAUDE.md` 폴더 맵 한 줄 + Known follow-ups 정리는 리드.
