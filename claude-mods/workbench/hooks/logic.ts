// workbench's pure logic: no `$`, nothing drawn. Parsing, wording and the
// state changes the hooks apply, so the tests can call every piece directly.

import type {
  WorkbenchGuess,
  WorkbenchIdea,
  WorkbenchMark,
  WorkbenchReflect,
  WorkbenchReflectItem,
  WorkbenchShelfUi,
} from '../types'
import { cells, fit } from './look-text'

// ── Names ──────────────────────────────────────────────────────────────────

export const PLUGIN = 'workbench'
export const SHELF_PANE = 'workbench-shelf'
export const ASSUME_PANE = 'workbench-assumptions'
export const REFLECT_PANE = 'workbench-reflect'
export const TOOL_SHORT = 'note_assumption'
export const TOOL_NAME = 'mcp__workbench__note_assumption'
export const SECTION_ID = 'workbench:assumptions'

export const MAX_IDEAS = 100
/** The longest idea the shelf keeps, in characters (every project's shelf shares the store's room). */
export const MAX_IDEA_CHARS = 4000
export const MAX_GUESSES = 50
export const MAX_LINES = 6

// ── Words the person reads ─────────────────────────────────────────────────

export const IDEA_EMPTY = 'Type /idea followed by the idea.'
export const IDEA_TOO_LONG = 'That idea is longer than 4,000 characters, too long to park. Nothing was saved.'
export const SHELF_EMPTY = 'No ideas parked for this project. Type /idea and a thought to save it for later.'
export const FILL_NOTE = 'In your prompt box — press Enter when Claude is free.'
export const FILL_FAILED = 'The prompt box could not take it. Nothing was sent.'
export const SENT_IDEA = 'Sent to Claude.'
export const ALL_INTRO = 'Here are some ideas I parked, handle them one at a time:'
export const EDIT_EMPTY = "An idea can't be empty. Use Delete to remove it."
export const EDIT_MOBILE = 'In your prompt box: change it and send to park the new version. The old one stays until you delete it.'
export const DELETE_ARMED = 'Press again to delete'

export const ASSUME_SECTION =
  "When you make a small guess the person didn't specify — a name, a file location, a default value, a library or approach, what's in or out of scope — call note_assumption once for that guess, in one short sentence, then keep working. Don't stop to ask about these; the person reviews them after the turn. Skip guesses that are obvious from the code or the request."
export const TOOL_DESCRIPTION =
  'Notes one small guess you made that the person did not specify (a name, a file location, a default value, a library or approach, scope), in one short sentence, so they can check it after the turn. Call it once per guess, then keep working; do not wait for an answer.'
export const TOOL_OFF_DESCRIPTION = 'Assumption Check is off. Do not call this tool.'
export const NOTED = 'Noted. Keep going.'
export const NOTED_OFF = 'Assumption Check is off, so nothing was noted. Keep going.'
export const NOTE_FAILED = "Couldn't note that one. Keep going."
export const NOTE_MISSING = 'note_assumption needs the guess in `assumption`, as one short sentence.'
export const ASSUME_EMPTY = 'No guesses to check. When Claude notes one during a task it shows up here.'
export const ASSUME_ON = 'Assumption Check is on: Claude notes its small guesses for you to check after each turn.'
export const ASSUME_OFF = "Assumption Check is off: Claude won't be asked to note its guesses."
export const ASSUME_ON_FAILED = "Couldn't turn Assumption Check on: Claude's note_assumption tool could not be added. Nothing was changed."
export const ASSUME_USAGE = 'Type /assumptions to check guesses, or /assumptions on or /assumptions off.'
export const CORRECTIONS_INTRO = 'Some of your guesses were wrong. Please fix these:'

export const REFLECT_START = 'Reflecting on this session… the suggestions open in a pane.'
export const REFLECT_NOTHING = 'Nothing to reflect on yet — send a prompt first.'
export const REFLECT_LOADING = 'Reading the session…'
export const REFLECT_FAILED = "Couldn't reflect this time. Nothing was changed."
export const REFLECT_EMPTY = 'Nothing from this session looks worth keeping in CLAUDE.md.'
export const REFLECT_ALL_PRESENT = 'Those lines are already in CLAUDE.md. Nothing was changed.'
export const REFLECT_WRITE_FAILED = "Couldn't write CLAUDE.md. Nothing was changed."
export const REFLECT_READ_FAILED = "Couldn't read CLAUDE.md. Nothing was changed."

export const REFLECT_PROMPT = [
  "Look back over this session and suggest up to 6 lasting instructions for this project's CLAUDE.md, learned from what happened here:",
  'corrections the person made, preferences they stated, build, test or run commands that worked, and gotchas you found.',
  'Each one is a single line, imperative, specific to this project and useful in future sessions.',
  'Leave out anything one-off, anything already obvious from the code, and any secrets, tokens, keys, passwords or personal data.',
  'Reply with strict JSON only, no prose and no code fence, in exactly this shape:',
  '{"lines":[{"text":"the instruction","why":"what in this session taught it, a few words"}]}',
  'If nothing is worth keeping, reply {"lines":[]}.',
].join(' ')

// ── Small helpers ──────────────────────────────────────────────────────────

/** One line: whitespace runs (newlines included) become single spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The first non-empty line of a text, trimmed. */
export function firstLine(text: string): string {
  const found = text.split(/\r?\n/).find(row => row.trim() !== '')
  return (found ?? '').trim()
}

/** The last part of a path: "/Users/me/code/earshot/" -> "earshot". */
export function projectName(root: string): string {
  const parts = root.split(/[\\/]+/).filter(part => part !== '')
  return parts.at(-1) ?? (root === '' ? 'this project' : root)
}

/** Joins a folder and a file name with the folder's own separator. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

/** Cuts text from the left so its end shows: "…/earshot/CLAUDE.md". */
export function fitStart(text: string, width: number): string {
  const chars = Array.from(text)
  if (width <= 0) return ''
  if (chars.length <= width) return text
  if (width === 1) return '…'
  return '…' + chars.slice(chars.length - (width - 1)).join('')
}

/** Word-wraps text into at most `maxLines` lines of at most `width` cells; the last is cut with … when more remains. */
export function wrapLines(text: string, width: number, maxLines: number): string[] {
  const room = Math.max(1, width)
  const words = oneLine(text).split(' ').filter(word => word !== '')
  const lines: string[] = []
  let current = ''
  let index = 0
  while (index < words.length) {
    const word = words[index]!
    const candidate = current === '' ? word : `${current} ${word}`
    if (cells(candidate) <= room) {
      current = candidate
      index += 1
      continue
    }
    if (current === '') {
      // A single word longer than the row: break it.
      const chars = Array.from(word)
      lines.push(chars.slice(0, room).join(''))
      words[index] = chars.slice(room).join('')
    } else {
      lines.push(current)
      current = ''
    }
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && current !== '') {
    lines.push(current)
    current = ''
  }
  const isCut = index < words.length || current !== ''
  if (isCut && lines.length > 0) {
    const last = lines.length - 1
    lines[last] = fit(`${lines[last]!} …`, room)
  }
  return lines.length > 0 ? lines : ['']
}

/** "now", "5m", "3h", "2d", "3w" between two times in milliseconds. */
export function ago(now: number, at: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

// ── Idea Shelf ─────────────────────────────────────────────────────────────

export function shelfKey(root: string): string {
  return `shelf:${root}`
}

/** What the store holds under a shelf key, read defensively. */
export function readIdeas(raw: unknown): WorkbenchIdea[] {
  if (!Array.isArray(raw)) return []
  const ideas: WorkbenchIdea[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const { id, text, at } = item as Record<string, unknown>
    if (typeof id !== 'string' || typeof text !== 'string' || text.trim() === '') continue
    ideas.push({ id, text, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 })
  }
  return ideas.slice(0, MAX_IDEAS)
}

/** A new idea goes on top; the shelf keeps the newest 100. */
export function addIdea(ideas: readonly WorkbenchIdea[], idea: WorkbenchIdea): WorkbenchIdea[] {
  return [idea, ...ideas.filter(one => one.id !== idea.id)].slice(0, MAX_IDEAS)
}

export function removeIdeas(ideas: readonly WorkbenchIdea[], ids: readonly string[]): WorkbenchIdea[] {
  return ideas.filter(one => !ids.includes(one.id))
}

export function editIdea(ideas: readonly WorkbenchIdea[], id: string, text: string): WorkbenchIdea[] {
  return ideas.map(one => (one.id === id ? { ...one, text } : one))
}

/** "Parked on the shelf (4 ideas for earshot)." */
export function parkedReply(count: number, project: string): string {
  return `Parked on the shelf (${plural(count, 'idea')} for ${project}).`
}

/** The right side of the shelf's title: "earshot · 4 ideas". */
export function shelfRight(root: string, count: number): string {
  return `${projectName(root)} · ${plural(count, 'idea')}`
}

/** One prompt holding every idea, oldest first, numbered. */
export function allIdeasPrompt(ideas: readonly WorkbenchIdea[]): string {
  const ordered = [...ideas].sort((a, b) => a.at - b.at)
  const rows = ordered.map((idea, index) => `${index + 1}. ${idea.text.trim()}`)
  return [ALL_INTRO, ...rows].join('\n')
}

/**
 * Whether a submitted text carries `block` whole, on lines of its own, as the
 * prompt box got it from a fill (alone, or after a blank line): never a mere
 * substring of the person's own sentence.
 */
export function carriesBlock(text: string, block: string, isNumbered = false): boolean {
  const body = text.replace(/\r\n/g, '\n')
  const want = block.replace(/\r\n/g, '\n').trim()
  if (want === '') return false
  for (let at = body.indexOf(want); at >= 0; at = body.indexOf(want, at + 1)) {
    const lineStart = body.lastIndexOf('\n', at - 1) + 1
    const after = at + want.length
    const lineEnd = body.indexOf('\n', after)
    const before = body.slice(lineStart, at)
    const rest = body.slice(after, lineEnd < 0 ? body.length : lineEnd)
    const isOwnLine = before.trim() === '' || (isNumbered && /^\s*\d+\. $/.test(before))
    if (isOwnLine && rest.trim() === '') return true
  }
  return false
}

/**
 * The filled ideas a submitted prompt carries whole (the person sent what was
 * filled): alone on lines of their own, or as a numbered row of Send all's
 * prompt when the prompt also carries that prompt's opening line.
 */
export function sentIdeaIds(text: string, ideas: readonly WorkbenchIdea[], filled: readonly string[]): string[] {
  if (text.trim() === '') return []
  const isList = carriesBlock(text, ALL_INTRO)
  return ideas
    .filter(idea => filled.includes(idea.id) && carriesBlock(text, idea.text, isList))
    .map(idea => idea.id)
}

export const SHELF_UI_CLEAR: WorkbenchShelfUi = { editingId: null, armedId: null, notice: null }

/** The armed Delete's words for the cells left beside Send and Edit. */
export function armedLabel(room: number): string {
  return [DELETE_ARMED, 'Again to delete', 'Sure?'].find(option => cells(option) <= room) ?? 'Sure?'
}

/** A footer's label: the full one where it fits, else the short one. */
export function labelFor(full: string, short: string, room: number): string {
  return cells(full) + 2 <= room ? full : short
}

// ── Assumption Check ───────────────────────────────────────────────────────

/** The tool's arguments as one guess, or null when `assumption` is missing. */
export function readGuessInput(input: unknown): { text: string; why: string } | null {
  if (typeof input !== 'object' || input === null) return null
  const args = input as Record<string, unknown>
  const raw = args['assumption']
  if (typeof raw !== 'string') return null
  const text = oneLine(raw).slice(0, 400)
  if (text === '') return null
  const whyRaw = args['why']
  const why = typeof whyRaw === 'string' ? oneLine(whyRaw).slice(0, 400) : ''
  return { text, why }
}

/** Adds a guess unless the same one (ignoring case) is already waiting; keeps the newest 50. */
export function addGuess(list: readonly WorkbenchGuess[], guess: WorkbenchGuess): WorkbenchGuess[] {
  const key = guess.text.toLowerCase()
  if (list.some(one => one.text.toLowerCase() === key)) return [...list]
  return [...list, guess].slice(-MAX_GUESSES)
}

/** Sets a guess's mark; choosing the mark it already has clears it. */
export function markGuess(list: readonly WorkbenchGuess[], id: string, mark: WorkbenchMark): WorkbenchGuess[] {
  return list.map(one => (one.id === id ? { ...one, mark: one.mark === mark ? null : mark } : one))
}

export function correctGuess(list: readonly WorkbenchGuess[], id: string, correction: string): WorkbenchGuess[] {
  return list.map(one => (one.id === id ? { ...one, correction } : one))
}

export function checkedCount(list: readonly WorkbenchGuess[]): number {
  return list.filter(one => one.mark !== null).length
}

/** "2 of 3 checked". */
export function checkedLine(list: readonly WorkbenchGuess[]): string {
  return `${checkedCount(list)} of ${list.length} checked`
}

export function wrongCount(list: readonly WorkbenchGuess[]): number {
  return list.filter(one => one.mark === 'wrong').length
}

function withoutStop(text: string): string {
  return text.trim().replace(/[.\s]+$/, '')
}

/** The corrections prompt: one numbered line per wrong guess, its correction when given. */
export function correctionsPrompt(list: readonly WorkbenchGuess[]): string {
  const wrong = list.filter(one => one.mark === 'wrong')
  const rows = wrong.map((one, index) => {
    const guess = withoutStop(one.text)
    const fix = one.correction.trim()
    if (fix === '') return `${index + 1}. You assumed ${guess}. That's wrong.`
    const ending = /[.!?]$/.test(fix) ? '' : '.'
    return `${index + 1}. You assumed ${guess}. That's wrong: ${fix}${ending}`
  })
  return [CORRECTIONS_INTRO, ...rows].join('\n')
}

/** After corrections went to Claude: every marked guess is done; unchecked ones stay. */
export function afterSend(list: readonly WorkbenchGuess[]): WorkbenchGuess[] {
  return list.filter(one => one.mark === null)
}

/** The ids of the guesses the person marked, which a sent corrections prompt settles. */
export function markedIds(list: readonly WorkbenchGuess[]): string[] {
  return list.filter(one => one.mark !== null).map(one => one.id)
}

/** After corrections filled into the prompt box were sent: those guesses, if still marked, are done. */
export function afterFilledSend(list: readonly WorkbenchGuess[], ids: readonly string[]): WorkbenchGuess[] {
  return list.filter(one => !(ids.includes(one.id) && one.mark !== null))
}

/** Whether a submitted prompt carries a corrections prompt (its opening line). */
export function carriesCorrections(text: string): boolean {
  return text.includes(CORRECTIONS_INTRO)
}

/**
 * At the end of a main turn: every guess noted since the last one ended joins
 * what the band announces (a background helper's between turns included).
 * Returns the ids the band announces from now on, or null when nothing new was
 * noted.
 */
export function announce(list: readonly WorkbenchGuess[], announced: readonly string[]): string[] | null {
  const fresh = list.filter(one => one.isAnnounced !== true).map(one => one.id)
  if (fresh.length === 0) return null
  const kept = announced.filter(id => !fresh.includes(id) && list.some(one => one.id === id))
  return [...kept, ...fresh]
}

/** The guesses with those ids marked as announced. */
export function markAnnounced(list: readonly WorkbenchGuess[], ids: readonly string[]): WorkbenchGuess[] {
  return list.map(one => (ids.includes(one.id) && one.isAnnounced !== true ? { ...one, isAnnounced: true } : one))
}

/** How many guesses the band announces that are still waiting to be checked. */
export function bandCount(list: readonly WorkbenchGuess[], announced: readonly string[]): number {
  return list.filter(one => one.mark === null && announced.includes(one.id)).length
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nodeText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (typeof node === 'object' && node !== null) return nodeText((node as { children?: unknown }).children ?? [])
  return ''
}

/**
 * About how many rows a drawn tree takes, unwrapped: a Text a row per line, a column Box its children's
 * sum, a row Box its tallest child, borders and spacing counted. The engine's own node counts none
 * (an empty band draws nothing). Used to leave room for the band another plugin draws beneath
 * (the same count as studio's).
 */
export function treeRows(node: unknown): number {
  if (node === null || node === undefined || typeof node === 'boolean') return 0
  if (typeof node === 'string' || typeof node === 'number') return String(node).split('\n').length
  if (Array.isArray(node)) return node.reduce((sum: number, child: unknown) => sum + treeRows(child), 0)
  if (typeof node !== 'object') return 0
  const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown }
  const props = element.props ?? {}
  if (props.display === 'none') return 0
  const children = Array.isArray(element.children) ? (element.children as unknown[]).flat(Infinity) : []
  switch (element.type) {
    case 'engine':
      return 0
    case 'Text':
      return Math.max(1, nodeText(children).split('\n').length)
    case 'Box': {
      const direction = props.flexDirection
      const isColumn = direction === 'column' || direction === 'column-reverse'
      const sizes = children.map(child => treeRows(child))
      const inner = isColumn ? sizes.reduce((sum, rows) => sum + rows, 0) : Math.max(0, ...sizes)
      const hasBorder = typeof props.borderStyle === 'string' && props.borderStyle !== ''
      const border = hasBorder ? (props.borderTop === false ? 0 : 1) + (props.borderBottom === false ? 0 : 1) : 0
      const padding = numberOr(props.paddingTop, numberOr(props.paddingY, numberOr(props.padding))) +
        numberOr(props.paddingBottom, numberOr(props.paddingY, numberOr(props.padding)))
      const margin = numberOr(props.marginTop, numberOr(props.marginY, numberOr(props.margin))) +
        numberOr(props.marginBottom, numberOr(props.marginY, numberOr(props.margin)))
      const height = typeof props.height === 'number' ? props.height : Math.max(numberOr(props.minHeight), inner + padding + border)
      return Math.max(0, height) + margin
    }
    default: {
      if (typeof props.rows === 'number') return Math.max(0, props.rows)
      const text = typeof props.text === 'string' ? props.text : typeof props.source === 'string' ? props.source : null
      return text === null ? 1 : Math.max(1, text.split('\n').length)
    }
  }
}

/** On Close: right and skipped guesses are done; wrong (unsent) and unchecked stay. */
export function afterClose(list: readonly WorkbenchGuess[]): WorkbenchGuess[] {
  return list.filter(one => one.mark === null || one.mark === 'wrong')
}

/** Whether the section belongs in a request offering these tools: workbench's own tool, by its listed name. */
export function offersTool(tools: readonly string[]): boolean {
  return tools.includes(TOOL_NAME)
}

/**
 * The band's words for `count` guesses in `room` cells beside its chips:
 * the longest that fits, down to the bare count.
 */
export function bandText(count: number, room: number): string {
  const word = count === 1 ? 'guess' : 'guesses'
  const options = [`◆ Claude made ${count} ${word} · `, `◆ ${count} ${word} · `, `◆ ${count} · `]
  return options.find(option => cells(option) <= room) ?? ''
}

/** The band's chips, by what fits: both, just the gold one, or none. */
export function bandLayout(count: number, columns: number): { text: string; hasCheck: boolean; hasDismiss: boolean } {
  const check = cells(' Check them ')
  const dismiss = cells('Dismiss')
  const both = check + 1 + dismiss
  if (columns >= both + cells(`◆ ${count} · `)) {
    return { text: bandText(count, columns - both), hasCheck: true, hasDismiss: true }
  }
  if (columns >= check + cells(`◆ ${count} · `)) {
    return { text: bandText(count, columns - check), hasCheck: true, hasDismiss: false }
  }
  return { text: fit(`◆ ${count}`, columns), hasCheck: false, hasDismiss: false }
}

// ── Reflect ────────────────────────────────────────────────────────────────

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_/i,
  /AKIA[0-9A-Z]{16}/,
  /xox[abprs]-/,
  /-----BEGIN/,
  /eyJ[A-Za-z0-9_-]{10,}\./,
  /\b(password|passwd|secret|api[_-]?key|token|bearer)\b\s*[:=]\s*\S+/i,
  /\b(?!git@)[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i,
]

/**
 * True for a run of 32 or more key characters that reads as random rather than
 * as words: at least 3 digits, mixed case or a quarter digits, and one piece
 * of 16 or more between `_` and `-`. So `regenerate_fixtures_for_parser_v3`
 * stays, a 40-character key does not.
 */
function hasRandomRun(text: string): boolean {
  for (const run of text.match(/[A-Za-z0-9_-]{32,}/g) ?? []) {
    const digits = run.replace(/[^0-9]/g, '').length
    if (digits < 3) continue
    const isMixedCase = /[a-z]/.test(run) && /[A-Z]/.test(run)
    const longest = Math.max(...run.split(/[_-]+/).map(part => part.length))
    if ((isMixedCase || digits / run.length >= 0.25) && longest >= 16) return true
  }
  return false
}

/** True when a line carries something that looks like a credential or an email address. */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text)) || hasRandomRun(text)
}

/**
 * One suggested line cleaned: one line, no bullet or number, no quotes that
 * wrap the whole line (a line that starts and ends with code spans keeps
 * them), at most 240 characters.
 */
export function cleanSuggestion(raw: string): string {
  let text = oneLine(raw)
  text = text.replace(/^([-*+•]|\d+[.)])\s+/, '')
  for (const quote of ['"', "'", '`']) {
    if (text.length >= 2 && text.startsWith(quote) && text.endsWith(quote) && !text.slice(1, -1).includes(quote)) {
      text = text.slice(1, -1).trim()
      break
    }
  }
  return text.length > 240 ? `${text.slice(0, 239).trimEnd()}…` : text
}

/** A line as compared for duplicates: no bullet, lower case, single spaces, no closing stop. */
export function normLine(text: string): string {
  return oneLine(text)
    .replace(/^([-*+•]|\d+[.)])\s+/, '')
    .replace(/[.\s]+$/, '')
    .toLowerCase()
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The fork's reply as up to six suggestions, or null when no JSON could be
 * read from it. Accepts a code fence, prose around the object, a bare array,
 * and items given as plain strings; drops empty, duplicate and secret-looking
 * lines.
 */
export function parseReflect(reply: string): { text: string; why: string }[] | null {
  // Only a fence around the whole reply is taken off: ``` inside a line stays.
  const body = reply
    .trim()
    .replace(/^```[\w-]*[ \t]*\r?\n/, '')
    .replace(/\r?\n[ \t]*```$/, '')
    .trim()
  let data = parseJsonLoose(body)
  if (data === undefined) {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start >= 0 && end > start) data = parseJsonLoose(body.slice(start, end + 1))
  }
  if (data === undefined) {
    const start = body.indexOf('[')
    const end = body.lastIndexOf(']')
    if (start >= 0 && end > start) data = parseJsonLoose(body.slice(start, end + 1))
  }
  if (data === undefined || data === null) return null
  let items: unknown
  if (Array.isArray(data)) items = data
  else if (typeof data === 'object') {
    const record = data as Record<string, unknown>
    items = record['lines'] ?? record['suggestions'] ?? record['instructions']
  }
  if (!Array.isArray(items)) return null
  const seen = new Set<string>()
  const out: { text: string; why: string }[] = []
  for (const item of items) {
    let rawText: unknown
    let rawWhy: unknown
    if (typeof item === 'string') rawText = item
    else if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>
      rawText = record['text'] ?? record['line'] ?? record['instruction']
      rawWhy = record['why'] ?? record['reason']
    }
    if (typeof rawText !== 'string') continue
    const text = cleanSuggestion(rawText)
    const why = typeof rawWhy === 'string' ? oneLine(rawWhy).slice(0, 200) : ''
    if (text === '' || looksSecret(text) || looksSecret(why)) continue
    const key = normLine(text)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push({ text, why })
    if (out.length === MAX_LINES) break
  }
  return out
}

/** The normalized lines a file already holds. */
export function presentLines(existing: string): Set<string> {
  return new Set(
    existing
      .split(/\r?\n/)
      .map(normLine)
      .filter(row => row !== ''),
  )
}

/** Suggestions as pane items: Keep by default, Skip when CLAUDE.md already has the line. */
export function toItems(lines: readonly { text: string; why: string }[], existing: string): WorkbenchReflectItem[] {
  const present = presentLines(existing)
  return lines.map(line => {
    const isPresent = present.has(normLine(line.text))
    return { text: line.text, why: line.why, keep: !isPresent, isPresent }
  })
}

export function keptLines(items: readonly WorkbenchReflectItem[]): string[] {
  return items.filter(item => item.keep).map(item => item.text)
}

/** "Add 3 lines to CLAUDE.md". */
export function addLabel(count: number): string {
  return `Add ${plural(count, 'line')} to CLAUDE.md`
}

export function addedNotice(count: number): string {
  return `Added ${plural(count, 'line')} to CLAUDE.md.`
}

/** The kept lines as a Markdown list, for the clipboard. */
export function copyText(lines: readonly string[]): string {
  return lines.map(line => `- ${line}`).join('\n')
}

/** A text's rows, each keeping its own line ending; the last may have none. */
function rowsOf(text: string): string[] {
  return text === '' ? [] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? [])
}

function bareRow(row: string): string {
  return row.replace(/\r?\n$/, '')
}

/** For each row, whether it belongs to a fenced code block (``` or ~~~), its fences included. */
export function fencedRows(rows: readonly string[]): boolean[] {
  let fence = ''
  return rows.map(row => {
    if (fence === '') {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(row)
      if (open === null) return false
      fence = open[1]!
      return true
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(row)
    if (close !== null && close[1]![0] === fence[0] && close[1]!.length >= fence.length) fence = ''
    return true
  })
}

/**
 * Appends lines at the end of the file's `## Learned` section, creating the
 * heading at the end when absent, and skipping lines the file already holds
 * anywhere (compared without case, bullet or closing stop). Headings inside
 * fenced code blocks are not headings. Every row already there is kept as it
 * was, its own line ending included; new rows use the file's (CRLF when it has
 * any). Returns the new text and the lines actually added.
 */
export function appendLearned(existing: string, lines: readonly string[]): { text: string; added: string[] } {
  const present = presentLines(existing)
  const added: string[] = []
  for (const raw of lines) {
    const line = cleanSuggestion(raw)
    const key = normLine(line)
    if (key === '' || present.has(key)) continue
    present.add(key)
    added.push(line)
  }
  if (added.length === 0) return { text: existing, added }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const bullets = added.map(line => `- ${line}${eol}`)
  const rows = rowsOf(existing)
  const bare = rows.map(bareRow)
  const fenced = fencedRows(bare)
  const isHeading = (index: number, pattern: RegExp) => fenced[index] !== true && pattern.test(bare[index]!)
  const ended = (row: string) => (row.endsWith('\n') ? row : `${row}${eol}`)
  const out = [...rows]
  const heading = bare.findIndex((_, index) => isHeading(index, /^ {0,3}##\s+Learned\s*$/i))
  if (heading < 0) {
    if (out.length > 0) {
      out[out.length - 1] = ended(out[out.length - 1]!)
      if (bare[bare.length - 1]!.trim() !== '') out.push(eol)
    }
    out.push(`## Learned${eol}`, eol, ...bullets)
    return { text: out.join(''), added }
  }
  let end = rows.length
  for (let index = heading + 1; index < rows.length; index++) {
    if (isHeading(index, /^ {0,3}#{1,2}\s/)) {
      end = index
      break
    }
  }
  let at = end
  while (at > heading + 1 && bare[at - 1]!.trim() === '') at -= 1
  out[at - 1] = ended(out[at - 1]!)
  const following = out[at]
  const lead = at === heading + 1 ? [eol] : []
  const tail = following !== undefined && bareRow(following).trim() !== '' ? [eol] : []
  out.splice(at, 0, ...lead, ...bullets, ...tail)
  return { text: out.join(''), added }
}

export const REFLECT_IDLE: WorkbenchReflect = {
  step: 'idle',
  target: '',
  isNew: false,
  items: [],
  notice: null,
  isAdded: false,
  seq: 0,
}

/** A suggestion's Keep/Skip flipped to `keep`. */
export function setKeep(items: readonly WorkbenchReflectItem[], index: number, keep: boolean): WorkbenchReflectItem[] {
  return items.map((item, at) => (at === index ? { ...item, keep } : item))
}

/** The plain-text form of a pane, for the transcript when the pane cannot be placed. */
export function shelfAsText(root: string, ideas: readonly WorkbenchIdea[]): string {
  if (ideas.length === 0) return SHELF_EMPTY
  return [`Idea shelf for ${projectName(root)}:`, ...ideas.map((idea, index) => `${index + 1}. ${firstLine(idea.text)}`)].join('\n')
}

export function guessesAsText(list: readonly WorkbenchGuess[]): string {
  if (list.length === 0) return ASSUME_EMPTY
  return ['Guesses Claude made:', ...list.map((one, index) => `${index + 1}. ${one.text}`)].join('\n')
}
