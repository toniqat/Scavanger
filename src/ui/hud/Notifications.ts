import type { GameContext } from '@/shared';
import { el, escapeHtml, rarityColor } from '../dom';

type Kind = 'info' | 'warning' | 'danger' | 'success';
const MAX_VISIBLE = 6;

/**
 * Right-center notification stack with kind-colored left borders and slide/fade dismiss. Lives in the social HUD
 * layer, so it also shows in the ship hub (the hub menu uses blocker token 'hub', not 'menu').
 */
export class Notifications {
  readonly root: HTMLElement;
  private unsubs: Array<() => void> = [];
  private live: HTMLElement[] = [];
  private lastCountdown = -1;

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
      b.on('enemy:waveStarted', ({ index, count }) => this.push(`적 증원 감지! <span style="color:var(--c-text-dim)">${index + 1}차 · ${count}마리</span>`, 'danger', '경고', 4)),
      b.on('extraction:activated', () => this.push('탈출 신호 전송 완료. 함선이 출발했습니다.', 'success', '탈출', 4)),
      b.on('extraction:shipIncoming', ({ eta }) => this.push(`함선 접근 중 — ${Math.round(eta)}초`, 'warning', '탈출', 4)),
      b.on('extraction:shipLanded', () => this.push('함선 착륙. 탑승하세요.', 'success', '탈출', 4)),
      b.on('extraction:boarded', () => this.push('탑승 확인. 내부 스위치를 작동하세요.', 'success', '탈출', 4)),
      b.on('extraction:liftoff', () => this.push('이륙 시퀀스 개시.', 'success', '탈출', 4)),
      b.on('crate:looted', () => this.push('상자를 모두 비웠습니다.', 'info', '보급', 2.5)),
      b.on('player:stimUsed', () => this.push('회복제 사용', 'success', '생명력', 2)),
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
      b.on('net:resumed', ({ seamless, inProgress }) => {
        if (seamless) this.push('재연결됨', 'success', '네트워크', 3);
        else this.push(inProgress ? '함선에 복귀했습니다 — 임무 진행 중, 발사 포드에서 재합류' : '함선에 복귀했습니다', 'success', '네트워크', 4);
      }),
      b.on('net:matched', ({ created }) => this.push(created ? '신호 송출 시작 — 대원 대기 중' : '공유 함선 신호 포착', created ? 'info' : 'success', '매치', 4)),
      b.on('hub:launchCountdown', ({ seconds }) => {
        const s = Math.ceil(seconds);
        if (s === this.lastCountdown || s <= 0) return;
        this.lastCountdown = s;
        this.push(`발사 <b>${s}</b>초 전`, 'warning', '발사', 1.1);
      }),
      b.on('hub:entered', () => { this.lastCountdown = -1; }),
      b.on('game:abort', () => this.clear()),
      b.on('game:newMission', () => { this.clear(); this.lastCountdown = -1; }),
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

  private clear(): void {
    for (const n of this.live) n.remove();
    this.live.length = 0;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
