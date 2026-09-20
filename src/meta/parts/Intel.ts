/**
 * src/meta/parts/Intel.ts — **the intel broker** (the 「행성 정보」 Raven sells = that raid's fixed gimmicks).
 *
 * The contract is `src/shared/intel.ts` (picks · resolving · the price formula) plus `IntelRef` in `shared/meta.ts`,
 * and the decision is `docs/DECISIONS.md` 「2026-09-14 — 정보상」. This file only **holds · buys · discards ·
 * consumes** — the one road to the world is `ctx.missionIntel`, and the places that set it are the launch
 * (`hub/parts/Pods.launch`), the receiving side (`net/parts/Lobby.beginSession`) and the solo resume
 * (`game/parts/Session`).
 *
 * Four rules —
 *  ① **one at a time**. Buying again over a held spec overwrites it with no refund (user's decision).
 *  ② **in multiplayer only the squad leader** buys and discards (the rover fare's 「one payer」 rule). A member only
 *     reads `lobby.intel`.
 *  ③ credits **wait for the relay's answer** (`MetaRef.creditsTx` — the same road as the crypto trades). On a refusal
 *     the held spec **does not change** — looking bought and then being bounced by the server would mean launching on
 *     that seed with the gimmicks missing.
 *  ④ it lives in the profile (`MetaSave.intel`) and has to survive a reload · a reconnect (「someone who came back
 *     through a reconnect must not silently lose something」) — `MetaStorage.snapshot()` uploads `data` whole, so
 *     `sanitizeMetaSave` is all that has to know about it.
 */
import type { GameContext, IntelGimmick, IntelPick, IntelRef, IntelSpec, IntelWire, PlanetId } from '@/shared';
import {
  INTEL_COST_TABLE, formatCreditReason, intelCode, intelCost, intelMaxTier, intelPlanetThreat, isPlanetId,
  resolveIntelEffects, sanitizeIntelPicks, sanitizeIntelSpec, intelSpecEqual, type IntelEffects,
} from '@/shared';
import type { MetaSystem } from '../MetaSystem';

/** The refusal reasons the screen prints verbatim. */
export const INTEL_REASON = {
  notHost: '분대장만 정보를 살 수 있습니다',
  inRaid: '레이드 중에는 정보를 살 수 없습니다',
  empty: '고정할 항목을 하나 이상 고르세요',
  credits: '크레딧이 부족합니다',
  pending: '결제를 처리하는 중입니다',
} as const;

export class Intel implements IntelRef {
  /** While the payment is out at the relay (no double purchase · the screen is dimmed). */
  private pending = false;
  /** Did this raid launch **actually using** the held spec (judged on `game:newMission` → consumed when it ends). */
  private armed = false;
  /** The last refusal reason (the screen's one line). */
  lastRefusal: string | null = null;

  constructor(private readonly sys: MetaSystem) {}

  private get ctx(): GameContext { return this.sys.ctx; }

  /* ── subscriptions ───────────────────────────────────────────────────── */
  subscribe(): Array<() => void> {
    const b = this.ctx.bus;
    return [
      // redraw the screen once the server document has swapped the local store out (`Credits.onProfileLoaded`
      // calls `store.replace`)
      b.on('net:profileLoaded', () => b.emit('intel:changed', { spec: this.get() })),
      b.on('game:newMission', ({ mode }) => { this.armed = mode !== 'training' && this.matchesMission(); }),
      b.on('game:complete', () => this.consumeIfArmed()),
      b.on('game:over', () => this.consumeIfArmed()),
      b.on('game:abort', () => this.consumeIfArmed()),
      // on ship entry, or when the lobby changes (a join · a host transfer), the squad leader pushes its held spec
      // again
      b.on('hub:entered', () => this.syncLobby()),
      b.on('net:lobbyUpdated', () => this.syncLobby()),
    ];
  }

  /* ── IntelRef ────────────────────────────────────────────────────────── */
  get(): IntelSpec | null { return sanitizeIntelSpec(this.sys.store.data.intel ?? null); }

  effects(): IntelEffects | null {
    const spec = this.get();
    return spec ? resolveIntelEffects(spec.picks) : null;
  }

  costOf(planet: PlanetId, picks: readonly IntelPick[]): number {
    return intelCost(intelPlanetThreat(planet), this.clamp(planet, picks), INTEL_COST_TABLE);
  }

  maxTierOf(g: IntelGimmick, planet: PlanetId): number { return intelMaxTier(g, planet); }

  /**
   * Buy. **The synchronous answer is 「was the request accepted」** (the same contract as a shop purchase and an
   * implant repair) — the real commit arrives after the relay's answer, as `intel:purchased` + `intel:changed`. On a
   * refusal the held spec stays as it is and `ui:notify` shows the reason.
   */
  buy(planet: PlanetId, seed: number, picks: readonly IntelPick[]): IntelSpec | null {
    this.lastRefusal = null;
    if (!isPlanetId(planet)) return this.refuse(INTEL_REASON.empty);
    if (this.pending) return this.refuse(INTEL_REASON.pending);
    if (this.ctx.isRaidActive()) return this.refuse(INTEL_REASON.inRaid);
    if (!this.canEdit()) return this.refuse(INTEL_REASON.notHost);
    const clean = this.clamp(planet, picks);
    if (clean.length === 0) return this.refuse(INTEL_REASON.empty);
    const cost = intelCost(intelPlanetThreat(planet), clean, INTEL_COST_TABLE);
    if (cost > this.sys.credits) return this.refuse(INTEL_REASON.credits);

    const spec: IntelSpec = { planet, seed: Math.floor(seed) >>> 0, picks: clean };
    const reason = formatCreditReason({ kind: 'intel', id: planet, code: intelCode(clean) });
    this.pending = true;
    void this.sys.creditsTx(-cost, reason).then((res) => {
      this.pending = false;
      if (!res.ok) {
        this.lastRefusal = res.reason || INTEL_REASON.credits;
        this.ctx.bus.emit('ui:notify', { text: `정보를 사지 못했습니다 — ${this.lastRefusal}`, kind: 'danger' });
        this.ctx.bus.emit('intel:changed', { spec: this.get() });
        return;
      }
      this.apply(spec, cost);
    }, () => { this.pending = false; });
    return spec;
  }

  /** 「지역 재배치」 — throws the held spec away. **No refund** (user's decision). */
  discard(): void {
    if (!this.canEdit()) { this.refuse(INTEL_REASON.notHost); return; }
    this.clear();
  }

  /** The raid used this spec (after the `game:complete` · `game:over` · `game:abort` settlement). */
  consume(): void { this.armed = false; this.clear(); }

  /** Is the payment still out at the relay (the screen locks its confirm button). */
  get isPending(): boolean { return this.pending; }

  /** Can this client buy and discard right now (single player, or the squad leader). */
  canEdit(): boolean {
    const net = this.ctx.net;
    if (!net || !net.lobby) return true;          // single player · outside a lobby
    return net.isHost === true && net.lobby.started !== true;
  }

  /* ── internals ───────────────────────────────────────────────────────── */

  /** Drops the lines this planet cannot sell and clamps the tier to its cap (a screen that passes the wrong thing
   *  still cannot leak a value through). */
  private clamp(planet: PlanetId, picks: readonly IntelPick[]): IntelPick[] {
    const out: IntelPick[] = [];
    for (const p of sanitizeIntelPicks(picks)) {
      const max = intelMaxTier(p.g, planet);
      if (max <= 0) continue;
      out.push(p.tier <= max ? p : { ...p, tier: max });
    }
    return out;
  }

  private refuse(reason: string): null {
    this.lastRefusal = reason;
    return null;
  }

  private apply(spec: IntelSpec, cost: number): void {
    this.sys.store.data.intel = spec;
    this.sys.store.markDirty();
    this.sys.store.flush();            // it has to survive a reload — uploaded to the profile the moment it is bought
    const b = this.ctx.bus;
    b.emit('intel:purchased', { spec, cost });
    b.emit('intel:changed', { spec });
    this.syncLobby();
  }

  private clear(): void {
    if (!this.sys.store.data.intel) return;
    this.sys.store.data.intel = null;
    this.sys.store.markDirty();
    this.sys.store.flush();
    this.ctx.bus.emit('intel:changed', { spec: null });
    this.syncLobby();
  }

  private consumeIfArmed(): void {
    if (!this.armed) return;
    this.consume();
  }

  /** Did this raid leave on the held spec's planet · seed (the launch is what carries it that way). */
  private matchesMission(): boolean {
    const spec = this.get();
    if (!spec) return false;
    return spec.planet === this.ctx.missionPlanet;
  }

  /** As the squad leader, matches `lobby.intel` to the held spec (sent only when it differs — this is called on
   *  every `net:lobbyUpdated`). */
  private syncLobby(): void {
    const net = this.ctx.net;
    if (!net || !net.lobby || net.lobby.started || net.isHost !== true) return;
    if (typeof net.setLobbyIntel !== 'function') return;
    const spec = this.get();
    const mine: IntelWire | null = spec ? { seed: spec.seed, picks: spec.picks } : null;
    const there = net.lobby.intel ?? null;
    const same = intelSpecEqual(
      mine ? { planet: 'x' as PlanetId, seed: mine.seed, picks: mine.picks } : null,
      there ? { planet: 'x' as PlanetId, seed: there.seed, picks: there.picks } : null,
    );
    if (same) return;
    net.setLobbyIntel(mine);
  }
}
