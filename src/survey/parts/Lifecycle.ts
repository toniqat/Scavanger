/**
 * src/survey/parts/Lifecycle.ts — page lifecycle hooks (the same moments meta/'s store flushes on).
 */

/** Calls `flush` when the page hides or unloads. Returns the unsubscribe. */
export function flushOnHide(flush: () => void): () => void {
  if (typeof window === 'undefined') return () => { /* no page */ };
  const on = (): void => flush();
  window.addEventListener('pagehide', on);
  window.addEventListener('beforeunload', on);
  return () => {
    window.removeEventListener('pagehide', on);
    window.removeEventListener('beforeunload', on);
  };
}
