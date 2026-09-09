/**
 * src/player/RemotePods.ts — **아군의 강하 포드** (2026-09-09).
 *
 * 이 파일이 답하는 질문: *분대원이 강하할 때 내 화면에 무엇이 보이는가.*
 *
 * 2026-09-09 이전에는 원격 분대원이 그냥 자리에 나타났다. 이제 강하하는 사람이 `pod drop` 을 보내고
 * 여기서 **같은 헬포드**(`Hellpod`)를 떨어뜨린다 — 낙하 · 착지 충격 · 문 열림까지 로컬과 같은 연출이고,
 * 카메라 컷만 없다 (그건 떨어지는 본인만의 것이다).
 *
 * 아바타를 숨기는 일은 여기서 하지 않는다 — 강하 중인 분대원은 자기 스냅샷에 `PlayerFlags.DROPPING` 을
 * 실어 보내고 `RemoteAvatar` 가 이미 그 플래그로 몸을 감춘다. 문이 열리면 플래그가 내려가고 몸이 돌아온다.
 */
import * as THREE from 'three';
import type { GameContext, PeerId } from '@/shared';
import { Hellpod, type HellpodEvents } from './Hellpod';

/** 분대 최대 인원 − 나 = 동시에 존재할 수 있는 원격 포드 수. */
const MAX_REMOTE_PODS = 3;

interface Entry { pod: Hellpod; ev: HellpodEvents }

export class RemotePods {
  private readonly pods = new Map<PeerId, Entry>();

  constructor(private readonly scene: THREE.Object3D) {}

  get count(): number { return this.pods.size; }
  /** 이 분대원의 포드가 지금 떨어지는 중인가 (스모크 테스트 · 디버그). */
  isActive(id: PeerId): boolean { return this.pods.get(id)?.pod.isActive ?? false; }

  /**
   * `pod drop` 수신 — `id` 의 포드를 `position` 위로 떨어뜨린다. 같은 사람이 다시 강하하면
   * (구조선) 그 사람의 포드를 재사용하므로 인스턴스는 분대원 수를 넘지 않는다.
   */
  drop(ctx: GameContext, id: PeerId, position: THREE.Vector3, yaw: number, kind: 0 | 1): void {
    let e = this.pods.get(id);
    if (!e) {
      if (this.pods.size >= MAX_REMOTE_PODS) {
        // 자리가 없다: 이미 끝난 포드를 하나 회수한다 (없으면 이번 강하는 소리만 난다)
        for (const [otherId, other] of this.pods) {
          if (other.pod.isActive) continue;
          this.pods.delete(otherId);
          e = other;
          break;
        }
        if (!e) return;
      } else {
        e = { pod: new Hellpod(), ev: { impact: false, opened: false, finished: false } };
        this.scene.add(e.pod.group);
      }
      this.pods.set(id, e);
    }
    const landing = position.clone();
    if (ctx.world?.ready) landing.y = ctx.world.getHeightAt(landing.x, landing.z);
    e.pod.start(landing, yaw);
    ctx.bus.emit('net:remotePodDrop', { id, position: landing.clone(), yaw, kind });
    ctx.bus.emit('audio:play', { id: 'hellpod_fall', position: landing, volume: 0.7 });
  }

  update(dt: number, ctx: GameContext): void {
    if (this.pods.size === 0) return;
    for (const e of this.pods.values()) {
      if (!e.pod.isActive) continue;
      e.pod.update(dt, e.ev);
      if (e.ev.impact) ctx.bus.emit('audio:play', { id: 'hellpod_impact', position: e.pod.position, volume: 0.8 });
      if (e.ev.opened) ctx.bus.emit('audio:play', { id: 'hellpod_open', position: e.pod.position, volume: 0.6 });
    }
  }

  /** 미션 리셋: 포드 지오메트리 · 머티리얼 dispose. */
  clear(): void {
    for (const e of this.pods.values()) e.pod.dispose();
    this.pods.clear();
  }
}
