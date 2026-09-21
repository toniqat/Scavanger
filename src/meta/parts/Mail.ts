/**
 * src/meta/parts/Mail.ts — the mailbox (`ctx.meta.mail`, contract `shared/mail.ts`, 2026-09-21).
 *
 * Mostly NPCs sending parcels alongside a quest. The mail lives in the meta document (`MetaSave.mail`), so it rides
 * the same localStorage cache + server profile sync as credits and NPC quests (`MetaStorage.markDirty`). A claim puts
 * the attachments into the **ship stash only** (never the bag) and only in the ship; what does not fit stays in the
 * mail (`qty` reduced), so nothing is ever lost. A mail with unclaimed attachments is never deleted — neither by
 * `deleteRead` nor by the `MAIL_KEEP_MAX` trim. Toasts are `ui/`'s: this part emits `ui:notify` / `mail:*` only.
 */
import type { MailAttachment, MailClaimResult, MailMessage, MailRef, MailSave, MailSendInput } from '@/shared';
import { MAIL_BODY_MAX_CHARS, MAIL_KEEP_MAX, MAIL_SEEN_IDS_MAX, MAIL_SUBJECT_MAX_CHARS, NPC_DEFS, resolveItemAlias } from '@/shared';
import type { MetaSystem } from '../MetaSystem';

/** Hostile-save guard for ids and sender labels (the text itself is only ever shown as `textContent`). */
const MAX_ID = 120;

export function freshMailSave(): MailSave {
  return { list: [], seen: [] };
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);

function sanitizeItems(raw: unknown): MailAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: MailAttachment[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const a = it as { defId?: unknown; qty?: unknown };
    const defId = str(a.defId, MAX_ID);
    const qty = Math.floor(Number(a.qty));
    if (defId && Number.isFinite(qty) && qty > 0) out.push({ defId, qty });
  }
  return out;
}

/** Anything out of storage → a valid `MailSave` (an old save has none → empty). */
export function sanitizeMailSave(raw: unknown): MailSave {
  const out = freshMailSave();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as { list?: unknown; seen?: unknown };
  const ids = new Set<string>();
  if (Array.isArray(r.list)) {
    for (const m of r.list) {
      if (!m || typeof m !== 'object') continue;
      const x = m as Partial<Record<keyof MailMessage, unknown>>;
      const id = str(x.id, MAX_ID);
      if (!id || ids.has(id)) continue;
      const items = sanitizeItems(x.items);
      const sentAt = Number(x.sentAt);
      ids.add(id);
      out.list.push({
        id,
        from: str(x.from, MAX_ID) ?? '',
        fromName: str(x.fromName, MAX_ID) ?? '',
        subject: str(x.subject, MAIL_SUBJECT_MAX_CHARS) ?? '',
        body: str(x.body, MAIL_BODY_MAX_CHARS) ?? '',
        sentAt: Number.isFinite(sentAt) ? sentAt : 0,
        read: x.read === true,
        items,
        // a claimed flag with items left is a lie — the items win
        claimed: items.length === 0,
        hadItems: items.length > 0 || x.hadItems === true,
      });
    }
  }
  if (Array.isArray(r.seen)) for (const s of r.seen) { const id = str(s, MAX_ID); if (id) ids.add(id); }
  out.seen = [...ids].slice(-Math.max(1, MAIL_SEEN_IDS_MAX));
  return out;
}

/** Sender id → Korean display name (an NPC's `name`, else the id itself as a free label). */
function senderName(from: string): string {
  return NPC_DEFS.find((d) => d.id === from)?.name ?? from;
}

export class Mail implements MailRef {
  constructor(private readonly sys: MetaSystem) {}

  /** The live save object (created on the fly for a document that predates the mailbox). */
  private get box(): MailSave {
    const d = this.sys.store.data;
    if (!d.mail) d.mail = freshMailSave();
    return d.mail;
  }

  /** Bus subscriptions — pushed by `MetaSystem.init` after its own `net:profileLoaded` (the new document is in place by then). */
  subscribe(): Array<() => void> {
    const b = this.sys.ctx.bus;
    return [
      b.on('net:profileLoaded', () => this.changed(false)),
    ];
  }

  list(): readonly MailMessage[] { return [...this.box.list].reverse(); }

  unreadCount(): number {
    let n = 0;
    for (const m of this.box.list) if (!m.read) n++;
    return n;
  }

  send(input: MailSendInput): boolean {
    const id = str(input?.id, MAX_ID);
    if (!id) return false;
    const box = this.box;
    if (box.seen.includes(id) || box.list.some((m) => m.id === id)) return false;
    const items = sanitizeItems(input.items ?? []);
    const from = str(input.from, MAX_ID) ?? '';
    box.list.push({
      id,
      from,
      fromName: senderName(from),
      subject: str(input.subject, MAIL_SUBJECT_MAX_CHARS) ?? '',
      body: str(input.body, MAIL_BODY_MAX_CHARS) ?? '',
      sentAt: Date.now(),
      read: false,
      items,
      claimed: items.length === 0,
      hadItems: items.length > 0,
    });
    box.seen.push(id);
    if (box.seen.length > MAIL_SEEN_IDS_MAX) box.seen.splice(0, box.seen.length - MAIL_SEEN_IDS_MAX);
    this.trim();
    this.sys.ctx.bus.emit('mail:received', { id, from });
    this.changed(true);
    return true;
  }

  markRead(id: string): void {
    const m = this.box.list.find((x) => x.id === id);
    if (!m || m.read) return;
    m.read = true;
    this.changed(true);
  }

  claim(id: string): MailClaimResult {
    const m = this.box.list.find((x) => x.id === id);
    if (!m || m.claimed || m.items.length === 0) return 'nothing';
    if (!this.sys.inShip) return 'in_raid';
    const r = this.claimOne(m);
    this.changed(true);
    this.notify(r);
    return r;
  }

  claimAll(): MailClaimResult {
    const open = this.box.list.filter((m) => !m.claimed && m.items.length > 0);
    if (open.length === 0) return 'nothing';
    if (!this.sys.inShip) return 'in_raid';
    let any = false;
    let result: MailClaimResult = 'ok';
    // oldest first — the parcel that waited longest gets the space first
    for (const m of open) {
      const r = this.claimOne(m);
      if (r === 'ok' || r === 'partial') any = true;
      if (r !== 'ok') { result = any ? 'partial' : r; break; }
    }
    this.changed(true);
    this.notify(result);
    return result;
  }

  deleteRead(): number {
    const box = this.box;
    const before = box.list.length;
    box.list = box.list.filter((m) => !(m.read && m.claimed));
    const n = before - box.list.length;
    if (n > 0) this.changed(true);
    return n;
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  /**
   * Move one mail's attachments into the stash, stack by stack (`stackMax`). A stack that does not fit ends the claim:
   * the units already placed are taken off the attachment, the rest stays. An attachment whose def no longer exists
   * is dropped (it can never be claimed — keeping it would make the mail undeletable forever).
   */
  private claimOne(m: MailMessage): MailClaimResult {
    const ctx = this.sys.ctx;
    const loot = ctx.loot, inv = ctx.inventory;
    if (!loot || !inv || typeof inv.tryAddToStash !== 'function') return 'no_space';
    let placedAny = false;
    let blocked = false;
    const left: MailAttachment[] = [];
    for (const a of m.items) {
      if (blocked) { left.push(a); continue; }
      // a def retired since the mail arrived resolves through `data/item_aliases.csv` like any old save
      const defId = resolveItemAlias(a.defId);
      const def = loot.getItemDef(defId);
      if (!def) { console.warn(`[meta] mail ${m.id}: unknown item ${a.defId} dropped`); continue; }
      let qty = a.qty;
      while (qty > 0) {
        const n = Math.min(Math.max(1, def.stackMax), qty);
        let ok = false;
        try { ok = inv.tryAddToStash(loot.createItem(defId, n)); } catch { ok = false; }
        if (!ok) break;
        placedAny = true;
        qty -= n;
      }
      if (qty > 0) { blocked = true; left.push({ defId, qty }); }
    }
    m.items = left;
    m.claimed = left.length === 0;
    if (m.claimed) m.read = true;
    if (!blocked) return 'ok';
    return placedAny ? 'partial' : 'no_space';
  }

  private notify(r: MailClaimResult): void {
    const bus = this.sys.ctx.bus;
    if (r === 'ok') bus.emit('ui:notify', { text: '첨부 아이템을 창고로 옮겼습니다', kind: 'success' });
    else if (r === 'partial') bus.emit('ui:notify', { text: '창고가 가득 차 일부만 받았습니다 — 나머지는 메일에 남아 있습니다', kind: 'warning' });
    else if (r === 'no_space') bus.emit('ui:notify', { text: '창고에 빈 자리가 없습니다', kind: 'warning' });
    else if (r === 'in_raid') bus.emit('ui:notify', { text: '첨부 아이템은 함선에서만 받을 수 있습니다', kind: 'warning' });
    if (r === 'ok' || r === 'partial') bus.emit('audio:play', { id: 'ui_click' });
  }

  /** Over `MAIL_KEEP_MAX`: drop the oldest read + claimed mails (never one with items left). */
  private trim(): void {
    const box = this.box;
    let over = box.list.length - MAIL_KEEP_MAX;
    if (over <= 0) return;
    box.list = box.list.filter((m) => {
      if (over > 0 && m.read && m.claimed) { over--; return false; }
      return true;
    });
  }

  private changed(dirty: boolean): void {
    if (dirty) this.sys.store.markDirty();
    this.sys.ctx.bus.emit('mail:changed', { unread: this.unreadCount(), total: this.box.list.length });
  }

  /** Console: forget every mail and every seen id. */
  reset(): void {
    this.sys.store.data.mail = freshMailSave();
    this.changed(true);
  }
}
