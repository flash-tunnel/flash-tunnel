import type { TunnelMode } from '@flash-tunnel/types'

export type ConfigTunnelMode = Exclude<TunnelMode, 'assigned'>

export interface DomainConfig {
  provider?: string
  zone?: string
  subdomain?: string
}

export interface ServerConfig {
  command?: string
  cwd?: string
  port?: number
  url?: string
  dir?: string
  timeout?: number
}

export interface TunnelConfig {
  provider?: string
  mode?: ConfigTunnelMode
  name?: string
}

export interface CloudflareOriginRequestConfig {
  httpHostHeader?: string
  noTLSVerify?: boolean
}

export interface CloudflareProviderConfig {
  accountId?: string
  zoneId?: string
  cloudflaredPath?: string
  originRequest?: CloudflareOriginRequestConfig
}

export interface ProvidersConfig {
  cloudflare?: CloudflareProviderConfig
  [providerId: string]: unknown
}

export interface FlashTunnelConfig {
  domain?: DomainConfig
  server?: ServerConfig
  tunnel?: TunnelConfig
  providers?: ProvidersConfig
  autoStopAfter?: string | number
}

export function defineConfig<T extends FlashTunnelConfig>(config: T): T {
  return config
}
