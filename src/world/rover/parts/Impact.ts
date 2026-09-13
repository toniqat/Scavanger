/**
 * src/world/rover/parts/Impact.ts — **달리는 탐사 차량에 부딪힘** (R2, 2026-09-13). 전차의 `rails/parts/Tram.updateTramHit` 과 같은 틀.
 *
 * - `ROVER_HIT_SPEED_MIN` 밑에서는 아무 일도 없고, 그 위에서는 넉백 · 피해가 `speed / ROVER_TRIP_SPEED` 에 비례한다.
 * - **플레이어(로컬 · 끊긴 분대원 고스트)는 넉백만 받고 피해는 없다** — 사람이 운전하지 않는 자동 차량이 분대원을
 *   죽이면 억울하다 (리드 결정). 로컬은 각 클라이언트가 자기 몸만 판정한다.
 * - 적은 **권위(싱글 · 호스트)만** 판정해 피해 + 넉백, `attacker = ROVER_DAMAGE_SOURCE` (킬 크레딧 없음 · 차량 어그로).
 * - 탑승자는 판정하지 않는다 (몸이 차 안 좌석에 있다 — `PlayerRef.roverRide` · 탑승자 목록).
 * - 쿨다운은 대상별(`local` · `e:<id>` · `g:<PeerId>`).
 */
import * as THREE from 'three';
import {
  PLAYER_RADIUS, ROVER_DAMAGE_SOURCE, ROVER_HALF_LENGTH, ROVER_HALF_WIDTH, ROVER_HIT_COOLDOWN_S, ROVER_HIT_DAMAGE,
  ROVER_HIT_KNOCKBACK, ROVER_HIT_SPEED_MIN, ROVER_TRIP_SPEED,
  type GameContext, type PeerId, type RoverVehicleDef,
} from '@/shared';

const _kb = new THREE.Vector3();
const _from = new THREE.Vector3();
/** 발 높이 창 (차체 바닥 기준, m) — 위로 이만큼, 아래로 이만큼 안의 몸만 부딪힌다. */
const FOOT_ABOVE = 1.4;
const FOOT_BELOW = 1.6;

/**
 * @param dir 주행 방향 (+1 / −1). 차체 yaw 는 이미 방향을 담고 있어 넉백 방향에만 쓴다.
 * @param riders 이 클라이언트 기준 탑승자 id (`'local'` · PeerId).
 */
export function updateRoverImpacts(
  game: GameContext, def: RoverVehicleDef, speed: number, hitUntil: Map<string, number>, riders: readonly string[],
): void {
  if (speed < ROVER_HIT_SPEED_MIN || !game.isGameplayPhase()) return;
  const now = game.time;
  if (hitUntil.size > 24) for (const [k, until] of hitUntil) if (until <= now) hitUntil.delete(k);
  const t = Math.min(1, speed / Math.max(0.001, ROVER_TRIP_SPEED));
  const c = Math.cos(def.yaw), s = Math.sin(def.yaw);
  const baseY = def.position.y;

  const player = game.player;
  if (player && !player.isDead && !player.isInShip && !player.isDropping && !player.roverRide
    && (hitUntil.get('local') ?? -Infinity) <= now) {
    const p = player.position;
    const side = hitSide(def, c, s, p.x, p.y, p.z, PLAYER_RADIUS, baseY);
    if (side !== 0) {
      hitUntil.set('local', now + ROVER_HIT_COOLDOWN_S);
      knockDir(c, s, side);
      game.bus.emit('audio:play', { id: 'tram_hit', position: p, volume: 0.7 });
      player.applyKnockback(_kb, ROVER_HIT_KNOCKBACK * t);
    }
  }

  const net = game.net;
  if (game.isMultiplayer && net && !net.isHost) return;

  const enemies = game.enemies;
  if (enemies) {
    const near = enemies.queryNear(def.position, Math.hypot(ROVER_HALF_LENGTH, ROVER_HALF_WIDTH) + 3);
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      if (e.isDead) continue;
      const key = `e:${e.id}`;
      if ((hitUntil.get(key) ?? -Infinity) > now) continue;
      const ep = e.position;
      const side = hitSide(def, c, s, ep.x, ep.y, ep.z, e.radius, baseY);
      if (side === 0) continue;
      hitUntil.set(key, now + ROVER_HIT_COOLDOWN_S);
      knockDir(c, s, side);
      game.bus.emit('audio:play', { id: 'tram_hit', position: ep, volume: 0.8 });
      enemies.pushBack(_from.copy(ep), 0.05, ROVER_HIT_KNOCKBACK * t, _kb);
      e.takeDamage(ROVER_HIT_DAMAGE * t, undefined, _kb, ROVER_DAMAGE_SOURCE);
    }
  }

  if (!net) return;
  const refs = net.getRemotePlayers();
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    if (!r.suspended || !r.inMission || r.isDead || r.ghostState === 2) continue;
    if (riders.includes(r.id)) continue;
    const key = `g:${r.id}`;
    if ((hitUntil.get(key) ?? -Infinity) > now) continue;
    const rp = r.position;
    const side = hitSide(def, c, s, rp.x, rp.y, rp.z, PLAYER_RADIUS, baseY);
    if (side === 0) continue;
    hitUntil.set(key, now + ROVER_HIT_COOLDOWN_S);
    knockDir(c, s, side);
    game.bus.emit('ghost:damage', {
      id: r.id as PeerId, amount: 0, from: def.position.clone(),
      kb: { direction: _kb.clone(), speed: ROVER_HIT_KNOCKBACK * t },
    });
  }
}

/** 차체 OBB(+`radius`) 안이고 발 높이가 창 안이면 어느 옆구리인지(+1 / −1), 아니면 0. */
function hitSide(def: RoverVehicleDef, c: number, s: number, x: number, y: number, z: number, radius: number, baseY: number): number {
  if (y > baseY + FOOT_ABOVE || y < baseY - FOOT_BELOW) return 0;
  const dx = x - def.position.x, dz = z - def.position.z;
  const lx = dx * c + dz * s, lz = -dx * s + dz * c;
  if (Math.abs(lx) > ROVER_HALF_LENGTH + radius || Math.abs(lz) > ROVER_HALF_WIDTH + radius) return 0;
  return lz >= 0 ? 1 : -1;
}

/** 앞으로 밀면서 옆으로 던진다 — 그대로 앞으로만 밀면 계속 부딪힌다. */
function knockDir(c: number, s: number, side: number): void {
  _kb.set(c * 0.6 - s * side, 0, s * 0.6 + c * side).normalize();
}
