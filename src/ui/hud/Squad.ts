import type { CharBuff, GameContext, LobbyPlayer, LobbyState, RemotePlayerRef } from '@/shared';
import { NET_MAX_PLAYERS, NET_SLOT_COLORS_CSS, PLAYER_DOWN_HP, PlayerFlags, SUSPENDED_LABEL_KO } from '@/shared';
import { GHOST_DEAD_LABEL_KO } from './Nameplates';
import { BuffStrip, type BuffCellState } from './BuffStrip';
import { el, setText, setVisible, toggleClass } from '../dom';

const REFRESH = 0.1; // seconds between DOM refreshes (≤ 10 Hz)

/** Per-member mission badge (Phase 7): where the member is relative to the running mission. */
export type SquadBadge = '' | '훈련장' | '임무 중' | '함선';

interface Row {
  root: HTMLElement; name: HTMLElement; badge: HTMLElement; fill: HTMLElement; bleed: HTMLElement; state: HTMLElement; lastKey: string;
  /** 2026-09-12: member id the row shows (`''` = hidden) and its buff thumbnails under the hp bar (never on the local row). */
  id: string;
  strip: BuffStrip;
}

/** Per-row extras (2026-09-12): who the row is and that member's buff list + revision. */
interface RowExtra { id?: string; buffs?: readonly CharBuff[] | null; rev?: number }

/** Host-ghost overlay for a suspended member (Phase 9): `bleed` = down pool 0..1 while the ghost is downed (−1 = none). */
interface Ghost { bleed: number; dead: boolean }
const NO_GHOST: Ghost = { bleed: -1, dead: false };

/**
 * Compact squad list (top-left, under the objective): slot colour bar, name, mission badge, hp bar, state text.
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
    for (let i = 0; i < NET_MAX_PLAYERS; i++) {
      const root = el('div', { cls: 'srow', parent: this.root });
      root.hidden = true;
      el('i', { cls: 'bar', parent: root });
      const body = el('div', { cls: 'body', parent: root });
      const top = el('div', { cls: 'top', parent: body });
      const name = el('span', { cls: 'name', text: '', parent: top });
      const badge = el('span', { cls: 'badge', text: '', parent: top });
      badge.hidden = true;
      const state = el('span', { cls: 'state', text: '', parent: top });
      const hp = el('div', { cls: 'hp', parent: body });
      const fill = el('div', { cls: 'fill', parent: hp });
      const bleed = el('div', { cls: 'bleed', parent: hp });
      const strip = new BuffStrip(body, { mini: true });
      this.rows.push({ root, name, badge, fill, bleed, state, lastKey: '', id: '', strip });
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
    const mp = !!net && (ctx.isMultiplayer || !!this.debugLobby || (hub && !!lobby));
    if (mp !== this.shown) { this.shown = mp; setVisible(this.root, mp); if (!mp) this.reset(); }
    if (!mp || !net) return;
    this.acc += dt;
    if (this.acc < REFRESH) return;
    this.acc = 0;

    let i = 0;
    // local player first
    const p = ctx.player;
    const localLp = net.localId ? this.bySlotOrId(lobby?.players, net.localId) : undefined;
    const localState = !net.connected ? SUSPENDED_LABEL_KO
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
        if (!lp || lp.id === net.localId) continue;
        const isDebug = this.debugRefs.has(lp.id);
        const ref = isDebug ? this.debugRefs.get(lp.id) : net.getRemotePlayer(lp.id);
        const suspended = lp.connected === false || ref?.suspended === true;
        const ghost = suspended && !hub ? this.ghostOf(ref) : NO_GHOST;
        // a debug ref has no socket behind it — judge it on its own fields, not on our (offline) connection
        const state = suspended ? (ghost.dead ? GHOST_DEAD_LABEL_KO : SUSPENDED_LABEL_KO) : hub ? (lp.ready ? '탑승 준비' : '함선 내') : this.remoteState(ref, net.connected || isDebug);
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
    for (; i < this.rows.length; i++) this.hideRow(this.rows[i]);
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
    const key = `${slot}|${name}|${hp.toFixed(2)}|${state}|${badge}|${me ? 1 : 0}|${bleeding ? ghost.bleed.toFixed(2) : '-'}|${me ? 0 : extra.rev ?? 0}`;
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
    row.fill.style.transform = `scaleX(${hp.toFixed(3)})`;
    toggleClass(row.root, 'me', me);
    toggleClass(row.root, 'dead', state === '전사' || ghost.dead);
    toggleClass(row.root, 'off', state === SUSPENDED_LABEL_KO || state === '연결 중' || ghost.dead);
    toggleClass(row.root, 'suspended', state === SUSPENDED_LABEL_KO || ghost.dead);
    toggleClass(row.root, 'bleeding', bleeding);
    row.bleed.style.transform = `scaleX(${(bleeding ? ghost.bleed : 0).toFixed(3)})`;
    toggleClass(row.root, 'drop', state === '강하 중');
    toggleClass(row.root, 'ready', state === '탑승 준비');
    toggleClass(row.root, 'low', hp < 0.4 && state !== '전사' && !ghost.dead);
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
