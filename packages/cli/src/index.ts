import type { PreviewSession, SessionCleaner, SessionState } from '@flash-tunnel/core'
import type { TunnelMode } from '@flash-tunnel/types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { CloudflareApi, createCloudflareDns, createCloudflareTunnel } from '@flash-tunnel/adapter-cloudflare'
import {
  cleanSessions,
  CleanupError,
  isProcessAlive,
  listSessionStates,
  loadFlashTunnelConfig,
  resolveHostname,
  startPreviewSession
} from '@flash-tunnel/core'
import { AdapterError } from '@flash-tunnel/types'
import { parseDuration } from '@flash-tunnel/utils'
import { cac } from 'cac'
import { theme } from './ui/theme'

interface StartOptions {
  cwd?: string
  port?: string
  command?: string
  url?: string
  mode?: string
  verbose?: boolean
  keep?: boolean
  autoStop?: string
}

interface CleanOptions {
  session?: string
  project?: string
  stale?: boolean
  all?: boolean
  dryRun?: boolean
  yes?: boolean
  force?: boolean
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

type StopReason = 'SIGINT' | 'SIGTERM' | 'auto-stop' | 'server-exit' | 'tunnel-exit'

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
    session.autoStopped?.then(() => finish('auto-stop'))
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

function createCleaner(): SessionCleaner | undefined {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  if (!apiToken) {
    return undefined
  }

  const api = new CloudflareApi({
    apiToken,
    apiBase: process.env.FLASH_TUNNEL_CLOUDFLARE_API_BASE
  })

  return {
    removeDns: async (state: SessionState) => {
      if (!state.dns) {
        return
      }
      try {
        await api.deleteDnsRecord(state.dns.zoneId, state.dns.recordId)
      }
      catch (error) {
        if (error instanceof AdapterError && error.code === 'NOT_FOUND') {
          return
        }
        throw error
      }
    },
    removeTunnel: async (state: SessionState) => {
      if (!state.tunnel || state.tunnel.mode !== 'named') {
        return
      }
      if (!state.tunnel.accountId) {
        throw new Error('Session is missing the Cloudflare account id')
      }

      await api.cleanupConnections(state.tunnel.accountId, state.tunnel.tunnelId).catch(() => {})
      try {
        await api.deleteTunnel(state.tunnel.accountId, state.tunnel.tunnelId)
      }
      catch (error) {
        if (error instanceof AdapterError && error.code === 'NOT_FOUND') {
          return
        }
        throw error
      }
    }
  }
}

async function sweepStale(projectRoot: string): Promise<void> {
  const cleaner = createCleaner()
  if (!cleaner) {
    return
  }

  const results = await cleanSessions({
    projectRoot,
    staleOnly: true,
    cleaner
  })

  for (const result of results) {
    if (result.status === 'removed') {
      process.stdout.write(`${theme.dim('swept')} ${result.sessionId}\n`)
    }
  }
}

async function startPreview(options: StartOptions): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const { config, source } = await loadFlashTunnelConfig(cwd)

  if (source) {
    process.stdout.write(`${theme.dim('config')} ${source}\n`)
  }

  await sweepStale(cwd).catch((error) => {
    process.stderr.write(`${theme.warn('!')} sweep failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })

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

  const autoStopValue = options.autoStop ?? config.autoStopAfter
  const autoStopAfterMs = autoStopValue === undefined ? undefined : parseDuration(autoStopValue)

  const session = await startPreviewSession({
    cwd,
    config,
    adapters: { tunnel, dns },
    mode,
    hostname,
    zone,
    keep: options.keep,
    autoStopAfterMs,
    configSource: source,
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

  if (options.keep) {
    process.stderr.write(`${theme.warn('!')} --keep: resources will stay until you run flash-tunnel clean\n`)
  }

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
    process.stdout.write(`${theme.dim(reason === 'auto-stop' ? 'Auto-stop reached; cleaning up...' : 'Stopping...')}\n`)
  }

  try {
    await session.stop()
  }
  catch (error) {
    if (error instanceof CleanupError) {
      process.stderr.write(`${theme.err('✖')} cleanup incomplete\n`)
      for (const failure of error.failures) {
        process.stderr.write(`  ${failure.step}: ${failure.error}\n`)
      }
      process.exitCode = 8
    }
    else {
      throw error
    }
  }

  if (options.keep) {
    process.stdout.write(`${theme.dim(`Kept resources. Clean up later: flash-tunnel clean --session ${session.sessionId}`)}\n`)
  }
}

function formatSession(state: SessionState): string {
  const target = state.dns?.hostname ?? state.tunnel?.publicUrl ?? '(none)'
  const alive = isProcessAlive(state.pid) ? 'alive' : 'dead'
  return `${state.sessionId}  ${state.state}  ${alive}  ${state.projectRoot}  ${target}`
}

async function runClean(options: CleanOptions): Promise<void> {
  if (!options.session && !options.stale && !options.all) {
    const states = await listSessionStates()
    if (states.length === 0) {
      process.stdout.write(`${theme.dim('No leftover sessions.')}\n`)
      return
    }
    for (const state of states) {
      process.stdout.write(`${formatSession(state)}\n`)
    }
    process.stdout.write(`${theme.dim('Use --session <id>, --stale or --all --yes to clean.')}\n`)
    return
  }

  if (options.all && !options.yes) {
    throw new Error('clean --all requires --yes')
  }

  const results = await cleanSessions({
    sessionId: options.session,
    projectRoot: options.project ? resolve(options.project) : undefined,
    staleOnly: options.stale,
    all: options.all,
    force: options.force,
    dryRun: options.dryRun,
    cleaner: options.dryRun ? undefined : createCleaner()
  })

  if (results.length === 0) {
    process.stdout.write(`${theme.dim('No matching sessions.')}\n`)
    return
  }

  let failed = 0
  for (const result of results) {
    const label = result.status === 'removed' || result.status === 'would-remove'
      ? theme.ok(result.status)
      : result.status === 'failed'
        ? theme.err(result.status)
        : theme.warn(result.status)

    process.stdout.write(`${label} ${result.sessionId}`)
    if (result.actions.length > 0) {
      process.stdout.write(`  ${result.actions.join(', ')}`)
    }
    if (result.reasons.length > 0) {
      process.stdout.write(`  ${result.reasons.join('; ')}`)
    }
    process.stdout.write('\n')

    if (result.status === 'failed') {
      failed += 1
    }
  }

  if (failed > 0) {
    process.exitCode = 8
  }
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${theme.err('✖')} ${message}\n`)
  process.exitCode = error instanceof CleanupError ? 8 : 1
}

async function runStart(options: StartOptions = {}): Promise<void> {
  try {
    await startPreview(options)
  }
  catch (error) {
    reportError(error)
  }
}

async function runCleanCommand(options: CleanOptions = {}): Promise<void> {
  try {
    await runClean(options)
  }
  catch (error) {
    reportError(error)
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
    .option('--auto-stop <duration>', 'Stop and clean up after a duration, e.g. 2h')
    .option('--keep', 'Keep DNS and tunnel after exit')
    .option('--verbose', 'Stream dev server and cloudflared logs')
    .action((_root: unknown, options: StartOptions = {}) => runStart(options))

  cli
    .command('start', 'Start a temporary public preview')
    .option('--cwd <dir>', 'Project directory')
    .option('--port <port>', 'Preferred local port')
    .option('--command <command>', 'Command used to start the local server')
    .option('--url <url>', 'Reuse an already running server')
    .option('--mode <mode>', 'Tunnel mode: quick or named')
    .option('--auto-stop <duration>', 'Stop and clean up after a duration, e.g. 2h')
    .option('--keep', 'Keep DNS and tunnel after exit')
    .option('--verbose', 'Stream dev server and cloudflared logs')
    .action((options: StartOptions = {}) => runStart(options))

  cli
    .command('clean', 'Clean leftover sessions')
    .option('--session <id>', 'Clean a specific session')
    .option('--project <dir>', 'Only sessions for this project')
    .option('--stale', 'Only sessions whose process is gone')
    .option('--all', 'Clean all sessions (requires --yes)')
    .option('--dry-run', 'Show what would be removed')
    .option('--yes', 'Confirm destructive clean')
    .option('--force', 'Allow cleaning a running session')
    .action((options: CleanOptions = {}) => runCleanCommand(options))

  cli.help()
  cli.version(readVersion())
  cli.parse(argv)
}
