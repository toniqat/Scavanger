import type { GameContext } from '@/shared';
import { sanitizePlayerName } from '@/shared';
import { el, setText } from '../dom';
import { MenuBase } from './MenuBase';
import { ControlsPanel, KEYBIND_BUTTON_LABEL } from './ControlsPanel';

/**
 * Title screen: wordmark, callsign field, `함선 탑승` → `hub:enter {ship:'personal'}`, then the controls diagram
 * (procedural keyboard + mouse with the bound keys lit, per-function list) and a `키 설정 변경` button that opens
 * the key-settings overlay (`onKeybinds`, owned by HudSystem).
 * Visible on phase 'menu' only. Seed / matchmaking live in the ship terminal (hub).
 * Invite link (`?lobby=CODE` → `ctx.net.inviteCode`): the button reads `초대 수락 · 함선 탑승`; on click we
 * `ensureConnected()` first, then enter the personal ship and `joinLobby(code)` (the hub docks us into the shared ship).
 * A failed connection shows an inline message and falls back to the offline personal ship on the next click.
 */
export class TitleMenu extends MenuBase {
  private nameInput: HTMLInputElement;
  private boardBtn: HTMLButtonElement;
  private msg: HTMLElement;
  private controls: ControlsPanel;
  private busy = false;
  private inviteFailed = false;

  constructor(parent: HTMLElement, private readonly onKeybinds: () => void) {
    super(parent, 'title');
    const head = el('div', { parent: this.frame });
    el('div', { cls: 'wordmark', html: 'SCAV<span>A</span>NGER', parent: head });
    el('div', { cls: 'tagline', text: '강하 · 수집 · 탈출', parent: head });

    const field = el('div', { cls: 'field', parent: this.frame });
    el('span', { cls: 'ui-label', text: '콜사인 (대원 이름)', parent: field });
    const row = el('div', { cls: 'row', parent: field });
    this.nameInput = el('input', { cls: 'ui-input', attrs: { type: 'text', placeholder: '스캐빈저', maxlength: '16', spellcheck: 'false', autocomplete: 'off' }, parent: row });
    this.nameInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.board(); });
    this.nameInput.addEventListener('keyup', (e) => e.stopPropagation());
    this.nameInput.addEventListener('change', () => this.applyName());

    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.boardBtn = this.button(actions, '함선 탑승', () => this.board(), 'primary');
    this.msg = el('div', { cls: 'form-msg', text: '', parent: actions });
    this.msg.hidden = true;

    el('div', { cls: 'divider', parent: this.frame });
    el('span', { cls: 'ui-label', text: '조작', parent: this.frame });
    this.controls = new ControlsPanel(this.frame);
    const foot = el('div', { cls: 'title-foot', parent: this.frame });
    el('div', { cls: 'hint', text: '함선의 단말기에서 임무 시드를 고르고 분대를 모으세요. 발사 포드에 탑승하면 강하합니다.', parent: foot });
    this.button(foot, KEYBIND_BUTTON_LABEL, () => this.onKeybinds(), 'keybinds');
    el('div', { cls: 'version', text: 'SCAVANGER · PROTOTYPE', parent: this.root });
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.unsubs.push(ctx.bus.on('game:phaseChanged', () => this.refresh()));
    this.refresh();
  }

  private refresh(): void {
    if (this.ctx.phase === 'menu') this.show(); else this.hide();
  }

  protected override onShow(): void {
    const net = this.ctx.net;
    if (net && !this.nameInput.value) this.nameInput.value = net.playerName;
    const invite = !!net?.inviteCode && !this.inviteFailed;
    setText(this.boardBtn, invite ? '초대 수락 · 함선 탑승' : '함선 탑승');
    this.boardBtn.disabled = false;
    this.busy = false;
    this.controls.refresh();
  }

  protected override onHide(): void { this.msg.hidden = true; }

  private applyName(): void {
    const net = this.ctx.net;
    const name = sanitizePlayerName(this.nameInput.value);
    this.nameInput.value = name;
    net?.setPlayerName(name);
  }

  private showMsg(text: string, kind: 'info' | 'warning' | 'danger' = 'warning'): void {
    this.msg.className = `form-msg ${kind}`;
    setText(this.msg, text);
    this.msg.hidden = false;
  }

  private async board(): Promise<void> {
    if (this.busy) return;
    this.applyName();
    const ctx = this.ctx;
    const net = ctx.net;
    const code = net?.inviteCode ?? null;

    if (net && code && !this.inviteFailed) {
      this.busy = true;
      this.boardBtn.disabled = true;
      setText(this.boardBtn, '서버 연결 중…');
      let ok = false;
      try { ok = await net.ensureConnected(); } catch { ok = false; }
      this.busy = false;
      this.boardBtn.disabled = false;
      if (ctx.phase !== 'menu') return;
      if (!ok) {
        this.inviteFailed = true;
        setText(this.boardBtn, '함선 탑승');
        this.showMsg('서버에 연결할 수 없습니다 — 초대를 수락하지 못했습니다. 다시 누르면 개인 함선(오프라인)으로 탑승합니다.', 'danger');
        return;
      }
      ctx.bus.emit('hub:enter', { ship: 'personal' });
      net.joinLobby(code);
      ctx.bus.emit('ui:notify', { text: `초대 코드 ${code} — 공유 함선에 합류 중`, kind: 'info' });
      return;
    }
    ctx.bus.emit('hub:enter', { ship: 'personal' });
  }

  override dispose(): void { this.controls.dispose(); super.dispose(); }
}
