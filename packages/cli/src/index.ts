import type { PreviewSession } from '@flash-tunnel/core'
import type { TunnelMode } from '@flash-tunnel/types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { CloudflareApi, createCloudflareDns, createCloudflareTunnel } from '@flash-tunnel/adapter-cloudflare'
import { loadFlashTunnelConfig, resolveHostname, startPreviewSession } from '@flash-tunnel/core'
import { cac } from 'cac'
import { theme } from './ui/theme'

interface StartOptions {
  cwd?: string
  port?: string
  command?: string
  url?: string
  mode?: string
  verbose?: boolean
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? '0.0.0'
  }
  catch {
    return '0.0.0'
  }
}

type StopReason = 'SIGINT' | 'SIGTERM' | 'server-exit' | 'tunnel-exit'

function waitForStop(session: PreviewSession): Promise<StopReason> {
  return new Promise((resolveStop) => {
    let finish: (reason: StopReason) => void = (): void => {}

    const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => finish(signal)

    finish = (reason: StopReason): void => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      resolveStop(reason)
    }

    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    session.exited.then(() => finish('tunnel-exit'))
    session.server.exited?.then(() => finish('server-exit'))
  })
}

function parseMode(value: string | undefined): TunnelMode {
  if (!value) {
    return 'named'
  }
  if (value === 'quick' || value === 'named') {
    return value
  }
  throw new Error(`Invalid tunnel mode "${value}". Use "quick" or "named".`)
}

async function startPreview(options: StartOptions): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const { config, source } = await loadFlashTunnelConfig(cwd)

  if (source) {
    process.stdout.write(`${theme.dim('config')} ${source}\n`)
  }

  const provider = config.providers?.cloudflare as
    | {
      accountId?: string
      cloudflaredPath?: string
      zoneId?: string
      originRequest?: { httpHostHeader?: string, noTLSVerify?: boolean }
    }
    | undefined

  const mode = parseMode(options.mode)
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const apiBase = process.env.FLASH_TUNNEL_CLOUDFLARE_API_BASE
  let zone = process.env.FLASH_TUNNEL_ZONE ?? config.domain?.zone

  if (mode === 'named' && !apiToken) {
    throw new Error('Named mode requires CLOUDFLARE_API_TOKEN; use --mode quick for a temporary domain')
  }

  if (mode === 'named' && !zone && apiToken) {
    const api = new CloudflareApi({ apiToken, apiBase })
    const zones = (await api.listZones()).filter(item => item.status === 'active')

    if (zones.length === 1 && zones[0]) {
      zone = zones[0].name
    }
    else if (zones.length === 0) {
      throw new Error('No active Cloudflare zone found; set domain.zone in flash-tunnel.ts')
    }
    else {
      throw new Error(`Multiple zones found (${zones.map(item => item.name).join(', ')}); set domain.zone`)
    }
  }

  if (mode === 'named' && !zone) {
    throw new Error('Named mode requires domain.zone in flash-tunnel.ts or FLASH_TUNNEL_ZONE')
  }

  const hostname = mode === 'named' && zone
    ? process.env.FLASH_TUNNEL_HOSTNAME
    ?? resolveHostname({
      cwd,
      zone,
      subdomain: config.domain?.subdomain
    })
    : undefined

  const tunnel = createCloudflareTunnel({
    cloudflaredPath: process.env.FLASH_TUNNEL_CLOUDFLARED ?? provider?.cloudflaredPath,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? provider?.accountId,
    apiToken,
    apiBase,
    originRequest: provider?.originRequest
  })

  const dns = mode === 'named' && apiToken
    ? createCloudflareDns({
        apiToken,
        zoneId: process.env.CLOUDFLARE_ZONE_ID ?? provider?.zoneId,
        apiBase
      })
    : undefined

  const session = await startPreviewSession({
    cwd,
    config,
    adapters: { tunnel, dns },
    mode,
    hostname,
    zone,
    onLog: options.verbose
      ? line => process.stderr.write(`${theme.dim('[log]')} ${line}\n`)
      : undefined
  })

  process.stdout.write(`${theme.ok('✔')} local  ${theme.url(session.localUrl)}\n`)
  if (session.dns && session.hostname) {
    process.stdout.write(`${theme.ok('✔')} dns    ${session.hostname} ${theme.dim(`(${session.dns.type} → ${session.dns.content})`)}\n`)
  }
  process.stdout.write(`${theme.ok('✔')} public ${theme.url(session.publicUrl)}\n`)
  process.stdout.write(`${theme.dim('Press Ctrl+C to stop.')}\n`)

  const reason = await waitForStop(session)

  if (reason === 'tunnel-exit') {
    process.stderr.write(`${theme.err('✖')} cloudflared exited unexpectedly\n`)
    process.exitCode = 5
  }
  else if (reason === 'server-exit') {
    process.stderr.write(`${theme.err('✖')} dev server exited unexpectedly\n`)
    process.exitCode = 3
  }
  else {
    process.stdout.write(`${theme.dim('Stopping...')}\n`)
  }

  await session.stop()
}

async function runStart(options: StartOptions = {}): Promise<void> {
  try {
    await startPreview(options)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${theme.err('✖')} ${message}\n`)
    process.exitCode = 1
  }
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const cli = cac('flash-tunnel')

  cli
    .command('[root]', 'Start a temporary public preview')
    .option('--cwd <dir>', 'Project directory')
    .option('--port <port>', 'Preferred local port')
    .option('--command <command>', 'Command used to start the local server')
    .option('--url <url>', 'Reuse an already running server')
    .option('--mode <mode>', 'Tunnel mode: quick or named')
    .option('--verbose', 'Stream dev server and cloudflared logs')
    .action((_root: unknown, options: StartOptions = {}) => runStart(options))

  cli
    .command('start', 'Start a temporary public preview')
    .option('--cwd <dir>', 'Project directory')
    .option('--port <port>', 'Preferred local port')
    .option('--command <command>', 'Command used to start the local server')
    .option('--url <url>', 'Reuse an already running server')
    .option('--mode <mode>', 'Tunnel mode: quick or named')
    .option('--verbose', 'Stream dev server and cloudflared logs')
    .action((options: StartOptions = {}) => runStart(options))

  cli.help()
  cli.version(readVersion())
  cli.parse(argv)
}
