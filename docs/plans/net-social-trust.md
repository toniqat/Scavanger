# 소셜 · 신뢰 경로 · 연결 설계안 (2026-09-11)

[docs/TODO.md](../TODO.md) 의 **B-3 · B-4 · B-5 · B-6 · E-4 · E-5 · E-6 · B-1 · E-3** 을 어떻게 풀지 적은 설계안이다.
2026-09-11 세션에서 탐색 에이전트 3개가 코드(커밋 `3532933` 기준)를 대조했고, 이 문서는 **새 세션이 다시 탐색하지
않고 바로 계약부터 쓸 수 있게** 그 결과와 방안을 옮겨 적은 것이다. 같은 날 B-2(프로필 GC)는 구현까지 끝났다.

> **수명**: 항목이 구현되면 그 절을 지우고, 남길 것은 TODO.md(행 삭제) · 폴더 README `변경 이력` · HISTORY.md 로 옮긴다.
> 절이 다 비면 파일을 지운다.
>
> **아직 사용자 결정이 없다.** 각 절의 `결정 필요` 는 권장안을 먼저 적었을 뿐이다 — 착수 전에 묻는다.
> 줄 번호는 2026-09-11 기준이므로 편집 전에 grep 으로 다시 확인한다.

---

## 0. 요약

| ID | 한 줄 방안 | 규모 | 소유 폴더 |
|---|---|---|---|
| B-6 | `LobbyManager.move` — 참가 가능 판정을 `Lobby.canAdd` **한 함수**로 뽑아 이동 전에 검사, `lobby:left` 대신 `reason:'moved'` | S–M | server · net · hub |
| B-3 | 서버가 초대를 **상태로 들고** 수락(서버가 대신 이동 — B-6 재사용) · 거절 · 만료 · 무효를 양쪽에 알린다 | M | server · net · ui |
| B-5 | watch 인덱스를 친구 → **네 목록 전부**로, 스냅샷 push 를 **viewer 당 250 ms 에 한 번**으로 합친다 | S–M | server |
| B-4 | 서버 차단 목록 + 귓속말 **전송 확인(ack)** + 클라이언트 대화 기록(슬롯 localStorage) · 오프라인 보관은 결정 | M–L | server · net · ui |
| E-4 | ① 함선 호출은 **호스트 경유** 재방송, ② 버프(힐 · 부스트 · 소생 · 은폐)는 **받는 쪽 상한 + 거리/시야 검사**, ③ 분대 계약 킬은 **호스트의 적 사망 이벤트에서 파생** | M–L | stratagems · weapons · implants · gadgets · meta · enemies |
| E-5 | 시계 **역행 감지(최고 시각 기록)** + 음수 나이 허용 폭 + **로드아웃 문서에 "레이드 중" 표식**(저장 키 삭제 구멍) | S | game · inventory |
| E-6 | 시계 도장 → **문서 리비전(낙관적 동시성)** + 서버 **ack** + 오프라인 큐 영속화 + 여러 문서 **한 프레임 트랜잭션** | L | server · net · inventory 외 문서 소유 폴더 |
| B-1 | `ctx.net.link` 상태 + 오프라인 동안 **익명 프로브 백오프** → 함선/타이틀에서 자동 접속, 레이드 중엔 표시만 · 연결 배지 · 전이 토스트 | M | net · ui · hub · electron(조회만) |
| E-3 | `scripts/smoke-desktop.mjs` — Electron 을 `--remote-debugging-port` 로 띄워 puppeteer-core `connect`, 셸에 `--user-data=` · `--hidden` 추가 | M | electron · scripts |

**권장 진행 순서** (묶음 하나 = 계약 커밋 → 폴더별 병렬 → `verify:all`):

1. **서버 소셜 묶음** — B-6 → B-3(이동 프리미티브를 쓴다) → B-5(push 합치기가 B-3 알림도 받는다) → B-4.
2. **연결 · 저장 묶음** — E-6(프로토콜) → B-1(같은 `net/`) → E-5(작다, 따로 끼워도 된다).
3. **신뢰 경로 묶음** — E-4 (+ C-57 `crate opened`, X-6 넉백 기하 검사를 같이).
4. **E-3** 은 독립. 먼저 하면 B-1 을 데스크톱 셸에서도 자동으로 검증할 수 있다.

---

## 1. B-6 — `social:play` 의 "상대 로비로 합류" 비원자성

### 확인한 사실
- `server/RelayServer.ts` `social:play` 분기 ②: `playBlockReason` → `theirs===mine` `in_squad` · `mine.size>1` `busy` ·
  `!theirs.isJoinable()` `in_mission` → **`removeFromLobby(c.id, …, 'leave')` + `lobby:left`** → `lobbies.join` → 실패 시
  `social:error`.
- 핸들러가 **전부 동기**이고 앞선 검사(`squad < 4`, `isJoinable`)가 `Lobby.add`(`server/Lobby.ts` `freeSlot` · size ·
  `isJoinable`)와 **지금은 같은 조건**이라, 오늘 규칙으로는 떠난 뒤 참가가 실패하지 않는다. **위험은 두 검사가
  따로 적혀 있다는 것** — 한쪽에만 조건이 붙거나 사이에 비동기가 끼면 그날부터 배를 잃는다.
- 떠나는 비용이 이미 있다: 혼자인 내 로비는 `leave` 로 **삭제**되고 `planet`(목표 행성)이 사라진다. 훈련 중이었다면
  훈련도 끝난다 — 호출자 자신의 `inMission` 은 검사하지 않는다.
- 클라이언트: `lobby:left` → `net:lobbyLeft` → `hub/parts/Transitions.onLobbyLeft` 가 공유 함선이면 `undock` 컷씬.
  이어지는 `lobby:state` 는 `ship==='personal' && !cutscene` 일 때만 `dock` 을 시작한다 → **분리 컷씬 도중에 온 새
  로비는 도킹을 못 부를 수 있다** (코드 읽기로만 확인 — 착수 전에 실측).
- selftest part 8 `:1286` 부근이 `lobby:left` → `social:play joined` 순서를 단언한다.

### 설계
1. `Lobby.canAdd(): LobbyErrorCode | null` 을 뽑고 `Lobby.add` 가 **그것을 부르게** 한다 (조건의 원본이 하나).
2. `LobbyManager.move(id, toCode, name): { ok: true; from: Lobby | null; to: Lobby; fromDeleted: boolean } | { ok: false; code }`
   - `to.canAdd()` 를 **먼저** 본다 → 실패면 아무것도 안 바꾸고 돌려준다.
   - 통과하면 `leave(id)` → `to.add(...)`. `add` 가 그래도 실패하면(계약 위반) 예외로 올려 selftest 가 잡게 한다 —
     되감기(rollback) 코드는 두지 않는다: 검사 함수가 하나라 도달할 수 없고, 되감기 경로는 테스트할 방법도 없다.
3. 핸들러 ②: 호출자가 `inMission`(훈련 포함)이면 `busy` 로 거절 (새 검사). 그다음 `move`.
4. 와이어: 지금 필드가 없는 `{t:'lobby:left'}` 에 **`reason?: 'moved'` · `to?: code`** 를 더해 보내고 곧바로 새 `lobby:state`.
   클라이언트 이벤트 `net:lobbyLeft.reason` 유니온(`'left' | 'disconnected' | 'kicked' | 'hostLeft'`)에 `'moved'` 를 **추가**한다.
5. hub: `onLobbyLeft` 가 `'moved'` 면 분리 컷씬을 틀지 않고, 다음 `lobby:state` 가 도킹을 부르게 한다
   (공유 함선 A → 공유 함선 B 는 **도킹 컷씬 한 번** — `결정 필요`).

### 결정 필요
- 공유 함선에서 다른 공유 함선으로 옮길 때 연출: **도킹 컷씬만(권장)** / 분리 + 도킹 / 컷 없이 교체.

### 테스트
- selftest: `canAdd` 와 `add` 가 같은 결과 · 대상이 가득 · 시작됨 · 사라짐일 때 **내 로비가 그대로** · 훈련 중 호출자 `busy` ·
  `lobby:left reason moved` 순서. 기존 `:1286` 단언 갱신.
- `smoke-social` (mock) + `smoke-controls-hub`: `moved` 뒤 도킹이 실제로 시작되는지.

---

## 2. B-3 — 초대 결과를 보낸 사람이 모른다

### 확인한 사실
- 서버 분기 ③(`RelayServer.ts` `social:play`): 로비가 없으면 만들고 `social:invited {from, name, lobby, at}` 을 대상에게,
  `social:play {outcome:'invited'}` 를 나에게 보낸다. **서버는 초대 상태를 하나도 들지 않는다.**
- 받는 쪽 `net/SocialSync.onInvited`: 보낸 사람별 중복 제거, `SQUAD_INVITE_MAX`(3) 초과는 오래된 것부터
  `social:inviteClosed dismissed`, TTL = `invite.at + SQUAD_INVITE_TTL_S(90) − serverNow()`.
- 수락(`acceptInvite`)은 그냥 `lobby:join` 이다 — 받는 사람이 그사이 로비를 만들었으면 `in_lobby`, 가득 · 시작 ·
  해산이면 `full`/`started`/`not_found` 가 **`lobby:error` → `net:error`** 로 온다 (소셜 토스트가 아니다).
- 보낸 사람은 "…에게 분대 초대를 보냈습니다" 토스트(`ui/hud/Notifications`) 뒤로 아무 이벤트도 받지 않는다.

### 설계
서버에 **메모리 초대 표**를 둔다 (영속하지 않는다 — 서버가 꺼지면 로비도 없다).

```
invites: Map<inviteId, { id, from: PeerId, to: PeerId, lobby: code, at, timer }>
```

- 만들 때: `(from, to)` 쌍마다 하나(새 초대가 옛것을 **대체** — 옛것은 `superseded` 로 닫는다), 대상당 `SQUAD_INVITE_MAX`.
- 닫히는 길 다섯 개, 전부 **한 함수** `closeInvite(inv, outcome, reason?)` 를 지나며 **양쪽에** 알린다:
  | outcome | 언제 | 보낸 사람에게 | 받은 사람에게 |
  |---|---|---|---|
  | `accepted` | `social:inviteReply {id, accept:true}` 로 이동 성공 | "OO 님이 합류했습니다" | (합류 자체가 알림) |
  | `declined` | `inviteReply accept:false` · 카드 × | 결정 필요 (아래) | 카드 닫힘 |
  | `expired` | 서버 타이머 `SQUAD_INVITE_TTL_S` | "OO 님이 응답하지 않았습니다" | 카드 닫힘 |
  | `failed` | 로비 해산 · 가득 · 시작 · 보낸 사람이 로비를 떠남 | 사유 | 사유 |
  | `offline` | 받는 사람 소켓이 끊김 | "OO 님이 접속을 종료했습니다" | — |
- **수락은 서버가 이동을 대신한다**: `inviteReply accept` → B-6 의 `move(to, inv.lobby)` (받는 사람이 혼자 탄 로비는
  비우고 옮기고, 남과 함께면 `busy`). 그래서 수락 실패도 `social:error` 한 경로로 온다.
- 로비 이벤트(`removeFromLobby` · `reset` · 시작 · 가득 참)에서 그 로비를 가리키는 초대를 훑어 `failed` 로 닫는다.

### 계약 (추가만)
- `ClientToServer`: `social:inviteReply {id: string, accept: boolean}`
- `ServerToClient`: `social:inviteResult {id, code, name, outcome, reason?}` (보낸 사람) · `social:inviteClosed {id, outcome, reason?}` (받은 사람)
- `SquadInvite.id?: string` (옛 서버는 없음 → 클라이언트는 예전처럼 `lobby:join` 폴백)
- `SocialErrorCode` 에 `'expired'`, events `social:inviteResult`
- `NetClient` 허용 목록 · `parts/Messages` · `SocialSync` 정화기에 새 메시지 셋

### 결정 필요
- 거절을 보낸 사람에게: **"OO 님이 초대를 거절했습니다"로 구분(권장 — 친구끼리 하는 게임)** / "수락되지 않았습니다"로 만료와 합침.
- 보낸 사람 쪽에 "초대 중" 표시: 토스트만(권장, 작다) / 소셜 행에 `초대 중` 배지(`SocialPlayer.invitedByMe?`).

### 테스트
- selftest part 8: 수락 → 이동 + `accepted` 양쪽 · 거절 · 서버 타이머 만료(짧은 TTL 옵션 `inviteTtlMs`) · 대상 로비 해산 →
  `failed` · 받는 사람 끊김 → `offline` · 같은 쌍 재초대 `superseded` · 옛 클라이언트(`id` 무시)도 `lobby:join` 으로 들어온다.
- `smoke-social` mock `socialSource` 에 `inviteReply` 경로.

---

## 3. B-5 — 프리즌스 팬아웃이 친구만 · 합치지 않는다

### 확인한 사실
- `rewatch(id)` 가 **`soc.friends` 만** 인덱싱한다. 불리는 곳: 접속 · `social:respond` · `social:remove`
  (`social:request` 는 부르지 않는다). 2026-09-11 B-2 GC 뒤 목록이 바뀐 접속자도 부른다.
- `pushSocial` = **전체 스냅샷**(최대 친구 100 + 요청 50 + 최근 20 행을 매번 resolve). `pushLobbyPresence(lobby)` 는 멤버마다
  `pushPresence` → 멤버 k 명의 공통 친구는 스냅샷을 **k 번** 받는다. `lobby:mission` 토글마다 팬아웃. 합치기 · 디바운스 **없음**.
- `suspendInLobby`(분대원 소켓 끊김)는 `lobby:state` 만 방송하고 분대원 스냅샷은 밀지 않는다.
- 클라이언트 `social:get` 은 `Community.open()` 한 곳(+ `welcome.social`)뿐이다.

### 설계
1. **watch 대상을 네 목록 전부로**: `rewatch` 가 `friends ∪ incoming ∪ outgoing ∪ recent.code` 를 인덱싱한다.
   `social:request` · `recordMet` 뒤에도 양쪽 `rewatch`.
2. **push 합치기**: `pushSocial(id)` 를 즉시 보내지 않고 `socialDirty: Set<PeerId>` 에 넣고, 비어 있던 집합이면
   `setTimeout(flushSocial, SOCIAL_PUSH_COALESCE_MS)`(250) 을 건다. `flushSocial` 이 viewer 마다 스냅샷 **한 번**.
   - 요청자에게 곧바로 돌려주는 응답(`social:request` · `respond` · `remove` 의 본인)은 **즉시** 보내고 집합에서 뺀다 —
     버튼 반응이 250 ms 늦으면 안 된다.
   - `close()` 에서 타이머 해제.
3. `suspendInLobby` 에서도 `pushLobbyPresence` (합치기가 비용을 흡수한다).
4. (나중) 바이트가 문제가 되면 `social:presence {rows:[{code, presence, squad, joinable}]}` 델타. **지금은 하지 않는다** —
   스냅샷이 몇 KB 이고 합치기만으로 빈도가 잡힌다.

### 결정 필요
- 최근 만난 플레이어의 접속 상태: **항상 실시간(권장 — 합치기로 비용이 작다)** / 커뮤니티 화면이 열려 있을 때만
  (`social:watch {open}` 추가, 트래픽은 더 작지만 계약 하나 더).

### 테스트
- selftest: 최근 목록 상대가 접속/해제 → 내게 push · 요청 대상의 프리즌스 push · 4인 로비 시작 → 공통 친구가
  스냅샷을 **1개** 받는다(250 ms 창 안 카운트) · 토글 10번 → 1–2개 · 본인 응답은 합치기 없이 즉시.

---

## 4. B-4 — 귓속말 기록 · 차단 없음, 오프라인은 실패 한 줄

### 확인한 사실
- 서버 `social:whisper`: `sanitizeWhisper`(제어문자 → 공백, `<` `>` 제거, 200자) → 대상 없음 `not_found` · 소켓 없음 `offline` →
  대상에게만 전달. **에코 · 저장 · 차단 검사 없음.**
- 클라이언트 `SocialSync.whisper`: 알려진 행이 오프라인이면 로컬에서 false, 아니면 **서버 답을 기다리지 않고**
  `social:whisper {out:true}` 를 먼저 그린다 → 서버가 `offline`/`not_found` 로 답하면 **이미 그려진 줄 + 따로 오류 토스트**.
- `ui/hud/ChatLog`: 입력은 `MAX_TEXT`=**120** 자로 자르는데 서버 한도는 `SOCIAL_WHISPER_MAX`=200. 줄은 `CHAT_MAX_LINES`(60)
  메모리 뿐, 12 초 뒤 흐려짐. 클라이언트에 소셜 영속화는 없다(`shared/social.ts` 머리 주석의 설계 의도).
- 차단 · 음소거 개념이 저장소 어디에도 없다 (분대원 음소거 토글은 UI 뿐 — A-6).

### 설계
**① 차단 (서버)**
- `SocialRecord.blocked?: PlayerCode[]` (캡 `SOCIAL_BLOCK_MAX` 100), `sanitizeSocial` 이 보존.
- `social:block {code, blocked: boolean}` → 차단하면 **친구 · 요청 · 최근을 양쪽에서 정리**하고 양쪽 `rewatch`.
- 차단당한 사람이 나에게 하는 것 — 전부 **조용히 삼킨다**(상대는 차단 사실을 모른다):
  귓속말(보낸 쪽에는 전송된 것처럼 ack), 친구 요청(보낸 쪽 outgoing 에만 남고 30 일 뒤 B-2 GC 가 만료), 같이 하기 초대(보낸 쪽엔 `expired` 처럼).
- 스냅샷에 `blocked: SocialPlayer[]` (선택 필드) — 커뮤니티 화면의 `차단 목록` 에서 해제.
- 분대 채팅: `LobbyState` 멤버에 아이디가 실려 있으므로 **클라이언트가 차단한 아이디의 줄을 그리지 않는다**(`결정 필요`).

**② 전송 확인**
- `social:whisper {code, text, nonce?}` → 서버가 `social:whisperAck {nonce, ok, at?, code?: SocialErrorCode}`.
- `ChatLog` 는 보낸 줄을 **흐린 대기 상태**로 그렸다가 ack 로 확정, 실패면 그 줄을 `전송 실패 — 오프라인` 으로 바꾼다
  (지금의 "그려진 줄 + 따로 토스트" 이중 표시가 사라진다). 입력 한도는 `SOCIAL_WHISPER_MAX` 로 맞춘다.

**③ 기록 (클라이언트)**
- `slotKey('scav.whispers')` — 대화 상대 아이디별 최근 `WHISPER_HISTORY_PER_PEER`(50) 줄, 상대 `WHISPER_HISTORY_PEERS`(20)명.
  캐릭터 슬롯마다 따로, 서버에는 저장하지 않는다.
- 커뮤니티 화면 행 우클릭 메뉴에 `대화 기록` → 그 상대와의 줄 목록 + 입력칸. 채팅창에서 `/r` 은 마지막 상대에게.

**④ 오프라인 보관 (결정 필요)**
- 권장: **친구에게만** 서버가 보관 — 받는 사람당 `SOCIAL_WHISPER_INBOX_MAX`(20) 줄, `SOCIAL_WHISPER_INBOX_TTL_MS`(7 일),
  접속 시 `social:whisperBacklog {lines}` 로 한 번. 보관은 프로필 파일에 들어가므로 B-2 GC 가 함께 치운다.
- 대안: 보관 없음 — 오프라인이면 ack 가 `offline` 을 돌려주고 대기 줄이 실패로 바뀐다.

### 결정 필요
- 오프라인 귓속말 보관: **친구에게만 20줄 · 7일(권장)** / 보관 없음.
- 차단이 분대 채팅까지 가리는가: **가린다(권장)** / 귓속말 · 요청 · 초대만.
- 차단 사실을 상대에게: **숨긴다(권장)** / "차단된 상대입니다" 오류.

### 테스트
- selftest: 차단 → 목록 정리 · 차단자에게 귓속말이 안 오고 보낸 쪽 ack 는 ok · 요청 · 초대 삼킴 · 해제 · 캡 · 파일 왕복 ·
  (보관 선택 시) 오프라인 친구에게 보관 → 접속 시 backlog 1회 · 비친구는 `offline` · TTL.
- `smoke-social`: 대기 줄 → ack 확정 · 실패 줄 교체 · 기록 localStorage 슬롯 키.

---

## 5. E-4 — 호스트 검증이 없는 신뢰 경로

### 위협 모델 (먼저 합의할 것)
PvE 협동이고 PvP 가 없다. **자기 클라이언트는 원래 무엇이든 할 수 있다**(크레딧도 `credits:tx` 가 델타를 그대로 받는다 —
서버 크레딧은 "원자적" 이지 "검증된" 것이 아니다). 그래서 막을 가치가 있는 것은 **남에게 영향을 주는 위조**다:
① 분대원에게 가짜 피해(그리핑), ② 분대원 상태를 비정상으로(속도 ×100 부스트), ③ 남의 계약 보상 부풀리기.
"내가 나에게" 하는 치트는 범위 밖이다.

### 확인한 사실
| 경로 | 보내는 쪽 | 받는 쪽 | 검사 |
|---|---|---|---|
| (a) 스프레이 힐 | `weapons/parts/Healing.sprayAllies` — 거리만, **레이캐스트 없음**, 0.5 s 마다 `buff heal` 을 **그 peer 에게 직접** | `implants/parts/Wire.onBuff` → `p.heal(amount)` | 사망/전투불능만. 양 · 빈도 · 거리 · 시야 · 보낸 사람 없음 |
| (a') `boost` · `revive` · `cloak` | 같은 `buff` | implants(`boost` 배수 · 지속) · gadgets(`revive` · `cloak`) | 없음 |
| (b) 오버차지 빔 | `implants/effects/Overcharge.findAlly` 원뿔 + 22 m, **레이캐스트 없음** · `buff heal` 0.2 s · `buff boost` | 같은 `onBuff` + `setOvercharged`(연사 ×1.3) | 없음 → 연사가 오르면 호스트 `HitRequest` 빈도 상한도 없다 |
| (c) 분대 계약 | `meta contractHit` 방송 (≤ `META_HIT_MAX` 10) · `meta contract` · `meta sync` | `meta/parts/Credits.onMetaMessage` → 활성 계약 + 화이트리스트 + 0.25 공유 | 빈도 · 중복 · 실제 발생 여부 없음 → `settleMission` 이 크레딧 · 신뢰도 지급 |
| (d) 함선 호출 피해 | `stratagems/parts/Targeting` → `strat call` 을 `'others'` 로 | `stratagems/parts/Wire` — `callId` 중복만, **kind 화이트리스트 없음**(sync 경로에만 있다) · 위치 · 쿨타임 · 호출자 검사 없음 → 각자 `impactDamage` 로 **자기 몸에** 피해 | 없음 |

호스트는 시드로 같은 월드를 갖고 있고(`WorldRef.raycast`), 원격 플레이어 위치(`net.getRemotePlayers()`)를 안다 —
검증에 필요한 재료는 이미 있다. 일반 사격(`HitRequest`)도 적 id · 피해 500 · 넉백 20 상한만 보는 수준이다.

### 설계 — 경로마다 가장 싼 검증
**(d) 함선 호출 → 호스트 경유 (가장 먼저)**
- 호출자는 `strat call` 을 `'host'` 로 보낸다(호스트 자신은 로컬). 호스트가 검사: kind 가 `STRATAGEM_ORDER` 에 있는가 ·
  `STRATAGEM_HOST_ONLY` 규칙 · **호출자별 공유 쿨타임**(`data/stratagems.csv` `cooldown`) · 구조선 grant 와 일치 · 목표 지점이 맵 안이고
  호출자 스냅샷 위치에서 `STRAT_MAX_CALL_RANGE` 안 · `eta` 는 호스트가 csv `delay` 로 다시 쓴다.
- 통과하면 호스트가 `strat call {…, by}` 를 `'all'` 로 재방송. 받는 쪽은 **`from === hostId` 인 `strat call` 만** 받는다.
- 지연: 호출에는 원래 수 초의 `delay` 가 있어 한 홉(수십 ms)은 느껴지지 않는다.
- 호스트 이관: 쿨타임 표는 새 호스트에 없다 → 비어서 시작(한 번 더 부를 수 있는 정도, 수용).

**(a)(b) 버프 → 보내는 쪽은 게임플레이 수정, 받는 쪽은 상한**
- **벽 통과는 치트가 아니라 버그다**: `sprayAllies` · `findAlly` 에 `world.raycast`(가슴 → 가슴) 한 줄. 이것만으로 TODO 문구의 "벽도 통과" 가 끝난다.
- 받는 쪽 `onBuff` (implants · gadgets 공용 헬퍼 `shared/buffRules.ts` — 두 폴더가 쓰므로 shared):
  - 보낸 사람이 **같은 로비의 연결된 멤버**인가.
  - 보낸 사람 스냅샷 위치와 내 거리 ≤ 그 버프의 사거리 + `BUFF_RANGE_SLACK`(스냅샷 지연분).
  - 양 상한: `heal` 은 초당 합계를 토큰 버킷으로(스프레이 초당 치유 × 1.5), `boost` 배수는 csv 최대치로 clamp, `duration` 은 정의값 이하.
  - `revive` 는 내가 **실제로 전투불능**일 때만(이미 그렇다면 유지), `cloak` 지속 clamp.
- 받는 쪽 시야 검사는 넣지 않는다 — 스냅샷 지연으로 문턱에서 정당한 힐이 튕긴다. 벽 문제는 보내는 쪽 레이캐스트가 푼다.

**(c) 계약 → 킬은 호스트 이벤트에서 파생**
- 적 사망은 이미 호스트 권위다: 호스트가 `ee kill {id, ty, killer: PeerId}` 를 방송하고(`shared/net.ts`), 리플리카는
  `enemies/net/Replica` 의 `case 'kill'` 에서 **자기 킬일 때만** `enemy:killed {by:'local'}` 을 낸다. 여기에 분대원 킬용 버스 이벤트
  `enemy:squadKill {type, by: PeerId}` 를 **추가**하고(호스트 경로 `enemies/parts/Damage` 에서도 같은 것을), meta 가 그것으로
  킬 목표(`kill_bugs` · `kill_rogues`)의 0.25 공유분을 스스로 센다 — `contractHit` 의 킬 목표는 무시한다.
  기존 `enemy:killed` 의 뜻(내 킬)은 바꾸지 않는다 — 통계 · XP 가 그것을 센다.
- 킬이 아닌 목표(상자 · 채집 · 탈출)는 `contractHit` 을 유지하되 **보낸 사람별 · 목표별 토큰 버킷**(`META_HIT_RATE`)과
  "레이드 중 · 같은 로비" 게이트.
- `meta sync` 는 요청한 적 있는 응답만 받는다(요청 id 를 붙여 짝맞춤).

**함께 처리할 것**: C-57 `crate opened`(받는 쪽이 id 존재 + 보낸 사람 거리 검사), X-6 넉백(호스트가 보낸 사람 스냅샷 위치와
적의 거리가 배리어 사거리 안인지), 호스트의 **보낸 사람별 `HitRequest` DPS 상한**(오버차지 연사 ×1.3 을 포함한 이론 최대 × 여유).

### 결정 필요
- 함선 호출을 호스트 경유로: **예(권장)** / 받는 쪽 검사만(kind 화이트리스트 + 쿨타임 추정).
- 분대 계약 킬을 호스트 이벤트 파생으로: **예(권장)** / `contractHit` 유지 + 빈도 상한만.
- 범위: **남에게 영향 주는 위조만(권장)** / 서버 크레딧 검증까지(= 서버가 경제 규칙을 알아야 한다, 훨씬 크다).

### 테스트
- 새 `scripts/smoke-trust.mjs` (2 페이지, verify 가 `stratagems` · `weapons` · `implants` · `gadgets` · `meta` 에 매핑):
  위조 `strat call`(비호스트 발신 · 모르는 kind · 쿨타임 중) 무시 · 위조 `buff boost ×100` clamp · 사거리 밖 힐 무시 ·
  벽 뒤 스프레이가 힐을 안 보냄 · 위조 `contractHit kill` 무시 + 실제 킬은 공유분 반영.
- 기존 `smoke-stratagems` · `smoke-meta` · `e2e-multiplayer` 가 정상 경로를 계속 green 으로.

---

## 6. E-5 — 솔로 레이드 5분 유예가 클라이언트 시계

### 확인한 사실
- `src/game/SoloRaid.ts`: 키 `slotKey('scav.soloraid')`, `SOLO_RAID_GRACE_MS` 5 분, `savedAt = Date.now()`.
  `soloRaidStatus` 가 `age = now − savedAt` 이고 **음수 나이(미래 저장)도 `fresh`**(의도 주석 — 시계가 뒤로 가도 정당한 런을 잃지 않게).
  → 플레이 중 시계를 앞으로 돌렸다 끄고, 시계를 되돌리면 **영원히 fresh**. 켜기 전에 시계를 되돌려도 된다.
- 부팅 때 **welcome 이 오기 전에** 동기로 판정한다(`GameFlowSystem` init → 첫 update 의 `consumeStoredSoloRaid`).
- 오프라인 싱글에는 새로고침을 넘어서는 믿을 시계가 없다(`performance.now` 는 페이지마다 0).
- **추가 구멍(코드 읽기로 확인, 착수 전 실측)**: 저장 키를 지우면 `none` → 아무것도 abort 되지 않는다. `scav.loadout` 은 함선에서만
  쓰이므로(`InventorySystem` 저장 지점) 레이드 전 장비가 그대로 남는다 — 시계보다 쉬운 우회다.
- 온라인이지만 로비가 없는 레이드도 "솔로" 다(`!isMultiplayer`) — 그 결과물은 서버 프로필 문서로 올라간다.

### 설계 (오프라인에서 가능한 만큼)
1. **최고 시각 기록**: `slotKey('scav.clockHigh')` 에 지금까지 본 가장 늦은 `Date.now()` 를 저장(레이드 저장 · 부팅 · 함선 저장마다 max).
   부팅 때 `now < clockHigh − SOLO_CLOCK_BACK_TOLERANCE_MS`(2 분)이면 **시계가 뒤로 갔다** → 저장이 있으면 `stale`.
2. **음수 나이 허용 폭**: `age < −SOLO_CLOCK_BACK_TOLERANCE_MS` 는 `stale`. NTP 보정 수준(초 단위)은 여전히 fresh.
3. **표식을 지키고 싶은 문서에 넣는다**: 레이드 시작 때 로드아웃 저장에 `raidSeed` 를 적고(인벤토리 소유), 정상 종료 · 사망 · 탈출에서
   지운다. 부팅 때 로드아웃에 `raidSeed` 가 있는데 솔로 저장이 없거나 seed 가 다르면 **`stale` 과 같은 처리**(레이드 실패 → 장비 소실).
   레이드 저장 키만 지워서는 장비를 지킬 수 없게 된다.
4. **남는 구멍(수용)**: "끄고 → 시계를 되돌리고 → 5 분 안처럼 켜기" 는 오프라인으로는 막을 수 없다.
   온라인일 때만 막으려면 솔로 레이드 저장을 서버에도 올려 서버 시계로 나이를 재야 한다 — `결정 필요`.

### 결정 필요
- 범위: **1–3 만(권장 — 솔로는 자기 자신만 속인다)** / 온라인 솔로는 서버 시계로 판정까지(`profile` 에 `soloraid` 문서 + 서버 수신 시각).

### 테스트
- 새 스모크 절(`smoke-raidflow` 확장): 미래 `savedAt` → stale · `clockHigh` 보다 과거로 부팅 → stale · 저장 키 삭제 + 로드아웃 `raidSeed` → 레이드 실패 처리 ·
  정상 새로고침 5 분 안 → 복귀 · 1 초 NTP 역행 → 복귀.

---

## 7. E-6 — 프로필 문서 병합이 writer 의 시계 기준

### 확인한 사실
- 서버 `ProfileStore.setDoc`: 도장 쓰기는 `t = min(at, now + PROFILE_CLOCK_SKEW_MS(5 분))`, `t < docsAt[key]` 면 `stale` — **조용히 버린다, ack 없음.**
- 클라이언트 `net/ProfileSync`: `set` 이 `at = serverNow()` 로 도장, `flush` 는 **`send` 가 true(= 소켓이 열려 있음)면 곧바로 대기열에서 지운다** —
  서버가 처리했는지 모른다. 대기열은 **메모리뿐**.
- welcome 한 번도 못 받은 세션은 `serverNow()` 가 `Date.now()` 다 → 시계가 5 분 이상 빠르면 `docsAt = 서버 now + 5 분` 이 저장되고,
  **그 뒤 최대 5 분 동안 정상 도장 쓰기가 전부 `stale` 로 조용히 버려진다**(TODO 문구보다 나쁘다 — 이긴 쓰기가 이후 쓰기를 막는다).
- stash · loadout 은 **따로** 디바운스(350 ms)되고 따로 `profile:set` 된다. 문서를 걸치는 편집이 더 있다: 시체 벗기기(progression + loadout),
  퀘스트 완료(meta + stash).
- **추가 손실 경로(코드 읽기로 확인, 착수 전 실측)**: 서버 없이 플레이한 세션의 진행은 localStorage 에만 있고 대기열(메모리)은
  새로고침에 사라진다. 다음에 서버에 붙으면 `inventory/parts/ProfileDocs.applyProfileDocs` 등이 **서버 사본으로 로컬을 갈아 끼운다** —
  오프라인에서 한 진행이 덮인다.

### 설계 — 시계를 버리고 리비전
토큰 = 브라우저 저장소이므로 **한 프로필의 작성자는 사실상 하나**다(다른 기기는 다른 프로필, 두 번째 탭은 `duplicate` 로 쫓겨난다).
그러니 "누가 더 최신인가" 를 시계로 물을 필요가 없다 — **"내가 마지막으로 본 판 위에 쓰는가"** 만 물으면 된다.

1. **리비전**: 서버 `ProfileRecord.docsRev?: Partial<Record<ProfileDocKey, number>>` (쓰기가 받아들여질 때마다 +1, welcome · docs 에 실린다).
2. **쓰기**: `profile:set {key, doc, baseRev, writeId}`
   - `baseRev === docsRev[key]`(없으면 0) → 저장, `rev+1`, **`profile:ack {writeId, key, rev}`**.
   - 다르면 → `profile:conflict {writeId, key, rev, doc}`. 같은 `writeId` 재전송(재접속 후)은 마지막 writeId 를 기억해 **ack 를 다시** 보낸다(멱등).
   - `at` 만 있는 옛 프레임은 지금 규칙 그대로(하위 호환). `fresh` 는 "`docsRev` 가 0 이고 문서가 없을 때만" 으로 같은 뜻.
3. **클라이언트 대기열 영속화**: `slotKey('scav.profileQueue')` 에 `{key → {doc, baseRev, writeId}}`. ack 를 받아야 지운다.
   부팅 후 welcome 에서:
   - 대기 항목의 `baseRev === 서버 rev` → **로컬이 이긴다**(오프라인 진행 보존) → 재전송.
   - `서버 rev > baseRev` → 충돌 → **서버가 이긴다**(다른 세션이 그사이 썼다) + 콘솔 경고. 폴더에 `net:profileLoaded` 로 서버 사본.
4. **트랜잭션**: `ProfileRef.setMany(entries)` → `profile:setMany {txId, docs: {key: {doc, baseRev}}}` — 서버가 전부 검사한 뒤
   **전부 또는 전무**, `profile:ack {txId, revs}`. 프레임 한도는 `MAX_DOC_FRAME_BYTES` 를 문서 수만큼(최대 5 × 256 KB) 허용.
   - inventory: `Stash` 와 `LoadoutStore` 의 디바운스를 **하나로** 합쳐 둘 다 바뀌었으면 `setMany(['stash','loadout'])`.
   - 시체 벗기기 · 퀘스트 완료도 `setMany` (progression · meta 쪽 호출부).
5. 서버 쪽 `stale` 무음 규칙은 옛 프레임에만 남는다.

### 단기 봉합 (리비전을 미룰 때)
- 마지막 서버 시계 오프셋을 `scav.serverOffset`(공용 키)에 저장해 오프라인 세션도 보정된 시계로 도장.
- `PROFILE_CLOCK_SKEW_MS` 를 5 분 → 5 초 (오프셋이 저장되면 큰 여유가 필요 없다).
- `profile:ack {key, at}` 만 추가해 `flush` 가 ack 뒤에 지우게.
→ 시계 조작은 여전히 통하고 원자성 · 오프라인 진행 손실은 그대로다. **권장은 리비전.**

### 결정 필요
- **리비전 + ack + 영속 대기열 + 트랜잭션(권장, L)** / 단기 봉합만(S).
- 충돌 시 정책: **서버 우선 + 경고(권장)** / 사용자에게 고르게 하기(UI 필요).

### 테스트
- selftest: `baseRev` 일치/불일치 · `writeId` 재전송 멱등 · `setMany` 한 문서가 너무 크면 전부 거절 · 옛 `at` 프레임 하위 호환 ·
  `docsRev` 파일 왕복.
- `smoke-search`(ProfileSync 병합 스텁)를 리비전 규칙으로 확장: 오프라인 세션 → 새로고침 → 접속 시 로컬 보존 · 다른 세션이 쓴 뒤면 서버 우선 ·
  `setMany` 중간 끊김 → 둘 다 옛 판.

---

## 8. B-1 — 릴레이 연결 실패를 알리는 UI 가 없다

### 확인한 사실
- 자동 재접속은 **한 번 붙었다가 끊긴 경우**만이다(`net/parts/Socket.onSocketDown` 이 `!wasConnected` 면 곧바로 return).
  첫 접속 실패는 그대로 오프라인이다.
- `ensureConnected` 를 부르는 곳: 개인 함선 `hub:enter` 마다의 `tryResume`, 터미널 버튼(`HubMenu.connectThen` — 신호 찾기 · 코드 도킹 · 신호 송출),
  `enterShip` 초대 코드, 설정 `적용하고 다시 접속`. 스스로는 절대 접속하지 않는다(`net/README`).
- 로비 없는 재접속은 `MAX_LOBBYLESS_ATTEMPTS`(6, 약 40 초) 뒤 **이벤트 없이** 포기한다.
- `NetClient.connect` 에 **타임아웃이 없다** — 죽은 IP 는 OS TCP 타임아웃까지 매달린다(데스크톱 프록시 `wsProxy` 도 마찬가지).
- 연결 상태를 보여 주는 곳: 터미널 헤더(열려 있을 때만) · 함선 안 터미널 화면 글자 · 재접속 토스트. `HubMenu.showMsg` 는 터미널이 닫혀 있으면
  **아무것도 안 한다** → `net:error` 가 사라진다 (C-59 의 kicked · server_full 문구도 같은 뿌리).
- 데스크톱 셸(C-28): 같은 오리진 `/ws` 로 붙는 순간 **임베디드 릴레이가 지연 시작**된다 → 배경 프로브가 그 경로를 두드리면 지연 시작이 무의미해진다.
- 끊지 말아야 할 규약: `serverRefused` · `duplicateKicked` 뒤에는 자동 재시도 금지(명시적 `connect()` 가 둘을 지운다), 프로브는 **토큰 없이**(같은 토큰은 `duplicate`).

### 설계
1. **링크 상태** (`ctx.net.link: NetLinkInfo`, 이벤트 `net:linkChanged`):
   `idle`(시도 전) · `connecting` · `connected` · `unreachable {nextProbeInMs}` · `refused {reason: kicked|server_full|duplicate}` · `reconnecting {attempt}`.
2. **접속 타임아웃**: `NET_CONNECT_TIMEOUT_MS`(6 s) — 넘기면 소켓을 닫고 `unreachable`.
3. **배경 프로브**: `unreachable` 이고 `refused` 가 아니면 익명 `probeRelay`(이미 있다, 4 s 타임아웃)를
   `NET_PROBE_BACKOFF_MS`(5 · 10 · 20 · 30 · 60 s 상한)로. 로비 없는 재접속 포기도 여기로 넘긴다(조용한 포기 제거).
   - **데스크톱 셸 + 임베디드 목표**(`/__scav/relay` 의 `source` 가 내장)면 프로브하지 않는다 — 필요할 때 켜지는 서버라 "못 찾음" 이 없다.
4. **프로브가 성공하면**: 함선(`hub`) · 타이틀이면 `ensureConnected()` 로 **자동 접속** + 토스트 "서버에 연결되었습니다".
   레이드 · 훈련 중이면 **접속하지 않고** 배지만 "서버 발견 — 함선에서 연결" (중간에 `net:profileLoaded` 가 오면 폴더들이 레이드 상태를 갈아 끼운다).
5. **UI** (`ui/hud/NetBadge` 신설 + 기존 보강):
   - 함선 · 타이틀 우측 상단 작은 배지: `오프라인 · 서버 찾는 중 (12초 뒤)` / `서버 주소를 확인하세요 — <주소>` / `추방됨` / 연결되면 3 초 `연결됨` 뒤 사라짐.
   - 타이틀(커서가 있다): 배지 옆 `다시 시도` · `서버 설정` 버튼.
   - 전이 토스트: 연결 → 끊김 "서버 연결이 끊겼습니다 — 다시 찾는 중", 끊김 → 연결 "서버에 다시 연결되었습니다".
   - `HubMenu.showMsg` 가 닫혀 있으면 토스트로 넘긴다(C-59 를 같이 닫는다).

### 결정 필요
- 늦게 켜진 서버에 **함선 · 타이틀에서만 자동 접속(권장)** / 알림만 띄우고 버튼으로.
- 배지를 레이드 HUD 에도: **숨긴다(권장 — 분대원 HUD 의 `연결 끊김` 이 이미 있다)** / 보인다.

### 테스트
- 새 스모크 절(`smoke-controls-hub` 또는 `smoke-netlink.mjs`): 설정 오버라이드를 **죽은 포트**로 → 배지 `오프라인` · 타임아웃 6 s 안에 `unreachable` →
  스모크가 그 포트에 릴레이를 직접 띄움 → 백오프 안에 자동 접속 + 토스트 · 레이드 중이면 접속하지 않음 · `kick` 뒤 프로브 없음.
- E-3 가 있으면 데스크톱 셸의 임베디드 목표에서 프로브가 돌지 않음(임베디드 릴레이 `/health` 가 아직 거절)을 확인.

---

## 9. E-3 — 데스크톱 셸을 검증하는 자동화가 없다

### 확인한 사실
- 브라우저 자동화는 `puppeteer-core` 25.10 뿐. Electron 44.2 가 설치돼 있고 `_electron` · `puppeteer.connect` · `--remote-debugging-port`
  를 쓰는 스크립트는 **없다**(수동 기록만 `electron/README` · `docs/VERIFICATION.md`).
- 브라우저 스모크는 `window.__scavDesktop = true` 로 셸을 **흉내** 낸다. `scripts/verify.mjs` 의 `foldersOf` 는 `electron/` 과 `scripts/pack-release.mjs` 를
  **어디에도 매핑하지 않는다**.
- 셸 제약: 창 포트 = 세이브 오리진(8790–8799 금지), **단일 인스턴스 락**(켜 둔 게임이 테스트를 막는다), `userData`
  (`%APPDATA%/SCAVANGER`) 공유, `electron/default-relay.txt` 에 LAN IP 가 구워져 있어 `--local` 없이는 그 IP 로 붙으러 간다, preload 없음,
  헤드리스 불가(창이 뜬다).
- 자동화로 증명할 수 **없는** 것: 진짜 Escape · 포인터 락 타이밍(CDP 키는 exclusive-access 경로를 우회한다 — 기록된 한계).

### 설계
**셸에 테스트용 플래그 둘** (`electron/main.ts`):
- `--user-data=<dir>` / `SCAV_USER_DATA` → `app.ready` 전에 `app.setPath('userData', dir)` — 저장소 · 단일 인스턴스 락 · 임베디드 릴레이 데이터가 전부 격리된다.
- `--hidden` → `BrowserWindow({show:false})` (렌더링은 계속된다 — `backgroundThrottling:false` 는 이미 있다).

**`scripts/smoke-desktop.mjs`** (verify: `standalone` + `exclusive`, 새 `EXTRA_PATHS` `^electron/` · `^scripts/pack-release\.mjs$` · 자기 자신):
0. 준비: `dist/` · `dist-electron/main.js` 가 소스보다 오래됐으면 `npm run app:build`(약 1–2 분). 임시 `userData`.
1. **부팅**: `node_modules/electron/dist/electron.exe . --local --hidden --app-port=8820 --port=8821 --user-data=<tmp> --remote-debugging-port=9340`
   → `http://127.0.0.1:9340/json/version` 폴링 → `puppeteer.connect({browserURL})` → `127.0.0.1:8820` 페이지.
   단언: `window.__game.ctx` · UA 에 `Electron/` · `isDesktopShell()` 이 흉내 없이 true · `__scavShellRelock` 설치.
2. **지연 릴레이(C-28)**: 접속 전 `http://127.0.0.1:8821/health` 거절 · `/__scav/relay` JSON 이 `(필요할 때 켜짐)` →
   `__game.getSystem('net').ensureConnected()` → welcome · 이제 `/health` 응답.
3. **프록시 모드**: 스모크가 빈 포트에 릴레이를 직접 띄우고 `--relay=ws://127.0.0.1:<p>/ws` 로 재부팅 → 렌더러는 같은 오리진 `/ws` 인데
   그 릴레이 `/health.clients === 1`. `server.txt` 경로도 한 번(임시 폴더에 두고 `PORTABLE_EXECUTABLE_DIR` 대신 cwd 후보로).
4. **세이브 = 창 포트**: localStorage 에 표식 → CDP `Browser.close` 로 정상 종료 → 같은 `--app-port` 재부팅 → 표식이 있다 ·
   다른 `--app-port` → 없다 (CLAUDE.md 의 규약을 코드로 고정).
5. **단일 인스턴스**: 같은 `userData` 로 두 번째 실행 → 즉시 종료 코드.
6. 출력 `N passed, M failed` + `FAIL` 줄.

**배포 폴더**(`app:dist`, electron-builder 라 느리다)는 `--release` 플래그일 때만: `release/SCAVANGER/` 가 정확히 넷(`app/` · stub · `server.txt` · 서버 exe) ·
stub `SCAVANGER.exe --hidden --app-port=… --remote-debugging-port=…` 가 인자를 넘겨 1 번 단언이 통과(`launcher.cs` 가 인자를 전달한다).

### 결정 필요
- verify 편입: **`electron/` 을 건드렸을 때 + `verify:all`(권장)** / `verify:all` 만 / 수동 명령만.
- 창이 실제로 뜨는 테스트: **`--hidden` 으로 숨김(권장)** / 보이게(디버깅 쉬움, 작업 중 화면을 가린다).

### 테스트
- 이 스모크 자체. 추가로 `smoke-server-dist` 의 포트 예약 주석(8830–8869)에 8820–8821 · 9340 을 적는다.

---

## 10. 계약 추가 한눈에 (전부 추가만)

| 파일 | 추가 | 항목 |
|---|---|---|
| `shared/net.ts` | `lobby:left.reason? 'moved'` · `lobby:left.to?` · `social:inviteReply` · `social:inviteResult` · `social:inviteClosed` · `social:block` · `social:whisper.nonce?` · `social:whisperAck` · (`social:whisperBacklog`) · `profile:set.baseRev?/writeId?` · `profile:setMany` · `profile:ack` · `profile:conflict` | B-6 · B-3 · B-4 · E-6 |
| `shared/social.ts` | `SquadInvite.id?` · `SocialErrorCode 'expired'` · `SocialRecord.blocked?` · `SocialSnapshot.blocked?` · `SOCIAL_BLOCK_MAX` · `SOCIAL_PUSH_COALESCE_MS` · (`SOCIAL_WHISPER_INBOX_*`) | B-3 · B-4 · B-5 |
| `shared/profile.ts` | `ProfileRecord.docsRev?` · `ProfileRef.setMany` | E-6 |
| `shared/events.ts` | `social:inviteResult` · `net:linkChanged` · `net:lobbyLeft.reason 'moved'` · `enemy:squadKill` | B-3 · B-1 · B-6 · E-4 |
| `shared/types.ts` | `NetRef.link` · `NetLinkInfo` | B-1 |
| `shared/buffRules.ts` (신규) | 버프 종류별 상한 · 사거리 · 토큰 버킷 헬퍼 | E-4 |
| `data/constants.csv` | 클라이언트가 읽는 수치: `BUFF_RANGE_SLACK` · `META_HIT_RATE` · `STRAT_MAX_CALL_RANGE` · `NET_CONNECT_TIMEOUT_MS` · `NET_PROBE_BACKOFF_MS` · `SOLO_CLOCK_BACK_TOLERANCE_MS` · `WHISPER_HISTORY_*` | E-4 · B-1 · E-5 · B-4 |

서버가 읽는 수치(`SOCIAL_*` · `PROFILE_*` · `NET_*`)는 지금처럼 `src/shared/*.ts` 의 TS 리터럴이다 — 릴레이는 Node 타입 스트리핑으로 돌아
`import.meta.glob` 으로 csv 를 읽을 수 없다(B-2 의 `PROFILE_GC_INACTIVE_MS` 도 같은 이유로 `profile.ts` 에 있다).
