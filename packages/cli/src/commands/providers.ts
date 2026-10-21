import type { Reporter } from '../ui/reporter'
import { createCloudflareDns, createCloudflareTunnel } from '@flash-tunnel/adapter-cloudflare'
import { theme } from '../ui/theme'

interface ProviderEntry {
  kind: 'dns' | 'tunnel'
  id: string
  capabilities: Record<string, unknown>
}

function builtinProviders(): ProviderEntry[] {
  const tunnel = createCloudflareTunnel()
  const dns = createCloudflareDns({ apiToken: '' })

  return [
    {
      kind: 'tunnel',
      id: tunnel.id,
      capabilities: tunnel.capabilities as unknown as Record<string, unknown>
    },
    {
      kind: 'dns',
      id: dns.id,
      capabilities: dns.capabilities as unknown as Record<string, unknown>
    }
  ]
}

export function runProviders(reporter: Reporter): void {
  const providers = builtinProviders()
  const tunnels = providers.filter(provider => provider.kind === 'tunnel')
  const dns = providers.filter(provider => provider.kind === 'dns')

  reporter.event({ type: 'providers', providers })

  if (reporter.json) {
    return
  }

  reporter.human(`${theme.bold('Tunnel adapters')}\n`)
  for (const provider of tunnels) {
    const modes = Array.isArray(provider.capabilities.modes) ? provider.capabilities.modes.join(', ') : 'unknown'
    const hostname = String(provider.capabilities.publicHostname ?? 'unknown')
    reporter.human(`  ${theme.accent(provider.id)}  modes: ${modes}  public hostname: ${hostname}\n`)
  }

  reporter.human(`\n${theme.bold('DNS adapters')}\n`)
  for (const provider of dns) {
    const records = Array.isArray(provider.capabilities.recordTypes)
      ? provider.capabilities.recordTypes.join(', ')
      : 'unknown'
    const flags = [
      provider.capabilities.proxied ? 'proxied' : undefined,
      provider.capabilities.comment ? 'comment' : undefined
    ].filter(Boolean).join(' ')
    reporter.human(`  ${theme.accent(provider.id)}  records: ${records}${flags ? `  ${flags}` : ''}\n`)
  }
}
