# 메신저 · NPC 퀘스트 · 단체방 (2026-09-14)

설계 · 사용자 결정 원본. 계약은 `src/shared/npc.ts`(NPC · 퀘스트 · 목표 · `NpcQuestRef`), `src/shared/meta.ts` 끝의
`2026-09-14 메신저 · NPC 퀘스트` 절(`MetaRef.npc` · `MetaSave.npc`), `src/shared/social.ts` 끝의 `2026-09-14 단체 메신저방` 절
(`RoomsRef` · 방 타입 · 개인 대화 읽음), `src/shared/net.ts` 끝의 같은 이름 절(와이어), `src/shared/events.ts` 끝의 같은 이름 절.

## 0. 사용자 결정 (인터뷰)

| 질문 | 결정 |
|---|---|
| 메신저 위치 | **P 키 독립 패널** — 커뮤니티 패널 자리를 대체. 상단 탭 `대화` · `친구` · `퀘스트`, 좌 목록(NPC · 개인 대화 · 단체방) + 가운데 대화 |
| 레이드 중 메신저 | **함선 전용** (지금 커뮤니티 패널과 같다). 레이드 중에는 채팅창 개인 대화 + 지도의 퀘스트 패널만 |
| 레이드 목표 확정 | **채우는 순간 확정** — 목표마다 독립, 채우면 즉시 완료(이후 사망해도 유지). 못 채우고 레이드가 끝나면 그 목표의 진행만 0. 회수(recover)는 탈출해야 확정 |
| 기존 기업 퀘스트 25개 | **전부 삭제** (`data/quests.csv` 삭제). 기업 코인 해금은 새 NPC 퀘스트 id 로 옮긴다 — 옛 해금 기록은 이어지지 않는다 |
| 분대 인정 | **발견만 공유** — 구조물 발견(전장의 안개는 분대 공유)은 분대원이 밝혀도 인정. 처치(막타) · 상호작용 · 컨테이너 조사 · 회수는 본인만 |
| 단체방 | **방장형 + 채팅창 연동 없음** — 누구나 만들고 친구를 초대. 초대 · 강퇴 · 이름 변경은 방장만(방장이 나가면 다음 사람). 최대 20명, 서버가 최근 200줄 보관. 단체방 대화는 메신저 안에서만 (개인 대화만 채팅창과 이어진다) |
| 초기 콘텐츠 | **NPC 10명 · 퀘스트 약 40개** — 기업마다 임원 1 + 직원 1 (8명), 무소속 2명. 인물마다 3–5개 연속 퀘스트 + 채굴 인가 4개 |
| 완료 처리 | **보고 버튼, 포기 불가** — 납품은 [납품] 버튼(가방 + 창고에서 소모), 목표가 다 차면 [완료 보고] → NPC 답장 + 보상. 수락한 퀘스트는 포기할 수 없다 |

요청 원문에서 온 규칙:
- 귓말 · 귓속말의 공식 명칭은 **개인 대화**. 채팅창에서 한 개인 대화가 메신저 대화 기록에 그대로 남고, 메신저에서도 보낼 수 있다 (저장소는 이미 하나 — `SocialSync` 의 `slotKey(WHISPER_STORAGE_KEY)`).
- 기업 퀘스트는 없어지고 **기업 계약만** 남는다. NPC 는 기업 네트워크와 별개로 메신저로 연락한다.
- 기업 임원 NPC 는 신뢰도를 보상으로 주기도 한다 (`rewardRep`). 특정 NPC 는 기업 신뢰도 레벨이 되어야 먼저 연락한다 (`npcs.csv reqRep`).
- NPC 가 퀘스트를 주면 대화에 **퀘스트 카드 말풍선**(이름 · 설명 · 목표 · 보상 + [수락] [생각해보지]). 「생각해보지」 = 보류 → 퀘스트 탭에 비활성으로 보이고 거기서 다시 수주 → 메신저 그 NPC 대화로 이동하며 NPC 가 짧게 설명한다 (`brief`).
- 퀘스트는 동시에 여러 개. 레이드 지도에서 **범례 위에 퀘스트 패널 목록**, 범례는 좌측 하단. 패널 안 하단에 진행 게이지, 호버 = 상세 툴팁.

리드가 정한 빈칸 (사용자에게 보고):
- 목표 `chain` 열 — 같은 값의 목표는 **한 레이드 안에서 모두** 채워야 확정 (구조물 발견 + 안의 컨테이너 조사 「모든 과정이 한 레이드 안에서」 를 데이터로 표현). 비우면 목표마다 독립.
- 납품은 **나눠서** 할 수 있다 — [납품] 한 번에 가진 만큼(남은 수량까지) 넣고 진행이 저장된다.
- 회수 · 납품의 `item` 은 아이템 id 또는 `weapon:<계열>`(등급 무관 그 계열 총기).
- 무기 계열 처치는 **총기 막타만** — 수류탄 · 가젯 · 근접 · 화상 지속 피해로 끝낸 처치는 계열 없음.
- 구조물 발견은 `fog:discovered kind 'structure'` 그대로 — 맵 스캐너 파동이 밝힌 것도 발견이다.
- NPC 연락 · 제안은 **함선에서만** 도착한다 (레이드 중 조건을 채워도 함선 복귀 후).

## 1. 데이터 (`data/`, 로더 `src/shared/npc.ts`)

### `npcs.csv`
`id,name,title,corp,role,color,glyph,reqLevel,reqRep,reqQuests,intro,bio`
- `corp` = helix | bastion | nomad | ceres | 비움(무소속), `role` = executive | staff | independent.
- 첫 연락 조건 = `reqLevel`(캐릭터 레벨) ∧ `reqRep`(`기업:레벨` | …) ∧ `reqQuests`(완료한 NPC 퀘스트 id | …). 비우면 조건 없음.
- `intro` = 첫 연락 말풍선들(`|` 로 나눈다). `bio` = 대화 머리 한 줄.

### `npc_quests.csv`
`id,npc,name,summary,reqLevel,reqRep,reqQuests,rewardCredits,rewardXp,rewardRep,rewardItems,offer,accept,decline,brief,complete`
- 같은 NPC 의 퀘스트는 **파일 줄 순서대로 하나씩** 제안한다 (한 NPC 에 `offered` 가 하나 있는 동안 다음 제안 없음).
- `rewardRep` = `기업:양` | …, `rewardItems` = `아이템id:수량` | …, `rewardCredits` 는 서버 원장 `quest:<id>` 로 한 번만 지급된다.
- 채굴 인가 4개의 id 는 고정: `q_hx_permit` · `q_bs_permit` · `q_nm_permit` · `q_ce_permit` (`data/crypto.csv` 의 `unlockQuest`, 크레딧 보상 > 0 필수).
- 대사 5종은 `|` 로 말풍선을 나눈다. 대화 기록에는 **사건만** 저장하고 글은 표에서 다시 그리므로 대사를 고치면 옛 기록도 바뀐다.

### `npc_objectives.csv`
`quest,kind,target,item,enemy,weapon,site,interact,planet,chain,label`

| kind | 채우는 것 | 쓰는 열 | 레이드? | 분대 공유 |
|---|---|---|---|---|
| `deliver` | 함선에서 [납품] — 가방 + 창고에서 소모, 나눠 넣기 가능 | `item` | 아니오 | — |
| `recover` | 그 레이드에서 얻은(`raidFound`) 아이템을 몸(가방 · 퀵슬롯 · 주머니)에 지니고 **탈출** | `item` | 예 (탈출 확정) | 본인 |
| `interact` | 맵 스캐너 작동 · 지하실 문(열쇠) · 연구소 2층 문(키카드) · 전차 호출/시동 · 탐사 차량 탑승 | `interact` | 예 | 본인 |
| `kill` | 적 처치 **막타** (`weapon` 이 있으면 그 계열 총기로) | `enemy`, `weapon` | 예 | 본인 |
| `discover` | 구조물 발견 (`fog:discovered kind 'structure'` + 구조물 종류) | `site` | 예 | **분대** |
| `search` | 그 종류 구조물 안의 컨테이너 조사 (컨테이너당 1회) | `site` | 예 | 본인 |

- `enemy` = `humanoid`(스캔 드론 제외 인간형 전부) | `rogue` | `raider` | `android` | `bug` | `named`(네임드 3종) | 적 타입 id.
- `planet` = 레이드 목표만, 비우면 어느 행성이든. 훈련장은 아무것도 세지 않는다.
- 레이드 목표의 **이번 레이드 진행**은 레이드가 끝나면(`game:complete` · `game:over` · `game:abort` · `hub:entered`) 확정되지 않은 만큼 0.
- `chain` — 같은 퀘스트의 같은 `chain` 목표들은 한 레이드 안에서 모두 목표치에 닿는 순간 함께 확정된다.

## 2. 상태 기계 · 저장

```
hidden ──(함선, 조건 충족, 그 NPC 에 대기 중 제안 없음)──► offered ──[수락]──► active ──(모든 목표 done)──[완료 보고]──► complete
                                                            └─[생각해보지]─► deferred ──[퀘스트 탭 수락]──► active (+ brief)
```
- 포기 없음. `hidden` 은 저장하지 않는다.
- 저장: `MetaSave.npc`(meta 문서 — 서버 프로필과 함께 간다, `MetaSave.v` 올림). `NpcSave = { contacts, log, quests }`,
  퀘스트는 `{ s, at, p[] }`(p = 목표별 **확정** 진행; 납품 = 넣은 수량, 레이드 목표 = 확정되면 target 아니면 0).
- 대화 기록 = `NpcLogEntry {at, e, q?}` (`intro` · `offer` · `accept` · `decline` · `brief` · `complete`). `getMessages` 가 표에서 말풍선으로 푼다:
  intro → NPC 말풍선들 · offer → NPC 말풍선들 + 퀘스트 카드 · accept/decline/brief/complete → 내 정해진 답(`NPC_REPLY_KO`) + NPC 말풍선들(complete 뒤에는 보상 시스템 줄).
- 완료 보상: 아이템을 먼저 넣어 보고(안 들어가면 `공간 없음` 거절, 아무것도 안 바뀜) → 크레딧 `quest:<id>` → 신뢰도 `addRep` → XP. 옛 `completeQuest` 와 같은 순서.
- `MetaRef.getQuestState(id)` 는 계약이라 남기고 NPC 퀘스트로 답한다: complete → `complete`, active → `accepted`, offered/deferred → `available`, 그 밖 → `locked` (housing 채굴 게이트가 그대로 산다).
- `QUEST_DEFS` 는 빈 배열로 남는다 (타입 · 이름은 계약). 서버 경제 표(`scripts/economy-table.mjs`)는 `NPC_QUEST_DEFS` 를 읽는다.

## 3. 새 사건 배관 (추가만)

| 이벤트 | 소유 | 뜻 |
|---|---|---|
| `enemy:killed.weaponClass?` | enemies (+ weapons 의 피해 출처) | **내 막타**가 총기였으면 그 계열, 아니면 null/생략. 비호스트도 자기 킬에 채운다 |
| `crate:open.zoneId?` · `zoneKind?` | world | 구조물 · 플랫폼 · 전차 컨테이너면 그 구역 |
| `world:interacted {kind, id, structureKind?}` | world | **이 클라이언트의 조작**으로 스캐너 · 문 · 전차 · 탐사 차량 상호작용이 성사됐다 (로컬 전용) |
| `npc:*` | meta | 메시지 도착 · 읽음 · 퀘스트 상태 · 목표 진행 · 보고 가능 |
| `ui:openMessenger` · `ui:messengerToggled` | ui | 메신저 열기 명령 · 열림 사실 |
| `social:unreadChanged` · `room:*` | net | 개인 대화 읽지 않음 · 단체방 상태/줄/초대/읽지 않음 |

## 4. 단체방 와이어 (서버 권위 · 영속)

- 클라 → 서버: `room:get` · `room:create {name, invite?, nonce}` · `room:invite` · `room:reply` · `room:leave` · `room:kick` · `room:rename` · `room:say {nonce}` · `room:history {before?}`.
- 서버 → 클라: `room:state {rooms}`(welcome 직후 · 변경마다 관계자에게) · `room:line` · `room:ack {nonce}` · `room:history` · `room:error`.
- 초대는 **친구만**, 영속(`ROOM_INVITE_TTL_MS`). 차단 규칙은 소셜과 같다(나를 차단한 사람은 `not_found`, 내가 차단한 사람은 초대 불가). 방당 `ROOM_MEMBER_MAX` 20 · 줄 `ROOM_LINES_MAX` 200 · 한 사람이 든 방 `ROOM_JOINED_MAX`.
- 방장이 나가면 가장 먼저 들어온 멤버가 방장, 마지막 멤버가 나가면 방 삭제. 프로필 GC 가 지운 사람은 방에서도 빠진다.
- 읽지 않음은 **클라이언트** 표시다(슬롯 localStorage 의 방별 `readAt`).

## 5. 화면

- **메신저**(ui, `src/ui/menus/messenger/`, CSS 접두사 `ms-`): P 탭 토글 · Tab/Esc 닫기 · 함선 전용 · 우상단 썸네일에 읽지 않음 합계 배지 · 분대 초대 카드 스택은 그대로.
  - `대화` 탭: 좌 목록(NPC · 개인 대화 상대 · 단체방, 최근 순, 읽지 않음 배지) · 가운데 말풍선 대화 + 입력창(NPC 는 입력창 없음). 단체방 머리: 멤버 · 초대(방장) · 이름 변경(방장) · 나가기.
  - `친구` 탭: 옛 커뮤니티 열(분대원 · 받은 요청 · 친구 · 최근 · 차단 목록) — 우클릭 메뉴의 「개인 대화」 는 대화 탭의 그 사람으로 이동.
  - `퀘스트` 탭: 진행 중(목표 · 진척 · [납품] · [완료 보고]) / 보류(비활성 · [수락] → 대화 탭 이동) / 완료.
- **지도 퀘스트 패널**(ui, `src/ui/map/`): 좌측 열 = 머리 → 퀘스트 패널 목록(스크롤) → 범례(좌측 하단) → 발밑 줄. 패널 = 퀘스트 이름 · NPC · 레이드 목표 줄 · 하단 게이지(전체 진척). 호버 = 상세 툴팁(설명 · 목표 전부 · 보상).
- **토스트**: 함선에서 새 NPC 메시지 (메신저가 닫혀 있을 때), 레이드에서 목표 확정 · 보고 가능, 완료 보상.

## 6. 에이전트 배정 (폴더 소유)

| 에이전트 | 소유 | 하지 않는 것 |
|---|---|---|
| A 단체방 · 개인 대화 서버/넷 | `server/*`, `src/net/*`, `social.ts`/`net.ts` 의 2026-09-14 절 안, `server/selftest.ts`, 새 `scripts/smoke-rooms.mjs`, net · shared 의 「귓속말」 → 「개인 대화」 문자열 | ui DOM |
| B 퀘스트 엔진 | `src/shared/npc.ts`, `meta.ts` 의 2026-09-14 절, `src/meta/*`(기업 퀘스트 화면 제거 포함), enemies/weapons/world 의 배관(§3), `housing/parts/Mining.ts` 게이트 확인, `scripts/economy-table.mjs` · `data-check.mjs` · `data-owners.mjs`, 기존 스모크의 퀘스트 부분, 새 `scripts/smoke-npc-quests.mjs` | csv 콘텐츠 작성, ui |
| C 메신저 UI | `src/ui/menus/messenger/*`, `ui/hud/Community.ts`, `ui/menus/social/*`, `ui/hud/ChatLog.ts`, 새 `ui/styles/messenger.css`, `HudSystem.ts`, 튜토리얼 게이트의 커뮤니티 선택자, 새 `scripts/smoke-messenger.mjs`, `smoke-social.mjs` 의 DOM 부분 | 지도 · 토스트 |
| D 콘텐츠 | `data/npcs.csv` · `npc_quests.csv` · `npc_objectives.csv` | 코드 |
| E 지도 패널 · 토스트 | `src/ui/map/*`, 새 `ui/styles/mapquests.css`, `ui/hud/Notifications.ts` · `MetaToasts.ts` 의 퀘스트 토스트 | 메신저 |

공통: `src/shared/types.ts` · `weapons/WeaponStats.ts` · `weapons/WeaponDefaults.ts` 는 다른 세션이 고치는 중이라 **건드리지 않는다**.
공용 파일(`verify.mjs` · 폴더 README)은 편집 직전에 다시 읽고 자기 줄만 고친다.

## 7. 초기 콘텐츠 요약 (D, 2026-09-14)

NPC 10 · 퀘스트 41 · 목표 94 (deliver 35 · kill 19 · recover 12 · interact 11 · discover 9 · search 8). 값은 전부 csv 에서 조정한다.

| id | 이름 | 직함 | 기업 | 역할 | 첫 연락 조건 | 성격 |
|---|---|---|---|---|---|---|
| `npc_park_doyun` | 박도윤 | 헬릭스 현장 보급관 | helix | staff | 없음 | 밝고 수다스러운 보급관, 한서진에게 보고 · 오세라와 기록 경쟁 |
| `npc_han_seojin` | 한서진 | 헬릭스 방산 조달실장 | helix | executive | helix:1 + `q_hx_s2` | 숫자와 납기로만 평가하는 냉정한 실장, 바스티온을 「느린 장인」이라 부른다 |
| `npc_oh_sera` | 오세라 | 바스티온 탄도 시험관 | bastion | staff | Lv.2 | 과묵하고 정확함에 집착하는 시험 사수 |
| `npc_kang_taeo` | 강태오 | 바스티온 중공업 기술이사 | bastion | executive | bastion:1 + `q_bs_s2` | 장인 기질, 설계도 유출에 예민 |
| `npc_cha_yuna` | 차유나 | 노마드 장비 수선공 | nomad | staff | 없음 | 털털한 반말, 마르코 옛 분대의 유일한 생존자 |
| `npc_marco_lee` | 마르코 이 | 노마드 장비 원정대장 | nomad | executive | nomad:1 + `q_nm_s2` | 피로스 VII 에서 분대를 잃은 노장 |
| `npc_min_jihoo` | 민지후 | 세레스 온실 연구원 | ceres | staff | Lv.2 | 다정한 식물학자, 상사의 연구 방식이 불안하다 |
| `npc_seo_haram` | 서하람 | 세레스 바이오 연구본부장 | ceres | executive | ceres:1 + `q_ce_s2` | 결과만 보는 차가운 연구자, 옛 실험 기록을 지우고 다닌다 |
| `npc_raven` | 레이븐 | 정보 브로커 | — | independent | Lv.4 | 네 기업 모두와 거래하는 정체불명의 브로커 |
| `npc_kane` | 케인 | 레이더 탈영병 | — | independent | `q_rv_2` 완료 (레이븐 소개) | 동료를 몰살한 네임드 로든을 쫓는 전직 용병 |

| NPC | 퀘스트 | 줄거리 |
|---|---|---|
| 박도윤 | 4 (`q_hx_s1`–`s4`) | 탄약 라인 재가동 → 보급로 스캔 · 정리 → 오세라에게 지지 않으려는 기관단총 실전 기록 → 전진기지에 남은 헬릭스 비축 물자 회수 |
| 한서진 | 4 (`q_hx_e1` · `q_hx_permit` · `e2` · `e3`) | 물량 검증 → HLXT 채굴 인가 → 레이븐 제보로 보레아스 IX 연구소의 바스티온 규격 복제 조사 → 피로스 VII 레이더 상대 돌격소총 화력 시연 |
| 오세라 | 4 (`q_bs_s1`–`s4`) | 관통 시험 표본 → 지정사수소총 시험 → 베르단트 III 에서 박도윤 기록 갱신 → 산탄 근접전 규격 (보상 지하실 열쇠 = 강태오 첫 의뢰 준비) |
| 강태오 | 4 (`q_bs_e1` · `q_bs_permit` · `e2` · `e3`) | 전진기지 지하실 설계도 회수 → BSTN 채굴 인가 → 한서진의 「느린 장인」 에 답하는 카민 I 저격 → 수송대를 갈아 버린 네임드 헤비 사냥 |
| 차유나 | 4 (`q_nm_s1`–`s4`) | 수선소 재료 → 현장 회수 장비 → 전차 짐칸 고정대 시승 → 탐사 차량 노선 버그 정리 |
| 마르코 이 | 4 (`q_nm_e1` · `q_nm_permit` · `e2` · `e3`) | 보레아스 IX 원정로 → NMDM 채굴 인가 → 피로스 VII 전진기지에서 옛 분대 기록 회수 → 은퇴 전 카민 I 마지막 원정 (네임드 처치) |
| 민지후 | 4 (`q_ce_s1`–`s4`) | 야생 약초 비교 → 함선 작물 영양 증명 → 본부장이 원하는 해석 전 세포 (의심 시작) → 배양 고기 전투식량 시제품 |
| 서하람 | 5 (`q_ce_e1` · `q_ce_permit` · `e2`–`e4`) | 분석기로 얻은 세포 → CRSC 채굴 인가 → 레이븐보다 먼저 연구소 기록 말소 → 고급 배양 산물 → 연구소 2층 잠긴 방의 봉인 표본 |
| 레이븐 | 4 (`q_rv_1`–`rv_4`) | 정보망 운영비 → 아켈론 II 에서 한서진의 비밀 장부 (바스티온 신뢰도) → 서하람이 지우기 전 세레스 기록 (헬릭스 신뢰도 · 키카드) → 암호화 코어 경매 · 안드로이드 경비망 |
| 케인 | 4 (`q_kn_1`–`kn_4`) | 피로스 VII 레이더로 증명 → 카민 I 레이더 보급선 차단 → 산탄 매복 → 네임드 저격수 로든 처치 |

설계 메모: 안드로이드 처치는 전부 아켈론 II(threat 1), 레이더만 요구하는 행성 조건은 피로스 VII · 카민 I(threat 3), 네임드(헤비 · 로든 · 아무나) 3개는 행성 조건 없이 후반에만.
전차(`RAIL_CHANCE` 0.7)는 퀘스트 1개, 연구소 잠긴 방(2층 50 % × 키카드)은 1개, 지하실 문은 열쇠를 보상으로 준 다음 퀘스트 1개에만 쓴다.
