/**
 * src/meta/parts/Intel.ts — **정보상**(레이븐이 파는 「행성 정보」 = 그 레이드의 기믹 고정).
 *
 * 계약은 `src/shared/intel.ts`(선택 · 해석 · 가격 식) + `shared/meta.ts` 의 `IntelRef` 이고, 결정은
 * `docs/DECISIONS.md` 「2026-09-14 — 정보상」 이다. 여기는 **보유 · 구매 · 폐기 · 소모**만 한다 — 월드에 닿는 길은
 * `ctx.missionIntel` 하나이고 그것을 세팅하는 곳은 출격(`hub/parts/Pods.launch`)과 수신(`net/parts/Lobby.beginSession`),
 * 솔로 이어하기(`game/parts/Session`)다.
 *
 * 규약 넷 —
 *  ① **한 번에 하나만** 갖는다. 이미 있는데 또 사면 환불 없이 덮어쓴다 (사용자 결정).
 *  ② **멀티에서는 분대장만** 사고 버린다 (탐사 차량 요금의 「결제자 한 명」 규약). 분대원은 `lobby.intel` 을 읽기만 한다.
 *  ③ 크레딧은 **릴레이의 답을 기다린다** (`MetaRef.creditsTx` — 암호화폐 매매와 같은 길). 거절되면 보유 정보를
 *     **바꾸지 않는다** — 산 것처럼 보였다가 서버에서 튕기면 그 시드로 출격해 놓고 기믹만 없는 맵이 된다.
 *  ④ 프로필에 산다 (`MetaSave.intel`). 새로고침 · 재접속을 견뎌야 한다 (「재접속으로 돌아온 사람이 조용히 무언가를
 *     잃으면 안 된다」) — `MetaStorage.snapshot()` 이 `data` 를 통째로 올리므로 `sanitizeMetaSave` 만 알면 된다.
 */
import type { GameContext, IntelGimmick, IntelPick, IntelRef, IntelSpec, IntelWire, PlanetId } from '@/shared';
import {
  INTEL_COST_TABLE, formatCreditReason, intelCode, intelCost, intelMaxTier, intelPlanetThreat, isPlanetId,
  resolveIntelEffects, sanitizeIntelPicks, sanitizeIntelSpec, intelSpecEqual, type IntelEffects,
} from '@/shared';
import type { MetaSystem } from '../MetaSystem';

/** 화면이 그대로 찍는 거절 사유. */
export const INTEL_REASON = {
  notHost: '분대장만 정보를 살 수 있습니다',
  inRaid: '레이드 중에는 정보를 살 수 없습니다',
  empty: '고정할 항목을 하나 이상 고르세요',
  credits: '크레딧이 부족합니다',
  pending: '결제를 처리하는 중입니다',
} as const;

export class Intel implements IntelRef {
  /** 결제가 릴레이에 나가 있는 동안 (이중 구매 방지 · 화면 딤드). */
  private pending = false;
  /** 이번 레이드가 보유 정보를 **실제로 쓰고** 출발했는가 (`game:newMission` 에서 판정 → 끝나면 소모). */
  private armed = false;
  /** 마지막 거절 사유 (화면의 한 줄). */
  lastRefusal: string | null = null;

  constructor(private readonly sys: MetaSystem) {}

  private get ctx(): GameContext { return this.sys.ctx; }

  /* ── 구독 ────────────────────────────────────────────────────────────── */
  subscribe(): Array<() => void> {
    const b = this.ctx.bus;
    return [
      // 서버 문서가 로컬 저장을 갈아 끼운 뒤 (Credits.onProfileLoaded 가 `store.replace` 한다) 화면을 다시 그린다
      b.on('net:profileLoaded', () => b.emit('intel:changed', { spec: this.get() })),
      b.on('game:newMission', ({ mode }) => { this.armed = mode !== 'training' && this.matchesMission(); }),
      b.on('game:complete', () => this.consumeIfArmed()),
      b.on('game:over', () => this.consumeIfArmed()),
      b.on('game:abort', () => this.consumeIfArmed()),
      // 함선에 들어오거나 로비가 바뀌면(합류 · 분대장 이관) 분대장이 자기 정보를 다시 올린다
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
   * 구매. **동기 답은 「요청이 받아들여졌는가」** 다 (상점 구매 · 임플란트 수리와 같은 규약) — 실제 확정은 릴레이의
   * 답을 받은 뒤 `intel:purchased` + `intel:changed` 로 온다. 거절이면 보유 정보가 그대로이고 `ui:notify` 가 사유를 띄운다.
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

  /** 「지역 재배치」 — 보유 정보를 버린다. **환불 없음** (사용자 결정). */
  discard(): void {
    if (!this.canEdit()) { this.refuse(INTEL_REASON.notHost); return; }
    this.clear();
  }

  /** 레이드가 이 정보를 썼다 (`game:complete` · `game:over` · `game:abort` 정산 뒤). */
  consume(): void { this.armed = false; this.clear(); }

  /** 결제가 아직 릴레이에 나가 있는가 (화면이 확정 버튼을 잠근다). */
  get isPending(): boolean { return this.pending; }

  /** 지금 이 클라이언트가 사고 버릴 수 있는가 (싱글이거나 분대장). */
  canEdit(): boolean {
    const net = this.ctx.net;
    if (!net || !net.lobby) return true;          // 싱글 · 로비 밖
    return net.isHost === true && net.lobby.started !== true;
  }

  /* ── 내부 ────────────────────────────────────────────────────────────── */

  /** 이 행성에서 살 수 없는 줄을 버리고 단계를 상한으로 자른다 (화면이 잘못 넘겨도 값이 새지 않는다). */
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
    this.sys.store.flush();            // 새로고침을 견뎌야 한다 — 산 즉시 프로필로 올린다
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

  /** 이 레이드가 보유 정보의 행성 · 시드로 떠났는가 (출격이 그렇게 실어 보낸다). */
  private matchesMission(): boolean {
    const spec = this.get();
    if (!spec) return false;
    return spec.planet === this.ctx.missionPlanet;
  }

  /** 분대장이면 `lobby.intel` 을 내 보유 정보와 맞춘다 (달라질 때만 보낸다 — `net:lobbyUpdated` 마다 불린다). */
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
