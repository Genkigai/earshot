// session-board through the engine: heartbeats, notes, the status line, the pane.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

import type { SessionBoardBeat } from '../types'
import { EMPTY_TEXT, NO_HELPERS, NO_HOME_TEXT } from '../hooks/view'

const START = 1_760_000_000_000
const MINUTE = 60_000
const HOME = '/home/dev'
const ROOT = '/home/dev/earshot'
const DIR = `${HOME}/.claude/mod-data/session-board/sessions`
const SELF = 'self-1'
const PANE = { component: 'Pane', requestId: 'session-board' } as const

type World = {
  clock: MockClock
  files: Map<string, { text: string; mtimeMs: number }>
  writes: { path: string; text: string }[]
  runs: string[][]
  status: (string | undefined)[]
  toasts: string[]
  logs: string[]
  copies: string[]
  contexts: (readonly string[] | undefined)[]
  agents: AgentInfo[]
  sessionId: string
  isPlaced: boolean
  panes: string[]
  /** Runs inside each tool call, beneath the plugin, before it answers. */
  during: ((call: { tool: string; id: string }) => Promise<void>) | null
  /** fs.list calls: one per read of the other sessions. */
  lists: number
  /** ui.panes calls. */
  paneChecks: number
  /** The id agent.spawn answers. */
  nextAgentId: string
  /** Whether the next prompt is dropped beneath (held, as prompt-upgrade does). */
  dropNext: boolean
}

/** Stands for the engine beneath the plugin: files in memory, a clock that moves when told. */
function world(on: On, options: { home?: string } = {}): World {
  const w: World = {
    clock: mock.clock(on, { now: START }),
    files: new Map(),
    writes: [],
    runs: [],
    status: [],
    toasts: [],
    logs: [],
    copies: [],
    contexts: [],
    agents: [],
    sessionId: SELF,
    isPlaced: true,
    panes: [],
    during: null,
    lists: 0,
    paneChecks: 0,
    nextAgentId: 'a1',
    dropNext: false,
  }
  mock.store(on)
  mock.env(on, { HOME: options.home ?? HOME })
  on('session.id', () => ({ value: w.sessionId }))
  on('session.root', () => ({ value: ROOT }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Notification', () => ({}))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: w.agents }))
  on('fs.list', ($, e) => {
    w.lists += 1
    if (e.path !== DIR) return { deny: `ENOENT: ${e.path}` }
    const entries = [...w.files.entries()]
      .filter(([path]) => path.startsWith(`${DIR}/`))
      .map(([path, file]) => ({
        name: path.slice(DIR.length + 1),
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      }))
    return { value: entries }
  })
  on('fs.read', ($, e) => {
    const file = w.files.get(e.path)
    return file !== undefined ? { value: file.text } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.write', ($, e) => {
    w.writes.push({ path: e.path, text: e.text })
    w.files.set(e.path, { text: e.text, mtimeMs: w.clock.now() })
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    if (argv[0] === 'rm') for (const path of argv.slice(2)) w.files.delete(path)
    const stdout = argv[0] === 'git' ? 'main\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', ($, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    w.copies.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.open', ($, e) => {
    if (!w.panes.includes(e.id)) w.panes.push(e.id)
    return { value: w.isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'too narrow' } }
  })
  on('ui.panes', () => {
    w.paneChecks += 1
    return { value: w.panes.map(id => ({ id, title: 'Sessions', isShown: true, isFocused: false, isPlaced: w.isPlaced })) }
  })
  on('prompt.submit', ($, e) => {
    w.contexts.push(e.context)
    if (w.dropNext) {
      w.dropNext = false
      return { drop: 'held to be sent again' }
    }
    return { text: e.text }
  })
  on('tool.check', ($, e) => ({ decision: e.tool === 'WebFetch' ? ('ask' as const) : ('allow' as const) }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: w.nextAgentId }))
  on('tool.call', async ($, e) => {
    await w.during?.({ tool: String(e.tool), id: e.tool_use_id })
    if (e.tool === 'Agent') {
      return {
        result: { status: 'async_launched', agentId: 'a1', description: e.description, prompt: e.prompt, outputFile: '/tmp/a1' },
        text: 'launched',
      } as never
    }
    return { result: {} as never, text: 'ok' }
  })
  return w
}

/** Another session's heartbeat file, as that session would have written it. */
function otherBeat(w: World, over: Partial<SessionBoardBeat>): SessionBoardBeat {
  const now = w.clock.now()
  const beat: SessionBoardBeat = {
    v: 1,
    id: 'other-1',
    root: ROOT,
    project: 'earshot',
    branch: 'fix/login',
    title: 'Fix login bug',
    state: 'working',
    currentStep: 'Bash npm test',
    startedAt: now - 30 * MINUTE,
    stateSince: now - 4 * MINUTE,
    lastBeat: now - 10_000,
    edits: [],
    helpers: [],
    model: 'claude-opus-5-5',
    ...over,
  }
  w.files.set(`${DIR}/${beat.id}.json`, { text: JSON.stringify(beat), mtimeMs: beat.lastBeat })
  return beat
}

async function start($: Engine, w: World): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

function command($: Engine, args = '') {
  return $.command.run({ command: 'sessions', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
}

function prompt($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

function turnStart($: Engine, id = 't1') {
  return $.turn.start({ text: 'go', turnId: id })
}

function turnEnd($: Engine, id = 't1') {
  return $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' })
}

function edit($: Engine, file: string) {
  return $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: 'a', new_string: 'b' })
}

/** The last heartbeat this session wrote. */
function lastOwn(w: World, id = SELF): SessionBoardBeat {
  const own = w.writes.filter(one => one.path === `${DIR}/${id}.json`)
  const last = own.at(-1)
  if (last === undefined) throw new Error('no heartbeat written')
  return JSON.parse(last.text) as SessionBoardBeat
}

function paneProps(columns: number) {
  return {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: columns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  } as never
}

async function textsFit(ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }, columns: number) {
  const all = await ui.findAll({ type: 'Text' })
  expect(all.length).toBeGreaterThan(0)
  for (const one of all) {
    expect(Array.from(one.text).length, `"${one.text}" is wider than ${columns}`).toBeLessThanOrEqual(columns)
  }
}

test('state machine through the hooks: working, waiting on a permission prompt, working, idle', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(lastOwn(w).state).toBe('idle')

  await w.clock.advance(5_000)
  await turnStart($)
  expect(lastOwn(w).state).toBe('working')
  expect(lastOwn(w).currentStep).toBe('Thinking')
  expect(lastOwn(w).branch).toBe('main')

  await w.clock.advance(5_000)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  expect(lastOwn(w).state).toBe('waiting')
  expect(lastOwn(w).waitingReason).toBe('needs your OK to run a command')

  await w.clock.advance(5_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(lastOwn(w).state).toBe('working')
  expect(lastOwn(w).currentStep).toBe('Bash npm test')

  await w.clock.advance(5_000)
  await turnEnd($)
  expect(lastOwn(w).state).toBe('idle')
  expect(lastOwn(w).currentStep).toBeUndefined()
})

test('a question to the person is waiting until the answer comes back', async ($, on) => {
  const w = world(on)
  let during: SessionBoardBeat | undefined
  await start($, w)
  await w.clock.advance(5_000)
  await turnStart($)
  await w.clock.advance(5_000)
  w.during = async () => {
    await w.clock.settle()
    during = lastOwn(w)
  }
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
  })
  w.during = null
  expect(during?.state).toBe('waiting')
  expect(during?.waitingReason).toBe('asked you a question')
  await w.clock.advance(3_000)
  expect(lastOwn(w).state).toBe('working')
})

test('title comes from the first real prompt, slash commands skipped', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(lastOwn(w).title).toBe('New session')
  await prompt($, '/compact')
  await w.clock.advance(5_000)
  await prompt($, 'Fix the login redirect loop that happens after the session token expires')
  await w.clock.advance(5_000)
  expect(lastOwn(w).title).toBe('Fix the login redirect loop that…')
  await prompt($, 'Now something else entirely')
  await w.clock.advance(5_000)
  expect(lastOwn(w).title).toBe('Fix the login redirect loop that…')
})

test('heartbeat is written on a state change and throttled to one write per 3 s', async ($, on) => {
  const w = world(on)
  await start($, w)
  const own = () => w.writes.filter(one => one.path === `${DIR}/${SELF}.json`)
  expect(own()).toHaveLength(1)
  const first = lastOwn(w)
  expect(first).toMatchObject({ v: 1, id: SELF, root: ROOT, project: 'earshot', branch: 'main', state: 'idle', model: 'claude-opus-5-5' })

  await w.clock.advance(5_000)
  await turnStart($)
  expect(own()).toHaveLength(2)

  await w.clock.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await w.clock.advance(500)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/app.js` })
  expect(own()).toHaveLength(2)

  await w.clock.advance(1_500)
  expect(own()).toHaveLength(3)
  expect(lastOwn(w)).toMatchObject({ state: 'working', currentStep: 'Read app.js', lastBeat: START + 8_000 })

  // the 30 s heartbeat while working
  await w.clock.advance(30_000)
  expect(own().length).toBeGreaterThanOrEqual(4)
  expect(lastOwn(w).lastBeat).toBeGreaterThanOrEqual(START + 35_000)
})

test('own edits are recorded relative to the root', async ($, on) => {
  const w = world(on)
  await start($, w)
  await turnStart($)
  await w.clock.advance(4_000)
  await edit($, 'src/app.ts')
  await w.clock.advance(4_000)
  expect(lastOwn(w).edits).toEqual([{ path: 'src/app.ts', at: START + 4_000 }])
})

test('same-folder context is added only when another alive session shares the root', async ($, on) => {
  const w = world(on)
  await start($, w)
  await prompt($, 'Hello there')
  expect(w.contexts.at(-1)).toBeUndefined()

  otherBeat(w, {
    edits: [
      { path: 'a.js', at: START - 2 * MINUTE },
      { path: 'src/b.ts', at: START - MINUTE },
    ],
  })
  await w.clock.advance(20_000)
  await prompt($, 'Refactor the auth module')
  const context = w.contexts.at(-1)
  expect(context).toHaveLength(1)
  expect(context?.[0]).toBe(
    'Another Claude Code session is working in this same project: "Fix login bug" (working, fix/login). ' +
      'In the last 30 minutes it edited: src/b.ts, a.js. Avoid editing those files unless the person asks; ' +
      'if you must, re-read them first because they may have changed.',
  )

  otherBeat(w, { root: '/home/dev/elsewhere', edits: [{ path: 'a.js', at: START }] })
  await w.clock.advance(20_000)
  await prompt($, 'And now?')
  expect(w.contexts.at(-1)).toBeUndefined()
})

test('an Edit of a file the other session edited 3 minutes ago gets a note and one toast', async ($, on) => {
  const w = world(on)
  otherBeat(w, { edits: [{ path: 'src/app.ts', at: START - 3 * MINUTE }] })
  await start($, w)
  await turnStart($)

  const first = await edit($, 'src/app.ts')
  expect(first.context).toEqual(['Note: session "Fix login bug" edited this file 3 minutes ago.'])
  expect(w.toasts).toEqual(['Heads up: the other session in earshot edited src/app.ts 3m ago.'])

  const again = await edit($, 'src/app.ts')
  expect(again.context).toEqual(['Note: session "Fix login bug" edited this file 3 minutes ago.'])
  expect(w.toasts).toHaveLength(1)

  const elsewhere = await edit($, 'src/other.ts')
  expect(elsewhere.context).toBeUndefined()
  expect(w.toasts).toHaveLength(1)
})

test('status line counts the other live sessions and clears when none are left', async ($, on) => {
  const w = world(on)
  otherBeat(w, { id: 'w1', state: 'waiting', waitingReason: 'needs your OK to run a command' })
  otherBeat(w, { id: 'k1', state: 'working' })
  otherBeat(w, { id: 'k2', state: 'working', lastBeat: START - 20 * MINUTE })
  otherBeat(w, { id: 'd1', state: 'idle' })
  await start($, w)
  expect(w.status.at(-1)).toBe('◆ 1 waiting · 1 working')

  for (const id of ['w1', 'k1', 'k2', 'd1']) w.files.delete(`${DIR}/${id}.json`)
  await w.clock.advance(2 * MINUTE)
  expect(w.status.at(-1)).toBeUndefined()
})

test('pane: empty state on terminal and desktop, narrow and wide', async ($, on) => {
  const w = world(on)
  await start($, w)
  const answer = await command($)
  expect(answer.text).toBe('Opening the session board.')
  await w.clock.settle()
  expect(w.panes).toEqual(['session-board'])
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const columns of [16, 36, 120]) {
      const ui = await $.ui.mount({ plugin: 'session-board', surface, ...PANE, props: paneProps(columns) })
      expect(await ui.find({ text: /S E S S I O N S/ })).toBeDefined()
      if (columns >= 36) {
        expect(await ui.find({ text: /Only this session is running/ })).toBeDefined()
        expect(await ui.find({ text: NO_HELPERS })).toBeDefined()
      }
      await textsFit(ui, columns)
      await ui.unmount()
    }
  }
  expect(EMPTY_TEXT).toContain('Other Claude Code sessions on this computer show up here.')
})

test('pane: every section and helper cards fit on terminal and desktop, narrow and wide', async ($, on) => {
  const w = world(on)
  otherBeat(w, { id: 'w1', project: 'api', root: '/home/dev/api', state: 'waiting', waitingReason: 'needs your OK to run a command', stateSince: START - 72_000 })
  otherBeat(w, { id: 'k1', state: 'working', title: 'Refactor the payment flow and its very long tests' })
  otherBeat(w, { id: 'd1', project: 'docs', root: '/home/dev/docs', state: 'idle', stateSince: START - 4 * MINUTE })
  otherBeat(w, { id: 'q1', project: 'old', root: '/home/dev/old', state: 'working', lastBeat: START - 12 * MINUTE })
  w.agents = [
    { id: 'a2', description: 'Read the docs', type: 'Explore', status: 'completed' },
    { id: 'a3', description: 'Lint everything', type: 'general-purpose', status: 'pending' },
  ]
  await start($, w)
  await turnStart($)
  await $.tool.call({ tool: 'Agent', description: 'Fix tests', prompt: 'Fix the failing tests.' })
  w.agents = [{ id: 'a1', description: 'Fix tests', type: 'general-purpose', status: 'running' }, ...w.agents]
  await command($)
  await w.clock.advance(2_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const columns of [16, 36, 120]) {
      const ui = await $.ui.mount({ plugin: 'session-board', surface, ...PANE, props: paneProps(columns) })
      if (columns < 36) {
        // a very narrow dock: everything is cut to the width, nothing spills
        expect(await ui.find({ text: /‖ api/ }), `${surface} ${columns}`).toBeDefined()
        await textsFit(ui, columns)
        await ui.unmount()
        continue
      }
      expect(await ui.find({ text: columns > 40 ? '4 running · 1 waiting' : '1 waiting' }), `${surface} ${columns}: ` + String(columns > 40 ? '4 running · 1 waiting' : '1 waiting')).toBeDefined()
      expect(await ui.find({ text: /‖ api/ }), `${surface} ${columns}: ` + String(/‖ api/)).toBeDefined()
      expect(await ui.find({ text: /▶ earshot/ }), `${surface} ${columns}: ` + String(/▶ earshot/)).toBeDefined()
      expect(await ui.find({ text: /\(this one\)/ }), `${surface} ${columns}: ` + String(/\(this one\)/)).toBeDefined()
      expect(await ui.find({ text: /✓ docs/ }), `${surface} ${columns}: ` + String(/✓ docs/)).toBeDefined()
      expect(await ui.find({ text: /· old/ }), `${surface} ${columns}: ` + String(/· old/)).toBeDefined()
      expect(await ui.find({ text: /● Fix tests/ }), `${surface} ${columns}: ` + String(/● Fix tests/)).toBeDefined()
      expect(await ui.find({ text: /✓ Read the/ }), `${surface} ${columns}: ` + String(/✓ Read the/)).toBeDefined()
      await textsFit(ui, columns)
      await ui.unmount()
    }
  }
})

test('pressing another session copies its resume command and says so in the pane', async ($, on) => {
  const w = world(on)
  otherBeat(w, { id: 'k1' })
  otherBeat(w, { id: 'd1', project: 'docs', root: '/home/dev/docs', state: 'idle' })
  await start($, w)
  await command($)
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', ...PANE, props: paneProps(80) })
  await ui.press({ key: 's:k1' })
  expect(w.copies).toEqual(['claude --resume k1'])
  expect(await ui.find({ text: 'Copied the resume command for earshot.' })).toBeDefined()
  await ui.press({ key: 's:d1' })
  expect(w.copies.at(-1)).toBe('cd /home/dev/docs && claude --resume d1')
  expect(w.toasts).toEqual([])
  await ui.unmount()
})

test('the pane refreshes every 2 s while open and stops once it is closed', async ($, on) => {
  const w = world(on)
  await start($, w)
  await command($)
  await w.clock.settle()
  otherBeat(w, { id: 'k1' })
  const listsOpen = w.lists
  await w.clock.advance(2_000)
  // each refresh reads the folder again
  expect(w.lists).toBeGreaterThan(listsOpen)
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', ...PANE, props: paneProps(80) })
  expect(await ui.find({ text: /▶ earshot · fix\/login/ })).toBeDefined()
  await ui.unmount()
  w.panes = []
  await w.clock.advance(2_000)
  const lists = w.lists
  const checks = w.paneChecks
  await w.clock.advance(10_000)
  // closed: no more folder reads, and the timer itself is gone
  expect(w.lists).toBe(lists)
  expect(w.paneChecks).toBe(checks)
})

test('a pane with no room says so and logs a summary instead', async ($, on) => {
  const w = world(on)
  w.isPlaced = false
  otherBeat(w, { id: 'k1' })
  await start($, w)
  await command($)
  await w.clock.settle()
  expect(w.toasts).toEqual(['The session board is waiting for room: widen the terminal to see it.'])
  expect(w.logs[0]).toBe('Sessions: 2 running')
  expect(w.logs.some(text => text.includes('▶ earshot · fix/login · Fix login bug'))).toBe(true)
})

test('/sessions off stops heartbeats, status and notes; /sessions on brings them back', async ($, on) => {
  const w = world(on)
  otherBeat(w, { id: 'k1', edits: [{ path: 'a.js', at: START }] })
  await start($, w)
  expect(w.status.at(-1)).toBe('◆ 1 working')

  const off = await command($, 'off')
  expect(off.text).toContain('Session board is off')
  await w.clock.settle()
  expect(w.runs).toContainEqual(['rm', '-f', `${DIR}/${SELF}.json`])
  expect(w.files.has(`${DIR}/${SELF}.json`)).toBe(false)
  expect(w.status.at(-1)).toBeUndefined()

  const writes = w.writes.length
  await w.clock.advance(5_000)
  await turnStart($)
  await prompt($, 'Edit a.js please')
  expect(w.contexts.at(-1)).toBeUndefined()
  await w.clock.advance(10 * MINUTE)
  expect(w.writes.length).toBe(writes)

  const back = await command($, 'on')
  expect(back.text).toBe('Session board is on.')
  await w.clock.settle()
  expect(w.files.has(`${DIR}/${SELF}.json`)).toBe(true)

  const odd = await command($, 'sideways')
  expect(odd.text).toContain('/sessions off')
})

test('session end removes the heartbeat file; a /clear starts a new one', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(w.files.has(`${DIR}/${SELF}.json`)).toBe(true)

  await $.session.end({ reason: 'clear', sessionId: SELF, resume: { id: SELF } })
  expect(w.files.has(`${DIR}/${SELF}.json`)).toBe(false)

  w.sessionId = 'self-2'
  await w.clock.advance(5_000)
  await turnStart($, 't2')
  expect(lastOwn(w, 'self-2')).toMatchObject({ id: 'self-2', title: 'New session', state: 'working' })

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'self-2', resume: { id: 'self-2' } })
  expect(w.files.has(`${DIR}/self-2.json`)).toBe(false)
})

test('heartbeat files older than a day are removed at session start', async ($, on) => {
  const w = world(on)
  otherBeat(w, { id: 'ancient', lastBeat: START - 25 * 60 * MINUTE })
  otherBeat(w, { id: 'fresh' })
  w.files.set(`${DIR}/broken.json`, { text: '{not json', mtimeMs: START })
  await start($, w)
  expect(w.files.has(`${DIR}/ancient.json`)).toBe(false)
  expect(w.files.has(`${DIR}/fresh.json`)).toBe(true)
  expect(w.status.at(-1)).toBe('◆ 1 working')
})

const PERMISSION = (tool: string) =>
  ({ message: `Claude needs your permission to use ${tool}`, notification_type: 'permission_prompt' }) as const

test('waiting stays up while the blocked call waits, even when an earlier call beside it finishes', async ($, on) => {
  const w = world(on)
  await start($, w)
  await w.clock.advance(5_000)
  await turnStart($)
  w.during = async call => {
    // the slow call that started first, then the one a permission prompt holds up
    if (call.tool === 'Bash') await w.clock.sleep(10_000)
    if (call.tool === 'WebFetch') {
      await $.classic.Notification(PERMISSION('WebFetch'))
      await w.clock.sleep(30_000)
    }
  }
  const slow = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await w.clock.settle()
  const blocked = $.tool.call({ tool: 'WebFetch', url: 'https://example.com/a', prompt: 'read it' })
  await w.clock.advance(4_000)
  expect(lastOwn(w).state).toBe('waiting')
  await w.clock.advance(10_000)
  await slow
  // the earlier call finished; the prompt is still up
  expect(lastOwn(w).state).toBe('waiting')
  expect(lastOwn(w).waitingReason).toBe('needs your OK to use WebFetch')
  await w.clock.advance(20_000)
  await blocked
  await w.clock.advance(3_000)
  expect(lastOwn(w).state).toBe('working')
  w.during = null
})

test('the call put to the person holds the waiting state, not a newer call running beside it', async ($, on) => {
  const w = world(on)
  await start($, w)
  await w.clock.advance(5_000)
  await turnStart($)
  w.during = async call => {
    if (call.tool === 'WebFetch') {
      await w.clock.sleep(1_000)
      // the engine's verdict for this call is `ask`, then its prompt shows
      await $.tool.check({ tool: 'WebFetch', input: { url: 'https://example.com/a' }, tool_use_id: call.id })
      await $.classic.Notification(PERMISSION('WebFetch'))
      await w.clock.sleep(30_000)
    }
    if (call.tool === 'Read') await w.clock.sleep(6_000)
  }
  const asked = $.tool.call({ tool: 'WebFetch', url: 'https://example.com/a', prompt: 'read it' })
  await w.clock.settle()
  const reading = $.tool.call({ tool: 'Read', file_path: `${ROOT}/big.log` })
  await w.clock.advance(4_000)
  expect(lastOwn(w).state).toBe('waiting')
  await w.clock.advance(6_000)
  await reading
  await w.clock.advance(3_000)
  expect(lastOwn(w).state).toBe('waiting')
  await w.clock.advance(20_000)
  await asked
  await w.clock.advance(3_000)
  expect(lastOwn(w).state).toBe('working')
  w.during = null
})

test("a plugin's prompt sent as the person's own words gets the title and the same-folder note", async ($, on) => {
  const w = world(on)
  otherBeat(w, { edits: [{ path: 'a.js', at: START - MINUTE }] })
  await start($, w)
  await $.prompt.submit({ text: 'A status digest from a plugin', wait: false, origin: { kind: 'plugin', name: 'other-mod' } })
  expect(w.contexts.at(-1)).toBeUndefined()
  await w.clock.advance(5_000)
  expect(lastOwn(w).title).toBe('New session')

  await $.prompt.submit({
    text: 'Refactor the auth module so tokens refresh',
    wait: false,
    origin: { kind: 'plugin', name: 'prompt-upgrade', asUser: true },
  })
  expect(w.contexts.at(-1)?.[0]).toContain('In the last 30 minutes it edited: a.js.')
  await w.clock.advance(5_000)
  expect(lastOwn(w).title).toBe('Refactor the auth module so tokens…')
})

test('the same-folder note skips sessions with no edits and is not repeated while unchanged', async ($, on) => {
  const w = world(on)
  otherBeat(w, { edits: [] })
  await start($, w)
  await prompt($, 'Refactor the auth module')
  // working, but nothing to avoid
  expect(w.contexts.at(-1)).toBeUndefined()

  otherBeat(w, { edits: [{ path: 'a.js', at: START }] })
  await w.clock.advance(20_000)
  await prompt($, 'Next step please')
  expect(w.contexts.at(-1)?.[0]).toContain('edited: a.js.')

  await w.clock.advance(20_000)
  await prompt($, 'And another one')
  expect(w.contexts.at(-1)).toBeUndefined()

  otherBeat(w, { edits: [{ path: 'a.js', at: START }, { path: 'b.js', at: START + 30_000 }] })
  await w.clock.advance(20_000)
  await prompt($, 'Keep going')
  expect(w.contexts.at(-1)?.[0]).toContain('edited: b.js, a.js.')

  // an unchanged note goes again after ten minutes
  await w.clock.advance(11 * MINUTE)
  otherBeat(w, { edits: [{ path: 'a.js', at: START }, { path: 'b.js', at: START + 30_000 }] })
  await w.clock.advance(20_000)
  await prompt($, 'Still there?')
  expect(w.contexts.at(-1)?.[0]).toContain('edited: b.js, a.js.')
})

test('a note on a prompt dropped beneath goes again with the prompt sent in its place', async ($, on) => {
  const w = world(on)
  otherBeat(w, { edits: [{ path: 'a.js', at: START }] })
  await start($, w)
  w.dropNext = true
  await prompt($, 'Fix the flaky test')
  expect(w.contexts.at(-1)?.[0]).toContain('edited: a.js.')
  await $.prompt.submit({ text: 'Fix the flaky test in auth.spec.ts', wait: false, origin: { kind: 'plugin', name: 'prompt-upgrade', asUser: true } })
  expect(w.contexts.at(-1)?.[0]).toContain('edited: a.js.')
})

test('edits outside the project are not recorded or shared', async ($, on) => {
  const w = world(on)
  await start($, w)
  await turnStart($)
  await w.clock.advance(4_000)
  await $.tool.call({ tool: 'Write', file_path: '/home/dev/.ssh/config', content: 'Host x' })
  await edit($, 'src/app.ts')
  await w.clock.advance(4_000)
  expect(lastOwn(w).edits.map(one => one.path)).toEqual(['src/app.ts'])
})

test('a HOME that is not absolute writes nothing and the pane says why', async ($, on) => {
  const w = world(on, { home: '~' })
  otherBeat(w, { id: 'k1' })
  await start($, w)
  await turnStart($)
  await w.clock.advance(60_000)
  expect(w.writes).toEqual([])
  await command($)
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', ...PANE, props: paneProps(80) })
  expect(await ui.find({ text: NO_HOME_TEXT })).toBeDefined()
  expect(await ui.find({ text: /Only this session is running/ })).toBeUndefined()
  await ui.unmount()
})

test("a workflow's helpers show on the board while the main loop is done, and end at their own answer", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turnStart($)
  await w.clock.advance(5_000)
  await turnEnd($)
  w.nextAgentId = 'wf-agent-1'
  await $.agent.spawn({
    tool_use_id: 'workflow-call',
    prompt: 'Review the mod.',
    description: 'Review the mod',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
    workflow: { runId: 'wf_1', agentIndex: 1 },
  })
  await w.clock.advance(3_000)
  expect(lastOwn(w).helpers).toMatchObject([{ id: 'wf-agent-1', description: 'Review the mod', status: 'running', isUnlisted: true }])

  // no agent list names it: it stays running through the idle heartbeat, kept going by its tool calls
  await w.clock.advance(10 * MINUTE)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/README.md`, agentId: 'wf-agent-1' } as unknown as Parameters<Engine['tool']['call']>[0])
  await w.clock.advance(8 * MINUTE)
  expect(lastOwn(w).helpers[0]?.status).toBe('running')
  otherBeat(w, { id: 'd1', project: 'docs', root: '/home/dev/docs', state: 'idle' })
  await command($)
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', ...PANE, props: paneProps(100) })
  expect(await ui.find({ text: /▶ earshot · main · New session · 1 helper working · 18:03 \(this one\)/ })).toBeDefined()
  expect(await ui.find({ text: /● Review the mod/ })).toBeDefined()
  await ui.unmount()

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'w1', reason: 'answer', agentId: 'wf-agent-1' })
  await w.clock.advance(3_000)
  expect(lastOwn(w).helpers[0]).toMatchObject({ id: 'wf-agent-1', status: 'completed' })
})

test('a helper running in the foreground shows as one card, not two', async ($, on) => {
  const w = world(on)
  await start($, w)
  await turnStart($)
  w.during = async call => {
    if (call.tool !== 'Agent') return
    await $.agent.spawn({
      tool_use_id: call.id,
      prompt: 'Fix the failing tests.',
      description: 'Fix tests',
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    })
    w.agents = [{ id: 'a1', description: 'Fix tests', type: 'general-purpose', status: 'running' }]
    await w.clock.sleep(20_000)
  }
  const running = $.tool.call({ tool: 'Agent', description: 'Fix tests', prompt: 'Fix the failing tests.' })
  await w.clock.settle()
  await command($)
  await w.clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', ...PANE, props: paneProps(100) })
  expect(await ui.findAll({ type: 'Text', text: /Fix tests/ })).toHaveLength(1)
  await ui.unmount()
  await w.clock.advance(20_000)
  await running
  w.during = null
})

test('the heartbeat folder is made private to this user', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(w.runs).toContainEqual(['chmod', '700', DIR])
  await turnStart($)
  await w.clock.advance(5 * MINUTE)
  expect(w.runs.filter(argv => argv[0] === 'chmod')).toHaveLength(1)
})

test('a pane waiting for room is only checked now and then', async ($, on) => {
  const w = world(on)
  w.isPlaced = false
  await start($, w)
  await command($)
  await w.clock.settle()
  const checks = w.paneChecks
  await w.clock.advance(10 * MINUTE)
  expect(w.paneChecks - checks).toBeLessThanOrEqual(45)
  // once seated it refreshes every 2 s again
  w.isPlaced = true
  otherBeat(w, { id: 'k1' })
  await w.clock.advance(16_000)
  const lists = w.lists
  await w.clock.advance(4_000)
  expect(w.lists - lists).toBeGreaterThanOrEqual(2)
})

test('/sessions off reads no branch at turn start', async ($, on) => {
  const w = world(on)
  await start($, w)
  await command($, 'off')
  await w.clock.settle()
  const gits = () => w.runs.filter(argv => argv[0] === 'git').length
  const before = gits()
  for (const id of ['t1', 't2', 't3']) {
    await turnStart($, id)
    await w.clock.advance(1_000)
    await turnEnd($, id)
  }
  expect(gits()).toBe(before)
})

test('after a /clear the new session is warned again about a file the old one was warned about', async ($, on) => {
  const w = world(on)
  otherBeat(w, { edits: [{ path: 'src/app.ts', at: START - 3 * MINUTE }] })
  await start($, w)
  await turnStart($)
  await edit($, 'src/app.ts')
  expect(w.toasts).toHaveLength(1)

  await $.session.end({ reason: 'clear', sessionId: SELF, resume: { id: SELF } })
  w.sessionId = 'self-2'
  await w.clock.advance(5_000)
  await turnStart($, 't2')
  await edit($, 'src/app.ts')
  expect(w.toasts).toHaveLength(2)
})

test("a helper's permission prompt keeps the session waiting while the main loop goes on", async ($, on) => {
  const w = world(on)
  await start($, w)
  await w.clock.advance(5_000)
  await turnStart($)
  w.during = async call => {
    if (call.tool !== 'WebFetch') return
    await $.tool.check({ tool: 'WebFetch', input: { url: 'https://example.com/a' }, tool_use_id: call.id, agentId: 'h1' })
    await $.classic.Notification(PERMISSION('WebFetch'))
    await w.clock.sleep(30_000)
  }
  const helperCall = { tool: 'WebFetch', url: 'https://example.com/a', prompt: 'read it', agentId: 'h1' }
  const asked = $.tool.call(helperCall as unknown as Parameters<Engine['tool']['call']>[0])
  await w.clock.advance(4_000)
  expect(lastOwn(w).state).toBe('waiting')
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/a.ts` })
  await w.clock.advance(4_000)
  expect(lastOwn(w).state).toBe('waiting')
  await w.clock.advance(30_000)
  await asked
  await w.clock.advance(3_000)
  expect(lastOwn(w).state).toBe('working')
  w.during = null
})

const QUESTION = {
  tool: 'AskUserQuestion',
  questions: [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
} as const

/** A helper's WebFetch that a permission prompt holds up for `ms`, and a question the person answers after `questionMs`. */
function helperPromptAndQuestion($: Engine, w: World, ms: number, questionMs: number) {
  w.during = async call => {
    if (call.tool === 'AskUserQuestion') await w.clock.sleep(questionMs)
    if (call.tool !== 'WebFetch') return
    await $.tool.check({ tool: 'WebFetch', input: { url: 'https://example.com/a' }, tool_use_id: call.id, agentId: 'h1' })
    await $.classic.Notification(PERMISSION('WebFetch'))
    await w.clock.sleep(ms)
  }
  const helperCall = { tool: 'WebFetch', url: 'https://example.com/a', prompt: 'read it', agentId: 'h1' }
  return {
    fetch: () => $.tool.call(helperCall as unknown as Parameters<Engine['tool']['call']>[0]),
    ask: () => $.tool.call(QUESTION as unknown as Parameters<Engine['tool']['call']>[0]),
  }
}

test("a question answered while a helper's permission prompt is still up shows that prompt's reason", async ($, on) => {
  const w = world(on)
  await start($, w)
  await w.clock.advance(5_000)
  await turnStart($)
  const calls = helperPromptAndQuestion($, w, 30_000, 5_000)
  const fetching = calls.fetch()
  await w.clock.advance(4_000)
  expect(lastOwn(w).waitingReason).toBe('needs your OK to use WebFetch')
  const asking = calls.ask()
  await w.clock.advance(3_000)
  expect(lastOwn(w).waitingReason).toBe('asked you a question')
  // answered: the helper's prompt is still up, so its reason shows, not the question's
  await w.clock.advance(6_000)
  await asking
  expect(lastOwn(w).state).toBe('waiting')
  expect(lastOwn(w).waitingReason).toBe('needs your OK to use WebFetch')
  await w.clock.advance(20_000)
  await fetching
  await w.clock.advance(3_000)
  expect(lastOwn(w).state).toBe('working')
  expect(lastOwn(w).waitingReason).toBeUndefined()
  w.during = null
})

test("a helper's permission prompt answered while a question is still up gives the question's reason back", async ($, on) => {
  const w = world(on)
  await start($, w)
  await w.clock.advance(5_000)
  await turnStart($)
  const calls = helperPromptAndQuestion($, w, 5_000, 30_000)
  const asking = calls.ask()
  await w.clock.advance(4_000)
  expect(lastOwn(w).waitingReason).toBe('asked you a question')
  const fetching = calls.fetch()
  await w.clock.advance(3_000)
  expect(lastOwn(w).waitingReason).toBe('needs your OK to use WebFetch')
  await w.clock.advance(6_000)
  await fetching
  expect(lastOwn(w).state).toBe('waiting')
  expect(lastOwn(w).waitingReason).toBe('asked you a question')
  await w.clock.advance(20_000)
  await asking
  await w.clock.advance(3_000)
  expect(lastOwn(w).state).toBe('working')
  w.during = null
})
