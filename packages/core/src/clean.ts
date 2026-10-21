import type { SessionState } from './state/store'
import { isProcessAlive, killProcessTree } from './process'
import {
  appendReapLog,
  isSessionStale,
  listSessionStates,
  readGlobalSessionState,
  removeSessionState,
  writeSessionState
} from './state/store'

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
  /** Kill processes recorded in the state file. Defaults to true. */
  killProcesses?: boolean
}

export type CleanSessionStatus = 'failed' | 'not-found' | 'removed' | 'skipped' | 'would-remove'

export interface CleanSessionResult {
  sessionId: string
  projectRoot: string
  status: CleanSessionStatus
  reasons: string[]
  actions: string[]
}

interface ProcessRef {
  kind: 'cloudflared' | 'server'
  pid: number
}

function recordedProcesses(state: SessionState): ProcessRef[] {
  const processes: ProcessRef[] = []
  const seen = new Set<number>()

  for (const process of state.processes ?? []) {
    if (!seen.has(process.pid)) {
      seen.add(process.pid)
      processes.push(process)
    }
  }

  if (state.server.pid && !seen.has(state.server.pid)) {
    processes.push({ kind: 'server', pid: state.server.pid })
  }

  return processes
}

function planActions(state: SessionState): string[] {
  const actions: string[] = []

  for (const process of recordedProcesses(state).filter(item => item.kind === 'cloudflared')) {
    actions.push(`stop process ${process.pid} (cloudflared)`)
  }
  if (state.dns) {
    actions.push(`delete dns record ${state.dns.recordId} (${state.dns.hostname})`)
  }
  if (state.tunnel && state.tunnel.mode === 'named') {
    actions.push(`delete tunnel ${state.tunnel.tunnelId} (${state.tunnel.name})`)
  }
  for (const process of recordedProcesses(state).filter(item => item.kind === 'server')) {
    actions.push(`stop process ${process.pid} (server)`)
  }

  return actions
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/**
 * Dispose one session. Ownership is checked by the caller through the state
 * file; remote deletes only ever use the recorded ids.
 */
export async function cleanSession(
  state: SessionState,
  options: CleanSessionsOptions = {}
): Promise<CleanSessionResult> {
  const result: CleanSessionResult = {
    sessionId: state.sessionId,
    projectRoot: state.projectRoot,
    status: 'skipped',
    reasons: [],
    actions: planActions(state)
  }

  if (isProcessAlive(state.pid) && !options.force) {
    result.reasons.push('session process is still running')
    return result
  }

  if (options.dryRun) {
    result.status = 'would-remove'
    return result
  }

  const processes = recordedProcesses(state)
  const canKill = options.killProcesses ?? true

  try {
    await appendReapLog(state.sessionId, `clean start (${processes.length} processes)`)

    for (const process of processes.filter(item => item.kind === 'cloudflared')) {
      if (canKill) {
        await killProcessTree(process.pid)
      }
      if (canKill && isProcessAlive(process.pid)) {
        throw new Error(`cloudflared process ${process.pid} is still running`)
      }
    }

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

    for (const process of processes.filter(item => item.kind === 'server')) {
      if (canKill) {
        await killProcessTree(process.pid)
      }
      if (canKill && isProcessAlive(process.pid)) {
        throw new Error(`server process ${process.pid} is still running`)
      }
    }

    await removeSessionState(state)
    result.status = 'removed'
    await appendReapLog(state.sessionId, 'clean ok')
  }
  catch (error) {
    const message = errorMessage(error)
    result.status = 'failed'
    result.reasons.push(message)
    state.cleanup.required = true
    state.cleanup.attempts += 1
    state.cleanup.inProgress = false
    state.state = 'failed'
    await writeSessionState(state).catch(() => {})
    await appendReapLog(state.sessionId, `clean failed: ${message}`)
  }

  return result
}

export async function cleanSessions(options: CleanSessionsOptions = {}): Promise<CleanSessionResult[]> {
  const now = options.now ?? Date.now()
  const states = (await listSessionStates()).filter(state => matches(state, options, now))

  const results: CleanSessionResult[] = []
  for (const state of states) {
    results.push(await cleanSession(state, options))
  }
  return results
}

/** Reaper entry used by `flash-tunnel __reap --session <id>`. */
export async function reapSession(
  sessionId: string,
  options: Omit<CleanSessionsOptions, 'sessionId'> = {}
): Promise<CleanSessionResult> {
  const state = await readGlobalSessionState(sessionId)
  if (!state) {
    return {
      sessionId,
      projectRoot: '',
      status: 'not-found',
      reasons: [],
      actions: []
    }
  }

  return cleanSession(state, options)
}
