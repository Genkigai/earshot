// session-board: every Claude Code session on this computer, a timer on each.
// Each session writes a small heartbeat file; the pane, the status line and
// the same-folder notes read the others'. Every `$` call lives here.

import type { EngineInterface, FsEntry, Register, RenderSurface, Timer } from 'claude-code'

import type { SessionBoardBeat, SessionBoardHelper, SessionBoardSnapshot } from '../types'
import * as L from './logic'
import type { BoardRow } from './logic'
import { drawBoard } from './view'

type Engine = EngineInterface

const PANE = 'session-board'
const SELF = { plugin: 'session-board', key: 'self' } as const
const SNAPSHOT = { plugin: 'session-board', key: 'snapshot' } as const
const NOTE = { plugin: 'session-board', key: 'note' } as const
const IS_ON = { plugin: 'session-board', key: 'isOn' } as const
const TOASTED = { plugin: 'session-board', key: 'toasted' } as const

const FAILED = 'The sessions command failed. Nothing was changed.'

// The working copy of this session's heartbeat, mirrored into $.state (SELF)
// so a hot reload finds it again. A reload runs this module afresh: these
// reset, its timers are dropped, and session.start loads them again.
let me: SessionBoardBeat | null = null
let isOn = true
let home = ''
let clearedId = ''
let inTurn = false
let seq = 0
// tool calls in flight, oldest first; those whose permission verdict was `ask`;
// and the calls holding the waiting state, each with its reason (it ends once they have all finished)
let inFlight: string[] = []
let asking = new Set<string>()
let blockers = new Map<string, string>()
// the last tool call of each workflow helper, which no agent list names
let activity = new Map<string, number>()
let lastWriteAt = Number.NEGATIVE_INFINITY
let isDirPrivate = false
let lastNote: L.SentNote | null = null
// null until the first status call of this load, so a line left from before a reload is replaced
let lastStatus: string | undefined | null = null
let trailing: Timer | null = null
let beat: { timer: Timer; mode: 'active' | 'idle' } | null = null
let refresh: { timer: Timer; ms: number } | null = null
let others: { at: number; beats: SessionBoardBeat[] } | null = null
let loading: Promise<void> | null = null

/** Puts the module's working values back to where a fresh load starts. */
function resetModule(): void {
  me = null
  isOn = true
  home = ''
  clearedId = ''
  inTurn = false
  seq = 0
  inFlight = []
  asking = new Set()
  blockers = new Map()
  activity = new Map()
  lastWriteAt = Number.NEGATIVE_INFINITY
  isDirPrivate = false
  lastNote = null
  lastStatus = null
  trailing = null
  beat = null
  refresh = null
  others = null
  loading = null
}

// ------------------------------------------------------------ loading

function ready($: Engine): Promise<void> {
  if (loading === null) {
    loading = load($).catch(() => {
      loading = null
    })
  }
  return loading
}

async function load($: Engine): Promise<void> {
  // only an absolute folder: a relative or `~` HOME would put files inside the project
  home = L.pickHome([await $.env.get('HOME'), await $.env.get('USERPROFILE')])
  isOn = (await $.store.get('isOn')) !== false
  await $.state.set(IS_ON, isOn)
  const kept = (await $.state.get(SELF)).value ?? null
  const id = await $.session.id()
  const base = kept !== null && kept.id === id ? kept : await freshBeat($, id)
  // edits outside the project are never shared (an older load may have kept some)
  me = { ...base, edits: base.edits.filter(one => !L.isAbsolutePath(one.path)) }
  // a reload forgets when workflow helpers last worked: count from now, not from their start
  const loadedAt = await $.clock.now()
  for (const one of L.helpersWorking(me)) if (one.isUnlisted === true) activity.set(one.id, loadedAt)
  inTurn = me.state === 'working' || me.state === 'waiting'
  await mirror($)
}

async function freshBeat($: Engine, id: string): Promise<SessionBoardBeat> {
  const now = await $.clock.now()
  const root = await $.session.root()
  const [branch, model, title] = await Promise.all([gitBranch($, root), sessionModel($), firstTitle($)])
  return L.newBeat({ id, root, branch, model, now, title })
}

async function gitBranch($: Engine, root: string): Promise<string> {
  try {
    const ran = await $.process.run(['git', 'branch', '--show-current'], { cwd: root, timeoutMs: 3_000 })
    return ran.exitCode === 0 ? ran.stdout.trim() : ''
  } catch {
    return ''
  }
}

async function sessionModel($: Engine): Promise<string> {
  try {
    return await $.session.model()
  } catch {
    return ''
  }
}

/** A resumed session's title, from its first real prompt. */
async function firstTitle($: Engine): Promise<string | null> {
  try {
    const rows = await $.session.messages()
    return Array.isArray(rows) ? L.titleFromMessages(rows) : null
  } catch {
    return null
  }
}

/** This session's beat, made afresh when the session id moved (a /clear). */
async function current($: Engine): Promise<SessionBoardBeat | null> {
  await ready($)
  const id = await $.session.id()
  if (me !== null && me.id === id) return me
  if (id === clearedId) return me
  me = await freshBeat($, id)
  inTurn = false
  lastWriteAt = Number.NEGATIVE_INFINITY
  await mirror($)
  return me
}

async function mirror($: Engine): Promise<void> {
  try {
    await $.state.set(SELF, me)
  } catch {
    // the mirror is a convenience for reloads
  }
}

// ------------------------------------------------------------ changes and writes

/** Applies one event to this session's beat; writes when it changed. */
function apply($: Engine, event: L.BoardEvent, now: number): void {
  if (me === null) return
  const before = me
  me = L.transition(me, event, now)
  if (me.state !== 'waiting') blockers.clear()
  if (me !== before) {
    void mirror($)
    void requestWrite($)
  }
}

/** Writes the heartbeat now, or once the 3 s gap since the last write has passed. */
async function requestWrite($: Engine): Promise<void> {
  if (!isOn || me === null || home === '') return
  const now = await $.clock.now()
  const wait = L.throttleWait(lastWriteAt, now)
  if (wait > 0) {
    if (trailing === null) {
      trailing = $.clock.after(wait, () => {
        trailing = null
        void requestWrite($)
      })
    }
    return
  }
  lastWriteAt = now
  me = { ...me, lastBeat: now, edits: L.pruneEdits(me.edits, now) }
  const text = JSON.stringify(me)
  void mirror($)
  try {
    await $.fs.write(L.beatPath(home, me.id), text)
  } catch {
    // a failed write is retried by the next heartbeat
    return
  }
  if (!isDirPrivate) {
    isDirPrivate = true
    void keepPrivate($)
  }
}

/** Heartbeats hold prompt and command text: only this user may open the folder. */
async function keepPrivate($: Engine): Promise<void> {
  try {
    await $.process.run(['chmod', '700', L.sessionsDir(home)], { timeoutMs: 2_000 })
  } catch {
    // where chmod is missing (plain Windows) the folder keeps its own rights
  }
}

/** Removes a heartbeat file; where `rm` is missing, marks it ended instead. */
async function removeBeat($: Engine, id: string): Promise<void> {
  if (home === '') return
  const path = L.beatPath(home, id)
  try {
    const ran = await $.process.run(['rm', '-f', path], { timeoutMs: 2_000 })
    if (ran.exitCode === 0) return
  } catch {
    // fall through to the ended mark
  }
  if (me === null || me.id !== id) return
  try {
    const now = await $.clock.now()
    await $.fs.write(path, JSON.stringify({ ...me, state: 'ended', lastBeat: now }))
  } catch {
    // nothing more to do
  }
}

/** Removes heartbeat files older than a day, and ended ones. */
async function sweep($: Engine, names: readonly string[]): Promise<void> {
  if (names.length === 0 || home === '') return
  const dir = L.sessionsDir(home)
  try {
    await $.process.run(['rm', '-f', ...names.map(name => `${dir}/${name}`)], { timeoutMs: 5_000 })
  } catch {
    // readers ignore them anyway
  }
}

// ------------------------------------------------------------ timers

/** The heartbeat: every 30 s while working or waiting, every 2 min while idle. */
function setBeat($: Engine, mode: 'active' | 'idle' | 'off'): void {
  if (beat !== null && beat.mode === mode) return
  beat?.timer.cancel()
  beat = null
  if (mode === 'off' || !isOn) return
  const ms = mode === 'active' ? L.ACTIVE_BEAT_MS : L.IDLE_BEAT_MS
  beat = { mode, timer: $.clock.every(ms, () => void pulse($)) }
}

async function pulse($: Engine): Promise<void> {
  try {
    await current($)
    const now = await $.clock.now()
    await refreshHelpers($, now)
    await requestWrite($)
    await readOthers($, now)
  } catch {
    // the next pulse tries again
  }
}

/** The pane's refresh: every 2 s while it is drawn, a slow check while it waits undrawn. */
function startRefresh($: Engine, ms: number = L.REFRESH_MS): void {
  if (refresh !== null && refresh.ms === ms) return
  refresh?.timer.cancel()
  refresh = { ms, timer: $.clock.every(ms, () => void tick($)) }
}

function stopRefresh(): void {
  refresh?.timer.cancel()
  refresh = null
}

async function tick($: Engine): Promise<void> {
  try {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane === undefined) {
      stopRefresh()
      return
    }
    // a pane waiting for room is only checked now and then until it is seated
    if (!pane.isPlaced) {
      startRefresh($, L.UNPLACED_POLL_MS)
      return
    }
    startRefresh($, L.REFRESH_MS)
    // a tab behind another needs no reads yet
    if (pane.isShown) await snapshotNow($)
  } catch {
    // the next tick tries again
  }
}

// ------------------------------------------------------------ reading others

/** Every other session's beat that is not dropped. */
async function readBeats($: Engine, now: number): Promise<{ beats: SessionBoardBeat[]; stale: string[] }> {
  if (home === '') return { beats: [], stale: [] }
  const dir = L.sessionsDir(home)
  let entries: FsEntry[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return { beats: [], stale: [] }
  }
  const selfId = me?.id ?? ''
  const picked = L.pickBeatFiles(entries, now, selfId)
  const stale = [...picked.stale]
  const read = await Promise.all(
    picked.fresh.map(async name => {
      try {
        const one = L.parseBeat(await $.fs.read(`${dir}/${name}`))
        if (one === null) return null
        if (L.liveness(one, now) === 'dropped') {
          stale.push(name)
          return null
        }
        return one.id === selfId ? null : one
      } catch {
        return null
      }
    }),
  )
  return { beats: read.filter((one): one is SessionBoardBeat => one !== null), stale }
}

/** Reads the others, keeps them for a moment, and updates the status line. */
async function readOthers($: Engine, now: number): Promise<SessionBoardBeat[]> {
  const { beats } = await readBeats($, now)
  others = { at: now, beats }
  showStatus($, isOn ? L.statusText(beats, me?.id ?? '', now) : undefined)
  return beats
}

/** The others as read within `maxAgeMs`, else read again. */
async function othersFresh($: Engine, now: number, maxAgeMs: number): Promise<SessionBoardBeat[]> {
  if (others !== null && now - others.at <= maxAgeMs && now >= others.at) return others.beats
  return readOthers($, now)
}

function showStatus($: Engine, text: string | undefined): void {
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

/** This session's helpers from `$.agent.list()` joined with the Agent calls it saw. */
async function refreshHelpers($: Engine, now: number): Promise<SessionBoardHelper[]> {
  if (me === null) return []
  let listed: L.AgentLike[] | null = null
  try {
    listed = (await $.agent.list()).map(one => ({ id: one.id, description: one.description, status: one.status }))
  } catch {
    listed = null
  }
  if (me === null) return []
  const merged = L.mergeHelpers(me.helpers, listed, now, activity)
  for (const id of activity.keys()) if (!merged.some(one => one.id === id)) activity.delete(id)
  if (!L.sameHelpers(merged, me.helpers)) {
    me = { ...me, helpers: merged }
    void mirror($)
  }
  return merged
}

/** Reads everything the pane draws into one snapshot in $.state. */
async function snapshotNow($: Engine): Promise<SessionBoardSnapshot> {
  await ready($)
  const now = await $.clock.now()
  const beats = await readOthers($, now)
  const helpers = await refreshHelpers($, now)
  const self = me
  const snapshot: SessionBoardSnapshot = {
    now,
    selfId: self?.id ?? '',
    selfRoot: self?.root ?? '',
    beats: self !== null ? [{ ...self, lastBeat: now }, ...beats] : beats,
    helpers,
    hasHome: home !== '',
  }
  await $.state.set(SNAPSHOT, snapshot)
  return snapshot
}

// ------------------------------------------------------------ actions

async function openPane($: Engine): Promise<void> {
  try {
    const snapshot = await snapshotNow($)
    const opened = await $.ui.open({ id: PANE, title: 'Sessions' })
    if (!opened.isPlaced) {
      $.ui.toast('The session board is waiting for room: widen the terminal to see it.')
      for (const text of L.summaryLines(snapshot.beats, snapshot.selfId, snapshot.now)) $.ui.log(text)
    }
    startRefresh($, opened.isPlaced ? L.REFRESH_MS : L.UNPLACED_POLL_MS)
  } catch {
    $.ui.toast('The session board could not open.')
  }
}

async function setOn($: Engine, value: boolean): Promise<void> {
  try {
    await ready($)
    isOn = value
    await $.store.set('isOn', value)
    await $.state.set(IS_ON, value)
    if (!value) {
      setBeat($, 'off')
      trailing?.cancel()
      trailing = null
      showStatus($, undefined)
      if (me !== null) await removeBeat($, me.id)
      return
    }
    lastWriteAt = Number.NEGATIVE_INFINITY
    setBeat($, inTurn ? 'active' : 'idle')
    await requestWrite($)
    await readOthers($, await $.clock.now())
  } catch {
    $.ui.toast('Session board could not switch. Try /sessions again.')
  }
}

async function copyResume($: Engine, row: BoardRow, surface: RenderSurface): Promise<void> {
  const text = L.resumeCommand(row, me?.root ?? '')
  let isCopied = false
  try {
    isCopied = (await $.ui.copy({ text, surface })).isCopied
  } catch {
    isCopied = false
  }
  const at = await $.clock.now()
  await $.state.set(NOTE, {
    text: isCopied ? `Copied the resume command for ${row.project}.` : `Could not copy here. Run: ${text}`,
    at,
    isGood: isCopied,
  })
}

/** Toasts a conflict once per file per session (a /clear is a new session). */
async function toastOnce($: Engine, conflict: L.Conflict, selfId: string, now: number): Promise<void> {
  const key = L.toastKey(selfId, conflict.path)
  const done = (await $.state.get(TOASTED)).value ?? []
  if (done.includes(key)) return
  await $.state.set(TOASTED, [...done, key].slice(-200))
  $.ui.toast(L.conflictToast(conflict, now))
}

/** Takes a finished call off the in-flight lists; true when it was one of the calls holding the waiting state. */
function endCall(id: string): boolean {
  inFlight = inFlight.filter(one => one !== id)
  asking.delete(id)
  return blockers.delete(id)
}

/** Once a blocked call has finished: back from waiting when none is left, else the reason of one still open. */
async function afterBlocked($: Engine): Promise<void> {
  try {
    const now = await $.clock.now()
    if (me?.state === 'waiting') apply($, L.afterBlocked([...blockers.values()], inTurn ? 'working' : 'idle'), now)
  } catch {
    // the next tool call or turn end corrects it
  }
}

// ------------------------------------------------------------ hooks

export const register: Register = on => {
  resetModule()

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'sessions',
        description: 'Every Claude Code session on this computer; /sessions off|on',
        argumentHint: '[off|on]',
        immediate: true,
      })
    } catch {
      // the rest still runs
    }
    void (async () => {
      try {
        await ready($)
        const now = await $.clock.now()
        const { stale } = await readBeats($, now)
        await sweep($, stale)
        if (isOn) {
          setBeat($, inTurn ? 'active' : 'idle')
          await requestWrite($)
          await readOthers($, now)
        }
        const panes = await $.ui.panes()
        if (panes.some(pane => pane.id === PANE)) {
          await snapshotNow($)
          startRefresh($)
        }
      } catch {
        // a quiet start; the next turn tries again
      }
    })()
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!L.isPersonOrigin(e.origin)) return next(e)
    const self = await current($)
    if (self === null) return next(e)
    const title = L.titleFrom(e.text)
    if (title !== null && self.title === L.NEW_TITLE) {
      me = { ...self, title }
      void mirror($)
      void requestWrite($)
    }
    if (!isOn || L.isSlashCommand(e.text)) return next(e)
    const now = await $.clock.now()
    const beats = await othersFresh($, now, 15 * L.SECOND)
    const note = L.sameFolderContext(beats, self.id, self.root, now)
    if (note === null || !L.shouldAttachNote(note, self.id, lastNote, now)) return next(e)
    const sent = await next({ ...e, context: [...(e.context ?? []), note] })
    // a prompt dropped beneath (held to be sent again) never reached the model
    if (sent.drop === undefined) lastNote = { id: self.id, text: note, at: now }
    return sent
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    try {
      const self = await current($)
      if (self !== null) {
        inTurn = true
        apply($, { kind: 'turn-start' }, await $.clock.now())
        setBeat($, 'active')
        // off means no heartbeat, so no branch to read for one
        if (isOn) void (async () => {
          const [branch, model] = await Promise.all([gitBranch($, self.root), sessionModel($)])
          if (me !== null && (me.branch !== branch || me.model !== model)) {
            me = { ...me, branch, model }
            void mirror($)
            await requestWrite($)
          }
        })().catch(() => undefined)
      }
    } catch {
      // never hold the turn
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const id = typeof e.tool_use_id === 'string' && e.tool_use_id !== '' ? e.tool_use_id : `seq:${++seq}`
    inFlight = [...inFlight, id]
    const input = e as unknown as Readonly<Record<string, unknown>>
    let conflict: L.Conflict | null = null
    let selfId = ''
    let edited: string | null = null
    let agentCard = ''
    let startedAt = 0
    try {
      await ready($)
      startedAt = await $.clock.now()
      if (tool === 'AskUserQuestion') {
        apply($, { kind: 'ask' }, startedAt)
        blockers.set(id, L.ASKED)
      } else if (e.agentId === undefined) {
        // a call the person still has to answer (a helper's, or one beside this) keeps the waiting state
        if (me?.state !== 'waiting' || blockers.size === 0) apply($, { kind: 'tool', step: L.stepFor(tool, input) }, startedAt)
      } else if (me !== null && me.helpers.some(one => one.id === e.agentId && one.isUnlisted === true)) {
        activity.set(e.agentId, startedAt)
      }
      if (e.tool === 'Agent' && me !== null) {
        agentCard = `call:${e.tool_use_id}`
        me = { ...me, helpers: [...me.helpers, L.helperStarting(agentCard, e.description, startedAt)] }
        void mirror($)
      }
      const file = L.editedPath(tool, input)
      if (file !== null && me !== null) {
        selfId = me.id
        // only files inside the project are shared or compared
        edited = L.pathInRoot(file, me.root)
        if (edited !== null && isOn) {
          const beats = await othersFresh($, startedAt, 5 * L.SECOND)
          conflict = L.conflictFor(beats, me.id, me.root, edited, startedAt)
        }
      }
    } catch {
      // the call goes on whatever happened here
    }

    const ran = await next(e).catch((error: unknown) => {
      if (endCall(id)) void afterBlocked($)
      throw error
    })
    // only a blocked call finishing changes the waiting, not an earlier call still running beside it
    if (endCall(id)) await afterBlocked($)

    try {
      const now = await $.clock.now()
      if (agentCard !== '' && me !== null) {
        me = { ...me, helpers: L.settleAgentCall(me.helpers, agentCard, ran, now) }
        void mirror($)
      }
      if (edited !== null && me !== null && me.id === selfId && ran.deny === undefined && ran.isError !== true) {
        me = { ...me, edits: L.addEdit(me.edits, edited, now) }
        void mirror($)
        void requestWrite($)
      }
      if (conflict !== null && ran.deny === undefined) {
        void toastOnce($, conflict, selfId, now)
        return { ...ran, context: [...(ran.context ?? []), L.conflictNote(conflict, now)] }
      }
    } catch {
      // the result stands as the tool gave it
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Watches the permission verdict only: a call put to the person is the one a
  // permission prompt holds up. It never changes the verdict.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    if (verdict.decision === 'ask' && id !== undefined && inFlight.includes(id)) asking.add(id)
    return verdict
  }).catch(($, e, next) => next(e))

  // Watches spawns only: the Agent call's card takes the agent's id, and a
  // workflow's agent, which no agent list names, gets a card of its own.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    if (agentId !== undefined && started.deny === undefined) {
      const spawn = {
        agentId,
        callId: e.workflow === undefined ? `call:${e.tool_use_id}` : null,
        description: e.description,
        isUnlisted: e.workflow !== undefined,
      }
      void (async () => {
        try {
          await ready($)
          const now = await $.clock.now()
          if (me === null) return
          me = { ...me, helpers: L.helperSpawned(me.helpers, spawn, now) }
          void mirror($)
          if (spawn.isUnlisted) void requestWrite($)
        } catch {
          // the agent list fills in what it can
        }
      })()
    }
    return started
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    try {
      await ready($)
      const now = await $.clock.now()
      apply($, { kind: 'notification', type: e.notification_type, message: e.message }, now)
      const reason = L.reasonForNotification(e.notification_type, e.message)
      if (me?.state === 'waiting' && reason !== null) {
        // a call already holding the waiting state (a question) keeps its own reason
        for (const id of L.blockersFor([...asking], inFlight)) if (!blockers.has(id)) blockers.set(id, reason)
      }
    } catch {
      // a notification is only a hint here
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await ready($)
        inTurn = false
        apply($, { kind: 'turn-complete' }, await $.clock.now())
        setBeat($, 'idle')
        if (isOn) void readOthers($, await $.clock.now()).catch(() => undefined)
      } catch {
        // the idle heartbeat corrects it
      }
    } else {
      // a helper's answer: a workflow agent, which no agent list names, ends here
      const agentId = e.agentId
      activity.delete(agentId)
      try {
        await ready($)
        const now = await $.clock.now()
        if (me !== null) {
          const helpers = L.helperFinished(me.helpers, agentId, e.reason, now)
          if (!L.sameHelpers(helpers, me.helpers)) {
            me = { ...me, helpers }
            void mirror($)
            void requestWrite($)
          }
        }
      } catch {
        // the quiet rule ends it later
      }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      await ready($)
      trailing?.cancel()
      trailing = null
      await removeBeat($, e.sessionId)
      if (e.reason === 'clear' || e.reason === 'resume') {
        clearedId = e.sessionId
        me = null
        inTurn = false
        blockers.clear()
        lastNote = null
        lastWriteAt = Number.NEGATIVE_INFINITY
        await $.state.set(SELF, null)
      } else {
        setBeat($, 'off')
        stopRefresh()
        showStatus($, undefined)
      }
    } catch {
      // exits stay fast
    }
    return next(e)
  })

  on('command.run', { command: 'sessions' }, ($, e) => {
    try {
      const arg = e.args.trim().toLowerCase()
      if (arg === 'off') {
        void setOn($, false)
        return { text: 'Session board is off: no heartbeat, status line or same-folder notes from this session.' }
      }
      if (arg === 'on') {
        void setOn($, true)
        return { text: 'Session board is on.' }
      }
      if (arg !== '') return { text: 'Use /sessions to open the board, or /sessions off or /sessions on.' }
      void openPane($)
      return { text: 'Opening the session board.' }
    } catch {
      return { text: FAILED }
    }
  }).catch(() => ({ text: FAILED }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const snapshot = (await $.state.get(SNAPSHOT)).value ?? null
    const note = (await $.state.get(NOTE)).value ?? null
    const isShownOn = (await $.state.get(IS_ON)).value ?? true
    return drawBoard(kit, {
      columns: e.props.bodyColumns,
      snapshot,
      note,
      isOn: isShownOn,
      onResume: (row, surface) => void copyResume($, row, surface),
    })
  })
}
