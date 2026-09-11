import type { GadgetId, GameContext } from '@/shared';
import { Keys, droneKindOfGadget, keyLabel, mouseButtonOf } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import '../styles/gadgetHint.css';

/** 한 번에 보이는 안내 줄 수 — 설치 + 기폭, 또는 드론 한 줄. */
const MAX_ROWS = 2;
/** 마우스 버튼 → 한국어 (`Mouse0` 좌 · `Mouse1` 휠 · `Mouse2` 우). 그 밖의 코드는 `keyLabel`. */
const MOUSE_KO: readonly string[] = ['좌클릭', '휠클릭', '우클릭'];

type Tone = 'ok' | 'bad' | 'det' | 'info';

interface Row { el: HTMLElement; pre: HTMLElement; key: HTMLElement; txt: HTMLElement; sig: string }

/** 키 라벨은 사용 시점에 읽는다 — 리바인딩되면 다음 프레임부터 따라간다. */
function actionLabel(code: string): string {
  const m = mouseButtonOf(code);
  return m >= 0 && m < MOUSE_KO.length ? MOUSE_KO[m] : keyLabel(code);
}

/**
 * **손에 든 가젯 안내** (`.gadget-hand-hint`, 게임플레이 레이어, 크로스헤어 아래, 2026-09-11).
 *
 * 한 줄 = 키캡 + 문구. 최대 두 줄이고 셋 중 해당하는 것만 쌓는다:
 *   - **설치 미리보기** — `gadget:placementChanged {gadget, valid, reason, mount}` (gadgets 가 바뀔 때만 낸다).
 *     `ctx.gadgets.placement` 가 있으면 그 살아 있는 값을 우선 읽는다(늦게 등록돼 이벤트를 놓쳐도 맞다).
 *     valid → `[좌클릭] 설치` (mount 가 있으면 `드론에 탑재`), invalid → 빨간 `reason` (없으면 `설치 불가`).
 *     판정은 흉내내지 않는다 — gadgets 가 좌클릭에 쓰는 **같은** 판정의 결과를 옮겨 적을 뿐이다.
 *   - **원격 지뢰 기폭** — 손에 든 아이템(`ctx.weapons.remoteState.heldItemId` → `ItemDef.gadgetId`)이나
 *     미리보기 가젯이 `remoteMine` 이고(C4 · 마지막 것을 놓은 뒤의 기폭기 손) `liveRemoteMineCount() > 0` 이면
 *     `[우클릭] 기폭 (n)`. **기폭기 손**(마지막 C4 를 놓은 뒤 슬롯 없는 손 — `heldItemId` 는 C4 def 그대로,
 *     `remoteState.detonator === true`, `quick:equipped` 의 uid 가 `detonator:` 로 시작)에서는 설치 줄을 그리지 않고
 *     `기폭기 · [우클릭] 기폭 (n)` 한 줄만 (0 개면 `기폭기 · 설치된 원격 지뢰 없음`).
 *   - **드론** — 손에 든 가젯이 `droneKindOfGadget` 이면: 내 드론이 없으면 `[좌클릭] 드론 배치`, 있고 사거리 안이면
 *     `[R ˅] 꾹 조종` (`.keycap.kc-hold` — 공용 chevron), `linkLost` 면 빨간 `신호 범위 밖`.
 *
 * 마우스 키는 `좌클릭` · `우클릭` 으로 적는다 (`FIRE` · `AIM` 은 마우스 전용 동작이지만 버튼은 바꿀 수 있으므로
 * `Keys.X` 를 매 프레임 읽는다). **드론 조종 중(`ctx.player.droneControl`) · 화면이 열려 있을 때 · 사망 · 페이즈
 * 밖이면 숨는다.** 값은 매 프레임 폴링하되 DOM 은 줄의 서명(키 · 문구 · 색 · 홀드)이 바뀔 때만 쓴다.
 */
export class GadgetHandHint {
  readonly root: HTMLElement;
  private rows: Row[] = [];
  private evGadget: GadgetId | null = null;
  private evValid = false;
  private evReason: string | null = null;
  private evMount: string | null = null;
  private shown = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'gadget-hand-hint', parent });
    for (let i = 0; i < MAX_ROWS; i++) {
      const row = el('div', { cls: 'ghh-row', parent: this.root });
      row.hidden = true;
      const pre = el('span', { cls: 'pre', parent: row });
      pre.hidden = true;
      const key = el('span', { cls: 'keycap', parent: row });
      const txt = el('span', { cls: 'txt', parent: row });
      this.rows.push({ el: row, pre, key, txt, sig: '' });
    }
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    const clear = (): void => { this.evGadget = null; this.evValid = false; this.evReason = null; this.evMount = null; };
    this.unsubs.push(
      b.on('gadget:placementChanged', ({ gadget, valid, reason, mount }) => {
        this.evGadget = gadget; this.evValid = valid; this.evReason = reason; this.evMount = mount;
      }),
      b.on('game:abort', clear),
      b.on('game:newMission', clear),
    );
  }

  update(_dt: number, ctx: GameContext): void {
    let n = 0;
    const p = ctx.player;
    const on = ctx.isGameplayActive() && !!p && !p.isDead && !(p.droneControl ?? false) && ctx.uiBlockers.size === 0;
    if (on) {
      const held = this.heldGadget(ctx);
      // 기폭기 손: 마지막 C4 를 놓은 뒤 슬롯 없는 손. `heldItemId` 는 C4 def 그대로이고 weapons 가 `detonator` 를 켠다.
      const detonator = (ctx.weapons?.remoteState as { detonator?: boolean } | undefined)?.detonator === true;

      // (1) 설치 미리보기 — 살아 있는 값이 있으면 그것, 없으면 마지막 이벤트. 기폭기 손에는 없다.
      const live = ctx.gadgets?.placement;
      const pGadget = detonator ? null : live !== undefined ? (live?.gadget ?? null) : this.evGadget;
      if (pGadget) {
        const valid = live !== undefined ? live!.valid : this.evValid;
        const reason = live !== undefined ? live!.reason : this.evReason;
        const mount = live !== undefined ? live!.mount : this.evMount;
        if (valid) n = this.setRow(n, null, actionLabel(Keys.FIRE), mount ? '드론에 탑재' : '설치', 'ok', false);
        else n = this.setRow(n, null, null, reason || '설치 불가', 'bad', false);
      }

      // (2) 원격 지뢰 기폭 — C4 를 들었거나 기폭기 손
      if (detonator || held === 'remoteMine' || pGadget === 'remoteMine') {
        const count = ctx.gadgets?.liveRemoteMineCount?.() ?? 0;
        const pre = detonator ? '기폭기 ·' : null;
        if (count > 0) n = this.setRow(n, pre, actionLabel(Keys.AIM), `기폭 (${count})`, 'det', false);
        else if (detonator) n = this.setRow(n, '기폭기 ·', null, '설치된 원격 지뢰 없음', 'info', false);
      }

      // (3) 드론 아이템 = 조종기
      const kind = droneKindOfGadget(held);
      if (kind) {
        const own = ctx.drones?.getOwnDrone(kind) ?? null;
        if (!own) n = this.setRow(n, null, actionLabel(Keys.FIRE), '드론 배치', 'info', false);
        else if (own.linkLost) n = this.setRow(n, null, null, '신호 범위 밖', 'bad', false);
        else n = this.setRow(n, null, keyLabel(Keys.RELOAD), '꾹 조종', 'ok', true);
      }
    }
    for (let i = n; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (!r.el.hidden) { r.el.hidden = true; r.sig = ''; }
    }
    this.shown = n;
  }

  /** 손에 든 소모품이 가젯이면 그 id. 총을 들었거나 가젯이 아니면 null. */
  private heldGadget(ctx: GameContext): GadgetId | null {
    const id = ctx.weapons?.remoteState?.heldItemId;
    if (!id) return null;
    return (ctx.loot?.getItemDef(id)?.gadgetId as GadgetId | undefined) ?? null;
  }

  /** `i` 번 줄을 채우고 다음 줄 번호를 돌려준다. 서명이 같으면 DOM 을 건드리지 않는다. */
  private setRow(i: number, pre: string | null, key: string | null, text: string, tone: Tone, hold: boolean): number {
    if (i >= this.rows.length) return i;
    const r = this.rows[i];
    const sig = `${pre ?? ''}|${key ?? ''}|${text}|${tone}|${hold ? 1 : 0}`;
    if (r.el.hidden) r.el.hidden = false;
    if (sig !== r.sig) {
      r.sig = sig;
      r.el.className = `ghh-row ${tone}`;
      if (r.pre.hidden !== !pre) r.pre.hidden = !pre;
      setText(r.pre, pre ?? '');
      if (r.key.hidden !== !key) r.key.hidden = !key;
      setText(r.key, key ?? '');
      toggleClass(r.key, 'kc-hold', hold);
      setText(r.txt, text);
    }
    return i + 1;
  }

  /** 지금 보이는 안내 줄 수 · 그 문구들 (debug / smoke). */
  get rowCount(): number { return this.shown; }
  get lines(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.shown; i++) {
      const r = this.rows[i];
      const parts: string[] = [];
      if (!r.pre.hidden) parts.push(r.pre.textContent ?? '');
      if (!r.key.hidden) parts.push(r.key.textContent ?? '');
      parts.push(r.txt.textContent ?? '');
      out.push(parts.join(' '));
    }
    return out;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
  }
}
