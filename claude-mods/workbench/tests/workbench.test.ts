// workbench through the engine: commands, the tool, the compose section, the
// band and the three panes. The hooks registered on `on` stand for the engine.

import { expect, mock, test } from 'claude-code/testing'

import { ASSUME_SECTION, FILL_NOTE, SHELF_EMPTY, TOOL_NAME } from '../hooks/logic'
import {
  ASSUME,
  BAND,
  OTHER,
  REFLECT,
  ROOT,
  SHELF,
  USAGE,
  bandProps,
  command,
  note,
  paneProps,
  shelfOf,
  start,
  turnEnds,
  turnStarts,
  widthsFit,
  world,
} from './world'

// ── 1. Idea Shelf: saved per project, newest first, persisted ──────────────

test('ideas are saved per project root, newest first, and listed; empty /idea replies plainly', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  expect((await command($, 'idea', '   ')).text).toBe('Type /idea followed by the idea.')
  expect((await command($, 'idea', 'add a cache to the parser')).text).toBe('Parked on the shelf (1 idea for earshot).')
  expect((await command($, 'idea', 'rename the config loader')).text).toBe('Parked on the shelf (2 ideas for earshot).')
  w.root = OTHER
  expect((await command($, 'idea', 'other project thought')).text).toBe('Parked on the shelf (1 idea for other).')
  const mine = shelfOf(w, ROOT)
  expect(mine.map(one => one.text)).toEqual(['rename the config loader', 'add a cache to the parser'])
  expect((shelfOf(w, OTHER)).map(one => one.text)).toEqual(['other project thought'])
  w.root = ROOT
  expect((await command($, 'ideas')).text).toBe('Opening the idea shelf (2 ideas for earshot).')
  expect(w.opened).toContain('workbench-shelf')
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...SHELF, props: paneProps(80) })
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  const first = texts.findIndex(text => text.includes('rename the config loader'))
  const second = texts.findIndex(text => text.includes('add a cache to the parser'))
  expect(first).toBeGreaterThan(-1)
  expect(second).toBeGreaterThan(first)
  expect(await ui.find({ text: /earshot · 2 ideas/ })).toBeDefined()
  await ui.unmount()
})

test('the shelf survives a new session: it is read back from the store', async ($, on) => {
  mock.clock(on, { now: 5_000_000 })
  world(on, { [`shelf:${ROOT}`]: [{ id: 'old', text: 'kept from yesterday', at: 1_000 }] }, true)
  await start($)
  expect((await command($, 'idea', 'a new one')).text).toBe('Parked on the shelf (2 ideas for earshot).')
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'desktop', ...SHELF, props: paneProps(60) })
  expect(await ui.find({ text: /kept from yesterday/ })).toBeDefined()
  await ui.unmount()
})

test('the shelf keeps at most 100 ideas', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const full = Array.from({ length: 100 }, (_, i) => ({ id: `i${i}`, text: `idea ${i}`, at: i }))
  const w = world(on, { [`shelf:${ROOT}`]: full })
  await start($)
  expect((await command($, 'idea', 'one more')).text).toBe('Parked on the shelf (100 ideas for earshot).')
  const ideas = shelfOf(w, ROOT)
  expect(ideas[0]?.text).toBe('one more')
  expect(ideas.at(-1)?.text).toBe('idea 98')
})

// ── 2. Send: submit when idle, fill when working ───────────────────────────

test('Send submits when idle and removes the idea; fills the prompt box while Claude works', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await command($, 'idea', 'write the migration')
  await command($, 'idea', 'add a cache')
  const [cache, migration] = shelfOf(w, ROOT)
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...SHELF, props: paneProps(80) })

  await turnStarts($, 't1')
  await ui.press({ key: `send-${cache!.id}` })
  expect(w.fills).toEqual(['add a cache'])
  expect(w.submits).toEqual([])
  expect(await ui.find({ text: FILL_NOTE })).toBeDefined()
  expect((shelfOf(w, ROOT)).map(one => one.text)).toEqual(['add a cache', 'write the migration'])

  // The person sends what was filled: it leaves the shelf.
  await $.prompt.submit({ text: 'add a cache', origin: { kind: 'composer' }, wait: false })
  expect((shelfOf(w, ROOT)).map(one => one.text)).toEqual(['write the migration'])

  await turnEnds($, 't1')
  await ui.press({ key: `send-${migration!.id}` })
  expect(w.submits).toEqual(['add a cache', 'write the migration'])
  expect(shelfOf(w, ROOT)).toEqual([])
  expect(await ui.find({ text: SHELF_EMPTY })).toBeDefined()
  await ui.unmount()
})

test('Send all builds one numbered prompt; Delete needs two presses; Edit saves inline', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await command($, 'idea', 'first thought')
  await clock.advance(60_000)
  await command($, 'idea', 'second thought')
  await clock.advance(60_000)
  await command($, 'idea', 'third thought')
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...SHELF, props: paneProps(80) })
  const [third] = shelfOf(w, ROOT)

  await ui.press({ key: `delete-${third!.id}` })
  expect(await ui.find({ text: 'Press again to delete' })).toBeDefined()
  expect(shelfOf(w, ROOT)).toHaveLength(3)
  await ui.press({ key: `delete-${third!.id}` })
  expect((shelfOf(w, ROOT)).map(one => one.text)).toEqual(['second thought', 'first thought'])

  const [second] = shelfOf(w, ROOT)
  await ui.press({ key: `edit-${second!.id}` })
  await ui.input({ key: `edit-field-${second!.id}`, text: 'second thought, sharpened' })
  expect((shelfOf(w, ROOT)).map(one => one.text)).toEqual(['second thought, sharpened', 'first thought'])

  await ui.press({ key: 'send-all' })
  expect(w.submits).toEqual(['Here are some ideas I parked, handle them one at a time:\n1. first thought\n2. second thought, sharpened'])
  expect(shelfOf(w, ROOT)).toEqual([])
  await ui.press({ key: 'close' })
  expect(w.closed).toContain('workbench-shelf')
  await ui.unmount()
})

test('on mobile, Edit puts /idea and the text in the prompt box', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await command($, 'idea', 'tidy the logger')
  const [idea] = shelfOf(w, ROOT)
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'mobile', ...SHELF, props: paneProps(40) })
  await ui.press({ key: `edit-${idea!.id}` })
  expect(w.fills).toEqual(['/idea tidy the logger'])
  await ui.unmount()
})

// ── 3. Assumption Check: the tool and the compose section ──────────────────

test('note_assumption records a guess with its turn; the compose section is added only when on', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  await start($)
  const compose = (tools: string[]) =>
    $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools, outputStyle: null, traits: [] })

  const withTool = await compose(['Read', TOOL_NAME])
  expect(withTool.sections.map(one => one.id)).toEqual(['intro', 'workbench:assumptions'])
  expect(withTool.sections[1]?.text).toBe(ASSUME_SECTION)
  expect(withTool.sections[1]?.scope).toBe('session')
  expect((await compose(['Read'])).sections.map(one => one.id)).toEqual(['intro'])

  await turnStarts($, 't1')
  const noted = await note($, 'the config file is config/app.json', 'the README mentions it')
  expect(noted.result).toBe('Noted. Keep going.')
  const missing = await note($, '   ')
  expect(missing.deny).toBeDefined()
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...ASSUME, props: paneProps(80) })
  expect(await ui.find({ text: /config\/app\.json/ })).toBeDefined()
  expect(await ui.find({ text: /README mentions it/ })).toBeDefined()
  expect(await ui.find({ text: '0 of 1 checked' })).toBeDefined()
  await ui.unmount()

  expect((await command($, 'assumptions', 'off')).text).toBe("Assumption Check is off: Claude won't be asked to note its guesses.")
  expect((await compose(['Read', TOOL_NAME])).sections.map(one => one.id)).toEqual(['intro'])
  expect((await note($, 'another guess')).result).toBe('Assumption Check is off, so nothing was noted. Keep going.')
  expect(w.store['assumeOn']).toBe(false)
  expect((await command($, 'assumptions', 'on')).text).toBe('Assumption Check is on: Claude notes its small guesses for you to check after each turn.')
  expect((await compose(['Read', TOOL_NAME])).sections.map(one => one.id)).toEqual(['intro', 'workbench:assumptions'])
  expect((await command($, 'assumptions', 'maybe')).text).toBe('Type /assumptions to check guesses, or /assumptions on or /assumptions off.')
})

// ── 4. The band ────────────────────────────────────────────────────────────

test('the band shows the count after a turn with guesses; hidden with a survey and when none', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  const mountBand = (columns: number, hasSurvey = false) =>
    $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...BAND, props: bandProps(columns, hasSurvey) })

  await turnStarts($, 't1')
  await turnEnds($, 't1')
  let ui = await mountBand(120)
  expect(await ui.find({ text: /guess/ })).toBeUndefined()
  await ui.unmount()

  await turnStarts($, 't2')
  await note($, 'port 3000')
  await note($, 'use zod for validation')
  await note($, 'tests live in __tests__')
  ui = await mountBand(120)
  expect(await ui.find({ text: /guess/ })).toBeUndefined()
  await ui.unmount()
  await turnEnds($, 't2')

  ui = await mountBand(120)
  expect(await ui.find({ text: /Claude made 3 guesses/ })).toBeDefined()
  expect(await ui.find({ key: 'check' })).toBeDefined()
  await ui.press({ key: 'check' })
  expect(w.opened).toContain('workbench-assumptions')
  await ui.unmount()

  ui = await mountBand(120, true)
  expect(await ui.find({ text: /guess/ })).toBeUndefined()
  await ui.unmount()

  ui = await mountBand(120)
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ text: /guess/ })).toBeUndefined()
  await ui.unmount()
})

// ── 5. Corrections from marks ──────────────────────────────────────────────

test('Send corrections builds the prompt from Right/Wrong marks and clears the checked ones', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await turnStarts($, 't1')
  await note($, 'the config lives in config/app.json')
  await note($, 'port 3000 is free')
  await note($, 'tests use jest')
  await note($, 'names are camelCase')
  await turnEnds($, 't1')
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'desktop', ...ASSUME, props: paneProps(90) })
  const keys = (await ui.findAll({ type: 'Button' })).map(one => one.key ?? '')
  const ids = keys.filter(key => key.startsWith('right-')).map(key => key.slice('right-'.length))
  expect(ids).toHaveLength(4)
  expect(await ui.find({ key: 'send-corrections' })).toBeUndefined()

  await ui.press({ key: `wrong-${ids[0]}` })
  await ui.input({ key: `fix-${ids[0]}`, text: 'it is in settings.toml', kind: 'change' })
  await ui.press({ key: `right-${ids[1]}` })
  await ui.press({ key: `wrong-${ids[2]}` })
  expect(await ui.find({ text: '3 of 4 checked' })).toBeDefined()
  await ui.press({ key: 'send-corrections' })
  expect(w.submits).toEqual([
    [
      'Some of your guesses were wrong. Please fix these:',
      "1. You assumed the config lives in config/app.json. That's wrong: it is in settings.toml.",
      "2. You assumed tests use jest. That's wrong.",
    ].join('\n'),
  ])
  expect(await ui.find({ text: 'Sent 2 corrections to Claude.' })).toBeDefined()
  expect(await ui.find({ text: '0 of 1 checked' })).toBeDefined()
  expect(await ui.find({ text: /camelCase/ })).toBeDefined()

  await ui.press({ key: 'all-right' })
  expect(await ui.find({ text: 'The guess is marked right.' })).toBeDefined()
  await ui.unmount()

  const band = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...BAND, props: bandProps(120) })
  expect(await band.find({ text: /guess/ })).toBeUndefined()
  await band.unmount()
})

test('corrections go to the prompt box while Claude works', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)
  await turnStarts($, 't1')
  await note($, 'we keep the old API')
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...ASSUME, props: paneProps(80) })
  const key = (await ui.findAll({ type: 'Button' })).map(one => one.key ?? '').find(k => k.startsWith('wrong-'))
  await ui.press({ key: key! })
  await ui.press({ key: 'send-corrections' })
  expect(w.submits).toEqual([])
  expect(w.fills).toEqual(["Some of your guesses were wrong. Please fix these:\n1. You assumed we keep the old API. That's wrong."])
  await ui.unmount()
})

// ── 6. Reflect ─────────────────────────────────────────────────────────────

test('/reflect forks, shows suggestions, and adds the kept ones under ## Learned without duplicates', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  const target = `${ROOT}/CLAUDE.md`
  w.files[target] = '# Earshot\n\n## Learned\n\n- Use pnpm, not npm\n'
  w.forkReply = {
    isAnswered: true,
    text: '```json\n{"lines":[{"text":"Run tests with pnpm test","why":"it worked"},{"text":"use PNPM, not npm.","why":"you said so"},{"text":"Keep the parser pure","why":"you corrected me"}]}\n```',
    usage: USAGE,
  }
  await start($)
  expect((await command($, 'reflect')).text).toBe('Reflecting on this session… the suggestions open in a pane.')
  expect(w.opened).toContain('workbench-reflect')
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', ...REFLECT, props: paneProps(90) })
  expect(await ui.find({ text: 'Reading the session…' })).toBeDefined()
  await clock.settle()
  expect(w.forkPrompts).toHaveLength(1)
  expect(w.forkPrompts[0]).toContain('"lines"')
  expect(await ui.find({ text: /Run tests with pnpm test/ })).toBeDefined()
  expect(await ui.find({ text: /already in CLAUDE\.md/ })).toBeDefined()
  expect(await ui.find({ key: 'add' })).toBeDefined()
  expect(await ui.find({ text: /Add 2 lines to CLAUDE\.md/ })).toBeDefined()

  await ui.press({ key: 'skip-2' })
  expect(await ui.find({ text: /Add 1 line to CLAUDE\.md/ })).toBeDefined()
  await ui.press({ key: 'copy' })
  expect(w.copies).toEqual(['- Run tests with pnpm test'])
  await ui.press({ key: 'keep-2' })
  await ui.press({ key: 'add' })
  expect(w.writes).toHaveLength(1)
  expect(w.writes[0]?.path).toBe(target)
  expect(w.writes[0]?.text).toBe('# Earshot\n\n## Learned\n\n- Use pnpm, not npm\n- Run tests with pnpm test\n- Keep the parser pure\n')
  expect(await ui.find({ text: 'Added 2 lines to CLAUDE.md.' })).toBeDefined()
  expect(await ui.find({ key: 'add' })).toBeUndefined()
  await ui.unmount()
})

test('reflect creates CLAUDE.md with ## Learned when missing; nothing to fork and errors say so', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  await start($)

  w.turns = 0
  expect((await command($, 'reflect')).text).toBe('Nothing to reflect on yet — send a prompt first.')
  expect(w.forkPrompts).toHaveLength(0)
  w.turns = 3

  w.forkReply = { isAnswered: false, reason: 'nothing-to-fork' }
  await command($, 'reflect')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'desktop', ...REFLECT, props: paneProps(80) })
  expect(await ui.find({ text: /Nothing to reflect on yet/ })).toBeDefined()

  w.forkReply = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }
  await command($, 'reflect')
  await clock.settle()
  expect(await ui.find({ text: "Couldn't reflect this time. Nothing was changed." })).toBeDefined()
  expect(await ui.find({ key: 'retry' })).toBeDefined()

  w.forkReply = { isAnswered: true, text: '{"lines":[{"text":"Run the linter before committing","why":"it caught a bug"}]}', usage: USAGE }
  await ui.press({ key: 'retry' })
  await clock.settle()
  expect(await ui.find({ text: /It doesn't exist yet/ })).toBeDefined()
  await ui.press({ key: 'add' })
  expect(w.writes[0]?.text).toBe('## Learned\n\n- Run the linter before committing\n')
  expect(await ui.find({ text: 'Added 1 line to CLAUDE.md.' })).toBeDefined()
  await ui.unmount()
})

// ── 7. Every pane and the band fit narrow and wide ─────────────────────────

test('panes and the band draw on terminal and desktop at 20, 32, 36 and 120 with nothing wider than the width', async ($, on) => {
  const clock = mock.clock(on, { now: 9_000_000 })
  const w = world(on)
  await start($)
  await command($, 'idea', 'a fairly long idea about refactoring the whole authentication module into smaller parts')
  await command($, 'idea', 'short one')
  await turnStarts($, 't1')
  await note($, 'the session token is kept in a cookie named sid and expires after thirty minutes of idle time', 'it matched the existing middleware')
  await note($, 'logs go to stdout')
  await turnEnds($, 't1')
  w.forkReply = {
    isAnswered: true,
    text: JSON.stringify({
      lines: [
        { text: 'Always run pnpm test --filter parser before pushing changes to the parser package', why: 'you asked for it twice during this session' },
        { text: 'Keep migrations reversible', why: '' },
      ],
    }),
    usage: USAGE,
  }
  await command($, 'reflect')
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const columns of [20, 32, 36, 120]) {
      const shelf = await $.ui.mount({ plugin: 'workbench', surface, ...SHELF, props: paneProps(columns) })
      expect(await shelf.find({ text: /I D E A/ })).toBeDefined()
      await widthsFit(shelf, columns)
      const [first] = shelfOf(w, ROOT)
      await shelf.press({ key: `delete-${first!.id}` })
      await widthsFit(shelf, columns)
      await shelf.press({ key: `edit-${first!.id}` })
      expect(await shelf.find({ key: `edit-field-${first!.id}` })).toBeDefined()
      await widthsFit(shelf, columns)
      await shelf.press({ key: `edit-cancel-${first!.id}` })
      await shelf.unmount()

      const assume = await $.ui.mount({ plugin: 'workbench', surface, ...ASSUME, props: paneProps(columns) })
      expect(await assume.find({ text: /A S S U M/ })).toBeDefined()
      await widthsFit(assume, columns)
      const wrong = (await assume.findAll({ type: 'Button' })).map(one => one.key ?? '').find(k => k.startsWith('wrong-'))
      await assume.press({ key: wrong! })
      await widthsFit(assume, columns)
      await assume.press({ key: wrong! })
      await assume.unmount()

      const reflect = await $.ui.mount({ plugin: 'workbench', surface, ...REFLECT, props: paneProps(columns) })
      expect(await reflect.find({ text: /R E F L E C T/ })).toBeDefined()
      await widthsFit(reflect, columns)
      await reflect.unmount()

      const band = await $.ui.mount({ plugin: 'workbench', surface, ...BAND, props: bandProps(columns) })
      expect(await band.find({ text: /2/ })).toBeDefined()
      await widthsFit(band, columns)
      await band.unmount()
    }
  }

  // The empty states fit too.
  w.root = OTHER
  await command($, 'ideas')
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const columns of [20, 32, 36, 120]) {
      const shelf = await $.ui.mount({ plugin: 'workbench', surface, ...SHELF, props: paneProps(columns) })
      expect(await shelf.find({ text: /No ideas parked/ })).toBeDefined()
      await widthsFit(shelf, columns)
      await shelf.unmount()
    }
  }
})
