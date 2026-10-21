import process from 'node:process'

export interface ShortcutActions {
  onCopy?: () => void
  onOpen?: () => void
  onQuit?: () => void
}

/**
 * Adds c/o/q shortcuts on an interactive terminal. Raw mode is restored when
 * the returned disposer runs, including on cleanup and failure paths.
 */
export function installShortcuts(actions: ShortcutActions): () => void {
  const stdin = process.stdin
  if (!stdin.isTTY || !process.stdout.isTTY || process.env.CI) {
    return () => {}
  }
  if (typeof stdin.setRawMode !== 'function') {
    return () => {}
  }

  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')

  const onData = (key: string): void => {
    if (key === '\u0003') {
      process.emit('SIGINT')
      return
    }
    if (key === 'q') {
      actions.onQuit?.()
    }
    else if (key === 'c') {
      actions.onCopy?.()
    }
    else if (key === 'o') {
      actions.onOpen?.()
    }
  }

  stdin.on('data', onData)

  return () => {
    stdin.off('data', onData)
    stdin.setRawMode(false)
    stdin.pause()
  }
}
