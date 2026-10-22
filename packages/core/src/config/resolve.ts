import type { FlashTunnelConfig } from '@flash-tunnel/config'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { parseDuration, slugify } from '@flash-tunnel/utils'
import { renderSubdomain } from '../domain'
import { FlashTunnelError } from '../errors'

export type ConfigSource = 'cli' | 'config' | 'default' | 'detected' | 'env' | 'inferred'

export interface ConfigSourceInfo {
  source: ConfigSource
  note?: string
}

export type ConfigSources = Record<string, ConfigSourceInfo>

export interface ResolvedConfigValues {
  domain: {
    provider: string
    zone?: string
    subdomain: string
    hostname?: string
  }
  server: {
    command?: string
    cwd: string
    port?: number
    url?: string
    dir?: string
    timeout: number
  }
  tunnel: {
    provider: string
    mode: 'named' | 'quick'
    name: string
  }
  providers: {
    cloudflare: {
      accountId?: string
      zoneId?: string
      cloudflaredPath: string
      originRequest?: {
        httpHostHeader?: string
        noTLSVerify?: boolean
      }
    }
  }
  autoStopAfter?: number
}

export interface ResolveConfigInput {
  cwd: string
  config: FlashTunnelConfig
  configFile?: string
  env?: NodeJS.ProcessEnv
  cli?: {
    zone?: string
    hostname?: string
    subdomain?: string
    mode?: string
    command?: string
    port?: string | number
    url?: string
    static?: string | true
    attach?: boolean
    dev?: boolean
    overwrite?: boolean
    allowMultilevel?: boolean
    autoStop?: string
    sessionId?: string
  }
  detected?: {
    command?: string
    port?: number
    dir?: string
    url?: string
    mode?: string
    framework?: string
    reason?: string
  }
  inferredZone?: string
}

export interface ResolvedConfig {
  values: ResolvedConfigValues
  sources: ConfigSources
  warnings: string[]
  configDir: string
  configFile?: string
}

const KNOWN_FIELDS = new Set(['domain', 'server', 'tunnel', 'providers', 'autoStopAfter'])

function invalid(message: string, hint?: string, cause?: unknown): FlashTunnelError {
  return new FlashTunnelError(message, {
    code: 'CONFIG_INVALID',
    exitCode: 2,
    hint,
    cause
  })
}

function positiveInteger(value: number, path: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw invalid(`${path} must be a positive integer`, `Remove ${path} or use a positive integer`)
  }
  return value
}

function portNumber(value: string | number, path: string): number {
  const port = typeof value === 'string' ? Number(value) : value
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw invalid(`${path} must be an integer between 0 and 65535`, `Check ${path}`)
  }
  return port
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

type SourceCandidate<T> = readonly [value: T | undefined, source: ConfigSource, note?: string]

interface PickedValue<T> {
  value?: T
  source?: ConfigSource
  note?: string
}

/**
 * First candidate that is present, together with where it came from. Keeping the
 * value and its origin in one list stops the two from drifting apart, which is
 * the main hazard of parallel `a ?? b ?? c` chains.
 */
function firstOf<T>(...candidates: SourceCandidate<T>[]): PickedValue<T> {
  for (const [value, source, note] of candidates) {
    if (value !== undefined) {
      return { value, source, note }
    }
  }
  return {}
}

function validateHostname(hostname: string): string {
  if (hostname.length > 253) {
    throw invalid(`Hostname is too long (${hostname.length} characters; maximum 253)`)
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname) || hostname.includes('..')) {
    throw invalid(`Invalid hostname "${hostname}"`, 'Use letters, digits, dots and hyphens')
  }
  return hostname
}

function validateZone(zone: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(zone)) {
    throw invalid(`Invalid zone "${zone}"`, 'Use a domain like example.com')
  }
  return zone.toLowerCase()
}

/**
 * Merge CLI, environment, config file and detection results into one effective
 * configuration and record where every value came from.
 */
export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
  const env = input.env ?? process.env
  const config = input.config
  const cli = input.cli ?? {}
  const configDir = input.configFile ? dirname(input.configFile) : resolve(input.cwd)
  const sources: ConfigSources = {}
  const warnings: string[] = []

  const setSource = (path: string, source: ConfigSource, note?: string): void => {
    sources[path] = note ? { source, note } : { source }
  }

  for (const field of Object.keys(config)) {
    if (!KNOWN_FIELDS.has(field)) {
      warnings.push(`Unknown configuration field "${field}"`)
    }
  }

  const project = slugify(basename(input.cwd))

  const zonePick = firstOf<string>(
    [optionalString(cli.zone), 'cli'],
    [optionalString(env.FLASH_TUNNEL_ZONE), 'env'],
    [optionalString(config.domain?.zone), 'config']
  )
  let zone: string | undefined
  if (zonePick.value) {
    zone = validateZone(zonePick.value)
    setSource('domain.zone', zonePick.source ?? 'config')
  }
  else if (input.inferredZone) {
    zone = validateZone(input.inferredZone)
    setSource('domain.zone', 'inferred', 'the only active Cloudflare zone')
  }

  const subdomainPick = firstOf<string>(
    [optionalString(cli.subdomain), 'cli'],
    [optionalString(config.domain?.subdomain), 'config']
  )
  const subdomain = subdomainPick.value ?? '{project}-{rand}'
  setSource(
    'domain.subdomain',
    subdomainPick.source ?? 'default',
    subdomainPick.source ? undefined : 'default template'
  )

  const hostnamePick = firstOf<string>(
    [optionalString(cli.hostname), 'cli'],
    [optionalString(env.FLASH_TUNNEL_HOSTNAME), 'env']
  )

  let hostname: string | undefined
  if (hostnamePick.value) {
    hostname = validateHostname(hostnamePick.value)
    setSource('domain.hostname', hostnamePick.source ?? 'env')
  }
  else if (zone) {
    try {
      hostname = validateHostname(`${renderSubdomain({
        cwd: input.cwd,
        template: subdomain,
        sessionId: cli.sessionId,
        allowMultilevel: cli.allowMultilevel
      })}.${zone}`)
      setSource('domain.hostname', 'default', `rendered from ${subdomain}`)
    }
    catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error), 'Check domain.subdomain', error)
    }
  }

  const serverCwdValue = optionalString(config.server?.cwd)
  const serverCwd = serverCwdValue
    ? isAbsolute(serverCwdValue) ? serverCwdValue : resolve(configDir, serverCwdValue)
    : input.configFile ? configDir : resolve(input.cwd)
  setSource('server.cwd', serverCwdValue ? 'config' : 'default')

  const staticValue = typeof cli.static === 'string' ? cli.static : undefined
  const directoryPick = firstOf<string>(
    [staticValue, 'cli'],
    [optionalString(config.server?.dir), 'config'],
    [input.detected?.dir, 'detected']
  )
  let serverDir: string | undefined
  if (directoryPick.value) {
    serverDir = isAbsolute(directoryPick.value)
      ? directoryPick.value
      : resolve(configDir, directoryPick.value)
    setSource('server.dir', directoryPick.source ?? 'config')
  }

  const commandPick = firstOf<string>(
    [optionalString(cli.command), 'cli'],
    [optionalString(env.FLASH_TUNNEL_COMMAND), 'env'],
    [optionalString(config.server?.command), 'config'],
    [optionalString(input.detected?.command), 'detected']
  )
  const command = commandPick.value
  if (command) {
    setSource('server.command', commandPick.source ?? 'detected', input.detected?.reason)
  }

  const urlPick = firstOf<string>(
    [optionalString(cli.url), 'cli'],
    [optionalString(config.server?.url), 'config'],
    [optionalString(input.detected?.url), 'detected']
  )
  const url = urlPick.value
  if (url) {
    if (!URL.canParse(url)) {
      throw invalid(`server.url is not a valid URL: "${url}"`, 'Use http://127.0.0.1:5173 or https://...')
    }
    setSource('server.url', urlPick.source ?? 'detected')
  }

  const portPick = firstOf<string | number>(
    [cli.port, 'cli'],
    [optionalString(env.FLASH_TUNNEL_PORT), 'env'],
    [config.server?.port, 'config'],
    [input.detected?.port, 'detected']
  )
  let port: number | undefined
  if (portPick.value !== undefined && portPick.value !== '') {
    port = portNumber(portPick.value, 'server.port')
    setSource('server.port', portPick.source ?? 'detected')
  }

  const timeout = config.server?.timeout === undefined
    ? 60_000
    : positiveInteger(config.server.timeout, 'server.timeout')
  setSource('server.timeout', config.server?.timeout === undefined ? 'default' : 'config')

  if (url && serverDir) {
    throw invalid('server.url and server.dir cannot be used together', 'Keep only one of server.url or server.dir')
  }
  if (command && serverDir) {
    throw invalid('server.command and server.dir cannot be used together', 'Keep only one of server.command or server.dir')
  }
  if (cli.static !== undefined && url) {
    throw invalid('--static cannot be used with --url', 'Use either --static or --url')
  }
  if (cli.attach && !url) {
    throw invalid('--attach requires --url', 'Pass --url http://127.0.0.1:5173')
  }
  if (cli.attach && command) {
    throw invalid('--attach cannot be used with server.command', 'Attach to a running server instead of starting one')
  }

  const modePick = firstOf<string>(
    [optionalString(cli.mode), 'cli'],
    [optionalString(env.FLASH_TUNNEL_MODE), 'env'],
    [optionalString(config.tunnel?.mode), 'config']
  )
  const modeCandidate = modePick.value ?? 'named'
  if (modeCandidate !== 'named' && modeCandidate !== 'quick') {
    throw invalid(`tunnel.mode must be "named" or "quick" (got "${modeCandidate}")`)
  }
  const mode: 'named' | 'quick' = modeCandidate
  if (mode === 'quick') {
    hostname = undefined
    delete sources['domain.hostname']
  }
  setSource('tunnel.mode', modePick.source ?? 'default')

  const tunnelProviderPick = firstOf<string>(
    [optionalString(env.FLASH_TUNNEL_TUNNEL_PROVIDER), 'env'],
    [optionalString(config.tunnel?.provider), 'config']
  )
  const tunnelProvider = tunnelProviderPick.value ?? 'cloudflare'
  setSource('tunnel.provider', tunnelProviderPick.source ?? 'default')

  const domainProviderPick = firstOf<string>(
    [optionalString(env.FLASH_TUNNEL_DNS_PROVIDER), 'env'],
    [optionalString(config.domain?.provider), 'config']
  )
  const domainProvider = domainProviderPick.value ?? 'cloudflare'
  setSource('domain.provider', domainProviderPick.source ?? 'default')

  const tunnelNameTemplate = optionalString(config.tunnel?.name)
    ?? `flash-tunnel-${project}-{rand}`
  let tunnelName: string
  try {
    tunnelName = renderSubdomain({ cwd: input.cwd, template: tunnelNameTemplate, sessionId: cli.sessionId })
  }
  catch (error) {
    throw invalid(
      `tunnel.name is invalid: ${error instanceof Error ? error.message : String(error)}`,
      'Use a single slug-like name without dots',
      error
    )
  }
  setSource('tunnel.name', config.tunnel?.name ? 'config' : 'default')

  const accountPick = firstOf<string>(
    [optionalString(env.CLOUDFLARE_ACCOUNT_ID), 'env'],
    [optionalString(config.providers?.cloudflare?.accountId), 'config']
  )
  const accountId = accountPick.value
  if (accountId) {
    setSource('providers.cloudflare.accountId', accountPick.source ?? 'env')
  }

  const zoneIdPick = firstOf<string>(
    [optionalString(env.CLOUDFLARE_ZONE_ID), 'env'],
    [optionalString(config.providers?.cloudflare?.zoneId), 'config']
  )
  const zoneId = zoneIdPick.value
  if (zoneId) {
    setSource('providers.cloudflare.zoneId', zoneIdPick.source ?? 'env')
  }

  const cloudflaredPick = firstOf<string>(
    [optionalString(env.FLASH_TUNNEL_CLOUDFLARED), 'env'],
    [optionalString(config.providers?.cloudflare?.cloudflaredPath), 'config']
  )
  const cloudflaredPath = cloudflaredPick.value ?? 'cloudflared'
  setSource('providers.cloudflare.cloudflaredPath', cloudflaredPick.source ?? 'default')

  const autoStopPick = firstOf<string | number>(
    [cli.autoStop, 'cli'],
    [optionalString(env.FLASH_TUNNEL_AUTO_STOP), 'env'],
    [config.autoStopAfter, 'config']
  )
  let autoStopAfter: number | undefined
  if (autoStopPick.value !== undefined && autoStopPick.value !== '') {
    try {
      autoStopAfter = parseDuration(autoStopPick.value)
    }
    catch (error) {
      throw invalid(
        `autoStopAfter is invalid: ${error instanceof Error ? error.message : String(error)}`,
        'Use a duration like 30m, 2h or 90s',
        error
      )
    }
    setSource('autoStopAfter', autoStopPick.source ?? 'config')
  }

  return {
    values: {
      domain: {
        provider: domainProvider,
        zone,
        subdomain,
        hostname
      },
      server: {
        command,
        cwd: serverCwd,
        port,
        url,
        dir: serverDir,
        timeout
      },
      tunnel: {
        provider: tunnelProvider,
        mode,
        name: tunnelName
      },
      providers: {
        cloudflare: {
          accountId,
          zoneId,
          cloudflaredPath,
          originRequest: config.providers?.cloudflare?.originRequest
        }
      },
      autoStopAfter
    },
    sources,
    warnings,
    configDir,
    configFile: input.configFile
  }
}
