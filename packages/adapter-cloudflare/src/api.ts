import type { DnsRecordSpec, DnsRecordType } from '@flash-tunnel/types'
import { AdapterError } from '@flash-tunnel/types'

export interface CloudflareApiOptions {
  apiToken: string
  apiBase?: string
  fetcher?: typeof fetch
}

export interface CloudflareAccount {
  id: string
  name: string
}

export interface CloudflareZone {
  id: string
  name: string
  status: string
}

export interface CloudflareTunnel {
  id: string
  name: string
  status: string
  connections?: Array<{ id: string }>
  token?: string
}

export interface CloudflareDnsRecord {
  id: string
  name: string
  type: DnsRecordType
  content: string
  proxied: boolean
  comment?: string
}

interface CloudflareEnvelope<T> {
  success?: boolean
  errors?: Array<{ code?: number, message?: string }>
  result?: T
}

function mapError(status: number, envelope: CloudflareEnvelope<unknown>): AdapterError {
  const first = envelope.errors?.[0]
  const cfCode = first?.code
  let code = 'CLOUDFLARE_API_ERROR'

  if (cfCode === 81057) {
    code = 'RECORD_CONFLICT'
  }
  else if (status === 401 || status === 403) {
    code = 'AUTH_INVALID'
  }
  else if (status === 404) {
    code = 'NOT_FOUND'
  }
  else if (status === 429) {
    code = 'RATE_LIMITED'
  }

  return new AdapterError(first?.message ?? `Cloudflare API responded with ${status}`, {
    code,
    retriable: status === 429 || status >= 500,
    details: { status, cfCode }
  })
}

export class CloudflareApi {
  private readonly apiToken: string
  private readonly apiBase: string
  private readonly fetcher: typeof fetch

  constructor(options: CloudflareApiOptions) {
    this.apiToken = options.apiToken
    this.apiBase = options.apiBase ?? 'https://api.cloudflare.com/client/v4'
    this.fetcher = options.fetcher ?? fetch
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.fetcher(`${this.apiBase}${path}`, {
        method,
        headers: {
          'authorization': `Bearer ${this.apiToken}`,
          'content-type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000)
      })
    }
    catch (error) {
      throw new AdapterError('Cloudflare API request failed', {
        code: 'CLOUDFLARE_API_ERROR',
        retriable: true,
        cause: error
      })
    }

    const text = await response.text()
    let envelope: CloudflareEnvelope<T> = {}
    if (text) {
      try {
        envelope = JSON.parse(text) as CloudflareEnvelope<T>
      }
      catch {
        throw new AdapterError('Cloudflare API returned invalid JSON', {
          code: 'CLOUDFLARE_API_ERROR',
          details: { status: response.status }
        })
      }
    }

    if (!response.ok || envelope.success === false) {
      throw mapError(response.status, envelope)
    }

    return envelope.result as T
  }

  async verifyToken(): Promise<void> {
    const result = await this.request<{ status?: string }>('GET', '/user/tokens/verify')
    if (result?.status !== 'active') {
      throw new AdapterError('Cloudflare API token is not active', {
        code: 'AUTH_INVALID',
        hint: 'Create a token with Account Cloudflare Tunnel Edit and Zone DNS Edit'
      })
    }
  }

  async listAccounts(): Promise<CloudflareAccount[]> {
    return this.request<CloudflareAccount[]>('GET', '/accounts?per_page=50')
  }

  async resolveAccountId(preferred?: string): Promise<string> {
    if (preferred) {
      return preferred
    }

    const accounts = await this.listAccounts()
    if (accounts.length === 1 && accounts[0]) {
      return accounts[0].id
    }

    throw new AdapterError('Cannot determine the Cloudflare account id', {
      code: 'ACCOUNT_NOT_FOUND',
      hint: 'Set CLOUDFLARE_ACCOUNT_ID or providers.cloudflare.accountId',
      details: { accounts: accounts.map(account => account.name) }
    })
  }

  async listZones(name?: string): Promise<CloudflareZone[]> {
    const query = new URLSearchParams({ per_page: '50' })
    if (name) {
      query.set('name', name)
    }
    return this.request<CloudflareZone[]>('GET', `/zones?${query.toString()}`)
  }

  async resolveZone(zone: string): Promise<CloudflareZone> {
    const zones = await this.listZones(zone)
    const match = zones.find(item => item.name === zone)
    if (!match) {
      throw new AdapterError(`Zone "${zone}" was not found`, {
        code: 'ZONE_NOT_FOUND',
        hint: 'Check domain.zone, or set CLOUDFLARE_ZONE_ID'
      })
    }
    if (match.status !== 'active') {
      throw new AdapterError(`Zone "${zone}" is ${match.status}`, {
        code: 'ZONE_NOT_ACTIVE',
        hint: 'Wait for the zone to become active in Cloudflare'
      })
    }
    return match
  }

  async createTunnel(accountId: string, name: string): Promise<CloudflareTunnel> {
    return this.request<CloudflareTunnel>('POST', `/accounts/${accountId}/cfd_tunnel`, {
      name,
      config_src: 'cloudflare'
    })
  }

  async getTunnel(accountId: string, tunnelId: string): Promise<CloudflareTunnel> {
    return this.request<CloudflareTunnel>('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`)
  }

  async getTunnelToken(accountId: string, tunnelId: string): Promise<string> {
    const result = await this.request<string | { token?: string }>(
      'GET',
      `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`
    )

    if (typeof result === 'string') {
      return result
    }
    if (result?.token) {
      return result.token
    }

    throw new AdapterError('Cloudflare did not return a tunnel token', {
      code: 'TUNNEL_CREATE_FAILED'
    })
  }

  async putIngress(accountId: string, tunnelId: string, ingress: unknown[]): Promise<void> {
    await this.request('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      config: { ingress }
    })
  }

  async cleanupConnections(accountId: string, tunnelId: string): Promise<void> {
    await this.request('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`)
  }

  async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
    await this.request('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`)
  }

  async listDnsRecords(zoneId: string, query: { name?: string, comment?: string } = {}): Promise<CloudflareDnsRecord[]> {
    const params = new URLSearchParams({ per_page: '100' })
    if (query.name) {
      params.set('name', query.name)
    }
    if (query.comment) {
      params.set('comment', query.comment)
    }
    return this.request<CloudflareDnsRecord[]>('GET', `/zones/${zoneId}/dns_records?${params.toString()}`)
  }

  async createDnsRecord(zoneId: string, spec: DnsRecordSpec): Promise<CloudflareDnsRecord> {
    return this.request<CloudflareDnsRecord>('POST', `/zones/${zoneId}/dns_records`, {
      type: spec.type,
      name: spec.name,
      content: spec.content,
      proxied: spec.proxied ?? false,
      ttl: spec.ttl ?? 1,
      comment: spec.comment
    })
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request('DELETE', `/zones/${zoneId}/dns_records/${recordId}`)
  }
}
