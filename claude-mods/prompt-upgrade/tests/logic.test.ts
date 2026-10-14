// Pure logic: which prompts are held back, reading the model's replies, the
// flow's steps and the text helpers' widths.

import { expect, test } from 'claude-code/testing'

import type { UpgradeEntry, UpgradeFlow } from '../types'
import {
  IDLE,
  addEntry,
  addPassOnce,
  answerFlow,
  answeredPairs,
  applyFailure,
  applyQuestions,
  applyRewrite,
  beginFlow,
  chosenEdit,
  extractJson,
  hasUnsent,
  historyRow,
  isBusy,
  isShortReply,
  judgeSubmit,
  numbersLine,
  parseQuestions,
  parseRewrite,
  questionsPrompt,
  retryFlow,
  rewriteBudget,
  rewritePrompt,
  sanitizeHistory,
  skipRestFlow,
  stepIndex,
  textToRun,
  trackerSegments,
  updateEntry,
  wrapText,
  oneLine,
  NO_DRAFTS,
} from '../hooks/logic'
import type { SubmitFacts } from '../hooks/logic'
import { cells } from '../hooks/look-text'

function facts(text: string, more: Partial<SubmitFacts> = {}): SubmitFacts {
  return {
    text,
    hasAttachments: false,
    isWorking: false,
    originKind: 'composer',
    isOn: true,
    passOnce: [],
    ...more,
  }
}

test('interception table: plain prompts are held back, the rest pass', async () => {
  expect(judgeSubmit(facts('fix the login bug in the auth flow'))).toEqual({ action: 'intercept' })
  expect(judgeSubmit(facts('/compact keep the plan')).action).toBe('pass')
  expect(judgeSubmit(facts('make this faster please', { hasAttachments: true })).action).toBe('pass')
  expect(judgeSubmit(facts('look at @src/auth/login.ts and fix it')).action).toBe('pass')
  expect(judgeSubmit(facts(`why does this fail?\n${'at frame (src/x.ts:1:1)\n'.repeat(120)}`)).action).toBe('pass')
  expect(judgeSubmit(facts('also update the changelog for this', { isWorking: true })).action).toBe('pass')
  expect(judgeSubmit(facts('yes')).action).toBe('pass')
  expect(judgeSubmit(facts('Keep going!')).action).toBe('pass')
  expect(judgeSubmit(facts('sounds good, do it')).action).toBe('pass')
  expect(judgeSubmit(facts('>do it now please, all of it'))).toEqual({ action: 'strip', text: 'do it now please, all of it' })
  expect(judgeSubmit(facts('>do it now'))).toEqual({ action: 'strip', text: 'do it now' })
  expect(judgeSubmit(facts('refactor the parser into smaller modules', { originKind: 'task-notification' })).action).toBe('pass')
  // nothing is held back while automatic mode is off, and ">" is left alone then
  expect(judgeSubmit(facts('fix the login bug in the auth flow', { isOn: false })).action).toBe('pass')
  expect(judgeSubmit(facts('>do it now', { isOn: false })).action).toBe('pass')
})

test('ready-made prompts from the sibling mods pass: a /pickup handoff and an Ask about an edit', async () => {
  const pickup = 'Continue from this handoff. Read it, confirm the next step, then carry on:\n\n## Goal\nShip the parser.'
  expect(judgeSubmit(facts(pickup))).toEqual({ action: 'pass', reason: 'written by another of your mods' })
  const ask = 'About your edit to src/app.js (edit 7 of 14):\n```diff\n@@ -1,1 +1,1 @@\n-a\n+b\n```\nwhy this?'
  expect(judgeSubmit(facts(ask)).action).toBe('pass')
  expect(judgeSubmit(facts('can you explain this change\n```diff\n-a\n+b\n```')).action).toBe('pass')
  // an ordinary prompt that merely mentions a handoff is still held
  expect(judgeSubmit(facts('write a handoff doc for the auth refactor'))).toEqual({ action: 'intercept' })
})

test('the loop guard: the mod\'s own sent text passes, by origin and by the let-through list', async () => {
  const upgraded = 'Fix the login bug in src/auth so that sessions survive a refresh, and add a test for it.'
  const byOrigin = judgeSubmit(facts(upgraded, { originKind: 'plugin', originName: 'prompt-upgrade' }))
  expect(byOrigin.action).toBe('pass')
  const listed = judgeSubmit(facts(upgraded, { passOnce: addPassOnce([], upgraded) }))
  expect(listed).toEqual({ action: 'pass', reason: 'sent by prompt-upgrade', consume: upgraded })
  // another plugin's prompt is not ours, but it is not typed in the box either
  expect(judgeSubmit(facts(upgraded, { originKind: 'plugin', originName: 'other-mod' })).action).toBe('pass')
  // the list keeps the last five
  let list: string[] = []
  for (let i = 0; i < 8; i++) list = addPassOnce(list, `text ${i}`)
  expect(list).toHaveLength(5)
  expect(list[4]).toBe('text 7')
})

test('short replies: three words or fewer, or a known reply', async () => {
  expect(isShortReply('go on')).toBe(true)
  expect(isShortReply('Thank you!!')).toBe(true)
  expect(isShortReply('LGTM.')).toBe(true)
  expect(isShortReply('fix the bug')).toBe(true)
  expect(isShortReply('fix the login bug')).toBe(false)
  expect(isShortReply('Yes, and keep going.')).toBe(true)
  expect(isShortReply('sounds good, but first rename the module')).toBe(false)
})

test('reading the questions: fences, extra text, limits and bad shapes are cleaned', async () => {
  const fenced = '```json\n{"questions":[{"question":"Which files?","options":["Only auth","Whole app"]}]}\n```'
  expect(parseQuestions(fenced)).toEqual([{ question: 'Which files?', options: ['Only auth', 'Whole app'] }])

  const chatty = 'Sure! Here you go: {"questions":[{"question":"Add tests?","options":["Yes, unit tests","No"]}]} Hope that helps {not json}'
  expect(parseQuestions(chatty)).toEqual([{ question: 'Add tests?', options: ['Yes, unit tests', 'No'] }])

  const tooMany = JSON.stringify({
    questions: [1, 2, 3, 4, 5].map(n => ({ question: `Question ${n}?`, options: ['a', 'b', 'c', 'd', 'e', 'f'] })),
  })
  const many = parseQuestions(tooMany)
  expect(many).toHaveLength(3)
  expect(many[0]?.options).toEqual(['a', 'b', 'c', 'd'])

  const bad = JSON.stringify({
    questions: [
      'just a string',
      { question: '', options: ['a', 'b'] },
      { question: 'One option only?', options: ['a'] },
      { question: 'Long options?', options: ['this option has far too many words in it', 'ok', 'fine'] },
      { question: 'Duplicates?', options: ['Yes', 'yes', 'Other'] },
      { question: 'Mixed?', options: [42, null, 'Plan first', 'Just do it'] },
    ],
  })
  expect(parseQuestions(bad)).toEqual([
    { question: 'Long options?', options: ['ok', 'fine'] },
    { question: 'Mixed?', options: ['Plan first', 'Just do it'] },
  ])

  // nothing usable: no questions, which means straight to the rewrite
  expect(parseQuestions('I have no questions.')).toEqual([])
  expect(parseQuestions('{"questions":[]}')).toEqual([])
  expect(parseQuestions('{"questions": [')).toEqual([])
  expect(extractJson('text {"a":"brace } in string"} more')).toEqual({ a: 'brace } in string' })
})

test('reading the rewrite: valid gives the prompt and what it added, invalid gives none', async () => {
  const good = '```json\n{"prompt":"Fix the login bug in [file].\\nAdd a test.","added":["A test"," Where to look ",7]}\n```'
  expect(parseRewrite(good)).toEqual({ prompt: 'Fix the login bug in [file].\nAdd a test.', added: ['A test', 'Where to look'] })
  expect(parseRewrite('{"prompt":"Do the thing well."}')).toEqual({ prompt: 'Do the thing well.', added: [] })
  expect(parseRewrite('{"prompt":"   ","added":[]}')).toBeNull()
  expect(parseRewrite('{"text":"wrong key"}')).toBeNull()
  expect(parseRewrite('no json at all')).toBeNull()
  expect(parseRewrite('["a","b"]')).toBeNull()
})

test('the model prompts carry the request, the answers and the rules', async () => {
  const q = questionsPrompt('fix the login bug')
  expect(q).toContain('fix the login bug')
  expect(q).toContain('{"questions":')
  expect(q).toContain('Never ask about something the request already says.')
  const r = rewritePrompt('fix the login bug', [{ question: 'Add tests?', answer: 'Yes, unit tests' }])
  expect(r).toContain('Q: Add tests?')
  expect(r).toContain('A: Yes, unit tests')
  expect(r).toContain('[placeholder]')
  expect(r).toContain('never invent paths')
  expect(rewritePrompt('x', [])).toContain('The person answered no questions.')
})

test('flow steps: answers and skips lead to the rewrite; stale results are ignored', async () => {
  const start = beginFlow(IDLE, 'fix the login bug', 1000)
  expect(start.step).toBe('questions-loading')
  expect(stepIndex(start)).toBe(0)
  const seq = start.requestSeq

  const questions = [
    { question: 'Add tests?', options: ['Yes', 'No'] },
    { question: 'Plan first?', options: ['Plan first', 'Just do it'] },
  ]
  expect(applyQuestions(start, seq + 1, questions)).toBeNull()
  const asked = applyQuestions(start, seq, questions) as UpgradeFlow
  expect(asked.step).toBe('questions')
  expect(stepIndex(asked)).toBe(1)

  const one = answerFlow(asked, 0, { kind: 'option', text: 'Yes' })
  expect(one.step).toBe('questions')
  const both = answerFlow(one, 1, { kind: 'skip' })
  expect(both.step).toBe('rewrite-loading')
  expect(both.requestSeq).toBe(seq + 1)
  expect(answeredPairs(both)).toEqual([{ question: 'Add tests?', answer: 'Yes' }])

  const rest = skipRestFlow(one)
  expect(rest.step).toBe('rewrite-loading')
  expect(rest.answers).toEqual([{ kind: 'option', text: 'Yes' }, { kind: 'skip' }])

  // no questions: straight to the rewrite
  const none = applyQuestions(start, seq, []) as UpgradeFlow
  expect(none.step).toBe('rewrite-loading')

  expect(applyRewrite(both, seq, { prompt: 'stale', added: [] })).toBeNull()
  const review = applyRewrite(both, both.requestSeq, { prompt: 'Better prompt.', added: ['a'] }) as UpgradeFlow
  expect(review.step).toBe('review')
  expect(stepIndex(review)).toBe(3)

  const failed = applyFailure(both, both.requestSeq, 'rewrite-loading', 'The model is busy right now.') as UpgradeFlow
  expect(failed.step).toBe('error')
  expect(stepIndex(failed)).toBe(2)
  const again = retryFlow(failed)
  expect(again.step).toBe('rewrite-loading')
  expect(again.requestSeq).toBe(both.requestSeq + 1)

  // an empty "other" answer does nothing
  expect(answerFlow(asked, 0, { kind: 'other', text: '   ' })).toBe(asked)
})

test('history keeps the last 20, newest first, and survives odd stored values', async () => {
  let list: UpgradeEntry[] = []
  for (let i = 0; i < 25; i++) list = addEntry(list, { id: `e${i}`, at: i, original: `o${i}`, upgrade: `u${i}`, added: [] })
  expect(list).toHaveLength(20)
  expect(list[0]?.id).toBe('e24')
  expect(updateEntry(list, 'e24', 'edited')[0]?.upgrade).toBe('edited')
  expect(sanitizeHistory('nope')).toEqual([])
  expect(sanitizeHistory([{ id: 'a', at: 1, original: 'o', upgrade: 'u', added: ['x', 3] }, { id: 2 }])).toEqual([
    { id: 'a', at: 1, original: 'o', upgrade: 'u', added: ['x'] },
  ])
})

test('text helpers keep to their widths', async () => {
  const long = 'Refactor the session store so that tokens refresh before they expire, keep the public API, and add tests. ' +
    'Supercalifragilisticexpialidociouslylongidentifiername too.'
  for (const width of [10, 32, 57]) {
    for (const one of wrapText(long, width)) expect(cells(one)).toBeLessThanOrEqual(width)
  }
  expect(wrapText('one\n\ntwo', 20)).toEqual(['one', '', 'two'])
  for (const columns of [12, 20, 32, 40, 60, 120]) {
    for (let current = 0; current < 4; current++) {
      const total = trackerSegments(current, columns).reduce((sum, s) => sum + cells(s.text), 0)
      expect(total).toBeLessThanOrEqual(columns)
    }
  }
  const wide = trackerSegments(1, 120).map(s => s.text).join('')
  expect(wide).toBe('✓ Your prompt  ›  ● Questions  ›  Rewrite  ›  Review')
  expect(numbersLine('one two three', 'a b c d e f', ['x', 'y'])).toBe('3 words → 6 words · 2 details added')
  expect(numbersLine('one', 'a', ['x'])).toBe('1 word → 1 word · 1 detail added')
  const entry: UpgradeEntry = { id: 'a', at: 0, original: long, upgrade: long + ' more words here', added: [] }
  for (const columns of [8, 20, 40, 120]) {
    for (const sent of [true, false, undefined]) {
      const one: UpgradeEntry = sent === undefined ? entry : { ...entry, sent }
      const r = historyRow(one, 3_600_000, columns)
      expect(cells(r.when) + 1 + cells(r.mark) + cells(r.snippet) + cells(r.words)).toBeLessThanOrEqual(columns)
    }
  }
  expect(historyRow({ ...entry, sent: true }, 0, 120).mark).toBe('✓ ')
  expect(historyRow({ ...entry, sent: false, upgrade: '' }, 0, 120).words).toMatch(/→ …$/)
})

test('a rewrite whose prompt holds a code fence is read, bare and fenced', async () => {
  const prompt = 'Make this pass:\n```ts\nexpect(sum(1, 2)).toBe(3)\n```\nthen run npm test.'
  const reply = JSON.stringify({ prompt, added: ['a check'] })
  expect(parseRewrite(reply)).toEqual({ prompt, added: ['a check'] })
  expect(parseRewrite('```json\n' + reply + '\n```')).toEqual({ prompt, added: ['a check'] })
  expect(parseRewrite('Here it is:\n```json\n' + reply + '\n```\nDone.')).toEqual({ prompt, added: ['a check'] })
})

test('leading prose with brackets does not hide the JSON after it', async () => {
  expect(parseRewrite('Here is the [upgraded] prompt: {"prompt":"Do X.","added":[]}')).toEqual({ prompt: 'Do X.', added: [] })
  const questions = 'Questions [3]: {"questions":[{"question":"Add tests?","options":["Yes","No"]}]}'
  expect(parseQuestions(questions)).toEqual([{ question: 'Add tests?', options: ['Yes', 'No'] }])
  // a cut-off reply is still no reply
  expect(parseRewrite('{"prompt":"Do X and then [step two')).toBeNull()
})

test('a prompt that starts with a path is not a slash command', async () => {
  expect(judgeSubmit(facts('/src/auth/login.ts throws on refresh, find out why and fix it'))).toEqual({ action: 'intercept' })
  expect(judgeSubmit(facts('/compact keep the plan')).action).toBe('pass')
  expect(judgeSubmit(facts('/plugin:do-thing with args here')).action).toBe('pass')
  expect(judgeSubmit(facts('/clear')).action).toBe('pass')
})

test('the rewrite budget grows with the prompt and stays within the API limit', async () => {
  expect(rewriteBudget('fix the login bug')).toEqual({ maxTokens: 1600, timeoutMs: 30_000 })
  const long = rewriteBudget('x'.repeat(9_000))
  expect(long.maxTokens).toBeGreaterThan(1600)
  expect(long.timeoutMs).toBeGreaterThan(30_000)
  const huge = rewriteBudget('x'.repeat(500_000))
  expect(huge.maxTokens).toBeLessThanOrEqual(64_000)
  expect(huge.timeoutMs).toBeLessThanOrEqual(180_000)
})

test('Run sends the edit, unless the field holds the upgrade unchanged on one line', async () => {
  const upgrade = 'Line one.\n\n- a\n- b'
  const review = { ...beginFlow(IDLE, 'x y z w', 0), step: 'review' as const, upgrade, editing: true }
  expect(chosenEdit(upgrade, oneLine(upgrade))).toBe(upgrade)
  expect(chosenEdit(upgrade, '   ')).toBe(upgrade)
  expect(chosenEdit(upgrade, 'Line one, edited.')).toBe('Line one, edited.')
  expect(textToRun(review, NO_DRAFTS)).toBe(upgrade)
  expect(textToRun(review, { compose: '', edit: { seq: review.requestSeq, text: 'Edited.' } })).toBe('Edited.')
  expect(textToRun(review, { compose: '', edit: { seq: review.requestSeq + 1, text: 'Stale.' } })).toBe(upgrade)
  expect(textToRun({ ...review, editing: false }, { compose: '', edit: { seq: review.requestSeq, text: 'Edited.' } })).toBe(upgrade)
})

test('what counts as an unsent prompt in the pane', async () => {
  expect(hasUnsent(IDLE)).toBe(false)
  expect(hasUnsent(beginFlow(IDLE, 'fix the login bug', 0))).toBe(true)
  expect(hasUnsent({ ...beginFlow(IDLE, 'fix the login bug', 0), fromHistory: true })).toBe(false)
  expect(hasUnsent({ ...IDLE, step: 'compose' })).toBe(false)
})

test('a review holding a typed edit counts as busy; an untouched or stale edit does not', async () => {
  const upgrade = 'Line one.\n\n- a\n- b'
  const reopened: UpgradeFlow = { ...IDLE, step: 'review', original: 'x y z', upgrade, requestSeq: 4, editing: true, historyId: 'a', fromHistory: true }
  const typed = (text: string, seq = reopened.requestSeq) => ({ compose: '', edit: { seq, text } })
  expect(isBusy(reopened, NO_DRAFTS)).toBe(false)
  expect(isBusy(reopened, typed(oneLine(upgrade)))).toBe(false)
  expect(isBusy(reopened, typed('Line one, edited.', 3))).toBe(false)
  expect(isBusy(reopened, typed('Line one, edited.'))).toBe(true)
  expect(isBusy({ ...IDLE, step: 'compose' }, { compose: 'tidy logs', edit: null })).toBe(true)
  expect(isBusy({ ...IDLE, step: 'compose' }, NO_DRAFTS)).toBe(false)
})
