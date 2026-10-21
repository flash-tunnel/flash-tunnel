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

  const zoneCandidate = cli.zone
    ?? optionalString(env.FLASH_TUNNEL_ZONE)
    ?? optionalString(config.domain?.zone)
  let zone: string | undefined
  if (zoneCandidate) {
    zone = validateZone(zoneCandidate)
    setSource('domain.zone', cli.zone ? 'cli' : env.FLASH_TUNNEL_ZONE ? 'env' : 'config')
  }
  else if (input.inferredZone) {
    zone = validateZone(input.inferredZone)
    setSource('domain.zone', 'inferred', 'the only active Cloudflare zone')
  }

  const subdomain = cli.subdomain
    ?? optionalString(config.domain?.subdomain)
    ?? '{project}-{rand}'
  setSource(
    'domain.subdomain',
    cli.subdomain ? 'cli' : config.domain?.subdomain ? 'config' : 'default',
    config.domain?.subdomain || cli.subdomain ? undefined : 'default template'
  )

  const explicitHostname = cli.hostname
    ?? optionalString(env.FLASH_TUNNEL_HOSTNAME)
    ?? undefined

  let hostname: string | undefined
  if (explicitHostname) {
    hostname = validateHostname(explicitHostname)
    setSource('domain.hostname', cli.hostname ? 'cli' : 'env')
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
  const directoryValue = staticValue ?? optionalString(config.server?.dir)
  let serverDir = directoryValue
    ? isAbsolute(directoryValue) ? directoryValue : resolve(configDir, directoryValue)
    : undefined
  if (serverDir) {
    setSource('server.dir', staticValue ? 'cli' : 'config')
  }
  else if (input.detected?.dir) {
    serverDir = input.detected.dir
    setSource('server.dir', 'detected')
  }

  const command = cli.command
    ?? optionalString(env.FLASH_TUNNEL_COMMAND)
    ?? optionalString(config.server?.command)
    ?? optionalString(input.detected?.command)
  if (command) {
    setSource(
      'server.command',
      cli.command ? 'cli' : env.FLASH_TUNNEL_COMMAND ? 'env' : config.server?.command ? 'config' : 'detected',
      input.detected?.reason
    )
  }

  const url = cli.url ?? optionalString(config.server?.url) ?? input.detected?.url
  if (url) {
    if (!URL.canParse(url)) {
      throw invalid(`server.url is not a valid URL: "${url}"`, 'Use http://127.0.0.1:5173 or https://...')
    }
    setSource('server.url', cli.url ? 'cli' : config.server?.url ? 'config' : 'detected')
  }

  const portCandidate = cli.port
    ?? optionalString(env.FLASH_TUNNEL_PORT)
    ?? config.server?.port
    ?? input.detected?.port
  let port: number | undefined
  if (portCandidate !== undefined && portCandidate !== '') {
    port = portNumber(portCandidate, 'server.port')
    setSource(
      'server.port',
      cli.port !== undefined ? 'cli' : env.FLASH_TUNNEL_PORT ? 'env' : config.server?.port !== undefined ? 'config' : 'detected'
    )
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

  const modeCandidate = cli.mode
    ?? optionalString(env.FLASH_TUNNEL_MODE)
    ?? config.tunnel?.mode
    ?? 'named'
  if (modeCandidate !== 'named' && modeCandidate !== 'quick') {
    throw invalid(`tunnel.mode must be "named" or "quick" (got "${modeCandidate}")`)
  }
  const mode: 'named' | 'quick' = modeCandidate
  if (mode === 'quick') {
    hostname = undefined
    delete sources['domain.hostname']
  }
  setSource(
    'tunnel.mode',
    cli.mode ? 'cli' : env.FLASH_TUNNEL_MODE ? 'env' : config.tunnel?.mode ? 'config' : 'default'
  )

  const tunnelProvider = optionalString(env.FLASH_TUNNEL_TUNNEL_PROVIDER)
    ?? optionalString(config.tunnel?.provider)
    ?? 'cloudflare'
  setSource(
    'tunnel.provider',
    env.FLASH_TUNNEL_TUNNEL_PROVIDER ? 'env' : config.tunnel?.provider ? 'config' : 'default'
  )

  const domainProvider = optionalString(env.FLASH_TUNNEL_DNS_PROVIDER)
    ?? optionalString(config.domain?.provider)
    ?? 'cloudflare'
  setSource(
    'domain.provider',
    env.FLASH_TUNNEL_DNS_PROVIDER ? 'env' : config.domain?.provider ? 'config' : 'default'
  )

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

  const accountId = optionalString(env.CLOUDFLARE_ACCOUNT_ID)
    ?? optionalString(config.providers?.cloudflare?.accountId)
  if (accountId) {
    setSource('providers.cloudflare.accountId', env.CLOUDFLARE_ACCOUNT_ID ? 'env' : 'config')
  }

  const zoneId = optionalString(env.CLOUDFLARE_ZONE_ID)
    ?? optionalString(config.providers?.cloudflare?.zoneId)
  if (zoneId) {
    setSource('providers.cloudflare.zoneId', env.CLOUDFLARE_ZONE_ID ? 'env' : 'config')
  }

  const cloudflaredPath = optionalString(env.FLASH_TUNNEL_CLOUDFLARED)
    ?? optionalString(config.providers?.cloudflare?.cloudflaredPath)
    ?? 'cloudflared'
  setSource(
    'providers.cloudflare.cloudflaredPath',
    env.FLASH_TUNNEL_CLOUDFLARED ? 'env' : config.providers?.cloudflare?.cloudflaredPath ? 'config' : 'default'
  )

  const autoStopValue = cli.autoStop
    ?? optionalString(env.FLASH_TUNNEL_AUTO_STOP)
    ?? config.autoStopAfter
  let autoStopAfter: number | undefined
  if (autoStopValue !== undefined && autoStopValue !== '') {
    try {
      autoStopAfter = parseDuration(autoStopValue)
    }
    catch (error) {
      throw invalid(
        `autoStopAfter is invalid: ${error instanceof Error ? error.message : String(error)}`,
        'Use a duration like 30m, 2h or 90s',
        error
      )
    }
    setSource(
      'autoStopAfter',
      cli.autoStop ? 'cli' : env.FLASH_TUNNEL_AUTO_STOP ? 'env' : 'config'
    )
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
