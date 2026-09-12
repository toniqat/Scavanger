/**
 * src/net/parts/CharBuffs.ts — **분대원의 버프 목록은 어떻게 오고 가는가** (캐릭터 버프, 2026-09-12). 설계: `docs/plans/char-buffs.md` §5.
 *
 *   내 목록 변경 ── `player:buffsChanged` ──▶ dirty ──(NetSystem.update, 스냅샷 **앞**)──▶ `cbuf state {rev, buffs}` → others
 *                                                  (한 프레임의 여러 변경은 한 번으로 — update 한 번에 한 번만 보낸다)
 *   20 Hz 스냅샷 `bfr` ── 받는 쪽 `onSnapshot(ref)`: `bfr ≠ ref.buffsRevision` (또는 스트림 재시작) → 그 사람에게 `cbufq sync`
 *                                                  (`CHAR_BUFF_SYNC_COOLDOWN_S` 에 한 번)
 *   `cbufq sync` ── 요청자에게만 내 `cbuf state` (요청자별 같은 쿨다운)
 *   `cbuf state` ── 로비 멤버만 · `sanitizeCharBuffs` · 더 낮은 rev 는 버림(단, 그 사람의 최신 스냅샷 `bfr` 와 같으면 받는다 —
 *                   새로고침으로 리비전 번호가 1 부터 다시 시작한 경우) → `entries` + ref 미러 → 목록이 실제로 바뀌었을 때만
 *                   `net:remoteBuffsChanged`
 *
 * 버프에는 게임 효과가 없으므로(사용자 결정) 권위 검사가 없다 — 로비 멤버 여부와 모양만 본다. 서버는 한 줄도 바뀌지 않는다:
 * 릴레이는 `relay` 봉투의 `d` 를 `t` 가 문자열인지만 보고 그대로 넘긴다 (`server/RelayServer.ts` 의 `relay` 검증).
 *
 * `entries` 는 ref 와 따로 산다: 함선 ↔ 레이드 전환마다 ref 가 지워지고 다시 만들어지는데(`clearRemotes`), 목록은 그 사이에 바뀌지
 * 않았으므로 새 ref 가 곧바로 물려받는다 (`mirror`) — 분대 목록의 썸네일이 깜빡이지 않고 요청도 나가지 않는다.
 */
import type { CharBuffMessage, CharBuffRequest, PeerId, RelayTarget } from '@/shared';
import type { CharBuff } from '@/shared';
import { CHAR_BUFF_SYNC_COOLDOWN_S, CHAR_BUFF_WIRE_MAX, sameCharBuffs, sanitizeCharBuffs } from '@/shared';
import type { NetSystem } from '../NetSystem';
import type { RemotePlayer } from '../RemotePlayer';
import { EMPTY_CHAR_BUFFS } from '../RemotePlayer';

interface Entry { rev: number; buffs: readonly CharBuff[] }

const nowS = (): number => performance.now() / 1000;

export class CharBuffRelay {
  private sys: NetSystem | null = null;
  private offs: Array<() => void> = [];
  /** My own list changed since the last `flush` (set by `player:buffsChanged`). */
  private dirty = false;
  /** Last accepted list + revision per lobby member (outlives the ref — see the file header). */
  readonly entries = new Map<PeerId, Entry>();
  /** `performance.now()` seconds of our last `cbufq sync` to each peer. */
  private readonly askedAt = new Map<PeerId, number>();
  /** `performance.now()` seconds of our last answer to each requester. */
  private readonly answeredAt = new Map<PeerId, number>();

  init(sys: NetSystem): void {
    this.sys = sys;
    this.offs.push(
      sys.ctx.bus.on('player:buffsChanged', () => { this.dirty = true; }),
      sys.onMessage('cbuf', (m, from) => this.onState(m, from)),
      sys.onMessage('cbufq', (m, from) => this.onRequest(m, from)),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.clear();
    this.dirty = false;
    this.sys = null;
  }

  /* ── 보내는 쪽 ─────────────────────────────────────────────────────────── */
  /**
   * `NetSystem.update`, **before** the snapshot: at most one `cbuf state` per frame however many `player:buffsChanged`
   * fired since. A change while offline / lobbyless is simply dropped — the next snapshot's `bfr` makes every receiver ask.
   */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.sendState('others');
  }

  private sendState(to: RelayTarget): void {
    const sys = this.sys;
    if (!sys || !sys.client.connected || !sys.lobby) return;   // `send()` would drop it too — skip the copy
    const p = sys.ctx.player;
    const list = p?.buffs ?? EMPTY_CHAR_BUFFS;
    const r = p?.buffsRevision;
    const rev = typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.floor(r) : 0;
    const msg: CharBuffMessage = { t: 'cbuf', ev: 'state', rev, buffs: list.slice(0, Math.max(0, Math.floor(CHAR_BUFF_WIRE_MAX))) };
    sys.send(msg, to);
  }

  /* ── 받는 쪽 ───────────────────────────────────────────────────────────── */
  private isMember(from: PeerId): boolean {
    const sys = this.sys;
    return !!sys && from !== sys.localId && !!sys.getLobbyPlayer(from);
  }

  private onState(m: CharBuffMessage, from: PeerId): void {
    const sys = this.sys;
    if (!sys || !m || typeof m !== 'object' || m.ev !== 'state' || !this.isMember(from)) return;
    if (typeof m.rev !== 'number' || !Number.isFinite(m.rev) || m.rev < 0) return;
    const rev = Math.floor(m.rev);
    const ref = sys.remotes.get(from);
    const prev = this.entries.get(from);
    // An older revision than ours is a late / stale copy — unless the sender's live snapshot says it IS at that revision
    // (a reload restarted its counter from 1).
    if (prev && rev < prev.rev && !(ref && ref.snapshotBuffsRev === rev)) return;
    const clean = sanitizeCharBuffs(m.buffs);
    const before = prev?.buffs ?? EMPTY_CHAR_BUFFS;
    const next = sameCharBuffs(before, clean) ? before : (clean.length === 0 ? EMPTY_CHAR_BUFFS : clean);
    this.entries.set(from, { rev, buffs: next });
    if (ref) { this.mirror(ref); ref.buffsResync = false; }   // an accepted list is the sender's current one
    if (next !== before) sys.ctx.bus.emit('net:remoteBuffsChanged', { id: from, buffs: next });
  }

  /** `cbufq sync`: answer the requester alone, at most once per `CHAR_BUFF_SYNC_COOLDOWN_S` per requester. */
  private onRequest(m: CharBuffRequest, from: PeerId): void {
    if (!this.sys || !m || typeof m !== 'object' || m.ev !== 'sync' || !this.isMember(from)) return;
    const now = nowS();
    const last = this.answeredAt.get(from);
    if (last !== undefined && now - last < CHAR_BUFF_SYNC_COOLDOWN_S) return;
    this.answeredAt.set(from, now);
    this.sendState(from);
  }

  /**
   * Every accepted `ps` (`parts/Messages`): the snapshot's `bfr` differs from the list we hold — or the stream restarted,
   * which makes an equal number meaningless — so ask that member for its list, once per `CHAR_BUFF_SYNC_COOLDOWN_S`.
   */
  onSnapshot(r: RemotePlayer): void {
    const sys = this.sys;
    if (!sys) return;
    if (r.snapshotBuffsRev === r.buffsRevision && !r.buffsResync) return;
    if (r.buffsResync && r.snapshotBuffsRev === 0 && r.buffsRevision === 0 && r.buffs.length === 0) { r.buffsResync = false; return; }
    const now = nowS();
    const last = this.askedAt.get(r.id);
    if (last !== undefined && now - last < CHAR_BUFF_SYNC_COOLDOWN_S) return;
    this.askedAt.set(r.id, now);
    const req: CharBuffRequest = { t: 'cbufq', ev: 'sync' };
    sys.send(req, r.id);
  }

  /** Copy the stored list onto `r` (a new ref after a scene change, or an accepted `cbuf state`). */
  mirror(r: RemotePlayer): void {
    const e = this.entries.get(r.id);
    if (!e) return;
    r.buffs = e.buffs;
    r.buffsRevision = e.rev;
  }

  /** `lobby:state` sweep: forget the members who are gone (same place the crew cards / ship visits are pruned). */
  prune(members: ReadonlySet<PeerId>): void {
    for (const map of [this.entries, this.askedAt, this.answeredAt] as Map<PeerId, unknown>[]) {
      for (const id of Array.from(map.keys())) if (!members.has(id)) map.delete(id);
    }
  }

  /** The lobby is gone. */
  clear(): void {
    this.entries.clear();
    this.askedAt.clear();
    this.answeredAt.clear();
  }
}
