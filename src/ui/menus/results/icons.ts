import type { RaidXpKind } from '@/shared';

/**
 * Procedural 24×24 line icons (currentColor, no fill) for the paged result screen — XP card kinds, the like thumb, its
 * check mark. No asset files (§4.1).
 */
const KIND_PATHS: Readonly<Record<RaidXpKind, string>> = {
  // Kill — a crosshair
  kill: '<circle cx="12" cy="12" r="7"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/><circle cx="12" cy="12" r="1.2"/>',
  // Gathering — a crystal cluster
  gather: '<path d="M8 20.5l-3-6 3-7 3 7z"/><path d="M14 20.5l-2.5-8L15 4l3.5 8.5z"/><path d="M3.5 20.5h17"/>',
  // Structure discovery — a building with a flag
  discover: '<path d="M4 20.5V11l6-4 6 4v9.5"/><path d="M8.5 20.5v-5h3v5"/><path d="M16 11V3.5l4 1.6-4 1.6"/><path d="M2.5 20.5h19"/>',
  // Map revealed — a folded map
  mapReveal: '<path d="M3.5 6.5l5.5-2.5 6 2.5 5.5-2.5v13.5l-5.5 2.5-6-2.5-5.5 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  // Survey — a camera
  survey: '<path d="M3.5 8.5h4l1.5-2.5h6l1.5 2.5h4v10.5h-17z"/><circle cx="12" cy="13.5" r="3.5"/>',
  // Player trust — two people
  trust: '<circle cx="8.5" cy="8" r="3"/><circle cx="16" cy="9" r="2.5"/><path d="M3 20a5.5 5.5 0 0 1 11 0"/><path d="M14.5 15.2A4.6 4.6 0 0 1 21 19.5"/>',
  // Contract — a document with a seal
  contract: '<path d="M6 3.5h9l3.5 3.5v13.5H6z"/><path d="M15 3.5V7h3.5"/><path d="M8.5 11h7M8.5 14h4"/><circle cx="15" cy="17.5" r="1.6"/>',
};

const FALLBACK_PATH = '<path d="M12 3.5l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>';

export function xpKindSvg(kind: RaidXpKind | string): string {
  const p = (KIND_PATHS as Readonly<Record<string, string>>)[kind] ?? FALLBACK_PATH;
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}

/** The like (thumb up) glyph. */
export const THUMB_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5v10H4v-10z"/><path d="M7.5 10.5l3.8-6.2c.9-1.4 3-.6 2.7 1l-.7 3.7h5.2c1.3 0 2.2 1.2 1.9 2.4l-1.8 7c-.2.9-1 1.6-2 1.6H7.5"/></svg>';
/** The liked state — a check mark. */
export const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>';
