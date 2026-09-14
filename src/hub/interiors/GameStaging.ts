import * as THREE from 'three';
import type { FurniturePose, GameContext, GymMinigame } from '@/shared';
import { yawFromForward } from './GeoBatch';
import { roomBox } from './RoomLayout';
import { CAMERA_WALL_MARGIN, restRig, segmentHits, sitPoseOf, type FootBox, type StagedPiece } from './GymStaging';
import { SIT_SEAT_TOP, TV_GAME_HUD, TV_GAME_SCREEN } from './FurnitureLeisure';

/* ────────────────────────────────────────────────────────────────────────────
 * 비디오게임 연출 (2026-09-13, 서재 시리즈 · 비디오게임 — docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」). `GymStaging` · `CookStaging` 을 본뜬다.
 *
 *   housing:gameSession {active:true}  → 좌석(`seatUid`)의 TV 에 가장 가까운 자리에 `sit` 자세 · TV 화면 쪽 yaw · 어깨 너머 고정 카메라
 *                                         → setFurniturePose (false 면 **그 자리에서** cancelGameSession) · TV 의 게임 화면(`model.tv.overlay`)을 켠다
 *   housing:gameBeat                   → 화면 **속** 표식이 튀고 진행 막대가 오른다 (2026-09-14, 사용자 결정: 키를 누를 때마다 화면이 번쩍이지 않는다)
 *   housing:gameSession {active:false} → 자세를 푼다 (reason `caller`) · 게임 화면을 숨기고 재질을 원래 색으로
 *   player:furniturePoseEnded (sit, 우리가 푼 것이 아니면) → cancelGameSession (자세 없이 미니게임만 남지 않게)
 *
 * 화면 연출은 공용 재질 `TV_GAME_SCREEN` · `TV_GAME_HUD` 의 **발광 색(uniform)** 만 바꾼다 — 재질을 갈아 끼우지도, `needsUpdate` 를
 * 세우지도 않으므로 셰이더 컴파일이 없고 점광원도 없다. 로컬 세션은 한 번에 하나라 공용 재질로 충분하다. 조각은 늘 uid 로 다시 찾는다
 * (방이 다시 지어지면 그룹이 바뀐다) — 재빌드된 TV 는 `BuildExtra.gameActive` 로 게임 화면을 켠 채 지어진다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 표식이 튀는 반응 시간 (초). */
const KICK_S = 0.25;
/**
 * 화면 발광 — 기본 세기 · 느린 맥동 폭. HUD 기본 세기.
 * **2026-09-14 (사용자 결정): 키를 누를 때마다 화면이 번쩍이지 않는다.** 판정마다 `emissive` · `emissiveIntensity` 를 판정 색으로
 * 튀기던 것(`flash` · `SCREEN_FLASH` · `HUD_FLASH`)을 걷어냈다 — 화면은 디스크 테마 색 + 잔잔한 `SCREEN_PULSE` 맥동뿐이고,
 * 판정 반응은 화면 **속 표식**(`kick`)과 진행 막대가 말한다. 여긴 uniform 만 바꾸는 코드라는 성질은 그대로다 (점광원 0개).
 */
const SCREEN_BASE = 1.15;
const SCREEN_PULSE = 0.18;
const HUD_BASE = 1.5;
const HUD_WHITE = new THREE.Color(0xdfefff);
/** 디스크 색을 모를 때의 화면 색. */
const DEFAULT_THEME = '#3aa8ff';
/** 앉는 방향을 TV 화면 쪽으로 틀 수 있는 최대 (rad) — 좌석이 TV 와 옆으로 어긋나 있어도 몸이 좌석 밖을 보지 않게. */
const YAW_CLAMP = 0.6;

/**
 * 어깨 너머 카메라 후보 (좌석 anchor 기준, 앞 = anchor → TV 화면): 옆 (+1 = **오른 어깨**) × 옆 거리 × 뒤 거리 × 바닥에서의 높이.
 * 오른 어깨 · 가깝게 · 뒤로 · 낮게를 좋아하고, 방 벽 · 같은 방 가구(TV 제외)에 들어가거나 시선이 가리면 크게 깎는다. 쇼파가 벽에 붙어
 * 뒤로 물러날 수 없으면 옆(뒤 0.3 m)으로 빠진다.
 */
const CAM_SIDES = [1, -1] as const;
const CAM_LATERAL = [0.45, 0.8, 1.25] as const;
const CAM_BACK = [1.1, 0.7, 0.3] as const;
const CAM_HEIGHT = [1.55, 1.85] as const;
/** 좌판 위 머리 높이 (`FURN_EYE.sit` 0.85) · 화면을 가리는지 보는 머리 · 어깨 상자 (좌판 기준). */
const HEAD_UP = 0.85;
const BODY = { half: 0.24, minUp: 0.5, maxUp: 1.0 } as const;

const _p = new THREE.Vector3();

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const contains = (b: FootBox, p: THREE.Vector3): boolean =>
  p.x >= b.minX - 0.02 && p.x <= b.maxX + 0.02 && p.y >= b.minY - 0.02 && p.y <= b.maxY + 0.02 && p.z >= b.minZ - 0.02 && p.z <= b.maxZ + 0.02;

/** TV 화면 앞면 한가운데 (월드). TV 가 아니면 null. */
export function tvScreenWorld(tv: StagedPiece): THREE.Vector3 | null {
  const rig = tv.model.tv;
  if (!rig) return null;
  tv.model.group.updateWorldMatrix(true, false);
  return tv.model.group.localToWorld(rig.screen.clone());
}

/**
 * 게임 화면 카메라. `blockers` = 좌석과 같은 방의 다른 가구 상자 — **TV 화면을 품은 상자(= TV 자신)는 여기서 뺀다** (화면을 보는 선이 TV 몸체 안에서
 * 끝나므로 늘 걸린다). 세션 시작에 한 번 도는 코드라 할당은 신경 쓰지 않는다.
 */
export function gameCameraOf(seat: StagedPiece, anchor: THREE.Vector3, screen: THREE.Vector3, blockers: readonly FootBox[]): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  let fx = screen.x - anchor.x, fz = screen.z - anchor.z;
  const len = Math.hypot(fx, fz);
  if (len < 1e-3) { fx = 0; fz = -1; } else { fx /= len; fz /= len; }
  const rx = -fz, rz = fx;                                                   // 오른쪽 (앞 (0, −1) → 오른쪽 (+1, 0))
  const floorY = anchor.y - SIT_SEAT_TOP;
  const head = new THREE.Vector3(anchor.x, anchor.y + HEAD_UP, anchor.z);
  const lookAt = head.clone().lerp(screen, 0.7);
  const body: FootBox = {
    minX: anchor.x - BODY.half, maxX: anchor.x + BODY.half, minY: anchor.y + BODY.minUp, maxY: anchor.y + BODY.maxUp,
    minZ: anchor.z - BODY.half, maxZ: anchor.z + BODY.half,
  };
  const others = blockers.filter((b) => !contains(b, screen));
  const box = roomBox(seat.item.room);
  let best: THREE.Vector3 | null = null, bestCost = Infinity;
  for (const side of CAM_SIDES) for (const lat of CAM_LATERAL) for (const back of CAM_BACK) for (const hgt of CAM_HEIGHT) {
    _p.set(anchor.x - fx * back + rx * side * lat, floorY + hgt, anchor.z - fz * back + rz * side * lat);
    let cost = (side < 0 ? 0.35 : 0) + (lat - CAM_LATERAL[0]) * 0.35 + (CAM_BACK[0] - back) * 0.3 + (hgt - CAM_HEIGHT[0]) * 0.5;
    if (box) {
      const minX = box.minX + CAMERA_WALL_MARGIN, maxX = box.maxX - CAMERA_WALL_MARGIN;
      const minZ = box.minZ + CAMERA_WALL_MARGIN, maxZ = box.maxZ - CAMERA_WALL_MARGIN;
      const over = Math.max(0, minX - _p.x, _p.x - maxX) + Math.max(0, minZ - _p.z, _p.z - maxZ);
      if (over > 0) {
        cost += 4 + over * 4;
        _p.x = THREE.MathUtils.clamp(_p.x, minX, maxX);
        _p.z = THREE.MathUtils.clamp(_p.z, minZ, maxZ);
      }
    }
    if (segmentHits(_p, screen, body)) cost += 2;
    for (const b of others) {
      if (contains(b, _p)) cost += 6;
      if (segmentHits(_p, screen, b)) cost += 3;
      if (segmentHits(_p, head, b)) cost += 1.5;
    }
    if (cost < bestCost) { bestCost = cost; best = (best ?? new THREE.Vector3()).copy(_p); }
  }
  return { position: best ?? head.clone().add(new THREE.Vector3(-fx * 1.1, 0.7, -fz * 1.1)), lookAt };
}

/**
 * 게임 세션 자세 한 벌 — 좌석 중 TV 화면에 가장 가까운 자리 · 화면 쪽 yaw(좌석 방향에서 ±`YAW_CLAMP`) · 어깨 너머 고정 카메라 · E 로 안 풀림.
 * 좌석이 앉는 가구가 아니거나 TV 에 게임 화면 rig 가 없으면 null.
 */
export function gamePoseOf(seat: StagedPiece, tv: StagedPiece, blockers: readonly FootBox[] = []): FurniturePose | null {
  const screen = tvScreenWorld(tv);
  if (!screen) return null;
  const base = sitPoseOf(seat, screen);
  if (!base) return null;
  const dx = screen.x - base.anchor.x, dz = screen.z - base.anchor.z;
  let yaw = base.yaw;
  if (dx * dx + dz * dz > 1e-6) yaw = base.yaw + THREE.MathUtils.clamp(wrapAngle(yawFromForward(dx, dz) - base.yaw), -YAW_CLAMP, YAW_CLAMP);
  return {
    kind: 'sit', anchor: base.anchor, yaw, camera: gameCameraOf(seat, base.anchor, screen, blockers),
    releaseOnInteract: false, furnitureUid: seat.item.uid,
  };
}

/** 게임 세션 연출. `FurnitureLayer` 가 자기 함선(방문 중이 아닌)일 때만 만든다. */
export class GameStaging {
  /** 연출 중인 TV · 좌석 uid (세션이 없으면 null). */
  tvUid: string | null = null;
  seatUid: string | null = null;
  private minigame: GymMinigame = 'press';
  /** 우리가 건 자세가 지금 걸려 있다. */
  private held = false;
  private releasing = false;
  private readonly unsubs: Array<() => void> = [];
  private clock = 0;
  private kick = 0;
  private progress = 0;
  private shownProgress = 0;
  private side = 1;
  private readonly theme = new THREE.Color(DEFAULT_THEME);
  private readonly screenBase = { color: TV_GAME_SCREEN.emissive.clone(), intensity: TV_GAME_SCREEN.emissiveIntensity };
  private readonly hudBase = { color: TV_GAME_HUD.emissive.clone(), intensity: TV_GAME_HUD.emissiveIntensity };

  /** `find` = uid 로 지금의 조각, `blockers` = 그 조각과 같은 방의 다른 가구 상자 (카메라 가림). */
  constructor(private readonly ctx: GameContext, private readonly find: (uid: string) => StagedPiece | null, private readonly blockers: (uid: string) => readonly FootBox[] = () => []) {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:gameSession', (e) => this.onSession(e.tvUid, e.seatUid, e.discDefId, e.minigame, e.active)),
      b.on('housing:gameBeat', (e) => this.onBeat(e.tvUid, e.quality, e.index, e.total)),
      b.on('player:furniturePoseEnded', (e) => {
        // 게임 자세가 우리 손을 거치지 않고 풀렸다 (페이즈 변경 · 스폰 · hub:left 의 reset) → 미니게임도 거둔다
        if (!this.tvUid || !this.held || this.releasing || e.kind !== 'sit') return;
        this.held = false;
        this.stop(false);
        this.cancelHousing();
      }),
    );
  }

  /** 이 TV 로 게임 중인가 (`BuildExtra.gameActive`). */
  activeOn(tvUid: string): boolean {
    return this.tvUid === tvUid;
  }

  /**
   * 디버그 · 스모크: 연출 중인 세션 · 판정 반응(`kick`) · 진행 막대 · 게임 화면이 보이는가 · 화면 발광 세기. 세션이 없으면 null.
   * 2026-09-14: 옛 `flash`(화면 번쩍임)는 없어졌다 — 판정 반응은 `kick` 이 말한다.
   */
  get stage(): { tvUid: string; seatUid: string | null; minigame: GymMinigame; held: boolean; kick: number; progress: number; overlay: boolean; screenIntensity: number } | null {
    if (!this.tvUid) return null;
    const rig = this.find(this.tvUid)?.model.tv;
    return {
      tvUid: this.tvUid, seatUid: this.seatUid, minigame: this.minigame, held: this.held, kick: this.kick, progress: this.progress,
      overlay: rig?.overlay.visible === true, screenIntensity: TV_GAME_SCREEN.emissiveIntensity,
    };
  }

  private onSession(tvUid: string, seatUid: string, discDefId: string, minigame: GymMinigame, active: boolean): void {
    if (!active) { if (this.tvUid === tvUid) this.stop(true); return; }
    const same = this.tvUid === tvUid && this.seatUid === seatUid;
    if (this.tvUid && !same) this.stop(true);
    const tv = this.find(tvUid), seat = this.find(seatUid);
    if (!tv?.model.tv || !seat || seat.model.rig?.pose !== 'sit') { this.cancelHousing(); return; }
    if (!same) {
      this.tvUid = tvUid; this.seatUid = seatUid; this.minigame = minigame;
      this.clock = 0; this.kick = 0; this.progress = 0; this.shownProgress = 0; this.side = 1;
      this.theme.set(this.discColor(discDefId));
    }
    tv.model.tv.overlay.visible = true;
    const p = this.ctx.player;
    if (!p || typeof p.setFurniturePose !== 'function') return;   // player 가 아직 자세를 모른다 — 미니게임은 그대로 둔다
    if (same && this.held && p.furniturePose === 'sit') return;    // 같은 세션을 다시 알렸다 — 다시 걸면 풀 때 돌아갈 자리가 좌석이 된다
    const pose = gamePoseOf(seat, tv, this.blockers(seatUid));
    let ok = false;
    // 우리 호출 안에서 나오는 자세 끝 알림(앉아 있던 흔들의자 · 이전 자세)은 우리 것이다
    this.releasing = true;
    try { ok = pose !== null && p.setFurniturePose(pose); } catch (err) { console.warn('[hub] setFurniturePose(game) failed', err); } finally { this.releasing = false; }
    if (!ok) { this.stop(false); this.cancelHousing(); return; }
    this.held = true;
  }

  /** 판정 하나 — **화면을 번쩍이지 않는다** (2026-09-14). 화면 속 표식이 튀고 진행 막대가 오른다. */
  private onBeat(tvUid: string, _quality: 'perfect' | 'good' | 'miss', index: number, total: number): void {
    if (tvUid !== this.tvUid) return;
    this.kick = 1;
    this.progress = total > 0 ? THREE.MathUtils.clamp((index + 1) / total, 0, 1) : 0;
    this.side = -this.side;
  }

  /** 매 프레임 (`FurnitureLayer.update`). 프레임당 할당 없음. */
  update(dt: number): void {
    this.clock += dt;
    if (!this.tvUid) return;
    const tv = this.find(this.tvUid);
    const seat = this.seatUid ? this.find(this.seatUid) : null;
    const rig = tv?.model.tv;
    if (!rig || !seat) { this.stop(true); this.cancelHousing(); return; }   // 세션 도중 TV · 좌석이 사라졌다
    rig.overlay.visible = true;
    this.kick = Math.max(0, this.kick - dt / KICK_S);
    // 화면은 늘 같은 밝기다 — 디스크 테마 색 + 잔잔한 맥동만 (2026-09-14, 사용자 결정)
    TV_GAME_SCREEN.emissive.copy(this.theme);
    TV_GAME_SCREEN.emissiveIntensity = SCREEN_BASE + SCREEN_PULSE * Math.sin(this.clock * 2.4);
    TV_GAME_HUD.emissive.copy(HUD_WHITE);
    TV_GAME_HUD.emissiveIntensity = HUD_BASE;
    // 화면 속 표식 — 미니게임마다 다르게 (벤치프레스 = 좌우로 오가는 커서 · 호흡 = 부풀었다 줄어드는 막대 · 사이클 = 박자마다 좌우로 건너뛴다)
    const half = rig.screenW * 0.4, m = rig.marker;
    if (this.minigame === 'press') {
      m.position.x = Math.sin(this.clock * 3.2) * half * 0.9;
      m.scale.y = 1 + this.kick * 0.25;
    } else if (this.minigame === 'breath') {
      m.position.x = 0;
      m.scale.y = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.clock * 1.6)) + this.kick * 0.3;
    } else {
      const target = this.side * half * 0.55;
      m.position.x += (target - m.position.x) * Math.min(1, dt * 14);
      m.scale.y = 1 + this.kick * 0.25;
    }
    this.shownProgress += (this.progress - this.shownProgress) * Math.min(1, dt * 8);
    rig.progress.scale.x = Math.max(0.001, this.shownProgress);
  }

  /** 연출을 거둔다: 게임 화면을 숨기고 재질을 원래대로. `release` = 우리가 건 자세도 푼다. */
  private stop(release: boolean): void {
    const tvUid = this.tvUid, seatUid = this.seatUid;
    this.tvUid = null;
    this.seatUid = null;
    const rig = tvUid ? this.find(tvUid)?.model.tv : undefined;
    if (rig) {
      rig.overlay.visible = false;
      rig.marker.position.x = 0;
      rig.marker.scale.y = 1;
      rig.progress.scale.x = 0.001;
    }
    const seatRig = seatUid ? this.find(seatUid)?.model.rig : undefined;
    if (seatRig) restRig(seatRig);
    TV_GAME_SCREEN.emissive.copy(this.screenBase.color);
    TV_GAME_SCREEN.emissiveIntensity = this.screenBase.intensity;
    TV_GAME_HUD.emissive.copy(this.hudBase.color);
    TV_GAME_HUD.emissiveIntensity = this.hudBase.intensity;
    const wasHeld = this.held;
    this.held = false;
    if (!release || !wasHeld) return;
    const p = this.ctx.player;
    if (!p || typeof p.setFurniturePose !== 'function' || p.furniturePose !== 'sit') return;
    this.releasing = true;
    try { p.setFurniturePose(null); } catch { /* player mid-build */ } finally { this.releasing = false; }
  }

  /** 게임 디스크의 테마 색 (`GameDiscDef.color`), 모르면 기본 색. */
  private discColor(defId: string): string {
    try {
      const c = this.ctx.loot?.getItemDef(defId)?.gameDisc?.color;
      return typeof c === 'string' && c ? c : DEFAULT_THEME;
    } catch { return DEFAULT_THEME; }
  }

  private cancelHousing(): void {
    const h = this.ctx.housing;
    if (h && typeof h.cancelGameSession === 'function') {
      try { h.cancelGameSession(); } catch (err) { console.warn('[hub] cancelGameSession failed', err); }
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.tvUid) { this.stop(true); this.cancelHousing(); }
  }
}
