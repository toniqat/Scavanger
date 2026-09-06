import type { GameContext, ItemDef, ItemInstance, SocketSlot } from '@/shared';
import type { WeaponAttachmentVisuals } from './WeaponModel';

/**
 * Attachment def ids → procedural attachment visuals (`WeaponModel.setAttachments`). Shared by the local
 * weapon (ids from `ItemInstance.sockets`) and remote replicas (ids from `PlayerSnapshot.att`) so both clients
 * draw the same brake / grip / laser / mag / stock for the same items.
 *
 * The socket comes from the item def (`ItemDef.attachment.socket`); when the def is unknown on this client the
 * caller's `fallbackSocket` (the socket key the instance stores it under) or a keyword in the id is used.
 */
export function addAttachmentVisual(ctx: GameContext, out: WeaponAttachmentVisuals, defId: string, fallbackSocket?: SocketSlot): void {
  const def: ItemDef | undefined = ctx.loot?.getItemDef(defId) ?? ctx.inventory?.getDef(defId);
  const id = defId.toLowerCase();
  const socket: SocketSlot | undefined = def?.attachment?.socket ?? fallbackSocket ?? socketFromId(id);
  switch (socket) {
    case 'muzzle': out.muzzle = id.includes('comp') ? 'comp' : id.includes('choke') ? 'choke' : 'brake'; break;
    case 'grip': out.grip = id.includes('angled') ? 'angled' : 'vertical'; break;
    case 'sight': out.sight = (def?.attachment?.effects.laser || id.includes('laser')) ? 'laser' : 'scope'; break;
    case 'mag': out.mag = true; break;
    case 'stock': out.stock = true; break;
    default: break;
  }
}

function socketFromId(id: string): SocketSlot | undefined {
  if (id.includes('brake') || id.includes('comp') || id.includes('choke') || id.includes('muzzle') || id.includes('suppress')) return 'muzzle';
  if (id.includes('grip')) return 'grip';
  if (id.includes('laser') || id.includes('scope') || id.includes('sight') || id.includes('dot')) return 'sight';
  if (id.includes('mag')) return 'mag';
  if (id.includes('stock')) return 'stock';
  return undefined;
}

/** Visuals for a whole instance (its `sockets` map). */
export function attachmentVisualsFor(ctx: GameContext, inst: ItemInstance): WeaponAttachmentVisuals {
  const out: WeaponAttachmentVisuals = {};
  const sockets = inst.sockets;
  if (!sockets) return out;
  for (const key of Object.keys(sockets) as SocketSlot[]) {
    const att = sockets[key];
    if (att) addAttachmentVisual(ctx, out, att.defId, key);
  }
  return out;
}

/** Visuals for a wire list of attachment def ids (remote replicas). */
export function attachmentVisualsFromIds(ctx: GameContext, ids: readonly string[]): WeaponAttachmentVisuals {
  const out: WeaponAttachmentVisuals = {};
  for (let i = 0; i < ids.length; i++) addAttachmentVisual(ctx, out, ids[i]);
  return out;
}

/** Socketed attachment def ids of an instance in a stable order (socket key order), into `out`. */
export function attachmentIdsOf(inst: ItemInstance | null | undefined, out: string[]): string[] {
  out.length = 0;
  const sockets = inst?.sockets;
  if (!sockets) return out;
  for (const key of Object.keys(sockets) as SocketSlot[]) {
    const att = sockets[key];
    if (att) out.push(att.defId);
  }
  return out;
}

/** Element-wise equality of two id lists. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
