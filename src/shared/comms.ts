/* ────────────────────────────────────────────────────────────────────────────
 * 의사소통 휠 (2026-09-09, owner: ui/hud/CommsWheel)
 *
 * `H` 를 **꾹 누르면** 방사형 휠이 열리고, 마우스를 밀어 한 칸을 고른 뒤 키를 놓으면 그 한 마디가 분대에
 * 전해진다 (채팅 한 줄 + 토스트 + 효과음). 짧게 톡 누르면 아무 일도 없다 — 이 키는 오직 휠이다.
 *
 * 배치가 상태에 따라 둘로 갈린다:
 *   - 서 있을 때 (`COMMS_ALIVE`)   — **4칸** N / E / S / W
 *   - 전투불능일 때 (`COMMS_DOWNED`) — **2칸** 좌 / 우 (살려줘 · 나를 버려)
 * 같은 순간 지역 핑(마우스 휠 버튼) 홀드 제스처도 같은 두 마디로 바뀐다 (`PingKind` 의 `help` / `abandon`).
 *
 * 문구(`line`)에 `{n}` 이 들어 있는 항목은 **보내는 쪽이** 숫자를 채워서 보낸다 (`comms:sent.text` 는 언제나
 * 완성된 문장이다). 지금 그런 항목은 `contract` 하나뿐이고 meta/ 의 진행 중인 계약에서 값을 얻는다.
 *
 * 이 파일은 값(라벨 · 배치)만 들고 있고 수치는 `data/constants.csv` 다 (`COMMS_*`).
 * ──────────────────────────────────────────────────────────────────────────── */

/** 한 마디의 식별자. **재정렬 · 삭제 금지** — 와이어(`CommsMessage.id`)가 이 문자열을 그대로 싣는다. */
export type CommsId =
  /* 서 있을 때 (4칸) */
  | 'need_heal'    // 회복수단이 필요하다
  | 'extract'      // 탈출해야 한다
  | 'contract'     // 내 계약 강조 — "계약 완료까지 <이름> <n>건 남았다"
  | 'lead'         // 앞장서라
  /* 전투불능일 때 (2칸) */
  | 'help_me'      // 살려줘
  | 'abandon_me';  // 나를 버려

/** 휠 칸의 자리. 4칸 배치는 N/E/S/W, 2칸 배치는 L/R 만 쓴다. */
export type CommsDir = 'N' | 'E' | 'S' | 'W' | 'L' | 'R';

export interface CommsDef {
  id: CommsId;
  /** 휠 칸에 그리는 짧은 라벨. */
  label: string;
  /**
   * 실제로 나가는 문장. `{n}` · `{name}` 이 있으면 보내는 쪽이 치환한다 (치환하지 못하면 `fallback` 을 쓴다).
   * 앞에 보낸 사람 이름은 붙이지 않는다 — 채팅 · 토스트가 `comms:sent.byName` 으로 알아서 붙인다.
   */
  line: string;
  /** `{n}` 을 채울 수 없을 때 쓰는 문장 (계약이 하나도 없을 때 등). 없으면 `line` 을 그대로 쓴다. */
  fallback?: string;
  dir: CommsDir;
  /** 휠 칸 색 (CSS). 급한 것일수록 붉다. */
  color: string;
}

/** 서 있을 때의 4칸. **배열 순서 = 휠 index** 이고 `comms:wheelChanged.hover` 가 그 index 다. */
export const COMMS_ALIVE: readonly CommsDef[] = [
  { id: 'need_heal', dir: 'N', label: '회복 필요', line: '회복수단이 필요하다!', color: '#4fd17e' },
  { id: 'extract',   dir: 'E', label: '탈출',     line: '탈출해야 한다!',       color: '#ffb347' },
  { id: 'contract',  dir: 'S', label: '내 계약',  line: '내 계약 — {name} 완료까지 {n}건 남았다.', fallback: '진행 중인 계약이 없다.', color: '#7fb7e6' },
  { id: 'lead',      dir: 'W', label: '앞장서라', line: '앞장서라.',             color: '#c77dff' },
];

/** 전투불능일 때의 2칸 (좌 / 우). */
export const COMMS_DOWNED: readonly CommsDef[] = [
  { id: 'help_me',     dir: 'L', label: '살려줘',     line: '살려줘!',       color: '#ff4d4d' },
  { id: 'abandon_me',  dir: 'R', label: '나를 버려',  line: '나를 버려라.',  color: '#8a929c' },
];

/** id → def (양쪽 배치를 합친 표). */
export const COMMS_DEF_MAP: ReadonlyMap<CommsId, CommsDef> =
  new Map([...COMMS_ALIVE, ...COMMS_DOWNED].map((d) => [d.id, d]));

/** 그 상태에서 쓰는 배치. 다른 데서 `downed ? COMMS_DOWNED : COMMS_ALIVE` 를 다시 쓰지 않는다. */
export function commsLayout(downed: boolean): readonly CommsDef[] {
  return downed ? COMMS_DOWNED : COMMS_ALIVE;
}

/**
 * `line` 의 자리표시자를 채운다. 값이 모자라면 `fallback`(없으면 `line` 원문)을 돌려준다.
 * 보내는 쪽 하나에서만 부르고, 받는 쪽은 이미 완성된 `comms:sent.text` 를 그대로 그린다.
 */
export function fillCommsLine(def: CommsDef, vars?: { n?: number; name?: string }): string {
  const needsN = def.line.includes('{n}');
  const needsName = def.line.includes('{name}');
  if ((needsN && vars?.n === undefined) || (needsName && !vars?.name)) return def.fallback ?? def.line;
  return def.line
    .replace('{n}', String(vars?.n ?? 0))
    .replace('{name}', vars?.name ?? '');
}

/**
 * 전투불능 상태의 지역 핑이 되는 `PingKind`. 좌 = 살려줘(`help`), 우 = 나를 버려(`abandon`);
 * 서 있을 때는 좌 = 여기 조심해(`caution`), 우 = 저쪽으로 가자(`attack`) 그대로다.
 * 라벨은 ui/hud/Pings 의 `PING_LABEL` 이 소유한다 — 여기서는 어떤 kind 가 어느 쪽인지만 정한다.
 */
export const PING_HOLD_KINDS = {
  alive: { left: 'caution', right: 'attack' },
  downed: { left: 'help', right: 'abandon' },
} as const;

/** 좌/우 휠 칸에 그릴 한국어 라벨 (핑 홀드 휠). */
export const PING_HOLD_LABEL_KO = {
  caution: '여기 조심해', attack: '저쪽으로 가자', help: '살려줘', abandon: '나를 버려',
} as const;
