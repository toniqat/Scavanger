import type { GameContext } from '@/shared';
import { el, setText } from '../dom';
import { MenuBase } from './MenuBase';
import { parseSeed } from './seed';

const CONTROLS: Array<[string[], string]> = [
  [['W', 'A', 'S', 'D'], '이동'], [['Shift'], '달리기 (스태미나)'], [['Space'], '점프'],
  [['C'], '앉기'], [['Z'], '엎드리기'], [['Alt'], '다이빙'],
  [['LMB'], '사격'], [['RMB'], '조준'], [['MMB'], '핑'], [['R'], '재장전'],
  [['1', '2', 'Q'], '무기 교체'], [['E'], '상호작용 (길게)'], [['F'], '회복제'],
  [['G'], '수류탄'], [['Tab'], '인벤토리'], [['M'], '지도'], [['Esc'], '일시 정지'],
];

/**
 * Title screen: wordmark, seed input, deploy button, multiplayer entry, controls.
 * Visible on phase 'menu' only while no lobby exists and the lobby screen is not open
 * (`ui:lobbyToggled`, `net:lobbyUpdated`, `net:lobbyLeft` swap between title and lobby).
 */
export class TitleMenu extends MenuBase {
  private seedInput: HTMLInputElement;
  private msg: HTMLElement;
  private lobbyOpen = false;

  constructor(parent: HTMLElement) {
    super(parent, 'title');
    const head = el('div', { parent: this.frame });
    el('div', { cls: 'wordmark', html: 'SCAV<span>A</span>NGER', parent: head });
    el('div', { cls: 'tagline', text: '강하 · 수집 · 탈출', parent: head });

    const field = el('div', { cls: 'field', parent: this.frame });
    el('span', { cls: 'ui-label', text: '임무 시드 (비워두면 무작위)', parent: field });
    const row = el('div', { cls: 'row', parent: field });
    this.seedInput = el('input', { cls: 'ui-input', attrs: { type: 'text', placeholder: '예: 8813', maxlength: '12', spellcheck: 'false' }, parent: row });
    this.seedInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.deploy(); });
    this.seedInput.addEventListener('keyup', (e) => e.stopPropagation());
    this.button(row, '무작위', () => { this.seedInput.value = String(Math.floor(Math.random() * 99999)); });

    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.button(actions, '임무 배치', () => this.deploy(), 'primary');
    this.button(actions, '멀티플레이', () => this.openLobby());
    this.msg = el('div', { cls: 'form-msg', text: '', parent: actions });
    this.msg.hidden = true;

    el('div', { cls: 'divider', parent: this.frame });
    el('span', { cls: 'ui-label', text: '조작', parent: this.frame });
    const grid = el('div', { cls: 'controls', parent: this.frame });
    for (const [keys, label] of CONTROLS) {
      const k = el('div', { cls: 'keys', parent: grid });
      for (const key of keys) el('span', { cls: 'keycap', text: key, parent: k });
      el('span', { text: label, parent: grid });
    }
    el('div', { cls: 'hint', text: '목표: 탈출 지점의 스위치를 작동하고 120초간 생존한 뒤 함선에 탑승하세요.', parent: this.frame });
    el('div', { cls: 'version', text: 'SCAVANGER · PROTOTYPE', parent: this.root });
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:phaseChanged', () => this.refresh()),
      b.on('ui:lobbyToggled', ({ open }) => { this.lobbyOpen = open; this.refresh(); }),
      b.on('net:lobbyUpdated', () => this.refresh()),
      b.on('net:lobbyLeft', () => this.refresh()),
    );
    this.refresh();
  }

  private refresh(): void {
    const ctx = this.ctx;
    const show = ctx.phase === 'menu' && !ctx.net?.lobby && !this.lobbyOpen;
    if (show) this.show(); else this.hide();
  }

  protected override onHide(): void { this.msg.hidden = true; }

  private openLobby(): void {
    if (!this.ctx.net) {
      setText(this.msg, '멀티플레이 사용 불가 — 네트워크 모듈이 없습니다');
      this.msg.hidden = false;
      this.ctx.bus.emit('ui:notify', { text: '멀티플레이 사용 불가', kind: 'warning' });
      return;
    }
    this.ctx.bus.emit('ui:lobbyToggled', { open: true });
  }

  private deploy(): void {
    this.ctx.bus.emit('game:newMission', { seed: parseSeed(this.seedInput.value) });
  }
}
