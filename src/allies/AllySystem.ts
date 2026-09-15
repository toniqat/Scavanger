/**
 * src/allies/AllySystem.ts — **안드로이드 분대원** (`ctx.allies`, 계약 `shared/allies.ts`).
 *
 * 계약은 `@/shared` 의 `allies.ts` · `net.ts` 끝 절이 전부다. 이 클래스는 상태와 한 줄 위임만 갖고, 일은 `parts/` 가 한다:
 *  - `parts/Roster`   — 명단 (로비 봇 멤버 / 치트 명단) · 몸 만들기 · `ally:rosterChanged`
 *  - `parts/Hub`      — 공용 함선의 잠든 슬롯 몸 · 나오기/돌아가기 · 발사 포드 앞 대기 · 개인 함선 치트 추종
 *  - `parts/Spawn`    — 레이드 진입 (기본 킷 · 강하 포드)
 *  - `parts/Fsm`      — 제안 → 반응 지연 → 전이, 상태별 행동 분기
 *  - `parts/Harness`  — 분대장 추적 · 하네스 반경 (한 방향 이동이면 절반으로)
 *  - `parts/Nav`      — 조향 · 장애물 회피 · 지면/충돌 (world 질의 순서를 지킨다)
 *  - `parts/Combat`   — 감지 · 적 핑 · 엄폐 · 연사
 *  - `parts/Vitals`   — 실드/체력/쓰러짐/사망 · 재해 · 소생
 *  - `parts/Commands` — 핑 · 의사소통 휠 · 인벤토리 요청 (선착순 하나)
 *  - `parts/Bag`      — 무게 · 장비 갈아끼우기 · 짐 버리기
 *  - `parts/Loot`     — 컨테이너 · 바닥 아이템
 *  - `parts/Support`  — 요청자에게 건네주기
 *  - `parts/Extract`  — 탈출구 탐색 · 호출 · 탑승 · 창고 이관
 *  - `parts/Contract` — 계약 목표 탐색
 *  - `parts/Rescue`   — 쓰러진 PC 일으키기 · 재해 밖으로 업고 뛰기
 *  - `parts/Ping`     — 안드로이드 이름으로 나가는 핑 · 채팅
 *  - `parts/Sync`     — `ally` / `allyq` 와이어 (호스트 권위)
 *  - `parts/Console`  — 개발 치트 `/android 1|0`
 *
 * 이 폴더는 **메시를 만들지 않는다** — player/ 가 `getBodies()` 를 읽어 `SoldierModel` 로 그린다.
 * `main.ts` 에서 `ExtractionSystem` 바로 뒤에 등록된다: 적 · 인벤토리 · 줍기 · 탈출이 이번 프레임 상태를 낸 뒤에 판단한다.
 */
import * as THREE from 'three';
import { ALLY_EXTRACT_CONFIRM_S, ALLY_LOCAL_PEER, PLAYER_REVIVE_RANGE } from '@/shared';
import type {
  AlliesRef, AllyBodyView, AllyId, AllyLoadoutView, AllyRosterEntry, AllyStateId, GameContext, GameSystem,
  ItemInstance, PeerId, PingKind, PlayerDamageSource,
} from '@/shared';
import type { Ally } from './parts/Body';
import type { AllyRequest } from './model';
import * as Roster from './parts/Roster';
import * as Hub from './parts/Hub';
import * as Spawn from './parts/Spawn';
import * as Fsm from './parts/Fsm';
import * as Harness from './parts/Harness';
import * as Vitals from './parts/Vitals';
import * as Commands from './parts/Commands';
import * as Support from './parts/Support';
import * as Extract from './parts/Extract';
import * as Sync from './parts/Sync';
import * as Console from './parts/Console';

export class AllySystem implements GameSystem, AlliesRef {
  readonly name = 'allies';
  ctx!: GameContext;

  /** 이 클라이언트가 아는 모든 몸 (bay 순). `getBodies()` 가 이 배열을 그대로 준다. */
  readonly bodies: Ally[] = [];
  readonly byId = new Map<AllyId, Ally>();
  /** 지금 명단 (`AlliesRef.roster`). 바뀔 때만 새 배열이다. */
  roster: readonly AllyRosterEntry[] = [];
  /** 서버 없는 치트 명단 — 세션 동안만 산다 (저장하지 않는다). */
  readonly localRoster: AllyRosterEntry[] = [];
  /** 사람이 이겨 슬롯으로 돌아간 기 — 다음 `ally:rosterChanged` 의 `evicted` 가 된다. */
  readonly evictedPending: AllyId[] = [];
  /** 명단을 다시 계산해야 한다 (프레임 루프는 이것이 설 때만 `Roster.refresh` 를 부른다 — 배열 할당을 줄인다). */
  rosterDirty = true;

  /** `getCombatBodies()` 의 재사용 배열. */
  readonly combatBuf: Ally[] = [];

  /* ── 분대장 · 하네스 (`parts/Harness`) ── */
  leaderId: PeerId = ALLY_LOCAL_PEER;
  readonly leaderPos = new THREE.Vector3();
  readonly leaderPrev = new THREE.Vector3();
  readonly leaderDir = new THREE.Vector3();
  leaderKnown = false;
  /** 한 방향으로 계속 가는 정도 0..1 (EMA). 1 이면 하네스가 `ALLY_HARNESS_MIN_FRAC` 까지 줄어든다. */
  commit = 0;
  harness = 0;

  /* ── 명령 · 요청 ── */
  /** 분대장의 이동 명령 (`attack` 핑 · `lead` 한 마디). */
  orderKind: 'moveTo' | 'lead' | null = null;
  readonly orderPos = new THREE.Vector3();
  orderUntil = -Infinity;
  /** 주의 핑 (`caution`). */
  readonly watchPos = new THREE.Vector3();
  watchUntil = -Infinity;
  /** 분대장이 적 핑을 찍었다 — 그 대상을 우선한다. */
  preferredEnemyId: number | null = null;
  /** 지금 받아들인 요청 하나 (선착순). */
  request: AllyRequest | null = null;
  /** 그 요청과 함께 온 한국어 문장 (원격 계약 요청의 유일한 단서). */
  requestText = '';
  /** 이 시각(`ctx.time`)까지는 새 요청을 무시한다. */
  requestBlockedUntil = -Infinity;
  /** 탈출 확인 창의 길이 (s). */
  readonly extractConfirmWindow = ALLY_EXTRACT_CONFIRM_S;
  /** 호스트가 `allyq revive` 를 받아 주는 거리 (m) — 사람의 소생 거리와 같다. */
  readonly reviveRange = PLAYER_REVIVE_RANGE;

  /* ── 컨테이너 · 시간 · 동기화 ── */
  /** 사람이 열어 본 컨테이너 — 그 상자를 먹던 안드로이드는 멈춘다. */
  readonly viewedContainers = new Set<string>();
  /** 강하 포드가 땅에 닿는 시각 (`ctx.time`). */
  readonly landAt = new Map<AllyId, number>();
  hazardTimer = 0;
  envTimer = 0;
  netTimer = 0;
  netHooked = false;
  readonly unsubs: Array<() => void> = [];
  readonly netUnsubs: Array<() => void> = [];
  /** 와이어를 풀 때 쓰는 스크래치 (이벤트로 나가는 벡터는 읽고 바로 쓴다). */
  readonly fireFrom = new THREE.Vector3();
  readonly fireTo = new THREE.Vector3();

  /** 지금 레이드 시뮬레이션이 돌고 있다 (`world:ready` 뒤). */
  raidActive = false;

  /* ═══════════════════════════ 수명 ═══════════════════════════ */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.allies = this;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('net:lobbyUpdated', () => { this.rosterDirty = true; }),
      b.on('net:lobbyLeft', () => { this.rosterDirty = true; }),
      b.on('net:androidReturned', ({ bay, reason }) => Roster.onReturned(this, bay, reason)),
      b.on('hub:entered', () => { this.rosterDirty = true; Roster.refresh(this); Hub.onHubEntered(this); }),
      b.on('hub:left', () => Hub.onHubLeft(this)),
      b.on('world:ready', (e) => { Spawn.onWorldReady(this, e.playerSpawn); Sync.askSync(this); }),
      b.on('game:abort', () => Spawn.onAbort(this)),
      b.on('ping:placedV3', (e) => Commands.onPing(this, e)),
      b.on('comms:sent', (e) => Commands.onComms(this, e)),
      b.on('inventory:itemRequested', (e) => Commands.onItemRequest(this, e)),
      b.on('inventory:containerViewed', ({ containerId }) => Commands.onContainerViewed(this, containerId)),
      b.on('extraction:liftoff', () => Extract.onLiftoff(this)),
      b.on('net:hostChanged', ({ isLocalHost }) => Sync.onHostChanged(this, isLocalHost)),
    );
    Console.register(this);
  }

  update(dt: number, ctx: GameContext): void {
    Sync.ensureNetHooks(this);
    if (this.rosterDirty) Roster.refresh(this);
    Harness.update(this, dt);
    if (ctx.isHubPhase()) Hub.update(this, dt);
    else if (this.raidActive) {
      Spawn.updateLanding(this);
      if (this.simulating) {
        Vitals.update(this, dt);
        Commands.tickRequest(this);
        Fsm.update(this, dt);
      } else Sync.updateReplicas(this, dt);
    }
    Sync.update(this, dt);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    Sync.unhook(this);
    this.bodies.length = 0;
    this.byId.clear();
    if (this.ctx?.allies === this) this.ctx.allies = null;
  }

  /* ═══════════════════════════ AlliesRef ═══════════════════════════ */
  /** 이 클라이언트가 안드로이드를 굴리는가 — 솔로 · 로비 호스트. */
  get simulating(): boolean { return this.ctx?.isAuthority ?? true; }

  getBodies(): readonly AllyBodyView[] { return this.bodies; }
  getBody(id: AllyId): AllyBodyView | null { return this.byId.get(id) ?? null; }
  getCombatBodies(): readonly AllyBodyView[] {
    const out = this.combatBuf;
    out.length = 0;
    if (!this.raidActive) return out;
    for (const a of this.bodies) {
      if (a.mode !== 'raid' || a.dead || a.downed || a.hidden) continue;
      out.push(a);
    }
    return out;
  }
  getLoadout(id: AllyId): AllyLoadoutView | null { return Roster.loadoutOf(this, id); }
  damage(id: AllyId, amount: number, source?: PlayerDamageSource, from?: THREE.Vector3): void {
    Vitals.damage(this, id, amount, source, from);
  }
  requestRevive(id: AllyId, opts?: { defib?: boolean }): boolean { return Vitals.requestRevive(this, id, opts); }
  carrierOf(peer: PeerId): AllyBodyView | null {
    for (const a of this.bodies) if (a.carrying === peer) return a;
    return null;
  }
  devSetAndroid(on: boolean): string { return Console.devSetAndroid(this, on); }

  /* ═══════════════════════════ parts 가 쓰는 한 줄 위임 ═══════════════════════════ */
  sendPing(a: Ally, kind: PingKind, p: THREE.Vector3, label?: string, enemyId?: number): void {
    Sync.sendPing(this, a, kind, p, label, enemyId);
  }
  sendChat(a: Ally, text: string): void { Sync.sendChat(this, a, text); }
  sendFire(a: Ally, from: THREE.Vector3, to: THREE.Vector3): void { Sync.sendFire(this, a, from, to); }
  sendPodDrop(a: Ally): void { Sync.sendPodDrop(this, a); }
  sendReviveRequest(id: AllyId, defib: boolean): boolean { return Sync.sendReviveRequest(this, id, defib); }
  revivePlayer(a: Ally, target: PeerId, defib: boolean): void { Sync.revivePlayer(this, a, target, defib); }
  depositToLeader(a: Ally, items: readonly ItemInstance[]): void { Sync.depositToLeader(this, a, items); }
  offerToLeader(a: Ally, item: ItemInstance): void { Support.offerToLeader(this, a, item); }

  /* ═══════════════════════════ 디버그 · 스모크 ═══════════════════════════ */
  /** 한 기를 특정 상태로 밀어 넣는다 (반응 지연 없이). 모르는 id 면 false. */
  debugForceState(id: AllyId, state: AllyStateId): boolean {
    const a = this.byId.get(id);
    if (!a) return false;
    Fsm.enter(this, a, state, 1000);
    return true;
  }
  /** 가방에 아이템 하나를 넣는다 (`raidFound` 표시 — 건네기 · 창고 이관 대상). */
  debugGive(id: AllyId, defId: string, qty = 1): boolean { return Roster.debugGive(this, id, defId, qty); }
  /** 분대장 위치를 덮어쓴다 (하네스 · 따라가기 확인). null 이면 해제. */
  debugLeaderAt(pos: THREE.Vector3 | null): void { Harness.debugOverride(this, pos); }
  /** 지금 하네스 반경(m) 과 방향 일관성 0..1. */
  debugHarness(): { radius: number; commit: number } { return { radius: this.harness, commit: this.commit }; }
  /** 한 기를 그 자리로 옮긴다. */
  debugTeleport(id: AllyId, x: number, y: number, z: number): boolean {
    const a = this.byId.get(id);
    if (!a) return false;
    a.position.set(x, y, z);
    a.hidden = false;
    return true;
  }
  /** 한 기의 지금 상태 · 체력 · 소지품 (스모크 판정용). */
  debugInfo(id: AllyId): {
    state: AllyStateId; mode: string; hp: number; shield: number; downed: boolean; dead: boolean; hidden: boolean;
    items: string[]; task: string | null; pos: [number, number, number];
  } | null {
    const a = this.byId.get(id);
    if (!a) return null;
    return {
      state: a.state, mode: a.mode, hp: a.hp, shield: a.shield, downed: a.downed, dead: a.dead, hidden: a.hidden,
      items: (a.bag?.items() ?? a.wireItems).map((i) => `${i.defId}x${i.qty}`),
      task: a.taskKind, pos: [a.position.x, a.position.y, a.position.z],
    };
  }
}
