import type { PlanetId } from './planets';

/* ────────────────────────────────────────────────────────────────────────────
 * 타이틀의 이어하기 · 레이드 포기 (2026-09-15, docs/DECISIONS.md 「2026-09-15 — 타이틀 이어하기 · 레이드 포기」).
 *
 * 레이드가 남아 있는 채로 게임을 켜면 **타이틀부터** 시작한다. 타이틀은 `이어하기`(강조) 밑에 붉은 `게임 시작` 을 두고,
 * 그 `게임 시작` 은 포기 팝업만 연다 (다른 캐릭터로 바꾸는 것도 이 레이드를 그만두겠다는 뜻이다 — 사용자 결정).
 *
 *  - `solo`     — localStorage 의 솔로 레이드 세이브. 유예(`SOLO_RAID_GRACE_MS`)는 **누르는 순간** 본다: 타이틀에 머무는
 *                 동안 넘으면 `이어하기` 가 사라지고 레이드 실패로 정산된다.
 *  - `tutorial` — 튜토리얼 세이브 (시간 제한 없음). 포기 = 진행만 지우고 다음 시작에서 **처음부터**.
 *  - `squad`    — 릴레이 로비에서 아직 달리는 분대 레이드. 부팅 때 `SQUAD_RAID_MARK_KEY` 가 있을 때만 타이틀에서 접속해
 *                 묻는다. 포기 = 그 레이드에서 사망 + **표류**(`LobbyPlayer.drifted` — 구조선 대상도 재투입도 아니다).
 *
 * Owner: game/ (`ctx.raidResume`). 그리는 쪽은 ui/menus/TitleMenu 하나다.
 * ──────────────────────────────────────────────────────────────────────────── */

export type RaidResumeKind = 'solo' | 'tutorial' | 'squad';

/** 포기 팝업의 초상 한 칸 (매칭 탭의 칸과 같은 어휘). */
export interface RaidResumeMember {
  id: string;
  name: string;
  /** 모르면 null (안드로이드 · 옛 서버). */
  level: number | null;
  /** `#rrggbb`, 모르면 null → 슬롯 색. */
  accent: string | null;
  slot: number;
  isHost: boolean;
  me: boolean;
  bot: boolean;
  /** 안드로이드의 조종실 슬롯 (사람은 0). */
  bay: number;
  connected: boolean;
  /** 이미 이 레이드를 포기한 분대원. */
  drifted: boolean;
}

export interface RaidResumeOffer {
  kind: RaidResumeKind;
  /** 튜토리얼 · 모르는 행성은 null. */
  planet: PlanetId | null;
  /** 마지막 저장 시점의 미션 경과 초. */
  missionTime: number;
  /** 나 → 다른 분대원(슬롯 순). 솔로 · 튜토리얼은 나 하나. */
  members: readonly RaidResumeMember[];
}

export interface RaidResumeRef {
  /** 지금 타이틀에 내밀 레이드, 없으면 null. 타이틀(phase `menu`) 밖에서는 늘 null. */
  readonly offer: RaidResumeOffer | null;
  /** 분대 레이드를 릴레이에 묻는 중이다 (부팅 때 한 번, 표식이 있을 때만). */
  readonly checking: boolean;
  /** 그 질문이 끝나면 풀린다 (묻는 중이 아니면 곧장). 캐릭터 선택 · 자동 시작이 이것을 기다린다. */
  settled(): Promise<void>;
  /** `이어하기`. 들어갔으면 true — 유예가 지난 솔로 레이드는 그 자리에서 실패로 정산하고 false. */
  resume(): boolean;
  /** `레이드 포기` (1초 홀드 뒤). 솔로 = 사망 정산 · 튜토리얼 = 처음부터 · 분대 = 사망 + 표류. */
  abandon(): void;
}

/**
 * 「이 캐릭터는 분대 레이드 안에 있다」 표식 (`slotKey` 를 탄다 — 세션 토큰이 슬롯마다라서다). 분대 레이드가 시작될 때
 * `{code, seed}` 로 적고 그 레이드가 이 사람에게 끝나면(탈출 · 실패 · 포기 · 귀환 · 로비 이탈) 지운다. 새로고침에는
 * 지우는 이벤트가 없으므로 남는다 — 그것이 곧 「타이틀에서 서버에 물어볼 이유가 있다」는 뜻이다.
 */
export const SQUAD_RAID_MARK_KEY = 'scav.squadraid';
