// The pure parts: the diff and its hunks, the tree, moving, the revert decision.

import { describe, expect, test } from 'claude-code/testing'

import type { ChangeDeckEntry } from '../types'
import {
  EMPTY_VIEW,
  MAX_LINE_CHARS,
  admit,
  askText,
  base64Bytes,
  buildTree,
  byParts,
  cleanLine,
  cleanText,
  diffLines,
  diffTexts,
  fitPath,
  headerLine,
  hunkHeader,
  isArmedNow,
  isLoadingNow,
  isUtf8,
  isWellFormed,
  limitHunks,
  messageNow,
  move,
  packRows,
  parseFileList,
  relativeTo,
  revertStep,
  revertWords,
  toggleFilter,
  touchedFiles,
  treeRows,
  visible,
  wrapWords,
} from '../hooks/logic'
import type { Hunk } from '../hooks/logic'
import { bigWidth, cells, fit, ruleParts, tilesAcross } from '../hooks/look-text'

const source = (hunks: readonly Hunk[]) => hunks.map(one => [hunkHeader(one), ...one.lines].join('\n')).join('\n')

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('')

function entry(id: number, relPath: string, more: Partial<ChangeDeckEntry> = {}): ChangeDeckEntry {
  return {
    id: String(id),
    seq: id,
    at: id * 1000,
    tool: 'Edit',
    path: `/p/${relPath}`,
    relPath,
    added: 1,
    removed: 0,
    isNew: false,
    isTooLarge: false,
    turn: 1,
    file: `/h/${id}.json`,
    ...more,
  }
}

describe('diff', () => {
  test('an insert makes one hunk with context and counts', async () => {
    const diff = diffTexts(lines(10), lines(10).replace('line 5\n', 'line 5\nnew A\nnew B\n'))
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(0)
    expect(diff.hunks).toHaveLength(1)
    expect(hunkHeader(diff.hunks[0]!)).toBe('@@ -3,6 +3,8 @@')
    expect(diff.hunks[0]!.lines).toEqual([
      ' line 3',
      ' line 4',
      ' line 5',
      '+new A',
      '+new B',
      ' line 6',
      ' line 7',
      ' line 8',
    ])
    expect(isWellFormed(source(diff.hunks))).toBe(true)
  })

  test('a delete counts removed lines only', async () => {
    const diff = diffTexts(lines(10), lines(10).replace('line 1\n', ''))
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(1)
    expect(hunkHeader(diff.hunks[0]!)).toBe('@@ -1,4 +1,3 @@')
    expect(diff.hunks[0]!.lines[0]).toBe('-line 1')
    expect(isWellFormed(source(diff.hunks))).toBe(true)
  })

  test('a replace shows the old line out and the new line in', async () => {
    const diff = diffTexts(lines(20), lines(20).replace('line 10\n', 'line ten\n'))
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(hunkHeader(diff.hunks[0]!)).toBe('@@ -7,7 +7,7 @@')
    expect(diff.hunks[0]!.lines).toContain('-line 10')
    expect(diff.hunks[0]!.lines).toContain('+line ten')
    expect(isWellFormed(source(diff.hunks))).toBe(true)
  })

  test('far-apart changes are two hunks; near ones merge', async () => {
    const far = diffTexts(lines(40), lines(40).replace('line 2\n', 'two\n').replace('line 30\n', 'thirty\n'))
    expect(far.hunks).toHaveLength(2)
    expect(isWellFormed(source(far.hunks))).toBe(true)
    const near = diffTexts(lines(40), lines(40).replace('line 2\n', 'two\n').replace('line 8\n', 'eight\n'))
    expect(near.hunks).toHaveLength(1)
  })

  test('no change makes no hunks', async () => {
    const diff = diffTexts(lines(5), lines(5))
    expect(diff.hunks).toHaveLength(0)
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(0)
  })

  test('a new file is all added from -0,0', async () => {
    const diff = diffTexts(null, 'a\nb\nc\n')
    expect(diff.added).toBe(3)
    expect(diff.removed).toBe(0)
    expect(hunkHeader(diff.hunks[0]!)).toBe('@@ -0,0 +1,3 @@')
    expect(isWellFormed(source(diff.hunks))).toBe(true)
  })

  test('a missing last newline is marked and still parses', async () => {
    const diff = diffTexts('a\nb\n', 'a\nb')
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.hunks[0]!.lines).toContain('\\ No newline at end of file')
    expect(isWellFormed(source(diff.hunks))).toBe(true)
  })

  test('over 5,000 lines a side is replaced whole', async () => {
    const diff = diffTexts(lines(5001), lines(5001, 'other'))
    expect(diff.isWhole).toBe(true)
    expect(diff.removed).toBe(5001)
    expect(diff.added).toBe(5001)
    expect(hunkHeader(diff.hunks[0]!)).toBe('@@ -1,5001 +1,5001 @@')
  })

  test('control characters are cleaned from shown lines', async () => {
    const diff = diffTexts('a\r\nb\r\n', 'a\r\nc\u0007\r\n')
    expect(diff.hunks[0]!.lines).toEqual([' a', '-b', '+c�'])
  })

  test('limiting keeps whole hunks, cuts the last one with a recounted header', async () => {
    const diff = diffTexts(null, lines(50))
    const shown = limitHunks(diff.hunks, 10)
    expect(shown.isCut).toBe(true)
    expect(shown.rows).toBe(10)
    expect(shown.totalRows).toBe(51)
    expect(shown.source.split('\n')[0]).toBe('@@ -0,0 +1,9 @@')
    expect(isWellFormed(shown.source)).toBe(true)
    const all = limitHunks(diff.hunks, 1000)
    expect(all.isCut).toBe(false)
    expect(isWellFormed(all.source)).toBe(true)
  })

  test('the well-formed check refuses a broken diff', async () => {
    expect(isWellFormed('@@ -1,2 +1,2 @@\n a\n')).toBe(false)
    expect(isWellFormed('not a diff')).toBe(false)
    expect(isWellFormed('')).toBe(false)
  })
})

describe('tree', () => {
  test('single-child folder chains collapse; folders sort first', async () => {
    const root = buildTree([
      { path: 'src/components/Button.tsx', status: 'A', added: 12, removed: 0, isTouched: true },
      { path: 'src/components/App.tsx', status: 'M', added: 4, removed: 1, isTouched: true },
      { path: 'README.md', status: 'M', added: 1, removed: 1, isTouched: true },
      { path: 'lib/a/b/c.ts', status: 'M', added: 2, removed: 3, isTouched: true },
    ])
    const rows = treeRows(root, 'all')
    expect(rows.map(row => `${row.depth}:${row.kind}:${row.name}`)).toEqual([
      '0:dir:lib/a/b',
      '1:file:c.ts',
      '0:dir:src/components',
      '1:file:App.tsx',
      '1:file:Button.tsx',
      '0:file:README.md',
    ])
  })

  test('status letters and counts come from the entries', async () => {
    const files = touchedFiles([
      entry(1, 'src/new.ts', { isNew: true, added: 10, removed: 0 }),
      entry(2, 'src/old.ts', { added: 3, removed: 2 }),
      entry(3, 'src/new.ts', { added: 2, removed: 1 }),
    ])
    const byPath = Object.fromEntries(files.map(file => [file.path, file]))
    expect(byPath['src/new.ts']).toMatchObject({ status: 'A', added: 12, removed: 1 })
    expect(byPath['src/old.ts']).toMatchObject({ status: 'M', added: 3, removed: 2 })
  })

  test('closed folders hide their files until opened', async () => {
    const root = buildTree([
      { path: 'a/x.ts', added: 0, removed: 0, isTouched: false },
      { path: 'a/y.ts', added: 0, removed: 0, isTouched: false },
      { path: 'b/z.ts', added: 1, removed: 0, isTouched: true, status: 'M' },
    ])
    expect(treeRows(root, new Set()).map(row => row.name)).toEqual(['a', 'b'])
    expect(treeRows(root, new Set(['a'])).map(row => row.name)).toEqual(['a', 'x.ts', 'y.ts', 'b'])
    const b = treeRows(root, new Set()).find(row => row.name === 'b')
    expect(b).toMatchObject({ kind: 'dir', hasTouched: true })
  })

  test('paths outside the project keep their absolute folder', async () => {
    expect(relativeTo('/p/src/a.ts', '/p')).toBe('src/a.ts')
    expect(relativeTo('/tmp/x.txt', '/p')).toBe('/tmp/x.txt')
    const rows = treeRows(buildTree([{ path: '/tmp/x.txt', added: 1, removed: 0, isTouched: true }]), 'all')
    expect(rows[0]).toMatchObject({ kind: 'dir', name: '/tmp' })
  })
})

describe('moving and reverting', () => {
  const all = [entry(1, 'a.ts'), entry(2, 'b.ts'), entry(3, 'a.ts'), entry(4, 'c.ts')]

  test('Prev, Next and Latest walk the entries', async () => {
    expect(move(all, null, null, 'prev')).toBe('3')
    expect(move(all, null, '3', 'prev')).toBe('2')
    expect(move(all, null, '1', 'prev')).toBe('1')
    expect(move(all, null, '2', 'next')).toBe('3')
    expect(move(all, null, '4', 'next')).toBe('4')
    expect(move(all, null, '2', 'latest')).toBeNull()
  })

  test('a file filter limits the walk to that file', async () => {
    expect(visible(all, 'a.ts').map(one => one.id)).toEqual(['1', '3'])
    expect(move(all, 'a.ts', null, 'prev')).toBe('1')
    expect(move(all, 'a.ts', '1', 'next')).toBe('3')
    expect(move(all, 'a.ts', '3', 'next')).toBe('3')
    const filtered = toggleFilter(EMPTY_VIEW, 'a.ts')
    expect(filtered.filter).toBe('a.ts')
    expect(toggleFilter(filtered, 'a.ts').filter).toBeNull()
  })

  test('revert only when the file still matches, armed first, never deleting a new file', async () => {
    const base = { id: '7', isTooLarge: false, hasBody: true, isLossy: false, before: 'old\n', after: 'new\n', armed: null, now: 1000 }
    expect(revertStep({ ...base, current: 'new\n' }).kind).toBe('arm')
    expect(revertStep({ ...base, current: 'new\n', armed: { id: '7', until: 2000 } }).kind).toBe('confirm')
    expect(revertStep({ ...base, current: 'new\n', armed: { id: '7', until: 500 } }).kind).toBe('arm')
    expect(revertStep({ ...base, current: 'new\n', armed: { id: '6', until: 2000 } }).kind).toBe('arm')
    expect(revertStep({ ...base, current: 'edited later\n' }).kind).toBe('changed')
    expect(revertStep({ ...base, current: null }).kind).toBe('changed')
    expect(revertStep({ ...base, before: null, current: 'new\n' }).kind).toBe('created')
    expect(revertStep({ ...base, isTooLarge: true, current: 'new\n' }).kind).toBe('too-large')
  })
})

test('chips pack into rows no wider than the room; look helpers keep widths', async () => {
  expect(packRows([8, 8, 8, 18, 23, 5], 120)).toEqual([[0, 1, 2, 3, 4, 5]])
  expect(packRows([8, 8, 8, 18, 23, 5], 40)).toEqual([[0, 1, 2], [3], [4, 5]])
  expect(fit('hello world', 5)).toBe('hell…')
  const { gold, hair } = ruleParts(9, 40)
  expect(gold.length + hair.length).toBe(40)
  expect(bigWidth('14')).toBe(7)
  expect(tilesAcross(40, 3, 12)).toBe(3)
})

describe('review fixes', () => {
  test('C1 control characters are cleaned from diff lines and drawn text', async () => {
    expect(cleanLine('x \u0085 y\u009b\u007f')).toBe('x � y��')
    const diff = diffTexts('a\n', 'a\u0080\u0099\n')
    expect(diff.hunks[0]!.lines).toEqual(['-a', '+a��'])
    expect(cleanText('src/\u0085x\tq\n.ts')).toBe('src/�x�q�.ts')
    expect(cleanText('src/café.ts')).toBe('src/café.ts')
  })

  test('UTF-8 check: bytes that are not UTF-8 make the text inexact, and revert refuses', async () => {
    expect(isUtf8(base64Bytes('Y2Fm77+9IG9uZQo='))).toBe(true)
    expect(isUtf8(base64Bytes('aMOpbGxvIOKckyDwnYSeCg=='))).toBe(true)
    expect(isUtf8(base64Bytes('Y2Fm6SBvbmUK'))).toBe(false)
    expect(isUtf8(base64Bytes('//5oAGkA'))).toBe(false)
    expect(isUtf8(base64Bytes('7aCA'))).toBe(false)
    expect(isUtf8(base64Bytes('wK8='))).toBe(false)
    expect(Array.from(base64Bytes('Y2Fm6SBvbmUK'))).toEqual([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6e, 0x65, 0x0a])
    const base = { id: '7', isTooLarge: false, hasBody: true, before: 'caf�\n', after: 'x\n', current: 'x\n', armed: null, now: 1 }
    expect(revertStep({ ...base, isLossy: true }).kind).toBe('not-text')
    expect(revertStep({ ...base, isLossy: false }).kind).toBe('arm')
    expect(revertWords('not-text', 'src/x', 2)).toBe("src/x isn't UTF-8 text, so it can't be put back exactly here. Nothing was changed.")
  })

  test('a helper no list names reads "by a helper", never by helper "helper"', async () => {
    const one = (more: Partial<ChangeDeckEntry>) => byParts(entry(1, 'a.ts', { at: 0, ...more }), 0)[1]
    expect(one({})).toBe('by Claude')
    expect(one({ agentId: 'abc' })).toBe('by a helper')
    expect(one({ agentId: 'abc', agentLabel: 'helper' })).toBe('by a helper')
    expect(one({ agentLabel: 'helper' })).toBe('by a helper')
    expect(one({ agentId: 'abc', agentLabel: 'Fix tests' })).toBe('by helper "Fix tests"')
    expect(one({ agentLabel: 'you' })).toBe('by you')
  })

  test('long paths keep their file name: header, messages and folders', async () => {
    const long = '/root/.claude/dev-mods/a4844b8a-d7cc/prompt-upgrade/hooks/logic.ts'
    expect(fitPath('src/app.js', 20)).toBe('src/app.js')
    expect(fitPath(long, 30)).toBe('/root/…/hooks/logic.ts')
    expect(fitPath(long, 22)).toBe('/root/…/hooks/logic.ts')
    expect(fitPath(long, 14)).toBe('…/logic.ts')
    expect(fitPath('src/components/very/deep/Button.tsx', 22)).toBe('src/…/deep/Button.tsx')
    expect(fitPath('averyveryverylongname.tsx', 10)).toBe('…gname.tsx')
    for (const width of [1, 2, 5, 9, 14, 22, 40]) expect(cells(fitPath(long, width))).toBeLessThanOrEqual(width)
    const header = headerLine(3, 3, entry(3, long, { tool: 'Edit' }), 40)
    expect(cells(header)).toBeLessThanOrEqual(40)
    expect(header).toMatch(/^Edit 3 of 3 · Edit · .*logic\.ts$/)
    const lines = wrapWords(`Press again to revert ${long} to before edit 7`, 30)
    expect(lines.some(one => one.includes('/hooks/logic.ts'))).toBe(true)
    for (const one of lines) expect(cells(one)).toBeLessThanOrEqual(30)
  })

  test('a line too long to show is cut, so the diff still shows and parses', async () => {
    const diff = diffTexts(`var a=${'x'.repeat(70_000)};\n`, `var a=${'y'.repeat(70_000)};\n`)
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    const shown = limitHunks(diff.hunks, 30)
    expect(shown.source).not.toBe('')
    expect(isWellFormed(shown.source)).toBe(true)
    for (const one of shown.source.split('\n')) expect(one.length).toBeLessThanOrEqual(MAX_LINE_CHARS + 2)
    expect(askText('min.js', 1, 1, diff.hunks)).not.toMatch(/no line changes/)
  })

  test('a one-line edit to a long file is diffed, not replaced whole', async () => {
    const before = lines(20_000)
    const diff = diffTexts(before, before.replace('line 12345\n', 'line twelve\n'))
    expect(diff.isWhole).toBe(false)
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(hunkHeader(diff.hunks[0]!)).toBe('@@ -12342,7 +12342,7 @@')
    expect(isWellFormed(source(diff.hunks))).toBe(true)
    const wide = diffTexts(lines(6000), lines(6000).replace(/line /g, 'row '))
    expect(wide.isWhole).toBe(true)
  })

  test('the index keeps 1,000 entries and its bodies under the size cap, oldest let go first', async () => {
    const sized = (id: number, bytes: number) => entry(id, 'a.ts', { bytes, file: `/h/${id}.json` })
    const full = Array.from({ length: 1000 }, (_, i) => sized(i + 1, 10))
    const past = admit(full, sized(1001, 10))
    expect(past.entries).toHaveLength(1000)
    expect(past.entries[0]!.id).toBe('2')
    expect(past.drop).toEqual(['/h/1.json'])
    const heavy = admit([sized(1, 60), sized(2, 60)], sized(3, 60), 1000, 150)
    expect(heavy.drop).toEqual(['/h/1.json'])
    expect(heavy.entries[0]).toMatchObject({ id: '1', file: '', isDropped: true })
    expect(heavy.entries[2]).toMatchObject({ id: '3', file: '/h/3.json' })
    const huge = admit([], sized(1, 999), 1000, 150)
    expect(huge.drop).toEqual([])
    expect(huge.entries[0]!.file).toBe('/h/1.json')
  })

  test('a listing or an armed revert a reload cut off does not stick', async () => {
    const project = { paths: [], source: 'none' as const, isCapped: false, loadingSince: 1000 }
    expect(isLoadingNow(project, 2000)).toBe(true)
    expect(isLoadingNow(project, 1000 + 61_000)).toBe(false)
    expect(isLoadingNow({ ...project, loadingSince: null }, 2000)).toBe(false)
    expect(isLoadingNow({ paths: [], source: 'none', isCapped: false, isLoading: true } as never, 2000)).toBe(false)
    const view = { ...EMPTY_VIEW, armed: { id: '7', until: 5000 }, message: { text: 'Press again', tone: 'warn' as const } }
    expect(isArmedNow(view, '7', 4000)).toBe(true)
    expect(isArmedNow(view, '7', 6000)).toBe(false)
    expect(messageNow(view, 4000)?.text).toBe('Press again')
    expect(messageNow(view, 6000)).toBeNull()
    expect(messageNow({ ...EMPTY_VIEW, message: { text: 'Reverted', tone: 'good' } }, 6000)?.text).toBe('Reverted')
  })

  test('Ask text: a fence longer than any backticks inside, a too-large edit, counts without headers', async () => {
    const diff = diffTexts('# Title\n', '# Title\n```js\nx\n```\n')
    const text = askText('README.md', 2, 3, diff.hunks)
    expect(text.startsWith('About your edit to README.md (edit 2 of 3):\n````diff\n')).toBe(true)
    expect(text.endsWith('\n````\n')).toBe(true)
    expect(askText('huge.txt', 1, 2, null, true)).toBe("About your edit to huge.txt (edit 1 of 2): the file was over 1 MB, so this edit's texts were not kept.\n")
    expect(askText('gone.txt', 1, 2, null)).toMatch(/could not be read/)
    const created = diffTexts(null, lines(80))
    expect(diffLines(created.hunks)).toBe(80)
    expect(limitHunks(created.hunks, 1000).totalLines).toBe(80)
    expect(diffLines(diffTexts('a\n', 'a').hunks)).toBe(2)
  })

  test('git -z output: names split on NUL, never quoted, so non-ASCII names match', async () => {
    const parsed = parseFileList('café.txt\u0000src/a b.ts\u0000README.md\u0000', 2)
    expect(parsed.paths).toEqual(['café.txt', 'src/a b.ts'])
    expect(parsed.isCapped).toBe(true)
    expect(parseFileList('a.ts\nb.ts\n', 10).paths).toEqual(['a.ts', 'b.ts'])
  })
})
