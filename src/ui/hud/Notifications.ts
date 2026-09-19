import type { GameContext } from '@/shared';
import { CONTRACT_DEFS, Keys, SUSPENDED_LABEL_KO, WEIGHT_STATE_LABEL_KO, formatCredits, keyLabel } from '@/shared';
/* 2026-09-14 (the messenger · NPC quests): objective done · ready to report · completion reward toasts — the old corporation quest (`QUEST_DEFS`) toast is gone */
import type { NpcQuestDef } from '@/shared';
import { CORP_DEFS, NPC_DEF_MAP, NPC_QUEST_MAP } from '@/shared';
/* 2026-09-13 (cooking material tiers): analysis catalogue · analysis level-up toasts */
import { ANALYSIS_RESULTS, SAMPLE_FAMILY_LABEL_KO, analysisTimeMul } from '@/shared';
/* 2026-09-13 (the cooking minigame): cook result · dining table quality toasts */
import { cookStepsOf, getMealDef, mealQualityStars, normalizeMealQuality } from '@/shared';
/* 2026-09-13 (the extraction rework): the auto-departure line (the departure grace `EXTRACTION_DEPART_GRACE_S` went out with the boarding toast on 2026-09-15) */
import { EXTRACTION_AUTO_DEPART_IDLE_S } from '@/shared';
/* 2026-09-16 (user's decision 「큰 수 축약」): XP on the quest reward line uses the same notation as credits (`shared/numberFormat`).
   Trust · item counts are left alone — the exact value is the meaning. */
import { formatCompactSigned } from '@/shared';
import { el, escapeHtml, rarityColor } from '../dom';
/* 2026-09-16: the item-gained toast thumbnail — the same shared chip as the inventory · cost lines */
import type { ItemDef } from '@/shared';
import { buildItemChip } from '@/shared';
/* 2026-09-11 (B-3): invite outcome toasts */
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
  /* 2026-09-15 (squads · dock matching): invite-only — somebody in a squad of two or more cannot be invited, and only the squad leader sends invites */
  in_other_squad: '이미 다른 분대에 있습니다',
  not_leader: '분대장만 초대할 수 있습니다',
};
function inviteFailWhy(code: SocialErrorCode | undefined): string {
  if (!code) return '';
  const text = INVITE_FAIL_KO[code] ?? SOCIAL_ERROR_MESSAGE_KO[code] ?? '';
  return text ? ` <span style="color:var(--c-text-dim)">(${escapeHtml(text)})</span>` : '';
}
import { stratagemDef } from './stratagemGlyphs';
/* 2026-09-15 (android squadmates): roster change · slot return · downed · death · stash deposit toasts */
import type { AllyId } from '@/shared';
import { androidNameOf } from '@/shared';

/**
 * 2026-09-15 — the subject particle `이` / `가`. A Hangul syllable with a final consonant takes `이`, one without takes `가`
 * (any other character takes `가`). Android names (`안드로이드 알파` · `베타` · `감마`) have no final consonant, so they all take
 * that one, but the rule picks it so the sentence stays natural as names grow — the 2026-09-15 decision not to spell `이(가)` out.
 */
function josaGa(name: string): string {
  const ch = name.charCodeAt(name.length - 1);
  if (!Number.isFinite(ch) || ch < 0xac00 || ch > 0xd7a3) return '가';
  return (ch - 0xac00) % 28 === 0 ? '가' : '이';
}

/** 2026-09-13 (meal quality): the star glyph colour — the same gold as the tooltip quality row · the buff thumbnail star badge. */
const STAR_COLOR = '#ffd24a';
/** ` ★★★☆☆` (leading space included, gold span). An empty string when the quality is 0. */
function starsHtml(quality: unknown): string {
  const q = normalizeMealQuality(quality);
  return q > 0 ? ` <span style="color:${STAR_COLOR}">${mealQualityStars(q)}</span>` : '';
}

type Kind = 'info' | 'warning' | 'danger' | 'success';
const MAX_VISIBLE = 6;
/** 2026-09-16: the side of the item-gained toast thumbnail (px). */
const ITEM_TOAST_THUMB_PX = 30;
/** 2026-09-16: between the bottom of the tutorial control guide panel and the toast stack (px). */
const TUT_PANEL_GAP_PX = 10;
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
  /** 2026-09-15: android id → display name. A unit that went back to its slot is off the roster, so its name comes from here. */
  private allyNames = new Map<AllyId, string>();
  /** 2026-09-16: the tutorial control guide panel (found through the DOM) · the stack top applied now (px, -1 = the default right-centre). */
  private tutPanel: HTMLElement | null = null;
  private belowTop = -1;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'notifs', parent });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('ui:notify', ({ text, kind, duration }) => this.push(escapeHtml(text), kind ?? 'info', undefined, duration)),
      b.on('inventory:itemAdded', ({ name, rarity, item, fromStash }) => {
        // 2026-09-12 (user's decision): ship stash → bag is a move, not a gain — no item-gained ticker appears
        if (fromStash) return;
        // 2026-09-16 (user's decision): the item-gained toast = a thumbnail chip left + `이름 ×수량` right (×1 is written too) — no `아이템` head label, no `획득:` prefix
        this.pushItem(ctx.loot?.getItemDef(item.defId), name, rarity, item.qty);
      }),
      b.on('inventory:full', ({ name }) => this.push(`가방이 가득 찼습니다 — <b>${escapeHtml(name)}</b>`, 'warning', '인벤토리', 3)),
      b.on('inventory:bagChanged', ({ dropped }) => {
        if (dropped.length > 0) this.push(`가방이 작아져 아이템 <b>${dropped.length}</b>개를 떨어뜨렸습니다`, 'warning', '인벤토리', 4);
      }),
      b.on('enemy:waveStarted', ({ index, count }) => this.push(`적 증원 감지! <span style="color:var(--c-text-dim)">${index + 1}차 · ${count}마리</span>`, 'danger', '경고', 4)),
      /* 2026-09-14 (tutorial): a ship that is already landed (`beginPreLanded`) **replays** these two with `duration: 0`
         to line the phase up only — 「도착까지 0초」 never happened, so it is not shown. The main game always has duration > 0. */
      b.on('extraction:activated', ({ duration }) => {
        if (duration <= 0) return;
        this.push(`탈출 신호 전송 완료. 함선 도착까지 ${Math.round(duration)}초.`, 'success', '탈출', 4);
      }),
      b.on('extraction:shipIncoming', ({ eta }) => this.push(`함선 접근 중 — ${Math.round(eta)}초`, 'warning', '탈출', 4)),
      // 2026-09-13 (the extraction rework): landing → auto-departure wait → departure grace → liftoff / left behind → callable again
      b.on('extraction:shipLanded', () => {
        /* 2026-09-14 3rd pass (user's decision): the tutorial's abandoned ship stands there from the start — neither 「착륙」
           nor 「도착」 happened, so no toast is written at all. The event itself still flows
           (the ship marker · music hang off the same event, and the marker disappears without it). */
        if (ctx.missionMode === 'tutorial') return;
        // For a ship with no auto-departure armed that sentence is false — `idleRemaining < 0` is that fact.
        const auto = (ctx.extraction?.idleRemaining ?? 0) >= 0;
        this.push(auto ? `함선 착륙. 탑승하세요 — ${Math.round(EXTRACTION_AUTO_DEPART_IDLE_S)}초 뒤 자동 출발` : '함선 착륙. 탑승하세요',
          'success', '탈출', 4);
      }),
      /* 2026-09-15 (user's decision): the `extraction:boarded` toast (「탑승 확인. 내부 스위치를 …초 뒤 출발합니다.」) was removed **in every raid** —
         the top-left objective line (`liftoffSwitch` in `ui/hud/Objective`) already says the same thing, and it came back on every trip in and out of the hold.
         The event itself is a contract and still flows (`extraction/ExtractionSystem` · the squad boarding display use it) — only the subscription here is gone. */
      b.on('extraction:departureStarted', ({ duration, auto }) => this.push(
        auto ? `대기 시간 초과 — <b>${Math.round(duration)}초</b> 뒤 함선이 출발합니다` : `출발 시퀀스 개시 — <b>${Math.round(duration)}초</b> 뒤 함선이 출발합니다`,
        'warning', '탈출', 5)),
      b.on('extraction:liftoff', ({ aboard, squadDone }) => {
        if (aboard ?? true) this.push('이륙 — 탈출 성공', 'success', '탈출', 4);
        else if (squadDone ?? true) this.push('함선 이륙', 'info', '탈출', 4);
        else this.push('함선이 출발했습니다 — 탑승하지 못했습니다', 'danger', '탈출', 5);
      }),
      b.on('extraction:reset', () => this.push('함선이 떠났습니다 — 탈출 신호소를 다시 작동할 수 있습니다', 'info', '탈출', 5)),
      /* 2026-09-16 (user's decision): the `crate:looted` (a crate · corpse emptied) toast 「상자를 모두 비웠습니다.」 was removed —
         the last item's item-gained toast already says the same moment. The event is a contract and still flows (enemies/ corpse sinking uses it). */
      // Phase 12: the 회복 스프레이 calls `applyHeal` (→ `player:stimUsed`) ten times a second while it is held; the
      // channel line below stands in for all of them, so this toast is muted while a channel is active.
      b.on('player:stimUsed', () => { if (!this.channel) this.push('회복제 사용', 'success', '생명력', 2); }),
      // down / revive / respawn (Phase 2)
      b.on('player:revived', ({ hp }) => this.push(`부활 — 체력 <b>${Math.ceil(hp)}</b>`, 'success', '생명력', 3)),
      // 2026-09-09: auto-revive is gone, so nobody emits `game:respawnAvailable` — the rescue ship notification takes its place
      b.on('rescue:called', ({ targetName }) => this.push(`${escapeHtml(targetName)} 구조선 호출됨`, 'success', '구조', 3)),
      b.on('leader:deviceDropped', () => this.push('분대장 기기가 떨어졌습니다', 'warning', '분대장', 4)),
      b.on('net:remoteDowned', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 전투불능 — 구조 필요`, 'danger', '분대', 4)),
      b.on('net:remoteRevived', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 부활`, 'success', '분대', 3)),
      // multiplayer feed
      b.on('net:remoteDied', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 전사`, 'danger', '분대', 4)),
      // 2026-09-11 (B-12): the **sole** owner of the join · leave toasts (the two `함선 합류 · 이탈` lines in `hub/HubSystem` were deleted).
      // Having no gate is deliberate — squadmates coming and going must be known during a raid · training too.
      b.on('net:peerJoined', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 합류`, 'info', '분대', 3)),
      b.on('net:peerLeft', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 이탈`, 'warning', '분대', 3.5)),
      b.on('net:lobbyLeft', ({ reason }) => { if (reason === 'hostLeft') this.push('호스트가 나갔습니다', 'warning', '분대', 4); }),
      /* ── 2026-09-15 (android squadmates, docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」) ──
       * The sole owner of the toasts is here (the 2026-09-11 B-12 contract) — allies · net only emit events. `evicted` is
       * 「사람이 합류해 밀려났다」, so its sentence differs from `removed` (the squad leader sent it back itself). */
      b.on('ally:rosterChanged', ({ roster, added, removed, evicted }) => {
        const gone = new Set(evicted);
        for (const id of removed) {
          const name = this.allyName(id);
          if (gone.has(id)) this.push(`분대원이 합류해 <b>${escapeHtml(name)}</b>${josaGa(name)} 슬롯으로 돌아갔다`, 'warning', '분대', 4);
          else this.push(`<b>${escapeHtml(name)}</b>${josaGa(name)} 슬롯으로 돌아갔다`, 'info', '분대', 3);
        }
        // The roster is what tells the name — to name a unit that drops out later, it has to be written down here first.
        this.allyNames.clear();
        for (const e of roster) this.allyNames.set(e.id, e.name);
        for (const id of added) {
          const name = this.allyName(id);
          this.push(`<b>${escapeHtml(name)}</b>${josaGa(name)} 분대에 합류했다`, 'success', '분대', 3);
        }
      }),
      // The relay refused it as 「full」 (to the requester only). `human_joined` is already said by the `evicted` line above.
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
       * 2026-09-16 (the plate model, user's decision — replacing the old `housing:mealServed` 「분대에 차리기」 notice): a squadmate **just
       * cooked** and a plate landed on the shared ship's dining table. net/ takes the `plate state`, emits `net:squadPlate` and **the toast is only here** (「the sole owner of toasts is ui/」).
       * Only `fresh` shows — the squadmate plate list received on joining is silent. Only while standing in the shared ship (where that table is visible).
       */
      b.on('net:squadPlate', ({ name, plate, fresh }) => {
        if (!fresh || !plate || ctx.hub?.ship !== 'shared') return;
        const def = getMealDef(plate.mealDefId);
        this.push(
          `<b>${escapeHtml(name || '분대원')}</b> 님이 식탁에 <b style="color:${rarityColor(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? plate.mealDefId)}</b>${starsHtml(plate.quality)} 을(를) 차렸습니다`,
          'success', '식탁', 4,
        );
      }),
      /*
       * 2026-09-13 (the cooking minigame, `docs/DECISIONS.md` 「2026-09-13 — 요리 미니게임」): the result of one cook. housing only emits events and the toast is only here
       * (the same contract as the dining table line above). Success = `<요리> ★★★★☆ → 함선 창고|가방`, failure = a `result.reason` warning. The `craft:completed` of the same moment
       * draws no toast below when it is a cook-bench recipe — this line stands in for it (the `inventory:itemAdded` item-gained ticker still appears as for a normal craft).
       */
      b.on('housing:cookResult', ({ result }) => {
        if (!result) return;
        // 2026-09-16 (the plate model): a meal is not an item — the name comes from the meal table, success is the absence of a `reason` (`itemUid` is always null)
        const def = getMealDef(result.mealDefId) ?? ctx.loot?.getItemDef(result.mealDefId);
        const name = `<b style="color:${rarityColor(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? result.mealDefId)}</b>`;
        if (result.landed && !result.reason) {
          const where = result.landed === 'stash' ? '함선 창고' : result.landed === 'bag' ? '가방' : '식탁';
          const stars = `<span style="color:${STAR_COLOR}">${mealQualityStars(result.quality)}</span>`;
          this.push(`${name} ${stars} <span style="color:var(--c-text-dim)">→ ${where}</span>`, 'success', '요리', 4);
        } else {
          this.push(`${name} — ${escapeHtml(result.reason || '요리를 만들지 못했습니다')}`, 'warning', '요리', 4);
        }
      }),
      /*
       * 2026-09-13 (cooking material tiers, `docs/DECISIONS.md` 「2026-09-13 — 요리 재료 티어」): the analyzer's two notices. housing only emits events and the toast is only here
       * (the same contract as the dining table line above). The old `housing:sampleDexAdded` (the sample catalogue) is no longer emitted and had no consumer in ui.
       *  - `analysisFound` — an output written into the analysis catalogue for the **first** time.
       *  - `analysisLevelUp` — the moment a family level rises: that level's resolve-time multiplier (`analysisTimeMul`) + the results **newly unlocked** at this level
       *    (those of `ANALYSIS_RESULTS` in the same family · `minLevel === level` · weight > 0 · not retired; names from `ctx.loot.getItemDef`).
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
       * 2026-09-11 (B-1): the `net:reconnecting` / `net:resumed` toasts were taken out of here — two lines appeared at the same moment.
       * During a raid · training `game/GameFlowSystem` covers it (`서버 재연결 중… (n)` · `재연결됨` · the return reason); in the ship
       * `hud/NetBadge` (disconnected → connected transition toast + the badge's `서버 재연결 중… (n)`) and `hub/parts/Transitions.onResumed`
       * (`함선에 재접속했습니다` · `진행 중인 임무로 복귀합니다`) each emit exactly one line.
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
        this.push(`<b>${escapeHtml(name)}</b> 함선 지원: <b>${escapeHtml(stratagemDef(kind)?.name ?? kind)}</b>`, 'warning', '호출', 4);
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
        // 2026-09-11 (E-8): when this 0 is the refund of a host denial (`refundCooldown`), no ready toast appears —
        // `stratagems` already showed the denial reason toast, and two lines side by side only blur what happened.
        if (refunded) return;
        this.push('함선 지원 준비 완료', 'success', '호출', 3);
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
      /* ── Phase 11 social: the folder's one toast owner reports every social outcome (the panels never toast) ── */
      b.on('social:error', ({ message }) => this.push(escapeHtml(message), 'warning', '소셜', 3.5)),
      b.on('social:play', ({ name, outcome }) => {
        const who = escapeHtml(name || '분대원');
        if (outcome === 'joined') this.push(`<b>${who}</b> 분대에 합류합니다`, 'success', '소셜', 3.5);
        else this.push(`<b>${who}</b>에게 분대 초대를 보냈습니다`, 'info', '소셜', 3.5);
      }),
      b.on('social:invited', ({ invite }) => this.push(`<b>${escapeHtml(invite.name || '분대원')}</b> 분대 초대 — ${keyLabel(Keys.INVITE)} 홀드로 참여`, 'info', '소셜', 5)),
      /*
       * 2026-09-11 (B-3): how an invite **I sent** ended. A decline and an expiry read differently on purpose (user decision) —
       * `superseded` says nothing (the newer invite's own `…에게 분대 초대를 보냈습니다` already did). A failed whisper is
       * never toasted here: its own chat line turns `전송 실패` (B-4).
       */
      b.on('social:inviteResult', ({ name, outcome, reason }) => {
        // `accepted`: the moment the invitee comes in, the `<이름> 합류` of `net:peerJoined` above already appears — the second line is dropped.
        // ⚠ So that join line is the **only** notification of an accepted invite — removing it means reviving this one first
        //   (2026-09-11 B-12 removed the other side, the `<이름> 함선 합류` in `hub/HubSystem`).
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
      // `inventory:itemAdded` line above is the one ticker a gather shows (the gather line doubled it).
      /* ── Phase 12: continuous-use item (회복 스프레이) — ONE line for the whole channel, updated in place ── */
      b.on('item:channelChanged', ({ defId, active, gauge }) => this.setChannel(ctx, defId, active, gauge)),
      b.on('craft:completed', ({ item }) => {
        // 2026-09-13 (the cooking minigame): a cook-bench meal is covered by the `housing:cookResult` toast instead — cook recipes are out of the
        // normal craft path, so an output with cook steps means the event came from `completeCook`
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
      // 2026-09-17 (user's decision): equipping · unequipping · swapping a tactical implant draws no toast — the slot art (the implant
      // widget) and the equip sound (`ui_equip` in `audio`) are enough. Only the `implant:equipped` subscription is gone from here.
      /* ── Phase 5: corporations (short lines; the credits chip / rep / contract toasts live in MetaToasts) ── */
      /* ── 2026-09-14: NPC quests (docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」) — the old corporation quest completion toast (`meta:questChanged`) went
       * away with the corporation quests. New NPC messages (`npc:message`) are shown by the messenger (ui/menus/messenger). Nothing is shown in the training range. ── */
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
          if (r.xp > 0) parts.push(`XP ${formatCompactSigned(r.xp, true)}`);
          for (const rep of r.rep) parts.push(`${escapeHtml(CORP_DEFS[rep.corp]?.name ?? rep.corp)} 신뢰도 +${rep.amount}`);
          /* 2026-09-14: the NPC's personal trust — right after corporation reputation (the same order as the messenger conversation's `보상 — …` line · the quest card chips) */
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
   * 2026-09-15: the android's display name. Its name when it is on the last roster, otherwise `androidNameOf` from the bay
   * number at the tail of the id (the id is `androidIdOf(scope, bay)` = `android:<scope>:<bay>`, so the last field is the bay).
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
    this.show(n, duration);
  }

  /**
   * 2026-09-16 (user's decision): one item-gained line — `.notif.info.nt-item` > the shared chip thumbnail (`buildItemChip`, no count badge) +
   * `.t` (`이름 ×수량`). The quantity is written even at 1. The chip's `data-def-id` is stripped so the hover card · right-click menu never catch on a toast.
   */
  private pushItem(def: ItemDef | undefined, name: string, rarity: string, qty: number): void {
    const n = el('div', { cls: 'notif info nt-item' });
    const chip = buildItemChip(def, { size: ITEM_TOAST_THUMB_PX });
    delete chip.dataset.defId;
    n.appendChild(chip);
    const count = Math.max(1, Math.floor(qty));
    el('span', {
      cls: 't',
      html: `<b style="color:${rarityColor(rarity)}">${escapeHtml(name)}</b> <span style="color:var(--c-text-dim)">×${count}</span>`,
      parent: n,
    });
    this.show(n, 3);
  }

  private show(n: HTMLElement, duration: number): void {
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

  /**
   * 2026-09-16 (user's decision): while the tutorial's right-hand control guide (`tutorial/ui/Controls`, `.tut-controls`) is up, the toast stack
   * starts **directly below that panel** — so the right-centre stack is not hidden behind it. It is found by DOM class alone, with no folder
   * import (the same coupling as the tutorial spotlight looking for `.key-guide .kg-close`). The panel is vertically centred in its band and its height
   * changes with the line count, so it is measured every frame — none or hidden ends it in one comparison. HudSystem.update calls it regardless of layer visibility.
   */
  update(): void {
    let panel = this.tutPanel;
    if (!panel || !panel.isConnected) panel = this.tutPanel = document.querySelector<HTMLElement>('.tut-controls');
    let top = -1;
    if (panel && !panel.hidden) {
      const r = panel.getBoundingClientRect();
      if (r.height > 0) top = Math.ceil(r.bottom) + TUT_PANEL_GAP_PX;
    }
    if (top === this.belowTop) return;
    this.belowTop = top;
    this.root.classList.toggle('below-tut', top >= 0);
    this.root.style.top = top >= 0 ? `${top}px` : '';
  }

  /** Text of the live channel line (debug), null when none. */
  get channelText(): string | null { return this.channel ? this.channel.el.textContent : null; }
  /** Live toast nodes, the channel line excluded (debug). */
  get liveCount(): number { return this.live.length; }
  /** 2026-09-15 (debug / smoke): the text of the toasts up right now (oldest first). */
  get toastTexts(): string[] { return this.live.map((n) => n.textContent ?? ''); }

  private clear(): void {
    for (const n of this.live) n.remove();
    this.live.length = 0;
    if (this.channel) { this.channel.el.remove(); this.channel = null; }
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
