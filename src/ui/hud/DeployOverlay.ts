import { el, setVisible } from '../dom';

/** Bottom-center "descending to planet surface" overlay shown during the hellpod drop. */
export class DeployOverlay {
  readonly root: HTMLElement;
  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'deploying hidden ui-fade', parent });
    el('div', { cls: 'ui-label', text: '강하 시퀀스', parent: this.root });
    el('div', { cls: 't', text: '행성 표면 강하 중…', parent: this.root });
    el('div', { cls: 'bar', parent: this.root });
  }
  setVisible(v: boolean): void { setVisible(this.root, v); }
  dispose(): void { this.root.remove(); }
}
