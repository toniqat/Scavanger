/**
 * src/shared/corpseViewers.ts — **지금 누가 이 시체를 들여다보고 있나** (2026-09-16, 사용자 결정).
 *
 * 규칙: 빈 시체(플레이어 · 안드로이드 · 튜토리얼 · 적)는 **루팅이 끝난 뒤** — 들여다보던 마지막 사람이 창을 닫은 뒤 —
 * `CORPSE_EMPTY_REMOVE_DELAY_S` 기다렸다가 가라앉아 사라진다. 누가(나든 분대원이든) 창을 열어 두고 있는 동안은 사라지지 않는다.
 * 빈손으로 선 시체(아무도 연 적이 없다)는 예전처럼 선 순간부터 센다.
 *
 * 이 파일이 답하는 질문: *시체 종류마다(game · enemies · world/tutorial) 같은 「보는 사람」 판정을 어떻게 한 벌로 하는가.*
 *
 * - **로컬**: 인벤토리의 `inventory:opened {containerId}` / `inventory:closed` 만 듣는다 (inventory 내부를 보지 않는다). 창이
 *   그 컨테이너를 보여 주는 동안 = 본다. 안전망으로 `ctx.inventory.isOpen` 도 함께 본다 (닫기 사건을 놓쳐도 영원히 붙잡지 않게).
 * - **와이어** (`cviewq open|close`, 세션의 비호스트만 보낸다): 호스트는 시체 id → 보는 peer 집합을 들고 있다. 한 사람은 한 번에
 *   시체 하나만 본다(창이 하나다) — 그래서 표는 분대 인원보다 커지지 않는다.
 * - **호스트 가드** (`buffRules.createBuffGuard` 와 같은 순서): `open` = ① 모양(이 추적기가 맡는 id · 아는 시체) ② 보낸 사람(연결된
 *   살아 있는 스냅샷) ③ 거리(`CORPSE_EMPTY_REQUEST_REACH_M`, 수평) ④ 요율(보낸 사람별 버킷 `CORPSE_EMPTY_REQUEST_RATE_MAX` /
 *   `_BURST`). `close` 는 보낸 사람 **자기** 항목만 지우므로 모양만 본다. 다른 추적기가 맡는 id 는 거절이 아니라 무시다.
 * - **호스트 정리**: 떠남(`net:peerLeft`) · 끊김(`net:peerSuspended`) · 재합류(`flow rejoined` — 새로 뜬 창은 닫혀 있다) ·
 *   사망 · 스냅샷이 사라짐 · 거리 이탈이면 그 사람의 항목을 스스로 지운다 (`update`). 닫기 와이어를 잃어도 시체가 영원히 남지 않는다.
 * - **호스트 이관**: 새 호스트는 표가 비어 있다 — 창을 열어 둔 클라이언트가 `net:hostChanged` 에 `open` 을 다시 보낸다.
 * - 판정을 **쓰는 쪽**(치울지 말지)은 각 폴더다: `game/Corpses` · `enemies/parts/CorpseEmpty` · `world/tutorial/parts/Corpses`.
 *   서로 맡는 id 가 겹치지 않아야 한다 (같은 창 열기를 두 번 보내지 않게) — `pcorpse:` / `corpse:<숫자>` / 튜토리얼 손 시체 id.
 */
import type * as THREE from 'three';
import type { GameContext } from './GameContext';
import {
  CORPSE_EMPTY_REQUEST_BURST, CORPSE_EMPTY_REQUEST_RATE_MAX, CORPSE_EMPTY_REQUEST_REACH_M,
} from './constants';
import type { CorpseViewRequest, NetRef, PeerId } from './net';

export interface CorpseViewTrackerOptions {
  /** 이 추적기가 맡는 컨테이너 id 인가 (다른 추적기와 겹치면 안 된다). */
  matches(containerId: string): boolean;
  /** 그 시체의 지금 자리 (모르는 시체 = null). 호스트의 거리 가드 · 거리 이탈 정리가 쓴다. */
  positionOf(containerId: string): THREE.Vector3 | null;
  /** false = 와이어 없이 로컬만 (튜토리얼 손 시체). 기본 true. */
  net?: boolean;
}

interface Bucket { tokens: number; at: number }

export class CorpseViewTracker {
  /** 내 창이 지금 보여 주는 (이 추적기가 맡는) 시체 id. */
  private local: string | null = null;
  /** 호스트: 시체 id → 보고 있는 원격 peer. */
  private readonly remote = new Map<string, Set<PeerId>>();
  private readonly buckets = new Map<PeerId, Bucket>();
  private readonly unsubs: Array<() => void> = [];
  private netUnsubs: Array<() => void> = [];
  private hookedNet: NetRef | null = null;
  /** 호스트가 거절한 `cviewq open` 수 (스모크 · 디버그용 — 거절된 요청은 아무것도 하지 않는다). */
  refused = 0;

  constructor(private readonly ctx: GameContext, private readonly opts: CorpseViewTrackerOptions) {
    const bus = ctx.bus;
    this.unsubs.push(
      bus.on('inventory:opened', ({ containerId }) =>
        this.setLocal(containerId && opts.matches(containerId) ? containerId : null)),
      bus.on('inventory:closed', () => this.setLocal(null)),
      bus.on('game:newMission', () => this.reset()),
      bus.on('game:abort', () => this.reset()),
    );
    if (opts.net !== false) {
      this.unsubs.push(
        bus.on('net:peerLeft', ({ id }) => this.dropPeer(id)),
        bus.on('net:peerSuspended', ({ id, suspended }) => { if (suspended) this.dropPeer(id); }),
        bus.on('net:hostChanged', ({ isLocalHost }) => {
          this.remote.clear();
          this.buckets.clear();
          // 새 호스트는 누가 보고 있는지 모른다 — 창을 열어 둔 사람이 다시 알린다
          if (!isLocalHost && this.local && this.sends()) this.ctx.net!.send({ t: 'cviewq', ev: 'open', id: this.local }, 'host');
        }),
      );
      this.hookNet();
    }
  }

  /** 내 창이 지금 `id` 를 보여 주고 있는가. */
  isLocalViewing(id: string): boolean {
    return this.local === id && !!this.ctx.inventory?.isOpen;
  }

  /** 내 창이 보여 주는 (이 추적기가 맡는) 시체 id, 없으면 null. 매 프레임 문자열을 만들지 않고 비교할 때 쓴다. */
  get localViewing(): string | null {
    return this.local !== null && this.ctx.inventory?.isOpen ? this.local : null;
  }

  /**
   * 누가든 `id` 를 보고 있는가. 호스트 · 싱글은 전원을 안다. 세션의 비호스트는 자기 창만 안다 — 그쪽은 치우는 시점을 호스트의
   * 방송이 정하므로 그것으로 충분하다.
   */
  isViewed(id: string): boolean {
    if (this.isLocalViewing(id)) return true;
    if (!this.hosting()) return false;
    const set = this.remote.get(id);
    return !!set && set.size > 0;
  }

  /** 호스트: `id` 를 보고 있는 원격 peer 수 (스모크 · 디버그용). */
  remoteViewers(id: string): number { return this.remote.get(id)?.size ?? 0; }

  /** 매 프레임 (쓰는 쪽의 `update`): 늦게 생긴 `ctx.net` 에 붙고, 호스트면 떠났거나 멀어진 사람의 항목을 지운다. */
  update(): void {
    if (this.opts.net === false) return;
    this.hookNet();
    if (this.remote.size === 0) return;
    if (!this.hosting()) { this.remote.clear(); return; }
    const net = this.ctx.net!;
    const reach2 = CORPSE_EMPTY_REQUEST_REACH_M * CORPSE_EMPTY_REQUEST_REACH_M;
    for (const [id, set] of this.remote) {
      const at = this.opts.positionOf(id);
      for (const peer of set) {
        const ref = net.getRemotePlayer(peer);
        const gone = !at || !ref || ref.connected === false || ref.isDead
          || (ref.position.x - at.x) ** 2 + (ref.position.z - at.z) ** 2 > reach2;
        if (gone) set.delete(peer);
      }
      if (set.size === 0) this.remote.delete(id);
    }
  }

  /** 미션 리셋: 표를 비운다 (와이어는 보내지 않는다). */
  reset(): void {
    this.local = null;
    this.remote.clear();
    this.buckets.clear();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const u of this.netUnsubs) u();
    this.netUnsubs = [];
    this.hookedNet = null;
    this.reset();
  }

  /* ── 내부 ────────────────────────────────────────────────────────────────────────────────────────────── */

  private hosting(): boolean {
    return this.opts.net !== false && this.ctx.isMultiplayer && !!this.ctx.net?.isHost;
  }

  /** 세션의 비호스트만 호스트에게 알린다. */
  private sends(): boolean {
    return this.opts.net !== false && this.ctx.isMultiplayer && !!this.ctx.net && !this.ctx.net.isHost;
  }

  private setLocal(id: string | null): void {
    if (id === this.local) return;
    const net = this.sends() ? this.ctx.net! : null;
    if (this.local !== null && net) net.send({ t: 'cviewq', ev: 'close', id: this.local }, 'host');
    this.local = id;
    if (id !== null && net) net.send({ t: 'cviewq', ev: 'open', id }, 'host');
  }

  private hookNet(): void {
    const net = this.ctx.net;
    if (!net || net === this.hookedNet || typeof net.onMessage !== 'function') return;
    for (const u of this.netUnsubs) u();
    this.hookedNet = net;
    this.netUnsubs = [
      net.onMessage('cviewq', (msg, from) => this.onRequest(msg, from)),
      net.onMessage('flow', (msg, from) => { if (msg.ev === 'rejoined') this.dropPeer(from); }),
    ];
  }

  private dropPeer(peer: PeerId): void {
    this.dropViews(peer);
    this.buckets.delete(peer);
  }

  private onRequest(msg: CorpseViewRequest, from: PeerId): void {
    if (!this.hosting()) return;
    // ① 모양
    if (!msg || (msg.ev !== 'open' && msg.ev !== 'close') || typeof msg.id !== 'string' || typeof from !== 'string') {
      this.refused++;
      return;
    }
    if (!this.opts.matches(msg.id)) return;   // 다른 시체 종류의 추적기가 맡는다
    if (msg.ev === 'close') {
      const set = this.remote.get(msg.id);
      if (set?.delete(from) && set.size === 0) this.remote.delete(msg.id);
      return;
    }
    const at = this.opts.positionOf(msg.id);
    if (!at) { this.refused++; return; }
    // ② 보낸 사람
    const ref = this.ctx.net!.getRemotePlayer(from);
    if (!ref || ref.connected === false || ref.isDead) { this.refused++; return; }
    // ③ 거리 (수평)
    const dx = ref.position.x - at.x, dz = ref.position.z - at.z;
    if (dx * dx + dz * dz > CORPSE_EMPTY_REQUEST_REACH_M * CORPSE_EMPTY_REQUEST_REACH_M) { this.refused++; return; }
    // ④ 요율
    if (!this.spend(from)) { this.refused++; return; }
    // 창은 하나다 — 그 사람이 보던 다른 시체는 닫혔다
    this.dropViews(from);
    let set = this.remote.get(msg.id);
    if (!set) { set = new Set(); this.remote.set(msg.id, set); }
    set.add(from);
  }

  private dropViews(peer: PeerId): void {
    for (const [id, set] of this.remote) {
      if (set.delete(peer) && set.size === 0) this.remote.delete(id);
    }
  }

  private spend(from: PeerId): boolean {
    const now = this.ctx.time;
    let b = this.buckets.get(from);
    if (!b) { b = { tokens: CORPSE_EMPTY_REQUEST_BURST, at: now }; this.buckets.set(from, b); }
    b.tokens = Math.min(CORPSE_EMPTY_REQUEST_BURST, b.tokens + Math.max(0, now - b.at) * CORPSE_EMPTY_REQUEST_RATE_MAX);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
