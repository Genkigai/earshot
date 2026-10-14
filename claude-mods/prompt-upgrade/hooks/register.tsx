// prompt-upgrade: turns a rough prompt into a clear coding request before it
// is sent. A pane asks up to three quick questions, rewrites the prompt and
// shows the original and the upgrade side by side; nothing runs until Run.
//
// Every `$` call lives here. The rules and text are in logic.ts, the panes'
// drawing in view.tsx.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { UpgradeDrafts, UpgradeEntry, UpgradeFlow } from '../types'
import {
  HANDBACK_CHECK_MS,
  IDLE,
  MODEL,
  MODEL_TIMEOUT_MS,
  NO_DRAFTS,
  QUESTIONS_MAX_TOKENS,
  SYSTEM,
  addEntry,
  addPassOnce,
  answerFlow,
  answeredPairs,
  applyFailure,
  applyQuestions,
  applyRewrite,
  beginFlow,
  chosenEdit,
  composeFlow,
  editFlow,
  entryFromFlow,
  failureText,
  hasPendingEdit,
  hasUnsent,
  isBusy,
  isCurrent,
  isLoading,
  judgeSubmit,
  openOtherFlow,
  parseQuestions,
  parseRewrite,
  questionsPrompt,
  removePassOnce,
  resetFlow,
  retryFlow,
  reviewFromEntry,
  rewriteBudget,
  rewritePrompt,
  sanitizeHistory,
  skipRestFlow,
  textToRun,
  toLoading,
  updateEntry,
  withNotice,
} from './logic'
import type { ModelFailure } from './logic'
import { HISTORY_TITLE, TITLE, drawFlow, drawHistory } from './view'
import type { FlowActions, FlowKit } from './view'

type Engine = EngineInterface

const PANE = 'prompt-upgrade'
const HISTORY_PANE = 'prompt-upgrade-history'

const STORE_ON = 'isOn'
const STORE_HISTORY = 'history'

const flowAtom = atom({ plugin: 'prompt-upgrade', key: 'flow' } as const, IDLE)
const isOnAtom = atom({ plugin: 'prompt-upgrade', key: 'isOn' } as const, false)
const historyAtom = atom({ plugin: 'prompt-upgrade', key: 'history' } as const, [] as UpgradeEntry[])
const passOnceAtom = atom({ plugin: 'prompt-upgrade', key: 'passOnce' } as const, [] as string[])
const draftsAtom = atom({ plugin: 'prompt-upgrade', key: 'drafts' } as const, NO_DRAFTS)

const NARROW_PROMPT = 'The window is too narrow for Prompt Upgrade, so your prompt is back in the box.'
const NARROW = 'The window is too narrow for Prompt Upgrade.'
const HELD = 'Held for Prompt Upgrade; nothing was sent. Press Run in its pane to send it.'
const BUSY = 'Prompt Upgrade is still on another prompt, so this one is back in the box. Finish or cancel that upgrade first.'
const SAME = 'This prompt is already in Prompt Upgrade. Press Run in its pane to send it, or Cancel there.'
const BUSY_NOTICE = 'Finish or cancel this upgrade first; your new prompt is back in the box.'
const BUSY_HISTORY_NOTICE = 'Finish or cancel this upgrade first, then pick from history again.'
const FAILED = 'Prompt Upgrade could not start. Nothing was sent.'
const NOT_BACK = 'Prompt Upgrade could not put your prompt back in the box; it is in the transcript.'
const ON_TEXT = 'Automatic mode is on: prompts you type go to Prompt Upgrade first. Start a prompt with > to send it as is.'
const OFF_TEXT = 'Automatic mode is off. Type /better followed by a prompt to upgrade one.'

/**
 * The model calls in flight, by the requestSeq they were asked under, so a
 * Cancel, Run or close stops them instead of letting them run on. A reload
 * loses the map; the calls then finish and their results are ignored as stale.
 */
const calls = new Map<number, AbortController>()

function abortCalls(): void {
  for (const one of calls.values()) one.abort()
  calls.clear()
}

async function nowMs($: Engine): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

function newId(now: number): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${now}-${Math.floor(Math.random() * 1e9)}`
  }
}

/**
 * Opens the upgrade pane; resolves whether it is drawn. Never rejects. No
 * `closeOnEscape`: Esc in one of its fields only hands the keys back, so typed
 * text is never thrown away by a habit key.
 */
function openFlowPane($: Engine): Promise<boolean> {
  return $.ui
    .open({ id: PANE, title: TITLE, focus: true, rows: 24 })
    .then(
      r => r.isPlaced,
      () => false,
    )
}

/**
 * Runs model work off a zero-delay timer, outside the press, command or prompt
 * that started it, so it never rides (or is cut with) that dispatch.
 */
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

/** Applies a flow change; a change into a loading step starts that step's model call. */
async function transition($: Engine, change: (flow: UpgradeFlow) => UpgradeFlow): Promise<UpgradeFlow> {
  const seen = { before: IDLE }
  const after = await update($, flowAtom, flow => {
    seen.before = flow
    return change(flow)
  })
  const moved = after.requestSeq !== seen.before.requestSeq || after.step !== seen.before.step
  const seq = after.requestSeq
  if (moved && after.step === 'questions-loading') launch($, () => askQuestions($, seq))
  if (moved && after.step === 'rewrite-loading') launch($, () => askRewrite($, seq))
  return after
}

/** Writes a model result only while the call is still current (no redraw for a stale one). */
async function settleCall(
  $: Engine,
  seq: number,
  step: 'questions-loading' | 'rewrite-loading',
  change: (flow: UpgradeFlow) => UpgradeFlow | null,
): Promise<void> {
  if (!isCurrent(await read($, flowAtom), seq, step)) return
  await transition($, flow => change(flow) ?? flow)
}

type Reply = { ok: true; text: string } | { ok: false; message: string }

/** One call to the fast model; always resolves, a failure as a calm sentence. */
async function ask($: Engine, seq: number, prompt: string, maxTokens: number, timeoutMs: number): Promise<Reply> {
  const stop = new AbortController()
  calls.set(seq, stop)
  try {
    const r = await $.model.complete({ model: MODEL, system: SYSTEM, prompt, maxTokens, timeoutMs }, { signal: stop.signal })
    if (r.isAnswered) return { ok: true, text: r.text }
    const failure: ModelFailure = r.reason === 'api-error' ? { reason: r.reason, status: r.status, error: r.error } : { reason: r.reason }
    return { ok: false, message: failureText(failure) }
  } catch {
    return { ok: false, message: failureText({ reason: 'refused' }) }
  } finally {
    if (calls.get(seq) === stop) calls.delete(seq)
  }
}

async function askQuestions($: Engine, seq: number): Promise<void> {
  try {
    const flow = await read($, flowAtom)
    if (!isCurrent(flow, seq, 'questions-loading')) return
    const reply = await ask($, seq, questionsPrompt(flow.original), QUESTIONS_MAX_TOKENS, MODEL_TIMEOUT_MS)
    if (!reply.ok) {
      await settleCall($, seq, 'questions-loading', f => applyFailure(f, seq, 'questions-loading', reply.message))
      return
    }
    const questions = parseQuestions(reply.text)
    await settleCall($, seq, 'questions-loading', f => applyQuestions(f, seq, questions))
  } catch {
    const message = failureText({ reason: 'thrown' })
    await settleCall($, seq, 'questions-loading', f => applyFailure(f, seq, 'questions-loading', message)).catch(() => undefined)
  }
}

async function askRewrite($: Engine, seq: number): Promise<void> {
  try {
    const flow = await read($, flowAtom)
    if (!isCurrent(flow, seq, 'rewrite-loading')) return
    const budget = rewriteBudget(flow.original)
    const reply = await ask($, seq, rewritePrompt(flow.original, answeredPairs(flow)), budget.maxTokens, budget.timeoutMs)
    const rewrite = reply.ok ? parseRewrite(reply.text) : null
    if (rewrite === null) {
      const message = reply.ok ? failureText({ reason: 'unreadable' }) : reply.message
      await settleCall($, seq, 'rewrite-loading', f => applyFailure(f, seq, 'rewrite-loading', message))
      return
    }
    if (!isCurrent(await read($, flowAtom), seq, 'rewrite-loading')) return
    const now = await nowMs($)
    const fresh = newId(now)
    const mark = { applied: false }
    const done = await update($, flowAtom, f => {
      const next = applyRewrite(f, seq, rewrite)
      mark.applied = next !== null
      // An entry saved earlier as "not sent" keeps its id, so the review updates it.
      return next === null ? f : { ...next, historyId: next.historyId ?? fresh }
    })
    if (!mark.applied || done.historyId === null) return
    const entry = entryFromFlow(done, done.historyId, now)
    await saveHistory($, list => addEntry(list, entry))
  } catch {
    const message = failureText({ reason: 'thrown' })
    await settleCall($, seq, 'rewrite-loading', f => applyFailure(f, seq, 'rewrite-loading', message)).catch(() => undefined)
  }
}

async function saveHistory($: Engine, change: (list: UpgradeEntry[]) => UpgradeEntry[]): Promise<void> {
  const list = await update($, historyAtom, change)
  try {
    await $.store.set(STORE_HISTORY, list)
  } catch {
    // The session still holds it; the next save tries again.
  }
}

/** Whether the prompt box already holds `text` (a copy the engine handed back, or one put there before). */
function holds(draft: string, text: string): boolean {
  const wanted = text.trim()
  if (wanted === '') return true
  const box = draft.trim()
  // A long text inside other words is the same text; a short one could be part of another word.
  return box === wanted || (wanted.length >= 20 && box.includes(wanted))
}

/**
 * Puts text back in the prompt box without losing anything already typed
 * there. A box holding only `over` (the engine's copy of the held original)
 * is replaced instead of added to.
 */
async function putBack($: Engine, text: string, over?: string): Promise<boolean> {
  let draft = ''
  try {
    draft = (await $.prompt.read()).text
  } catch {
    draft = ''
  }
  if (holds(draft, text)) return true
  const isSpare = draft.trim() === '' || (over !== undefined && over.trim() !== '' && draft.trim() === over.trim())
  try {
    const r = isSpare ? await $.prompt.fill({ text, mode: 'replace' }) : await $.prompt.fill({ text: `\n\n${text}`, mode: 'append' })
    return r.isFilled
  } catch {
    return false
  }
}

/** Puts text back in the box; when the box cannot take it, says so and keeps it in the transcript. */
async function returnToBox($: Engine, text: string, over?: string): Promise<void> {
  if (text.trim() === '') return
  if (await putBack($, text, over)) return
  $.ui.toast(NOT_BACK)
  $.ui.log(`Your prompt: ${text}`)
}

/**
 * After a typed prompt was held back (dropped) without a flow taking it: the
 * engine may hand a dropped prompt back to the box itself, so the mod looks a
 * moment later and puts it there only when it is not there yet.
 */
function returnHeldToBox($: Engine, text: string): void {
  const check = () => {
    void returnToBox($, text).catch(() => undefined)
  }
  try {
    $.clock.after(HANDBACK_CHECK_MS, check)
  } catch {
    check()
  }
}

/** After a send: the engine's copy of the held original leaves the box, so Enter cannot send it a second time. */
async function clearHeld($: Engine, original: string): Promise<void> {
  const held = original.trim()
  if (held === '') return
  try {
    const box = (await $.prompt.read()).text
    if (box.trim() === held) await $.prompt.fill({ text: '', mode: 'replace' })
  } catch {
    // The box keeps the copy; nothing is lost.
  }
}

/** After a cancel or close: the original goes back in the prompt box, so nothing is lost. */
async function restoreOriginal($: Engine, flow: UpgradeFlow): Promise<void> {
  if (flow.fromHistory || flow.original.trim() === '') return
  await returnToBox($, flow.original)
}

/**
 * A second prompt arrived while one is under way: the one under way is saved
 * to history as "not sent" (so it is never only in the pane) and the pane says
 * why the new one went back to the box.
 */
async function keepUnsent($: Engine, notice: string): Promise<void> {
  const now = await nowMs($)
  const fresh = newId(now)
  const drafts = await read($, draftsAtom)
  const flow = await update($, flowAtom, f => {
    if (hasUnsent(f)) return withNotice({ ...f, historyId: f.historyId ?? fresh }, notice)
    // A compose field or a reopened review's typed edit stays in the pane; only the note is added.
    return f.step === 'compose' || hasPendingEdit(f, drafts) ? withNotice(f, notice) : f
  })
  if (!hasUnsent(flow) || flow.historyId === null) return
  const id = flow.historyId
  await saveHistory($, list => {
    const known = list.find(one => one.id === id)
    // An entry saved at Review keeps what it holds (an edit, its time); a new one is added.
    return known !== undefined ? list : addEntry(list, entryFromFlow(flow, id, now))
  })
}

type Started = 'started' | 'busy' | 'same' | 'narrow'

/**
 * Starts an upgrade of `original` in the pane. Refuses (`busy`) while another
 * prompt is under way, never replacing it, or `same` when that prompt is this
 * one sent again; `narrow` when the pane could not be drawn. The caller puts
 * the text back in the box for `busy` and `narrow`.
 */
async function startUpgrade($: Engine, original: string): Promise<Started> {
  const opening = openFlowPane($)
  const now = await nowMs($)
  const drafts = await read($, draftsAtom)
  const seen = { busy: false, same: false }
  const flow = await update($, flowAtom, f => {
    // `update` may run this again after a missed write: every mark is set afresh.
    seen.busy = false
    seen.same = false
    if (isBusy(f, drafts)) {
      seen.busy = true
      seen.same = hasUnsent(f) && f.original.trim() === original.trim()
      return f
    }
    return beginFlow(f, original, now)
  })
  if (seen.same) {
    await opening
    return 'same'
  }
  if (seen.busy) {
    await keepUnsent($, BUSY_NOTICE)
    await opening
    return 'busy'
  }
  await update($, draftsAtom, () => NO_DRAFTS)
  if (!(await opening)) {
    await update($, flowAtom, f => (f.requestSeq === flow.requestSeq ? resetFlow(f) : f))
    await $.ui.close({ id: PANE }).catch(() => undefined)
    return 'narrow'
  }
  launch($, () => askQuestions($, flow.requestSeq))
  return 'started'
}

/** `/better` alone: the pane with a field to type a rough prompt (or what is already there). */
async function openCompose($: Engine): Promise<void> {
  const opening = openFlowPane($)
  const now = await nowMs($)
  const seen = { fresh: false }
  const flow = await update($, flowAtom, f => {
    seen.fresh = f.step === 'idle'
    return seen.fresh ? composeFlow(f, now) : f
  })
  // A fresh compose screen starts with an empty field: no text left from an earlier one.
  if (seen.fresh) await update($, draftsAtom, () => NO_DRAFTS)
  if (!(await opening)) {
    await update($, flowAtom, f => (f.requestSeq === flow.requestSeq && f.step === 'compose' ? resetFlow(f) : f))
    await $.ui.close({ id: PANE }).catch(() => undefined)
    $.ui.toast(NARROW)
  }
}

async function openHistory($: Engine): Promise<void> {
  const r = await $.ui.open({ id: HISTORY_PANE, title: HISTORY_TITLE, focus: true, closeOnEscape: true, rows: 24 })
  if (!r.isPlaced) {
    await $.ui.close({ id: HISTORY_PANE }).catch(() => undefined)
    $.ui.toast(NARROW)
  }
}

/**
 * A history row pressed: its review reopens in the upgrade pane, or, for an
 * original saved before its rewrite arrived, a fresh upgrade of it. Refused
 * while another prompt is under way: that one stays, with a note why.
 */
async function openEntry($: Engine, id: string): Promise<void> {
  const opening = openFlowPane($)
  const list = await read($, historyAtom)
  const entry = list.find(one => one.id === id)
  const drafts = await read($, draftsAtom)
  const now = await nowMs($)
  const seen = { busy: false, moved: false }
  const flow = await transition($, f => {
    seen.busy = false
    seen.moved = false
    if (entry === undefined) return f
    if (f.historyId === entry.id && f.step !== 'idle' && f.step !== 'compose') return f
    if (isBusy(f, drafts)) {
      seen.busy = true
      return f
    }
    seen.moved = true
    return entry.upgrade.trim() === '' ? beginFlow(f, entry.original, now, entry.id) : reviewFromEntry(f, entry)
  })
  if (seen.busy) await keepUnsent($, BUSY_HISTORY_NOTICE)
  if (seen.moved) await update($, draftsAtom, () => NO_DRAFTS)
  await $.ui.close({ id: HISTORY_PANE }).catch(() => undefined)
  const isPlaced = await opening
  if (isPlaced && flow.step !== 'idle') return
  // Only what this press put up is taken down; an upgrade under way stays.
  if (seen.moved) await update($, flowAtom, f => (f.requestSeq === flow.requestSeq ? resetFlow(f) : f))
  if ((await read($, flowAtom)).step === 'idle') await $.ui.close({ id: PANE }).catch(() => undefined)
  if (!isPlaced) $.ui.toast(NARROW)
}

/**
 * Sends a prompt as the person's own words. The flow is claimed first, in one
 * state write, so a second press of Run finds nothing to send; the text is
 * marked "let through once" before it goes, so the prompt.submit hook never
 * takes it back into the pane.
 */
async function send(
  $: Engine,
  seq: number,
  pick: (flow: UpgradeFlow, drafts: UpgradeDrafts) => string | null,
  isUpgrade: boolean,
): Promise<void> {
  const drafts = await read($, draftsAtom)
  const claim: { flow: UpgradeFlow | null; text: string } = { flow: null, text: '' }
  await update($, flowAtom, f => {
    // `update` retries after a missed write: only the call whose write lands keeps the claim.
    claim.flow = null
    if (f.requestSeq !== seq) return f
    const text = (pick(f, drafts) ?? '').trim()
    if (text === '') return f
    claim.flow = f
    claim.text = text
    return resetFlow(f)
  })
  const flow = claim.flow
  if (flow === null) return
  const clean = claim.text
  abortCalls()
  await update($, draftsAtom, () => NO_DRAFTS)
  await update($, passOnceAtom, list => addPassOnce(list, clean))
  await $.ui.close({ id: PANE }).catch(() => undefined)
  let entered = false
  try {
    const r = await $.prompt.submit({ text: clean, asUser: true })
    entered = r.drop === undefined
  } catch {
    entered = false
  }
  const held = flow.fromHistory ? undefined : flow.original
  if (!entered) {
    await update($, passOnceAtom, list => removePassOnce(list, clean))
    if (await putBack($, clean, held)) $.ui.toast('Prompt Upgrade could not send that, so it is in the prompt box.')
    else {
      $.ui.toast('Prompt Upgrade could not send that or put it in the prompt box; it is in the transcript.')
      $.ui.log(`Your prompt: ${clean}`)
    }
    return
  }
  const historyId = flow.historyId
  if (isUpgrade && historyId !== null) await saveHistory($, list => updateEntry(list, historyId, clean, true))
  if (held !== undefined) await clearHeld($, held)
}

/**
 * Cancel, or the pane closed by hand: the flow ends and what the person typed
 * goes back: the original to the prompt box (the compose field's text when
 * nothing was started), and an edited upgrade onto its history entry.
 */
async function discard($: Engine, closePane: boolean): Promise<void> {
  const drafts = await read($, draftsAtom)
  const claim: { flow: UpgradeFlow | null } = { flow: null }
  await update($, flowAtom, f => {
    claim.flow = null
    if (f.step === 'idle') return f
    claim.flow = f
    return resetFlow(f)
  })
  abortCalls()
  if (closePane) await $.ui.close({ id: PANE }).catch(() => undefined)
  const flow = claim.flow
  if (flow === null || flow.step === 'compose') {
    // The compose field draws for an idle flow too: its text goes back either way.
    if (drafts.compose.trim() !== '') {
      await update($, draftsAtom, () => NO_DRAFTS)
      await returnToBox($, drafts.compose)
    }
    return
  }
  await update($, draftsAtom, () => NO_DRAFTS)
  const edit = drafts.edit
  const historyId = flow.historyId
  if (flow.step === 'review' && historyId !== null && edit !== null && edit.seq === flow.requestSeq) {
    const typed = chosenEdit(flow.upgrade, edit.text)
    if (typed !== flow.upgrade) await saveHistory($, list => updateEntry(list, historyId, typed))
  }
  await restoreOriginal($, flow)
}

/** The pane's handlers. Each reads the flow afresh; `seq` ties a press to the flow it was drawn for. */
function flowActions($: Engine, surface: RenderSurface, seq: number, hasInput: boolean): FlowActions {
  const quietly = (work: () => Promise<unknown>) => work().catch(() => undefined)
  const mine = (f: UpgradeFlow) => f.requestSeq === seq
  return {
    compose: text =>
      quietly(async () => {
        const prompt = text.trim()
        if (prompt === '') return
        const now = await nowMs($)
        const flow = await transition($, f => (mine(f) && (f.step === 'compose' || f.step === 'idle') ? beginFlow(f, prompt, now) : f))
        if (flow.step === 'questions-loading' && flow.original === prompt) await update($, draftsAtom, () => NO_DRAFTS)
      }),
    composeDraft: text => quietly(() => update($, draftsAtom, d => ({ ...d, compose: text }))),
    choose: (index, option) => quietly(() => transition($, f => (mine(f) ? answerFlow(f, index, { kind: 'option', text: option }) : f))),
    openOther: index => quietly(() => update($, flowAtom, f => (mine(f) ? openOtherFlow(f, index) : f))),
    other: (index, text) => quietly(() => transition($, f => (mine(f) ? answerFlow(f, index, { kind: 'other', text }) : f))),
    skip: index => quietly(() => transition($, f => (mine(f) ? answerFlow(f, index, { kind: 'skip' }) : f))),
    skipRest: () => quietly(() => transition($, f => (mine(f) ? skipRestFlow(f) : f))),
    run: () => quietly(() => send($, seq, (f, drafts) => (f.step === 'review' ? textToRun(f, drafts) : null), true)),
    runText: text => quietly(() => send($, seq, f => (f.step === 'review' ? chosenEdit(f.upgrade, text) : null), true)),
    draft: text => quietly(() => update($, draftsAtom, d => ({ ...d, edit: { seq, text } }))),
    edit: editing =>
      quietly(async () => {
        if (!hasInput) {
          // No text field on this surface: the upgrade goes to the prompt box to edit there.
          const claim: { flow: UpgradeFlow | null } = { flow: null }
          await update($, flowAtom, f => {
            claim.flow = null
            if (!mine(f) || f.step !== 'review') return f
            claim.flow = f
            return resetFlow(f)
          })
          const flow = claim.flow
          if (flow === null) return
          await $.ui.close({ id: PANE }).catch(() => undefined)
          const over = flow.fromHistory ? undefined : flow.original
          if (!(await putBack($, flow.upgrade, over))) $.ui.toast('Prompt Upgrade could not put the upgrade in the prompt box.')
          return
        }
        if (editing) {
          await update($, flowAtom, f => (mine(f) ? editFlow(f, true) : f))
          return
        }
        // Stop editing keeps what was typed: it becomes the upgrade (and its history entry's).
        const drafts = await read($, draftsAtom)
        const kept = { text: '', id: null as string | null }
        await update($, flowAtom, f => {
          kept.text = ''
          if (!mine(f) || f.step !== 'review') return f
          const typed = textToRun(f, drafts)
          if (typed.trim() === '' || typed === f.upgrade) return editFlow(f, false)
          kept.text = typed
          kept.id = f.historyId
          return { ...editFlow(f, false), upgrade: typed }
        })
        await update($, draftsAtom, d => ({ ...d, edit: null }))
        const keptId = kept.id
        if (kept.text !== '' && keptId !== null) await saveHistory($, list => updateEntry(list, keptId, kept.text))
      }),
    copy: () =>
      quietly(async () => {
        const flow = await read($, flowAtom)
        if (!mine(flow) || flow.step !== 'review') return
        const text = textToRun(flow, await read($, draftsAtom))
        const r = await $.ui.copy({ text, surface }).catch(() => null)
        if (r === null || !r.isCopied) $.ui.toast('Prompt Upgrade could not copy the upgrade on this screen.')
      }),
    cancel: () => quietly(() => discard($, true)),
    retry: () => quietly(() => transition($, f => (mine(f) ? retryFlow(f) : f))),
    sendOriginal: () =>
      quietly(() => send($, seq, f => (f.step !== 'idle' && f.step !== 'compose' ? f.original : null), false)),
  }
}

/** Reads the saved switch and history into the session's state. */
async function loadSaved($: Engine): Promise<void> {
  const storedOn = await $.store.get(STORE_ON)
  await update($, isOnAtom, () => storedOn === true)
  const history = sanitizeHistory(await $.store.get(STORE_HISTORY))
  await update($, historyAtom, () => history)
}

/**
 * After a reload mid-step: a loading step asks again instead of leaving the
 * pane stuck. With the pane gone (it closed without its hooks, as at an
 * unload), the original goes back in the prompt box instead of vanishing.
 */
async function resume($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow.step === 'idle') return
  const panes = await $.ui.panes()
  if (!panes.some(pane => pane.id === PANE)) {
    await discard($, false)
    return
  }
  if (isLoading(flow.step)) {
    await transition($, f => (f.step === 'questions-loading' || f.step === 'rewrite-loading' ? toLoading(f, f.step) : f))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'better',
        description: 'Upgrade a rough prompt before it is sent; on, off or history',
        argumentHint: '[prompt] | on | off | history',
        immediate: true,
      })
    } catch {
      // Without the command, automatic mode still works.
    }
    try {
      await loadSaved($)
    } catch {
      // Starts with automatic mode off and an empty history.
    }
    try {
      await resume($)
    } catch {
      // The pane shows what it had; Cancel still works.
    }
    return next(e)
  })

  on('command.run', { command: 'better' }, async ($, e) => {
    try {
      const args = e.args.trim()
      const word = args.toLowerCase()
      if (word === 'on' || word === 'off') {
        const isOn = word === 'on'
        await update($, isOnAtom, () => isOn)
        try {
          await $.store.set(STORE_ON, isOn)
        } catch {
          return { text: `${isOn ? ON_TEXT : OFF_TEXT} It could not be saved, so it lasts for this session only.` }
        }
        return { text: isOn ? ON_TEXT : OFF_TEXT }
      }
      if (word === 'history') {
        void (async () => {
          try {
            await openHistory($)
          } catch {
            $.ui.toast('Prompt Upgrade could not open the history.')
          }
        })()
        return { text: 'Opening your last upgrades.' }
      }
      if (args === '') {
        void (async () => {
          try {
            await openCompose($)
          } catch {
            $.ui.toast('Prompt Upgrade could not open.')
          }
        })()
        return { text: 'Opening Prompt Upgrade. Type a rough prompt there.' }
      }
      const current = await read($, flowAtom)
      const wasBusy = isBusy(current, await read($, draftsAtom))
      const wasSame = wasBusy && hasUnsent(current) && current.original.trim() === args
      void (async () => {
        try {
          const started = await startUpgrade($, args)
          if (started === 'started' || started === 'same') return
          await returnToBox($, args)
          if (started === 'narrow') $.ui.toast(NARROW_PROMPT)
          else if (!wasBusy) $.ui.toast(BUSY)
        } catch {
          $.ui.toast(FAILED)
        }
      })()
      if (wasSame) return { text: SAME }
      if (wasBusy) return { text: BUSY }
      return { text: 'Upgrading your prompt in the Prompt Upgrade pane. Nothing is sent until you press Run.' }
    } catch {
      return { text: FAILED }
    }
  }).catch(() => ({ text: FAILED }))

  on('prompt.submit', async ($, e, next) => {
    const isOn = await read($, isOnAtom)
    const passOnce = await read($, passOnceAtom)
    const verdict = judgeSubmit({
      text: e.text,
      hasAttachments: (e.attachments?.length ?? 0) > 0,
      isWorking: e.turnId !== undefined,
      originKind: e.origin.kind,
      originName: e.origin.kind === 'plugin' ? e.origin.name : undefined,
      isOn,
      passOnce,
    })
    if (verdict.action === 'pass') {
      const consumed = verdict.consume
      if (consumed !== undefined) await update($, passOnceAtom, list => removePassOnce(list, consumed))
      return next(e)
    }
    if (verdict.action === 'strip') {
      return verdict.text === '' ? next(e) : next({ ...e, text: verdict.text })
    }
    let started: Started
    try {
      started = await startUpgrade($, e.text)
    } catch {
      // Something failed before the pane took the prompt: take down only the
      // upgrade this prompt began (never one under way) and send it as typed.
      await update($, flowAtom, f => (f.original === e.text && !f.fromHistory ? resetFlow(f) : f)).catch(() => undefined)
      if ((await read($, flowAtom).catch(() => IDLE)).step === 'idle') await $.ui.close({ id: PANE }).catch(() => undefined)
      return next(e)
    }
    if (started === 'started') return { drop: HELD }
    if (started === 'same') return { drop: SAME }
    returnHeldToBox($, e.text)
    return { drop: started === 'busy' ? BUSY : NARROW_PROMPT }
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    // Closed by hand (the close mark): the same as Cancel.
    if (e.origin.kind === 'person') {
      try {
        await discard($, false)
      } catch {
        // The pane is closed either way; the flow is reset at the next start.
      }
    }
    return closed
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const columns = Math.max(8, Math.floor(e.props.bodyColumns))
    const flow = await read($, flowAtom)
    const isOn = await read($, isOnAtom)
    // Mobile draws no text field: branch on the surface, not on the table.
    const flowKit: FlowKit =
      e.surface !== 'mobile' && 'Input' in kit
        ? { Box: kit.Box, Text: kit.Text, Button: kit.Button, Input: kit.Input }
        : { Box: kit.Box, Text: kit.Text, Button: kit.Button }
    const hasInput = flowKit.Input !== undefined
    return drawFlow(flowKit, { flow, isOn, columns }, flowActions($, e.surface, flow.requestSeq, hasInput))
  })

  on('ui.render', { component: 'Pane', requestId: HISTORY_PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const columns = Math.max(8, Math.floor(e.props.bodyColumns))
    const entries = await read($, historyAtom)
    const now = await nowMs($)
    return drawHistory(
      kit,
      { entries, now, columns },
      {
        open: id => openEntry($, id).catch(() => undefined),
        close: () => $.ui.close({ id: HISTORY_PANE }).catch(() => undefined),
      },
    )
  })
}
