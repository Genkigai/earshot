// context-pilot: a context meter measured from real token counts, cache-tax
// tracking, growth bumps, and automatic handoffs for long work.
//
// Every `$` call lives here. The rules and text are in logic.ts, the pane's
// drawing in view.tsx.

import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer, TurnStepInput, TurnStepResult } from 'claude-code'

import type { PilotHandoff, PilotHelper, PilotSettings, PilotSnapshot } from '../types'
import {
  DEFAULT_SETTINGS,
  PILOT_HELP,
  TOOL_NAME,
  agentRecord,
  applyHelperCache,
  applyHelperStep,
  applyMainStep,
  applySetting,
  arrivalLabel,
  currentTurn,
  endHelper,
  freshSnapshot,
  handoffDir,
  handoffFile,
  handoffNowPrompt,
  handoffRecord,
  handoffText,
  handoffWaits,
  hasRunning,
  helperNote,
  helperReturnNote,
  latestFile,
  mainNote,
  markBackground,
  markHandoff,
  markReported,
  normalizeSettings,
  noteArrival,
  parsePilot,
  pickupPrompt,
  projectSlug,
  settingsText,
  statusText,
  sweepHelpers,
  taxOf,
  unwarn,
  withPhase,
} from './logic'
import type { HelperDue } from './logic'
import { drawPane } from './view'

type Engine = EngineInterface

const PANE = 'context-pilot'
const PANE_TITLE = 'Context pilot'
const SAVE_TOOL = /^mcp__context-pilot__save_handoff$/

const snapshotAtom = atom({ plugin: 'context-pilot', key: 'snapshot' } as const, freshSnapshot(0, 0))
const settingsAtom = atom({ plugin: 'context-pilot', key: 'settings' } as const, DEFAULT_SETTINGS)
const helpersAtom = atom({ plugin: 'context-pilot', key: 'helpers' } as const, [] as PilotHelper[])
const handoffAtom = atom({ plugin: 'context-pilot', key: 'handoff' } as const, null as PilotHandoff | null)
// The running main turn's id (null while idle). Kept in state, not module
// memory, so a reload in the middle of a turn still knows a turn runs.
const busyAtom = atom({ plugin: 'context-pilot', key: 'busy' } as const, null as string | null)

const TOOL_DESCRIPTION =
  'Save a handoff so the remaining work continues cleanly in a fresh session or a fresh helper. Call it when ' +
  'context-pilot asks you to hand off, or when the person asks for a handoff. scope "session" is the main ' +
  'conversation (the next session picks it up with /pickup); scope "helper" is a subagent handing back only ' +
  'its remaining work. Write the text in Markdown: the goal, what is done, what is in progress, the exact next ' +
  'steps, key files and decisions, gotchas, and how to verify. Returns the saved path.'

// Loops the engine runs that are no helper of the Agent tool (compaction,
// memory, a workflow's agents): how often each was looked up, and what its
// last request left in the cache, so its cache still counts.
const lookups = new Map<string, number>()
const loopCache = new Map<string, number>()

// Timers: the pane's one-second redraw while it is open, a slow look while it
// waits undrawn (the redraw starts once it is drawn), and the helper watch
// while a helper runs. A reload drops them; session.start starts them again.
let ticker: Timer | undefined
let placing: Timer | undefined
let watcher: Timer | undefined

// Notes to Claude wait here until their loop has no tool call outstanding, so
// a note never lands between a tool call and its result: they are added after
// the last result of a step comes in, at the loop's next request, or (main
// loop) when the turn ends. `outstanding` counts the results a loop still
// waits for; the main loop is the key ''. Results stored while a loop's step
// still streams are counted in `seen` and settled when the step ends.
//
// An `isAsk` note asks a helper to hand off: the helper counts as asked only
// once it is stored, so one that never goes in takes the ask back.
type Note = { text: string; isAsk: boolean }
const MAIN = ''
const pending = new Map<string, Note[]>()
const outstanding = new Map<string, number>()
const streaming = new Set<string>()
const seen = new Map<string, number>()
// Helpers whose ask went in at the top of their latest step, after that
// request was built: read only if that step calls a tool and the loop goes on.
const unreadAsk = new Set<string>()

// ─── Small helpers ──────────────────────────────────────────────────────────

function reason(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'an unknown error'
}

function setStatus($: Engine, snapshot: PilotSnapshot, settings: PilotSettings): void {
  try {
    $.ui.status(statusText(snapshot, settings))
  } catch {
    // the status line is a nicety
  }
}

/** A toast for something the person needs to know (a failure); never throws. */
function toast($: Engine, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // nowhere to say it
  }
}

async function homeDir($: Engine): Promise<string> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (home === undefined || home === '') throw new Error('HOME is not set')
  return home
}

async function appendNote($: Engine, text: string, agentId?: string): Promise<boolean> {
  try {
    const stored = await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text }] },
      ...(agentId !== undefined ? { agentId } : {}),
    })
    if (stored.deny !== undefined) {
      $.ui.log(`context-pilot: a note was refused: ${stored.deny}`, { to: 'debug' })
      return false
    }
    return true
  } catch (error) {
    $.ui.log(`context-pilot: a note could not be added: ${reason(error)}`, { to: 'debug' })
    return false
  }
}

function queueNote(loop: string, note: Note): void {
  pending.set(loop, [...(pending.get(loop) ?? []), note])
}

async function isMainBusy($: Engine): Promise<boolean> {
  return (await read($, busyAtom)) !== null
}

/** A note for the main loop: queued while a main turn runs, else added now. */
async function tellMain($: Engine, text: string): Promise<void> {
  if (await isMainBusy($)) queueNote(MAIN, { text, isAsk: false })
  else await appendNote($, text)
}

async function flushNotes($: Engine, loop: string): Promise<void> {
  const notes = pending.get(loop)
  if (notes === undefined) return
  pending.delete(loop)
  for (const note of notes) {
    const isStored = await appendNote($, note.text, loop === MAIN ? undefined : loop)
    if (isStored || loop === MAIN) continue
    // A helper never read its ask; a report for a helper that ended goes to main.
    if (note.isAsk) await update($, helpersAtom, list => unwarn(list, loop))
    else await tellMain($, note.text)
  }
}

/** A helper's run ended with notes still waiting: asks are taken back, reports go to main. */
async function dropLoop($: Engine, id: string): Promise<void> {
  const notes = pending.get(id) ?? []
  pending.delete(id)
  for (const note of notes) {
    if (note.isAsk) await update($, helpersAtom, list => unwarn(list, id))
    else await tellMain($, note.text)
  }
}

async function saveSettings($: Engine, change: (settings: PilotSettings) => PilotSettings): Promise<PilotSettings> {
  const next = await update($, settingsAtom, change)
  await $.store.set('settings', next)
  setStatus($, await read($, snapshotAtom), next)
  return next
}

// ─── Measuring ──────────────────────────────────────────────────────────────

async function afterMainStep($: Engine, e: TurnStepInput, result: TurnStepResult): Promise<void> {
  const usage = result.usage
  if (usage === null) return
  const now = await $.clock.now()
  let window = 0
  let statusPercent: number | null = null
  let costUsd: number | null = null
  try {
    const measured = await $.session.usage()
    window = measured.context.window
    statusPercent = measured.context.percent ?? null
    costUsd = measured.cost?.usd ?? null
  } catch {
    // the model's own window stands in
  }
  const settings = await read($, settingsAtom)
  let fire = false
  const snapshot = await update($, snapshotAtom, current => {
    const out = applyMainStep(
      current,
      {
        turnId: e.turnId,
        index: e.index,
        model: e.model,
        usage,
        toolUses: result.toolUses,
        now,
        window,
        statusPercent,
        costUsd,
      },
      settings,
    )
    fire = out.fire
    return out.snapshot
  })
  if (fire) queueNote(MAIN, { text: mainNote(snapshot.percent), isAsk: false })
  setStatus($, snapshot, settings)
}

async function lookupAgent($: Engine, id: string): Promise<AgentInfo | null> {
  const tries = lookups.get(id) ?? 0
  if (tries >= 3) return null
  try {
    const found = (await $.agent.list()).find(agent => agent.id === id)
    if (found !== undefined) {
      lookups.delete(id)
      return found
    }
  } catch {
    // looked up again on its next request
  }
  lookups.set(id, tries + 1)
  return null
}

async function countLoopCache($: Engine, id: string, result: TurnStepResult, now: number): Promise<void> {
  const usage = result.usage
  if (usage === null) return
  const tax = taxOf(usage, loopCache.get(id) ?? null)
  loopCache.set(id, usage.cache_read_input_tokens + usage.cache_creation_input_tokens)
  await update($, snapshotAtom, current => applyHelperCache(current, usage, tax, now))
}

async function afterHelperStep($: Engine, e: TurnStepInput, result: TurnStepResult): Promise<void> {
  const usage = result.usage
  const id = e.agentId
  if (usage === null || id === undefined) return
  const now = await $.clock.now()
  const known = (await read($, helpersAtom)).find(one => one.id === id)
  let description = known?.description ?? ''
  if (known === undefined) {
    const info = await lookupAgent($, id)
    if (info === null || info.teammateId !== undefined) {
      await countLoopCache($, id, result, now)
      return
    }
    description = info.description
  }
  const settings = await read($, settingsAtom)
  // A helper on main's model has main's window, as the session reports it.
  const main = await read($, snapshotAtom)
  const window = e.model === main.model ? main.window : 0
  let due: HelperDue | null = null
  let tax = 0
  await update($, helpersAtom, list => {
    const out = applyHelperStep(list, { id, description, model: e.model, usage, now, window }, settings)
    due = out.due
    tax = out.tax
    return out.list
  })
  await update($, snapshotAtom, current => applyHelperCache(current, usage, tax, now))
  const reasonDue: HelperDue | null = due
  if (reasonDue !== null) queueNote(id, { text: helperNote(reasonDue), isAsk: true })
  if (settings.isAuto) ensureWatcher($)
}

function ensureWatcher($: Engine): void {
  if (watcher !== undefined) return
  watcher = $.clock.every(30_000, () => {
    void sweep($)
  })
}

function stopWatcher(): void {
  watcher?.cancel()
  watcher = undefined
}

async function sweep($: Engine): Promise<void> {
  try {
    const now = await $.clock.now()
    const list = await read($, helpersAtom)
    const settings = await read($, settingsAtom)
    if (!settings.isAuto || !hasRunning(list, now)) {
      stopWatcher()
      return
    }
    let due: { id: string; due: HelperDue }[] = []
    await update($, helpersAtom, current => {
      const out = sweepHelpers(current, now, settings)
      due = out.due
      return out.list
    })
    for (const one of due) queueNote(one.id, { text: helperNote(one.due), isAsk: true })
  } catch {
    stopWatcher()
  }
}

async function helperEnded($: Engine, id: string): Promise<void> {
  const now = await $.clock.now()
  const list = await update($, helpersAtom, current => endHelper(current, id, now))
  const helper = list.find(one => one.id === id)
  if (helper === undefined || !helper.isBackground || helper.isReported) return
  const note = helperReturnNote(helper)
  if (note === null) return
  await update($, helpersAtom, current => markReported(current, id))
  // Told to the loop that started it, or the main loop once that one ended.
  const parent = helper.parentId === null ? undefined : list.find(one => one.id === helper.parentId)
  if (parent !== undefined && parent.endedAt === null) queueNote(parent.id, { text: note, isAsk: false })
  else await tellMain($, note)
}

// ─── Handoffs ───────────────────────────────────────────────────────────────

type SaveArgs = { text: string; scope: 'session' | 'helper'; title: string; agentId: string | undefined }

function saveArgs(e: unknown): SaveArgs {
  const o = e !== null && typeof e === 'object' ? (e as Record<string, unknown>) : {}
  const agentId = typeof o.agentId === 'string' && o.agentId !== '' ? o.agentId : undefined
  // A helper's handoff is always a helper's: latest.md belongs to the main session.
  const scope = agentId !== undefined ? 'helper' : o.scope === 'helper' ? 'helper' : 'session'
  return {
    text: typeof o.text === 'string' ? o.text : '',
    scope,
    title: typeof o.title === 'string' ? o.title : '',
    agentId,
  }
}

async function exists($: Engine, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

async function saveHandoff($: Engine, args: SaveArgs): Promise<string> {
  const home = await homeDir($)
  const root = await $.session.root()
  const now = await $.clock.now()
  const dir = handoffDir(home, root)
  let path = handoffFile(dir, now, args.scope)
  for (let attempt = 2; attempt <= 9 && (await exists($, path)); attempt++) {
    path = handoffFile(dir, now, args.scope, attempt)
  }
  const helper =
    args.agentId === undefined ? undefined : (await read($, helpersAtom)).find(one => one.id === args.agentId)
  const from = args.agentId === undefined ? '' : `helper ${helper?.description !== undefined && helper.description !== '' ? `"${helper.description}"` : args.agentId}`
  const body = handoffText({ text: args.text, title: args.title, scope: args.scope, root, now, from })
  await $.fs.write(path, body)
  if (args.scope === 'session') await $.fs.write(latestFile(dir), body)
  const record = handoffRecord({ path, home, savedAt: now, text: body, scope: args.scope, isFromEarlier: false })
  await update($, handoffAtom, () => record)
  if (args.agentId !== undefined) {
    const agentId = args.agentId
    await update($, helpersAtom, list => markHandoff(list, agentId, path, now))
  } else if (args.scope === 'session') {
    const turn = currentTurn(await read($, snapshotAtom), await read($, busyAtom))
    const snapshot = await update($, snapshotAtom, current => withPhase(current, 'handed-off', turn))
    setStatus($, snapshot, await read($, settingsAtom))
  }
  return path
}

async function requestHandoff($: Engine): Promise<void> {
  const settings = await read($, settingsAtom)
  const before = await read($, snapshotAtom)
  const turn = currentTurn(before, await read($, busyAtom))
  const snapshot = await update($, snapshotAtom, current => withPhase(current, 'handing-off', turn))
  setStatus($, snapshot, settings)
  // Nothing was asked: the status line goes back to what it said.
  const putBack = async (): Promise<void> => {
    const back = await update($, snapshotAtom, current =>
      current.phase === 'handing-off' && current.phaseTurn === turn
        ? withPhase(current, before.phase, before.phaseTurn)
        : current,
    )
    setStatus($, back, settings)
  }
  let dropped: string | undefined
  try {
    dropped = (await $.prompt.submit({ text: handoffNowPrompt(snapshot.requests > 0 ? snapshot.percent : null) })).drop
  } catch (error) {
    await putBack()
    throw error
  }
  if (dropped !== undefined) {
    await putBack()
    toast($, `Claude was not asked for a handoff: ${dropped}`)
  }
}

function askForHandoff($: Engine): void {
  void (async () => {
    try {
      await requestHandoff($)
    } catch {
      toast($, 'Context pilot could not ask Claude for a handoff.')
    }
  })()
}

async function markPicked($: Engine, path: string, root: string): Promise<void> {
  try {
    const snapshot = await update($, snapshotAtom, current => ({ ...current, isWaiting: false }))
    setStatus($, snapshot, await read($, settingsAtom))
    const stat = await $.fs.stat(path)
    const raw = await $.store.get('picked')
    const picked = raw !== null && typeof raw === 'object' ? { ...(raw as Record<string, number>) } : {}
    picked[projectSlug(root)] = stat.mtimeMs
    const kept = Object.entries(picked).slice(-50)
    await $.store.set('picked', Object.fromEntries(kept))
  } catch {
    // remembering the pickup is a nicety
  }
}

/** At start (and after a reload): settings, the snapshot, a waiting handoff, the timers. */
async function startup($: Engine): Promise<void> {
  const settings = normalizeSettings(await $.store.get('settings'))
  await update($, settingsAtom, () => settings)
  const now = await $.clock.now()
  let startedAt = now
  try {
    startedAt = (await $.session.usage()).startedAt
  } catch {
    // now stands in
  }
  let snapshot = await update($, snapshotAtom, current =>
    current.sessionStart === 0 ? freshSnapshot(now, startedAt) : current,
  )
  try {
    const home = await homeDir($)
    const root = await $.session.root()
    const path = latestFile(handoffDir(home, root))
    if (await exists($, path)) {
      const stat = await $.fs.stat(path)
      const text = await $.fs.read(path)
      const raw = await $.store.get('picked')
      const picked = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const mark = picked[projectSlug(root)]
      const isFromEarlier = stat.mtimeMs < snapshot.sessionStart
      const record = handoffRecord({ path, home, savedAt: stat.mtimeMs, text, scope: 'session', isFromEarlier })
      await update($, handoffAtom, current => (current === null || current.savedAt <= record.savedAt ? record : current))
      const waits = handoffWaits({
        mtimeMs: stat.mtimeMs,
        now,
        sessionStart: snapshot.sessionStart,
        pickedMtime: typeof mark === 'number' ? mark : null,
      })
      if (waits && snapshot.requests === 0) {
        snapshot = await update($, snapshotAtom, current => ({ ...current, isWaiting: true }))
      }
    }
  } catch (error) {
    $.ui.log(`context-pilot: the latest handoff could not be read: ${reason(error)}`, { to: 'debug' })
  }
  setStatus($, snapshot, settings)
  try {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane?.isPlaced === true) startTicker($)
    else if (pane !== undefined) watchPlacing($)
    if (settings.isAuto && hasRunning(await read($, helpersAtom), now)) ensureWatcher($)
  } catch {
    // timers start with the next pane open or helper request
  }
}

// ─── The pane ───────────────────────────────────────────────────────────────

function startTicker($: Engine): void {
  stopPlacing()
  if (ticker !== undefined) return
  ticker = $.clock.every(1000, () => {
    void tick($)
  })
}

function stopTicker(): void {
  ticker?.cancel()
  ticker = undefined
}

async function tick($: Engine): Promise<void> {
  try {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane === undefined) {
      stopTicker()
      return
    }
    if (pane.isShown && pane.isPlaced) $.ui.invalidate('ui.render')
  } catch {
    stopTicker()
  }
}

/** A pane that waits undrawn: looked at every 2 seconds until it is drawn or gone. */
function watchPlacing($: Engine): void {
  if (placing !== undefined || ticker !== undefined) return
  placing = $.clock.every(2000, () => {
    void checkPlaced($)
  })
}

function stopPlacing(): void {
  placing?.cancel()
  placing = undefined
}

async function checkPlaced($: Engine): Promise<void> {
  try {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane === undefined) stopPlacing()
    else if (pane.isPlaced) startTicker($)
  } catch {
    stopPlacing()
  }
}

function openPane($: Engine): void {
  void (async () => {
    try {
      const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
      // The one-second redraw runs only for a pane that is drawn.
      if (opened.isPlaced) startTicker($)
      else {
        watchPlacing($)
        const line = statusText(await read($, snapshotAtom), { ...(await read($, settingsAtom)), showStatus: true })
        toast($, `The pilot pane waits for a wider window.${line !== undefined ? ` ${line}` : ''}`)
      }
    } catch {
      toast($, 'The context pilot pane could not open.')
    }
  })()
}

async function copyPath($: Engine, surface: Parameters<Engine['ui']['copy']>[0]['surface']): Promise<void> {
  try {
    const handoff = await read($, handoffAtom)
    const path = handoff !== null ? handoff.path : handoffDir(await homeDir($), await $.session.root())
    const copied = await $.ui.copy({ text: path, ...(surface !== undefined ? { surface } : {}) })
    if (!copied.isCopied) toast($, `Could not copy the path (${copied.reason}).`)
  } catch {
    toast($, 'Could not copy the path.')
  }
}

async function toggleAuto($: Engine): Promise<void> {
  try {
    await saveSettings($, settings => ({ ...settings, isAuto: !settings.isAuto }))
  } catch {
    toast($, 'Could not change auto-handoff.')
  }
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.tool.register({
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The handoff itself, in Markdown.' },
            scope: {
              type: 'string',
              enum: ['session', 'helper'],
              description: '"session" for the main conversation, "helper" for a subagent. Defaults by who calls.',
            },
            title: { type: 'string', description: 'A short title for the handoff.' },
          },
          required: ['text'],
        },
        isDeferred: false,
      })
    } catch (error) {
      $.ui.log(`context-pilot: save_handoff could not be registered: ${reason(error)}`, { to: 'debug' })
      toast($, 'Context pilot could not give Claude its save_handoff tool, so handoffs cannot be saved this session.')
    }
    try {
      await $.command.register({
        name: 'pilot',
        description: 'Context pilot: measured context, cache tax and handoffs (opens a pane)',
        argumentHint: '[on|off|settings|set <name> <value>]',
        immediate: true,
      })
      await $.command.register({
        name: 'handoff',
        description: 'Ask Claude to write a session handoff now',
        immediate: true,
      })
      await $.command.register({
        name: 'pickup',
        description: "Put this project's latest handoff in the prompt box",
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`context-pilot: a command could not be registered: ${reason(error)}`, { to: 'debug' })
    }
    try {
      await startup($)
    } catch (error) {
      $.ui.log(`context-pilot: start-up failed: ${reason(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        const now = await $.clock.now()
        const snapshot = await update($, snapshotAtom, () => freshSnapshot(now))
        await update($, helpersAtom, () => [])
        lookups.clear()
        loopCache.clear()
        pending.clear()
        outstanding.clear()
        streaming.clear()
        seen.clear()
        unreadAsk.clear()
        await update($, busyAtom, () => null)
        stopWatcher()
        setStatus($, snapshot, await read($, settingsAtom))
      } catch {
        // a fresh start is a nicety
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      await update($, busyAtom, () => e.turnId)
    } catch {
      // notes for main then go in at once, as while idle
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const loop = e.agentId ?? MAIN
    // Notes still waiting (a result count that never closed) go in now: every
    // result of the last step is in by the time the next request starts. This
    // request is built already, so the loop reads them at its next one.
    if (pending.has(loop)) {
      const hasAsk = (pending.get(loop) ?? []).some(note => note.isAsk)
      try {
        await flushNotes($, loop)
      } catch {
        // tried again at the next request
      }
      if (hasAsk && loop !== MAIN) unreadAsk.add(loop)
    }
    // Results the engine stores while this step still streams are counted
    // here, and settled against the step's tool calls once it ends.
    streaming.add(loop)
    seen.set(loop, 0)
    let result: TurnStepResult
    try {
      result = yield* next(e)
    } finally {
      streaming.delete(loop)
    }
    try {
      const uses = result.toolUses.length
      const left = Math.max(0, uses - (seen.get(loop) ?? 0))
      seen.delete(loop)
      outstanding.set(loop, left)
      if (uses > 0) unreadAsk.delete(loop)
      if (e.agentId === undefined) await afterMainStep($, e, result)
      else await afterHelperStep($, e, result)
      // Every result is in (while the step streamed or while it was measured):
      // a note due now goes after them. The count is read again, not `left`.
      if (uses > 0 && (outstanding.get(loop) ?? 0) === 0 && pending.has(loop)) await flushNotes($, loop)
    } catch (error) {
      $.ui.log(`context-pilot: a request was not measured: ${reason(error)}`, { to: 'debug' })
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    try {
      if (e.agentId === undefined) {
        await update($, busyAtom, () => null)
        outstanding.delete(MAIN)
        await flushNotes($, MAIN)
      } else {
        // A helper that ended reads no more notes: an ask it never read is
        // taken back, so the main loop is not told it was asked to stop.
        await dropLoop($, e.agentId)
        const id = e.agentId
        if (unreadAsk.delete(id)) await update($, helpersAtom, list => unwarn(list, id))
        outstanding.delete(id)
        seen.delete(id)
        await helperEnded($, id)
      }
    } catch {
      // the helper list catches up on its next request
    }
    return out
  })

  on('session.measure', async ($, e, next) => {
    try {
      await update($, snapshotAtom, current => ({
        ...current,
        statusPercent: e.context.percent ?? current.statusPercent,
        costUsd: e.cost?.usd ?? current.costUsd,
        window: current.window > 0 ? current.window : e.context.window,
      }))
    } catch {
      // the next request measures again
    }
    return next(e)
  })

  on('session.append', { door: ['prompt', 'delivery', 'tool-result'] }, async ($, e, next) => {
    const stored = await next(e)
    if (stored.deny !== undefined) return stored
    try {
      if (e.door === 'tool-result') {
        const loop = e.agentId ?? MAIN
        const results = Math.max(1, e.message.content.filter(block => block.type === 'tool_result').length)
        if (streaming.has(loop)) {
          // The step still streams: it settles this count when it ends.
          seen.set(loop, (seen.get(loop) ?? 0) + results)
        } else {
          const left = Math.max(0, (outstanding.get(loop) ?? 0) - results)
          outstanding.set(loop, left)
          // The step's last result is stored: a waiting note goes in after it.
          if (left === 0 && pending.has(loop)) void flushNotes($, loop).catch(() => undefined)
        }
      } else if (e.agentId === undefined) {
        const label = arrivalLabel(e.origin.kind)
        await update($, snapshotAtom, current => noteArrival(current, label))
      }
    } catch {
      // a note waits for the next request; a bump is put down to the prompt
    }
    return stored
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    try {
      const record = agentRecord(ran.result)
      if (record === null) return ran
      const now = await $.clock.now()
      if (record.status === 'async_launched') {
        const description = record.description !== '' ? record.description : e.description
        const parentId = e.agentId ?? null
        await update($, helpersAtom, list => markBackground(list, record.agentId, description, now, parentId))
        if ((await read($, settingsAtom)).isAuto) ensureWatcher($)
        return ran
      }
      const helper = (await read($, helpersAtom)).find(one => one.id === record.agentId)
      if (helper === undefined || helper.isReported) return ran
      const note = helperReturnNote(helper)
      if (note === null) return ran
      await update($, helpersAtom, list => markReported(list, record.agentId))
      return { ...ran, context: [...(ran.context ?? []), note] }
    } catch {
      return ran
    }
  }).catch(($, e, next) => next(e))

  // A RegExp matcher: the tool is this mod's own, so the laid table of MCP
  // tools may not list it yet.
  on('tool.call', { tool: SAVE_TOOL }, async ($, e) => {
    const args = saveArgs(e)
    if (args.text.trim() === '') return { deny: 'save_handoff needs the handoff itself in `text`.' }
    try {
      const path = await saveHandoff($, args)
      return { result: `Handoff saved to ${path}.` }
    } catch (error) {
      return {
        deny: `The handoff could not be saved (${reason(error)}). Put the handoff text in your reply instead.`,
      }
    }
  }).catch(() => ({ deny: 'The handoff could not be saved. Put the handoff text in your reply instead.' }))

  on('command.run', { command: 'pilot' }, async ($, e) => {
    try {
      const command = parsePilot(typeof e.args === 'string' ? e.args : '')
      switch (command.kind) {
        case 'open':
          openPane($)
          return { text: 'Opening the context pilot.' }
        case 'auto': {
          await saveSettings($, settings => ({ ...settings, isAuto: command.isOn }))
          return { text: `Auto-handoff is ${command.isOn ? 'on' : 'off'}.` }
        }
        case 'settings':
          return { text: settingsText(await read($, settingsAtom)) }
        case 'set': {
          const out = applySetting(await read($, settingsAtom), command.name, command.value)
          if ('error' in out) return { text: out.error }
          await saveSettings($, () => out.settings)
          return { text: out.text }
        }
        case 'help':
          return { text: PILOT_HELP }
      }
    } catch {
      return { text: 'The pilot command failed. Nothing was changed.' }
    }
  }).catch(() => ({ text: 'The pilot command failed. Nothing was changed.' }))

  on('command.run', { command: 'handoff' }, $ => {
    try {
      askForHandoff($)
      return { text: 'Asking Claude to write a handoff.' }
    } catch {
      return { text: 'Could not ask for a handoff. Nothing was changed.' }
    }
  }).catch(() => ({ text: 'Could not ask for a handoff. Nothing was changed.' }))

  on('command.run', { command: 'pickup' }, async $ => {
    try {
      const home = await homeDir($)
      const root = await $.session.root()
      const path = latestFile(handoffDir(home, root))
      let text = ''
      try {
        text = await $.fs.read(path)
      } catch {
        return { text: 'No handoff for this project yet.' }
      }
      if (text.trim() === '') return { text: 'No handoff for this project yet.' }
      const filled = await $.prompt.fill({ text: pickupPrompt(text), mode: 'replace' })
      if (!filled.isFilled) return { text: `The prompt box could not take the handoff right now. It is at ${path}.` }
      void markPicked($, path, root)
      return { text: 'The handoff is in your prompt box. Press Enter to continue.' }
    } catch {
      return { text: 'Pickup failed. Nothing was changed.' }
    }
  }).catch(() => ({ text: 'Pickup failed. Nothing was changed.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const columns = Math.max(1, Math.floor(e.props.bodyColumns))
    const snapshot = await read($, snapshotAtom)
    const settings = await read($, settingsAtom)
    const helpers = await read($, helpersAtom)
    const handoff = await read($, handoffAtom)
    let now = snapshot.updatedAt
    try {
      now = await $.clock.now()
    } catch {
      // the last update's time stands in
    }
    return drawPane(
      kit,
      { snapshot, settings, helpers, handoff, now, columns },
      {
        writeNow: () => askForHandoff($),
        toggleAuto: () => toggleAuto($),
        copyPath: () => copyPath($, e.surface),
        close: () => $.ui.close({ id: PANE }).catch(() => undefined),
      },
    )
  })
}
