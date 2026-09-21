import type { ClientToServer, EventBus, LobbyState, PeerId, PlayerCode, PlayerTrustInfo, ServerToClient, TrustLikeError, TrustRef } from '@/shared';
import { PLAYER_TRUST_POINTS_MAX, PLAYER_TRUST_TABLE, TRUST_LIKE_ERROR_KO, isBotPlayer, isValidPlayerCode, playerTrustInfo } from '@/shared';

/** Longest name mirrored off the wire (the relay sanitizes to 16 — a guard against a hostile frame only). */
const NAME_MAX = 32;

/**
 * `ctx.net.trust` (2026-09-21): the client mirror of player ↔ player trust (`shared/playerTrust.ts` holds the rules).
 *
 * The relay owns every value; this class only keeps what it was told:
 *   - `onSnapshot(social)` → `SocialSnapshot.trust` (welcome + every `social:state`) replaces the pair map.
 *   - `onGain(m)`          → `trust:gain` updates one pair at once and emits `net:trustChanged` (the result screen animates it).
 *   - `onWindow(m)`        → `trust:window` — which squadmates of my last raid I may still like.
 *   - `onRefused(m)`       → `trust:refused` — the optimistic `liked` mark is taken back (except `already`) and
 *                            `net:trustRefused` carries the Korean line.
 *   - `onRaidStart(lobby, me)` → `game:start` of a raid I enter: the pair values are captured (`beforeRaid`), the mates
 *                            are the lobby's other humans, and the window is "unknown" until the relay answers.
 *   - `onDisconnected()`   → likes are refused locally until the next welcome (the values stay for display).
 *
 * `canLike` is optimistic before the relay's window arrives (every human mate of that raid), so the result screen can
 * draw its buttons at once; the relay is the judge either way.
 */
export class TrustSync implements TrustRef {
  private readonly points = new Map<PlayerCode, number>();
  private readonly atStart = new Map<PlayerCode, number>();
  private captured = false;
  private mates = new Set<PlayerCode>();
  private readonly liked = new Set<PlayerCode>();
  /** null = the relay has not spoken about this raid yet (optimistic), true / false = its `trust:window.open`. */
  private windowOpen: boolean | null = null;
  private live = false;

  /* ── wired by NetSystem ── */
  send: (msg: ClientToServer) => boolean = () => false;
  bus: EventBus | null = null;

  /* ── TrustRef ── */
  get(code: PlayerCode): PlayerTrustInfo { return this.infoOf(this.points.get(code) ?? 0); }
  infoOf(points: number): PlayerTrustInfo { return playerTrustInfo(points, PLAYER_TRUST_TABLE); }
  beforeRaid(code: PlayerCode): PlayerTrustInfo {
    return this.captured ? this.infoOf(this.atStart.get(code) ?? 0) : this.get(code);
  }
  canLike(code: PlayerCode): boolean {
    return this.live && this.windowOpen !== false && this.mates.has(code) && !this.liked.has(code);
  }
  hasLiked(code: PlayerCode): boolean { return this.liked.has(code); }
  like(code: PlayerCode): boolean {
    if (!this.canLike(code)) return false;
    if (!this.send({ t: 'trust:like', code })) return false;
    this.liked.add(code);   // optimistic; `trust:refused` takes it back
    this.bus?.emit('net:trustWindow', { open: this.windowOpen !== false });
    return true;
  }

  /* ── fed by NetSystem ── */
  /** `welcome.social` — absent (anonymous socket / a relay without a store) = likes stay off. */
  onWelcome(snapshot: unknown): void {
    this.live = typeof snapshot === 'object' && snapshot !== null;
    this.points.clear();
    this.onSnapshot(snapshot);
  }

  onSnapshot(snapshot: unknown): void {
    if (typeof snapshot !== 'object' || snapshot === null) return;
    const raw = (snapshot as { trust?: unknown }).trust;
    this.points.clear();
    if (typeof raw !== 'object' || raw === null) return;
    for (const [code, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!isValidPlayerCode(code) || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
      this.points.set(code, Math.min(PLAYER_TRUST_POINTS_MAX, Math.floor(v)));
    }
  }

  onGain(m: Extract<ServerToClient, { t: 'trust:gain' }>): void {
    if (!isValidPlayerCode(m.code) || typeof m.points !== 'number' || !Number.isFinite(m.points)) return;
    if (m.reason !== 'raid' && m.reason !== 'like') return;
    const points = Math.max(0, Math.min(PLAYER_TRUST_POINTS_MAX, Math.floor(m.points)));
    const delta = typeof m.delta === 'number' && Number.isFinite(m.delta) ? Math.floor(m.delta) : 0;
    this.points.set(m.code, points);
    if (m.reason === 'like' && m.mine === true) this.liked.add(m.code);
    const name = typeof m.name === 'string' ? m.name.slice(0, NAME_MAX) : '';
    const ev: { code: PlayerCode; name: string; points: number; delta: number; reason: 'raid' | 'like'; mine?: boolean } = { code: m.code, name, points, delta, reason: m.reason };
    if (m.reason === 'like' && typeof m.mine === 'boolean') ev.mine = m.mine;
    this.bus?.emit('net:trustChanged', ev);
  }

  onWindow(m: Extract<ServerToClient, { t: 'trust:window' }>): void {
    const codes = (v: unknown): PlayerCode[] => (Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && isValidPlayerCode(c)) : []);
    this.windowOpen = m.open === true;
    if (this.windowOpen) this.mates = new Set(codes(m.mates));
    this.liked.clear();
    for (const c of codes(m.liked)) this.liked.add(c);
    this.bus?.emit('net:trustWindow', { open: this.windowOpen });
  }

  onRefused(m: Extract<ServerToClient, { t: 'trust:refused' }>): void {
    const error = typeof m.error === 'string' && Object.prototype.hasOwnProperty.call(TRUST_LIKE_ERROR_KO, m.error) ? m.error as TrustLikeError : null;
    if (!error) return;
    if (error !== 'already' && isValidPlayerCode(m.code)) this.liked.delete(m.code);
    this.bus?.emit('net:trustRefused', { code: isValidPlayerCode(m.code) ? m.code : '', error, message: TRUST_LIKE_ERROR_KO[error] });
    this.bus?.emit('net:trustWindow', { open: this.windowOpen !== false });
  }

  /** A raid I enter just started (`game:start`, not a rejoin): capture the values and the human mates. */
  onRaidStart(lobby: LobbyState, me: PeerId | null): void {
    this.atStart.clear();
    for (const [c, p] of this.points) this.atStart.set(c, p);
    this.captured = true;
    const mates = new Set<PlayerCode>();
    for (const p of lobby.players) {
      if (p.id === me || isBotPlayer(p)) continue;
      if (typeof p.code === 'string' && isValidPlayerCode(p.code)) mates.add(p.code);
    }
    this.mates = mates;
    this.liked.clear();
    this.windowOpen = null;
    this.bus?.emit('net:trustWindow', { open: true });
  }

  onDisconnected(): void {
    this.live = false;
  }
}
