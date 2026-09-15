/**
 * src/gadgets/parts/Thumper.ts — **진동 장치(썸퍼)는 언제 두드리고, 언제 부르고, 언제 부서지는가** (2026-09-15, 땅굴벌레).
 *
 * - **타격은 와이어가 없다.** 모든 클라이언트가 자기 복제본의 `age` 에서 센다 (`floor(age / THUMPER_INTERVAL_S)`) — 호스트는
 *   `DeployableWire.age` 로 설치 뒤 흐른 시간을 실어 보내므로 늦은 합류자도 같은 박자다. 타격마다 분진 링 · `thumper_thump` ·
 *   `THUMPER_SHAKE_RADIUS` 안의 로컬 플레이어에게 `camera:shake` (가까울수록 세다).
 * - **부름은 호스트만** 낸다: `THUMPER_STRIKES` 번째 타격에 `sandworm:summon {position, source:'thumper'}` 를 **한 번**
 *   (`Deployable.summoned`). 이미 벌레가 나온 레이드에서는 디렉터가 무시하고, 장치는 그 뒤로도 영원히 두드린다 (사용자 결정).
 * - **분출이 부순다**: `sandworm:erupted {position, radius}` 를 받은 권위가 그 반경 안의 진동 장치를 `remove(destroyed)` 한다 —
 *   복제본은 평소의 `gad remove` 로 같이 부서진다. 회수는 없다 (`GadgetDef.recoverTime` 0).
 */
import type * as THREE from 'three';
import { THUMPER_GROUND_R, THUMPER_INTERVAL_S, THUMPER_SHAKE, THUMPER_SHAKE_RADIUS, THUMPER_STRIKES } from '@/shared';
import type { Deployable } from '../Deployable';
import type { GadgetSystem } from '../GadgetSystem';

/* ── 표현 전용 값 (게임플레이 수치 아님 — 수치는 `THUMPER_*`) ─────────────────────── */
/** 타격 분진 링의 색 · 수명(s). */
const DUST_COLOR = '#c9b48a';
const DUST_LIFE = 0.5;
/** 타격 흔들림의 길이(s) — 세기는 `THUMPER_SHAKE`. */
const SHAKE_S = 0.25;
const THUMP_VOLUME = 0.9;
/** 분출로 부서질 때의 작은 파편 링. */
const BREAK_COLOR = '#ffb14a';
const BREAK_RADIUS = 2.5;

/** 이번 주기의 진행도 0..1 (0 = 방금 내리쳤다). `GadgetVisuals` 가 망치 높이로 그린다. */
export function cyclePhase(d: Deployable): number {
  const k = d.age / THUMPER_INTERVAL_S;
  return k - Math.floor(k);
}

/**
 * 매 프레임 (모든 클라이언트, `Simulate.animate` 에서): 망치 위상을 visual 에 넘기고, `age` 가 다음 타격 시각을 넘었으면 타격한다.
 * `age` 는 `GadgetSystem.update` 가 dt > 0 일 때만 올리므로 일시정지 중에는 두드리지 않는다.
 */
export function tick(sys: GadgetSystem, d: Deployable, dt: number): void {
  d.visual.phase = cyclePhase(d);
  if (dt <= 0 || d.removing) return;
  const due = Math.floor(d.age / THUMPER_INTERVAL_S);
  while (d.strikes < due) {
    d.strikes++;
    strike(sys, d, d.strikes);
  }
}

/** 타격 하나: FX 는 모두, 부름은 권위가 `THUMPER_STRIKES` 번째에 한 번. */
function strike(sys: GadgetSystem, d: Deployable, n: number): void {
  const ctx = sys.ctx;
  sys.visuals.pulse(d.position, DUST_COLOR, 0.25, THUMPER_GROUND_R, DUST_LIFE);
  ctx.bus.emit('audio:play', { id: 'thumper_thump', position: d.position, volume: THUMP_VOLUME });
  const p = ctx.player;
  if (p && !p.isDead) {
    const k = 1 - p.position.distanceTo(d.position) / THUMPER_SHAKE_RADIUS;
    if (k > 0) ctx.bus.emit('camera:shake', { intensity: THUMPER_SHAKE * k, duration: SHAKE_S });
  }
  if (n === THUMPER_STRIKES && ctx.isAuthority && !d.summoned) {
    d.summoned = true;
    ctx.bus.emit('sandworm:summon', { position: d.position.clone(), source: 'thumper' });
  }
}

/** `sandworm:erupted` (권위만): 분출 반경 안의 진동 장치를 부순다 — 복제본은 호스트의 `gad remove {destroyed}` 로 따라온다. */
export function onErupted(sys: GadgetSystem, position: THREE.Vector3, radius: number): void {
  if (!sys.ctx.isAuthority) return;
  const r2 = radius * radius;
  for (let i = sys.deployables.length - 1; i >= 0; i--) {
    const d = sys.deployables[i];
    if (d.removing || d.kind !== 'thumper') continue;
    const dx = d.position.x - position.x, dz = d.position.z - position.z;
    if (dx * dx + dz * dz > r2) continue;
    sys.visuals.pulse(d.position, BREAK_COLOR, 0.4, BREAK_RADIUS, 0.45);
    sys.remove(d, 'destroyed');
  }
}
