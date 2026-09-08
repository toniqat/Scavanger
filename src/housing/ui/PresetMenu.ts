import type { GameContext, ImplantId, LoadoutPreset } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { HousingPanel } from './Panel';
import { clear, el, isolateInput, setText } from './dom';

const IMPLANT_LABEL: Readonly<Record<ImplantId, string>> = {
  grapple: '갈고리', dash: '대시', barrier: '배리어', overcharge: '오버차지', scan: '정찰', atlauncher: '대전차포',
};
/** Rows of a preset card. `implantItems` (2026-09-08) is a list, so `slotText` joins it. */
const SLOT_LABEL: ReadonlyArray<[keyof LoadoutPreset, string]> = [
  ['primary', '주무기 I'], ['primary2', '주무기 II'], ['secondary', '보조무기'], ['bag', '가방'], ['armor', '방탄복'],
  ['implant', '전술 임플란트'], ['implantItems', '임플란트'],
];

/**
 * 프리셋 메뉴 (`openPresetMenu()`): one card per preset slot (`getPresetCount()`): name field, 현재 장비 저장, 적용,
 * 삭제 and the slot contents; the last apply result (장착 n · 없음 list) is shown under the list.
 *
 * Phase 8 UI pass: the only way in is the **관물대** (`furn_range_console`) placed in a 사격장 room — the 시설 메뉴 and
 * its 프리셋 button are gone, so the header no longer links back to one.
 */
export class PresetMenu extends HousingPanel {
  private subtitle: HTMLElement;
  private list: HTMLElement;
  private result: HTMLElement;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'presets', 'preset-menu');
    const f = this.frame;
    const head = el('div', { cls: 'hs-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '로드아웃 프리셋', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });

    const page = el('div', { cls: 'hs-page', parent: f });
    const sec = this.section(page, '프리셋');
    this.list = el('div', { cls: 'hs-list presets', parent: sec });
    this.result = el('div', { cls: 'hs-result', text: '', parent: sec });
    this.result.hidden = true;

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: f });
    el('div', { cls: 'hint', text: '가방 + 창고에 있는 장비만 장착됩니다. 없는 장비는 슬롯을 비웁니다.', parent: el('div', { cls: 'left', parent: foot }) });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());
  }

  open(): void { this.openPanel(); }

  /** Do not rebuild the cards while a name is being typed (an inventory change would wipe the field). */
  protected override refreshIfOpen(): void {
    const a = document.activeElement;
    if (this.isOpen && a instanceof HTMLInputElement && this.root.contains(a)) return;
    super.refreshIfOpen();
  }

  private slotText(preset: LoadoutPreset, key: keyof LoadoutPreset): string {
    const v = preset[key];
    if (!v) return '—';
    if (Array.isArray(v)) return v.length ? v.map((d) => this.housing.nameOf(d)).join(', ') : '없음';
    if (key === 'implant') return IMPLANT_LABEL[v as ImplantId] ?? String(v);
    return this.housing.nameOf(v as string);
  }

  private save(index: number, name: string): void {
    const cur = this.housing.captureLoadout();
    if (!cur) { this.showMsg('현재 장비를 읽을 수 없습니다 (인벤토리 준비 중)', 'warning'); return; }
    const preset: LoadoutPreset = { ...cur, name: name.trim() || `프리셋 ${index + 1}` };
    if (this.housing.savePreset(index, preset)) this.showMsg(`${preset.name} 저장`, 'success');
    this.refresh();
  }

  private apply(index: number): void {
    const r = this.housing.applyPreset(index);
    if (!r) { this.showMsg(this.ctx.phase === 'hub' ? '적용할 수 없습니다 (인벤토리 준비 중)' : '함선에서만 적용할 수 있습니다', 'warning'); return; }
    const missing = r.missing.map((d) => this.housing.nameOf(d));
    setText(this.result, `장착 ${r.equipped}${missing.length ? ` · 없음: ${missing.join(', ')}` : ''}`);
    this.result.hidden = false;
    this.showMsg(missing.length ? `장비 ${r.equipped}개 장착, ${missing.length}개 없음` : `장비 ${r.equipped}개 장착`, missing.length ? 'warning' : 'success');
  }

  refresh(): void {
    const h = this.housing;
    const presets = h.getPresets();
    const range = h.getFacility('range');
    setText(this.subtitle, range.level > 0 ? `사격장 Lv.${range.level} · 슬롯 ${presets.length}개` : '사격장 방이 없습니다 — 방 용도를 사격장으로 정하면 프리셋 슬롯이 열립니다.');
    clear(this.list);
    if (!presets.length) el('div', { cls: 'hs-empty', text: '프리셋 슬롯이 없습니다', parent: this.list });
    presets.forEach((preset, i) => {
      const card = el('div', { cls: `hs-preset${preset ? '' : ' empty'}`, parent: this.list, attrs: { 'data-preset': String(i) } });
      const top = el('div', { cls: 'top', parent: card });
      el('span', { cls: 'idx', text: String(i + 1), parent: top });
      const name = el('input', { cls: 'ui-input name', attrs: { type: 'text', maxlength: '24', placeholder: `프리셋 ${i + 1}`, spellcheck: 'false' }, parent: top });
      name.value = preset?.name ?? '';
      isolateInput(name);            // 2026-09-08: Escape only blurs the field; the panel closes on E
      name.addEventListener('change', () => { if (preset && h.savePreset(i, { ...preset, name: name.value.trim() || preset.name })) this.showMsg('이름 변경', 'info'); });
      const slots = el('div', { cls: 'slots', parent: card });
      for (const [key, label] of SLOT_LABEL) {
        const s = el('div', { cls: 'slot', parent: slots });
        el('span', { cls: 'k', text: label, parent: s });
        el('span', { cls: 'v', text: preset ? this.slotText(preset, key) : '—', parent: s });
      }
      const actions = el('div', { cls: 'actions', parent: card });
      this.button(actions, '현재 장비 저장', () => this.save(i, name.value), 'small');
      const ba = this.button(actions, '적용', () => this.apply(i), 'small primary');
      ba.disabled = !preset;
      const bd = this.button(actions, '삭제', () => { if (h.deletePreset(i)) this.showMsg('프리셋 삭제', 'info'); this.refresh(); }, 'small danger');
      bd.disabled = !preset;
    });
  }
}
