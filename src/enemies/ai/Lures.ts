import * as THREE from 'three';

/**
 * Noise beacons the bugs walk toward. Two sources feed it:
 * - `EnemyManagerRef.addDistraction` (lure grenade, loud gunfire, anything that wants aggro)
 * - `ctx.gadgets.findDistraction` (the authoritative lure deployable), queried live by `EnemySystem.lureFor`
 *
 * Entries are tiny and few (a handful at a time), so a flat array with squared-distance tests is cheaper
 * than any spatial structure and allocates nothing per frame.
 *
 * 2026-09-15 (땅굴벌레 등장 판정): 항목마다 `kind` 가 붙는다 — `'lure'` = 바깥에서 온 유인(유인 수류탄 배치물 ·
 * `addDistraction`), `'noise'` = 총성 · 폭발(`onGunshot`). 벌레 AI 는 둘을 구분하지 않고, `sandworm/Director` 만
 * `nearestLure` 로 유인 종류를 찾아 확률 가산 · 분출 자리 후보로 쓴다.
 */
export type LureKind = 'lure' | 'noise';

export interface LureEntry {
  readonly position: THREE.Vector3;
  radius: number;
  /** 0..1; the strongest lure inside its own radius wins. */
  weight: number;
  /** ctx.time when it stops pulling. */
  expires: number;
  /** 2026-09-15: 유인인가 총성인가 (같은 자리에 합쳐질 때는 유인이 이긴다). */
  kind: LureKind;
}

const MAX_LURES = 12;

export class LureField {
  private readonly entries: LureEntry[] = [];

  /** Add / refresh a lure. Returns the entry so the caller can wake nearby bugs. */
  add(pos: THREE.Vector3, radius: number, duration: number, weight: number, now: number, kind: LureKind = 'lure'): LureEntry {
    const w = THREE.MathUtils.clamp(weight, 0, 1);
    const r = Math.max(1, radius);
    // merge with an existing lure at (nearly) the same spot instead of stacking duplicates
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.position.distanceToSquared(pos) < 4) {
        e.radius = Math.max(e.radius, r);
        e.weight = Math.max(e.weight, w);
        e.expires = Math.max(e.expires, now + duration);
        if (kind === 'lure') e.kind = 'lure';
        return e;
      }
    }
    if (this.entries.length >= MAX_LURES) {
      // drop the weakest one
      let worst = 0;
      for (let i = 1; i < this.entries.length; i++) if (this.entries[i].weight < this.entries[worst].weight) worst = i;
      this.entries.splice(worst, 1);
    }
    const entry: LureEntry = { position: pos.clone(), radius: r, weight: w, expires: now + duration, kind };
    this.entries.push(entry);
    return entry;
  }

  /** Drop expired entries (called once per frame). */
  prune(now: number): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].expires <= now) this.entries.splice(i, 1);
    }
  }

  /**
   * Strongest lure whose radius covers `pos`. Writes its position into `out` and returns the weight
   * (0 when nothing pulls). Falls off linearly toward the edge of the radius so distant bugs prefer closer lures.
   */
  best(pos: THREE.Vector3, out: THREE.Vector3, now: number): number {
    let bestW = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.expires <= now) continue;
      const dx = e.position.x - pos.x, dz = e.position.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > e.radius * e.radius) continue;
      const w = e.weight * (1 - Math.sqrt(d2) / e.radius * 0.35);
      if (w > bestW) { bestW = w; out.copy(e.position); }
    }
    return bestW;
  }

  /**
   * 2026-09-15 (땅굴벌레): `(x, z)` 에서 `range` m 안의 살아 있는 **유인**(`kind 'lure'`) 중 가장 가까운 것의 자리를 `out` 에 쓴다.
   * 총성은 세지 않는다. 있으면 true.
   */
  nearestLure(x: number, z: number, range: number, now: number, out: THREE.Vector3): boolean {
    let best = range * range;
    let found = false;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.kind !== 'lure' || e.expires <= now) continue;
      const dx = e.position.x - x, dz = e.position.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > best) continue;
      best = d2; found = true; out.copy(e.position);
    }
    return found;
  }

  get count(): number { return this.entries.length; }

  clear(): void { this.entries.length = 0; }
}
