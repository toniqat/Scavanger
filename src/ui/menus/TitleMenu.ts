import type { GameContext } from '@/shared';
import { el } from '../dom';
import { MenuBase } from './MenuBase';

const CONTROLS: Array<[string[], string]> = [
  [['W', 'A', 'S', 'D'], '이동'], [['Shift'], '달리기'], [['Space'], '점프'],
  [['LMB'], '사격'], [['RMB'], '조준'], [['R'], '재장전'],
  [['1', '2', 'Q'], '무기 교체'], [['E'], '상호작용 (길게)'], [['F'], '회복제'],
  [['G'], '수류탄'], [['Tab'], '인벤토리'], [['Esc'], '일시 정지'],
];

/** Title screen: wordmark, seed input, deploy button, controls. */
export class TitleMenu extends MenuBase {
  private seedInput: HTMLInputElement;

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
    this.unsubs.push(ctx.bus.on('game:phaseChanged', ({ phase }) => {
      if (phase === 'menu') this.show(); else this.hide();
    }));
    if (ctx.phase === 'menu') this.show();
  }

  private deploy(): void {
    const raw = this.seedInput.value.trim();
    let seed: number;
    if (!raw) seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    else if (/^\d+$/.test(raw)) seed = Number(raw) >>> 0;
    else { let h = 2166136261; for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); } seed = h >>> 0; }
    this.ctx.bus.emit('game:newMission', { seed });
  }
}
