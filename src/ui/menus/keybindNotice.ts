import type { GameContext, KeyAction, KeybindLoadReport } from '@/shared';
import { Keys, getKeyActionDef, keyLabel, saveKeybinds } from '@/shared';
import { el, toggleClass } from '../dom';

/**
 * **옛 키 설정 세이브 알림** (2026-09-11, C-9 · X-8).
 *
 * `scav.keybinds` 에는 버전이 없어서, 기본 키가 옮겨 가기 전에 저장한 블롭(예: `RELOAD=V` 를 저장한 뒤 새 기본
 * `DIVE=V`)은 새 기본 키와 **조용히** 같은 키를 쓴다 — 키 설정 화면을 열어야만 `⚠ 겹침` 이 보였다. 그리고 목록에서
 * 빠진 액션(`SWAP` 이전 무기 · `SECONDARY` 보조무기 · `CURSOR` 커서)의 줄은 영영 블롭에 남아 있었다.
 * `shared/Keybinds.loadKeybinds()` (main.ts 부팅)가 그것을 모아 두고 `takeKeybindLoadReport()` 가 **한 번만** 돌려준다.
 *
 * 읽는 곳은 `TitleMenu.bind` 하나다 — `takeAutoStart()` 와 같은 이유(부팅에 정확히 한 번 · 첫 화면이 여기).
 *  - 타이틀이 뜨는 부팅이면 이 카드(`.kb-notice`)가 타이틀 아래쪽 가운데에 뜬다. 타이틀이 보이는 동안
 *    `KEYBIND_NOTICE_S` 초가 흐르면 스스로 접히고, `확인` 으로 바로 닫히며, `키 설정 열기` 는 설정 패널을 연다.
 *  - 슬롯 전환 자동 시작(타이틀을 건너뛴다)이면 첫 `hub:entered` 에서 같은 줄을 `ui:notify` 로 흘린다.
 * 어느 쪽이든 **알린 순간** `saveKeybinds()` 를 불러 은퇴 줄을 블롭에서 지운다 (겹침은 사용자가 고칠 때까지
 * 블롭에 남으므로 다음 부팅에 다시 알린다 — 실제로 두 동작이 한 키에 묶여 있는 상태라 조용히 넘기지 않는다).
 */

/** 타이틀이 보이는 시간 기준으로 이만큼 지나면 카드가 접힌다. */
export const KEYBIND_NOTICE_S = 14;
/** 카드 · 토스트에 싣는 최대 줄 수 (넘치면 마지막 줄이 `외 n건`). */
const MAX_LINES = 4;

/** 목록에서 빠진 액션의 이름 — 은퇴 액션은 원시 문자열이라 `KEY_ACTION_DEFS` 에 라벨이 없다. */
const RETIRED_LABEL_KO: Readonly<Record<string, string>> = {
  SWAP: '이전 무기',
  SECONDARY: '보조무기',
  CURSOR: '커서',
};

/** 짧은 액션 이름: `재장전 / (수류탄을 들고 있을 때) 코킹` → `재장전`. */
function actionName(id: KeyAction): string {
  const label = getKeyActionDef(id)?.label ?? id;
  return label.split(' / ')[0];
}

/**
 * 리포트를 사람이 읽는 줄로. 은퇴 액션은 한 줄에 모으고, 겹침은 **키마다** 한 줄이다 — 블롭에서 온 두 액션이
 * 서로 겹치면 리포트에는 `A→[B]` 와 `B→[A]` 가 둘 다 있으므로 키 코드로 묶어 한 번만 적는다.
 */
export function describeKeybindReport(report: KeybindLoadReport): string[] {
  const lines: string[] = [];
  const byCode = new Map<string, Set<KeyAction>>();
  for (const c of report.conflicts) {
    const code = Keys[c.action];
    let set = byCode.get(code);
    if (!set) { set = new Set(); byCode.set(code, set); }
    set.add(c.action);
    for (const o of c.with) set.add(o);
  }
  for (const [code, set] of byCode) {
    lines.push(`같은 키 ${keyLabel(code)}: ${[...set].map(actionName).join(' · ')}`);
  }
  if (report.retired.length > 0) {
    lines.push(`없어진 기능의 키 설정을 지웠습니다: ${report.retired.map((r) => RETIRED_LABEL_KO[r] ?? r).join(' · ')}`);
  }
  if (lines.length > MAX_LINES) {
    const rest = lines.length - (MAX_LINES - 1);
    lines.length = MAX_LINES - 1;
    lines.push(`외 ${rest}건 — 설정 › 키 설정에서 확인하세요`);
  }
  return lines;
}

/** 타이틀 안의 알림 카드. `TitleMenu` 가 만들고 `update(dt, titleShown)` 을 매 프레임 넘긴다. */
export class KeybindNotice {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private left = 0;
  private _report: KeybindLoadReport | null = null;
  private _lines: string[] = [];
  private unsub: (() => void) | null = null;
  private ctx: GameContext | null = null;

  constructor(parent: HTMLElement, private readonly onOpenSettings: () => void) {
    this.root = el('div', { cls: 'kb-notice', parent });
    this.root.hidden = true;
    const head = el('div', { cls: 'kbn-head', parent: this.root });
    el('i', { cls: 'kbn-ico', text: '⚠', parent: head });
    el('span', { cls: 'kbn-title', text: '키 설정을 확인하세요', parent: head });
    this.list = el('div', { cls: 'kbn-lines', parent: this.root });
    el('div', { cls: 'kbn-sub', text: '예전에 저장한 키 설정이 새 기본 키와 맞지 않습니다.', parent: this.root });
    const foot = el('div', { cls: 'kbn-foot', parent: this.root });
    const open = el('button', { cls: 'ui-btn', text: '키 설정 열기', parent: foot });
    open.type = 'button';
    open.addEventListener('click', (e) => { e.stopPropagation(); this.click(); this.dismiss(); this.onOpenSettings(); });
    const ok = el('button', { cls: 'ui-btn primary', text: '확인', parent: foot });
    ok.type = 'button';
    ok.addEventListener('click', (e) => { e.stopPropagation(); this.click(); this.dismiss(); });
  }

  /**
   * 부팅 리포트를 받는다. `autoStart` 면 카드 대신 첫 `hub:entered` 에 토스트로 흘린다.
   * 리포트가 없으면 아무것도 하지 않는다.
   */
  take(ctx: GameContext, report: KeybindLoadReport | null, autoStart: boolean): void {
    this.ctx = ctx;
    if (!report) return;
    this._report = report;
    this._lines = describeKeybindReport(report);
    if (this._lines.length === 0) return;
    if (autoStart) {
      this.unsub = ctx.bus.on('hub:entered', () => {
        this.unsub?.();
        this.unsub = null;
        for (const text of this._lines) ctx.bus.emit('ui:notify', { text: `키 설정 — ${text}`, kind: 'warning', duration: 8 });
        saveKeybinds();
      });
      return;
    }
    this.list.replaceChildren();
    for (const text of this._lines) el('div', { cls: 'kbn-line', text, parent: this.list });
    this.left = KEYBIND_NOTICE_S;
    this.root.hidden = false;
    toggleClass(this.root, 'fade', false);
    saveKeybinds();
  }

  /** 타이틀이 보이는(하위 화면에 가려지지 않은) 동안만 시간이 흐른다. */
  update(dt: number, titleShown: boolean): void {
    if (this.root.hidden || !titleShown || this.left <= 0) return;
    this.left -= dt;
    if (this.left <= 0) this.dismiss();
    else if (this.left < 0.4) toggleClass(this.root, 'fade', true);
  }

  /** `MenuBase.button` 과 같은 클릭음. */
  private click(): void { this.ctx?.bus.emit('audio:play', { id: 'ui_click' }); }

  dismiss(): void {
    this.left = 0;
    if (!this.root.hidden) { this.root.hidden = true; toggleClass(this.root, 'fade', false); }
  }

  /** 이번 부팅에 받은 리포트 · 그 줄 · 카드가 떠 있나 (debug / smoke). */
  get report(): KeybindLoadReport | null { return this._report; }
  get lines(): readonly string[] { return this._lines; }
  get isOn(): boolean { return !this.root.hidden; }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    this.root.remove();
  }
}
