import type { GameContext, StructureKind } from '@/shared';
import { RAIL_LABEL_KO, STRUCTURE_LABEL_KO } from '@/shared';

/** 발생 빈도가 높은 종류는 토스트를 띄우지 않는다 (상자 · 채집물은 world/Fog 가 이미 그렇게 한다). */
const DISCOVER_TEXT: Readonly<Record<'structure' | 'rail' | 'grove' | 'rover', string>> = {
  structure: '구조물 발견',
  rail: '선로 발견',
  grove: '거대 버섯 군락 발견',
  /* 2026-09-13 */
  rover: '탐사 차량 정류장 발견',
};

/** 2026-09-13: 남이 낸 탐사 차량 요금 토스트를 받는 거리(m, 차체까지) — 멀리 있는 분대원에게는 조용하다. */
const ROVER_TRIP_NOTICE_M = 60;

/**
 * **레이드 알림 (2026-09-09).** DOM 을 하나도 만들지 않는 순수 이벤트 → 토스트 변환기다 — 화면에 그리는 일은
 * 이미 있는 `hud/Notifications` (`ui:notify`) 가 한다. 세 가지를 맡는다:
 *
 *   - **새 랜드마크 발견** (`fog:discovered` 의 `structure` · `rail` · `grove` · `rover`). 신호소 · 둥지의 토스트는
 *     `world/Fog` 의 `TOAST` 표가 띄우지만 이 넷은 world/ 가 아직 그 표에 넣지 않았고, 랜드마크 문구는 지도 ·
 *     나침반 마커와 같은 어휘를 써야 해서 ui/ 가 들고 있는다. 구조물은 `ctx.world.getStructures()` 에서
 *     `StructureKind` 를 찾아 `STRUCTURE_LABEL_KO`(버려진 전진기지 · 버려진 연구실 · 불시착한 함선)로 이름을
 *     붙이고, 못 찾으면 일반 문구로 떨어진다. **world/Fog 의 `TOAST` 에 이 종류들을 넣으면 토스트가 두 번
 *     뜬다** — 넣지 않기로 한 자리다.
 *   - **레이더 강하 예고** (`rogueDrop:incoming`). `레이더 n명 강하 감지 — n초` 위험 토스트. 2026-09-13 부터 강하는
 *     레이더만 내리고 분대장(보스)이 섞이지 않으므로 `(분대장 포함)` 문구는 없어졌다 (이벤트 · 필드 이름은 계약이라
 *     `rogueDrop:*` · `boss` 그대로다). **2026-09-10 부터 소리는 여기서 내지 않는다** — `wave_alarm`(벌레 웨이브와
 *     같은 소리였다)을 걷어내고 `audio/AudioSystem` 이 같은 이벤트로 `rogue_drop_alarm` 을 울린다. 거리 감쇠가
 *     붙은 소리라 크기를 정할 수 있는 곳이 거기뿐이고, 한 사건에 두 폴더가 경보를 울리면 겹쳐 난다.
 *     화면 표시(화면 안 머리 마커 · 밖 방향 호)는 `hud/DangerIndicators` 가 `ctx.enemies.getRogueDrops()` 를
 *     직접 읽어 그린다 (강하는 살아 있는 목표라 이벤트 목록보다 그 질의가 정확하다).
 *   - **탐사 차량** (2026-09-13, `rover:*`). 정류장 공개 · 결제 출발(탄 사람 · 차 곁 `ROVER_TRIP_NOTICE_M` 안의 사람만) ·
 *     내 도착 · 파괴 · 내 요청 거절 · 내가 탄 차의 체력 50 % / 25 % 경고(탑승 한 번에 문턱마다 한 번).
 */
export class RaidAlerts {
  private unsubs: Array<() => void> = [];
  /** 마지막으로 알린 강하 (한 강하가 예고 · 착지로 두 번 오는 것을 걸러 낸다). */
  private announced = new Set<string>();
  /* 2026-09-13: 탐사 차량 */
  private roverAboard = false;
  private roverWarned = 0;          // 0 = 없음 · 1 = 50 % 알림 · 2 = 25 % 알림

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('fog:discovered', ({ kind, id, position }) => {
        if (kind !== 'structure' && kind !== 'rail' && kind !== 'grove' && kind !== 'rover') return;
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
      /* ── 2026-09-13: 탐사 차량 ── */
      b.on('rover:stationsRevealed', () => {
        b.emit('ui:notify', { text: '모든 정류장 위치가 지도에 표시되었습니다', kind: 'info', duration: 3 });
      }),
      b.on('rover:boarded', ({ local, aboard }) => {
        if (!local) return;
        this.roverAboard = aboard;
        this.roverWarned = 0;
      }),
      b.on('rover:tripStarted', ({ name, toId, fare, local, grace }) => {
        const to = this.stationLabel(ctx, toId);
        const secs = Math.max(0, Math.ceil(grace));
        if (local) {
          b.emit('ui:notify', { text: `${fare} 크레딧 지불 · ${secs}초 뒤 ${to}(으)로 출발`, kind: 'success', duration: 3.5 });
          return;
        }
        if (!this.nearRover(ctx)) return;
        b.emit('ui:notify', { text: `${name} 님이 ${fare} 크레딧을 지불 · ${secs}초 뒤 ${to}(으)로 출발`, kind: 'info', duration: 3.5 });
      }),
      b.on('rover:arrived', ({ stationId, trip }) => {
        if (!trip || !(this.roverAboard || ctx.world?.rover?.localAboard)) return;
        b.emit('ui:notify', { text: `${this.stationLabel(ctx, stationId)} 도착 — 하차`, kind: 'success', duration: 3 });
      }),
      b.on('rover:destroyed', () => {
        b.emit('ui:notify', { text: '탐사 차량이 파괴되었습니다', kind: 'danger', duration: 4 });
      }),
      b.on('rover:refused', ({ reason }) => {
        b.emit('ui:notify', { text: reason, kind: 'warning', duration: 2.6 });
      }),
      b.on('rover:damaged', ({ hp, maxHp }) => {
        if (!(this.roverAboard || ctx.world?.rover?.localAboard) || maxHp <= 0 || hp <= 0) return;
        const f = hp / maxHp;
        if (f <= 0.25 && this.roverWarned < 2) {
          this.roverWarned = 2;
          b.emit('ui:notify', { text: '탐사 차량 체력 25% 이하 — 곧 파괴됩니다', kind: 'danger', duration: 3 });
        } else if (f <= 0.5 && this.roverWarned < 1) {
          this.roverWarned = 1;
          b.emit('ui:notify', { text: '탐사 차량 체력 50% 이하', kind: 'warning', duration: 2.6 });
        }
      }),
      b.on('game:newMission', () => this.reset()),
      b.on('game:abort', () => this.reset()),
    );
  }

  private reset(): void {
    this.announced.clear();
    this.roverAboard = false;
    this.roverWarned = 0;
  }

  /** 구조물 id (또는 그 위치)로 종류를 찾는다. world/ 가 아직 구조물을 만들지 않으면 null 이다. */
  private structureKind(ctx: GameContext, id: string, position: { x: number; z: number }): StructureKind | null {
    const list = ctx.world?.getStructures() ?? [];
    for (const s of list) if (s.id === id) return s.kind;
    return ctx.world?.structureAt(position.x, position.z)?.kind ?? null;
  }

  private stationLabel(ctx: GameContext, id: string): string {
    for (const st of ctx.world?.rover?.route.stations ?? []) if (st.id === id) return st.label;
    return '정류장';
  }

  /** 로컬 플레이어가 탐사 차량에 타 있거나 차 곁(`ROVER_TRIP_NOTICE_M`)에 있는가. */
  private nearRover(ctx: GameContext): boolean {
    const rv = ctx.world?.rover;
    const p = ctx.player;
    if (!rv || !p) return false;
    if (rv.localAboard) return true;
    const v = rv.vehicle.position;
    return Math.hypot(p.position.x - v.x, p.position.z - v.z) <= ROVER_TRIP_NOTICE_M;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.unsubs = []; this.reset(); }
}
