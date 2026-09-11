/**
 * src/enemies/named/SniperShot.ts — **로든의 사격 · 조준경 반짝임 연출** (2026-09-11).
 *
 * 호스트(`ai/named/Sniper.fire`)와 리플리카(`ai/named/Sniper.onSniperEvent`)가 **같은 함수**로 그린다 — 한쪽만
 * 고치면 두 화면에서 다른 총성이 된다. 게임 상태는 하나도 바꾸지 않는다(피해는 호스트의 `fireGun` → `dmg`).
 *
 * - 트레이서 세 겹: 굵고 밝은 심지 · 넓고 흐린 탄연(가산 혼합이라 어두운 색 = 옅은 아지랑이) · 달려가는 섬광.
 * - 총구 섬광은 `FlashPool` 스프라이트만 쓴다 — **광원 세기 0** (씬의 광원 개수 규칙).
 * - 소리는 `playSniperAudio` 로 **실제 위치**에서 낸다. 멀리까지 들리는 거리 곡선은 `audio/AudioSystem` 의
 *   `RANGED_SOUNDS`(`sniper_shot` 900 m · `sniper_glint` 260 m, 전조용 `floor`)가 갖는다.
 */
import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import type { TargetList } from '../Targets';

/** `EnemyHost` 와 `ReplicaHost` 가 둘 다 만족하는 최소 모양. */
export interface SniperFxHost {
  readonly ctx: GameContext;
  readonly targets: TargetList;
  playAudio(id: string, position: THREE.Vector3, volume?: number, pitch?: number): void;
}

/** 탄착점이 로컬 플레이어에게서 이 거리(m) 안이면 화면이 흔들린다 (스쳐 간 탄). */
const NEAR_MISS_SHAKE_M = 8;

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _back = new THREE.Vector3();
const _g = new THREE.Vector3();

/**
 * 멀리서도 들리는 소리. **실제 위치로만 낸다** — `sniper_shot` / `sniper_glint` 의 거리 곡선(900 m · 260 m,
 * 전조가 들리게 하는 `floor`)은 `audio/AudioSystem` 의 `RANGED_SOUNDS` 가 갖는다. 위치를 청취자 쪽으로 당기면
 * 그 곡선이 무너진다. (함수로 남긴 것은 호출부를 한 곳에 모아 두려는 것이다.)
 */
export function playSniperAudio(host: SniperFxHost, id: string, at: THREE.Vector3, volume: number, pitch = 1): void {
  host.playAudio(id, at, volume, pitch);
}

/** 대물 저격총 한 발: 트레이서 · 총구 섬광 · 소염기 연기 · 엎드린 자리의 흙먼지 · 탄착 · 총성 · 스친 탄 흔들림. */
export function sniperShotFx(host: SniperFxHost, from: THREE.Vector3, to: THREE.Vector3, hit: boolean): void {
  const fx = FxManager.get();
  _dir.subVectors(to, from);
  const dist = _dir.length();
  if (dist > 1e-4) _dir.multiplyScalar(1 / dist); else _dir.set(0, 0, 1);
  if (fx) {
    fx.tracers.add(from, to, 0xfff2d6, 0.075, 0.28, 0);                    // 심지
    fx.tracers.add(from, to, 0x5a5448, 0.26, 0.75, 0);                     // 탄연
    fx.tracers.add(from, to, 0xffe0a0, 0.13, Math.min(0.6, dist / 900 + 0.06), 900);   // 달려가는 섬광
    fx.flashes.flash(from, 0xffd49a, 0, 2.2, 0.09);                        // 광원 세기 0 — 스프라이트만
    ParticleBurst.smoke(fx.alpha, from, 8, 0.9, 0x6b6456);
    ParticleBurst.sparks(fx.additive, from, _dir, 5, 8, 0xffd08a);
    // 엎드려 쏘면 총구 폭풍이 땅을 친다
    const world = host.ctx.world;
    if (world && world.ready) {
      _g.set(from.x, world.getHeightAt(from.x, from.z) + 0.05, from.z);
      if (from.y - _g.y < 1.2) ParticleBurst.dust(fx.alpha, _g, UP, 14, 1.6);
    }
    if (!hit) {
      _back.copy(_dir).negate();
      ParticleBurst.dust(fx.alpha, to, _back, 10, 1.3);
      ParticleBurst.sparks(fx.additive, to, _back, 4, 5);
    }
  }
  playSniperAudio(host, 'sniper_shot', from, 1);
  if (hit) host.playAudio('hit_flesh', to, 0.9, 0.75);
  const dl = host.targets.distToLocal(to);
  if (dl < NEAR_MISS_SHAKE_M) host.ctx.bus.emit('camera:shake', { intensity: 0.35 * (1 - dl / NEAR_MISS_SHAKE_M), duration: 0.25 });
}

/** 조준경 반짝임 소리 (반짝임 그림 자체는 `models/named/SniperLook` 의 스프라이트다). */
export function sniperGlintFx(host: SniperFxHost, at: THREE.Vector3, targetLocal: boolean): void {
  playSniperAudio(host, 'sniper_glint', at, targetLocal ? 0.9 : 0.45);
}
