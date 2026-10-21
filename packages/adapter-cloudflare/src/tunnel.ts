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
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { AdapterError } from '@flash-tunnel/types'
import { sleep, stripAnsi } from '@flash-tunnel/utils'

const ADAPTER_ID = 'cloudflare'
const QUICK_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

export interface CloudflareTunnelOptions {
  cloudflaredPath?: string
  accountId?: string
  apiToken?: string
}

export function createCloudflareTunnel(options: CloudflareTunnelOptions = {}): TunnelAdapter {
  const cloudflaredPath = options.cloudflaredPath ?? 'cloudflared'

  let childProcess: ChildProcess | undefined
  let output: string[] = []
  let exitInfo: { code: number | null, signal: string | null } | undefined
  let publicUrl: string | undefined

  function reset(): void {
    childProcess = undefined
    output = []
    exitInfo = undefined
    publicUrl = undefined
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
      if (mode === 'named' && !options.apiToken) {
        throw new AdapterError('Named tunnels require CLOUDFLARE_API_TOKEN', {
          code: 'AUTH_INVALID',
          hint: 'Set CLOUDFLARE_API_TOKEN, or use --mode quick for a temporary domain'
        })
      }

      if (mode === 'named') {
        throw new AdapterError('Named tunnel mode is not implemented yet', {
          code: 'TUNNEL_CREATE_FAILED',
          hint: 'Use --mode quick until the named tunnel adapter lands'
        })
      }

      ensureCloudflared()
    },

    async provision(_ctx: AdapterContext, spec: TunnelProvisionSpec): Promise<TunnelHandle> {
      reset()
      return {
        provider: ADAPTER_ID,
        tunnelId: 'quick',
        name: spec.name,
        secrets: {},
        meta: { mode: 'quick', localUrl: spec.localUrl }
      }
    },

    async start(_ctx: AdapterContext, handle: TunnelHandle, hooks: TunnelHooks): Promise<void> {
      const localUrl = handle.meta?.localUrl
      if (!localUrl) {
        throw new AdapterError('Missing local URL for quick tunnel', {
          code: 'PROCESS_SPAWN_FAILED'
        })
      }

      const child = spawn(cloudflaredPath, ['tunnel', '--no-autoupdate', '--url', localUrl], {
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
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

      while (Date.now() - startedAt < timeoutMs) {
        if (publicUrl) {
          handle.publicUrl = publicUrl
          return { state: 'connected', connections: 1, publicUrl }
        }

        if (exitInfo) {
          throw new AdapterError(
            `cloudflared exited before the tunnel was ready (code ${exitInfo.code ?? 'null'})${output.length ? `\n${output.slice(-10).join('\n')}` : ''}`,
            { code: 'TUNNEL_NOT_CONNECTED', retriable: true }
          )
        }

        await sleep(150)
      }

      throw new AdapterError(`Timed out after ${timeoutMs}ms waiting for the quick tunnel URL`, {
        code: 'TUNNEL_NOT_CONNECTED',
        retriable: true,
        hint: 'Check that outbound UDP 7844 is reachable, or retry'
      })
    },

    async stop(): Promise<void> {
      const child = childProcess
      if (!child?.pid || child.exitCode !== null) {
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
      reset()
    },

    async deprovision(): Promise<void> {
      reset()
    }
  }
}

export const cloudflareTunnel = createCloudflareTunnel()
