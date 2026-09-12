/**
 * src/shared/lootRolls.ts — **루팅 굴림의 시드 식** (2026-09-12).
 *
 * 컨테이너 · 시체 내용물은 굴린 적 없는 채로 두었다가 **처음 열 때** 결정적으로 굴린다 — 같은 맵 시드 · 같은 id 면 어느
 * 클라이언트에서 열어도 같은 물건이 나온다. 2026-09-12 에 그 굴림을 **열지 않고 미리 보는** 곳이 둘 생겼다
 * (world 의 `previewContainerItems` · 지상 드론 스캔). 식이 폴더마다 복사돼 있으면 한쪽만 고쳐도 「스캔은 서사라는데 열어 보니
 * 없다」 가 되므로 `shared` 로 뽑았다 (CLAUDE.md: 같은 수식을 두 폴더가 쓰면 shared 로 뽑는다 — `ballistics` 와 같은 처리).
 *
 *   crateLootRandom   상자 · 구조물/플랫폼/전차 컨테이너 · 보급 상자 — inventory `ContainerStore.getOrCreate` · `parts/Peek` ·
 *                     world `structures/parts/Containers.rollCrateContents`
 *   corpseLootRandom  적 시체 — enemies `Corpses.Corpse.interact` · gadgets `drones/parts/Scan`
 *
 * 식 자체는 2026-09-12 이전과 **비트 단위로 같다** (`inventory/__selftest__` 의 고정 출력이 그대로다).
 */
import { Random } from './Random';

/** 컨테이너 `containerId` 의 내용물 굴림 rng — `(맵 시드 >>> 0) ^ hash(id)`. 이 rng 로 `LootRef.rollCrateOn(tier, rng, 행성)`. */
export function crateLootRandom(seed: number, containerId: string): Random {
  return new Random(((seed >>> 0) ^ Random.hash(containerId)) >>> 0);
}

/** 적 `enemyId` 시체의 내용물 굴림 rng — `맵 시드 ^ (enemyId × 2654435761)`, 0 이면 1. 이 rng 로 `LootRef.rollCorpseOn`. */
export function corpseLootRandom(seed: number, enemyId: number): Random {
  return new Random(((seed ^ (enemyId * 2654435761)) >>> 0) || 1);
}
