import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext, ItemInstance } from '@/shared';
/* appended (2026-09-16): 빈 시체 제거 — 본편 시체와 같은 수치 */
import { CORPSE_EMPTY_REMOVE_DELAY_S, CORPSE_EMPTY_SINK_DEPTH_M, CORPSE_EMPTY_SINK_S } from '@/shared';
import { CORPSES, box, placed, type CorpseSpec } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * 손으로 놓은 시체 세 구 (2026-09-14, 튜토리얼).
 *
 * **컨테이너 굴림을 쓰지 않는다** — 튜토리얼이 주는 것은 정해져 있어야 한다. 그래서 내용물을
 * `ctx.loot.createItem` 으로 직접 만들어 `ctx.inventory.openContainerItems(id, items, position, title)` 에
 * 넘긴다 (적 시체 · 분대원 시체가 이미 쓰는 「내용물을 호출자가 대는 컨테이너」 경로 그대로다 — 인벤토리가
 * `containerId` 별로 남은 것을 캐시하므로 다시 열면 가져간 것이 빠져 있고, 비면 `crate:looted` 가 온다).
 *
 * id 접두사가 `corpse:` 라 `ui/hud/pillar.pillarAllowed` 가 빛기둥을 세운다 — 본편에서 시체만 기둥을 갖는
 * 규칙 그대로이고, 무기를 잃은 사람이 자기 시체를 찾아가는 것과 같은 길이다.
 * ──────────────────────────────────────────────────────────────────────────── */

interface Entry {
  spec: CorpseSpec;
  items: ItemInstance[];
  position: THREE.Vector3;
  emptied: boolean;
  /* appended (2026-09-16): 빈 시체 제거 */
  /** 비었을 때의 `ctx.missionTime` (-1 = 아직). */
  emptiedAt: number;
  /** 다 가라앉아 치웠다 (상호작용 해제 · 메시 제거). */
  removed: boolean;
  mesh: THREE.Mesh | null;
  geo: THREE.BufferGeometry | null;
}

/** 엎드린 병사 하나의 지오메트리 (머리는 +Z 쪽, `yaw` 로 돌린다). */
function corpseGeometry(yaw: number): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [
    box(0.62, 0.34, 1.0, 0, 0.17, 0.15),                       // 몸통
    box(0.5, 0.3, 0.66, 0, 0.15, -0.62),                       // 골반 · 허벅지
    box(0.2, 0.24, 0.7, -0.14, 0.12, -1.2, 0.12),              // 왼다리
    box(0.2, 0.24, 0.78, 0.16, 0.12, -1.24, -0.18),            // 오른다리
    box(0.18, 0.18, 0.62, -0.38, 0.1, 0.24, 0.5),              // 왼팔 (벌어져 있다)
    box(0.18, 0.18, 0.6, 0.38, 0.1, 0.1, -0.35),               // 오른팔
    box(0.66, 0.3, 0.42, 0, 0.2, 0.5),                         // 배낭 · 어깨
  ];
  const head = new THREE.SphereGeometry(0.17, 10, 8);
  parts.push(placed(head, 0, 0.17, 0.82));
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged) merged.rotateY(yaw);
  return merged;
}

export class TutorialCorpses {
  readonly group = new THREE.Group();
  private ctx: GameContext | null = null;
  private entries: Entry[] = [];
  private disposables: Array<{ dispose(): void }> = [];
  private unsub: (() => void) | null = null;

  constructor() { this.group.name = 'TutorialCorpses'; }

  build(ctx: GameContext, root: THREE.Group): void {
    this.ctx = ctx;
    root.add(this.group);
    const cloth = new THREE.MeshStandardMaterial({ color: 0x4b5240, roughness: 0.92, metalness: 0.08, emissive: 0x0d0f0b, emissiveIntensity: 0.7 });
    this.disposables.push(cloth);

    for (const spec of CORPSES) {
      const geo = corpseGeometry(spec.yaw);
      let mesh: THREE.Mesh | null = null;
      if (geo) {
        mesh = new THREE.Mesh(geo, cloth);
        mesh.name = spec.id;
        mesh.position.set(spec.x, spec.y, spec.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
      const entry: Entry = {
        spec,
        items: this.makeItems(ctx, spec),
        position: new THREE.Vector3(spec.x, spec.y + 0.3, spec.z),
        emptied: false,
        emptiedAt: -1, removed: false, mesh, geo,
      };
      this.entries.push(entry);
      ctx.interactables.register({
        id: spec.id,
        kind: 'corpse',
        position: entry.position,
        radius: 2.4,
        getPrompt: () => (entry.emptied ? '비어 있음' : `${spec.name} 뒤지기`),
        canInteract: () => !entry.emptied && ctx.isGameplayActive(),
        interact: () => {
          ctx.inventory?.openContainerItems(spec.id, entry.items, entry.position, spec.name);
          ctx.bus.emit('audio:play', { id: 'crate_open', position: entry.position.clone(), volume: 0.6 });
        },
      });
    }

    // 다 비운 시체는 프롬프트가 `비어 있음` 으로 바뀌고, 2026-09-16 부터 본편 시체처럼 가라앉아 사라진다 (`update`)
    this.unsub = ctx.bus.on('crate:looted', ({ crateId }) => {
      const e = this.entries.find((x) => x.spec.id === crateId);
      if (e && !e.emptied) { e.emptied = true; e.emptiedAt = ctx.missionTime; }
    });
  }

  /**
   * 2026-09-16 (빈 시체 제거, `TutorialWorld.update` 가 매 프레임): 빈 시체는 `CORPSE_EMPTY_REMOVE_DELAY_S` 뒤
   * `CORPSE_EMPTY_SINK_S` 동안 `CORPSE_EMPTY_SINK_DEPTH_M` 가라앉고, 끝나면 상호작용(= 빛기둥)을 풀고 메시와 지오메트리를 버린다.
   * 본편 플레이어 시체(`game/Corpses.PlayerCorpseObject.stepSink`)와 같은 곡선 · 같은 시계(`ctx.missionTime`)다.
   */
  update(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.missionTime;
    for (const e of this.entries) {
      if (!e.emptied || e.removed || e.emptiedAt < 0) continue;
      const elapsed = now - e.emptiedAt - CORPSE_EMPTY_REMOVE_DELAY_S;
      if (elapsed < 0) continue;
      const k = CORPSE_EMPTY_SINK_S > 0 ? Math.min(1, elapsed / CORPSE_EMPTY_SINK_S) : 1;
      if (e.mesh) e.mesh.position.y = e.spec.y - CORPSE_EMPTY_SINK_DEPTH_M * k * k;
      if (k < 1) continue;
      e.removed = true;
      ctx.interactables.unregister(e.spec.id);
      if (e.mesh) { e.mesh.removeFromParent(); e.mesh = null; }
      if (e.geo) { e.geo.dispose(); e.geo = null; }
    }
  }

  /** 고정 목록 → 실제 아이템. `'stack'` 은 그 def 의 `stackMax` 한 칸 가득 (탄약). */
  private makeItems(ctx: GameContext, spec: CorpseSpec): ItemInstance[] {
    const loot = ctx.loot;
    const out: ItemInstance[] = [];
    if (!loot) return out;
    for (const want of spec.items) {
      const def = loot.getItemDef(want.id);
      if (!def) continue;
      const qty = want.qty === 'stack' ? Math.max(1, def.stackMax) : want.qty;
      out.push(loot.createItem(want.id, qty));
    }
    return out;
  }

  dispose(): void {
    const ctx = this.ctx;
    this.unsub?.();
    this.unsub = null;
    for (const e of this.entries) {
      ctx?.interactables.unregister(e.spec.id);
      e.geo?.dispose();   // 2026-09-16: 시체마다 지오메트리를 들고 있다 (가라앉아 치운 것은 이미 null)
      e.geo = null; e.mesh = null;
    }
    this.entries.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
    this.group.removeFromParent();
    this.ctx = null;
  }
}
