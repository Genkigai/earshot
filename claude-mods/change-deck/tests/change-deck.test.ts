// The mod through the engine: recording edits, the commands, the pane and its buttons.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ChangeDeckEntry } from '../types'

import { GOLD, cells } from '../hooks/look-text'

const ROOT = '/work/app'
const HOME = '/home/me'
const DATA = `${HOME}/.claude/mod-data/change-deck/sess-1`
const PANE = { component: 'Pane', requestId: 'change-deck' } as const
const START = 1_700_000_000_000

type World = {
  files: Map<string, string>
  /** A file's bytes as base64, where they differ from its text (not UTF-8). */
  bytes: Map<string, string>
  /** Folders `fs.list` answers, by path. */
  dirs: Map<string, { name: string; kind: 'file' | 'dir' }[]>
  agents: { id: string; description: string; type: string; status: 'running' }[]
  isPlaced: boolean
  isGitRepo: boolean
  writes: { path: string; text: string }[]
  fills: string[]
  toasts: string[]
  runs: string[][]
  opens: string[]
  closes: string[]
  /** How the next edit tool call ends. */
  outcome: 'ok' | 'deny' | 'error'
  gitFiles: string[]
  clock: MockClock
}

/** Stands for the engine beneath the plugin: files in memory, a fake edit tool. */
function world(on: On): World {
  const w: World = {
    files: new Map(),
    bytes: new Map(),
    dirs: new Map(),
    agents: [{ id: 'a1', description: 'Fix tests', type: 'general-purpose', status: 'running' }],
    isPlaced: true,
    isGitRepo: true,
    writes: [],
    fills: [],
    toasts: [],
    runs: [],
    opens: [],
    closes: [],
    outcome: 'ok',
    gitFiles: [],
    clock: mock.clock(on, { now: START }),
  }
  mock.store(on)
  mock.env(on, { HOME })
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: w.agents }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', ($, e) => {
    const text = w.files.get(e.path)
    if (text !== undefined) return { value: { kind: 'file' as const, size: text.length, mtimeMs: START, isLink: false } }
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', ($, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) return { deny: `ENOENT: ${e.path}` }
    if (e.as === 'bytes') return { value: { base64: w.bytes.get(e.path) ?? '' } }
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.writes.push({ path: e.path, text: e.text })
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const listed = w.dirs.get(e.path)
    if (listed === undefined) return { deny: 'ENOENT' }
    return { value: listed.map(one => ({ ...one, size: 1, mtimeMs: START, isLink: false })) }
  })
  on('process.run', ($, e) => {
    w.runs.push([...e.argv])
    const isGit = e.argv[0] === 'git'
    const stdout = isGit ? w.gitFiles.join('\u0000') : ''
    const exitCode = isGit && !w.isGitRepo ? 128 : 0
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', ($, e) => {
    w.opens.push(e.id)
    return { value: w.isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'the terminal is 90 columns, under 110' } }
  })
  on('ui.close', ($, e) => {
    w.closes.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('tool.call', ($, e) => {
    if (w.outcome === 'deny') return { deny: 'The person said no.' }
    if (w.outcome === 'error') return { isError: true as const, result: 'String not found.', text: 'String not found.' }
    if (e.tool === 'Edit') {
      const text = w.files.get(e.file_path) ?? ''
      w.files.set(e.file_path, text.replace(e.old_string, e.new_string))
    } else if (e.tool === 'Write') {
      w.files.set(e.file_path, e.content)
    } else if (e.tool === 'NotebookEdit') {
      w.files.set(e.notebook_path, `{"cells":[${JSON.stringify(e.new_source)}]}\n`)
    }
    return { result: {} as never, text: 'ok' }
  })
  return w
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

function edit($: Engine, file: string, from: string, to: string, agentId?: string) {
  return $.tool.call({
    tool: 'Edit',
    file_path: `${ROOT}/${file}`,
    old_string: from,
    new_string: to,
    ...(agentId !== undefined ? { agentId } : {}),
  } as never)
}

function write($: Engine, file: string, content: string) {
  return $.tool.call({ tool: 'Write', file_path: `${ROOT}/${file}`, content })
}

function command($: Engine, args = '') {
  return $.command.run({ command: 'changes', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
}

function paneProps(columns: number, rows = 40) {
  return { title: 'Changes', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} } as never
}

/** Another plugin reading the index, as any plugin may: `/peek` answers it as JSON. */
const PEEK: Plugin = {
  name: 'peek',
  register(on) {
    on('command.run', { command: 'peek' }, async $ => {
      const { value } = await $.state.get({ plugin: 'change-deck', key: 'entries' })
      return { text: JSON.stringify(value ?? []) }
    })
  },
}
const WITH_PEEK = { plugins: [PEEK] }

async function entries($: Engine): Promise<ChangeDeckEntry[]> {
  const ran = await $.command.run({ command: 'peek', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  return JSON.parse(ran.text ?? '[]') as ChangeDeckEntry[]
}

/** Fails with a label naming what was not drawn. */
function must(found: unknown, label: string): void {
  if (found === undefined) throw new Error(`not drawn: ${label}`)
}

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

const num = (value: unknown): number => (typeof value === 'number' ? value : 0)

/** Cells a Box's padding and border take across. */
function frame(props: Record<string, unknown>): number {
  const padX = typeof props.paddingX === 'number' ? props.paddingX : num(props.padding)
  return 2 * padX + (props.borderStyle !== undefined ? 2 : 0)
}

/** Cells a drawn node takes across, laid out as the surface lays it (Code cuts itself at the edge). */
function across(node: unknown): number {
  if (typeof node === 'string') return cells(node)
  if (typeof node !== 'object' || node === null) return 0
  const el = node as Drawn
  const props = el.props ?? {}
  const kids = el.children ?? []
  if (el.type === 'Code') return 0
  if (el.type === 'Text') return kids.reduce<number>((sum, one) => sum + across(one), 0)
  if (el.type === 'Button') {
    return kids.length > 0 ? kids.reduce<number>((sum, one) => sum + across(one), 0) : cells(String(props.label ?? '')) + 4
  }
  if (typeof props.width === 'number') return props.width
  const widths = kids.map(across)
  const isRow = props.flexDirection === undefined || props.flexDirection === 'row'
  const inner = isRow
    ? widths.reduce((sum, one) => sum + one, 0) + num(props.gap) * Math.max(0, widths.length - 1)
    : Math.max(0, ...widths)
  return inner + frame(props)
}

/** Every Box whose content is wider than the width it declares, as `where: content > room`. */
function overflows(node: unknown, where = 'root', out: string[] = []): string[] {
  if (typeof node !== 'object' || node === null) return out
  const el = node as Drawn
  const props = el.props ?? {}
  const kids = el.children ?? []
  if (el.type === 'Box' && typeof props.width === 'number') {
    const room = props.width - frame(props)
    const widths = kids.map(across)
    const isRow = props.flexDirection === undefined || props.flexDirection === 'row'
    const content = isRow
      ? widths.reduce((sum, one) => sum + one, 0) + num(props.gap) * Math.max(0, widths.length - 1)
      : Math.max(0, ...widths)
    if (content > room) out.push(`${where}: ${content} > ${room}`)
  }
  kids.forEach((one, index) => overflows(one, `${where}/${(one as Drawn).type ?? 'text'}${index}`, out))
  return out
}

/** Asserts the drawing fits `columns`: no Box over its width, the whole no wider than the pane. */
async function expectFits(ui: { drawn: () => Promise<unknown> }, columns: number, at: string): Promise<void> {
  const tree = await ui.drawn()
  expect({ at, overflows: overflows(tree) }).toEqual({ at, overflows: [] })
  expect({ at, width: across(tree) <= columns }).toEqual({ at, width: true })
}

const bodyWrites = (w: World) => w.writes.filter(one => one.path.startsWith(DATA))

test('an Edit reads the file before and after, keeps both, and adds an index entry', WITH_PEEK, async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/src/app.js`, 'one\ntwo\nthree\n')
  await start($)
  await edit($, 'src/app.js', 'two', 'TWO')
  const list = await entries($)
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({
    id: '1',
    tool: 'Edit',
    path: `${ROOT}/src/app.js`,
    relPath: 'src/app.js',
    added: 1,
    removed: 1,
    isNew: false,
    turn: 3,
    file: `${DATA}/1.json`,
  })
  const saved = bodyWrites(w)
  expect(saved).toHaveLength(1)
  expect(JSON.parse(saved[0]!.text)).toMatchObject({ before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n' })
})

test('a denied or errored edit records nothing; a helper edit carries its label', WITH_PEEK, async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/a.txt`, 'a\n')
  await start($)
  w.outcome = 'deny'
  await edit($, 'a.txt', 'a', 'b')
  w.outcome = 'error'
  await edit($, 'a.txt', 'a', 'b')
  expect(await entries($)).toHaveLength(0)
  expect(bodyWrites(w)).toHaveLength(0)
  w.outcome = 'ok'
  await edit($, 'a.txt', 'a', 'b', 'a1')
  const list = await entries($)
  expect(list).toHaveLength(1)
  expect(list[0]?.agentLabel).toBe('Fix tests')
})

test('a new file is recorded as new; /changes off stops recording and on starts it', WITH_PEEK, async ($, on) => {
  const w = world(on)
  await start($)
  await write($, 'notes.md', 'hello\n')
  expect((await entries($))[0]).toMatchObject({ isNew: true, added: 1, removed: 0 })
  expect((await command($, 'off')).text).toBe('Stopped recording edits. /changes on starts again.')
  await write($, 'notes.md', 'hello again\n')
  expect(await entries($)).toHaveLength(1)
  await command($, 'on')
  await write($, 'notes.md', 'third\n')
  expect(await entries($)).toHaveLength(2)
  expect((await command($, 'clear')).text).toBe('Cleared the change record for this session.')
  expect(await entries($)).toHaveLength(0)
  await w.clock.settle()
  expect(w.runs.some(argv => argv[0] === 'rm' && argv.includes(`${DATA}/1.json`) && argv.includes(`${DATA}/2.json`))).toBe(true)
})

test('/changes answers at once and opens the pane', async ($, on) => {
  const w = world(on)
  await start($)
  const ran = await command($)
  expect(ran.text).toBe('Opening the changes pane.')
  await w.clock.settle()
  expect(w.opens).toEqual(['change-deck'])
  expect((await command($, 'nonsense')).text).toMatch(/\/changes clear/)
})

test('pane draws on terminal and desktop, narrow and wide, nothing wider than its width', async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/src/app.js`, Array.from({ length: 60 }, (_, i) => `line ${i}\n`).join(''))
  w.files.set(`${ROOT}/src/components/Button.tsx`, 'export {}\n')
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const columns of [40, 130]) {
      const ui = await $.ui.mount({ plugin: 'change-deck', surface, ...PANE, props: paneProps(columns) })
      must(await ui.find({ text: /No edits yet\./ }), `empty ${surface} ${columns}`)
      await expectFits(ui, columns, `empty ${surface} ${columns}`)
      await ui.unmount()
    }
  }
  await edit($, 'src/app.js', 'line 3\n', 'line three\n')
  await edit($, 'src/components/Button.tsx', 'export {}', 'export const Button = 1')
  await edit($, 'src/app.js', 'line 40\n', 'line forty\nline forty-one\n', 'a1')
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const columns of [32, 40, 120, 130]) {
      const ui = await $.ui.mount({ plugin: 'change-deck', surface, ...PANE, props: paneProps(columns) })
      const at = `${surface} ${columns}`
      must(await ui.find({ text: /C H A N G E S/ }), `title ${at}`)
      must(await ui.find({ text: '3 edits · 2 files' }), `summary ${at}`)
      must(await ui.find({ text: /Edit 3 of 3 · Edit · src\/app\.js/ }), `header ${at}`)
      must(await ui.find({ text: /by helper "Fix tests"/ }), `who ${at}`)
      must(await ui.find({ text: /turn 3/ }), `turn ${at}`)
      const code = await ui.find({ type: 'Code' })
      expect(code?.props.format).toBe('diff')
      expect(String(code?.props.source)).toBe(
        '@@ -38,7 +38,8 @@\n line 37\n line 38\n line 39\n-line 40\n+line forty\n+line forty-one\n line 41\n line 42\n line 43',
      )
      for (const one of await ui.findAll({ type: 'Text' })) {
        expect(cells(one.text)).toBeLessThanOrEqual(columns)
      }
      await expectFits(ui, columns, at)
      await ui.press({ key: 'mode-project' })
      await expectFits(ui, columns, `${at} project`)
      await ui.press({ key: 'mode-touched' })
      await ui.unmount()
    }
  }
})

test('Prev, Next and Latest move through the edits; a file press filters them', async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/a.ts`, 'a\n')
  w.files.set(`${ROOT}/b.ts`, 'b\n')
  await start($)
  await edit($, 'a.ts', 'a', 'a1')
  await edit($, 'b.ts', 'b', 'b1')
  await edit($, 'a.ts', 'a1', 'a2')
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(130) })
  expect(await ui.find({ text: /Edit 3 of 3/ })).toBeDefined()
  await ui.press({ key: 'prev' })
  expect(await ui.find({ text: /Edit 2 of 3 · Edit · b\.ts/ })).toBeDefined()
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'prev' })
  expect(await ui.find({ text: /Edit 1 of 3/ })).toBeDefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ text: /Edit 2 of 3/ })).toBeDefined()
  await ui.press({ key: 'latest' })
  expect(await ui.find({ text: /Edit 3 of 3/ })).toBeDefined()
  await ui.press({ key: 'f:a.ts' })
  expect(await ui.find({ text: /Showing 2 edits to a\.ts/ })).toBeDefined()
  await ui.press({ key: 'prev' })
  expect(await ui.find({ text: /Edit 1 of 3 · Edit · a\.ts/ })).toBeDefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ text: /Edit 3 of 3/ })).toBeDefined()
  await ui.press({ key: 'f:a.ts' })
  expect(await ui.find({ text: /Showing/ })).toBeUndefined()
  await ui.unmount()
})

test('Revert arms, then writes the old text back and records itself', WITH_PEEK, async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/src/app.js`, 'one\ntwo\n')
  await start($)
  await edit($, 'src/app.js', 'two', 'TWO')
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(130) })
  await ui.press({ key: 'revert' })
  expect(await ui.find({ text: 'Press again to revert src/app.js to before edit 1' })).toBeDefined()
  expect(w.files.get(`${ROOT}/src/app.js`)).toBe('one\nTWO\n')
  await ui.press({ key: 'revert' })
  expect(w.files.get(`${ROOT}/src/app.js`)).toBe('one\ntwo\n')
  expect(await ui.find({ text: 'Reverted src/app.js to before edit 1.' })).toBeDefined()
  const list = await entries($)
  expect(list).toHaveLength(2)
  expect(list[1]).toMatchObject({ tool: 'Revert', agentLabel: 'you', relPath: 'src/app.js' })
  await ui.unmount()
})

test('Revert waits out its window, refuses a file changed since, and never deletes a new file', async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/src/app.js`, 'one\ntwo\n')
  await start($)
  await edit($, 'src/app.js', 'two', 'TWO')
  await write($, 'fresh.txt', 'new file\n')
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(130) })

  await ui.press({ key: 'revert' })
  expect(await ui.find({ text: /This edit created the file\. Delete it yourself/ })).toBeDefined()
  expect(w.files.has(`${ROOT}/fresh.txt`)).toBe(true)

  await ui.press({ key: 'prev' })
  await ui.press({ key: 'revert' })
  await w.clock.advance(11_000)
  await ui.press({ key: 'revert' })
  expect(w.files.get(`${ROOT}/src/app.js`)).toBe('one\nTWO\n')
  expect(await ui.find({ text: /Press again to revert/ })).toBeDefined()

  w.files.set(`${ROOT}/src/app.js`, 'one\nTWO\nthree\n')
  await ui.press({ key: 'revert' })
  expect(await ui.find({ text: "src/app.js changed after this edit, so it can't be reverted cleanly." })).toBeDefined()
  expect(w.files.get(`${ROOT}/src/app.js`)).toBe('one\nTWO\nthree\n')
  await ui.unmount()
})

test('Ask Claude puts the diff in the prompt box and closes the pane', async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/src/app.js`, 'one\ntwo\n')
  await start($)
  await edit($, 'src/app.js', 'two', 'TWO')
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'desktop', ...PANE, props: paneProps(40) })
  await ui.press({ key: 'ask' })
  expect(w.fills).toHaveLength(1)
  expect(w.fills[0]).toBe('About your edit to src/app.js (edit 1 of 1):\n```diff\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n```\n')
  expect(w.closes).toEqual(['change-deck'])
  await ui.unmount()
})

test('long diffs show what fits and a Show all chip; Project mode lists the files', async ($, on) => {
  const w = world(on)
  w.gitFiles = ['README.md', 'src/app.js', 'src/util/math.js']
  await start($)
  await write($, 'src/app.js', Array.from({ length: 80 }, (_, i) => `row ${i}\n`).join(''))
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(130, 30) })
  const chip = await ui.find({ key: 'show-all' })
  expect(chip?.text).toMatch(/Show all 80 lines/)
  const before = String((await ui.find({ type: 'Code' }))?.props.source).split('\n').length
  await ui.press({ key: 'show-all' })
  const after = String((await ui.find({ type: 'Code' }))?.props.source).split('\n').length
  expect(after).toBe(81)
  expect(before).toBeLessThan(after)

  await ui.press({ key: 'mode-project' })
  expect(w.runs.some(argv => argv[0] === 'git' && argv[1] === 'ls-files' && argv.includes('-z'))).toBe(true)
  expect(await ui.find({ key: 'd:src' })).toBeDefined()
  expect(await ui.find({ key: 'f:README.md' })).toBeDefined()
  expect(await ui.find({ key: 'f:src/app.js' })).toBeUndefined()
  await ui.press({ key: 'd:src' })
  expect(await ui.find({ key: 'f:src/app.js' })).toBeDefined()
  await ui.press({ key: 'mode-touched' })
  expect(await ui.find({ key: 'f:README.md' })).toBeUndefined()
  await expectFits(ui, 130, 'touched after project')
  await ui.unmount()
})

test('C1 control characters in an edited file still draw: the pane is not refused', async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/data.txt`, 'plain\n')
  await start($)
  await write($, 'data.txt', 'x \u0085 y\nmojibake a\u0080\u0099\nansi \u009b31m\n')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'change-deck', surface, ...PANE, props: paneProps(80) })
    await expectFits(ui, 80, `c1 ${surface}`)
    const code = await ui.find({ type: 'Code' })
    expect(String(code?.props.source)).not.toMatch(/[\u0080-\u009f]/)
    expect(String(code?.props.source)).toMatch(/\+x � y/)
    await ui.unmount()
  }
})

test('a file that is not UTF-8 is recorded but never written back lossily', WITH_PEEK, async ($, on) => {
  const w = world(on)
  const file = `${ROOT}/latin1.txt`
  w.files.set(file, 'caf� one\n')
  w.bytes.set(file, 'Y2Fm6SBvbmUK')
  await start($)
  await write($, 'latin1.txt', 'caf� one\nline two\n')
  w.bytes.set(file, 'Y2Fm6SBvbmUK')
  expect((await entries($))[0]).toMatchObject({ isLossy: true, added: 1 })
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(130) })
  must(await ui.find({ text: /Not UTF-8 text/ }), 'lossy note')
  const writesBefore = w.writes.filter(one => one.path === file).length
  await ui.press({ key: 'revert' })
  await ui.press({ key: 'revert' })
  expect(w.writes.filter(one => one.path === file)).toHaveLength(writesBefore)
  expect(w.files.get(file)).toBe('caf� one\nline two\n')
  must(await ui.find({ text: /latin1\.txt isn't UTF-8 text, so it can't be put back exactly here\./ }), 'refusal')
  await ui.unmount()
})

test('a real U+FFFD in a UTF-8 file is exact and can be reverted', WITH_PEEK, async ($, on) => {
  const w = world(on)
  const file = `${ROOT}/ok.txt`
  w.files.set(file, 'caf� one\n')
  w.bytes.set(file, 'Y2Fm77+9IG9uZQo=')
  await start($)
  await edit($, 'ok.txt', 'one', 'two')
  expect((await entries($))[0]?.isLossy).toBeUndefined()
  w.bytes.delete(file)
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(130) })
  await ui.press({ key: 'revert' })
  await ui.press({ key: 'revert' })
  expect(w.files.get(file)).toBe('caf� one\n')
  await ui.unmount()
})

test('a helper the agent list does not name shows as "by a helper"', WITH_PEEK, async ($, on) => {
  const w = world(on)
  w.agents = []
  w.files.set(`${ROOT}/a.txt`, 'a\n')
  await start($)
  await edit($, 'a.txt', 'a', 'b', 'wf-agent-9')
  const list = await entries($)
  expect(list[0]?.agentLabel).toBeUndefined()
  expect(list[0]?.agentId).toBe('wf-agent-9')
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(130) })
  must(await ui.find({ text: /by a helper/ }), 'by a helper')
  expect(await ui.find({ text: /by helper "/ })).toBeUndefined()
  await ui.unmount()
})

test('a long path keeps its file name in the header and the revert message', async ($, on) => {
  const w = world(on)
  const file = '/root/.claude/dev-mods/a4844b8a-d7cc-5298-af62/prompt-upgrade/hooks/logic.ts'
  w.files.set(file, 'one\ntwo\n')
  await start($)
  await $.tool.call({ tool: 'Edit', file_path: file, old_string: 'two', new_string: 'TWO' } as never)
  for (const columns of [40, 130]) {
    const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(columns) })
    must(await ui.find({ text: /^Edit 1 of 1 · Edit · .*\/logic\.ts$/ }), `header ${columns}`)
    await ui.press({ key: 'revert' })
    must(await ui.find({ text: /logic\.ts$/ }), `message ${columns}`)
    await expectFits(ui, columns, `long path ${columns}`)
    await ui.press({ key: 'latest' })
    await ui.unmount()
  }
})

test('an edit to a very long line still shows its diff and a Show all chip', async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/min.js`, `var a=${'x'.repeat(70_000)};\n`)
  await start($)
  await write($, 'min.js', `var a=${'y'.repeat(70_000)};\n`)
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(130) })
  const code = await ui.find({ type: 'Code' })
  expect(String(code?.props.source)).toMatch(/^@@ -1,1 \+1,1 @@\n-var a=x+…\n\+var a=y+…$/)
  expect(await ui.find({ text: /No line changes/ })).toBeUndefined()
  await ui.unmount()
})

test('very narrow panes draw within their width', async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/src/app.js`, 'one\ntwo\n')
  await start($)
  for (const columns of [10, 16, 20, 23]) {
    const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(columns) })
    await expectFits(ui, columns, `narrow empty ${columns}`)
    await ui.unmount()
  }
  await edit($, 'src/app.js', 'two', 'TWO')
  for (const columns of [10, 16, 20, 23, 24]) {
    const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'desktop', ...PANE, props: paneProps(columns) })
    await expectFits(ui, columns, `narrow ${columns}`)
    for (const one of await ui.findAll({ type: 'Text' })) expect(cells(one.text)).toBeLessThanOrEqual(columns)
    must(await ui.find({ key: 'close' }), `close ${columns}`)
    await ui.unmount()
  }
})

test('a file over 1 MB is listed as too large; Ask says its texts were not kept', WITH_PEEK, async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/big.log`, 'x'.repeat(1_000_001))
  await start($)
  await write($, 'big.log', 'y'.repeat(1_000_002))
  expect((await entries($))[0]).toMatchObject({ isTooLarge: true, added: 0, removed: 0 })
  const saved = JSON.parse(bodyWrites(w)[0]!.text) as { before: unknown; after: unknown }
  expect(saved).toMatchObject({ before: null, after: null })
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(130) })
  must(await ui.find({ text: /too large to replay/ }), 'too large note')
  await ui.press({ key: 'revert' })
  must(await ui.find({ text: /big\.log was over 1 MB/ }), 'revert refusal')
  await ui.press({ key: 'ask' })
  expect(w.fills).toEqual(["About your edit to big.log (edit 1 of 1): the file was over 1 MB, so this edit's texts were not kept.\n"])
  await ui.unmount()
})

test('a NotebookEdit is recorded by its notebook path', WITH_PEEK, async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/nb.ipynb`, '{"cells":[]}\n')
  await start($)
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${ROOT}/nb.ipynb`, new_source: 'print(1)' } as never)
  expect((await entries($))[0]).toMatchObject({ tool: 'NotebookEdit', relPath: 'nb.ipynb', added: 1, removed: 1 })
})

test('a pane not placed says so in one toast with the record so far', async ($, on) => {
  const w = world(on)
  w.isPlaced = false
  await start($)
  expect((await command($)).text).toBe('Opening the changes pane.')
  await w.clock.settle()
  expect(w.toasts).toEqual(['The changes pane is waiting for room: the terminal is 90 columns, under 110. So far 0 edits · 0 files.'])
})

test('outside git, Project mode walks the folders, skipping node_modules', async ($, on) => {
  const w = world(on)
  w.isGitRepo = false
  w.dirs.set(ROOT, [
    { name: 'src', kind: 'dir' },
    { name: 'node_modules', kind: 'dir' },
    { name: 'README.md', kind: 'file' },
  ])
  w.dirs.set(`${ROOT}/src`, [{ name: 'app.js', kind: 'file' }])
  w.dirs.set(`${ROOT}/node_modules`, [{ name: 'dep.js', kind: 'file' }])
  w.files.set(`${ROOT}/src/app.js`, 'a\n')
  await start($)
  await edit($, 'src/app.js', 'a', 'b')
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(130) })
  await ui.press({ key: 'mode-project' })
  must(await ui.find({ key: 'f:README.md' }), 'README')
  must(await ui.find({ key: 'd:src' }), 'src')
  expect(await ui.find({ key: 'd:node_modules' })).toBeUndefined()
  await ui.unmount()
})

test('git names with non-ASCII letters match the touched file once', async ($, on) => {
  const w = world(on)
  w.gitFiles = ['café.txt', 'README.md']
  w.files.set(`${ROOT}/café.txt`, 'a\n')
  await start($)
  await edit($, 'café.txt', 'a', 'b')
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(130) })
  await ui.press({ key: 'mode-project' })
  expect(await ui.findAll({ key: 'f:café.txt' })).toHaveLength(1)
  expect(await ui.find({ text: /"caf/ })).toBeUndefined()
  await ui.unmount()
})

test('the screen keeps one gold chip: the mode chips are slate with a marker', async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/a.ts`, 'a\n')
  await start($)
  await edit($, 'a.ts', 'a', 'b')
  const ui = await $.ui.mount({ plugin: 'change-deck', surface: 'terminal', ...PANE, props: paneProps(130) })
  const gold = (await ui.findAll({ type: 'Text' })).filter(one => one.props.backgroundColor === GOLD)
  expect(gold.map(one => one.text.trim())).toEqual(['Next ›'])
  must(await ui.find({ text: /● Touched/ }), 'chosen mode')
  must(await ui.find({ text: /○ Project/ }), 'other mode')
  await ui.unmount()
})

test('/changes clear removes only the bodies it forgot, so a later edit keeps its own', WITH_PEEK, async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/a.ts`, 'a\n')
  await start($)
  await edit($, 'a.ts', 'a', 'b')
  await edit($, 'a.ts', 'b', 'c')
  await command($, 'clear')
  await edit($, 'a.ts', 'c', 'd')
  await w.clock.settle()
  const removed = w.runs.filter(argv => argv[0] === 'rm')
  expect(removed).toEqual([['rm', '-f', '--', `${DATA}/1.json`, `${DATA}/2.json`]])
  const list = await entries($)
  expect(list).toHaveLength(1)
  expect(list[0]?.file).toBe(`${DATA}/3.json`)
})
