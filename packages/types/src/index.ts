export const ADAPTER_API_VERSION = 1

export type AdapterKind = 'dns' | 'tunnel'
export type TunnelMode = 'named' | 'quick' | 'assigned'
export type DnsRecordType = 'CNAME' | 'A' | 'AAAA' | 'TXT'

export interface AdapterLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
}

export interface AdapterContext {
  sessionId: string
  cwd: string
  logger: AdapterLogger
  signal: AbortSignal
  now: () => number
}

export interface AdapterErrorOptions {
  code: string
  retriable?: boolean
  hint?: string
  cause?: unknown
  details?: Record<string, unknown>
}

export class AdapterError extends Error {
  readonly code: string
  readonly retriable: boolean
  readonly hint?: string
  readonly details?: Record<string, unknown>

  constructor(message: string, options: AdapterErrorOptions) {
    super(message, { cause: options.cause })
    this.name = 'AdapterError'
    this.code = options.code
    this.retriable = options.retriable ?? false
    this.hint = options.hint
    this.details = options.details
  }
}

export interface DnsCapabilities {
  recordTypes: DnsRecordType[]
  proxied: boolean
  ttl: boolean
  comment: boolean
  lookupByName: boolean
}

export interface DnsRecordSpec {
  zone: string
  name: string
  type: DnsRecordType
  content: string
  proxied?: boolean
  ttl?: number
  comment?: string
  /** Replace records that were not created by this tool. */
  overwrite?: boolean
}

export interface DnsRecordRef {
  provider: string
  zoneId: string
  recordId: string
  name: string
  type: DnsRecordType
  content: string
  proxied: boolean
}

export interface DnsAdapter {
  readonly kind: 'dns'
  readonly id: string
  readonly apiVersion: typeof ADAPTER_API_VERSION
  readonly capabilities: DnsCapabilities

  preflight: (ctx: AdapterContext, target: {
    zone: string
    name: string
    type: DnsRecordType
    overwrite?: boolean
  }) => Promise<void>

  ensure: (ctx: AdapterContext, spec: DnsRecordSpec) => Promise<DnsRecordRef>

  remove: (ctx: AdapterContext, ref: DnsRecordRef) => Promise<void>

  find: (ctx: AdapterContext, query: {
    zone: string
    name?: string
    comment?: string
  }) => Promise<DnsRecordRef[]>
}

export interface TunnelCapabilities {
  modes: TunnelMode[]
  publicHostname: 'custom' | 'assigned' | 'both'
  requiresDns: boolean
  dns?: {
    type: DnsRecordType
    targetFrom: 'handle'
    proxied: boolean
    providerAffinity?: string[]
  }
  concurrent: boolean
}

export interface TunnelProvisionSpec {
  name: string
  hostname?: string
  localUrl: string
  comment?: string
}

export interface TunnelSecrets {
  token?: string
  credentialsFile?: string
}

export interface TunnelHandle {
  provider: string
  tunnelId: string
  name: string
  publicUrl?: string
  dns?: {
    type: DnsRecordType
    target: string
    proxied: boolean
  }
  secrets: TunnelSecrets
  meta?: Record<string, string>
}

export interface TunnelStatus {
  state: 'starting' | 'connected' | 'degraded' | 'stopped'
  connections: number
  publicUrl?: string
  detail?: string
}

export interface TunnelHooks {
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void
  onExit?: (info: { code: number | null, signal: string | null }) => void
}

export interface TunnelAdapter {
  readonly kind: 'tunnel'
  readonly id: string
  readonly apiVersion: typeof ADAPTER_API_VERSION
  readonly capabilities: TunnelCapabilities

  preflight: (ctx: AdapterContext, opts: { hostname?: string, mode: TunnelMode }) => Promise<void>

  provision: (ctx: AdapterContext, spec: TunnelProvisionSpec) => Promise<TunnelHandle>

  start: (ctx: AdapterContext, handle: TunnelHandle, hooks: TunnelHooks) => Promise<void>

  waitReady: (ctx: AdapterContext, handle: TunnelHandle, timeoutMs: number) => Promise<TunnelStatus>

  stop: (ctx: AdapterContext, handle: TunnelHandle) => Promise<void>

  deprovision: (ctx: AdapterContext, handle: TunnelHandle) => Promise<void>

  status?: (ctx: AdapterContext, handle: TunnelHandle) => Promise<TunnelStatus>
}

export interface FlashTunnelEvents {
  'state': { from: string, to: string }
  'log': { level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string }
  'step': { id: string, status: 'fail' | 'ok' | 'start', detail?: string, durationMs?: number }
  'server:detected': { command: string, cwd: string, confidence: 'high' | 'low', reason: string }
  'server:ready': { url: string, port: number, startedByUs: boolean, durationMs: number }
  'tunnel:provisioned': { tunnelId: string, name: string }
  'tunnel:connected': { connections: number }
  'dns:created': { hostname: string, recordId: string, zoneId: string }
  'public:ready': { url: string, verifyMs: number }
  'autostop:expired': { expiresAt: number }
  'cleanup:step': { kind: string, status: 'start' | 'ok' | 'skip' | 'error', detail?: string }
  'cleanup:done': { ok: boolean, removed: string[], failed: Array<{ kind: string, error: string }> }
}

export function defineDnsAdapter<T extends DnsAdapter>(adapter: T): T {
  return adapter
}

export function defineTunnelAdapter<T extends TunnelAdapter>(adapter: T): T {
  return adapter
}

export function isDnsAdapter(value: unknown): value is DnsAdapter {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<DnsAdapter>
  return candidate.kind === 'dns'
    && candidate.apiVersion === ADAPTER_API_VERSION
    && typeof candidate.ensure === 'function'
    && typeof candidate.remove === 'function'
    && Array.isArray(candidate.capabilities?.recordTypes)
}

export function isTunnelAdapter(value: unknown): value is TunnelAdapter {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<TunnelAdapter>
  return candidate.kind === 'tunnel'
    && candidate.apiVersion === ADAPTER_API_VERSION
    && typeof candidate.provision === 'function'
    && typeof candidate.deprovision === 'function'
    && Array.isArray(candidate.capabilities?.modes)
}
