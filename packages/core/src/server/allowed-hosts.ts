import type { TunnelMode } from '@flash-tunnel/types'
import process from 'node:process'

/**
 * Escape hatch understood by Vite (6.1+): the value is appended to
 * `server.allowedHosts`, and `preview.allowedHosts` inherits server settings, so
 * a tunnel hostname works without editing `vite.config`.
 *
 * Vite 6.1 - 8.0 read the variable as a single hostname; comma-separated lists
 * are only supported from 8.1. flash-tunnel therefore always injects one value.
 */
export const VITE_ALLOWED_HOSTS_ENV = '__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS'

/** Quick tunnels get a random `*.trycloudflare.com` hostname. */
export const QUICK_TUNNEL_ALLOWED_HOST = '.trycloudflare.com'

/**
 * Hostname the local dev server should accept. Named tunnels have a stable
 * hostname; quick tunnels are only known once cloudflared is up, so the whole
 * domain is allowed (Vite treats a leading dot as a wildcard).
 */
export function tunnelAllowedHost(mode: TunnelMode, hostname?: string): string {
  return mode === 'named' && hostname ? hostname : QUICK_TUNNEL_ALLOWED_HOST
}

/**
 * Environment additions for the spawned dev server. An explicit user value is
 * left untouched: it may target an older Vite that only understands one host.
 */
export function viteAllowedHostsEnv(
  mode: TunnelMode,
  hostname?: string,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (env[VITE_ALLOWED_HOSTS_ENV]) {
    return {}
  }

  return {
    [VITE_ALLOWED_HOSTS_ENV]: tunnelAllowedHost(mode, hostname)
  }
}
