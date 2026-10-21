import type { CloudflareZone } from '@flash-tunnel/adapter-cloudflare'
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

export async function chooseZone(zones: CloudflareZone[]): Promise<string> {
  try {
    return await select<string>({
      message: 'Select a Cloudflare zone',
      choices: zones.map(zone => ({
        name: `${zone.name} (${zone.status})`,
        value: zone.name
      }))
    })
  }
  catch (error) {
    promptFailure(error)
  }
}

export async function confirmQuickFallback(): Promise<boolean> {
  try {
    return await confirm({
      message: 'CLOUDFLARE_API_TOKEN is not set. Use a temporary trycloudflare.com domain instead?',
      default: false
    })
  }
  catch (error) {
    promptFailure(error)
  }
}

export async function choosePortConflict(port: number): Promise<'exit' | 'reuse'> {
  try {
    return await select<'exit' | 'reuse'>({
      message: `Port ${port} is already in use`,
      choices: [
        { name: 'Reuse the server already running on this port', value: 'reuse' },
        { name: 'Exit', value: 'exit' }
      ]
    })
  }
  catch (error) {
    promptFailure(error)
  }
}

export async function confirmKeep(): Promise<boolean> {
  try {
    return await confirm({
      message: '--keep leaves the DNS record and tunnel behind. Continue?',
      default: false
    })
  }
  catch (error) {
    promptFailure(error)
  }
}
