import type { GameContext } from '@/shared';
import { el, setText } from '../../dom';

const ESCAPE_TOKEN = 'messenger:pop';

/**
 * 메신저 안의 작은 팝오버 하나 (2026-09-14) — 방 만들기 · 친구 초대 · 이름 변경. 패널 틀(`.cp-frame`) 안에 절대 위치로 뜨고
 * 한 번에 하나만 열린다. Escape 는 `ctx.escape` 의 `messenger:pop` 으로 이것만 닫고(패널보다 위), 틀의 빈 곳을 누르면 닫힌다.
 */
export class Popover {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private body: HTMLElement;
  private ctx: GameContext | null = null;
  private _open = false;
  private readonly onDown = (e: MouseEvent): void => {
    if (!this._open) return;
    if (e.target instanceof Node && this.root.contains(e.target)) return;
    this.close();
  };

  constructor(private readonly frame: HTMLElement) {
    this.root = el('div', { cls: 'ms-pop', parent: frame });
    this.root.hidden = true;
    const head = el('div', { cls: 'ms-pop-head', parent: this.root });
    this.title = el('span', { cls: 'ms-pop-title', text: '', parent: head });
    const x = el('button', { cls: 'ms-pop-x', text: '×', parent: head });
    x.title = '닫기';
    x.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    this.body = el('div', { cls: 'ms-pop-body', parent: this.root });
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    frame.addEventListener('mousedown', this.onDown);
  }

  bind(ctx: GameContext): void { this.ctx = ctx; }

  get isOpen(): boolean { return this._open; }
  /** 지금 열린 팝오버의 종류 (`data-kind`, 디버그 · 스모크). */
  get kind(): string | null { return this._open ? this.root.dataset.kind ?? null : null; }

  /** `kind` 는 스모크 · CSS 표식. `build` 가 본문을 채운다. */
  open(kind: string, title: string, build: (body: HTMLElement) => void): void {
    this.close();
    this.root.dataset.kind = kind;
    setText(this.title, title);
    this.body.replaceChildren();
    build(this.body);
    this.root.hidden = false;
    this._open = true;
    this.ctx?.escape.push(ESCAPE_TOKEN, () => this.close());
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.root.hidden = true;
    this.body.replaceChildren();
    this.ctx?.escape.remove(ESCAPE_TOKEN);
  }

  dispose(): void {
    this.close();
    this.frame.removeEventListener('mousedown', this.onDown);
    this.root.remove();
  }
}
