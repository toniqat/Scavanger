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
 *   - **로그 강하 예고** (`rogueDrop:incoming`). `적 강하 감지 — n초` 위험 토스트 + `wave_alarm`; 보스가 섞였으면
 *     문구에 `(분대장)` 이 붙는다. 화면 밖 화살표는 `hud/OffscreenIndicators` 가 `ctx.enemies.getRogueDrops()`
 *     를 직접 읽어 그린다 (강하는 살아 있는 목표라 이벤트 목록보다 그 질의가 정확하다).
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
      b.on('rogueDrop:incoming', ({ dropId, count, boss, eta }) => {
        if (this.announced.has(dropId)) return;
        this.announced.add(dropId);
        const who = boss ? `적 ${count}명 강하 감지 (분대장 포함)` : `적 ${count}명 강하 감지`;
        b.emit('ui:notify', { text: `${who} — ${Math.max(0, Math.ceil(eta))}초`, kind: 'danger', duration: 4 });
        b.emit('audio:play', { id: 'wave_alarm', volume: 0.8 });
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
