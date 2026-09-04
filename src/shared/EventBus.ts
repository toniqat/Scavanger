import type { GameEvents, GameEventName } from './events';

type Handler<K extends GameEventName> = (payload: GameEvents[K]) => void;

/** Typed synchronous event bus. Handlers run in registration order; exceptions are isolated. */
export class EventBus {
  private handlers = new Map<GameEventName, Set<Handler<any>>>();

  on<K extends GameEventName>(name: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) { set = new Set(); this.handlers.set(name, set); }
    set.add(fn);
    return () => this.off(name, fn);
  }
  once<K extends GameEventName>(name: K, fn: Handler<K>): () => void {
    const off = this.on(name, (p) => { off(); fn(p); });
    return off;
  }
  off<K extends GameEventName>(name: K, fn: Handler<K>): void {
    this.handlers.get(name)?.delete(fn);
  }
  emit<K extends GameEventName>(name: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch (e) { console.error(`[EventBus] handler for ${String(name)} threw`, e); }
    }
  }
  clear(): void { this.handlers.clear(); }
}
