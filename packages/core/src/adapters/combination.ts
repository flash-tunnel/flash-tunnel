import type { DnsAdapter, TunnelAdapter, TunnelMode } from '@flash-tunnel/types'
import { FlashTunnelError } from '../errors'

export interface AdapterCombinationInput {
  tunnel: TunnelAdapter
  dns?: DnsAdapter
  mode: TunnelMode
  /** What the user explicitly asked for, used by C5/C6 warnings. */
  requested?: {
    hostname?: boolean
    zone?: boolean
    subdomain?: boolean
  }
}

export interface AdapterCombination {
  warnings: string[]
}

function combinationError(message: string, hint: string): FlashTunnelError {
  return new FlashTunnelError(message, {
    code: 'ADAPTER_COMBINATION_INVALID',
    exitCode: 2,
    hint
  })
}

/**
 * Validate the tunnel/DNS pair before any resource is created (C1-C7 in 03).
 */
export function validateAdapterCombination(input: AdapterCombinationInput): AdapterCombination {
  const { tunnel, dns, mode, requested } = input
  const warnings: string[] = []

  if (!tunnel.capabilities.modes.includes(mode)) {
    throw new FlashTunnelError(
      `Tunnel adapter "${tunnel.id}" does not support mode "${mode}"`,
      {
        code: 'TUNNEL_MODE_UNSUPPORTED',
        exitCode: 5,
        hint: `Available modes: ${tunnel.capabilities.modes.join(', ')}`
      }
    )
  }

  if (tunnel.capabilities.requiresDns && !dns) {
    throw combinationError(
      `Tunnel adapter "${tunnel.id}" requires a DNS adapter`,
      'Configure domain.provider, or use a mode that assigns a hostname (quick)'
    )
  }

  const dnsCapabilities = tunnel.capabilities.dns
  if (dnsCapabilities && dns) {
    if (!dns.capabilities.recordTypes.includes(dnsCapabilities.type)) {
      throw combinationError(
        `DNS adapter "${dns.id}" does not support ${dnsCapabilities.type} records required by tunnel "${tunnel.id}"`,
        `Supported record types: ${dns.capabilities.recordTypes.join(', ')}`
      )
    }

    if (dnsCapabilities.proxied && !dns.capabilities.proxied) {
      throw combinationError(
        `Tunnel adapter "${tunnel.id}" requires proxied DNS records, but "${dns.id}" cannot proxy`,
        'Choose a DNS adapter that supports proxied records'
      )
    }

    if (dnsCapabilities.providerAffinity && !dnsCapabilities.providerAffinity.includes(dns.id)) {
      throw combinationError(
        `DNS adapter "${dns.id}" is not compatible with tunnel adapter "${tunnel.id}"`,
        `Compatible DNS adapters: ${dnsCapabilities.providerAffinity.join(', ')}`
      )
    }
  }

  if (mode === 'quick') {
    if (requested?.hostname || requested?.zone || requested?.subdomain) {
      warnings.push('quick mode ignores domain configuration; the public hostname is assigned by the provider')
    }
  }
  else if (tunnel.capabilities.publicHostname === 'assigned') {
    if (requested?.hostname) {
      warnings.push(`tunnel adapter "${tunnel.id}" assigns its own hostname; --hostname is ignored`)
    }
    if (requested?.zone || requested?.subdomain) {
      warnings.push(`tunnel adapter "${tunnel.id}" assigns its own hostname; domain configuration is ignored`)
    }
  }

  return { warnings }
}
