import type { StratagemDef, StratagemId } from '@/shared';
import { STRATAGEM_DEFS } from '@/shared';

/** HUD glyph per ship call (text only — no asset files). */
export const STRATAGEM_GLYPH: Readonly<Record<StratagemId, string>> = {
  orbital_laser: '◎',
  airstrike: '▼',
  supply_drop: '▣',
  structure_drop: '▦',
};

/** CSS colour per ship call (danger red for the two orbital strikes, green/blue for the drops). */
export const STRATAGEM_COLOR: Readonly<Record<StratagemId, string>> = {
  orbital_laser: '#ff4d4d',
  airstrike: '#ff8a3d',
  supply_drop: '#4fd17e',
  structure_drop: '#7fb7e6',
};

export function stratagemDef(id: StratagemId | null | undefined): StratagemDef | undefined {
  return id ? STRATAGEM_DEFS.find((d) => d.id === id) : undefined;
}

/** Mouse hint by targeting mode (armed / targeting HUD). */
export function stratagemArmHint(def: StratagemDef): string {
  return def.targeting === 'topview' ? '좌클 홀드 → 위치 지정' : '좌클 투하 · 우클 취소';
}
export function stratagemTargetHint(def: StratagemDef): string {
  return def.targeting === 'topview' ? '좌클 확정 · 우클/Esc 취소' : '좌클 투하 · 우클 취소';
}
