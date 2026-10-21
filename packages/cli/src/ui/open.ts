import { spawn } from 'node:child_process'
import process from 'node:process'

/** Best-effort browser opener; never throws or blocks the session. */
export function openUrl(url: string): void {
  const [command, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]

  try {
    const child = spawn(command as string, args as string[], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true
    })
    child.once('error', () => {})
    child.unref()
  }
  catch {
    // Opening the browser is a convenience, not a requirement.
  }
}
