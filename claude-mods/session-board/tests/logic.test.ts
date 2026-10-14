// session-board's pure logic: the state machine, titles, liveness, notes, cards.

import { expect, test } from 'claude-code/testing'

import type { SessionBoardBeat } from '../types'
import {
  ALIVE_MS,
  DROP_MS,
  MINUTE,
  UNLISTED_QUIET_MS,
  ASKED,
  addEdit,
  afterBlocked,
  blockersFor,
  boardGroups,
  boardTileWidth,
  cardWidth,
  cardsAcross,
  conflictFor,
  conflictNote,
  conflictToast,
  cutAtWord,
  helperCard,
  helperFinished,
  helperSpawned,
  isPersonOrigin,
  liveness,
  mergeHelpers,
  newBeat,
  parseBeat,
  pathInRoot,
  pickHome,
  reasonForNotification,
  relativeTo,
  resumeCommand,
  rowText,
  sameFolderContext,
  settleAgentCall,
  shouldAttachNote,
  statusText,
  stepFor,
  throttleWait,
  titleFrom,
  titleFromMessages,
  transition,
  wrapWords,
} from '../hooks/logic'
import { cells, headingParts, tilesAcross } from '../hooks/look-text'

const NOW = 1_760_000_000_000
const ROOT = '/home/dev/earshot'

function other(over: Partial<SessionBoardBeat>): SessionBoardBeat {
  return {
    ...newBeat({ id: 'other-1', root: ROOT, branch: 'fix/login', model: 'm', now: NOW - 20 * MINUTE }),
    title: 'Fix login bug',
    state: 'working',
    stateSince: NOW - 4 * MINUTE,
    lastBeat: NOW - 10_000,
    ...over,
  }
}

test('state machine: start, working, waiting on a notification, working on a tool call, idle at the end', async () => {
  let beat = newBeat({ id: 's', root: ROOT, branch: 'main', model: 'm', now: NOW })
  expect(beat.state).toBe('idle')
  expect(beat.title).toBe('New session')

  beat = transition(beat, { kind: 'turn-start' }, NOW + 1_000)
  expect(beat.state).toBe('working')
  expect(beat.currentStep).toBe('Thinking')
  expect(beat.stateSince).toBe(NOW + 1_000)

  beat = transition(beat, { kind: 'tool', step: 'Bash npm test' }, NOW + 2_000)
  expect(beat.currentStep).toBe('Bash npm test')
  expect(beat.stateSince).toBe(NOW + 1_000)

  const waiting = transition(
    beat,
    { kind: 'notification', type: 'permission_prompt', message: 'Claude needs your permission to use Bash' },
    NOW + 3_000,
  )
  expect(waiting.state).toBe('waiting')
  expect(waiting.waitingReason).toBe('needs your OK to run a command')
  expect(waiting.stateSince).toBe(NOW + 3_000)

  beat = transition(waiting, { kind: 'tool', step: 'Edit app.js' }, NOW + 4_000)
  expect(beat.state).toBe('working')
  expect(beat.waitingReason).toBeUndefined()
  expect(beat.currentStep).toBe('Edit app.js')

  const asked = transition(beat, { kind: 'ask' }, NOW + 5_000)
  expect(asked.waitingReason).toBe('asked you a question')
  expect(transition(asked, { kind: 'resume', to: 'working' }, NOW + 6_000).state).toBe('working')

  beat = transition(beat, { kind: 'turn-complete' }, NOW + 7_000)
  expect(beat.state).toBe('idle')
  expect(beat.currentStep).toBeUndefined()
  expect(beat.stateSince).toBe(NOW + 7_000)

  // nothing changes: the same object, so nothing is written
  expect(transition(beat, { kind: 'turn-complete' }, NOW + 8_000)).toBe(beat)
  // a tool call outside a turn (a plugin's own) changes nothing
  expect(transition(beat, { kind: 'tool', step: 'Read a' }, NOW + 9_000)).toBe(beat)
  // an idle reminder is no waiting
  expect(transition(beat, { kind: 'notification', type: 'idle_prompt', message: 'waiting' }, NOW)).toBe(beat)
})

test('notification reasons and tool steps read plainly', async () => {
  expect(reasonForNotification('permission_prompt', 'Claude needs your permission to use Bash')).toBe(
    'needs your OK to run a command',
  )
  expect(reasonForNotification('permission_prompt', 'Claude needs your permission to use WebFetch')).toBe(
    'needs your OK to use WebFetch',
  )
  expect(reasonForNotification('elicitation_dialog', 'Server asks')).toBe('asked you a question')
  expect(reasonForNotification('idle_prompt', 'Claude is waiting for your input')).toBeNull()
  expect(stepFor('Edit', { file_path: '/r/src/app.js' })).toBe('Edit app.js')
  expect(stepFor('Bash', { command: 'npm test\necho done' })).toBe('Bash npm test')
  expect(stepFor('mcp__github__get_file', {})).toBe('github get_file')
  expect(stepFor('AskUserQuestion', {})).toBe('Asking a question')
})

test('title from the first real prompt, slash commands skipped, cut at a word boundary', async () => {
  expect(titleFrom('/review 12')).toBeNull()
  expect(titleFrom('/compact')).toBeNull()
  expect(titleFrom('   ')).toBeNull()
  expect(titleFrom('/Users/dev/app.js is broken')).toBe('/Users/dev/app.js is broken')
  const title = titleFrom('Fix the login redirect loop that happens after the session token expires')
  expect(title).toBe('Fix the login redirect loop that…')
  expect((title ?? '').length).toBeLessThanOrEqual(40)
  expect(cutAtWord('Short one')).toBe('Short one')
  expect(cutAtWord('Supercalifragilisticexpialidocious-and-more-words-without-spaces', 20)).toBe('Supercalifragilisti…')
  expect(
    titleFromMessages([
      { role: 'user', text: '/sessions' },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: 'Add a rate limit to the API' },
    ]),
  ).toBe('Add a rate limit to the API')
})

test('alive, went quiet and dropped come from the last heartbeat', async () => {
  expect(liveness({ lastBeat: NOW - 30_000, state: 'working' }, NOW)).toBe('alive')
  expect(liveness({ lastBeat: NOW - ALIVE_MS, state: 'idle' }, NOW)).toBe('alive')
  expect(liveness({ lastBeat: NOW - ALIVE_MS - 1, state: 'idle' }, NOW)).toBe('quiet')
  expect(liveness({ lastBeat: NOW - 3 * 60 * MINUTE, state: 'working' }, NOW)).toBe('quiet')
  expect(liveness({ lastBeat: NOW - DROP_MS - 1, state: 'working' }, NOW)).toBe('dropped')
  expect(liveness({ lastBeat: NOW, state: 'ended' }, NOW)).toBe('dropped')
  const groups = boardGroups(
    [
      other({ id: 'a', lastBeat: NOW - 10_000 }),
      other({ id: 'b', lastBeat: NOW - 12 * MINUTE }),
      other({ id: 'c', lastBeat: NOW - DROP_MS - 1 }),
    ],
    'self',
    NOW,
  )
  expect(groups.working.map(row => row.id)).toEqual(['a'])
  expect(groups.quiet.map(row => row.id)).toEqual(['b'])
  expect(groups.quiet[0]?.right).toBe(' · went quiet 12m ago')
  expect(groups.running).toBe(1)

  const fresh = newBeat({ id: 'f', root: ROOT, branch: '', model: 'm', now: NOW - 4 * MINUTE })
  const opened = boardGroups([{ ...fresh, lastBeat: NOW }], 'self', NOW).done[0]
  expect(opened?.left).toBe('○ earshot · New session')
  expect(opened?.right).toBe(' · opened 4m ago')
  const finished = boardGroups([{ ...fresh, lastBeat: NOW, stateSince: NOW - MINUTE }], 'self', NOW).done[0]
  expect(finished?.right).toBe(' · finished 1m ago')
})

test('heartbeat files parse, and bad ones are skipped', async () => {
  const beat = other({ edits: [{ path: 'a.js', at: NOW }] })
  expect(parseBeat(JSON.stringify(beat))).toEqual(beat)
  expect(parseBeat('not json')).toBeNull()
  expect(parseBeat('{"v":2,"id":"x"}')).toBeNull()
  expect(parseBeat('[]')).toBeNull()
  expect(parseBeat(JSON.stringify({ ...beat, state: 'dancing' }))).toBeNull()
})

test('same-folder context only for another alive session in the same root, with its recent edits', async () => {
  const beats = [
    other({
      edits: [
        { path: 'a.js', at: NOW - 2 * MINUTE },
        { path: 'src/b.ts', at: NOW - 1 * MINUTE },
        { path: 'old.md', at: NOW - 45 * MINUTE },
      ],
    }),
  ]
  expect(sameFolderContext(beats, 'self', ROOT, NOW)).toBe(
    'Another Claude Code session is working in this same project: "Fix login bug" (working, fix/login). ' +
      'In the last 30 minutes it edited: src/b.ts, a.js. Avoid editing those files unless the person asks; ' +
      'if you must, re-read them first because they may have changed.',
  )
  expect(sameFolderContext(beats, 'self', '/home/dev/other-project', NOW)).toBeNull()
  expect(sameFolderContext([other({ lastBeat: NOW - 10 * MINUTE })], 'self', ROOT, NOW)).toBeNull()
  expect(sameFolderContext([other({ state: 'idle', edits: [] })], 'self', ROOT, NOW)).toBeNull()
  expect(sameFolderContext(beats, 'other-1', ROOT, NOW)).toBeNull()
  // a session with no edits leaves nothing to avoid: no note for it alone, and left out beside others
  expect(sameFolderContext([other({ state: 'working', edits: [] })], 'self', ROOT, NOW)).toBeNull()
  const docs = other({ id: 'other-2', title: 'Docs', branch: '', state: 'waiting', edits: [] })
  expect(sameFolderContext([...beats, docs], 'self', ROOT, NOW)).toBe(sameFolderContext(beats, 'self', ROOT, NOW))
  const api = other({ id: 'other-3', title: 'API', branch: '', state: 'waiting', edits: [{ path: 'api.ts', at: NOW }] })
  const two = sameFolderContext([...beats, docs, api], 'self', ROOT, NOW)
  expect(two).toContain('Other Claude Code sessions are working in this same project')
  expect(two).toContain('- "API" (waiting on the person) edited: api.ts.')
  expect(two).not.toContain('Docs')
})

test('a conflict is the other session editing the same file within ten minutes', async () => {
  const beats = [other({ edits: [{ path: 'src/app.ts', at: NOW - 3 * MINUTE }, { path: 'old.ts', at: NOW - 12 * MINUTE }] })]
  const found = conflictFor(beats, 'self', ROOT, relativeTo(`${ROOT}/src/app.ts`, ROOT), NOW)
  expect(found?.beat.id).toBe('other-1')
  expect(conflictNote(found!, NOW)).toBe('Note: session "Fix login bug" edited this file 3 minutes ago.')
  expect(conflictToast(found!, NOW)).toBe('Heads up: the other session in earshot edited src/app.ts 3m ago.')
  expect(conflictFor(beats, 'self', ROOT, 'old.ts', NOW)).toBeNull()
  expect(conflictFor(beats, 'self', '/elsewhere', 'src/app.ts', NOW)).toBeNull()
})

test('edits keep the last thirty minutes, thirty at most, one per path', async () => {
  let edits = addEdit([], 'a.js', NOW - 40 * MINUTE)
  edits = addEdit(edits, 'b.js', NOW - MINUTE)
  edits = addEdit(edits, 'b.js', NOW)
  expect(edits).toEqual([{ path: 'b.js', at: NOW }])
  for (let i = 0; i < 40; i++) edits = addEdit(edits, `f${i}.js`, NOW + i)
  expect(edits).toHaveLength(30)
  expect(edits.at(-1)?.path).toBe('f39.js')
})

test('throttle: one write per three seconds', async () => {
  expect(throttleWait(Number.NEGATIVE_INFINITY, NOW)).toBe(0)
  expect(throttleWait(NOW, NOW + 1_000)).toBe(2_000)
  expect(throttleWait(NOW, NOW + 3_000)).toBe(0)
})

test('status line counts other live sessions only', async () => {
  const beats = [
    other({ id: 'self', state: 'waiting' }),
    other({ id: 'a', state: 'waiting' }),
    other({ id: 'b', state: 'working' }),
    other({ id: 'c', state: 'working' }),
    other({ id: 'd', state: 'working', lastBeat: NOW - 20 * MINUTE }),
    other({ id: 'e', state: 'idle' }),
  ]
  expect(statusText(beats, 'self', NOW)).toBe('◆ 1 waiting · 2 working')
  expect(statusText([other({ id: 'e', state: 'idle' })], 'self', NOW)).toBeUndefined()
  expect(statusText([], 'self', NOW)).toBeUndefined()
})

test('status line counts a waiting session once, by its top state, even with a helper at work', async () => {
  const helper = (status: string) => ({ id: `h-${status}`, description: 'Review', startedAt: NOW - MINUTE, status })
  for (const status of ['running', 'waiting']) {
    const waiting = other({ id: 'a', state: 'waiting', waitingReason: 'needs your OK to use WebFetch', helpers: [helper(status)] })
    expect(statusText([waiting], 'self', NOW), `with a ${status} helper`).toBe('◆ 1 waiting')
    // the same as the pane: under Waiting only
    const groups = boardGroups([waiting], 'self', NOW)
    expect([groups.waiting.length, groups.working.length]).toEqual([1, 0])
  }
  const working = other({ id: 'b', state: 'working', helpers: [helper('running')] })
  expect(statusText([working], 'self', NOW)).toBe('◆ 1 working')
})

test('rows keep their timer on the right and fit the width', async () => {
  expect(rowText('▶ earshot · main · A long title here', ' · 4:05', 22)).toBe('▶ earshot · ma… · 4:05')
  expect(rowText('▶ x', ' · 4:05', 40)).toBe('▶ x · 4:05')
  for (const one of wrapWords('Only this session is running. Other Claude Code sessions show up here.', 12)) {
    expect(one.length).toBeLessThanOrEqual(12)
  }
  expect(resumeCommand({ id: 'abc', root: ROOT }, ROOT)).toBe('claude --resume abc')
  expect(resumeCommand({ id: 'abc', root: '/home/dev/my app' }, ROOT)).toBe("cd '/home/dev/my app' && claude --resume abc")
})

test('helpers join the Agent calls with the agent list, and draw as cards', async () => {
  let helpers = [{ id: 'call:t1', description: 'Fix tests', startedAt: NOW, status: 'running' }]
  helpers = settleAgentCall(helpers, 'call:t1', { result: { status: 'async_launched', agentId: 'a1' } }, NOW + 100)
  expect(helpers[0]?.id).toBe('a1')
  expect(settleAgentCall(helpers, 'a1', { deny: 'no' }, NOW)).toHaveLength(0)
  const merged = mergeHelpers(
    helpers,
    [
      { id: 'a1', description: 'Fix tests', status: 'running' },
      { id: 'a2', description: 'Read docs', status: 'completed' },
      { id: 'a3', description: 'Lint', status: 'pending' },
    ],
    NOW + 72_000,
  )
  expect(merged.map(one => one.id)).toEqual(['a1', 'a3', 'a2'])
  const card = helperCard(merged[0]!, NOW + 72_000, 20)
  expect(card.text).toBe('● Fix tests  1:12   ')
  expect(card.text.length).toBe(20)
  expect(helperCard(merged[1]!, NOW + 72_000, 20).isDim).toBe(true)
  const gone = mergeHelpers(merged, [], NOW + 200_000)
  expect(gone.find(one => one.id === 'a1')?.status).toBe('completed')
})

test('the Working timer counts from the turn start, through permission prompts', async () => {
  let beat = newBeat({ id: 's', root: ROOT, branch: 'main', model: 'm', now: NOW })
  beat = transition(beat, { kind: 'turn-start' }, NOW)
  beat = transition(beat, { kind: 'notification', type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, NOW + 5_000)
  beat = transition(beat, { kind: 'tool', step: 'Bash npm test' }, NOW + 65_000)
  expect(beat.state).toBe('working')
  expect(beat.workingSince).toBe(NOW)
  const row = boardGroups([beat], 'self', NOW + 125_000).working[0]
  expect(row?.right).toBe(' · 2:05')
  // a new turn after an idle stretch starts the timer again
  beat = transition(beat, { kind: 'turn-complete' }, NOW + 200_000)
  beat = transition(beat, { kind: 'turn-start' }, NOW + 300_000)
  expect(beat.workingSince).toBe(NOW + 300_000)
  expect(parseBeat(JSON.stringify(beat))?.workingSince).toBe(NOW + 300_000)
})

test("the resume command quotes another session's id", async () => {
  expect(resumeCommand({ id: 'x; rm -rf ~', root: ROOT }, ROOT)).toBe("claude --resume 'x; rm -rf ~'")
  expect(resumeCommand({ id: 'a4844b8a-d7cc', root: ROOT }, ROOT)).toBe('claude --resume a4844b8a-d7cc')
})

test('cards, tiles and headings add up to no more than the width', async () => {
  for (const columns of [16, 36, 120]) {
    const n = cardsAcross(columns)
    const width = cardWidth(columns, n)
    expect(n * width + 2 * (n - 1), `cards at ${columns}`).toBeLessThanOrEqual(columns)
    const card = helperCard({ id: 'h', description: 'A long helper description here', startedAt: NOW, status: 'running' }, NOW + 5_000, width)
    expect(cells(card.text)).toBe(width)
    const across = tilesAcross(columns, 3, 11)
    const tile = boardTileWidth(columns, across)
    expect(across * tile + (across - 1), `tiles at ${columns}`).toBeLessThanOrEqual(columns)
    const head = headingParts("This session's helpers", columns)
    expect(cells(head.label) + (head.hair === '' ? 0 : cells(head.hair)), `heading at ${columns}`).toBeLessThanOrEqual(columns)
  }
  expect(boardTileWidth(6, 1)).toBe(6)
  expect(cardWidth(3, 1)).toBe(3)
})

test("the person's own prompts: typed, bridged, SDK, or a plugin's sent as their words", async () => {
  expect(isPersonOrigin({ kind: 'composer' })).toBe(true)
  expect(isPersonOrigin({ kind: 'bridge' })).toBe(true)
  expect(isPersonOrigin({ kind: 'sdk' })).toBe(true)
  expect(isPersonOrigin({ kind: 'plugin', asUser: true })).toBe(true)
  expect(isPersonOrigin({ kind: 'plugin' })).toBe(false)
  expect(isPersonOrigin({ kind: 'peer' })).toBe(false)
  expect(isPersonOrigin({ kind: 'scheduled-trigger' })).toBe(false)
})

test('only paths inside the project are kept, and only an absolute HOME is used', async () => {
  expect(pathInRoot(`${ROOT}/src/app.ts`, ROOT)).toBe('src/app.ts')
  expect(pathInRoot('/home/dev/.ssh/config', ROOT)).toBeNull()
  expect(pathInRoot('/home/dev/earshot-other/a.ts', ROOT)).toBeNull()
  expect(pathInRoot('./src/a.ts', ROOT)).toBe('src/a.ts')
  expect(pathInRoot('../x.ts', ROOT)).toBeNull()
  expect(pathInRoot('C:\\work\\app\\a.ts', 'C:\\work\\app')).toBe('a.ts')
  expect(pickHome(['~', undefined])).toBe('')
  expect(pickHome([undefined, ''])).toBe('')
  expect(pickHome(['relative/home'])).toBe('')
  expect(pickHome(['', 'C:\\Users\\dev'])).toBe('C:\\Users\\dev')
  expect(pickHome(['/home/dev', '/other'])).toBe('/home/dev')
})

test('the blocked call is the one put to the person, else the newest in flight', async () => {
  expect(blockersFor(['b'], ['a', 'b', 'c'])).toEqual(['b'])
  expect(blockersFor(['b', 'gone'], ['a', 'b'])).toEqual(['b'])
  expect(blockersFor([], ['a', 'b'])).toEqual(['b'])
  expect(blockersFor(['gone'], [])).toEqual([])
})

test('a blocked call ending resumes when none is left, else shows the reason of the newest still open', async () => {
  expect(afterBlocked([], 'working')).toEqual({ kind: 'resume', to: 'working' })
  expect(afterBlocked(['needs your OK to use WebFetch', ASKED], 'idle')).toEqual({ kind: 'still-waiting', reason: ASKED })
  let beat = transition(newBeat({ id: 's', root: ROOT, branch: 'main', model: 'm', now: NOW }), { kind: 'turn-start' }, NOW)
  beat = transition(beat, { kind: 'ask' }, NOW + 1_000)
  const still = transition(beat, afterBlocked(['needs your OK to use WebFetch'], 'working'), NOW + 5_000)
  expect(still).toMatchObject({ state: 'waiting', waitingReason: 'needs your OK to use WebFetch', stateSince: NOW + 1_000 })
  // the same reason, or a session no longer waiting, changes nothing
  expect(transition(still, { kind: 'still-waiting', reason: 'needs your OK to use WebFetch' }, NOW + 6_000)).toBe(still)
  const working = transition(still, { kind: 'resume', to: 'working' }, NOW + 7_000)
  expect(transition(working, { kind: 'still-waiting', reason: ASKED }, NOW + 8_000)).toBe(working)
})

test('an unchanged same-folder note is not sent again for ten minutes', async () => {
  const last = { id: 's', text: 'note', at: NOW }
  expect(shouldAttachNote('note', 's', null, NOW)).toBe(true)
  expect(shouldAttachNote('note', 's', last, NOW + 60_000)).toBe(false)
  expect(shouldAttachNote('other note', 's', last, NOW + 60_000)).toBe(true)
  expect(shouldAttachNote('note', 's2', last, NOW + 60_000)).toBe(true)
  expect(shouldAttachNote('note', 's', last, NOW + 10 * MINUTE)).toBe(true)
})

test("workflow helpers: a card at the spawn, ended by their own answer or a long quiet; an idle session with one counts as working", async () => {
  let helpers = helperSpawned([], { agentId: 'w1', callId: null, description: 'Review', isUnlisted: true }, NOW)
  expect(helpers).toEqual([{ id: 'w1', description: 'Review', startedAt: NOW, status: 'running', isUnlisted: true }])
  // no agent list names it: it stays running
  expect(mergeHelpers(helpers, [], NOW + 5 * MINUTE)[0]?.status).toBe('running')
  // a tool call keeps it going past the quiet limit; with none it is taken as finished
  const late = NOW + UNLISTED_QUIET_MS + MINUTE
  expect(mergeHelpers(helpers, [], late, new Map([['w1', NOW + 10 * MINUTE]]))[0]?.status).toBe('running')
  // ended when it went quiet, which is longer ago than a finished card stays
  expect(mergeHelpers(helpers, [], late)).toEqual([])

  const idle = { ...newBeat({ id: 'o', root: ROOT, branch: 'main', model: 'm', now: NOW - MINUTE }), stateSince: NOW, lastBeat: NOW + 60_000, helpers }
  expect(boardGroups([idle], 'self', NOW + 72_000).working[0]?.left).toBe('▶ earshot · main · New session · 1 helper working')
  expect(boardGroups([idle], 'self', NOW + 72_000).working[0]?.right).toBe(' · 1:12')
  expect(statusText([idle], 'self', NOW + 72_000)).toBe('◆ 1 working')

  helpers = helperFinished(helpers, 'w1', 'answer', NOW + 90_000)
  expect(helpers[0]).toMatchObject({ status: 'completed', endedAt: NOW + 90_000 })
  expect(helperFinished([{ ...helpers[0]!, endedAt: undefined, status: 'running' }], 'w1', 'error', NOW)[0]?.status).toBe('failed')
  expect(boardGroups([{ ...idle, helpers }], 'self', NOW + 100_000).done).toHaveLength(1)
  expect(statusText([{ ...idle, helpers }], 'self', NOW + 100_000)).toBeUndefined()
  expect(parseBeat(JSON.stringify({ ...idle, helpers }))?.helpers[0]?.isUnlisted).toBe(true)
})

test("an Agent call's card takes the spawned agent's id, so the agent list adds no second card", async () => {
  let helpers = [{ id: 'call:t1', description: 'Fix tests', startedAt: NOW, status: 'running' }]
  helpers = helperSpawned(helpers, { agentId: 'a1', callId: 'call:t1', description: 'Fix tests', isUnlisted: false }, NOW + 50)
  expect(helpers.map(one => one.id)).toEqual(['a1'])
  const merged = mergeHelpers(helpers, [{ id: 'a1', description: 'Fix tests', status: 'running' }], NOW + 5_000)
  expect(merged).toHaveLength(1)
  // the call's own answer still settles the card under its new id
  const settled = settleAgentCall(merged, 'call:t1', { result: { status: 'completed', agentId: 'a1' } }, NOW + 9_000)
  expect(settled).toMatchObject([{ id: 'a1', status: 'completed', endedAt: NOW + 9_000 }])
})
