import type { GameContext, LobbyPlayer, RemotePlayerRef } from '@/shared';
import { NET_MAX_PLAYERS, NET_SLOT_COLORS_CSS, PlayerFlags } from '@/shared';
import { el, setText, setVisible, toggleClass } from '../dom';

const REFRESH = 0.1; // seconds between DOM refreshes (≤ 10 Hz)

interface Row { root: HTMLElement; name: HTMLElement; fill: HTMLElement; state: HTMLElement; lastKey: string }

/**
 * Compact squad list (top-left, under the objective): slot colour bar, name, hp bar, state text.
 * Local player first (from `ctx.player`), then lobby members by slot (`ctx.net.getRemotePlayer`).
 * Visible only while `ctx.isMultiplayer`; refreshed at ≤ 10 Hz and only writes the DOM when a row changed.
 */
export class Squad {
  readonly root: HTMLElement;
  private rows: Row[] = [];
  private acc = REFRESH;
  private shown = false;
  private unsubs: Array<() => void> = [];

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
      const state = el('span', { cls: 'state', text: '', parent: top });
      const hp = el('div', { cls: 'hp', parent: body });
      const fill = el('div', { cls: 'fill', parent: hp });
      this.rows.push({ root, name, fill, state, lastKey: '' });
    }
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('game:abort', () => this.reset()),
      ctx.bus.on('game:newMission', () => { this.acc = REFRESH; }),
    );
  }

  update(dt: number, ctx: GameContext): void {
    const net = ctx.net;
    const mp = !!net && ctx.isMultiplayer;
    if (mp !== this.shown) { this.shown = mp; setVisible(this.root, mp); if (!mp) this.reset(); }
    if (!mp || !net) return;
    this.acc += dt;
    if (this.acc < REFRESH) return;
    this.acc = 0;

    let i = 0;
    // local player first
    const p = ctx.player;
    const localState = p?.isDead ? '전사' : p?.isDropping ? '강하 중' : !net.connected ? '연결 끊김' : '';
    this.fillRow(this.rows[i++], net.localSlot, net.playerName, p ? p.hp / Math.max(1, p.maxHp) : 1, localState, true);

    // squad members by slot (lobby list is the source of truth; the RemotePlayerRef may lag by a snapshot)
    const players = net.lobby?.players;
    if (players) {
      for (let slot = 0; slot < NET_MAX_PLAYERS && i < this.rows.length; slot++) {
        const lp = this.bySlot(players, slot);
        if (!lp || lp.id === net.localId) continue;
        const ref = net.getRemotePlayer(lp.id);
        this.fillRow(this.rows[i++], slot, lp.name, ref ? ref.hp / Math.max(1, ref.maxHp) : 0, this.remoteState(ref, net.connected), false);
      }
    } else {
      // no lobby snapshot (should not happen in a session) — fall back to whatever refs exist
      for (const ref of net.getRemotePlayers()) {
        if (i >= this.rows.length) break;
        this.fillRow(this.rows[i++], ref.slot, ref.name, ref.hp / Math.max(1, ref.maxHp), this.remoteState(ref, net.connected), false);
      }
    }
    for (; i < this.rows.length; i++) this.hideRow(this.rows[i]);
  }

  private bySlot(players: readonly LobbyPlayer[], slot: number): LobbyPlayer | undefined {
    for (let k = 0; k < players.length; k++) if (players[k].slot === slot) return players[k];
    return undefined;
  }

  private remoteState(ref: RemotePlayerRef | undefined, netUp: boolean): string {
    if (!netUp) return '연결 끊김';
    if (!ref) return '연결 중';
    if (!ref.connected || ref.stale) return '연결 끊김';
    if (ref.isDead) return '전사';
    if (ref.flags & PlayerFlags.DROPPING) return '강하 중';
    return '';
  }

  private fillRow(row: Row, slot: number, name: string, hp01: number, state: string, me: boolean): void {
    const hp = Math.min(1, Math.max(0, hp01));
    const key = `${slot}|${name}|${hp.toFixed(2)}|${state}|${me ? 1 : 0}`;
    if (key === row.lastKey) return;
    row.lastKey = key;
    row.root.hidden = false;
    row.root.style.setProperty('--sc', NET_SLOT_COLORS_CSS[slot] ?? '#fff');
    setText(row.name, me ? `${name} (나)` : name);
    setText(row.state, state);
    row.fill.style.transform = `scaleX(${hp.toFixed(3)})`;
    toggleClass(row.root, 'me', me);
    toggleClass(row.root, 'dead', state === '전사');
    toggleClass(row.root, 'off', state === '연결 끊김' || state === '연결 중');
    toggleClass(row.root, 'drop', state === '강하 중');
    toggleClass(row.root, 'low', hp < 0.4 && state !== '전사');
  }

  private hideRow(row: Row): void {
    if (row.lastKey === 'hidden') return;
    row.lastKey = 'hidden';
    row.root.hidden = true;
  }

  private reset(): void { for (const r of this.rows) this.hideRow(r); this.acc = REFRESH; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
