import type { GameContext } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * 함선 탑승 한 갈래 (2026-09-09).
 *
 * 예전에는 타이틀의 `함선 탑승` 버튼(`TitleMenu.board()`)이 이 일을 직접 했다. 캐릭터 선택창이 생기면서
 * 들어가는 문이 **둘**이 됐다:
 *
 *   1. 캐릭터 선택창에서 지금 슬롯의 카드를 눌렀을 때 (새로고침 없이 바로 함선으로),
 *   2. 다른 슬롯을 골라 새로고침한 **직후** (`markAutoStart` → `takeAutoStart`, 타이틀을 건너뛴다).
 *
 * 초대 링크(`?lobby=CODE` → `ctx.net.inviteCode`) 흐름이 둘 중 하나에만 붙어 있으면, 초대를 받은 사람이 슬롯을
 * 바꿔 들어가는 순간 공유 함선 대신 개인 함선에 떨어진다. 그래서 문이 아니라 **길**을 하나로 둔다.
 *
 * 동작은 예전 `TitleMenu.board()` 그대로다: 초대 코드가 있으면 먼저 `ensureConnected()`, 성공하면 개인 함선에
 * 들어간 뒤 `joinLobby(code)` (허브가 공유 함선으로 도킹시킨다). 실패하면 안내를 남기고 **그 다음 시도부터는**
 * 오프라인 개인 함선으로 간다.
 * ──────────────────────────────────────────────────────────────────────────── */

/* ── appended (2026-09-14, 튜토리얼 개편 — `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」) ──────────────────────────────────
 *
 * **새 캐릭터는 함선을 거치지 않는다.** 튜토리얼 트랙 ①(`raid`)이 아직 안 끝났으면 이 길은 `hub:enter` 대신
 * **튜토리얼 레이드**로 간다 — 손으로 지은 튜토리얼 행성에서 깨어나 조작을 배우고, 버려진 함선을 타고 탈출하는 것이
 * 곧 **함선 획득**이다. 탈출 정산이 끝난 뒤의 `hub:enter {ship:'personal'}` 는 결과 화면 · `game/` 의 평소 경로라
 * 여기에 새 코드가 없다 (트랙 ②는 그 첫 진입에서 `tutorial/` 이 시작한다).
 *
 * 갈림길이 여기인 이유는 이 파일 머리 주석 그대로다 — 들어가는 **문**은 둘(카드 클릭 · 슬롯 전환 뒤 자동 시작)이지만
 * **길**은 하나다. 판정을 `TitleMenu` 에 넣으면 자동 시작으로 들어온 새 캐릭터만 함선에 떨어진다.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** 한 번 실패한 초대는 다시 시도하지 않는다 (예전 `TitleMenu.inviteFailed` 와 같은 뜻, 타이틀 흐름은 하나뿐이라 모듈 상태로 둔다). */
let inviteFailed = false;

/** 이 화면이 초대 코드를 들고 있는가 — 버튼 라벨을 `초대 수락 · 함선 탑승` 으로 바꿀지 결정한다. */
export function hasPendingInvite(ctx: GameContext): boolean {
  return !!ctx.net?.inviteCode && !inviteFailed;
}

export interface EnterShipHooks {
  /** 서버에 붙는 동안 true (라벨은 `서버 연결 중…`), 끝나면 false. */
  setBusy?(busy: boolean): void;
  /** 초대 수락 실패 안내. */
  showMessage?(text: string, kind: 'info' | 'warning' | 'danger'): void;
  /** 2026-09-15: 기다려 보니 이어할 레이드가 있었다 — 함선 대신 타이틀로 돌아간다 (부른 화면이 스스로 닫힌다). */
  onResumeOffer?(): void;
}

/**
 * 함선으로 들어간다. 초대 코드가 없으면 곧장 `hub:enter {ship:'personal'}` 한 프레임이다.
 * 대기 중에 페이즈가 바뀌면(다른 경로로 이미 들어갔다면) 조용히 물러난다.
 */
export async function enterShip(ctx: GameContext, hooks: EnterShipHooks = {}): Promise<void> {
  /*
   * 2026-09-15 (타이틀 이어하기 · 레이드 포기): **레이드가 남아 있으면 함선이 아니라 타이틀이다.** 분대 레이드는 서버에 물어야
   * 보이므로 그 질문(`ctx.raidResume.checking` — 부팅 때 표식이 있을 때만)이 끝날 때까지 기다린다. 이 파일이 문이 아니라 길이라
   * (머리 주석) 캐릭터 카드 · 슬롯 전환 뒤 자동 시작이 모두 여기를 지난다.
   */
  const rr = ctx.raidResume;
  if (rr?.checking) {
    hooks.setBusy?.(true);
    try { await rr.settled(); } catch { /* 모르면 예전처럼 들어간다 */ }
    hooks.setBusy?.(false);
    if (ctx.phase !== 'menu') return;
  }
  if (rr?.offer) { hooks.onResumeOffer?.(); return; }

  const net = ctx.net;
  const code = net?.inviteCode ?? null;

  if (net && code && !inviteFailed) {
    hooks.setBusy?.(true);
    let ok = false;
    try { ok = await net.ensureConnected(); } catch { ok = false; }
    hooks.setBusy?.(false);
    if (ctx.phase !== 'menu') return;
    if (!ok) {
      inviteFailed = true;
      hooks.showMessage?.('서버에 연결할 수 없습니다 — 초대를 수락하지 못했습니다. 다시 누르면 개인 함선(오프라인)으로 탑승합니다.', 'danger');
      return;
    }
    ctx.bus.emit('hub:enter', { ship: 'personal' });
    net.joinLobby(code);
    ctx.bus.emit('ui:notify', { text: `초대 코드 ${code} — 공유 함선에 합류 중`, kind: 'info' });
    return;
  }

  // 2026-09-14: 초대가 없고 트랙 ① 이 아직 안 끝난 새 캐릭터면 함선 대신 튜토리얼 레이드로 간다.
  if (startTutorialRaid(ctx)) return;

  ctx.bus.emit('hub:enter', { ship: 'personal' });
}

/**
 * 튜토리얼 레이드로 갈 차례인가 — 갔으면 true.
 *
 * **초대는 튜토리얼보다 앞선다** (위 호출부의 순서). 둘 중 덜 놀라운 쪽을 고른 것이다: 초대는 **사람이 지금 기다리고
 * 있는 약속**이고, 튜토리얼은 나중에 혼자 들어올 때 그대로 기다린다 (트랙은 건너뛴 것으로 치지 않는다 — `skipTrack`
 * 을 부르지 않으므로 다음 단독 진입에서 다시 이 갈림길에 선다). 반대로 「튜토리얼 먼저, 초대는 그 뒤에」로 하면
 * 탈출 정산 뒤의 함선 첫 진입은 `game/` 의 경로라 이 파일이 초대를 이어 줄 자리가 없고, 친구는 그동안 빈 함선을
 * 보고 있게 된다.
 *
 * **솔로 강제**: 튜토리얼 레이드는 매치메이킹 · 로비가 없다. 로비에 이미 들어가 있으면(초대 · 재접속) 아무것도 하지
 * 않고 평소 경로로 넘긴다 — 여기서 혼자 `game:newMission` 을 내면 분대와 어긋난다.
 */
function startTutorialRaid(ctx: GameContext): boolean {
  const tut = ctx.tutorial;
  if (!tut || typeof tut.isTrackDone !== 'function' || tut.isTrackDone('raid')) return false;
  if (ctx.net?.lobby) return false;

  /*
   * `missionPlanet` · `missionIntel` 과 **똑같은 규약**: `game:newMission` 을 emit 하는 쪽이 **emit 전에** 세팅한다
   * (`hub/parts/Pods.launch` · `hub/parts/Crew.startTraining` 이 본보기). 튜토리얼 행성은 손으로 지은 월드라
   * 목표 행성도 정보상 기믹도 없다 — 훈련장과 같은 처리다.
   */
  ctx.missionMode = 'tutorial';
  ctx.missionPlanet = null;
  ctx.missionIntel = null;
  // 월드는 시드를 쓰지 않지만(고정 배치) 계약이 숫자를 요구하므로 하나 굴려 넘긴다.
  ctx.bus.emit('game:newMission', { seed: (Math.random() * 0xffffffff) >>> 0, mode: 'tutorial' });
  return true;
}
