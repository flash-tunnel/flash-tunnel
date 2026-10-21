import type { CleanSessionResult, PreviewSession, SessionCleaner, SessionState } from '@flash-tunnel/core'
import type { FlashTunnelEvents, TunnelMode } from '@flash-tunnel/types'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { CloudflareApi, createCloudflareDns, createCloudflareTunnel } from '@flash-tunnel/adapter-cloudflare'
import {
  cleanSession,
  cleanSessions,
  CleanupError,
  Emitter,
  findStaleSessions,
  FlashTunnelError,
  isProcessAlive,
  listSessionStates,
  loadFlashTunnelConfig,
  ProjectLockedError,
  reapSession,
  resolveHostname,
  startPreviewSession
} from '@flash-tunnel/core'
import { AdapterError } from '@flash-tunnel/types'
import { parseDuration } from '@flash-tunnel/utils'
import { cac } from 'cac'
import { runDoctor } from './commands/doctor'
import { runInit } from './commands/init'
import { runProviders } from './commands/providers'
import { Reporter } from './ui/reporter'
import { theme, themeStderr } from './ui/theme'

interface StartOptions {
  cwd?: string
  port?: string
  command?: string
  url?: string
  mode?: string
  zone?: string
  hostname?: string
  verbose?: boolean
  keep?: boolean
  autoStop?: string
  noSweep?: boolean
  sweep?: boolean
  json?: boolean
  silent?: boolean
  readyFile?: string
  onReady?: string
  noOpen?: boolean
}

interface CleanOptions {
  session?: string
  project?: string
  stale?: boolean
  all?: boolean
  dryRun?: boolean
  yes?: boolean
  force?: boolean
  json?: boolean
  silent?: boolean
}

interface InitCommandOptions {
  cwd?: string
  force?: boolean
  json?: boolean
  silent?: boolean
}

interface DoctorCommandOptions {
  cwd?: string
  json?: boolean
  silent?: boolean
}

type SignalReason = 'SIGINT' | 'SIGHUP' | 'SIGTERM'
type StopReason = SignalReason | 'auto-stop' | 'server-exit' | 'tunnel-exit'

let pendingReapSessionId: string | undefined
let exitReaperInstalled = false

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function waitForStop(session: PreviewSession): Promise<StopReason> {
  return new Promise((resolveStop) => {
    let finished = false

    function finish(reason: StopReason): void {
      if (finished) {
        return
      }
      finished = true
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      process.off('SIGHUP', onSighup)
      resolveStop(reason)
    }

    function onSigint(): void {
      finish('SIGINT')
    }

    function onSigterm(): void {
      finish('SIGTERM')
    }

    function onSighup(): void {
      finish('SIGHUP')
    }

    process.once('SIGINT', onSigint)
    process.once('SIGTERM', onSigterm)
    process.once('SIGHUP', onSighup)

    session.exited.then(() => {
      if (!session.stopping) {
        finish('tunnel-exit')
      }
    })
    session.autoStopped?.then(() => finish('auto-stop'))
    session.server.exited?.then(() => {
      if (!session.stopping) {
        finish('server-exit')
      }
    })
  })
}

/** The second Ctrl+C during cleanup exits immediately; the state file is reaped on next start. */
function installInterruptEscalation(): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    process.stderr.write(`\n${theme.warn('!')} forced exit (${signal}); leftover resources will be cleaned by the next run\n`)
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }

  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  return () => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

function installExitReaper(): void {
  if (exitReaperInstalled) {
    return
  }
  exitReaperInstalled = true

  process.on('exit', () => {
    const sessionId = pendingReapSessionId
    const entry = process.argv[1]
    if (!sessionId || !entry) {
      return
    }

    spawnSync(process.execPath, [entry, '__reap', '--session', sessionId, '--force'], {
      stdio: 'ignore',
      timeout: 20_000,
      windowsHide: true
    })
  })
}

function parseMode(value: string | undefined): TunnelMode {
  if (!value) {
    return 'named'
  }
  if (value === 'quick' || value === 'named') {
    return value
  }
  throw new FlashTunnelError(`Invalid tunnel mode "${value}"`, {
    code: 'INVALID_MODE',
    exitCode: 2,
    hint: 'Use "quick" for a temporary trycloudflare.com domain or "named" for a custom domain'
  })
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

async function sweepStale(projectRoot: string, reporter: Reporter): Promise<void> {
  const { project, others } = await findStaleSessions(projectRoot)

  for (const state of others) {
    reporter.warn(`leftover session ${state.sessionId} in ${state.projectRoot}; run flash-tunnel clean --stale`)
  }

  if (project.length === 0) {
    return
  }

  const cleaner = createCleaner()

  for (const state of project) {
    if (!cleaner && (state.dns || state.tunnel?.mode === 'named')) {
      reporter.warn(`leftover session ${state.sessionId} needs CLOUDFLARE_API_TOKEN; run flash-tunnel clean --session ${state.sessionId}`)
      continue
    }

    const result = await cleanSession(state, { cleaner })
    if (result.status === 'removed') {
      reporter.log(`${theme.dim('swept')} ${state.sessionId}\n`)
    }
    else if (result.status === 'failed') {
      reporter.warn(`sweep ${state.sessionId}: ${result.reasons.join('; ')}`)
    }
  }
}

async function startPreview(options: StartOptions, reporter: Reporter): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd())

  let loaded: Awaited<ReturnType<typeof loadFlashTunnelConfig>>
  try {
    loaded = await loadFlashTunnelConfig(cwd)
  }
  catch (error) {
    throw new FlashTunnelError(`Failed to load flash-tunnel.ts: ${errorMessage(error)}`, {
      code: 'CONFIG_LOAD_FAILED',
      exitCode: 2,
      cause: error
    })
  }

  const { config, source } = loaded

  if (source) {
    reporter.log(`${theme.dim('config')} ${source}\n`)
  }

  if (!options.noSweep && options.sweep !== false) {
    await sweepStale(cwd, reporter).catch((error) => {
      reporter.warn(`sweep failed: ${errorMessage(error)}`)
    })
  }

  const provider = config.providers?.cloudflare as
    | {
      accountId?: string
      cloudflaredPath?: string
      zoneId?: string
      originRequest?: { httpHostHeader?: string, noTLSVerify?: boolean }
    }
    | undefined

  const mode = parseMode(options.mode ?? config.tunnel?.mode)
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const apiBase = process.env.FLASH_TUNNEL_CLOUDFLARE_API_BASE
  let zone = options.zone ?? process.env.FLASH_TUNNEL_ZONE ?? config.domain?.zone

  if (mode === 'named' && !apiToken) {
    throw new FlashTunnelError('Named mode requires CLOUDFLARE_API_TOKEN', {
      code: 'AUTH_MISSING',
      exitCode: 4,
      hint: 'Export CLOUDFLARE_API_TOKEN, or use --mode quick for a temporary domain'
    })
  }

  if (mode === 'named' && !zone && apiToken) {
    const api = new CloudflareApi({ apiToken, apiBase })
    const zones = (await api.listZones()).filter(item => item.status === 'active')

    if (zones.length === 1 && zones[0]) {
      zone = zones[0].name
    }
    else if (zones.length === 0) {
      throw new FlashTunnelError('No active Cloudflare zone found', {
        code: 'ZONE_NOT_FOUND',
        exitCode: 2,
        hint: 'Set domain.zone in flash-tunnel.ts or pass --zone'
      })
    }
    else {
      throw new FlashTunnelError(`Multiple zones found (${zones.map(item => item.name).join(', ')})`, {
        code: 'ZONE_AMBIGUOUS',
        exitCode: 2,
        hint: 'Set domain.zone in flash-tunnel.ts or pass --zone'
      })
    }
  }

  if (mode === 'named' && !zone) {
    throw new FlashTunnelError('Named mode requires a zone', {
      code: 'ZONE_REQUIRED',
      exitCode: 2,
      hint: 'Set domain.zone in flash-tunnel.ts or pass --zone'
    })
  }

  const hostname = mode === 'named' && zone
    ? options.hostname
    ?? process.env.FLASH_TUNNEL_HOSTNAME
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
  let autoStopAfterMs: number | undefined
  try {
    autoStopAfterMs = autoStopValue === undefined ? undefined : parseDuration(autoStopValue)
  }
  catch (error) {
    throw new FlashTunnelError(`Invalid auto-stop duration: ${errorMessage(error)}`, {
      code: 'INVALID_DURATION',
      exitCode: 2,
      hint: 'Use a value like 30m, 2h or 90s'
    })
  }

  const events = new Emitter<FlashTunnelEvents>()
  events.on('server:ready', payload => reporter.event({
    type: 'server:ready',
    localUrl: payload.url,
    startedByUs: payload.startedByUs,
    durationMs: payload.durationMs
  }))
  events.on('tunnel:provisioned', payload => reporter.event({
    type: 'tunnel:provisioned',
    tunnelId: payload.tunnelId,
    name: payload.name
  }))
  events.on('tunnel:connected', payload => reporter.event({
    type: 'tunnel:connected',
    connections: payload.connections
  }))
  events.on('dns:created', payload => reporter.event({
    type: 'dns:created',
    hostname: payload.hostname,
    recordId: payload.recordId,
    zoneId: payload.zoneId
  }))
  events.on('cleanup:step', payload => reporter.event({
    type: 'cleanup:step',
    kind: payload.kind,
    status: payload.status,
    ...(payload.detail ? { detail: payload.detail } : {})
  }))
  events.on('cleanup:done', payload => reporter.event({
    type: 'cleanup',
    ok: payload.ok,
    removed: payload.removed,
    failed: payload.failed
  }))
  events.on('autostop:expired', payload => reporter.event({
    type: 'autostop',
    expiresAt: new Date(payload.expiresAt).toISOString()
  }))

  const controller = new AbortController()
  let interrupted: SignalReason | undefined
  const onEarlySignal = (signal: NodeJS.Signals): void => {
    if (signal !== 'SIGINT' && signal !== 'SIGTERM' && signal !== 'SIGHUP') {
      return
    }
    interrupted = signal
    controller.abort(new Error(`Interrupted by ${signal}`))
  }
  process.once('SIGINT', onEarlySignal)
  process.once('SIGTERM', onEarlySignal)
  process.once('SIGHUP', onEarlySignal)

  let session: PreviewSession
  try {
    session = await startPreviewSession({
      cwd,
      config,
      adapters: { tunnel, dns },
      mode,
      hostname,
      zone,
      keep: options.keep,
      autoStopAfterMs,
      configSource: source,
      signal: controller.signal,
      events,
      onLog: options.verbose
        ? line => process.stderr.write(`${theme.dim('[log]')} ${line}\n`)
        : undefined
    })
  }
  catch (error) {
    process.off('SIGINT', onEarlySignal)
    process.off('SIGTERM', onEarlySignal)
    process.off('SIGHUP', onEarlySignal)

    if (interrupted) {
      process.exitCode = interrupted === 'SIGINT' ? 130 : 143
      return
    }
    throw error
  }

  process.off('SIGINT', onEarlySignal)
  process.off('SIGTERM', onEarlySignal)
  process.off('SIGHUP', onEarlySignal)

  pendingReapSessionId = session.sessionId

  reporter.human(`${theme.ok('✔')} local  ${theme.url(session.localUrl)}\n`)
  if (session.dns && session.hostname) {
    reporter.human(`${theme.ok('✔')} dns    ${session.hostname} ${theme.dim(`(${session.dns.type} → ${session.dns.content})`)}\n`)
  }
  reporter.human(`${theme.ok('✔')} public ${theme.url(session.publicUrl)}\n`)

  await reporter.ready({
    type: 'ready',
    url: session.publicUrl,
    localUrl: session.localUrl,
    hostname: session.hostname,
    tunnelId: session.tunnel.tunnelId,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt
  })

  reporter.human(`${theme.dim('Press Ctrl+C to stop.')}\n`)

  if (options.keep) {
    reporter.warn(`--keep: resources will stay until you run flash-tunnel clean --session ${session.sessionId}`)
  }

  const reason = await waitForStop(session)

  if (reason === 'tunnel-exit') {
    reporter.error(new Error('cloudflared exited unexpectedly'), 'TUNNEL_EXITED')
    process.exitCode = 5
  }
  else if (reason === 'server-exit') {
    reporter.error(new Error('dev server exited unexpectedly'), 'SERVER_EXITED')
    process.exitCode = 3
  }
  else if (reason === 'SIGINT') {
    process.exitCode = 130
  }
  else if (reason === 'SIGTERM' || reason === 'SIGHUP') {
    process.exitCode = 143
  }
  else {
    reporter.log(`${theme.dim(reason === 'auto-stop' ? 'Auto-stop reached; cleaning up...' : 'Stopping...')}\n`)
  }

  const removeEscalation = installInterruptEscalation()
  let stoppedCleanly = false
  try {
    await session.stop()
    stoppedCleanly = true
  }
  catch (error) {
    if (error instanceof CleanupError) {
      if (!reporter.json) {
        process.stderr.write(`${themeStderr.err('✖')} cleanup incomplete\n`)
        for (const failure of error.failures) {
          process.stderr.write(`  ${failure.step}: ${failure.error}\n`)
        }
      }
      process.exitCode = 8
    }
    else {
      throw error
    }
  }
  finally {
    removeEscalation()
    if (stoppedCleanly) {
      pendingReapSessionId = undefined
    }
  }

  if (options.keep) {
    reporter.human(`${theme.dim(`Kept resources. Clean up later: flash-tunnel clean --session ${session.sessionId}`)}\n`)
  }
}

function formatSession(state: SessionState): string {
  const target = state.dns?.hostname ?? state.tunnel?.publicUrl ?? '(none)'
  const alive = isProcessAlive(state.pid) ? 'alive' : 'dead'
  return `${state.sessionId}  ${state.state}  ${alive}  ${state.projectRoot}  ${target}`
}

async function runClean(options: CleanOptions, reporter: Reporter): Promise<void> {
  if (!options.session && !options.stale && !options.all) {
    const states = await listSessionStates()
    if (states.length === 0) {
      reporter.human(`${theme.dim('No leftover sessions.')}\n`)
      return
    }
    for (const state of states) {
      reporter.event({
        type: 'session',
        sessionId: state.sessionId,
        state: state.state,
        pid: state.pid,
        alive: isProcessAlive(state.pid),
        projectRoot: state.projectRoot,
        target: state.dns?.hostname ?? state.tunnel?.publicUrl ?? null
      })
      reporter.human(`${formatSession(state)}\n`)
    }
    reporter.human(`${theme.dim('Use --session <id>, --stale or --all --yes to clean.')}\n`)
    return
  }

  if (options.all && !options.yes) {
    throw new FlashTunnelError('clean --all requires --yes', { code: 'CONFIRM_REQUIRED', exitCode: 2 })
  }

  const results = await cleanSessionsFor(options)

  if (results.length === 0) {
    reporter.human(`${theme.dim('No matching sessions.')}\n`)
    return
  }

  let failed = 0
  for (const result of results) {
    reporter.event({
      type: 'clean',
      sessionId: result.sessionId,
      status: result.status,
      actions: result.actions,
      reasons: result.reasons
    })

    const label = result.status === 'removed' || result.status === 'would-remove'
      ? theme.ok(result.status)
      : result.status === 'failed'
        ? theme.err(result.status)
        : theme.warn(result.status)

    let line = `${label} ${result.sessionId}`
    if (result.actions.length > 0) {
      line += `  ${result.actions.join(', ')}`
    }
    if (result.reasons.length > 0) {
      line += `  ${result.reasons.join('; ')}`
    }
    reporter.human(`${line}\n`)

    if (result.status === 'failed') {
      failed += 1
    }
  }

  if (failed > 0) {
    process.exitCode = 8
  }
}

async function cleanSessionsFor(options: CleanOptions): Promise<CleanSessionResult[]> {
  return cleanSessions({
    sessionId: options.session,
    projectRoot: options.project ? resolve(options.project) : undefined,
    staleOnly: options.stale,
    all: options.all,
    force: options.force,
    dryRun: options.dryRun,
    cleaner: options.dryRun ? undefined : createCleaner()
  })
}

function exitCodeFor(error: unknown): number {
  if (error instanceof FlashTunnelError) {
    return error.exitCode
  }
  if (error instanceof CleanupError) {
    return 8
  }
  if (error instanceof AdapterError) {
    if (/^(?:AUTH|TOKEN|PERMISSION|ACCOUNT)/.test(error.code)) {
      return 4
    }
    if (/^(?:DNS|ZONE|RECORD)/.test(error.code)) {
      return 6
    }
    if (error.code.startsWith('TUNNEL')) {
      return 5
    }
    if (/^(?:PUBLIC|VERIFY)/.test(error.code)) {
      return 7
    }
  }
  if (error instanceof ProjectLockedError) {
    return 2
  }
  if (error instanceof TypeError && /config|flash-tunnel\.ts/i.test(error.message)) {
    return 2
  }
  return 1
}

function reportError(error: unknown, reporter: Reporter): void {
  const code = error instanceof FlashTunnelError || error instanceof AdapterError
    ? error.code
    : undefined
  const hint = error instanceof FlashTunnelError ? error.hint : undefined

  reporter.error(error, code, hint)

  if (process.env.FLASH_TUNNEL_DEBUG === '1' && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`)
  }

  process.exitCode = exitCodeFor(error)
}

async function runStart(options: StartOptions = {}): Promise<void> {
  const reporter = new Reporter({
    ...options,
    cwd: resolve(options.cwd ?? process.cwd())
  })

  try {
    await startPreview(options, reporter)
  }
  catch (error) {
    reportError(error, reporter)
  }
  finally {
    reporter.exit(Number(process.exitCode ?? 0))
  }
}

async function runCleanCommand(options: CleanOptions = {}): Promise<void> {
  const reporter = new Reporter({ ...options })

  try {
    await runClean(options, reporter)
  }
  catch (error) {
    reportError(error, reporter)
  }
  finally {
    reporter.exit(Number(process.exitCode ?? 0))
  }
}

async function runInitCommand(options: InitCommandOptions = {}): Promise<void> {
  const reporter = new Reporter({
    ...options,
    cwd: resolve(options.cwd ?? process.cwd())
  })

  try {
    await runInit(options, reporter)
  }
  catch (error) {
    reportError(error, reporter)
  }
  finally {
    reporter.exit(Number(process.exitCode ?? 0))
  }
}

async function runDoctorCommand(options: DoctorCommandOptions = {}): Promise<void> {
  const reporter = new Reporter({
    ...options,
    cwd: resolve(options.cwd ?? process.cwd())
  })

  try {
    await runDoctor(options, reporter)
  }
  catch (error) {
    reportError(error, reporter)
  }
  finally {
    reporter.exit(Number(process.exitCode ?? 0))
  }
}

function runProvidersCommand(options: { json?: boolean, silent?: boolean } = {}): void {
  runProviders(new Reporter(options))
}

async function runReapCommand(sessionId: string, force: boolean): Promise<void> {
  try {
    const result = await reapSession(sessionId, { cleaner: createCleaner(), force })
    if (result.status === 'failed') {
      process.stderr.write(`${theme.err('✖')} reaper could not clean ${sessionId}: ${result.reasons.join('; ')}\n`)
      process.exitCode = 8
    }
  }
  catch (error) {
    process.stderr.write(`${theme.err('✖')} reaper failed for ${sessionId}: ${errorMessage(error)}\n`)
    process.exitCode = 8
  }
}

function findReapSessionId(argv: string[]): string | undefined {
  const index = argv.indexOf('--session')
  return index >= 0 ? argv[index + 1] : undefined
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  installExitReaper()

  if (argv.includes('--no-color')) {
    process.env.NO_COLOR = '1'
  }

  if (argv.includes('__reap')) {
    const sessionId = findReapSessionId(argv)
    if (!sessionId) {
      process.stderr.write('__reap requires --session <id>\n')
      process.exitCode = 2
      return
    }
    await runReapCommand(sessionId, argv.includes('--force'))
    return
  }

  const cli = cac('flash-tunnel')

  cli
    .command('[root]', 'Start a temporary public preview')
    .option('--cwd <dir>', 'Project directory')
    .option('--port <port>', 'Preferred local port')
    .option('--command <command>', 'Command used to start the local server')
    .option('--url <url>', 'Reuse an already running server')
    .option('--mode <mode>', 'Tunnel mode: quick or named')
    .option('--zone <domain>', 'Cloudflare zone')
    .option('--hostname <fqdn>', 'Full public hostname')
    .option('--auto-stop <duration>', 'Stop and clean up after a duration, e.g. 2h')
    .option('--keep', 'Keep DNS and tunnel after exit')
    .option('--no-sweep', 'Do not scan for leftover sessions at startup')
    .option('--verbose', 'Stream dev server and cloudflared logs')
    .option('--json', 'Machine-readable NDJSON on stdout')
    .option('--silent', 'Only print errors')
    .option('--ready-file <path>', 'Write the ready payload to a file')
    .option('--on-ready <command>', 'Run a command once the preview is ready')
    .option('--no-open', 'Do not open the preview in a browser')
    .option('--no-color', 'Disable colors')
    .option('--no-spinner', 'Disable the spinner')
    .action((_root: unknown, options: StartOptions = {}) => runStart(options))

  cli
    .command('start', 'Start a temporary public preview')
    .option('--cwd <dir>', 'Project directory')
    .option('--port <port>', 'Preferred local port')
    .option('--command <command>', 'Command used to start the local server')
    .option('--url <url>', 'Reuse an already running server')
    .option('--mode <mode>', 'Tunnel mode: quick or named')
    .option('--zone <domain>', 'Cloudflare zone')
    .option('--hostname <fqdn>', 'Full public hostname')
    .option('--auto-stop <duration>', 'Stop and clean up after a duration, e.g. 2h')
    .option('--keep', 'Keep DNS and tunnel after exit')
    .option('--no-sweep', 'Do not scan for leftover sessions at startup')
    .option('--verbose', 'Stream dev server and cloudflared logs')
    .option('--json', 'Machine-readable NDJSON on stdout')
    .option('--silent', 'Only print errors')
    .option('--ready-file <path>', 'Write the ready payload to a file')
    .option('--on-ready <command>', 'Run a command once the preview is ready')
    .option('--no-open', 'Do not open the preview in a browser')
    .option('--no-color', 'Disable colors')
    .option('--no-spinner', 'Disable the spinner')
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
    .option('--json', 'Machine-readable NDJSON on stdout')
    .option('--silent', 'Only print errors')
    .action((options: CleanOptions = {}) => runCleanCommand(options))

  cli
    .command('doctor', 'Check the environment and configuration')
    .option('--cwd <dir>', 'Project directory')
    .option('--json', 'Machine-readable NDJSON on stdout')
    .option('--silent', 'Only print errors')
    .action((options: DoctorCommandOptions = {}) => runDoctorCommand(options))

  cli
    .command('init', 'Create flash-tunnel.ts and ignore .flash-tunnel/')
    .option('--cwd <dir>', 'Project directory')
    .option('--force', 'Overwrite an existing flash-tunnel.ts')
    .option('--json', 'Machine-readable NDJSON on stdout')
    .option('--silent', 'Only print errors')
    .action((options: InitCommandOptions = {}) => runInitCommand(options))

  cli
    .command('providers', 'List available adapters')
    .option('--json', 'Machine-readable NDJSON on stdout')
    .option('--silent', 'Only print errors')
    .action((options: { json?: boolean, silent?: boolean } = {}) => runProvidersCommand(options))

  cli.help()
  cli.version(readVersion())
  cli.parse(argv)
}
