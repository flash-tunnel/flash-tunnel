import { randomId } from '@flash-tunnel/utils'

export const CORE_API_VERSION = 1

export function createSessionId(now: number = Date.now()): string {
  return `ft_${now.toString(36)}_${randomId(4)}`
}
