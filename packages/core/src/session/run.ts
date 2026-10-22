import type { FlashTunnelConfig } from '@flash-tunnel/config'
import type {
  AdapterContext,
  AdapterLogger,
  DnsAdapter,
  DnsRecordRef,
  FlashTunnelEvents,
  TunnelAdapter,
  TunnelHandle,
  TunnelMode
} from '@flash-tunnel/types'
import type { ServerHandle } from '../server/types'
import type { SessionPhase, SessionState } from '../state/store'
import type { LedgerKind } from './ledger'
import { basename } from 'node:path'
import process from 'node:process'
import { AdapterError } from '@flash-tunnel/types'
import { randomId, sleep, slugify } from '@flash-tunnel/utils'
import { FlashTunnelError } from '../errors'
import { Emitter } from '../events'
import { createSessionLog, pruneSessionLogs } from '../logs'
import { VITE_ALLOWED_HOSTS_ENV, viteAllowedHostsEnv } from '../server/allowed-hosts'
import { detectServer } from '../server/detect'
import { startServer } from '../server/run'
import {
  acquireProjectLock,
  releaseProjectLock,
  removeSessionState,
  writeSessionState
} from '../state/store'
import { PublicHostBlockedError, verifyPublicUrl } from '../tunnel/verify'
import { CORE_API_VERSION, createSessionId } from './id'
import { ResourceLedger } from './ledger'

const CLEANUP_TIMEOUTS = {
  tunnelStop: 8_000,
  tunnelDrain: 10_000,
  dnsRemove: 10_000,
  tunnelDeprovision: 10_000,
  serverStop: 8_000
} as const

const CLEANUP_BUDGET_MS = 30_000

const CLEANUP_STEPS: Record<LedgerKind, { name: string, timeoutMs: number, attempts: number }> = {
  'tunnel-process': { name: 'tunnel.stop', timeoutMs: CLEANUP_TIMEOUTS.tunnelStop, attempts: 1 },
  'dns': { name: 'dns.remove', timeoutMs: CLEANUP_TIMEOUTS.dnsRemove, attempts: 3 },
  'tunnel': { name: 'tunnel.deprovision', timeoutMs: CLEANUP_TIMEOUTS.tunnelDeprovision, attempts: 3 },
  'server': { name: 'server.stop', timeoutMs: CLEANUP_TIMEOUTS.serverStop, attempts: 1 }
}

const ALLOWED_TRANSITIONS: Record<SessionPhase, readonly SessionPhase[]> = {
  'starting': ['server-ready'],
  'server-ready': ['provisioning-tunnel'],
  'provisioning-tunnel': ['tunnel-provisioned'],
  'tunnel-provisioned': ['dns-created', 'running'],
  'dns-created': ['running'],
  'running': [],
  'tearing-down': [],
  'kept': [],
  'failed': []
}

export interface PreviewAdapters {
  tunnel: TunnelAdapter
  dns?: DnsAdapter
}

export interface StartPreviewSessionOptions {
  cwd: string
  config: FlashTunnelConfig
  adapters: PreviewAdapters
  mode?: TunnelMode
  hostname?: string
  zone?: string
  signal?: AbortSignal
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void
  verifyTimeoutMs?: number
  persist?: boolean
  keep?: boolean
  overwrite?: boolean
  autoStopAfterMs?: number
  configSource?: string
  /** Test hook: shrink the total cleanup budget. */
  cleanupBudgetMs?: number
  /** Optional observer created by the caller so early events are not missed. */
  events?: Emitter<FlashTunnelEvents>
}

export interface PreviewSession {
  sessionId: string
  localUrl: string
  publicUrl: string
  hostname?: string
  server: ServerHandle
  tunnel: TunnelHandle
  dns?: DnsRecordRef
  expiresAt?: string
  exited: Promise<void>
  autoStopped?: Promise<void>
  events: Emitter<FlashTunnelEvents>
  /** True as soon as intentional teardown starts. */
  readonly stopping: boolean
  stop: () => Promise<void>
}

export interface CleanupFailure {
  step: string
  error: string
}

export class CleanupError extends Error {
  readonly failures: CleanupFailure[]

  constructor(failures: CleanupFailure[]) {
    super(`Cleanup failed: ${failures.map(failure => `${failure.step} (${failure.error})`).join(', ')}`)
    this.name = 'CleanupError'
    this.failures = failures
  }
}

function createLogger(onLog?: StartPreviewSessionOptions['onLog']): AdapterLogger {
  const write = (level: string, message: string): void => {
    onLog?.(`[${level}] ${message}`, 'stderr')
  }

  return {
    debug: (message: string) => write('debug', message),
    info: (message: string) => write('info', message),
    warn: (message: string) => write('warn', message),
    error: (message: string) => write('error', message)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()
  })

  // Observe the losing promise so a late rejection never becomes unhandled.
  work.catch(() => {})

  return Promise.race([work, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

async function retry<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      return await operation()
    }
    catch (error) {
      lastError = error
      if (!(error instanceof AdapterError) || !error.retriable) {
        throw error
      }
    }
  }

  throw lastError
}

export async function startPreviewSession(options: StartPreviewSessionOptions): Promise<PreviewSession> {
  const { cwd, config, adapters } = options
  const mode: TunnelMode = options.mode ?? config.tunnel?.mode ?? 'quick'
  const persist = options.persist ?? true
  const events = options.events ?? new Emitter<FlashTunnelEvents>()

  if (!adapters.tunnel.capabilities.modes.includes(mode)) {
    throw new FlashTunnelError(`Tunnel adapter "${adapters.tunnel.id}" does not support mode "${mode}"`, {
      code: 'TUNNEL_MODE_UNSUPPORTED',
      exitCode: 5
    })
  }

  const sessionId = createSessionId()
  let state: SessionState | undefined
  let lockAcquired = false

  if (persist) {
    await acquireProjectLock(cwd, sessionId)
    lockAcquired = true

    const now = new Date().toISOString()
    state = {
      version: 1,
      sessionId,
      pid: process.pid,
      projectRoot: cwd,
      startedAt: now,
      heartbeatAt: now,
      state: 'starting',
      configSource: options.configSource,
      server: { cwd, startedByUs: false },
      cleanup: { required: false, attempts: 0, inProgress: false, kept: false }
    }
    await writeSessionState(state)
    events.emit('state', { from: 'idle', to: 'starting' })
  }

  const saveState = async (): Promise<void> => {
    if (state) {
      await writeSessionState(state).catch(() => {})
    }
  }

  const stepStarts = new Map<string, number>()
  let activeStep: string | undefined

  const emitStep = (id: string, status: 'fail' | 'ok' | 'start', detail?: string): void => {
    const now = Date.now()
    if (status === 'start') {
      stepStarts.set(id, now)
      activeStep = id
    }
    const startedAt = stepStarts.get(id)
    events.emit('step', {
      id,
      status,
      detail,
      durationMs: status === 'start' ? undefined : now - (startedAt ?? now)
    })
    if (status !== 'start' && activeStep === id) {
      activeStep = undefined
    }
  }

  const transition = async (to: SessionPhase): Promise<void> => {
    if (!state) {
      return
    }

    const from = state.state
    if (from !== to && !ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new FlashTunnelError(`Illegal session state transition: ${from} -> ${to}`, {
        code: 'STATE_TRANSITION_INVALID',
        exitCode: 1
      })
    }

    state.state = to
    if (from !== to) {
      events.emit('state', { from, to })
    }
    await saveState()
  }

  const serverLog = persist
    ? await createSessionLog(cwd, sessionId, 'server').catch(() => undefined)
    : undefined
  const tunnelLog = persist
    ? await createSessionLog(cwd, sessionId, 'tunnel').catch(() => undefined)
    : undefined
  if (persist) {
    void pruneSessionLogs(cwd, 10).catch(() => {})
  }

  const serverStartedAt = Date.now()
  const plan = detectServer(cwd, config.server)
  emitStep('server', 'start')
  let server: ServerHandle
  try {
    server = await startServer(plan, {
      timeoutMs: config.server?.timeout,
      signal: options.signal,
      // Let Vite accept the tunnel hostname without touching vite.config.
      env: viteAllowedHostsEnv(mode, options.hostname),
      onLog: (line, stream) => {
        options.onLog?.(line, stream)
        serverLog?.write(line)
      }
    })
  }
  catch (error) {
    emitStep('server', 'fail', errorMessage(error))
    await releaseProjectLock(cwd, sessionId).catch(() => {})
    if (state) {
      await removeSessionState(state).catch(() => {})
    }
    throw new FlashTunnelError(
      `Failed to start the local server: ${errorMessage(error)}`,
      { code: 'SERVER_START_FAILED', exitCode: 3, cause: error }
    )
  }
  emitStep('server', 'ok', server.url)

  events.emit('server:detected', {
    command: plan.command ?? plan.mode,
    cwd: plan.cwd,
    confidence: plan.confidence,
    reason: plan.reason
  })

  if (state) {
    state.server = {
      url: server.url,
      command: plan.command,
      cwd: plan.cwd,
      pid: server.pid,
      startedByUs: server.startedByUs
    }
    await transition('server-ready')
  }

  events.emit('server:ready', {
    url: server.url,
    port: server.port,
    startedByUs: server.startedByUs,
    durationMs: Date.now() - serverStartedAt
  })

  const ctx: AdapterContext = {
    sessionId,
    cwd,
    logger: createLogger(options.onLog),
    signal: options.signal ?? new AbortController().signal,
    now: Date.now
  }

  const ledger = new ResourceLedger()
  const origin = {
    sessionId,
    createdAt: Date.now(),
    version: CORE_API_VERSION.toString()
  }
  ledger.add({
    kind: 'server',
    provider: 'local',
    ref: { url: server.url, pid: server.pid },
    origin,
    owned: true,
    dispose: () => server.stop()
  })

  const tunnelName = config.tunnel?.name ?? `flash-tunnel-${slugify(basename(cwd))}-${randomId(4)}`
  let handle: TunnelHandle | undefined
  let dnsRef: DnsRecordRef | undefined
  let stopPromise: Promise<void> | undefined
  let stopping = false
  let heartbeatTimer: NodeJS.Timeout | undefined
  let autoStopTimer: NodeJS.Timeout | undefined
  let resolveTunnelExit: () => void = () => {}
  let resolveAutoStopped: () => void = () => {}
  const tunnelExited = new Promise<void>((resolve) => {
    resolveTunnelExit = resolve
  })

  const cleanup = async (): Promise<{ failures: CleanupFailure[], removed: string[] }> => {
    const failures: CleanupFailure[] = []
    const removed: string[] = []
    const budgetMs = options.cleanupBudgetMs ?? CLEANUP_BUDGET_MS
    const deadline = Date.now() + budgetMs

    const step = async (
      kind: string,
      timeoutMs: number,
      task: () => Promise<void>,
      attempts = 1
    ): Promise<boolean> => {
      events.emit('cleanup:step', { kind, status: 'start' })
      const remaining = deadline - Date.now()

      if (remaining <= 0) {
        const message = 'cleanup time budget exhausted'
        failures.push({ step: kind, error: message })
        events.emit('cleanup:step', { kind, status: 'error', detail: message })
        return false
      }

      try {
        await withTimeout(
          retry(task, attempts),
          Math.min(timeoutMs, remaining),
          kind
        )
        removed.push(kind)
        events.emit('cleanup:step', { kind, status: 'ok' })
        return true
      }
      catch (error) {
        const message = errorMessage(error)
        failures.push({ step: kind, error: message })
        events.emit('cleanup:step', { kind, status: 'error', detail: message })
        return false
      }
    }

    const drainTunnel = async (): Promise<void> => {
      if (!handle) {
        return
      }
      const current = handle
      const statusFn = adapters.tunnel.status
      if (!statusFn) {
        events.emit('cleanup:step', { kind: 'tunnel.drain', status: 'skip', detail: 'adapter has no status()' })
        return
      }

      events.emit('cleanup:step', { kind: 'tunnel.drain', status: 'start' })
      try {
        const startedAt = Date.now()
        while (Date.now() - startedAt < CLEANUP_TIMEOUTS.tunnelDrain) {
          const status = await statusFn(ctx, current)
          if (status.connections === 0) {
            break
          }
          await sleep(300)
        }
        events.emit('cleanup:step', { kind: 'tunnel.drain', status: 'ok' })
      }
      catch (error) {
        // Draining is best-effort; deprovision retries force-clean connections.
        events.emit('cleanup:step', { kind: 'tunnel.drain', status: 'skip', detail: errorMessage(error) })
      }
    }

    for (const entry of ledger.reversed()) {
      const config = CLEANUP_STEPS[entry.kind]

      if (!entry.owned) {
        events.emit('cleanup:step', { kind: config.name, status: 'skip', detail: '--keep' })
        continue
      }

      await step(config.name, config.timeoutMs, entry.dispose, config.attempts)
      if (entry.kind === 'tunnel-process') {
        await drainTunnel()
      }
    }

    ledger.clear()

    return { failures, removed }
  }

  const stop = async (): Promise<void> => {
    if (stopPromise) {
      return stopPromise
    }

    stopping = true
    stopPromise = (async () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = undefined
      }
      if (autoStopTimer) {
        clearTimeout(autoStopTimer)
        autoStopTimer = undefined
      }

      if (state) {
        state.state = 'tearing-down'
        state.cleanup.inProgress = true
        await saveState()
        events.emit('state', { from: 'running', to: 'tearing-down' })
      }

      const { failures, removed } = await cleanup()
      await serverLog?.close()
      await tunnelLog?.close()

      events.emit('cleanup:done', {
        ok: failures.length === 0,
        removed: options.keep
          ? removed.filter(kind => kind !== 'dns.remove' && kind !== 'tunnel.deprovision')
          : removed,
        failed: failures.map(failure => ({ kind: failure.step, error: failure.error }))
      })

      if (persist && state) {
        if (failures.length > 0) {
          state.cleanup.required = true
          state.cleanup.attempts += 1
          state.cleanup.inProgress = false
          state.state = 'failed'
          await saveState()
        }
        else if (options.keep) {
          state.cleanup.kept = true
          state.cleanup.inProgress = false
          state.state = 'kept'
          await saveState()
        }
        else {
          await removeSessionState(state).catch(() => {})
        }
      }

      if (lockAcquired) {
        await releaseProjectLock(cwd, sessionId).catch(() => {})
        lockAcquired = false
      }

      if (failures.length > 0) {
        throw new CleanupError(failures)
      }
    })()

    return stopPromise
  }

  try {
    await transition('provisioning-tunnel')
    emitStep('tunnel', 'start')
    await adapters.tunnel.preflight(ctx, { mode })
    handle = await adapters.tunnel.provision(ctx, {
      name: tunnelName,
      localUrl: server.url,
      hostname: options.hostname
    })
    emitStep('tunnel', 'ok', handle.name)

    const provisionedHandle = handle
    ledger.add({
      kind: 'tunnel',
      provider: provisionedHandle.provider,
      ref: { tunnelId: provisionedHandle.tunnelId },
      origin,
      owned: !options.keep,
      dispose: () => adapters.tunnel.deprovision(ctx, provisionedHandle)
    })

    if (state) {
      state.tunnel = {
        provider: handle.provider,
        tunnelId: handle.tunnelId,
        name: handle.name,
        publicUrl: handle.publicUrl,
        mode,
        accountId: handle.meta?.accountId,
        configured: true
      }
      await transition('tunnel-provisioned')
    }

    events.emit('tunnel:provisioned', { tunnelId: handle.tunnelId, name: handle.name })

    if (handle.dns) {
      if (!adapters.dns) {
        throw new Error('The tunnel requires a DNS record but no DNS adapter is configured')
      }
      if (!options.hostname || !options.zone) {
        throw new Error('A hostname and zone are required for the DNS record')
      }

      emitStep('dns', 'start')
      await adapters.dns.preflight(ctx, {
        zone: options.zone,
        name: options.hostname,
        type: handle.dns.type,
        overwrite: options.overwrite
      })
      dnsRef = await adapters.dns.ensure(ctx, {
        zone: options.zone,
        name: options.hostname,
        type: handle.dns.type,
        content: handle.dns.target,
        proxied: handle.dns.proxied,
        ttl: 1,
        comment: `flash-tunnel:${sessionId}`,
        overwrite: options.overwrite
      })
      emitStep('dns', 'ok', dnsRef.name)

      const createdDns = dnsRef
      ledger.add({
        kind: 'dns',
        provider: createdDns.provider,
        ref: createdDns,
        origin,
        owned: !options.keep,
        dispose: () => adapters.dns!.remove(ctx, createdDns)
      })

      if (state) {
        state.dns = {
          provider: dnsRef.provider,
          zoneId: dnsRef.zoneId,
          recordId: dnsRef.recordId,
          hostname: dnsRef.name,
          comment: `flash-tunnel:${sessionId}`
        }
        await transition('dns-created')
      }

      events.emit('dns:created', {
        hostname: dnsRef.name,
        recordId: dnsRef.recordId,
        zoneId: dnsRef.zoneId
      })
    }

    await adapters.tunnel.start(ctx, handle, {
      onLog: (line, stream) => {
        options.onLog?.(line, stream)
        tunnelLog?.write(line)
      },
      onExit: (info) => {
        options.onLog?.(`cloudflared exited (code ${info.code ?? 'null'})`, 'stderr')
        resolveTunnelExit()
      }
    })
    const startedHandle = handle
    const tunnelPid = Number(handle.meta?.processPid)
    ledger.add({
      kind: 'tunnel-process',
      provider: startedHandle.provider,
      ref: { pid: Number.isInteger(tunnelPid) ? tunnelPid : undefined },
      origin,
      owned: true,
      dispose: () => adapters.tunnel.stop(ctx, startedHandle)
    })

    if (state) {
      if (Number.isInteger(tunnelPid) && tunnelPid > 0) {
        state.processes = [{ kind: 'cloudflared', pid: tunnelPid }]
        await saveState()
      }
    }

    const verifyStartedAt = Date.now()
    emitStep('verify', 'start')
    const status = await adapters.tunnel.waitReady(ctx, handle, 30_000)
    events.emit('tunnel:connected', { connections: status.connections })
    const publicUrl = status.publicUrl ?? handle.publicUrl

    if (!publicUrl) {
      throw new Error('Tunnel did not provide a public URL')
    }

    let verified
    try {
      verified = await verifyPublicUrl(publicUrl, {
        timeoutMs: options.verifyTimeoutMs ?? 60_000,
        signal: options.signal,
        diagnoseDns: true
      })
    }
    catch (error) {
      if (error instanceof PublicHostBlockedError) {
        const hint = server.startedByUs
          ? `flash-tunnel passes ${VITE_ALLOWED_HOSTS_ENV} to the dev server automatically, which requires Vite 6.1 or newer. On older Vite add "${error.host}" to server.allowedHosts in vite.config.`
          : `The dev server was not started by flash-tunnel, so the tunnel hostname could not be injected. Add "${error.host}" to server.allowedHosts in vite.config, or let flash-tunnel start the dev server.`

        throw new FlashTunnelError(error.message, {
          code: 'PUBLIC_HOST_BLOCKED',
          exitCode: 7,
          hint,
          cause: error
        })
      }

      throw new FlashTunnelError(
        `The public URL did not answer: ${errorMessage(error)}`,
        { code: 'PUBLIC_VERIFY_FAILED', exitCode: 7, hint: 'Check cloudflared connectivity and try again', cause: error }
      )
    }
    emitStep('verify', 'ok', `HTTP ${verified.status}`)
    events.emit('public:ready', { url: publicUrl, verifyMs: Date.now() - verifyStartedAt })

    if (state) {
      if (state.tunnel) {
        state.tunnel.publicUrl = publicUrl
      }
      if (options.autoStopAfterMs && options.autoStopAfterMs > 0) {
        state.expiresAt = new Date(Date.now() + options.autoStopAfterMs).toISOString()
      }
      await transition('running')

      heartbeatTimer = setInterval(() => {
        if (!state) {
          return
        }
        state.heartbeatAt = new Date().toISOString()
        void saveState()
      }, 15_000)
      heartbeatTimer.unref()
    }

    let autoStopped: Promise<void> | undefined
    if (options.autoStopAfterMs && options.autoStopAfterMs > 0) {
      autoStopped = new Promise<void>((resolve) => {
        resolveAutoStopped = resolve
      })
      autoStopTimer = setTimeout(() => {
        events.emit('autostop:expired', { expiresAt: Date.parse(state?.expiresAt ?? '') || Date.now() })
        void stop()
          .catch(() => {})
          .finally(() => resolveAutoStopped())
      }, options.autoStopAfterMs)
      autoStopTimer.unref()
    }

    return {
      sessionId,
      localUrl: server.url,
      publicUrl,
      hostname: options.hostname,
      server,
      tunnel: handle,
      dns: dnsRef,
      expiresAt: state?.expiresAt,
      exited: tunnelExited,
      autoStopped,
      events,
      get stopping(): boolean {
        return stopping
      },
      stop
    }
  }
  catch (error) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
    }
    if (autoStopTimer) {
      clearTimeout(autoStopTimer)
    }

    if (activeStep) {
      emitStep(activeStep, 'fail', errorMessage(error))
    }

    stopping = true
    const { failures } = await cleanup()
    await serverLog?.close()
    await tunnelLog?.close()

    events.emit('cleanup:done', {
      ok: failures.length === 0,
      removed: [],
      failed: failures.map(failure => ({ kind: failure.step, error: failure.error }))
    })

    if (persist && state) {
      if (failures.length > 0) {
        state.cleanup.required = true
        state.cleanup.attempts += 1
        state.state = 'failed'
        await saveState()
      }
      else {
        await removeSessionState(state).catch(() => {})
      }
      if (lockAcquired) {
        await releaseProjectLock(cwd, sessionId).catch(() => {})
        lockAcquired = false
      }
    }

    throw error
  }
}
