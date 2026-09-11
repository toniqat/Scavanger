/**
 * src/world/rails/parts/Tram.ts — **전차 차체 · 운전실 콘솔 · 배치 · 충돌 피해**.
 *
 * `Rails` 에서 떼어낸 메서드 묶음이다 (2026-09-10 분할). 상태는 `TramInst` 하나에 들어 있고
 * (`rails/model`), 이 파일은 그것을 만들고 · 매 프레임 놓고 · 치인 사람을 판정한다.
 *
 * **축 규약**: 로컬 +X = 진행 방향(길이 `halfLen`), 로컬 +Z = 좌우(폭 `halfWid`).
 * `data/structures.csv` 의 `tram.halfD`(6) 가 반**길이**, `tram.halfW`(1.9) 가 반**폭**이다 —
 * 2026-09-10 이전에는 이 둘이 뒤바뀐 채로 지오메트리에 들어가 **선로와 수직으로 길쭉한 판때기**가 달렸다.
 *
 * **지붕은 없다** (무개차) — 3인칭 카메라가 갇히지 않게 하는 규약이고 구조물의 무너진 지붕과 같은 판단이다.
 * 대신 앞 격벽 뒤가 **운전실**이고 그 안에 시동 콘솔이 선다: 차체 안이 실제로 걸어 다니는 공간이다.
 */
import * as THREE from 'three';
import {
  Layers, PLAYER_HEIGHT, PLAYER_RADIUS, RIDE_EDGE_MARGIN, RIDE_FOOT_DROP, TRAM_CONSOLE_RANGE, TRAM_HIT_COOLDOWN_S, TRAM_HIT_DAMAGE,
  TRAM_HIT_FLOOR_CLEAR, TRAM_HIT_KNOCKBACK, TRAM_HIT_REACH, TRAM_HIT_SPEED_MIN, TRAM_SPEED, TRAM_START_HOLD_S,
  type GameContext, type PeerId, type Random, type TramDef,
} from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from '../../build';
import type { ContainerSpec } from '../../structures/parts/Containers';
import { pickTier, structureRow } from '../../structures/model';
import type { SpatialHash } from '../../SpatialHash';
import {
  GLASS, SCREEN, STEEL, STEEL_DARK, TRAM_CAB_LEN, TRAM_DESK_H, TRAM_DESK_HALF_L, TRAM_DESK_HALF_W,
  TRAM_DOOR_HALF, TRAM_FLOOR_T, TRAM_FLOOR_UP, TRAM_NOSE_T, TRAM_WALL_H, TRAM_WALL_T,
  type RailBuild, type RailPath, type TramInst, sampleAt,
} from '../model';

/* 핫 패스 스크래치 — 프레임당 할당 금지 (월드는 단일 스레드다). */
const _pos = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _kb = new THREE.Vector3();
const _from = new THREE.Vector3();

/** 차체 · 콜라이더 · 객실 컨테이너 · 운전실 콘솔 자리를 만든다. 등록(`Interactable`)은 `Rails` 가 한다. */
export function buildTram(
  ctx: BuildCtx, rng: Random, startS: number, startDock: string | null,
  specs: ContainerSpec[], out: RailBuild,
): TramInst {
  const row = structureRow('tram');
  /** 반**길이**(진행 방향) · 반**폭** · 객실 높이 — csv 가 원본이다. */
  const halfLen = row ? row.halfD : 6, halfWid = row ? row.halfW : 1.9, wallH = row ? row.wallH : 2.2;
  const parts: THREE.BufferGeometry[] = [];

  // ── 바닥 · 대차 ────────────────────────────────────────────────────
  const floor = new THREE.BoxGeometry(halfLen * 2, TRAM_FLOOR_T, halfWid * 2);
  xform(floor, { x: 0, y: -TRAM_FLOOR_T / 2, z: 0 });
  paintGradient(floor, STEEL_DARK, STEEL);
  parts.push(floor);
  for (const s of [-1, 1]) {
    const bogie = new THREE.BoxGeometry(1.8, 0.4, halfWid * 1.5);
    xform(bogie, { x: s * halfLen * 0.62, y: -0.5, z: 0 });
    paint(bogie, STEEL_DARK, 0.06, rng);
    parts.push(bogie);
  }

  /* ── 옆판 (허리 높이 — 위가 열려 있어 카메라가 갇히지 않는다) ─────────────────
   * 가운데는 **승강구**로 비운다. 양쪽 다 비우는 이유는 왕복 선로에서 전차가 뒤집혀 달려
   * 플랫폼이 반대편에 오기 때문이다. 승강구는 이제 **진행 방향으로** 뚫린다. */
  const seg = (k: number): [number, number] => (k < 0 ? [-halfLen, -TRAM_DOOR_HALF] : [TRAM_DOOR_HALF, halfLen]);
  for (const sz of [-1, 1]) {
    for (const k of [-1, 1]) {
      const [x0, x1] = seg(k);
      const len = x1 - x0, mid = (x0 + x1) / 2;
      const w = new THREE.BoxGeometry(len, TRAM_WALL_H, TRAM_WALL_T);
      xform(w, { x: mid, y: TRAM_WALL_H / 2, z: sz * halfWid });
      paintGradient(w, STEEL_DARK, STEEL, 0, TRAM_WALL_H);
      parts.push(w);
      const cap = new THREE.BoxGeometry(len, 0.1, TRAM_WALL_T + 0.1);
      xform(cap, { x: mid, y: TRAM_WALL_H + 0.03, z: sz * halfWid });
      paint(cap, STEEL, 0.05, rng);
      parts.push(cap);
    }
  }

  // ── 앞 격벽(기수) + 전면 유리 ──────────────────────────────────────
  {
    const nose = new THREE.BoxGeometry(TRAM_NOSE_T, wallH, halfWid * 2);
    xform(nose, { x: halfLen - TRAM_NOSE_T / 2, y: wallH / 2, z: 0 });
    paintGradient(nose, STEEL_DARK, STEEL, 0, wallH);
    parts.push(nose);
    const glass = new THREE.BoxGeometry(0.08, 0.62, halfWid * 1.5);
    xform(glass, { x: halfLen - 0.02, y: wallH * 0.66, z: 0 });
    paint(glass, GLASS);
    parts.push(glass);
  }

  // ── 후미 난간 ─────────────────────────────────────────────────────
  {
    const g = new THREE.BoxGeometry(0.22, TRAM_WALL_H, halfWid * 2);
    xform(g, { x: -halfLen + 0.11, y: TRAM_WALL_H / 2, z: 0 });
    paintGradient(g, STEEL_DARK, STEEL, 0, TRAM_WALL_H);
    parts.push(g);
  }

  /* ── 운전 콘솔 (2026-09-10 — 플랫폼에서 차 안으로 옮겼다) ────────────────
   * 앞 격벽에 등을 대고 선 데스크 + 기울어진 화면. 격벽 뒤 `TRAM_CAB_LEN` 이 운전실이고
   * 그 자리는 **비어 있다** — 걸어 들어가 콘솔 앞에 설 수 있어야 한다. */
  const deskX = halfLen - TRAM_NOSE_T - TRAM_DESK_HALF_L;
  {
    const desk = new THREE.BoxGeometry(TRAM_DESK_HALF_L * 2, TRAM_DESK_H, TRAM_DESK_HALF_W * 2);
    xform(desk, { x: deskX, y: TRAM_DESK_H / 2, z: 0 });
    paintGradient(desk, STEEL_DARK, STEEL, 0, TRAM_DESK_H);
    parts.push(desk);
    const screen = new THREE.BoxGeometry(0.46, 0.07, TRAM_DESK_HALF_W * 1.7);
    xform(screen, { x: 0, y: 0, z: 0 }, new THREE.Euler(0, 0, 0.5));
    xform(screen, { x: deskX - 0.04, y: TRAM_DESK_H + 0.06, z: 0 });
    paint(screen, SCREEN, 0.06, rng);
    parts.push(screen);
    const lever = new THREE.BoxGeometry(0.1, 0.42, 0.1);
    xform(lever, { x: deskX - 0.06, y: TRAM_DESK_H + 0.2, z: TRAM_DESK_HALF_W * 0.55 });
    paint(lever, STEEL, 0.05, rng);
    parts.push(lever);
  }

  const geo = merge(parts);
  out.geos.push(geo);
  const mesh = new THREE.Mesh(geo, out.mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.layers.enable(Layers.PROP);
  // 2026-09-10: 이름을 준다 — `scripts/smoke-structures.mjs` 가 `rail_*` 메시의 바운딩 박스와 상자
  // 콜라이더를 견주는데, 예전에는 차체 메시가 무명이라 전차만 그 검사에서 통째로 빠져 있었다.
  mesh.name = 'rail_tram_body';
  const root = new THREE.Group();
  root.name = 'tram';
  root.add(mesh);
  out.group.add(root);

  const vel = new THREE.Vector3();
  const def: TramDef = {
    id: 'tram_rail_0', lineId: 'rail_0',
    position: new THREE.Vector3(), yaw: 0, state: 'idle', s: startS, dir: 1,
  };
  const inst: TramInst = {
    def, root, parts: [], vel, containers: [], consolePos: new THREE.Vector3(),
    halfLen, halfWid, wallH,
    dockTimer: 0, runT: 0, lastDock: startDock, targetS: startS, hitUntil: new Map(),
  };

  /* 콜라이더: 바닥(= 발판) 하나 + 옆판 넷 + 앞 격벽 + 후미 난간 + 콘솔 데스크. 전부 `Obstacle.box` 이고
   * `velocity` 는 **같은 벡터 객체**를 공유한다 — 매 프레임 그 하나만 고치면 발판 질의가 곧바로 새 속도를 본다. */
  const addPart = (ox: number, oz: number, oy: number, hx: number, hz: number, h: number): void => {
    const entry = ctx.hash.addBox(new THREE.Vector3(0, -9999, 0), hx, hz, 0, h, 'tram');
    entry.velocity = vel;
    inst.parts.push({ entry, ox, oz, oy });
  };
  addPart(0, 0, -TRAM_FLOOR_T, halfLen, halfWid, TRAM_FLOOR_T);                       // 바닥 (윗면 = 전차 바닥)
  for (const sz of [-1, 1]) for (const k of [-1, 1]) {
    const [x0, x1] = seg(k);
    addPart((x0 + x1) / 2, sz * halfWid, 0, (x1 - x0) / 2, TRAM_WALL_T / 2, TRAM_WALL_H);
  }
  addPart(halfLen - TRAM_NOSE_T / 2, 0, 0, TRAM_NOSE_T / 2, halfWid, wallH);          // 앞 격벽
  addPart(-halfLen + 0.11, 0, 0, 0.11, halfWid, TRAM_WALL_H);                         // 후미 난간
  addPart(deskX, 0, 0, TRAM_DESK_HALF_L, TRAM_DESK_HALF_W, TRAM_DESK_H);              // 콘솔 데스크

  /* ── 객실 컨테이너 (움직인다 — `ContainerSpec.dynamic`) ─────────────────
   * 승강구와 운전실은 비운다: 문 앞에 캐비닛이 서면 타지 못하고, 운전실에 서면 콘솔을 가린다. */
  const count = row ? row.containers : 3;
  const allZones: Array<[number, number]> = [
    [-halfLen + 1.0, -TRAM_DOOR_HALF - 0.7],
    [TRAM_DOOR_HALF + 0.7, halfLen - TRAM_NOSE_T - TRAM_CAB_LEN - 0.7],
  ];
  const zones = allZones.filter(([a, b]) => b > a);
  const spanTotal = zones.reduce((sum, [a, b]) => sum + (b - a), 0);
  for (let i = 0; i < count; i++) {
    let t = spanTotal * ((i + 0.5) / Math.max(1, count));
    let ox = zones.length ? zones[0][0] : 0;
    for (const [a, b] of zones) {
      if (t <= b - a) { ox = a + t; break; }
      t -= b - a; ox = b;
    }
    const oz = (i % 2 === 0 ? -1 : 1) * (halfWid - 0.7);
    const spec: ContainerSpec = {
      id: `tram_c${i}`, position: new THREE.Vector3(), yaw: 0,
      tier: pickTier(row ? row.tiers : [], rng.next()), style: (i % 3) as 0 | 1 | 2,
      zoneId: 'tram_rail_0', zoneKind: 'platform', dynamic: true,
    };
    specs.push(spec);
    inst.containers.push({ spec, ox, oz, oy: 0 });
  }

  return inst;
}

/**
 * `s` 에서 전차 · 콜라이더 · 컨테이너 · 콘솔을 다시 놓는다. `speed` 는 발판 속도(m/s, 0 이면 정지).
 *
 * **스냅샷을 찍지 않는다** — 타고 있는 쪽(`player/PlayerController`)은 여기서 고쳐 둔 `entry.position` ·
 * `box.yaw` 를 매 프레임 다시 읽어 자기 자리를 푼다 (함선 실내가 스냅샷 때문에 깨졌던 전례와 같은 이유).
 */
export function placeTram(inst: TramInst, path: RailPath, speed: number, hash: SpatialHash | null): void {
  sampleAt(path, inst.def.s, _pos, _tan);
  const yaw = Math.atan2(_tan.z, _tan.x) + (inst.def.dir < 0 ? Math.PI : 0);
  const fy = _pos.y + TRAM_FLOOR_UP;
  inst.def.position.set(_pos.x, fy, _pos.z);
  inst.def.yaw = yaw;
  inst.root.position.set(_pos.x, fy, _pos.z);
  inst.root.rotation.y = -yaw;
  inst.vel.set(_tan.x * speed * inst.def.dir, 0, _tan.z * speed * inst.def.dir);

  const c = Math.cos(yaw), s = Math.sin(yaw);
  // 로컬 +X = 길이(진행 방향), 로컬 +Z = 폭. 메시는 Euler(0, −yaw, 0) 이라 +X → (cos, sin), +Z → (−sin, cos).
  for (const p of inst.parts) {
    const wx = _pos.x + p.ox * c - p.oz * s;
    const wz = _pos.z + p.ox * s + p.oz * c;
    hash?.move(p.entry, wx, fy + p.oy, wz, yaw);
  }
  for (const cc of inst.containers) {
    cc.spec.position.set(_pos.x + cc.ox * c - cc.oz * s, fy + cc.oy, _pos.z + cc.ox * s + cc.oz * c);
    // 캐비닛은 벽(옆판)에 등을 대고 선다 — 벽 법선은 로컬 ±Z 다.
    cc.spec.yaw = yaw + (cc.oz < 0 ? Math.PI / 2 : -Math.PI / 2);
  }
  {
    // 콘솔 앞에 서는 자리 = 데스크에서 후미 쪽으로 한 걸음. `Interactable.position` 이 이 객체다.
    const ox = inst.halfLen - TRAM_NOSE_T - TRAM_DESK_HALF_L * 2 - 0.35;
    inst.consolePos.set(_pos.x + ox * c, fy + 1.0, _pos.z + ox * s);
  }
}

/**
 * **달리는 전차에 치이면 피해 + 넉백** (2026-09-10).
 *
 * 위험한 것은 **빠를 때뿐**이다: `TRAM_HIT_SPEED_MIN` 밑에서는 아무 일도 없고, 그 위에서는 피해도 넉백도
 * `speed / TRAM_SPEED` 에 비례한다 (정차 · 출발 직후의 저속 구간은 안전하다).
 *
 * **탑승자는 맞지 않는다.** 전차 바닥(`def.position.y`)보다 발이 `TRAM_HIT_FLOOR_CLEAR` 넘게 아래일 때만
 * 판정한다 — 데크 위에 선 사람과 (같은 높이인) 플랫폼 위의 사람은 그 한 줄로 빠지고, 선로 발판(바닥보다
 * `TRAM_FLOOR_UP` 0.35 m 아래)이나 맨땅에 선 사람만 남는다.
 *
 * **호스트/리플리카**: 전차의 상태(`s` · `dir` · state)는 호스트 권위이고 이미 동기화돼 있으므로, 판정은
 * 각 클라이언트가 **자기 플레이어만** 본다 (재해 `Hazard` 와 같은 철학 — 새 와이어를 만들지 않는다).
 * 그래서 남의 화면에서 내가 치이는 일도, 내 화면에서만 안 치이는 일도 없다.
 *
 * ## 2026-09-11 (C-18) — 적 · 끊긴 분대원도 치인다
 * - **권위(싱글 · 호스트)** 만 `ctx.enemies.queryNear` 로 차체 둘레의 적을 훑어 같은 OBB · 높이대 판정을 한다 →
 *   `EnemyRef.takeDamage(…, 'ai')`(킬 크레딧 없음) + `EnemyManagerRef.pushBack`(그 적 하나에 `dir` 로). 전차는
 *   시드 결정적이고 `s` 가 동기화돼 있으므로 호스트가 판정하면 리플리카에는 적 스냅샷 · `ee damaged` 로 간다.
 * - **끊긴 분대원(고스트, `suspended`)** 은 권위가 몸을 시뮬레이션하므로 같은 판정 → `ghost:damage {kb}`.
 *   고스트는 플레이어 몸이라 발 높이 규칙이 플레이어와 같다.
 * - ~~타고 있는 적은 치지 않는다: 차체 OBB 안에서 발이 데크 윗면 − `RIDE_FOOT_DROP` 이상이면 탑승자다~~ →
 *   C-63 에서 좁혔다 (아래). 그 창이 선로 발판(바닥 −`TRAM_FLOOR_UP` 0.35)까지 덮어 **선로 위에 선 적이 안 치였다.**
 * - 쿨다운은 **대상별**(`TramInst.hitUntil`)이다. 소리는 전용 `tram_hit`(정의는 `audio/`).
 *
 * ## 2026-09-11 (C-63) — 면제는 실제로 타고 있는 몸만
 * 로컬 플레이어 · 적 · 끊긴 분대원이 **한 규칙**(`riderExempt`)을 쓴다:
 * - 발이 바닥 − `TRAM_HIT_FLOOR_CLEAR` 위 = 데크 · 플레이어 높이의 플랫폼 → 치지 않는다 (2026-09-10 한 줄 그대로).
 * - 그 밑 `RIDE_FOOT_DROP` 띠(바닥 −0.18 … −0.7 — 선로 발판이 여기다)는 차체 단면 + `RIDE_EDGE_MARGIN` 안이고
 *   **발밑이 고정 발판이 아닐 때만** 뺀다 — 발밑이 이 전차의 부품(`velocity === inst.vel`, 부품이 같은 속도 벡터를
 *   공유한다)이거나 비어 있으면(경사 · 프레임 요동으로 조금 처진 탑승자) 탑승자, 선로 발판을 밟은 몸은 치인다.
 * 적의 탑승 상태는 여전히 `EnemyRef` 로 묻지 않는다 — 발밑 질의는 월드가 스스로 답한다. 판정 순서는 이 폴더의
 * `update`(월드) → 플레이어 · 적 순이라 몸은 한 프레임 전 자리지만, 데크 높이 한 줄이 먼저 거르므로 뒤처진 탑승자가
 * 치이는 일은 없다.
 */
export function updateTramHit(game: GameContext | null, inst: TramInst, speed: number, dt: number): void {
  void dt;
  if (!game || speed < TRAM_HIT_SPEED_MIN) return;
  const now = game.time;
  const hitUntil = inst.hitUntil;
  if (hitUntil.size > 24) for (const [k, until] of hitUntil) if (until <= now) hitUntil.delete(k);

  const t = Math.min(1, speed / Math.max(0.001, TRAM_SPEED));
  const floorY = inst.def.position.y;
  const c = Math.cos(inst.def.yaw), s = Math.sin(inst.def.yaw);

  // ── 로컬 플레이어 — 각 클라이언트가 자기 몸만 (2026-09-10 그대로) ─────────────────
  const player = game.player;
  if (player && !player.isDead && !player.isInShip && !player.isDropping && game.isGameplayActive()
    && (hitUntil.get('local') ?? -Infinity) <= now) {
    const p = player.position;
    const side = riderExempt(game, inst, p.x, p.y, p.z)
      ? 0 : hitSide(inst, c, s, p.x, p.y, p.z, PLAYER_RADIUS, floorY - TRAM_HIT_FLOOR_CLEAR, floorY - TRAM_HIT_REACH);
    if (side !== 0) {
      hitUntil.set('local', now + TRAM_HIT_COOLDOWN_S);
      knockDir(c, s, side);
      game.bus.emit('audio:play', { id: 'tram_hit', position: p, volume: 0.9 });
      player.applyKnockback(_kb, TRAM_HIT_KNOCKBACK * t);
      player.takeDamage(TRAM_HIT_DAMAGE * t, inst.def.position);
    }
  }

  // ── 권위: 적 · 끊긴 분대원 ─────────────────────────────────────────────────
  const net = game.net;
  if (game.isMultiplayer && net && !net.isHost) return;
  if (!game.isGameplayPhase()) return;

  const enemies = game.enemies;
  if (enemies) {
    const near = enemies.queryNear(inst.def.position, Math.hypot(inst.halfLen, inst.halfWid) + TRAM_HIT_REACH + 3);
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      if (e.isDead) continue;
      const key = `e:${e.id}`;
      if ((hitUntil.get(key) ?? -Infinity) > now) continue;
      /* 발 높이 창: 위 = 바닥 − `TRAM_HIT_FLOOR_CLEAR`(플레이어와 같다 — 그 밑 탑승 띠는 `riderExempt`, C-63), 아래 = 몸
       * **꼭대기**가 플레이어 규칙의 머리 자리(바닥 − (TRAM_HIT_REACH − PLAYER_HEIGHT))에 닿는가 — 벌레는 작고 베헤모스는 크다. */
      const lowFoot = floorY - (TRAM_HIT_REACH - PLAYER_HEIGHT) - e.height;
      const ep = e.position;
      if (riderExempt(game, inst, ep.x, ep.y, ep.z)) continue;
      const side = hitSide(inst, c, s, ep.x, ep.y, ep.z, e.radius, floorY - TRAM_HIT_FLOOR_CLEAR, lowFoot);
      if (side === 0) continue;
      hitUntil.set(key, now + TRAM_HIT_COOLDOWN_S);
      knockDir(c, s, side);
      game.bus.emit('audio:play', { id: 'tram_hit', position: e.position, volume: 0.9 });
      // 그 적 하나만 민다 — 반경을 몸 안으로 좁히고 방향을 준다 (pushBack 은 반경 + 몸 반지름까지 본다)
      enemies.pushBack(_from.copy(e.position), 0.05, TRAM_HIT_KNOCKBACK * t, _kb);
      e.takeDamage(TRAM_HIT_DAMAGE * t, undefined, _kb, 'ai');
    }
  }

  if (!net) return;
  const refs = net.getRemotePlayers();   // 싱글에서는 빈 목록이다
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    if (!r.suspended || !r.inMission || r.isDead || r.ghostState === 2) continue;
    const key = `g:${r.id}`;
    if ((hitUntil.get(key) ?? -Infinity) > now) continue;
    const rp = r.position;
    if (riderExempt(game, inst, rp.x, rp.y, rp.z)) continue;
    const side = hitSide(inst, c, s, rp.x, rp.y, rp.z, PLAYER_RADIUS, floorY - TRAM_HIT_FLOOR_CLEAR, floorY - TRAM_HIT_REACH);
    if (side === 0) continue;
    hitUntil.set(key, now + TRAM_HIT_COOLDOWN_S);
    knockDir(c, s, side);
    game.bus.emit('audio:play', { id: 'tram_hit', position: r.position, volume: 0.9 });
    game.bus.emit('ghost:damage', {
      id: r.id as PeerId, amount: TRAM_HIT_DAMAGE * t, from: inst.def.position.clone(),
      kb: { direction: _kb.clone(), speed: TRAM_HIT_KNOCKBACK * t },
    });
  }
}

/**
 * 차체 OBB(+`radius`) 안이고 발 높이가 `[footMin, footMax]` 안이면 **선로의 어느 쪽인지**(+1 / −1), 아니면 0.
 * `footMax` 위는 탑승자 · 플랫폼 위, `footMin` 밑은 전차 밑이다.
 */
function hitSide(
  inst: TramInst, c: number, s: number, x: number, y: number, z: number, radius: number, footMax: number, footMin: number,
): number {
  if (y > footMax || y < footMin) return 0;
  const dx = x - inst.def.position.x, dz = z - inst.def.position.z;
  const lx = dx * c + dz * s, lz = -dx * s + dz * c;
  if (Math.abs(lx) > inst.halfLen + radius || Math.abs(lz) > inst.halfWid + radius) return 0;
  return lz >= 0 ? 1 : -1;
}

/**
 * C-63: 데크 높이 밑 `RIDE_FOOT_DROP` 띠의 몸이 **이 전차를 타고 있는가**. 띠 밖은 false (데크 높이 위는 `hitSide` 의
 * `footMax` 가 이미 거르고, 띠 밑은 선로 옆 · 맨땅이다). 띠 안에서는 `shared/ride.rideContains` 와 같은 부피
 * (차체 단면 + `RIDE_EDGE_MARGIN`) 안이고 **발밑이 고정 발판이 아닐 때만** 탑승자다:
 * - 발밑 발판(`getStandingObstacle`, 윗면 ±`PROP_TOP_MARGIN`)이 이 전차의 부품(`velocity === inst.vel`) → 탑승자.
 * - 발밑에 아무것도 없다 → 경사 · 프레임 요동으로 데크보다 조금 처진 탑승자 (그 높이의 고정 표면은 선로 발판뿐이다).
 * - 발밑이 선로 발판 같은 **고정 발판** → 전차 옆 · 앞의 선로에 선 몸 — 치인다 (C-63 이 닫은 틈).
 */
function riderExempt(game: GameContext, inst: TramInst, x: number, y: number, z: number): boolean {
  const floorY = inst.def.position.y;
  if (y > floorY - TRAM_HIT_FLOOR_CLEAR || y < floorY - RIDE_FOOT_DROP) return false;
  const c = Math.cos(inst.def.yaw), s = Math.sin(inst.def.yaw);
  const dx = x - inst.def.position.x, dz = z - inst.def.position.z;
  if (Math.abs(dx * c + dz * s) > inst.halfLen + RIDE_EDGE_MARGIN || Math.abs(-dx * s + dz * c) > inst.halfWid + RIDE_EDGE_MARGIN) return false;
  const w = game.world;
  if (!w || !w.ready) return false;
  const o = w.getStandingObstacle(x, z, y);
  return !o || o.velocity === inst.vel;
}

/** 앞으로 밀면서 **선로 밖으로** 던지는 방향을 `_kb` 에 쓴다 — 그대로 앞으로만 밀면 계속 치인다. */
function knockDir(c: number, s: number, side: number): void {
  _kb.set(c * 0.7 - s * side, 0, s * 0.7 + c * side).normalize();
}

/** 운전실 콘솔의 상호작용 반경 · 홀드 시간은 계약(csv)에서 온다 — `Rails` 가 등록할 때 쓴다. */
export const TRAM_CONSOLE = { radius: TRAM_CONSOLE_RANGE, holdTime: TRAM_START_HOLD_S } as const;
