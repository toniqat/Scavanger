/**
 * src/gadgets/parts/Mount.ts — **드론 위에 올라탄 설치물은 언제까지, 어떻게 드론을 따라가나?** (2026-09-11)
 *
 * `Deployable.mount` 가 드론 id 를 들고 있는 동안 위치는 매 프레임 `DroneRef.getMountPoint` 다. 드론 위치는 모든
 * 클라이언트에 복제본이 이미 있으므로 **각자 로컬에서 따라간다** — 위치 메시지는 없다.
 *
 * 드론이 사라지면 탑재물은 그 자리 아래 표면으로 떨어져 **바닥 설치물로 남는다** (`mount = null`):
 *  - 모두가 `drone:removed` 를 보고 로컬에서 떨어뜨린다 (즉시 반응).
 *  - 호스트는 거기에 더해 **같은 id 로 `gad spawn` 을 다시 방송**한다 (`mount` 없음). 계약에 위치 갱신 메시지가
 *    없어서 고른 방법이고, 받는 쪽(`Wire` 의 spawn)은 이미 있는 id 면 새로 만들지 않고 위치 · yaw · hp · 무장 ·
 *    mount 만 덮어쓴다 — 복제본의 드론 보간 지연 때문에 어긋난 착지 자리가 호스트 것으로 맞춰진다.
 *  - 비호스트는 `getDrone` 이 null 이어도 **그것만으로는 떼지 않는다** — 늦게 합류하면 `gad sync` 가 `drone sync`
 *    보다 먼저 올 수 있어서, 아직 모르는 드론을 "사라졌다" 로 읽으면 멀쩡한 탑재물이 땅에 떨어진다.
 *
 * 드론 위 지뢰의 적 전용 감지는 원격 지뢰 담당(`Simulate`)의 몫이다 — 여기는 `mount` 를 정확히 유지만 한다.
 */
import type { DeployableWire, DroneRef, GameContext } from '@/shared';
import type { Deployable } from '../Deployable';
import type { GadgetSystem } from '../GadgetSystem';

/**
 * `DroneRef.mountedDeployableId` 는 계약상 readonly 이고 "gadgets 가 설정한다" 고 적혀 있다. 드론 구현이 쓰기 가능한
 * 필드로 두면 여기서 채우고, getter 로만 두면(스스로 계산하면) 대입이 조용히 실패한다.
 */
function setDroneMountId(drone: DroneRef | null | undefined, id: string | null): void {
  if (!drone) return;
  try { (drone as { mountedDeployableId: string | null }).mountedDeployableId = id; } catch { /* getter-only */ }
}

/** 스폰 직후: 드론 위에 올린다. 드론을 아직 모르면 id 만 들고 기다린다 (위치는 요청 자리 그대로). */
export function attach(sys: GadgetSystem, d: Deployable, droneId: string): void {
  d.mount = droneId;
  const drone = sys.ctx.drones?.getDrone(droneId) ?? null;
  if (!drone) return;
  drone.getMountPoint(d.position);
  setDroneMountId(drone, d.id);
}

/** 제거 · 떼어내기 전에: 드론 쪽 표시를 지운다 (그 드론이 아직 이 설치물을 가리키고 있을 때만). */
export function unmount(sys: GadgetSystem, d: Deployable): void {
  const id = d.mount;
  if (!id) return;
  d.mount = null;
  const drone = sys.ctx.drones?.getDrone(id) ?? null;
  if (drone && drone.mountedDeployableId === d.id) setDroneMountId(drone, null);
}

/** 드론에서 떨어져 그 아래 표면에 선다. 호스트는 같은 id 로 `gad spawn` 을 다시 방송한다. */
export function detach(sys: GadgetSystem, d: Deployable): void {
  if (!d.mount) return;
  unmount(sys, d);
  const world = sys.ctx.world;
  if (world && world.ready) d.position.y = world.getSurfaceY(d.position.x, d.position.z, d.position.y);
  d.visual.root.position.copy(d.position);
  if (sys.ctx.isAuthority) sys.broadcast({ t: 'gad', ev: 'spawn', d: sys.wireOf(d) }, 'others');
}

/** 매 프레임 (배치물 루프 전): 탑재물을 드론 윗면으로 옮긴다. */
export function updateMounts(sys: GadgetSystem, ctx: GameContext): void {
  const list = sys.deployables;
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (!d.mount || d.removing) continue;
    const drone = ctx.drones?.getDrone(d.mount) ?? null;
    if (drone) {
      drone.getMountPoint(d.position);
      d.yaw = drone.yaw;
      if (drone.mountedDeployableId !== d.id) setDroneMountId(drone, d.id);
      continue;
    }
    // 권위자만 "드론이 없다" 를 믿는다 (위 머리 주석)
    if (ctx.isAuthority) detach(sys, d);
  }
}

/** `drone:removed`: 그 드론에 올라탄 것을 전부 떨어뜨린다 (모든 클라이언트). */
export function onDroneRemoved(sys: GadgetSystem, droneId: string): void {
  const list = sys.deployables;
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (d.mount === droneId && !d.removing) detach(sys, d);
  }
}

/**
 * 비호스트: 이미 있는 id 로 `gad spawn` 이 다시 왔다 (호스트가 드론에서 떨어진 탑재물을 재방송) — 새로 만들지 않고
 * 상태만 덮어쓴다.
 */
export function applyWire(sys: GadgetSystem, d: Deployable, w: DeployableWire): void {
  const next = w.mount ?? null;
  if (d.mount && d.mount !== next) unmount(sys, d);
  d.position.set(w.p[0], w.p[1], w.p[2]);
  d.yaw = w.yaw;
  d.hp = w.hp;
  d.armed = w.armed;
  if (next) attach(sys, d, next);
  d.visual.root.position.copy(d.position);
  d.visual.root.rotation.y = d.yaw;
}
