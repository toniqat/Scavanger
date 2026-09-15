/* appended (2026-09-09): 수치 원본은 data/*.csv — csv 로더/조회기를 계약으로 공개한다 */
export * from './data/tables';
export * from './constants';
export * from './types';
export * from './events';
export * from './net';
export * from './gear';
export * from './implants';
export * from './gadgets';
export * from './progression';
export { EventBus } from './EventBus';
export { Input } from './Input';
export { GameContext } from './GameContext';
export { Random } from './Random';
/* appended: key rebinding (2026-09-06) */
export * from './Keybinds';
/* appended (2026-09-06): dev console + ship housing contracts */
export * from './console';
export * from './housing';
/* appended (2026-09-06): Phase 5 meta progression contract */
export * from './meta';
/* appended (2026-09-06): Phase 7 — server profile / raid session, item labels */
export * from './profile';
export * from './labels';
/* appended (2026-09-06): Phase 8 — shared 재료 요구 칩 renderer */
export * from './itemChip';
/* appended (2026-09-07): Phase 10 — 인게임 마우스 커서 */
export * from './cursor';
/* appended (2026-09-07): Phase 11 — 행성 선택 · 소셜 */
export * from './planets';
/* appended (2026-09-09): 행성 표는 csv 를 읽으므로 서버가 실행하는 planets.ts 와 갈라져 있다 */
export * from './planetDefs';
export * from './social';
/* appended (2026-09-08): 튜토리얼 계약 */
export * from './tutorial';
/* appended (2026-09-14): 튜토리얼 월드 질의 — `ctx.world.tutorial` (체크포인트 · 낙하 규칙) */
export * from './tutorialWorld';
/* appended (2026-09-09): 캐릭터 세이브 슬롯 · 캐릭터 생성 · 재화(보상) 칩 */
export * from './saveSlot';
export * from './character';
export * from './currency';
/* appended (2026-09-09): Escape 닫기 스택 — 열린 화면 중 가장 위 하나를 ESC 로 닫는다 */
export * from './escape';
/* appended (2026-09-13): 공용 경고 · 1초 홀드 확인 팝업 (`openHoldAsk`) — 첫 사용처는 캐릭터 시트 */
export * from './holdAsk';
/* appended (2026-09-09): 레이드 플레이 개선 — 의사소통 휠 계약 */
export * from './comms';
/* appended (2026-09-10): 포탄 궤적 닫힌 식 — enemies 와 ui 가 같은 자리를 그린다 */
export * from './ballistics';
/* appended (2026-09-10): 셰이더 선컴파일 · 점광원 예산 — `ctx.shaders` */
export * from './render';
/* appended (2026-09-11): 점광원 풀 — 함선(hub)과 행성 구조물(world)이 같은 규칙으로 가까운 자리만 비춘다 */
export * from './lightPool';
/* appended (2026-09-11): 투척물이 창문 유리를 깨고 지나가는 한 줄 — weapons · gadgets · enemies 공용 */
export * from './fragile';
/* appended (2026-09-11): 지상 · 공중 드론 (`ctx.drones`) · 네임드 로그 */
export * from './drones';
export * from './named';
/* appended (2026-09-11, C-18): 차량 탑승 좌표 변환 — 플레이어 · 적 · 시체가 같은 식으로 전차에 탄다 */
export * from './ride';
/* appended (2026-09-11): 소셜 · 신뢰 · 연결 — 받는 쪽 버프 상한 · 서버 크레딧 사유 문법 / 경제 표 */
export * from './buffRules';
export * from './credits';
/* appended (2026-09-12): 캐릭터 버프 — 식사 · 준비물 · 운동 디버프 · 환경 노출 · 휴식 / 운동 중을 한 목록으로 (docs/DECISIONS.md 「2026-09-12 — 캐릭터 버프」) */
export * from './charBuffs';
/* appended (2026-09-12): 루팅 굴림 시드 식 — 여는 코드와 미리보기(world · 드론 스캔)가 같은 식을 쓴다 */
export * from './lootRolls';
/* appended (2026-09-12): 「이번 레이드에서 얻은 아이템」 표식 — 아이템 회수 계약의 개수 · 스택 분리 · 사선 띠 (docs/DECISIONS.md 「2026-09-12 — 전투 소모품」) */
export * from './raidFound';
/* appended (2026-09-13): 탈출 개편 — `ctx.extraction` (적 출입 금지 영역 · 출발 유예 상태) */
export * from './extraction';
/* appended (2026-09-13): 요리 미니게임 · 요리 품질 — 조리대 단계표 · 자동 조리 가구 · 품질 별 (docs/DECISIONS.md 「2026-09-13 — 요리 미니게임」) */
export * from './cooking';
/* appended (2026-09-13): 암호화폐 채굴 · 거래소 — 코인 표(csv) · 순수 시세 식(릴레이 공용) */
export * from './crypto';
export * from './cryptoMarket';
/* appended (2026-09-13): 서재 시리즈 · 매체 효과 · 비디오게임 (docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) */
export * from './library';
/* appended (2026-09-14): 메신저 NPC · NPC 퀘스트 (docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」) */
export * from './npc';
/* appended (2026-09-14): 로컬 총기 피해 출처 — NPC 퀘스트 「그 계열 총기로 처치」 (weapons 가 감싸고 enemies 가 읽는다) */
export * from './damageSource';
/* appended (2026-09-14): 정보상 — 기믹 고정 선택 · 해석본 · 비용 식 (릴레이 공용, docs/DECISIONS.md 「2026-09-14 — 정보상」) */
export * from './intel';
export * from './intelDefs';
/* appended (2026-09-15): 공용 키캡 — 마우스 버튼 그림 · 꾹 누르기 · 문장 안 키캡 토큰 (`{FIRE:hold}`) */
export * from './keycap';
/* appended (2026-09-15): 폭발 감쇠 2단 계단 — 모든 폭발물이 같은 식을 쓴다 (weapons · enemies · gadgets · stratagems) */
export * from './explosion';
/* appended (2026-09-15): 얼굴 초상 프레이밍 — 캐릭터 생성 확정 팝업과 터미널 매칭 탭이 같은 얼굴을 그린다 */
export * from './faceFraming';
/* appended (2026-09-15): 안드로이드 분대원 (`ctx.allies`) · 엄폐 자리 고르기 — 적 인간형과 안드로이드가 같은 식을 쓴다 */
export * from './allies';
export * from './cover';
/* appended (2026-09-15): 타이틀 이어하기 · 레이드 포기 (`ctx.raidResume`) */
export * from './raidResume';
/* appended (2026-09-16): 요리 정의 표 — 요리는 아이템이 아니라 식탁의 접시다 (`getMealDef`, `data/meals.csv`) */
export * from './meals';
