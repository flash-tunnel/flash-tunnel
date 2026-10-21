import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { randomId, slugify } from '@flash-tunnel/utils'

export interface ResolveHostnameOptions {
  cwd: string
  zone: string
  subdomain?: string
  hostname?: string
}

function gitBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || 'nogit'
  }
  catch {
    return 'nogit'
  }
}

export function resolveHostname(options: ResolveHostnameOptions): string {
  if (options.hostname) {
    return options.hostname
  }

  const template = options.subdomain ?? '{project}-{rand}'
  const project = slugify(basename(options.cwd))
  const branch = slugify(gitBranch(options.cwd))

  const label = template
    .replaceAll('{project}', project)
    .replaceAll('{branch}', branch)
    .replaceAll('{ts}', Date.now().toString(36))
    .replace(/\{rand(?::(\d+))?\}/g, (_match, length: string | undefined) => randomId(Number(length ?? 4)))

  if (label.includes('.')) {
    throw new Error('Multi-level subdomains are not supported yet; use a single label')
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) || label.length > 63) {
    throw new Error(`Invalid subdomain label "${label}"`)
  }

  return `${label}.${options.zone}`
}
