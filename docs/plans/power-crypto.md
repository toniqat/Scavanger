# 가구 배치 규칙 · 발전기 전력 · 암호화폐 채굴 (2026-09-13)

> ⚠ **전력 절은 같은 날 폐지됐다** (사용자 결정 「발전기의 전력 할당 시스템 너무 빡세다 — 제거하고 상위 시설을 제작하기 위한 조건으로만」).
> 할당 · 비활성화 · 멈춘 시계 · 자동 보충 · 가구 / 용도 `power` 가 전부 없어졌고, 발전기는 Lv.1–5 · 용도별 증축 게이트
> (Lv.2 온실 · 주방 / Lv.3 연구실 / Lv.4 헬스장 · 서재 / Lv.5 채굴 시설) + 기존 가구 · 창고 강화 게이트뿐이다. 메인 컴퓨터 필수 규칙은 남는다(「가동 중」 → 「배치됨」).
> 아래 표와 「전력」 절은 기록으로만 읽는다 — 현재 규칙은 `CLAUDE.md` §4 와 `src/housing/README.md` 변경 이력.

리드가 계약(`src/shared/*`)과 데이터 열(`data/*.csv`)을 먼저 넣었고, 기능 폴더 에이전트 5명이 병렬로 구현한다.
계약 원본: `src/shared/housing.ts` 끝의 「2026-09-13 — 가구 배치 규칙 · 발전기 전력 · 암호화폐 채굴」 절 ·
`src/shared/crypto.ts` · `src/shared/cryptoMarket.ts` · `src/shared/credits.ts`(`cbuy` · `csell`) · `src/shared/net.ts` 끝의 암호화폐 시세 절 ·
`src/shared/events.ts` 끝 · `src/shared/meta.ts` 끝(`MetaRef.creditsTx`).

## 사용자 결정

| 질문 | 결정 |
|---|---|
| 전력 분배 | **수동 할당** — 발전기 화면에서 시설마다 전력을 배분, 할당 < 요구면 그 시설의 가구 전부 정지 |
| 자동 채움 (구현 중 추가 질문) | **유지** — 요구량이 오른 시설은 **할당 안 된 전력에서만** 부족분을 가져온다 (다른 시설 · 손으로 줄인 시설은 안 건드린다, 모자라면 정지 + 토스트). `POWER_AUTO_TOPUP` = 1. 순수 수동이면 튜토리얼의 작업대가 놓자마자 막혔다 |
| 새 배치 규칙을 어기는 옛 배치 | **가구 창고로 뺀다** (로드할 때 `ShipState.sanitize`) |
| 거래소 | **매도 + 매수** — 서버 시세, 크레딧 사유 `cbuy` · `csell` 을 릴레이가 검증 |
| 잠긴 코인 4종의 해금 | **기업마다 새 퀘스트** (`hx_crypto` · `bs_crypto` · `nm_crypto` · `ce_crypto`) |
| 연산 클러스터 크기 | **1×2칸** (0.5 × 1 m), 회전 가능 |
| 메인 컴퓨터 | **필수** — 함선당 1대, 가동 중이어야 클러스터가 채굴한다. 코인 지정 · 지갑 · 거래소는 메인 컴퓨터 화면 (코인 지정은 클러스터 화면에서도) |
| 접근 면 분류 | 기본안 — 아래 표 (`data/furniture.csv` 의 `access`) |
| 전력 세부 | 코어 수만큼 클러스터 전력 증가 · 발전기 최대 Lv 5 → 10 · 서재 보너스도 전력 필요 · **조종석은 전력을 쓰지 않는다** |

리드가 정한 기본값 (질문하지 않은 것):
- 비워야 하는 칸끼리는 겹쳐도 된다 (마주보는 작업대 둘이 1칸 통로 공유). 모서리 칸은 비울 필요 없다.
- 채굴은 연속 — 주기가 끝날 때마다 지갑에 저절로 들어가고 다음 주기가 이어진다. 오프라인 · 레이드 중에도 흐른다 (서버 시계).
- 코어 수가 바뀌면 진행도를 접어 새 주기로 잇는다(손해 없음). 코인을 바꾸면 진행도 0.
- 전력이 끊긴 동안 재배 · 배양 · 해석 · 채굴 시계는 멈춘다 (썩지 않는다 — 사용자 명세의 편의 규칙). 제작 · 조리 · 운동 · 서재 보너스 · TV 켜기는 막힌다.
- 옛 세이브(할당이 없는 함선)는 v12 이관에서 방 순서대로 요구량만큼 자동 할당한다 — 업데이트 한 번에 모든 시설이 꺼지지 않게.
- 프로세서는 레이드에서 극히 드물다 (상자 T4–5 · 연구소/전진기지 컨테이너 · 안드로이드 시체). 연산 코어 = 회로 기판 + 프로세서.
- 오프라인(서버 없음): 채굴은 돈다, 차트 · 매매는 「서버에 연결되어야 합니다」.

## 접근 면 (`access`)

| 값 | 비워야 하는 칸 | 벽 | 상호작용 | 가구 |
|---|---|---|---|---|
| `front` | 앞(로컬 −Z) 한 줄 | 안 됨 | 앞에서만 | 작업대 5 · 추출기 · 조합대 · 3D 프린터 · 분석기 · 조리대 · 자동 조리 4 · 책장 · 디스크 전시대 · 레코드랙 · TV · 레코드 플레이어 3 · 메인 컴퓨터 · 시술대 · 기업 컴퓨터 |
| `sides` | 넓은 두 면(로컬 ±Z) 한 줄씩 | 됨 | 두 면 | 재배 스테이션 · 배양조 · 연산 클러스터 · 식탁 |
| `all` | 네 면 한 줄씩 | 됨 | 어느 면이든 | 헬스 기구 4 |
| `none` | — | — | 지금처럼 | 꾸밈 가구 · 흔들의자 |

격자 방향: yaw 0 앞 = y 감소, 1 = x 증가, 2 = y 증가, 3 = x 감소 (`furnitureFaceDir`). 칸 목록은 `furnitureClearanceCells`.

## 전력

- 공급 = `GENERATOR_POWER_BY_LEVEL[발전기 레벨]` (`data/tables.csv`, Lv.0–10).
- 시설 요구 = `ROOM_PURPOSE_POWER[용도]`(`room_purposes.csv` 의 `power`) + 그 방의 **활성** 가구 `power` 합 (+ 클러스터 코어 × `COMPUTE_CLUSTER_POWER_PER_CORE`).
- 할당: `ShipState.powerAlloc[방 번호]`, 합 ≤ 공급. 할당 < 요구 → 그 방 가구 전부 `furnitureOperationalBlock` = `POWER_SHORT_REASON_KO`.
- 비활성화: `ShipState.disabledFurniture` — 요구에서 빠지고 `FURNITURE_DISABLED_REASON_KO`. 버튼은 스테이션 화면 · 시설 관리 인스펙터의 업그레이드 옆.
- 멈춤: `ShipState.pausedAt[uid]` · `stationNow(uid)` · `housing:operationalChanged {pausedMs}` (받는 쪽이 자기 시각을 민다).

## 암호화폐

- 코인 8종 `data/crypto.csv` (열린 4 · 기업 4). 지갑 = 정수 단위, `CRYPTO_UNITS_PER_COIN` 단위 = 코인 1개.
- 주기 = `cycleHours × COMPUTE_CORE_TIME_MUL^(코어−1)`, 주기마다 `yieldUnits`.
- 시세: 릴레이가 `CRYPTO_TICK_S` 마다 코인별로 움직이고(기준가 근처 평균 회귀 + 하루 σ = `volatility`) 봉을 저장한다. `crypto:watch` · `crypto:history` · `crypto:prices`.
- 매매: `MetaRef.creditsTx(delta, formatCreditReason({kind:'crypto-buy'|'crypto-sell', id, qty: units}))` → 릴레이가 최근 `CRYPTO_QUOTE_WINDOW_S` 시세 창으로 금액 검증 → 성공하면 지갑 변경.

## 에이전트 분담

| 에이전트 | 소유 |
|---|---|
| ① 배치 규칙 | `housing/Rules.ts`(canPlaceAt · autoPlaceSpot · placementBlock), `ShipState.sanitize` 의 규칙 적용, `hub/interiors/Furniture.ts` 의 상호작용 앵커 · 방향 검사, `hub/HousingMode.ts` 고스트 · 비워야 할 칸 표시, 조종석 기본 배치 좌표, 스모크 |
| ② 전력 | `housing/parts/Power.ts` · 할당 · 비활성 · 멈춤 · v12 이관, Garden · Culture · Lab · Library · Gym · Cooking 게이트, 작업대 게이트(hub · inventory), 발전기 화면(`ui/hud/ShipManage`) · 인스펙터 · `StationShell` 비활성 버튼, 스모크 |
| ③ 채굴 규칙 · 데이터 | `housing/parts/Mining.ts` · 지갑 · 매매(`tradeCrypto`) · `ShipState` 채굴 필드, `meta` 의 `creditsTx`, items(프로세서 · 연산 코어 · 레시피 · 루팅), 퀘스트 납품 조정, 콘솔 치트, 스모크 |
| ④ 채굴 화면 · 모델 | `housing/ui/mining/*`(클러스터 화면 · 메인 컴퓨터: 현황 · 지갑 · 거래소 차트), `hub/interiors/FurnitureMining.ts` 모델 · 상호작용 연결, 툴팁 |
| ⑤ 서버 시세 · 네트워크 | `server/CryptoMarket.ts` · 저장 · 메시지, `server/Economy.ts` 의 `cbuy`/`csell`, `scripts/economy-table.mjs` 의 `crypto` 절, `selftest`, `net/parts/Crypto.ts`(`ctx.net.crypto`) |
