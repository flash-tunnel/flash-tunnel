import type { FlashTunnelConfig } from '@flash-tunnel/config'
import type {
  AdapterContext,
  AdapterLogger,
  DnsAdapter,
  DnsRecordRef,
  TunnelAdapter,
  TunnelHandle,
  TunnelMode
} from '@flash-tunnel/types'
import type { ServerHandle } from '../server/types'
import type { SessionState } from '../state/store'
import { basename } from 'node:path'
import process from 'node:process'
import { randomId, slugify } from '@flash-tunnel/utils'
import { detectServer } from '../server/detect'
import { startServer } from '../server/run'
import {
  acquireProjectLock,
  releaseProjectLock,
  removeSessionState,
  writeSessionState
} from '../state/store'
import { verifyPublicUrl } from '../tunnel/verify'
import { createSessionId } from './id'

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
  autoStopAfterMs?: number
  configSource?: string
}

export interface PreviewSession {
  sessionId: string
  localUrl: string
  publicUrl: string
  hostname?: string
  server: ServerHandle
  tunnel: TunnelHandle
  dns?: DnsRecordRef
  exited: Promise<void>
  autoStopped?: Promise<void>
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

export async function startPreviewSession(options: StartPreviewSessionOptions): Promise<PreviewSession> {
  const { cwd, config, adapters } = options
  const mode: TunnelMode = options.mode ?? config.tunnel?.mode ?? 'quick'
  const persist = options.persist ?? true

  if (!adapters.tunnel.capabilities.modes.includes(mode)) {
    throw new Error(`Tunnel adapter "${adapters.tunnel.id}" does not support mode "${mode}"`)
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
  }

  const plan = detectServer(cwd, config.server)
  const server = await startServer(plan, {
    timeoutMs: config.server?.timeout,
    signal: options.signal,
    onLog: options.onLog
  })

  const ctx: AdapterContext = {
    sessionId,
    cwd,
    logger: createLogger(options.onLog),
    signal: options.signal ?? new AbortController().signal,
    now: Date.now
  }

  const tunnelName = config.tunnel?.name ?? `flash-tunnel-${slugify(basename(cwd))}-${randomId(4)}`
  let handle: TunnelHandle | undefined
  let dnsRef: DnsRecordRef | undefined
  let tunnelStarted = false
  let stopPromise: Promise<void> | undefined
  let heartbeatTimer: NodeJS.Timeout | undefined
  let autoStopTimer: NodeJS.Timeout | undefined
  let resolveTunnelExit: () => void = () => {}
  let resolveAutoStopped: () => void = () => {}
  const tunnelExited = new Promise<void>((resolve) => {
    resolveTunnelExit = resolve
  })

  const cleanup = async (): Promise<CleanupFailure[]> => {
    const failures: CleanupFailure[] = []

    if (handle) {
      if (tunnelStarted) {
        try {
          await adapters.tunnel.stop(ctx, handle)
        }
        catch (error) {
          failures.push({ step: 'tunnel.stop', error: errorMessage(error) })
        }
        tunnelStarted = false
      }

      if (!options.keep && dnsRef && adapters.dns) {
        try {
          await adapters.dns.remove(ctx, dnsRef)
          dnsRef = undefined
        }
        catch (error) {
          failures.push({ step: 'dns.remove', error: errorMessage(error) })
        }
      }

      if (!options.keep) {
        try {
          await adapters.tunnel.deprovision(ctx, handle)
          handle = undefined
        }
        catch (error) {
          failures.push({ step: 'tunnel.deprovision', error: errorMessage(error) })
        }
      }
    }

    try {
      await server.stop()
    }
    catch (error) {
      failures.push({ step: 'server.stop', error: errorMessage(error) })
    }

    return failures
  }

  const stop = async (): Promise<void> => {
    if (stopPromise) {
      return stopPromise
    }

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
        await writeSessionState(state).catch(() => {})
      }

      const failures = await cleanup()

      if (persist && state) {
        if (failures.length > 0) {
          state.cleanup.required = true
          state.cleanup.attempts += 1
          state.cleanup.inProgress = false
          state.state = 'failed'
          await writeSessionState(state).catch(() => {})
        }
        else if (options.keep) {
          state.cleanup.kept = true
          state.cleanup.inProgress = false
          state.state = 'kept'
          await writeSessionState(state).catch(() => {})
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
    await adapters.tunnel.preflight(ctx, { mode })
    handle = await adapters.tunnel.provision(ctx, {
      name: tunnelName,
      localUrl: server.url,
      hostname: options.hostname
    })

    if (state) {
      state.server = {
        url: server.url,
        command: plan.command,
        cwd: plan.cwd,
        startedByUs: server.startedByUs
      }
      state.tunnel = {
        provider: handle.provider,
        tunnelId: handle.tunnelId,
        name: handle.name,
        publicUrl: handle.publicUrl,
        mode,
        accountId: handle.meta?.accountId
      }
      state.state = 'tunnel-provisioned'
      await writeSessionState(state)
    }

    if (handle.dns) {
      if (!adapters.dns) {
        throw new Error('The tunnel requires a DNS record but no DNS adapter is configured')
      }
      if (!options.hostname || !options.zone) {
        throw new Error('A hostname and zone are required for the DNS record')
      }

      await adapters.dns.preflight(ctx, {
        zone: options.zone,
        name: options.hostname,
        type: handle.dns.type
      })
      dnsRef = await adapters.dns.ensure(ctx, {
        zone: options.zone,
        name: options.hostname,
        type: handle.dns.type,
        content: handle.dns.target,
        proxied: handle.dns.proxied,
        ttl: 1,
        comment: `flash-tunnel:${sessionId}`
      })

      if (state) {
        state.dns = {
          provider: dnsRef.provider,
          zoneId: dnsRef.zoneId,
          recordId: dnsRef.recordId,
          hostname: dnsRef.name
        }
        state.state = 'dns-created'
        await writeSessionState(state)
      }
    }

    await adapters.tunnel.start(ctx, handle, {
      onLog: (line, stream) => options.onLog?.(line, stream),
      onExit: (info) => {
        options.onLog?.(`cloudflared exited (code ${info.code ?? 'null'})`, 'stderr')
        resolveTunnelExit()
      }
    })
    tunnelStarted = true

    const status = await adapters.tunnel.waitReady(ctx, handle, 30_000)
    const publicUrl = status.publicUrl ?? handle.publicUrl

    if (!publicUrl) {
      throw new Error('Tunnel did not provide a public URL')
    }

    await verifyPublicUrl(publicUrl, {
      timeoutMs: options.verifyTimeoutMs ?? 60_000,
      signal: options.signal
    })

    if (state) {
      state.state = 'running'
      if (state.tunnel) {
        state.tunnel.publicUrl = publicUrl
      }
      await writeSessionState(state)

      heartbeatTimer = setInterval(() => {
        if (!state) {
          return
        }
        state.heartbeatAt = new Date().toISOString()
        void writeSessionState(state).catch(() => {})
      }, 15_000)
      heartbeatTimer.unref()
    }

    let autoStopped: Promise<void> | undefined
    if (options.autoStopAfterMs && options.autoStopAfterMs > 0) {
      autoStopped = new Promise<void>((resolve) => {
        resolveAutoStopped = resolve
      })
      autoStopTimer = setTimeout(() => {
        stop()
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
      exited: tunnelExited,
      autoStopped,
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

    const failures = await cleanup()
    if (persist && state) {
      if (failures.length > 0) {
        state.cleanup.required = true
        state.state = 'failed'
        await writeSessionState(state).catch(() => {})
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
