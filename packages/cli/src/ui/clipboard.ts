import { spawnSync } from 'node:child_process'
import process from 'node:process'

/** Best-effort clipboard copy; returns false when no clipboard tool exists. */
export function copyToClipboard(text: string): boolean {
  const [command, args] = process.platform === 'win32'
    ? ['clip', []]
    : process.platform === 'darwin'
      ? ['pbcopy', []]
      : ['wl-copy', []]

  const result = spawnSync(command as string, args as string[], {
    input: text,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true
  })

  return !result.error && result.status === 0
}
