export type LedgerKind = 'dns' | 'server' | 'tunnel' | 'tunnel-process'

export interface LedgerOrigin {
  sessionId: string
  createdAt: number
  version: string
}

export interface LedgerEntry<T = unknown> {
  kind: LedgerKind
  provider: string
  ref: T
  origin: LedgerOrigin
  /** false means dispose only detaches (for example a reused dev server). */
  owned: boolean
  dispose: () => Promise<void>
}

/**
 * Ordered resource ledger. Entries are disposed in reverse creation order,
 * and one failing dispose never blocks the remaining entries.
 */
export class ResourceLedger {
  private readonly entries: LedgerEntry[] = []

  add<T>(entry: LedgerEntry<T>): void {
    this.entries.push(entry as LedgerEntry)
  }

  get size(): number {
    return this.entries.length
  }

  snapshot(): LedgerEntry[] {
    return [...this.entries]
  }

  reversed(): LedgerEntry[] {
    return [...this.entries].reverse()
  }

  clear(): void {
    this.entries.length = 0
  }
}
