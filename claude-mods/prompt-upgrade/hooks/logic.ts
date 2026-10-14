// Pure logic for prompt-upgrade: which prompts are held back, the model's
// prompts and how their replies are read, the flow's steps, the history, and
// the text helpers the pane draws with. No `$` here, so tests call it directly.

import type { UpgradeAnswer, UpgradeDrafts, UpgradeEntry, UpgradeFlow, UpgradeQuestion, UpgradeStep } from '../types'
import { cells, fit } from './look-text'

export const PLUGIN = 'prompt-upgrade'
export const MODEL = 'haiku'
export const MODEL_TIMEOUT_MS = 30_000
export const QUESTIONS_MAX_TOKENS = 700
/** The rewrite's token cap for a prompt of ordinary length; a longer one gets more (rewriteBudget). */
export const REWRITE_MAX_TOKENS = 1_600
const REWRITE_TOKEN_CAP = 16_000
const REWRITE_TIMEOUT_CAP_MS = 180_000
/** How long after a held-back prompt the mod checks the prompt box (the engine may hand the prompt back itself). */
export const HANDBACK_CHECK_MS = 250
export const HISTORY_LIMIT = 20
export const PASS_ONCE_LIMIT = 5

export const MAX_QUESTIONS = 3
export const MAX_OPTIONS = 4
export const MIN_OPTIONS = 2
export const MAX_OPTION_WORDS = 5
/** Past this many characters a prompt is taken to hold pasted content (a log, a diff) and goes straight through. */
export const PASTE_CHARS = 2_000

// ---------------------------------------------------------------------------
// Which prompts go to the pane

const SHORT_REPLIES = new Set([
  'yes',
  'no',
  'ok',
  'okay',
  'sure',
  'go',
  'go on',
  'keep going',
  'continue',
  'do it',
  'thanks',
  'thank you',
  'next',
  'proceed',
  'sounds good',
  'lgtm',
  'y',
  'n',
  'please',
  'go ahead',
  'yep',
  'yeah',
  'nope',
  'great',
  'perfect',
  'cool',
])

/** Lower case, punctuation gone, spaces collapsed. */
export function normalizeReply(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * "yes", "keep going", "ok!", anything of three words or fewer, and a run of
 * known replies ("sounds good, do it").
 */
export function isShortReply(text: string): boolean {
  const norm = normalizeReply(text)
  if (norm === '') return true
  if (SHORT_REPLIES.has(norm)) return true
  if (norm.split(' ').length <= 3) return true
  const pieces = text
    .toLowerCase()
    .split(/[,.!?;:]+|\band\b|\bthen\b/)
    .map(normalizeReply)
    .filter(piece => piece !== '')
  return pieces.length > 0 && pieces.every(piece => SHORT_REPLIES.has(piece))
}

/**
 * An `@path` mention attaches a file to the prompt. A heuristic on purpose: any
 * `@word` counts (so `@property` passes too), since sending a real mention
 * through the mod would leave it unexpanded, while passing a non-mention loses nothing.
 */
export function mentionsFile(text: string): boolean {
  return /(^|\s)@[^\s@]+/.test(text)
}

/** `/name` or `/name args`; a path such as `/src/auth/login.ts ...` is not a command. */
export function isSlashCommand(text: string): boolean {
  return /^\/[\w:.-]+(\s|$)/u.test(text)
}

/** How the sibling mods' ready-made prompts start: context-pilot's /pickup and change-deck's "Ask Claude about this". */
const SIBLING_STARTS = ['Continue from this handoff.', 'About your edit to ']

/** A prompt another mod of this set wrote into the box: already precise, so it goes straight through. */
export function isFromSiblingMod(text: string): boolean {
  return SIBLING_STARTS.some(start => text.startsWith(start)) || text.includes('```diff')
}

export type SubmitFacts = {
  text: string
  hasAttachments: boolean
  /** A turn was running when the prompt was submitted (`e.turnId` set). */
  isWorking: boolean
  originKind: string
  originName?: string
  isOn: boolean
  passOnce: readonly string[]
}

export type SubmitVerdict =
  | { action: 'pass'; reason: string; consume?: string }
  | { action: 'strip'; text: string }
  | { action: 'intercept' }

/** Decides what happens to a submitted prompt. */
export function judgeSubmit(f: SubmitFacts): SubmitVerdict {
  const isMine = f.originKind === 'plugin' && f.originName === PLUGIN
  const listed = f.passOnce.includes(f.text)
  if (isMine || listed) {
    return listed ? { action: 'pass', reason: 'sent by prompt-upgrade', consume: f.text } : { action: 'pass', reason: 'sent by prompt-upgrade' }
  }
  if (!f.isOn) return { action: 'pass', reason: 'automatic mode is off' }
  if (f.originKind !== 'composer') return { action: 'pass', reason: 'not typed in the prompt box' }
  const trimmed = f.text.trimStart()
  if (trimmed.startsWith('>')) return { action: 'strip', text: trimmed.slice(1).trimStart() }
  if (isSlashCommand(trimmed)) return { action: 'pass', reason: 'slash command' }
  if (isFromSiblingMod(trimmed)) return { action: 'pass', reason: 'written by another of your mods' }
  if (f.hasAttachments || mentionsFile(f.text)) return { action: 'pass', reason: 'files or images attached' }
  if (f.text.length > PASTE_CHARS) return { action: 'pass', reason: 'long pasted content' }
  if (f.isWorking) return { action: 'pass', reason: 'sent while Claude is working' }
  if (isShortReply(f.text)) return { action: 'pass', reason: 'short reply' }
  return { action: 'intercept' }
}

/** Adds a text the mod is about to send to the let-through-once list. */
export function addPassOnce(list: readonly string[], text: string): string[] {
  return [...list.filter(one => one !== text), text].slice(-PASS_ONCE_LIMIT)
}

export function removePassOnce(list: readonly string[], text: string): string[] {
  return list.filter(one => one !== text)
}

// ---------------------------------------------------------------------------
// The model's prompts

export const SYSTEM =
  'You help a software engineer sharpen a request before it is sent to a coding agent (Claude Code) ' +
  'that works inside their repository. You reply with strict JSON only: no prose, no code fence.'

export function questionsPrompt(original: string): string {
  return [
    'Here is a rough request the person is about to send to a coding agent working in their repository:',
    '',
    '<request>',
    original.trim(),
    '</request>',
    '',
    'Pick at most three multiple-choice questions whose answers would most change how well the agent does this request.',
    'Good questions for a coding request cover:',
    '- scope: which part of the code or which files (only when the request is vague about it)',
    '- constraints: keep the public API, no new dependencies, match the existing style',
    '- verification: add or update tests, which checks to run',
    '- output: a plan first or make the change directly, PR-ready or not',
    '',
    'Rules:',
    '- Never ask about something the request already says.',
    '- Each question is short and ends with a question mark.',
    '- Each question has 2 to 4 options, each at most 5 words.',
    '- If no question would clearly help, return an empty list.',
    '',
    'Reply with JSON only, exactly this shape:',
    '{"questions":[{"question":"...","options":["...","..."]}]}',
  ].join('\n')
}

export type AnsweredQuestion = { question: string; answer: string }

/** The answers the rewrite uses: answered ones only, skipped ones left out. */
export function answeredPairs(flow: Pick<UpgradeFlow, 'questions' | 'answers'>): AnsweredQuestion[] {
  const out: AnsweredQuestion[] = []
  flow.questions.forEach((q, i) => {
    const a = flow.answers[i]
    if (a !== null && a !== undefined && a.kind !== 'skip') out.push({ question: q.question, answer: a.text })
  })
  return out
}

export function rewritePrompt(original: string, answers: readonly AnsweredQuestion[]): string {
  const qa =
    answers.length === 0
      ? ['The person answered no questions.']
      : ['<answers>', ...answers.flatMap(a => [`Q: ${a.question}`, `A: ${a.answer}`]), '</answers>']
  return [
    'Rewrite this rough request to a coding agent into one clear, complete request the person could have typed themselves.',
    '',
    '<request>',
    original.trim(),
    '</request>',
    '',
    ...qa,
    '',
    'Rules:',
    '- Keep exactly what the person meant. Do not change the task.',
    '- State the goal, who or what it is for, the scope (only files, areas or names the person mentioned; never invent paths),',
    '  the constraints, the format of the result, and how to verify it (tests or checks to run, what "done" looks like).',
    '- Use the answers given. Leave out anything that was not answered.',
    '- Never invent facts, names, numbers, file paths or prices. Where something needed is unknown, write a [placeholder] in square brackets.',
    '- Plain language, in the first person, as one request. No headings, no markdown, no preamble. Short paragraphs or a short list are fine.',
    '- "added" lists each detail you added that was not in the original request, each under 8 words.',
    '',
    'Reply with JSON only, exactly this shape:',
    '{"prompt":"...","added":["...","..."]}',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Reading the model's replies

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collapses runs of whitespace and trims. */
export function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(word => word !== '').length
}

type Parsed = { ok: true; value: unknown } | { ok: false }

function tryParse(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

/** The index of the bracket closing the one at `start`, strings and escapes respected; -1 when it never closes. */
function closingIndex(source: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** How many bracket positions a reply is searched from before giving up. */
const MAX_JSON_STARTS = 64

/**
 * The first JSON value in a reply that `accept` takes: the whole reply, then
 * the inside of a fence wrapping the whole reply (to its last fence, so a
 * fence inside a string survives), then each balanced `{...}` or `[...]` span
 * in turn, leading and trailing prose ignored. Undefined when none is found.
 */
export function extractJson(text: string, accept: (value: unknown) => boolean = () => true): unknown {
  const trimmed = text.trim()
  const whole = tryParse(trimmed)
  if (whole.ok && accept(whole.value)) return whole.value
  const fence = /^```[\w-]*[ \t]*\r?\n([\s\S]*)```\s*$/.exec(trimmed)
  const source = fence !== null && fence[1] !== undefined ? fence[1].trim() : trimmed
  if (source !== trimmed) {
    const inner = tryParse(source)
    if (inner.ok && accept(inner.value)) return inner.value
  }
  let tries = 0
  for (let i = 0; i < source.length && tries < MAX_JSON_STARTS; i++) {
    const ch = source[i]
    if (ch !== '{' && ch !== '[') continue
    tries += 1
    const end = closingIndex(source, i)
    if (end < 0) continue
    const span = tryParse(source.slice(i, end + 1))
    if (span.ok && accept(span.value)) return span.value
  }
  return undefined
}

function looksLikeQuestions(value: unknown): boolean {
  return (isRecord(value) && Array.isArray(value.questions)) || (Array.isArray(value) && value.some(isRecord))
}

function looksLikeRewrite(value: unknown): boolean {
  return isRecord(value) && typeof value.prompt === 'string'
}

/**
 * The questions in a reply, cleaned: at most three, each with two to four
 * distinct options of at most five words. Bad items are dropped; a reply
 * that cannot be read gives none, which means "go straight to the rewrite".
 */
export function parseQuestions(text: string): UpgradeQuestion[] {
  const data = extractJson(text, looksLikeQuestions)
  const list: unknown[] = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.questions) ? data.questions : []
  const out: UpgradeQuestion[] = []
  for (const item of list) {
    if (out.length >= MAX_QUESTIONS) break
    if (!isRecord(item)) continue
    const question = typeof item.question === 'string' ? clean(item.question) : ''
    if (question === '' || cells(question) > 200) continue
    const raw: unknown[] = Array.isArray(item.options) ? item.options : []
    const options: string[] = []
    for (const one of raw) {
      if (options.length >= MAX_OPTIONS) break
      if (typeof one !== 'string') continue
      const option = clean(one)
      if (option === '' || wordCount(option) > MAX_OPTION_WORDS || cells(option) > 40) continue
      if (/^other\b/i.test(option)) continue
      if (options.some(seen => seen.toLowerCase() === option.toLowerCase())) continue
      options.push(option)
    }
    if (options.length < MIN_OPTIONS) continue
    out.push({ question, options })
  }
  return out
}

export type Rewrite = { prompt: string; added: string[] }

/** The upgraded prompt and what it added; null when the reply cannot be read (a model failure). */
export function parseRewrite(text: string): Rewrite | null {
  const data = extractJson(text, looksLikeRewrite)
  if (!isRecord(data)) return null
  const prompt = typeof data.prompt === 'string' ? data.prompt.replace(/\r\n?/g, '\n').trim() : ''
  if (prompt === '') return null
  const raw: unknown[] = Array.isArray(data.added) ? data.added : []
  const added = raw
    .filter((one): one is string => typeof one === 'string')
    .map(clean)
    .filter(one => one !== '')
    .slice(0, 12)
  return { prompt, added }
}

/**
 * The rewrite's token cap and time limit, grown with the prompt: the reply
 * carries the whole upgraded prompt inside JSON, so a long prompt (pasted
 * code) needs room, or the reply is cut and cannot be read.
 */
export function rewriteBudget(original: string): { maxTokens: number; timeoutMs: number } {
  const estimate = Math.ceil(original.length / 3)
  const maxTokens = Math.min(REWRITE_TOKEN_CAP, Math.max(REWRITE_MAX_TOKENS, estimate * 2 + 800))
  const timeoutMs = Math.min(REWRITE_TIMEOUT_CAP_MS, MODEL_TIMEOUT_MS + (maxTokens - REWRITE_MAX_TOKENS) * 12)
  return { maxTokens, timeoutMs }
}

export type ModelFailure = { reason: string; status?: number | null; error?: string }

/** A calm sentence for why a model call gave no usable answer. */
export function failureText(f: ModelFailure): string {
  switch (f.reason) {
    case 'aborted':
      return 'The model took too long to answer.'
    case 'empty-reply':
      return 'The model sent back an empty reply.'
    case 'unreadable':
      return "The model's reply could not be read."
    case 'api-error':
      if (f.error === 'rate_limit') return 'The model is rate limited right now.'
      if (f.error === 'overloaded') return 'The model is busy right now.'
      if (f.error === 'authentication_failed') return 'The model could not be reached with your sign-in.'
      return typeof f.status === 'number' ? `The model returned an error (${f.status}).` : 'The model could not be reached.'
    default:
      return 'The model could not be asked.'
  }
}

// ---------------------------------------------------------------------------
// The flow

export const IDLE: UpgradeFlow = {
  step: 'idle',
  original: '',
  questions: [],
  answers: [],
  otherOpen: null,
  upgrade: '',
  added: [],
  error: null,
  startedAt: 0,
  requestSeq: 0,
  editing: false,
  historyId: null,
  fromHistory: false,
  notice: null,
}

export const NO_DRAFTS: UpgradeDrafts = { compose: '', edit: null }

export function isLoading(step: UpgradeStep): boolean {
  return step === 'questions-loading' || step === 'rewrite-loading'
}

/** Back to nothing; the bumped sequence makes any call in flight stale. */
export function resetFlow(prev: UpgradeFlow): UpgradeFlow {
  return { ...IDLE, requestSeq: prev.requestSeq + 1 }
}

/** The "type a rough prompt" screen. */
export function composeFlow(prev: UpgradeFlow, now: number): UpgradeFlow {
  return { ...IDLE, step: 'compose', startedAt: now, requestSeq: prev.requestSeq + 1 }
}

/**
 * A new upgrade of `original`: step 1, reading, with the questions call next.
 * `historyId` names the history entry it already has (one saved as "not sent").
 */
export function beginFlow(prev: UpgradeFlow, original: string, now: number, historyId: string | null = null): UpgradeFlow {
  return { ...IDLE, step: 'questions-loading', original, startedAt: now, requestSeq: prev.requestSeq + 1, historyId }
}

/** Starts (or restarts) a loading step with a fresh sequence number. */
export function toLoading(prev: UpgradeFlow, step: 'questions-loading' | 'rewrite-loading'): UpgradeFlow {
  return { ...prev, step, error: null, otherOpen: null, editing: false, notice: null, requestSeq: prev.requestSeq + 1 }
}

/**
 * Whether the flow holds a prompt the person typed that is not yet sent or
 * put back: anything past the compose screen, unless it was reopened from history.
 */
export function hasUnsent(flow: UpgradeFlow): boolean {
  return flow.step !== 'idle' && flow.step !== 'compose' && !flow.fromHistory && flow.original.trim() !== ''
}

/** Whether the review holds an edit typed in its Edit field that is not yet sent, kept or cancelled. */
export function hasPendingEdit(flow: UpgradeFlow, drafts: UpgradeDrafts): boolean {
  const edit = drafts.edit
  if (flow.step !== 'review' || edit === null || edit.seq !== flow.requestSeq) return false
  return chosenEdit(flow.upgrade, edit.text) !== flow.upgrade
}

/**
 * Whether a new upgrade would push something aside: an unsent prompt, an edit
 * typed on a review (one reopened from history too), or text in the compose field.
 */
export function isBusy(flow: UpgradeFlow, drafts: UpgradeDrafts): boolean {
  if (hasUnsent(flow) || hasPendingEdit(flow, drafts)) return true
  return flow.step === 'compose' && drafts.compose.trim() !== ''
}

/** The one-line note drawn at the top of the pane. */
export function withNotice(flow: UpgradeFlow, notice: string): UpgradeFlow {
  return { ...flow, notice }
}

/** Whether a call made under `seq` for `step` may still apply its result. */
export function isCurrent(flow: UpgradeFlow, seq: number, step: UpgradeStep): boolean {
  return flow.requestSeq === seq && flow.step === step
}

/** The questions arrived. None: straight to the rewrite. Null when the call is stale. */
export function applyQuestions(flow: UpgradeFlow, seq: number, questions: readonly UpgradeQuestion[]): UpgradeFlow | null {
  if (!isCurrent(flow, seq, 'questions-loading')) return null
  if (questions.length === 0) return toLoading({ ...flow, questions: [], answers: [] }, 'rewrite-loading')
  return { ...flow, step: 'questions', questions: [...questions], answers: questions.map(() => null), otherOpen: null, notice: null }
}

/** The rewrite arrived. Null when the call is stale. */
export function applyRewrite(flow: UpgradeFlow, seq: number, rewrite: Rewrite): UpgradeFlow | null {
  if (!isCurrent(flow, seq, 'rewrite-loading')) return null
  return { ...flow, step: 'review', upgrade: rewrite.prompt, added: [...rewrite.added], error: null, editing: false, notice: null }
}

/** A model call failed: the calm error card. Null when the call is stale. */
export function applyFailure(
  flow: UpgradeFlow,
  seq: number,
  step: 'questions-loading' | 'rewrite-loading',
  message: string,
): UpgradeFlow | null {
  if (!isCurrent(flow, seq, step)) return null
  return { ...flow, step: 'error', error: { stage: step === 'questions-loading' ? 'questions' : 'rewrite', message }, notice: null }
}

/** Try again after an error: the failed step, asked afresh. */
export function retryFlow(flow: UpgradeFlow): UpgradeFlow {
  if (flow.step !== 'error' || flow.error === null) return flow
  return toLoading(flow, flow.error.stage === 'questions' ? 'questions-loading' : 'rewrite-loading')
}

export function isResolved(answer: UpgradeAnswer | undefined): boolean {
  return answer !== null && answer !== undefined
}

export function answeredCount(flow: Pick<UpgradeFlow, 'answers'>): number {
  return flow.answers.filter(a => a !== null && a.kind !== 'skip').length
}

/** Answers (or skips) one question; once all are settled the rewrite starts. */
export function answerFlow(flow: UpgradeFlow, index: number, answer: Exclude<UpgradeAnswer, null>): UpgradeFlow {
  if (flow.step !== 'questions' || index < 0 || index >= flow.questions.length) return flow
  if (answer.kind !== 'skip' && clean(answer.text) === '') return flow
  const answers = flow.answers.slice()
  answers[index] = answer.kind === 'skip' ? answer : { kind: answer.kind, text: clean(answer.text) }
  const next: UpgradeFlow = { ...flow, answers, otherOpen: flow.otherOpen === index ? null : flow.otherOpen, notice: null }
  return flow.questions.every((_, i) => isResolved(answers[i])) ? toLoading(next, 'rewrite-loading') : next
}

/** "Skip the rest, upgrade now": unanswered questions are skipped and the rewrite starts. */
export function skipRestFlow(flow: UpgradeFlow): UpgradeFlow {
  if (flow.step !== 'questions') return flow
  const answers = flow.questions.map((_, i) => flow.answers[i] ?? { kind: 'skip' as const })
  return toLoading({ ...flow, answers }, 'rewrite-loading')
}

/** Opens the "Other (type it)" field of one question. */
export function openOtherFlow(flow: UpgradeFlow, index: number): UpgradeFlow {
  if (flow.step !== 'questions' || index < 0 || index >= flow.questions.length) return flow
  return { ...flow, otherOpen: flow.otherOpen === index ? null : index, notice: null }
}

export function editFlow(flow: UpgradeFlow, editing: boolean): UpgradeFlow {
  if (flow.step !== 'review') return flow
  return { ...flow, editing, notice: null }
}

/** What Run sends: the edit while editing (unless it is just the upgrade on one line), else the upgrade. */
export function textToRun(flow: UpgradeFlow, drafts: UpgradeDrafts): string {
  const edit = drafts.edit
  if (!flow.editing || edit === null || edit.seq !== flow.requestSeq) return flow.upgrade
  return chosenEdit(flow.upgrade, edit.text)
}

/**
 * The text an Edit field's Enter sends. The field is one line, so an
 * untouched field holds the upgrade with its line breaks flattened: that
 * sends the upgrade itself, line breaks kept. An empty field sends it too.
 */
export function chosenEdit(upgrade: string, typed: string): string {
  if (typed.trim() === '' || typed === oneLine(upgrade)) return upgrade
  return typed
}

/** Reopens a saved upgrade at its review. */
export function reviewFromEntry(prev: UpgradeFlow, entry: UpgradeEntry): UpgradeFlow {
  return {
    ...IDLE,
    step: 'review',
    original: entry.original,
    upgrade: entry.upgrade,
    added: [...entry.added],
    startedAt: entry.at,
    requestSeq: prev.requestSeq + 1,
    historyId: entry.id,
    fromHistory: true,
  }
}

/** The flow as a history entry: saved at Review, or earlier ("not sent") when a second prompt arrives. */
export function entryFromFlow(flow: UpgradeFlow, id: string, now: number): UpgradeEntry {
  return { id, at: now, original: flow.original, upgrade: flow.upgrade, added: [...flow.added], sent: false }
}

/** Which of the four steps is current: 0 your prompt, 1 questions, 2 rewrite, 3 review. */
export function stepIndex(flow: Pick<UpgradeFlow, 'step' | 'error'>): number {
  switch (flow.step) {
    case 'questions':
      return 1
    case 'rewrite-loading':
      return 2
    case 'review':
      return 3
    case 'error':
      return flow.error?.stage === 'rewrite' ? 2 : 0
    default:
      return 0
  }
}

// ---------------------------------------------------------------------------
// History

export function addEntry(list: readonly UpgradeEntry[], entry: UpgradeEntry): UpgradeEntry[] {
  return [entry, ...list.filter(one => one.id !== entry.id)].slice(0, HISTORY_LIMIT)
}

/** Keeps what was actually run or typed (an edited upgrade) on the entry, and whether it was sent. */
export function updateEntry(list: readonly UpgradeEntry[], id: string, upgrade: string, sent?: boolean): UpgradeEntry[] {
  return list.map(one => (one.id === id ? { ...one, upgrade, ...(sent === undefined ? {} : { sent }) } : one))
}

/** History read back from the store, shape-checked; anything odd is dropped. */
export function sanitizeHistory(value: unknown): UpgradeEntry[] {
  if (!Array.isArray(value)) return []
  const out: UpgradeEntry[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const { id, at, original, upgrade, added, sent } = item
    if (typeof id !== 'string' || typeof original !== 'string' || typeof upgrade !== 'string') continue
    out.push({
      id,
      at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
      original,
      upgrade,
      added: Array.isArray(added) ? added.filter((one): one is string => typeof one === 'string') : [],
      ...(typeof sent === 'boolean' ? { sent } : {}),
    })
    if (out.length >= HISTORY_LIMIT) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Text the pane draws

export const STEP_LABELS = ['Your prompt', 'Questions', 'Rewrite', 'Review'] as const
const SHORT_LABELS = ['Prompt', 'Ask', 'Rewrite', 'Review'] as const

export type Tone = 'done' | 'current' | 'rest' | 'sep'
export type Segment = { text: string; tone: Tone }

/**
 * The step tracker, `✓ Your prompt  ›  ● Questions  ›  Rewrite  ›  Review`,
 * in the widest form that fits `columns`; never wider than it.
 */
export function trackerSegments(current: number, columns: number): Segment[] {
  const build = (labels: readonly string[], sep: string, numbered: boolean): Segment[] => {
    const out: Segment[] = []
    labels.forEach((label, i) => {
      if (i > 0) out.push({ text: sep, tone: 'sep' })
      const name = numbered ? String(i + 1) : label
      if (i < current) out.push({ text: `✓ ${name}`, tone: 'done' })
      else if (i === current) out.push({ text: `● ${name}`, tone: 'current' })
      else out.push({ text: name, tone: 'rest' })
    })
    return out
  }
  const width = (segments: readonly Segment[]) => segments.reduce((sum, s) => sum + cells(s.text), 0)
  const tries = [
    build(STEP_LABELS, '  ›  ', false),
    build(STEP_LABELS, ' › ', false),
    build(SHORT_LABELS, ' › ', false),
    build(SHORT_LABELS, ' ', false),
    build(STEP_LABELS, ' › ', true),
  ]
  for (const one of tries) if (width(one) <= columns) return one
  const label = STEP_LABELS[Math.max(0, Math.min(3, current))] ?? ''
  return [{ text: fit(`● ${current + 1}/4 ${label}`, columns), tone: 'current' }]
}

/**
 * Word-wraps text into lines of at most `width` cells. Paragraph breaks are
 * kept as empty lines; a word longer than the width is split.
 */
export function wrapText(text: string, width: number): string[] {
  const room = Math.max(1, Math.floor(width))
  const out: string[] = []
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = paragraph.split(/\s+/).filter(word => word !== '')
    if (words.length === 0) {
      out.push('')
      continue
    }
    let line = ''
    for (const whole of words) {
      let word = whole
      while (cells(word) > room) {
        if (line !== '') {
          out.push(line)
          line = ''
        }
        const chars = Array.from(word)
        out.push(chars.slice(0, room).join(''))
        word = chars.slice(room).join('')
      }
      if (word === '') continue
      if (line === '') line = word
      else if (cells(line) + 1 + cells(word) <= room) line += ` ${word}`
      else {
        out.push(line)
        line = word
      }
    }
    if (line !== '') out.push(line)
  }
  while (out.length > 1 && out[0] === '') out.shift()
  while (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out.length === 0 ? [''] : out
}

/** Wraps with a hanging indent: `· first line` then `  next lines`. */
export function bulletLines(text: string, width: number, bullet = '· '): string[] {
  const indent = ' '.repeat(cells(bullet))
  return wrapText(text, Math.max(1, width - cells(bullet))).map((one, i) => (i === 0 ? bullet : indent) + one)
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export type NumberParts = { before: string; after: string; added: string }

/** The numbers of the review: words before and after, details added. */
export function numberParts(original: string, upgrade: string, added: readonly string[]): NumberParts {
  return {
    before: plural(wordCount(original), 'word', 'words'),
    after: plural(wordCount(upgrade), 'word', 'words'),
    added: plural(added.length, 'detail added', 'details added'),
  }
}

/** `42 words → 118 words · 6 details added`. */
export function numbersLine(original: string, upgrade: string, added: readonly string[]): string {
  const p = numberParts(original, upgrade, added)
  return `${p.before} → ${p.after} · ${p.added}`
}

/** "now", "4m", "3h", "2d" ago. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const hrs = Math.floor(m / 60)
  if (hrs < 48) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

/** A history row's parts; the pane draws `when`, a space, `mark`, `snippet`, `words`. */
export type HistoryRow = { when: string; mark: string; snippet: string; words: string }

/**
 * One history row cut to `columns`: when (4 cells), ✓ sent or ○ not sent,
 * the first 50 characters of the original, then words before → after (… when
 * the rewrite never arrived).
 */
export function historyRow(entry: UpgradeEntry, now: number, columns: number): HistoryRow {
  const when = ago(now - entry.at).padEnd(4, ' ')
  const mark = entry.sent === true ? '✓ ' : entry.sent === false ? '○ ' : '  '
  const after = entry.upgrade.trim() === '' ? '…' : String(wordCount(entry.upgrade))
  const words = `${wordCount(entry.original)} → ${after}`
  const first = Array.from(clean(entry.original)).slice(0, 50).join('')
  const lead = cells(when) + 1 + cells(mark)
  const roomWithWords = columns - lead - cells(words) - 1
  if (roomWithWords >= 8) return { when, mark, snippet: fit(first, roomWithWords), words: ` ${words}` }
  if (columns - lead >= 1) return { when, mark, snippet: fit(first, columns - lead), words: '' }
  return { when: fit(when, Math.max(0, columns - 1)), mark: '', snippet: '', words: '' }
}

/** One line for the Edit field: line breaks become spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}
