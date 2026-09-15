import type { GameContext } from '@/shared';
import { CONTRACT_DEFS, Keys, SUSPENDED_LABEL_KO, WEIGHT_STATE_LABEL_KO, formatCredits, keyLabel } from '@/shared';
/* 2026-09-14 (메신저 · NPC 퀘스트): 목표 달성 · 보고 가능 · 완료 보상 토스트 — 옛 기업 퀘스트(`QUEST_DEFS`) 토스트는 없어졌다 */
import type { NpcQuestDef } from '@/shared';
import { CORP_DEFS, NPC_DEF_MAP, NPC_QUEST_MAP } from '@/shared';
/* 2026-09-13 (요리 재료 티어): 분석 도감 · 분석 레벨업 토스트 */
import { ANALYSIS_RESULTS, SAMPLE_FAMILY_LABEL_KO, analysisTimeMul } from '@/shared';
/* 2026-09-13 (요리 미니게임): 조리 결과 · 식탁 품질 토스트 */
import { cookStepsOf, mealQualityStars, normalizeMealQuality } from '@/shared';
/* 2026-09-13 (탈출 개편): 자동 출발 문구 (출발 유예 `EXTRACTION_DEPART_GRACE_S` 는 2026-09-15 에 탑승 토스트와 함께 빠졌다) */
import { EXTRACTION_AUTO_DEPART_IDLE_S } from '@/shared';
import { el, escapeHtml, rarityColor } from '../dom';
/* 2026-09-11 (B-3): 초대 결과 토스트 */
import type { SocialErrorCode } from '@/shared';
import { SOCIAL_ERROR_MESSAGE_KO, SOCIAL_INVITE_OUTCOME_KO } from '@/shared';

/**
 * Why a squad invite `failed` (B-3). The relay reuses `SocialErrorCode`s with an invite-specific meaning — `not_found` is
 * "the squad is gone (dissolved / the inviter left)", not "no such 아이디" — so the generic error lines would mislead.
 */
const INVITE_FAIL_KO: Partial<Record<SocialErrorCode, string>> = {
  not_found: '분대가 없어졌습니다',
  full: '분대가 가득 찼습니다',
  in_mission: '분대가 임무를 시작했습니다',
  limit: '받은 초대가 너무 많습니다',
  busy: '이미 다른 분대에 있습니다',
  /* 2026-09-15 (분대 · 도킹 매칭): 초대 전용 — 2인 이상 분대에 있는 사람은 초대할 수 없고, 초대는 분대장만 보낸다 */
  in_other_squad: '이미 다른 분대에 있습니다',
  not_leader: '분대장만 초대할 수 있습니다',
};
function inviteFailWhy(code: SocialErrorCode | undefined): string {
  if (!code) return '';
  const text = INVITE_FAIL_KO[code] ?? SOCIAL_ERROR_MESSAGE_KO[code] ?? '';
  return text ? ` <span style="color:var(--c-text-dim)">(${escapeHtml(text)})</span>` : '';
}
import { stratagemDef } from './stratagemGlyphs';
/* 2026-09-15 (안드로이드 분대원): 명단 변화 · 슬롯 복귀 · 쓰러짐 · 사망 · 창고 입고 토스트 */
import type { AllyId } from '@/shared';
import { androidNameOf } from '@/shared';

/**
 * 2026-09-15 — 주격 조사 `이` / `가`. 한글 음절의 종성이 있으면 `이`, 없으면 `가` (그 밖의 글자는 `가`).
 * 안드로이드 이름(`안드로이드 알파` · `베타` · `감마`)은 모두 종성이 없어 `가` 지만, 이름이 늘어나도 문장이 어색해지지
 * 않게 규칙으로 고른다 — `이(가)` 를 늘어놓지 않는다는 2026-09-15 결정.
 */
function josaGa(name: string): string {
  const ch = name.charCodeAt(name.length - 1);
  if (!Number.isFinite(ch) || ch < 0xac00 || ch > 0xd7a3) return '가';
  return (ch - 0xac00) % 28 === 0 ? '가' : '이';
}

/** 2026-09-13 (요리 품질): 별 글자 색 — 툴팁 품질 줄 · 버프 썸네일 별 배지와 같은 금색. */
const STAR_COLOR = '#ffd24a';
/** ` ★★★☆☆` (앞 공백 포함, 금색 span). 품질 0 이면 빈 문자열. */
function starsHtml(quality: unknown): string {
  const q = normalizeMealQuality(quality);
  return q > 0 ? ` <span style="color:${STAR_COLOR}">${mealQualityStars(q)}</span>` : '';
}

type Kind = 'info' | 'warning' | 'danger' | 'success';
const MAX_VISIBLE = 6;
/** Durability warning tiers (fraction of max). */
const DUR_WARN = 0.25;
const DUR_CRIT = 0.1;

/**
 * Right-center notification stack with kind-colored left borders and slide/fade dismiss. Lives in the social HUD
 * layer, so it also shows in the ship hub (the hub menu uses blocker token 'hub', not 'menu').
 */
export class Notifications {
  readonly root: HTMLElement;
  private unsubs: Array<() => void> = [];
  private live: HTMLElement[] = [];
  private lastCountdown = -1;
  private lastStructureToast = -Infinity;
  private cooldownWasRunning = false;
  /** uid → warning tier already shown (1 = ≤25 %, 2 = ≤10 %). */
  private durWarned = new Map<string, number>();
  /** The one live channel line (Phase 12 회복 스프레이), null while no continuous-use item is held. */
  private channel: { el: HTMLElement; text: HTMLElement; defId: string; pct: number } | null = null;
  /** 2026-09-15: 안드로이드 id → 표시 이름. 슬롯으로 돌아간 기는 명단에 없으므로 이름을 여기서 꺼낸다. */
  private allyNames = new Map<AllyId, string>();

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'notifs', parent });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('ui:notify', ({ text, kind, duration }) => this.push(escapeHtml(text), kind ?? 'info', undefined, duration)),
      b.on('inventory:itemAdded', ({ name, rarity, item, fromStash }) => {
        // 2026-09-12 (사용자 결정): 함선 창고 → 가방은 옮긴 것이지 얻은 것이 아니다 — 획득 티커를 띄우지 않는다
        if (fromStash) return;
        const qty = item.qty > 1 ? ` <span style="color:var(--c-text-dim)">×${item.qty}</span>` : '';
        this.push(`획득: <b style="color:${rarityColor(rarity)}">${escapeHtml(name)}</b>${qty}`, 'info', '아이템', 3);
      }),
      b.on('inventory:full', ({ name }) => this.push(`가방이 가득 찼습니다 — <b>${escapeHtml(name)}</b>`, 'warning', '인벤토리', 3)),
      b.on('inventory:bagChanged', ({ dropped }) => {
        if (dropped.length > 0) this.push(`가방이 작아져 아이템 <b>${dropped.length}</b>개를 떨어뜨렸습니다`, 'warning', '인벤토리', 4);
      }),
      b.on('enemy:waveStarted', ({ index, count }) => this.push(`적 증원 감지! <span style="color:var(--c-text-dim)">${index + 1}차 · ${count}마리</span>`, 'danger', '경고', 4)),
      /* 2026-09-14 (튜토리얼): 이미 착륙해 있는 함선(`beginPreLanded`)은 이 둘을 `duration: 0` 으로 **재생**해
         페이즈만 맞춘다 — 「도착까지 0초」는 일어나지 않은 일이므로 띄우지 않는다. 본편은 언제나 duration > 0. */
      b.on('extraction:activated', ({ duration }) => {
        if (duration <= 0) return;
        this.push(`탈출 신호 전송 완료. 함선 도착까지 ${Math.round(duration)}초.`, 'success', '탈출', 4);
      }),
      b.on('extraction:shipIncoming', ({ eta }) => this.push(`함선 접근 중 — ${Math.round(eta)}초`, 'warning', '탈출', 4)),
      // 2026-09-13 (탈출 개편): 착륙 → 자동 출발 대기 → 출발 유예 → 이륙 / 남겨짐 → 다시 호출 가능
      b.on('extraction:shipLanded', () => {
        /* 2026-09-14 3차 (사용자 결정): 튜토리얼의 버려진 함선은 처음부터 그 자리에 서 있다 — 「착륙」도
           「도착」도 일어난 일이 아니라 토스트를 아예 쓰지 않는다. 이벤트 자체는 그대로 흐른다
           (함선 마커 · 음악이 같은 이벤트에 매달려 있어, 안 내면 마커가 사라진다). */
        if (ctx.missionMode === 'tutorial') return;
        // 자동 출발을 걸지 않은 함선은 그 문장이 거짓이다 — `idleRemaining < 0` 이 그 사실이다.
        const auto = (ctx.extraction?.idleRemaining ?? 0) >= 0;
        this.push(auto ? `함선 착륙. 탑승하세요 — ${Math.round(EXTRACTION_AUTO_DEPART_IDLE_S)}초 뒤 자동 출발` : '함선 착륙. 탑승하세요',
          'success', '탈출', 4);
      }),
      /* 2026-09-15 (사용자 결정): `extraction:boarded` 토스트(「탑승 확인. 내부 스위치를 …초 뒤 출발합니다.」)를 **모든 레이드에서** 없앴다 —
         같은 사실을 좌상단 목표 줄(`ui/hud/Objective` 의 `liftoffSwitch`)이 이미 말하고 있고, 화물칸을 드나들 때마다 다시 떴다.
         이벤트 자체는 계약이라 그대로 흐른다 (`extraction/ExtractionSystem` · 분대 탑승 표시가 쓴다) — 여기 구독만 없다. */
      b.on('extraction:departureStarted', ({ duration, auto }) => this.push(
        auto ? `대기 시간 초과 — <b>${Math.round(duration)}초</b> 뒤 함선이 출발합니다` : `출발 시퀀스 개시 — <b>${Math.round(duration)}초</b> 뒤 함선이 출발합니다`,
        'warning', '탈출', 5)),
      b.on('extraction:liftoff', ({ aboard, squadDone }) => {
        if (aboard ?? true) this.push('이륙 — 탈출 성공', 'success', '탈출', 4);
        else if (squadDone ?? true) this.push('함선 이륙', 'info', '탈출', 4);
        else this.push('함선이 출발했습니다 — 탑승하지 못했습니다', 'danger', '탈출', 5);
      }),
      b.on('extraction:reset', () => this.push('함선이 떠났습니다 — 탈출 신호소를 다시 작동할 수 있습니다', 'info', '탈출', 5)),
      b.on('crate:looted', () => this.push('상자를 모두 비웠습니다.', 'info', '보급', 2.5)),
      // Phase 12: the 회복 스프레이 calls `applyHeal` (→ `player:stimUsed`) ten times a second while it is held; the
      // channel line below stands in for all of them, so this toast is muted while a channel is active.
      b.on('player:stimUsed', () => { if (!this.channel) this.push('회복제 사용', 'success', '생명력', 2); }),
      // down / revive / respawn (Phase 2)
      b.on('player:revived', ({ hp }) => this.push(`부활 — 체력 <b>${Math.ceil(hp)}</b>`, 'success', '생명력', 3)),
      // 2026-09-09: 자동 부활이 사라져 `game:respawnAvailable` 은 아무도 발행하지 않는다 — 그 자리에 구조선 알림이 온다
      b.on('rescue:called', ({ targetName }) => this.push(`${escapeHtml(targetName)} 구조선 호출됨`, 'success', '구조', 3)),
      b.on('leader:deviceDropped', () => this.push('분대장 기기가 떨어졌습니다', 'warning', '분대장', 4)),
      b.on('net:remoteDowned', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 전투불능 — 구조 필요`, 'danger', '분대', 4)),
      b.on('net:remoteRevived', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 부활`, 'success', '분대', 3)),
      // multiplayer feed
      b.on('net:remoteDied', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 전사`, 'danger', '분대', 4)),
      // 2026-09-11 (B-12): 합류 · 이탈 토스트의 **유일한** 주인 (`hub/HubSystem` 의 `함선 합류 · 이탈` 두 줄을 지웠다).
      // 게이트가 없는 것은 일부러다 — 레이드 · 훈련 중에도 분대원이 들어오고 나가는 것은 알아야 한다.
      b.on('net:peerJoined', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 합류`, 'info', '분대', 3)),
      b.on('net:peerLeft', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 이탈`, 'warning', '분대', 3.5)),
      b.on('net:lobbyLeft', ({ reason }) => { if (reason === 'hostLeft') this.push('호스트가 나갔습니다', 'warning', '분대', 4); }),
      /* ── 2026-09-15 (안드로이드 분대원, docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」) ──
       * 토스트의 유일한 주인은 여기다 (2026-09-11 B-12 규약) — allies · net 은 이벤트만 낸다. `evicted` 는
       * 「사람이 합류해 밀려났다」라서 `removed`(분대장이 직접 돌려보냈다)와 문장이 다르다. */
      b.on('ally:rosterChanged', ({ roster, added, removed, evicted }) => {
        const gone = new Set(evicted);
        for (const id of removed) {
          const name = this.allyName(id);
          if (gone.has(id)) this.push(`분대원이 합류해 <b>${escapeHtml(name)}</b>${josaGa(name)} 슬롯으로 돌아갔다`, 'warning', '분대', 4);
          else this.push(`<b>${escapeHtml(name)}</b>${josaGa(name)} 슬롯으로 돌아갔다`, 'info', '분대', 3);
        }
        // 이름표는 명단이 알려 준다 — 나중에 빠진 기의 이름을 부르려면 여기서 미리 적어 둬야 한다.
        this.allyNames.clear();
        for (const e of roster) this.allyNames.set(e.id, e.name);
        for (const id of added) {
          const name = this.allyName(id);
          this.push(`<b>${escapeHtml(name)}</b>${josaGa(name)} 분대에 합류했다`, 'success', '분대', 3);
        }
      }),
      // 릴레이가 「가득 찼다」로 거절했다 (요청자에게만). `human_joined` 는 위 `evicted` 줄이 이미 말한다.
      b.on('net:androidReturned', ({ reason }) => {
        if (reason !== 'full') return;
        this.push('분대가 가득 차 안드로이드를 들일 수 없다', 'warning', '분대', 4);
      }),
      b.on('ally:downed', ({ id, name }) => {
        const n = name || this.allyName(id);
        this.push(`<b>${escapeHtml(n)}</b> 전투불능 — 구조 필요`, 'danger', '분대', 4);
      }),
      b.on('ally:died', ({ id, name }) => {
        const n = name || this.allyName(id);
        this.push(`<b>${escapeHtml(n)}</b> 파괴됨`, 'danger', '분대', 4);
      }),
      b.on('ally:deposited', ({ id, name, count, lost }) => {
        const n = name || this.allyName(id);
        const miss = lost > 0 ? ` <span style="color:var(--c-text-dim)">(창고가 가득 차 ${lost}개 유실)</span>` : '';
        this.push(`<b>${escapeHtml(n)}</b>${josaGa(n)} 전리품 <b>${count}</b>개를 창고에 넣었다${miss}`, count > 0 ? 'success' : 'info', '분대', 4);
      }),
      /*
       * 2026-09-11 (A-3c 공유 식탁): 「한 명이 차리면 분대 전원이 받는다」(사용자 결정)의 알림. `housing:mealServed`
       * 는 차린 쪽의 `housing/` 이 내고 net/ 이 릴레이하지만, **토스트를 띄우는 것은 여기 하나**다 — 합류 · 이탈
       * 토스트와 같은 규약(2026-09-11 B-12: 「토스트의 유일한 주인은 ui/」). housing · net 은 이벤트만 낸다.
       * 게이트가 없는 것은 일부러다: 차려 준 사람은 공유 함선에 있고 받는 사람도 그 함선에 있다.
       */
      b.on('housing:mealServed', ({ defId, by, quality }) => {
        const def = ctx.loot?.getItemDef(defId);
        const name = def?.name ?? defId;
        // 2026-09-13 (요리 품질): 차린 요리의 별 (0 이면 생략)
        this.push(
          `<b>${escapeHtml(by || '분대원')}</b> 님이 <b style="color:${rarityColor(def?.rarity ?? 'common')}">${escapeHtml(name)}</b>${starsHtml(quality)} 을(를) 차렸습니다`,
          'success', '식탁', 4,
        );
      }),
      /*
       * 2026-09-13 (요리 미니게임, `docs/DECISIONS.md` 「2026-09-13 — 요리 미니게임」): 조리 한 번의 결과. housing 은 이벤트만 내고 토스트는 여기 하나다
       * (위 식탁 줄과 같은 규약). 성공 = `<요리> ★★★★☆ → 함선 창고|가방`, 실패 = `result.reason` 경고. 같은 순간의 `craft:completed` 는
       * 아래에서 조리대 요리면 토스트를 내지 않는다 — 이 줄이 대신한다 (`inventory:itemAdded` 획득 티커는 일반 제작과 같이 그대로 뜬다).
       */
      b.on('housing:cookResult', ({ result }) => {
        if (!result) return;
        const def = ctx.loot?.getItemDef(result.mealDefId);
        const name = `<b style="color:${rarityColor(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? result.mealDefId)}</b>`;
        if (result.itemUid && result.landed && !result.reason) {
          const where = result.landed === 'stash' ? '함선 창고' : '가방';
          const stars = `<span style="color:${STAR_COLOR}">${mealQualityStars(result.quality)}</span>`;
          this.push(`${name} ${stars} <span style="color:var(--c-text-dim)">→ ${where}</span>`, 'success', '요리', 4);
        } else {
          this.push(`${name} — ${escapeHtml(result.reason || '요리를 만들지 못했습니다')}`, 'warning', '요리', 4);
        }
      }),
      /*
       * 2026-09-13 (요리 재료 티어, `docs/DECISIONS.md` 「2026-09-13 — 요리 재료 티어」): 분석기의 두 알림. housing 은 이벤트만 내고 토스트는 여기 하나다
       * (위 식탁 줄과 같은 규약). 옛 `housing:sampleDexAdded`(표본 도감) 는 더 나지 않고 ui 에 소비자도 없었다.
       *  - `analysisFound` — 분석 도감에 **처음** 적힌 산출물.
       *  - `analysisLevelUp` — 계열 레벨이 오른 순간: 그 레벨의 해석 시간 배수(`analysisTimeMul`) + 이번 레벨에서 **새로 풀린** 결과
       *    (`ANALYSIS_RESULTS` 중 같은 계열 · `minLevel === level` · 가중치 > 0 · 은퇴 아닌 것, 이름은 `ctx.loot.getItemDef`).
       */
      b.on('housing:analysisFound', ({ defId }) => {
        const def = ctx.loot?.getItemDef(defId);
        this.push(
          `분석 도감 — <b style="color:${rarityColor(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? defId)}</b> 발견`,
          'success', '분석', 4,
        );
      }),
      b.on('housing:analysisLevelUp', ({ family, level }) => {
        const fam = SAMPLE_FAMILY_LABEL_KO[family] ?? family;
        const mul = Math.round(analysisTimeMul(level) * 100) / 100;
        const names: string[] = [];
        for (const r of ANALYSIS_RESULTS) {
          if (r.family !== family || r.minLevel !== level || !(r.weight > 0)) continue;
          const def = ctx.loot?.getItemDef(r.defId);
          if (def?.retired) continue;
          const name = def?.name ?? r.defId;
          if (!names.includes(name)) names.push(name);
        }
        const fresh = names.length > 0 ? ` · 새 결과: <b>${names.map((n) => escapeHtml(n)).join(', ')}</b>` : '';
        this.push(`<b>${escapeHtml(fam)} 분석 Lv.${level}</b> — 해석 시간 ×${mul}${fresh}`, 'success', '분석', 5);
      }),
      b.on('pickup:taken', ({ item, byLocal, byName }) => {
        if (byLocal) return;
        const def = ctx.loot?.getItemDef(item.defId);
        const qty = item.qty > 1 ? ` <span style="color:var(--c-text-dim)">×${item.qty}</span>` : '';
        this.push(`<b>${escapeHtml(byName ?? '분대원')}</b> 획득: <b style="color:${rarityColor(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? item.defId)}</b>${qty}`, 'info', '분대', 3);
      }),
      // matchmaking / hub
      /*
       * 2026-09-11 (B-1): `net:reconnecting` / `net:resumed` 토스트를 여기서 걷어냈다 — 같은 순간에 두 줄씩 떴다.
       * 레이드 · 훈련 중에는 `game/GameFlowSystem` 이 (`서버 재연결 중… (n)` · `재연결됨` · 복귀 사유), 함선에서는
       * `hud/NetBadge`(끊김 → 연결 전이 토스트 + 배지의 `서버 재연결 중… (n)`)와 `hub/parts/Transitions.onResumed`
       * (`함선에 재접속했습니다` · `진행 중인 임무로 복귀합니다`)가 각자 한 줄씩만 낸다.
       */
      b.on('net:matched', ({ created }) => this.push(created ? '신호 송출 시작 — 대원 대기 중' : '공유 함선 신호 포착', created ? 'info' : 'success', '매치', 4)),
      b.on('hub:launchCountdown', ({ seconds }) => {
        const s = Math.ceil(seconds);
        if (s === this.lastCountdown || s <= 0) return;
        this.lastCountdown = s;
        this.push(`발사 <b>${s}</b>초 전`, 'warning', '발사', 1.1);
      }),
      b.on('hub:entered', () => { this.lastCountdown = -1; }),
      // ship calls (Phase 3)
      b.on('stratagem:called', ({ kind, caller }) => {
        if (caller === null) return; // own calls: the panel / targeting HUD already say it
        const name = ctx.net?.getLobbyPlayer(caller)?.name ?? ctx.net?.getRemotePlayer(caller)?.name ?? '분대원';
        this.push(`<b>${escapeHtml(name)}</b> 함선 호출: <b>${escapeHtml(stratagemDef(kind)?.name ?? kind)}</b>`, 'warning', '호출', 4);
      }),
      b.on('stratagem:landed', ({ kind }) => {
        if (kind === 'orbital_laser' || kind === 'airstrike') this.push(`착탄 — <b>${escapeHtml(stratagemDef(kind)?.name ?? kind)}</b>`, 'danger', '호출', 3);
      }),
      b.on('structure:destroyed', () => {
        const now = performance.now();
        if (now - this.lastStructureToast < 1000) return;
        this.lastStructureToast = now;
        this.push('엄폐물 파괴', 'warning', '구조물', 2.5);
      }),
      b.on('stratagem:cooldown', ({ remaining, refunded }) => {
        if (remaining > 0) { this.cooldownWasRunning = true; return; }
        if (!this.cooldownWasRunning) return;
        this.cooldownWasRunning = false;
        // 2026-09-11 (E-8): 이 0 이 호스트의 거절을 되돌려 준 것이면(`refundCooldown`) 준비 완료를 띄우지 않는다 —
        // `stratagems` 가 이미 거절 사유 토스트를 띄웠고, 두 줄이 나란히 뜨면 무엇이 일어났는지 오히려 흐려진다.
        if (refunded) return;
        this.push('함선 호출 준비 완료', 'success', '호출', 3);
      }),
      b.on('game:abort', () => { this.clear(); this.cooldownWasRunning = false; }),
      b.on('game:newMission', ({ mode }) => {
        this.clear(); this.lastCountdown = -1; this.cooldownWasRunning = false; this.durWarned.clear();
        if (mode === 'training') this.push('시뮬레이션 훈련장 입장 — 탄약 · 내구도 미소모, 출구 콘솔로 종료', 'info', '훈련장', 5);
      }),
      /* ── Phase 7: host migration / suspended members / training ── */
      b.on('net:hostChanged', ({ hostId, isLocalHost }) => {
        const name = isLocalHost || hostId === ctx.net?.localId ? (ctx.net?.playerName ?? '나')
          : (ctx.net?.getLobbyPlayer(hostId)?.name ?? ctx.net?.getRemotePlayer(hostId)?.name ?? '분대원');
        this.push(`호스트 변경: <b>${escapeHtml(name)}</b>${isLocalHost ? ' <span style="color:var(--c-text-dim)">(나)</span>' : ''}`, 'warning', '네트워크', 4);
      }),
      b.on('net:peerSuspended', ({ name, suspended }) => {
        if (suspended) this.push(`<b>${escapeHtml(name)}</b> ${SUSPENDED_LABEL_KO} — 자리 유지 중`, 'warning', '분대', 4);
        else this.push(`<b>${escapeHtml(name)}</b> 재연결`, 'success', '분대', 3);
      }),
      b.on('training:exitRequested', () => this.push('시뮬레이션 훈련장 퇴장 — 장비 복원', 'info', '훈련장', 3)),
      /* ── Phase 11 소셜: the folder's one toast owner reports every social outcome (the panels never toast) ── */
      b.on('social:error', ({ message }) => this.push(escapeHtml(message), 'warning', '소셜', 3.5)),
      b.on('social:play', ({ name, outcome }) => {
        const who = escapeHtml(name || '분대원');
        if (outcome === 'joined') this.push(`<b>${who}</b> 분대에 합류합니다`, 'success', '소셜', 3.5);
        else this.push(`<b>${who}</b>에게 분대 초대를 보냈습니다`, 'info', '소셜', 3.5);
      }),
      b.on('social:invited', ({ invite }) => this.push(`<b>${escapeHtml(invite.name || '분대원')}</b> 분대 초대 — ${keyLabel(Keys.INVITE)} 홀드로 참여`, 'info', '소셜', 5)),
      /*
       * 2026-09-11 (B-3): how an invite **I sent** ended. 거절 and 만료 read differently on purpose (user decision) —
       * `superseded` says nothing (the newer invite's own `…에게 분대 초대를 보냈습니다` already did). A failed whisper is
       * never toasted here: its own chat line turns `전송 실패` (B-4).
       */
      b.on('social:inviteResult', ({ name, outcome, reason }) => {
        // `accepted`: 받은 사람이 들어오는 순간 바로 아래 `net:peerJoined` 의 `<이름> 합류` 가 이미 뜬다 — 두 번째 줄은 뺀다.
        // ⚠ 그래서 `:83` 의 합류 줄이 초대 수락의 **유일한** 알림이다 — 지우려면 여기부터 되살려야 한다
        //   (2026-09-11 B-12 는 반대편, 즉 `hub/HubSystem` 의 `<이름> 함선 합류` 를 지웠다).
        if (outcome === 'superseded' || outcome === 'accepted') return;
        const why = outcome === 'failed' ? inviteFailWhy(reason) : '';
        const kind = outcome === 'declined' || outcome === 'failed' ? 'warning' : 'info';
        this.push(`<b>${escapeHtml(name || '분대원')}</b> ${escapeHtml(SOCIAL_INVITE_OUTCOME_KO[outcome])}${why}`, kind, '소셜', 4);
      }),
      // B-3: an invite I **received** that the relay cancelled (their squad started / filled / dissolved) — the card is gone.
      // `limit` is the relay trimming my stack for a newer invite: the card just makes room, exactly like the local trim.
      b.on('social:inviteClosed', ({ reason, detail }) => {
        if (reason !== 'failed' || detail === 'limit') return;
        this.push(`분대 초대가 취소되었습니다${inviteFailWhy(detail)}`, 'warning', '소셜', 3.5);
      }),
      /* ── tactical kit: gear, gathering, crafting, gadgets, progression ── */
      b.on('durability:changed', ({ uid, defId, durability, max }) => {
        if (max <= 0) return;
        const ratio = durability / max;
        const tier = ratio <= DUR_CRIT ? 2 : ratio <= DUR_WARN ? 1 : 0;
        const prev = this.durWarned.get(uid) ?? 0;
        if (tier <= prev) { if (tier === 0 && prev !== 0) this.durWarned.set(uid, 0); return; }
        this.durWarned.set(uid, tier);
        if (tier === 0) return;
        const name = ctx.loot?.getItemDef(defId)?.name ?? defId;
        this.push(
          `내구도 ${tier === 2 ? '위험' : '주의'} — <b>${escapeHtml(name)}</b> <span style="color:var(--c-text-dim)">${Math.round(ratio * 100)}%</span>`,
          tier === 2 ? 'danger' : 'warning', '장비', 3.2,
        );
      }),
      b.on('durability:broken', ({ uid, name }) => {
        this.durWarned.set(uid, 2);
        this.push(`파손: <b>${escapeHtml(name)}</b> — 성능이 크게 떨어집니다`, 'danger', '장비', 4);
      }),
      b.on('repair:completed', ({ uid, name }) => {
        this.durWarned.delete(uid);
        this.push(`수리 완료: <b>${escapeHtml(name)}</b>`, 'success', '장비', 3);
      }),
      b.on('inventory:overloaded', ({ state }) => {
        const label = WEIGHT_STATE_LABEL_KO[state] ?? state;
        if (state === 'over') this.push(`<b>과적</b> — 이동할 수 없습니다`, 'danger', '무게', 4);
        else if (state === 'heavy') this.push(`<b>${escapeHtml(label)}</b> — 구르기 불가, 이동 속도 감소`, 'warning', '무게', 3.5);
        else if (state === 'light') this.push(`${escapeHtml(label)} — 스태미나 회복 감소`, 'info', '무게', 2.5);
      }),
      // Phase 12: no `gather:collected` toast any more — the herb lands in the bag through `tryAddItem`, whose
      // `inventory:itemAdded` line above is the one ticker a gather shows (the 채집 line doubled it).
      /* ── Phase 12: continuous-use item (회복 스프레이) — ONE line for the whole channel, updated in place ── */
      b.on('item:channelChanged', ({ defId, active, gauge }) => this.setChannel(ctx, defId, active, gauge)),
      b.on('craft:completed', ({ item }) => {
        // 2026-09-13 (요리 미니게임): 조리대 요리는 `housing:cookResult` 토스트가 대신한다 — 조리대 레시피는 일반 제작 경로에서 빠졌으므로
        // 산출물에 조리 단계가 있으면 곧 `completeCook` 이 낸 이벤트다
        if (cookStepsOf(item.defId).length > 0) return;
        const def = ctx.loot?.getItemDef(item.defId);
        const qty = item.qty > 1 ? ` <span style="color:var(--c-text-dim)">×${item.qty}</span>` : '';
        this.push(`제작 완료: <b style="color:${rarityColor(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? item.defId)}</b>${qty}`, 'success', '제작', 3);
      }),
      b.on('craft:failed', ({ reason }) => {
        const msg = reason === 'missing' ? '재료가 부족합니다' : reason === 'space' ? '가방에 공간이 없습니다' : '제작을 취소했습니다';
        this.push(msg, reason === 'cancelled' ? 'info' : 'warning', '제작', 2.5);
      }),
      b.on('gadget:recovered', ({ item }) => {
        const name = ctx.loot?.getItemDef(item.defId)?.name ?? item.defId;
        this.push(`회수: <b>${escapeHtml(name)}</b>`, 'info', '장비', 2.5);
      }),
      b.on('gadget:deployed', ({ kind }) => {
        if (kind === 'mine') this.push('지뢰 설치됨 — 피아 구분 없음, 접근 주의', 'danger', '경고', 3.5);
      }),
      b.on('player:gritSaved', () => this.push('인내 — 치명상을 버텨냈습니다', 'warning', '생명력', 3)),
      b.on('implant:equipped', ({ id }) => {
        if (!id) { this.push('전술 임플란트 해제', 'info', '임플란트', 2.5); return; }
        const name = ctx.implants?.getDef(id)?.name ?? id;
        this.push(`전술 임플란트 장착: <b>${escapeHtml(name)}</b>`, 'info', '임플란트', 3);
      }),
      /* ── Phase 5: corporations (short lines; the credits chip / rep / contract toasts live in MetaToasts) ── */
      /* ── 2026-09-14: NPC 퀘스트 (docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」) — 옛 기업 퀘스트 완료 토스트(`meta:questChanged`)는 기업 퀘스트와 함께
       * 없어졌다. 새 NPC 메시지(`npc:message`)는 메신저(ui/menus/messenger)가 띄운다. 훈련장에서는 아무것도 띄우지 않는다. ── */
      b.on('npc:objectiveProgress', ({ questId, index, done, raid }) => {
        if (!done || !raid || ctx.isTraining()) return;
        const info = ctx.meta?.npc?.getQuest(questId) ?? null;
        const name = info?.def.name ?? NPC_QUEST_MAP.get(questId)?.name ?? questId;
        const label = info?.objectives.find((o) => o.def.index === index)?.label ?? '';
        this.push(`퀘스트 목표 달성 — <b>${escapeHtml(name)}</b>${label ? `: ${escapeHtml(label)}` : ''}`, 'success', '퀘스트', 4);
      }),
      b.on('npc:questReady', ({ id }) => {
        if (ctx.isTraining()) return;
        const name = ctx.meta?.npc?.getQuest(id)?.def.name ?? NPC_QUEST_MAP.get(id)?.name ?? id;
        this.push(`<b>${escapeHtml(name)}</b> — 함선에서 메신저로 완료 보고`, 'info', '퀘스트', 5);
      }),
      b.on('npc:questChanged', ({ id, state, prev }) => {
        if (state !== 'complete' || prev === 'complete' || ctx.isTraining()) return;
        const def: NpcQuestDef | undefined = ctx.meta?.npc?.getQuest(id)?.def ?? NPC_QUEST_MAP.get(id);
        const r = def?.rewards;
        const parts: string[] = [];
        if (r) {
          if (r.credits > 0) parts.push(`크레딧 ${formatCredits(r.credits, { sign: true })}`);
          if (r.xp > 0) parts.push(`XP +${r.xp}`);
          for (const rep of r.rep) parts.push(`${escapeHtml(CORP_DEFS[rep.corp]?.name ?? rep.corp)} 신뢰도 +${rep.amount}`);
          /* 2026-09-14: NPC 개인 신뢰도 — 기업 신뢰도 바로 뒤 (메신저 대화의 `보상 — …` 줄 · 퀘스트 카드 칩과 같은 순서) */
          if (r.npcTrust > 0 && def) parts.push(`${escapeHtml(NPC_DEF_MAP.get(def.npc)?.name ?? def.npc)} 신뢰도 +${r.npcTrust}`);
          for (const it of r.items) {
            const d = ctx.loot?.getItemDef(it.defId);
            const qty = it.qty > 1 ? ` ×${it.qty}` : '';
            parts.push(`<b style="color:${rarityColor(d?.rarity ?? 'common')}">${escapeHtml(d?.name ?? it.defId)}</b>${qty}`);
          }
        }
        const rw = parts.length ? ` <span style="color:var(--c-text-dim)">— ${parts.join(' · ')}</span>` : '';
        this.push(`퀘스트 완료 · <b>${escapeHtml(def?.name ?? id)}</b>${rw}`, 'success', '퀘스트', 5);
      }),
      b.on('meta:contractAccepted', ({ id }) => {
        const name = CONTRACT_DEFS.find((c) => c.id === id)?.name ?? id;
        this.push(`계약 수락 · <b>${escapeHtml(name)}</b>`, 'info', '계약', 3);
      }),
      b.on('meta:contractAbandoned', ({ id }) => {
        const name = CONTRACT_DEFS.find((c) => c.id === id)?.name ?? id;
        this.push(`계약 포기 · <b>${escapeHtml(name)}</b>`, 'warning', '계약', 3);
      }),
      b.on('meta:purchase', ({ defId, price, placed }) => {
        const def = ctx.loot?.getItemDef(defId);
        const where = placed === 'stash' ? ' <span style="color:var(--c-text-dim)">(창고)</span>' : '';
        this.push(`구매: <b style="color:${rarityColor(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? defId)}</b> · 크레딧 ${formatCredits(-price, { sign: true })}${where}`, 'info', '상점', 3);
      }),
      b.on('meta:sale', ({ defId, qty, credits }) => {
        const def = ctx.loot?.getItemDef(defId);
        const q = qty > 1 ? ` <span style="color:var(--c-text-dim)">×${qty}</span>` : '';
        this.push(`판매: <b style="color:${rarityColor(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? defId)}</b>${q} · 크레딧 ${formatCredits(credits, { sign: true })}`, 'success', '상점', 3);
      }),
      b.on('game:abort', () => this.clear()),
    );
  }

  /**
   * 2026-09-15: 안드로이드 표시 이름. 마지막 명단에 있으면 그 이름, 없으면 id 꼬리의 bay 번호로 `androidNameOf`
   * (id 는 `androidIdOf(scope, bay)` = `android:<scope>:<bay>` 라 마지막 칸이 bay 다).
   */
  private allyName(id: AllyId): string {
    const known = this.allyNames.get(id);
    if (known) return known;
    const bay = Number.parseInt(String(id).slice(String(id).lastIndexOf(':') + 1), 10);
    return Number.isFinite(bay) ? androidNameOf(bay) : '안드로이드';
  }

  push(html: string, kind: Kind, label?: string, duration = 3.5): void {
    const n = el('div', { cls: `notif ${kind}` });
    if (label) el('span', { cls: 'k', text: label, parent: n });
    el('span', { cls: 't', html, parent: n });
    this.root.appendChild(n);
    this.live.push(n);
    requestAnimationFrame(() => n.classList.add('in'));
    while (this.live.length > MAX_VISIBLE) this.dismiss(this.live[0]);
    window.setTimeout(() => this.dismiss(n), duration * 1000);
  }

  private dismiss(n: HTMLElement): void {
    const i = this.live.indexOf(n);
    if (i < 0) return;
    this.live.splice(i, 1);
    n.classList.remove('in'); n.classList.add('out');
    window.setTimeout(() => n.remove(), 300);
  }

  /**
   * Phase 12: the channel line. `active:true` creates it once (or updates the percentage in place — no new node per
   * tick), `active:false` dismisses it. It is pinned outside the `MAX_VISIBLE` rotation so a burst of other toasts
   * cannot push it out mid-channel. `gauge` is the remaining gauge 0..1 per the contract (an absolute value ≥ 1 is
   * still read as a fraction of the item's `durabilityMax`, so an older weapons build renders sensibly).
   */
  private setChannel(ctx: GameContext, defId: string, active: boolean, gauge: number): void {
    if (!active) {
      if (this.channel) {
        const n = this.channel.el;
        this.channel = null;
        n.classList.remove('in'); n.classList.add('out');
        window.setTimeout(() => n.remove(), 300);
      }
      return;
    }
    const def = ctx.loot?.getItemDef(defId);
    const max = def?.durabilityMax ?? 0;
    const frac = gauge > 1 && max > 0 ? gauge / max : Math.min(1, Math.max(0, gauge));
    const pct = Math.round(frac * 100);
    const name = def?.name ?? defId;
    if (this.channel && this.channel.defId !== defId) this.setChannel(ctx, this.channel.defId, false, 0);
    if (!this.channel) {
      const n = el('div', { cls: 'notif info channel' });
      el('span', { cls: 'k', text: '사용 중', parent: n });
      const text = el('span', { cls: 't', parent: n });
      this.root.appendChild(n);
      requestAnimationFrame(() => n.classList.add('in'));
      this.channel = { el: n, text, defId, pct: -1 };
    }
    if (pct !== this.channel.pct) {
      this.channel.pct = pct;
      this.channel.text.innerHTML = `<b>${escapeHtml(name)}</b> 사용 중 · <span class="pct">${pct} %</span>`;
    }
  }

  /** Text of the live channel line (debug), null when none. */
  get channelText(): string | null { return this.channel ? this.channel.el.textContent : null; }
  /** Live toast nodes, the channel line excluded (debug). */
  get liveCount(): number { return this.live.length; }
  /** 2026-09-15 (debug / smoke): 지금 떠 있는 토스트의 글자 (오래된 것부터). */
  get toastTexts(): string[] { return this.live.map((n) => n.textContent ?? ''); }

  private clear(): void {
    for (const n of this.live) n.remove();
    this.live.length = 0;
    if (this.channel) { this.channel.el.remove(); this.channel = null; }
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
