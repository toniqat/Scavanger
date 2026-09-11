# src/world/structures — 버려진 구조물 · 선로 부속의 파트

`world/` 의 하위 폴더다. 시스템도 `ctx` 게시도 없다 — 클래스는 한 단계 위의 `Structures.ts` · `Rails.ts` 이고, 여기에는
그 클래스가 쓰는 **어휘**(`model.ts`)와 **떼어낸 메서드 묶음**(`parts/`)만 있다. 설계 · 결정 · 알려진 한계는 전부
[`../README.md`](../README.md) 의 날짜별 절에 있다 (`2026-09-09: 버려진 구조물` · `2026-09-11: 볼록 콜라이더 · 경사 계단 · 2층 건물` ·
`2026-09-12: 구조물 도달성`).

| File | Role |
|---|---|
| `model.ts` | `data/structures.csv` 를 읽는 유일한 자리 (`STRUCTURE_ROWS` · `structureRow` · `pickTier`) + 건물 치수 상수(`WALL_T` · `DOOR_W` · `STAIR_*` · `OPENING_APPROACH` · `BASEMENT_*` …). THREE 를 값으로 쓰지 않는다. |
| `parts/Build.ts` | 건물 한 채의 지오메트리 + 콜라이더 (`buildBuilding` 전진기지 · 연구실, `buildWreck` 불시착 함선). 배치 결정(정문 → 격벽 · 계단 · 지하 구멍 · 통로 → 틈 — 출입구 앞마당을 막는 자리는 고르지 않는다), 층 · 창 · 사다리 · 계단 · 지하실 · 소품 · 컨테이너 자리 · 조명 자리, 도달성 스모크용 `StructureNav`. 기울거나 구른 메시는 `fitBox` · `propHullOf` 로 그린 정점에서 콜라이더를 잰다. |
| `parts/Stairs.ts` | 계단 한 줄 — 보이는 단 + 경사 콜라이더 하나 (구조물 · 선로 플랫폼 공용). |
| `parts/Containers.ts` | 상호작용 컨테이너 묶음 (구조물 · 플랫폼 · 전차). 콜라이더는 몸통 상자(움직이는 전차 안 것은 없음). |
| `parts/Glass.ts` | 창문 유리 (`InstancedMesh` 하나 + 얇은 상자 콜라이더, 깨지면 레이 · 작은 몸만 통과). |
| `parts/ScanWave.ts` | 옥상 맵 스캐너 파동. |

## 규약
- **콜라이더는 보이는 실루엣이다.** 새 메시를 더하면 같은 수로 콜라이더를 걸거나, 그림뿐인 이유를 주석에 적는다
  (사다리 가로대 · 문 위 장식처럼 몸이 닿지 않는 높이).
- **출입구 앞마당은 비운다.** 새로 막는 것(난간 · 덩어리)을 배치할 때 `OPENING_APPROACH` 사각형과 겹치지 않는지 본다 —
  `node scripts/smoke-structure-reach.mjs` 가 몸 반지름 flood fill 로 확인한다.
- `parts/` 는 `Structures.ts` · `Rails.ts` 에서 **타입만** 가져온다 (값이 필요하면 `model.ts` 로).

## 변경 이력
- **2026-09-12** — 이 README 를 만들었다 (폴더에 README 가 없었다). 같은 날의 구조물 도달성 작업은 `../README.md`.
