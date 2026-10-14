// Nothing the person typed is lost: a second prompt during an upgrade, the
// engine handing a held prompt back, double presses, Esc and closing by hand,
// edits, reloads, long prompts and calls cut short.

import { expect, test } from 'claude-code/testing'

import { oneLine } from '../hooks/logic'
import { HISTORY_LEGEND } from '../hooks/view'
import {
  HISTORY,
  PLUGIN,
  QUESTIONS,
  REWRITE,
  ROUGH,
  UPGRADE,
  ZERO,
  better,
  enter,
  mountPane,
  paneProps,
  said,
  start,
  world,
} from './world'
import type { World } from './world'

const FIRST = 'refactor the session store so tokens refresh early'
const SECOND = 'tidy the logging setup in the server and drop the dead flags'
const BUSY = /still on another prompt/
const NOTICE = /Finish or cancel this upgrade first/

type Entry = { id: string; original: string; upgrade: string; sent?: boolean }

function history(w: World): Entry[] {
  return (w.store.get('history') as Entry[] | undefined) ?? []
}

test('a second typed prompt while one is under way is refused, not swapped in; the first is kept as not sent', async ($, on) => {
  const w = world(on, { store: { isOn: true } })
  w.replies.push(said(QUESTIONS))
  await start($)
  expect((await enter($, w, FIRST)).drop).toContain('Held for Prompt Upgrade')
  await w.clock.settle()

  const second = await enter($, w, SECOND)
  expect(second.drop).toMatch(BUSY)
  await w.clock.advance(250)
  // the new prompt is back in the box; no second model call; the first is in history, not sent
  expect(w.fills).toEqual([SECOND])
  expect(w.asked).toHaveLength(1)
  expect(history(w)).toEqual([expect.objectContaining({ original: FIRST, upgrade: '', sent: false })])

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: 'Add tests for the fix?' })).toBeDefined()
  expect(await ui.find({ text: NOTICE })).toBeDefined()
  // Cancel still puts the first one back, beside the second
  await ui.press({ key: 'cancel' })
  expect(w.box).toContain(FIRST)
  expect(w.box).toContain(SECOND)
  await ui.unmount()
})

test('/better with a prompt while one is under way puts the new one in the box and keeps the first', async ($, on) => {
  const w = world(on)
  w.replies.push(said(QUESTIONS), said(REWRITE))
  await start($)
  await better($, FIRST)
  await w.clock.settle()
  expect((await better($, SECOND)).text).toMatch(BUSY)
  await w.clock.settle()
  expect(w.fills).toEqual([SECOND])
  expect(w.asked).toHaveLength(1)
  expect(w.toasts).toEqual([])
  expect(history(w)[0]).toEqual(expect.objectContaining({ original: FIRST, sent: false }))

  // the first goes on to its review; that review updates the same history entry
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'skip-rest' })
  await w.clock.settle()
  expect(await ui.find({ key: 'run' })).toBeDefined()
  expect(history(w)).toHaveLength(1)
  expect(history(w)[0]).toEqual(expect.objectContaining({ original: FIRST, upgrade: UPGRADE, sent: false }))
  await ui.unmount()
})

test('pressing a history entry while one is under way keeps the one under way', async ($, on) => {
  const w = world(on)
  w.replies.push(said('{"questions":[]}'), said(REWRITE), said(QUESTIONS))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const first = await mountPane($, 'terminal')
  await first.press({ key: 'run' })
  await first.unmount()
  const old = history(w)[0]?.id ?? ''

  await better($, FIRST)
  await w.clock.settle()
  await better($, 'history')
  await w.clock.settle()
  const list = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...HISTORY, props: paneProps(80) })
  await list.press({ key: `h-${old}` })
  await list.unmount()

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: 'Add tests for the fix?' })).toBeDefined()
  expect(await ui.find({ text: NOTICE })).toBeDefined()
  expect(history(w).map(one => one.original)).toEqual([FIRST, ROUGH])
  await ui.press({ key: 'cancel' })
  expect(w.fills).toEqual([FIRST])
  await ui.unmount()
})

test('a history entry saved before its rewrite reopens as a fresh upgrade of its original', async ($, on) => {
  const w = world(on)
  w.replies.push(said(QUESTIONS), said('{"questions":[]}'))
  await start($)
  await better($, FIRST)
  await w.clock.settle()
  await better($, SECOND)
  await w.clock.settle()
  const saved = history(w)[0]
  expect(saved).toEqual(expect.objectContaining({ original: FIRST, upgrade: '', sent: false }))
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'cancel' })
  await ui.unmount()

  await better($, 'history')
  await w.clock.settle()
  const list = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...HISTORY, props: paneProps(80) })
  const row = await list.find({ key: `h-${saved?.id ?? ''}` })
  expect(row?.text).toContain('○ ')
  expect(row?.text).toContain('→ …')
  expect(await list.find({ text: HISTORY_LEGEND })).toBeDefined()
  await list.press({ key: `h-${saved?.id ?? ''}` })
  await list.unmount()
  await w.clock.settle()
  // a fresh upgrade of the saved original: its questions call (none came back), then its rewrite
  expect(w.asked).toHaveLength(3)
  expect(w.asked[1]).toContain(FIRST)
  expect(w.asked[1]).toContain('multiple-choice questions')
  expect(w.asked[2]).toContain('Rewrite this rough request')
})

test('when the engine hands a held prompt back, Run leaves the box clean and Cancel does not double it', async ($, on) => {
  const w = world(on, { store: { isOn: true }, handBack: true })
  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  await start($)
  await enter($, w, FIRST)
  expect(w.box).toBe(FIRST)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'run' })
  expect(w.submits).toEqual([{ text: UPGRADE, origin: 'plugin' }])
  expect(w.box).toBe('')
  await ui.unmount()

  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  await enter($, w, SECOND)
  await w.clock.settle()
  const again = await mountPane($, 'terminal')
  w.fills = []
  await again.press({ key: 'cancel' })
  expect(w.fills).toEqual([])
  expect(w.box).toBe(SECOND)
  await again.unmount()
})

test('a narrow window shows the prompt once when the engine hands it back', async ($, on) => {
  const w = world(on, { store: { isOn: true }, placed: false, handBack: true })
  await start($)
  const held = await enter($, w, FIRST)
  expect(held.drop).toContain('too narrow')
  await w.clock.advance(250)
  expect(w.fills).toEqual([])
  expect(w.box).toBe(FIRST)
})

test('Send my original with automatic mode on is sent, not held again, and leaves the box clean', async ($, on) => {
  const w = world(on, { store: { isOn: true }, handBack: true })
  w.replies.push({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO })
  await start($)
  await enter($, w, FIRST)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'send-original' })
  expect(w.submits).toEqual([{ text: FIRST, origin: 'plugin' }])
  expect(w.box).toBe('')
  expect(w.opened).toEqual(['prompt-upgrade'])
  await ui.unmount()
})

test('two quick presses of Run send the prompt once', async ($, on) => {
  const w = world(on)
  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal')
  await Promise.all([ui.press({ key: 'run' }), ui.press({ key: 'run' })])
  expect(w.submits).toEqual([{ text: UPGRADE, origin: 'plugin' }])
  await ui.unmount()
})

test('Esc does not close the upgrade pane, so typing in its fields is never thrown away', async ($, on) => {
  const w = world(on)
  await start($)
  await better($)
  await w.clock.settle()
  const opened = w.openArgs.find(one => one.id === 'prompt-upgrade')
  expect(opened).toBeDefined()
  expect(opened?.closeOnEscape).toBeUndefined()
})

// The test kit cannot raise a close by the person (its `$` has no ui.close),
// so these go through Cancel, which shares the close mark's path (discard).

test('leaving the compose screen puts the text typed in its field back in the box', async ($, on) => {
  const w = world(on)
  await start($)
  await better($)
  await w.clock.settle()
  const ui = await mountPane($, 'desktop', 80)
  await ui.input({ key: 'compose', text: 'speed up the slow integration tests', kind: 'change' })
  await ui.press({ key: 'cancel' })
  expect(w.fills).toEqual(['speed up the slow integration tests'])
  await ui.unmount()
})

test('leaving while editing puts the original back and keeps the edit on its history entry', async ($, on) => {
  const w = world(on)
  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'edit' })
  await ui.input({ key: 'edit', text: 'Fix the login bug in src/auth and add one test.', kind: 'change' })
  await ui.press({ key: 'cancel' })
  expect(w.fills).toEqual([ROUGH])
  expect(history(w)[0]).toEqual(expect.objectContaining({ upgrade: 'Fix the login bug in src/auth and add one test.', sent: false }))
  await ui.unmount()
})

test('Run while editing sends the edit typed so far', async ($, on) => {
  const w = world(on)
  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'edit' })
  await ui.input({ key: 'edit', text: 'Fix the login bug and add a regression test.', kind: 'change' })
  await ui.press({ key: 'run' })
  expect(w.submits).toEqual([{ text: 'Fix the login bug and add a regression test.', origin: 'plugin' }])
  expect(history(w)[0]).toEqual(expect.objectContaining({ upgrade: 'Fix the login bug and add a regression test.', sent: true }))
  await ui.unmount()
})

test('Edit then Enter with nothing changed sends the upgrade with its line breaks', async ($, on) => {
  const w = world(on)
  const multi = 'Line one of the request.\n\n- item a\n- item b'
  w.replies.push(said('{"questions":[]}'), said(JSON.stringify({ prompt: multi, added: ['a list'] })))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'edit' })
  expect((await ui.find({ key: 'edit', type: 'Input' }))?.props.value).toBe(oneLine(multi))
  await ui.input({ key: 'edit', text: oneLine(multi) })
  expect(w.submits).toEqual([{ text: multi, origin: 'plugin' }])
  await ui.unmount()
})

test('a reload with the pane gone puts the held prompt back in the box', async ($, on) => {
  const w = world(on)
  w.replies.push(said(QUESTIONS))
  await start($)
  await better($, FIRST)
  await w.clock.settle()
  // the pane went away without its close hook (an unload), then the session starts again
  w.openPanes = []
  await start($)
  await w.clock.settle()
  expect(w.fills).toEqual([FIRST])
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ key: 'compose' })).toBeDefined()
  await ui.unmount()
})

test('Cancel stops the model call in flight', async ($, on) => {
  const w = world(on)
  w.holdMs = 5000
  w.replies.push(said(QUESTIONS))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'cancel' })
  await w.clock.settle()
  expect(w.aborted).toBe(1)
  await w.clock.advance(5000)
  expect(await ui.find({ text: 'Add tests for the fix?' })).toBeUndefined()
  await ui.unmount()
})

test('a long prompt gets room for its rewrite instead of a cut-off reply', async ($, on) => {
  const w = world(on)
  const pasted = `make this function pass its tests:\n${'const value = compute(input, options) // step\n'.repeat(120)}`
  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  await start($)
  await better($, pasted)
  await w.clock.settle()
  expect(w.maxTokens).toHaveLength(2)
  expect(w.maxTokens[1] ?? 0).toBeGreaterThan(1600)
  expect(w.maxTokens[1] ?? 0).toBeLessThanOrEqual(64_000)
})

test('Stop editing keeps what was typed as the upgrade', async ($, on) => {
  const w = world(on)
  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'edit' })
  await ui.input({ key: 'edit', text: 'Fix the login bug and keep the session cookie.', kind: 'change' })
  await ui.press({ key: 'edit' })
  expect(await ui.find({ text: 'Fix the login bug and keep the session cookie.' })).toBeDefined()
  expect(history(w)[0]?.upgrade).toBe('Fix the login bug and keep the session cookie.')
  await ui.press({ key: 'run' })
  expect(w.submits).toEqual([{ text: 'Fix the login bug and keep the session cookie.', origin: 'plugin' }])
  await ui.unmount()
})

test('sending the held prompt again says it is already in the pane, and changes nothing', async ($, on) => {
  const w = world(on, { store: { isOn: true }, handBack: true })
  w.replies.push(said(QUESTIONS))
  await start($)
  await enter($, w, FIRST)
  await w.clock.settle()
  const again = await enter($, w, FIRST)
  expect(again.drop).toMatch(/already in Prompt Upgrade/)
  await w.clock.advance(250)
  expect(w.fills).toEqual([])
  expect(w.box).toBe(FIRST)
  expect(history(w)).toEqual([])
  expect(w.asked).toHaveLength(1)
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: NOTICE })).toBeUndefined()
  expect(await ui.find({ text: 'Add tests for the fix?' })).toBeDefined()
  await ui.unmount()
})

/** Runs one upgrade to Run, reopens it from history and types an edit in its Edit field. */
async function editReopened($: Parameters<typeof start>[0], w: World, edit: string) {
  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const first = await mountPane($, 'terminal')
  await first.press({ key: 'run' })
  await first.unmount()
  const old = history(w)[0]?.id ?? ''
  await better($, 'history')
  await w.clock.settle()
  const list = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...HISTORY, props: paneProps(80) })
  await list.press({ key: `h-${old}` })
  await list.unmount()
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'edit' })
  await ui.input({ key: 'edit', text: edit, kind: 'change' })
  w.fills = []
  w.submits = []
  return ui
}

test('/better while a review reopened from history holds a typed edit keeps the edit and puts the new prompt in the box', async ($, on) => {
  const w = world(on)
  const edit = 'Fix the login bug in src/auth/session.ts and add one regression test.'
  const ui = await editReopened($, w, edit)
  const asked = w.asked.length

  expect((await better($, FIRST)).text).toMatch(BUSY)
  await w.clock.settle()
  expect(w.fills).toEqual([FIRST])
  expect(w.asked).toHaveLength(asked)
  expect(await ui.find({ text: NOTICE })).toBeDefined()
  expect(await ui.find({ key: 'run' })).toBeDefined()
  // the edit is still there: Run sends it
  await ui.press({ key: 'run' })
  expect(w.submits).toEqual([{ text: edit, origin: 'plugin' }])
  await ui.unmount()
})

test('a prompt typed in automatic mode while a reopened review holds a typed edit is put back, and the edit kept', async ($, on) => {
  const w = world(on, { store: { isOn: true } })
  const edit = 'Fix the login bug in src/auth/session.ts and keep the cookie name.'
  const ui = await editReopened($, w, edit)
  const asked = w.asked.length

  expect((await enter($, w, SECOND)).drop).toMatch(BUSY)
  await w.clock.advance(250)
  expect(w.box).toBe(SECOND)
  expect(w.asked).toHaveLength(asked)
  expect(await ui.find({ text: NOTICE })).toBeDefined()
  // Cancel keeps the edit on its history entry and leaves the box as it is
  await ui.press({ key: 'cancel' })
  expect(history(w)[0]).toEqual(expect.objectContaining({ original: ROUGH, upgrade: edit }))
  expect(w.box).toBe(SECOND)
  await ui.unmount()
})

test('a reopened review with no edit typed still gives way to a new /better', async ($, on) => {
  const w = world(on)
  w.replies.push(said('{"questions":[]}'), said(REWRITE))
  await start($)
  await better($, ROUGH)
  await w.clock.settle()
  const first = await mountPane($, 'terminal')
  await first.press({ key: 'run' })
  await first.unmount()
  const old = history(w)[0]?.id ?? ''
  await better($, 'history')
  await w.clock.settle()
  const list = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...HISTORY, props: paneProps(80) })
  await list.press({ key: `h-${old}` })
  await list.unmount()
  w.replies.push(said(QUESTIONS))
  expect((await better($, FIRST)).text).toMatch(/Upgrading your prompt/)
  await w.clock.settle()
  expect(w.asked.at(-1)).toContain(FIRST)
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: 'Add tests for the fix?' })).toBeDefined()
  await ui.unmount()
})
