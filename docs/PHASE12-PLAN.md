# Phase 12 — 임플란트 아이템 · 배리어 rework · 정찰 rework · 총알 추적 · UX 정리 (2026-09-08)

Branch `feature/implant-system-barrier-scan-ux`. Contract committed first (`src/shared`, last README section), then 7
folder-scoped agents in parallel. Where this file and `CLAUDE.md` disagree, `CLAUDE.md` wins.

## User decisions (asked up front)
- 임플란트 장착칸: **기본 4칸, 5레벨마다 +1, 상한 10** (`IMPLANT_SLOTS_*`).
- 임플란트 판매 · 망가진 임플란트 수리(조합): **세레스 바이오** (기업 탭에 임플란트 서브탭).
- 전설 퍽 3종 **실제 구현**: `auto_revive` 재기동 회로 · `quick_heal` 가속 대사 · `kill_stamina` 아드레날린 펌프.
- AI 총알 추적: **방향 주시(3 s, 감지 2배) 후 발사 지점으로 전진**; 버그는 바로 이동.

## Work items → owner

| # | Item | Owner agent (folders) |
|---|---|---|
| 1 | 배리어: 좌우로 넓게, 버그 통과 불가(충돌), 부딪힌 버그는 방패 든 플레이어를 우선 공격, 정면 근접공격은 방패가 대신 맞음 | **A implants** (`src/implants/`) — `resolveBarrierCollision` / `absorbFrontalAttack`, width; **B enemies** (`src/enemies/`) — collision + retarget + absorb call + `ee barrierHit` |
| 2 | 배리어 들고 좌클릭 / 근접키 = 실드 배쉬 (스태미나 소모, 개머리판 보너스 없음, 방패 폭만큼 정면 근접) | **A implants** (pose via `player.startMelee('heavy')`, damage via `ctx.enemies.queryNear`, `imp bash`) |
| 3 | 감지 스탯: 근처 적을 나침반에 빨간색 + 인디케이터 (스탯 높으면 더 멀리) | **F ui** (`hud/Compass`, `hud/Detection`) |
| 4 | 정찰: 이동 중 사용, 한 번 누르면 넓게 스캔, 15 s 동안 자신 + 아군에게 상호작용물 · 적 인디케이터, 나침반, 벽 뒤 적 적색 실루엣 | **A implants** (`mode:'instant'`, `imp scanCast`, `scan:cast`, `setXray` 호출) · **B enemies** (`setXray` 실루엣) · **F ui** (나침반 · 인디케이터 15 s) |
| 5 | 임플란트 아이템 시스템 (등급 · 칸 · 능력치 · 전설 퍽 · 망가진 임플란트 · 수리 · 함선에서만 교체 · 퀘스트 보상) | **C items+progression** (`src/items/`, `src/progression/`) · **D meta** (`src/meta/`, `src/shared/meta.ts` 데이터) · **E weapons+player** (퍽 효과) · **G inventory** (타일 툴팁 · 카탈로그 탭) |
| 6 | 일시정지 메뉴가 항상 최상위 (템창 위에서 둘 다 못 끄는 상태 수정) | **H game+electron** (`src/game/`, `src/ui/menus/MenuBase.ts`, z-index) |
| 7 | 분해 중 가로 게이지 | **G inventory** (`ui/DisassemblePanel`) |
| 8 | 채집 시 채집 티커 제거, 아이템 획득 티커만 | **F ui** |
| 9 | 지속 사용 아이템(회복 스프레이) 티커 하나 유지 · 게이지 0 이어도 아이템 유지(내구도 0) · 함선 수리로 회복 · 게이지 200 | **E weapons** (`item:channelChanged`, 0 에서 삭제 금지) · **G inventory** (수리 목록에 스프레이) · **F ui** (티커) · 상수는 계약에서 200 |
| 10 | 저격소총 등 정밀 사격이 약간 왼쫙으로 쏠림 — 원인 확인 · 수정 | **E weapons** |
| 11 | 로그 · 버그 AI 가 감지 범위 밖에서 온 총알에 반응 (주시 → 전진 → 발견 시 교전) | **B enemies** (`reportShot`, `shotq`) · **E weapons** (`ctx.enemies.reportShot` 호출) |
| 12 | `start-game.bat` 제거, 실행은 `SCAVANGER.exe` 로 (서버만 배치) | **H game+electron** (root, `CLAUDE.md` 명령 표, `electron/README.md`) |
| 13 | 브라우저: 커서 화면을 ESC 로 닫으면 블러 유지 + 중앙 '좌측 클릭으로 게임 재개' → 클릭 시 재개; 자기 키(Tab)로 닫으면 바로 재개 | **H game** (`RESUME_GATE_BLOCKER`, `ui:resumeGate`) |
| 14 | Electron: 재개 게이트 없음, 커서가 필요 없을 때는 항상 숨김 (Alt 예외) | **H game+electron** (`isDesktopShell()`) |
| 15 | 컷씬 중 우하단 시설관리 · 우상단 커뮤니티 버튼 숨김; 공용 함선에서 시설관리 버튼 숨김 | **F ui** (`hud/ShipManageHint`, `hud/Community`) |
| 16 | 시설관리에서 빈 방 + 우측 시설 버튼 → 중앙 모달리스 확인 팝업(재료 썸네일) → 확인 시 지정; "재료가 충분해 보이는데 제작이 안 됨" 원인 수정 | **F ui+housing** (`hud/ShipManage`, `src/housing/`) |

## Contract summary (see `src/shared/README.md` § 2026-09-08)
- `types.ts`: `ItemCategory 'implant'`, `ItemDef.implant: ImplantItemDef {slots, stats, perk?, broken?, repairsTo?, repairCost?}`,
  `EnemyManagerRef.reportShot(origin, dir, range, hit|null)` / `setXray(ids, seconds)`.
- `progression.ts`: `PerkId` + `PERK_DEFS`, `EquippedImplant`, `PlayerProfile.implants?`, `DerivedStats.perks`,
  `ProgressionRef.implantSlots / implantSlotsUsed / getEquippedImplants / equipImplant / unequipImplant / getStatWithImplants / getImplantBonus`.
- `implants.ts`: `ImplantsRef.resolveBarrierCollision(pos, radius) → owner|null`, `absorbFrontalAttack(owner, fromPos, amount) → bool`, `bashing`.
- `net.ts`: `shotq` (`ShotReport`), `ee barrierHit`, `imp bash`, `imp scanCast`.
- `events.ts`: `progress:implantsChanged`, `implant:bashed`, `implant:barrierBumped`, `enemy:shotAlerted`, `scan:cast`,
  `ui:resumeGate`, `inventory:disassembleProgress`, `item:channelChanged`.
- `constants.ts`: `IMPLANT_SLOTS_*`, `IMPLANT_SHIELD_BASH_*`, `IMPLANT_SCAN_RADIUS` / `_REVEAL_TIME_V2` / `_COOLDOWN_V2`,
  `ENEMY_SHOT_ALERT_*`, `COMPASS_ENEMY_COLOR`, `RESUME_GATE_BLOCKER`, `HEAL_SPRAY_GAUGE` 100 → 200.
- `labels.ts`: 임플란트 label / colour / icon. `cursor.ts`: `isDesktopShell()`.
- Lead-owned stubs (to be replaced): `EnemySystem.reportShot / setXray`, `ImplantSystem.resolveBarrierCollision /
  absorbFrontalAttack / bashing`, `ProgressionSystem.implant*`, `derive.ts perks`.

## Rules for every agent
- Edit only your folders. `src/shared` is frozen except where this plan names you (values of existing constants in
  your area; meta data in `shared/meta.ts` for agent D). Need something else? Say so in your report — do not add it.
- `npm run typecheck` green before you finish. Then `npm run verify --folders <yours>` (or the mapped smokes) against a
  private vite (`npx vite --port 52xx`) — other agents' vite reloads kill smokes.
- Update your folder `README.md`. Do **not** edit `CLAUDE.md` (lead does) — put the one-line folder-map delta in your report.
- Korean UI text. No asset files. No React. Reuse scratch vectors.
