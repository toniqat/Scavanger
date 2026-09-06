# Phase 9 계획서 — Known follow-ups II (2026-09-06)

`CLAUDE.md` 의 **Known follow-ups** 중 사용자가 고른 10 항목을 구현하고 메모를 지우는 페이즈. Phase 7 과 같은 방식:
`src/shared` 계약은 **이미 작성·커밋되어 있다** (`types / net / profile / events / constants / housing / implants / labels / meta` 의
`appended (Phase 9)` 구역 + `src/shared/README.md` 마지막 절). 각 에이전트는 자기 폴더만 소유하고 계약은 읽기만 한다
(append 가 꼭 필요하면 리드에게 보고). `/* Phase 9 skeleton */` 표시는 typecheck 를 통과시키기 위한 자리이며 **구현으로 교체**한다.

`CLAUDE.md` 를 먼저 읽고, 자기 폴더의 `README.md` 를 읽은 뒤 작업한다. 끝나면 둘 다 갱신한다. **다른 폴더의 파일은 절대 편집하지 않는다.**

## 0. 사용자 결정 (AskUserQuestion, 2026-09-06)
| 항목 | 결정 |
|---|---|
| 프로필 오프라인 동기화 | 문서마다 타임스탬프(`profile:set.at` = 저장 시점의 `serverNow()`), 서버는 **최신 쪽이 이김**(`docsAt`), 오프라인 편집은 `ProfileSync` 가 큐에 보관해 재접속 때 밀어넣는다. meta / progression / housing 은 자체 큐 없이 `profile.set` 만 호출(inventory 의 자체 큐는 제거). 스타터 킷 같은 기본 저장은 `fresh` 로 보내 실제 프로필을 덮지 않는다 |
| 호스트 이전 · 고스트 빈틈 | `RemotePlayerRef.ghostState / ghostDownHp` 를 net 가 채우고 game 의 자체 맵 삭제. 스냅샷 `dhp` 로 고스트가 실제 다운 체력을 이어받음. 서버는 `started` 중 **임무 안에 접속된 멤버가 없으면 이전하지 않고**(호스트 자리 보류) 누군가 돌아오면 그때 이전. 페이지 새로고침 = 임무 이탈(`lobby:mission false`, 서버의 중복 소켓 경로도 동일) + 호스트는 고스트를 `NET_GHOST_PARK_S` 동안 **주차**(시뮬레이션 · 표적 · 전멸 판정 제외, 재합류 시 복원만) |
| 늦은 합류 동기화 | `stratq sync` → `strat sync`(호스트가 동기화 권위), `metaq sync` → `meta sync`(피어 간, 요청자당 미션당 1회), 배리어는 `flow rejoined` 에 소유자가 `imp barrier` 재전송. 은폐는 이미 스냅샷 플래그라 추가 없음. pickups / gadgets / gather 는 `net:hostChanged {isLocalHost:false}` 에 재요청(계약이 약속했던 것). 릴레이 계약 검증: `amount` 유한 · 1..`META_HIT_MAX`, goal / corp 화이트리스트, 진척 clamp |
| e2e 커버리지 | 2-클라이언트 훈련 합류, `contq take → cont taken / denied`, `imp beam` 수신 + `RemoteImplants.debugBeam`, 델타 스냅샷 후 적 수 재확인 |
| 소규모 정리 | 화상 킬 = 불 놓은 사람(`applyStatus(..., attacker)`, `enemy:killed.by`), 점프대 플레이어별 재발동 `JUMP_PAD_RETRIGGER_S`, 포기 홀드 `player:giveUpProgress` + HUD 바, `raycastBarrier` 순수 질의 + `damageBarrier` |
| 서재 책장 | 스킬당 책 1권(14권, `ItemCategory 'book'`, `ItemDef.book.skill`), 2–4 티어 상자 · 로그 시체 · 세레스 상점(신뢰도 2). 책장 `furn_bookshelf`(서재, 6칸). 보너스 = `1 + BOOK_XP_PER_BOOK × Σ BOOK_RARITY_MUL`, 상한 `BOOK_GAIN_MAX`, `housing.getSkillGainMul` 에 합산(progression 무변경). 도감은 책장 패널 안 + 함선 탭의 절. 상태는 `ShipState.books / bookDex`(v3). 책장 회수 시 책은 창고로 |
| 훈련장 타겟 모드 | `TrainingMode` 고정 / 이동 / 타임 코스, 아레나 안의 **모드 콘솔** `training_mode`(순환) + **무기 거치대** `training_rack`(→ `inventory.openCatalog({category:'primary'})`, 종료 시 기존 복원으로 원상복구). 클라이언트 로컬(와이어 없음). HUD 는 `TrainingPanel`(점수 · 남은 시간) |
| 델타 적 스냅샷 | `es` 는 델타, `NET_ENEMY_KEYFRAME_S` 마다 + `flow rejoined / takeover` 직후 키프레임, `seq` / `gone`, 변경 필드만. 미지 id 의 델타는 무시(`ee spawn` / 키프레임이 채움) |

## 1. 계약 요약 (읽기 전용)
- `types.ts`: `ItemCategory 'book'`, `ItemDef.book / BookDef {skill}`, `InventoryRef.openCatalog(opts?: {category?})`, `EnemyManagerRef.applyStatus(..., attacker?)`,
  `TrainingMode / TRAINING_MODES / TRAINING_MODE_LABEL_KO`, `TrainingRef` (`mode / setMode / score / hits / remaining / bestTime / startCourse / resetScore`), `WorldRef.training`.
- `profile.ts`: `ProfileRecord.docsAt?`, `PROFILE_CLOCK_SKEW_MS`, `ProfileRef.set(key, doc, {fresh?})` — **오프라인에서도 버리지 않는다**.
- `net.ts`: `profile:set {at?, fresh?}`, `PlayerSnapshot.dhp?`, `EnemyWire` 필드 옵셔널(델타) + `EnemySnapshot.seq / gone?`, `NET_ENEMY_KEYFRAME_S`, `NET_GHOST_PARK_S`, `META_HIT_MAX`,
  `strat sync {calls: StratagemCallWire[]}` + `stratq sync`, `meta sync {corp, hits}` + `metaq sync`, `RemotePlayerRef.ghostState? / ghostDownHp? / downHp?`.
- `events.ts`: `enemy:killed.by?`, `player:giveUpProgress`, `training:modeChanged / scored / courseFinished`, `housing:booksChanged`, `ui:bookshelfToggled`.
- `constants.ts`: `JUMP_PAD_RETRIGGER_S`, `BOOKS_PER_SHELF / BOOK_XP_PER_BOOK / BOOK_RARITY_MUL / BOOK_GAIN_MAX`, `TRAINING_MOVING_* / TRAINING_COURSE_* / TRAINING_BEST_STORAGE_KEY`, `SHIP_STATE_VERSION` 3.
- `housing.ts`: `ROOM_PURPOSES_ACTIVE += 'library'`, `FurnitureModelKind / FurnitureInteraction += 'bookshelf'`, `furn_bookshelf`, `PlacedBook`, `BookSlotInfo`, `ShipState.books? / bookDex?`,
  `HousingRef.getBooks / placeBook / takeBook / getOwnedBooks / getBookBonus / getBookDex / openBookshelfMenu`.
- `implants.ts`: `ImplantsRef.damageBarrier(owner, point, amount?)`; `raycastBarrier` 는 순수 질의. `labels.ts`: `book` 라벨 / 색 / 아이콘. `meta.ts`: 세레스 stock `{category:'book', minRepLevel:2}`.

## 2. 서버 + 네트 + e2e (`server/`, `src/net/`, `scripts/e2e-multiplayer.mjs`) — 한 에이전트
### 프로필 (newest wins)
- `server/Store.ts`: `ProfileRecord.docsAt` 저장 + `sanitizeRecord` 에서 숫자 clamp. `setDoc(id, key, doc, at?, fresh?)`: `fresh`(또는 `at` 없음) → 키가 없을 때만 저장(있으면 무시, 에러 아님);
  `at` 있음 → `at = min(at, Date.now() + PROFILE_CLOCK_SKEW_MS)`, `at >= (docsAt[key] ?? 0)` 일 때만 저장하고 `docsAt[key] = at`. 오래된 문서는 조용히 버림(`lobby:error` 없음). `RelayServer` 는 `at / fresh` 를 넘긴다.
- `src/net/ProfileSync.ts`: `set` 은 `available` 과 무관하게 `pending` + `pendingAt`(= `serverNow()`; `fresh` 는 stamp 없음) 에 넣고, 연결돼 있을 때만 디바운스 flush. `flush` 는 `{t:'profile:set', key, doc, at | fresh}`.
  `onWelcome / onDocs`: 서버 `docsAt[key] > pendingAt[key]` 이면 pending 을 버리고 서버 사본, 아니면 pending 이 덮고 flush. `onDocs` 도 `migrated = profile.credits === null` 로 계산. `too_large` 를 받으면 그 키의 pending 제거(영원히 재시도하지 않음).
- `NetSystem.serverNow()`: 첫 `welcome` 이후에는 **연결이 끊겨도** 마지막 오프셋(단조 `performance.now()` 기반)을 유지한다. `Date.now()` 폴백은 welcome 을 한 번도 못 본 세션뿐.
### 고스트 · 호스트 이전 · 새로고침
- `Snapshotter`: `isDowned` 이면 `dhp = round(downHp)`. `RemotePlayer.push` 가 `downHp` 를 보관, `applyGhost` 가 `ghostState = g.st`, `ghostDownHp = g.dhp`, `clearGhost` 가 둘 다 undefined. `DebugRemoteRef` 도 같은 필드.
- `onHostChanged` (`NetSystem`): `_inSession` 게이트를 `lobby.started` 로 완화해 `net:hostChanged` 는 항상 emit(각 시스템은 이미 라이브 미션 밖에서 no-op), `flow takeover` 송신은 `_inSession` 일 때만.
- `onWelcome`: `lobby.started && !seamless && !_inSession && me.inMission` 이면 `applyLobby` 직후 `lobby:mission {inMission:false}` 전송(새로고침 = 임무 이탈). `rejoinMission()` 은 그대로 true 로 되돌린다.
- 서버 `Lobby.migrateHost()`: `started` 이면 후보는 **접속된 inMission 멤버뿐**; 없으면 이전하지 않는다(false). `remove()`(유예 만료)에서도 같은 규칙 — 단, inMission 멤버가 한 명도 안 남았으면(모두 나감) `reset()` 후 일반 이전.
  호스트가 끊긴 상태에서 inMission 멤버가 재접속하면(`connection` 경로) 지연 없이 `migrateHost()` 재시도 + `lobby:state`. 중복 소켓 교체 경로(`CLOSE_DUPLICATE`)는 `setInMission(id, false)`(새 페이지 = 임무 이탈).
- `selftest.ts`: 프로필 `at` 최신/구식/`fresh`/skew clamp, `docsAt` 왕복, 이전 보류 규칙(임무 밖 멤버만 접속 → 호스트 유지 → inMission 멤버 재접속 → 즉시 이전), 중복 소켓 → `inMission false`.
### e2e (`scripts/e2e-multiplayer.mjs`) — 아래 그룹 추가, `scripts/README.md` 의 검사 수 갱신
- **훈련 합류**: 레이드가 끝나고 공유 함선으로 돌아온 뒤 B(비호스트)가 `ctx.hub.startTraining()` → A 에서 `lobby.mode==='training'`, B 만 `inMission`, A 는 `phase 'hub'`; B 는 `missionMode 'training'` + `world.mode`. A 가 `startTraining()`(합류 = `rejoinMission`) → 둘 다 inMission, 원격 아바타 각 1. B 가 `training:exitRequested` 로 나감 → `net:missionMembership` 반영, A 가 나가면 서버가 로비 reset (`lobby.started false`).
- **컨테이너 권위**: 레이드 중 B 가 `ctx.world.getCrates()[0]` 옆으로 `teleport` → `crate:open` → `container:searchDone` 대기(또는 `searched` 강제) → `quickMove` 가 `'pending'` → A(호스트)의 `containers.get(id)` taken 반영, B 가방 증가 + `pendingTakeUids()` 비움; A 가 같은 idx 를 먼저 가져간 뒤 B 재요청 → `cont denied` + 토스트.
- **오버차지 빔**: 공유 함선에서 A `ctx.implants.setEquipped('overcharge')`, 미션에서 `pointerLockElement` 를 canvas 로 스텁하고 B 를 A 의 정면 6 m 에 `teleport`, `KeyQ` keydown 유지 → B 에서 `onMessage('imp')` beam `{target: B}` + `audio:play overcharge_beam` + `getSystem('implants').debugBeam(aId).on === true`; keyup → `target null`, `debugBeam(...).on false`.
- **델타 스냅샷**: 기존 적 수 비교를 3 s 대기 후 한 번 더, 호스트 이전 블록 뒤에도 한 번 더(`|host − client| ≤ 3`).

## 3. 플레이어 + 게임 (`src/player/`, `src/game/`) — 한 에이전트
- `createGhost`: `ref.isDowned` 이면 `downHp = clamp(ref.downHp ?? PLAYER_DOWN_HP, 1, PLAYER_DOWN_HP)`. 승격 재구성은 `lastGhost` 우선(그대로).
- **주차된 고스트**: `dropGhost(id)` 가 `net:missionMembership {inMission:false}` / `net:peerSuspended {suspended:false}` 로 불릴 때 `GhostWire` 를 `parked: Map<id, {wire, until: ctx.time + NET_GHOST_PARK_S}>` 에 보관하고 `ghost gone` 브로드캐스트(아바타는 스냅샷 모드로). `flow rejoined` 시 활성 고스트가 없고 주차 항목이 있으면 그 wire 로 `ghost restore` 를 보낸다(그 뒤 삭제). 만료는 `updateGhosts` 에서. `onPeerSuspended {suspended:false}` 의 early return 은 유지하되 **재합류 없이 돌아온 멤버**(`inMission` 이 false 로 바뀜)는 위 경로로 주차된다.
- `smoke-ghost.mjs`: "suspending a downed ref → full down pool" 기대를 `downHp` 상속으로 바꾸고(`debugSpawn` 에 `downHp` 옵션), 주차 → 재합류 복원 검사 추가.
- **포기 홀드**: `updateDowned` 에서 `player:giveUpProgress {t: giveUpHold / PLAYER_GIVE_UP_HOLD}`(≤ 20 Hz, 변화 시), 놓거나 `clearDowned` 면 `{t:-1}`.
- `GameFlowSystem`: `ghostStates` 맵과 `net:ghostState` 구독 삭제 → `isRemoteAlive` 는 `r.suspended ? (r.ghostState ?? 0) !== 2 : …`. 주차된(inMission false) 멤버는 이미 `!inMission` 로 제외된다.
- `smoke-raidflow.mjs` / `smoke-phase2.mjs` 에 give-up 진행 이벤트 검사 추가.

## 4. 스트라타젬 + 임플란트 + 가젯 (`src/stratagems/`, `src/implants/`, `src/gadgets/`) — 한 에이전트
- **strat sync**: 비호스트 클라이언트는 `world:ready` 에 `stratq sync` 를 host 로; 호스트는 `stratq sync` 와 `flow rejoined` 에 `strat sync {calls}` 를 그 peer 에게(`eta = landsAt − ctx.time`, `st` 는 손상된 구조물만, `looted`). 수신: 이미 아는 `callId` 는 건너뛰고, `createCall(kind, p, eta, seed, false, callId, caller)` 후 `eta ≤ 0` 이면 즉시 착지 fast-forward(구조물 obstacle + 보급 상자 interactable 등록) → `setStructureHp`. 쿨다운은 동기화하지 않는다(개인 상태).
- **배리어**: `raycastBarrier` 에서 `onBarrierBlocked` / spark 제거(순수). `damageBarrier` 스켈레톤을 그 자리로(로컬 = `onBarrierBlocked`, 원격 = spark). `flow rejoined` 수신 시 자기 배리어가 활성이면 `imp barrier {active:true, p, yaw, hp}` 를 `from` 에게 unicast.
- **buff revive 이중 적용**: `ImplantSystem.onBuff` 의 `'revive'` 처리 삭제(계약: gadgets 소유).
- `RemoteImplants.debugBeam(peerId): {on, target, self, until} | null` + `ImplantSystem.debugBeam` 위임(e2e 용).
- **점프대**: `Deployable.padNext: Map<PeerId|'local', number>`; `updateLocalEffects` 는 `padNext.get('local') ?? 0 > ctx.time` 이면 스킵, 발사 시 `ctx.time + JUMP_PAD_RETRIGGER_S`. `0.7` 리터럴 삭제(`padCooldown` 은 프레임 내 중복 방지용으로만).
- **화상 크레딧**: `updateFireZone` 의 `applyStatus(..., 'burning', …, d.owner)`.
- **호스트 이전 재동기화**: `GadgetSystem` 이 `net:hostChanged {isLocalHost:false}` 에 `gadq sync` 재요청.
- 스모크: `smoke-stratagems.mjs`(합성 `strat sync` 수신 → 콜 · 구조물 · hp 재현, 호스트 `stratq sync` 응답), `smoke-tactical.mjs`(점프대 2 s 안에 정확히 1회, 배리어 LOS 질의가 hp 를 깎지 않음 + `damageBarrier` 가 깎음).

## 5. 무기 + 픽업 (`src/weapons/`, `src/pickups/`) — 한 에이전트
- `Blocking.raycastBlockers` 는 결과만 돌려주고, **실탄 명중 경로**(`WeaponSystem` hitscan 해석, `Projectile` 세그먼트)는 배리어가 최종 히트일 때 `ctx.implants.damageBarrier(r.owner, r.point)` 를 1회 호출. `WeaponHost.lineOfSight` 는 순수 질의 그대로(이제 안전).
- `Flamethrower.ts` / `Shockgun.ts`: `applyStatus(..., ctx.net?.localId ?? 'local')`.
- `PickupSystem`: `net:hostChanged {isLocalHost:false}` → `itemq sync` 재요청. `REST_Y.book` 은 스켈레톤으로 이미 있음(픽업 실루엣 목록에 `book` 추가는 선택).
- 스모크: `smoke-weapons.mjs` 에 배리어 명중 → `implant:barrierHit` 1회, LOS 질의 0회 검사.

## 6. 적 (`src/enemies/`)
- **델타 스냅샷** (`net/HostSync.ts`): `SnapshotCache`(id → 마지막 송신 필드, 반올림된 값 기준 비교). `encodeSnapshot(active, time, cache, force)`: `seq` 단조 증가; 키프레임(`force` 또는 `seq % (NET_ENEMY_KEYFRAME_S × NET_ENEMY_SNAPSHOT_HZ) === 0`)은 전 필드 + `full:true`; 델타는 변경된 적만, 변경 필드만(`ty` / `w` 는 캐시에 없던 첫 등장에만), `gone` = 캐시에 있었는데 이번에 제외된 id. `reset()` / `promote()` 에서 캐시 초기화 + 다음 스냅샷 강제 키프레임. `flow rejoined / takeover` 수신(호스트) → `forceFullNext`.
- `net/Replica.ts`: `seq` 는 `msg.seq`; `ReplicaBuffer.applyWire(now, w)` 가 최신 샘플 위에 존재하는 필드만 덮어쓴다(`push` 는 `adopt` / `spawn` 용). `seenSeq` 는 `full` 에서만 찍고 sweep 도 `full` 에서만; `gone` 은 항상 release(`dead` 는 시체 타이머에 맡김). 미지 id + `ty` 없음 → 무시. 스켈레톤 guard 교체.
- **화상 크레딧**: `Enemy.burnAttacker: TargetId | null`; `applyStatus(..., attacker)` 가 저장(`'burning'` / `'incinerated'`); `updateStatuses` 의 DoT 는 `applyDot(…, e.burnAttacker ?? e.lastDamager)`; `onHitRequest` 는 `from` 을 `applyStatusBits` 로 전달; `onEnemyKilled` 가 `enemy:killed.by` 채움(로컬 = `net.localId ?? 'local'`, 원격 = peer, ai = null), `Replica` 의 `ee kill` 도 `by: msg.killer`. 크레딧된 원격 peer 에게 `hitc {killed:true}` 를 보내 킬 히트마커.
- **적 사격 vs 배리어**: 로그 `fireGun` 히트스캔 / 곡사 착탄 전 `ctx.implants.raycastBarrier(origin, dir, dist, true)` 로 막히면 `damageBarrier(owner, point)` + 피해 없음(가젯 `blocksProjectile` 과 같은 자리).
- 스모크: 새 `scripts/smoke-enemy-delta.mjs`(솔로에서 `encodeSnapshot` 을 직접 호출: 첫 스냅샷 키프레임, 정지 적은 델타에서 빠짐, 이동 적은 `p` 만, hp 변화만 `hp`, `gone`, 키프레임 주기, `applyWire` 로 복제 갱신, 미지 id 무시; `applyStatus` attacker → `enemy:killed.by`) 를 `scripts/verify.mjs` 에 등록(`folders: ['enemies','net']`).

## 7. 하우징 + 아이템 + 프로그레션 (`src/housing/`, `src/items/`, `src/progression/`) — 한 에이전트
- **items**: `BOOK_ITEM_DEFS` 14권(`book_<skill>`, `category 'book'`, `book:{skill}`, 1×2, `stackMax 1`, weight 0.6, rarity 는 스킬별로 섞어서 common 4 / uncommon 5 / rare 3 / epic 2), `ITEM_DEFS` 에 splice, 루트 `categoryWeights` 티어 2–4 에 `book: 3 / 3 / 2`, `ROGUE_*` 시체 테이블에 `book` 드랍(rogue 3 %, boss 20 %). 제작 불가.
- **housing**: `ShipState.books / bookDex` + `sanitize`(placed 책장 uid 검증, slot 범위, `ItemDef.book` 검증, v3), `freshState` 에 빈 배열. `Rules.bookGainMulFor(skill, books)`; `HousingSystem.getSkillGainMul = skillGainMulFor(...) × getBookBonus(skill)`; `placeBook / takeBook / getBooks / getOwnedBooks / getBookDex`(bookDex 는 `placeBook` 에서 추가), `recover()` 는 `dropBooksOf(uid)` 로 책을 창고로(공간 없으면 회수 거부 사유 `책을 먼저 빼세요`). `housing:booksChanged` + `changed('books')`. 새 `ui/BookshelfMenu.ts`(`HousingPanel`, page `'bookshelf'` → `wirePage` null, `ui:bookshelfToggled`): 책장 칸(꽂기 / 빼기), 보유 서적(`buildItemChip`), **도감** 절(14 스킬 행: 이름 · 보유 여부 · 현재 배율). `ShipView` 우측 방 목록 아래에 **도감** 절(같은 렌더러) 추가. 스켈레톤 교체.
- **progression**: `ProgressionRef.getSkillGainMul` 주석을 "사격장 × 서재" 로 갱신; `smoke-progression.mjs` 에 fake housing `getSkillGainMul` 가 XP 에 곱해지는 검사 1개.
- 스모크: 새 `scripts/smoke-library.mjs`(책 def / 루트 카테고리, 서재 지정, 책장 제작 · 배치, `placeBook` 가방 → 창고 순서, 중복 슬롯 거부, `getBookBonus` 수치 · 상한, `getSkillGainMul` 합산, `takeBook`, 회수 → 창고 반환 / 공간 없음 거부, `bookDex` 유지, 저장 v3 왕복 + 손상 저장 sanitize, 패널 DOM · 도감 행, 함선 탭 도감 절) 를 `scripts/verify.mjs` 에 등록(`folders: ['housing','items','hub','inventory']`).

## 8. 월드 + 허브 (`src/world/`, `src/hub/`) — 한 에이전트
- `TrainingArena implements TrainingRef`: `mode`, 이동 모드(`updateMoving`: lane 안에서 `TRAINING_MOVING_SPAN` 왕복, `TRAINING_MOVING_SPEED`, 양 끝 `TRAINING_MOVING_PAUSE_S`; `t.root.position.x` 와 `t.entry.position.x` 를 함께 갱신하고 **셀이 바뀌면 hash remove/insert**), 타임 코스(`startCourse`: `TRAINING_COURSE_TARGETS` 격추를 `TRAINING_COURSE_TIME_S` 안에; `knockDown` 마다 `training:scored`; 완료 / 시간 초과 시 `training:courseFinished {time, score, completed, best}` + best 를 `TRAINING_BEST_STORAGE_KEY` 에 저장; 쿨다운 `TRAINING_COURSE_COOLDOWN_S`), `announce()` 의 subText 에 모드 · 남은 시간. 코스 중 `setMode` 거부.
- 콘솔 두 개(출구 콘솔과 같은 받침대): `training_mode`(x ≈ +8, 프롬프트 `표적 모드: <라벨>` → 다음 모드로 순환, `timed` 에서 다시 E = `startCourse`), `training_rack`(x ≈ +14, `무기 거치대` → `ctx.inventory.openCatalog({category:'primary'})`). `dispose` 에서 unregister. `WorldSystem.training` 스켈레톤 교체.
- `Gather.ts`: `net:hostChanged {isLocalHost:false}` → `harvq sync` 재요청.
- **hub**: `bookshelf` 빌더(책장 몸체 + `ctx.housing.getBooks(uid)` 의 채워진 칸 수만큼 책등 박스, 색은 rarity), `FurnitureCallbacks.onBookshelf(uid)` + `interact` 분기(`onRangeConsole` 폴백 앞에), `HubSystem` 에서 `ctx.housing.openBookshelfMenu(uid)`; `housing:booksChanged` → 그 방 `rebuildRoom`(`COVERED_CHANGE_REASONS` 에 `'books'`). 스켈레톤 교체.
- 스모크: `smoke-training.mjs` 에 `target modes` 절(모드 순환 · 이동 표적 x 변화 · 이동 후 raycast 명중 · 타임 코스 시작 / 득점 / 완료 이벤트 / best 저장 · 거치대 → `ui:catalogToggled` + 주무기 탭 · 종료 후 복원), `smoke-ship-rooms.mjs` 에 책장 메시 · 프롬프트 · `housing:booksChanged` 재빌드.

## 9. 인벤토리 + 메타 (`src/inventory/`, `src/meta/`) — 한 에이전트
- **inventory**: `offlineDocs / offlineArmed / suppressOfflineQueue` 삭제 → 항상 `profile.set(key, doc)`; 스타터 킷 / 시작 시 창고 리사이즈 저장은 `profile.set(key, doc, {fresh:true})`. `onProfileLoaded` 는 서버(=병합된) 사본을 그대로 적용. `openCatalog(opts)`: `category` 가 있으면 그 카테고리를 포함하는 탭으로 `catalog.setTab`. `CatalogTabId 'book'` + 탭 + 라벨. `smoke-search.mjs` 의 오프라인 우선 검사는 "오프라인 편집은 `profile.set` 큐로 간다(fake profile 의 `set` 호출 기록)" 로 교체.
- **meta**: `Storage.upload()` 의 `available` 가드 삭제(항상 `set`). `sentHits: Map<goal, number>` (미션마다 초기화, `reportContractHit` 의 send 자리에서 증가), `metaq sync` 를 재합류 `world:ready`(`net:gameStarting.rejoin`) 에 others 로; 수신 피어는 요청자당 미션당 1회 `meta sync {corp, hits}` unicast; 수신 측은 goal 별 `reportContractHit(goal, n, false)`. 검증(`contractHit` 도): `Number.isFinite`, `1 ≤ amount ≤ META_HIT_MAX`(sync 는 `def.target`), `GOAL_IDS` / `CORP_IDS` 포함, `ac.progress` 를 `MAX_PROGRESS` 로 clamp.
- 스모크: `smoke-meta.mjs`(sync 응답 1회 · 검증 거부 · clamp, 오프라인 `profile.set` 호출), `smoke-inventory-p6.mjs`(`openCatalog({category:'primary'})` 탭, `book` 탭), `smoke-loadout.mjs`(fresh 플래그).

## 10. 프로그레션 프로필 훅 · 하우징 프로필 훅 (에이전트 7 에 포함)
- `ProgressionSystem.upload()` / `ShipStore.upload()` 의 `available` 가드 삭제(항상 `profile.set`). `smoke-progression` / `smoke-housing` 의 fake profile 검사에 "오프라인에서도 `set` 이 호출된다" 1개씩.

## 11. UI (`src/ui/`)
- `hud/Vitals.ts`: `.giveup` 바(`--c-danger`, `player:giveUpProgress`, `t < 0` 숨김, `setDowned(false)` 에서 숨김).
- `hud/TrainingPanel.ts`(`ContractPanel` 복제): `ctx.missionMode === 'training'` 에서만, 모드 라벨 · 점수 `score / TRAINING_COURSE_TARGETS`(timed) · 남은 시간 · best; `training:modeChanged / scored / courseFinished` + `ui:notify` 완료 토스트.
- `Nameplates` / `Squad`: suspended 멤버의 `ghostState === 1` 이면 `ghostDownHp` 출혈 바(회색 위 빨강).
- 스모크: `smoke-ui-p5.mjs` 또는 `smoke-ui-p6.mjs` 에 합성 이벤트로 give-up 바 · TrainingPanel · 고스트 출혈 바 검사.

## 12. 검증
- 매 수정 후 `npm run typecheck` / `typecheck:server`. 에이전트 완료 후 `npm run verify`(변경 폴더 매핑). 리드가 `npm run verify:all` + `e2e:mp`.
- 여러 에이전트가 동시에 편집하는 동안 vite 풀 리로드가 스모크를 죽인다 — 각자 **사설 vite**(`npx vite --port 53xx`, HMR 소켓은 스크립트가 파킹)로 돌린다. 포트: 서버·넷 5301 / 플레이어·게임 5302 / 스트라타젬·임플란트·가젯 5303 / 무기·픽업 5304 / 적 5305 / 하우징·아이템 5306 / 월드·허브 5307 / 인벤·메타 5308 / UI 5309. 릴레이가 필요하면 `PORT=87xx npm run server` + `VITE_WS_URL`.
- `scripts/verify.mjs` 에 새 스모크를 등록할 때는 파일을 **다시 읽고** 한 줄만 append 한다(적 · 하우징 두 에이전트만 손댄다).
- 문서: 폴더 README, `scripts/README.md` 의 자기 스크립트 행, `CLAUDE.md` 폴더 맵 한 줄 + Known follow-ups 정리는 리드.
