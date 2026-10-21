import { spawn } from 'node:child_process'
import process from 'node:process'
import { sleep } from '@flash-tunnel/utils'

export interface KillProcessTreeOptions {
  /** Grace period between SIGTERM and SIGKILL on POSIX. */
  graceMs?: number
}

/** Check whether a process exists without signalling it. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true
    }
    await sleep(50)
  }
  return !isProcessAlive(pid)
}

function kill(pid: number, signal: NodeJS.Signals, group: boolean): void {
  try {
    process.kill(group ? -pid : pid, signal)
  }
  catch {
    // The process or group is already gone, or the group is not available.
  }
}

/**
 * Stop a detached process tree recorded in a session state file.
 * Never targets the current process; cleanup must not kill the reaper itself.
 */
export async function killProcessTree(pid: number, options: KillProcessTreeOptions = {}): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return
  }
  if (!isProcessAlive(pid)) {
    return
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    })
    await waitForGone(pid, 5000)
    return
  }

  kill(pid, 'SIGTERM', true)
  kill(pid, 'SIGTERM', false)

  if (await waitForGone(pid, options.graceMs ?? 5000)) {
    return
  }

  kill(pid, 'SIGKILL', true)
  kill(pid, 'SIGKILL', false)
  await waitForGone(pid, 2000)
}
