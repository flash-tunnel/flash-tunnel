import process from 'node:process'
import { styleText } from 'node:util'

type Style = Parameters<typeof styleText>[0]

const paint = (style: Style, text: string): string => styleText(style, text, { stream: process.stdout })

export const theme = {
  ok: (text: string) => paint(['bold', 'green'], text),
  err: (text: string) => paint(['bold', 'red'], text),
  warn: (text: string) => paint(['bold', 'yellow'], text),
  info: (text: string) => paint('blue', text),
  accent: (text: string) => paint('cyan', text),
  url: (text: string) => paint(['bold', 'cyan', 'underline'], text),
  dim: (text: string) => paint('gray', text),
  bold: (text: string) => paint('bold', text)
}
