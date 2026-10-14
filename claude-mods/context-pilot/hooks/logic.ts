// Pure logic for context-pilot: measuring, cache tax, growth bumps, handoff
// rules, paths and text. No `$` here, so the tests call it directly.

import type {
  PilotBump,
  PilotHandoff,
  PilotHelper,
  PilotSettings,
  PilotSnapshot,
  PilotTotals,
} from '../types'
import { cells, clock, fit, tokens } from './look-text'

// ─── Settings ────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: PilotSettings = {
  isAuto: true,
  mainThreshold: 70,
  helperMinutes: 20,
  helperContext: 30,
  showStatus: true,
}

function intIn(value: unknown, low: number, high: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(high, Math.max(low, Math.round(n)))
}

/** Settings read back from the store, every field checked; defaults fill gaps. */
export function normalizeSettings(raw: unknown): PilotSettings {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    isAuto: typeof o.isAuto === 'boolean' ? o.isAuto : DEFAULT_SETTINGS.isAuto,
    mainThreshold: intIn(o.mainThreshold, 10, 95, DEFAULT_SETTINGS.mainThreshold),
    helperMinutes: intIn(o.helperMinutes, 1, 600, DEFAULT_SETTINGS.helperMinutes),
    helperContext: intIn(o.helperContext, 5, 95, DEFAULT_SETTINGS.helperContext),
    showStatus: typeof o.showStatus === 'boolean' ? o.showStatus : DEFAULT_SETTINGS.showStatus,
  }
}

type SettingSpec = {
  name: string
  aliases: readonly string[]
  kind: 'switch' | 'number'
  field: keyof PilotSettings
  low?: number
  high?: number
  unit?: string
  about: string
}

const SETTINGS: readonly SettingSpec[] = [
  { name: 'auto', aliases: ['auto-handoff', 'handoff'], kind: 'switch', field: 'isAuto', about: 'auto-handoff notes' },
  {
    name: 'main',
    aliases: ['threshold', 'main-threshold'],
    kind: 'number',
    field: 'mainThreshold',
    low: 10,
    high: 95,
    unit: '%',
    about: 'main context threshold',
  },
  {
    name: 'helper-minutes',
    aliases: ['minutes'],
    kind: 'number',
    field: 'helperMinutes',
    low: 1,
    high: 600,
    unit: ' min',
    about: 'helper time limit',
  },
  {
    name: 'helper-context',
    aliases: ['helper'],
    kind: 'number',
    field: 'helperContext',
    low: 5,
    high: 95,
    unit: '%',
    about: 'helper context limit',
  },
  { name: 'status', aliases: ['status-line', 'statusline'], kind: 'switch', field: 'showStatus', about: 'status line' },
]

function shownValue(spec: SettingSpec, settings: PilotSettings): string {
  const value = settings[spec.field]
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : `${value}${spec.unit ?? ''}`
}

/** `/pilot settings`: every setting, its value and what it does. */
export function settingsText(settings: PilotSettings): string {
  const rows = SETTINGS.map(
    spec => `  ${spec.name.padEnd(15)} ${shownValue(spec, settings).padEnd(7)} ${spec.about}`,
  )
  return ['Context pilot settings', ...rows, 'Change one with /pilot set <name> <value>.'].join('\n')
}

/** Applies `/pilot set <name> <value>`: the new settings and a sentence, or why not. */
export function applySetting(
  settings: PilotSettings,
  name: string,
  value: string,
): { settings: PilotSettings; text: string } | { error: string } {
  const key = name.trim().toLowerCase()
  const spec = SETTINGS.find(one => one.name === key || one.aliases.includes(key))
  if (spec === undefined) {
    return { error: `There is no setting "${name}". Settings: ${SETTINGS.map(s => s.name).join(', ')}.` }
  }
  const raw = value.trim().toLowerCase()
  if (spec.kind === 'switch') {
    const isOn = ['on', 'true', 'yes', '1'].includes(raw)
    const isOff = ['off', 'false', 'no', '0'].includes(raw)
    if (!isOn && !isOff) return { error: `${spec.name} takes on or off.` }
    const next = { ...settings, [spec.field]: isOn }
    return { settings: next, text: `${capital(spec.about)} is ${isOn ? 'on' : 'off'}.` }
  }
  const n = Number(raw.replace(/%$/, '').replace(/min(utes)?$/, '').trim())
  const low = spec.low ?? 0
  const high = spec.high ?? 100
  if (!Number.isFinite(n) || Math.round(n) !== n || n < low || n > high) {
    return { error: `${spec.name} takes a whole number from ${low} to ${high}.` }
  }
  const next = { ...settings, [spec.field]: n }
  return { settings: next, text: `${capital(spec.about)} set to ${n}${spec.unit ?? ''}.` }
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** What `/pilot <args>` asks for. */
export type PilotCommand =
  | { kind: 'open' }
  | { kind: 'auto'; isOn: boolean }
  | { kind: 'settings' }
  | { kind: 'set'; name: string; value: string }
  | { kind: 'help' }

export function parsePilot(args: string): PilotCommand {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  const first = (words[0] ?? '').toLowerCase()
  if (first === '' || first === 'open' || first === 'show') return { kind: 'open' }
  if (first === 'on' || first === 'off') return { kind: 'auto', isOn: first === 'on' }
  if (first === 'settings' || first === 'config') return { kind: 'settings' }
  if (first === 'set' && words.length >= 3) {
    return { kind: 'set', name: words[1] ?? '', value: words.slice(2).join(' ') }
  }
  return { kind: 'help' }
}

export const PILOT_HELP =
  'Usage: /pilot opens the pane; /pilot on|off turns auto-handoff on or off; ' +
  '/pilot settings lists the settings; /pilot set <name> <value> changes one.'

// ─── Measuring ───────────────────────────────────────────────────────────────

/** The four token counts a request reports (ModelUsage). */
export type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

/** The context a request was answered over: uncached + cache read + cache written. */
export function contextOf(usage: StepUsage): number {
  return count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens)
}

/** The share of a request's input the prompt cache served, 0 to 1. */
export function hitRate(usage: StepUsage): number {
  const total = contextOf(usage)
  return total > 0 ? count(usage.cache_read_input_tokens) / total : 0
}

/**
 * Cache tax of one request: what it wrote to the cache that the previous
 * request of the same loop had already left there (a miss, an expiry, a changed
 * prefix). A loop's first request pays none, nor does the normal write of the
 * new tail.
 *
 * @param previousCached what the previous request read plus wrote; null for
 *   the loop's first request
 */
export function taxOf(usage: StepUsage, previousCached: number | null): number {
  if (previousCached === null) return 0
  const missed = Math.max(0, previousCached - count(usage.cache_read_input_tokens))
  return Math.max(0, Math.min(count(usage.cache_creation_input_tokens), missed))
}

/** The window of a model: 1M when its id carries `[1m]`, else 200k. */
export function windowOfModel(model: string): number {
  return /\[1m\]/i.test(model) ? 1_000_000 : 200_000
}

/** `claude-opus-5-5[1m]` -> `opus-5-5[1m]`; `claude-sonnet-4-5-20250929` -> `sonnet-4-5`. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}(?=$|\[)/, '')
}

function roundTenth(n: number): number {
  return Math.round(n * 10) / 10
}

/** Adds one request to the session's cache totals. */
export function addTotals(totals: PilotTotals, usage: StepUsage, tax: number): PilotTotals {
  return {
    requests: totals.requests + 1,
    input: totals.input + contextOf(usage),
    read: totals.read + count(usage.cache_read_input_tokens),
    written: totals.written + count(usage.cache_creation_input_tokens),
    tax: totals.tax + tax,
  }
}

/** The session's cache hit rate, 0 to 1. */
export function sessionHit(totals: PilotTotals): number {
  return totals.input > 0 ? totals.read / totals.input : 0
}

export function freshSnapshot(now: number, sessionStart: number = now): PilotSnapshot {
  return {
    sessionStart,
    model: '',
    window: 0,
    context: 0,
    percent: 0,
    statusPercent: null,
    costUsd: null,
    requests: 0,
    turn: 0,
    turnId: null,
    history: [],
    pending: 'your prompt',
    arrival: null,
    bumps: [],
    last: null,
    totals: { requests: 0, input: 0, read: 0, written: 0, tax: 0 },
    isArmed: true,
    phase: 'measuring',
    phaseTurn: 0,
    notes: 0,
    isWaiting: false,
    updatedAt: now,
  }
}

// ─── What arrived between two requests ──────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(part => part !== '')
  return parts[parts.length - 1] ?? path
}

function oneLine(text: string, width: number): string {
  const first = text.split('\n')[0] ?? ''
  return fit(first.replace(/\s+/g, ' ').trim(), width)
}

/** One tool call named by its tool and main argument: `Read app.js`, `Bash npm test`. */
export function toolLabel(name: string, input: unknown): string {
  const args = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const file = str(args.file_path) || str(args.notebook_path) || str(args.path)
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file !== '' ? `${name} ${baseName(file)}` : name
    case 'Bash':
      return str(args.command) !== '' ? `Bash ${oneLine(str(args.command), 40)}` : 'Bash'
    case 'Grep':
      return str(args.pattern) !== '' ? `Grep "${oneLine(str(args.pattern), 30)}"` : 'Grep'
    case 'Glob':
      return str(args.pattern) !== '' ? `Glob ${oneLine(str(args.pattern), 30)}` : 'Glob'
    case 'Agent':
    case 'Task':
      return str(args.description) !== '' ? `Agent "${oneLine(str(args.description), 40)}"` : 'Agent'
    case 'WebFetch': {
      const host = /^[a-z]+:\/\/([^/?#]+)/i.exec(str(args.url))?.[1]
      return host !== undefined ? `WebFetch ${host}` : 'WebFetch'
    }
    case 'WebSearch':
      return str(args.query) !== '' ? `WebSearch "${oneLine(str(args.query), 30)}"` : 'WebSearch'
    case 'Skill':
      return str(args.skill) !== '' ? `Skill ${oneLine(str(args.skill), 30)}` : 'Skill'
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      if (mcp !== null) return `${mcp[1]}:${mcp[2]}`
      return file !== '' ? `${name} ${baseName(file)}` : name
    }
  }
}

/** The tool calls a response asked for, as one label; null when it asked for none. */
export function labelOf(toolUses: readonly { name: string; input: unknown }[]): string | null {
  const first = toolUses[0]
  if (first === undefined) return null
  const label = toolLabel(first.name, first.input)
  return toolUses.length > 1 ? `${label} +${toolUses.length - 1}` : label
}

/** What a change of context between two main requests is put down to. */
export function attribute(delta: number, isNewTurn: boolean, pending: string, arrival: string | null): string {
  if (delta < 0) return 'compaction'
  if (isNewTurn) return arrival ?? 'your prompt'
  return arrival !== null ? `${pending} + ${arrival}` : pending
}

/** A prompt row's origin, as a bump label. */
export function arrivalLabel(kind: string): string {
  switch (kind) {
    case 'composer':
    case 'bridge':
    case 'sdk':
      return 'your prompt'
    case 'task-notification':
      return 'task notification'
    case 'plugin':
      return 'plugin prompt'
    case 'peer':
    case 'peer-send-message':
      return 'peer message'
    case 'scheduled-trigger':
      return 'scheduled prompt'
    default:
      return 'incoming message'
  }
}

/** Notes a prompt or delivery that came in for the main loop. */
export function noteArrival(s: PilotSnapshot, label: string): PilotSnapshot {
  if (s.arrival === null) return { ...s, arrival: label }
  if (s.arrival === label || s.arrival.endsWith(' …')) return s
  return { ...s, arrival: `${s.arrival} …` }
}

/** Keeps the five biggest rises, biggest first (an earlier one wins a tie). */
export function rankBumps(bumps: readonly PilotBump[], bump: PilotBump, keep = 5): PilotBump[] {
  if (!(bump.delta > 0)) return bumps.slice(0, keep)
  return [...bumps, bump].sort((a, b) => b.delta - a.delta).slice(0, keep)
}

// ─── One main-loop request ──────────────────────────────────────────────────

export type MainStep = {
  turnId: string
  index: number
  model: string
  usage: StepUsage
  toolUses: readonly { name: string; input: unknown }[]
  now: number
  /** The session's window when the engine reported one (0 when not). */
  window: number
  statusPercent: number | null
  costUsd: number | null
}

const HISTORY = 240

/**
 * Folds one main-loop request into the snapshot: context, percent, history,
 * cache and tax, the bump since the last request, and the threshold. `fire` is
 * true when this request crossed the threshold while armed (a note is due).
 */
export function applyMainStep(
  s: PilotSnapshot,
  step: MainStep,
  settings: PilotSettings,
): { snapshot: PilotSnapshot; fire: boolean } {
  const context = contextOf(step.usage)
  const window = step.window > 0 ? step.window : windowOfModel(step.model)
  const percent = window > 0 ? roundTenth((context / window) * 100) : 0
  const isNewTurn = step.index === 0 || step.turnId !== s.turnId
  const turn = isNewTurn ? s.turn + 1 : s.turn

  let bumps = s.bumps
  if (s.requests > 0) {
    const delta = context - s.context
    bumps = rankBumps(bumps, { delta, label: attribute(delta, isNewTurn, s.pending, s.arrival), turn })
  }

  const previousCached = s.last === null ? null : s.last.read + s.last.written
  const tax = taxOf(step.usage, previousCached)

  let isArmed = s.isArmed
  let phase = s.phase
  let phaseTurn = typeof s.phaseTurn === 'number' ? s.phaseTurn : s.turn
  let fire = false
  // A saved handoff is news until the next main turn. An ask is answered in
  // the turn after it: a second new turn with nothing saved means it was not.
  if (isNewTurn && phase === 'handed-off' && turn > phaseTurn) phase = 'measuring'
  if (isNewTurn && phase === 'handing-off' && turn > phaseTurn + 1) phase = 'measuring'
  // Re-armed only by a real drop after the note fired (a compaction).
  if (!isArmed && percent < settings.mainThreshold - 10) {
    isArmed = true
    if (phase === 'handing-off') phase = 'measuring'
  }
  if (settings.isAuto && isArmed && percent >= settings.mainThreshold) {
    fire = true
    isArmed = false
    phase = 'handing-off'
    phaseTurn = turn
  }

  const snapshot: PilotSnapshot = {
    ...s,
    model: step.model !== '' ? step.model : s.model,
    window,
    context,
    percent,
    statusPercent: step.statusPercent ?? s.statusPercent,
    costUsd: step.costUsd ?? s.costUsd,
    requests: s.requests + 1,
    turn,
    turnId: step.turnId,
    history: [...s.history, context].slice(-HISTORY),
    pending: labelOf(step.toolUses) ?? "Claude's reply",
    arrival: null,
    bumps,
    last: {
      context,
      hit: hitRate(step.usage),
      read: count(step.usage.cache_read_input_tokens),
      written: count(step.usage.cache_creation_input_tokens),
      tax,
      output: count(step.usage.output_tokens),
    },
    totals: addTotals(s.totals, step.usage, tax),
    isArmed,
    phase,
    phaseTurn,
    notes: fire ? s.notes + 1 : s.notes,
    isWaiting: false,
    updatedAt: step.now,
  }
  return { snapshot, fire }
}

/**
 * The snapshot with a new handoff phase, set in main turn `turn` (the turn
 * running now; the last measured one by default).
 */
export function withPhase(s: PilotSnapshot, phase: PilotSnapshot['phase'], turn: number = s.turn): PilotSnapshot {
  return { ...s, phase, phaseTurn: turn }
}

/**
 * The main turn running now: the last measured one, or the one after it when
 * a turn has started that no request of has been measured yet.
 *
 * @param running the running main turn's id; null while idle
 */
export function currentTurn(s: PilotSnapshot, running: string | null): number {
  return running !== null && running !== s.turnId ? s.turn + 1 : s.turn
}

/** Folds a helper's request into the session's cache totals. */
export function applyHelperCache(s: PilotSnapshot, usage: StepUsage, tax: number, now: number): PilotSnapshot {
  return { ...s, totals: addTotals(s.totals, usage, tax), updatedAt: now }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export type HelperStep = {
  id: string
  description: string
  model: string
  usage: StepUsage
  now: number
  /** The window the session reports when the helper runs main's model; 0 or absent to go by the model id. */
  window?: number
}

export type HelperDue = { isTime: boolean; isContext: boolean; minutes: number; percent: number }

const MINUTE = 60_000

/** Whether a running helper has passed a limit and has not been asked yet. */
export function helperDue(helper: PilotHelper, now: number, settings: PilotSettings): HelperDue | null {
  if (!settings.isAuto || helper.isWarned || helper.endedAt !== null) return null
  const minutes = Math.floor((now - helper.startedAt) / MINUTE)
  const isTime = now - helper.startedAt >= settings.helperMinutes * MINUTE
  const isContext = helper.percent >= settings.helperContext
  if (!isTime && !isContext) return null
  return { isTime, isContext, minutes, percent: Math.round(helper.percent) }
}

function warned(helper: PilotHelper, due: HelperDue): PilotHelper {
  const why = due.isTime && due.isContext ? 'time and context' : due.isTime ? 'time' : 'context'
  return { ...helper, isWarned: true, warnedFor: why }
}

const KEEP_HELPERS = 20

function keepRecent(list: readonly PilotHelper[]): PilotHelper[] {
  return [...list].sort((a, b) => a.lastAt - b.lastAt).slice(-KEEP_HELPERS)
}

export function newHelper(id: string, description: string, now: number): PilotHelper {
  return {
    id,
    description,
    startedAt: now,
    lastAt: now,
    endedAt: null,
    context: 0,
    window: 0,
    percent: 0,
    requests: 0,
    cached: 0,
    isBackground: false,
    parentId: null,
    isWarned: false,
    warnedFor: null,
    handoffPath: null,
    isReported: false,
  }
}

/**
 * Folds one helper request into the helper list: its context, percent and
 * cache. `due` says a limit was passed now (the helper is marked asked, so it
 * is asked once); `tax` is this request's cache tax.
 */
export function applyHelperStep(
  list: readonly PilotHelper[],
  step: HelperStep,
  settings: PilotSettings,
): { list: PilotHelper[]; due: HelperDue | null; tax: number } {
  const found = list.find(one => one.id === step.id)
  const base = found ?? newHelper(step.id, step.description, step.now)
  const context = contextOf(step.usage)
  const window = step.window !== undefined && step.window > 0 ? step.window : windowOfModel(step.model)
  const tax = taxOf(step.usage, base.requests > 0 ? base.cached : null)
  let helper: PilotHelper = {
    ...base,
    description: base.description !== '' ? base.description : step.description,
    // A helper resumed after its run ended (a follow-up message) times its new run.
    startedAt: base.endedAt !== null ? step.now : base.startedAt,
    lastAt: step.now,
    endedAt: null,
    context,
    window,
    percent: roundTenth((context / window) * 100),
    requests: base.requests + 1,
    cached: count(step.usage.cache_read_input_tokens) + count(step.usage.cache_creation_input_tokens),
  }
  const due = helperDue(helper, step.now, settings)
  if (due !== null) helper = warned(helper, due)
  const rest = list.filter(one => one.id !== step.id)
  return { list: keepRecent([...rest, helper]), due, tax }
}

/** The timer's check: every running helper past a limit, each marked asked. */
export function sweepHelpers(
  list: readonly PilotHelper[],
  now: number,
  settings: PilotSettings,
): { list: PilotHelper[]; due: { id: string; due: HelperDue }[] } {
  const due: { id: string; due: HelperDue }[] = []
  const next = list.map(helper => {
    const reason = helperDue(helper, now, settings)
    if (reason === null) return helper
    due.push({ id: helper.id, due: reason })
    return warned(helper, reason)
  })
  return { list: next, due }
}

/** Takes back a helper's ask whose note never reached it, so it reads as never asked. */
export function unwarn(list: readonly PilotHelper[], id: string): PilotHelper[] {
  return list.map(one => (one.id === id && one.isWarned ? { ...one, isWarned: false, warnedFor: null } : one))
}

/** Marks a helper's run ended. */
export function endHelper(list: readonly PilotHelper[], id: string, now: number): PilotHelper[] {
  return list.map(one => (one.id === id ? { ...one, endedAt: now, lastAt: now } : one))
}

/** Records a helper the Agent tool started in the background (creating it if new). */
export function markBackground(
  list: readonly PilotHelper[],
  id: string,
  description: string,
  now: number,
  parentId: string | null = null,
): PilotHelper[] {
  const found = list.find(one => one.id === id)
  const helper = { ...(found ?? newHelper(id, description, now)), isBackground: true, parentId }
  if (helper.description === '') helper.description = description
  return keepRecent([...list.filter(one => one.id !== id), helper])
}

/** Records where a helper saved its handoff. */
export function markHandoff(list: readonly PilotHelper[], id: string, path: string, now: number): PilotHelper[] {
  const found = list.find(one => one.id === id)
  const helper = { ...(found ?? newHelper(id, '', now)), handoffPath: path }
  return keepRecent([...list.filter(one => one.id !== id), helper])
}

/** Marks that the main loop was told about a helper's early stop. */
export function markReported(list: readonly PilotHelper[], id: string): PilotHelper[] {
  return list.map(one => (one.id === id ? { ...one, isReported: true } : one))
}

/** A helper still counts as running until it ends, or stays silent this long. */
export const STALE_MS = 30 * MINUTE

/** The helpers the pane lists: running ones, then up to three that handed off. */
export function visibleHelpers(list: readonly PilotHelper[], now: number): PilotHelper[] {
  const running = list.filter(one => one.endedAt === null && now - one.lastAt < STALE_MS)
  const handed = list
    .filter(one => one.handoffPath !== null && !running.includes(one))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 3)
  return [...running.sort((a, b) => a.startedAt - b.startedAt), ...handed]
}

/** Whether any helper is still running (the watch timer runs while one is). */
export function hasRunning(list: readonly PilotHelper[], now: number): boolean {
  return list.some(one => one.endedAt === null && now - one.lastAt < STALE_MS)
}

/** Within 80% of either limit. */
export function isNearLimit(helper: PilotHelper, now: number, settings: PilotSettings): boolean {
  const ranFor = (helper.endedAt ?? now) - helper.startedAt
  return ranFor >= 0.8 * settings.helperMinutes * MINUTE || helper.percent >= 0.8 * settings.helperContext
}

// ─── Notes to Claude ────────────────────────────────────────────────────────

export const TOOL_NAME = 'save_handoff'
export const TOOL_FULL = 'mcp__context-pilot__save_handoff'

const WRAP_UP =
  "Wrap up: don't start new helpers, let running helpers finish, update any files you were changing to a " +
  `consistent state, then call save_handoff (the ${TOOL_FULL} tool, scope 'session') with: the goal, what is ` +
  'done, what is in progress, the exact next steps, key files and decisions, gotchas, and how to verify. ' +
  'Then stop and tell the person to start a fresh session and type /pickup.'

/** The note appended to the main conversation at the threshold. */
export function mainNote(percent: number): string {
  return `Context is at ${Math.round(percent)}%. ${WRAP_UP}`
}

/** The prompt `/handoff` and the pane's button queue. */
export function handoffNowPrompt(percent: number | null): string {
  const at = percent === null ? '' : ` (context is at ${Math.round(percent)}%)`
  return `Write a session handoff now${at}. ${WRAP_UP}`
}

/** The note appended into a helper's own loop when it passes a limit. */
export function helperNote(due: HelperDue): string {
  const why =
    due.isTime && due.isContext
      ? `You have been running ${due.minutes} minutes and your context is ${due.percent}%.`
      : due.isTime
        ? `You have been running ${due.minutes} minutes.`
        : `Your context is ${due.percent}%.`
  return (
    `${why} Stop now: call save_handoff (the ${TOOL_FULL} tool, scope 'helper') with only the remaining ` +
    "work (what is left, files, next steps), then end with a one-paragraph summary that starts 'HANDOFF SAVED'."
  )
}

/** What the main loop reads when a helper that stopped early returns. */
export function helperReturnNote(helper: PilotHelper): string | null {
  if (helper.handoffPath !== null) {
    return (
      `This helper stopped early and saved a handoff at ${helper.handoffPath}. Start a fresh helper with the ` +
      "Agent tool and give it that handoff's text to finish the remaining work."
    )
  }
  if (helper.isWarned) {
    return (
      'This helper was asked to stop early and saved no handoff. Its summary above describes what it finished; ' +
      'start a fresh helper with the Agent tool for whatever work is left.'
    )
  }
  return null
}

// ─── Handoff files ──────────────────────────────────────────────────────────

/** A filesystem-safe slug of the project root: `/Users/leland/Coding/earshot` -> `Users-leland-Coding-earshot`. */
export function projectSlug(root: string): string {
  const slug = root
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(-120)
    .replace(/^[-.]+|[-.]+$/g, '')
  return slug === '' ? 'root' : slug
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYYMMDD-HHMMSS` in local time. */
export function stamp(ms: number): string {
  const d = new Date(ms)
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-` +
    `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  )
}

/** `YYYY-MM-DD HH:MM` in local time. */
export function readableTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** The mod's data folder under HOME. */
export function dataDir(home: string): string {
  return `${home.replace(/[\\/]+$/, '')}/.claude/mod-data/context-pilot`
}

/** The folder this project's handoffs go in. */
export function handoffDir(home: string, root: string): string {
  return `${dataDir(home)}/handoffs/${projectSlug(root)}`
}

/** Where one handoff goes: `<stamp>-<scope>.md`, `-2`, `-3` on a clash. */
export function handoffFile(dir: string, ms: number, scope: 'session' | 'helper', attempt = 1): string {
  const suffix = attempt > 1 ? `-${attempt}` : ''
  return `${dir}/${stamp(ms)}-${scope}${suffix}.md`
}

export function latestFile(dir: string): string {
  return `${dir}/latest.md`
}

/** The text a handoff file holds: a heading, one line of where and when, then Claude's text. */
export function handoffText(o: {
  text: string
  title: string
  scope: 'session' | 'helper'
  root: string
  now: number
  from: string
}): string {
  const fallback = o.scope === 'session' ? 'Session handoff' : 'Helper handoff'
  const title = o.title.trim().split('\n')[0]?.trim() || fallback
  const from = o.from !== '' ? ` · from ${o.from}` : ''
  return `# ${title}\n\nSaved ${readableTime(o.now)} · ${o.scope} · ${o.root}${from}\n\n${o.text.trim()}\n`
}

/** The title and a one-line summary of a handoff file's text. */
export function summarize(text: string): { title: string; summary: string } {
  const lines = text.split('\n').map(line => line.trim())
  const heading = lines.find(line => /^#\s+/.test(line))
  const title = heading !== undefined ? heading.replace(/^#+\s+/, '') : (lines.find(line => line !== '') ?? 'Handoff')
  const body = lines.find(
    line => line !== '' && !/^#/.test(line) && !/^Saved \d{4}-\d{2}-\d{2}/.test(line) && line !== title,
  )
  return { title: fit(title, 80), summary: fit((body ?? '').replace(/^[-*]\s+/, ''), 160) }
}

/** A handoff record for state. */
export function handoffRecord(o: {
  path: string
  home: string
  savedAt: number
  text: string
  scope: 'session' | 'helper'
  isFromEarlier: boolean
}): PilotHandoff {
  const { title, summary } = summarize(o.text)
  return {
    path: o.path,
    shownPath: tildePath(o.path, o.home),
    savedAt: o.savedAt,
    title,
    summary,
    scope: o.scope,
    isFromEarlier: o.isFromEarlier,
  }
}

export const WEEK_MS = 7 * 24 * 60 * MINUTE

/** Whether a latest.md is a handoff waiting from an earlier session. */
export function handoffWaits(o: { mtimeMs: number; now: number; sessionStart: number; pickedMtime: number | null }): boolean {
  return o.mtimeMs < o.sessionStart && o.now - o.mtimeMs < WEEK_MS && o.pickedMtime !== o.mtimeMs
}

/** The text `/pickup` puts in the prompt box. */
export function pickupPrompt(text: string): string {
  return `Continue from this handoff. Read it, confirm the next step, then carry on:\n\n${text.trim()}`
}

// ─── Status line and pane text ──────────────────────────────────────────────

/** The status line under the prompt; undefined clears it. */
export function statusText(s: PilotSnapshot, settings: PilotSettings): string | undefined {
  if (!settings.showStatus) return undefined
  if (s.requests === 0) return s.isWaiting ? 'handoff waiting · /pickup' : undefined
  const parts = [
    `ctx ${Math.round(s.percent)}%`,
    `cache ${Math.round(sessionHit(s.totals) * 100)}%`,
    `tax ${tokens(s.totals.tax)}`,
  ]
  if (s.phase === 'handing-off') parts.push('handing off…')
  if (s.phase === 'handed-off') parts.push('handoff saved')
  return parts.join(' · ')
}

/** `just now`, `5m ago`, `2h ago`, `3d ago`. */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Cuts text from the start, keeping its end: `…/earshot/latest.md`. */
export function fitStart(text: string, width: number): string {
  const chars = Array.from(text)
  if (width <= 0) return ''
  if (chars.length <= width) return text
  if (width === 1) return '…'
  return '…' + chars.slice(chars.length - (width - 1)).join('')
}

/** A path with HOME written as `~`. */
export function tildePath(path: string, home: string): string {
  const clean = home.replace(/[\\/]+$/, '')
  return clean !== '' && path.startsWith(clean) ? `~${path.slice(clean.length)}` : path
}

/** A jump's size with one decimal under 100k: `950`, `12.3k`, `18k`, `140k`, `1.2M`. */
export function deltaTokens(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1_000 || abs >= 100_000) return tokens(n)
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

/** One "Biggest jumps" row: `+12.3k  Read app.js · turn 4`, cut to `columns`. */
export function bumpLine(bump: PilotBump, columns: number): string {
  const head = `+${deltaTokens(bump.delta)}`.padEnd(7) + ' '
  const tail = ` · turn ${bump.turn}`
  const room = columns - cells(head) - cells(tail)
  if (room < 4) return fit(`${head}${bump.label}`, columns)
  return `${head}${fit(bump.label, room)}${tail}`
}

/** The pane's one line when it is too narrow for the rest: `ctx 42% · cache 99% · tax 0`. */
export function narrowLine(s: PilotSnapshot): string {
  if (s.requests === 0) return 'Nothing measured yet.'
  return `ctx ${Math.round(s.percent)}% · cache ${Math.round(sessionHit(s.totals) * 100)}% · tax ${tokens(s.totals.tax)}`
}

/** The muted line under the growth chart. */
export function scaleLine(history: readonly number[], shown: number, columns: number): string {
  const values = history.slice(-Math.max(1, shown))
  const peak = Math.max(0, ...values)
  const low = Math.min(...values)
  const text =
    values.length === 0
      ? ''
      : `${tokens(low)} to ${tokens(peak)} peak · last ${values.length} request${values.length === 1 ? '' : 's'}`
  return fit(text, columns)
}

/** "Status line says 38% · measured 42% · window 200k". */
export function compareLine(s: PilotSnapshot): string {
  const says = s.statusPercent === null ? 'Status line has no figure yet' : `Status line says ${Math.round(s.statusPercent)}%`
  return `${says} · measured ${Math.round(s.percent)}% · window ${tokens(s.window)}`
}

/** "Last request 97% hit · 1.2k written · 0 tax · $1.24 so far". */
export function lastLine(s: PilotSnapshot): string {
  if (s.last === null) return ''
  const cost = s.costUsd === null ? '' : ` · $${s.costUsd.toFixed(2)} so far`
  return (
    `Last request ${Math.round(s.last.hit * 100)}% hit · ${tokens(s.last.written)} written · ` +
    `${tokens(s.last.tax)} tax${cost}`
  )
}

/** The Context tile's tone and label. */
export function contextLook(percent: number, threshold: number): { tone: 'good' | 'warn'; label: string } {
  if (percent >= threshold) return { tone: 'warn', label: 'Context · handoff' }
  if (percent >= 50) return { tone: 'warn', label: 'Context' }
  return { tone: 'good', label: 'Context' }
}

/** One helper row's parts, sized to `columns`. */
export function helperRow(
  helper: PilotHelper,
  now: number,
  columns: number,
): { name: string; time: string; pct: string; meterWidth: number; isHanded: boolean } {
  const isHanded = helper.handoffPath !== null
  const time = clock((helper.endedAt ?? now) - helper.startedAt).padStart(7)
  const pct = isHanded ? ' handed off' : `${String(Math.round(helper.percent)).padStart(3)}%`
  const meterWidth = isHanded ? 0 : columns >= 70 ? 16 : columns >= 48 ? 8 : 0
  const fixed = cells(time) + 1 + cells(pct) + (meterWidth > 0 ? meterWidth + 1 : 0)
  const name = fit(helper.description !== '' ? helper.description : helper.id, Math.max(1, columns - fixed))
  return { name, time, pct, meterWidth, isHanded }
}

/** The pane's one line about the latest handoff. */
export function handoffLine(handoff: PilotHandoff | null, now: number, columns: number): string {
  if (handoff === null) return fit('No handoff for this project yet.', columns)
  const when = handoff.isFromEarlier ? `From an earlier session, ${ago(now - handoff.savedAt)}` : `Saved ${ago(now - handoff.savedAt)}`
  const head = `${when} · `
  const room = columns - cells(head)
  if (room < 8) return fit(`${head}${handoff.shownPath}`, columns)
  return `${head}${fitStart(handoff.shownPath, room)}`
}

/** Breaks text into lines of at most `width` cells, at spaces where it can. */
export function wrapWords(text: string, width: number): string[] {
  const room = Math.max(1, width)
  const lines: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(one => one !== '')) {
    const piece = cells(word) > room ? fit(word, room) : word
    if (current === '') current = piece
    else if (cells(current) + 1 + cells(piece) <= room) current = `${current} ${piece}`
    else {
      lines.push(current)
      current = piece
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

/** The agent id, status and description an Agent tool's result carries, if any. */
export function agentRecord(result: unknown): { agentId: string; status: string; description: string } | null {
  if (result === null || typeof result !== 'object') return null
  const o = result as Record<string, unknown>
  if (typeof o.agentId !== 'string' || o.agentId === '') return null
  return { agentId: o.agentId, status: str(o.status), description: str(o.description) }
}
