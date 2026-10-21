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
import { basename } from 'node:path'
import { randomId, slugify } from '@flash-tunnel/utils'
import { detectServer } from '../server/detect'
import { startServer } from '../server/run'
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
  stop: () => Promise<void>
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

export async function startPreviewSession(options: StartPreviewSessionOptions): Promise<PreviewSession> {
  const { cwd, config, adapters } = options
  const mode: TunnelMode = options.mode ?? config.tunnel?.mode ?? 'quick'

  if (!adapters.tunnel.capabilities.modes.includes(mode)) {
    throw new Error(`Tunnel adapter "${adapters.tunnel.id}" does not support mode "${mode}"`)
  }

  const sessionId = createSessionId()
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
  let resolveTunnelExit: () => void = () => {}
  const tunnelExited = new Promise<void>((resolve) => {
    resolveTunnelExit = resolve
  })

  const cleanup = async (): Promise<void> => {
    if (handle) {
      if (tunnelStarted) {
        await adapters.tunnel.stop(ctx, handle).catch(() => {})
        tunnelStarted = false
      }
      if (dnsRef && adapters.dns) {
        await adapters.dns.remove(ctx, dnsRef).catch(() => {})
        dnsRef = undefined
      }
      await adapters.tunnel.deprovision(ctx, handle).catch(() => {})
      handle = undefined
    }
  }

  try {
    await adapters.tunnel.preflight(ctx, { mode })
    handle = await adapters.tunnel.provision(ctx, {
      name: tunnelName,
      localUrl: server.url,
      hostname: options.hostname
    })

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

    let stopped = false
    return {
      sessionId,
      localUrl: server.url,
      publicUrl,
      hostname: options.hostname,
      server,
      tunnel: handle,
      dns: dnsRef,
      exited: tunnelExited,
      stop: async () => {
        if (stopped) {
          return
        }
        stopped = true
        await cleanup()
        await server.stop()
      }
    }
  }
  catch (error) {
    await cleanup()
    await server.stop().catch(() => {})
    throw error
  }
}
