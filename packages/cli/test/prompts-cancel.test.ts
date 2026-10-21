import { FlashTunnelError } from '@flash-tunnel/core'
import { describe, expect, it, vi } from 'vitest'
import { chooseZone } from '../src/ui/prompts'

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(async () => {
    const error = new Error('cancelled')
    error.name = 'ExitPromptError'
    throw error
  }),
  confirm: vi.fn(async () => true)
}))

describe('prompt cancellation', () => {
  it('maps ExitPromptError to exit code 130', async () => {
    await expect(chooseZone([{ id: 'z', name: 'example.com', status: 'active' }]))
      .rejects
      .toBeInstanceOf(FlashTunnelError)

    try {
      await chooseZone([{ id: 'z', name: 'example.com', status: 'active' }])
    }
    catch (error) {
      expect((error as FlashTunnelError).exitCode).toBe(130)
      expect((error as FlashTunnelError).code).toBe('CANCELLED')
    }
  })
})
