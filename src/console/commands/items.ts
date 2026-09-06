import type { CommandFactory } from './types';
import { err } from './types';

/** `items` — open the inventory's infinite item catalog (the window itself belongs to inventory/). */
export const items: CommandFactory = () => ({
  name: 'items',
  usage: 'items',
  description: '무한 아이템 상자(카탈로그)를 엽니다',
  run(_args, ctx) {
    const inv = ctx.inventory;
    if (!inv || typeof inv.openCatalog !== 'function') return err('인벤토리 시스템이 준비되지 않았습니다');
    // Close the console first so the catalog's own blocker decides the pointer-lock state.
    ctx.console?.close();
    inv.openCatalog();
    return '아이템 카탈로그 열림';
  },
});
