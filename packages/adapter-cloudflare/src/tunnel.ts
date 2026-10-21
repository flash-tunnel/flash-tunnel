import type {
  AdapterContext,
  TunnelAdapter,
  TunnelHandle,
  TunnelHooks,
  TunnelMode,
  TunnelProvisionSpec,
  TunnelStatus
} from '@flash-tunnel/types'
import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import type { CloudflareTunnel as CloudflareTunnelResource } from './api'
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { AdapterError } from '@flash-tunnel/types'
import { sleep, stripAnsi } from '@flash-tunnel/utils'
import { CloudflareApi } from './api'

const ADAPTER_ID = 'cloudflare'
const QUICK_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

export interface CloudflareTunnelOptions {
  cloudflaredPath?: string
  accountId?: string
  apiToken?: string
  apiBase?: string
  originRequest?: {
    httpHostHeader?: string
    noTLSVerify?: boolean
  }
  fetcher?: typeof fetch
}

interface ActiveTunnel {
  handle: TunnelHandle
  accountId?: string
  mode: TunnelMode
  resource?: CloudflareTunnelResource
}

export function createCloudflareTunnel(options: CloudflareTunnelOptions = {}): TunnelAdapter {
  const cloudflaredPath = options.cloudflaredPath ?? 'cloudflared'
  const api = options.apiToken
    ? new CloudflareApi({
        apiToken: options.apiToken,
        apiBase: options.apiBase,
        fetcher: options.fetcher
      })
    : undefined

  let childProcess: ChildProcess | undefined
  let output: string[] = []
  let exitInfo: { code: number | null, signal: string | null } | undefined
  let publicUrl: string | undefined
  let active: ActiveTunnel | undefined
  let accountId: string | undefined
  let plannedMode: TunnelMode = 'quick'

  function reset(): void {
    childProcess = undefined
    output = []
    exitInfo = undefined
    publicUrl = undefined
    active = undefined
  }

  function requireApi(): CloudflareApi {
    if (!api) {
      throw new AdapterError('Named tunnels require CLOUDFLARE_API_TOKEN', {
        code: 'AUTH_INVALID',
        hint: 'Set CLOUDFLARE_API_TOKEN, or use --mode quick for a temporary domain'
      })
    }
    return api
  }

  function ensureCloudflared(): void {
    const check = spawnSync(cloudflaredPath, ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 10_000,
      windowsHide: true
    })

    if (check.error || check.status !== 0) {
      throw new AdapterError(`Cannot run cloudflared at "${cloudflaredPath}"`, {
        code: 'PROCESS_SPAWN_FAILED',
        hint: 'Install cloudflared or set providers.cloudflare.cloudflaredPath',
        cause: check.error
      })
    }
  }

  function capture(chunk: Buffer, hooks: TunnelHooks): void {
    const text = stripAnsi(chunk.toString())
    for (const line of text.split(/\r?\n/)) {
      if (!line) {
        continue
      }

      output.push(line)
      if (output.length > 200) {
        output.shift()
      }

      hooks.onLog?.(line, 'stderr')

      const match = QUICK_URL_PATTERN.exec(line)
      if (match?.[0]) {
        publicUrl = match[0]
      }
    }
  }

  async function resolveAccountId(): Promise<string> {
    if (accountId) {
      return accountId
    }
    accountId = await requireApi().resolveAccountId(options.accountId)
    return accountId
  }

  async function rollbackTunnel(accountIdValue: string, tunnelId: string): Promise<void> {
    const client = requireApi()
    await client.cleanupConnections(accountIdValue, tunnelId).catch(() => {})
    await client.deleteTunnel(accountIdValue, tunnelId).catch(() => {})
  }

  return {
    kind: 'tunnel',
    id: ADAPTER_ID,
    apiVersion: 1,
    capabilities: {
      modes: ['named', 'quick'],
      publicHostname: 'both',
      requiresDns: false,
      concurrent: true
    },

    async preflight(_ctx: AdapterContext, { mode }: { mode: TunnelMode }): Promise<void> {
      plannedMode = mode
      ensureCloudflared()

      if (mode === 'named') {
        const client = requireApi()
        await client.verifyToken()
        await resolveAccountId()
      }
    },

    async provision(_ctx: AdapterContext, spec: TunnelProvisionSpec): Promise<TunnelHandle> {
      reset()

      if (plannedMode === 'quick') {
        return {
          provider: ADAPTER_ID,
          tunnelId: 'quick',
          name: spec.name,
          secrets: {},
          meta: { mode: 'quick', localUrl: spec.localUrl }
        }
      }

      if (spec.hostname === undefined) {
        throw new AdapterError('Named tunnel requires a hostname', {
          code: 'TUNNEL_CREATE_FAILED',
          hint: 'Set domain.zone (and optionally domain.subdomain) in flash-tunnel.ts'
        })
      }

      const client = requireApi()
      const accountIdValue = await resolveAccountId()
      const tunnel = await client.createTunnel(accountIdValue, spec.name)
      const token = tunnel.token ?? await client.getTunnelToken(accountIdValue, tunnel.id)

      const originRequest = options.originRequest && Object.keys(options.originRequest).length > 0
        ? options.originRequest
        : undefined
      const ingress: Array<Record<string, unknown>> = [
        {
          hostname: spec.hostname,
          service: spec.localUrl,
          ...(originRequest ? { originRequest } : {})
        },
        { service: 'http_status:404' }
      ]

      try {
        await client.putIngress(accountIdValue, tunnel.id, ingress)
      }
      catch (error) {
        await rollbackTunnel(accountIdValue, tunnel.id)
        throw error
      }

      const handle: TunnelHandle = {
        provider: ADAPTER_ID,
        tunnelId: tunnel.id,
        name: spec.name,
        publicUrl: `https://${spec.hostname}`,
        dns: {
          type: 'CNAME',
          target: `${tunnel.id}.cfargotunnel.com`,
          proxied: true
        },
        secrets: { token },
        meta: {
          mode: 'named',
          accountId: accountIdValue,
          hostname: spec.hostname,
          localUrl: spec.localUrl
        }
      }

      active = {
        handle,
        accountId: accountIdValue,
        mode: 'named',
        resource: tunnel
      }

      return handle
    },

    async start(_ctx: AdapterContext, handle: TunnelHandle, hooks: TunnelHooks): Promise<void> {
      const localUrl = handle.meta?.localUrl
      const named = handle.meta?.mode === 'named'
      if (!localUrl) {
        throw new AdapterError('Missing local URL for tunnel', {
          code: 'PROCESS_SPAWN_FAILED'
        })
      }

      const args = named
        ? ['--no-autoupdate', 'tunnel', 'run']
        : ['--no-autoupdate', 'tunnel', '--url', localUrl]

      const child = spawn(cloudflaredPath, args, {
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: named && handle.secrets.token
          ? { ...process.env, TUNNEL_TOKEN: handle.secrets.token }
          : process.env
      })

      childProcess = child
      child.stderr?.on('data', (chunk: Buffer) => capture(chunk, hooks))
      child.stdout?.on('data', (chunk: Buffer) => capture(chunk, hooks))
      child.once('exit', (code, signal) => {
        exitInfo = { code, signal }
        hooks.onExit?.({ code, signal })
      })
    },

    async waitReady(_ctx: AdapterContext, handle: TunnelHandle, timeoutMs: number): Promise<TunnelStatus> {
      const startedAt = Date.now()
      const named = handle.meta?.mode === 'named'

      while (Date.now() - startedAt < timeoutMs) {
        if (named) {
          const client = requireApi()
          const accountIdValue = handle.meta?.accountId
          if (!accountIdValue) {
            throw new AdapterError('Missing account id for named tunnel', {
              code: 'TUNNEL_NOT_CONNECTED'
            })
          }

          try {
            const tunnel = await client.getTunnel(accountIdValue, handle.tunnelId)
            const connections = tunnel.connections?.length ?? 0
            if (tunnel.status === 'healthy' && connections > 0) {
              if (handle.publicUrl) {
                publicUrl = handle.publicUrl
              }
              return { state: 'connected', connections, publicUrl: handle.publicUrl }
            }
          }
          catch (error) {
            if (exitInfo) {
              throw new AdapterError(
                `cloudflared exited before the tunnel was ready (code ${exitInfo.code ?? 'null'})${output.length ? `\n${output.slice(-10).join('\n')}` : ''}`,
                { code: 'TUNNEL_NOT_CONNECTED', retriable: true, cause: error }
              )
            }
          }
        }
        else if (publicUrl) {
          handle.publicUrl = publicUrl
          return { state: 'connected', connections: 1, publicUrl }
        }

        if (exitInfo) {
          throw new AdapterError(
            `cloudflared exited before the tunnel was ready (code ${exitInfo.code ?? 'null'})${output.length ? `\n${output.slice(-10).join('\n')}` : ''}`,
            { code: 'TUNNEL_NOT_CONNECTED', retriable: true }
          )
        }

        await sleep(named ? 1000 : 150)
      }

      throw new AdapterError(`Timed out after ${timeoutMs}ms waiting for the tunnel`, {
        code: 'TUNNEL_NOT_CONNECTED',
        retriable: true,
        hint: 'Check that outbound UDP 7844 is reachable, or retry'
      })
    },

    async stop(): Promise<void> {
      const child = childProcess
      if (!child?.pid || child.exitCode !== null) {
        childProcess = undefined
        return
      }

      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        })
      }
      else {
        try {
          process.kill(-child.pid, 'SIGTERM')
        }
        catch {
          child.kill('SIGTERM')
        }
      }

      await sleep(100)
      childProcess = undefined
    },

    async deprovision(): Promise<void> {
      const current = active
      if (!current) {
        reset()
        return
      }

      if (current.mode === 'named') {
        const client = requireApi()
        const accountIdValue = current.accountId
        const tunnelId = current.handle.tunnelId

        if (accountIdValue) {
          await client.cleanupConnections(accountIdValue, tunnelId).catch(() => {})

          try {
            await client.deleteTunnel(accountIdValue, tunnelId)
          }
          catch (error) {
            const retryable = error instanceof AdapterError
              && /active connection|connections/i.test(error.message)
            if (!retryable) {
              if (error instanceof AdapterError && error.code === 'NOT_FOUND') {
                reset()
                return
              }
              throw error
            }
            await client.cleanupConnections(accountIdValue, tunnelId).catch(() => {})
            await client.deleteTunnel(accountIdValue, tunnelId)
          }
        }
      }

      reset()
    },

    async status(_ctx: AdapterContext, handle: TunnelHandle): Promise<TunnelStatus> {
      const named = handle.meta?.mode === 'named'
      if (!named || !handle.meta?.accountId) {
        return {
          state: handle.publicUrl ? 'connected' : 'starting',
          connections: handle.publicUrl ? 1 : 0,
          publicUrl: handle.publicUrl
        }
      }

      const client = requireApi()
      const tunnel = await client.getTunnel(handle.meta.accountId, handle.tunnelId)
      const connections = tunnel.connections?.length ?? 0
      return {
        state: tunnel.status === 'healthy' ? 'connected' : 'starting',
        connections,
        publicUrl: handle.publicUrl
      }
    }
  }
}

export const cloudflareTunnel = createCloudflareTunnel()
