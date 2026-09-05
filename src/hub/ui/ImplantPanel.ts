import type { GameContext, ImplantDef, ImplantId } from '@/shared';
import {
  IMPLANT_IDS, IMPLANT_AT_COOLDOWN, IMPLANT_BARRIER_HP, IMPLANT_DASH_CHARGES, IMPLANT_DASH_COOLDOWN,
  IMPLANT_DASH_DISTANCE, IMPLANT_GRAPPLE_COOLDOWN, IMPLANT_GRAPPLE_RANGE, IMPLANT_OVERCHARGE_RANGE,
  IMPLANT_SCAN_COOLDOWN, KEY_IMPLANT,
} from '@/shared';
import { el, setText, toggleClass } from './dom';

/**
 * Fallback catalogue used until `ctx.implants` exists (the implants system is registered separately).
 * Numbers come from `@/shared/constants` so the two never drift; `ImplantSystem.getAllDefs()` wins when present.
 */
const FALLBACK: Record<ImplantId, ImplantDef> = {
  grapple: {
    id: 'grapple', name: '갈고리', mode: 'wielded', cooldown: IMPLANT_GRAPPLE_COOLDOWN, charges: 1, icon: '⌇', color: '#7fe0c0',
    description: `와이어를 발사해 지형·지물에 걸고 그 지점으로 끌려갑니다. 사거리 ${IMPLANT_GRAPPLE_RANGE} m.`,
  },
  dash: {
    id: 'dash', name: '대시', mode: 'instant', cooldown: IMPLANT_DASH_COOLDOWN, charges: IMPLANT_DASH_CHARGES, icon: '»', color: '#ffd166',
    description: `정면으로 ${IMPLANT_DASH_DISTANCE} m 순간 이동합니다. 충전 ${IMPLANT_DASH_CHARGES}회.`,
  },
  barrier: {
    id: 'barrier', name: '배리어', mode: 'instant', cooldown: 0, charges: 1, icon: '⌒', color: '#8fc8ff',
    description: `정면에 넓은 실드를 전개해 적 발사체를 막습니다. 내구도 ${IMPLANT_BARRIER_HP}, 비전개 시 회복.`,
  },
  overcharge: {
    id: 'overcharge', name: '오버차지', mode: 'wielded', cooldown: 0, charges: 1, icon: '≈', color: '#c08bff',
    description: `빔으로 아군을 회복하거나(좌클릭) 이동·연사 속도를 강화합니다(우클릭). 사거리 ${IMPLANT_OVERCHARGE_RANGE} m.`,
  },
  scan: {
    id: 'scan', name: '정찰', mode: 'wielded', cooldown: IMPLANT_SCAN_COOLDOWN, charges: 1, icon: '◎', color: '#5fd7ff',
    description: '파동을 보내 벽 너머의 적·상자·채집물·설치물을 일정 시간 표시합니다.',
  },
  atlauncher: {
    id: 'atlauncher', name: '대전차포', mode: 'wielded', cooldown: IMPLANT_AT_COOLDOWN, charges: 1, icon: '➤', color: '#ff8a5a',
    description: '로켓을 발사해 착탄점에 큰 폭발을 일으킵니다. 대형 개체 상대용.',
  },
};

/** 'KeyQ' → 'Q', 'Digit3' → '3'. */
function implantKeyLabel(): string {
  return String(KEY_IMPLANT).replace(/^(Key|Digit)/, '');
}

interface Row {
  root: HTMLElement;
  icon: HTMLElement;
  name: HTMLElement;
  meta: HTMLElement;
  desc: HTMLElement;
  tag: HTMLElement;
}

/** What the panel needs from `HubMenu`. */
export interface ImplantPanelHost {
  showMsg(text: string, kind?: 'info' | 'success' | 'warning' | 'danger'): void;
}

/**
 * 전술 임플란트 장착 page of the ship terminal. Lists all six implants and equips one through
 * `ctx.implants.setEquipped` (ship only — the call refuses during a raid and we say so).
 */
export class ImplantPanel {
  readonly root: HTMLElement;
  private rows = new Map<ImplantId, Row>();
  private note: HTMLElement;
  private btnClear: HTMLButtonElement;
  private unsubs: Array<() => void> = [];

  constructor(private readonly ctx: GameContext, private readonly host: ImplantPanelHost) {
    const root = this.root = el('div', { cls: 'hub-page' });
    const sec = el('div', { cls: 'hub-section', parent: root });
    el('div', { cls: 'ui-label', text: '전술 임플란트', parent: sec });
    this.note = el('div', { cls: 'hint', parent: sec });

    const list = el('div', { cls: 'imp-list', parent: sec });
    for (const id of IMPLANT_IDS) {
      const row = el('div', { cls: 'imp-card', parent: list });
      const icon = el('div', { cls: 'ico', parent: row });
      const body = el('div', { cls: 'body', parent: row });
      const head = el('div', { cls: 'head', parent: body });
      const name = el('div', { cls: 'name', parent: head });
      const tag = el('div', { cls: 'tag', parent: head });
      const meta = el('div', { cls: 'meta', parent: head });
      const desc = el('div', { cls: 'desc', parent: body });
      row.addEventListener('click', (e) => { e.stopPropagation(); this.select(id); });
      this.rows.set(id, { root: row, icon, name, meta, desc, tag });
    }

    this.btnClear = el('button', { cls: 'ui-btn wide', text: '장착 해제', parent: sec });
    this.btnClear.addEventListener('click', (e) => { e.stopPropagation(); this.select(null); });

    el('div', { cls: 'hint', text: `장착한 임플란트는 임무 중 ${implantKeyLabel()} 키로 사용합니다. 함선에서만 교체할 수 있습니다.`, parent: sec });

    this.unsubs.push(ctx.bus.on('implant:equipped', () => this.refresh()));
  }

  private defs(): readonly ImplantDef[] {
    const fromSystem = this.ctx.implants?.getAllDefs?.();
    if (fromSystem && fromSystem.length) return fromSystem;
    return IMPLANT_IDS.map((id) => FALLBACK[id]);
  }

  private equipped(): ImplantId | null {
    return this.ctx.implants?.equipped ?? this.ctx.progression?.profile?.implant ?? null;
  }

  private select(id: ImplantId | null): void {
    const ctx = this.ctx;
    ctx.bus.emit('audio:play', { id: 'ui_click' });
    if (ctx.isRaidActive()) { this.host.showMsg('임무 중에는 임플란트를 교체할 수 없습니다', 'warning'); return; }
    const imp = ctx.implants;
    if (!imp) { this.host.showMsg('임플란트 모듈을 사용할 수 없습니다', 'danger'); return; }
    if (id !== null && this.equipped() === id) { this.refresh(); return; }
    const ok = imp.setEquipped(id);
    if (!ok) { this.host.showMsg('지금은 임플란트를 교체할 수 없습니다', 'warning'); return; }
    const def = this.defs().find((d) => d.id === id);
    this.host.showMsg(id === null ? '임플란트를 해제했습니다' : `${def?.name ?? id} 장착 완료`, 'success');
    this.refresh();
  }

  refresh(): void {
    const ctx = this.ctx;
    const available = !!ctx.implants;
    const raid = ctx.isRaidActive();
    const equipped = this.equipped();
    const defs = this.defs();

    setText(this.note, !available
      ? '임플란트 모듈이 아직 활성화되지 않았습니다 — 목록만 표시합니다.'
      : raid ? '임무 중에는 교체할 수 없습니다.'
        : '하나를 선택해 장착합니다. 함선에서만 교체할 수 있습니다.');
    toggleClass(this.note, 'warn', !available || raid);

    for (const id of IMPLANT_IDS) {
      const row = this.rows.get(id);
      const def = defs.find((d) => d.id === id) ?? FALLBACK[id];
      if (!row) continue;
      const on = equipped === id;
      row.root.className = `imp-card${on ? ' on' : ''}${available && !raid ? '' : ' locked'}`;
      row.root.style.setProperty('--ic', def.color);
      setText(row.icon, def.icon);
      setText(row.name, def.name);
      setText(row.tag, def.mode === 'instant' ? '즉시' : '장비형');
      const bits: string[] = [];
      if (def.cooldown > 0) bits.push(`쿨타임 ${def.cooldown}초`);
      if (def.charges > 1) bits.push(`충전 ${def.charges}`);
      setText(row.meta, bits.join(' · '));
      setText(row.desc, def.description);
    }
    this.btnClear.disabled = !available || raid || equipped === null;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
  }
}
