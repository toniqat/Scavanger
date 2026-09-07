# Phase 11 계획서 — 행성 선택 · 소셜 (2026-09-07)

사용자가 요청한 두 덩어리(**[행성 선택]** 터미널 개편 + **ESC 소셜 화면 / 커뮤니티**)를 구현하는 페이즈.
Phase 7 · 9 · 10 과 같은 방식: `src/shared` 계약은 리드가 **먼저 작성·커밋했다** (`net / types / events / constants /
Keybinds / profile / GameContext / index` 의 `appended (Phase 11)` 구역 + 새 파일 `planets.ts` · `social.ts` +
`src/shared/README.md` 마지막 절). 각 에이전트는 **자기 폴더만 소유**하고 계약은 읽기만 한다 (append 가 꼭 필요하면
리드에게 보고). `/* Phase 11 skeleton */` 표시는 typecheck 를 통과시키기 위한 자리이며 **구현으로 교체**한다.

`CLAUDE.md` 를 먼저 읽고, 자기 폴더의 `README.md` 를 읽은 뒤 작업한다. 끝나면 둘 다 갱신한다.
**다른 폴더의 파일은 절대 편집하지 않는다.** 병렬 실행 중에는 vite full-reload 가 스모크를 죽이므로
`npx vite --port 5299` 같은 개인 인스턴스를 쓰거나 조용한 창에서 돌린다.

## 0. 사용자 결정 (AskUserQuestion, 2026-09-07)

| 항목 | 결정 |
|---|---|
| 진행 방식 | shared 계약 선작성 → 폴더별 병렬 에이전트 → `npm run verify:all` |
| 소셜 백엔드 | **서버 프로필 문서 + 토큰 파생 아이디**. `ProfileRecord.social` (서버가 읽고 쓴다), 아이디는 PeerId 에서 파생한 8자 `PlayerCode` (`AB3D-9KMN`). 프리즌스(접속 · 함선/임무 · 분대 인원)는 서버가 알려준다 |
| 행성 구성 | **기존 5개 바이옴 = 5행성**, 기존 콘텐츠 재조합. 신규 적 · 신규 아이템 없음 |
| 터미널 | 전체화면. **중앙 = 행성 홀로그램**, 좌우 사이드 섹션에 기존 매치메이킹(신호 찾기 / 코드로 도킹 / 신호 송출 · 공개 / 도킹 해제 / 승무원 목록 / 시뮬레이션 훈련장)을 그대로 유지 |
| 행성 선택 권한 | 공유 함선에서는 **호스트만**. 개인 함선은 본인 |
| 소셜 노출 범위 | ESC 우측 소셜 패널도, 우측 상단 커뮤니티 아이콘도 **함선에서만** (레이드 중 ESC 는 지금처럼 좌측 버튼만) |
| 이동 컷씬 | **기존 `DockingCutscene` 재활용 + 워프** (`HUB_TRAVEL_DURATION` 4.5 초, 절차적 지오메트리만) |

## 1. 계약 요약 (읽기 전용)

전체는 `src/shared/README.md` 의 **Phase 11 — 행성 선택 · 소셜** 절. 요점:

- **`planets.ts` (신규)**: `PlanetId` 5종, `PLANET_DEFS`(이름 · 지형 · 위협 · `biome` · `sky` · `fog`/`fogMul` ·
  홀로그램 색 · `eco`), `getPlanet / isPlanetId / planetIndex / planetLabel`, `PLANET_NONE_LABEL`,
  `PLANET_THREAT_LABELS`, `PLANET_STORAGE_KEY`.
- **`social.ts` (신규)**: `PlayerCode` + `playerCodeFrom / formatPlayerCode / normalizePlayerCode /
  isValidPlayerCode`, `PresenceState` + `PRESENCE_LABELS`, `SocialCard` / `SocialPlayer` / `SocialSnapshot` /
  `SquadInvite` / `WhisperLine`, `playBlockReason` + `PLAY_BLOCK_LABELS`, `PlayOutcome`, `SocialErrorCode` +
  `SOCIAL_ERROR_MESSAGE_KO`, 캡 상수, `SocialRecord`(서버 소유), `SocialRef`.
- **`net.ts`**: `LobbyState.planet?`, `lobby:planet`, `lobby:start.planet?`, `game:start.planet?`,
  `LobbyErrorCode 'no_planet'`, `welcome.social?`, `social:*` 7개 up / 5개 down,
  `NetRef.lobbyPlanet / setLobbyPlanet / startGame(seed, mode?, planet?) / social`.
- **`types.ts`**: `HubRef.planet / setPlanet / travelling`, `WorldRef.planet`, `ChatKind 'whisper'`.
  **`GameContext.missionPlanet`** — `game:newMission` 을 emit 하는 쪽이 emit **전에** 세팅한다 (`missionMode` 와 동일).
- **`events.ts`**: `game:newMission.planet?`, `world:ready.planet?`, `net:gameStarting.planet?`,
  `hub:planetChanged`, `hub:travel`, `hub:terminalToggled`, `social:updated / invited / inviteClosed / whisper /
  play / error`, `ui:communityToggled`, `chat:whisperTo`.
- **`constants.ts`**: `HUB_TRAVEL_*`, `PLANET_HOLOGRAM_*`, `PLANET_SWAP_TIME`, `COMMUNITY_BLOCKER`,
  `SOCIAL_CARDS_PER_ROW / SOCIAL_FRIEND_ROWS / SOCIAL_RECENT_ROWS`, `SQUAD_VOICE_DEFAULT`, **`Keys.INVITE` = P**.
- **리드가 이미 처리한 것**: `progression/ProgressionSystem` 의 문서화되지 않은 `P` 캐릭터 시트 토글 **제거**
  (P 는 이제 `Keys.INVITE`), `server/Lobby.ts` 의 `LOBBY_ERROR_MESSAGE_KO.no_planet`.

## 2. 전 폴더 공통 규칙

- **커서 규약(Phase 10)은 그대로**: 커서를 쓰는 화면은 `uiBlockers.add(TOKEN)` → `ctx.input.setCursorMode(true, TOKEN)`,
  닫을 때 그 반대. `exitPointerLock()` 을 호출하지 않는다. **예외는 `ui/menus/MenuBase` (`'menu'`)** — Esc 일시정지
  메뉴는 지금 코드 그대로 둔다.
- **행성은 항상 `PlanetId` 문자열로만 오간다**. 인덱스로 보내지 않는다 (`PLANET_IDS` 는 UI 순서용).
- **아이디(`PlayerCode`)만 오간다**. 다른 사람의 `PeerId` 는 클라이언트에 절대 내려가지 않는다.
- 서버 없이(오프라인 / 솔로) 게임은 **전부 그대로 동작해야 한다**: 행성 선택은 로컬(`PLANET_STORAGE_KEY`),
  소셜은 `SocialRef.available === false` 로 "소셜 기능을 사용할 수 없습니다" 안내만.
- 헤드리스 스모크는 **시뮬레이션 시간**(`ctx.time`, `waitSim`)으로 기다리고, 키 탭은 keydown+keyup 을 같은 프레임에
  `document.body` 로 (`bubbles:true`) 보낸다.

## 3. 폴더별 작업

### 3-1. `server/` — 소셜 저장소 · 프리즌스 · 초대 · 귓속말 · `lobby:planet`

**(A) 소셜 저장소** (`Store.ts`).
- `ProfileRecord.social` (`SocialRecord`) 를 읽고 쓴다. 지금 `profiles` 맵은 private 이고 `get()` 이 **없는 id 를
  만들어 버리므로**, 최소 `getIfExists(id)` 와 코드 → PeerId 역인덱스가 필요하다 (`load()` 에서 인덱스 재구축).
- 첫 접속 때 `social` 이 없으면 만든다: `code = playerCodeFrom(peerId)`, 충돌(다른 PeerId 가 이미 그 코드)이면
  `salt` 를 1 씩 올려 재파생. `name` 은 소켓의 `?n=` / `lobby:name` 으로 갱신, `level` 은 `social:me` 로 갱신.
- `sanitizeRecord` 에 `social` 정화 추가 (배열 길이 캡, 잘못된 코드 제거, 자기 자신 제거, friends ∩ incoming 제거).
  `profiles.json` 은 여전히 debounce 저장, placeholder 레코드는 저장하지 않는다.
- 캡: `SOCIAL_FRIEND_MAX` · `SOCIAL_REQUEST_MAX` · `SOCIAL_RECENT_MAX`.

**(B) 프리즌스 + 팬아웃** (`RelayServer.ts`).
- 사실은 이미 다 있다: 접속 = `clients.has(id)`, 로비 = `lobbies.lobbyOf(id)`, 임무 = `player.inMission`,
  종류 = `lobby.mode`. `PresenceState` 로 접는다 — **그레이스 중(`connected:false`)은 `offline`**.
- **로비 밖으로 나가는 push 채널이 없다**: `broadcast()` 는 로비 멤버만 돈다. `id → 그 사람을 친구로 가진
  접속자 집합` 인덱스를 만들고 (연결 / 해제 / 로비 join·leave / `lobby:mission` / `game:start` / `lobby:planet` 시
  갱신) 관련 있는 사람에게만 `social:state` 를 보낸다. 폴링 금지. `close()` 에서 인덱스도 정리한다.
- `welcome.social` 에 스냅샷을 담는다 (토큰이 있는 접속만; 익명은 아예 없음).
- `SocialSnapshot` 해석: 각 코드 → 프로필 → `SocialPlayer {code, name, level, presence, squad, joinable}`.
  `joinable` 은 `playBlockReason(target, mySquad, NET_MAX_PLAYERS, isSelf) === null`.

**(C) 요청 처리** (`parseClientMessage` + `handle`).
| 메시지 | 규칙 |
|---|---|
| `social:get` | 스냅샷 회신. 프로필 없음 → `social:error unavailable` |
| `social:me {level}` | 정수 클램프(0..999) 후 저장, 친구들에게 push |
| `social:request {code}` | 자기 자신 `self` · 없는 코드 `not_found` · 이미 친구/요청 `already` · 캡 `limit`. 양쪽 레코드에 기록하고 **양쪽에** `social:state` |
| `social:respond {code, accept}` | `incoming` 에 없으면 `invalid`. 수락 → 양쪽 `friends` 에 추가 + 양쪽 `recent` 에서 제거. 거절 → 요청만 삭제. 양쪽 push |
| `social:remove {code}` | **상호** 삭제, 양쪽 push |
| `social:play {code}` | ① 대상 오프라인 `offline` · 임무 중 `in_mission` · 분대 4명 `full` ② **대상이 로비에 있음** → 내가 (없거나 나 혼자인) 로비를 떠나고 대상 로비에 `add` → 나에게 `lobby:state` + `social:play {outcome:'joined'}`, 대상 로비에는 `lobby:state`. 내 로비에 다른 멤버가 있으면 `busy` ③ **대상이 로비 없음** → 내 로비가 없으면 먼저 비공개 로비를 만들어 주고(`lobby:state`), 대상에게 `social:invited {invite}`, 나에게 `social:play {outcome:'invited'}` |
| `social:whisper {code, text}` | 텍스트 trim + `SOCIAL_WHISPER_MAX` 잘라내기, 빈 문자열 `invalid`. 대상 접속 중 아니면 `offline`. 대상에게 `social:whisper {code: 내 코드, name: 내 이름, text, at}` |

- **최근 만난 플레이어**: 한 로비에 2명 이상이 함께 있게 된 순간(join / quickmatch / `social:play` 로 합류) 각 쌍의
  양쪽 레코드 `recent` 에 `{code, at}` 를 최신순으로 기록한다 (이미 친구면 넣지 않는다, `SOCIAL_RECENT_MAX` 초과분은
  가장 오래된 것부터 버린다). 친구가 되면 `recent` 에서 빠진다.

**(D) `lobby:planet`** — 호스트 · 미시작 전용, 알 수 없는 id 는 `invalid`, `lobby.planet` 저장 후 `lobby:state`
브로드캐스트. `lobby:start` 는 `mode !== 'training'` 인데 `planet` 이 없으면 `no_planet`; 있으면 `lobby.planet` 에
반영하고 `game:start {..., planet}` 으로 내려보낸다. `reset()` 은 planet 을 **유지**한다 (임무가 끝나도 목적지는 그대로).

**(E) `selftest.ts`** — `/* ═══ part 8: Phase 11 — 행성 + 소셜 ═══ */` 배너를 `try` 안 마지막에 추가.
행성(호스트만 / 미시작만 / 알 수 없는 id / `no_planet` / `game:start.planet` / reset 후 유지), 소셜(코드 파생 ·
친구 요청 → 수락 → 상호 삭제 · 프리즌스 전이 · 최근 목록 · 귓속말 라우팅 · `social:play` 세 분기 · 캡).
`expectNone` 으로 부정 검증, 시간이 필요한 것은 자체 서버를 nested `try/finally` 로 띄운다. **총 체크 수가 늘어나면
`server/README.md:17` 과 `src/net/README.md` 의 "194" 표기를 새 숫자로 갱신한다.**

### 3-2. `src/net/` — `SocialSync` · 행성 와이어

- **`SocialSync.ts` (신규)**: `SocialRef` 구현. `welcome.social` / `social:state` → 미러 + `social:updated`,
  `social:invited` → `invites` 에 push (+ `SQUAD_INVITE_TTL_S` 만료 타이머 → `social:inviteClosed {reason:'expired'}`,
  `SQUAD_INVITE_MAX` 초과 시 오래된 것 제거), `social:whisper` → `social:whisper {line}`, `social:play` →
  `social:play`, `social:error` → `social:error`. `acceptInvite` 는 `net.joinLobby(invite.lobby)` 를 호출하고
  `inviteClosed {reason:'accepted'}`. `setLevel` 은 `SOCIAL_ME_DEBOUNCE_MS` 로 debounce.
  `playBlock(code)` 은 `playBlockReason(row, 내 분대 인원, NET_MAX_PLAYERS, code === me.code)`.
  연결이 끊기면 `available=false`, 목록 비우고 `social:updated` (초대는 버린다).
- **`NetClient.ts`**: `SERVER_TYPES` 화이트리스트에 `social:state / invited / whisper / play / error` 추가.
  `MAX_INBOUND_BYTES` 는 그대로 (스냅샷은 작다).
- **`NetSystem.ts`**: 스켈레톤 교체 — `social` 은 `SocialSync` 인스턴스, `lobbyPlanet` / `setLobbyPlanet`(낙관적 미러
  + `lobby:planet`), `startGame(seed, mode?, planet?)`. `game:start` 핸들러(`:668-679`)와 `beginSession` 에서
  **`ctx.missionPlanet` 을 `game:newMission` emit 전에** 세팅하고 `net:gameStarting.planet` / `game:newMission.planet`
  에 실어 보낸다. `rejoinMission()` 은 `lobby.planet` 을 쓴다. `applyLobby` 에서 `planet` 이 바뀌면 아무 이벤트도
  내지 않는다 — 컷씬은 hub 가 `net:lobbyUpdated` 를 보고 판단한다 (계약대로 별도 메시지 없음).
- `progress:levelUp` / `progress:loaded` 를 듣고 `social.setLevel(ctx.progression.level)` 를 호출한다 (net 이
  progression 을 읽는 것은 기존에도 하던 방식 — `ctx.progression?.level`, 없으면 skip).
- **`scripts/e2e-multiplayer.mjs`** 에 두 클라이언트 시나리오 추가: 호스트가 행성을 고르면 게스트의 `lobby.planet` /
  `ctx.hub.planet` 이 따라오고, 게스트는 `setPlanet` 이 거부되며, 친구 요청 → 수락 → 프리즌스가 서로 보이고,
  귓속말이 도착한다. 기존 103 체크는 깨지지 않게 유지하고 새 숫자를 README 에 적는다.

### 3-3. `src/hub/` — 전체화면 터미널 · 행성 선택 · 이동 컷씬 (가장 큰 레인)

**(A) `ui/HubMenu.ts` 전체화면 개편.**
- 루트에 `.fullscreen` 을 붙여 `.frame` 이 화면을 꽉 채우게 한다 (`hub.css`). 3열 레이아웃:
  **좌측** = 기존 `신호` 섹션(개인 함선) / `공유 함선` 섹션(코드 · 초대 링크 · 공개 전환 · 승무원 4행 · 도킹 해제),
  **중앙** = 행성 홀로그램 + 이름 · 지형 · 위협 badge · 한 줄 브리핑 + `◀ ▶` + 중앙 하단 **행성 이동** 버튼,
  **우측 하단** = `시뮬레이션 훈련장` 섹션, 그리고 **닫기 (Esc)** 버튼.
- **`승무원` 섹션(이름 입력 · `hub-crew-name` · 힌트)은 삭제**한다. 호출명은 타이틀 화면에서만 정한다
  (`ctx.housing.lockCrewName()` 호출도 함께 사라진다). `.seed-hint` 는 그대로 둔다 (`/seed` 안내).
- 좌우 이동: `◀ ▶` 클릭, `←/→`(그리고 `A/D`) 키. 선택만 바꾸는 것은 즉시(프리뷰), **실제 이동은 `행성 이동`** 버튼.
  이미 그 행성이면 버튼은 `현재 목표` 로 비활성. 비호스트는 `호스트만 지정할 수 있습니다` 로 비활성.
  카운트다운 중 · 이동 중에도 비활성.
- `hub:terminalToggled {open}` 을 emit (기존 `ui:hubMenuToggled` 도 유지).
- 커서 규약은 지금 코드 그대로 (`'hub'` 토큰 + `setCursorMode`).

**(B) `ui/PlanetHologram.ts` (신규)** — Phase 10 의 초상화(`PlayerRef.createPortraits`)와 같은 방식으로 **자체
`THREE.WebGLRenderer`** 를 가진 `PLANET_HOLOGRAM_PX` 정사각 캔버스. `interiors/Starfield.ts` 의 `Planet` 클래스를
그대로 재사용해 `PlanetDef.hologram / hologramAtmo` 색으로 구체 + 대기 셸을 만들고, `PLANET_HOLOGRAM_SPIN` 으로
자전 · `PLANET_HOLOGRAM_TILT` 로 기울인다. 스캔라인 · 와이어 링 같은 홀로그램 연출은 절차적 지오메트리로.
행성 교체는 `PLANET_SWAP_TIME` 동안 페이드/슬라이드. 터미널이 닫히면 렌더 루프를 멈춘다 (`isOpen` 게이트).

**(C) 행성 상태 · 이동 컷씬** (`HubSystem.ts`).
- 스켈레톤 교체: `planet` 은 로비가 있으면 `net.lobbyPlanet`, 없으면 로컬 값(`PLANET_STORAGE_KEY` 에서 복원 / 저장).
  `setPlanet` 은 (호스트 아님 / 알 수 없는 id / `travelling` / 카운트다운 중) 거부, 성공 시 `startTravel(planet)`.
- `startTravel(planet)`: 모든 포드 하차 · 터미널/작업대 닫기 · `hub:travel {stage:'start', planet}` →
  `DockingCutscene` 을 `direction: 'travel'` 로 (`HUB_TRAVEL_DURATION`, `HUB_TRAVEL_WARP_FRACTION`,
  `HUB_TRAVEL_WARP_STRETCH` 로 별을 늘이고 목적지 구체가 창밖에 나타난다) → 끝나면 `travelling=false`,
  `hub:travel {stage:'end'}` + `hub:planetChanged {planet, by}`, 함선 내부는 **다시 만들지 않는다**
  (배경만 바뀐다 — `disposeInterior` 금지).
- **비호스트 동기화**: `net:lobbyUpdated` 에서 `lobby.planet` 이 내가 알던 값과 다르면 `startTravel(…, by:'squad')`.
  로비에 처음 들어갔을 때(`docking`)는 컷씬 없이 값만 채운다.
- 창밖 행성: `PersonalShip` / `SharedShip` 의 장식 `Planet(...)` 을 현재 행성 색으로 만들고 이동이 끝나면 갱신한다.
- **발사 슬롯 게이트**: `podCanInteract` 에 `planet !== null` 추가, `podPrompt` 는 `목표 행성 미지정 — 터미널에서 지정`.
  `travelling` 중에도 탑승 불가.
- `launch()`: 솔로는 `ctx.missionPlanet = planet` 후 `game:newMission {seed, mode:'raid', planet}`,
  로비 호스트는 `net.startGame(seed, 'raid', planet)`. `startTraining()` 은 행성을 넘기지 않는다(훈련장은 무관).
- `updateTerminalScreen()` 에 `목표 <행성 이름>` 줄 추가 (미지정이면 `PLANET_NONE_LABEL`).

**(D) 스모크 `scripts/smoke-planets.mjs` (신규, ~45 체크)** — 터미널 열기 → 좌우 이동 → `행성 이동` →
`hub:travel` start/end → `ctx.hub.planet` · 창밖 행성 색 · 터미널 화면 줄, 미지정 상태에서 포드 프롬프트/거부,
지정 후 탑승 가능, 가짜 로비(`hud.debugRemotes` 방식으로 `ctx.net` 를 흉내내지 말고 **솔로**로 검증) — 로비 경로는
`e2e:mp` 가 본다. 마지막에 `game:newMission.planet` 이 실려 나가는지 확인.

### 3-4. `src/ui/` — ESC 재배치 · 설정 패널 · 커뮤니티 · 귓속말 (두 번째로 큰 레인)

**(A) ESC 재배치** (`menus/PauseMenu.ts` + `base.css`).
- 버튼 열(`.actions`)을 **화면 좌측**으로 (프레임을 좌측 정렬 + 세로 중앙). 버튼 구성 · 문구 · `game:paused` 흐름은
  그대로. 레이드/함선 분기(`returnBtn` 의 `display`)도 그대로 유지한다.
- **함선일 때만** 우측 소셜 열(`.pause-social`)을 붙인다: 상단 **분대원**(로비 없으면 미표시) · 중앙 **친구**
  (`SOCIAL_FRIEND_ROWS` 만큼 보이고 세로 스크롤) · 하단 **최근 플레이어**(`SOCIAL_RECENT_ROWS`, 최대
  `SOCIAL_RECENT_MAX`). 레이드 중 ESC 는 지금과 동일(좌측 버튼만).
- **분대원 행**: 좌측 간단 프로필(아이디 · 레벨), 우측 **보이스 슬라이더 + 음소거 토글** — `SQUAD_VOICE_DEFAULT`,
  값은 컴포넌트 안에만 저장하고 아무 것도 하지 않는다(보이스 채팅 미구현). 툴팁/힌트로 `보이스 채팅 준비 중` 표기.
- **프로필 패널**(`menus/social/ProfileCard.ts` 등, `SOCIAL_CARDS_PER_ROW` = 가로 2개): 좌측 아이디
  (`formatPlayerCode`) + 이름, 우측 레벨, 프리즌스 점/라벨(`PRESENCE_LABELS`).
- **우클릭 컨텍스트 메뉴**: `같이 하기` (`social.playBlock` 이 null 일 때만 활성, 아니면 `PLAY_BLOCK_LABELS` 를 사유로
  비활성) · `귓속말하기` (ESC 를 닫고 `chat:whisperTo` emit) · `친구 삭제`(친구일 때만, **확인 팝업** 후
  `removeFriend`) · `친구 추가`(친구 아닐 때만, `requestFriend`). 받은 친구 요청 행에는 `수락` / `거절`.
- `social:updated / play / error` 를 듣고 다시 그리고, 실패는 `Notifications.push` 로 알린다.

**(B) 설정 패널** (`menus/SettingsMenu.ts`).
- 오버레이를 **좌측 중앙 패널**로 (`.settings-menu.side`), 내용은 `오디오`(전체 · 효과음) + `키 설정`:
  키 설정 안에 **`ControlsPanel`**(키보드 + 마우스 다이어그램 + 기능별 목록)을 그대로 인스턴스화하고 그 아래
  `KEYBIND_BUTTON_LABEL` 버튼 → `KeybindMenu.open()`. 타이틀 화면 구성과 동일하게 보이면 성공.
- 블로커/Escape 처리(현재: 토큰 없음, capture keydown, `keybinds.isOpen` 이면 양보)는 **그대로 유지**.
- `dispose()` 에서 `ControlsPanel.dispose()` 를 먼저 부른다 (`TitleMenu` 와 같은 순서).

**(C) 커뮤니티 아이콘 · 초대 패널** (`hud/Community.ts` 신규, social 레이어).
- `ShipManageHint` 와 같은 방식: `socialRoot` 에 붙고, 매 프레임 `ctx.isHubPhase()` 로 self-gate.
  우측 상단(`right: 32px; top: 28px`)에 커뮤니티 아이콘 + **썸네일**, 썸네일 **내부 우측 하단**에 접속 중 친구 수
  (`social.onlineFriends`), 받은 친구 요청이 있으면 **썸네일 우측 상단에 레드닷** (`social.hasNews`).
  `.cheat-tag`(top 64px)와 겹치므로 치트 태그가 켜져 있을 때의 좌표를 확인한다.
- 클릭하면 커뮤니티 패널을 연다: **ESC 의 소셜 열과 같은 컴포넌트를 재사용**해 친구 / 최근 / 요청을 보여주고,
  `COMMUNITY_BLOCKER` 토큰 + `setCursorMode(true, COMMUNITY_BLOCKER)`, `ui:communityToggled` emit, Esc 로 닫힌다.
- **분대 초대 패널**: 썸네일 **아래**에 `SQUAD_INVITE_MAX` 개까지 쌓인다. 아이디 · 이름 · `P 홀드로 참여` +
  하단 게이지(`SQUAD_INVITE_HOLD_S`, `InteractionPrompt` 의 `scaleX` 바 방식). `Keys.INVITE` 를 **함선에서만**
  누적하고(다른 블로커가 없을 때) 다 차면 `social.acceptInvite(from)`. 만료/수락은 `social:inviteClosed` 로 사라진다.

**(D) 귓속말** (`hud/ChatLog.ts`).
- 대상 상태를 갖는다: `chat:whisperTo {code, name}` 이 오면 입력창을 열고 `.chat-target` 칩(`→ 이름`)을 붙인다.
  Enter 전송은 `ctx.net.social.whisper(code, text)` 로 나가고 로컬 라인은 `kind:'whisper'`.
  `social:whisper {line}` 을 듣고 받은 귓속말도 `whisper` 라인으로 그린다(`line.out` 으로 방향 구분).
  칩의 X(또는 빈 입력에서 Esc)로 대상 해제 → 평소 채팅. 대상이 오프라인이면 `whisper()` 가 false → 실패 라인.
  `.chat-line.whisper` CSS 추가. 채팅창은 **함선에서도** 열려야 한다 (이미 그렇다 — 블로커만 없으면 된다).
  귓속말 대상이 있는 동안에는 채팅창 위치를 스펙대로 **화면 중앙 좌측**으로 올린다(`.hud-bl.whispering`).

**(E) 결과 화면 · 재배치** (`menus/MissionComplete.ts`) — `다시 배치 (같은 시드)` 는 `ctx.missionPlanet` 을 함께
실어 보낸다 (`game:newMission {seed, planet}`), 그렇지 않으면 같은 시드인데 행성이 바뀐다. 결과/사망 화면 제목 옆에
행성 이름(`planetLabel(ctx.missionPlanet)`)을 한 줄 넣는다.

**(F) 스모크 `scripts/smoke-social.mjs` (신규, ~60 체크)** — `HudSystem` 에 `debugSocial(snapshot, invites)` 훅을
추가해(기존 `debugRemotes` 와 같은 방식) 가짜 스냅샷으로: ESC 좌측 버튼 위치 · 함선에서만 보이는 우측 열 ·
카드 2열 · 우클릭 메뉴 4개 항목의 활성/비활성 · 친구 삭제 확인 팝업 · 커뮤니티 썸네일의 접속 수/레드닷 ·
초대 패널 P 홀드 게이지 → 수락 · 귓속말 칩과 `whisper` 라인 · 설정 패널의 다이어그램 + 키 설정 버튼.

### 3-5. `src/world/` + `src/enemies/` — 행성 지형 · 생태계

**(A) `world/`**
- `WorldSystem.generate(seed, mode)` 가 `game:newMission.planet`(없으면 `ctx.missionPlanet`)을 받아
  `this.planet` 에 저장하고, `this.biome = planetBiome(planet) ?? pickBiome(seed)` 로 고른다
  (`biomes.ts` 에 `biomeById(id)` 추가; `pickBiome` 은 폴백으로 남긴다 — 계약 문서에 그렇게 적혀 있다).
- `world:ready` 에 `planet` 을 실어 보낸다. `WorldRef.planet` 스켈레톤 교체.
- `Gather.ts`: `resolveHerbIds` 의 균등 1/3 을 **행성 가중치**(`eco.herbs`)로 바꾼다. `variant`(모양)와 `defId`
  (아이템)를 **분리**해야 한다 — 지금은 `herbIds[variant % len]` 로 묶여 있다. 노드 수는
  `GATHER_NODES_PER_MISSION × eco.gatherDensity` 로 반올림. 훈련장은 지금처럼 채집 없음.
- 훈련장(`mode:'training'`)은 planet 을 null 로 두고 아무것도 바꾸지 않는다.

**(B) `enemies/`**
- `EnemySystem` 의 `world:ready` 핸들러에서 `ctx.world.planet` → `getPlanet(...)?.eco` 를 스포너/웨이브/가드에
  넣는다 (없으면 지금 동작 그대로 = 기본 생태계).
- `Spawner.ts`: `ambientGroup(threat)` / `waveGroup(index, count)` 의 하드코딩 계단을 **가중 추첨**으로 바꾼다.
  **기존 위협 게이트는 유지**(가중치가 있어도 threat 가 열리지 않으면 등장하지 않는다) → 난이도 곡선 불변.
  `MAX_ARTILLERY` / `MAX_BEHEMOTH` / `cap` 은 `eco.maxArtillery` / `eco.maxBehemoth` / `× eco.pressure` 로.
  생태계가 없으면 지금 숫자를 그대로 쓰는 기본값을 둔다.
- `RogueGuards.placeRogueGuards`: 밀도 `× eco.rogues`(0 이면 배치 없음), `eco.boss` 가 false 면 보스는 시드가
  뽑을 때만. 시드 결정성은 유지한다 (같은 시드 + 같은 행성 = 같은 배치).
- 리플리카/호스트 계약은 건드리지 않는다 — 생태계는 **호스트에서만** 스폰 구성을 바꾼다 (`es` / `ee` 그대로).

**(C) 스모크 `scripts/smoke-ecology.mjs` (신규, ~40 체크)** — 콘솔 없이 `window.__game` 으로 행성별
`ctx.world.planet` · 바이옴 id · 채집 아이템 분포(30개 이상 샘플의 가중치 근사) · 노드 수 · 앰비언트 스폰 구성에
금지 타입이 없는지 · 로그 가드 수 · 같은 시드+행성 재생성 시 동일성.

### 3-6. 리드(나) 소유

- **`src/core/`**: `Atmosphere.applyPlanet(def): SkyPalette` — 이름으로 `SKY_PALETTES` 를 찾아 적용하고
  `fog=false` 면 `fog.density = 0` + `scene.background` 를 하늘의 `horizon` 으로, `fog=true` 면
  `fogDensity × fogMul`. `Engine` 의 `world:ready` 핸들러가 `planet` 이 있으면 `applyPlanet`, 없으면 기존
  `applySeed`. `toneMappingExposure` 는 두 경로 모두에서 유지.
- **`src/game/`**: `GameFlowSystem.onNewMission` 에서 `ctx.missionPlanet = planet ?? (mode==='training' ? null :
  ctx.missionPlanet)` 로 방어적으로 확정 (emitter 가 이미 세팅하지만 `MissionComplete` 재배치 경로가 있다).
- `scripts/verify.mjs` 에 새 스모크 3개(`smoke-planets` / `smoke-social` / `smoke-ecology`) 를 폴더 맵에 등록.
- 문서: `CLAUDE.md` 폴더 맵 · 커맨드 목록 · 마지막 업데이트 · Known follow-ups, `docs/VERIFICATION.md` 결과.

## 4. 검증

각 에이전트: `npm run typecheck` (+ server 레인은 `typecheck:server`, `net:selftest`) → 자기 스모크.
리드: 전부 합친 뒤 `npm run verify:all` (build + `net:selftest` + `e2e:mp` + 전 스모크).
결과는 `docs/VERIFICATION.md` 에 기록한다.
