import type { SessionState } from './state/store'
import { isProcessAlive, isSessionStale, listSessionStates, removeSessionState } from './state/store'

export interface SessionCleaner {
  removeDns?: (state: SessionState) => Promise<void>
  removeTunnel?: (state: SessionState) => Promise<void>
}

export interface CleanSessionsOptions {
  sessionId?: string
  projectRoot?: string
  staleOnly?: boolean
  all?: boolean
  force?: boolean
  dryRun?: boolean
  cleaner?: SessionCleaner
  now?: number
}

export interface CleanSessionResult {
  sessionId: string
  projectRoot: string
  status: 'failed' | 'removed' | 'skipped' | 'would-remove'
  reasons: string[]
  actions: string[]
}

function matches(state: SessionState, options: CleanSessionsOptions, now: number): boolean {
  if (options.sessionId && state.sessionId !== options.sessionId) {
    return false
  }
  if (options.projectRoot && state.projectRoot !== options.projectRoot) {
    return false
  }
  if (options.staleOnly && !isSessionStale(state, now)) {
    return false
  }
  return true
}

export async function cleanSessions(options: CleanSessionsOptions = {}): Promise<CleanSessionResult[]> {
  const now = options.now ?? Date.now()
  const states = (await listSessionStates()).filter(state => matches(state, options, now))

  const results: CleanSessionResult[] = []

  for (const state of states) {
    const result: CleanSessionResult = {
      sessionId: state.sessionId,
      projectRoot: state.projectRoot,
      status: 'skipped',
      reasons: [],
      actions: []
    }

    if (isProcessAlive(state.pid) && !options.force) {
      result.reasons.push('session process is still running')
      results.push(result)
      continue
    }

    const actions: string[] = []
    if (state.dns) {
      actions.push(`delete dns record ${state.dns.recordId} (${state.dns.hostname})`)
    }
    if (state.tunnel && state.tunnel.mode === 'named') {
      actions.push(`delete tunnel ${state.tunnel.tunnelId} (${state.tunnel.name})`)
    }

    if (options.dryRun) {
      result.status = 'would-remove'
      result.actions = actions
      results.push(result)
      continue
    }

    try {
      if (state.dns) {
        if (!options.cleaner?.removeDns) {
          throw new Error('No DNS cleaner configured')
        }
        await options.cleaner.removeDns(state)
      }

      if (state.tunnel && state.tunnel.mode === 'named') {
        if (!options.cleaner?.removeTunnel) {
          throw new Error('No tunnel cleaner configured')
        }
        await options.cleaner.removeTunnel(state)
      }

      await removeSessionState(state)
      result.status = 'removed'
      result.actions = actions
    }
    catch (error) {
      result.status = 'failed'
      result.reasons.push(error instanceof Error ? error.message : String(error))
    }

    results.push(result)
  }

  return results
}
