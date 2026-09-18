import type { GameContext, StructureKind } from '@/shared';
import { RAIL_LABEL_KO, STRUCTURE_LABEL_KO } from '@/shared';

/** Kinds that happen often raise no toast (crates · gather nodes are already handled that way by world/Fog). */
const DISCOVER_TEXT: Readonly<Record<'structure' | 'rail' | 'grove' | 'rover', string>> = {
  structure: '구조물 발견',
  rail: '선로 발견',
  grove: '거대 버섯 군락 발견',
  /* 2026-09-13 */
  rover: '탐사 차량 정류장 발견',
};

/** 2026-09-13: distance (m, to the vehicle) within which somebody else's rover fare toast arrives — silent for a distant squadmate. */
const ROVER_TRIP_NOTICE_M = 60;

/**
 * **Raid alerts (2026-09-09).** A pure event → toast converter that builds no DOM at all — drawing on screen is done by
 * the existing `hud/Notifications` (`ui:notify`). It handles three things:
 *
 *   - **A new landmark discovered** (`structure` · `rail` · `grove` · `rover` of `fog:discovered`). The `신호소` · nest
 *     toasts are raised by the `TOAST` table in `world/Fog`, but world/ has not put these four into that table and a
 *     landmark's text must use the same vocabulary as the map · compass markers, so ui/ holds them. A structure's
 *     `StructureKind` is looked up in `ctx.world.getStructures()` and named with `STRUCTURE_LABEL_KO` (버려진 전진기지 ·
 *     버려진 연구실 · 불시착한 함선); when it is not found the generic text is used. **Putting these kinds into
 *     `world/Fog`'s `TOAST` would raise the toast twice** — that is the spot deliberately left empty.
 *   - **A raider drop warning** (`rogueDrop:incoming`). The danger toast `레이더 n명 강하 감지 — n초`. Since 2026-09-13 a
 *     drop lands raiders only and mixes in no leader (boss), so the `(분대장 포함)` text is gone (the event · field names
 *     are a contract, so `rogueDrop:*` · `boss` stay). **Since 2026-09-10 the sound is not played here** — `wave_alarm`
 *     (which was the same sound as a bug wave) was taken out and `audio/AudioSystem` rings `rogue_drop_alarm` off the
 *     same event. It is a sound with distance falloff, so that is the only place its volume can be decided, and two
 *     folders alarming on one event would sound on top of each other.
 *     The on-screen part (head marker on screen · direction arc off screen) is drawn by `hud/DangerIndicators`, which
 *     reads `ctx.enemies.getRogueDrops()` directly (a drop is a live target, so that query is truer than an event list).
 *   - **The rover** (2026-09-13, `rover:*`). Stations revealed · a paid departure (riders and people within
 *     `ROVER_TRIP_NOTICE_M` of the vehicle only) · one's own arrival · destruction · one's own request refused · the
 *     50 % / 25 % hp warnings of the vehicle one rides (once per threshold per boarding).
 */
export class RaidAlerts {
  private unsubs: Array<() => void> = [];
  /** The drops already announced (it filters out one drop arriving twice, as a warning and as a landing). */
  private announced = new Set<string>();
  /* 2026-09-13: the rover */
  private roverAboard = false;
  private roverWarned = 0;          // 0 = none · 1 = the 50 % alert · 2 = the 25 % alert

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
      /* ── 2026-09-13: the rover ── */
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

  /** Finds the kind by structure id (or by its position). null while world/ has built no structure yet. */
  private structureKind(ctx: GameContext, id: string, position: { x: number; z: number }): StructureKind | null {
    const list = ctx.world?.getStructures() ?? [];
    for (const s of list) if (s.id === id) return s.kind;
    return ctx.world?.structureAt(position.x, position.z)?.kind ?? null;
  }

  private stationLabel(ctx: GameContext, id: string): string {
    for (const st of ctx.world?.rover?.route.stations ?? []) if (st.id === id) return st.label;
    return '정류장';
  }

  /** Whether the local player is aboard the rover or beside it (`ROVER_TRIP_NOTICE_M`). */
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
