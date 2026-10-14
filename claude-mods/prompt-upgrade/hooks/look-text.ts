// Pure text helpers for the shared look. No `$`, no drawing: safe to test.

export const GOLD = '#F2C46D'
export const HAIR = '#262B33'
export const SLATE = '#262B33'
export const MUTED = '#7D8590'
export const TEXT = '#E6EDF3'
export const GREEN = '#3DD68C'
export const AMBER = '#E3B341'
export const RED = '#F47067'
export const INK = '#0D1117'

/** Cell width of a string. Box-drawing and the glyphs used here are one cell each. */
export function cells(text: string): number {
  return Array.from(text).length
}

/** Cuts text to at most `width` cells, ending with an ellipsis when cut. */
export function fit(text: string, width: number): string {
  const chars = Array.from(text)
  if (width <= 0) return ''
  if (chars.length <= width) return text
  if (width === 1) return '…'
  return chars.slice(0, width - 1).join('') + '…'
}

/** Pads (or cuts) text to exactly `width` cells. */
export function pad(text: string, width: number): string {
  const cut = fit(text, width)
  return cut + ' '.repeat(Math.max(0, width - cells(cut)))
}

/** Spreads letters for a premium title: "PILOT" -> "P I L O T". */
export function spaced(text: string): string {
  return Array.from(text.toUpperCase()).join(' ')
}

/** The two parts of the title rule: gold under the title, a hairline to the edge. */
export function ruleParts(titleWidth: number, columns: number): { gold: string; hair: string } {
  const goldWidth = Math.max(0, Math.min(titleWidth, columns))
  const hairWidth = Math.max(0, columns - goldWidth)
  return { gold: '━'.repeat(goldWidth), hair: '─'.repeat(hairWidth) }
}

/** A heading in small capitals followed by a hairline that fills the row. */
export function headingParts(label: string, columns: number): { label: string; hair: string } {
  const shown = fit(label.toUpperCase(), Math.max(0, columns - 2))
  const hairWidth = Math.max(0, columns - cells(shown) - 1)
  return { label: shown, hair: hairWidth > 0 ? '─'.repeat(hairWidth) : '' }
}

/** A meter of `width` cells, filled to `percent` (0 to 100). */
export function meterParts(percent: number, width: number): { fill: string; rest: string } {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  const filled = Math.round((clamped / 100) * width)
  return { fill: '━'.repeat(filled), rest: '─'.repeat(Math.max(0, width - filled)) }
}

// Big numerals: three rows tall, heavy box-drawing strokes.
const GLYPHS: Record<string, readonly [string, string, string]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
  '.': [' ', ' ', '╻'],
  ',': [' ', ' ', '┛'],
  ':': [' ', '╹', '╻'],
  '-': ['   ', '╺━╸', '   '],
  '+': ['   ', '╺╋╸', '   '],
  '×': ['   ', '╲╱ ', '╱╲ '],
  '%': ['╻ ╱', ' ╱ ', '╱ ╹'],
  '$': ['┏╋╸', '┗╋┓', '╺╋┛'],
  'h': ['╻  ', '┣━┓', '╹ ╹'],
  'm': ['   ', '┏┳┓', '╹╹╹'],
  's': ['┏━╸', '┗━┓', '╺━┛'],
  'k': ['╻ ╻', '┣━┛', '╹ ╹'],
  '/': ['  ╱', ' ╱ ', '╱  '],
  ' ': [' ', ' ', ' '],
}

/** Whether every character of `text` has a big glyph. */
export function canBig(text: string): boolean {
  return Array.from(text).every(ch => GLYPHS[ch] !== undefined)
}

/** The three rows of `text` in big numerals, glyphs one space apart. */
export function bigRows(text: string): [string, string, string] {
  const chars = Array.from(text)
  const rows: [string[], string[], string[]] = [[], [], []]
  for (const ch of chars) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' ']!
    rows[0].push(glyph[0])
    rows[1].push(glyph[1])
    rows[2].push(glyph[2])
  }
  return [rows[0].join(' '), rows[1].join(' '), rows[2].join(' ')]
}

/** Width in cells of `text` drawn big. */
export function bigWidth(text: string): number {
  return cells(bigRows(text)[0])
}

/** How many tiles fit across `columns`: three, then two, then one. */
export function tilesAcross(columns: number, wanted: number, minTile = 22): number {
  for (let n = Math.min(3, wanted); n > 1; n--) {
    if (Math.floor((columns - (n - 1)) / n) >= minTile) return n
  }
  return 1
}

/** Width of each tile when `n` tiles share `columns` with one-cell gaps. */
export function tileWidth(columns: number, n: number): number {
  return Math.max(8, Math.floor((columns - (n - 1)) / n))
}

/** "1:05", "12:40", "1:02:03" from milliseconds. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`
}

/** "2m 14s", "45s", "1h 3m" from milliseconds. */
export function took(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** Compact token counts: 950, 12.3k, 1.2M. */
export function tokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 10_000) return `${Math.round(n / 1000)}k`
  if (abs >= 1_000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

const SPARK = '▁▂▃▄▅▆▇█'

/** A one-row bar chart of `values`, the last `width` of them, scaled to the largest. */
export function spark(values: readonly number[], width: number): string {
  const shown = values.slice(-Math.max(0, width))
  const top = Math.max(0, ...shown)
  if (shown.length === 0) return ''
  return shown
    .map(v => (top <= 0 || v <= 0 ? ' ' : SPARK[Math.min(7, Math.max(0, Math.round((v / top) * 7)))]!))
    .join('')
}

/** Three rows of vertical bars (bottom to top), `width` bars, scaled to the largest. */
export function bars3(values: readonly number[]): [string, string, string] {
  const top = Math.max(0, ...values)
  const rows: [string[], string[], string[]] = [[], [], []]
  for (const v of values) {
    const level = top <= 0 || v <= 0 ? 0 : Math.max(1, Math.round((v / top) * 24))
    for (let r = 0; r < 3; r++) {
      const inRow = Math.max(0, Math.min(8, level - r * 8))
      rows[2 - r]!.push(inRow === 0 ? ' ' : SPARK[inRow - 1]!)
    }
  }
  return [rows[0].join(''), rows[1].join(''), rows[2].join('')]
}
