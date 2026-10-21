import process from 'node:process'

/** Windows conhost without a Unicode-capable terminal falls back to ASCII. */
export const unicode = process.platform !== 'win32'
  || Boolean(process.env.WT_SESSION)
  || process.env.TERM_PROGRAM === 'vscode'

export const symbols = unicode
  ? { ok: '✔', fail: '✖', warn: '⚠', info: 'ℹ', bullet: '·', arrow: '→' }
  : { ok: '√', fail: '×', warn: '!', info: 'i', bullet: '-', arrow: '->' }
