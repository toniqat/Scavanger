/**
 * src/housing/parts/Music.ts — **음악 재생 상태** (2026-09-14 사용자 결정).
 *
 * **소리는 나지 않는다.** 축음기 · 주크박스 · 턴테이블(`FurnitureInteraction 'record_player'`)을 E 로 켜면 그 함선의
 * 레코드랙에 꽂힌 레코드가 재생 목록이 되고, 화면 구석의 재생 창(`ui/hud/MusicPlayer`)이 제목 · 아티스트 · 볼륨을 띄운다.
 * 오디오 노드가 하나도 없으므로 상태는 **순수 데이터**이고 「곡이 끝났다」는 `startedAt + lengthS × 1000` 을 시각과
 * 비교한 결과일 뿐이다 — 그래서 `tickMusic` 은 `update()` 에서 **시각만** 본다.
 *
 * 규칙:
 *  - **재생 중인 플레이어는 늘 하나다.** 여러 대를 켜 두면 `ShipState.toggled` 의 **마지막** 레코드 플레이어가 이긴다
 *    (그 목록은 켠 순서대로 push 되므로 「가장 마지막에 켠 것」과 같다). 그것을 끄면 그 전에 켜 둔 것으로 자연히 돌아간다.
 *  - 재생 목록은 **함선의 레코드랙 전부**(여러 대여도 한 목록)이고, 보관함 배치 순서 → 칸 번호 순이다. 같은 def 는 한 번만.
 *  - `mode`: `'playlist'` 는 끝까지 돌고 처음으로, `'repeat'` 는 한 곡 무한 반복. 재생 창이 `HousingRef` 의 조작 계약
 *    (`musicNext` · `musicPrev` · `setMusicMode` · `musicStop`, 2026-09-14 추가)으로 바꾼다.
 *  - **함선 전용**이다. 레이드 · 훈련장 · 타이틀에서는 `MUSIC_PLAYER_OFF` 이고 `tick` 도 그 자리에서 돌아간다.
 *  - 상태가 **정말로** 바뀔 때만 `housing:musicChanged` 가 난다 (`sameState` 서명 비교) — 매 프레임 emit 하지 않는다.
 *
 * 이 파일은 `parts/Library.ts` 를 고치지 않는다 — 꽂힌 목록은 이미 있는 공개 질의(`getPlaced` · `getShelfMedium` ·
 * `shelfItemsOf` · `toggledUids`)로만 읽는다.
 */
import type { MusicMode, MusicPlayerState, MusicTrack } from '@/shared';
import { LIBRARY_SERIES_MAP, MUSIC_MODES, MUSIC_PLAYER_OFF, musicArtistOf, musicLengthOf, resolveItemAlias } from '@/shared';
import type { HousingSystem } from '../HousingSystem';

/** 레코드 아이템 id 접두사 (`record_<시리즈id>` — `items/ItemDefs.libraryItemIdFor` 가 만드는 모양). */
const RECORD_PREFIX = 'record_';

/** 시스템 필드의 초기값 (클래스 필드에서 부르므로 함수로 둔다 — 상수 객체를 공유하지 않는다는 뜻은 아니다). */
export function initialMusicState(): MusicPlayerState { return MUSIC_PLAYER_OFF; }

/* ── 질의 ────────────────────────────────────────────────────────────────── */

/** 지금 재생 중인 상태 (꺼져 있으면 `MUSIC_PLAYER_OFF`). */
export function musicState(sys: HousingSystem): MusicPlayerState { return sys.musicState; }

/** 켜져 있는 레코드 플레이어 중 **가장 마지막에 켠** 것. 하나도 없으면 null. */
function activePlayerUid(sys: HousingSystem): string | null {
  const list = sys.toggledUids();
  for (let i = list.length - 1; i >= 0; i--) {
    const uid = list[i];
    const item = sys.getPlacedByUid(uid);
    const def = item ? sys.getFurnitureDef(item.defId) : undefined;
    if (def && def.interaction === 'record_player') return uid;
  }
  return null;
}

/** 레코드 아이템 id → 한 곡. 레코드가 아니면 null (옛 id 는 `resolveItemAlias` 로 푼다). */
function trackOf(defId: string): MusicTrack | null {
  const id = resolveItemAlias(defId);
  if (!id.startsWith(RECORD_PREFIX)) return null;
  const series = LIBRARY_SERIES_MAP.get(id.slice(RECORD_PREFIX.length));
  if (!series || series.medium !== 'record') return null;
  return { defId: id, title: series.name, artist: musicArtistOf(series.id), lengthS: musicLengthOf(series.id) };
}

/** 함선의 레코드랙에 꽂힌 레코드 전부 — 보관함 배치 순서 → 칸 번호 순, 같은 def 는 한 번만. */
function buildPlaylist(sys: HousingSystem): MusicTrack[] {
  const out: MusicTrack[] = [];
  const seen = new Set<string>();
  for (const item of sys.getPlaced()) {
    if (sys.getShelfMedium(item.uid) !== 'record') continue;
    const entries = sys.shelfItemsOf(item.uid).slice().sort((a, b) => a.slot - b.slot);
    for (const e of entries) {
      const t = trackOf(e.defId);
      if (!t || seen.has(t.defId)) continue;
      seen.add(t.defId);
      out.push(t);
    }
  }
  return out;
}

/* ── 상태 ────────────────────────────────────────────────────────────────── */

function sameTrack(a: MusicTrack | null, b: MusicTrack | null): boolean {
  return a === b || (!!a && !!b && a.defId === b.defId);
}

function sameState(a: MusicPlayerState, b: MusicPlayerState): boolean {
  if (a === b) return true;
  if (a.furnitureUid !== b.furnitureUid || a.index !== b.index || a.mode !== b.mode || a.startedAt !== b.startedAt) return false;
  if (!sameTrack(a.track, b.track)) return false;
  if (a.playlist.length !== b.playlist.length) return false;
  for (let i = 0; i < a.playlist.length; i++) if (a.playlist[i].defId !== b.playlist[i].defId) return false;
  return true;
}

/**
 * 새 상태를 앉히고, 정말 달라졌을 때만 `housing:musicChanged`.
 * `force` 는 **사람이 누른 조작**이 서명 비교에 묻히지 않게 한다 (곡이 한 장뿐인 목록에서 `다음 ▶` 를 눌러
 * 같은 곡이 처음부터 다시 도는 경우 — 같은 밀리초라면 서명까지 같아진다).
 */
function setState(sys: HousingSystem, next: MusicPlayerState, force = false): void {
  if (!force && sameState(sys.musicState, next)) return;
  sys.musicState = next;
  sys.ctx?.bus.emit('housing:musicChanged', { state: next });
}

/** 이 함선에서 음악이 돌 수 있는 상황인가 — 개인 · 공유 함선(레이드 · 훈련장 · 타이틀 제외). */
function inShip(sys: HousingSystem): boolean {
  const ctx = sys.ctx;
  return !!ctx && ctx.isHubPhase() && !ctx.isRaidActive();
}

/**
 * 켜진 플레이어 · 재생 목록을 다시 세운다. 같은 플레이어가 계속 돌고 있고 지금 곡이 목록에 그대로 있으면
 * **`startedAt` 을 지킨다** (레코드 한 장을 더 꽂았다고 듣던 곡이 처음으로 돌아가면 안 된다).
 */
export function refreshMusic(sys: HousingSystem): void {
  const uid = inShip(sys) ? activePlayerUid(sys) : null;
  if (!uid) { setState(sys, MUSIC_PLAYER_OFF); return; }
  const prev = sys.musicState;
  const playlist = buildPlaylist(sys);
  const same = prev.furnitureUid === uid;
  let index = same && prev.track ? playlist.findIndex((t) => t.defId === prev.track?.defId) : -1;
  const keep = index >= 0;
  if (!keep) index = playlist.length > 0 ? 0 : -1;
  const track = index >= 0 ? playlist[index] : null;
  setState(sys, {
    furnitureUid: uid,
    track,
    playlist,
    index,
    mode: same ? prev.mode : 'playlist',
    startedAt: keep ? prev.startedAt : (track ? sys.nowMs() : 0),
  });
}

/** 다음 곡으로 (반복이면 같은 곡을 처음부터). 목록이 비어 있으면 아무 일도 없다. */
function advance(sys: HousingSystem): void {
  const s = sys.musicState;
  if (!s.track || s.playlist.length === 0) return;
  if (s.mode === 'repeat') { setState(sys, { ...s, startedAt: sys.nowMs() }); return; }
  const next = (s.index + 1) % s.playlist.length;
  setState(sys, { ...s, index: next, track: s.playlist[next], startedAt: sys.nowMs() });
}

/**
 * `HousingSystem.update()` 에서 프레임마다 — 꺼져 있으면 비교 한 번으로 돌아간다. 시계가 크게 뛰어도
 * (탭 복귀 · 서버 시계 동기화) `advance` 가 `startedAt` 을 지금으로 다시 잡으므로 한 프레임에 한 곡만 넘어간다.
 */
export function tickMusic(sys: HousingSystem): void {
  const s = sys.musicState;
  if (!s.furnitureUid) return;
  if (!inShip(sys)) { setState(sys, MUSIC_PLAYER_OFF); return; }
  if (!s.track || s.track.lengthS <= 0) return;
  if (sys.nowMs() - s.startedAt < s.track.lengthS * 1000) return;
  advance(sys);
}

/** 재생을 끈다 (미션 시작 · 중단 · 함선을 떠남 · `dispose`). 상태만 끄고 `toggled` 는 건드리지 않는다. */
export function stopMusic(sys: HousingSystem): void { setState(sys, MUSIC_PLAYER_OFF); }

/* ── 조작 (`HousingRef` 추가 계약, 2026-09-14) ─────────────────────────────
 * 재생 창의 버튼 넷이 여기로 들어온다. 넷 다 성공하면 **곧바로** `housing:musicChanged` 가 난다
 * (`musicStop` 은 가구 토글이 내는 `housing:furnitureToggled` → `refreshMusic` 을 거친다). */

/** `dir` 만큼 곡을 옮긴다 — `'repeat'` 이어도 **사람이 누르면 넘어간다**(자동 진행만 반복이다). */
function step(sys: HousingSystem, dir: 1 | -1): boolean {
  const s = sys.musicState;
  const n = s.playlist.length;
  if (!s.furnitureUid || !s.track || n === 0) return false;
  const next = (((s.index + dir) % n) + n) % n;
  setState(sys, { ...s, index: next, track: s.playlist[next], startedAt: sys.nowMs() }, true);
  return true;
}

export function musicNext(sys: HousingSystem): boolean { return step(sys, 1); }

export function musicPrev(sys: HousingSystem): boolean { return step(sys, -1); }

/** 재생 방식 전환. 재생 중이 아니거나 같은 값이면 false. */
export function setMusicMode(sys: HousingSystem, mode: MusicMode): boolean {
  const s = sys.musicState;
  if (!s.furnitureUid) return false;
  if (!MUSIC_MODES.includes(mode) || s.mode === mode) return false;
  setState(sys, { ...s, mode });
  return true;
}

/**
 * 재생을 멈춘다 — ⚠ **가구의 `toggled` 도 함께 내린다**(상태만 끄면 가구는 켜진 모습으로 남는다).
 * 새 저장 경로를 만들지 않고 **가구 E 토글과 같은 경로**(`Library.toggleFurniture`)를 그대로 탄다 —
 * `ShipState.toggled` · `changed('toggle')` · `housing:furnitureToggled` · `record_off` 소리까지 같다.
 * 그 사건을 `bindMusic` 이 받아 `refreshMusic` 하므로 여기서 상태를 직접 끄지 않는다.
 */
export function musicStop(sys: HousingSystem): boolean {
  const uid = sys.musicState.furnitureUid;
  if (!uid) return false;
  const on = sys.toggleFurniture(uid);
  if (on === null) { stopMusic(sys); return true; }   // 가구가 사라졌다 (회수 · 서버 사본) — 상태만 정리한다
  if (on) sys.toggleFurniture(uid);                   // 있을 수 없는 경우(이미 꺼져 있었다) — 켜 버린 것을 되돌린다
  // 다른 플레이어를 켜 뒀다면 그것이 이어받는다 — 그래도 「이 가구를 껐다」는 성공이다.
  refreshMusic(sys);
  return true;
}

export function bindMusic(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  const refresh = (): void => refreshMusic(sys);
  const stop = (): void => stopMusic(sys);
  return [
    // 켜기 / 끄기 — `parts/Library.toggleFurniture` 가 내는 사실 하나가 재생의 유일한 방아쇠다.
    b.on('housing:furnitureToggled', refresh),
    // 레코드랙 내용 · 보유 보관함이 바뀌었다 (꽂기 · 빼기 · 회수 · 시설 제거 · 서버 사본).
    b.on('housing:libraryChanged', refresh),
    b.on('housing:shelfChanged', refresh),
    b.on('housing:furnitureRecovered', refresh),
    b.on('housing:loaded', refresh),
    b.on('hub:entered', refresh),
    b.on('game:newMission', stop),
    b.on('game:abort', stop),
    b.on('hub:left', stop),
    b.on('game:phaseChanged', ({ phase }) => { if (phase === 'hub') refresh(); else stop(); }),
  ];
}
