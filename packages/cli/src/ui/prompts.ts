import type { CloudflareZone } from '@flash-tunnel/adapter-cloudflare'
import type { WorkspaceCandidate } from '@flash-tunnel/core'
import process from 'node:process'
import { FlashTunnelError } from '@flash-tunnel/core'
import { confirm, select } from '@inquirer/prompts'

export interface PromptGuardOptions {
  yes?: boolean
  json?: boolean
}

/** Prompts are only allowed on an interactive terminal, never in CI or --json. */
export function canPrompt(options: PromptGuardOptions = {}): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false
  }
  if (process.env.CI || options.yes || options.json) {
    return false
  }
  return true
}

function promptFailure(error: unknown): never {
  if (error instanceof Error && error.name === 'ExitPromptError') {
    throw new FlashTunnelError('Cancelled', {
      code: 'CANCELLED',
      exitCode: 130
    })
  }
  throw error
}

/** Run a prompt and turn a user cancellation into the shared exit-code 130 error. */
async function withPrompt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  }
  catch (error) {
    return promptFailure(error)
  }
}

export function chooseZone(zones: CloudflareZone[]): Promise<string> {
  return withPrompt(() => select<string>({
    message: 'Select a Cloudflare zone',
    choices: zones.map(zone => ({
      name: `${zone.name} (${zone.status})`,
      value: zone.name
    }))
  }))
}

export function confirmQuickFallback(): Promise<boolean> {
  return withPrompt(() => confirm({
    message: 'CLOUDFLARE_API_TOKEN is not set. Use a temporary trycloudflare.com domain instead?',
    default: false
  }))
}

export function chooseWorkspace(candidates: WorkspaceCandidate[]): Promise<WorkspaceCandidate> {
  return withPrompt(() => select<WorkspaceCandidate>({
    message: 'Select the workspace to preview',
    choices: candidates.map(candidate => ({
      name: `${candidate.name}  ${candidate.cwd}`,
      value: candidate
    }))
  }))
}

export function choosePortConflict(port: number): Promise<'exit' | 'reuse'> {
  return withPrompt(() => select<'exit' | 'reuse'>({
    message: `Port ${port} is already in use`,
    choices: [
      { name: 'Reuse the server already running on this port', value: 'reuse' },
      { name: 'Exit', value: 'exit' }
    ]
  }))
}

export function confirmOverwrite(hostname: string): Promise<boolean> {
  return withPrompt(() => confirm({
    message: `DNS record "${hostname}" was created by another tool. Replace it?`,
    default: false
  }))
}

export function confirmKeep(): Promise<boolean> {
  return withPrompt(() => confirm({
    message: '--keep leaves the DNS record and tunnel behind. Continue?',
    default: false
  }))
}
