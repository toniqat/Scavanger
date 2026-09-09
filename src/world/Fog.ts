/**
 * src/world/Fog.ts — **전장의 안개** (`FogRef`, 게시: `ctx.world.fog`).
 *
 * `MAP_SIZE / FOG_CELL_M` 변의 정사각 마스크 하나가 원본이고, **한 번 밝힌 칸은 레이드가 끝날 때까지
 * 다시 어두워지지 않는다**. 밝히는 주체는 분대원 전원 — 매 `FOG_UPDATE_HZ` 마다 로컬 플레이어와
 * `ctx.net.getRemotePlayers()` 의 살아 있는 분대원 주위 `FOG_REVEAL_RADIUS` 를 칠한다. 모두가 이미 흐르는
 * `ps` 스냅샷의 좌표를 보므로 **평상시에는 새 와이어가 없다**; 늦게 합류한 클라이언트만 `fogq sync` 로
 * 호스트의 마스크를 받는다 (`fog sync {mask}` = `serialize()` 의 base64).
 *
 * 랜드마크 발견도 여기서 판정한다 — 탈출 신호소 · 둥지 · 상자 · 채집물이 밝혀진 칸에 처음 들어오면
 * `fog:discovered` 를 내보내고, 랜드마크(신호소 · 둥지)만 `ui:notify` 토스트를 띄운다. 지도 · 월드 마커 ·
 * 나침반은 전부 `isDiscovered` 하나로 게이트된다.
 *
 * 훈련장에서는 만들어지지 않는다 (`WorldSystem.fog === null`).
 */
import type * as THREE from 'three';
import {
  FOG_CELL_M, FOG_REVEAL_RADIUS, FOG_UPDATE_HZ, MAP_SIZE,
  type FogRef, type GameContext, type PeerId,
} from '@/shared';

/** `fog:discovered.kind` — 지도 마커 종류와 같은 이름. */
type DiscoverKind = 'extraction' | 'nest' | 'crate' | 'outpost' | 'gather';

/** 발견 토스트를 띄우는 종류와 문구 (상자 · 채집물은 너무 잦아 토스트 없이 이벤트만 나간다). */
const TOAST: Partial<Record<DiscoverKind, string>> = {
  extraction: '탈출 신호소 발견',
  nest: '벌레 둥지 발견',
  outpost: '전초기지 발견',
};

/** base64 인코딩 (비트 팩된 마스크 — 6400칸이 800바이트 → base64 약 1.1 KB). */
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(data: string): Uint8Array | null {
  try {
    const s = atob(data);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch { return null; }
}

export class Fog implements FogRef {
  readonly cells: number;
  readonly cellSize = FOG_CELL_M;
  readonly mask: Uint8Array;
  revision = 0;

  private revealed = 0;
  private readonly half = MAP_SIZE / 2;
  private ctx: GameContext | null = null;
  private timer = 0;
  private grew = false;
  /** 이미 발견을 알린 오브젝트 id. */
  private readonly seen = new Set<string>();
  /** 이번 틱에 토스트를 띄운 종류 (둥지 하나가 구멍 3~4개라 그만큼 토스트가 뜨는 것을 막는다). */
  private readonly toasted = new Set<DiscoverKind>();
  private readonly unsubs: Array<() => void> = [];
  private netHooked = false;

  constructor() {
    this.cells = Math.max(1, Math.ceil(MAP_SIZE / FOG_CELL_M));
    this.mask = new Uint8Array(this.cells * this.cells);
  }

  get explored(): number {
    const total = this.cells * this.cells;
    return total > 0 ? this.revealed / total : 0;
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /** 미션 시작 시 `WorldSystem.generate` 가 부른다. 클라이언트면 호스트에게 지금까지의 마스크를 요청한다. */
  attach(ctx: GameContext): void {
    this.ctx = ctx;
    this.ensureNet();
    this.requestSync();
  }

  /** 미션 종료 (`game:abort` / 다음 미션). 마스크 · 발견 기록 · 네트워크 구독을 전부 버린다. */
  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.netHooked = false;
    this.mask.fill(0);
    this.revealed = 0;
    this.revision = 0;
    this.seen.clear();
    this.ctx = null;
  }

  /* ── 질의 ──────────────────────────────────────────────────────────── */

  private index(x: number, z: number): number {
    const cx = Math.floor((x + this.half) / this.cellSize);
    const cz = Math.floor((z + this.half) / this.cellSize);
    if (cx < 0 || cz < 0 || cx >= this.cells || cz >= this.cells) return -1;
    return cz * this.cells + cx;
  }

  isRevealed(x: number, z: number): boolean {
    const i = this.index(x, z);
    return i < 0 ? true : this.mask[i] !== 0;      // 맵 밖은 가릴 것이 없다
  }

  isDiscovered(position: THREE.Vector3): boolean {
    return this.isRevealed(position.x, position.z);
  }

  /* ── 칠하기 ────────────────────────────────────────────────────────── */

  reveal(x: number, z: number, radius: number): void {
    if (radius <= 0) return;
    const s = this.cellSize;
    const c0 = Math.max(0, Math.floor((x - radius + this.half) / s));
    const c1 = Math.min(this.cells - 1, Math.floor((x + radius + this.half) / s));
    const r0 = Math.max(0, Math.floor((z - radius + this.half) / s));
    const r1 = Math.min(this.cells - 1, Math.floor((z + radius + this.half) / s));
    const r2 = radius * radius;
    let grew = false;
    for (let cz = r0; cz <= r1; cz++) {
      const wz = -this.half + (cz + 0.5) * s - z;
      const row = cz * this.cells;
      for (let cx = c0; cx <= c1; cx++) {
        const i = row + cx;
        if (this.mask[i] !== 0) continue;
        const wx = -this.half + (cx + 0.5) * s - x;
        if (wx * wx + wz * wz > r2) continue;
        this.mask[i] = 255;
        this.revealed++;
        grew = true;
      }
    }
    if (grew) { this.revision++; this.grew = true; }
  }

  /**
   * 매 프레임 호출되지만 실제 칠하기는 `FOG_UPDATE_HZ` 마다 한 번이다.
   * 로컬 플레이어 + 살아 있는 원격 분대원 전원의 시야가 합쳐진다.
   */
  update(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / Math.max(1, FOG_UPDATE_HZ);
    this.ensureNet();

    const p = ctx.player;
    if (p && !p.isDead) this.reveal(p.position.x, p.position.z, FOG_REVEAL_RADIUS);
    const net = ctx.net;
    if (net && ctx.isMultiplayer) {
      for (const r of net.getRemotePlayers()) {
        // 같은 미션 안의, 살아 있는 분대원만 (허브에 있는 사람 · 완전 사망자는 아무것도 밝히지 않는다)
        if (!r.inMission || r.isDead) continue;
        if (!r.connected && !r.suspended) continue;
        this.reveal(r.position.x, r.position.z, FOG_REVEAL_RADIUS);
      }
    }

    this.scanDiscoveries(ctx);
    if (this.grew) {
      this.grew = false;
      ctx.bus.emit('fog:revealed', { revision: this.revision, explored: this.explored });
    }
  }

  /* ── 발견 게이트 ───────────────────────────────────────────────────── */

  private scanDiscoveries(ctx: GameContext): void {
    const world = ctx.world;
    if (!world?.ready) return;
    this.toasted.clear();
    for (const e of world.getExtractionPoints()) this.discover('extraction', e.id, e.position);
    // `getNestPositions()` is one entry per **hole**, and a nest's holes are metres apart — they all cross the
    // reveal boundary in the same tick, so the per-tick `toasted` filter turns 3–4 of them into one 발견 toast.
    const nests = world.getNestPositions();
    for (let i = 0; i < nests.length; i++) this.discover('nest', `nest_${i}`, nests[i]);
    for (const c of world.getCrates()) this.discover('crate', c.id, c.position);
    const nodes = world.getGatherNodes?.();
    if (nodes) for (const g of nodes) this.discover('gather', g.id, g.position);
  }

  private discover(kind: DiscoverKind, id: string, position: THREE.Vector3): void {
    if (this.seen.has(id) || !this.isDiscovered(position)) return;
    this.seen.add(id);
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.bus.emit('fog:discovered', { kind, id, position });
    const text = TOAST[kind];
    if (!text || this.toasted.has(kind)) return;      // one toast per kind per tick
    this.toasted.add(kind);
    ctx.bus.emit('ui:notify', { text, kind: 'info', duration: 2.2 });
  }

  /* ── 직렬화 (늦게 합류한 클라이언트) ───────────────────────────────── */

  serialize(): string {
    const bytes = new Uint8Array(Math.ceil(this.mask.length / 8));
    for (let i = 0; i < this.mask.length; i++) {
      if (this.mask[i] !== 0) bytes[i >> 3] |= 1 << (i & 7);
    }
    return toBase64(bytes);
  }

  applySerialized(data: string): void {
    const bytes = fromBase64(data);
    if (!bytes || bytes.length < Math.ceil(this.mask.length / 8)) return;
    let grew = false;
    for (let i = 0; i < this.mask.length; i++) {
      if ((bytes[i >> 3] & (1 << (i & 7))) === 0 || this.mask[i] !== 0) continue;
      this.mask[i] = 255;
      this.revealed++;
      grew = true;
    }
    if (!grew) return;
    this.revision++;
    this.ctx?.bus.emit('fog:revealed', { revision: this.revision, explored: this.explored });
  }

  /* ── 멀티플레이 (호스트 권한, 늦은 합류만) ─────────────────────────── */

  private ensureNet(): void {
    const ctx = this.ctx;
    const net = ctx?.net;
    if (!ctx || !net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('fog', (m) => {
        if (m.ev === 'sync' && !ctx.net?.isHost) this.applySerialized(m.mask);
      }),
      net.onMessage('fogq', (m, from) => {
        if (m.ev === 'sync' && ctx.net?.isHost) this.sendSync(from);
      }),
      net.onMessage('flow', (m, from) => {
        if (m.ev === 'rejoined' && ctx.net?.isHost) this.sendSync(from);
      }),
      // 승격된 호스트는 우리 마스크를 본 적이 없다 — 반대로 우리가 새 호스트에게 다시 받는다
      ctx.bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost) this.requestSync(); }),
    );
  }

  private requestSync(): void {
    const ctx = this.ctx;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
    net.send({ t: 'fogq', ev: 'sync' }, 'host');
  }

  private sendSync(to: PeerId): void {
    const ctx = this.ctx;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer) return;
    net.send({ t: 'fog', ev: 'sync', mask: this.serialize() }, to);
  }
}
