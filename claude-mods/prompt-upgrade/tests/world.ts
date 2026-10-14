// The engine beneath the plugin for the tests: store, panes, the prompt box,
// the model and the clock, all answered here and recorded for the checks.

import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ModelCompleteResult, On, PaneOpenArgs, PromptSubmitInput, PromptSubmitResult } from 'claude-code'

export const PLUGIN = 'prompt-upgrade'
export const PANE = { component: 'Pane', requestId: 'prompt-upgrade' } as const
export const HISTORY = { component: 'Pane', requestId: 'prompt-upgrade-history' } as const
export const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
export const SURFACES = ['terminal', 'desktop'] as const

export const ROUGH = 'fix the login bug'
export const UPGRADE =
  'Fix the login bug in [where it happens] so that a signed-in user stays signed in after a page refresh. ' +
  'Keep the public API as it is. Add a unit test that fails before the fix and passes after, then run the test suite.'
export const QUESTIONS = JSON.stringify({
  questions: [
    { question: 'Add tests for the fix?', options: ['Yes, unit tests', 'No tests'] },
    { question: 'Plan first?', options: ['Plan first', 'Just do it'] },
  ],
})
export const REWRITE = JSON.stringify({ prompt: UPGRADE, added: ['A unit test for the fix', 'Keep the public API'] })

export type World = {
  clock: MockClock
  store: Map<string, unknown>
  replies: ModelCompleteResult[]
  asked: string[]
  /** The token cap of each model call, in order. */
  maxTokens: number[]
  /** How many model calls the plugin cut short. */
  aborted: number
  opened: string[]
  /** Each `$.ui.open` argument whole, to check its dialog manners. */
  openArgs: PaneOpenArgs[]
  closed: string[]
  openPanes: string[]
  /** The prompt box as it stands. */
  box: string
  fills: string[]
  submits: { text: string; origin: string }[]
  toasts: string[]
  copies: string[]
  placed: boolean
  holdMs: number
  /** Whether the engine hands a dropped typed prompt back to the box, as 2.1.296's REPL does. */
  handBack: boolean
}

/** Stands for the engine beneath the plugin: answers everything the mod asks of it. */
export function world(on: On, o: { store?: Record<string, unknown>; placed?: boolean; handBack?: boolean } = {}): World {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const w: World = {
    clock,
    store: new Map(Object.entries(o.store ?? {})),
    replies: [],
    asked: [],
    maxTokens: [],
    aborted: 0,
    opened: [],
    openArgs: [],
    closed: [],
    openPanes: [],
    box: '',
    fills: [],
    submits: [],
    toasts: [],
    copies: [],
    placed: o.placed ?? true,
    holdMs: 0,
    handBack: o.handBack ?? false,
  }
  on('store.get', ($, e) => ({ value: w.store.get(e.key) }))
  on('store.set', ($, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)) as unknown)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    w.openArgs.push({ ...e })
    if (w.placed && !w.openPanes.includes(e.id)) w.openPanes.push(e.id)
    return { value: w.placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'below 110 columns' } }
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    w.openPanes = w.openPanes.filter(id => id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: w.openPanes.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', ($, e) => {
    w.copies.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('prompt.read', () => ({ value: { text: w.box, cursor: w.box.length } }))
  on('prompt.fill', ($, e) => {
    w.fills.push(e.text)
    w.box = e.mode === 'append' || e.mode === 'insert' ? w.box + e.text : e.text
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    w.submits.push({ text: e.text, origin: e.origin.kind })
    return { text: e.text }
  })
  on('model.complete', async ($, e, next) => {
    w.asked.push(e.prompt)
    w.maxTokens.push(e.maxTokens ?? 0)
    next.signal.addEventListener('abort', () => {
      w.aborted += 1
    })
    const reply = w.replies.shift()
    if (w.holdMs > 0) await clock.sleep(w.holdMs)
    return { value: reply ?? { isAnswered: false as const, reason: 'empty-reply' as const, usage: ZERO } }
  })
  return w
}

export function said(text: string): ModelCompleteResult {
  return { isAnswered: true, text, usage: ZERO }
}

export async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

/** `/better <args>` typed at the prompt. */
export function better($: Engine, args = '') {
  return $.command.run({
    command: 'better',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
}

/** A prompt typed in the prompt box and sent with Enter (the box itself is left alone). */
export function typed($: Engine, text: string, more: Partial<PromptSubmitInput> = {}) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...more })
}

/**
 * A prompt typed in the box and sent with Enter as the REPL does it: the box
 * empties at Enter, and when a hook drops the prompt and the engine hands it
 * back, it lands in the box again.
 */
export async function enter($: Engine, w: World, text: string): Promise<PromptSubmitResult> {
  w.box = ''
  const r = await typed($, text)
  if (r.drop !== undefined && w.handBack) w.box = w.box === '' ? text : `${w.box}\n${text}`
  return r
}

export function paneProps(columns: number) {
  return { title: 'Prompt Upgrade', isFocused: true, bodyColumns: columns, placement: 'dock' } as never
}

export function mountPane<P extends 'terminal' | 'desktop' | 'mobile'>($: Engine, surface: P, columns = 120) {
  return $.ui.mount({ plugin: PLUGIN, surface, ...PANE, props: paneProps(columns) })
}
