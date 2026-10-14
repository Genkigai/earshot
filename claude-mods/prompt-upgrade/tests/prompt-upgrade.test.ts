// The mod through the engine: the command, interception, the flow in the
// pane, Run, Cancel, errors, history, reloads and the pane's widths.

import { expect, test } from 'claude-code/testing'

import { GOLD, MUTED, cells } from '../hooks/look-text'
import { EMPTY_HISTORY, MOBILE_COMPOSE, SAFE_LINE } from '../hooks/view'
import {
  HISTORY,
  PANE,
  PLUGIN,
  QUESTIONS,
  REWRITE,
  ROUGH,
  SURFACES,
  UPGRADE,
  ZERO,
  better,
  mountPane,
  paneProps,
  said,
  start,
  typed,
  world,
} from './world'

test('the full flow: /better, questions, rewrite, review, Run sends the upgrade unintercepted', async ($, on) => {
  const w = world(on)
  w.replies.push(said(QUESTIONS), said(REWRITE))
  await start($)
  expect((await better($, 'on')).text).toContain('Automatic mode is on')

  const reply = await better($, ROUGH)
  expect(reply.text).toContain('Nothing is sent until you press Run')
  await w.clock.settle()
  expect(w.opened).toEqual(['prompt-upgrade'])
  expect(w.asked[0]).toContain(ROUGH)

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: 'Add tests for the fix?' })).toBeDefined()
  expect(await ui.find({ text: '0 of 2 answered' })).toBeDefined()
  expect(await ui.find({ text: '● Questions' })).toBeDefined()
  // the tracker's separators are muted, not the near-invisible hairline colour
  const separators = await ui.findAll({ type: 'Text', text: '  ›  ' })
  expect(separators).toHaveLength(3)
  for (const one of separators) expect(one.props.color).toBe(MUTED)
  expect(await ui.find({ key: 'q0-other' })).toBeDefined()
  expect(await ui.find({ key: 'skip-rest' })).toBeDefined()

  await ui.press({ key: 'q0-o0' })
  expect(await ui.find({ text: '1 of 2 answered' })).toBeDefined()
  expect(await ui.find({ text: ' ✓ ' })).toBeDefined()
  await ui.press({ key: 'q1-skip' })
  await w.clock.settle()

  // the rewrite used the answer and left out the skipped question
  expect(w.asked).toHaveLength(2)
  expect(w.asked[1]).toContain('A: Yes, unit tests')
  expect(w.asked[1]).not.toContain('Plan first?')

  expect(await ui.find({ text: '● Review' })).toBeDefined()
  expect(await ui.find({ text: '4 words' })).toBeDefined()
  expect(await ui.find({ text: '2 details added' })).toBeDefined()
  expect(await ui.find({ text: '· A unit test for the fix' })).toBeDefined()
  for (const key of ['run', 'edit', 'copy', 'cancel']) expect(await ui.find({ key })).toBeDefined()
  const upgradeCard = await ui.find({ key: 'card-upgrade' })
  expect(upgradeCard?.props.borderColor).toBe(GOLD)
  expect((await ui.find({ key: 'cards' }))?.props.flexDirection).toBe('row')

  await ui.press({ key: 'run' })
  expect(w.submits).toEqual([{ text: UPGRADE, origin: 'plugin' }])
  expect(w.closed).toContain('prompt-upgrade')
  expect(w.fills).toEqual([])
  await ui.unmount()
})

test('Edit swaps the upgrade card for a field, and Enter runs the edited text', async ($, on) => {
  const w = world(on, { store: { isOn: true } })
  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal', 60)
  expect((await ui.find({ key: 'cards' }))?.props.flexDirection).toBe('column')
  await ui.press({ key: 'edit' })
  expect(await ui.find({ key: 'card-upgrade' })).toBeUndefined()
  expect(await ui.find({ key: 'edit', type: 'Input' })).toBeDefined()
  await ui.input({ key: 'edit', text: 'Fix the login bug in src/auth and add a test.' })
  expect(w.submits).toEqual([{ text: 'Fix the login bug in src/auth and add a test.', origin: 'plugin' }])
  await ui.unmount()
})

test('Cancel closes the pane and puts the original back in the prompt box', async ($, on) => {
  const w = world(on)
  w.replies.push(said('no questions here'), said(REWRITE))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal')
  // no usable questions: straight to the rewrite and the review
  expect(await ui.find({ key: 'run' })).toBeDefined()
  await ui.press({ key: 'cancel' })
  expect(w.fills).toEqual([ROUGH])
  expect(w.closed).toContain('prompt-upgrade')
  expect(w.submits).toEqual([])
  await ui.unmount()
})

test('Cancel while reading puts the prompt back, and the late questions change nothing', async ($, on) => {
  const w = world(on)
  w.holdMs = 1000
  w.replies.push(said(QUESTIONS))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /Reading your prompt/ })).toBeDefined()
  expect(await ui.find({ text: '● Your prompt' })).toBeDefined()
  await ui.press({ key: 'cancel' })
  expect(w.fills).toEqual([ROUGH])
  await w.clock.advance(1000)
  expect(await ui.find({ text: 'Add tests for the fix?' })).toBeUndefined()
  expect(await ui.find({ key: 'compose' })).toBeDefined()
  await ui.unmount()
})

test('/better on and off flip the stored switch and change interception', async ($, on) => {
  const w = world(on)
  await start($)
  const prompt = 'refactor the session store so tokens refresh early'

  expect((await typed($, prompt)).drop).toBeUndefined()
  expect(w.submits.map(s => s.text)).toEqual([prompt])

  await better($, 'on')
  expect(w.store.get('isOn')).toBe(true)
  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  const held = await typed($, prompt)
  expect(held.drop).toContain('Prompt Upgrade')
  expect(w.submits).toHaveLength(1)
  expect(w.opened).toEqual(['prompt-upgrade'])
  await w.clock.settle()
  expect(w.asked[0]).toContain(prompt)

  const off = await better($, 'off')
  expect(off.text).toContain('Automatic mode is off')
  expect(w.store.get('isOn')).toBe(false)
  expect((await typed($, prompt)).drop).toBeUndefined()
  expect(w.submits).toHaveLength(2)
})

test('the switch is read back from the store when the session starts', async ($, on) => {
  const w = world(on, { store: { isOn: true } })
  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  await start($)
  const held = await typed($, 'make the parser stream its input instead of buffering')
  expect(held.drop).toContain('Prompt Upgrade')
  expect(w.submits).toEqual([])
  await w.clock.settle()
})

test('automatic mode lets commands, attachments, mid-turn prompts, short replies, ">" and its own text through', async ($, on) => {
  const w = world(on, { store: { isOn: true } })
  await start($)
  await typed($, '/compact keep the plan')
  await typed($, 'make the parser faster please', { attachments: [{ type: 'image', mediaType: 'image/png' }] })
  await typed($, 'look at @src/auth/login.ts and tidy it up')
  await typed($, 'also update the changelog for this change', { turnId: 'turn-1' })
  await typed($, 'yes')
  await typed($, 'keep going')
  await typed($, '>do it now')
  await typed($, 'Fix the login bug and add a test for it.', { origin: { kind: 'plugin', name: 'prompt-upgrade', asUser: true } })
  expect(w.submits.map(s => s.text)).toEqual([
    '/compact keep the plan',
    'make the parser faster please',
    'look at @src/auth/login.ts and tidy it up',
    'also update the changelog for this change',
    'yes',
    'keep going',
    'do it now',
    'Fix the login bug and add a test for it.',
  ])
  expect(w.opened).toEqual([])
  expect(w.asked).toEqual([])
})

test('a model failure shows the calm error card; Try again asks again; Send my original sends it', async ($, on) => {
  const w = world(on)
  w.replies.push({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO })
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: SAFE_LINE })).toBeDefined()
  expect(await ui.find({ text: 'The model is busy right now.' })).toBeDefined()
  for (const key of ['retry', 'send-original', 'cancel']) expect(await ui.find({ key })).toBeDefined()

  w.replies.push({ isAnswered: false, reason: 'aborted', usage: ZERO })
  await ui.press({ key: 'retry' })
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  expect(await ui.find({ text: 'The model took too long to answer.' })).toBeDefined()

  await ui.press({ key: 'send-original' })
  expect(w.submits).toEqual([{ text: ROUGH, origin: 'plugin' }])
  expect(w.closed).toContain('prompt-upgrade')
  await ui.unmount()
})

test('an unreadable rewrite is a failure at the rewrite step', async ($, on) => {
  const w = world(on)
  w.replies.push(said('{"questions":[]}'), said('Here is a better prompt: just fix it.'))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: "The model's reply could not be read." })).toBeDefined()
  expect(await ui.find({ text: '● Rewrite' })).toBeDefined()
  await ui.unmount()
})

test('a narrow window puts the words back in the prompt box and says so in one line', async ($, on) => {
  const w = world(on, { store: { isOn: true }, placed: false })
  await start($)
  const prompt = 'rename the config loader and update its callers'
  const held = await typed($, prompt)
  expect(held.drop).toBe('The window is too narrow for Prompt Upgrade, so your prompt is back in the box.')
  // the box is checked a moment after the drop, once the engine had its chance to hand it back
  await w.clock.advance(250)
  expect(w.fills).toEqual([prompt])
  expect(w.asked).toEqual([])

  w.box = ''
  await better($, 'tidy the logging setup in the server')
  await w.clock.settle()
  expect(w.fills).toEqual([prompt, 'tidy the logging setup in the server'])
  expect(w.toasts).toEqual(['The window is too narrow for Prompt Upgrade, so your prompt is back in the box.'])
})

test('history keeps upgrades; pressing one reopens its review, where Copy works', async ($, on) => {
  const w = world(on)
  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const first = await mountPane($, 'terminal')
  await first.press({ key: 'run' })
  await first.unmount()
  const saved = w.store.get('history') as { id: string; original: string; sent?: boolean }[]
  expect(saved).toHaveLength(1)
  expect(saved[0]?.original).toBe(ROUGH)
  expect(saved[0]?.sent).toBe(true)

  expect((await better($, 'history')).text).toContain('last upgrades')
  await w.clock.settle()
  expect(w.opened).toContain('prompt-upgrade-history')
  const list = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...HISTORY, props: paneProps(80) })
  const row = await list.find({ key: `h-${saved[0]?.id ?? ''}` })
  expect(row?.text).toContain(ROUGH)
  expect(row?.text).toContain('4 → ')
  expect(row?.text).toContain('✓ ')
  await list.press({ key: `h-${saved[0]?.id ?? ''}` })
  expect(w.closed).toContain('prompt-upgrade-history')
  await list.unmount()

  const review = await mountPane($, 'terminal')
  expect(await review.find({ text: '● Review' })).toBeDefined()
  await review.press({ key: 'copy' })
  expect(w.copies).toEqual([UPGRADE])
  expect(w.toasts).toEqual([])
  const fillsBefore = w.fills.length
  await review.press({ key: 'cancel' })
  expect(w.fills).toHaveLength(fillsBefore)
  await review.unmount()
})

test('a reload mid-step asks again instead of leaving the pane stuck', async ($, on) => {
  const w = world(on)
  w.holdMs = 1000
  w.replies.push(said(QUESTIONS), said(QUESTIONS))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  // a reload runs session.start again while the pane stays up
  await start($)
  await w.clock.settle()
  expect(w.asked).toHaveLength(2)
  await w.clock.advance(1000)
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: '0 of 2 answered' })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: 'Add tests for the fix?' })).toHaveLength(1)
  await ui.unmount()
})

test('/better alone opens a field to type a prompt; mobile is told to use the command', async ($, on) => {
  const w = world(on)
  w.replies.push(said(QUESTIONS))
  await start($)
  await better($)
  await w.clock.settle()
  expect(w.opened).toEqual(['prompt-upgrade'])
  const phone = await mountPane($, 'mobile', 40)
  expect(await phone.find({ text: MOBILE_COMPOSE }), JSON.stringify((await phone.findAll({ type: 'Text' })).map(t => t.text))).toBeDefined()
  expect(await phone.find({ type: 'Input' }), 'no field on mobile').toBeUndefined()
  await phone.unmount()
  const ui = await mountPane($, 'desktop', 80)
  await ui.input({ key: 'compose', text: 'speed up the test suite' })
  await w.clock.settle()
  expect(w.asked[0]).toContain('speed up the test suite')
  expect(await ui.find({ text: 'Add tests for the fix?' }), JSON.stringify((await ui.findAll({ type: 'Text' })).map(t => t.text))).toBeDefined()
  await ui.unmount()
})

test('Skip the rest, upgrade now skips what is unanswered and starts the rewrite', async ($, on) => {
  const w = world(on)
  w.replies.push(said(QUESTIONS), said(REWRITE))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const ui = await mountPane($, 'desktop', 100)
  await ui.press({ key: 'q1-o1' })
  await ui.press({ key: 'skip-rest' })
  await w.clock.settle()
  expect(w.asked[1]).toContain('A: Just do it')
  expect(w.asked[1]).not.toContain('Add tests for the fix?')
  expect(await ui.find({ text: '● Review' })).toBeDefined()
  await ui.unmount()
})

const LONG_ROUGH =
  'the checkout page is slow and sometimes double charges people when they click pay twice, can you look into it ' +
  'and make it not do that, also the spinner never stops on errors'
const LONG_QUESTIONS = JSON.stringify({
  questions: [
    {
      question: 'Which part should the fix cover: the payment button, the server endpoint, or both of them together?',
      options: ['Button only', 'Server endpoint only', 'Both, end to end'],
    },
    { question: 'Add tests?', options: ['Yes, unit and integration', 'Unit tests only', 'No tests'] },
    { question: 'Plan first or change directly?', options: ['Plan first', 'Make the change', 'PR-ready change'] },
  ],
})
const LONG_REWRITE = JSON.stringify({
  prompt:
    'Fix the double charge on the checkout page: when a person clicks Pay twice, only one charge should go through. ' +
    'Cover both the Pay button and the server endpoint that creates the charge ([endpoint name]).\n\n' +
    'Also make the spinner stop and show an error message when payment fails.\n\n' +
    'Keep the public API unchanged and add no new dependencies. Add unit and integration tests that reproduce the ' +
    'double charge, run the full test suite, and consider it done when the tests pass and a double click charges once.',
  added: [
    'Scope: the button and the endpoint',
    'Constraint: keep the public API',
    'Verification: unit and integration tests',
    'What done looks like, stated plainly for the agent to check against',
  ],
})

test('the pane draws every step within the width on terminal and desktop, narrow and wide', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on)
  await start($)

  const check = async (label: string, component: typeof PANE | typeof HISTORY = PANE) => {
    for (const surface of SURFACES) {
      for (const columns of [32, 40, 120]) {
        const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...component, props: paneProps(columns) })
        const texts = await ui.findAll({ type: 'Text' })
        expect(texts.length).toBeGreaterThan(0)
        for (const one of texts) {
          expect(cells(one.text), `${label} on ${surface} at ${columns}: "${one.text}"`).toBeLessThanOrEqual(columns)
        }
        await ui.unmount()
      }
    }
  }

  await better($)
  await w.clock.settle()
  await check('compose')

  w.holdMs = 1000
  w.replies.push(said(LONG_QUESTIONS))
  await better($, LONG_ROUGH)
  await w.clock.settle()
  await check('reading')
  await w.clock.advance(1000)
  await check('questions')
  // a second prompt while this one is under way: refused, with a note at the top
  await better($, 'rename the payment client and update every caller of it')
  await w.clock.settle()
  await check('questions with a notice')

  /** Acts on the pane as the person would, then lets the drawing go so the checks can mount. */
  const act = async (work: (ui: Awaited<ReturnType<typeof mountPane<'terminal'>>>) => Promise<unknown>) => {
    const ui = await mountPane($, 'terminal', 120)
    await work(ui)
    await ui.unmount()
  }

  await act(ui => ui.press({ key: 'q0-other' }))
  await check('questions with the other field open')
  await act(ui => ui.input({ key: 'q0-other-input', text: 'Both, and the retry logic in the payment client as well' }))
  await check('questions with a typed answer')

  w.replies.push(said(LONG_REWRITE))
  await act(async ui => {
    await ui.press({ key: 'q1-o0' })
    await ui.press({ key: 'q2-skip' })
  })
  await w.clock.settle()
  await check('rewrite')
  expect(w.asked[1]).toContain('A: Both, and the retry logic in the payment client as well')
  expect(w.asked[1]).toContain('A: Yes, unit and integration')
  expect(w.asked[1]).not.toContain('Plan first or change directly?')
  await w.clock.advance(1000)
  await check('review')
  await act(ui => ui.press({ key: 'edit' }))
  await check('review while editing')
  await act(ui => ui.press({ key: 'cancel' }))

  w.holdMs = 0
  w.replies.push({ isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: ZERO })
  await better($, LONG_ROUGH)
  await w.clock.settle()
  await check('error')

  await better($, 'history')
  await w.clock.settle()
  await check('history', HISTORY)
})

test('the history pane says so when it is empty', async ($, on) => {
  const w = world(on)
  await start($)
  await better($, 'history')
  await w.clock.settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...HISTORY, props: paneProps(80) })
  expect(await ui.find({ text: EMPTY_HISTORY })).toBeDefined()
  await ui.press({ key: 'close' })
  expect(w.closed).toContain('prompt-upgrade-history')
  await ui.unmount()
})
