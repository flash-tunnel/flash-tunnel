import type { ServerPlan } from './types'
import { createServer } from 'node:net'

export function isInferredPort(plan: ServerPlan): boolean {
  return plan.mode === 'command' && (plan.portSource === 'framework' || plan.portSource === 'default')
}

export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.once('listening', () => {
      server.close(() => resolvePort(true))
    })
    server.listen(port, '127.0.0.1')
    server.unref()
  })
}
