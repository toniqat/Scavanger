# 캐릭터 버프 · 가구 자세 동기화 — 설계안 (2026-09-12)

A-3a · A-3e(헬스장 · 서재 매체) 바로 뒤의 후속 요청. 리드가 `src/shared` 계약을 먼저 쓰고 폴더별 에이전트 4개(player · net · hub · ui)가
병렬로 채운다. 구현이 끝나면 결과는 `docs/HISTORY.md` 로 옮긴다.

## 1. 사용자 명세

> 의자에 앉기, 운동하기 등 시설 상호작용 상태를 캐릭터의 버프로 변경. 중간에 함선 방문한 다른 플레이어에게 해당 캐릭터 정보를
> 불러올 때 버프와 같이 불러와서 의자에 앉음 / 운동 애니메이션 진행을 제대로 동기화시킴.

지금(A-3a · A-3e 직후)은 가구 자세가 **로컬 전용**이다 — 스냅샷에 없어서 개인 함선을 방문한 분대원에게는 주인이 서 있다.

## 2. 사용자 결정 (AskUserQuestion 2라운드)

| 질문 | 결정 |
|---|---|
| 버프 목록에 담을 것 | **전부** — 가구 상호작용(휴식 · 운동) + 운동 디버프(근육통 · 심폐 피로) + 식사 + 준비물 (+ 환경 노출) |
| 표시 위치 | **함선에서도 PC 체력바가 보이게** 하고, **PC 체력바 아래** 작은 버프/디버프 썸네일. **분대원도 체력바 아래** 썸네일 |
| 분대원 썸네일 자리 | **좌하단 분대 목록** 행의 체력바 아래 (월드 명판 아님) |
| 기존 글자 배지 3개 (레이드 식사 · 환경 · 함선 운동 디버프) | **썸네일로 대체** — 배지는 걷어낸다 |
| 남은 시간 표시 | **아이콘 + 시간 게이지** (+ 짧은 시간 글자) |
| 함선의 「다음 레이드에 실린」 식사 · 준비물 | **보인다 — 대기 표시**(흐리게), 출격하면 선명해진다 |
| 운동 동기화 수준 | **실제 동작 그대로** — 바벨 높이 · 걸음 · 크랭크 위상과 기구 상태(원반)가 방문자 화면에서도 같다 |
| 버프 효과 | **없음** — 표시 · 동기화용 |

## 3. 리드 기본값 (묻지 않고 정한 것)

- 버프에는 효과가 없으므로 **권위 검사가 없다** — 받는 쪽은 로비 멤버 여부와 모양(`sanitizeCharBuffs`)만 본다. 효과의 원본(요리 `derived`,
  준비물 `hasEnvPrep`, 디버프 `applyGymSession`)은 한 줄도 안 바뀐다.
- 분대 목록의 **내 줄에는 썸네일을 달지 않는다** — 내 것은 PC 체력바 아래에 이미 있다.
- 함선의 PC 체력바는 **이름 · 실드 · 체력**(함선에서는 늘 가득)만. 스태미나 바는 레이드 전용 그대로.
- 개인 함선 방문자는 가구를 쓸 수 없으므로(둘러보기 전용) 원격 자세는 사실상 **함선 주인** 것뿐이지만, 코드는 같은 `hubSite` 의 누구든 받는다.
- 원격 자세의 **발 x · z 는 스냅샷 `p`**(자세 중 player 가 발을 anchor 에 박는다), 높이 · 방향 · 위상만 `fp` 로 온다.

## 4. 버프 목록 규칙 (owner: player)

| kind | key | 언제 | state | 타이머 |
|---|---|---|---|---|
| `meal` | `meal` | 함선: `progression.getMeal()` · 레이드: `getActiveMeal()` | 함선 `pending` · 레이드 `active` | 없음 |
| `prep` | `prep:<env>` | 함선: `getPreps()` 각각 · 레이드: `getActivePreps()` 각각 (env = `def.prep.env`) | 같다 | 없음 |
| `env_exposed` | `env` | 레이드에서 player 의 환경 판정이 `env !== null && !protected` | `active` (디버프) | 없음 |
| `gym_fatigue` | `fatigue:<stat>` | 어디서든 `getGymFatigueUntil(stat) > now` | `active` (디버프) | `startedAt = until − GYM_FATIGUE_HOURS h`, `endsAt = until` |
| `rest` | `pose` | 가구 자세 `sit` | `active` | 없음 |
| `exercise` | `pose` | 가구 자세 `bench` · `run` · `cycle` (+ `housing.gymSession` 이 있으면 `stat` · `minigame`) | `active` | 없음 |

- 시각은 `ctx.net?.serverNow?.() ?? Date.now()`.
- 다시 모으는 때: `progress:mealChanged` · `progress:prepChanged` · `progress:gymFatigue` · 자기 환경 판정 변화 · 자세 시작/끝 ·
  `housing:gymSession` · `game:newMission` · `game:abort` · `hub:entered` + **1 초 틱**(디버프 만료). `sameCharBuffs` 로 같으면
  리비전을 올리지 않는다 — 올릴 때만 새 배열 + `player:buffsChanged`.

## 5. 와이어 (owner: net)

```
내 목록 변경 ── player:buffsChanged ──▶ net: cbuf state {rev, buffs} → others (같은 프레임의 여러 변경은 하나로)
20 Hz 스냅샷 ── bfr = buffsRevision, fp = [pose index, anchorY, yaw, 누적 위상], fu = 조각 uid (자세 중만)
받는 쪽 ── cbuf state: 로비 멤버만 · sanitizeCharBuffs → ref.buffs / buffsRevision → net:remoteBuffsChanged
       └─ 스냅샷 bfr ≠ ref.buffsRevision → 그 사람에게 cbufq sync (CHAR_BUFF_SYNC_COOLDOWN_S 에 한 번)
       └─ cbufq sync 에 답한다 (요청자별 같은 쿨다운)
       └─ fp/fu → ref.furniturePose (위상은 스냅샷 보간 — 누적값이라 감김 없이 선형), 고스트 · stale 이면 null
```

## 6. 폴더별 할 일

### 6-A. player
- `PlayerRef.buffs` · `buffsRevision` · `player:buffsChanged` (§4 규칙, 새 part 파일 권장 — 예: `parts/Buffs.ts`).
- `FurniturePose.furnitureUid` 를 받아 두고 `furniturePoseState` 를 낸다 — `phase` 는 **누적**(run = 걸음 수 + 위상, cycle = 바퀴 수, bench 0 … 1).
- `RemoteAvatar` 가 `ref.furniturePose` 로 원격 자세를 그린다: 로컬과 같은 `SoldierModel` 자세 필드 · 같은 블렌드, 루트는 `(ref.position.x, anchorY, ref.position.z)`,
  몸 방향은 로컬 규칙(`bench` = yaw + π), `run` 은 보행 주기에 누적 걸음 위상. 자세가 끝나면 블렌드로 서기.
- 스모크: `smoke-pose` 에 버프 모으기(식사 · 준비물 pending/active · 디버프 타이머 · 휴식 · 운동 + 리비전이 같은 목록에서 안 오른다) ·
  `furniturePoseState` 누적 위상 · `RemoteAvatar` 원격 자세(디버그 원격 ref 로).

### 6-B. net
- `Snapshotter`: `bfr` · `fp` · `fu`. `RemotePlayer`: `buffs` · `buffsRevision` · `furniturePose`(보간) · 고스트 때 자세 null.
- `cbuf` · `cbufq` 송수신 (§5), 모든 페이즈에서(함선 · 레이드). 새 멤버 합류 · 재접속은 `bfr` 불일치로 자연히 따라온다.
- `e2e-mp` 에 두 브라우저 검사: A 의 버프(예: 운동 디버프 · 식사)가 B 의 `ref.buffs` 로 오고, A 가 자세를 취하면(맨 anchor 로 충분) B 의
  `ref.furniturePose` 가 kind · 위상을 따라오고, **B 가 새로고침으로 늦게 붙어도** 리비전 불일치로 목록을 받는다.

### 6-C. hub
- `FurniturePose.furnitureUid` 를 흔들의자 · 운동 세션 자세에 넣는다.
- **방문자 쪽 가구 연출**: 같은 `hubSite` 의 원격 분대원이 `furniturePose.furnitureUid` 로 가리키는 조각을, 그 사람의 보간 위상으로 돌린다 —
  벤치 · 스미스 원반 표시 + 바 위치(거치대 → 누르기 경로, 로컬 `GymStaging` 과 같은 식), 트레드밀 벨트(위상 차이 × 걸음 길이), 사이클 크랭크 ·
  페달 · 플라이휠(바퀴 수), 흔들의자 흔들림. 방문한 함선(`FurnitureSource`)과 내 함선 둘 다에서 동작해야 한다.
- 스모크: `smoke-housing` 또는 새 검사로 디버그 원격 ref 가 조각의 원반 · 바를 움직이는지.

### 6-D. ui
- **PC 체력바를 함선에서도** 보이게 한다 (이름 · 실드 · 체력, 스태미나는 레이드 전용).
- 공용 썸네일 줄 컴포넌트(예: `hud/BuffStrip.ts`): 썸네일마다 글리프(`meal` · `prep` 은 아이템 def 의 icon · color, `env_exposed` 는 `ENV_ICON` · `ENV_COLOR`,
  나머지는 `CHAR_BUFF_GLYPH` · `CHAR_BUFF_COLOR`), `pending` 은 흐리게, 디버프는 빨간 테두리, 타이머가 있으면 **시간 게이지**(남은 비율로 줄어드는
  덮개) + 아주 작은 시간 글자(`23h` · `42m` · `35s`), `title` = `charBuffTitle`. 키로 DOM 재사용, 1 초 틱은 타이머가 있을 때만.
- 붙일 곳: **PC 체력바 바로 아래**(`ctx.player.buffs` + `player:buffsChanged`) · **좌하단 분대 목록의 분대원 행 체력바 아래**(`ref.buffs` +
  `net:remoteBuffsChanged`, 내 줄 제외).
- **걷어낼 것**: `hud/MealBadge` · `hud/EnvBadge` · `hud/GymFatigueBadge` 와 그 CSS · 디버그 게터 · HudSystem 등록, 그리고 그것을 쓰던 스모크 검사
  (`rg "shownMeal|shownEnv|gymFatigue|meal-badge|env-badge|gfat-" scripts src` — 같은 정보를 버프 줄로 검사하게 옮긴다).
- 스모크: 새 `smoke-buffs`(또는 기존 ui 스모크) — 로컬 줄(가짜 목록 · 흐림 · 디버프 · 게이지 · 시간 글자) · 분대원 줄(`HudSystem.debugRemotes` 에 buffs 달린 ref) ·
  함선에서 체력바가 보인다.

## 7. 병렬 작업 규칙

1. 자기 폴더만 (`src/shared` · `data/` 금지 — 모자라면 보고). 스크립트 소유: player `smoke-pose`, net `e2e-mp`, hub `smoke-housing`, ui 새 스모크 + 배지 스모크 수정.
2. `npm run typecheck` — 자기 폴더 에러 0. 스모크는 5273 을 쓰지 않는다 (개인 포트 `npx vite --port 53xx --strictPort` + `node scripts/verify.mjs --only … --url … --log-dir scripts/logs/<이름> --keep-relay --no-typecheck`).
   **개인 vite 는 끝나면 반드시 종료를 확인한다** (지난 사이클에 셋이 살아 있었다).
3. 폴더 README(구조 + `변경 이력`)만 쓴다. `CLAUDE.md` · `docs/*` 는 리드. 커밋하지 않는다.
4. 끝나면 짧게 보고: 바꾼 파일, 계약에서 모자랐던 것, 확인 못 한 것.
