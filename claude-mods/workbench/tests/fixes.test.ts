// The review's findings, each pinned by a test that failed before its fix.

import { expect, mock, test } from 'claude-code/testing'

import {
  ALL_INTRO,
  FILL_NOTE,
  TOOL_NAME,
  TOOL_OFF_DESCRIPTION,
  allIdeasPrompt,
  appendLearned,
  cleanSuggestion,
  looksSecret,
  offersTool,
  parseReflect,
  sentIdeaIds,
  treeRows,
} from '../hooks/logic'
import {
  ASSUME,
  BAND,
  ENGINE_NODE,
  OTHER_BAND,
  REFLECT,
  ROOT,
  SHELF,
  bandProps,
  command,
  note,
  paneProps,
  personSends,
  shelfOf,
  start,
  turnEnds,
  turnStarts,
  widthsFit,
  world,
} from './world'

const CORRECTION_ROWS = "Some of your guesses were wrong. Please fix these:\n1. You assumed we keep the old API. That's wrong: drop it."

async function guessKeys(ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined }[]> }, prefix: string): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).map(one => one.key ?? '').filter(key => key.startsWith(prefix))
}

// ── Pure logic ─────────────────────────────────────────────────────────────

test('a filled idea counts as sent only when the prompt carries it whole, not inside a sentence', async () => {
  const ideas = [{ id: 'a', text: 'add tests', at: 0 }]
  expect(sentIdeaIds('remove the debug logging, then add tests for the parser', ideas, ['a'])).toEqual([])
  expect(sentIdeaIds('add tests\n\nand keep it short', ideas, ['a'])).toEqual(['a'])
})

test('Send all’s numbered rows count as sent only under its opening line, and only whole', async () => {
  const ideas = [
    { id: 'a', text: 'first thought', at: 10 },
    { id: 'b', text: 'a second idea\nover two lines', at: 20 },
  ]
  const list = allIdeasPrompt(ideas)
  expect(sentIdeaIds(list, ideas, ['a', 'b'])).toEqual(['a', 'b'])
  expect(sentIdeaIds(`fix the build first\n\n${list}`, ideas, ['a', 'b'])).toEqual(['a', 'b'])
  // A numbered list of the person's own, without Send all's opening line, takes nothing.
  expect(sentIdeaIds('1. first thought\n2. something else', ideas, ['a', 'b'])).toEqual([])
  // Under the opening line, an idea inside a sentence is still not taken.
  expect(sentIdeaIds(`${ALL_INTRO}\n1. not the first thought\n2. my first thought on it`, ideas, ['a', 'b'])).toEqual([])
})

test('cleanSuggestion keeps code spans at both ends; a fence inside a line survives parsing', async () => {
  expect(cleanSuggestion('`pnpm test` runs the suite; lint with `pnpm lint`')).toBe('`pnpm test` runs the suite; lint with `pnpm lint`')
  expect(cleanSuggestion('"Use pnpm, not npm"')).toBe('Use pnpm, not npm')
  expect(parseReflect('{"lines":[{"text":"`bun test` is the runner, not `jest`","why":"x"}]}')).toEqual([
    { text: '`bun test` is the runner, not `jest`', why: 'x' },
  ])
  expect(parseReflect('{"lines":[{"text":"Wrap code in ```ts fences","why":""}]}')?.[0]?.text).toBe('Wrap code in ```ts fences')
  expect(parseReflect('Here:\n```json\n{"lines":[{"text":"Keep it","why":""}]}\n```\nDone.')?.[0]?.text).toBe('Keep it')
})

test('appendLearned ignores headings inside code fences and keeps every existing row as it was', async () => {
  const fenced = '# Proj\n\n## Learned\n\n- Use pnpm\n\n```bash\n# run the tests\npnpm test\n```\n'
  expect(appendLearned(fenced, ['Keep migrations reversible']).text).toBe(
    '# Proj\n\n## Learned\n\n- Use pnpm\n\n```bash\n# run the tests\npnpm test\n```\n- Keep migrations reversible\n',
  )
  const decoy = '# P\n\n```md\n## Learned\n```\n\nMore notes\n'
  expect(appendLearned(decoy, ['A rule']).text).toBe('# P\n\n```md\n## Learned\n```\n\nMore notes\n\n## Learned\n\n- A rule\n')
  const mixed = '# P\r\nline one\nline two\r\n'
  expect(appendLearned(mixed, ['A rule']).text).toBe('# P\r\nline one\nline two\r\n\r\n## Learned\r\n\r\n- A rule\r\n')
  expect(appendLearned('## Learned\n## Other\n', ['A rule']).text).toBe('## Learned\n\n- A rule\n\n## Other\n')
  expect(appendLearned('# P\n\n## Learned\n\n- a', ['A rule']).text).toBe('# P\n\n## Learned\n\n- a\n- A rule\n')
})

test('the secret filter keeps long word-like names and still drops random keys', async () => {
  expect(looksSecret('Run scripts/regenerate_fixtures_for_parser_v3.sh after schema changes')).toBe(false)
  expect(looksSecret('Name tests like test_authentication_flow_handles_v2_tokens')).toBe(false)
  expect(looksSecret('Use the key Zx8Kq2LmN4pR7sT1vW3yB6cD9fG0hJ5kAb12 for staging')).toBe(true)
  expect(looksSecret('Pin commit e83c5163316f89bfbde7d9ab23ca2e25604af290')).toBe(true)
})

test('the compose section follows workbench’s own tool only', async () => {
  expect(offersTool([TOOL_NAME])).toBe(true)
  expect(offersTool(['mcp__other__note_assumption'])).toBe(false)
})

// ── Corrections and filled ideas ───────────────────────────────────────────

test('corrections filled while Claude works keep the marks until that text is sent', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await turnStarts($, 't1')
  await note($, 'we keep the old API')
  await note($, 'logs go to stdout')
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...ASSUME, props: paneProps(80) })
  const [wrong] = await guessKeys(ui, 'wrong-')
  const [, right] = await guessKeys(ui, 'right-')
  await ui.press({ key: wrong! })
  await ui.input({ key: `fix-${wrong!.slice('wrong-'.length)}`, text: 'drop it', kind: 'change' })
  await ui.press({ key: right! })
  await ui.press({ key: 'send-corrections' })
  expect(w.fills).toEqual([CORRECTION_ROWS])
  expect(await ui.find({ text: FILL_NOTE })).toBeDefined()
  // Still there, the typed correction too: nothing was sent yet.
  expect(await ui.find({ text: '2 of 2 checked' })).toBeDefined()
  expect(await ui.find({ key: `fix-${wrong!.slice('wrong-'.length)}`, text: 'drop it' })).toBeDefined()

  // A second press does not put the same text in the box twice.
  await ui.press({ key: 'send-corrections' })
  expect(w.fills).toHaveLength(1)

  await personSends($, w.box)
  expect(await ui.find({ text: /old API/ })).toBeUndefined()
  expect(await ui.find({ text: /No guesses to check/ })).toBeDefined()
  await ui.unmount()
})

test('a filled idea is not taken by a later prompt that merely mentions it, and Send twice fills once', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await command($, 'idea', 'add tests')
  const [idea] = shelfOf(w, ROOT)
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...SHELF, props: paneProps(80) })
  await turnStarts($, 't1')
  await ui.press({ key: `send-${idea!.id}` })
  await ui.press({ key: `send-${idea!.id}` })
  expect(w.fills).toEqual(['add tests'])
  expect(w.box).toBe('add tests')

  // The person clears the box and sends something else: the idea stays parked.
  await personSends($, 'look at the failing build first')
  await turnEnds($, 't1')
  await personSends($, 'remove the debug logging, then add tests for the parser')
  expect(shelfOf(w, ROOT).map(one => one.text)).toEqual(['add tests'])
  await ui.unmount()
})

test('Send all while Claude works: the ideas leave once the person sends that text unchanged', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await command($, 'idea', 'first thought')
  await clock.advance(60_000)
  await command($, 'idea', 'second thought')
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...SHELF, props: paneProps(80) })
  await turnStarts($, 't1')
  await ui.press({ key: 'send-all' })
  expect(w.fills).toEqual([`${ALL_INTRO}\n1. first thought\n2. second thought`])
  expect(w.submits).toEqual([])
  expect(shelfOf(w, ROOT)).toHaveLength(2)
  await turnEnds($, 't1')
  await personSends($, w.box)
  expect(shelfOf(w, ROOT)).toEqual([])
  await ui.unmount()
})

test('an idea held by another plugin and sent on by it still leaves the shelf', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await command($, 'idea', 'rename the config loader')
  const [idea] = shelfOf(w, ROOT)
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...SHELF, props: paneProps(80) })
  await turnStarts($, 't1')
  await ui.press({ key: `send-${idea!.id}` })
  await turnEnds($, 't1')
  w.holdsComposer = true
  await personSends($, 'rename the config loader')
  expect(shelfOf(w, ROOT)).toHaveLength(1)
  await $.prompt.submit({ text: 'rename the config loader', origin: { kind: 'plugin', name: 'prompt-upgrade' }, wait: false })
  expect(shelfOf(w, ROOT)).toEqual([])
  await ui.unmount()
})

// ── The band ───────────────────────────────────────────────────────────────

test('the band counts the guesses still to check since it was last dismissed', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on)
  await start($)
  await turnStarts($, 't1')
  await note($, 'port 3000')
  await note($, 'use zod')
  await turnEnds($, 't1')
  let band = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...BAND, props: bandProps(120) })
  expect(await band.find({ text: /Claude made 2 guesses/ })).toBeDefined()
  await band.press({ key: 'dismiss' })
  await band.unmount()

  await turnStarts($, 't2')
  await note($, 'tests live in __tests__')
  await turnEnds($, 't2')
  band = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...BAND, props: bandProps(120) })
  expect(await band.find({ text: /Claude made 1 guess / })).toBeDefined()
  await band.unmount()
})

test('a guess a helper noted between turns is announced when the next turn ends', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on)
  await start($)
  await turnStarts($, 't1')
  await turnEnds($, 't1')
  await note($, 'the cache is per process', undefined, 'agent-bg-1')
  await turnStarts($, 't2')
  await turnEnds($, 't2')
  const band = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...BAND, props: bandProps(120) })
  expect(await band.find({ text: /Claude made 1 guess / })).toBeDefined()
  await band.unmount()
})

test('the band draws on top of what is beneath it, never in its place; it yields without room', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.below = OTHER_BAND
  await start($)
  await turnStarts($, 't1')
  await note($, 'port 3000')
  await turnEnds($, 't1')
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'workbench', surface, ...BAND, props: bandProps(120) })
    expect(await band.find({ text: /Claude made 1 guess/ })).toBeDefined()
    expect(await band.find({ text: 'OTHER BAND' })).toBeDefined()
    await band.unmount()
    const cramped = await $.ui.mount({ plugin: 'workbench', surface, ...BAND, props: bandProps(120, false, 0) })
    expect(await cramped.find({ text: /guess/ })).toBeUndefined()
    expect(await cramped.find({ text: 'OTHER BAND' })).toBeDefined()
    await cramped.unmount()
  }
})

/** The Boxes above an engine node that carry a prop the engine refuses there. */
function sizedAboveEngine(node: unknown, sized: string[] = []): string[] {
  if (typeof node !== 'object' || node === null) return []
  if (Array.isArray(node)) return node.flatMap(one => sizedAboveEngine(one, sized))
  const { type, props = {}, children } = node as { type?: string; props?: Record<string, unknown>; children?: unknown }
  if (type === 'engine') return sized
  const here = type === 'Box' ? REFUSED_ABOVE_ENGINE.filter(name => props[name] !== undefined) : []
  return sizedAboveEngine(children ?? [], [...sized, ...here])
}

const REFUSED_ABOVE_ENGINE = ['width', 'height', 'minWidth', 'minHeight', 'display', 'overflow', 'position', 'top', 'left', 'right', 'bottom']

test('over the engine’s own node the band shows: nothing above that node has a size', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  expect(w.below).toEqual(ENGINE_NODE)
  await start($)
  await turnStarts($, 't1')
  await note($, 'port 3000')
  await turnEnds($, 't1')
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const columns of [32, 120]) {
      // A sized Box above the engine node is refused whole: mount then finds nothing workbench drew.
      const band = await $.ui.mount({ plugin: 'workbench', surface, ...BAND, props: bandProps(columns, false, 1) })
      expect(await band.find({ text: /guess/ })).toBeDefined()
      const tree = await band.drawn()
      expect(JSON.stringify(tree)).toContain('"type":"engine"')
      expect(sizedAboveEngine(tree)).toEqual([])
      await widthsFit(band, columns)
      await band.unmount()
    }
  }
})

test('the band takes only the rows maxRows leaves over the band beneath it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.below = OTHER_BAND
  await start($)
  await turnStarts($, 't1')
  await note($, 'port 3000')
  await turnEnds($, 't1')
  expect(treeRows(OTHER_BAND)).toBe(1)
  expect(treeRows(ENGINE_NODE)).toBe(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    // One row, held by the band beneath: workbench draws nothing of its own.
    const full = await $.ui.mount({ plugin: 'workbench', surface, ...BAND, props: bandProps(120, false, 1) })
    expect(await full.find({ text: /guess/ })).toBeUndefined()
    expect(await full.find({ text: 'OTHER BAND' })).toBeDefined()
    expect(treeRows(await full.drawn())).toBeLessThanOrEqual(1)
    await full.unmount()
    // Two rows: workbench's row on top of the other band's.
    const roomy = await $.ui.mount({ plugin: 'workbench', surface, ...BAND, props: bandProps(120, false, 2) })
    expect(await roomy.find({ text: /Claude made 1 guess/ })).toBeDefined()
    expect(await roomy.find({ text: 'OTHER BAND' })).toBeDefined()
    expect(treeRows(await roomy.drawn())).toBe(2)
    await roomy.unmount()
  }
})

// ── Assumption Check's switch and its tool ─────────────────────────────────

test('/assumptions on says so when the tool cannot be added, and stays off', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { assumeOn: false })
  await start($)
  expect(w.registered).toEqual([])
  w.registerFails = true
  const reply = await command($, 'assumptions', 'on')
  expect(reply.text).toMatch(/Couldn't turn Assumption Check on/)
  expect(w.store['assumeOn']).toBe(false)
  w.registerFails = false
  expect((await command($, 'assumptions', 'on')).text).toMatch(/Assumption Check is on/)
  expect(w.store['assumeOn']).toBe(true)
  expect(w.registered).toEqual(['note_assumption'])
})

test('a session started with Assumption Check off adds no tool and no section; the tool is tucked away', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { assumeOn: false })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  await start($)
  expect(w.registered).toEqual([])
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [TOOL_NAME], outputStyle: null, traits: [] })
  expect(composed.sections.map(one => one.id)).toEqual(['intro'])
  const described = await $.tool.describe({ tool: TOOL_NAME, description: 'Notes one small guess', provider: { plugin: 'workbench', tier: 'user' } })
  expect(described).toEqual({ description: TOOL_OFF_DESCRIPTION, isDeferred: true })
})

// ── Closing, clearing, the fallback ────────────────────────────────────────

test('Close on the Assumptions pane settles right and skipped guesses; wrong and unchecked stay', async ($, on) => {
  // The person's own close (Esc, the close mark) reaches the mod's ui.close hook, which settles the
  // same way; the kit cannot raise that close (its $ has no ui.close), so this pins the button's path.
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await turnStarts($, 't1')
  await note($, 'port 3000')
  await note($, 'use zod')
  await note($, 'tests live in __tests__')
  await turnEnds($, 't1')
  let ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...ASSUME, props: paneProps(80) })
  const rights = await guessKeys(ui, 'right-')
  const skips = await guessKeys(ui, 'skip-')
  await ui.press({ key: rights[0]! })
  await ui.press({ key: skips[1]! })
  await ui.press({ key: 'close' })
  expect(w.closed).toEqual(['workbench-assumptions'])
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...ASSUME, props: paneProps(80) })
  expect(await ui.find({ text: '0 of 1 checked' })).toBeDefined()
  expect(await ui.find({ text: /__tests__/ })).toBeDefined()
  await ui.unmount()
})

test('after /clear the old guesses and the band are gone', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on)
  await start($)
  await turnStarts($, 't1')
  await note($, 'port 3000')
  await turnEnds($, 't1')
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  const band = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...BAND, props: bandProps(120) })
  expect(await band.find({ text: /guess/ })).toBeUndefined()
  await band.unmount()
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...ASSUME, props: paneProps(80) })
  expect(await ui.find({ text: /No guesses to check/ })).toBeDefined()
  await ui.unmount()
})

test('a pane with no room says so in one line and puts its contents in the transcript', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await command($, 'idea', 'tidy the logger')
  w.isPlaced = false
  await command($, 'ideas')
  await clock.settle()
  expect(w.toasts).toEqual(['The idea shelf pane has no room here; its contents are in the transcript.'])
  expect(w.logs).toEqual(['Idea shelf for earshot:\n1. tidy the logger'])
})

test('an idea past 4,000 characters is refused plainly and nothing is saved', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  const reply = await command($, 'idea', 'x'.repeat(4001))
  expect(reply.text).toBe('That idea is longer than 4,000 characters, too long to park. Nothing was saved.')
  expect(shelfOf(w, ROOT)).toEqual([])
})

// ── Reflect ────────────────────────────────────────────────────────────────

test('while Reflect reads, Start over asks again (a reload mid-read would otherwise leave it stuck)', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  w.forkReply = { isAnswered: true, text: '{"lines":[{"text":"Run the linter before committing","why":"x"}]}', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  await start($)
  await command($, 'reflect')
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...REFLECT, props: paneProps(80) })
  expect(await ui.find({ text: 'Reading the session…' })).toBeDefined()
  await ui.press({ key: 'restart' })
  await clock.settle()
  expect(w.forkPrompts).toHaveLength(2)
  expect(await ui.find({ text: /Run the linter before committing/ })).toBeDefined()
  await ui.unmount()
})
