/**
 * src/world/rails/parts/Platform.ts — **선로 플랫폼** (데크 · 계단 · 난간 · 컨테이너 · 안내판).
 *
 * `Rails` 에서 떼어낸 메서드 묶음이고 상태는 없다 (2026-09-10 분할).
 * 축 규약은 `rails/model` 그대로다: **로컬 +X = 선로 접선(플랫폼 길이 `halfW`), 로컬 +Z = 옆(깊이 `halfD`)**.
 * `PLATFORM_OFFSET` 이 `halfD + tram.halfW + 0.05` 인 것도 그 규약에서 나온다.
 *
 * **2026-09-10 — 시동 콘솔은 여기 없다.** 전차 시동은 운전실 콘솔(`parts/Tram`)로 옮겼다.
 *
 * **2026-09-10 (두 번째) — 그 자리의 기둥은 「전차 호출」 콘솔이다.** 시동이 차 안으로 들어간 대가로
 * 플랫폼에서 전차를 부를 수단이 사라졌었다 (반대편에 서 있으면 선로 위를 걸어가야 했다). 이 콘솔은
 * **부르기만** 한다 — 실제 출발은 여전히 타서 운전실 콘솔을 눌러야 한다. 등록(`Interactable`)은
 * 상태 기계를 든 `Rails` 가 하고, 여기서는 **보이는 물건**(받침 · 몸통 · 화면 · 버튼 · 발광 띠)과
 * 그 콜라이더를 세운 뒤 **콘솔 자리를 돌려준다**.
 */
import * as THREE from 'three';
import { Layers, PROP_STEP_UP_MAX, RAIL_STAIR_DEPTH, RAIL_STAIR_MAX_RISE, type Random, type RailPlatformDef } from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from '../../build';
import type { ContainerSpec } from '../../structures/parts/Containers';
import { pickTier, type structureRow } from '../../structures/model';
import { DECK, DECK_DARK, STEEL, STEEL_DARK, type RailBuild } from '../model';

/**
 * 플랫폼 한 자리. 데크는 **땅에서 올라오는 덩어리**(밑에 들어갈 일이 없다)이고 데크 윗면은 전차 바닥과
 * 같은 높이다 — 정차하면 틈 없이 걸어서 탄다.
 */
export function buildPlatform(
  ctx: BuildCtx, rng: Random, def: RailPlatformDef,
  row: ReturnType<typeof structureRow>, groundY: number, deckTop: number, yaw: number,
  ax: number, az: number, specs: ContainerSpec[], out: RailBuild,
): THREE.Vector3 {
  const halfW = row ? row.halfW : 7, halfD = row ? row.halfD : 4.5;
  const parts: THREE.BufferGeometry[] = [];
  const { x: cx, z: cz } = def.position;
  const deckH = Math.max(0.4, deckTop - groundY);

  // 데크
  const deck = new THREE.BoxGeometry(halfW * 2, deckH, halfD * 2);
  xform(deck, { x: cx, y: deckTop - deckH / 2, z: cz }, new THREE.Euler(0, -yaw, 0));
  paintGradient(deck, DECK_DARK, DECK, deckTop - deckH, deckTop);
  parts.push(deck);
  ctx.hash.addBox(new THREE.Vector3(cx, deckTop - deckH, cz), halfW, halfD, yaw, deckH, 'platform');

  buildStairs(ctx, rng, parts, cx, cz, yaw, ax, az, halfD, groundY, deckTop);

  // 바깥쪽 난간 · 지붕 기둥 (실루엣만 — 카메라를 막지 않는다)
  for (let i = -1; i <= 1; i += 2) {
    const g = new THREE.BoxGeometry(0.28, 2.6, 0.28);
    const px = cx + ax * (halfD - 0.5) + Math.cos(yaw) * (halfW - 0.8) * i;
    const pz = cz + az * (halfD - 0.5) + Math.sin(yaw) * (halfW - 0.8) * i;
    xform(g, { x: px, y: deckTop + 1.3, z: pz }, new THREE.Euler(0, -yaw, 0));
    paint(g, STEEL_DARK, 0.06, rng);
    parts.push(g);
  }
  {
    const rail = new THREE.BoxGeometry(halfW * 2, 0.14, 0.16);
    const px = cx + ax * (halfD - 0.25), pz = cz + az * (halfD - 0.25);
    xform(rail, { x: px, y: deckTop + 1.0, z: pz }, new THREE.Euler(0, -yaw, 0));
    paint(rail, STEEL, 0.05, rng);
    parts.push(rail);
  }

  /* ── 「전차 호출」 콘솔 ────────────────────────────────────────────────────
   * 예전 시동 콘솔 · 그 뒤 안내판이 서 있던 자리다 (선로 쪽 데크 모서리, 한쪽 끝).
   * 조작하는 물건이므로 **그렇게 보여야 한다** — 받침 · 몸통 · 기울어진 화면 · 버튼 두 개 ·
   * 몸통을 두르는 발광 띠. 발광 조각은 `out.glow` 로 넘겨 `Rails` 가 **한 덩어리 emissive 메시**로
   * 합친다 (플랫폼마다 메시를 늘리지 않는다). */
  const conX = cx + Math.cos(yaw) * (halfW - 1.2) - ax * (halfD - 1.0);
  const conZ = cz + Math.sin(yaw) * (halfW - 1.2) - az * (halfD - 1.0);
  {
    /** 콘솔 로컬 오프셋 → 월드. `ox` = 선로 방향, `oz` = 데크 안쪽(플레이어가 서는 쪽), `tilt` = 로컬 X 축 기울기. */
    const put = (g: THREE.BufferGeometry, ox: number, oy: number, oz: number, tilt = 0): THREE.BufferGeometry => {
      if (tilt) xform(g, undefined, new THREE.Euler(tilt, 0, 0));
      return xform(g, {
        x: conX + Math.cos(yaw) * ox + ax * oz,
        y: deckTop + oy,
        z: conZ + Math.sin(yaw) * ox + az * oz,
      }, new THREE.Euler(0, -yaw, 0));
    };

    const plinth = put(new THREE.BoxGeometry(0.9, 0.18, 0.56), 0, 0.09, 0);
    paint(plinth, DECK_DARK, 0.05, rng);
    parts.push(plinth);

    const body = put(new THREE.BoxGeometry(0.8, 0.95, 0.5), 0, 0.655, 0);
    paintGradient(body, STEEL_DARK, STEEL, deckTop + 0.18, deckTop + 1.13);
    parts.push(body);

    // 기울어진 화면 틀 — 서서 내려다보는 각도(0.5 rad)로 눕혔다.
    const head = put(new THREE.BoxGeometry(0.74, 0.44, 0.14), 0, 1.28, 0.1, -0.5);
    paint(head, STEEL_DARK, 0.05, rng);
    parts.push(head);

    // 발광: 화면 · 몸통 띠 · 버튼 두 개 (틀 앞면 법선 = (0, sin 0.5, cos 0.5))
    out.glow.push(put(new THREE.BoxGeometry(0.6, 0.32, 0.03), 0, 1.323, 0.179, -0.5));
    out.glow.push(put(new THREE.BoxGeometry(0.72, 0.05, 0.02), 0, 1.06, 0.255));
    for (const sx of [-1, 1]) out.glow.push(put(new THREE.BoxGeometry(0.09, 0.09, 0.03), sx * 0.19, 0.86, 0.255));

    // 콜라이더 = 보이는 실루엣. 반지름은 가장 넓은 받침의 모서리 스윕(hypot(0.45, 0.28) = 0.53)이다.
    ctx.hash.add(new THREE.Vector3(conX, deckTop, conZ), 0.53, 1.5, 'sign');
  }

  const geo = merge(parts);
  out.geos.push(geo);
  const mesh = new THREE.Mesh(geo, out.mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.layers.enable(Layers.PROP);
  mesh.name = `rail_${def.id}`;
  out.group.add(mesh);

  // 컨테이너 (데크 위, 선로 반대쪽에 붙여)
  const count = row ? row.containers : 4;
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (i / (count - 1) - 0.5) * (halfW * 2 - 2.4);
    const px = cx + Math.cos(yaw) * t + ax * (halfD - 1.1);
    const pz = cz + Math.sin(yaw) * t + az * (halfD - 1.1);
    specs.push({
      id: `${def.id}_c${i}`, position: new THREE.Vector3(px, deckTop, pz), yaw: yaw + Math.PI / 2,
      tier: pickTier(row ? row.tiers : [], rng.next()), style: (i % 3) as 0 | 1 | 2,
      zoneId: def.id, zoneKind: 'platform',
    });
  }

  /* 호출 콘솔 앞에 서는 자리(가슴 높이). `Rails` 가 여기에 `Interactable` 을 건다. */
  return new THREE.Vector3(conX, deckTop + 1.0, conZ);
}

/**
 * **플랫폼 계단** (2026-09-10 개편).
 *
 * 예전에는 단수가 `4` 로 못 박혀 있었다. 데크 높이(`deckH`)는 선로 부양 패스 때문에 자리마다 다른데
 * (언덕을 가로지르는 구간에서는 3 m 를 넘는다) 단수가 고정이면 한 단의 높이가 `PROP_STEP_UP_MAX`(0.9)를
 * 넘어 **계단이 벽이 된다** — "계단이 계단으로 작동하지 않는" 그것이다.
 *
 * 이제 **한 단의 높이를 `RAIL_STAIR_MAX_RISE` 이하로 고정하고 단수를 거기서 뽑는다.** 그리고 기준면을
 * 패드 높이가 아니라 **계단이 실제로 닿는 바깥쪽 지형**과 견줘 잡는다 (계단이 패드 밖으로 뻗어 지형이
 * 꺼져 있으면 마지막 한 단만 유난히 높아진다). 각 단의 상자는 그 자리 지형에서 올라오므로 떠 있지 않다.
 */
function buildStairs(
  ctx: BuildCtx, rng: Random, parts: THREE.BufferGeometry[],
  cx: number, cz: number, yaw: number, ax: number, az: number,
  halfD: number, groundY: number, deckTop: number,
): void {
  const depth = Math.max(0.4, RAIL_STAIR_DEPTH);
  const riseMax = Math.max(0.15, Math.min(RAIL_STAIR_MAX_RISE, PROP_STEP_UP_MAX));
  const offsetOf = (i: number): number => halfD + depth / 2 + i * depth;

  // 단수와 기준면을 함께 푼다 — 단수가 늘면 계단이 더 밖으로 뻗고, 거기 지형이 더 낮으면 단수가 또 는다.
  let n = Math.max(2, Math.ceil(Math.max(0.4, deckTop - groundY) / riseMax));
  let baseY = groundY;
  for (let pass = 0; pass < 3; pass++) {
    const far = offsetOf(Math.max(0, n - 2));
    const gy = ctx.terrain.getHeightAt(cx + ax * far, cz + az * far);
    const b = Math.min(groundY, gy);
    const need = Math.max(2, Math.ceil(Math.max(0.4, deckTop - b) / riseMax));
    if (need === n && b === baseY) break;
    n = need; baseY = b;
  }
  const total = Math.max(0.4, deckTop - baseY);

  // i = 0 이 데크에 가장 가까운(가장 높은) 단이다. 마지막 한 단은 데크 상판이므로 `n - 1` 개만 세운다.
  for (let i = 0; i < n - 1; i++) {
    const top = baseY + (total * (n - 1 - i)) / n;
    const off = offsetOf(i);
    const px = cx + ax * off, pz = cz + az * off;
    const gy = Math.min(ctx.terrain.getHeightAt(px, pz), top - 0.12);
    const h = top - gy;
    const g = new THREE.BoxGeometry(4.4, h, depth);
    xform(g, { x: px, y: gy + h / 2, z: pz }, new THREE.Euler(0, -yaw, 0));
    paint(g, DECK_DARK, 0.05, rng);
    parts.push(g);
    ctx.hash.addBox(new THREE.Vector3(px, gy, pz), 2.2, depth / 2, yaw, h, 'platform');
  }
}
