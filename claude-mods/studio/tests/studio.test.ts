// studio through the engine: the band's states, the skins pane, the browser pane,
// image preview, and every pane's widths on the terminal and the desktop.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ConfigRow, HttpResponse, On, PromptOrigin, RenderElement, RenderSurface } from 'claude-code'

import { treeRows } from '../hooks/logic'

const START = 1_760_000_000_000
const HOME = '/home/dev'
const SURFACES = ['terminal', 'desktop'] as const
const WIDTHS = [36, 120] as const
/** What next(e) resolves to when nothing else draws above the prompt: core's own node. */
const ENGINE_NODE = { type: 'engine', ref: 0 } as unknown as RenderElement
/** A one-row band another plugin draws beneath studio's. */
const OTHER_BAND = { type: 'Text', props: {}, children: ['OTHER BAND'] } as unknown as RenderElement

type World = {
  clock: MockClock
  status: (string | undefined)[]
  toasts: string[]
  opened: string[]
  closed: string[]
  writes: { path: string; text: string }[]
  configSets: { key: string; value: unknown }[]
  fills: string[]
  copies: string[]
  fetched: string[]
  pages: Map<string, HttpResponse | 'fail'>
  failTools: number
  denyCustomTheme: boolean
  surfaces: RenderSurface[]
  /** Runs inside the next tool call, beneath the plugin, before it answers. */
  during: (() => Promise<void>) | null
  /** Runs inside the next prompt submit, beneath the plugin, before it enters or is dropped. */
  duringPrompt: (() => Promise<void>) | null
  /** A hook beneath drops every prompt with this reason (prompt-upgrade holding one back). */
  dropPrompts: string | null
  /** A hook beneath rewrites a prompt's text on its way in. */
  rewritePrompt: ((text: string) => string) | null
  /** Refuse the next tool calls (a guard's or the person's No). */
  denyTools: number
  /** What the prompt box holds. */
  draft: string
  /** Files that already exist. */
  existing: Set<string>
  /** What the chain beneath studio's band answers: core's own node, unless a test puts another plugin's band there. */
  belowBand: RenderElement
  /** Whether an image pane opened unasked finds room. */
  placeImage: boolean
  /** The slash commands this session has. */
  commands: string[]
  turnTexts: string[]
}

const THEME_ROW: ConfigRow = {
  key: 'theme',
  label: 'Theme',
  kind: 'choice',
  value: 'dark',
  options: ['dark', 'light', 'dark-daltonized'],
  provider: { plugin: 'engine', tier: 'core' },
  isLocked: false,
}

/** Stands for the engine beneath the plugin; `engine` raises what core raises on its own (a prompt's turn.start). */
function world(on: On, engine: Engine, env: Readonly<Record<string, string>> = {}): World {
  const w: World = {
    clock: mock.clock(on, { now: START }),
    status: [],
    toasts: [],
    opened: [],
    closed: [],
    writes: [],
    configSets: [],
    fills: [],
    copies: [],
    fetched: [],
    pages: new Map(),
    failTools: 0,
    denyCustomTheme: true,
    surfaces: ['terminal'],
    during: null,
    duringPrompt: null,
    dropPrompts: null,
    rewritePrompt: null,
    denyTools: 0,
    draft: '',
    existing: new Set(),
    belowBand: ENGINE_NODE,
    placeImage: true,
    commands: ['compact', 'clear', 'model', 'theme'],
    turnTexts: [],
  }
  let theme = 'dark'
  let turns = 0
  mock.store(on)
  mock.env(on, { HOME, ...env })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: w.surfaces }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Notification', () => ({}))
  // Core: a prompt submitted while idle enters and its turn starts before next(e) resolves.
  on('prompt.submit', async ($, e) => {
    const during = w.duringPrompt
    w.duringPrompt = null
    await during?.()
    if (w.dropPrompts !== null) return { drop: w.dropPrompts }
    const text = w.rewritePrompt === null ? e.text : w.rewritePrompt(e.text)
    if (e.turnId === undefined) {
      w.turnTexts.push(text)
      await engine.turn.start({ text, turnId: `t${++turns}` })
    }
    return { text }
  })
  on('command.list', () => ({ value: w.commands.map(name => ({ name, description: name, source: 'builtin' as const })) }))
  on('command.run', ($, e) => {
    if (e.command === 'theme') throw new Error('the theme picker is not here')
    return { text: '' }
  })
  on('prompt.read', () => ({ value: { text: w.draft, cursor: w.draft.length } }))
  on('fs.exists', ($, e) => ({ value: w.existing.has(e.path) }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.render', { component: 'AbovePrompt' }, () => w.belowBand)
  on('ui.status', ($, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    if (e.id === 'image' && !w.placeImage) return { value: { isPlaced: false as const, reason: 'opened unasked under 144 columns (100 now)' } }
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    w.copies.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('prompt.fill', ($, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('fs.write', ($, e) => {
    w.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('config.list', () => ({ value: [{ ...THEME_ROW, value: theme }] }))
  on('config.set', ($, e) => {
    w.configSets.push({ key: e.key, value: e.value })
    if (w.denyCustomTheme && String(e.value).startsWith('custom:')) return { deny: 'For custom themes, use /theme.' }
    theme = String(e.value)
    return { value: e.value }
  })
  on('http.fetch', ($, e) => {
    w.fetched.push(e.url)
    const page = w.pages.get(e.url)
    if (page === undefined || page === 'fail') return { deny: 'getaddrinfo ENOTFOUND' }
    return { value: page }
  })
  on('tool.call', async () => {
    const during = w.during
    w.during = null
    await during?.()
    if (w.denyTools > 0) {
      w.denyTools--
      return { deny: 'Blocked by a guard.' }
    }
    if (w.failTools > 0) {
      w.failTools--
      return { isError: true as const, result: 'exit 1', text: 'Exit code 1' }
    }
    return { result: {} as never, text: 'ok' }
  })
  return w
}

async function start($: Engine, w: World): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

function command($: Engine, name: string, args = '', isFullscreen = true) {
  return $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen, columns: 140 } })
}

function prompt($: Engine, text: string, origin: PromptOrigin = { kind: 'composer' }) {
  return $.prompt.submit({ text, wait: false, origin })
}

function turnEnd($: Engine, reason: 'answer' | 'aborted' = 'answer') {
  return $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason })
}

function bandProps(columns: number, maxRows: number, hasSurvey = false) {
  return {
    hasSurvey,
    isWorking: true,
    maxRows,
    bodyColumns: columns,
    scroll: { offset: 0, bodyRows: maxRows },
    view: {},
  }
}

function paneProps(columns: number) {
  return {
    title: 'studio',
    isFocused: false,
    bodyColumns: columns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  }
}

/** Whether core's own node is somewhere in a drawn tree. */
function holdsEngine(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(holdsEngine)
  const element = node as { type?: unknown; children?: unknown }
  return element.type === 'engine' || holdsEngine(element.children)
}

/** Every Text the band draws, at a width and a height, on a surface; mounting rejects a tree the surface refuses. */
async function band($: Engine, columns = 80, maxRows = 10, surface: RenderSurface = 'terminal', hasSurvey = false) {
  const ui = await $.ui.mount({ plugin: 'studio', surface, component: 'AbovePrompt', props: bandProps(columns, maxRows, hasSurvey) })
  const tree = await ui.drawn()
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  const own = await ui.find({ key: 'studio-band' })
  await ui.unmount()
  return { texts, joined: texts.join('|'), rows: own?.children.length ?? 0, tree, hasEngine: holdsEngine(tree) }
}

/** Only core's own node is drawn: studio's band is not there. */
async function expectNoBand($: Engine, columns = 80, maxRows = 10, surface: RenderSurface = 'terminal', hasSurvey = false) {
  const drawn = await band($, columns, maxRows, surface, hasSurvey)
  expect(drawn.joined).toBe('')
  expect(drawn.tree).toEqual(ENGINE_NODE)
}

function png(width: number, height: number): string {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 1, 2, 3, 4]
  return btoa(String.fromCharCode(...bytes))
}

function jpeg(width: number, height: number): string {
  const bytes = [0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]
  return btoa(String.fromCharCode(...bytes))
}

function pasteImage($: Engine, data: string, mediaType: string, uuid: string) {
  return $.session.append({
    message: {
      type: 'user',
      role: 'user',
      content: [
        { type: 'text', text: 'what is wrong here?' },
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
      ],
    },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid,
  })
}

function html(title: string, body: string): HttpResponse {
  return {
    status: 200,
    ok: true,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    text: `<html><head><title>${title}</title></head><body>${body}</body></html>`,
  }
}

const TODOS = [
  { content: 'Read the login code', status: 'completed' as const, activeForm: 'Reading' },
  { content: 'Fix the token check', status: 'in_progress' as const, activeForm: 'Fixing' },
  { content: 'Add a test', status: 'pending' as const, activeForm: 'Adding' },
  { content: 'Run the suite', status: 'pending' as const, activeForm: 'Running' },
]

// ---------------------------------------------------------------------------

test('band: working, needs you, stuck, stopped, and done hiding after 5 s', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)

  await expectNoBand($)

  await prompt($, 'Fix the login bug. Then run the tests')
  await w.clock.advance(72_000)
  let drawn = await band($)
  expect(drawn.joined).toContain('Fix the login bug · 1m 12s')
  expect(drawn.joined).toContain('Thinking')
  expect(drawn.hasEngine, "core's own node stays beneath the band").toBe(true)

  await $.tool.call({ tool: 'TodoWrite', todos: TODOS })
  let whileRunning = ''
  w.during = async () => {
    whileRunning = (await band($)).joined
  }
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.js', old_string: 'a', new_string: 'b' })
  expect(whileRunning).toContain('Edit app.js')
  drawn = await band($)
  expect(drawn.joined).toContain('Thinking')
  expect(drawn.texts.filter(text => text.startsWith('✓'))).toHaveLength(1)
  expect(drawn.texts.filter(text => text.startsWith('▶'))).toHaveLength(1)
  expect(drawn.joined).toContain('Next   ')
  expect(drawn.joined).toContain('Up next')
  expect(drawn.joined).toContain('Working')

  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  drawn = await band($)
  expect(drawn.joined).toContain('Needs you · permission to use Bash')

  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' })
  drawn = await band($)
  expect(drawn.joined).not.toContain('Needs you')

  w.failTools = 3
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' })
  drawn = await band($)
  expect(drawn.joined).toContain('The last 3 tool calls failed · Bash npm test')

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  drawn = await band($)
  expect(drawn.joined).not.toContain('failed')

  await turnEnd($, 'answer')
  drawn = await band($)
  expect(drawn.joined).toContain('All done · Fix the login bug · took')
  await w.clock.advance(4_000)
  expect((await band($)).joined).toContain('All done')
  await w.clock.advance(1_500)
  await expectNoBand($)

  await prompt($, 'Refactor the parser')
  await turnEnd($, 'aborted')
  drawn = await band($)
  expect(drawn.joined).toContain('Stopped · Refactor the parser · you pressed Esc')
})

test('band yields to a survey and when switched off; never wider or taller than given', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  await prompt($, 'Ship the release notes')
  const many = Array.from({ length: 12 }, (_, i) => ({
    content: `Step number ${i + 1} with a long and winding description`,
    status: (i < 4 ? 'completed' : i === 4 ? 'in_progress' : 'pending') as 'completed' | 'in_progress' | 'pending',
    activeForm: 'x',
  }))
  await $.tool.call({ tool: 'TodoWrite', todos: many })

  await expectNoBand($, 80, 10, 'terminal', true)

  for (const surface of SURFACES) {
    for (const columns of [32, 120]) {
      for (const maxRows of [3, 10]) {
        const drawn = await band($, columns, maxRows, surface)
        expect(drawn.rows).toBeGreaterThan(0)
        expect(drawn.rows).toBeLessThanOrEqual(Math.min(maxRows, 8))
        for (const text of drawn.texts) expect(Array.from(text).length).toBeLessThanOrEqual(columns)
      }
    }
  }

  const answer = await command($, 'progress', 'off')
  expect(answer.text).toBe('The progress band is off.')
  await w.clock.settle()
  await expectNoBand($)
  expect((await command($, 'progress')).text).toContain('off')
})

test('skins pane lists the themes from config.list and Use calls config.set', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  const answer = await command($, 'skin')
  expect(answer.text).toBe('Opening skins.')
  await w.clock.settle()
  expect(w.opened).toContain('skins')

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', component: 'Pane', requestId: 'skins', props: paneProps(80) })
  expect(await ui.find({ text: /S K I N S/ })).toBeDefined()
  expect(await ui.find({ text: /^Dark +$/ })).toBeDefined()
  expect(await ui.find({ text: /^Light +$/ })).toBeDefined()
  expect(await ui.find({ text: /Dark daltonized/ })).toBeDefined()
  expect(await ui.find({ text: /Gold & Slate/ })).toBeDefined()

  await ui.press({ key: 'use:light' })
  await w.clock.settle()
  expect(w.configSets).toEqual([{ key: 'theme', value: 'light' }])
  expect(await ui.find({ text: /Theme set to Light/ })).toBeDefined()

  await ui.press({ key: 'use:custom:gold-and-slate' })
  await w.clock.settle()
  expect(w.writes.map(one => one.path)).toEqual([`${HOME}/.claude/themes/gold-and-slate.json`])
  expect(JSON.parse(w.writes[0]?.text ?? '{}')).toMatchObject({ name: 'Gold & Slate', base: 'dark', overrides: { claude: '#F2C46D' } })
  expect(w.configSets.at(-1)).toEqual({ key: 'theme', value: 'custom:gold-and-slate' })
  expect(await ui.find({ text: /^Saved Gold & Slate to ~\/\.claude\/themes\. Pick it in \/theme\.$/ })).toBeDefined()
  expect(await ui.find({ text: /^The theme setting said: For custom themes, use \/theme\.$/ })).toBeDefined()
  expect(await ui.find({ key: 'open-theme' })).toBeDefined()

  await ui.press({ key: 'accent:teal' })
  await w.clock.settle()
  const status = await command($, 'studio')
  expect(status.text).toContain('accent Teal')
  await ui.unmount()
})

test('browse: a link press loads the new page, Back returns, a failed fetch shows the error card', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  w.pages.set('https://example.com/docs', html('Docs home', '<h1>Docs</h1><p>See the <a href="/guide">guide</a>.</p>'))
  w.pages.set('https://example.com/guide', html('The guide', '<h1>Guide</h1><p>Step one.</p><a href="https://broken.example/">broken</a>'))
  w.pages.set('https://broken.example/', 'fail')

  expect((await command($, 'browse', 'hello there')).text).toBe('Type a full web address, like /browse docs.python.org.')
  expect((await command($, 'browse', 'example.com/docs')).text).toBe('Opening example.com…')
  await w.clock.settle()
  expect(w.opened).toContain('browse')
  expect(w.fetched).toEqual(['https://example.com/docs'])

  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', component: 'Pane', requestId: 'browse', props: paneProps(100) })
  expect(await ui.find({ text: /^Docs home$/ })).toBeDefined()
  const page = await ui.find({ key: 'page' })
  expect(page?.text).toContain('[guide](https://example.com/guide)')
  expect(await ui.find({ key: 'back' })).toBeUndefined()

  await ui.press({ key: 'page', link: { href: 'https://example.com/guide' } })
  await w.clock.settle()
  expect(w.fetched.at(-1)).toBe('https://example.com/guide')
  expect(await ui.find({ text: /^The guide$/ })).toBeDefined()
  expect((await ui.find({ key: 'page' }))?.text).toContain('# Guide')

  await ui.press({ key: 'back' })
  await w.clock.settle()
  expect(w.fetched.at(-1)).toBe('https://example.com/docs')
  expect(await ui.find({ text: /^Docs home$/ })).toBeDefined()

  await ui.press({ key: 'copy' })
  expect(w.copies.at(-1)).toContain('# Docs')

  await ui.press({ key: 'page', link: { href: 'https://example.com/guide' } })
  await ui.press({ key: 'page', link: { href: 'https://broken.example/' } })
  await w.clock.settle()
  const card = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(card, 'the error card').toContain("Couldn't load broken.example: getaddrinfo ENOTFOUND.")
  expect(await ui.find({ key: 'retry' })).toBeDefined()
  expect(await ui.find({ key: 'close' })).toBeDefined()

  w.pages.set('https://broken.example/', html('Fixed', '<p>Back up.</p>'))
  await ui.press({ key: 'retry' })
  await w.clock.settle()
  expect(await ui.find({ text: /^Fixed$/ })).toBeDefined()

  await ui.press({ key: 'send' })
  expect(w.fills.at(-1)?.startsWith('From Fixed (https://broken.example/):\n\n')).toBe(true)
  expect(w.closed).toContain('browse')
  await ui.unmount()
})

test('image preview: a status line by default, the pane on a fullscreen terminal, /preview', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)

  expect((await command($, 'preview', '', false)).text).toContain('No image yet')

  await pasteImage($, png(1280, 720), 'image/png', 'u1')
  await w.clock.settle()
  expect(w.status.at(-1)).toBe('image attached · 1280×720 · 33 B')
  expect(w.opened).not.toContain('image')
  await w.clock.advance(10_000)
  expect(w.status.at(-1)).toBeUndefined()

  const shown = await command($, 'preview', '', true)
  expect(shown.text).toBe('Showing image.png · 1280×720 · 33 B.')
  await w.clock.settle()
  expect(w.opened).toContain('image')

  w.opened.length = 0
  await pasteImage($, png(64, 64), 'image/png', 'u2')
  await w.clock.settle()
  expect(w.opened).toEqual(['image'])

  w.opened.length = 0
  await pasteImage($, jpeg(640, 480), 'image/jpeg', 'u3')
  await w.clock.settle()
  expect(w.opened).toEqual([])
  expect(w.status.at(-1)).toBe('image attached · 640×480 · 23 B')
  expect((await command($, 'preview')).text).toBe('Last image: image.jpg · 640×480 · 23 B (the terminal draws PNG pictures only).')

  expect((await command($, 'preview', 'off')).text).toBe('Image preview is off.')
  await w.clock.settle()
  const before = w.status.length
  await pasteImage($, png(10, 10), 'image/png', 'u4')
  await w.clock.settle()
  expect(w.status.length).toBe(before)
})

test('every pane and the band draw on terminal and desktop, narrow and wide, no Text past the width', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  await prompt($, 'Make every pane fit its width no matter how long the words get')
  await $.tool.call({ tool: 'TodoWrite', todos: TODOS })
  await command($, 'skin')
  await pasteImage($, png(1280, 720), 'image/png', 'u1')
  w.pages.set(
    'https://example.com/a-very-long-path/that-keeps-going',
    html('A page title that is much longer than any narrow pane could ever hold', '<h1>Title</h1><p>Text.</p>'),
  )
  await command($, 'browse', 'example.com/a-very-long-path/that-keeps-going')
  await w.clock.settle()

  const check = async (surface: RenderSurface, columns: number, requestId: string | null) => {
    const ui =
      requestId === null
        ? await $.ui.mount({ plugin: 'studio', surface, component: 'AbovePrompt', props: bandProps(columns, 10) })
        : await $.ui.mount({ plugin: 'studio', surface, component: 'Pane', requestId, props: paneProps(columns) })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.length).toBeGreaterThan(0)
    for (const one of texts) {
      expect(Array.from(one.text).length, `${requestId ?? 'band'} on ${surface} at ${columns}: "${one.text}"`).toBeLessThanOrEqual(columns)
    }
    await ui.unmount()
  }

  for (const surface of SURFACES) {
    for (const columns of WIDTHS) {
      await check(surface, columns, null)
      await check(surface, columns, 'skins')
      await check(surface, columns, 'image')
      await check(surface, columns, 'browse')
    }
  }

  // The error card and the loading line too.
  w.pages.set('https://example.com/down', 'fail')
  await command($, 'browse', 'example.com/down')
  await w.clock.settle()
  for (const surface of SURFACES) for (const columns of WIDTHS) await check(surface, columns, 'browse')

  const terminal = await $.ui.mount({ plugin: 'studio', surface: 'terminal', component: 'Pane', requestId: 'image', props: paneProps(60) })
  const picture = await terminal.find({ type: 'Image' })
  expect(picture?.props.alt).toBe('image.png · 1280×720 · 33 B')
  expect(picture?.props.columns).toBe(60)
  await terminal.unmount()
  const desktop = await $.ui.mount({ plugin: 'studio', surface: 'desktop', component: 'Pane', requestId: 'image', props: paneProps(60) })
  expect(await desktop.find({ type: 'Image' })).toBeUndefined()
  expect(await desktop.find({ text: /1280×720/ })).toBeDefined()
  await desktop.unmount()
})

// ---------------------------------------------------------------------------
// Prompts other plugins send, prompts they drop, and the band beside another

const UPGRADE_AS_USER: PromptOrigin = { kind: 'plugin', name: 'prompt-upgrade', asUser: true }

test('a prompt a plugin sends as the person starts a job; its own prompts and notifications do not', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)

  await prompt($, 'Make the parser faster', UPGRADE_AS_USER)
  expect((await band($)).joined).toContain('Make the parser faster · 0s')
  await turnEnd($, 'answer')
  await w.clock.advance(5_500)
  await expectNoBand($)

  await prompt($, 'Summarise the notes', { kind: 'plugin', name: 'workbench' })
  await expectNoBand($)
  await prompt($, 'Task 3 finished', { kind: 'task-notification' })
  await expectNoBand($)
})

test('a prompt a hook beneath drops starts no job, not even for a moment, and the band before it stays', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  await prompt($, 'First job here')
  await turnEnd($, 'aborted')
  expect((await band($)).joined).toContain('Stopped · First job here · you pressed Esc')

  let during = ''
  w.dropPrompts = 'held back for an upgrade'
  w.duringPrompt = async () => {
    during = (await band($)).joined
  }
  const answer = await prompt($, 'Make the parser faster please')
  expect(answer.drop).toBe('held back for an upgrade')
  expect(during).toContain('Stopped · First job here')
  expect(during).not.toContain('Make the parser')
  const after = (await band($)).joined
  expect(after).toContain('Stopped · First job here')
  expect(after).not.toContain('Make the parser')

  // The upgraded prompt sent in its place, as the person's, is the job.
  w.dropPrompts = null
  await prompt($, 'Make the parser faster, keeping its API', UPGRADE_AS_USER)
  expect((await band($)).joined).toContain('Make the parser faster · 0s')
})

test('a prompt a hook beneath rewrites still starts its job, named as the person wrote it', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  w.rewritePrompt = text => `${text}\n\nKeep the answer short.`
  await prompt($, 'Tidy the imports')
  expect(w.turnTexts).toEqual(['Tidy the imports\n\nKeep the answer short.'])
  expect((await band($)).joined).toContain('Tidy the imports · 0s')
})

test("a prompt folded into the running turn is never claimed by a later turn; a queued one still gets its job", { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  await prompt($, 'Fix the build')
  // Typed over t1 and delivered into it: it gets no turn of its own.
  await $.prompt.submit({ text: 'also check lint', wait: false, origin: { kind: 'composer' }, turnId: 't1' })
  await turnEnd($, 'answer')
  await w.clock.advance(5_500)
  await expectNoBand($)
  // A plugin's own prompt, then a scheduled one, with the folded prompt's words: neither is a job.
  await prompt($, 'also check lint', { kind: 'plugin', name: 'other' })
  await expectNoBand($)
  await turnEnd($, 'answer')
  await prompt($, 'also check lint', { kind: 'scheduled-trigger' })
  await expectNoBand($)
  await turnEnd($, 'answer')

  // A prompt typed mid-turn that waits for its own turn starts its job when that turn starts.
  await prompt($, 'Tidy the imports')
  await $.prompt.submit({ text: 'Then update the changelog', wait: true, origin: { kind: 'composer' }, turnId: 't4' })
  await turnEnd($, 'answer')
  await $.turn.start({ text: 'Then update the changelog', turnId: 't5' })
  expect((await band($)).joined).toContain('Then update the changelog · 0s')
})

test('a prompt that starts with a path or a word that is no command starts a job; a command does not', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  await prompt($, '/tmp is full, clean it up')
  expect((await band($)).joined).toContain('/tmp is full · 0s')
  await turnEnd($, 'answer')
  await w.clock.advance(5_500)
  await prompt($, '/compact keep the plan')
  await expectNoBand($)
})

test('a refused tool call neither counts toward Stuck nor clears it', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  await prompt($, 'Run the suite')
  w.failTools = 2
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  w.denyTools = 1
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect((await band($)).joined).not.toContain('failed')
  w.failTools = 1
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect((await band($)).joined).toContain('The last 3 tool calls failed · Bash npm test')
  w.denyTools = 1
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect((await band($)).joined).toContain('The last 3 tool calls failed')
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect((await band($)).joined).not.toContain('failed')
})

test('a plugin notification is not a wait on the person; a permission prompt is', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  await prompt($, 'Build it')
  await $.classic.Notification({ message: 'Build finished in 3m', notification_type: 'plugin_notification' })
  expect((await band($)).joined).not.toContain('Needs you')
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  expect((await band($)).joined).toContain('Needs you · permission to use Bash')
})

test('escape sequences pasted into a prompt never reach the band', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  await prompt($, '\u001b[31mTypeError\u001b[0m in parser, fix it\n\u001b[2mat line 3\u001b[0m')
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: '\u001b[32mGreen step\u001b[0m', status: 'in_progress', activeForm: 'x' }] })
  let whileRunning = ''
  w.during = async () => {
    whileRunning = (await band($)).joined
  }
  await $.tool.call({ tool: 'Bash', command: 'printf "\u001b[1mbold\u001b[0m"' })
  expect(whileRunning).toContain('Bash printf "bold"')
  await $.classic.Notification({ message: 'Claude needs your permission to use \u001b[1mBash\u001b[0m', notification_type: 'permission_prompt' })
  const drawn = await band($)
  expect(drawn.joined).toContain('Needs you · permission to use Bash')
  expect(drawn.joined).toContain('TypeError in parser')
  expect(drawn.joined).toContain('Green step')
  expect(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(drawn.joined)).toBe(false)
})

test("studio's band and the band beneath it together stay within maxRows", { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  w.belowBand = {
    type: 'Box',
    props: { flexDirection: 'column' },
    children: [
      { type: 'Text', props: {}, children: ['OTHER 1'] },
      { type: 'Text', props: {}, children: ['OTHER 2'] },
    ],
  } as unknown as RenderElement
  await prompt($, 'Ship the release notes')
  const many = Array.from({ length: 8 }, (_, i) => ({
    content: `Step ${i + 1}`,
    status: (i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending') as 'completed' | 'in_progress' | 'pending',
    activeForm: 'x',
  }))
  await $.tool.call({ tool: 'TodoWrite', todos: many })
  for (const maxRows of [3, 4, 6, 10]) {
    const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80, maxRows) })
    const tree = await ui.drawn()
    const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
    expect(treeRows(tree), `rows at maxRows ${maxRows}`).toBeLessThanOrEqual(maxRows)
    expect(texts).toContain('OTHER 1')
    expect(texts).toContain('OTHER 2')
    expect(texts.join('|')).toContain('Ship the release notes')
    await ui.unmount()
  }
  // The band beneath already fills the room: studio's steps aside rather than push past it.
  const full = await band($, 80, 2)
  expect(full.joined).toBe('OTHER 1|OTHER 2')
})

test("the band draws above core's own node, which the surface takes, at every width and height", { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  await prompt($, 'Ship the release notes')
  await $.tool.call({ tool: 'TodoWrite', todos: TODOS })
  for (const surface of SURFACES) {
    for (const columns of [32, 120]) {
      for (const maxRows of [1, 2, 4, 8]) {
        const drawn = await band($, columns, maxRows, surface)
        const where = `${surface} at ${columns}×${maxRows}`
        expect(drawn.joined, where).toContain('Ship the release')
        expect(drawn.hasEngine, `core's node beneath on ${where}`).toBe(true)
        expect(treeRows(drawn.tree), `rows on ${where}`).toBeLessThanOrEqual(maxRows)
        for (const text of drawn.texts) expect(Array.from(text).length, `${where}: "${text}"`).toBeLessThanOrEqual(columns)
      }
    }
  }
})

test('a one-row band beneath keeps its row and studio takes what is left of maxRows', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  w.belowBand = OTHER_BAND
  await prompt($, 'Ship the release notes')
  await $.tool.call({ tool: 'TodoWrite', todos: TODOS })
  // One row of room, and the band beneath takes it: studio's steps aside.
  expect((await band($, 80, 1)).joined).toBe('OTHER BAND')
  for (const maxRows of [2, 3, 4, 8]) {
    const drawn = await band($, 80, maxRows)
    expect(treeRows(drawn.tree), `rows at maxRows ${maxRows}`).toBeLessThanOrEqual(maxRows)
    expect(drawn.rows, `studio's rows at maxRows ${maxRows}`).toBeGreaterThan(0)
    expect(drawn.rows, `studio's rows at maxRows ${maxRows}`).toBeLessThanOrEqual(maxRows - 1)
    expect(drawn.texts.at(-1)).toBe('OTHER BAND')
    expect(drawn.joined).toContain('Ship the release notes')
  }
})

test('/theme failing from the skins pane is said in a toast', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  await command($, 'skin')
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', component: 'Pane', requestId: 'skins', props: paneProps(80) })
  await ui.press({ key: 'use:custom:gold-and-slate' })
  await w.clock.settle()
  await ui.press({ key: 'open-theme' })
  await w.clock.settle()
  expect(w.toasts.some(text => text.includes('Type /theme to pick Gold & Slate'))).toBe(true)
  await ui.unmount()
})

test('Gold & Slate already saved is used as it is, never overwritten', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  w.existing.add(`${HOME}/.claude/themes/gold-and-slate.json`)
  await command($, 'skin')
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', component: 'Pane', requestId: 'skins', props: paneProps(100) })
  await ui.press({ key: 'use:custom:gold-and-slate' })
  await w.clock.settle()
  expect(w.writes).toEqual([])
  expect(w.configSets.at(-1)).toEqual({ key: 'theme', value: 'custom:gold-and-slate' })
  expect(await ui.find({ text: /^Gold & Slate is already in ~\/\.claude\/themes \(kept as it is\)\. Pick it in \/theme\.$/ })).toBeDefined()
  await ui.unmount()
})

test('a CLAUDE_CONFIG_DIR that is no full path writes nothing', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $, { CLAUDE_CONFIG_DIR: '~/.claude-work' })
  await start($, w)
  await command($, 'skin')
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', component: 'Pane', requestId: 'skins', props: paneProps(120) })
  await ui.press({ key: 'use:custom:gold-and-slate' })
  await w.clock.settle()
  expect(w.writes).toEqual([])
  expect(await ui.find({ text: /CLAUDE_CONFIG_DIR is not a full path/ })).toBeDefined()
  await ui.unmount()
})

test('Send to Claude starts the page on a new paragraph after a draft', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  w.pages.set('https://example.com/', html('Docs home', '<p>Hello.</p>'))
  await command($, 'browse', 'example.com')
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: 'studio', surface: 'terminal', component: 'Pane', requestId: 'browse', props: paneProps(100) })
  w.draft = 'summarize this'
  await ui.press({ key: 'send' })
  expect(w.fills.at(-1)?.startsWith('\n\nFrom Docs home (https://example.com/):\n\nHello.')).toBe(true)
  w.draft = ''
  await ui.press({ key: 'send' })
  expect(w.fills.at(-1)?.startsWith('From Docs home')).toBe(true)
  await ui.unmount()
})

test("the layout comes from any command the person runs, not only studio's", { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  await $.command.run({ command: 'model', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  await pasteImage($, png(1280, 720), 'image/png', 'u1')
  await w.clock.settle()
  expect(w.opened).toEqual(['image'])
})

test('an image pane with no room closes again: the status line says it, no toast', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  w.placeImage = false
  await command($, 'studio', '', true)
  await pasteImage($, png(1280, 720), 'image/png', 'u1')
  await w.clock.settle()
  expect(w.opened).toEqual(['image'])
  expect(w.closed).toEqual(['image'])
  expect(w.toasts).toEqual([])
  expect(w.status.at(-1)).toBe('image attached · 1280×720 · 33 B')
})

test('/clear clears the band and the last image', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, $)
  await start($, w)
  await prompt($, 'Refactor the parser')
  await turnEnd($, 'aborted')
  await pasteImage($, png(64, 64), 'image/png', 'u1')
  await w.clock.settle()
  expect((await band($)).joined).toContain('Stopped · Refactor the parser')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await w.clock.settle()
  await expectNoBand($)
  expect((await command($, 'preview', '', false)).text).toContain('No image yet')
})
