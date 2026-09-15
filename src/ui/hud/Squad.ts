import type { AllyBodyView, AllyRosterEntry, CharBuff, GameContext, LobbyPlayer, LobbyState, RemotePlayerRef } from '@/shared';
import { NET_MAX_PLAYERS, NET_SLOT_COLORS_CSS, PLAYER_DOWN_HP, PlayerFlags, SUSPENDED_LABEL_KO } from '@/shared';
/* 2026-09-15 (분대 · 도킹 매칭): 미도킹 분대 — 모두 제 개인 함선에 있다 */
import { isDockedLobby } from '@/shared';
/* 2026-09-15 (안드로이드 분대원): 봇 멤버는 사람 행이 아니다 · 명단은 `ctx.allies` 가 준다 */
import { ANDROID_BAY_COUNT, ALLY_DOWN_HP, isBotPlayer } from '@/shared';
import { allyBody, allyRoster } from './allySource';

/** Hub state of every member of an **undocked** squad (2026-09-15): nobody is in the shared ship yet. */
const SQUAD_PERSONAL_SHIP_KO = '개인 함선';
/** 2026-09-15: 안드로이드 행의 배지 · 상태 문구 (사람 행의 `훈련장` / `임무 중` / `함선` 과 같은 자리). */
const ANDROID_BADGE_KO = '안드로이드';
const ANDROID_DOWNED_KO = '쓰러짐';
const ANDROID_DEAD_KO = '사망';
import { GHOST_DEAD_LABEL_KO } from './Nameplates';
import { BuffStrip, type BuffCellState } from './BuffStrip';
import { el, setText, setVisible, toggleClass } from '../dom';

const REFRESH = 0.1; // seconds between DOM refreshes (≤ 10 Hz)

/** Per-member mission badge (Phase 7): where the member is relative to the running mission; 2026-09-15 + 안드로이드. */
export type SquadBadge = '' | '훈련장' | '임무 중' | '함선' | typeof ANDROID_BADGE_KO;

interface Row {
  root: HTMLElement; name: HTMLElement; badge: HTMLElement; fill: HTMLElement; bleed: HTMLElement; state: HTMLElement; lastKey: string;
  /** 2026-09-15 (안드로이드): 체력 바 위의 얇은 실드 바 — 사람 행에서는 숨는다 (`.has-shield` 가 붙지 않는다). */
  sh: HTMLElement; shFill: HTMLElement;
  /** 2026-09-12: member id the row shows (`''` = hidden) and its buff thumbnails under the hp bar (never on the local row). */
  id: string;
  strip: BuffStrip;
}

/** Per-row extras (2026-09-12): who the row is and that member's buff list + revision. */
interface RowExtra {
  id?: string; buffs?: readonly CharBuff[] | null; rev?: number;
  /** 2026-09-15: 안드로이드 행 — 실드 비율 (0 = 실드 바 없음). */
  shield?: number;
  android?: boolean;
}

/** Host-ghost overlay for a suspended member (Phase 9): `bleed` = down pool 0..1 while the ghost is downed (−1 = none). */
interface Ghost { bleed: number; dead: boolean }
const NO_GHOST: Ghost = { bleed: -1, dead: false };

/**
 * Compact squad list (bottom-left `.hud-bl` column, above the local vitals): slot colour bar, name, mission badge, hp bar, state text.
 * Local player first (from `ctx.player`), then lobby members by slot (`ctx.net.getRemotePlayer`).
 * Visible while `ctx.isMultiplayer` (mission) or in the shared ship (hub phase with a lobby); refreshed at ≤ 10 Hz
 * and only writes the DOM when a row changed. Hub states: `함선 내` / `탑승 준비` (`LobbyPlayer.ready`);
 * `연결 끊김` (`SUSPENDED_LABEL_KO`, `.off` grey) for `LobbyPlayer.connected === false` / `RemotePlayerRef.suspended`
 * (slot + body kept while the peer reconnects).
 *
 * Phase 7 badges: while the lobby is `started`, every row carries `훈련장` (`lobby.mode === 'training'` member with
 * `inMission`), `임무 중` (raid member) or `함선` (not in the running mission — `.badge.ship`). `LobbyPlayer.inMission`
 * undefined (older server) reads as `started && connected`. `net:lobbyUpdated` / `net:missionMembership` force the
 * next frame to refresh. `setDebug(lobby, refs)` feeds a synthetic lobby + refs for smoke tests.
 *
 * Phase 9: a suspended member's host ghost shows on the row — `ref.ghostState === 1` overlays a red bleed bar
 * (`.bleeding`, `ghostDownHp / PLAYER_DOWN_HP`) on the grey hp bar, `ghostState === 2` reads `사망` (`.suspended.dead`).
 *
 * 2026-09-12 (캐릭터 버프, 사용자 결정): every **squadmate** row carries a mini `BuffStrip` under its hp bar — `ref.buffs`
 * (net's `cbuf state`, a new array on change) drawn as-is; the local row has none (mine sit under the PC hp bar).
 * `net:remoteBuffsChanged` forces the next refresh; the row key carries `ref.buffsRevision`, and the strip itself compares
 * the list by reference, so a 10 Hz refresh never rebuilds a thumbnail.
 *
 * 2026-09-15 (안드로이드 분대원): bot lobby members are **never** drawn as human rows (they have no socket, so no
 * `RemotePlayerRef` ever arrives — the row would freeze on `연결 중`). They come last instead, one row per
 * `ctx.allies.roster` entry (`fillAndroidRows`): slot colour, an `안드로이드` badge, hp + a thin shield bar, and
 * `쓰러짐` / `사망`. The list also shows with **no lobby at all** when the dev cheat roster holds an android.
 */
export class Squad {
  readonly root: HTMLElement;
  private ctx: GameContext | null = null;
  private rows: Row[] = [];
  private acc = REFRESH;
  private shown = false;
  private unsubs: Array<() => void> = [];
  private debugLobby: LobbyState | null = null;
  private debugRefs = new Map<string, RemotePlayerRef>();

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'squad hidden', parent });
    el('div', { cls: 'ui-label', text: '분대', parent: this.root });
    // 2026-09-15: 사람 4 + 안드로이드 `ANDROID_BAY_COUNT` 기가 동시에 설 수 있다 (사람이 이겨 봇이 빠지기 전 한 프레임 포함).
    for (let i = 0; i < NET_MAX_PLAYERS + ANDROID_BAY_COUNT; i++) {
      const root = el('div', { cls: 'srow', parent: this.root });
      root.hidden = true;
      el('i', { cls: 'bar', parent: root });
      const body = el('div', { cls: 'body', parent: root });
      const top = el('div', { cls: 'top', parent: body });
      const name = el('span', { cls: 'name', text: '', parent: top });
      const badge = el('span', { cls: 'badge', text: '', parent: top });
      badge.hidden = true;
      const state = el('span', { cls: 'state', text: '', parent: top });
      const sh = el('div', { cls: 'sh', parent: body });
      const shFill = el('div', { cls: 'fill', parent: sh });
      const hp = el('div', { cls: 'hp', parent: body });
      const fill = el('div', { cls: 'fill', parent: hp });
      const bleed = el('div', { cls: 'bleed', parent: hp });
      const strip = new BuffStrip(body, { mini: true });
      this.rows.push({ root, name, badge, fill, bleed, state, sh, shFill, lastKey: '', id: '', strip });
    }
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.unsubs.push(
      ctx.bus.on('net:remoteBuffsChanged', () => { this.acc = REFRESH; }),
      ctx.bus.on('game:abort', () => this.reset()),
      ctx.bus.on('game:newMission', () => { this.acc = REFRESH; }),
      ctx.bus.on('net:lobbyUpdated', () => { this.acc = REFRESH; }),
      ctx.bus.on('net:missionMembership', () => { this.acc = REFRESH; }),
      ctx.bus.on('net:peerSuspended', () => { this.acc = REFRESH; }),
    );
  }

  /** Smoke-test hook: a synthetic lobby (+ refs by id, e.g. from `remotePlayers.debugSpawn`) shown instead of `ctx.net.lobby`. */
  setDebug(lobby: LobbyState | null, refs: readonly RemotePlayerRef[] = []): void {
    this.debugLobby = lobby;
    this.debugRefs.clear();
    for (const r of refs) this.debugRefs.set(r.id, r);
    this.acc = REFRESH;
    if (!lobby) this.reset();
  }

  update(dt: number, ctx: GameContext): void {
    const net = ctx.net;
    const hub = ctx.phase === 'hub' || ctx.phase === 'docking';
    const lobby = this.debugLobby ?? net?.lobby ?? null;
    /* 2026-09-15 (안드로이드 분대원): 치트 명단(`/android 1`)은 **서버도 로비도 없이** 개인 함선 · 솔로 레이드에
     * 존재한다 — 그래서 목록이 뜨는 조건에 「안드로이드가 한 기라도 있다」가 들어가고, `net` 이 null 이어도
     * 안드로이드 행만으로 그린다 (아래 사람 행 구간은 통째로 `net` 을 요구한다). */
    const roster = allyRoster(ctx);
    const mp = (!!net && (ctx.isMultiplayer || !!this.debugLobby || (hub && !!lobby))) || roster.length > 0;
    if (mp !== this.shown) { this.shown = mp; setVisible(this.root, mp); if (!mp) this.reset(); }
    if (!mp) return;
    this.acc += dt;
    if (this.acc < REFRESH) return;
    this.acc = 0;

    let i = 0;
    if (!net) { i = this.fillAndroidRows(ctx, roster, i); for (; i < this.rows.length; i++) this.hideRow(this.rows[i]); return; }
    // 2026-09-15: an undocked squad (docked absent = true, as on the wire) — every member is still in their own personal ship
    const personal = hub && !!lobby && !isDockedLobby(lobby);
    // local player first
    const p = ctx.player;
    const localLp = net.localId ? this.bySlotOrId(lobby?.players, net.localId) : undefined;
    const localState = !net.connected ? SUSPENDED_LABEL_KO
      : personal ? SQUAD_PERSONAL_SHIP_KO
      : hub ? (localLp?.ready ? '탑승 준비' : '함선 내')
      : p?.isDead ? '전사' : p?.isDropping ? '강하 중' : '';
    // Without a lobby entry for us (offline / debug lobby) our own membership is simply "are we in a mission phase".
    const localBadge = lobby ? this.badgeOf(lobby, localLp, ctx.isGameplayPhase() || ctx.phase === 'deploying') : '';
    this.fillRow(this.rows[i++], net.localSlot, net.playerName, hub ? 1 : p ? p.hp / Math.max(1, p.maxHp) : 1, localState, localBadge, true, NO_GHOST, { id: net.localId ?? 'local' });

    // squad members by slot (lobby list is the source of truth; the RemotePlayerRef may lag by a snapshot)
    const players = lobby?.players;
    if (players) {
      for (let slot = 0; slot < NET_MAX_PLAYERS && i < this.rows.length; slot++) {
        const lp = this.bySlot(players, slot);
        // 2026-09-15: 봇 멤버(안드로이드)는 소켓이 없어 `RemotePlayerRef` 가 영영 오지 않는다 — 사람 행으로 그리면
        // `연결 중` 으로 굳은 빈 줄이 된다. 봇은 아래 `fillAndroidRows` 가 `ctx.allies` 의 몸으로 그린다.
        if (!lp || lp.id === net.localId || isBotPlayer(lp)) continue;
        const isDebug = this.debugRefs.has(lp.id);
        const ref = isDebug ? this.debugRefs.get(lp.id) : net.getRemotePlayer(lp.id);
        const suspended = lp.connected === false || ref?.suspended === true;
        const ghost = suspended && !hub ? this.ghostOf(ref) : NO_GHOST;
        // a debug ref has no socket behind it — judge it on its own fields, not on our (offline) connection
        const state = suspended ? (ghost.dead ? GHOST_DEAD_LABEL_KO : SUSPENDED_LABEL_KO)
          : personal ? SQUAD_PERSONAL_SHIP_KO
          : hub ? (lp.ready ? '탑승 준비' : '함선 내') : this.remoteState(ref, net.connected || isDebug);
        const hp = hub ? 1 : ref ? ref.hp / Math.max(1, ref.maxHp) : 0;
        this.fillRow(this.rows[i++], slot, lp.name, hp, state, lobby ? this.badgeOf(lobby, lp, ref?.inMission) : '', false, ghost,
          { id: lp.id, buffs: ref?.buffs ?? null, rev: ref?.buffsRevision ?? 0 });
      }
    } else {
      // no lobby snapshot (should not happen in a session) — fall back to whatever refs exist
      for (const ref of net.getRemotePlayers()) {
        if (i >= this.rows.length) break;
        const ghost = ref.suspended ? this.ghostOf(ref) : NO_GHOST;
        const state = ref.suspended ? (ghost.dead ? GHOST_DEAD_LABEL_KO : SUSPENDED_LABEL_KO) : this.remoteState(ref, net.connected);
        this.fillRow(this.rows[i++], ref.slot, ref.name, ref.hp / Math.max(1, ref.maxHp), state, '', false, ghost,
          { id: ref.id, buffs: ref.buffs ?? null, rev: ref.buffsRevision ?? 0 });
      }
    }
    i = this.fillAndroidRows(ctx, roster, i);
    for (; i < this.rows.length; i++) this.hideRow(this.rows[i]);
  }

  /**
   * 2026-09-15 (안드로이드 분대원): 명단(`ctx.allies.roster`, bay 순) 한 기에 한 줄. 사람 행 **아래**에 붙는다.
   * 체력 · 실드는 그 기의 몸(`getBody`)에서 읽고, 몸이 아직 없으면(리플리카가 첫 `ally state` 를 못 받았다)
   * 체력 만땅 · 상태 빈칸으로 자리만 잡는다 — 사람 행의 `연결 중` 과 같은 뜻이다.
   */
  private fillAndroidRows(ctx: GameContext, roster: readonly AllyRosterEntry[], from: number): number {
    let i = from;
    for (const entry of roster) {
      if (i >= this.rows.length) break;
      const body: AllyBodyView | null = allyBody(ctx, entry.id);
      const hp = body ? body.hp / Math.max(1, body.maxHp) : 1;
      const shield = body && body.maxShield > 0 && !body.dead && !body.downed ? body.shield / body.maxShield : 0;
      const state = body?.dead ? ANDROID_DEAD_KO : body?.downed ? ANDROID_DOWNED_KO : '';
      // 쓰러졌으면 사람 행의 호스트 유령과 같은 붉은 출혈 바를 쓴다 (출혈 풀 = `ALLY_DOWN_HP`).
      const ghost: Ghost = body?.downed ? { bleed: Math.min(1, Math.max(0, body.downHp / Math.max(1, ALLY_DOWN_HP))), dead: false } : NO_GHOST;
      this.fillRow(this.rows[i++], entry.slot, entry.name, hp, state, ANDROID_BADGE_KO, false, ghost,
        { id: entry.id, shield, android: true });
    }
    return i;
  }

  private bySlot(players: readonly LobbyPlayer[], slot: number): LobbyPlayer | undefined {
    for (let k = 0; k < players.length; k++) if (players[k].slot === slot) return players[k];
    return undefined;
  }

  private bySlotOrId(players: readonly LobbyPlayer[] | undefined, id: string): LobbyPlayer | undefined {
    if (!players) return undefined;
    for (let k = 0; k < players.length; k++) if (players[k].id === id) return players[k];
    return undefined;
  }

  /** `훈련장` / `임무 중` / `함선` while a mission runs; empty while nothing is started. `refInMission` = fallback for an undefined `LobbyPlayer.inMission`. */
  private badgeOf(lobby: LobbyState, lp: LobbyPlayer | undefined, refInMission?: boolean): SquadBadge {
    if (!lobby.started) return '';
    const inMission = lp?.inMission ?? refInMission ?? (lp ? lp.connected !== false : false);
    if (!inMission) return '함선';
    return lobby.mode === 'training' ? '훈련장' : '임무 중';
  }

  /** Host-ghost overlay of a suspended ref (Phase 9): downed → bleed pool, dead → `사망`. */
  private ghostOf(ref: RemotePlayerRef | undefined): Ghost {
    if (!ref || ref.ghostState === undefined) return NO_GHOST;
    if (ref.ghostState === 2) return { bleed: -1, dead: true };
    if (ref.ghostState === 1) return { bleed: Math.min(1, Math.max(0, (ref.ghostDownHp ?? PLAYER_DOWN_HP) / PLAYER_DOWN_HP)), dead: false };
    return NO_GHOST;
  }

  private remoteState(ref: RemotePlayerRef | undefined, netUp: boolean): string {
    if (!netUp) return SUSPENDED_LABEL_KO;
    if (!ref) return '연결 중';
    if (ref.suspended || !ref.connected || ref.stale) return SUSPENDED_LABEL_KO;
    if (ref.isDead) return '전사';
    if (ref.flags & PlayerFlags.DROPPING) return '강하 중';
    return '';
  }

  private fillRow(row: Row, slot: number, name: string, hp01: number, state: string, badge: SquadBadge, me: boolean, ghost: Ghost = NO_GHOST, extra: RowExtra = {}): void {
    const hp = Math.min(1, Math.max(0, hp01));
    const bleeding = ghost.bleed >= 0;
    row.id = extra.id ?? '';
    // Reference-compared inside the strip (no-op for the same array); the 1 s gauge tick is gated in there too.
    row.strip.set(me ? null : (extra.buffs ?? null), this.ctx);
    row.strip.update(this.ctx);
    const android = extra.android === true;
    const shield = Math.min(1, Math.max(0, extra.shield ?? 0));
    const key = `${slot}|${name}|${hp.toFixed(2)}|${state}|${badge}|${me ? 1 : 0}|${bleeding ? ghost.bleed.toFixed(2) : '-'}|${me ? 0 : extra.rev ?? 0}|${android ? shield.toFixed(2) : '-'}`;
    if (key === row.lastKey) return;
    row.lastKey = key;
    row.root.hidden = false;
    row.root.style.setProperty('--sc', NET_SLOT_COLORS_CSS[slot] ?? '#fff');
    setText(row.name, me ? `${name} (나)` : name);
    setText(row.state, state);
    setText(row.badge, badge);
    row.badge.hidden = !badge;
    toggleClass(row.badge, 'ship', badge === '함선');
    toggleClass(row.badge, 'training', badge === '훈련장');
    toggleClass(row.badge, 'android', android);
    row.fill.style.transform = `scaleX(${hp.toFixed(3)})`;
    // 실드 바는 안드로이드 행에만 붙는다 (사람 행의 실드는 PC 체력 블록 · 이름표가 맡는다).
    toggleClass(row.root, 'android', android);
    toggleClass(row.root, 'has-shield', android && shield > 0);
    row.shFill.style.transform = `scaleX(${shield.toFixed(3)})`;
    toggleClass(row.root, 'me', me);
    toggleClass(row.root, 'dead', state === '전사' || state === ANDROID_DEAD_KO || ghost.dead);
    toggleClass(row.root, 'off', state === SUSPENDED_LABEL_KO || state === '연결 중' || ghost.dead);
    toggleClass(row.root, 'suspended', state === SUSPENDED_LABEL_KO || ghost.dead);
    toggleClass(row.root, 'bleeding', bleeding);
    row.bleed.style.transform = `scaleX(${(bleeding ? ghost.bleed : 0).toFixed(3)})`;
    toggleClass(row.root, 'drop', state === '강하 중');
    toggleClass(row.root, 'ready', state === '탑승 준비');
    toggleClass(row.root, 'low', hp < 0.4 && state !== '전사' && state !== ANDROID_DEAD_KO && !ghost.dead);
  }

  /** 2026-09-15 (debug / smoke): 지금 보이는 행들 — id · 이름 · 배지 · 상태 · 체력 · 실드 (DOM 순서). */
  get rowStates(): Array<{ id: string; name: string; badge: string; state: string; hp: string; shield: string; android: boolean }> {
    const out: Array<{ id: string; name: string; badge: string; state: string; hp: string; shield: string; android: boolean }> = [];
    for (const r of this.rows) {
      if (r.root.hidden) continue;
      out.push({
        id: r.id, name: r.name.textContent ?? '', badge: r.badge.hidden ? '' : (r.badge.textContent ?? ''),
        state: r.state.textContent ?? '', hp: r.fill.style.transform, shield: r.shFill.style.transform,
        android: r.root.classList.contains('android'),
      });
    }
    return out;
  }

  private hideRow(row: Row): void {
    if (row.lastKey === 'hidden') return;
    row.lastKey = 'hidden';
    row.root.hidden = true;
    row.id = '';
    row.strip.set(null, null);
  }

  private reset(): void { for (const r of this.rows) this.hideRow(r); this.acc = REFRESH; }

  /** Buff thumbnails on the visible row of member `id` (debug / smoke); null when no row shows that member. */
  buffStateOf(id: string): BuffCellState[] | null {
    for (const r of this.rows) if (!r.root.hidden && r.id === id) return r.strip.state;
    return null;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
