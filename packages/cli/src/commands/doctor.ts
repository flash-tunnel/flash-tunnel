import type { CloudflareApi } from '@flash-tunnel/adapter-cloudflare'
import type { Reporter } from '../ui/reporter'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import process from 'node:process'
import { CloudflareApi as Api } from '@flash-tunnel/adapter-cloudflare'
import {
  detectServer,
  findConfigFile,
  isProcessAlive,
  isSessionStale,
  listSessionStates,
  loadFlashTunnelConfig
} from '@flash-tunnel/core'
import { AdapterError } from '@flash-tunnel/types'
import { symbols } from '../ui/symbols'
import { theme } from '../ui/theme'

export type CheckLevel = 'error' | 'info' | 'ok' | 'warn'

export interface DoctorCheck {
  id: string
  level: CheckLevel
  message: string
  hint?: string
}

export interface DoctorOptions {
  cwd?: string
  config?: string
}

const MINIMUM_NODE = [22, 14, 0] as const

function compareVersions(actual: string, minimum: readonly number[]): boolean {
  const parts = actual.split('.').map(part => Number.parseInt(part, 10))
  for (let index = 0; index < minimum.length; index += 1) {
    const value = parts[index] ?? 0
    const expected = minimum[index] ?? 0
    if (value > expected) {
      return true
    }
    if (value < expected) {
      return false
    }
  }
  return true
}

function apiFor(token: string | undefined): CloudflareApi | undefined {
  if (!token) {
    return undefined
  }
  return new Api({
    apiToken: token,
    apiBase: process.env.FLASH_TUNNEL_CLOUDFLARE_API_BASE
  })
}

function checkCloudflared(path: string): DoctorCheck {
  const result = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 10_000,
    windowsHide: true
  })

  if (result.error || result.status !== 0) {
    return {
      id: 'cloudflared',
      level: 'error',
      message: `cloudflared is not runnable at "${path}"`,
      hint: 'Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
    }
  }

  const version = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/)[0]
  return { id: 'cloudflared', level: 'ok', message: version || 'cloudflared is installed' }
}

function checkPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.once('listening', () => {
      server.close(() => resolvePort(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function checkCloudflare(
  token: string | undefined,
  config: Awaited<ReturnType<typeof loadFlashTunnelConfig>>['config']
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const api = apiFor(token)

  if (!api) {
    checks.push({
      id: 'token',
      level: 'warn',
      message: 'CLOUDFLARE_API_TOKEN is not set',
      hint: 'Named tunnels need a token; quick mode can run without one'
    })
    return checks
  }

  try {
    await api.verifyToken()
    checks.push({ id: 'token', level: 'ok', message: 'Cloudflare API token is active' })
  }
  catch (error) {
    checks.push({
      id: 'token',
      level: 'error',
      message: error instanceof Error ? error.message : String(error),
      hint: 'Create a token with Account Cloudflare Tunnel Edit and Zone DNS Edit'
    })
    return checks
  }

  try {
    const accounts = await api.listAccounts()
    const configured = process.env.CLOUDFLARE_ACCOUNT_ID ?? config.providers?.cloudflare?.accountId

    if (accounts.length === 0) {
      checks.push({ id: 'account', level: 'error', message: 'The token cannot see any Cloudflare account' })
    }
    else if (accounts.length === 1 && accounts[0]) {
      checks.push({ id: 'account', level: 'ok', message: `Account ${accounts[0].name}` })
    }
    else if (configured) {
      checks.push({ id: 'account', level: 'ok', message: `Account id ${configured}` })
    }
    else {
      checks.push({
        id: 'account',
        level: 'warn',
        message: `Multiple accounts are visible (${accounts.map(account => account.name).join(', ')})`,
        hint: 'Set CLOUDFLARE_ACCOUNT_ID or providers.cloudflare.accountId'
      })
    }
  }
  catch (error) {
    checks.push({
      id: 'account',
      level: 'error',
      message: error instanceof Error ? error.message : String(error)
    })
  }

  const zone = process.env.FLASH_TUNNEL_ZONE ?? config.domain?.zone
  try {
    if (zone) {
      const resolved = await api.resolveZone(zone)
      checks.push({ id: 'zone', level: 'ok', message: `Zone ${resolved.name} (${resolved.status})` })
    }
    else {
      const zones = (await api.listZones()).filter(item => item.status === 'active')
      if (zones.length === 0) {
        checks.push({
          id: 'zone',
          level: 'error',
          message: 'No active zone is visible to this token',
          hint: 'Set domain.zone in flash-tunnel.ts or pass --zone'
        })
      }
      else if (zones.length === 1 && zones[0]) {
        checks.push({
          id: 'zone',
          level: 'info',
          message: `Single active zone detected: ${zones[0].name}`,
          hint: 'Add domain.zone to flash-tunnel.ts to skip zone discovery'
        })
      }
      else {
        checks.push({
          id: 'zone',
          level: 'warn',
          message: `Multiple active zones: ${zones.map(item => item.name).join(', ')}`,
          hint: 'Set domain.zone so the tool does not have to guess'
        })
      }
    }
  }
  catch (error) {
    checks.push({
      id: 'zone',
      level: 'error',
      message: error instanceof Error ? error.message : String(error),
      hint: error instanceof AdapterError ? error.hint : undefined
    })
  }

  return checks
}

export async function collectDoctorChecks(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const checks: DoctorCheck[] = []

  checks.push(compareVersions(process.versions.node, MINIMUM_NODE)
    ? { id: 'node', level: 'ok', message: `Node ${process.versions.node}` }
    : {
        id: 'node',
        level: 'error',
        message: `Node ${process.versions.node} is too old`,
        hint: 'Upgrade to Node 22.14.0 or newer'
      })

  let config: Awaited<ReturnType<typeof loadFlashTunnelConfig>>['config'] = {}
  const configFile = options.config ? resolve(cwd, options.config) : findConfigFile(cwd)
  if (!configFile) {
    checks.push({
      id: 'config',
      level: 'info',
      message: 'No flash-tunnel.ts found; defaults will be used'
    })
  }
  else {
    try {
      const loaded = await loadFlashTunnelConfig(cwd, { config: options.config })
      config = loaded.config
      checks.push({ id: 'config', level: 'ok', message: `Loaded ${configFile}` })
    }
    catch (error) {
      checks.push({
        id: 'config',
        level: 'error',
        message: error instanceof Error ? error.message : String(error),
        hint: 'Fix the flash-tunnel.ts export or syntax'
      })
    }
  }

  checks.push(checkCloudflared(process.env.FLASH_TUNNEL_CLOUDFLARED ?? config.providers?.cloudflare?.cloudflaredPath ?? 'cloudflared'))

  checks.push(...await checkCloudflare(process.env.CLOUDFLARE_API_TOKEN, config))

  try {
    const plan = detectServer(cwd, config.server)
    const free = await checkPortFree(plan.port)
    checks.push(free
      ? { id: 'port', level: 'ok', message: `Port ${plan.port} is free (${plan.command ?? plan.mode})` }
      : {
          id: 'port',
          level: 'warn',
          message: `Port ${plan.port} is already in use`,
          hint: 'Another dev server may be running; use --reuse to attach to it'
        })

    if (plan.framework === 'vite') {
      checks.push({
        id: 'framework',
        level: 'info',
        message: 'Vite detected',
        hint: 'If the public URL returns 403, add the hostname to server.allowedHosts'
      })
    }
    else if (plan.framework === 'next') {
      checks.push({
        id: 'framework',
        level: 'info',
        message: 'Next.js detected',
        hint: 'If the public URL returns a host error, add it to allowedDevOrigins'
      })
    }
  }
  catch (error) {
    checks.push({
      id: 'server',
      level: 'error',
      message: error instanceof Error ? error.message : String(error),
      hint: 'Try --command, --url or --cwd to point the tool at your dev server'
    })
  }

  const sessions = await listSessionStates()
  const stale = sessions.filter(state => isSessionStale(state))
  const alive = sessions.filter(state => isProcessAlive(state.pid))
  if (stale.length > 0) {
    checks.push({
      id: 'sessions',
      level: 'warn',
      message: `${stale.length} leftover session${stale.length === 1 ? '' : 's'} need cleanup`,
      hint: 'Run flash-tunnel clean --stale'
    })
  }
  else if (alive.length > 0) {
    checks.push({ id: 'sessions', level: 'info', message: `${alive.length} running session${alive.length === 1 ? '' : 's'}` })
  }
  else {
    checks.push({ id: 'sessions', level: 'ok', message: 'No leftover sessions' })
  }

  checks.push({
    id: 'terminal',
    level: 'info',
    message: process.stdout.isTTY
      ? `Interactive terminal (${process.platform})`
      : 'Non-interactive output; prompts and spinner are disabled'
  })

  return checks
}

export async function runDoctor(options: DoctorOptions, reporter: Reporter): Promise<void> {
  const checks = await collectDoctorChecks(options)
  reporter.event({ type: 'doctor', checks })

  if (reporter.json) {
    if (checks.some(check => check.level === 'error')) {
      process.exitCode = 1
    }
    return
  }

  for (const check of checks) {
    const symbol = check.level === 'ok'
      ? theme.ok(symbols.ok)
      : check.level === 'warn'
        ? theme.warn(symbols.warn)
        : check.level === 'error'
          ? theme.err(symbols.fail)
          : theme.info(symbols.info)
    reporter.human(`${symbol} ${check.message}\n`)
    if (check.hint) {
      reporter.human(`  ${theme.dim(check.hint)}\n`)
    }
  }

  if (checks.some(check => check.level === 'error')) {
    process.exitCode = 1
  }
}
