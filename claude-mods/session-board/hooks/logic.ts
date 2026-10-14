// session-board's pure logic: no `$`, no drawing. Heartbeats, the state
// machine, titles, liveness, the board's rows, the same-folder notes.

import type {
  SessionBoardBeat,
  SessionBoardEdit,
  SessionBoardHelper,
  SessionBoardState,
} from '../types'
import { cells, clock, fit, pad, tileWidth } from './look-text'

export const SECOND = 1_000
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

/** A session is alive while its last heartbeat is this recent. */
export const ALIVE_MS = 5 * MINUTE
/** Past this a heartbeat is dropped (and its file removed at session start). */
export const DROP_MS = 24 * HOUR
/** Own edits are kept this long in the heartbeat. */
export const EDIT_WINDOW_MS = 30 * MINUTE
/** At most this many edits are kept. */
export const EDIT_MAX = 30
/** Another session's edit this recent makes an edit here a conflict. */
export const CONFLICT_MS = 10 * MINUTE
/** At most one heartbeat write per this many milliseconds. */
export const WRITE_GAP_MS = 3 * SECOND
/** Heartbeat while working or waiting. */
export const ACTIVE_BEAT_MS = 30 * SECOND
/** Heartbeat while idle, so others know the session is alive. */
export const IDLE_BEAT_MS = 2 * MINUTE
/** Pane refresh while it is open. */
export const REFRESH_MS = 2 * SECOND
/** How long the pane's "Copied ..." line stays. */
export const NOTE_MS = 10 * SECOND
/** Finished helpers stay on the card row this long. */
export const HELPER_KEEP_MS = 10 * MINUTE
/** A workflow helper with no turn.complete and no tool call for this long is taken as finished. */
export const UNLISTED_QUIET_MS = 15 * MINUTE
/** An unchanged same-folder note is attached again only after this long. */
export const NOTE_REPEAT_MS = 10 * MINUTE
/** While its pane waits undrawn, the board checks this often whether it was seated. */
export const UNPLACED_POLL_MS = 15 * SECOND

export const NEW_TITLE = 'New session'
export const TITLE_MAX = 40
export const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

// ---------------------------------------------------------------- paths

/** The last part of a path, either separator. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/** `~/.claude/mod-data/session-board/sessions` under `home`. */
export function sessionsDir(home: string): string {
  return `${home.replace(/[\\/]+$/, '')}/.claude/mod-data/session-board/sessions`
}

/** The heartbeat file of session `id`. */
export function beatPath(home: string, id: string): string {
  return `${sessionsDir(home)}/${id}.json`
}

/** `file` relative to `root` when it lies under it, else as given. */
export function relativeTo(file: string, root: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const f = norm(file)
  const r = norm(root).replace(/\/+$/, '')
  if (r !== '' && f.startsWith(`${r}/`)) return f.slice(r.length + 1)
  return f
}

/** Whether `path` is absolute: `/x`, `\\x` or `C:\\x`. */
export function isAbsolutePath(path: string): boolean {
  return /^([A-Za-z]:)?[\\/]/.test(path)
}

/** The first candidate that is an absolute folder, or '' when none is (a relative or `~` HOME). */
export function pickHome(candidates: readonly (string | undefined)[]): string {
  for (const one of candidates) {
    const trimmed = (one ?? '').trim()
    if (trimmed !== '' && isAbsolutePath(trimmed)) return trimmed
  }
  return ''
}

/** `file` relative to `root`, or null when it lies outside the project (those are never shared). */
export function pathInRoot(file: string, root: string): string | null {
  if (!isAbsolutePath(file)) {
    const rel = file.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
    return rel === '' || rel.startsWith('../') ? null : rel
  }
  const rel = relativeTo(file, root)
  return isAbsolutePath(rel) ? null : rel
}

/** The file an edit tool's input names, or null for any other tool. */
export function editedPath(tool: string, input: Readonly<Record<string, unknown>>): string | null {
  if (!EDIT_TOOLS.includes(tool)) return null
  const path = tool === 'NotebookEdit' ? input['notebook_path'] : input['file_path']
  return typeof path === 'string' && path !== '' ? path : null
}

// ---------------------------------------------------------------- titles

/** Whether a prompt is a slash command (`/compact`, `/review 12`), not a path. */
export function isSlashCommand(text: string): boolean {
  return /^\s*\/[A-Za-z0-9][\w:.-]*(\s|$)/.test(text)
}

/** Cuts `text` to at most `max` cells, at a word boundary when one is near. */
export function cutAtWord(text: string, max: number = TITLE_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (cells(clean) <= max) return clean
  const chars = Array.from(clean).slice(0, max)
  const head = chars.join('')
  const space = head.lastIndexOf(' ')
  const cut = space >= Math.floor(max / 2) ? head.slice(0, space) : chars.slice(0, max - 1).join('')
  return `${cut.replace(/[\s,.;:!?-]+$/, '')}…`
}

/** A session title from a prompt, or null when it is no real prompt. */
export function titleFrom(text: string, max: number = TITLE_MAX): string | null {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '' || isSlashCommand(clean) || clean.startsWith('<')) return null
  return cutAtWord(clean, max)
}

/** The first real prompt among user messages, as a title. */
export function titleFromMessages(rows: readonly { role: string; text: string }[]): string | null {
  for (const row of rows) {
    if (row.role !== 'user') continue
    const title = titleFrom(row.text)
    if (title !== null) return title
  }
  return null
}

/**
 * Whether a prompt's origin is the person's own: typed, sent from the bridge or
 * the SDK host, or a plugin's prompt sent as their own words (`asUser`), as
 * prompt-upgrade's Run is. Not a plain plugin prompt, a peer or a schedule.
 */
export function isPersonOrigin(origin: { kind: string; asUser?: boolean }): boolean {
  if (origin.kind === 'plugin') return origin.asUser === true
  return origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'
}

// ---------------------------------------------------------------- the state machine

export type BoardEvent =
  | { kind: 'turn-start' }
  | { kind: 'turn-complete' }
  | { kind: 'notification'; type: string; message: string }
  | { kind: 'ask' }
  | { kind: 'tool'; step: string }
  | { kind: 'resume'; to: 'working' | 'idle' }
  /** A blocked call ended while others still hold the waiting state: the reason of one still open. */
  | { kind: 'still-waiting'; reason: string }

/** The waiting reason of a question to the person. */
export const ASKED = 'asked you a question'

/** The waiting reason a classic Notification means, or null when it means none. */
export function reasonForNotification(type: string, message: string): string | null {
  const isPermission = type === 'permission_prompt' || (type === '' && /permission/i.test(message))
  if (isPermission) {
    if (/\bBash\b/.test(message)) return 'needs your OK to run a command'
    const tool = /permission to use ([\w:.-]+)/i.exec(message)?.[1]
    return tool !== undefined ? `needs your OK to use ${tool}` : 'needs your OK'
  }
  if (type === 'elicitation_dialog') return ASKED
  return null
}

/** A fresh heartbeat for this session. */
export function newBeat(o: {
  id: string
  root: string
  branch: string
  model: string
  now: number
  title?: string | null
}): SessionBoardBeat {
  return {
    v: 1,
    id: o.id,
    root: o.root,
    project: baseName(o.root) || o.root,
    branch: o.branch,
    title: o.title ?? NEW_TITLE,
    state: 'idle',
    startedAt: o.now,
    stateSince: o.now,
    lastBeat: o.now,
    edits: [],
    helpers: [],
    model: o.model,
  }
}

function moveTo(
  beat: SessionBoardBeat,
  state: SessionBoardState,
  now: number,
  extra: { waitingReason?: string; currentStep?: string },
): SessionBoardBeat {
  const next: SessionBoardBeat = { ...beat, state, stateSince: beat.state === state ? beat.stateSince : now }
  delete next.waitingReason
  delete next.currentStep
  if (extra.waitingReason !== undefined) next.waitingReason = extra.waitingReason
  if (extra.currentStep !== undefined) next.currentStep = extra.currentStep
  return next
}

/**
 * The beat after `event`. Returns the same object when nothing changed, so a
 * caller writes only on a change.
 *
 * turn start: working; turn complete: idle; a permission prompt or question:
 * waiting with its reason; the next tool call (or the blocked one finishing):
 * working again, or, while another blocked call is still open, waiting with
 * that one's reason. A tool call outside a turn (a plugin's own) changes nothing.
 */
export function transition(beat: SessionBoardBeat, event: BoardEvent, now: number): SessionBoardBeat {
  switch (event.kind) {
    case 'turn-start': {
      if (beat.state === 'working' && beat.currentStep === 'Thinking') return beat
      const isBusy = beat.state === 'working' || beat.state === 'waiting'
      const next = moveTo(beat, 'working', now, { currentStep: 'Thinking' })
      next.workingSince = isBusy ? (beat.workingSince ?? beat.stateSince) : now
      return next
    }
    case 'turn-complete':
      if (beat.state === 'idle' && beat.currentStep === undefined) return beat
      return moveTo(beat, 'idle', now, {})
    case 'notification': {
      const reason = reasonForNotification(event.type, event.message)
      if (reason === null) return beat
      if (beat.state === 'waiting' && beat.waitingReason === reason) return beat
      return moveTo(beat, 'waiting', now, { waitingReason: reason, ...stepOf(beat) })
    }
    case 'ask':
      if (beat.state === 'waiting' && beat.waitingReason === ASKED) return beat
      return moveTo(beat, 'waiting', now, { waitingReason: ASKED, ...stepOf(beat) })
    case 'tool':
      if (beat.state === 'idle' || beat.state === 'ended') return beat
      if (beat.state === 'working' && beat.currentStep === event.step) return beat
      return moveTo(beat, 'working', now, { currentStep: event.step })
    case 'resume':
      if (beat.state !== 'waiting') return beat
      return moveTo(beat, event.to, now, event.to === 'working' ? stepOf(beat) : {})
    case 'still-waiting':
      if (beat.state !== 'waiting' || beat.waitingReason === event.reason) return beat
      return moveTo(beat, 'waiting', now, { waitingReason: event.reason, ...stepOf(beat) })
  }
}

function stepOf(beat: SessionBoardBeat): { currentStep?: string } {
  return beat.currentStep !== undefined ? { currentStep: beat.currentStep } : {}
}

/** What a tool call is doing, in a few words: `Edit app.js`, `Bash npm test`. */
export function stepFor(tool: string, input: Readonly<Record<string, unknown>>): string {
  const text = (key: string): string => {
    const value = input[key]
    return typeof value === 'string' ? value : ''
  }
  let detail = ''
  switch (tool) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'Read':
      detail = baseName(text('file_path'))
      break
    case 'NotebookEdit':
      detail = baseName(text('notebook_path'))
      break
    case 'Bash':
      detail = text('command').split('\n')[0] ?? ''
      break
    case 'Grep':
    case 'Glob':
      detail = text('pattern')
      break
    case 'Agent':
      detail = text('description')
      break
    case 'WebFetch':
      detail = hostOf(text('url'))
      break
    case 'WebSearch':
      detail = text('query')
      break
    case 'Skill':
      detail = text('skill')
      break
    case 'AskUserQuestion':
      return 'Asking a question'
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  const name = mcp !== null ? `${mcp[1]} ${mcp[2]}` : tool
  const shown = detail.replace(/\s+/g, ' ').trim()
  return fit(shown === '' ? name : `${name} ${shown}`, 48)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- heartbeats

const STATES: readonly string[] = ['working', 'waiting', 'idle', 'ended']

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** A heartbeat file's text as a beat, or null when it is not one. */
export function parseBeat(text: string): SessionBoardBeat | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o['v'] !== 1 || typeof o['id'] !== 'string' || o['id'] === '') return null
  if (typeof o['root'] !== 'string' || !STATES.includes(str(o['state']))) return null
  if (!isNum(o['lastBeat']) || !isNum(o['stateSince'])) return null
  const root = o['root']
  const edits = Array.isArray(o['edits'])
    ? o['edits'].flatMap((one): SessionBoardEdit[] => {
        if (typeof one !== 'object' || one === null) return []
        const e = one as Record<string, unknown>
        return typeof e['path'] === 'string' && isNum(e['at']) ? [{ path: e['path'], at: e['at'] }] : []
      })
    : []
  const helpers = Array.isArray(o['helpers'])
    ? o['helpers'].flatMap((one): SessionBoardHelper[] => {
        if (typeof one !== 'object' || one === null) return []
        const rec = one as Record<string, unknown>
        if (typeof rec['id'] !== 'string' || !isNum(rec['startedAt'])) return []
        const helper: SessionBoardHelper = {
          id: rec['id'],
          description: str(rec['description'], 'Helper'),
          startedAt: rec['startedAt'],
          status: str(rec['status'], 'running'),
        }
        if (isNum(rec['endedAt'])) helper.endedAt = rec['endedAt']
        if (rec['isUnlisted'] === true) helper.isUnlisted = true
        return [helper]
      })
    : []
  const beat: SessionBoardBeat = {
    v: 1,
    id: o['id'],
    root,
    project: str(o['project']) || baseName(root) || root,
    branch: str(o['branch']),
    title: str(o['title']) || NEW_TITLE,
    state: str(o['state']) as SessionBoardState,
    startedAt: isNum(o['startedAt']) ? o['startedAt'] : o['stateSince'],
    stateSince: o['stateSince'],
    lastBeat: o['lastBeat'],
    edits,
    helpers,
    model: str(o['model']),
  }
  if (typeof o['waitingReason'] === 'string') beat.waitingReason = o['waitingReason']
  if (typeof o['currentStep'] === 'string') beat.currentStep = o['currentStep']
  if (isNum(o['workingSince'])) beat.workingSince = o['workingSince']
  return beat
}

export type Liveness = 'alive' | 'quiet' | 'dropped'

/** Alive within 5 minutes of its last beat; quiet up to 24 hours; dropped after, or ended. */
export function liveness(beat: Pick<SessionBoardBeat, 'lastBeat' | 'state'>, now: number): Liveness {
  if (beat.state === 'ended') return 'dropped'
  const age = now - beat.lastBeat
  if (age > DROP_MS) return 'dropped'
  if (age > ALIVE_MS) return 'quiet'
  return 'alive'
}

/** Which heartbeat files to read, and which are stale enough to remove. */
export function pickBeatFiles(
  entries: readonly { name: string; kind: string; mtimeMs: number }[],
  now: number,
  selfId: string,
): { fresh: string[]; stale: string[] } {
  const fresh: string[] = []
  const stale: string[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (entry.name === `${selfId}.json`) continue
    if (entry.mtimeMs > 0 && now - entry.mtimeMs > DROP_MS) stale.push(entry.name)
    else fresh.push(entry.name)
  }
  return { fresh, stale }
}

/** Own edits with `path` (re)recorded at `now`: last 30 minutes, at most 30. */
export function addEdit(edits: readonly SessionBoardEdit[], path: string, now: number): SessionBoardEdit[] {
  const kept = edits.filter(one => one.path !== path)
  return pruneEdits([...kept, { path, at: now }], now)
}

/** Edits of the last 30 minutes, at most 30, oldest first. */
export function pruneEdits(edits: readonly SessionBoardEdit[], now: number): SessionBoardEdit[] {
  return edits
    .filter(one => now - one.at <= EDIT_WINDOW_MS)
    .sort((a, b) => a.at - b.at)
    .slice(-EDIT_MAX)
}

/** Edits within `windowMs`, newest first. */
export function recentEdits(edits: readonly SessionBoardEdit[], now: number, windowMs: number): SessionBoardEdit[] {
  return edits.filter(one => now - one.at <= windowMs).sort((a, b) => b.at - a.at)
}

/** Milliseconds to wait before the next write may go: 0 when it may go now. */
export function throttleWait(lastWriteAt: number, now: number, gap: number = WRITE_GAP_MS): number {
  const elapsed = now - lastWriteAt
  return elapsed >= gap ? 0 : gap - elapsed
}

// ---------------------------------------------------------------- other sessions

/** Other alive sessions in the same project root. */
export function sameRootOthers(
  beats: readonly SessionBoardBeat[],
  selfId: string,
  root: string,
  now: number,
): SessionBoardBeat[] {
  return beats.filter(b => b.id !== selfId && b.root === root && liveness(b, now) === 'alive')
}

function stateWord(state: SessionBoardState): string {
  if (state === 'waiting') return 'waiting on the person'
  return state
}

function fileList(paths: readonly string[], max = 8): string {
  const shown = paths.slice(0, max).join(', ')
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown
}

const AVOID =
  'Avoid editing those files unless the person asks; if you must, re-read them first because they may have changed.'

/**
 * The note the model reads beside a prompt when another alive session works
 * in the same project, or null when there is nothing relevant to say.
 */
export function sameFolderContext(
  beats: readonly SessionBoardBeat[],
  selfId: string,
  root: string,
  now: number,
): string | null {
  // a session with no recent edits leaves nothing to avoid, so it is left out
  const relevant = sameRootOthers(beats, selfId, root, now)
    .map(b => ({ beat: b, files: recentEdits(b.edits, now, EDIT_WINDOW_MS).map(e => e.path) }))
    .filter(one => one.files.length > 0)
    .slice(0, 3)
  if (relevant.length === 0) return null
  const head = (b: SessionBoardBeat) =>
    `"${b.title}" (${[stateWord(b.state), b.branch].filter(part => part !== '').join(', ')})`
  if (relevant.length === 1) {
    const { beat, files } = relevant[0]!
    const lead = `Another Claude Code session is working in this same project: ${head(beat)}.`
    return `${lead} In the last 30 minutes it edited: ${fileList(files)}. ${AVOID}`
  }
  return [
    'Other Claude Code sessions are working in this same project (edits from the last 30 minutes):',
    ...relevant.map(({ beat, files }) => `- ${head(beat)} edited: ${fileList(files)}.`),
    AVOID,
  ].join('\n')
}

/** The note last attached to a prompt of session `id`. */
export type SentNote = { id: string; text: string; at: number }

/**
 * Whether to attach `note` to this prompt: not when the same note went with
 * an earlier prompt of this session less than ten minutes ago, since the model
 * already has it.
 */
export function shouldAttachNote(note: string, selfId: string, last: SentNote | null, now: number): boolean {
  if (last === null || last.id !== selfId || last.text !== note) return true
  return now - last.at >= NOTE_REPEAT_MS || now < last.at
}

export type Conflict = { beat: SessionBoardBeat; at: number; path: string }

/** The other alive session in the same root that edited `path` most recently, within 10 minutes. */
export function conflictFor(
  beats: readonly SessionBoardBeat[],
  selfId: string,
  root: string,
  path: string,
  now: number,
): Conflict | null {
  let found: Conflict | null = null
  for (const beat of sameRootOthers(beats, selfId, root, now)) {
    for (const edit of beat.edits) {
      if (edit.path !== path || now - edit.at > CONFLICT_MS) continue
      if (found === null || edit.at > found.at) found = { beat, at: edit.at, path }
    }
  }
  return found
}

function minutesAgo(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / MINUTE)
  if (minutes < 1) return 'less than a minute ago'
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
}

/** The note the model reads after an edit of a file the other session edited. */
export function conflictNote(conflict: Conflict, now: number): string {
  return `Note: session "${conflict.beat.title}" edited this file ${minutesAgo(now - conflict.at)}.`
}

/** The key that keeps a conflict toast to once per file per session. */
export function toastKey(selfId: string, path: string): string {
  return `${selfId}:${path}`
}

/** The toast the person sees, once per file per session. */
export function conflictToast(conflict: Conflict, now: number): string {
  return `Heads up: the other session in ${conflict.beat.project} edited ${fit(conflict.path, 60)} ${ago(now - conflict.at)}.`
}

/** "just now", "4m ago", "3h ago". */
export function ago(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < MINUTE) return 'just now'
  if (safe < HOUR) return `${Math.floor(safe / MINUTE)}m ago`
  return `${Math.floor(safe / HOUR)}h ago`
}

/** The status line: other live sessions waiting and working, or undefined for none. */
export function statusText(beats: readonly SessionBoardBeat[], selfId: string, now: number): string | undefined {
  const live = beats.filter(b => b.id !== selfId && liveness(b, now) === 'alive')
  const waiting = live.filter(b => b.state === 'waiting').length
  // each session once, by its top state, as the board sorts it: helpers count only for an idle one
  const working = live.filter(b => b.state === 'working' || (b.state === 'idle' && helpersWorking(b).length > 0)).length
  const parts: string[] = []
  if (waiting > 0) parts.push(`${waiting} waiting`)
  if (working > 0) parts.push(`${working} working`)
  return parts.length > 0 ? `◆ ${parts.join(' · ')}` : undefined
}

/** What the person runs to resume a session: from another project, with a `cd`. */
export function resumeCommand(beat: Pick<SessionBoardBeat, 'id' | 'root'>, selfRoot: string): string {
  // the id comes from another session's file: quoted, so a bad one cannot run anything when pasted
  const command = `claude --resume ${shellQuote(beat.id)}`
  return beat.root === '' || beat.root === selfRoot ? command : `cd ${shellQuote(beat.root)} && ${command}`
}

/** A POSIX shell word for `text`. */
export function shellQuote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

// ---------------------------------------------------------------- the board

export type RowTone = 'warn' | 'good' | 'muted' | 'text'

export type BoardRow = {
  id: string
  root: string
  project: string
  isSelf: boolean
  left: string
  right: string
  tone: RowTone
  isDim: boolean
}

export type BoardGroups = {
  waiting: BoardRow[]
  working: BoardRow[]
  done: BoardRow[]
  quiet: BoardRow[]
  /** Alive sessions, this one included. */
  running: number
  /** Whether any session but this one is listed. */
  hasOthers: boolean
}

/** Every session sorted into the board's sections, rows as text. */
export function boardGroups(beats: readonly SessionBoardBeat[], selfId: string, now: number): BoardGroups {
  const groups: BoardGroups = { waiting: [], working: [], done: [], quiet: [], running: 0, hasOthers: false }
  const sorted = [...beats].sort((a, b) => a.stateSince - b.stateSince)
  for (const beat of sorted) {
    const isSelf = beat.id === selfId
    const live = isSelf ? 'alive' : liveness(beat, now)
    if (live === 'dropped') continue
    if (!isSelf) groups.hasOthers = true
    const mark = isSelf ? ' (this one)' : ''
    const base = { id: beat.id, root: beat.root, project: beat.project, isSelf }
    if (live === 'quiet') {
      groups.quiet.push({
        ...base,
        left: `· ${beat.project} · ${beat.title}`,
        right: ` · went quiet ${ago(now - beat.lastBeat)}`,
        tone: 'muted',
        isDim: true,
      })
      continue
    }
    groups.running += 1
    const since = clock(now - beat.stateSince)
    if (beat.state === 'waiting') {
      groups.waiting.push({
        ...base,
        left: `‖ ${beat.project} · ${beat.title} · ${beat.waitingReason ?? 'waiting on you'}`,
        right: ` · ${since}${mark}`,
        tone: 'warn',
        isDim: false,
      })
    } else if (beat.state === 'working') {
      const parts = [beat.project, beat.branch, beat.title, beat.currentStep ?? ''].filter(part => part !== '')
      const from = beat.workingSince !== undefined && beat.workingSince <= beat.stateSince ? beat.workingSince : beat.stateSince
      groups.working.push({
        ...base,
        left: `▶ ${parts.join(' · ')}`,
        right: ` · ${clock(now - from)}${mark}`,
        tone: 'good',
        isDim: false,
      })
    } else if (beat.state === 'idle' && helpersWorking(beat).length > 0) {
      // the main loop is done, but its helpers (a workflow's agents, say) still work
      const busy = helpersWorking(beat)
      const step = busy.length === 1 ? '1 helper working' : `${busy.length} helpers working`
      const parts = [beat.project, beat.branch, beat.title, step].filter(part => part !== '')
      const from = Math.min(...busy.map(one => one.startedAt))
      groups.working.push({
        ...base,
        left: `▶ ${parts.join(' · ')}`,
        right: ` · ${clock(now - from)}${mark}`,
        tone: 'good',
        isDim: false,
      })
    } else {
      // a session that never ran a turn is open, not finished
      const hasRun = beat.stateSince > beat.startedAt
      groups.done.push({
        ...base,
        left: `${hasRun ? '✓' : '○'} ${beat.project} · ${beat.title}`,
        right: hasRun ? ` · finished ${ago(now - beat.stateSince)}${mark}` : ` · opened ${ago(now - beat.startedAt)}${mark}`,
        tone: 'muted',
        isDim: true,
      })
    }
  }
  groups.done.reverse()
  groups.quiet.reverse()
  return groups
}

/** The pane title's right side: `3 running · 1 waiting`, the waiting count kept first when room is short. */
export function headerRight(groups: BoardGroups, room: number = Number.POSITIVE_INFINITY): string {
  const waiting = groups.waiting.length
  const running = `${groups.running} running`
  if (waiting === 0) return running
  const full = `${running} · ${waiting} waiting`
  return cells(full) <= room ? full : `${waiting} waiting`
}

/** One row's text in `columns` cells, the timer kept on the right where it fits. */
export function rowText(left: string, right: string, columns: number): string {
  const room = columns - cells(right)
  if (room < 8) return fit(left + right, columns)
  return fit(left, room) + right
}

// ---------------------------------------------------------------- helpers

export type AgentLike = { id: string; description: string; status: string }

const ENDED: readonly string[] = ['completed', 'failed', 'killed']
const ACTIVE: readonly string[] = ['running', 'pending', 'waiting', 'idle']
/** Statuses that mean a helper is at work (an idle teammate waits for a message). */
const WORKING: readonly string[] = ['running', 'pending', 'waiting']

/** A beat's helpers that are still at work. */
export function helpersWorking(beat: Pick<SessionBoardBeat, 'helpers'>): SessionBoardHelper[] {
  return beat.helpers.filter(one => one.endedAt === undefined && WORKING.includes(one.status))
}

/**
 * The helpers once `agent.spawn` started `agentId`: the Agent call's own card
 * (`callId`) takes the agent's id, so one helper is never shown twice; a
 * workflow's agent (`isUnlisted`) gets a card of its own.
 */
export function helperSpawned(
  helpers: readonly SessionBoardHelper[],
  spawn: { agentId: string; callId: string | null; description: string; isUnlisted: boolean },
  now: number,
): SessionBoardHelper[] {
  if (helpers.some(one => one.id === spawn.agentId)) return [...helpers]
  const callIndex = spawn.callId === null ? -1 : helpers.findIndex(one => one.id === spawn.callId)
  if (callIndex >= 0) {
    return helpers.map((one, index) => (index === callIndex ? { ...one, id: spawn.agentId } : one))
  }
  const added = helperStarting(spawn.agentId, spawn.description, now)
  if (spawn.isUnlisted) added.isUnlisted = true
  return [...helpers, added]
}

/** The helpers once the workflow agent `agentId` answered (its own turn.complete). */
export function helperFinished(
  helpers: readonly SessionBoardHelper[],
  agentId: string,
  reason: string,
  now: number,
): SessionBoardHelper[] {
  const status = reason === 'error' || reason === 'refusal' ? 'failed' : reason === 'aborted' ? 'killed' : 'completed'
  return helpers.map(one =>
    one.id === agentId && one.isUnlisted === true && one.endedAt === undefined ? { ...one, status, endedAt: now } : one,
  )
}

function isEnded(status: string): boolean {
  return ENDED.includes(status)
}

/** A helper the Agent tool is starting, under the call's id until it has its own. */
export function helperStarting(id: string, description: string, now: number): SessionBoardHelper {
  return { id, description: description.trim() || 'Helper', startedAt: now, status: 'running' }
}

/** The helpers after the Agent call `callId` answered (`outcome` is its result). */
export function settleAgentCall(
  helpers: readonly SessionBoardHelper[],
  callId: string,
  outcome: { deny?: string; isError?: boolean; result?: unknown },
  now: number,
): SessionBoardHelper[] {
  if (outcome.deny !== undefined) return helpers.filter(one => one.id !== callId)
  const result = typeof outcome.result === 'object' && outcome.result !== null ? (outcome.result as Record<string, unknown>) : {}
  const resultId = typeof result['agentId'] === 'string' ? result['agentId'] : typeof result['taskId'] === 'string' ? result['taskId'] : null
  // agent.spawn may already have given the call's card the agent's own id
  const target = helpers.some(one => one.id === callId) ? callId : resultId
  return helpers.map(one => {
    if (target === null || one.id !== target) return one
    if (outcome.isError === true) return { ...one, status: 'failed', endedAt: now }
    const id = resultId ?? one.id
    if (result['status'] === 'completed' || (result['status'] === undefined && id === one.id)) {
      return { ...one, id, status: 'completed', endedAt: now }
    }
    return { ...one, id, status: 'running' }
  })
}

function helperOrder(a: SessionBoardHelper, b: SessionBoardHelper): number {
  const aEnded = a.endedAt !== undefined
  const bEnded = b.endedAt !== undefined
  if (aEnded !== bEnded) return aEnded ? 1 : -1
  if (aEnded && bEnded) return (b.endedAt ?? 0) - (a.endedAt ?? 0)
  return a.startedAt - b.startedAt
}

/**
 * This session's helpers: the ones it tracked from Agent calls joined with
 * `$.agent.list()` (`listed`, null when it could not be read). One that left
 * the listing while running is taken as finished; finished ones stay ten minutes.
 */
export function mergeHelpers(
  tracked: readonly SessionBoardHelper[],
  listed: readonly AgentLike[] | null,
  now: number,
  activity: ReadonlyMap<string, number> = new Map(),
): SessionBoardHelper[] {
  const byId = new Map<string, SessionBoardHelper>()
  for (const one of tracked) byId.set(one.id, { ...one })
  // a workflow's agent is never listed: it ends at its turn.complete, or after a long quiet
  for (const one of byId.values()) {
    if (one.isUnlisted !== true || one.endedAt !== undefined) continue
    const last = Math.max(one.startedAt, activity.get(one.id) ?? 0)
    if (now - last > UNLISTED_QUIET_MS) byId.set(one.id, { ...one, status: 'completed', endedAt: last })
  }
  if (listed !== null) {
    const seen = new Set(listed.map(one => one.id))
    for (const one of byId.values()) {
      const isLaunching = one.id.startsWith('call:')
      if (one.isUnlisted === true) continue
      if (!seen.has(one.id) && !isLaunching && one.endedAt === undefined && now - one.startedAt > 10 * SECOND) {
        byId.set(one.id, { ...one, status: 'completed', endedAt: now })
      }
    }
    for (const agent of listed) {
      const had = byId.get(agent.id)
      const base: SessionBoardHelper = had ?? {
        id: agent.id,
        description: agent.description || 'Helper',
        startedAt: now,
        status: agent.status,
      }
      const next: SessionBoardHelper = {
        ...base,
        description: agent.description.trim() || base.description,
        status: agent.status,
      }
      if (isEnded(agent.status)) next.endedAt = base.endedAt ?? now
      else delete next.endedAt
      byId.set(agent.id, next)
    }
  }
  return [...byId.values()]
    .filter(one => one.endedAt === undefined || now - one.endedAt <= HELPER_KEEP_MS)
    .sort(helperOrder)
    .slice(0, 12)
}

/** Whether two helper lists say the same. */
export function sameHelpers(a: readonly SessionBoardHelper[], b: readonly SessionBoardHelper[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export type HelperCard = { key: string; text: string; tone: RowTone; isDim: boolean }

/** One helper as a card of exactly `width` cells: `● Fix tests  1:12`. */
export function helperCard(helper: SessionBoardHelper, now: number, width: number): HelperCard {
  let glyph = '●'
  let right = clock(now - helper.startedAt)
  let tone: RowTone = 'good'
  let isDim = false
  switch (helper.status) {
    case 'pending':
      glyph = '○'
      right = 'queued'
      tone = 'muted'
      isDim = true
      break
    case 'waiting':
      glyph = '‖'
      right = 'waiting'
      tone = 'warn'
      break
    case 'idle':
      glyph = '○'
      right = 'idle'
      tone = 'muted'
      break
    case 'completed': {
      glyph = '✓'
      const took = (helper.endedAt ?? now) - helper.startedAt
      right = took >= SECOND ? clock(took) : 'done'
      tone = 'muted'
      break
    }
    case 'failed':
      glyph = '■'
      right = 'failed'
      tone = 'warn'
      break
    case 'killed':
      glyph = '■'
      right = 'stopped'
      tone = 'muted'
      break
    default:
      if (!ACTIVE.includes(helper.status) && !isEnded(helper.status)) right = helper.status
  }
  const room = Math.max(1, width - cells(right) - 4)
  const text = pad(`${glyph} ${fit(helper.description, room)}  ${right}`, width)
  return { key: `h:${helper.id}`, text, tone, isDim }
}

/** Cards per row: three when each gets 24 cells, two when 16, else one. */
export function cardsAcross(columns: number): number {
  if (Math.floor((columns - 4) / 3) >= 24) return 3
  if (Math.floor((columns - 2) / 2) >= 16) return 2
  return 1
}

/** Each card's width when `n` share `columns` with two-cell gaps (never wider than `columns`). */
export function cardWidth(columns: number, n: number): number {
  return Math.max(1, Math.min(columns, Math.max(4, Math.floor((columns - 2 * (n - 1)) / n))))
}

/** Each big tile's width when `n` share `columns`, never wider than `columns`. */
export function boardTileWidth(columns: number, n: number): number {
  return Math.max(1, Math.min(columns, tileWidth(columns, n)))
}

/**
 * The calls holding a waiting state when a permission prompt shows: the calls
 * in flight whose permission verdict was `ask`, else the newest call in flight
 * (an earlier call still running is not the blocked one).
 */
export function blockersFor(asking: readonly string[], inFlight: readonly string[]): string[] {
  const asked = inFlight.filter(id => asking.includes(id))
  if (asked.length > 0) return asked
  const newest = inFlight.at(-1)
  return newest !== undefined ? [newest] : []
}

/**
 * What the waiting state does once a call holding it ended: back to `to` when
 * none is left (`reasons`, oldest first, are those still holding it), else the
 * reason of the newest one still open.
 */
export function afterBlocked(reasons: readonly string[], to: 'working' | 'idle'): BoardEvent {
  const open = reasons.at(-1)
  return open === undefined ? { kind: 'resume', to } : { kind: 'still-waiting', reason: open }
}

/** Splits `items` into rows of `n`. */
export function chunk<T>(items: readonly T[], n: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += Math.max(1, n)) rows.push(items.slice(i, i + Math.max(1, n)))
  return rows
}

/** A plain-text summary of the board, for when the pane cannot be placed. */
export function summaryLines(beats: readonly SessionBoardBeat[], selfId: string, now: number): string[] {
  const groups = boardGroups(beats, selfId, now)
  const rows = [...groups.waiting, ...groups.working, ...groups.done]
  if (!groups.hasOthers) return ['Only this session is running.']
  return [`Sessions: ${headerRight(groups)}`, ...rows.map(row => `${row.left}${row.right}`)]
}

/** Breaks `text` into lines of whole words, each at most `columns` cells (a longer word is cut). */
export function wrapWords(text: string, columns: number): string[] {
  const width = Math.max(1, columns)
  const out: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(one => one !== '')) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (cells(candidate) <= width) {
      current = candidate
      continue
    }
    if (current !== '') out.push(current)
    current = fit(word, width)
  }
  if (current !== '') out.push(current)
  return out
}
