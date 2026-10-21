import type { DnsAdapter, TunnelAdapter } from '@flash-tunnel/types'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ADAPTER_API_VERSION, isDnsAdapter, isTunnelAdapter } from '@flash-tunnel/types'
import { FlashTunnelError } from '../errors'

function adapterError(message: string, hint?: string, cause?: unknown): FlashTunnelError {
  return new FlashTunnelError(message, {
    code: 'ADAPTER_LOAD_FAILED',
    exitCode: 2,
    hint,
    cause
  })
}

function moduleUrl(spec: string, cwd: string): string {
  if (spec.startsWith('npm:')) {
    return spec.slice('npm:'.length)
  }
  if (spec.startsWith('file:')) {
    return pathToFileURL(resolve(cwd, spec.slice('file:'.length))).href
  }
  if (spec.startsWith('.') || isAbsolute(spec)) {
    return pathToFileURL(resolve(cwd, spec)).href
  }
  return spec
}

async function importAdapterModule(spec: string, cwd: string): Promise<Record<string, unknown>> {
  const url = moduleUrl(spec, cwd)
  try {
    return await import(url) as Record<string, unknown>
  }
  catch (error) {
    throw adapterError(
      `Cannot load adapter "${spec}": ${error instanceof Error ? error.message : String(error)}`,
      'Use npm:package-name, file:./adapter.mjs or a path to a local adapter module',
      error
    )
  }
}

async function resolveExport(module: Record<string, unknown>, key: string): Promise<unknown> {
  const candidate = module.default ?? module[key] ?? module.adapter
  return typeof candidate === 'function' ? await (candidate as () => unknown)() : candidate
}

function checkVersion(spec: string, candidate: { apiVersion?: number }): void {
  if (candidate.apiVersion !== ADAPTER_API_VERSION) {
    throw adapterError(
      `Adapter "${spec}" targets API version ${String(candidate.apiVersion)} but this CLI expects ${ADAPTER_API_VERSION}`,
      'Upgrade the adapter or the CLI so both use the same contract version'
    )
  }
}

export async function loadTunnelAdapter(spec: string, cwd: string): Promise<TunnelAdapter> {
  const module = await importAdapterModule(spec, cwd)
  const candidate = await resolveExport(module, 'tunnel')

  if (!isTunnelAdapter(candidate)) {
    if (candidate && typeof candidate === 'object' && (candidate as { kind?: string }).kind === 'tunnel') {
      checkVersion(spec, candidate as { apiVersion?: number })
    }
    throw adapterError(`"${spec}" does not export a valid tunnel adapter`)
  }

  checkVersion(spec, candidate)
  return candidate
}

export async function loadDnsAdapter(spec: string, cwd: string): Promise<DnsAdapter> {
  const module = await importAdapterModule(spec, cwd)
  const candidate = await resolveExport(module, 'dns')

  if (!isDnsAdapter(candidate)) {
    if (candidate && typeof candidate === 'object' && (candidate as { kind?: string }).kind === 'dns') {
      checkVersion(spec, candidate as { apiVersion?: number })
    }
    throw adapterError(`"${spec}" does not export a valid DNS adapter`)
  }

  checkVersion(spec, candidate)
  return candidate
}
