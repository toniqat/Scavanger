#!/usr/bin/env node
/**
 * Verification runner — the one command to run after a change.
 *
 *   node scripts/verify.mjs                      # --changed: smokes for the folders touched in the working tree
 *                                                #   (a narrow src/shared change picks the folders that use the changed exports;
 *                                                #    a wide one still goes full — see the comment at GLOBAL_PATHS)
 *   node scripts/verify.mjs --all                # everything (typecheck, build, selftest, every smoke in SMOKES, e2e) — before a merge
 *   node scripts/verify.mjs --folders weapons,ui # smokes mapped to those feature folders
 *   node scripts/verify.mjs --only smoke-weapons,e2e-mp
 *   node scripts/verify.mjs --rerun-failed       # only what failed in the previous run (scripts/logs/last-run.json)
 *   node scripts/verify.mjs --list               # folder → smoke map (+ src/ 밖의 경로 매핑)
 *   node scripts/verify.mjs --dry-run            # what the current change would run, and why — runs nothing
 *   node scripts/verify.mjs --help               # this text (an unknown option prints it too and runs nothing)
 *
 * Options: --jobs N (parallel Chrome instances, default 4 — 6 is faster but adds timing reds, see the note at `opts.jobs`;
 *          use 1–2 with SMOKE_GL=swiftshader, which is CPU-bound) · --serial · --base <git ref> (diff base for --changed,
 *          default = working tree vs HEAD, falling back to HEAD~1) · --build · --no-typecheck · --no-e2e ·
 *          --keep-relay (do not restart a relay already listening on 8787) · --url http://host:port/ · --timeout <min> ·
 *          --log-dir <dir> (default scripts/logs — give each concurrent runner its own, e.g. scripts/logs/agent-3)
 *
 * What it does:
 *   1. typecheck (client + server), data:check (data/*.csv 스키마) and check-css-prefixes (한 접두사는 한 폴더) in parallel — seconds. net:selftest (~50 s, its own
 *      random port) runs **alongside the smokes** and is awaited just before the summary.
 *   2. Starts vite (5273) and the relay (8787) if they are not up — **unless every selected script is `standalone`**
 *      (smoke-pitch, smoke-desktop, smoke-intel), which use neither. When e2e-mp is in the set the relay is always
 *      restarted first: public lobbies left by an interrupted run live for the 5-min grace and hijack quick match.
 *   3. Runs the selected smoke scripts concurrently (each owns its own headless Chrome on the real GPU via ANGLE D3D11,
 *      40–90 s each; the lanes' start times share one ~24 s ramp budget, so vite warm-up and Chrome launches never coincide). Output goes to
 *      scripts/logs/<name>.log; only the summary and the FAIL lines are printed. SMOKE_GL=swiftshader (no GPU / CI) is
 *      ~10× slower and CPU-bound: measured 2026-09-06, one script ≈ 140 s alone and 2 lanes gained nothing (31 min total).
 *   4. e2e-mp runs alone at the end (two browsers, 15 s waits — sensitive to CPU contention).
 *   5. Writes scripts/logs/last-run.json and prints a one-line result string ready to paste into the commit message (its `검증:` line).
 *   Servers started here are stopped on exit; servers found running are left alone.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, readdirSync, existsSync, createWriteStream } from 'node:fs';
import { CSV_FOLDERS, CSV_WIDE } from './data-owners.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// `--log-dir <dir>` (2026-09-11): 여러 에이전트가 같은 트리에서 동시에 돌 때 서로의 로그 · last-run.json 을 덮어쓰지 않게.
const LOG_ARG = process.argv.indexOf('--log-dir');
const LOG_REL = (LOG_ARG >= 0 && process.argv[LOG_ARG + 1] ? process.argv[LOG_ARG + 1] : 'scripts/logs').replace(/\\/g, '/').replace(/\/$/, '');
const LOG_DIR = resolve(ROOT, LOG_REL);
const LAST_RUN = resolve(LOG_DIR, 'last-run.json');
const isWin = process.platform === 'win32';

// ─── Job catalogue ─────────────────────────────────────────────────────────────────────────────────────────────
// `folders` = feature folders (src/<name>, or `server`) whose changes make this script relevant.
// `standalone: true` = neither vite nor the relay is used, so the runner does not start them.
// When a smoke is added, also add its row to scripts/README.md.
const SMOKES = {
  'smoke-weapons':      { file: 'scripts/smoke-weapons.mjs',      folders: ['weapons', 'items', 'inventory', 'hub', 'pickups', 'audio'] },
  /* 2026-09-14 (모든 총알을 발사체로): 150 m 낙차 ≈ ½·g·t² · 도착 ≈ d/v · 날아간 거리의 거리 감소 · 총구 앞 벽 즉시 명중 · 산탄 펠릿 전부 발사 · 명중 ·
     트리거당 reportShot 1회 · 650 m/s × 50 ms 스텝 터널링 없음(얇은 기둥 · 적) · 배리어 정지 · 레이저 사이트 조준 / 복귀 · 확장 총열 소켓 ·
     풀 성장 · 복제 탄 먼저 퇴출 · bloomPerShot / swayMul · 첫 발사에 셰이더 프로그램 증가 없음. 스탯은 인스턴스에 덮어써 csv 수치와 무관하다. */
  'smoke-ballistics':   { file: 'scripts/smoke-ballistics.mjs',   folders: ['weapons', 'items'] },
  'smoke-phase2':       { file: 'scripts/smoke-phase2.mjs',       folders: ['player', 'weapons', 'inventory', 'game', 'ui'] },
  'smoke-quickslots':   { file: 'scripts/smoke-quickslots.mjs',   folders: ['inventory', 'ui', 'weapons'] },
  'smoke-phase3':       { file: 'scripts/smoke-phase3.mjs',       folders: ['stratagems', 'world', 'ui', 'weapons'] },
  'smoke-stratagems':   { file: 'scripts/smoke-stratagems.mjs',   folders: ['stratagems', 'world'] },
  'smoke-phase4':       { file: 'scripts/smoke-phase4.mjs',       folders: ['enemies', 'items', 'world', 'inventory', 'weapons', 'player'] },
  'smoke-tactical':     { file: 'scripts/smoke-tactical.mjs',     folders: ['implants', 'gadgets', 'progression', 'player', 'world', 'enemies', 'inventory', 'items', 'weapons', 'audio'] },
  /* 2026-09-12 (agent D): 지상 드론 스캔 — 조준 · 3 초 홀드 · 조준 이탈 초기화 · 등급 = 열었을 때 내용물 · 라벨 · 채팅 · 좌클릭이 총으로 새지 않음 ·
     적 시체 / 보급 상자 / 구조물 컨테이너 미리보기 ≡ 열기 · 레이드 리셋에 라벨이 사라진다. */
  'smoke-drone-scan':   { file: 'scripts/smoke-drone-scan.mjs',   folders: ['gadgets', 'inventory'] },
  'smoke-controls-hub': { file: 'scripts/smoke-controls-hub.mjs', folders: ['ui', 'hub', 'inventory', 'implants', 'progression', 'player', 'net'] },
  'smoke-ship-rooms':   { file: 'scripts/smoke-ship-rooms.mjs',   folders: ['hub', 'housing'] },
  'smoke-inventory-p6': { file: 'scripts/smoke-inventory-p6.mjs', folders: ['inventory', 'housing', 'items'] },
  'smoke-loadout':      { file: 'scripts/smoke-loadout.mjs',      folders: ['inventory'] },
  'smoke-search':       { file: 'scripts/smoke-search.mjs',       folders: ['inventory'] },
  /* 2026-09-11 (온실 개편): `items` 추가 — 재배 스테이션 검사가 토양(`soil_*`) · 씨앗(`seed_*`) · 작물(`crop_*`) def 를
     직접 쓴다. `ui` 추가 — 토양 `속성` · `수확` 줄과 씨앗 `맞는 토양` 줄(`ui/hud/ItemTip`)을 단언하는 곳이 여기뿐이다. */
  'smoke-housing':      { file: 'scripts/smoke-housing.mjs',      folders: ['housing', 'hub', 'inventory', 'progression', 'items', 'ui'] },
  'smoke-console':      { file: 'scripts/smoke-console.mjs',      folders: ['console', 'progression', 'inventory', 'player', 'hub'] },
  'smoke-progression':  { file: 'scripts/smoke-progression.mjs',  folders: ['progression'] },
  'smoke-ui-p6':        { file: 'scripts/smoke-ui-p6.mjs',        folders: ['ui'] },
  'smoke-ui-p5':        { file: 'scripts/smoke-ui-p5.mjs',        folders: ['ui', 'meta', 'game'] },
  'smoke-uniques':      { file: 'scripts/smoke-uniques.mjs',      folders: ['weapons', 'items', 'enemies', 'player', 'ui'] },
  'smoke-rogue-v2':     { file: 'scripts/smoke-rogue-v2.mjs',     folders: ['enemies'] },
  'smoke-humanoid-ai':  { file: 'scripts/smoke-humanoid-ai.mjs',  folders: ['enemies'] },
  'smoke-enemy-alert':  { file: 'scripts/smoke-enemy-alert.mjs',  folders: ['enemies', 'implants', 'weapons'] },
  /* 2026-09-15 (안드로이드 분대원, 적 쪽): 주입한 안드로이드 몸이 곁가지 표적이 되고(`all`/`alive` 밖) 인간형이 노려 쏘고,
     접촉 · 폭발 · 화염 지대가 닿고, `applyAllyHit` 이 킬 크레딧 없이 적을 깨우고, `ally:fired` 가 총성처럼 들리고,
     `shared/cover.pickCoverSpot` 이 진짜 장애물 뒤를 고른다. allies/ 없이 도는 디버그 주입만 쓴다. */
  'smoke-enemy-allies': { file: 'scripts/smoke-enemy-allies.mjs', folders: ['enemies', 'allies'] },
  'smoke-rogue-drop':   { file: 'scripts/smoke-rogue-drop.mjs',   folders: ['enemies', 'world'] },
  /* 2026-09-13 (행성별 적 팩션 · spawn-director): threat 1/2/3 × 시드 — 거점 그룹 팩션 · 그룹 수 · 인원 · 실내 · 분대장 ≤ 1 ·
     레이더 우회조 한 명 · 상자 경비 없음 · 같은 시드 = 같은 배치 · 네임드 확률 · 팩션. world 의 getSiteSpawnPoints 도 탄다. */
  'smoke-faction-sites': { file: 'scripts/smoke-faction-sites.mjs', folders: ['enemies', 'world'] },
  'smoke-resume-gate':  { file: 'scripts/smoke-resume-gate.mjs',  folders: ['game', 'ui'] },
  'smoke-meta':         { file: 'scripts/smoke-meta.mjs',         folders: ['meta', 'inventory', 'hub', 'ui', 'game'] },
  /* 2026-09-14 (메신저 · NPC 퀘스트): 첫 연락 · 순차 제안 · 보류 → 수락(brief) · 나눠 납품 · 완료 보고 보상 · 레이드 목표(막타 계열 · 발견+조사 chain ·
     상호작용 · 탈출 회수 · 행성 조건 · 레이드 끝 되돌림) · 실제 배관(damageSource → enemy:killed.weaponClass) · getQuestState · 저장 · 정리. */
  'smoke-npc-quests':   { file: 'scripts/smoke-npc-quests.mjs',   folders: ['meta', 'enemies', 'world', 'weapons'] },
  /* 2026-09-12 (E2): 즐겨찾기 칩 우클릭 메뉴(위임 · 띠 · 이벤트 재도색 · Escape) · 기업 상점 타일 옵트인 · 즐겨찾기 판매 한 번 더 확인
     (1초 홀드 · Escape 취소 · 일괄 담기 제외) · 특정 아이템 회수 계약(계약 행 칩 · 몸에 지닌 개수 정산). E1 API 가 없으면 스텁. */
  'smoke-favorite-chips': { file: 'scripts/smoke-favorite-chips.mjs', folders: ['meta', 'ui', 'inventory'] },
  /* 2026-09-12 (§5-2): 아이템 회수 계약 — 이번 레이드에서 얻은 것만 센다 · 가져온 스택과 안 합쳐진다 · 같은 사선 띠(레이드 중만) ·
     나누기 / 바닥 픽업 와이어 / 시체 와이어 / 레이드 blob 이 표식을 지킨다 · 다른 아이템은 섞이면 표식 없음 · 정산 ·
     함선 복귀 시 표식 제거 + 진행도 0 · 훈련장은 표식 없음. */
  'smoke-recovery-contract': { file: 'scripts/smoke-recovery-contract.mjs', folders: ['meta', 'inventory', 'pickups', 'game', 'world', 'enemies'] },
  'smoke-training':     { file: 'scripts/smoke-training.mjs',     folders: ['world', 'hub', 'housing', 'game'] },
  'smoke-ghost':        { file: 'scripts/smoke-ghost.mjs',        folders: ['player', 'net', 'game'] },
  /* 2026-09-11: 사다리 (잡기 · W/S · 달리기 스태미나 · 꼭대기 올라서기 · E 놓기 · 점프 · 발치 내려서기 · 무기 잠금 ·
     CLIMBING 비트) + 단차 보간(`bodyOffset`) + 월드 천장 클램프. 가짜 `LadderDef` 로 돌아 world 의 사다리가 없어도 된다. */
  'smoke-ladder':       { file: 'scripts/smoke-ladder.mjs',       folders: ['player', 'net'] },
  /* 2026-09-12 (A-3a · A-3e): 가구 자세 — 거절 조건 · 발 고정 · 입력 무시 · E 로 일어나기(옆 가구 프롬프트를 치지 않는다) ·
     고정 카메라 블렌드 · 위상 드라이브(바벨 손 높이 · 페달 발 높이) · 자리 복귀 · spawnStanding / 페이즈 변경 reset.
     가구 모델 없이 anchor 만으로 돌므로 hub 의 가구가 없어도 된다. */
  'smoke-pose':         { file: 'scripts/smoke-pose.mjs',         folders: ['player', 'hub'] },
  /* 2026-09-12 (A2): 조준 흔들림 — 함선 · 허리 사격은 0 · 정조준 8자(표의 크기 · 부호 교차) · 렌더된 카메라 === getLookDir ·
     흔들림 속 퍼짐 0 사격이 화면 중심 선 위 · 반동 · aimSwayMul 0.5 · 앉기 / 엎드리기 / 걷기 배수 · 어깨 전환 · 연출 카메라 · 해제. */
  'smoke-aim-sway':     { file: 'scripts/smoke-aim-sway.mjs',     folders: ['player', 'weapons'] },
  'smoke-raidflow':     { file: 'scripts/smoke-raidflow.mjs',     folders: ['game', 'extraction', 'player', 'inventory', 'world'] },
  /* 2026-09-13 (탈출 개편): 20초 호출 · 착륙 외피 콜라이더 8개 · 적 전용 입구 차단 · 스위치 → 10초 유예(취소 불가 · 유예 중 탑승) →
     탑승 이륙(연출 카메라 · `.hud.cinematic` · 결과 extracted) · 대기 초과 자동 출발에 남겨짐 → reset → 다시 호출 · 화물칸 시체가 함께 떠난다. */
  'smoke-extraction':   { file: 'scripts/smoke-extraction.mjs',   folders: ['extraction', 'game'] },
  'smoke-library':      { file: 'scripts/smoke-library.mjs',      folders: ['housing', 'items', 'hub', 'inventory'] },
  /* 2026-09-13 (서재 시리즈 · 비디오게임 — hub 쪽): 게임 디스크 전시대 · 쇼파 · 좌식 테이블 · 러그 · 의자 모델(광원 0 · 앉는 방향 −Z) ·
     TV 화면 E · 좌석 앉기 · 게임 세션 연출(좌석 자세 · 고정 카메라 · TV 게임 화면 · 거절 → cancelGameSession). housing 메서드는 스텁. */
  'smoke-tv-games':     { file: 'scripts/smoke-tv-games.mjs',     folders: ['hub'] },
  /* 2026-09-12: 가구 화면 개편 — 재배 스테이션 · 분석기 · 배양조 · 식탁의 공통 틀 · 업그레이드 모달(1초 홀드) ·
     HH:MM:SS · 우클릭 · 더블클릭 / 끌기 수확, 그리고 드롭 한 번 = refresh 한 번. 격자는 inventory 의 TradeGrids 다. */
  'smoke-stations':     { file: 'scripts/smoke-stations.mjs',     folders: ['housing', 'inventory', 'items'] },
  /* 2026-09-13 (배치 규칙 — 접근 면): front(벽 · 앞 줄) / sides(좁은 끝 허용 · 넓은 면 거절 · 넓은 면 벽 허용) / all(모서리 허용) · 통로 공유 ·
     양방향 · 자동 배치 · 옛 배치 → 가구 창고 + 담긴 흙 · 씨앗 환불 · 조종석 시설 유지 · 상호작용 방향(앞 / 넓은 면) · 고스트 칸 타일. */
  'smoke-furniture-access': { file: 'scripts/smoke-furniture-access.mjs', folders: ['housing', 'hub'] },
  /* 2026-09-13 (요리 재료 티어 · agent B): 순수 규칙(기본값 = 옛 식 · 비율 · 마모 · 결과표 추첨) · 분석 결과를 넣는 순간 굴린다 · 회수 →
     경험치 · 레벨업 · 분석 도감 · 흙 / 배지 내구도(0 이어도 칸 유지 · 비율 보너스) · 소켓 끼우기 / 가득 참 / 교체 · 스캐폴드 → 종별 고기 ·
     은퇴 세포주 거절 · 세이브 왕복 · 요리 effects → derived(마지막, 너그럽게). */
  'smoke-food-chain':   { file: 'scripts/smoke-food-chain.mjs',   folders: ['housing', 'items', 'progression'] },
  /* 2026-09-13 (발전기 = 증축 조건 — 같은 날 전력 할당 폐지, 옛 smoke-power 대체): 전력 API 없음 · 새 함선 v13 · 발전기 Lv.1–5 ·
     용도별 증축 게이트(room_purposes.csv generator · purposeBlock · purposeRequirements · 실제 setRoomPurpose + 재료 소모) ·
     가구 · 창고 강화 게이트 · 발전기 강화 csv 비용 · sanitize(0 → 1 · 8 → 5 · 모자란 시설 제거 + 환불 · 가구 창고 · 전력 필드 없음) ·
     메인 컴퓨터 없는 클러스터 · 시설 관리 발전기 행 해금 줄 · 스테이션 화면 전력 줄 없음 · 새로고침 로드 경로(토스트 · 창고 환불). */
  'smoke-generator':    { file: 'scripts/smoke-generator.mjs',    folders: ['housing', 'ui'] },
  /* 2026-09-13: 암호화폐 채굴 규칙 — 클러스터 주기 · 지갑 · 코어 · 잠긴 코인 · 회수 거절 · 세이브 정리 (housing `parts/Mining` · `MiningRules`, items 프로세서 · 연산 코어) */
  'smoke-mining':       { file: 'scripts/smoke-mining.mjs',       folders: ['housing', 'items', 'meta'] },
  /* 2026-09-14: 툴팁 고정 — 1초 홀드 링(`ui:cursorHold`) → 고정 카드 + 마름모 · 바깥 누르기 / 마름모 / Escape / 창 닫기 / 아이템 사라짐으로 해제 ·
     짧은 누르기 = 클릭 · 문턱 넘는 이동 = 드래그 · 고정 무기 카드의 받는 소켓만(가운데) · 소켓 호버 카드 · 가방 / 창고 칸으로 끌어내기(막힌 칸 거절) ·
     상자 무기는 호버만 · 내구도 게이지(모든 내구도 타일 · 색 · 숫자 없음) · 기업 탭 TradeGrids 고정. */
  'smoke-tip-pin':      { file: 'scripts/smoke-tip-pin.mjs',      folders: ['inventory', 'ui'] },
  /* 2026-09-12 (E1): 아이템 즐겨찾기 — API · 이벤트 · 우클릭 = 모든 아이템에 메뉴(격자 · 장비칸 · 휠 · 시체 창) · 더블클릭 빠른 이동 ·
     파란 사선 띠(가방 · 창고 · 장비칸 · TradeGrids · buildItemTile, 필요한 탄약이면 노란 띠와 둘 다) · 정렬 앞쪽 · 「즐겨찾기」 칩 ·
     분해 확인 1초 홀드 · 시체 창 글로우 · 로드아웃 `fav` 저장 / 새로고침 / 서버 문서 교체 + 올리지 못한 토글 보호. */
  'smoke-favorites':    { file: 'scripts/smoke-favorites.mjs',    folders: ['inventory'] },
  'smoke-library-consumers': { file: 'scripts/smoke-library-consumers.mjs', folders: ['inventory', 'meta', 'game', 'console', 'ui'] },
  /* 2026-09-12 (A-3a): 헬스장 — gymBlock 사유 · 미니게임 판정 3종(화면 없이) · 세션 흐름(블로커 · ESC · 키 가이드 ·
     Space 가 Input 에 안 닿는다) · applyGymSession 결과 + 근육통 · 근육통 중 경험치 0 · 취소 · 새로고침 보존. */
  'smoke-gym':          { file: 'scripts/smoke-gym.mjs',          folders: ['housing', 'progression', 'hub', 'player'] },
  /* 2026-09-13 (비디오게임, H2): TV 좌석 규칙 매트릭스 · 판정 튜닝 · 게임기 장착/교체/회수 · 게임 목록 · 게임 세션(지능 · 인지력) · 디버프 · 취소. */
  'smoke-video-games':  { file: 'scripts/smoke-video-games.mjs',  folders: ['housing', 'progression', 'hub', 'items'] },
  /* 2026-09-13 (요리 미니게임): 판정 6종(화면 없이) · cookBlock 사유 · 조리대 레벨 잠김 · 조리대 화면(레일 · 단계 칩) · 세션(블로커 · ESC ·
     실제 pointerdown 칼질) · 결과 = 품질 요리가 창고에 · 재료는 끝에서 · 품질 다른 요리 둘 · 취소 = 재료 그대로 · 자동 가구 Lv.1/2/3 ·
     식탁 품질 줄 · 새로고침 보존 · 출격 식사의 derived 보너스. */
  'smoke-cooking':      { file: 'scripts/smoke-cooking.mjs',      folders: ['housing', 'inventory', 'progression', 'hub', 'player'] },
  /* 2026-09-13 (암호화폐 채굴 화면): 연산 클러스터 화면(코어 칸 3×3 드롭 · 우클릭 / 더블클릭 빼기 · 코인 지정 · 진행도 있으면 1초 홀드 경고 ·
     잠긴 코인 거절 · 레일) · 메인 컴퓨터(현황 · 지갑 · 거래소 — 스텁 시세로 차트 · 호버 OHLC · 기간 · 봉/선 · watch 참조 계수 · 견적 사유로 막히는
     1초 홀드 매매 · 잠긴 코인 · 오프라인 문구) · Tab / Esc 닫기 · 두 가구 모델 · 코어 수만큼 켜진 칸 · 점광원 개수 불변. */
  'smoke-mining-ui':    { file: 'scripts/smoke-mining-ui.mjs',    folders: ['housing', 'hub'] },
  /* 2026-09-12 (캐릭터 버프): PC 체력 블록이 함선에서도 보인다 · 체력바 아래 버프 썸네일 줄(흐림 · 디버프 테두리 · 시간 게이지 ·
     키로 DOM 재사용) · 분대원 행의 미니 줄(디버그 원격 ref) · 옛 배지 셋이 없다 · 레이드 자리 / 드론 시점 축소. */
  'smoke-buffs':        { file: 'scripts/smoke-buffs.mjs',        folders: ['ui', 'player', 'net'] },
  /* 2026-09-12 (A1): 전투 소모품 3종 — 아드레날린(스태미나 전량 · 지속 소모 0) · 각성제(장전 · 정조준 · 흔들림 배수 · 소모 +50 %) ·
     안정제(`refillAll`), 체력 가득해도 홀드 시작 · 버프 `boost` 항목 · HUD 썸네일 · 만료 · 서로 지우기 · 레시피 · 로그 시체. */
  'smoke-consumables':  { file: 'scripts/smoke-consumables.mjs',  folders: ['weapons', 'player', 'items'] },
  'smoke-enemy-delta':  { file: 'scripts/smoke-enemy-delta.mjs',  folders: ['enemies', 'net'] },
  /* Phase 11 */
  'smoke-planets':      { file: 'scripts/smoke-planets.mjs',      folders: ['hub', 'world', 'game'] },
  'smoke-social':       { file: 'scripts/smoke-social.mjs',       folders: ['ui', 'net'] },
  /* 2026-09-14 (메신저): P 패널 = 대화(NPC · 개인 대화 · 단체방) · 친구 · 퀘스트 탭, 썸네일 읽지 않음 배지, 퀘스트 카드 수락 / 보류 ·
     납품 · 완료 보고, 단체방 기록 · 보내기 · 초대 · 이름 변경 · 내보내기 · 나가기(1초 홀드), NPC 메시지 토스트, 두 해상도 스크린샷. */
  'smoke-messenger':    { file: 'scripts/smoke-messenger.mjs',    folders: ['ui', 'meta', 'net'] },
  'smoke-rooms':        { file: 'scripts/smoke-rooms.mjs',        folders: ['net'] },
  'smoke-ecology':      { file: 'scripts/smoke-ecology.mjs',      folders: ['world', 'enemies', 'items'] },
  /* 2026-09-09: 소품 콜라이더가 그려진 실루엣보다 큰지 **숫자로** 잰다. `Props.hullOf` 가 바운딩 박스로
     콜라이더를 만들기 때문에 지오메트리 쪽 사고(→ `noise3` 의 lerp 인자 순서)가 곧 보이지 않는 벽이 된다. */
  'smoke-props-collision': { file: 'scripts/smoke-props-collision.mjs', folders: ['world'] },
  /* 2026-09-09: 버려진 구조물 · 선로 · 전차. 같은 취지로 **사각(OBB) 콜라이더**가 그려진 실루엣 안에 있는지
     재고, 실내 이동 · 지하실 해치 · 플랫폼 데크 · 전차 발판 속도까지 본다. */
  'smoke-structures':   { file: 'scripts/smoke-structures.mjs',   folders: ['world', 'items', 'inventory'] },
  /* 2026-09-12: 구조물 **도달성** — 콜라이더가 그린 것 안에 있어도 사람이 못 지나가는 자리(계단 입구 0.8 m 틈 · 난간이
     막은 문 · 바깥으로만 열린 계단)를 몸 반지름 flood fill(진짜 `getSurfaceY` + `resolveCollision`)로 여러 시드에서 잰다. */
  'smoke-structure-reach': { file: 'scripts/smoke-structure-reach.mjs', folders: ['world'] },
  /* 2026-09-13 (행성별 적 팩션 · world-sites): 거점 스폰 자리 — `getSiteSpawnPoints` 실내(층 바닥 · 벽 안 · 잠긴 방 밖 · 정문에서 걸어서
     닿는다) · 실외(발자국 밖 · 선로 회랑 밖 · 충돌 없음) · 플랫폼 · 폐허 · 결정성 · minGap · 훈련장 빈 답. */
  'smoke-site-spawns':  { file: 'scripts/smoke-site-spawns.mjs',  folders: ['world', 'enemies'] },
  /* 2026-09-09: 환경 재해 — 종류 · 시작 시각이 시드의 함수라 와이어가 없다. 시드 결정성 · 도형 규약 ·
     끝까지 갔을 때의 맵 봉쇄 · 초당 피해 · atmo:override · 거대 버섯 군락을 브라우저 안에서 잰다. */
  'smoke-hazard':       { file: 'scripts/smoke-hazard.mjs',       folders: ['world'] },
  /* 2026-09-08: 튜토리얼 — 게이트가 housing / hub / inventory / meta 의 거절 사유 함수에 들어가 있으므로
     그 폴더를 건드리면 함께 돈다. 다른 스모크는 전부 `scav.s1.tutorial` 을 done 으로 심고 시작한다. */
  'smoke-tutorial':     { file: 'scripts/smoke-tutorial.mjs',     folders: ['tutorial', 'hub', 'housing', 'inventory', 'ui', 'items'] },
  /* 2026-09-15 (E-12): 튜토리얼 레이드 트랙을 끝까지 — 체크포인트 부활 · 낙사 부활 자리 · kill/clamp · 즉시 이륙 → 정산(TUTORIAL_RAID_XP) → 함선 획득.
     smoke-tutorial 은 증축 트랙만 몬다. 구간 사이는 순간이동, 판정이 걸린 행동(낙하 · 스위치)만 실제 입력.
     2026-09-16: 방탄복 실드 + 자연 낙하 → 체력 피해 · 다친 채 wall 을 지나도 supplyLoot 유지 · 붕대 실사용 → grenade · 이륙 프레임마다 크로스헤어 0 · HUD 코드 페이드.
     2026-09-17: `ui` 추가 — 이륙 프레임의 크로스헤어 · HUD 페이드 검사는 ui/ 의 것이라 ui 만 바꾼 변경에서도 돌아야 한다. */
  'smoke-tutorial-raid': { file: 'scripts/smoke-tutorial-raid.mjs', folders: ['tutorial', 'world', 'game', 'extraction', 'player', 'enemies', 'ui'] },
  /* 2026-09-15 (E-12): 튜토리얼 함선 트랙 — levelUp → stats(＋ · 1초 홀드 확정) · 새로고침 복원.
     2026-09-16: 메신저 단계 제외 — 확정 뒤 화면을 닫아야 트랙이 끝난다 · 옛 저장 messenger / ravenQuest = 끝 · 레이븐은 튜토리얼 뒤. */
  'smoke-tutorial-ship': { file: 'scripts/smoke-tutorial-ship.mjs', folders: ['tutorial', 'meta', 'ui', 'progression', 'inventory'] },
  /* 2026-09-15 (E-12 · B-14): 전역 낙하 피해 — 높이별 피해 식 · 안전 높이 · 실드 먼저 · 치사 · 남이 띄운 몸 면제 + 피드백(착지음 · 흔들림 · 비네트). */
  'smoke-fall-damage':  { file: 'scripts/smoke-fall-damage.mjs',  folders: ['player', 'audio', 'ui', 'world'] },
  /* 2026-09-15 (B-16 · 사용자 버그): 화염 지대 — 화염수류탄 · G-10 소이 수류탄이 실제로 불 지대를 세우는가 · 피해 · 드론 피해 · 소리 · 만료. */
  'smoke-fire-zones':   { file: 'scripts/smoke-fire-zones.mjs',   folders: ['gadgets', 'weapons', 'items', 'enemies', 'audio'] },
  /* 2026-09-15 (땅굴벌레 · 진동 장치): 진동 장치 — 카탈로그 · 미리보기 ≡ 설치(맨땅 초록 · 옥상 빨강 `burrowGroundOk`) · 1 초 타격(소리 · 흔들림) ·
     5번째 타격에 `sandworm:summon` 1회 · 회수 불가 · 분출 반경 안만 파괴 · 재설치 · 와이어 age. */
  'smoke-thumper':      { file: 'scripts/smoke-thumper.mjs',      folders: ['gadgets', 'world', 'enemies', 'items'] },
  /* 2026-09-15 (안드로이드 분대원 — 레이드 갈고리): 안드로이드 가방(배치 · 병합 · resize 넘침) · 사람과 같은 무게 식 ·
     컨테이너 미리보기 ≡ 안드로이드 획득(가져간 상태 · 열린 모습 · `container:itemTaken.by`) · 아이템 요청 4종 payload ·
     컨테이너 창 열기 사건 · 바닥 아이템 `takeBy` · 탈출 패드 목록 / 콘솔 누르기 / 탑승 지점 · 루팅 컨테이너 목록 ·
     재해 도형별 `nearestSafePoint` · 창고 입고. `ctx.allies` 없이 계약만 직접 부른다. */
  'smoke-ally-hooks':   { file: 'scripts/smoke-ally-hooks.mjs',   folders: ['inventory', 'pickups', 'extraction', 'world', 'gadgets', 'stratagems'] },
  /* 2026-09-14: 캐릭터 확정 팝업(요약 카드 · 값/5 게이지 · 얼굴 정지 썸네일 · 1초 홀드) → 새로고침 → 튜토리얼 오프닝 — 검은 페이드가 코드로
     중간값을 지난다(reduced motion 에서도) · 연출이 **끝난다**(음수 타이머 버그) · 카메라가 백뷰로 이어진다 · 연출 중 나침반 0 / Tab 막힘 →
     끝나면 나침반 페이드인 · Tab 열림 · 튜토리얼 레이드 내내 시계 · 탈출 타이머 없음. */
  'smoke-intro-wake':   { file: 'scripts/smoke-intro-wake.mjs',   folders: ['player', 'tutorial', 'ui', 'inventory'] },
  /* 2026-09-08: 공용 함선 격납고 — 두 클라이언트가 필요하다 (개인 함선 방문 · `hs` 동석 규칙). 릴레이를 쓰므로
     e2e 와 같이 exclusive 로 돈다. */
  'smoke-hangar':       { file: 'scripts/smoke-hangar.mjs',       folders: ['hub', 'net', 'housing', 'player'], exclusive: true, freshRelay: true },
  /* 2026-09-15 (분대 · 도킹 매칭): 세 클라이언트 — 초대 → 미도킹 분대(각자 개인 함선 · 허브 스냅샷 없음 · 분대 HUD `개인 함선`) · 발사/훈련장 잠금 ·
     분대원 requestDock 거절 · 분대장 도킹 = 즉시 페이드 / 분대원 우측 카운트다운 → 열린 화면 전부 닫힘 → 도킹 · 혼자 공개 매칭 합류 ·
     도킹 해제는 나만 · 도킹된 분대로 초대 수락 = 카운트다운 · 혼자 비공개 매칭. 릴레이는 **스스로** 8894 에 띄운다(작업 트리의
     server/index.ts) — 공용 8787 을 재시작하지 않으므로 freshRelay 가 아니다. 브라우저 3개라 exclusive. */
  'smoke-squad-dock':   { file: 'scripts/smoke-squad-dock.mjs',   folders: ['net', 'hub', 'server'], exclusive: true },
  /* 2026-09-15 (안드로이드 분대원): 봇 로비 멤버의 계약 — `setAndroidBay` 로 3기 들이기(bot·bay·ready·자기 슬롯) · 봇은 사람이 아니다
     (`net:peerJoined` · 원격 아바타 없음) · 사람이 합류하면 가장 늦게 들어온 기가 슬롯으로(새로 온 사람까지 `net:androidReturned`) ·
     분대원 not_host · 가득 차면 full + 요청자에게만 되돌림 · 돌려보내기 · 사람 이탈. 릴레이는 **스스로** 8896 에 띄운다. 브라우저 2개라 exclusive. */
  'smoke-android-lobby': { file: 'scripts/smoke-android-lobby.mjs', folders: ['net', 'server'], exclusive: true },
  /* 2026-09-15 (안드로이드 분대원 — hub): 조종실 슬롯 3칸(위치 · 갑판을 보는 yaw · `exit` · 캡슐 콜라이더 · `hub_android_<bay>` 3 s 홀드) ·
     프롬프트(들이기 / 돌려보내기 / 분대장 아님은 프롬프트로 거절) · 봇 발사 슬롯(아바타 없이 준비 완료 · `is-bot` 카드 · 우클릭 거절) ·
     `getPodStandPose` · 매칭 탭 봇 칸 · 레이드 진입 암전(카운트다운 → 페이드 hold + `raid:loadBegin` → 지연 발사, 준비 해제 무효).
     릴레이 로비 없이 `HubSystem.debugSharedShip` 으로 공용 함선에 선다 — 브라우저 하나. */
  'smoke-android-bays': { file: 'scripts/smoke-android-bays.mjs', folders: ['hub'] },
  /* 2026-09-15 (안드로이드 분대원 — allies): 치트 명단(`/android 1`) · 개인 함선의 몸 · 솔로 레이드 강하 포드 · 묶인 기본 킷 ·
     체력 ×ALLY_HP_MUL · 하네스 복귀와 한 방향 이동 시 절반으로 줄기 · 감지 → 적 핑 → 연사 → `applyAllyHit` ·
     피해 → 쓰러짐 → 소생 → 출혈 사망 → `spawnAllyCorpse`. 다른 폴더의 계약 멤버가 없으면 그 검사만 skip 한다. */
  'smoke-allies-core':  { file: 'scripts/smoke-allies-core.mjs',  folders: ['allies'] },
  /* 2026-09-15 (안드로이드 분대원 — allies 명령): 분대장 이동 / 주의 핑 · 선착순 요청과 쿨다운 · 없는 물건의 채팅 한 줄 ·
     회복 요청 → 핑 → 접근 → 떨구기 · 상자 루팅과 사람이 열면 중단 · 탈출 핑 → 재확인 → 콘솔 누르기. */
  'smoke-allies-orders': { file: 'scripts/smoke-allies-orders.mjs', folders: ['allies'] },
  /* 2026-09-10: 피칭 위키(`docs/pitch/`) — 빌드가 없어서 깨져도 조용한 문서다. vite 도 게임도 쓰지 않고
     `docs/pitch` 를 정적으로 서빙해 페이지를 전부 열어 본다 (링크 · 사이드바 · nextnav · 카드 넘기기).
     `folders` 로는 안 잡히므로(`src/` 밖이다) 위의 `EXTRA_PATHS` 가 `docs/pitch/` 변경에서 직접 고른다. */
  'smoke-pitch':        { file: 'scripts/smoke-pitch.mjs',        folders: [], standalone: true },
  /* 2026-09-14 (정보상): 산 기믹 고정이 정말 그만큼 붙는가 · 같은 시드 · 정보로 두 번 계획하면 같은가 ·
     기믹이 자기보다 **앞에서** 뽑힌 절을 밀지 않는가 · 미리보기(`WorldRef.previewLayout`)가 계획과 같은 것을 말하는가.
     브라우저를 안 쓴다 — 헤드리스 vite 로 `src/world/preview.ts` 를 SSR 로드해 레이아웃만 만든다 (standalone). */
  'smoke-intel':        { file: 'scripts/smoke-intel.mjs',        folders: ['world', 'meta', 'enemies', 'hub'], standalone: true },
  /* 2026-09-10: 씬의 광원 개수. 플레이 중에 그 숫자가 바뀌면 씬의 모든 머티리얼이 셰이더를 다시 컴파일해
     한 프레임이 멎는다 — 지금까지 탈출 함선 · 신호탄 · 헬포드 · 분대장 기기가 이 그물에 걸렸다. 광원을
     들고 있는 폴더 전부에 매핑한다. */
  'smoke-lights':       { file: 'scripts/smoke-lights.mjs',       folders: ['extraction', 'player', 'game', 'hub', 'world', 'core'] },
  /* 2026-09-11 (C 배치): 네임드 로그 판정 (엎드린 로든 눕힌 캡슐 · 소염기 매몰 · 승격 시 스캔 드론 입양 · 리플리카 헤비
     트레이서 · 리플리카 훅 host) 과 전차 위 적 · 적 시체 탑승 (+ 리플리카 예측 · 강하 목표 플랫폼). 둘 다 릴레이 없이 돈다. */
  'smoke-named':        { file: 'scripts/smoke-named.mjs',        folders: ['enemies', 'weapons'] },
  /* 2026-09-13: 버그 굴착 스폰(첫 배치 제외 · 순찰 · 공격/이동 금지 · 흔들림 중복 없음 · 리플리카 em · 뱉어진 몸 포물선)과
     땅굴벌레 이벤트(threat 굴림 · 전조 흔들림 증가 · 분출 피해/넉백 · 뱉기 · 독극물 · 처치 시체 · 리플리카 → 승격 · 탈출 웨이브 제거).
     둘 다 릴레이 없이 돈다. */
  'smoke-burrow':       { file: 'scripts/smoke-burrow.mjs',       folders: ['enemies', 'audio'] },
  'smoke-sandworm':     { file: 'scripts/smoke-sandworm.mjs',     folders: ['enemies', 'audio', 'console'] },
  'smoke-tram-ride':    { file: 'scripts/smoke-tram-ride.mjs',    folders: ['enemies', 'world'] },
  /* 2026-09-13 (탐사 차량 R2): 정류장 4–5 · 정차 · 탑승(프롬프트 · 홀드 · riders · 정류장 공개 · 목적지 선택 열기) · 요금(10 단위 · 범위) ·
     결제 → 크레딧 차감 → 5초 유예 → trip · 이동 중 탑승 거절 · 도착 강제 하차(목적지 곁) · 순환 출발 + 포탑 사격 · 피해 · 파괴(탑승자 하차 ·
     targetable false · 탑승 거절). 콘솔 `rover` 치트(`cheat:rover`)로 시간을 줄인다. src/world/rover 는 `world` 폴더다. */
  'smoke-rover':        { file: 'scripts/smoke-rover.mjs',        folders: ['world', 'audio', 'console'] },
  /* 2026-09-14 (메신저 · NPC 퀘스트 E): 전술 지도 좌측 열(머리 → 퀘스트 패널 → 범례 좌측 하단 → 발밑 줄, 열 높이 = 캔버스) · 가짜 NpcQuestRef
     패널 · 레이드 목표 줄 · 게이지 · 호버 툴팁 · 이벤트 갱신 · 트랙 6 스크롤 / 0 숨김 · 목적지 선택 모드 숨김 · 퀘스트 토스트 3종 ·
     1280×720 / 1920×1080 프레임 + 스크린샷. 릴레이 없이 돈다. */
  'smoke-map-quests':   { file: 'scripts/smoke-map-quests.mjs',   folders: ['ui', 'meta'] },
  /* 2026-09-11 (E-4 + C-57 · X-6): 신뢰 경로 — 두 클라이언트 · **코드로 만든 비공개 로비**(빠른 매칭 아님)로 레이드에 들어가
     위조 strat call / stratq call · 버프 상한 · 벽 뒤 스프레이 · 계약 킬 파생 · meta sync rid · crate opened 거리 · 넉백 기하 ·
     hit 요청 DPS 상한을 잰다. 공용 릴레이를 쓰지만 자기 로비라 exclusive 가 아니다. */
  'smoke-trust':        { file: 'scripts/smoke-trust.mjs',        folders: ['stratagems', 'weapons', 'implants', 'gadgets', 'meta', 'enemies'] },
  /* 2026-09-11 (B-1): 링크 상태 · 익명 배경 프로브 · 연결 배지 · 거절 뒤 프로브 없음 · 셸 목표도 프로브(2026-09-15). 공용 릴레이(8787)는
     쓰지 않고 8885(스스로 띄우고 죽이는 릴레이) · 8886(대답 없는 TCP)을 쓴다 — 그래서 exclusive 가 아니다. */
  'smoke-netlink':      { file: 'scripts/smoke-netlink.mjs',      folders: ['net', 'ui', 'hub'] },
  /* 2026-09-11 (E-3): 데스크톱 셸을 **진짜 Electron** 으로 (`--hidden --user-data=<임시>`, 창 8820 · 두 번째 창 8822 ·
     스모크 릴레이 8823 · 디버깅 9340 · 메인 인스펙터 9341; 2026-09-15 셸에 서버가 없다 — 번들 · asar · 포트로 확인).
     vite 도 공용 릴레이도 안 쓰지만 GPU · 포트를 잡고 `dist/` 가 오래됐으면
     vite build 를 돌리므로 혼자 돈다. `folders` 로는 안 잡힌다 — `EXTRA_PATHS` 가 `electron/` · `pack-release` · 자기 자신에서 고른다. */
  /* 2026-09-15 (레이드 진입 로딩): 발사 → 암전 hold (임무 시계 · 강하 포드 정지) · 진행도 1 · 최소 암전 시간 · 페이드인 · deploying → playing ·
     끝나지 않는 가짜 분대원이면 호스트가 상한까지 기다린다(디버그 훅) · 재접속 · 훈련장은 게이트를 타지 않는다. */
  'smoke-raid-loading': { file: 'scripts/smoke-raid-loading.mjs', folders: ['game', 'core', 'hub', 'ui'] },
  /* 2026-09-15 (안드로이드 분대원 — player 쪽): 주입한 `AllyBodyView` 로 몸을 검사한다 — 안드로이드 외형(머리 조각 교체) · 자세 매핑 ·
     감춰진 / 죽은 몸 · 손에 든 총 · 방탄복 판 · 몸 풀 재사용 · `revive:ally:<id>` 상호작용 → `requestRevive` · 안드로이드가 업은 PC ·
     `ally:fired` 연출의 점광원 개수 불변 · 안드로이드 얼굴 초상 · 안드로이드가 있으면 솔로 PC 도 쓰러진다. allies/ 없이 돈다. */
  'smoke-ally-avatars': { file: 'scripts/smoke-ally-avatars.mjs', folders: ['player', 'allies'] },
  /* 2026-09-15 (안드로이드 분대원 — ui 쪽): 가짜 `ctx.allies`(`hud.debugAllies`) + 버스 이벤트만으로 — 분대 행(배지 · 실드 ·
     봇이 사람 행으로 안 그려진다) · 이름표 · 나침반 눈금 · 지도 범례 · `ally:ping` 마커 / 콜아웃 / `ping:placedV3` ·
     `ally:chat` 이 relay 되지 않음 · 토스트 7종 · 로딩 게이지(암전 위 · squad 진행도 · dt 0 에서도 돈다 · 사라짐). */
  'smoke-ally-ui':      { file: 'scripts/smoke-ally-ui.mjs',      folders: ['ui', 'allies'] },
  'smoke-desktop':      { file: 'scripts/smoke-desktop.mjs',      folders: [], standalone: true, exclusive: true },
  'e2e-mp':             { file: 'scripts/e2e-multiplayer.mjs',    folders: ['net', 'server', 'game', 'extraction', 'hub', 'pickups', 'player', 'enemies'], exclusive: true, freshRelay: true },
};
// Anything under these paths touches the engine / bootstrap → run everything.
const GLOBAL_PATHS = [/^src\/core\//, /^src\/main\.ts$/, /^index\.html$/, /^vite\.config/, /^package\.json$/, /^tsconfig/];

/* 2026-09-16: `src/shared` 는 **바뀐 크기로** 판단한다. 예전에는 shared 아래 아무 파일이나 걸리면 전체(95종 · 18~21분)로
   올라갔는데, 최근 40커밋 중 28건이 shared 를 건드려서 「연관된 것만」 돌리려고 `verify` 를 쳐도 7할이 전체였다.
   재보니 그 확대가 **대부분은 옳다** — shared 를 건드린 커밋은 대개 기능 배치라 진짜로 넓다(144파일 · 15폴더 →
   shared 를 빼고 폴더로만 골라도 91/95 스모크). 낭비는 **좁은 커밋**에 몰려 있었다: 계약 커밋 `4e96c64`(6파일 ·
   1폴더)가 21분. 그래서 좁을 때만 심볼로 좁힌다. 심볼 매핑을 넓은 커밋에까지 쓰지 않는 이유는 효과가 없어서다 —
   바뀐 export 가 수십 개로 불어나 소비 폴더가 22개 중 중앙값 17개였다(전체와 사실상 같다).
   `.md` 는 세지 않는다: shared 는 코드와 README 가 늘 같이 바뀌므로 README 가 판정을 흔들면 안 된다. */
const SHARED_RE = /^src\/shared\//;
const SHARED_NARROW_FILES = 2;    // 바뀐 shared **코드** 파일 수
const SHARED_NARROW_FOLDERS = 3;  // 같은 변경이 건드린 기능 폴더 수

// `src/` 밖에 사는 것들 — 폴더 이름으로는 안 잡히므로 경로에서 스모크를 직접 고른다.
const EXTRA_PATHS = [
  { label: 'docs/pitch/', re: /^docs\/pitch\//, smokes: ['smoke-pitch'] },
  // 2026-09-11 (E-3): 데스크톱 셸 · 배포 폴더 · 그 스모크 자신.
  { label: 'electron/', re: /^electron\//, smokes: ['smoke-desktop'] },
  { label: 'scripts/pack-release.mjs', re: /^scripts\/pack-release\.mjs$/, smokes: ['smoke-desktop'] },
  { label: 'scripts/smoke-desktop.mjs', re: /^scripts\/smoke-desktop\.mjs$/, smokes: ['smoke-desktop'] },
];

/* 2026-09-16: 레인 시동 간격은 **레인당**이 아니라 **총 예산**이다. 예전의 8초 × 레인은 4레인에서 24초, 8레인에서는
   56초를 그냥 버렸다 — 한 웨이브로 끝나는 묶음(`--only`, `--changed`)에서는 그게 실행 시간의 대부분이었다.
   vite 예열과 Chrome 기동이 겹치지 않게 하려는 원래 목적에는 총 24초면 충분하고, 레인을 몇 개로 주든 램프는 같다. */
const RAMP_BUDGET_MS = 24_000;

// ─── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
/* 2026-09-11: 모르는 플래그 · --help 는 **아무것도 돌리지 않고** 머리 주석을 찍고 끝낸다. 예전에는 조용히 무시돼서
   `verify.mjs --help` 가 인자 없는 --changed 전체 검증(릴레이 재시작 + e2e 포함)을 시작했다. */
const KNOWN_FLAGS = new Set(['--all', '--list', '--dry-run', '--rerun-failed', '--serial', '--build', '--no-typecheck', '--no-e2e', '--keep-relay']);
const VALUE_FLAGS = new Set(['--folders', '--only', '--base', '--jobs', '--url', '--timeout', '--log-dir']);
{
  const unknown = argv.filter((a, i) => a.startsWith('-') && !KNOWN_FLAGS.has(a) && !VALUE_FLAGS.has(a) && !VALUE_FLAGS.has(argv[i - 1]));
  if (unknown.length) {
    const head = readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? '';
    const isHelp = unknown.every((a) => a === '--help' || a === '-h');
    if (!isHelp) console.error(`unknown option(s): ${unknown.join(' ')}\n`);
    console.log(head.split('\n').map((l) => l.replace(/^\s?\*\s?/, '')).join('\n').trim());
    process.exit(isHelp ? 0 : 2);
  }
}
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const opts = {
  all: has('--all'), list: has('--list'), dryRun: has('--dry-run'), rerunFailed: has('--rerun-failed'),
  folders: val('--folders', '').split(',').filter(Boolean),
  only: val('--only', '').split(',').filter(Boolean),
  base: val('--base', null),
  /* 2026-09-16 — 기본 4레인. 같은 날 두 번 쟀다.
     ① 28스레드 · RTX 4070 SUPER: 4레인 18분 30초 → 8레인 20분 00초 — 그때는 "프레임 바닥(`Engine.MAX_DT` 20 fps) 때문"으로 읽었지만
        그 실행에는 **`browser.close()` 가 최대 2분씩 붙잡히는 멈춤**(`scripts/close-browser.mjs` 머리 주석)이 섞여 있었을 공산이 크다
        (그때 적은 「스모크 묶음이 같은 초에 끝난다」가 이 멈춤의 증상이다).
        닫히는 Chrome 이 많을수록 더 걸리므로 레인을 늘린 쪽이 손해로 보였던 것이다.
     ② 7800X3D(8코어 16스레드) · RTX 4080 SUPER, 멈춤을 고친 뒤 `--all`: 4레인 16분 40초 · 6레인 **12분 56초**.
        하지만 6레인에서 20 fps 밑 시간이 210초 → 292초로 늘고, 4레인에서는 안 나던 타이밍 빨강 3개가 나왔다
        (`smoke-ladder` 사다리 속도 · `smoke-tutorial-raid` HUD 페이드 값 · `smoke-rover` 포탑 명중). 그래서 기본값은 4 로 둔다 —
        빨리 돌리고 빨강을 다시 확인할 각오면 `--jobs 6`.
     SMOKE_GL=swiftshader 는 CPU 바운드라 `--jobs 1~2` 를 직접 준다. */
  jobs: has('--serial') ? 1 : Math.max(1, Number(val('--jobs', 4)) || 4),
  build: has('--build') || has('--all'),
  typecheck: !has('--no-typecheck'),
  e2e: !has('--no-e2e'),
  keepRelay: has('--keep-relay'),
  url: val('--url', 'http://localhost:5273/'),
  timeoutMs: (Number(val('--timeout', 15)) || 15) * 60_000,
};

if (opts.list) {
  const byFolder = {};
  for (const [name, j] of Object.entries(SMOKES)) for (const f of j.folders) (byFolder[f] ??= []).push(name);
  console.log('folder → smoke scripts');
  for (const f of Object.keys(byFolder).sort()) console.log(`  ${f.padEnd(12)} ${byFolder[f].join(', ')}`);
  console.log(`  ${'(global)'.padEnd(12)} src/core, main.ts, index.html, vite.config, package.json, tsconfig → all`);
  console.log(`  ${'(shared)'.padEnd(12)} src/shared: 코드 ${SHARED_NARROW_FILES}개 이하 + 기능 폴더 ${SHARED_NARROW_FOLDERS}개 이하 → 바뀐 export 를 쓰는 폴더, 그보다 넓으면 all`);
  // `src/` 밖의 경로로 붙는 것들은 폴더 표에 안 나오므로 따로 찍는다.
  for (const e of EXTRA_PATHS) console.log(`  ${'(path)'.padEnd(12)} ${e.label} → ${e.smokes.join(', ')}`);
  // 2026-09-11: data/*.csv → 소비 폴더 (`scripts/data-owners.mjs`). 스모크는 위 폴더 표를 따라간다.
  console.log('\ndata csv → folders (scripts/data-owners.mjs)');
  for (const [csv, fs] of Object.entries(CSV_FOLDERS).sort()) console.log(`  ${csv.padEnd(26)} ${fs.join(', ')}`);
  console.log(`  ${[...CSV_WIDE].join(', ').padEnd(26)} (wide — no smokes picked, a note is printed)`);
  let csvOnDisk = [];
  try { csvOnDisk = readdirSync(resolve(ROOT, 'data')).filter((f) => f.endsWith('.csv')); } catch { /* no data dir */ }
  const unmapped = csvOnDisk.filter((f) => !CSV_WIDE.has(f) && !CSV_FOLDERS[f]);
  if (unmapped.length) console.log(`  ⚠ not mapped (a change to these picks no smokes): ${unmapped.join(', ')}`);
  process.exit(0);
}

// ─── Selection ─────────────────────────────────────────────────────────────────────────────────────────────────
function git(args) { return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout ?? ''; }
function changedFiles() {
  if (opts.base) return git(['diff', '--name-only', opts.base]).split('\n').filter(Boolean);
  const status = git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)
    .map((l) => l.slice(3).trim()).map((p) => p.includes(' -> ') ? p.split(' -> ')[1] : p);
  if (status.length) return status;
  return git(['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n').filter(Boolean);
}
/* 2026-09-16: 좁은 shared 변경에서 **바뀐 export 를 쓰는 기능 폴더**를 찾는다. diff 의 바뀐 줄에서 식별자를 뽑아
   shared 가 export 하는 이름만 남기고, 그 이름을 작업 트리에서 낱말 단위로 찾는다 (`git grep -w` — `\b` 는 이
   git 빌드에서 안 먹는다). 바뀐 줄이 함수 본문 안이라 export 이름이 하나도 안 잡히면 그 파일이 export 하는 것을
   전부 후보로 삼고, 그래도 비면 `ok: false` 로 알려 전체를 돌게 한다 — 좁히다 놓치느니 도는 편이 낫다. */
function sharedConsumers(sharedTs) {
  const diff = opts.base
    ? git(['diff', '-U0', opts.base, '--', ...sharedTs])
    : (git(['diff', '-U0', 'HEAD', '--', ...sharedTs]) || git(['diff', '-U0', 'HEAD~1', 'HEAD', '--', ...sharedTs]));
  const exported = new Set(
    git(['grep', '-h', '-oE', 'export (const|function|type|interface|class|enum|let) [A-Za-z0-9_]+', '--', 'src/shared'])
      .split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean),
  );
  const ids = new Set();
  for (const line of diff.split('\n')) {
    if (!/^[+-][^+-]/.test(line)) continue;
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) if (exported.has(m[0])) ids.add(m[0]);
  }
  if (!ids.size) {
    for (const f of sharedTs) {
      let text = ''; try { text = readFileSync(resolve(ROOT, f), 'utf8'); } catch { /* 지워진 파일 */ }
      for (const m of text.matchAll(/export (?:const|function|type|interface|class|enum|let) ([A-Za-z0-9_]+)/g)) ids.add(m[1]);
    }
  }
  if (!ids.size) return { syms: 0, consumers: [], ok: false };
  const list = [...ids]; const consumers = new Set();
  // 이름을 한 번에 다 던지면 git grep 이 조용히 빈손으로 돌아온다 — 15개씩 끊는다.
  for (let i = 0; i < list.length; i += 15) {
    for (const h of git(['grep', '-l', '-w', '-E', list.slice(i, i + 15).join('|'), '--', 'src']).split('\n')) {
      const m = h.replace(/\\/g, '/').match(/^src\/([^/]+)\//);
      if (m && m[1] !== 'shared') consumers.add(m[1]);
    }
  }
  return { syms: list.length, consumers: [...consumers].sort(), ok: true };
}
function foldersOf(files) {
  const folders = new Set(); const extra = new Set(); const notes = []; const shared = []; let global = false;
  for (const f of files) {
    const p = f.replace(/\\/g, '/');
    if (GLOBAL_PATHS.some((re) => re.test(p))) { global = true; continue; }
    // shared 는 기능 폴더가 아니다 — 모아뒀다가 루프 뒤에서 크기로 판단한다.
    if (SHARED_RE.test(p)) { if (p.endsWith('.ts')) shared.push(p); continue; }
    const m = p.match(/^src\/([^/]+)\//); if (m) folders.add(m[1]);
    if (/^server\//.test(p)) folders.add('server');
    for (const e of EXTRA_PATHS) if (e.re.test(p)) e.smokes.forEach((n) => extra.add(n));
    // 2026-09-11: data/<file>.csv → 그 수치를 소비하는 폴더 (`scripts/data-owners.mjs`). 전역 표는 고르지 않고 알린다.
    const csv = p.match(/^data\/([^/]+\.csv)$/)?.[1];
    if (csv) {
      if (CSV_WIDE.has(csv)) notes.push(`data/${csv} 는 거의 모든 폴더가 읽는다 — 스모크를 고르지 않았다 (--folders 로 직접 주거나 verify:all)`);
      else if (CSV_FOLDERS[csv]) CSV_FOLDERS[csv].forEach((x) => folders.add(x));
      else notes.push(`data/${csv} 가 scripts/data-owners.mjs 의 CSV_FOLDERS 에 없다 — 스모크를 고르지 못했다`);
    }
  }
  if (!global && shared.length) {
    if (shared.length > SHARED_NARROW_FILES || folders.size > SHARED_NARROW_FOLDERS) {
      global = true;
      notes.push(`src/shared 코드 ${shared.length}개 · 기능 폴더 ${folders.size}개 — 넓은 변경이라 전체를 돈다 (좁은 기준: 파일 ${SHARED_NARROW_FILES} 이하 · 폴더 ${SHARED_NARROW_FOLDERS} 이하)`);
    } else {
      const { syms, consumers, ok } = sharedConsumers(shared);
      if (!ok) { global = true; notes.push('src/shared 변경에서 바뀐 export 를 못 찾았다 — 안전하게 전체를 돈다'); }
      else {
        for (const f of consumers) folders.add(f);
        notes.push(`src/shared 좁은 변경 — 바뀐 export ${syms}개를 쓰는 폴더: ${consumers.join(', ') || '(없음)'}`);
      }
    }
  }
  return { folders: [...folders], extra: [...extra], global, notes };
}
function select() {
  const names = Object.keys(SMOKES);
  let picked, reason;
  if (opts.only.length) {
    const bad = opts.only.filter((n) => !SMOKES[n]);
    if (bad.length) { console.error(`unknown script(s): ${bad.join(', ')}. Known: ${names.join(', ')}`); process.exit(2); }
    picked = opts.only; reason = '--only';
  } else if (opts.rerunFailed) {
    if (!existsSync(LAST_RUN)) { console.error(`no previous run recorded (${LOG_REL}/last-run.json)`); process.exit(2); }
    const last = JSON.parse(readFileSync(LAST_RUN, 'utf8'));
    picked = last.results.filter((r) => !r.ok).map((r) => r.name).filter((n) => SMOKES[n]);
    reason = `--rerun-failed (${last.time})`;
  } else if (opts.all) {
    picked = names; reason = '--all';
  } else if (opts.folders.length) {
    picked = names.filter((n) => SMOKES[n].folders.some((f) => opts.folders.includes(f)));
    reason = `--folders ${opts.folders.join(',')}`;
  } else {
    const files = changedFiles();
    const { folders, extra, global, notes } = foldersOf(files);
    for (const n of notes) console.log(`  note: ${n}`);
    if (global) { picked = names; reason = `changed: engine/bootstrap or a wide shared change → all (${files.length} files)`; }
    else {
      // `extra` = `src/` 밖의 경로가 직접 고른 것 (docs/pitch → smoke-pitch). 폴더 매핑과 합집합이다.
      picked = names.filter((n) => extra.includes(n) || SMOKES[n].folders.some((f) => folders.includes(f)));
      reason = `changed folders: ${[...folders, ...extra.map((n) => `(${n})`)].join(', ') || '(none)'}`;
    }
  }
  if (!opts.e2e) picked = picked.filter((n) => n !== 'e2e-mp');
  return { picked, reason };
}

// ─── Process helpers ───────────────────────────────────────────────────────────────────────────────────────────
const children = new Set();
function npmRun(script, logName, extraEnv = {}) {
  const log = createWriteStream(resolve(LOG_DIR, `${logName}.log`));
  const env = { ...process.env, FORCE_COLOR: '0', ...extraEnv };
  const child = isWin
    ? spawn(`npm.cmd run ${script}`, { shell: true, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env })
    : spawn('npm', ['run', script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stdout.pipe(log); child.stderr.pipe(log);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { child.kill('SIGTERM'); } catch { /* gone */ } }
}
function pidsOnPort(port) {
  if (isWin) {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
    const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
    return [...new Set(out.split('\n').map((l) => l.match(re)?.[1]).filter((p) => p && p !== '0'))];
  }
  const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '';
  return out.split('\n').filter(Boolean);
}
function killPort(port) {
  for (const pid of pidsOnPort(port)) {
    if (isWin) spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } }
  }
}
/* 2026-09-17 (E-12): 커널 대기에 걸린 chrome 이 살아남으면 puppeteer 도 `close-browser.mjs` 도 그 브라우저의 임시 프로필을
   못 지운다 — 그날 %TEMP% 에 45개가 쌓여 있었다. 지우는 건 러너의 몫이다. 2시간은 가장 긴 스모크(~4분)보다 한참 길어
   **지금 돌고 있는** 브라우저의 프로필을 건드릴 수 없는 값이다. */
function sweepStaleProfiles(maxAgeMs = 2 * 60 * 60 * 1000) {
  const tmp = os.tmpdir();
  let gone = 0;
  for (const name of readdirSync(tmp).filter((n) => n.startsWith('puppeteer_dev_chrome_profile-'))) {
    const dir = resolve(tmp, name);
    try {
      if (Date.now() - statSync(dir).mtimeMs < maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true, maxRetries: 1 });
      gone++;
    } catch { /* 아직 누가 쥐고 있다 — 다음 실행에서 다시 본다 */ }
  }
  if (gone) console.log(`  swept ${gone} stale puppeteer profile folder(s) from %TEMP%`);
}
async function isUp(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(url, label, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await isUp(url)) return true; await sleep(500); }
  throw new Error(`${label} did not come up at ${url} within ${ms / 1000}s (see ${LOG_REL}/)`);
}
/** Run a command, capture everything to a log, return {code, out, seconds}. */
function runCapture(cmd, args, logName, { shell = false, timeoutMs = opts.timeoutMs } = {}) {
  return new Promise((done) => {
    const t0 = Date.now();
    const log = createWriteStream(resolve(LOG_DIR, `${logName}.log`));
    let out = '';
    const child = spawn(cmd, args, { shell, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } });
    children.add(child);
    const onData = (chunk) => { out += chunk; log.write(chunk); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const timer = setTimeout(() => { out += `\n[verify] timeout after ${timeoutMs / 60000} min — killed\n`; killTree(child); }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer); children.delete(child); log.end();
      done({ code: code ?? (signal ? 1 : 0), out, seconds: Math.round((Date.now() - t0) / 1000) });
    });
    child.on('error', (err) => { clearTimeout(timer); children.delete(child); done({ code: 1, out: String(err), seconds: 0 }); });
  });
}
function summarize(name, r) {
  const m = [...r.out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
  const ratio = r.out.match(/(\d+)\/(\d+) passed/); // server selftest prints "selftest: 101/101 passed"
  const passed = m ? Number(m[1]) : ratio ? Number(ratio[1]) : null;
  const failed = m ? Number(m[2]) : ratio ? Number(ratio[2]) - Number(ratio[1]) : null;
  const consoleErrs = r.out.match(/(\d+) console errors/)?.[1];
  const ok = r.code === 0 && (failed === null || failed === 0);
  const fails = r.out.split('\n').filter((l) => /^\s*FAIL\b/.test(l)).slice(0, 12);
  const score = passed !== null ? `${passed}/${passed + failed}` : (r.code === 0 ? 'ok' : `exit ${r.code}`);
  return { name, ok, score, passed, failed, consoleErrs: consoleErrs ? Number(consoleErrs) : undefined, seconds: r.seconds, code: r.code, fails, log: `${LOG_REL}/${name}.log` };
}
function report(s) {
  const mark = s.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  console.log(`${mark} ${s.name.padEnd(20)} ${s.score.padEnd(9)} ${String(s.seconds).padStart(4)} s${s.ok ? '' : `   → ${s.log}`}`);
  for (const f of s.fails) console.log(`      ${f.trim()}`);
  if (!s.ok && !s.fails.length) console.log(`      (no FAIL line — crashed or timed out; tail of ${s.log}:)\n      ${tail(s.log)}`);
}
function tail(logRel, n = 6) {
  try { return readFileSync(resolve(ROOT, logRel), 'utf8').trim().split('\n').slice(-n).join('\n      '); } catch { return ''; }
}

// ─── Main ──────────────────────────────────────────────────────────────────────────────────────────────────────
mkdirSync(LOG_DIR, { recursive: true });
const started = { vite: null, relay: null, relayData: null };
const results = [];
const tStart = Date.now();
let exiting = false;
function cleanup() {
  if (exiting) return; exiting = true;
  for (const c of children) killTree(c);
  killTree(started.vite); killTree(started.relay);
  if (started.relayData) { try { rmSync(started.relayData, { recursive: true, force: true }); } catch { /* still locked → stays in %TEMP% */ } }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

try {
  const { picked, reason } = select();
  console.log(`verify — ${reason}`);
  console.log(`  smokes: ${picked.length ? picked.join(', ') : '(none)'}   jobs: ${opts.jobs}   cpus: ${os.cpus().length}`);
  /* 2026-09-16: `--dry-run` 은 고른 것만 찍고 끝낸다. shared 변경이 전체로 올라갈지 아닐지를 20분 써서 알아낼 수는 없다. */
  if (opts.dryRun) { console.log(`  (--dry-run: ${picked.length} scripts, nothing run)`); process.exit(0); }

  // 1. Fast static checks, all in parallel.
  const npx = isWin ? 'npx.cmd' : 'npx';
  const fast = [];
  if (opts.typecheck) {
    fast.push(runCapture(npx, ['tsc', '--noEmit'], 'typecheck', { shell: isWin }).then((r) => summarize('typecheck', r)));
    fast.push(runCapture(npx, ['tsc', '--noEmit', '-p', 'server/tsconfig.json'], 'typecheck-server', { shell: isWin }).then((r) => summarize('typecheck-server', r)));
  }
  /* 2026-09-16: net:selftest 는 50초쯤 걸리는데 `fast` 를 다 기다린 뒤에야 스모크가 시작돼, 매 실행이 브라우저를 한 대도
     안 띄운 채 50초를 버렸다. 이 검사는 **랜덤 포트에 자기 릴레이를 띄우는 순수 Node 테스트**(`server/selftest.ts` 머리 주석)라
     8787 릴레이 · vite · 스모크와 겹쳐도 서로 건드리지 않는다 — 스모크와 나란히 돌리고 요약 직전에만 기다린다. */
  const slow = [runCapture(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/selftest.ts'], 'net-selftest')
    .then((r) => { const s = summarize('net-selftest', r); results.push(s); report(s); return s; })];

  // data/*.csv 는 수치의 단일 원본이다 — 오타는 게임을 죽이지 않고 조용히 기본값으로 굴러가므로 여기서 잡는다.
  fast.push(runCapture(process.execPath, ['scripts/data-check.mjs'], 'data-check').then((r) => summarize('data-check', r)));
  /* CSS 클래스 접두사도 같은 종류의 구멍이다 — 두 폴더가 같은 접두사를 고르면 전역 규칙이 남의 화면에 걸리는데
     타입체크도 스모크도 못 본다(클래스는 문자열이고, 결과는 오류가 아니라 어긋난 그림이다 — B-18). 0.1 초다. */
  fast.push(runCapture(process.execPath, ['scripts/check-css-prefixes.mjs'], 'css-prefixes').then((r) => summarize('css-prefixes', r)));
  if (opts.build) fast.push(runCapture(npx, ['vite', 'build'], 'build', { shell: isWin }).then((r) => {
    const s = summarize('build', r);
    const js = r.out.match(/index-[\w-]+\.js\s+([\d.,]+ kB)/)?.[1]; const css = r.out.match(/index-[\w-]+\.css\s+([\d.,]+ kB)/)?.[1];
    if (js) s.score = `${js} JS${css ? ` / ${css} CSS` : ''}`;
    return s;
  }));
  for (const s of await Promise.all(fast)) { results.push(s); report(s); }

  // `standalone` = 이 스크립트는 vite 도 릴레이도 쓰지 않는다 (배포 서버 빌드 · 피칭 위키).
  // 고른 것이 **전부** standalone 이면 서버를 아예 띄우지 않는다 — 안 그러면 쓰지도 않을 vite 를
  // 기다리느라 수십 초를 버린다. 하나라도 브라우저를 쓰면 예전처럼 둘 다 띄운다.
  const needServers = picked.some((n) => !SMOKES[n].standalone);
  if (picked.length) {
    if (needServers) sweepStaleProfiles();
    // 2. Servers — 고른 것이 전부 standalone 이면 건너뛴다.
    if (!needServers) console.log('  servers skipped (standalone scripts only)');
    else {
      const relayUrl = 'http://localhost:8787/health';
      const needFreshRelay = picked.some((n) => SMOKES[n].freshRelay) && !opts.keepRelay;
      if (needFreshRelay && pidsOnPort(8787).length) { console.log('  restarting relay (stale lobbies would hijack quick match)'); killPort(8787); await sleep(500); }
      if (!(await isUp(relayUrl))) {
        // C-41 (2026-09-11): 러너가 직접 띄우는 릴레이는 임시 프로필 저장소를 쓴다 — 스모크가 만든 수천 개의
        // 테스트 프로필이 개발용 server/data/profiles.json 에 쌓이지 않게. 이미 떠 있던 릴레이는 건드리지 않는다.
        started.relayData = mkdtempSync(resolve(os.tmpdir(), 'scav-verify-relay-'));
        // E-4 (2026-09-11): 스모크 · e2e 가 쓰는 dev 크레딧 사유(smoke:* · e2e:* · console · shot)를 받는 릴레이로 띄운다.
        started.relay = npmRun('server', 'relay', { SCAV_DATA_DIR: started.relayData, SCAV_DEV_ECONOMY: '1' });
        await waitUp(relayUrl, 'relay');
        console.log(`  relay started (8787, profiles in ${started.relayData})`);
      }
      else {
        console.log('  relay already up (8787)');
        // E-4 (2026-09-11): a relay someone started by hand (dev:all · npm run server) refuses the dev credit reasons
        // (`smoke:*` top-ups revert). `/health.devEconomy` is absent on a relay older than the credit validation.
        const h = await fetch(relayUrl, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null);
        if (h && h.devEconomy === false) console.log('  note: that relay runs WITHOUT SCAV_DEV_ECONOMY — smokes that top up credits with smoke:* reasons see them reverted (restart it with SCAV_DEV_ECONOMY=1, or drop --keep-relay)');
      }
      if (!(await isUp(opts.url))) { started.vite = npmRun('dev', 'vite'); await waitUp(opts.url, 'vite'); console.log(`  vite started (${opts.url})`); }
      else console.log(`  vite already up (${opts.url})`);
    }

    // 3. Smokes in a pool; exclusive jobs afterwards, one at a time.
    const pool = picked.filter((n) => !SMOKES[n].exclusive);
    const solo = picked.filter((n) => SMOKES[n].exclusive);
    const runSmoke = async (name) => {
      const s = summarize(name, await runCapture(process.execPath, [...(SMOKES[name].nodeArgs ?? []), SMOKES[name].file, opts.url], name));
      results.push(s); report(s);
    };
    let next = 0;
    const stagger = Math.max(1_000, Math.round(RAMP_BUDGET_MS / Math.max(1, opts.jobs)));
    const lane = async (i) => { await sleep(i * stagger); while (next < pool.length) await runSmoke(pool[next++]); };
    await Promise.all(Array.from({ length: Math.min(opts.jobs, pool.length) }, (_, i) => lane(i)));
    for (const name of solo) await runSmoke(name);
  }
  await Promise.all(slow);
} catch (err) {
  console.error(`\nverify aborted: ${err.message}`);
  results.push({ name: 'runner', ok: false, score: 'aborted', seconds: 0, fails: [], log: `${LOG_REL}/` });
} finally {
  cleanup();
}

// 4. Summary + record.
const total = Math.round((Date.now() - tStart) / 1000);
const failed = results.filter((r) => !r.ok);
const line = results.map((r) => `${r.name} ${r.score}${r.consoleErrs ? ` (${r.consoleErrs} console errors)` : ''}`).join(', ');
console.log(`\n${failed.length ? `\x1b[31m${failed.length} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'} in ${Math.floor(total / 60)} min ${total % 60} s`);
console.log(`docs line: ${new Date().toISOString().slice(0, 10)}: ${line}`);
if (failed.length) console.log('re-run only the failures: node scripts/verify.mjs --rerun-failed');
const record = { time: new Date().toISOString(), totalSeconds: total, results };
writeFileSync(LAST_RUN, JSON.stringify(record, null, 2));
/* 2026-09-17 (E-13): 빨간 잡의 로그를 `failed/` 에 복사해 둔다. 실패한 실행의 로그는 늘 「단독으로 다시 돌려 보는」
   다음 실행이 같은 파일 이름으로 덮었고, 그 재실행이 초록이면 증거가 통째로 사라졌다 (E-13 의 2026-09-16 실패 3번이
   그렇게 없어졌다). 여기 사본은 **다음 빨간 실행**에만 덮인다. */
if (failed.length) {
  const dir = resolve(LOG_DIR, 'failed');
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const r of failed) { try { copyFileSync(resolve(ROOT, r.log), resolve(dir, `${r.name}.log`)); } catch { /* 로그 파일이 없는 잡(runner) */ } }
    writeFileSync(resolve(dir, 'last-run.json'), JSON.stringify(record, null, 2));
    console.log(`failed logs kept in ${LOG_REL}/failed/ (only the next red run overwrites them)`);
  } catch { /* 사본을 못 남겨도 실행 결과는 그대로다 */ }
}
process.exit(failed.length ? 1 : 0);
