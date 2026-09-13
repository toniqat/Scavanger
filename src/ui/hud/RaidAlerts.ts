import type { GameContext, StructureKind } from '@/shared';
import { RAIL_LABEL_KO, STRUCTURE_LABEL_KO } from '@/shared';

/** 발생 빈도가 높은 종류는 토스트를 띄우지 않는다 (상자 · 채집물은 world/Fog 가 이미 그렇게 한다). */
const DISCOVER_TEXT: Readonly<Record<'structure' | 'rail' | 'grove', string>> = {
  structure: '구조물 발견',
  rail: '선로 발견',
  grove: '거대 버섯 군락 발견',
};

/**
 * **레이드 알림 (2026-09-09).** DOM 을 하나도 만들지 않는 순수 이벤트 → 토스트 변환기다 — 화면에 그리는 일은
 * 이미 있는 `hud/Notifications` (`ui:notify`) 가 한다. 두 가지를 맡는다:
 *
 *   - **새 랜드마크 발견** (`fog:discovered` 의 `structure` · `rail` · `grove`). 신호소 · 둥지의 토스트는
 *     `world/Fog` 의 `TOAST` 표가 띄우지만 이 셋은 world/ 가 아직 그 표에 넣지 않았고, 랜드마크 문구는 지도 ·
 *     나침반 마커와 같은 어휘를 써야 해서 ui/ 가 들고 있는다. 구조물은 `ctx.world.getStructures()` 에서
 *     `StructureKind` 를 찾아 `STRUCTURE_LABEL_KO`(버려진 전진기지 · 버려진 연구실 · 불시착한 함선)로 이름을
 *     붙이고, 못 찾으면 일반 문구로 떨어진다. **world/Fog 의 `TOAST` 에 이 세 종류를 넣으면 토스트가 두 번
 *     뜬다** — 넣지 않기로 한 자리다.
 *   - **레이더 강하 예고** (`rogueDrop:incoming`). `레이더 n명 강하 감지 — n초` 위험 토스트. 2026-09-13 부터 강하는
 *     레이더만 내리고 분대장(보스)이 섞이지 않으므로 `(분대장 포함)` 문구는 없어졌다 (이벤트 · 필드 이름은 계약이라
 *     `rogueDrop:*` · `boss` 그대로다). **2026-09-10 부터 소리는 여기서 내지 않는다** — `wave_alarm`(벌레 웨이브와
 *     같은 소리였다)을 걷어내고 `audio/AudioSystem` 이 같은 이벤트로 `rogue_drop_alarm` 을 울린다. 거리 감쇠가
 *     붙은 소리라 크기를 정할 수 있는 곳이 거기뿐이고, 한 사건에 두 폴더가 경보를 울리면 겹쳐 난다.
 *     화면 표시(화면 안 머리 마커 · 밖 방향 호)는 `hud/DangerIndicators` 가 `ctx.enemies.getRogueDrops()` 를
 *     직접 읽어 그린다 (강하는 살아 있는 목표라 이벤트 목록보다 그 질의가 정확하다).
 */
export class RaidAlerts {
  private unsubs: Array<() => void> = [];
  /** 마지막으로 알린 강하 (한 강하가 예고 · 착지로 두 번 오는 것을 걸러 낸다). */
  private announced = new Set<string>();

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('fog:discovered', ({ kind, id, position }) => {
        if (kind !== 'structure' && kind !== 'rail' && kind !== 'grove') return;
        let text = DISCOVER_TEXT[kind];
        if (kind === 'structure') {
          const sk = this.structureKind(ctx, id, position);
          if (sk) text = `${STRUCTURE_LABEL_KO[sk]} 발견`;
        } else if (kind === 'rail') {
          const line = ctx.world?.getRailLines().find((l) => l.id === id || l.platforms.some((p) => p.id === id));
          if (line) text = `${RAIL_LABEL_KO[line.kind]} 발견`;
        }
        b.emit('ui:notify', { text, kind: 'info', duration: 2.6 });
      }),
      b.on('rogueDrop:incoming', ({ dropId, count, eta }) => {
        if (this.announced.has(dropId)) return;
        this.announced.add(dropId);
        b.emit('ui:notify', { text: `레이더 ${count}명 강하 감지 — ${Math.max(0, Math.ceil(eta))}초`, kind: 'danger', duration: 4 });
      }),
      b.on('game:newMission', () => this.announced.clear()),
      b.on('game:abort', () => this.announced.clear()),
    );
  }

  /** 구조물 id (또는 그 위치)로 종류를 찾는다. world/ 가 아직 구조물을 만들지 않으면 null 이다. */
  private structureKind(ctx: GameContext, id: string, position: { x: number; z: number }): StructureKind | null {
    const list = ctx.world?.getStructures() ?? [];
    for (const s of list) if (s.id === id) return s.kind;
    return ctx.world?.structureAt(position.x, position.z)?.kind ?? null;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.unsubs = []; this.announced.clear(); }
}
