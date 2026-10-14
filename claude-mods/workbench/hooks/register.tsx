// workbench: three helpers for a coding day.
//   Idea Shelf        /idea parks a side-thought per project; /ideas sends them later.
//   Assumption Check  Claude notes its small guesses with note_assumption; a band
//                     after the turn opens /assumptions to mark them right or wrong.
//   Reflect           /reflect turns lessons from the session into CLAUDE.md lines.
//
// Every `$` call lives here. Wording and state changes are in logic.ts, the
// drawings in view.tsx.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type {
  WorkbenchGuess,
  WorkbenchIdea,
  WorkbenchNotice,
  WorkbenchReflect,
  WorkbenchShelf,
  WorkbenchTone,
} from '../types'
import {
  ASSUME_OFF,
  ASSUME_ON,
  ASSUME_ON_FAILED,
  ASSUME_PANE,
  ASSUME_SECTION,
  ASSUME_USAGE,
  EDIT_EMPTY,
  EDIT_MOBILE,
  FILL_FAILED,
  FILL_NOTE,
  IDEA_EMPTY,
  IDEA_TOO_LONG,
  MAX_IDEA_CHARS,
  NOTED,
  NOTED_OFF,
  NOTE_FAILED,
  NOTE_MISSING,
  PLUGIN,
  REFLECT_ALL_PRESENT,
  REFLECT_IDLE,
  REFLECT_NOTHING,
  REFLECT_PANE,
  REFLECT_PROMPT,
  REFLECT_READ_FAILED,
  REFLECT_START,
  REFLECT_WRITE_FAILED,
  SECTION_ID,
  SENT_IDEA,
  SHELF_PANE,
  SHELF_UI_CLEAR,
  TOOL_DESCRIPTION,
  TOOL_OFF_DESCRIPTION,
  TOOL_SHORT,
  addGuess,
  addIdea,
  addedNotice,
  afterClose,
  afterFilledSend,
  afterSend,
  allIdeasPrompt,
  announce,
  appendLearned,
  bandCount,
  carriesBlock,
  carriesCorrections,
  copyText,
  correctGuess,
  correctionsPrompt,
  editIdea,
  guessesAsText,
  joinPath,
  keptLines,
  markAnnounced,
  markGuess,
  markedIds,
  offersTool,
  parkedReply,
  parseReflect,
  plural,
  projectName,
  readGuessInput,
  readIdeas,
  removeIdeas,
  sentIdeaIds,
  setKeep,
  shelfAsText,
  shelfKey,
  toItems,
  treeRows,
  wrongCount,
} from './logic'
import { ASSUME_TITLE, REFLECT_TITLE, SHELF_TITLE, drawAssumptions, drawBand, drawReflect, drawShelf } from './view'
import type { FieldKit } from './view'

type Engine = EngineInterface

const STORE_ASSUME_ON = 'assumeOn'
/** workbench's own tool, by its listed name; a RegExp so typing never depends on the laid MCP table. */
const OWN_TOOL = /^mcp__workbench__note_assumption$/

const isWorkingAtom = atom({ plugin: 'workbench', key: 'isWorking' } as const, false)
const turnIdAtom = atom({ plugin: 'workbench', key: 'turnId' } as const, '')
const shelfAtom = atom({ plugin: 'workbench', key: 'shelf' } as const, { root: '', ideas: [] } as WorkbenchShelf)
const shelfUiAtom = atom({ plugin: 'workbench', key: 'shelfUi' } as const, SHELF_UI_CLEAR)
const filledAtom = atom({ plugin: 'workbench', key: 'filled' } as const, [] as string[])
const fixFilledAtom = atom({ plugin: 'workbench', key: 'fixFilled' } as const, [] as string[])
const assumeOnAtom = atom({ plugin: 'workbench', key: 'assumeOn' } as const, true)
const guessesAtom = atom({ plugin: 'workbench', key: 'guesses' } as const, [] as WorkbenchGuess[])
const announcedAtom = atom({ plugin: 'workbench', key: 'announced' } as const, [] as string[])
const assumeNoticeAtom = atom({ plugin: 'workbench', key: 'assumeNotice' } as const, null as WorkbenchNotice | null)
const reflectAtom = atom({ plugin: 'workbench', key: 'reflect' } as const, REFLECT_IDLE)

/** Whether this module registered note_assumption since it loaded (a reload registers again). */
let isToolRegistered = false

// ── Small helpers ──────────────────────────────────────────────────────────

const notice = (text: string, tone: WorkbenchTone): WorkbenchNotice => ({ text, tone })

async function nowMs($: Engine): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

function newId(at: number): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${at.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
  }
}

async function projectRoot($: Engine): Promise<string> {
  try {
    return await $.session.root()
  } catch {
    try {
      return await $.session.cwd()
    } catch {
      return ''
    }
  }
}

async function loadIdeas($: Engine, root: string): Promise<WorkbenchIdea[]> {
  try {
    return readIdeas(await $.store.get(shelfKey(root)))
  } catch {
    return []
  }
}

/** Reads a project's shelf from the store, changes it, writes it back and mirrors it for the pane. */
async function changeShelf(
  $: Engine,
  root: string,
  change: (ideas: WorkbenchIdea[]) => WorkbenchIdea[],
): Promise<WorkbenchIdea[]> {
  const ideas = change(await loadIdeas($, root))
  await $.store.set(shelfKey(root), ideas)
  await update($, shelfAtom, shelf => (shelf.root === root ? { root, ideas } : shelf))
  return ideas
}

/** Runs work off a zero-delay timer, outside the command or press that started it. */
function launch($: Engine, work: () => Promise<void>): void {
  const run = () => {
    void work().catch(() => undefined)
  }
  try {
    $.clock.after(0, run)
  } catch {
    run()
  }
}

/**
 * Puts text in the prompt box, after a blank line when the person already
 * typed something; a box that already holds it is left as it is.
 */
async function fillBox($: Engine, text: string): Promise<boolean> {
  let draft = ''
  try {
    draft = (await $.prompt.read()).text
  } catch {
    draft = ''
  }
  if (carriesBlock(draft, text)) return true
  const filled = await $.prompt.fill(
    draft.trim() === '' ? { text, mode: 'replace' } : { text: `\n\n${text}`, mode: 'append' },
  )
  return filled.isFilled
}

type Delivery = { kind: 'sent' } | { kind: 'filled' } | { kind: 'failed' } | { kind: 'dropped'; reason: string }

/** Sends text as the person's prompt when Claude is idle; while it works, fills the prompt box instead. */
async function deliver($: Engine, text: string): Promise<Delivery> {
  if (!(await read($, isWorkingAtom))) {
    const submitted = await $.prompt.submit({ text, asUser: true })
    if (submitted.drop !== undefined) return { kind: 'dropped', reason: submitted.drop }
    return { kind: 'sent' }
  }
  return (await fillBox($, text)) ? { kind: 'filled' } : { kind: 'failed' }
}

function deliveryNotice(result: Delivery, sentText: string): WorkbenchNotice {
  if (result.kind === 'sent') return notice(sentText, 'good')
  if (result.kind === 'filled') return notice(FILL_NOTE, 'warn')
  if (result.kind === 'dropped') return notice(`It was stopped before it reached Claude: ${result.reason}`, 'warn')
  return notice(FILL_FAILED, 'warn')
}

/** Opens one of the panes; when it cannot be placed, says so in one line and puts its text in the transcript. */
async function openPane($: Engine, id: string, title: string, fallback: () => Promise<string>): Promise<void> {
  const opened = await $.ui.open({ id, title, focus: true, ...(id === SHELF_PANE ? {} : { closeOnEscape: true }) })
  if (opened.isPlaced) return
  $.ui.toast(`The ${title.toLowerCase()} pane has no room here; its contents are in the transcript.`)
  $.ui.log(await fallback())
}

async function closePane($: Engine, id: string): Promise<void> {
  try {
    await $.ui.close({ id })
  } catch {
    // A hook kept it open: nothing to do.
  }
}

function inputKit(kit: ReturnType<EngineInterface['ui']['resolve']>, surface: RenderSurface): FieldKit {
  if (surface !== 'mobile' && 'Input' in kit) {
    return { Box: kit.Box, Text: kit.Text, Button: kit.Button, Input: kit.Input }
  }
  return { Box: kit.Box, Text: kit.Text, Button: kit.Button }
}

// ── Assumption Check: the tool ─────────────────────────────────────────────

async function registerTool($: Engine): Promise<void> {
  await $.tool.register({
    name: TOOL_SHORT,
    description: TOOL_DESCRIPTION,
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        assumption: { type: 'string', description: 'The guess, in one short sentence.' },
        why: { type: 'string', description: 'Optional: why you guessed this.' },
      },
      required: ['assumption'],
    },
  })
  isToolRegistered = true
}

/** Turns Assumption Check on or off; false when the tool could not be added, with nothing changed. */
async function setAssumeOn($: Engine, isOn: boolean): Promise<boolean> {
  if (isOn && !isToolRegistered) {
    try {
      await registerTool($)
    } catch {
      return false
    }
  }
  await $.store.set(STORE_ASSUME_ON, isOn)
  await update($, assumeOnAtom, () => isOn)
  try {
    $.ui.invalidate('tool.describe')
  } catch {
    // The description refreshes on its own at the next session.
  }
  return true
}

// ── Idea Shelf: pane actions ───────────────────────────────────────────────

async function setShelfNotice($: Engine, value: WorkbenchNotice | null): Promise<void> {
  await update($, shelfUiAtom, ui => ({ ...ui, editingId: null, armedId: null, notice: value }))
}

async function sendIdea($: Engine, id: string): Promise<void> {
  const shelf = await read($, shelfAtom)
  const idea = shelf.ideas.find(one => one.id === id)
  if (idea === undefined) return
  const result = await deliver($, idea.text)
  if (result.kind === 'sent') await changeShelf($, shelf.root, ideas => removeIdeas(ideas, [id]))
  if (result.kind === 'filled') await update($, filledAtom, ids => [...ids.filter(one => one !== id), id])
  await setShelfNotice($, deliveryNotice(result, SENT_IDEA))
}

async function sendAllIdeas($: Engine): Promise<void> {
  const shelf = await read($, shelfAtom)
  if (shelf.ideas.length === 0) return
  const ids = shelf.ideas.map(one => one.id)
  const result = await deliver($, allIdeasPrompt(shelf.ideas))
  if (result.kind === 'sent') await changeShelf($, shelf.root, ideas => removeIdeas(ideas, ids))
  if (result.kind === 'filled') await update($, filledAtom, filled => [...new Set([...filled, ...ids])])
  await setShelfNotice($, deliveryNotice(result, `Sent ${plural(ids.length, 'idea')} to Claude as one prompt.`))
}

async function startEdit($: Engine, id: string, hasInput: boolean): Promise<void> {
  const shelf = await read($, shelfAtom)
  const idea = shelf.ideas.find(one => one.id === id)
  if (idea === undefined) return
  if (hasInput) {
    await update($, shelfUiAtom, ui => ({ ...ui, editingId: id, armedId: null, notice: null }))
    try {
      await $.ui.focus({ requestId: SHELF_PANE, key: `edit-field-${id}` })
    } catch {
      // The pane does not hold the keys: the field is there to click.
    }
    return
  }
  const isFilled = await fillBox($, `/idea ${idea.text}`)
  await setShelfNotice($, isFilled ? notice(EDIT_MOBILE, 'muted') : notice(FILL_FAILED, 'warn'))
}

async function saveEdit($: Engine, id: string, value: string): Promise<void> {
  const text = value.trim()
  if (text === '' || text.length > MAX_IDEA_CHARS) {
    const said = text === '' ? EDIT_EMPTY : IDEA_TOO_LONG
    await update($, shelfUiAtom, ui => ({ ...ui, notice: notice(said, 'warn') }))
    return
  }
  const shelf = await read($, shelfAtom)
  await changeShelf($, shelf.root, ideas => editIdea(ideas, id, text))
  await setShelfNotice($, notice('Saved.', 'muted'))
}

async function pressDelete($: Engine, id: string): Promise<void> {
  const ui = await read($, shelfUiAtom)
  if (ui.armedId !== id) {
    await update($, shelfUiAtom, now => ({ ...now, armedId: id, editingId: null, notice: null }))
    return
  }
  const shelf = await read($, shelfAtom)
  await changeShelf($, shelf.root, ideas => removeIdeas(ideas, [id]))
  await update($, filledAtom, ids => ids.filter(one => one !== id))
  await setShelfNotice($, notice('Deleted.', 'muted'))
}

// ── Assumption Check: pane actions ─────────────────────────────────────────

async function sendCorrections($: Engine): Promise<void> {
  const list = await read($, guessesAtom)
  const wrong = wrongCount(list)
  if (wrong === 0) return
  const result = await deliver($, correctionsPrompt(list))
  if (result.kind === 'sent') {
    await update($, guessesAtom, now => afterSend(now))
    await update($, fixFilledAtom, () => [])
  }
  // Only in the prompt box: the marks and typed corrections stay until that text is sent.
  if (result.kind === 'filled') {
    const ids = markedIds(list)
    await update($, fixFilledAtom, now => [...new Set([...now, ...ids])])
  }
  const sentText = `Sent ${plural(wrong, 'correction')} to Claude.`
  await update($, assumeNoticeAtom, () => deliveryNotice(result, sentText))
}

async function markAllRight($: Engine): Promise<void> {
  const list = await read($, guessesAtom)
  if (list.length === 0) return
  await update($, guessesAtom, () => [])
  await update($, announcedAtom, () => [])
  await update($, fixFilledAtom, () => [])
  const said = list.length === 1 ? 'The guess is marked right.' : `All ${list.length} guesses marked right.`
  await update($, assumeNoticeAtom, () => notice(said, 'good'))
}

/** What closing the Assumptions pane settles, however it closes: right and skipped guesses go. */
async function settleAssumptions($: Engine): Promise<void> {
  await update($, guessesAtom, now => afterClose(now))
  await update($, assumeNoticeAtom, () => null)
}

/**
 * The Close button. A plugin's own close does not pass through its own
 * ui.close hook, so it settles here; the hook settles every other close.
 */
async function closeAssumptions($: Engine): Promise<void> {
  await settleAssumptions($)
  await closePane($, ASSUME_PANE)
}

/** After a /clear: the guesses belong to a conversation Claude no longer has. */
async function forgetConversation($: Engine): Promise<void> {
  await update($, guessesAtom, () => [])
  await update($, announcedAtom, () => [])
  await update($, fixFilledAtom, () => [])
  await update($, assumeNoticeAtom, () => null)
  await update($, isWorkingAtom, () => false)
  await update($, turnIdAtom, () => '')
}

async function openAssumptions($: Engine): Promise<void> {
  await update($, assumeNoticeAtom, () => null)
  await openPane($, ASSUME_PANE, ASSUME_TITLE, async () => guessesAsText(await read($, guessesAtom)))
}

// ── Reflect ────────────────────────────────────────────────────────────────

async function readClaudeMd($: Engine, path: string): Promise<{ text: string; isNew: boolean }> {
  const exists = await $.fs.exists(path)
  if (!exists) return { text: '', isNew: true }
  const text = await $.fs.read(path)
  return { text: typeof text === 'string' ? text : '', isNew: false }
}

/** Starts a reflection: the pane shows the loading line, the fork runs off a timer. */
async function beginReflect($: Engine): Promise<number> {
  const root = await projectRoot($)
  const target = joinPath(root, 'CLAUDE.md')
  const next = await update($, reflectAtom, (r): WorkbenchReflect => ({ ...REFLECT_IDLE, step: 'loading', target, seq: r.seq + 1 }))
  launch($, () => runReflect($, next.seq, target))
  return next.seq
}

async function runReflect($: Engine, seq: number, target: string): Promise<void> {
  const apply = (change: (r: WorkbenchReflect) => WorkbenchReflect) =>
    update($, reflectAtom, r => (r.seq === seq ? change(r) : r))
  try {
    const reply = await $.model.fork({ prompt: REFLECT_PROMPT })
    if (!reply.isAnswered) {
      await apply(r => ({ ...r, step: reply.reason === 'nothing-to-fork' ? 'nothing' : 'error' }))
      return
    }
    const lines = parseReflect(reply.text)
    if (lines === null) {
      await apply(r => ({ ...r, step: 'error' }))
      return
    }
    if (lines.length === 0) {
      await apply(r => ({ ...r, step: 'empty' }))
      return
    }
    let existing = { text: '', isNew: true }
    try {
      existing = await readClaudeMd($, target)
    } catch {
      existing = { text: '', isNew: false }
    }
    await apply(r => ({ ...r, step: 'ready', isNew: existing.isNew, items: toItems(lines, existing.text) }))
  } catch {
    await apply(r => ({ ...r, step: 'error' }))
  }
}

async function addToClaudeMd($: Engine): Promise<void> {
  const r = await read($, reflectAtom)
  const lines = keptLines(r.items)
  if (r.step !== 'ready' || r.isAdded || lines.length === 0) return
  const say = (text: string, tone: WorkbenchTone, isAdded = false) =>
    update($, reflectAtom, now => (now.seq === r.seq ? { ...now, notice: notice(text, tone), isAdded: now.isAdded || isAdded } : now))
  let existing: { text: string; isNew: boolean }
  try {
    existing = await readClaudeMd($, r.target)
  } catch {
    await say(REFLECT_READ_FAILED, 'warn')
    return
  }
  const appended = appendLearned(existing.text, lines)
  if (appended.added.length === 0) {
    await say(REFLECT_ALL_PRESENT, 'muted')
    return
  }
  try {
    await $.fs.write(r.target, appended.text)
  } catch {
    await say(REFLECT_WRITE_FAILED, 'warn')
    return
  }
  await say(addedNotice(appended.added.length), 'good', true)
}

async function copyKept($: Engine, surface: RenderSurface): Promise<void> {
  const r = await read($, reflectAtom)
  const lines = keptLines(r.items)
  if (lines.length === 0) return
  const copied = await $.ui.copy({ text: copyText(lines), surface })
  const said = copied.isCopied
    ? notice(`Copied ${plural(lines.length, 'line')}.`, 'good')
    : notice("Couldn't copy on this screen.", 'warn')
  await update($, reflectAtom, now => (now.seq === r.seq ? { ...now, notice: said } : now))
}

// ── Registration ───────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      const stored = await $.store.get(STORE_ASSUME_ON)
      await update($, assumeOnAtom, () => stored !== false)
    } catch {
      // Keep the default: on.
    }
    try {
      const root = await projectRoot($)
      const ideas = await loadIdeas($, root)
      await update($, shelfAtom, () => ({ root, ideas }))
    } catch {
      // The shelf loads again when /idea or /ideas runs.
    }
    // Each on its own, so one failing to register leaves the others working.
    await $.command
      .register({
        name: 'idea',
        description: "Park an idea on this project's shelf without interrupting Claude",
        argumentHint: '<idea>',
        immediate: true,
      })
      .catch(() => undefined)
    await $.command
      .register({ name: 'ideas', description: "Open this project's idea shelf to send, edit or delete ideas", immediate: true })
      .catch(() => undefined)
    await $.command
      .register({
        name: 'assumptions',
        description: 'Check the small guesses Claude made, or turn Assumption Check on or off',
        argumentHint: '[on|off]',
        immediate: true,
      })
      .catch(() => undefined)
    await $.command
      .register({ name: 'reflect', description: 'Turn lessons from this session into lines for CLAUDE.md', immediate: true })
      .catch(() => undefined)
    try {
      if (await read($, assumeOnAtom)) await registerTool($)
    } catch {
      // Without the tool, the section is left out of the prompt too (offersTool).
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await forgetConversation($)
      } catch {
        // The old guesses stay listed; nothing else depends on them.
      }
    }
    return next(e)
  })

  // ── Turn tracking ────────────────────────────────────────────────────────

  on('turn.start', async ($, e, next) => {
    try {
      await update($, isWorkingAtom, () => true)
      await update($, turnIdAtom, () => e.turnId)
    } catch {
      // Without it, Send fills the prompt box less often: harmless.
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await update($, isWorkingAtom, () => false)
        await update($, turnIdAtom, () => '')
        // Every guess noted since the last main turn ended joins the band, a helper's between turns too.
        const ids = announce(await read($, guessesAtom), await read($, announcedAtom))
        if (ids !== null) {
          await update($, guessesAtom, now => markAnnounced(now, ids))
          await update($, announcedAtom, () => ids)
        }
      } catch {
        // The band stays as it was.
      }
    }
    return next(e)
  })

  // ── Idea Shelf ───────────────────────────────────────────────────────────

  on('command.run', { command: 'idea' }, async ($, e) => {
    try {
      const text = e.args.trim()
      if (text === '') return { text: IDEA_EMPTY }
      if (text.length > MAX_IDEA_CHARS) return { text: IDEA_TOO_LONG }
      const root = await projectRoot($)
      const at = await nowMs($)
      const ideas = addIdea(await loadIdeas($, root), { id: newId(at), text, at })
      await $.store.set(shelfKey(root), ideas)
      await update($, shelfAtom, () => ({ root, ideas }))
      return { text: parkedReply(ideas.length, projectName(root)) }
    } catch {
      return { text: "Couldn't park that idea. Nothing was saved." }
    }
  }).catch(() => ({ text: "Couldn't park that idea. Nothing was saved." }))

  on('command.run', { command: 'ideas' }, async $ => {
    try {
      const root = await projectRoot($)
      const ideas = await loadIdeas($, root)
      await update($, shelfAtom, () => ({ root, ideas }))
      await update($, shelfUiAtom, () => SHELF_UI_CLEAR)
      void (async () => {
        try {
          await openPane($, SHELF_PANE, SHELF_TITLE, async () => shelfAsText(root, ideas))
        } catch {
          $.ui.toast("The idea shelf couldn't open.")
        }
      })()
      return { text: `Opening the idea shelf (${plural(ideas.length, 'idea')} for ${projectName(root)}).` }
    } catch {
      return { text: "Couldn't open the idea shelf." }
    }
  }).catch(() => ({ text: "Couldn't open the idea shelf." }))

  // What was put in the prompt box while Claude worked (ideas, corrections) is settled once
  // that text is sent: by the person, or by another plugin that held it and sends it on
  // (prompt-upgrade's Run). The person's next prompt ends the wait either way.
  on('prompt.submit', async ($, e, next) => {
    const filled = await read($, filledAtom)
    const fixes = await read($, fixFilledAtom)
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    const isOtherPlugin = e.origin.kind === 'plugin' && e.origin.name !== PLUGIN
    if ((filled.length === 0 && fixes.length === 0) || (!isPerson && !isOtherPlugin)) return next(e)
    const entered = await next(e)
    if (entered.drop !== undefined) return entered
    try {
      const texts = [e.text, entered.text]
      if (filled.length > 0) {
        const shelf = await read($, shelfAtom)
        const sent = [...new Set(texts.flatMap(text => sentIdeaIds(text, shelf.ideas, filled)))]
        if (sent.length > 0) await changeShelf($, shelf.root, ideas => removeIdeas(ideas, sent))
        await update($, filledAtom, ids => (isPerson ? [] : ids.filter(id => !sent.includes(id))))
      }
      if (fixes.length > 0) {
        const isSent = texts.some(carriesCorrections)
        if (isSent) {
          await update($, guessesAtom, list => afterFilledSend(list, fixes))
          await update($, assumeNoticeAtom, () => null)
        }
        if (isSent || isPerson) await update($, fixFilledAtom, () => [])
      }
    } catch {
      // What was filled stays listed: nothing lost.
    }
    return entered
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'workbench-shelf' }, async ($, e) => {
    const kit = inputKit($.ui.resolve(e), e.surface)
    const hasInput = kit.Input !== undefined
    const shelf = await read($, shelfAtom)
    const ui = await read($, shelfUiAtom)
    const now = await nowMs($)
    return drawShelf(
      kit,
      { columns: Math.max(1, e.props.bodyColumns), root: shelf.root, ideas: shelf.ideas, ui, now },
      {
        send: id => sendIdea($, id),
        edit: id => startEdit($, id, hasInput),
        saveEdit: (id, text) => saveEdit($, id, text),
        cancelEdit: () => update($, shelfUiAtom, now2 => ({ ...now2, editingId: null })),
        remove: id => pressDelete($, id),
        sendAll: () => sendAllIdeas($),
        close: () => closePane($, SHELF_PANE),
      },
    )
  })

  // ── Assumption Check ─────────────────────────────────────────────────────

  on('tool.call', { tool: OWN_TOOL }, async ($, e) => {
    if (!(await read($, assumeOnAtom))) return { result: NOTED_OFF }
    const input = readGuessInput(e)
    if (input === null) return { deny: NOTE_MISSING }
    const at = await nowMs($)
    let turn = 0
    try {
      turn = await $.session.turns()
    } catch {
      turn = 0
    }
    const guess: WorkbenchGuess = {
      id: newId(at),
      text: input.text,
      why: input.why,
      turn,
      turnId: await read($, turnIdAtom),
      at,
      agentId: e.agentId ?? null,
      mark: null,
      correction: '',
      isAnnounced: false,
    }
    await update($, guessesAtom, list => addGuess(list, guess))
    return { result: NOTED }
  }).catch(() => ({ result: NOTE_FAILED }))

  on('tool.describe', { tool: OWN_TOOL }, async ($, e, next) => {
    if (await read($, assumeOnAtom)) return next(e)
    return { description: TOOL_OFF_DESCRIPTION, isDeferred: true }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, assumeOnAtom)) || !offersTool(e.tools)) return composed
    if (composed.sections.some(section => section.id === SECTION_ID)) return composed
    return { sections: [...composed.sections, { id: SECTION_ID, text: ASSUME_SECTION, scope: 'session' as const }] }
  })

  on('command.run', { command: 'assumptions' }, async ($, e) => {
    try {
      const arg = e.args.trim().toLowerCase()
      if (arg === 'on' || arg === 'off') {
        if (!(await setAssumeOn($, arg === 'on'))) return { text: ASSUME_ON_FAILED }
        return { text: arg === 'on' ? ASSUME_ON : ASSUME_OFF }
      }
      if (arg !== '') return { text: ASSUME_USAGE }
      const list = await read($, guessesAtom)
      void (async () => {
        try {
          await openAssumptions($)
        } catch {
          $.ui.toast("The assumptions pane couldn't open.")
        }
      })()
      return { text: list.length === 0 ? 'Opening Assumptions: no guesses to check yet.' : `Opening Assumptions (${plural(list.length, 'guess', 'guesses')} to check).` }
    } catch {
      return { text: "Couldn't run /assumptions. Nothing was changed." }
    }
  }).catch(() => ({ text: "Couldn't run /assumptions. Nothing was changed." }))

  // One row on top of whatever else draws in the band (another mod's, the engine's), never in its place,
  // and only while maxRows has a row left over what is beneath. The wrapper is a plain column Box: an
  // engine node under a Box with a size, display, overflow or position is refused, the band with it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.maxRows < 1) return next(e)
    const isOn = await read($, assumeOnAtom)
    const count = bandCount(await read($, guessesAtom), await read($, announcedAtom))
    if (!isOn || count === 0) return next(e)
    const below = await next(e)
    if (e.props.maxRows - treeRows(below) < 1) return below
    const kit = $.ui.resolve(e)
    const { Box } = kit
    const columns = Math.max(1, e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        {drawBand(kit, count, columns, {
          check: () => openAssumptions($),
          dismiss: () => update($, announcedAtom, () => []),
        })}
        {below}
      </Box>
    )
  })

  // The person's close (Esc, the close mark) settles the guesses as the Close button does.
  on('ui.close', { id: 'workbench-assumptions' }, async ($, e, next) => {
    const closed = await next(e)
    try {
      await settleAssumptions($)
    } catch {
      // They stay listed until the next close.
    }
    return closed
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'workbench-assumptions' }, async ($, e) => {
    const kit = inputKit($.ui.resolve(e), e.surface)
    const isOn = await read($, assumeOnAtom)
    const guesses = await read($, guessesAtom)
    const said = await read($, assumeNoticeAtom)
    return drawAssumptions(
      kit,
      { columns: Math.max(1, e.props.bodyColumns), isOn, guesses, notice: said },
      {
        mark: (id, mark) => update($, guessesAtom, list => markGuess(list, id, mark)),
        correct: (id, text) => update($, guessesAtom, list => correctGuess(list, id, text)),
        send: () => sendCorrections($),
        allRight: () => markAllRight($),
        close: () => closeAssumptions($),
      },
    )
  })

  // ── Reflect ──────────────────────────────────────────────────────────────

  on('command.run', { command: 'reflect' }, async $ => {
    try {
      let turns = 1
      try {
        turns = await $.session.turns()
      } catch {
        turns = 1
      }
      if (turns === 0) return { text: REFLECT_NOTHING }
      await beginReflect($)
      void (async () => {
        try {
          await openPane($, REFLECT_PANE, REFLECT_TITLE, async () => 'Reflect could not show its pane here. Widen the window and run /reflect again.')
        } catch {
          $.ui.toast("The reflect pane couldn't open.")
        }
      })()
      return { text: REFLECT_START }
    } catch {
      return { text: "Couldn't start reflecting. Nothing was changed." }
    }
  }).catch(() => ({ text: "Couldn't start reflecting. Nothing was changed." }))

  on('ui.render', { component: 'Pane', requestId: 'workbench-reflect' }, async ($, e) => {
    const kit = inputKit($.ui.resolve(e), e.surface)
    const reflect = await read($, reflectAtom)
    return drawReflect(
      kit,
      { columns: Math.max(1, e.props.bodyColumns), reflect },
      {
        keep: (index, keep) =>
          update($, reflectAtom, r => ({ ...r, items: setKeep(r.items, index, keep), notice: r.isAdded ? r.notice : null })),
        add: () => addToClaudeMd($),
        copy: () => copyKept($, e.surface),
        retry: () => beginReflect($),
        close: () => closePane($, REFLECT_PANE),
      },
    )
  })
}
