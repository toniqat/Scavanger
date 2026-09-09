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
}

/**
 * 함선으로 들어간다. 초대 코드가 없으면 곧장 `hub:enter {ship:'personal'}` 한 프레임이다.
 * 대기 중에 페이즈가 바뀌면(다른 경로로 이미 들어갔다면) 조용히 물러난다.
 */
export async function enterShip(ctx: GameContext, hooks: EnterShipHooks = {}): Promise<void> {
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

  ctx.bus.emit('hub:enter', { ship: 'personal' });
}
