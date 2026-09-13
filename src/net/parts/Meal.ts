import * as THREE from 'three';
import type { MealMessage, PeerId } from '@/shared';
import { BUFF_RANGE_SLACK, MEAL_SERVE_RANGE, META_HIT_RATE, normalizeMealQuality } from '@/shared';
import type { NetSystem } from '../NetSystem';

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════════
 * 공유 함선 식탁 — `meal serve` 와이어 (A-3c, 2026-09-11)
 *
 * 한 명이 요리 하나를 소모해 「분대에 차리기」를 누르면(`housing:mealServed`) 그 자리에 있는 분대원 **전원**이
 * 같은 식사를 받는다 (사용자 결정). 규칙의 주인은 progression(`serveMeal`)이고, 이 파일은 **흐름만** 만든다.
 *
 * 권한은 E-4 「남에게 영향 주는 메시지는 권위에서만 받는다」 그대로다:
 *   차린 사람(비호스트) ──`meal req`──▶ 호스트 ──검사 후 `meal serve {who}`──▶ 사거리 안의 분대원들
 *   차린 사람이 호스트면 검사 없이 곧장 재방송(자기 행동이다).
 * 받는 쪽은 **로비 호스트가 보낸 것만** 받아들여 `ctx.progression.serveMeal(defId)` 를 부른다.
 *
 * 호스트가 보는 네 겹은 `shared/buffRules.createBuffGuard` 가 정한 순서 그대로다 — 모양 · 보낸 사람(연결된
 * 로비 멤버) · 자리(둘 다 **공유 데크** `hubSite === null`) + 거리(`MEAL_SERVE_RANGE + BUFF_RANGE_SLACK`) · 요율.
 * **새 상한을 코드에 적지 않는다**: 거리는 `MEAL_SERVE_RANGE`(식탁이 먹이는 반경, `data/constants.csv`)에
 * 버프와 같은 스냅샷 지연 여유 `BUFF_RANGE_SLACK` 을 더한 값이고, 요율은 피어가 보내는 비-피해 요청의 기존
 * 상한 `META_HIT_RATE`(초당 2건, 버스트 2배)를 그대로 쓴다. 식탁 전용 상수가 필요하다고 판단되면 계약(리드)이
 * 정할 일이지 이 파일이 정할 일이 아니다.
 *
 * 와이어는 계약이다 — `shared/net.ts` 의 `MealMessage` (`GameMessage` union 의 `DroneRequest` 다음 줄).
 * `req` = 비호스트 → 호스트(차렸다), `serve` = 호스트 → 사거리 안의 분대원(받아라, `who` = 차린 사람).
 * 서버는 한 줄도 바뀌지 않는다 — 기존 `relay` 봉투를 그대로 탄다.
 *
 * 2026-09-13 (요리 품질, docs/plans/cooking-minigames.md §3): 차린 요리의 **품질 그대로** 분대원이 받는다. `req` · `serve` 둘 다
 * `q`(별 1 … 5, 0 이면 생략)를 싣고, 받는 쪽은 `normalizeMealQuality` 로 자른 값을 `serveMeal(def, q)` 와 `housing:mealServed {quality}`
 * 에 넘긴다. 품질은 효과 배수뿐이라(최대 +25 %) 호스트가 따로 검사할 권위가 없다 — 모양 검사(정수 0 … `MEAL_QUALITY_MAX`)만 한다.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */

interface Bucket { tokens: number; at: number }

/** 식탁이 먹이는 거리(m): 데이터의 반경 + 버프와 같은 스냅샷 지연 여유. */
const SERVE_RANGE = MEAL_SERVE_RANGE + BUFF_RANGE_SLACK;
/** 보낸 사람별 `meal req` 요율(초당) · 버킷 크기(초) — `META_HIT_RATE` 의 문서 그대로 버스트는 2배다. */
const REQ_RATE = META_HIT_RATE;
const REQ_BURST_S = 2;

export class MealRelay {
  private sys: NetSystem | null = null;
  private offs: Array<() => void> = [];
  /** `serveMeal` 을 적용하면서 우리가 낸 `housing:mealServed` 를 다시 릴레이하지 않기 위한 재진입 가드. */
  private applying = false;
  /** 호스트 전용: 보낸 사람별 `meal req` 토큰 버킷. */
  private readonly buckets = new Map<PeerId, Bucket>();
  /** 두 개인 이유: 차린 사람의 자리와 받는 사람(나)의 자리를 **한 식에서 동시에** 재기 때문이다. */
  private readonly vFrom = new THREE.Vector3();
  private readonly vMe = new THREE.Vector3();

  init(sys: NetSystem): void {
    this.sys = sys;
    const bus = sys.ctx.bus;
    this.offs.push(
      bus.on('housing:mealServed', ({ defId, quality }) => this.onLocalServed(defId, normalizeMealQuality(quality))),
      // 로비를 떠나면 호스트 시절의 버킷은 의미가 없다.
      bus.on('net:lobbyLeft', () => this.buckets.clear()),
      sys.onMessage('meal', (m, from) => this.onWire(m, from)),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.buckets.clear();
    this.sys = null;
  }

  /* ── 보내는 쪽 ─────────────────────────────────────────────────────────── */
  /**
   * 내가 식탁에서 분대에 차렸다. **공유 함선의 데크에서만** 나간다 — 개인 함선 · 격납고에 정박한 남의 함선
   * 안(`hubSite !== null`) · 레이드 중에는 아무것도 보내지 않는다.
   */
  private onLocalServed(defId: string, quality: number): void {
    const sys = this.sys;
    if (!sys || this.applying) return;
    if (typeof defId !== 'string' || !defId) return;
    if (!this.onSharedDeck()) return;
    const me = sys.localId;
    if (!me) return;
    if (sys.isHost) {
      this.fanOut(defId, me, this.localPosition(this.vFrom), quality);
      return;
    }
    const msg: MealMessage = { t: 'meal', ev: 'req', def: defId };
    if (quality > 0) msg.q = quality;
    sys.send(msg, 'host');
  }

  /* ── 받는 쪽 ───────────────────────────────────────────────────────────── */
  private onWire(m: MealMessage, from: PeerId): void {
    const sys = this.sys;
    if (!sys || !m || typeof m !== 'object') return;                      // ① 모양
    const def = typeof m.def === 'string' ? m.def : '';
    if (!def || def.length > 64) return;
    if (!this.onSharedDeck()) return;
    const q = normalizeMealQuality(m.q);                                 // 2026-09-13 요리 품질 (없음 · 이상한 값 = 0)

    if (m.ev === 'req') {
      if (!sys.isHost) return;                                           // 요청은 호스트만 처리한다
      if (!this.senderIsSquad(from)) return;                             // ② 보낸 사람
      const at = this.peerPosition(from);
      if (!at) return;                                                   // ③ 자리 (공유 데크 + 스냅샷)
      if (!this.allow(from)) return;                                     // ④ 요율
      this.fanOut(def, from, at, q);
      return;
    }

    if (m.ev === 'serve') {
      // E-4: **로비 호스트가 보낸 것만**. 호스트 자신은 `fanOut` 에서 직접 적용하므로 여기 오지 않는다.
      const hostId = sys.lobby?.hostId ?? null;
      if (!hostId || from !== hostId || from === sys.localId) return;
      const who = typeof m.who === 'string' && m.who ? m.who : from;
      this.apply(def, who, q);
    }
  }

  /**
   * 호스트: 차린 사람(`who`, 위치 `at`)을 기준으로 `MEAL_SERVE_RANGE` 안에 있는 **같은 공유 데크의** 분대원에게만
   * 보낸다 (`MEAL_SERVE_RANGE` 의 계약 주석: 「호스트가 스냅샷 거리로 검사한다」). 차린 본인은 건너뛴다 —
   * 자기 몫은 housing 이 이미 로컬에서 처리했다.
   */
  private fanOut(defId: string, who: PeerId, at: THREE.Vector3 | null, quality: number): void {
    const sys = this.sys;
    if (!sys || !at) return;
    const me = sys.localId;
    for (const p of sys.lobby?.players ?? []) {
      if (p.id === who || p.connected === false) continue;
      if (p.id === me) {
        // 호스트 자신도 사거리 안이면 받는다.
        const mine = this.localPosition(this.vMe);
        if (mine && mine.distanceTo(at) <= SERVE_RANGE) this.apply(defId, who, quality);
        continue;
      }
      const pos = this.peerPosition(p.id);
      if (!pos || pos.distanceTo(at) > SERVE_RANGE) continue;
      const msg: MealMessage = { t: 'meal', ev: 'serve', def: defId, who };
      if (quality > 0) msg.q = quality;
      sys.send(msg, p.id);
    }
  }

  /**
   * 실제 적용: 규칙은 progression 의 것이고(`serveMeal`), 토스트는 ui 의 것이다 — 그래서 받은 쪽도
   * `housing:mealServed` 를 **차린 사람의 표시 이름**과 함께 다시 낸다 (`by` 의 계약이 그렇다).
   * 그 이벤트가 다시 릴레이되지 않도록 `applying` 으로 감싼다.
   */
  private apply(defId: string, who: PeerId, quality: number): void {
    const sys = this.sys;
    if (!sys) return;
    try { sys.ctx.progression?.serveMeal(defId, quality); } catch { /* progression 미준비 */ }
    const by = sys.getLobbyPlayer(who)?.name ?? sys.getRemotePlayer(who)?.name ?? '대원';
    this.applying = true;
    try { sys.ctx.bus.emit('housing:mealServed', { defId, by, quality }); } finally { this.applying = false; }
  }

  /* ── 질의 ──────────────────────────────────────────────────────────────── */
  /** 공유 함선의 **데크** 위인가 (로비 안 · 레이드 밖 · `hubSite === null`). */
  private onSharedDeck(): boolean {
    const sys = this.sys;
    if (!sys || !sys.inHubSession) return false;
    return (sys.ctx.hub?.hubSite ?? null) === null;
  }

  private localPosition(out: THREE.Vector3): THREE.Vector3 | null {
    const p = this.sys?.ctx.player;
    return p && !p.isDead ? out.copy(p.position) : null;
  }

  /** 보낸 사람이 연결된 로비 멤버인가 (나 자신은 아니다). */
  private senderIsSquad(from: PeerId): boolean {
    const sys = this.sys;
    if (!sys || from === sys.localId) return false;
    const m = sys.lobby?.players.find((p) => p.id === from);
    return !!m && m.connected !== false;
  }

  /** 그 피어의 마지막 스냅샷 위치 — **같은 공유 데크에 있을 때만**. */
  private peerPosition(id: PeerId): THREE.Vector3 | null {
    const ref = this.sys?.getRemotePlayer(id);
    if (!ref || ref.connected === false) return null;
    if ((ref.hubSite ?? null) !== null) return null;
    return ref.position;
  }

  /** 보낸 사람별 토큰 버킷 (호스트 전용). */
  private allow(from: PeerId): boolean {
    const now = performance.now() / 1000;
    const cap = REQ_RATE * REQ_BURST_S;
    let b = this.buckets.get(from);
    if (!b) { b = { tokens: cap, at: now }; this.buckets.set(from, b); }
    b.tokens = Math.min(cap, b.tokens + Math.max(0, now - b.at) * REQ_RATE);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
