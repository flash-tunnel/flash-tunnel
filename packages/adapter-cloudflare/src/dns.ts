import type { AdapterContext, DnsAdapter, DnsRecordRef, DnsRecordSpec, DnsRecordType } from '@flash-tunnel/types'
import type { CloudflareDnsRecord } from './api'
import { AdapterError } from '@flash-tunnel/types'
import { CloudflareApi } from './api'

export interface CloudflareDnsOptions {
  apiToken: string
  zoneId?: string
  apiBase?: string
  fetcher?: typeof fetch
}

const OWNED_COMMENT_PREFIX = 'flash-tunnel:'

function isOwned(comment: string | undefined): boolean {
  return comment?.startsWith(OWNED_COMMENT_PREFIX) ?? false
}

function toRef(provider: string, zoneId: string, record: CloudflareDnsRecord): DnsRecordRef {
  return {
    provider,
    zoneId,
    recordId: record.id,
    name: record.name,
    type: record.type,
    content: record.content,
    proxied: record.proxied
  }
}

export function createCloudflareDns(options: CloudflareDnsOptions): DnsAdapter {
  const api = new CloudflareApi(options)
  const zoneIds = new Map<string, string>()

  async function zoneIdFor(zone: string): Promise<string> {
    if (options.zoneId) {
      return options.zoneId
    }

    const cached = zoneIds.get(zone)
    if (cached) {
      return cached
    }

    const resolved = await api.resolveZone(zone)
    zoneIds.set(zone, resolved.id)
    return resolved.id
  }

  return {
    kind: 'dns',
    id: 'cloudflare',
    apiVersion: 1,
    capabilities: {
      recordTypes: ['CNAME', 'A', 'AAAA', 'TXT'],
      proxied: true,
      ttl: true,
      comment: true,
      lookupByName: true
    },

    async preflight(_ctx: AdapterContext, target: {
      zone: string
      name: string
      type: DnsRecordType
      overwrite?: boolean
    }): Promise<void> {
      await api.verifyToken()
      const zoneId = await zoneIdFor(target.zone)
      const existing = await api.listDnsRecords(zoneId, { name: target.name })
      const conflicts = existing.filter(record => !isOwned(record.comment))

      if (conflicts.length > 0 && !target.overwrite) {
        throw new AdapterError(`DNS record "${target.name}" already exists`, {
          code: 'RECORD_CONFLICT',
          hint: 'Use a different subdomain, or pass --overwrite to replace a non-flash-tunnel record',
          details: { records: conflicts.map(record => record.id) }
        })
      }
    },

    async ensure(_ctx: AdapterContext, spec: DnsRecordSpec): Promise<DnsRecordRef> {
      const zoneId = await zoneIdFor(spec.zone)
      const existing = await api.listDnsRecords(zoneId, { name: spec.name })

      for (const record of existing) {
        if (isOwned(record.comment)) {
          await api.deleteDnsRecord(zoneId, record.id).catch(() => {})
        }
      }

      try {
        const record = await api.createDnsRecord(zoneId, spec)
        return toRef('cloudflare', zoneId, record)
      }
      catch (error) {
        if (error instanceof AdapterError && error.code === 'RECORD_CONFLICT') {
          const current = await api.listDnsRecords(zoneId, { name: spec.name })
          const owned = current.filter(record => isOwned(record.comment))
          if (owned.length === 0) {
            throw error
          }
          for (const record of owned) {
            await api.deleteDnsRecord(zoneId, record.id)
          }
          const record = await api.createDnsRecord(zoneId, spec)
          return toRef('cloudflare', zoneId, record)
        }
        throw error
      }
    },

    async remove(_ctx: AdapterContext, ref: DnsRecordRef): Promise<void> {
      try {
        await api.deleteDnsRecord(ref.zoneId, ref.recordId)
      }
      catch (error) {
        if (error instanceof AdapterError && error.code === 'NOT_FOUND') {
          return
        }
        throw error
      }
    },

    async find(_ctx: AdapterContext, query: {
      zone: string
      name?: string
      comment?: string
    }): Promise<DnsRecordRef[]> {
      const zoneId = await zoneIdFor(query.zone)
      const records = await api.listDnsRecords(zoneId, {
        name: query.name,
        comment: query.comment
      })
      return records.map(record => toRef('cloudflare', zoneId, record))
    }
  }
}
