import process from 'node:process'
import { styleText } from 'node:util'

type Style = Parameters<typeof styleText>[0]

export interface Theme {
  ok: (text: string) => string
  err: (text: string) => string
  warn: (text: string) => string
  info: (text: string) => string
  accent: (text: string) => string
  url: (text: string) => string
  dim: (text: string) => string
  bold: (text: string) => string
}

export function createTheme(stream: NodeJS.WriteStream): Theme {
  const paint = (style: Style, text: string): string => styleText(style, text, { stream })

  return {
    ok: (text: string) => paint(['bold', 'green'], text),
    err: (text: string) => paint(['bold', 'red'], text),
    warn: (text: string) => paint(['bold', 'yellow'], text),
    info: (text: string) => paint('blue', text),
    accent: (text: string) => paint('cyan', text),
    url: (text: string) => paint(['bold', 'cyan', 'underline'], text),
    dim: (text: string) => paint('gray', text),
    bold: (text: string) => paint('bold', text)
  }
}

export const theme = createTheme(process.stdout)
export const themeStderr = createTheme(process.stderr)
