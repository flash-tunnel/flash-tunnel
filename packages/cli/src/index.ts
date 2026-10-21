import type { FlashTunnelConfig } from '@flash-tunnel/config'
import type {
  CleanSessionResult,
  PreviewSession,
  ResolveConfigInput,
  ResolvedConfig,
  SessionCleaner,
  SessionState
} from '@flash-tunnel/core'
import type { AdapterContext, FlashTunnelEvents } from '@flash-tunnel/types'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { CloudflareApi, createCloudflareDns, createCloudflareTunnel } from '@flash-tunnel/adapter-cloudflare'
import {
  cleanSession,
  cleanSessions,
  CleanupError,
  detectServer,
  detectWorkspaceCandidates,
  Emitter,
  findStaleSessions,
  FlashTunnelError,
  isProcessAlive,
  listSessionStates,
  loadDnsAdapter,
  loadFlashTunnelConfig,
  loadTunnelAdapter,
  ProjectLockedError,
  reapSession,
  resolveConfig,
  sameProject,
  startPreviewSession,
  validateAdapterCombination
} from '@flash-tunnel/core'
import { AdapterError } from '@flash-tunnel/types'
import { formatDuration, redact } from '@flash-tunnel/utils'
import { cac } from 'cac'
import { isPortAvailable, runBuildScript } from './commands/build'
import { runDoctor } from './commands/doctor'
import { runInit } from './commands/init'
import { runProviders } from './commands/providers'
import { copyToClipboard } from './ui/clipboard'
import { openUrl } from './ui/open'
import {
  canPrompt,
  choosePortConflict,
  chooseWorkspace,
  chooseZone,
  confirmKeep,
  confirmOverwrite,
  confirmQuickFallback
} from './ui/prompts'
import { Reporter } from './ui/reporter'
import { installShortcuts } from './ui/shortcuts'
import { StepUi } from './ui/steps'
import { symbols } from './ui/symbols'
import { theme, themeStderr } from './ui/theme'

interface StartOptions {
  cwd?: string
  config?: string
  port?: string
  command?: string
  url?: string
  mode?: string
  zone?: string
  hostname?: string
  subdomain?: string
  static?: string | boolean
  attach?: boolean
  dev?: boolean
  build?: boolean
  reuse?: boolean
  overwrite?: boolean
  allowMultilevel?: boolean
  dryRun?: boolean
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
  spinner?: boolean
  yes?: boolean
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
  config?: string
  json?: boolean
  silent?: boolean
}

type SignalReason = 'SIGINT' | 'SIGHUP' | 'SIGTERM'
type StopReason = SignalReason | 'auto-stop' | 'fatal' | 'quit' | 'server-exit' | 'tunnel-exit'

interface StopOutcome {
  reason: StopReason
  error?: unknown
}

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

function waitForStop(session: PreviewSession, quit?: Promise<void>): Promise<StopOutcome> {
  return new Promise((resolveStop) => {
    let finished = false

    function finish(reason: StopReason, error?: unknown): void {
      if (finished) {
        return
      }
      finished = true
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      process.off('SIGHUP', onSighup)
      process.off('uncaughtException', onUncaught)
      process.off('unhandledRejection', onUnhandledRejection)
      resolveStop({ reason, error })
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

    function onUncaught(error: Error): void {
      finish('fatal', error)
    }

    function onUnhandledRejection(reason: unknown): void {
      finish('fatal', reason instanceof Error ? reason : new Error(String(reason)))
    }

    process.once('SIGINT', onSigint)
    process.once('SIGTERM', onSigterm)
    process.once('SIGHUP', onSighup)
    process.once('uncaughtException', onUncaught)
    process.once('unhandledRejection', onUnhandledRejection)

    session.exited.then(() => {
      if (!session.stopping) {
        finish('tunnel-exit')
      }
    })
    session.autoStopped?.then(() => finish('auto-stop'))
    quit?.then(() => finish('quit'))
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
    process.stderr.write(`\n${theme.warn(symbols.warn)} forced exit (${signal}); leftover resources will be cleaned by the next run\n`)
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
      if (state.dns.provider !== 'cloudflare') {
        throw new Error(`No DNS cleaner is registered for provider "${state.dns.provider}"`)
      }
      try {
        const records = await api.listDnsRecords(state.dns.zoneId, { name: state.dns.hostname })
        const record = records.find(item => item.id === state.dns?.recordId)

        if (!record) {
          return
        }
        if (!record.comment?.startsWith('flash-tunnel:')) {
          throw new Error(
            `Refusing to delete DNS record ${record.id}: it was not created by flash-tunnel`
          )
        }

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
      if (state.tunnel.provider !== 'cloudflare') {
        throw new Error(`No tunnel cleaner is registered for provider "${state.tunnel.provider}"`)
      }
      if (!state.tunnel.accountId) {
        throw new Error('Session is missing the Cloudflare account id')
      }

      try {
        const tunnel = await api.getTunnel(state.tunnel.accountId, state.tunnel.tunnelId)
        if (tunnel.name !== state.tunnel.name) {
          throw new Error(
            `Refusing to delete tunnel ${state.tunnel.tunnelId}: name does not match the session record`
          )
        }
      }
      catch (error) {
        if (error instanceof AdapterError && error.code === 'NOT_FOUND') {
          return
        }
        throw error
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

function printEffectiveConfig(resolved: ResolvedConfig, reporter: Reporter): void {
  reporter.event({
    type: 'dry-run',
    configFile: resolved.configFile ?? null,
    config: resolved.values,
    sources: resolved.sources,
    warnings: resolved.warnings
  })

  if (reporter.json) {
    return
  }

  reporter.human(`${theme.bold('Effective configuration')}${resolved.configFile ? `  ${theme.dim(resolved.configFile)}` : ''}\n`)

  const rows: Array<[string, string | number | undefined]> = [
    ['domain.zone', resolved.values.domain.zone],
    ['domain.hostname', resolved.values.domain.hostname],
    ['domain.provider', resolved.values.domain.provider],
    ['domain.subdomain', resolved.values.domain.subdomain],
    ['server.command', resolved.values.server.command],
    ['server.cwd', resolved.values.server.cwd],
    ['server.port', resolved.values.server.port],
    ['server.url', resolved.values.server.url],
    ['server.dir', resolved.values.server.dir],
    ['server.timeout', resolved.values.server.timeout],
    ['tunnel.provider', resolved.values.tunnel.provider],
    ['tunnel.mode', resolved.values.tunnel.mode],
    ['tunnel.name', resolved.values.tunnel.name],
    ['providers.cloudflare.accountId', resolved.values.providers.cloudflare.accountId],
    ['providers.cloudflare.zoneId', resolved.values.providers.cloudflare.zoneId],
    ['providers.cloudflare.cloudflaredPath', resolved.values.providers.cloudflare.cloudflaredPath],
    ['autoStopAfter', resolved.values.autoStopAfter === undefined ? 'off' : formatDuration(resolved.values.autoStopAfter)]
  ]

  for (const [key, value] of rows) {
    const info = resolved.sources[key]
    const source = info
      ? theme.dim(`(${info.source}${info.note ? `: ${info.note}` : ''})`)
      : ''
    reporter.human(`  ${key.padEnd(32)} ${String(value ?? '-').padEnd(28)} ${source}\n`)
  }

  for (const warning of resolved.warnings) {
    reporter.warn(warning)
  }
}

function buildEffectiveConfig(
  config: FlashTunnelConfig,
  resolved: ResolvedConfig
): FlashTunnelConfig {
  return {
    ...config,
    domain: {
      ...config.domain,
      provider: resolved.values.domain.provider,
      zone: resolved.values.domain.zone,
      subdomain: resolved.values.domain.subdomain
    },
    server: {
      command: resolved.values.server.command,
      cwd: resolved.values.server.cwd,
      port: resolved.values.server.port,
      url: resolved.values.server.url,
      dir: resolved.values.server.dir,
      timeout: resolved.values.server.timeout
    },
    tunnel: {
      ...config.tunnel,
      provider: resolved.values.tunnel.provider,
      mode: resolved.values.tunnel.mode,
      name: resolved.values.tunnel.name
    },
    providers: {
      ...config.providers,
      cloudflare: {
        ...config.providers?.cloudflare,
        ...resolved.values.providers.cloudflare
      }
    },
    autoStopAfter: resolved.values.autoStopAfter
  }
}

async function startPreview(options: StartOptions, reporter: Reporter): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd())

  let loaded: Awaited<ReturnType<typeof loadFlashTunnelConfig>>
  try {
    loaded = await loadFlashTunnelConfig(cwd, { config: options.config })
  }
  catch (error) {
    throw new FlashTunnelError(`Failed to load flash-tunnel.ts: ${errorMessage(error)}`, {
      code: 'CONFIG_LOAD_FAILED',
      exitCode: 2,
      cause: error
    })
  }

  const { config: loadedConfig, source } = loaded
  let config = loadedConfig

  if (source) {
    reporter.log(`${theme.dim('config')} ${source}\n`)
  }

  if (!options.dryRun && !options.noSweep && options.sweep !== false) {
    await sweepStale(cwd, reporter).catch((error) => {
      reporter.warn(`sweep failed: ${errorMessage(error)}`)
    })
  }

  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const apiBase = process.env.FLASH_TUNNEL_CLOUDFLARE_API_BASE
  const cliConfig: NonNullable<ResolveConfigInput['cli']> = {
    zone: options.zone,
    hostname: options.hostname,
    subdomain: options.subdomain,
    mode: options.mode,
    command: options.command,
    port: options.port,
    url: options.url,
    static: options.static === true ? true : typeof options.static === 'string' ? options.static : undefined,
    attach: options.attach,
    dev: options.dev,
    overwrite: options.overwrite,
    allowMultilevel: options.allowMultilevel,
    autoStop: options.autoStop
  }

  let preliminary = resolveConfig({
    cwd,
    config,
    configFile: source,
    cli: cliConfig
  })

  if (options.build && !options.dryRun) {
    runBuildScript(preliminary.values.server.cwd, reporter)
  }

  const requiresCloudflare = preliminary.values.tunnel.provider === 'cloudflare'
    || preliminary.values.domain.provider === 'cloudflare'

  if (preliminary.values.tunnel.mode === 'named' && requiresCloudflare && !apiToken && !options.dryRun) {
    if (canPrompt(options) && await confirmQuickFallback()) {
      cliConfig.mode = 'quick'
    }
    else {
      throw new FlashTunnelError('Named mode requires CLOUDFLARE_API_TOKEN', {
        code: 'AUTH_MISSING',
        exitCode: 4,
        hint: 'Export CLOUDFLARE_API_TOKEN, or use --mode quick for a temporary domain'
      })
    }
  }

  let inferredZone: string | undefined
  let zoneIssue: string | undefined
  if (
    preliminary.values.tunnel.mode === 'named'
    && preliminary.values.domain.provider === 'cloudflare'
    && !preliminary.values.domain.zone
    && apiToken
  ) {
    const api = new CloudflareApi({ apiToken, apiBase })
    const zones = (await api.listZones()).filter(item => item.status === 'active')
    if (zones.length === 1 && zones[0]) {
      inferredZone = zones[0].name
    }
    else if (zones.length === 0) {
      zoneIssue = 'No active Cloudflare zone is visible to this token'
    }
    else if (canPrompt(options)) {
      inferredZone = await chooseZone(zones)
    }
    else {
      zoneIssue = `Multiple zones found (${zones.map(item => item.name).join(', ')})`
    }
  }

  let detected: {
    command?: string
    port?: number
    dir?: string
    url?: string
    mode?: string
    framework?: string
    reason?: string
  } | undefined
  let detectionError: unknown
  try {
    const plan = detectServer(cwd, {
      cwd: preliminary.values.server.cwd,
      command: preliminary.values.server.command,
      port: preliminary.values.server.port,
      url: preliminary.values.server.url,
      dir: preliminary.values.server.dir,
      timeout: preliminary.values.server.timeout
    }, {
      forceDev: options.dev,
      forceStatic: options.static !== undefined
    })
    detected = {
      command: plan.command,
      port: plan.port,
      dir: plan.mode === 'static' ? plan.dir : undefined,
      mode: plan.mode,
      framework: plan.framework,
      reason: plan.reason
    }
  }
  catch (error) {
    detectionError = error

    if (/No runnable script/.test(errorMessage(error))) {
      const candidates = detectWorkspaceCandidates(cwd)

      if (candidates.length > 0) {
        if (!canPrompt(options)) {
          throw new FlashTunnelError('No runnable script found in the project root', {
            code: 'WORKSPACE_REQUIRED',
            exitCode: 2,
            hint: `Pass --cwd <path>. Candidates: ${candidates.map(candidate => candidate.cwd).join(', ')}`
          })
        }

        const choice = await chooseWorkspace(candidates)
        config = { ...config, server: { ...config.server, cwd: choice.cwd } }
        preliminary = resolveConfig({ cwd, config, configFile: source, cli: cliConfig })

        try {
          const plan = detectServer(cwd, {
            cwd: preliminary.values.server.cwd,
            command: preliminary.values.server.command,
            port: preliminary.values.server.port,
            url: preliminary.values.server.url,
            dir: preliminary.values.server.dir,
            timeout: preliminary.values.server.timeout
          }, {
            forceDev: options.dev,
            forceStatic: options.static !== undefined
          })
          detected = {
            command: plan.command,
            port: plan.port,
            dir: plan.mode === 'static' ? plan.dir : undefined,
            mode: plan.mode,
            framework: plan.framework,
            reason: plan.reason
          }
          detectionError = undefined
        }
        catch (retryError) {
          detectionError = retryError
        }
      }
    }
  }

  let reusedPort = false
  if (detected?.port && detected.port > 0 && !preliminary.values.server.url && !options.attach) {
    if (!await isPortAvailable(detected.port)) {
      const reuse = options.reuse
        || (canPrompt(options) && await choosePortConflict(detected.port) === 'reuse')

      if (!reuse) {
        throw new FlashTunnelError(`Port ${detected.port} is already in use`, {
          code: 'PORT_IN_USE',
          exitCode: 3,
          hint: 'Stop the other process, pass --port <n>, or use --reuse'
        })
      }

      detected = {
        port: detected.port,
        url: `http://127.0.0.1:${detected.port}`,
        mode: 'attach',
        framework: detected.framework,
        reason: `port ${detected.port} is in use; reusing the running server`
      }
      reusedPort = true
    }
  }

  const resolved = resolveConfig({
    cwd,
    config,
    configFile: source,
    cli: cliConfig,
    detected,
    ...(inferredZone ? { inferredZone } : {})
  })

  if (detectionError) {
    resolved.warnings.push(`Server detection failed: ${errorMessage(detectionError)}`)
  }
  for (const warning of resolved.warnings) {
    reporter.warn(warning)
  }

  if (options.dryRun) {
    printEffectiveConfig(resolved, reporter)
    return
  }

  const mode = resolved.values.tunnel.mode
  const zone = resolved.values.domain.zone

  if (
    mode === 'named'
    && !zone
    && (resolved.values.tunnel.provider === 'cloudflare' || resolved.values.domain.provider === 'cloudflare')
  ) {
    throw new FlashTunnelError(zoneIssue ?? 'Named mode requires a zone', {
      code: zoneIssue ? 'ZONE_NOT_FOUND' : 'ZONE_REQUIRED',
      exitCode: 2,
      hint: 'Set domain.zone in flash-tunnel.ts or pass --zone'
    })
  }

  const hostname = mode === 'named' ? resolved.values.domain.hostname : undefined
  const autoStopAfterMs = resolved.values.autoStopAfter
  const effectiveConfig = buildEffectiveConfig(config, resolved)
  if (reusedPort) {
    effectiveConfig.server = {
      ...effectiveConfig.server,
      command: undefined,
      dir: undefined,
      url: `http://127.0.0.1:${detected?.port}`
    }
  }

  const tunnelProvider = resolved.values.tunnel.provider
  const domainProvider = resolved.values.domain.provider
  const tunnel = tunnelProvider === 'cloudflare'
    ? createCloudflareTunnel({
        cloudflaredPath: resolved.values.providers.cloudflare.cloudflaredPath,
        accountId: resolved.values.providers.cloudflare.accountId,
        apiToken,
        apiBase,
        originRequest: resolved.values.providers.cloudflare.originRequest
      })
    : await loadTunnelAdapter(tunnelProvider, resolved.configDir)

  const dns = mode !== 'named'
    ? undefined
    : domainProvider === 'cloudflare'
      ? apiToken
        ? createCloudflareDns({
            apiToken,
            zoneId: resolved.values.providers.cloudflare.zoneId,
            apiBase
          })
        : undefined
      : await loadDnsAdapter(domainProvider, resolved.configDir)

  const combination = validateAdapterCombination({
    tunnel,
    dns,
    mode,
    requested: {
      hostname: Boolean(options.hostname ?? process.env.FLASH_TUNNEL_HOSTNAME),
      zone: Boolean(options.zone ?? process.env.FLASH_TUNNEL_ZONE ?? config.domain?.zone),
      subdomain: Boolean(options.subdomain ?? config.domain?.subdomain)
    }
  })
  for (const warning of combination.warnings) {
    reporter.warn(warning)
  }

  let overwrite = options.overwrite ?? false
  if (mode === 'named' && dns && zone && hostname) {
    const preflightCtx: AdapterContext = {
      sessionId: 'ft_preflight',
      cwd,
      signal: new AbortController().signal,
      now: Date.now,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message: string) => reporter.warn(message),
        error: (message: string) => reporter.warn(message)
      }
    }

    try {
      await dns.preflight(preflightCtx, {
        zone,
        name: hostname,
        type: tunnel.capabilities.dns?.type ?? 'CNAME',
        overwrite
      })
    }
    catch (error) {
      if (error instanceof AdapterError && error.code === 'RECORD_CONFLICT' && canPrompt(options)) {
        overwrite = await confirmOverwrite(hostname)
        if (!overwrite) {
          throw error
        }
        reporter.warn(`Overwriting the existing DNS record for ${hostname}`)
      }
      else {
        throw error
      }
    }
  }

  let keep = options.keep ?? false
  if (keep && canPrompt(options)) {
    keep = await confirmKeep()
    if (!keep) {
      reporter.log(`${theme.dim('--keep cancelled; resources will be removed on exit.')}\n`)
    }
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

  const steps = new StepUi(reporter, {
    enabled: options.spinner === false ? false : undefined
  })
  events.on('step', payload => steps.handle(payload))

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
      config: effectiveConfig,
      adapters: { tunnel, dns },
      mode,
      hostname,
      zone,
      keep,
      overwrite,
      autoStopAfterMs,
      configSource: source,
      signal: controller.signal,
      events,
      onLog: options.verbose
        ? line => process.stderr.write(`${theme.dim('[log]')} ${redact(line)}\n`)
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

  reporter.human(`${theme.ok(symbols.ok)} local  ${theme.url(session.localUrl)}\n`)
  if (session.dns && session.hostname) {
    reporter.human(`${theme.ok(symbols.ok)} dns    ${session.hostname} ${theme.dim(`(${session.dns.type} → ${session.dns.content})`)}\n`)
  }
  reporter.human(`${theme.ok(symbols.ok)} public ${theme.url(session.publicUrl)}\n`)

  await reporter.ready({
    type: 'ready',
    url: session.publicUrl,
    localUrl: session.localUrl,
    hostname: session.hostname,
    tunnelId: session.tunnel.tunnelId,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt
  })

  if (
    !options.noOpen
    && !reporter.json
    && process.stdout.isTTY
    && !process.env.CI
    && process.env.FLASH_TUNNEL_NO_OPEN !== '1'
  ) {
    openUrl(session.publicUrl)
  }

  reporter.human(`${theme.dim('Press Ctrl+C to stop. c copies the URL, o opens it, q quits.')}\n`)

  if (keep) {
    reporter.warn(`--keep: resources will stay until you run flash-tunnel clean --session ${session.sessionId}`)
  }

  let requestQuit: () => void = () => {}
  const quit = new Promise<void>((resolveQuit) => {
    requestQuit = resolveQuit
  })
  const disposeShortcuts = installShortcuts({
    onQuit: () => requestQuit(),
    onCopy: () => {
      if (copyToClipboard(session.publicUrl)) {
        reporter.log(`${theme.dim('copied')} ${session.publicUrl}\n`)
      }
      else {
        reporter.warn('No clipboard tool found; copy the URL manually')
      }
    },
    onOpen: () => openUrl(session.publicUrl)
  })

  let outcome: StopOutcome
  try {
    outcome = await waitForStop(session, quit)
  }
  finally {
    disposeShortcuts()
  }

  const { reason, error: fatalError } = outcome

  if (reason === 'fatal') {
    reportError(fatalError ?? new Error('Unexpected failure'), reporter)
    process.exitCode = 1
  }
  else if (reason === 'tunnel-exit') {
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
        process.stderr.write(`${themeStderr.err(symbols.fail)} cleanup incomplete\n`)
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

  if (keep) {
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
    const projectRoot = options.project ? resolve(options.project) : undefined
    const states = (await listSessionStates())
      .filter(state => !projectRoot || sameProject(state, projectRoot))

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
      process.stderr.write(`${theme.err(symbols.fail)} reaper could not clean ${sessionId}: ${result.reasons.join('; ')}\n`)
      process.exitCode = 8
    }
  }
  catch (error) {
    process.stderr.write(`${theme.err(symbols.fail)} reaper failed for ${sessionId}: ${errorMessage(error)}\n`)
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
    .option('--config <path>', 'Path to flash-tunnel.ts')
    .option('--port <port>', 'Preferred local port')
    .option('--command <command>', 'Command used to start the local server')
    .option('--url <url>', 'Reuse an already running server')
    .option('--attach', 'Only attach; requires --url')
    .option('--static [dir]', 'Serve a static directory')
    .option('--dev', 'Force the dev script')
    .option('--build', 'Run the build script before starting')
    .option('--reuse', 'Reuse a server already listening on the port')
    .option('--mode <mode>', 'Tunnel mode: quick or named')
    .option('--zone <domain>', 'Cloudflare zone')
    .option('--hostname <fqdn>', 'Full public hostname')
    .option('--subdomain <label>', 'Subdomain label or template')
    .option('--allow-multilevel', 'Allow multi-level subdomains')
    .option('--overwrite', 'Replace DNS records not created by this tool')
    .option('--auto-stop <duration>', 'Stop and clean up after a duration, e.g. 2h')
    .option('--keep', 'Keep DNS and tunnel after exit')
    .option('--no-sweep', 'Do not scan for leftover sessions at startup')
    .option('--verbose', 'Stream dev server and cloudflared logs')
    .option('--json', 'Machine-readable NDJSON on stdout')
    .option('--silent', 'Only print errors')
    .option('--dry-run', 'Print the effective configuration and exit')
    .option('--ready-file <path>', 'Write the ready payload to a file')
    .option('--on-ready <command>', 'Run a command once the preview is ready')
    .option('--no-open', 'Do not open the preview in a browser')
    .option('--no-color', 'Disable colors')
    .option('--no-spinner', 'Disable the spinner')
    .option('-y, --yes', 'Disable prompts and use defaults')
    .action((_root: unknown, options: StartOptions = {}) => runStart(options))

  cli
    .command('start', 'Start a temporary public preview')
    .option('--cwd <dir>', 'Project directory')
    .option('--config <path>', 'Path to flash-tunnel.ts')
    .option('--port <port>', 'Preferred local port')
    .option('--command <command>', 'Command used to start the local server')
    .option('--url <url>', 'Reuse an already running server')
    .option('--attach', 'Only attach; requires --url')
    .option('--static [dir]', 'Serve a static directory')
    .option('--dev', 'Force the dev script')
    .option('--build', 'Run the build script before starting')
    .option('--reuse', 'Reuse a server already listening on the port')
    .option('--mode <mode>', 'Tunnel mode: quick or named')
    .option('--zone <domain>', 'Cloudflare zone')
    .option('--hostname <fqdn>', 'Full public hostname')
    .option('--subdomain <label>', 'Subdomain label or template')
    .option('--allow-multilevel', 'Allow multi-level subdomains')
    .option('--overwrite', 'Replace DNS records not created by this tool')
    .option('--auto-stop <duration>', 'Stop and clean up after a duration, e.g. 2h')
    .option('--keep', 'Keep DNS and tunnel after exit')
    .option('--no-sweep', 'Do not scan for leftover sessions at startup')
    .option('--verbose', 'Stream dev server and cloudflared logs')
    .option('--json', 'Machine-readable NDJSON on stdout')
    .option('--silent', 'Only print errors')
    .option('--dry-run', 'Print the effective configuration and exit')
    .option('--ready-file <path>', 'Write the ready payload to a file')
    .option('--on-ready <command>', 'Run a command once the preview is ready')
    .option('--no-open', 'Do not open the preview in a browser')
    .option('--no-color', 'Disable colors')
    .option('--no-spinner', 'Disable the spinner')
    .option('-y, --yes', 'Disable prompts and use defaults')
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
    .option('--config <path>', 'Path to flash-tunnel.ts')
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
