/**
 * src/world/rover/parts/Impact.ts — **being rammed by a running rover** (R2, 2026-09-13). The same frame as the tram's `rails/parts/Tram.updateTramHit`.
 *
 * - Below `ROVER_HIT_SPEED_MIN` nothing happens; above it the knockback and damage scale with `speed / ROVER_TRIP_SPEED`.
 * - **Players (the local one and disconnected squadmate ghosts) take knockback only, no damage** — being killed by a
 *   driverless automatic vehicle would feel unfair (lead's decision). Each client judges its own local body only.
 * - Enemies are judged by **the authority (single player · host) only**, for damage + knockback, `attacker = ROVER_DAMAGE_SOURCE` (no kill credit · aggro on the vehicle).
 * - Riders are not judged (their bodies are in the car's seats — `PlayerRef.roverRide` · the rider list).
 * - The cooldown is per target (`local` · `e:<id>` · `g:<PeerId>`).
 */
import * as THREE from 'three';
import {
  PLAYER_RADIUS, ROVER_DAMAGE_SOURCE, ROVER_HALF_LENGTH, ROVER_HALF_WIDTH, ROVER_HIT_COOLDOWN_S, ROVER_HIT_DAMAGE,
  ROVER_HIT_KNOCKBACK, ROVER_HIT_SPEED_MIN, ROVER_TRIP_SPEED,
  type GameContext, type PeerId, type RoverVehicleDef,
} from '@/shared';

const _kb = new THREE.Vector3();
const _from = new THREE.Vector3();
/** The foot-height window (relative to the body's floor, m) — only bodies this far above and this far below are hit. */
const FOOT_ABOVE = 1.4;
const FOOT_BELOW = 1.6;

/**
 * @param dir the travel direction (+1 / −1). The body yaw already carries the direction, so this is used for the knockback direction only.
 * @param riders the rider ids as this client sees them (`'local'` · PeerId).
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

/** Inside the body OBB (+`radius`) with the feet within the window: which flank (+1 / −1), else 0. */
function hitSide(def: RoverVehicleDef, c: number, s: number, x: number, y: number, z: number, radius: number, baseY: number): number {
  if (y > baseY + FOOT_ABOVE || y < baseY - FOOT_BELOW) return 0;
  const dx = x - def.position.x, dz = z - def.position.z;
  const lx = dx * c + dz * s, lz = -dx * s + dz * c;
  if (Math.abs(lx) > ROVER_HALF_LENGTH + radius || Math.abs(lz) > ROVER_HALF_WIDTH + radius) return 0;
  return lz >= 0 ? 1 : -1;
}

/** Pushes forwards while throwing the body sideways — pushing straight forwards alone keeps ramming it. */
function knockDir(c: number, s: number, side: number): void {
  _kb.set(c * 0.6 - s * side, 0, s * 0.6 + c * side).normalize();
}
