/**
 * src/player/SoldierPool.ts — **원격 아바타 몸 풀** (2026-09-10).
 *
 * 이 파일이 답하는 질문: *분대원이 함선 ↔ 행성을 오갈 때마다 병사 모델을 새로 지어야 하는가.*
 *
 * `RemotePlayerSystem` 은 `hub:entered` · `game:newMission` · `game:abort` 마다 아바타를 전부 버리고 다음 스냅샷에서
 * 다시 만든다 (위치가 남지 않게 하려는 규칙이라 그대로 둔다). 예전에는 그때마다 `SoldierModel` 이 메시 · 머티리얼을
 * 통째로 새로 만들었다 — 한 명당 메시 86개(몸 43 + 실루엣 43), 머티리얼 6개. 이제 아바타가 사라지면 몸은 여기로
 * **주차**되고(`release` → `SoldierModel.resetForReuse`), 같은 악센트의 아바타가 다시 생기면 그 몸을 꺼내 쓴다.
 *
 * 키는 **악센트 색** 하나다 — 생성자에서 구워지는 유일한 값이기 때문이다(`NET_SLOT_COLORS[slot]`). 악센트당
 * `NET_MAX_PLAYERS − 1` 개까지만 들고, 넘치는 몸은 그 자리에서 `dispose` 한다.
 */
import { NET_MAX_PLAYERS } from '@/shared';
import { SoldierModel } from './SoldierModel';

export class SoldierPool {
  private readonly parked = new Map<number, SoldierModel[]>();

  constructor(private readonly capPerAccent = NET_MAX_PLAYERS - 1) {}

  /** 주차된 몸의 총 수 (스모크 · 디버그). */
  get size(): number {
    let n = 0;
    for (const list of this.parked.values()) n += list.length;
    return n;
  }

  /** `accent` 로 구운 몸 하나 — 주차된 것이 있으면 그것을, 없으면 새로 짓는다. 씬에는 붙이지 않는다. */
  acquire(accent: number): SoldierModel {
    return this.parked.get(accent)?.pop() ?? new SoldierModel(accent);
  }

  /** 몸을 되돌린다: 인스턴스 상태를 생성 직후로 돌리고(씬에서도 떼어 낸다) 자리가 있으면 주차, 없으면 dispose. */
  release(model: SoldierModel): void {
    let list = this.parked.get(model.accentColor);
    if (!list) { list = []; this.parked.set(model.accentColor, list); }
    if (list.includes(model)) return;   // already parked (a double release must never hand one body to two avatars)
    model.resetForReuse();
    if (list.length >= this.capPerAccent) { model.dispose(); return; }
    list.push(model);
  }

  /** 시스템 종료: 주차된 몸을 전부 dispose. */
  dispose(): void {
    for (const list of this.parked.values()) for (const m of list) m.dispose();
    this.parked.clear();
  }
}
