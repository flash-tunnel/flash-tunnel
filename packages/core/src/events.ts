type Handler = (payload: never) => void

/**
 * Minimal typed event emitter used by core. Deliberately not an EventEmitter:
 * a throwing listener must never interrupt creation or cleanup work.
 */
export class Emitter<Events extends object> {
  private readonly handlers = new Map<keyof Events, Set<Handler>>()

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set<Handler>()
    handlers.add(listener as Handler)
    this.handlers.set(event, handlers)

    return () => {
      handlers.delete(listener as Handler)
    }
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const handlers = this.handlers.get(event)
    if (!handlers) {
      return
    }

    for (const handler of handlers) {
      try {
        (handler as (value: Events[K]) => void)(payload)
      }
      catch {
        // Observers are best-effort; core owns the state machine.
      }
    }
  }

  clear(): void {
    this.handlers.clear()
  }
}
