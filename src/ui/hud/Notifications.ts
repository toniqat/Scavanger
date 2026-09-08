import type { GameContext } from '@/shared';
import { CONTRACT_DEFS, Keys, QUEST_DEFS, SUSPENDED_LABEL_KO, WEIGHT_STATE_LABEL_KO, formatCredits, keyLabel } from '@/shared';
import { el, escapeHtml, rarityColor } from '../dom';
import { stratagemDef } from './stratagemGlyphs';

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

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'notifs', parent });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('ui:notify', ({ text, kind, duration }) => this.push(escapeHtml(text), kind ?? 'info', undefined, duration)),
      b.on('inventory:itemAdded', ({ name, rarity, item }) => {
        const qty = item.qty > 1 ? ` <span style="color:var(--c-text-dim)">×${item.qty}</span>` : '';
        this.push(`획득: <b style="color:${rarityColor(rarity)}">${escapeHtml(name)}</b>${qty}`, 'info', '아이템', 3);
      }),
      b.on('inventory:full', ({ name }) => this.push(`가방이 가득 찼습니다 — <b>${escapeHtml(name)}</b>`, 'warning', '인벤토리', 3)),
      b.on('inventory:bagChanged', ({ dropped }) => {
        if (dropped.length > 0) this.push(`가방이 작아져 아이템 <b>${dropped.length}</b>개를 떨어뜨렸습니다`, 'warning', '인벤토리', 4);
      }),
      b.on('enemy:waveStarted', ({ index, count }) => this.push(`적 증원 감지! <span style="color:var(--c-text-dim)">${index + 1}차 · ${count}마리</span>`, 'danger', '경고', 4)),
      b.on('extraction:activated', () => this.push('탈출 신호 전송 완료. 함선이 출발했습니다.', 'success', '탈출', 4)),
      b.on('extraction:shipIncoming', ({ eta }) => this.push(`함선 접근 중 — ${Math.round(eta)}초`, 'warning', '탈출', 4)),
      b.on('extraction:shipLanded', () => this.push('함선 착륙. 탑승하세요.', 'success', '탈출', 4)),
      b.on('extraction:boarded', () => this.push('탑승 확인. 내부 스위치를 작동하세요.', 'success', '탈출', 4)),
      b.on('extraction:liftoff', () => this.push('이륙 시퀀스 개시.', 'success', '탈출', 4)),
      b.on('crate:looted', () => this.push('상자를 모두 비웠습니다.', 'info', '보급', 2.5)),
      // Phase 12: the 회복 스프레이 calls `applyHeal` (→ `player:stimUsed`) ten times a second while it is held; the
      // channel line below stands in for all of them, so this toast is muted while a channel is active.
      b.on('player:stimUsed', () => { if (!this.channel) this.push('회복제 사용', 'success', '생명력', 2); }),
      // down / revive / respawn (Phase 2)
      b.on('player:revived', ({ hp }) => this.push(`부활 — 체력 <b>${Math.ceil(hp)}</b>`, 'success', '생명력', 3)),
      b.on('game:respawnAvailable', ({ seconds }) => { if (seconds <= 0) this.push('부활 준비 완료', 'success', '부활', 3); }),
      b.on('net:remoteDowned', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 전투불능 — 구조 필요`, 'danger', '분대', 4)),
      b.on('net:remoteRevived', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 부활`, 'success', '분대', 3)),
      // multiplayer feed
      b.on('net:remoteDied', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 전사`, 'danger', '분대', 4)),
      b.on('net:peerJoined', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 합류`, 'info', '분대', 3)),
      b.on('net:peerLeft', ({ name }) => this.push(`<b>${escapeHtml(name)}</b> 이탈`, 'warning', '분대', 3.5)),
      b.on('net:lobbyLeft', ({ reason }) => { if (reason === 'hostLeft') this.push('호스트가 나갔습니다', 'warning', '분대', 4); }),
      b.on('pickup:taken', ({ item, byLocal, byName }) => {
        if (byLocal) return;
        const def = ctx.loot?.getItemDef(item.defId);
        const qty = item.qty > 1 ? ` <span style="color:var(--c-text-dim)">×${item.qty}</span>` : '';
        this.push(`<b>${escapeHtml(byName ?? '분대원')}</b> 획득: <b style="color:${rarityColor(def?.rarity ?? 'common')}">${escapeHtml(def?.name ?? item.defId)}</b>${qty}`, 'info', '분대', 3);
      }),
      // reconnection / matchmaking / hub
      b.on('net:reconnecting', ({ attempt }) => this.push(`서버 재연결 중… <span style="color:var(--c-text-dim)">(${attempt})</span>`, 'warning', '네트워크', 3)),
      b.on('net:resumed', ({ seamless, inProgress, lobby }) => {
        if (seamless) { this.push('재연결됨', 'success', '네트워크', 3); return; }
        // A 훈련장 is not the squad's mission — it never reads as 임무 진행 중 (individual entry from the terminal).
        const training = lobby?.started === true && (lobby.mode ?? 'raid') === 'training';
        this.push(inProgress && !training
          ? '함선에 복귀했습니다 — 임무 진행 중, 발사 포드에서 재합류'
          : training ? '함선에 복귀했습니다 — 훈련장 진행 중, 터미널에서 합류' : '함선에 복귀했습니다', 'success', '네트워크', 4);
      }),
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
      b.on('stratagem:cooldown', ({ remaining }) => {
        if (remaining > 0) { this.cooldownWasRunning = true; return; }
        if (!this.cooldownWasRunning) return;
        this.cooldownWasRunning = false;
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
      b.on('meta:questChanged', ({ id, state }) => {
        if (state !== 'complete') return;
        const name = QUEST_DEFS.find((q) => q.id === id)?.name ?? id;
        this.push(`퀘스트 완료 · <b>${escapeHtml(name)}</b>`, 'success', '퀘스트', 4);
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

  private clear(): void {
    for (const n of this.live) n.remove();
    this.live.length = 0;
    if (this.channel) { this.channel.el.remove(); this.channel = null; }
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
