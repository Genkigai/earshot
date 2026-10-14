// Pure logic for studio: parsing, formatting and state transitions.
// No `$` and nothing drawn, so every function here can be tested directly.

import type { ConfigRow, PromptOrigin } from 'claude-code'

import type {
  StudioAccent,
  StudioImage,
  StudioJob,
  StudioSettings,
  StudioTheme,
  StudioTodo,
} from '../types'
import { cells, fit, meterParts, pad, took } from './look-text'

// ---------------------------------------------------------------------------
// Settings

export const DEFAULT_SETTINGS: StudioSettings = { isOn: true, progress: true, preview: true, accent: 'gold' }

export const ACCENTS: Record<StudioAccent, { hex: string; label: string }> = {
  gold: { hex: '#F2C46D', label: 'Gold' },
  teal: { hex: '#4FD1C5', label: 'Teal' },
  violet: { hex: '#B392F0', label: 'Violet' },
  coral: { hex: '#F78C6C', label: 'Coral' },
}

export const ACCENT_ORDER: readonly StudioAccent[] = ['gold', 'teal', 'violet', 'coral']

function isAccent(value: unknown): value is StudioAccent {
  return value === 'gold' || value === 'teal' || value === 'violet' || value === 'coral'
}

/** Settings read back from the store, every field checked and defaulted. */
export function readSettings(raw: unknown): StudioSettings {
  const from = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    isOn: typeof from.isOn === 'boolean' ? from.isOn : DEFAULT_SETTINGS.isOn,
    progress: typeof from.progress === 'boolean' ? from.progress : DEFAULT_SETTINGS.progress,
    preview: typeof from.preview === 'boolean' ? from.preview : DEFAULT_SETTINGS.preview,
    accent: isAccent(from.accent) ? from.accent : DEFAULT_SETTINGS.accent,
  }
}

export function accentHex(settings: StudioSettings | null | undefined): string {
  return ACCENTS[settings?.accent ?? 'gold'].hex
}

/** `on`, `off`, `''` for nothing typed, or null for anything else. */
export function parseSwitch(args: string): 'on' | 'off' | '' | null {
  const word = args.trim().toLowerCase()
  if (word === '') return ''
  if (word === 'on' || word === 'yes' || word === 'true') return 'on'
  if (word === 'off' || word === 'no' || word === 'false') return 'off'
  return null
}

// ---------------------------------------------------------------------------
// Jobs: one per real prompt

const REAL_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

/** Where a prompt came from, as `prompt.submit` stamps it, or just its kind. */
export type OriginLike = PromptOrigin | PromptOrigin['kind']

/** The person's own words: typed, sent from their phone or the SDK host, or a plugin's prompt sent `asUser` (a Run or Send of theirs). */
export function isPersonsOrigin(origin: OriginLike): boolean {
  if (typeof origin === 'string') return REAL_ORIGINS.has(origin)
  if (REAL_ORIGINS.has(origin.kind)) return true
  return origin.kind === 'plugin' && origin.asUser === true
}

/** The command a prompt starts with (`/compact keep it` gives `compact`), or null. A path like `/src/a.ts` names none. */
export function slashName(text: string): string | null {
  const match = /^\/([\w:.-]+)(\s|$)/.exec(text.trim())
  return match?.[1] ?? null
}

/**
 * A prompt that starts a job: the person's own words, not a slash command. `isCommand` says whether a
 * leading `/word` names a command this session has; without it every leading `/word` counts as one.
 */
export function isRealPrompt(text: string, origin: OriginLike, isCommand?: (name: string) => boolean): boolean {
  if (!isPersonsOrigin(origin) || text.trim() === '') return false
  const name = slashName(text)
  if (name === null) return true
  return isCommand === undefined ? false : !isCommand(name)
}

/** A prompt of the person's noted at `prompt.submit`, waiting for the turn it starts. */
export type PendingPrompt = {
  /** The text as it reached studio's hook. */
  typed: string
  /** The text that entered the session, once `next(e)` said so; null while it is still on its way. */
  entered: string | null
  /** True while studio's `prompt.submit` hook waits on `next(e)` for it. */
  inFlight: boolean
}

/** How many noted prompts studio keeps waiting for their turn (one typed mid-turn may never get one). */
export const PENDING_CAP = 5

/**
 * Which noted prompt a starting turn belongs to, by its text: one still inside its submit first,
 * then one that entered and waits its turn; -1 when the turn is no prompt of the person's.
 */
export function claimIndex(pending: readonly PendingPrompt[], turnText: string): number {
  const text = turnText.trim()
  if (text === '') return -1
  const inFlight = pending.findIndex(note => note.inFlight && note.typed.trim() === text)
  if (inFlight >= 0) return inFlight
  return pending.findIndex(note => !note.inFlight && (note.typed.trim() === text || note.entered?.trim() === text))
}

/** The first line worth naming a job after: outside code fences, not a fence marker. */
function firstProseLine(text: string): string {
  const rows = plain(text).split(/\r?\n/)
  let inFence = false
  for (const row of rows) {
    const trimmed = row.trim()
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (!inFence && trimmed !== '') return row
  }
  return rows.find(row => row.trim() !== '' && !/^(```|~~~)/.test(row.trim())) ?? ''
}

/** The job's name: the prompt's first clause, about 40 cells, cut at a word. */
export function jobName(text: string, max = 40): string {
  let clause = oneLine(firstProseLine(text))
  const stop = clause.search(/[.!?;:](\s|$)|,\s|\s[-–—]\s/)
  if (stop > 0) clause = clause.slice(0, stop)
  clause = clause.replace(/^(please|pls|hey|ok|okay|so|can you|could you|would you)[,\s]+/i, '').trim()
  clause = clause.replace(/^(please)[,\s]+/i, '').trim()
  if (clause === '') return 'Untitled job'
  clause = clause.charAt(0).toUpperCase() + clause.slice(1)
  if (cells(clause) <= max) return clause
  const chars = Array.from(clause)
  const head = chars.slice(0, max - 1).join('')
  const endsWord = chars[max - 1] === ' '
  const space = head.lastIndexOf(' ')
  const cut = endsWord ? head : space >= Math.floor(max / 2) ? head.slice(0, space) : head
  return `${cut.replace(/[\s,;:.-]+$/, '')}…`
}

/** A fresh job. Steps the last job left unfinished carry over (the task tools keep one list per session). */
export function startJob(name: string, now: number, previous: StudioJob | null): StudioJob {
  const carried = previous?.todos.some(todo => todo.status !== 'completed') ? previous.todos : []
  return {
    name,
    startedAt: now,
    endedAt: null,
    phase: 'working',
    step: 'Thinking',
    reason: '',
    failures: 0,
    todos: carried,
  }
}

export function isActive(job: StudioJob | null | undefined): job is StudioJob {
  return job !== null && job !== undefined && (job.phase === 'working' || job.phase === 'needs' || job.phase === 'stuck')
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Terminal escape sequences (colours, cursor moves, titles) as pasted terminal output carries them. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g

/** Text with its escape sequences and control characters gone (tab, newline and carriage return kept). */
export function plain(text: string): string {
  return text.replace(ANSI, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

/** One line of drawable text: no escape sequences, no control characters, whitespace collapsed. */
function oneLine(text: string): string {
  return plain(text).replace(/\s+/g, ' ').trim()
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(part => part !== '')
  return parts.at(-1) ?? path
}

function hostOrText(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The current step in plain words, from a tool call: `Edit app.js`, `Bash npm test`. */
export function stepLabel(tool: string, input: Readonly<Record<string, unknown>>): string {
  let label: string
  switch (tool) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'MultiEdit':
    case 'NotebookEdit':
      label = `${tool} ${baseName(str(input.file_path) || str(input.notebook_path))}`
      break
    case 'Bash':
      label = `Bash ${str(input.command).split(/\r?\n/)[0] ?? ''}`
      break
    case 'Grep':
    case 'Glob':
      label = `${tool} ${str(input.pattern)}`
      break
    case 'WebFetch':
      label = `WebFetch ${hostOrText(str(input.url))}`
      break
    case 'WebSearch':
      label = `WebSearch ${str(input.query)}`
      break
    case 'Agent':
    case 'Task':
      label = `Agent ${str(input.description)}`
      break
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      label = 'Planning'
      break
    case 'AskUserQuestion':
      label = 'Asking you'
      break
    case 'Skill':
      label = `Skill ${str(input.skill)}`
      break
    default:
      if (tool.startsWith('mcp__')) {
        const parts = tool.split('__')
        label = `${parts[1] ?? ''} ${parts.slice(2).join('__')}`
      } else {
        label = tool
      }
  }
  const shown = oneLine(label)
  return Array.from(shown).length > 120 ? fit(shown, 120) : shown
}

// ---------------------------------------------------------------------------
// The to-do list, from whichever to-do tools this build has

type Status = StudioTodo['status']

function asStatus(value: unknown): Status | null {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : null
}

/** TodoWrite's `todos` input, the whole list each time. */
export function todosFromTodoWrite(raw: unknown): StudioTodo[] | null {
  if (!Array.isArray(raw)) return null
  const list: StudioTodo[] = []
  raw.forEach((item: unknown, index) => {
    if (typeof item !== 'object' || item === null) return
    const one = item as Record<string, unknown>
    const status = asStatus(one.status)
    const name = oneLine(str(one.content) || str(one.activeForm))
    if (status !== null && name !== '') list.push({ id: String(index + 1), name, status })
  })
  return list
}

/** TaskList's result, `{ tasks: [{ id, subject, status }] }`: the whole list. */
export function todosFromTaskList(result: unknown): StudioTodo[] | null {
  if (typeof result !== 'object' || result === null) return null
  const tasks = (result as Record<string, unknown>).tasks
  if (!Array.isArray(tasks)) return null
  const list: StudioTodo[] = []
  for (const item of tasks as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const one = item as Record<string, unknown>
    const status = asStatus(one.status)
    const name = oneLine(str(one.subject))
    if (status !== null && name !== '') list.push({ id: str(one.id) || String(list.length + 1), name, status })
  }
  return list
}

/** TaskCreate: its input names the step, its result `{ task: { id } }` gives the id. */
export function addTask(list: readonly StudioTodo[], subject: string, result: unknown): StudioTodo[] {
  const task =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>).task : undefined
  const fromResult = typeof task === 'object' && task !== null ? (task as Record<string, unknown>) : {}
  const id = str(fromResult.id) || `t${list.length + 1}`
  const name = oneLine(subject || str(fromResult.subject))
  if (name === '' || list.some(todo => todo.id === id)) return [...list]
  return [...list, { id, name, status: 'pending' }]
}

/** TaskUpdate: `{ taskId, status?, subject? }`; `deleted` drops the step. */
export function updateTask(list: readonly StudioTodo[], input: Readonly<Record<string, unknown>>): StudioTodo[] {
  const id = str(input.taskId)
  if (input.status === 'deleted') return list.filter(todo => todo.id !== id)
  const status = asStatus(input.status)
  const subject = oneLine(str(input.subject))
  return list.map(todo =>
    todo.id === id ? { ...todo, status: status ?? todo.status, name: subject || todo.name } : todo,
  )
}

export type CheckKind = 'done' | 'working' | 'next' | 'later'
export type CheckRow = { name: string; kind: CheckKind; word: string }

/** The checklist rows: done steps, the one in progress, then `Next` and `Up next`. */
export function checklist(todos: readonly StudioTodo[]): CheckRow[] {
  let hasNext = false
  return todos.map(todo => {
    if (todo.status === 'completed') return { name: todo.name, kind: 'done', word: 'Done' }
    if (todo.status === 'in_progress') return { name: todo.name, kind: 'working', word: 'Working' }
    if (!hasNext) {
      hasNext = true
      return { name: todo.name, kind: 'next', word: 'Next' }
    }
    return { name: todo.name, kind: 'later', word: 'Up next' }
  })
}

/** Which rows show in `room` rows (the `N more` row included), the step in progress kept in view. */
export function checklistWindow(rows: readonly CheckRow[], room: number, cap = 6): { shown: CheckRow[]; more: number } {
  const space = Math.max(0, room)
  if (rows.length <= Math.min(cap, space)) return { shown: [...rows], more: 0 }
  const count = Math.max(0, Math.min(cap, space - 1))
  if (count === 0) return { shown: [], more: space > 0 ? rows.length : 0 }
  const focus = rows.findIndex(row => row.kind !== 'done')
  const anchor = focus < 0 ? rows.length - 1 : focus
  const start = Math.max(0, Math.min(anchor - 1, rows.length - count))
  return { shown: rows.slice(start, start + count), more: rows.length - count }
}

export function percentDone(todos: readonly StudioTodo[]): number {
  if (todos.length === 0) return 0
  return (todos.filter(todo => todo.status === 'completed').length / todos.length) * 100
}

// ---------------------------------------------------------------------------
// Job state transitions

export const STUCK_AFTER = 3

export function stuckSentence(step: string, failures = STUCK_AFTER): string {
  return `The last ${failures} tool calls failed · ${step}`
}

/**
 * After the tool call that showed `step` settled: a failure counts toward Stuck, a success clears it
 * (and Needs you). The step goes back to `Thinking` unless another call has named one since.
 */
export function afterTool(job: StudioJob, isFailure: boolean, step: string = job.step): StudioJob {
  if (!isActive(job)) return job
  const nextStep = job.step === step ? 'Thinking' : job.step
  if (isFailure) {
    const failures = job.failures + 1
    if (failures >= STUCK_AFTER) return { ...job, step: nextStep, failures, phase: 'stuck', reason: stuckSentence(step, failures) }
    const wasWaiting = job.phase === 'needs'
    return { ...job, step: nextStep, failures, phase: wasWaiting ? 'working' : job.phase, reason: wasWaiting ? '' : job.reason }
  }
  return { ...job, step: nextStep, failures: 0, phase: 'working', reason: '' }
}

/**
 * After the tool call that showed `step` was refused (a hook's or a guard's deny, or the person's No):
 * neither a failure nor a success, so the Stuck count stands; the wait it may have raised is over.
 */
export function afterDeny(job: StudioJob, step: string = job.step): StudioJob {
  if (!isActive(job)) return job
  const nextStep = job.step === step ? 'Thinking' : job.step
  return job.phase === 'needs' ? { ...job, step: nextStep, phase: 'working', reason: '' } : { ...job, step: nextStep }
}

/** A tool call is starting: it names the step and ends a wait. */
export function beforeTool(job: StudioJob, step: string): StudioJob {
  if (!isActive(job)) return job
  return job.phase === 'needs' ? { ...job, step, phase: 'working', reason: '' } : { ...job, step }
}

/** The notifications that mean something waits on the person: a permission prompt or a question, a helper's too. */
const NEEDS_YOU = new Set([
  'permission_prompt',
  'worker_permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
])

/** What a notification means for the band: the reason it needs the person, or null when it does not. */
export function needsReason(message: string, notificationType: string): string | null {
  if (!NEEDS_YOU.has(notificationType)) return null
  const text = oneLine(message)
    .replace(/^claude (code )?(needs|is waiting for|wants) your\s+/i, '')
    .replace(/[.!]$/, '')
  return text === '' ? 'waiting for you' : text
}

export function needsYou(job: StudioJob, reason: string): StudioJob {
  if (!isActive(job)) return job
  return { ...job, phase: 'needs', reason }
}

/** The reason an AskUserQuestion call waits on the person. */
export function questionReason(input: Readonly<Record<string, unknown>>): string {
  const questions = Array.isArray(input.questions) ? (input.questions as unknown[]) : []
  const first = questions[0]
  const one = typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {}
  const label = oneLine(str(one.header) || str(one.question))
  return label === '' ? 'a question for you' : `a question: ${label}`
}

export type TurnEnd = 'answer' | 'aborted' | 'refusal' | 'error'

/** The end of the turn that carried the job. */
export function endJob(job: StudioJob, reason: TurnEnd, now: number): StudioJob {
  if (!isActive(job)) return job
  if (reason === 'answer') return { ...job, phase: 'done', endedAt: now, reason: '' }
  const why =
    reason === 'aborted' ? 'you pressed Esc' : reason === 'refusal' ? 'the model declined' : 'an error ended the turn'
  return { ...job, phase: 'stopped', endedAt: now, reason: why }
}

export function elapsedMs(job: StudioJob, now: number): number {
  const end = job.endedAt ?? Math.max(now, job.startedAt)
  return Math.max(0, end - job.startedAt)
}

// ---------------------------------------------------------------------------
// The band's model: every string already cut to the width it is drawn in

export type Tone = 'text' | 'muted' | 'good' | 'warn' | 'accent'

export type BandHeader = {
  glyph: string
  glyphTone: Tone
  left: string
  leftTone: Tone
  leftBold: boolean
  /** Cells between the left text and the right text, so the right one sits at the edge. */
  gap: number
  right: string
}

export type BandRow = {
  glyph: string
  glyphTone: Tone
  name: string
  nameTone: Tone
  nameBold: boolean
  meterFill: string
  meterRest: string
  meterTone: Tone
  word: string
  wordTone: Tone
}

export type BandModel = { header: BandHeader; rows: BandRow[]; more: string | null }

function headerFor(job: StudioJob, now: number): Omit<BandHeader, 'gap'> {
  const time = took(elapsedMs(job, now))
  switch (job.phase) {
    case 'needs':
      return {
        glyph: '‖',
        glyphTone: 'warn',
        left: `Needs you · ${job.reason}`,
        leftTone: 'warn',
        leftBold: true,
        right: `${job.name} · ${time}`,
      }
    case 'stuck':
      return {
        glyph: '⚠',
        glyphTone: 'warn',
        left: job.reason,
        leftTone: 'warn',
        leftBold: true,
        right: `${job.name} · ${time}`,
      }
    case 'stopped':
      return {
        glyph: '■',
        glyphTone: 'muted',
        left: `Stopped · ${job.name} · ${job.reason}`,
        leftTone: 'text',
        leftBold: false,
        right: '',
      }
    case 'done':
      return {
        glyph: '✓',
        glyphTone: 'good',
        left: `All done · ${job.name} · took ${time}`,
        leftTone: 'good',
        leftBold: true,
        right: '',
      }
    default:
      return {
        glyph: '◆',
        glyphTone: 'accent',
        left: `${job.name} · ${time}`,
        leftTone: 'text',
        leftBold: true,
        right: job.step,
      }
  }
}

const WORD_WIDTH = 7

function rowFor(row: CheckRow, columns: number, percent: number): BandRow {
  const meterWidth = columns >= 48 ? 10 : columns >= 34 ? 6 : 0
  const hasWord = columns >= 18
  const fixed = 2 + (meterWidth > 0 ? meterWidth + 2 : 0) + (hasWord ? WORD_WIDTH + 2 : 0)
  const nameWidth = Math.max(1, columns - fixed)
  const fill = row.kind === 'done' ? 100 : row.kind === 'working' ? Math.max(percent, 10) : 0
  const meter = meterParts(fill, meterWidth)
  const look: Record<CheckKind, Pick<BandRow, 'glyph' | 'glyphTone' | 'nameTone' | 'nameBold' | 'meterTone' | 'wordTone'>> = {
    done: { glyph: '✓', glyphTone: 'good', nameTone: 'muted', nameBold: false, meterTone: 'good', wordTone: 'muted' },
    working: { glyph: '▶', glyphTone: 'accent', nameTone: 'text', nameBold: true, meterTone: 'accent', wordTone: 'accent' },
    next: { glyph: '○', glyphTone: 'muted', nameTone: 'muted', nameBold: false, meterTone: 'muted', wordTone: 'muted' },
    later: { glyph: '○', glyphTone: 'muted', nameTone: 'muted', nameBold: false, meterTone: 'muted', wordTone: 'muted' },
  }
  return {
    ...look[row.kind],
    name: pad(row.name, nameWidth),
    meterFill: meter.fill,
    meterRest: meter.rest,
    word: hasWord ? pad(row.word, WORD_WIDTH) : '',
  }
}

/** The band for a job at `columns` wide and at most `maxRows` tall; null draws nothing. */
export function bandModel(job: StudioJob | null, now: number, columns: number, maxRows: number): BandModel | null {
  if (job === null || job.phase === 'hidden' || maxRows < 1 || columns < 4) return null
  const head = headerFor(job, now)
  const room = columns - 2
  const wantsRight = head.right !== '' && columns >= 30
  const rightWidth = wantsRight ? Math.min(cells(head.right), Math.floor(room * 0.4)) : 0
  const right = rightWidth > 0 ? fit(head.right, rightWidth) : ''
  const left = fit(head.left, room - (right !== '' ? cells(right) + 2 : 0))
  const gap = right !== '' ? Math.max(2, room - cells(left) - cells(right)) : 0
  const header: BandHeader = { ...head, left, right, gap }
  if (!isActive(job) || job.todos.length === 0) return { header, rows: [], more: null }
  const { shown, more } = checklistWindow(checklist(job.todos), maxRows - 1)
  const percent = percentDone(job.todos)
  const rows = shown.map(row => rowFor(row, columns, percent))
  return { header, rows, more: more > 0 ? fit(`  +${more} more`, columns) : null }
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
 * (an empty band draws nothing). Used to leave room for the band another plugin draws beneath.
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

// ---------------------------------------------------------------------------
// Images

export const MAX_KEEP_BYTES = 4 * 1024 * 1024
export const MAX_DRAW_BYTES = 2 * 1024 * 1024

/** Decoded size of base64 text. */
export function base64Bytes(b64: string): number {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

/** The first `max` bytes of base64 text, decoded. */
export function headBytes(b64: string, max: number): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '')
  const take = Math.min(clean.length, Math.ceil(max / 3) * 4)
  const cut = clean.slice(0, take - (take % 4))
  let raw = ''
  try {
    raw = atob(cut)
  } catch {
    return new Uint8Array(0)
  }
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp'
export type ImageSize = { kind: ImageKind; width: number; height: number }

function at(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = ''
  for (let i = start; i < start + length; i++) out += String.fromCharCode(at(bytes, i))
  return out
}

/** The kind and pixel size an image's header gives, or null when it gives none. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  // PNG: signature, then IHDR's width and height, big-endian.
  if (at(bytes, 0) === 0x89 && ascii(bytes, 1, 3) === 'PNG' && ascii(bytes, 12, 4) === 'IHDR') {
    const read = (i: number) => ((at(bytes, i) << 24) >>> 0) + (at(bytes, i + 1) << 16) + (at(bytes, i + 2) << 8) + at(bytes, i + 3)
    const width = read(16)
    const height = read(20)
    return width > 0 && height > 0 ? { kind: 'png', width, height } : null
  }
  // JPEG: walk the segments to the first start-of-frame.
  if (at(bytes, 0) === 0xff && at(bytes, 1) === 0xd8) {
    let i = 2
    while (i + 8 < bytes.length) {
      if (at(bytes, i) !== 0xff) {
        i++
        continue
      }
      const marker = at(bytes, i + 1)
      if (marker === 0xff) {
        i++
        continue
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      if (marker === 0xd9 || marker === 0xda) return null
      const length = (at(bytes, i + 2) << 8) + at(bytes, i + 3)
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) {
        const height = (at(bytes, i + 5) << 8) + at(bytes, i + 6)
        const width = (at(bytes, i + 7) << 8) + at(bytes, i + 8)
        return width > 0 && height > 0 ? { kind: 'jpeg', width, height } : null
      }
      if (length < 2) return null
      i += 2 + length
    }
    return null
  }
  // GIF: logical screen size, little-endian.
  if (ascii(bytes, 0, 4) === 'GIF8') {
    const width = at(bytes, 6) + (at(bytes, 7) << 8)
    const height = at(bytes, 8) + (at(bytes, 9) << 8)
    return width > 0 && height > 0 ? { kind: 'gif', width, height } : null
  }
  // WebP: lossy, lossless or extended.
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4)
    if (chunk === 'VP8 ') {
      return {
        kind: 'webp',
        width: (at(bytes, 26) + (at(bytes, 27) << 8)) & 0x3fff,
        height: (at(bytes, 28) + (at(bytes, 29) << 8)) & 0x3fff,
      }
    }
    if (chunk === 'VP8L') {
      const width = 1 + (((at(bytes, 22) & 0x3f) << 8) | at(bytes, 21))
      const height = 1 + (((at(bytes, 24) & 0x0f) << 10) | (at(bytes, 23) << 2) | ((at(bytes, 22) & 0xc0) >> 6))
      return { kind: 'webp', width, height }
    }
    if (chunk === 'VP8X') {
      const width = 1 + (at(bytes, 24) | (at(bytes, 25) << 8) | (at(bytes, 26) << 16))
      const height = 1 + (at(bytes, 27) | (at(bytes, 28) << 8) | (at(bytes, 29) << 16))
      return { kind: 'webp', width, height }
    }
  }
  return null
}

/** `512 B`, `240 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** One line about an image: `image.png · 1280×720 · 240 KB`. */
export function imageLine(image: Pick<StudioImage, 'name' | 'width' | 'height' | 'bytes'>): string {
  const parts = [image.name]
  if (image.width !== null && image.height !== null) parts.push(`${image.width}×${image.height}`)
  if (image.bytes > 0) parts.push(formatBytes(image.bytes))
  return parts.join(' · ')
}

/** The latest image from a prompt row's image block (`{ type: 'image', source: { type: 'base64', ... } }`). */
export function imageFromBlock(block: unknown, filename: string | undefined, now: number): StudioImage | null {
  if (typeof block !== 'object' || block === null) return null
  const one = block as Record<string, unknown>
  if (one.type !== 'image') return null
  const source = typeof one.source === 'object' && one.source !== null ? (one.source as Record<string, unknown>) : {}
  if (source.type !== 'base64' || typeof source.data !== 'string') return null
  const data = source.data
  const declared = str(source.media_type)
  const bytes = base64Bytes(data)
  let size = imageSize(headBytes(data, 256 * 1024))
  if (size === null && bytes <= MAX_KEEP_BYTES) size = imageSize(headBytes(data, bytes))
  const mediaType = size !== null ? `image/${size.kind}` : declared || 'image'
  const ext = EXT[mediaType] ?? EXT[declared] ?? 'img'
  const named = filename !== undefined ? oneLine(baseName(filename.trim())) : ''
  const name = named !== '' ? named : `image.${ext}`
  const canDraw = size?.kind === 'png' && bytes <= MAX_DRAW_BYTES
  return {
    name,
    mediaType,
    bytes,
    width: size?.width ?? null,
    height: size?.height ?? null,
    png: canDraw ? data : null,
    at: now,
  }
}

/** Details only, for an attachment whose bytes never reached the conversation row. */
export function imageFromAttachment(filename: string | undefined, mediaType: string | undefined, now: number): StudioImage {
  const type = mediaType ?? 'image'
  const named = filename !== undefined ? oneLine(baseName(filename.trim())) : ''
  const name = named !== '' ? named : `image.${EXT[type] ?? 'img'}`
  return { name, mediaType: type, bytes: 0, width: null, height: null, png: null, at: now }
}

export type ImageAction = 'pane' | 'status' | 'none'

/** A pane only where it docks as a sidebar on the terminal and the terminal can draw the picture. */
export function imageAction(input: {
  isOn: boolean
  hasTerminal: boolean
  isFullscreen: boolean | undefined
  canDraw: boolean
}): ImageAction {
  if (!input.isOn) return 'none'
  if (input.hasTerminal && input.isFullscreen === true && input.canDraw) return 'pane'
  return 'status'
}

/** The Image box in cells: as wide as the pane, as tall as the picture's shape asks (cells are about 1:2). */
export function imageCells(
  width: number | null,
  height: number | null,
  columns: number,
  rows: number,
): { columns: number; rows: number } {
  const maxColumns = Math.max(1, Math.min(255, columns))
  const maxRows = Math.max(1, Math.min(255, rows))
  if (width === null || height === null || width <= 0 || height <= 0) {
    return { columns: maxColumns, rows: Math.max(1, Math.min(maxRows, Math.round(maxColumns / 2))) }
  }
  const wantRows = Math.max(1, Math.round((maxColumns * height) / width / 2))
  if (wantRows <= maxRows) return { columns: maxColumns, rows: wantRows }
  const fitColumns = Math.max(1, Math.min(maxColumns, Math.round((maxRows * 2 * width) / height)))
  return { columns: fitColumns, rows: maxRows }
}

// ---------------------------------------------------------------------------
// Web addresses and pages

/** A full address from what was typed: `example.com/x` gains `https://`, `localhost:3000` gains `http://`. */
export function normalizeUrl(input: string): string | null {
  const typed = input.trim().replace(/^<|>$/g, '')
  if (typed === '' || /\s/.test(typed)) return null
  let candidate: string
  if (/^https?:\/\//i.test(typed)) {
    candidate = typed
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(typed) && !/^[a-z0-9.-]+:\d+/i.test(typed)) {
    return null
  } else {
    const host = typed.split(/[/?#]/)[0] ?? ''
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
    if (!isLocal && !/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(host)) return null
    candidate = `${isLocal ? 'http' : 'https'}://${typed}`
  }
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.hostname === '') return null
    return url.href
  } catch {
    return null
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** A link target from a page, made absolute against the page; null unless it is http or https. */
export function resolveHref(href: string, base: string): string | null {
  const raw = decodeEntities(href.trim())
  if (raw === '' || /^(javascript|data|vbscript):/i.test(raw)) return null
  try {
    const url = new URL(raw, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** The same page, a fragment aside. */
export function samePage(a: string, b: string): boolean {
  return a.split('#')[0] === b.split('#')[0]
}

export const BODY_CAP = 3 * 1024 * 1024
export const MARKDOWN_CAP = 60_000
export const FETCH_TIMEOUT_MS = 15_000
export const SEND_CAP = 6_000

export type BodyKind = 'html' | 'markdown' | 'text' | 'json' | 'other'

export function bodyKind(contentType: string | undefined, text: string): BodyKind {
  const type = (contentType ?? '').toLowerCase().split(';')[0]?.trim() ?? ''
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type === 'text/markdown' || type === 'text/x-markdown') return 'markdown'
  if (type === 'application/json' || type.endsWith('+json')) return 'json'
  if (type.startsWith('text/')) return 'text'
  if (type === '') {
    const start = text.trimStart().slice(0, 400).toLowerCase()
    if (start.startsWith('<!doctype html') || start.startsWith('<html') || /<(head|body|p|div)\b/.test(start)) return 'html'
    if (start.startsWith('{') || start.startsWith('[')) {
      try {
        JSON.parse(text)
        return 'json'
      } catch {
        return 'text'
      }
    }
    return 'text'
  }
  if (type === 'application/xml' || type === 'application/javascript') return 'text'
  return 'other'
}

export type Page = { ok: true; title: string; markdown: string } | { ok: false; reason: string }

/** A fetched response as a page to read, or the plain reason it is not one. */
export function pageFrom(
  url: string,
  response: { status: number; ok: boolean; headers: Readonly<Record<string, string>>; text: string },
): Page {
  if (!response.ok) return { ok: false, reason: `the server answered ${response.status}` }
  const contentType = response.headers['content-type']
  const body = response.text.length > BODY_CAP ? response.text.slice(0, BODY_CAP) : response.text
  const kind = bodyKind(contentType, body)
  if (kind === 'other') {
    const type = (contentType ?? 'unknown').split(';')[0]?.trim() ?? 'unknown'
    return { ok: false, reason: `it is a ${type} file, not a page` }
  }
  if (kind === 'html') {
    const page = htmlToMarkdown(body, url)
    return { ok: true, title: page.title, markdown: page.markdown === '' ? '_This page has no readable text._' : page.markdown }
  }
  if (kind === 'json') {
    let pretty = body
    try {
      pretty = JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      // Not valid JSON after all: shown as it came.
    }
    const fence = pretty.includes('```') ? '~~~~' : '```'
    return { ok: true, title: lastSegment(url), markdown: capMarkdown(`${fence}json\n${sanitize(pretty)}\n${fence}`) }
  }
  const clean = sanitize(body.replace(/\r\n?/g, '\n'))
  const heading = /^#\s+(.+)$/m.exec(clean)
  const title = kind === 'markdown' && heading?.[1] !== undefined ? oneLine(heading[1]) : lastSegment(url)
  return { ok: true, title, markdown: capMarkdown(clean) }
}

function lastSegment(url: string): string {
  try {
    const parsed = new URL(url)
    const segment = parsed.pathname.split('/').filter(part => part !== '').at(-1)
    return segment !== undefined ? decodeURIComponent(segment) : parsed.host
  } catch {
    return url
  }
}

/** The text Send to Claude puts in the prompt box. */
export function sendText(title: string, url: string, markdown: string): string {
  let body = markdown
  if (body.length > SEND_CAP) {
    const cut = body.lastIndexOf('\n', SEND_CAP)
    body = `${body.slice(0, cut > SEND_CAP / 2 ? cut : SEND_CAP)}\n…`
  }
  return `From ${title} (${url}):\n\n${body}\n\n`
}

/** What goes between the person's draft and text appended after it: a blank line, unless the draft is empty or ends in one. */
export function draftSeparator(draft: string): string {
  if (draft.trim() === '' || draft.endsWith('\n\n')) return ''
  return draft.endsWith('\n') ? '\n' : '\n\n'
}

/** A short plain reason from anything thrown. */
export function shortReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'something went wrong'
  // A rejected `$` call reads `<plugin>: $.noun.event: <why>`; the why is what the person needs.
  const first = oneLine(raw.split(/\r?\n/)[0] ?? raw).replace(/^([\w.-]+: )?\$\.[\w.]+: /, '')
  return fit(first === '' ? 'something went wrong' : first, 90)
}

// ---------------------------------------------------------------------------
// HTML to Markdown, with no DOM

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', bull: '•', middot: '·',
  times: '×', divide: '÷', deg: '°', plusmn: '±', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', para: '¶', shy: '', zwj: '', zwnj: '', lrm: '', rlm: '',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', minus: '−',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ',
  iexcl: '¡', iquest: '¿', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó',
  uacute: 'ú', agrave: 'à', egrave: 'è', ograve: 'ò', acirc: 'â', ecirc: 'ê',
  ocirc: 'ô', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', euml: 'ë',
  ccedil: 'ç', szlig: 'ß', oslash: 'ø', aring: 'å', aelig: 'æ',
  Aacute: 'Á', Eacute: 'É', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä', Ntilde: 'Ñ',
  hearts: '♥', check: '✓', star: '☆', dagger: '†', permil: '‰', prime: '′',
}

/** Decodes named (common ones) and numeric character references. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�'
      if (code === 9 || code === 10) return String.fromCharCode(code)
      if (code < 32 || (code >= 0x7f && code < 0xa0)) return ''
      return String.fromCodePoint(code)
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()]
    return named !== undefined ? named : whole
  })
}

/** Drops the escape sequences and control characters a drawn text may not hold (tab and newline stay). */
export function sanitize(text: string): string {
  return plain(text).replace(/\r/g, '')
}

/** Cuts markdown to the cap at a line, closing a fence left open. */
export function capMarkdown(markdown: string, cap = MARKDOWN_CAP): string {
  if (markdown.length <= cap) return markdown
  const cut = markdown.lastIndexOf('\n', cap)
  let head = markdown.slice(0, cut > cap / 2 ? cut : cap)
  const fences = head.split('\n').filter(row => /^(```|~~~~)/.test(row)).length
  if (fences % 2 === 1) head += '\n```'
  return `${head}\n\n_… the page goes on; cut at ${cap.toLocaleString('en-US')} characters._`
}

const DROPPED = ['script', 'style', 'noscript', 'svg', 'head', 'title', 'nav', 'footer', 'aside', 'template', 'iframe', 'canvas', 'object', 'math']
/**
 * A tag's attributes: a value quoted right after `=` may hold `>` (never `<`, so a quote left open cannot
 * swallow the page); a quote anywhere else is a plain character, as a browser reads `class=a"b`.
 */
const ATTRS = `(?:[^>"'<]|(?<!=\\s*)["']|(?<==\\s*)"[^"<]*"|(?<==\\s*)'[^'<]*')*`
const TAG_NAME = '[a-zA-Z][a-zA-Z0-9:-]*'
const BLOCKS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'figure', 'figcaption', 'address', 'details', 'summary',
  'dl', 'dt', 'dd', 'center', 'form', 'fieldset', 'legend', 'caption', 'hgroup', 'body', 'html',
])
const INDENT = '\u0001\u0001'

type Frame =
  | { kind: 'root' }
  | { kind: 'a'; href: string | null }
  | { kind: 'strong' | 'em' | 'code'; tag: string }
  | { kind: 'heading'; level: number }
  | { kind: 'pre'; lang: string }
  | { kind: 'quote' }
  | { kind: 'cell' }

type Buffer = { frame: Frame; parts: string[] }

type TableState = { rows: string[][]; row: string[] | null }

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  if (match === null) return null
  return match[1] ?? match[2] ?? match[3] ?? ''
}

function languageOf(attrs: string): string {
  const cls = attribute(attrs, 'class') ?? ''
  const match = /(?:^|\s)(?:language|lang)-([A-Za-z0-9_+#-]+)/.exec(cls)
  return match?.[1] ?? ''
}

/** Markdown links as their plain text: `[Post \[1\]](https://ex.com/p)` reads `Post [1]`. */
function linksAsText(markdown: string): string {
  return markdown.replace(/\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g, (_, label: string) => label.replace(/\\([[\]])/g, '$1')).trim()
}

/** A page's title and its readable text as Markdown, links made absolute against `baseUrl`. */
export function htmlToMarkdown(html: string, baseUrl: string): { title: string; markdown: string } {
  let source = html.length > BODY_CAP ? html.slice(0, BODY_CAP) : html
  source = source.replace(/\r\n?/g, '\n').replace(/\u0001/g, '')
  source = source.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<![^>]*>/g, '').replace(/<\?[\s\S]*?\?>/g, '')
  // A page may name the address its links are relative to.
  const baseTag = new RegExp(`<base\\b(${ATTRS})>`, 'i').exec(source) ?? /<base\b([^>]*)>/i.exec(source)
  const baseHref = baseTag?.[1] !== undefined ? attribute(baseTag[1], 'href') : null
  const linkBase = (baseHref !== null ? resolveHref(baseHref, baseUrl) : null) ?? baseUrl
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source)
  let title = titleMatch?.[1] !== undefined ? oneLine(sanitize(decodeEntities(titleMatch[1]))) : ''
  // `</head>` may be left out: the body starts where the head ends.
  if (/<head\b/i.test(source) && !/<\/head\s*>/i.test(source)) source = source.replace(/<body\b/i, '</head>$&')
  for (const tag of DROPPED) {
    // Quote-aware first; then the plain form for a tag a stray quote left unmatched.
    for (const attrs of [ATTRS, '[^>]*']) {
      source = source.replace(new RegExp(`<${tag}\\b${attrs}\\/>`, 'gi'), '')
      source = source.replace(new RegExp(`<${tag}\\b${attrs}>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '')
    }
  }

  const stack: Buffer[] = [{ frame: { kind: 'root' }, parts: [] }]
  const lists: { ordered: boolean; n: number }[] = []
  const tables: TableState[] = []
  let preDepth = 0
  let justMarked = false

  const top = (): Buffer => stack[stack.length - 1]!
  const emit = (text: string) => {
    if (text === '') return
    top().parts.push(text)
    if (/\S/.test(text)) justMarked = false
  }
  const tail = (): string => {
    const parts = top().parts
    let out = ''
    for (let i = parts.length - 1; i >= 0 && out.length < 2; i--) out = parts[i] + out
    return out.slice(-2)
  }
  const endsInLine = () => {
    const end = tail()
    return end === '' || end.endsWith('\n')
  }
  const ensureLine = () => {
    if (justMarked) return
    if (!endsInLine()) emit('\n')
  }
  const ensureBlank = () => {
    if (justMarked) return
    const end = tail()
    if (end === '' || end === '\n\n') return
    emit(end.endsWith('\n') ? '\n' : '\n\n')
  }
  const open = (frame: Frame) => {
    stack.push({ frame, parts: [] })
  }
  const finish = (buffer: Buffer): string => {
    const inner = buffer.parts.join('')
    const frame = buffer.frame
    switch (frame.kind) {
      case 'a': {
        let text = oneLine(inner)
        if (text === '') return ''
        // A heading inside a link (a card's title) stays a heading, its text the link.
        const heading = /^\s*\n\n(#{1,4}) /.exec(inner)
        if (heading?.[1] !== undefined) text = text.slice(heading[1].length + 1)
        let out = text
        if (frame.href !== null) {
          const label = text.replace(/([[\]])/g, '\\$1')
          const target = frame.href.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')
          out = `[${label}](${target})`
        }
        return heading?.[1] !== undefined ? `\n\n${heading[1]} ${out}\n\n` : out
      }
      case 'strong':
      case 'em': {
        const text = oneLine(inner)
        if (text === '') return inner.trim() === '' ? inner.replace(/\S/g, '') : ''
        const mark = frame.kind === 'strong' ? '**' : '_'
        const lead = /^\s/.test(inner) ? ' ' : ''
        const trail = /\s$/.test(inner) ? ' ' : ''
        return `${lead}${mark}${text}${mark}${trail}`
      }
      case 'code': {
        const text = oneLine(inner)
        if (text === '') return ''
        return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
      }
      case 'heading': {
        const text = oneLine(inner)
        return text === '' ? '' : `\n\n${'#'.repeat(Math.min(4, frame.level))} ${text}\n\n`
      }
      case 'pre': {
        const body = inner.replace(/^\n/, '').replace(/\s+$/, '')
        const fence = body.includes('```') ? '~~~~' : '```'
        return `\n\n${fence}${frame.lang}\n${body}\n${fence}\n\n`
      }
      case 'quote': {
        const body = inner.replace(/^\s+|\s+$/g, '')
        if (body === '') return ''
        return `\n\n${body.split('\n').map(row => (row.trim() === '' ? '>' : `> ${row}`)).join('\n')}\n\n`
      }
      case 'cell':
        return oneLine(inner).replace(/\|/g, '\\|')
      default:
        return inner
    }
  }
  const closeTop = (): void => {
    const buffer = stack.pop()
    if (buffer === undefined) return
    if (buffer.frame.kind === 'pre') preDepth = Math.max(0, preDepth - 1)
    const text = finish(buffer)
    if (buffer.frame.kind === 'cell') {
      const table = tables[tables.length - 1]
      if (table !== undefined) {
        if (table.row === null) table.row = []
        table.row.push(text)
      }
      return
    }
    emit(text)
  }
  /** Closes up to and including the nearest open frame of `kind`; false when none is open. */
  const closeFrame = (matches: (frame: Frame) => boolean): boolean => {
    let index = -1
    for (let i = stack.length - 1; i > 0; i--) {
      if (matches(stack[i]!.frame)) {
        index = i
        break
      }
    }
    if (index < 0) return false
    while (stack.length > index) closeTop()
    return true
  }
  const finishRow = (table: TableState) => {
    if (closeFrame(frame => frame.kind === 'cell')) {
      // The open cell joined the row.
    }
    if (table.row !== null && table.row.length > 0) table.rows.push(table.row)
    table.row = null
  }
  const finishTable = () => {
    const table = tables.pop()
    if (table === undefined) return
    if (table.row !== null && table.row.length > 0) table.rows.push(table.row)
    const width = Math.max(0, ...table.rows.map(row => row.length))
    if (width === 0) return
    const line = (row: readonly string[]) =>
      `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`
    const out = [line(table.rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`]
    for (const row of table.rows.slice(1)) out.push(line(row))
    ensureBlank()
    emit(`${out.join('\n')}\n\n`)
  }

  // A tag (quote-aware, then plain for one a stray quote broke), a run of text, or a lone `<`.
  const TOKEN = new RegExp(`<(\\/?)(${TAG_NAME})(${ATTRS})>|<(\\/?)(${TAG_NAME})([^>]*)>|([^<]+)|(<)`, 'g')
  let match: RegExpExecArray | null
  while ((match = TOKEN.exec(source)) !== null) {
    const textNode = match[7] ?? match[8]
    if (textNode !== undefined) {
      const decoded = sanitize(decodeEntities(textNode))
      if (preDepth > 0) {
        emit(decoded)
        continue
      }
      let text = decoded.replace(/[\s ]+/g, ' ')
      if (endsInLine() || justMarked) text = text.replace(/^ /, '')
      if (text !== '') emit(text)
      continue
    }
    const isPlain = match[2] === undefined
    const isClose = (isPlain ? match[4] : match[1]) === '/'
    const tag = ((isPlain ? match[5] : match[2]) ?? '').toLowerCase()
    const attrs = (isPlain ? match[6] : match[3]) ?? ''

    if (preDepth > 0) {
      if (tag === 'pre' && isClose) {
        closeFrame(frame => frame.kind === 'pre')
        ensureBlank()
      } else if (tag === 'br') {
        emit('\n')
      } else if (tag === 'code' && !isClose) {
        const frame = top().frame
        if (frame.kind === 'pre' && frame.lang === '') frame.lang = languageOf(attrs)
      }
      continue
    }

    const inCell = stack.some(buffer => buffer.frame.kind === 'cell')
    if (/^h[1-6]$/.test(tag)) {
      if (isClose) closeFrame(frame => frame.kind === 'heading')
      else {
        ensureBlank()
        open({ kind: 'heading', level: Number(tag.slice(1)) })
      }
      continue
    }
    switch (tag) {
      case 'a':
        if (isClose) closeFrame(frame => frame.kind === 'a')
        else {
          closeFrame(frame => frame.kind === 'a')
          const href = attribute(attrs, 'href')
          open({ kind: 'a', href: href === null ? null : resolveHref(href, linkBase) })
        }
        break
      case 'strong':
      case 'b':
        if (isClose) closeFrame(frame => frame.kind === 'strong')
        else open({ kind: 'strong', tag })
        break
      case 'em':
      case 'i':
        if (isClose) closeFrame(frame => frame.kind === 'em')
        else open({ kind: 'em', tag })
        break
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt':
        if (isClose) closeFrame(frame => frame.kind === 'code')
        else open({ kind: 'code', tag })
        break
      case 'pre':
        if (!isClose) {
          ensureBlank()
          preDepth++
          open({ kind: 'pre', lang: languageOf(attrs) })
        }
        break
      case 'blockquote':
        if (isClose) closeFrame(frame => frame.kind === 'quote')
        else {
          ensureBlank()
          open({ kind: 'quote' })
        }
        break
      case 'br':
        emit(inCell ? ' ' : '\n')
        break
      case 'hr':
        ensureBlank()
        emit('---\n\n')
        break
      case 'img': {
        const alt = oneLine(decodeEntities(attribute(attrs, 'alt') ?? ''))
        if (alt !== '') emit(`${endsInLine() || justMarked ? '' : ' '}[image: ${alt}] `)
        break
      }
      case 'ul':
      case 'ol':
        if (isClose) {
          lists.pop()
          if (lists.length === 0) ensureBlank()
          else ensureLine()
        } else {
          if (lists.length === 0) ensureBlank()
          else ensureLine()
          const start = Number.parseInt(attribute(attrs, 'start') ?? '1', 10)
          lists.push({ ordered: tag === 'ol', n: Number.isFinite(start) ? start : 1 })
        }
        break
      case 'li':
        if (isClose) ensureLine()
        else {
          ensureLine()
          const list = lists[lists.length - 1]
          const depth = Math.max(0, lists.length - 1)
          const marker = list?.ordered === true ? `${list.n++}. ` : '- '
          emit(`${INDENT.repeat(depth)}${marker}`)
          justMarked = true
        }
        break
      case 'table':
        if (isClose) {
          const table = tables[tables.length - 1]
          if (table !== undefined) finishRow(table)
          finishTable()
        } else {
          ensureBlank()
          tables.push({ rows: [], row: null })
        }
        break
      case 'tr': {
        const table = tables[tables.length - 1]
        if (table === undefined) break
        finishRow(table)
        if (!isClose) table.row = []
        break
      }
      case 'td':
      case 'th': {
        const table = tables[tables.length - 1]
        if (table === undefined) break
        closeFrame(frame => frame.kind === 'cell')
        if (!isClose) {
          if (table.row === null) table.row = []
          open({ kind: 'cell' })
        }
        break
      }
      default:
        if (BLOCKS.has(tag)) {
          if (inCell) emit(' ')
          else ensureBlank()
        }
    }
  }
  while (stack.length > 1) closeTop()
  while (tables.length > 0) finishTable()

  const lines = stack[0]!.parts.join('').split('\n')
  const out: string[] = []
  let inFence = false
  let blanks = 0
  for (const raw of lines) {
    if (/^(```|~~~~)/.test(raw.trim()) && !raw.startsWith(INDENT)) {
      inFence = !inFence
      out.push(raw.trim())
      blanks = 0
      continue
    }
    if (inFence) {
      out.push(raw.replace(/\s+$/, ''))
      continue
    }
    const row = raw.replace(/[ \t ]+/g, ' ').trim().replace(/\u0001/g, ' ')
    if (row === '') {
      blanks++
      if (blanks === 1 && out.length > 0) out.push('')
      continue
    }
    blanks = 0
    out.push(row)
  }
  const markdown = capMarkdown(sanitize(out.join('\n').replace(/^\n+|\n+$/g, '')))
  if (title === '') {
    const heading = /^#{1,4} (.+)$/m.exec(markdown)
    // A title is one short line: a heading's first 500 characters are plenty, and keep the scan cheap.
    const text = heading?.[1] !== undefined ? linksAsText(heading[1].slice(0, 500)) : ''
    title = text !== '' ? text : hostOf(baseUrl)
  }
  return { title, markdown }
}

// ---------------------------------------------------------------------------
// Skins

export const CUSTOM_SLUG = 'gold-and-slate'
export const CUSTOM_VALUE = `custom:${CUSTOM_SLUG}`
export const CUSTOM_LABEL = 'Gold & Slate (matches your mods)'

/** The custom theme file: the shape this build reads from its themes folder (`name`, `base`, `overrides`), the whole palette in it. */
export function customThemeJson(): string {
  const theme = {
    name: 'Gold & Slate',
    base: 'dark',
    overrides: {
      claude: '#F2C46D',
      permission: '#F2C46D',
      suggestion: '#F2C46D',
      remember: '#F2C46D',
      text: '#E6EDF3',
      inactive: '#7D8590',
      subtle: '#7D8590',
      promptBorder: '#7D8590',
      bashBorder: '#E3B341',
      success: '#3DD68C',
      warning: '#E3B341',
      // Slate behind your own prompts in the transcript (a key the dark theme has; one it lacks is ignored).
      userMessageBackground: '#262B33',
    },
  }
  return `${JSON.stringify(theme, null, 2)}\n`
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * Where this build reads custom themes: `<config dir>/themes`, the config dir `$CLAUDE_CONFIG_DIR` or
 * `$HOME/.claude`, with `~` for the home folder when shown. Only a full path is used: a relative one
 * (or `~`, which nothing expands) would land the file under the working directory, so it is refused.
 */
export function themesFolderFrom(home: string, configDir: string): { path: string; shown: string } | { error: string } {
  const homeDir = home.trim().replace(/[\\/]+$/, '')
  const dir = configDir.trim().replace(/[\\/]+$/, '')
  let root: string
  if (dir !== '') {
    if (!isAbsolutePath(dir)) return { error: `CLAUDE_CONFIG_DIR is not a full path (${fit(dir, 40)}), so studio won't guess where themes go` }
    root = dir
  } else {
    if (homeDir === '' || !isAbsolutePath(homeDir)) return { error: 'HOME is not set, so the themes folder is unknown' }
    root = `${homeDir}/.claude`
  }
  const path = `${root}/themes`
  const shown = homeDir !== '' && path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path
  return { path, shown }
}

const THEME_WORDS: Record<string, string> = { ansi: 'ANSI', daltonized: 'daltonized', auto: 'Auto' }

/** `dark-daltonized` reads `Dark daltonized`, `light-ansi` reads `Light ANSI`. */
export function themeLabel(value: string): string {
  if (value === CUSTOM_VALUE) return CUSTOM_LABEL
  if (value.startsWith('custom:')) return `Custom: ${value.slice('custom:'.length)}`
  if (value === 'auto') return 'Auto (match terminal)'
  const words = value.split(/[-_\s]+/).filter(word => word !== '')
  const shown = words.map((word, index) => {
    const known = THEME_WORDS[word.toLowerCase()]
    if (known !== undefined) return known
    return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word
  })
  return shown.join(' ') || value
}

/** The theme choices from `/config`'s rows, with the custom Gold & Slate entry last. */
export function themesFrom(rows: readonly ConfigRow[]): { themes: StudioTheme[]; current: string } | null {
  const row = rows.find(one => one.key === 'theme')
  if (row === undefined) return null
  const current = typeof row.value === 'string' ? row.value : String(row.value)
  const values: string[] = []
  for (const option of row.options ?? []) if (!values.includes(option)) values.push(option)
  if (values.length === 0 && current !== '') values.push(current)
  const themes: StudioTheme[] = values
    .filter(value => value !== CUSTOM_VALUE)
    .map(value => ({ value, label: themeLabel(value), isCustom: value.startsWith('custom:') }))
  if (current.startsWith('custom:') && current !== CUSTOM_VALUE && !values.includes(current)) {
    themes.push({ value: current, label: themeLabel(current), isCustom: true })
  }
  themes.push({ value: CUSTOM_VALUE, label: CUSTOM_LABEL, isCustom: true })
  return { themes, current }
}
