// The engine beneath workbench in the tests: the hooks registered on `on`
// answer what the mod asks of it, and record what it did.

import { expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import type { WorkbenchIdea } from '../types'
import { TOOL_NAME } from '../hooks/logic'

export const ROOT = '/Users/leland/code/earshot'
export const OTHER = '/Users/leland/code/other'
export const SHELF = { component: 'Pane', requestId: 'workbench-shelf' } as const
export const ASSUME = { component: 'Pane', requestId: 'workbench-assumptions' } as const
export const REFLECT = { component: 'Pane', requestId: 'workbench-reflect' } as const
export const BAND = { component: 'AbovePrompt' } as const
export const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
/** What `next(e)` resolves to in the band when nothing else draws there: the engine's own node. */
export const ENGINE_NODE = { type: 'engine', ref: 0 } as unknown as RenderElement
/** Another plugin's one-row band beneath workbench's. */
export const OTHER_BAND = { type: 'Text', props: {}, children: ['OTHER BAND'] } as unknown as RenderElement

export type World = {
  root: string
  turns: number
  submits: string[]
  fills: string[]
  /** What the prompt box holds: fills land here, the person's submit empties it. */
  box: string
  writes: { path: string; text: string }[]
  files: Record<string, string>
  toasts: string[]
  logs: string[]
  opened: string[]
  closed: string[]
  copies: string[]
  registered: string[]
  forkReply: unknown
  forkPrompts: string[]
  store: Record<string, unknown>
  /** When true, tool.register refuses. */
  registerFails: boolean
  /** When false, ui.open answers that the pane waits undrawn. */
  isPlaced: boolean
  /** When true, the person's own prompts are held by a plugin beneath (as prompt-upgrade does). */
  holdsComposer: boolean
  /** What draws in the band beneath workbench: the engine's node unless a test puts another band there. */
  below: RenderElement
}

/**
 * The engine beneath the plugin, answering what the mod asks of it. The store
 * is `mock.store` when `isMockStore`, else a record the test can read back.
 */
export function world(on: On, store: Record<string, unknown> = {}, isMockStore = false): World {
  const w: World = {
    root: ROOT,
    turns: 2,
    submits: [],
    fills: [],
    box: '',
    writes: [],
    files: {},
    toasts: [],
    logs: [],
    opened: [],
    closed: [],
    copies: [],
    registered: [],
    forkReply: { isAnswered: true, text: '{"lines":[]}', usage: USAGE },
    forkPrompts: [],
    store: { ...store },
    registerFails: false,
    isPlaced: true,
    holdsComposer: false,
    below: ENGINE_NODE,
  }
  if (isMockStore) {
    mock.store(on, store)
  } else {
    on('store.get', ($, e) => ({ value: w.store[e.key] }))
    on('store.set', ($, e) => {
      w.store[e.key] = JSON.parse(JSON.stringify(e.value))
      return { value: undefined }
    })
  }
  // What is beneath workbench's band: the engine's own node, or another plugin's band.
  on('ui.render', { component: 'AbovePrompt' }, () => w.below)
  on('session.root', () => ({ value: w.root }))
  on('session.cwd', () => ({ value: w.root }))
  on('session.turns', () => ({ value: w.turns }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => {
    if (w.registerFails) return { deny: 'tools are locked' }
    w.registered.push(e.name)
    return { value: { tool: TOOL_NAME } }
  })
  on('tool.describe', ($, e) => ({ description: e.description }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: w.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'the terminal is 90 columns wide' } }
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    w.copies.push(e.text)
    return { value: { isCopied: true } }
  })
  on('prompt.read', () => ({ value: { text: w.box, cursor: w.box.length } }))
  on('prompt.fill', ($, e) => {
    w.fills.push(e.text)
    w.box = e.mode === 'append' ? `${w.box}${e.text}` : e.text
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'composer') {
      w.box = ''
      if (w.holdsComposer) return { drop: 'held for an upgrade' }
    }
    w.submits.push(e.text)
    return { text: e.text }
  })
  on('fs.exists', ($, e) => ({ value: w.files[e.path] !== undefined }))
  on('fs.read', ($, e) => {
    const text = w.files[e.path]
    return text !== undefined ? { value: text } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.write', ($, e) => {
    w.writes.push({ path: e.path, text: e.text })
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('model.fork', ($, e) => {
    w.forkPrompts.push(e.prompt)
    return { value: w.forkReply as never }
  })
  return w
}

/** A slash command as the person types it. */
export function command($: Engine, name: string, args = '') {
  return $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
}

export async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

export function shelfOf(w: World, root: string): WorkbenchIdea[] {
  return (w.store[`shelf:${root}`] ?? []) as WorkbenchIdea[]
}

export function paneProps(columns: number) {
  return { title: 'Pane', isFocused: false, bodyColumns: columns, placement: 'dock' } as never
}

export function bandProps(columns: number, hasSurvey = false, maxRows = 6) {
  return {
    hasSurvey,
    isWorking: false,
    maxRows,
    bodyColumns: columns,
    scroll: { offset: 0, bodyRows: maxRows },
    view: {},
  } as never
}

export async function turnStarts($: Engine, turnId: string): Promise<void> {
  await $.turn.start({ text: 'go', turnId })
}

export async function turnEnds($: Engine, turnId: string): Promise<void> {
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

/**
 * Claude calling note_assumption. The input is cast so the test's typing
 * never depends on whether the laid table of MCP tools lists the mod's tool.
 */
export function note($: Engine, assumption: string, why?: string, agentId?: string) {
  type Args = Parameters<Engine['tool']['call']>[0]
  const input = {
    tool: TOOL_NAME,
    tool_use_id: `toolu_${assumption.length}`,
    assumption,
    ...(why !== undefined ? { why } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
  }
  return $.tool.call(input as unknown as Args)
}

/** The person sending a prompt from the prompt box. */
export function personSends($: Engine, text: string) {
  return $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
}

// ── Widths ─────────────────────────────────────────────────────────────────

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown }

function flat(children: unknown): unknown[] {
  if (children === undefined || children === null || children === false) return []
  if (!Array.isArray(children)) return [children]
  return children.flatMap(flat)
}

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object' || node === null) return ''
  return flat((node as Drawn).children).map(textOf).join('')
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

/**
 * The cells a drawn element needs across, from its content: a row's children
 * side by side with their gaps, a column's widest child, margins, padding and
 * borders added. A row of chips wider than its pane shows here even when each
 * Text alone fits.
 */
export function naturalWidth(node: unknown): number {
  if (typeof node === 'string' || typeof node === 'number') return Array.from(String(node)).length
  if (typeof node !== 'object' || node === null) return 0
  const { type, props = {} } = node as Drawn
  const kids = flat((node as Drawn).children)
  const margin = count(props['marginLeft']) + count(props['marginRight']) + 2 * count(props['marginX'])
  let inner = 0
  if (type === 'Text') inner = Array.from(textOf(node)).length
  else if (type === 'Button') inner = kids.length > 0 ? kids.reduce<number>((sum, kid) => sum + naturalWidth(kid), 0) : Array.from(String(props['label'] ?? '')).length
  else if (type === 'Box') {
    const widths = kids.map(naturalWidth)
    const isRow = (props['flexDirection'] ?? 'row') === 'row'
    const gap = count(props['gap'] ?? props['columnGap'])
    const pad = 2 * count(props['paddingX']) + count(props['paddingLeft']) + count(props['paddingRight']) + (props['borderStyle'] !== undefined ? 2 : 0)
    inner = (isRow ? widths.reduce((sum, one) => sum + one, 0) + gap * Math.max(0, widths.length - 1) : Math.max(0, ...widths)) + pad
  }
  return inner + margin
}

type Drawing = {
  findAll: (q: { type: string }) => Promise<{ text: string }[]>
  drawn: () => Promise<unknown>
}

/** No Text is wider than `columns`, and no row of the tree needs more than `columns`. */
export async function widthsFit(ui: Drawing, columns: number): Promise<void> {
  for (const one of await ui.findAll({ type: 'Text' })) {
    expect(Array.from(one.text).length, `"${one.text}" is wider than ${columns}`).toBeLessThanOrEqual(columns)
  }
  const tree = await ui.drawn()
  expect(naturalWidth(tree), `the drawing needs more than ${columns} columns`).toBeLessThanOrEqual(columns)
}
