// workbench's pure logic, called directly.

import { expect, test } from 'claude-code/testing'

import type { WorkbenchGuess } from '../types'
import {
  CORRECTIONS_INTRO,
  addGuess,
  afterClose,
  afterSend,
  ago,
  allIdeasPrompt,
  appendLearned,
  bandLayout,
  checkedLine,
  correctionsPrompt,
  fitStart,
  looksSecret,
  markGuess,
  parkedReply,
  parseReflect,
  projectName,
  readIdeas,
  sentIdeaIds,
  toItems,
  wrapLines,
} from '../hooks/logic'
import { cells } from '../hooks/look-text'

function guess(id: string, text: string, mark: WorkbenchGuess['mark'] = null, correction = ''): WorkbenchGuess {
  return { id, text, why: '', turn: 1, turnId: 't1', at: 0, agentId: null, mark, correction, isAnnounced: false }
}

test('shelf words: project name, reply, all-ideas prompt oldest first', async () => {
  expect(projectName('/Users/me/code/earshot/')).toBe('earshot')
  expect(projectName('C:\\code\\earshot')).toBe('earshot')
  expect(parkedReply(1, 'earshot')).toBe('Parked on the shelf (1 idea for earshot).')
  expect(parkedReply(4, 'earshot')).toBe('Parked on the shelf (4 ideas for earshot).')
  const prompt = allIdeasPrompt([
    { id: 'b', text: 'second', at: 20 },
    { id: 'a', text: 'first', at: 10 },
  ])
  expect(prompt).toBe('Here are some ideas I parked, handle them one at a time:\n1. first\n2. second')
  expect(readIdeas([{ id: 'x', text: 'ok', at: 1 }, { id: 'y', text: '  ' }, 'junk', null])).toEqual([{ id: 'x', text: 'ok', at: 1 }])
  const cache = [{ id: 'a', text: 'add a cache', at: 0 }]
  expect(sentIdeaIds('add a cache', cache, ['a'])).toEqual(['a'])
  expect(sentIdeaIds('fix the login first\n\nadd a cache', cache, ['a'])).toEqual(['a'])
  expect(sentIdeaIds('add a cache', cache, [])).toEqual([])
})

test('times and widths: ago, wrapLines, fitStart', async () => {
  expect(ago(0, 0)).toBe('now')
  expect(ago(5 * 60_000, 0)).toBe('5m')
  expect(ago(3 * 3_600_000, 0)).toBe('3h')
  expect(ago(2 * 86_400_000, 0)).toBe('2d')
  expect(ago(21 * 86_400_000, 0)).toBe('3w')
  const lines = wrapLines('one two three four five six seven eight nine ten', 10, 2)
  expect(lines).toHaveLength(2)
  for (const row of lines) expect(cells(row)).toBeLessThanOrEqual(10)
  expect(lines[1]?.endsWith('…')).toBe(true)
  expect(wrapLines('short', 10, 3)).toEqual(['short'])
  expect(wrapLines('abcdefghijklmnop', 5, 4)).toEqual(['abcde', 'fghij', 'klmno', 'p'])
  expect(fitStart('/a/very/long/path/CLAUDE.md', 11)).toBe('…/CLAUDE.md')
})

test('corrections prompt from Right/Wrong marks with optional corrections', async () => {
  const list = [
    guess('1', 'the config lives in config/app.json', 'wrong', 'it is in settings.toml'),
    guess('2', 'port 3000 is free', 'right'),
    guess('3', 'tests use jest.', 'wrong'),
    guess('4', 'we keep the old API', 'skip'),
    guess('5', 'names are camelCase', null),
  ]
  expect(correctionsPrompt(list)).toBe(
    [
      CORRECTIONS_INTRO,
      "1. You assumed the config lives in config/app.json. That's wrong: it is in settings.toml.",
      "2. You assumed tests use jest. That's wrong.",
    ].join('\n'),
  )
  expect(checkedLine(list)).toBe('4 of 5 checked')
  expect(afterSend(list).map(one => one.id)).toEqual(['5'])
  expect(afterClose(list).map(one => one.id)).toEqual(['1', '3', '5'])
  const toggled = markGuess(markGuess(list, '5', 'right'), '5', 'right')
  expect(toggled.find(one => one.id === '5')?.mark).toBeNull()
  expect(addGuess(list, guess('6', 'PORT 3000 IS FREE'))).toHaveLength(5)
  expect(addGuess(list, guess('6', 'a new guess'))).toHaveLength(6)
})

test('band words fit narrow and wide', async () => {
  for (const columns of [12, 20, 26, 36, 60, 120]) {
    const layout = bandLayout(3, columns)
    const used = cells(layout.text) + (layout.hasCheck ? cells(' Check them ') : 0) + (layout.hasDismiss ? 1 + cells('Dismiss') : 0)
    expect(used).toBeLessThanOrEqual(columns)
  }
  expect(bandLayout(3, 120).text).toBe('◆ Claude made 3 guesses · ')
  expect(bandLayout(1, 120).text).toBe('◆ Claude made 1 guess · ')
  expect(bandLayout(3, 36)).toEqual({ text: '◆ 3 guesses · ', hasCheck: true, hasDismiss: true })
})

test('reflect JSON parse: fences, junk around it, too many lines, secrets', async () => {
  const fenced = '```json\n{"lines":[{"text":"Run tests with `bun test`","why":"it worked"}]}\n```'
  expect(parseReflect(fenced)).toEqual([{ text: 'Run tests with `bun test`', why: 'it worked' }])
  const junk = 'Sure! Here you go:\n{"lines":[{"text":"- Use pnpm, not npm.","why":"you corrected me"}]}\nHope that helps.'
  expect(parseReflect(junk)).toEqual([{ text: 'Use pnpm, not npm.', why: 'you corrected me' }])
  const many = JSON.stringify({ lines: Array.from({ length: 9 }, (_, i) => ({ text: `Rule number ${i}`, why: '' })) })
  expect(parseReflect(many)).toHaveLength(6)
  const dupes = JSON.stringify({ lines: [{ text: 'Use pnpm' }, { text: 'use PNPM.' }, 'Keep files small'] })
  expect(parseReflect(dupes)?.map(one => one.text)).toEqual(['Use pnpm', 'Keep files small'])
  const secret = JSON.stringify({ lines: [{ text: 'Set API_KEY=sk-abcdefghijklmnopqrstuvwx' }, { text: 'Email me at a.person@example.com' }, { text: 'Clone from git@github.com:org/repo' }] })
  expect(parseReflect(secret)?.map(one => one.text)).toEqual(['Clone from git@github.com:org/repo'])
  expect(parseReflect('no json here at all')).toBeNull()
  expect(parseReflect('{"lines":[]}')).toEqual([])
  expect(parseReflect('[{"text":"Bare array works"}]')).toEqual([{ text: 'Bare array works', why: '' }])
  expect(looksSecret('Run the server from src/components/authentication/providers')).toBe(false)
})

test('CLAUDE.md append: creates ## Learned, skips duplicates, keeps other sections', async () => {
  const fresh = appendLearned('', ['Use pnpm', 'Run tests with bun test'])
  expect(fresh.text).toBe('## Learned\n\n- Use pnpm\n- Run tests with bun test\n')
  const withTitle = appendLearned('# Project\n\nSome notes.\n', ['Use pnpm'])
  expect(withTitle.text).toBe('# Project\n\nSome notes.\n\n## Learned\n\n- Use pnpm\n')
  const existing = '# Project\n\n## Learned\n\n- Use pnpm\n\n## Other\n\nStuff\n'
  const again = appendLearned(existing, ['use PNPM.', 'Keep commits small'])
  expect(again.added).toEqual(['Keep commits small'])
  expect(again.text).toBe('# Project\n\n## Learned\n\n- Use pnpm\n- Keep commits small\n\n## Other\n\nStuff\n')
  const none = appendLearned(existing, ['Use pnpm'])
  expect(none.added).toEqual([])
  expect(none.text).toBe(existing)
  const crlf = appendLearned('# P\r\n', ['A rule'])
  expect(crlf.text).toBe('# P\r\n\r\n## Learned\r\n\r\n- A rule\r\n')
  const items = toItems([{ text: 'Use pnpm', why: '' }, { text: 'New rule', why: 'x' }], existing)
  expect(items.map(one => [one.keep, one.isPresent])).toEqual([
    [false, true],
    [true, false],
  ])
})
