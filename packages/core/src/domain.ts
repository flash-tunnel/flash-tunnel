import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { randomId, slugify } from '@flash-tunnel/utils'

export interface RenderSubdomainOptions {
  cwd: string
  template?: string
  sessionId?: string
  allowMultilevel?: boolean
}

export interface ResolveHostnameOptions extends RenderSubdomainOptions {
  zone: string
  hostname?: string
  /** Backwards-compatible alias for template. */
  subdomain?: string
}

function readGitBranch(cwd: string): string {
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

/**
 * `git rev-parse` costs tens of milliseconds per spawn, and one start renders
 * several templates for the same directory. Cache per cwd so the branch is read
 * at most once.
 */
const branchCache = new Map<string, string>()

function gitBranch(cwd: string): string {
  const cached = branchCache.get(cwd)
  if (cached !== undefined) {
    return cached
  }

  const branch = readGitBranch(cwd)
  branchCache.set(cwd, branch)
  return branch
}

export function renderSubdomain(options: RenderSubdomainOptions): string {
  const template = options.template ?? '{project}-{rand}'
  const project = slugify(basename(options.cwd))
  // Only pay for the git lookup when the template actually uses the branch.
  const branch = template.includes('{branch}') ? slugify(gitBranch(options.cwd)) : ''

  const label = template
    .replaceAll('{project}', project)
    .replaceAll('{branch}', branch)
    .replaceAll('{session}', options.sessionId ?? 'session')
    .replaceAll('{ts}', Date.now().toString(36))
    .replace(/\{rand(?::(\d+))?\}/g, (_match, length: string | undefined) => randomId(Number(length ?? 4)))

  if (label.includes('.') && !options.allowMultilevel) {
    throw new Error('Multi-level subdomains require --allow-multilevel and an Advanced Certificate')
  }

  const labels = label.split('.')
  for (const part of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part) || part.length > 63) {
      throw new Error(`Invalid subdomain label "${label}"`)
    }
  }

  return label
}

export function resolveHostname(options: ResolveHostnameOptions): string {
  if (options.hostname) {
    return options.hostname
  }

  return `${renderSubdomain({ ...options, template: options.template ?? options.subdomain })}.${options.zone}`
}
