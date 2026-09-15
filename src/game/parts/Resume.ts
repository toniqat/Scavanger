/**
 * src/game/parts/Resume.ts — **타이틀의 이어하기 · 레이드 포기** (`ctx.raidResume`, 2026-09-15).
 *
 * docs/DECISIONS.md 「2026-09-15 — 타이틀 이어하기 · 레이드 포기」 (사용자 결정):
 *  - 레이드가 남아 있는 채로 게임을 켜면 **곧장 레이드로 떨어지지 않고 타이틀부터** 시작한다. 예전에는 첫 `update()` 가
 *    솔로 세이브를 보자마자 `resumeSoloRaid` 를 불렀다 — 이제 그 결정은 타이틀의 `이어하기` 한 번이다.
 *  - 포기 = 그 레이드에서 사망. 솔로는 사망과 같은 정산(장비 · 가방 · 임플란트 손실, 사망 XP, 계약 실패), 분대는 거기에
 *    **표류**가 붙는다(구조선 불가 · 재투입 불가 — 릴레이의 `LobbyPlayer.drifted`), 튜토리얼은 진행만 지우고 처음부터.
 *  - 솔로 유예(`SOLO_RAID_GRACE_MS`)는 **누르는 순간** 본다 — 타이틀에 머무는 동안 넘으면 `이어하기` 가 사라지고 실패로 정산된다.
 *
 * 세이브 파일은 부팅 때 **지우지 않는다** (예전에는 지웠다가 이어하기에서 다시 썼다) — 타이틀에서 아무것도 고르지 않고 창을
 * 닫아도 다음 부팅이 같은 레이드를 내민다.
 *
 * 분대 레이드는 릴레이에 붙어야 보인다. 그래서 분대 레이드가 시작될 때 `SQUAD_RAID_MARK_KEY` 표식을 남기고, 부팅 때 표식이
 * 있을 때만 타이틀에서 접속한다 — 표식이 없는 사람(대부분의 솔로 · 오프라인 플레이어)은 타이틀에서 아무것도 기다리지 않는다.
 */
import type {
  GameContext, ItemInstance, LobbyPlayer, LobbyState, MissionStats, PlayerCorpseWire, RaidResumeMember, RaidResumeOffer,
  RaidResumeRef,
} from '@/shared';
import { GameContext as Ctx, SQUAD_RAID_MARK_KEY, activeSlot, androidNameOf, isBotPlayer, readSlotCard, sanitizeAccent, slotKey } from '@/shared';
import { bumpClockHigh, clearSoloRaid, loadSoloRaid, readClockHigh, soloRaidBootStatus, soloRaidStatus, type SoloRaidSave } from '../SoloRaid';
import { itemsToWire } from '../Corpses';
import type { GameFlowSystem } from '../GameFlowSystem';

const LATE_TEXT = '복귀가 너무 늦었습니다 — 레이드 실패';
/** 타이틀에 머무는 동안 솔로 유예가 넘어가는 순간을 잡는 주기 (ms). 판정은 매번 시계를 읽으므로 반응 속도일 뿐이다. */
const EXPIRY_POLL_MS = 1000;

interface SquadMark { code: string; seed: number }

export class RaidResume implements RaidResumeRef {
  /** 유예 안에 있던 솔로 · 튜토리얼 세이브 (파일은 디스크에 그대로 있다). */
  private solo: SoloRaidSave | null = null;
  /** 부팅 때 이미 늦었다 — 첫 프레임에 실패로 정산한다 (`save` null = 세이브 없이 킷의 레이드 표식만 남았다, E-5 ③). */
  private staleAtBoot: { save: SoloRaidSave | null } | null = null;
  private mark: SquadMark | null = null;
  private check: Promise<void> | null = null;
  private _checking = false;
  private nextPollAt = 0;
  /** 마지막으로 방송한 제안의 모양 — 같으면 `raid:resumeChanged` 를 다시 내지 않는다. */
  private lastKey = '';
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly sys: GameFlowSystem) {}

  private get ctx(): GameContext { return this.sys.ctx; }

  /** `GameFlowSystem.init` 에서 한 번. 인벤토리가 먼저 init 된 뒤라 킷의 레이드 표식을 읽을 수 있다. */
  bind(): void {
    const ctx = this.ctx;
    ctx.raidResume = this;
    // 2026-09-11 (E-5): judged against the highest clock this slot has seen and the loadout's solo raid marker, then the
    // boot itself is recorded as a clock reading.
    const solo = loadSoloRaid();
    const now = Date.now();
    const status = soloRaidBootStatus(solo, ctx.inventory?.soloRaidSeed ?? null, now, readClockHigh());
    bumpClockHigh(now);
    if (status === 'fresh') this.solo = solo;
    else if (status === 'stale') this.staleAtBoot = { save: solo };
    this.mark = readMark();

    const b = ctx.bus;
    this.unsubs.push(
      // 분대 레이드에 들어섰다 (출격 · 재투입 · 이어하기) — 새로고침으로 끊겨도 다음 부팅의 타이틀이 물어볼 수 있게
      // 로비 없는 발행(스모크 · 옛 경로)은 되찾을 분대 레이드가 아니다
      b.on('net:gameStarting', ({ seed, lobby, mode }) => { if ((mode ?? 'raid') === 'raid' && lobby?.code) this.writeMark({ code: lobby.code, seed }); }),
      // 이 사람의 레이드가 끝났다 — 탈출 · 실패 · 포기 · 귀환(`hub:enter` 의 abort) · 타이틀로
      b.on('game:complete', () => this.dropMark()),
      b.on('game:over', () => this.dropMark()),
      b.on('game:abort', () => this.dropMark()),
      b.on('net:lobbyLeft', () => { this.dropMark(); this.emitChanged(); }),
      b.on('net:lobbyUpdated', () => this.emitChanged()),
      b.on('net:resumed', () => this.emitChanged()),
      b.on('game:phaseChanged', () => this.emitChanged()),
    );
    // 타이틀 · 자동 시작이 첫 마이크로태스크에서 `checking` 을 읽는다 — 그래서 첫 `update()` 가 아니라 여기서 시작한다
    this.startSquadCheck();
    this.emitChanged();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.ctx?.raidResume === this) this.ctx.raidResume = null;
  }

  /** `GameFlowSystem.update` 에서 매 프레임 (할 일이 없으면 곧장 돌아온다). */
  update(): void {
    const ctx = this.ctx;
    if (this.staleAtBoot) {
      const { save } = this.staleAtBoot;
      this.staleAtBoot = null;
      if (ctx.phase === 'menu') this.failSolo(save, LATE_TEXT);   // 이미 다른 곳이면 (분대 재접속이 앞질렀다) 건드리지 않는다
      return;
    }
    const solo = this.solo;
    if (!solo || solo.mode === 'tutorial' || ctx.phase !== 'menu') return;
    const now = performance.now();
    if (now < this.nextPollAt) return;
    this.nextPollAt = now + EXPIRY_POLL_MS;
    if (expired(solo)) this.failSolo(solo, LATE_TEXT);
  }

  /* ── RaidResumeRef ─────────────────────────────────────────────────── */

  get offer(): RaidResumeOffer | null {
    if (this.ctx.phase !== 'menu') return null;
    const solo = this.solo;
    if (solo) {
      const tutorial = solo.mode === 'tutorial';
      return { kind: tutorial ? 'tutorial' : 'solo', planet: tutorial ? null : solo.planet, missionTime: solo.missionTime, members: [this.localMember(null)] };
    }
    const lobby = this.squadLobby();
    if (!lobby) return null;
    return { kind: 'squad', planet: lobby.planet ?? null, missionTime: this.ctx.net?.raidBlob?.missionTime ?? 0, members: this.squadMembers(lobby) };
  }

  get checking(): boolean { return this._checking; }

  settled(): Promise<void> { return this.check ?? Promise.resolve(); }

  resume(): boolean {
    const ctx = this.ctx;
    if (ctx.phase !== 'menu') return false;
    const solo = this.solo;
    if (solo) {
      // 「누르는 순간 판정」 (사용자 결정) — 폴링 사이에 넘었을 수도 있다
      if (expired(solo)) { this.failSolo(solo, LATE_TEXT); return false; }
      this.solo = null;
      this.sys.resumeSoloRaid(solo);   // 파일은 그대로다 — 이어진 레이드의 첫 주기 저장이 덮어쓴다
      this.emitChanged();
      return true;
    }
    const net = ctx.net;
    if (!net || !this.squadLobby()) return false;
    net.rejoinMission();              // → net:gameStarting {rejoin} + game:newMission (월드 · blob · 호스트의 ghost restore)
    this.emitChanged();
    return net.inSession;
  }

  abandon(): void {
    if (this.ctx.phase !== 'menu') return;
    const solo = this.solo;
    if (solo) {
      if (solo.mode === 'tutorial') this.restartTutorial();
      else this.failSolo(solo, '레이드를 포기했습니다 — 캐릭터가 사망해 소지품을 모두 잃었습니다');
      return;
    }
    const lobby = this.squadLobby();
    if (lobby) this.abandonSquad(lobby);
  }

  /* ── 분대 레이드 확인 ───────────────────────────────────────────────── */

  private startSquadCheck(): void {
    const net = this.ctx.net;
    if (!this.mark || !net || typeof net.ensureConnected !== 'function') return;
    // 추방 · 인원 초과 · 다른 창 접속으로 거절당한 링크는 스스로 다시 붙지 않는다 (`shared/net` 규칙)
    if (net.link?.state === 'refused') return;
    this._checking = true;
    this.check = net.ensureConnected().catch(() => false).then((ok) => {
      this._checking = false;
      this.check = null;
      // 붙었는데 그 레이드가 없다 (끝났다 · 로비가 없다 · 이미 표류) — 표식은 할 일을 다했다. 못 붙었으면 모르는 것이니 남긴다.
      if (ok && !this.squadLobby()) this.dropMark();
      this.emitChanged();
    });
  }

  /** 표식의 레이드가 아직 달리고 내가 거기서 빠져나와 있는가 (표류 전). */
  private squadLobby(): LobbyState | null {
    const mark = this.mark;
    const net = this.ctx.net;
    const lobby = net?.lobby ?? null;
    if (!mark || !net || !lobby || net.inSession) return null;
    if (!lobby.started || (lobby.mode ?? 'raid') !== 'raid' || lobby.code !== mark.code || lobby.seed !== mark.seed) return null;
    const me = net.localId ? lobby.players.find((p) => p.id === net.localId) : undefined;
    return me && !me.drifted ? lobby : null;
  }

  /* ── 초상 명단 (매칭 탭과 같은 순서 · 같은 원본) ───────────────────── */

  private localMember(lp: LobbyPlayer | null): RaidResumeMember {
    let card: ReturnType<typeof readSlotCard> | null = null;
    try { card = readSlotCard(activeSlot()); } catch { card = null; }
    const lvl = this.ctx.progression?.level;
    return {
      id: lp?.id ?? 'me', name: card?.name || lp?.name || this.ctx.net?.playerName || '나',
      level: typeof lvl === 'number' && lvl > 0 ? lvl : card?.level ?? null,
      // 나는 내 캐릭터의 악센트 (세이브) — 로비에 실린 값은 그 메아리다
      accent: sanitizeAccent(card?.accent) ?? sanitizeAccent(lp?.accent) ?? null,
      slot: lp?.slot ?? 0, isHost: !!lp?.isHost, me: true, bot: false, bay: 0, connected: true, drifted: false,
    };
  }

  private squadMembers(lobby: LobbyState): RaidResumeMember[] {
    const me = this.ctx.net?.localId ?? null;
    const mine = lobby.players.find((p) => p.id === me) ?? null;
    const out = [this.localMember(mine)];
    for (const p of lobby.players.filter((q) => q !== mine).sort((a, c) => a.slot - c.slot)) {
      const bot = isBotPlayer(p);
      out.push({
        id: p.id, name: bot ? androidNameOf(p.bay ?? 0) : (p.name || '—'),
        level: !bot && typeof p.level === 'number' && p.level > 0 ? p.level : null,
        accent: sanitizeAccent(p.accent), slot: p.slot, isHost: !bot && p.isHost, me: false, bot, bay: p.bay ?? 0,
        connected: bot || p.connected !== false, drifted: p.drifted === true,
      });
    }
    return out;
  }

  /* ── 포기 · 실패 ────────────────────────────────────────────────────── */

  /**
   * 솔로 레이드의 끝 = **사망**과 같은 손실 (`parts/Death.onLocalDied` 솔로 갈래, 사용자 결정 「솔로도 완전히 잃는다」):
   * 장착 임플란트는 짝도 없이, 가방 · 장비 · 퀵슬롯 · 주머니는 `game:abort` → `inventory/parts/Lifecycle.onAbort` 의 `loseKit`
   * (킷의 레이드 표식도 거기서 지워진다). 유예 초과 · 부팅 때 이미 늦은 세이브 · 포기가 모두 이 길이다.
   */
  private failSolo(save: SoloRaidSave | null, text: string): void {
    const ctx = this.ctx;
    this.solo = null;
    clearSoloRaid();
    try { ctx.progression?.stripImplantsForCorpse?.(); } catch (e) { console.error('[gameflow] implant strip on a lost solo raid failed', e); }
    if (save) {
      this.settle(save.stats, save.missionTime);
      // 정보상 기믹 고정은 레이드가 끝나야 소모된다 (`meta/parts/Intel`) — 이 레이드가 싣고 나간 것이면 여기서 끝났다
      if (save.intel?.length) { try { ctx.meta?.intel?.consume(); } catch (e) { console.error('[gameflow] intel consume failed', e); } }
    }
    ctx.bus.emit('game:abort', {});
    ctx.bus.emit('ui:notify', { text, kind: 'danger', duration: 6 });
    this.emitChanged();
  }

  /**
   * 튜토리얼 포기 (사용자 결정 — 「처음부터 다시, 캐릭터 세이브는 남긴다」): 레이드 트랙의 진행만 지우면 다음 `게임 시작` 이
   * 튜토리얼 레이드를 처음부터 연다. 튜토리얼에서 주운 것은 그 판의 것이라 킷도 비운다 (`game:abort` → `loseKit`) —
   * 남기면 다시 하는 튜토리얼이 같은 무기를 한 번 더 쥐여 준다. 레벨 · 크레딧 · 창고는 그대로다.
   */
  private restartTutorial(): void {
    const ctx = this.ctx;
    this.solo = null;
    clearSoloRaid();
    try { ctx.tutorial?.restartTrack?.('raid'); } catch (e) { console.error('[gameflow] tutorial restart failed', e); }
    ctx.bus.emit('game:abort', {});
    ctx.bus.emit('ui:notify', { text: '튜토리얼을 포기했습니다 — 다음에 시작하면 처음부터 다시 진행합니다', kind: 'warning', duration: 6 });
    this.emitChanged();
  }

  /**
   * 분대 레이드 포기 = 그 자리에서 사망 + **표류**. 순서가 요점이다:
   *  ① 릴레이가 돌려준 blob 으로 그 레이드의 소지품을 되살린 뒤 사망과 같은 길로 뽑는다 (`InventoryRef.stripForCorpse` —
   *     장착 임플란트는 망가진 짝으로 · 빈 킷을 곧장 저장). blob 이 없으면(저장 전에 끊겼다) 지금 킷을 뽑는다.
   *  ② 그 소지품으로 **내가** 시체를 세운다 — `pcorpse` 규약(「죽은 본인이 보낸다」) 그대로, 몸이 서 있던 자리
   *     (`RaidSessionBlob.pose`)에. 이미 죽어 있었으면(`state` 2) 시체는 그때 섰고 뽑힌 것도 없다.
   *     id 끝이 숫자가 아니어서 받는 쪽 시퀀스(`PlayerCorpseManager.add`)와 겹치지 않는다.
   *  ③ 정산 — 자발적 귀환의 분대 갈래(`parts/Death.finishReturnToShip`)와 같다.
   *  ④ `lobby:abandon` — 릴레이가 표류로 적고 방송한다. 구조선 후보 · 재투입이 그것을 본다.
   */
  private abandonSquad(lobby: LobbyState): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!net) return;
    const blob = net.raidBlob;
    const me = net.localId;
    if (blob) { try { ctx.inventory?.applyRaidState(blob.inventory); } catch (e) { console.error('[gameflow] raid blob restore on abandon failed', e); } }
    let items: ItemInstance[] = [];
    try { items = ctx.inventory?.stripForCorpse?.() ?? []; } catch (e) { console.error('[gameflow] strip on abandon failed', e); }
    const pose = blob?.pose;
    if (blob && pose && pose.state !== 2 && me && items.length > 0) {
      const corpse: PlayerCorpseWire = {
        id: `pcorpse:${me}:d${Date.now().toString(36)}`, owner: me,
        name: lobby.players.find((p) => p.id === me)?.name || net.playerName || '분대원',
        p: [pose.x, pose.y, pose.z], yaw: pose.yaw, at: blob.missionTime, items: itemsToWire(items),
      };
      net.send({ t: 'pcorpse', ev: 'spawn', corpse }, 'others');
    }
    this.settle(blob?.stats ?? null, blob?.missionTime ?? 0);
    net.abandonRaid?.();
    this.dropMark();
    ctx.bus.emit('ui:notify', { text: '레이드를 포기했습니다 — 캐릭터가 사망해 표류 처리되었습니다', kind: 'danger', duration: 6 });
    this.emitChanged();
  }

  /**
   * 사망으로 끝난 레이드의 정산 (`parts/Death.awardMissionXp` — 처치 경험치 `killXp` × 사망 배율, 계약 정산, 레이드 횟수). 결과 화면은
   * 없다 (여기는 타이틀이다). 준비물도 레이드의 끝에 비운다 (A-13).
   */
  private settle(stats: MissionStats | null | undefined, missionTime: number): void {
    const ctx = this.ctx;
    const seed = typeof stats?.seed === 'number' ? stats.seed : 0;
    ctx.missionMode = 'raid';
    ctx.stats = { ...Ctx.freshStats(seed), ...(stats ?? {}), extracted: false, lootValue: 0, timeSeconds: Math.max(0, missionTime), mode: 'raid' };
    this.sys.rewarded = false;
    this.sys.awardMissionXp();
    ctx.progression?.clearActivePreps();
  }

  /* ── 표식 · 방송 ────────────────────────────────────────────────────── */

  private writeMark(mark: SquadMark): void {
    this.mark = mark;
    try { window.localStorage.setItem(slotKey(SQUAD_RAID_MARK_KEY), JSON.stringify(mark)); } catch { /* storage off */ }
  }

  private dropMark(): void {
    if (!this.mark) return;
    this.mark = null;
    try { window.localStorage.removeItem(slotKey(SQUAD_RAID_MARK_KEY)); } catch { /* storage off */ }
  }

  private emitChanged(): void {
    const offer = this.offer;
    const shape = offer
      ? `${offer.kind}|${offer.members.map((m) => `${m.id}${m.connected ? '' : '~'}${m.drifted ? '!' : ''}${m.isHost ? '*' : ''}`).join(',')}`
      : '-';
    const key = `${shape}|${this._checking ? 1 : 0}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.ctx.bus.emit('raid:resumeChanged', { offer, checking: this._checking });
  }
}

/** 유예가 지났는가 — 튜토리얼은 시간 제한이 없다 (`soloRaidStatus` 첫 줄). */
function expired(save: SoloRaidSave): boolean {
  return save.mode !== 'tutorial' && soloRaidStatus(save, Date.now(), readClockHigh()) === 'stale';
}

function readMark(): SquadMark | null {
  try {
    const raw = window.localStorage.getItem(slotKey(SQUAD_RAID_MARK_KEY));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SquadMark> | null;
    return v && typeof v.code === 'string' && typeof v.seed === 'number' && Number.isFinite(v.seed) ? { code: v.code, seed: v.seed } : null;
  } catch { return null; }
}
