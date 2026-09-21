/**
 * Mailbox (2026-09-21, user's decisions):
 *
 * - Mostly NPCs sending items with a quest (the survey camera parcel first). **Existing NPC quest rewards stay as they
 *   are** (paid on report) — mail is for parcels only.
 * - Its own HUD button **left of the messenger button**, its own window: list left, the selected mail right with the
 *   attached items as thumbnails at the bottom; the list's bottom bar has `읽은 메일 삭제` (bulk) and `모두 받기`.
 * - Stored in the character's meta document (so it follows the profile sync), per save slot.
 *
 * Owner: `meta/` implements `MailRef` as `ctx.meta.mail`; `ui/` draws the button and the window.
 */

export interface MailAttachment {
  defId: string;
  qty: number;
}

export interface MailMessage {
  /** Unique, stable (`<source>:<key>` for scripted mail so a resend is idempotent). */
  id: string;
  /** Sender: an NPC id (`data/npcs.csv`) or a free label for system mail. */
  from: string;
  /** Korean display name of the sender (resolved at send time). */
  fromName: string;
  subject: string;
  body: string;
  /** Epoch ms. */
  sentAt: number;
  read: boolean;
  /** Attachments not yet claimed. Empty after `모두 받기` / a claim. */
  items: MailAttachment[];
  /** True once every attachment was claimed (a mail that never had any is also claimed). */
  claimed: boolean;
  /** True when the mail was sent with attachments — tells `받음` (claimed) from a mail that never had any. Absent on an old save = derived from `claimed` / `items`. */
  hadItems?: boolean;
}

export interface MailSendInput {
  id: string;
  from: string;
  subject: string;
  body: string;
  items?: MailAttachment[];
}

export type MailClaimResult = 'ok' | 'partial' | 'no_space' | 'in_raid' | 'nothing';

export interface MailRef {
  /** Newest first. */
  list(): readonly MailMessage[];
  unreadCount(): number;
  /** Idempotent by `id` — sending an id that already exists (even deleted) does nothing and returns false. */
  send(input: MailSendInput): boolean;
  markRead(id: string): void;
  /** Claim one mail's attachments into the stash. Ship only. */
  claim(id: string): MailClaimResult;
  /** Claim every mail's attachments (stops at the first one that does not fit). */
  claimAll(): MailClaimResult;
  /** Delete every read mail whose attachments are claimed. Returns how many went. */
  deleteRead(): number;
}

/* ══ appended 2026-09-21 (agent MAIL): the saved shape ══ */

/**
 * The mailbox inside the meta document (`MetaSave.mail`). `list` is **oldest first** in storage (`MailRef.list()`
 * returns it reversed). `seen` holds every id ever delivered — deleted ones included — so a scripted resend with the
 * same id is a no-op after the player deleted it (capped at `MAIL_SEEN_IDS_MAX`, oldest forgotten first).
 */
export interface MailSave {
  list: MailMessage[];
  seen: string[];
}

declare module './meta' {
  interface MetaSave {
    /** 2026-09-21 (`META_SAVE_VERSION` 3): the mailbox. Absent on an older save = empty. */
    mail?: MailSave;
  }
}
