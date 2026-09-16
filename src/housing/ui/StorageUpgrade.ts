import type { GameEventName } from '@/shared';
import { FACILITY_LABEL_KO, STASH_COLS, STASH_ROWS_BY_STORAGE_LEVEL } from '@/shared';
import { generatorRequirement, stashSizeFor } from '../Rules';
import { UpgradeModal } from './UpgradeModal';
import type { UpgradeSpec } from './UpgradeModal';
import type { HousingSystem } from '../HousingSystem';

/**
 * **창고 업그레이드 모달** (2026-09-16, 사용자 결정) — `HousingRef.openStorageUpgrade()` 의 구현.
 *
 * 부르는 곳이 **하우징 밖**이다: 인벤토리 Tab 화면의 창고 머리줄과 작업대 창의 머리줄이 「업그레이드」 한 줄로 이것만
 * 부른다. 그래서 가구 화면(`HousingPanel`)이 열려 있다고 가정하지 않고, 모달을 `ctx.uiRoot` 직계에 `standalone` 으로
 * 붙인다 (`UpgradeModalOptions` — `.interactive` · 인벤토리 창 위 z · Tab 도 스스로 닫기).
 *
 * 모양과 규칙은 **가구 업그레이드와 완전히 같다** (사용자 결정 「기존 모달을 재사용한다」): 재료 칩 · 발전기 요구 칩 ·
 * `UI_HOLD_CONFIRM_S` 홀드 확정 · Enter 삼킴 · Escape 는 `ctx.escape`. 여기서 정하는 것은 **내용**뿐이다.
 *
 * 열려 있는 동안 재료가 오갈 수 있으므로(가방 ↔ 창고 이동, 다른 화면에서의 제작) 아래 사건마다 다시 그린다. 구독은
 * 여는 순간 걸고 `onClose` 에서 끊는다 — 닫힌 모달이 버스를 계속 붙들지 않게.
 */
const REFRESH_EVENTS: readonly GameEventName[] = [
  'housing:changed', 'housing:facilityUpgraded', 'inventory:changed', 'inventory:stashChanged',
];

/** 이 레벨의 창고 칸 수 = `STASH_ROWS_BY_STORAGE_LEVEL[level] × STASH_COLS` (표에서만 읽는다 — 수를 적지 않는다). */
function cellsAt(level: number): number {
  const { cols, rows } = stashSizeFor(level);
  return cols * rows;
}

export class StorageUpgrade {
  private readonly modal: UpgradeModal;
  private offs: Array<() => void> = [];

  constructor(private readonly sys: HousingSystem) {
    this.modal = new UpgradeModal(sys.ctx, sys.ctx.uiRoot, sys, {
      standalone: true,
      onClose: () => this.unbind(),
    });
  }

  get isOpen(): boolean { return this.modal.isOpen; }

  /** 같은 「업그레이드」 버튼을 또 누르면 닫힌다 (버튼이 토글이다). */
  toggle(): void {
    if (this.modal.isOpen) { this.modal.close(); return; }
    const bus = this.sys.ctx.bus;
    for (const e of REFRESH_EVENTS) this.offs.push(bus.on(e, () => this.modal.refresh()));
    this.modal.open(() => this.spec(), () => this.run());
  }

  close(): void { this.modal.close(); }

  dispose(): void { this.unbind(); this.modal.dispose(); }

  private unbind(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  private spec(): UpgradeSpec | null {
    const info = this.sys.getFacility('storage');
    const atMax = info.level >= info.maxLevel;
    return {
      name: FACILITY_LABEL_KO.storage,
      level: info.level,
      maxLevel: info.maxLevel,
      // 다음 레벨이 여는 것 = 늘어나는 창고 칸. 앞뒤 칸 수는 표에서 센다.
      gain: atMax ? '' : `창고 칸 ${cellsAt(info.level)}칸 → ${cellsAt(info.level + 1)}칸`,
      cost: info.nextCost,
      // `blocked` 가 발전기 게이트 · 재료 부족을 이미 한국어 한 줄로 답한다 (`Rules.facilityBlockReason`).
      // 최대 레벨은 모달이 스스로 「최대 레벨입니다」로 말하므로 여기서 겹쳐 적지 않는다.
      reason: atMax ? null : info.blocked,
      // 가구 모달과 같은 발전기 요구 칩 — 채워진 요구도 `현재/필요` 로 보여 준다 (2026-09-14 규약).
      requirements: atMax ? [] : generatorRequirement(this.sys.state, info.level + 1),
    };
  }

  private run(): void {
    // 성공하면 `Rooms.upgrade` 가 `housing:stashSizeChanged` 를 쏘고 inventory 가 창고 격자를 그 크기로 맞춘다.
    if (this.sys.upgrade('storage')) this.sys.notify(`${FACILITY_LABEL_KO.storage}를 업그레이드했습니다`, 'success');
  }
}

export function openStorageUpgrade(sys: HousingSystem): void {
  if (!sys.ctx) return;
  // 표가 한 줄뿐이면 올릴 레벨이 없다 — 창을 띄우는 대신 아무 일도 하지 않는다.
  if (STASH_ROWS_BY_STORAGE_LEVEL.length <= 1 || STASH_COLS <= 0) return;
  sys.storageUpgrade ??= new StorageUpgrade(sys);
  sys.storageUpgrade.toggle();
}
