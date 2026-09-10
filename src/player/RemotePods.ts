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
 *
 * **포드는 처음부터 `MAX_REMOTE_PODS` 개가 씬에 있다** (2026-09-10). 헬포드마다 추진기 `PointLight` 가 하나씩 있어서,
 * 예전처럼 `pod drop` 을 받은 그 순간 `new Hellpod()` 을 씬에 넣으면 `numPointLights` 가 1 늘고 **씬의 모든
 * 머티리얼이 셰이더를 다시 컴파일했다** — 분대원마다 한 번씩, 레이드 중 임의의 프레임에(실측 2.7 · 3.1초 정지).
 * 그리고 `clear()` 가 매 미션 포드를 dispose 했으므로 다음 미션에서 똑같이 반복됐다. 이제 포드는 `init` 때 한 번
 * 씬에 들어가 광원 세기 0 · 몸 숨김으로 대기하고, `clear()` 는 **숨기기만** 한다 — 광원 개수가 절대 바뀌지 않는다
 * (`Hellpod` 의 `group` / `body` 규약, CLAUDE.md "씬의 광원 개수를 플레이 중에 바꾸지 않는다").
 */
import * as THREE from 'three';
import type { GameContext, PeerId } from '@/shared';
import { Hellpod, type HellpodEvents } from './Hellpod';

/** 분대 최대 인원 − 나 = 동시에 존재할 수 있는 원격 포드 수. */
const MAX_REMOTE_PODS = 3;

interface Entry { pod: Hellpod; ev: HellpodEvents; owner: PeerId | null }

export class RemotePods {
  /** 늘 `MAX_REMOTE_PODS` 개 — 생성자에서 만들고 `dispose` 전에는 줄지도 늘지도 않는다. */
  private readonly slots: Entry[] = [];
  private readonly byPeer = new Map<PeerId, Entry>();

  constructor(private readonly scene: THREE.Object3D) {
    for (let i = 0; i < MAX_REMOTE_PODS; i++) {
      const pod = new Hellpod();   // 광원 세기 0 · body 숨김으로 태어난다
      scene.add(pod.group);
      this.slots.push({ pod, ev: { impact: false, opened: false, finished: false }, owner: null });
    }
  }

  /** 지금 분대원에게 배정된 포드 수 (스모크 테스트 · 디버그). */
  get count(): number { return this.byPeer.size; }
  /** 이 분대원의 포드가 지금 떨어지는 중인가 (스모크 테스트 · 디버그). */
  isActive(id: PeerId): boolean { return this.byPeer.get(id)?.pod.isActive ?? false; }

  /**
   * `pod drop` 수신 — `id` 의 포드를 `position` 위로 떨어뜨린다. 같은 사람이 다시 강하하면
   * (구조선) 그 사람의 포드를 재사용한다. 비어 있는 포드가 없으면 이미 끝난 포드를 하나 회수하고,
   * 셋 다 떨어지는 중이면 이번 강하는 소리도 없이 넘어간다 (예전과 같다).
   */
  drop(ctx: GameContext, id: PeerId, position: THREE.Vector3, yaw: number, kind: 0 | 1): void {
    let e = this.byPeer.get(id);
    if (!e) {
      e = this.freeSlot();
      if (!e) return;
      if (e.owner !== null) this.byPeer.delete(e.owner);
      e.owner = id;
      this.byPeer.set(id, e);
    }
    const landing = position.clone();
    if (ctx.world?.ready) landing.y = ctx.world.getHeightAt(landing.x, landing.z);
    e.pod.start(landing, yaw);
    ctx.bus.emit('net:remotePodDrop', { id, position: landing.clone(), yaw, kind });
    ctx.bus.emit('audio:play', { id: 'hellpod_fall', position: landing, volume: 0.7 });
  }

  update(dt: number, ctx: GameContext): void {
    for (let i = 0; i < this.slots.length; i++) {
      const e = this.slots[i];
      if (!e.pod.isActive) continue;
      e.pod.update(dt, e.ev);
      if (e.ev.impact) ctx.bus.emit('audio:play', { id: 'hellpod_impact', position: e.pod.position, volume: 0.8 });
      if (e.ev.opened) ctx.bus.emit('audio:play', { id: 'hellpod_open', position: e.pod.position, volume: 0.6 });
    }
  }

  /**
   * 미션 리셋 · 함선 진입: 모든 포드를 **숨기고** 배정만 잊는다. dispose 하지 않는다 — 포드를 씬에서 빼면
   * 광원 개수가 바뀐다 (파일 머리말).
   */
  clear(): void {
    for (const e of this.slots) {
      e.pod.hide();
      e.owner = null;
      e.ev.impact = false; e.ev.opened = false; e.ev.finished = false;
    }
    this.byPeer.clear();
  }

  /** 시스템 종료 전용: 지오메트리 · 머티리얼 dispose + 씬에서 제거. */
  dispose(): void {
    for (const e of this.slots) e.pod.dispose();
    this.slots.length = 0;
    this.byPeer.clear();
  }

  /** 아무에게도 배정되지 않은 포드, 없으면 이미 착륙이 끝난 포드. 둘 다 없으면 undefined. */
  private freeSlot(): Entry | undefined {
    for (const e of this.slots) if (e.owner === null) return e;
    for (const e of this.slots) if (!e.pod.isActive) return e;
    return undefined;
  }
}
