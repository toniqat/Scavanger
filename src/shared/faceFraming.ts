/* ────────────────────────────────────────────────────────────────────────────
 * 얼굴 초상 프레이밍 (2026-09-15, 터미널 매칭 탭 — docs/DECISIONS.md 「2026-09-15 — 분대 · 도킹 매칭」).
 *
 * 같은 얼굴이 두 곳에 그려진다 — 캐릭터 생성 확정 팝업의 정지 이미지(`ui/menus/SoldierPreview.snapshotFace`)와
 * 함선 터미널 매칭 탭의 정사각 초상(`player/FaceSnapshot`, `PlayerRef.snapshotFace`). 두 곳이 숫자를 각자 들고
 * 있으면 한쪽만 고쳐 같은 캐릭터가 두 화면에서 다른 얼굴이 된다 (「같은 것을 두 폴더가 쓰면 shared 로 뽑는다」).
 * 연출 기하 · 조명이지 밸런스 수치가 아니므로 csv 가 아니라 여기 둔다. 런타임 import 가 없다 (three 도 없다).
 *
 * 포즈를 잡고 카메라를 겨누는 **절차**는 `player/FaceSnapshot` 의 `poseFaceModel` · `aimFaceCamera` 하나이고
 * 두 렌더러가 그것을 부른다 — 여기에는 그 절차가 읽는 값만 있다.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 몸의 yaw. 모델의 정면은 −Z 이고 yaw 만큼 돌면 정면이 `(−sin yaw, 0, −cos yaw)` 가 된다 — π 면 카메라(+Z)를 똑바로
 * 보고, π 에서 **덜** 돌수록 화면 왼쪽(−X)으로 고개가 간다. 0.7 rad ≈ 40° = 카메라 쪽 왼쪽 사선.
 */
export const FACE_SNAPSHOT_YAW = Math.PI - 0.7;
/** 얼굴 카메라의 세로 FOV (도). */
export const FACE_SNAPSHOT_FOV = 24;
/** 이미지의 **짧은 변**이 담을 폭 (m) — 헬멧 + 목 + 어깨 윗선. */
export const FACE_SNAPSHOT_SPAN = 0.62;
/** 바라보는 점 — `SoldierModel.headPivot`(목 밑동)에서 헬멧 가운데까지 (m). */
export const FACE_SNAPSHOT_LOOK_UP = 0.15;
/** 카메라를 눈높이보다 이만큼 올린다 (m) — 살짝 내려다보는 초상. */
export const FACE_SNAPSHOT_CAM_UP = 0.04;
/** 카메라 near / far (m). */
export const FACE_SNAPSHOT_NEAR = 0.05;
export const FACE_SNAPSHOT_FAR = 20;
/**
 * 포즈 고정: 숨쉬기 위상(`SoldierModel.update` 의 time)을 이 값에 묶고 관절 감쇠가 목표에 닿을 만큼 몇 걸음 돌린다.
 * `update(dt <= 0)` 은 서 있는 자세를 **건드리지 않고** 돌아오므로, 막 지은 모델(`resetPose` = 관절 0)을 한 번도
 * 굴리지 않고 찍으면 차렷이 아니라 뼈대 기본각이 찍힌다.
 */
export const FACE_SNAPSHOT_TIME = 0;
export const FACE_SNAPSHOT_SETTLE_STEPS = 12;
export const FACE_SNAPSHOT_SETTLE_DT = 0.1;

/** 조명 — 키 + 림 + 반구광 (캐릭터 생성 미리보기의 턴테이블도 같은 조명이다). */
export const FACE_LIGHT_KEY = { color: 0xfff3dd, intensity: 2.3, x: 2.6, y: 3.4, z: 3.4 } as const;
export const FACE_LIGHT_RIM = { color: 0x9fc4ff, intensity: 1.35, x: -3.0, y: 2.0, z: -2.6 } as const;
export const FACE_LIGHT_HEMI = { sky: 0xbcd4ff, ground: 0x2b2f38, intensity: 0.95 } as const;
/** 톤매핑 노출 (ACES Filmic). */
export const FACE_TONE_EXPOSURE = 1.0;

/** `PlayerRef.snapshotFace` 의 기본 한 변 (px) 과 허용 범위. */
export const FACE_SNAPSHOT_SIZE = 256;
export const FACE_SNAPSHOT_SIZE_MIN = 48;
export const FACE_SNAPSHOT_SIZE_MAX = 512;
/** 색 · 크기별 data URL 캐시 상한 (넘으면 가장 오래된 것부터 버린다). */
export const FACE_SNAPSHOT_CACHE_MAX = 16;
/** 마지막 스냅숏 뒤 이만큼 아무도 부르지 않으면 오프스크린 렌더러(GL 컨텍스트)를 놓는다 (ms). */
export const FACE_SNAPSHOT_IDLE_DISPOSE_MS = 4000;

/**
 * 짧은 변이 `FACE_SNAPSHOT_SPAN` 을 담는 카메라 거리. `aspect` = 가로 / 세로 — 가로가 짧으면(세로로 긴 캔버스) 가로
 * 시야각으로 줄여 잰다. 이미지를 정사각형으로 자르는 쪽(`object-fit: cover`)이 같은 얼굴을 보게 하는 식이다.
 */
export function faceCameraDistance(aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const tanHalf = Math.tan(((FACE_SNAPSHOT_FOV * Math.PI) / 180) / 2) * Math.min(1, a);
  return (FACE_SNAPSHOT_SPAN / 2) / Math.max(1e-3, tanHalf);
}
