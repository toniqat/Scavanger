# 튜토리얼 개편 — 레이드에서 시작한다 (2026-09-14, 사용자 결정)

> 이 문서는 **계약과 분담의 원본**이다. 구현하는 사람은 자기 폴더 절만 읽으면 되지만,
> `## 2. 계약` 은 전부 읽는다 — 여섯 폴더가 그 한 장에서 만난다.

## 0. 한 줄

새 캐릭터는 **함선 없이 튜토리얼 행성에서 깨어나** 조작을 하나씩 배우고, 버려진 함선을 타고 탈출해
**그 함선을 자기 함선으로 삼는다.** 함선에 들어와 레벨업 · 스탯 투자 · 메신저 NPC 연락을 거치고,
시설 증축 · 제작은 그 뒤 별도 트랙으로 안내한다.

## 1. 결정 (2026-09-14, 사용자)

| 항목 | 결정 |
|---|---|
| 맵 | `MissionMode += 'tutorial'` · `world/tutorial/` 가 **손으로 지은 월드**를 만든다 (`TrainingArena` 와 같은 방식 — 절차 생성기를 아예 안 탄다) |
| 전역으로 들어가는 것 | **낙하 피해**(치사 가능) · **소모품 퀵슬롯 자동 장착** |
| 튜토리얼 전용 | 체크포인트 부활 · HUD 점진 노출 · 좁은 감지범위 적 · 절벽 낙사/클램프 |
| 진입 | 캐릭터 생성 → **함선을 거치지 않고** 튜토리얼 레이드 → 탈출 = 함선 획득 |
| 사망 | 본편 규칙 그대로 **내 시체**가 서고 장비가 그 안에 남는다. 체크포인트에서 부활. 처치한 적은 부활하지 않는다 |
| 조작 가이드 | 화면 **우측 전용 패널** 신설 (우하단 키 가이드와 별개) |
| NPC | `npc_raven` 재사용 + 메신저 **대사 선택지** 기능 신설 (어느 쪽을 골라도 대화는 같은 자리로 흐른다) |
| 트랙 | **3개**, 각각 따로 건너뛴다 — ① 레이드 조작 ② 스탯 · NPC ③ 증축 · 제작 |

### 지키는 규칙

- **「시체가 적 감지 범위 안에 떨어진다」를 맵으로 막는다.** 무기를 잃은 채 벌레 옆 시체를 주우러 갈 수는 없다 —
  각 구간의 체크포인트는 **그 구간의 적 감지 범위 밖**에 두고, 적 감지 반경(`sense`)을 그 거리보다 짧게 잡는다.
  그래도 막히는 배치가 나오면 맵을 고치지 규칙을 고치지 않는다.
- **본편 규칙을 예외로 뚫지 않는다.** 「자동 부활 없음」은 그대로이고, 체크포인트 부활은
  `ctx.missionMode === 'tutorial'` 안에서만 사는 별도 갈래다. `player:respawn` 은 이미 있는 계약이라 그것을 쓴다.
- **수치는 csv 에.** 낙하 피해 · 감지 반경 · 지급품 · 보상 XP 전부 `data/constants.csv` · `data/tuning.csv`.
- **`src/shared` 는 추가만.** 아래 계약 절의 모든 항목은 새 이름이거나 새 선택 필드다.

## 2. 계약 (리드가 먼저 커밋한다 — 에이전트는 이것을 전제로 시작한다)

### 2.1 `src/shared/types.ts`

```ts
export type MissionMode = 'raid' | 'training' | 'tutorial';
```

`WorldRef` 에 한 줄 (`training` 과 같은 자리 · 같은 규약):

```ts
/** `ctx.world.tutorial` — 튜토리얼 월드일 때만. 체크포인트 · 낙하 규칙 · 지금 구간. */
readonly tutorial: TutorialWorldRef | null;
```

`PlayerRef` 에 한 줄:

```ts
/**
 * 튜토리얼 오프닝 — 쓰러진 자세로 시작해 `durationS` 에 걸쳐 일어난다. 그 동안 입력이 잠기고
 * 카메라는 player/ 가 든다. 끝나면 `player:introWakeDone` · 평소 3인칭 백뷰로 하드 컷.
 */
playIntroWake?(durationS: number): void;
```

`ExtractionRef` 에 한 줄 (튜토리얼의 버려진 함선 = **이미 착륙해 있는 탈출선**):

```ts
/**
 * 호출 · 착륙을 건너뛰고 그 자리에 착륙한 상태(`landed`)로 세운다. 튜토리얼 전용 —
 * `ctx.missionMode !== 'tutorial'` 이면 false. `autoDepart: false` 면 무응답 자동 출발을 걸지 않는다.
 * 스위치 → 10초 유예 → 이륙 → 결과 · 정산은 평소 경로 그대로다.
 */
beginPreLanded?(position: THREE.Vector3, yaw: number, opts?: { autoDepart?: boolean }): boolean;
```

### 2.2 `src/shared/tutorialWorld.ts` (신규)

```ts
/** 체크포인트 id — 순서대로. 죽으면 마지막으로 지난 곳에서 다시 선다. */
export type TutorialCheckpointId =
  | 'wake' | 'cliff' | 'corpse' | 'bugs' | 'crawl' | 'android' | 'drop' | 'supply' | 'wall' | 'ship';

/** 이 자리에서 떨어졌을 때의 규칙. */
export type TutorialFallRule = 'normal' | 'kill' | 'clamp';

export interface TutorialWorldRef {
  /** 마지막으로 지난 체크포인트 (시작은 'wake'). */
  readonly checkpoint: TutorialCheckpointId;
  /** 부활 자리 (발 위치) · 바라볼 yaw. */
  respawnPose(): { position: THREE.Vector3; yaw: number };
  /**
   * `position` 에서 떨어졌을 때의 규칙.
   *   'kill'   = 즉사 (절벽 1)
   *   'clamp'  = 피해를 주되 체력 1 밑으로는 안 내려간다 (절벽 2)
   *   'normal' = 전역 낙하 피해 그대로
   */
  fallRule(position: THREE.Vector3): TutorialFallRule;
  /** dev 콘솔 · 스모크: 그 체크포인트로 순간이동한다. */
  gotoCheckpoint(id: TutorialCheckpointId): boolean;
  /** 이 월드가 세워야 할 적 전부 (`TutorialEnemySpawn` — type · position · yaw · sense · leash). */
  enemySpawns(): readonly TutorialEnemySpawn[];
}
```

**월드가 자리를, enemies 가 몸을 갖는다** — 폴더끼리 import 하지 않으려고 이렇게 갈랐다.
`enemies/` 는 `world:ready` 에서 `ctx.world.tutorial?.enemySpawns()` 를 **한 번** 읽어 그대로 세운다.

### 2.3 `src/shared/tutorial.ts` (확장 — 기존 id 는 한 글자도 안 바꾼다)

```ts
/** 트랙 — 각각 따로 건너뛴다. */
export type TutorialTrack = 'raid' | 'ship' | 'build';

export type TutorialStepId =
  /* ① raid — 튜토리얼 레이드 */
  | 'wake' | 'move' | 'sprintJump' | 'corpseLoot' | 'shoot' | 'crouch' | 'crouchAim'
  | 'drop' | 'heal' | 'grenade' | 'extract'
  /* ② ship — 함선 첫 진입 */
  | 'levelUp' | 'stats' | 'messenger' | 'ravenQuest'
  /* ③ build — 기존 17단계 그대로 (id 불변) */
  | 'intro' | 'manage' | ... | 'raid';

export const TUTORIAL_TRACK_STEPS: Readonly<Record<TutorialTrack, readonly TutorialStepId[]>>;

export type TutorialGate =
  | ...기존 11종...
  | 'hud';   // 숨김 전용. id = 'vitals' | 'weapon' | 'stamina' | 'implant' | 'stratagem'

export interface TutorialSave {
  version: 2;
  /** 트랙별 상태. 없는 트랙 = 아직 시작 전. */
  tracks: Partial<Record<TutorialTrack, { step: TutorialStepId | null; done: boolean }>>;
  room?: number;
  /** v1 세이브는 `step`/`done` 을 `tracks.build` 로 옮겨 읽는다. */
}

export interface TutorialRef {
  readonly track: TutorialTrack | null;   // 지금 도는 트랙
  // ... 기존 전부 그대로 ...
  /** 그 트랙만 건너뛴다. */
  skipTrack(track: TutorialTrack): void;
  /** 그 트랙이 끝났는가 (완주 · 건너뛰기 둘 다 true). */
  isTrackDone(track: TutorialTrack): boolean;
}
```

### 2.4 `src/shared/events.ts` (추가만)

```ts
/** 낙하 피해가 들어갔다 (전역). `rule` = 튜토리얼 클램프 · 낙사가 걸렸는지. */
'player:fell': { height: number; damage: number; rule: TutorialFallRule };
/** 튜토리얼 월드의 체크포인트를 지났다 (owner: world/tutorial). */
'tutorial:checkpoint': { id: TutorialCheckpointId; index: number };
/** 오프닝 기상 연출이 끝났다 (owner: player). */
'player:introWakeDone': Record<string, never>;
/** `tutorial:changed` 에 `track` 추가 (선택 필드). */
'tutorial:changed': { active: boolean; step: TutorialStepId | null; index: number; count: number; track?: TutorialTrack };
```

### 2.5 `src/shared/npc.ts` (대사 선택지)

```ts
export type NpcLogEvent = 'intro' | 'offer' | 'accept' | 'decline' | 'brief' | 'complete' | 'choice';
export interface NpcLogEntry { at: number; e: NpcLogEvent; q?: string; /** choice: 고른 번호 (0부터). */ c?: number }
```

`NpcDef` 에 선택 필드 둘 (`data/npcs.csv` 새 열 — 비면 선택지 없음):

- `introChoices?: readonly string[]` — 첫 연락 말풍선이 끝난 뒤 뜨는 **내 대답** 버튼들 (csv `introChoices`, `|` 구분)
- `introChoiceReplies?: readonly string[]` — 고른 번호에 대응하는 NPC 의 답 (csv `introChoiceReplies`, `|` 구분)

`getMessages` 가 `choice` 사건을 `{from:'me', text: introChoices[c]}` + `{from:'npc', text: introChoiceReplies[c]}`
두 줄로 푼다. **고른 뒤의 대화는 어느 쪽이든 같다** — 분기 상태를 저장하지 않는다.

### 2.6 `data/constants.csv` (신규 수치)

| key | 뜻 |
|---|---|
| `FALL_DAMAGE_SAFE_M` | 이 높이까지는 피해 없음 |
| `FALL_DAMAGE_PER_M` | 넘은 1 m 당 피해 |
| `FALL_DAMAGE_MAX` | 한 번의 낙하 피해 상한 |
| `TUTORIAL_ENEMY_SENSE_M` | 튜토리얼 적의 감지 반경 (매우 좁다) |
| `TUTORIAL_ENEMY_LEASH_M` | 이 거리를 벗어나면 자기 자리로 돌아간다 |
| `TUTORIAL_RESPAWN_DELAY_S` | 사망 → 체크포인트 부활까지 |
| `TUTORIAL_RAID_XP` | 튜토리얼 완주 보상 XP (레벨 2 에 닿는 양) |

낙하 피해는 **실드 → 체력** 순으로 들어간다 (평소 피해와 같은 경로). 튜토리얼 절벽 2 에서만
`fallRule === 'clamp'` 라 `hp` 가 1 밑으로 안 내려간다.

## 3. 폴더별 분담

### A. `src/world/tutorial/` — 손으로 지은 튜토리얼 행성
`TrainingArena.ts` 가 본보기다 (`game:newMission {mode}` 가 절차 생성기 대신 이것을 부른다).

- 고정 하이트맵 + 폐허 · **절벽 1**(달려서 점프해야만 넘는 폭) · **포복 구간**(선 채로는 못 지나는 기둥) ·
  **절벽 2**(낙하 피해를 보는 높이) · 무너진 벽 · 버려진 함선 자리.
- **안개 · 재해 · 상자 · 채집 · 둥지 · 전차 · 탐사 차량 없음.** `ctx.world.fog === null` 은 훈련장과 같다.
- 체크포인트 트리거 볼륨 10개 → `tutorial:checkpoint` · `TutorialWorldRef` 구현.
- 낙사 규칙 볼륨 (절벽 1 아래 = `kill`, 절벽 2 착지 구역 = `clamp`).
- 시체 3구 배치 — ① 무기 · 가방 · 탄약 ② 회복 아이템 · 수류탄 ③ (선택) 전리품.
  **컨테이너 굴림은 쓰지 않는다** — 고정 아이템 목록이다.
- 버려진 함선은 메시를 새로 만들지 않는다: `ctx.extraction.beginPreLanded(pos, yaw, {autoDepart:false})`
  가 **진짜 탈출선**을 그 자리에 세우고, 내부 스위치 · 10초 유예 · 이륙 · 정산이 평소 경로로 흐른다.
- 광원 예산: 튜토리얼 월드도 `SCENE_POINT_LIGHT_BUDGET` 를 지킨다 (`core/LightBudget` 이 여분을 채운다).

### B. `src/player/` + `src/game/` — 낙하 피해 · 체크포인트 · 기상 연출
- **낙하 피해(전역)**: `PlayerController` 의 착지(`!wasGrounded → grounded`)에서 낙하 시작 높이와의 차로 계산,
  `ctx.world.tutorial?.fallRule()` 을 물어 `kill` / `clamp` 를 적용하고 `player:fell` 을 낸다.
  사다리 · 갈고리 · 대시 · 전차 데크 · 탐사 차량 탑승 중에는 계산하지 않는다 (탑승자는 어떤 피해도 안 받는다).
- **체크포인트 부활**: `game/parts/Death` 의 훈련장 갈래 옆에 튜토리얼 갈래를 둔다 —
  시체는 평소대로 서고(`stripForCorpse` · `spawnLocalCorpse`), `TUTORIAL_RESPAWN_DELAY_S` 뒤
  `respawnPose()` 자리에서 `player:respawn`. **레이드 실패 없음 · 솔로 세션을 지우지 않는다**
  (`clearSoloRaid()` 를 튜토리얼에서는 부르지 않는다 — 새로고침하면 체크포인트부터 이어 한다).
- **기상 연출**: `playIntroWake` — 쓰러진 자세 · 카메라가 몸을 비추다 일어서며 백뷰로 하드 컷.
- 튜토리얼 레이드는 **솔로 강제**다 (매치메이킹 · 로비 진입 자체가 없다).

### C. `src/tutorial/` — 3트랙 단계 기계 · 우측 조작 가이드 · HUD 게이트
- `TutorialSave` v2 (트랙별) · v1 마이그레이션(`step`/`done` → `tracks.build`).
- 트랙 ①/②/③ 각각 자기 목표 패널 · 자기 건너뛰기(1초 홀드).
- **우측 조작 가이드 패널** 신설 — 배운 조작이 한 줄씩 쌓이고 사라지지 않는다. 우하단 키 가이드와 겹치지 않게
  세로로 쌓고 CSS 접두사는 `tut-` 를 이어 쓴다.
- **HUD 점진 노출**: `hides('hud', id)` — `vitals`(체력 · 실드)와 `weapon` 은 시체에서 무기를 얻기 전까지,
  `stamina` 는 처음 소모되기 전까지, `implant` · `stratagem` 은 튜토리얼 내내 숨긴다.
- 진행 판정은 **버스 이벤트 관찰** 그대로 (`tutorial:checkpoint` · `enemy:killed` · `player:stanceChanged` ·
  `inventory:changed` · `weapon:fired` · `player:fell` …). 남의 폴더를 들여다보지 않는다.

### D. `src/enemies/` — 튜토리얼 전용 적
- 벌레 2 · 안드로이드 4 를 **고정 자리 · 고정 종류**로 세운다. 굴림 없음 · 웨이브 없음 · 순찰 없음.
- 감지 반경 `TUTORIAL_ENEMY_SENSE_M` · 이탈 거리 `TUTORIAL_ENEMY_LEASH_M`.
- 벌레 난이도 배수(threat 표)는 튜토리얼에 붙지 않는다 (행성이 없다 — 훈련장과 같은 처리).
- 안드로이드 외피 · 피 대신 불꽃 · 시체 전리품은 본편 그대로.

### E. `src/inventory/` + `src/hub/` + `src/game/` — 퀵슬롯 자동 장착 · 진입 순서
- **소모품 퀵슬롯 자동 장착(전역)**: 주운 아이템이 퀵슬롯에 올릴 수 있는 종류이고 **빈 칸이 있으면** 그 칸에 올린다.
  이미 같은 종류가 휠에 있으면 그쪽에 합친다. 「퀵슬롯은 가방 격자가 아니다」 규약 그대로 — 옮기기이지 복사가 아니다.
- **진입 순서**: `ui/menus/enterShip` 가 갈림길이다. 튜토리얼 트랙 ① 이 아직 안 끝난 **새 캐릭터**면
  `hub:enter` 대신 튜토리얼 레이드를 시작한다 (`ctx.missionMode='tutorial'` → `game:newMission {seed, mode:'tutorial'}`).
  탈출 정산 뒤 `hub:enter {ship:'personal'}` 로 함선 첫 진입 = **함선 획득**.
- 트랙 ③ 은 함선 안에서 시작한다 — 기존 자동 시작 조건(`looksFresh`)을 트랙 ③ 판정으로 옮긴다.

### F. `src/meta/` + `src/ui/menus/messenger/` — 레이븐 · 선택지 · 스탯 안내
- `npc_raven` 의 `intro` 를 전 함선 주인의 연락책으로 다시 쓰고 `introChoices` 두 개를 단다
  (부정 / 수긍 — 어느 쪽이든 흘려 넘긴다). `data/npcs.csv` 새 열 둘.
- 메신저 말풍선 아래 **선택지 버튼 줄** (퀘스트 카드의 `[수락] [생각해보지]` 와 같은 문법 · 같은 CSS).
- 트랙 ② 의 첫 퀘스트는 레이븐의 기존 퀘스트 줄 중 하나를 쓰거나 `npc_quests.csv` 에 튜토리얼용 한 줄을 더한다.
- 스탯 투자 안내는 기존 캐릭터 시트의 `포인트 투자 확정`(1초 홀드)을 스포트라이트로 가리킨다 — 새 UI 없음.

## 4. 검증

- `npm run typecheck` · `npm run data:check` (새 csv 열 · 새 상수).
- `scripts/smoke-tutorial.mjs` 를 **트랙별로 가른다** — ① 은 튜토리얼 레이드를 콘솔로 체크포인트마다 건너뛰며
  끝까지, ② 는 함선 첫 진입 · 스탯 확정 · 메신저, ③ 은 기존 86검사 그대로.
- 다른 스모크는 여전히 `scav.tutorial` 을 `done` 으로 심는다 — **v2 모양으로** 심어야 한다
  (`tracks: {raid:{done:true}, ship:{done:true}, build:{done:true}}`). 이 한 줄을 안 고치면 모든 스모크가 빨개진다.
- 새 스모크 `smoke-fall-damage.mjs` — 전역 낙하 피해(안전 높이 · 상한 · 실드 우선)와 튜토리얼 클램프.
