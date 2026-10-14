// The mod through the engine: steps, notes, the tool, the commands, the pane.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepResult } from 'claude-code'

import { EMPTY_TEXT, NARROW } from '../hooks/view'

const ROOT = '/Users/leland/Coding/earshot'
const HOME = '/Users/leland'
const DIR = `${HOME}/.claude/mod-data/context-pilot/handoffs/Users-leland-Coding-earshot`
const PANE = { component: 'Pane', requestId: 'context-pilot' } as const
const MINUTE = 60_000

type Use = { name: string; input: unknown }

type World = {
  status: (string | undefined)[]
  writes: { path: string; text: string }[]
  fills: string[]
  submits: string[]
  toasts: string[]
  replies: TurnStepResult[]
  files: Record<string, { text: string; mtimeMs: number }>
  /** Work done while the next step streams (a tool result the engine stores early). */
  midStream: (() => Promise<void>)[]
  /** Work done while the mod reads the session's usage, after the step streamed. */
  duringUsage: (() => Promise<void>)[]
  /** How often the mod asked which panes are open. */
  paneReads: number
  /** How often the mod asked for its pane to be drawn again. */
  redraws: number
  isOpen: boolean
  /** Whether the open pane is drawn; a test flips it when the terminal widens. */
  isPlaced: boolean
}

type WorldOptions = {
  startedAt?: number
  window?: number
  /** What `$.ui.open` answers for the pane (true when unsaid). */
  isPlaced?: boolean
  /** `$.tool.register` is refused. */
  toolFails?: boolean
  /** A hook drops the prompt `$.prompt.submit` sends, with this reason. */
  dropSubmit?: string
}

/** Stands for the engine beneath the plugin: answers what the mod asks of it. */
function world(on: On, o: WorldOptions = {}): World {
  const w: World = {
    status: [],
    writes: [],
    fills: [],
    submits: [],
    toasts: [],
    replies: [],
    files: {},
    midStream: [],
    duringUsage: [],
    paneReads: 0,
    redraws: 0,
    isOpen: false,
    isPlaced: o.isPlaced ?? true,
  }
  mock.store(on)
  mock.env(on, { HOME })
  on('ui.status', ($, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.panes', () => {
    w.paneReads += 1
    const pane = { id: 'context-pilot', title: 'Context pilot', isShown: true, isFocused: false, isPlaced: w.isPlaced }
    return { value: w.isOpen ? [pane] : [] }
  })
  on('ui.invalidate', ($, e, next) => {
    w.redraws += 1
    return next(e)
  })
  on('ui.open', () => {
    w.isOpen = true
    return !w.isPlaced
      ? { value: { isPlaced: false as const, reason: 'the terminal is 90 columns; an unasked pane needs 144' } }
      : { value: { isPlaced: true as const } }
  })
  on('session.usage', async () => {
    const during = w.duringUsage.shift()
    if (during !== undefined) await during()
    return {
      value: { startedAt: o.startedAt ?? 0, context: { window: o.window ?? 200_000, percent: 38 }, rateLimits: [] },
    }
  })
  on('session.root', () => ({ value: ROOT }))
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: 'Fix tests', type: 'general-purpose', status: 'running' },
      { id: 'a2', description: 'Read the docs', type: 'Explore', status: 'running' },
    ],
  }))
  on('tool.register', () =>
    o.toolFails === true ? { deny: 'tools are off here' } : { value: { tool: 'mcp__context-pilot__save_handoff' } },
  )
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('fs.write', ($, e) => {
    w.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: w.files[e.path] !== undefined }))
  on('fs.read', ($, e) => {
    const file = w.files[e.path]
    return file !== undefined ? { value: file.text } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.stat', ($, e) => {
    const file = w.files[e.path]
    return file !== undefined
      ? { value: { kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
      : { deny: `ENOENT: ${e.path}` }
  })
  on('prompt.fill', ($, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    if (o.dropSubmit !== undefined) return { drop: o.dropSubmit }
    w.submits.push(e.text)
    return { text: e.text }
  })
  on('turn.step', async function* ($, e) {
    const reply = w.replies.shift()
    if (reply === undefined) throw new Error('no reply queued')
    const during = w.midStream.shift()
    if (during !== undefined) await during()
    return { ...reply, turnId: e.turnId, index: e.index }
  })
  return w
}

function usageAt(context: number, write = 1_000) {
  return {
    input_tokens: 0,
    output_tokens: 300,
    cache_read_input_tokens: context - write,
    cache_creation_input_tokens: write,
    model: 'claude-opus-5-5',
  }
}

/** One model request through the plugin, answered beneath with `context` tokens. */
async function step(
  $: Engine,
  w: World,
  o: { context: number; index?: number; turnId?: string; agentId?: string; toolUses?: Use[] },
): Promise<TurnStepResult> {
  w.replies.push({
    turnId: '',
    index: 0,
    answer: '',
    toolUses: o.toolUses ?? [],
    stopReason: 'tool_use',
    usage: usageAt(o.context),
  })
  const stream = $.turn.step({
    turnId: o.turnId ?? 't1',
    index: o.index ?? 1,
    model: 'claude-opus-5-5',
    messageCount: 3,
    ...(o.agentId !== undefined ? { agentId: o.agentId } : {}),
  })
  let next = await stream.next()
  while (next.done !== true) next = await stream.next()
  return next.value
}

type SaveInput = { text: string; scope?: 'session' | 'helper'; title?: string; agentId?: string }

/**
 * Claude calling save_handoff. The input is cast so the test's typing never
 * depends on whether the laid table of MCP tools lists the mod's own tool.
 */
function callSave($: Engine, args: SaveInput) {
  type Args = Parameters<Engine['tool']['call']>[0]
  return $.tool.call({ tool: 'mcp__context-pilot__save_handoff', ...args } as unknown as Args)
}

/** A slash command as the person types it at the prompt. */
function command($: Engine, name: string, args = '') {
  return $.command.run({
    command: name,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
}

function paneProps(columns: number) {
  return { title: 'Context pilot', isFocused: false, bodyColumns: columns, placement: 'dock' } as never
}

let rowCount = 0

/** A tool-result row coming into a loop, as the engine appends one. */
async function toolResult($: Engine, agentId?: string, results = 1): Promise<void> {
  rowCount += 1
  await $.session.append({
    message: {
      type: 'user',
      role: 'user',
      content: Array.from({ length: results }, (_, i) => ({ type: 'tool_result', tool_use_id: `toolu_${rowCount}_${i}`, content: 'ok' })),
    },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Read' },
    uuid: `row-${rowCount}`,
    ...(agentId !== undefined ? { agentId } : {}),
  })
}

/** A turn of a loop ending. */
async function turnEnds($: Engine, agentId?: string): Promise<void> {
  await $.turn.complete({
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: 't-end',
    reason: 'answer',
    ...(agentId !== undefined ? { agentId } : {}),
  })
}

type Rows = readonly { door: string; agentId?: string; message: { content: { type: string; [k: string]: unknown }[] } }[]

/** The plugin's notes in one loop ('' for main). */
function notesIn(rows: Rows, loop: string): Rows {
  return rows.filter(row => row.door === 'note' && (row.agentId ?? '') === loop)
}

function noteTexts(rows: readonly { message: { content: { type: string; [k: string]: unknown }[] } }[]): string[] {
  return rows.map(row => row.message.content.map(block => String(block.text ?? '')).join(''))
}

test('a request is measured from its usage and shown on the status line', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  const result = await step($, w, { context: 84_000, index: 0 })
  expect(result.usage?.cache_read_input_tokens).toBe(83_000)
  expect(w.status.at(-1)).toBe('ctx 42% · cache 99% · tax 0')
})

test('bumps name what came in between: a tool call, a task notification', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await step($, w, { context: 30_000, index: 0, toolUses: [{ name: 'Read', input: { file_path: '/r/app.js' } }] })
  await step($, w, { context: 42_000, index: 1 })
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'Agent "Fix tests" finished.' }] },
    door: 'delivery',
    origin: { kind: 'task-notification' },
    uuid: 'row-1',
  })
  await step($, w, { context: 60_000, index: 0, turnId: 't2' })
  const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'terminal', ...PANE, props: paneProps(80) })
  expect(await ui.find({ text: /^\+18k\s+task notification · turn 2$/ })).toBeDefined()
  expect(await ui.find({ text: /^\+12k\s+Read app\.js · turn 1$/ })).toBeDefined()
  await ui.unmount()
})

test('main threshold appends exactly one note, re-armed only after a 10-point drop', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  const w = world(on)
  const counts: number[] = []
  for (const context of [100_000, 145_000, 150_000, 125_000, 150_000, 110_000, 142_000]) {
    await step($, w, { context, toolUses: [{ name: 'Read', input: { file_path: 'a.ts' } }] })
    // The note waits for the step's tool result, so it never splits a call from its result.
    const before = notesIn(session.appended(), '').length
    await toolResult($)
    await clock.settle()
    expect(notesIn(session.appended(), '').length - before).toBeLessThanOrEqual(1)
    counts.push(notesIn(session.appended(), '').length)
  }
  expect(counts).toEqual([0, 1, 1, 1, 1, 1, 2])
  const notes = noteTexts(notesIn(session.appended(), ''))
  expect(notes[0]).toStartWith('Context is at 73%. Wrap up:')
  expect(notes[0]).toContain('save_handoff')
  expect(notes[0]).toContain('/pickup')
  expect(w.status).toContain('ctx 73% · cache 99% · tax 0 · handing off…')
})

test('a threshold crossed on the last reply of a turn is noted when the turn ends', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  const w = world(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await step($, w, { context: 150_000, index: 0 })
  expect(notesIn(session.appended(), '')).toHaveLength(0)
  await turnEnds($)
  expect(notesIn(session.appended(), '')).toHaveLength(1)
})

test('a helper past 20 minutes gets one note, in its own loop only', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  const w = world(on)
  await step($, w, { context: 20_000, agentId: 'a1', toolUses: [{ name: 'Bash', input: { command: 'npm test' } }] })
  await clock.advance(5 * MINUTE)
  await step($, w, { context: 22_000, agentId: 'a2', toolUses: [{ name: 'Read', input: { file_path: 'a.ts' } }] })
  await clock.advance(16 * MINUTE)
  // a1 is still inside its long tool call: the note waits for the result.
  expect(notesIn(session.appended(), 'a1')).toHaveLength(0)
  await toolResult($, 'a1')
  await toolResult($, 'a2')
  await clock.settle()
  const rows = session.appended()
  expect(notesIn(rows, 'a1')).toHaveLength(1)
  expect(notesIn(rows, 'a2')).toHaveLength(0)
  expect(notesIn(rows, '')).toHaveLength(0)
  expect(noteTexts(notesIn(rows, 'a1'))[0]).toStartWith('You have been running 20 minutes. Stop now: call save_handoff')
  await step($, w, { context: 24_000, agentId: 'a1', toolUses: [{ name: 'Read', input: { file_path: 'a.ts' } }] })
  await toolResult($, 'a1')
  await clock.advance(MINUTE)
  expect(notesIn(session.appended(), 'a1')).toHaveLength(1)
})

test('a helper past its context limit is asked after its parallel results are all in', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  const w = world(on)
  const two = [{ name: 'Read', input: { file_path: 'a.ts' } }, { name: 'Read', input: { file_path: 'b.ts' } }, { name: 'Grep', input: { pattern: 'x' } }]
  await step($, w, { context: 70_000, agentId: 'a2', toolUses: two })
  await toolResult($, 'a2')
  await clock.settle()
  expect(notesIn(session.appended(), 'a2')).toHaveLength(0)
  await toolResult($, 'a2', 2)
  await clock.settle()
  const rows = notesIn(session.appended(), 'a2')
  expect(rows).toHaveLength(1)
  expect(noteTexts(rows)[0]).toStartWith('Your context is 35%.')
})

test('save_handoff writes the file under the project slug, and latest.md for a session', async ($, on) => {
  mock.clock(on, { now: new Date(2026, 9, 14, 9, 30, 0).getTime() })
  const w = world(on)
  const ran = await callSave($, {
    text: '## Goal\nShip the parser.\n\n## Next\n- Run the tests',
    scope: 'session',
    title: 'Ship the parser',
  })
  const path = `${DIR}/20261014-093000-session.md`
  expect(ran.result).toBe(`Handoff saved to ${path}.`)
  expect(w.writes.map(one => one.path)).toEqual([path, `${DIR}/latest.md`])
  expect(w.writes[0]?.text).toStartWith('# Ship the parser\n\nSaved 2026-10-14 09:30 · session · /Users/leland/Coding/earshot')
  expect(w.writes[0]?.text).toContain('## Next\n- Run the tests')
  expect(w.status.at(-1)).toBeUndefined()
})

test('a helper handoff never touches latest.md and takes the next free name', async ($, on) => {
  mock.clock(on, { now: new Date(2026, 9, 14, 9, 51, 0).getTime() })
  const w = world(on)
  w.files[`${DIR}/20261014-095100-helper.md`] = { text: 'taken', mtimeMs: 1 }
  const saved = await callSave($, { text: 'Left: the parser.', scope: 'helper' })
  expect(saved.result).toBe(`Handoff saved to ${DIR}/20261014-095100-helper-2.md.`)
  expect(w.writes.map(one => one.path)).toEqual([`${DIR}/20261014-095100-helper-2.md`])
  const empty = await callSave($, { text: '  ' })
  expect(empty.deny).toBe('save_handoff needs the handoff itself in `text`.')
})

test('a helper asked to stop: the Agent result tells the main loop', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  on('tool.call', { tool: 'Agent' }, () => ({
    result: { status: 'completed', agentId: 'a1', content: [], totalToolUseCount: 3 },
  }))
  const w = world(on)
  await step($, w, { context: 20_000, agentId: 'a1', toolUses: [{ name: 'Read', input: { file_path: 'a.ts' } }] })
  await clock.advance(21 * MINUTE)
  await toolResult($, 'a1')
  await clock.settle()
  expect(notesIn(session.appended(), 'a1')).toHaveLength(1)
  await turnEnds($, 'a1')
  const ran = await $.tool.call({ tool: 'Agent', description: 'Fix tests', prompt: 'Fix the failing tests.' })
  expect(ran.context?.[0]).toStartWith('This helper was asked to stop early and saved no handoff.')
  const again = await $.tool.call({ tool: 'Agent', description: 'Fix tests', prompt: 'Fix the failing tests.' })
  expect(again.context).toBeUndefined()
})

test('a background helper asked to stop is reported to the main loop when it ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  on('tool.call', { tool: 'Agent' }, () => ({
    result: { status: 'async_launched', agentId: 'a1', description: 'Fix tests', prompt: 'Fix them.' },
  }))
  const w = world(on)
  const launched = await $.tool.call({ tool: 'Agent', description: 'Fix tests', prompt: 'Fix them.' })
  expect(launched.context).toBeUndefined()
  await step($, w, { context: 20_000, agentId: 'a1', toolUses: [{ name: 'Read', input: { file_path: 'a.ts' } }] })
  await clock.advance(21 * MINUTE)
  await toolResult($, 'a1')
  await clock.settle()
  // The main loop is idle, so the report goes in at once.
  await turnEnds($, 'a1')
  const main = notesIn(session.appended(), '')
  expect(main).toHaveLength(1)
  expect(noteTexts(main)[0]).toStartWith('This helper was asked to stop early')
})

test('a background helper that ends while the main loop works is reported after its tool results', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  on('tool.call', { tool: 'Agent' }, () => ({
    result: { status: 'async_launched', agentId: 'a1', description: 'Fix tests', prompt: 'Fix them.' },
  }))
  const w = world(on)
  await $.tool.call({ tool: 'Agent', description: 'Fix tests', prompt: 'Fix them.' })
  await step($, w, { context: 20_000, agentId: 'a1', toolUses: [{ name: 'Read', input: { file_path: 'a.ts' } }] })
  await clock.advance(21 * MINUTE)
  await toolResult($, 'a1')
  await $.turn.start({ text: 'more', turnId: 't2' })
  await step($, w, { context: 30_000, index: 0, turnId: 't2', toolUses: [{ name: 'Read', input: { file_path: 'a.ts' } }] })
  await turnEnds($, 'a1')
  await clock.settle()
  expect(notesIn(session.appended(), '')).toHaveLength(0)
  await toolResult($)
  await clock.settle()
  expect(notesIn(session.appended(), '')).toHaveLength(1)
})

test('/pickup fills the prompt box with the handoff; without one it says so', async ($, on) => {
  mock.clock(on, { now: 5_000_000 })
  const w = world(on)
  const none = await command($, 'pickup')
  expect(none.text).toBe('No handoff for this project yet.')
  expect(w.fills).toHaveLength(0)
  w.files[`${DIR}/latest.md`] = { text: '# Ship it\n\nNext: run the tests.\n', mtimeMs: 4_000_000 }
  const done = await command($, 'pickup')
  expect(done.text).toBe('The handoff is in your prompt box. Press Enter to continue.')
  expect(w.fills).toEqual([
    'Continue from this handoff. Read it, confirm the next step, then carry on:\n\n# Ship it\n\nNext: run the tests.',
  ])
})

test('a waiting handoff shows on the status line at start, until /pickup', async ($, on) => {
  const clock = mock.clock(on, { now: 9_000_000 })
  const w = world(on, { startedAt: 8_000_000 })
  w.files[`${DIR}/latest.md`] = { text: '# Ship it\n\nNext: run the tests.\n', mtimeMs: 7_000_000 }
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(w.status.at(-1)).toBe('handoff waiting · /pickup')
  await command($, 'pickup')
  await clock.settle()
  expect(w.status.at(-1)).toBeUndefined()
})

test('/handoff queues the handoff prompt; /pilot changes and lists settings', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  const asked = await command($, 'handoff')
  expect(asked.text).toBe('Asking Claude to write a handoff.')
  await clock.settle()
  expect(w.submits[0]).toStartWith('Write a session handoff now. Wrap up:')
  expect((await command($, 'pilot', 'set main 60')).text).toBe('Main context threshold set to 60%.')
  expect((await command($, 'pilot', 'off')).text).toBe('Auto-handoff is off.')
  expect((await command($, 'pilot', 'set main 300')).text).toBe(
    'main takes a whole number from 10 to 95.',
  )
  const listed = (await command($, 'pilot', 'settings')).text ?? ''
  expect(listed).toContain('main            60%')
  expect(listed).toContain('auto            off')
  expect((await command($, 'pilot')).text).toBe('Opening the context pilot.')
})

type Drawn = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

/**
 * Cells across a drawn element as the surface lays it out: a Text's strings
 * end to end, a row Box's children side by side with their gaps, a column
 * Box's widest child; borders and padding added. A wrapping row is measured
 * by its widest child, since that is what it wraps down to.
 */
function widthOf(node: unknown): number {
  if (typeof node === 'string') return Array.from(node).length
  if (node === null || typeof node !== 'object') return 0
  const el = node as Drawn
  const props = el.props ?? {}
  const kids = (el.children ?? []).filter(kid => kid !== null && kid !== undefined && kid !== false).map(widthOf)
  const sum = kids.reduce((a, b) => a + b, 0)
  if (el.type === 'Text') return sum
  if (el.type === 'Button') return kids.length > 0 ? sum : Array.from(String(props.label ?? '')).length
  if (el.type !== 'Box') return Math.max(0, ...kids)
  const frame =
    (props.borderStyle !== undefined ? 2 : 0) +
    2 * (num(props.paddingX) || num(props.padding)) +
    num(props.paddingLeft) +
    num(props.paddingRight)
  const direction = props.flexDirection ?? 'row'
  if ((direction !== 'row' && direction !== 'row-reverse') || props.flexWrap === 'wrap') return Math.max(0, ...kids) + frame
  const gap = num(props.columnGap) || num(props.gap)
  return sum + gap * Math.max(0, kids.length - 1) + frame
}

test('pane draws on terminal and desktop, narrow and wide, empty and measured', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  const check = async (columns: number, isEmpty: boolean) => {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'context-pilot', surface, ...PANE, props: paneProps(columns) })
      expect(await ui.find({ text: /C O N T E X T/ })).toBeDefined()
      if (columns < NARROW) {
        expect(await ui.find({ text: isEmpty ? /^Nothing meas/ : /^ctx \d+% · cache/ })).toBeDefined()
        expect(await ui.find({ type: 'Button', key: 'close' })).toBeDefined()
      } else if (isEmpty) {
        expect(await ui.find({ text: /Nothing measured yet/ })).toBeDefined()
      } else {
        expect(await ui.find({ text: /BIGGEST JUMPS/ })).toBeDefined()
        expect(await ui.find({ text: /Read app\.js/ })).toBeDefined()
        // At the narrowest full layout the long lines are cut short.
        expect(await ui.find({ text: columns >= 32 ? /Fix tests/ : /^Fix/ })).toBeDefined()
        expect(await ui.find({ text: columns >= 32 ? /Status line says 38%/ : /^Status line/ })).toBeDefined()
      }
      for (const one of await ui.findAll({ type: 'Text' })) {
        expect(one.text.length, `"${one.text}" at ${columns} on ${surface}`).toBeLessThanOrEqual(columns)
      }
      // Whole rows too: a title bar, a heading, a helper row with its meter.
      expect(widthOf(await ui.drawn()), `the widest row at ${columns} on ${surface}`).toBeLessThanOrEqual(columns)
      await ui.unmount()
    }
  }
  await check(16, true)
  await check(32, true)
  await check(120, true)
  expect(EMPTY_TEXT).toContain('Nothing measured yet')
  await step($, w, { context: 40_000, index: 0, toolUses: [{ name: 'Read', input: { file_path: '/r/app.js' } }] })
  await step($, w, { context: 52_300, index: 1, toolUses: [{ name: 'Bash', input: { command: 'npm test' } }] })
  await step($, w, { context: 20_000, agentId: 'a1' })
  await clock.advance(3 * MINUTE)
  await step($, w, { context: 61_000, index: 2 })
  await check(16, false)
  await check(NARROW, false)
  await check(32, false)
  await check(120, false)
  await check(64, false)
  await check(80, false)
  const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'terminal', ...PANE, props: paneProps(80) })
  expect(await ui.find({ text: 'Auto-handoff: on' })).toBeDefined()
  await ui.press({ key: 'auto' })
  expect(await ui.find({ text: 'Auto-handoff: off' })).toBeDefined()
  await ui.unmount()
})

test("a helper whose last reply passes its limit is not reported as asked to stop", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  on('tool.call', { tool: 'Agent' }, () => ({
    result: { status: 'completed', agentId: 'a1', content: [], totalToolUseCount: 1 },
  }))
  const w = world(on)
  await step($, w, { context: 40_000, agentId: 'a1', toolUses: [{ name: 'Read', input: { file_path: 'a.ts' } }] })
  await toolResult($, 'a1')
  // Its final reply (no tool calls) reaches 35%: the ask can no longer go in.
  await step($, w, { context: 70_000, agentId: 'a1' })
  await turnEnds($, 'a1')
  await clock.settle()
  expect(notesIn(session.appended(), 'a1')).toHaveLength(0)
  const ran = await $.tool.call({ tool: 'Agent', description: 'Fix tests', prompt: 'Fix the failing tests.' })
  expect(ran.context).toBeUndefined()
})

test('an ask that went in only as the last request was sent is taken back too', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  on('tool.call', { tool: 'Agent' }, () => ({
    result: { status: 'completed', agentId: 'a1', content: [], totalToolUseCount: 1 },
  }))
  const w = world(on)
  await step($, w, { context: 20_000, agentId: 'a1', toolUses: [{ name: 'Read', input: { file_path: 'a.ts' } }] })
  await toolResult($, 'a1')
  // The 20-minute watch comes due between its tool result and its next request.
  await clock.advance(21 * MINUTE)
  await clock.settle()
  await step($, w, { context: 21_000, agentId: 'a1' })
  await turnEnds($, 'a1')
  await clock.settle()
  const ran = await $.tool.call({ tool: 'Agent', description: 'Fix tests', prompt: 'Fix the failing tests.' })
  expect(ran.context).toBeUndefined()
})

test('a helper that saved a handoff: the Agent result carries its path', async ($, on) => {
  const clock = mock.clock(on, { now: new Date(2026, 9, 14, 10, 0, 0).getTime() })
  const session = mock.session(on)
  on('tool.call', { tool: 'Agent' }, () => ({
    result: { status: 'completed', agentId: 'a1', content: [], totalToolUseCount: 4 },
  }))
  const w = world(on)
  await step($, w, { context: 70_000, agentId: 'a1', toolUses: [{ name: 'Read', input: { file_path: 'a.ts' } }] })
  await toolResult($, 'a1')
  await clock.settle()
  expect(notesIn(session.appended(), 'a1')).toHaveLength(1)
  const path = `${DIR}/20261014-100000-helper.md`
  const saved = await callSave($, { text: 'Left: the parser.', agentId: 'a1' })
  expect(saved.result).toBe(`Handoff saved to ${path}.`)
  expect(w.writes.map(one => one.path)).toEqual([path])
  await step($, w, { context: 71_000, agentId: 'a1' })
  await turnEnds($, 'a1')
  const ran = await $.tool.call({ tool: 'Agent', description: 'Fix tests', prompt: 'Fix the failing tests.' })
  expect(ran.context?.[0]).toBe(
    `This helper stopped early and saved a handoff at ${path}. Start a fresh helper with the Agent tool ` +
      "and give it that handoff's text to finish the remaining work.",
  )
})

test('a helper on the main model is measured against the window the session reports', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  const w = world(on, { window: 1_000_000 })
  await step($, w, { context: 50_000, index: 0 })
  // 70k is 35% of a 200k guess, but 7% of the session's 1M window.
  await step($, w, { context: 70_000, agentId: 'a2', toolUses: [{ name: 'Read', input: { file_path: 'a.ts' } }] })
  await toolResult($, 'a2')
  await clock.settle()
  expect(notesIn(session.appended(), 'a2')).toHaveLength(0)
  const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'terminal', ...PANE, props: paneProps(80) })
  expect(await ui.find({ text: /^Read the docs/ })).toBeDefined()
  expect(await ui.find({ text: /^\s+7%$/ })).toBeDefined()
  await ui.unmount()
})

test('a note waits for tool results the engine stores while the step still streams', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  const w = world(on)
  const read = { name: 'Read', input: { file_path: 'a.ts' } }
  const bash = { name: 'Bash', input: { command: 'npm test' } }
  // The threshold is crossed on a step whose fast Read is stored mid-stream.
  w.midStream.push(() => toolResult($))
  await step($, w, { context: 150_000, toolUses: [read, bash] })
  await clock.settle()
  expect(notesIn(session.appended(), '')).toHaveLength(0)
  await toolResult($)
  await clock.settle()
  expect(notesIn(session.appended(), '')).toHaveLength(1)
  expect(session.appended().at(-1)?.door).toBe('note')
  // Every result of a helper's step stored mid-stream: its ask goes in as the step ends.
  w.midStream.push(() => toolResult($, 'a2', 2))
  await step($, w, { context: 70_000, agentId: 'a2', toolUses: [read, bash] })
  await clock.settle()
  expect(notesIn(session.appended(), 'a2')).toHaveLength(1)
})

test('handing off… clears when no handoff came, and handoff saved lasts one turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  const turn = async (turnId: string, context: number, save = false) => {
    await $.turn.start({ text: 'go', turnId })
    await step($, w, { context, index: 0, turnId })
    if (save) await callSave($, { text: 'Next: run the tests.', scope: 'session' })
    await turnEnds($)
  }
  await turn('t1', 40_000)
  await command($, 'handoff')
  await clock.settle()
  expect(w.status.at(-1)).toBe('ctx 20% · cache 98% · tax 0 · handing off…')
  // The handoff turn: Claude does not save one.
  await turn('t2', 41_000)
  expect(w.status.at(-1)).toBe('ctx 21% · cache 98% · tax 0 · handing off…')
  // The person carries on: the ask has gone unanswered.
  await turn('t3', 42_000, true)
  expect(w.status.at(-1)).toBe('ctx 21% · cache 98% · tax 0 · handoff saved')
  await turn('t4', 43_000)
  expect(w.status.at(-1)).toBe('ctx 22% · cache 98% · tax 0')
})

test('/handoff asked while a turn runs keeps handing off… through the handoff turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await step($, w, { context: 40_000, index: 0, turnId: 't1' })
  await turnEnds($)
  // A new turn has started and none of its requests is measured yet.
  await $.turn.start({ text: 'more', turnId: 't2' })
  await command($, 'handoff')
  await clock.settle()
  await step($, w, { context: 41_000, index: 0, turnId: 't2' })
  await turnEnds($)
  await $.turn.start({ text: 'Write a session handoff now.', turnId: 't3' })
  await step($, w, { context: 42_000, index: 0, turnId: 't3' })
  expect(w.status.at(-1)).toBe('ctx 21% · cache 98% · tax 0 · handing off…')
})

test('a dropped /handoff prompt puts the status line back and says why', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { dropSubmit: 'held for review' })
  await step($, w, { context: 40_000, index: 0 })
  await command($, 'handoff')
  await clock.settle()
  expect(w.status.at(-1)).toBe('ctx 20% · cache 98% · tax 0')
  expect(w.toasts.at(-1)).toBe('Claude was not asked for a handoff: held for review')
})

test('a pane that waits undrawn runs no redraw timer', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { isPlaced: false })
  expect((await command($, 'pilot')).text).toBe('Opening the context pilot.')
  await clock.settle()
  expect(w.toasts.at(-1)).toStartWith('The pilot pane waits for a wider window.')
  const before = w.paneReads
  await clock.advance(10_000)
  expect(w.redraws).toBe(0)
  // Only a slow look for when it is drawn, not the one-second redraw.
  expect(w.paneReads - before).toBeLessThanOrEqual(5)
  // Closed while it waited: the look stops too.
  w.isOpen = false
  await clock.advance(2_000)
  const after = w.paneReads
  await clock.advance(10_000)
  expect(w.paneReads).toBe(after)
})

test('a pane drawn after it waited undrawn starts its one-second redraw', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { isPlaced: false })
  await command($, 'pilot')
  await clock.settle()
  await clock.advance(5_000)
  expect(w.redraws).toBe(0)
  // The terminal widens to the pane's floor: it is drawn now.
  w.isPlaced = true
  await clock.advance(5_000)
  expect(w.redraws).toBeGreaterThanOrEqual(2)
  // Closed: the redraw stops with it.
  w.isOpen = false
  await clock.advance(2_000)
  const reads = w.paneReads
  const redraws = w.redraws
  await clock.advance(10_000)
  expect(w.paneReads).toBe(reads)
  expect(w.redraws).toBe(redraws)
})

test('a note goes in after a result stored once the step streamed, before the note was due', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const session = mock.session(on)
  const w = world(on)
  // The step's only result is stored while the mod still measures that step.
  w.duringUsage.push(() => toolResult($))
  await step($, w, { context: 150_000, toolUses: [{ name: 'Read', input: { file_path: 'a.ts' } }] })
  await clock.settle()
  const rows = session.appended()
  expect(notesIn(rows, '')).toHaveLength(1)
  expect(rows.at(-1)?.door).toBe('note')
})

test('the person hears when save_handoff could not be given to Claude', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { toolFails: true })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(w.toasts).toContain(
    'Context pilot could not give Claude its save_handoff tool, so handoffs cannot be saved this session.',
  )
})
