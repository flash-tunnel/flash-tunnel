import type { DnsAdapter, TunnelAdapter } from '@flash-tunnel/types'
import { loadDnsAdapter, loadTunnelAdapter } from './load'

export type TunnelFactory = () => TunnelAdapter
export type DnsFactory = () => DnsAdapter

/**
 * Built-in adapters are registered by the CLI; anything not registered is
 * treated as `npm:package`, `file:./adapter.mjs` or a local path.
 */
export class AdapterRegistry {
  private readonly tunnels = new Map<string, TunnelFactory>()
  private readonly dns = new Map<string, DnsFactory>()

  registerTunnel(id: string, factory: TunnelFactory): void {
    this.tunnels.set(id, factory)
  }

  registerDns(id: string, factory: DnsFactory): void {
    this.dns.set(id, factory)
  }

  listTunnels(): string[] {
    return [...this.tunnels.keys()]
  }

  listDns(): string[] {
    return [...this.dns.keys()]
  }

  async resolveTunnel(id: string, cwd: string): Promise<TunnelAdapter> {
    const factory = this.tunnels.get(id)
    if (factory) {
      return factory()
    }
    return loadTunnelAdapter(id, cwd)
  }

  async resolveDns(id: string, cwd: string): Promise<DnsAdapter> {
    const factory = this.dns.get(id)
    if (factory) {
      return factory()
    }
    return loadDnsAdapter(id, cwd)
  }
}
