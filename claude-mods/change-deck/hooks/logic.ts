// Pure logic for the change deck: the line diff and its hunks, the file tree,
// moving through the replay, the revert decision, and the words the pane shows.
// Nothing here touches `$`, so the tests call every function directly.

import type { ChangeDeckEntry, ChangeDeckProject, ChangeDeckView } from '../types'
import { cells, fit } from './look-text'

// ── The line diff ────────────────────────────────────────────────────────────

/** Lines of context around each change. */
export const CONTEXT = 3
/** Above this many lines on either side the diff is "replaced whole file". */
export const MAX_SIDE_LINES = 5000
/** The most edit distance the diff searches before it replaces the middle whole. */
export const MAX_D = 1500
/** Files larger than this many bytes are not kept for replay. */
export const MAX_BYTES = 1_000_000
/** A diff line longer than this many characters is cut (its marker kept), so one long line never hides the diff. */
export const MAX_LINE_CHARS = 1000

export type Hunk = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** The hunk's body: ` `, `-`, `+` lines and `\ No newline at end of file`. */
  lines: string[]
}

export type Diff = {
  hunks: Hunk[]
  added: number
  removed: number
  /** True when the file was too long to diff line by line. */
  isWhole: boolean
}

type Op = { kind: ' ' | '-' | '+'; text: string }

/** Splits text into lines that keep their `\n`, so a missing last newline shows. */
export function splitLines(text: string | null): string[] {
  if (text === null || text === '') return []
  const out: string[] = []
  let start = 0
  for (;;) {
    const at = text.indexOf('\n', start)
    if (at < 0) {
      if (start < text.length) out.push(text.slice(start))
      return out
    }
    out.push(text.slice(start, at + 1))
    start = at + 1
  }
}

/**
 * Myers' O(ND) shortest edit script between `a` and `b`, or null when the edit
 * distance passes `maxD`. Keeps only the band of V each step reads, so memory
 * grows with D squared rather than D times the file's length.
 */
function myers(a: readonly string[], b: readonly string[], maxD: number): Op[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max; d++) {
    if (d > maxD) return null
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!
      } else {
        x = v[offset + k - 1]! + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (found >= 0) break
  }
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = found; d >= 0; d--) {
    const band = trace[d]!
    const at = (k: number) => band[k + d + 1]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ kind: ' ', text: a[x - 1]! })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ kind: '+', text: b[y - 1]! })
      } else {
        ops.push({ kind: '-', text: a[x - 1]! })
      }
    }
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

/**
 * A line as a diff shows it: no line break, no control characters but tab
 * (C0, DEL and C1 all become U+FFFD; the engine refuses a drawing holding one),
 * and cut after MAX_LINE_CHARS characters.
 */
export function cleanLine(text: string): string {
  const clean = text
    .replace(/\r?\n$/, '')
    .replace(/\r$/, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '�')
  return clean.length > MAX_LINE_CHARS ? Array.from(clean).slice(0, MAX_LINE_CHARS).join('') + '…' : clean
}

/** Text for one row (a path, a label): every control character, tab and newline too, becomes U+FFFD. */
export function cleanText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '�')
}

/** Groups an edit script into unified-diff hunks with `context` lines around. */
function hunksOf(ops: readonly Op[], context: number): Hunk[] {
  const hunks: Hunk[] = []
  const oldBefore: number[] = []
  const newBefore: number[] = []
  let oldSeen = 0
  let newSeen = 0
  for (const op of ops) {
    oldBefore.push(oldSeen)
    newBefore.push(newSeen)
    if (op.kind !== '+') oldSeen++
    if (op.kind !== '-') newSeen++
  }
  let i = 0
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.kind === ' ') i++
    if (i >= ops.length) break
    const start = Math.max(0, i - context)
    let lastChange = i
    let j = i
    while (j < ops.length) {
      if (ops[j]!.kind !== ' ') {
        lastChange = j
      } else if (j - lastChange > 2 * context) {
        break
      }
      j++
    }
    const stop = Math.min(ops.length, lastChange + 1 + context)
    const lines: string[] = []
    let oldCount = 0
    let newCount = 0
    for (let at = start; at < stop; at++) {
      const op = ops[at]!
      lines.push(op.kind + cleanLine(op.text))
      if (!op.text.endsWith('\n')) lines.push('\\ No newline at end of file')
      if (op.kind !== '+') oldCount++
      if (op.kind !== '-') newCount++
    }
    const oldPos = oldBefore[start]!
    const newPos = newBefore[start]!
    hunks.push({
      oldStart: oldCount > 0 ? oldPos + 1 : oldPos,
      oldCount,
      newStart: newCount > 0 ? newPos + 1 : newPos,
      newCount,
      lines,
    })
    i = stop
  }
  return hunks
}

/**
 * The diff of two texts (null for a file that did not exist). The common head
 * and tail are kept first; the changed middle is diffed line by line unless it
 * passes MAX_SIDE_LINES on a side (then it is shown replaced whole, `isWhole`)
 * or MAX_D edits (then it is replaced whole too, quietly).
 */
export function diffTexts(before: string | null, after: string | null): Diff {
  const a = splitLines(before)
  const b = splitLines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const isWhole = midA.length > MAX_SIDE_LINES || midB.length > MAX_SIDE_LINES
  const middle =
    (isWhole ? null : myers(midA, midB, MAX_D)) ??
    [...midA.map(text => ({ kind: '-' as const, text })), ...midB.map(text => ({ kind: '+' as const, text }))]
  let added = 0
  let removed = 0
  for (const op of middle) {
    if (op.kind === '+') added++
    if (op.kind === '-') removed++
  }
  const ops: Op[] = [
    ...a.slice(0, head).map(text => ({ kind: ' ' as const, text })),
    ...middle,
    ...a.slice(a.length - tail).map(text => ({ kind: ' ' as const, text })),
  ]
  return { hunks: hunksOf(ops, CONTEXT), added, removed, isWhole }
}

/** `@@ -a,b +c,d @@` */
export function hunkHeader(hunk: Hunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
}

/** Rows a hunk takes drawn: its header and its lines. */
export function hunkRows(hunk: Hunk): number {
  return 1 + hunk.lines.length
}

/** Rows the whole diff takes drawn. */
export function diffRows(hunks: readonly Hunk[]): number {
  return hunks.reduce((sum, hunk) => sum + hunkRows(hunk), 0)
}

/** Lines of the diff a person counts: context, removed and added, not headers or notes. */
export function diffLines(hunks: readonly Hunk[]): number {
  let count = 0
  for (const hunk of hunks) for (const one of hunk.lines) if (!one.startsWith('\\')) count++
  return count
}

/** The first `keep` lines of a hunk as a hunk of its own, its header recounted. */
function cutHunk(hunk: Hunk, keep: number): Hunk {
  let lines = hunk.lines.slice(0, Math.max(1, keep))
  while (lines.length > 1 && lines[0]!.startsWith('\\')) lines = lines.slice(1)
  let oldCount = 0
  let newCount = 0
  for (const one of lines) {
    if (one.startsWith(' ') || one.startsWith('-')) oldCount++
    if (one.startsWith(' ') || one.startsWith('+')) newCount++
  }
  const oldStart = oldCount === 0 && hunk.oldCount > 0 ? hunk.oldStart - 1 : hunk.oldStart
  const newStart = newCount === 0 && hunk.newCount > 0 ? hunk.newStart - 1 : hunk.newStart
  return { oldStart, oldCount, newStart, newCount, lines }
}

export type ShownDiff = {
  /** Unified-diff hunks that parse: whole hunks, the last one perhaps cut and recounted. */
  source: string
  /** Rows of `source`. */
  rows: number
  /** Rows of the whole diff. */
  totalRows: number
  /** Diff lines (not headers) of `source`. */
  lines: number
  /** Diff lines (not headers) of the whole diff. */
  totalLines: number
  isCut: boolean
}

/**
 * The hunks that fit `maxRows` rows and `maxChars` characters, as text that
 * still parses: a hunk cut short gets a header counting what it keeps.
 */
export function limitHunks(hunks: readonly Hunk[], maxRows: number, maxChars = 60_000): ShownDiff {
  const totalRows = diffRows(hunks)
  const out: string[] = []
  let rows = 0
  let lines = 0
  let chars = 0
  let isCut = false
  for (const hunk of hunks) {
    const need = hunkRows(hunk)
    const text = [hunkHeader(hunk), ...hunk.lines].join('\n')
    if (rows + need <= maxRows && chars + text.length + 1 <= maxChars) {
      out.push(text)
      rows += need
      lines += diffLines([hunk])
      chars += text.length + 1
      continue
    }
    isCut = true
    const roomRows = maxRows - rows - 1
    if (roomRows >= 1) {
      let keep = Math.min(roomRows, hunk.lines.length)
      let cut = cutHunk(hunk, keep)
      let cutText = [hunkHeader(cut), ...cut.lines].join('\n')
      while (keep > 1 && chars + cutText.length + 1 > maxChars) {
        keep = Math.max(1, Math.floor(keep / 2))
        cut = cutHunk(hunk, keep)
        cutText = [hunkHeader(cut), ...cut.lines].join('\n')
      }
      if (chars + cutText.length + 1 <= maxChars) {
        out.push(cutText)
        rows += hunkRows(cut)
        lines += diffLines([cut])
      }
    }
    break
  }
  return { source: out.join('\n'), rows, totalRows, lines, totalLines: diffLines(hunks), isCut }
}

/**
 * Whether `source` parses as unified-diff hunks: each `@@ -a,b +c,d @@` header
 * followed by exactly the lines its counts promise.
 */
export function isWellFormed(source: string): boolean {
  if (source === '') return false
  const lines = source.split('\n')
  let i = 0
  let hunks = 0
  while (i < lines.length) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!)
    if (match === null) return false
    let oldLeft = match[2] === undefined ? 1 : Number(match[2])
    let newLeft = match[4] === undefined ? 1 : Number(match[4])
    i++
    hunks++
    while (oldLeft > 0 || newLeft > 0) {
      const one = lines[i]
      if (one === undefined) return false
      if (one.startsWith(' ')) {
        oldLeft--
        newLeft--
      } else if (one.startsWith('-')) {
        oldLeft--
      } else if (one.startsWith('+')) {
        newLeft--
      } else if (!one.startsWith('\\')) {
        return false
      }
      if (oldLeft < 0 || newLeft < 0) return false
      i++
    }
    while (lines[i]?.startsWith('\\') === true) i++
  }
  return hunks > 0
}

// ── Paths ────────────────────────────────────────────────────────────────────

/** Forward slashes, no trailing slash. */
export function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
}

/** The path relative to `root`, or the path itself when it lies outside. */
export function relativeTo(path: string, root: string): string {
  const file = normalizePath(path)
  const base = normalizePath(root)
  if (base !== '' && file.startsWith(base + '/')) return file.slice(base.length + 1)
  return file
}

/** An absolute path for a tool's path argument. */
export function absoluteFrom(path: string, cwd: string): string {
  const file = normalizePath(path)
  if (file.startsWith('/') || /^[A-Za-z]:\//.test(file)) return file
  return `${normalizePath(cwd)}/${file.replace(/^\.\//, '')}`
}

/**
 * A path cut to `width` cells keeping its file name: the first folder, an
 * ellipsis for the middle, then as many trailing folders as fit
 * (`/root/…/hooks/logic.ts`); just the name's end when even that is too wide.
 */
export function fitPath(path: string, width: number): string {
  const room = Math.floor(width)
  if (room <= 0) return ''
  if (cells(path) <= room) return path
  const parts = path.split('/')
  const base = parts[parts.length - 1]!
  const headCount = parts[0] === '' ? 2 : 1
  const tailWithin = (budget: number): string | null => {
    if (base === '' || cells(base) > budget) return null
    let tail = base
    for (let i = parts.length - 2; i >= headCount; i--) {
      const next = `${parts[i]}/${tail}`
      if (cells(next) > budget) break
      tail = next
    }
    return tail
  }
  if (parts.length - 1 > headCount) {
    const head = parts.slice(0, headCount).join('/')
    const tail = tailWithin(room - cells(head) - 3)
    if (tail !== null) return `${head}/…/${tail}`
  }
  const bare = parts.length > 1 ? tailWithin(room - 2) : null
  if (bare !== null) return `…/${bare}`
  const chars = Array.from(path)
  return room === 1 ? '…' : '…' + chars.slice(chars.length - (room - 1)).join('')
}

/** A session id safe as one folder name. */
export function safeSegment(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9_-]/g, '_')
  return cleaned === '' ? 'session' : cleaned.slice(0, 120)
}

/** The folder this mod keeps a session's edits in. */
export function sessionFolder(home: string, sessionId: string): string {
  return `${normalizePath(home)}/.claude/mod-data/change-deck/${safeSegment(sessionId)}`
}

/** Whether `path` is one of this mod's saved bodies (`…/.claude/mod-data/change-deck/<session>/<n>.json`). */
export function isBodyPath(path: string): boolean {
  return /\/\.claude\/mod-data\/change-deck\/[A-Za-z0-9_-]+\/\d+\.json$/.test(normalizePath(path))
}

/** Whether a listed folder under the data root is old enough to remove. */
export function isStaleFolder(name: string, mtimeMs: number, now: number, current: string): boolean {
  if (name === current || name === '.' || name === '..' || name.includes('/')) return false
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return false
  return mtimeMs > 0 && now - mtimeMs > 7 * 24 * 60 * 60 * 1000
}

// ── The file tree ────────────────────────────────────────────────────────────

export type TreeFile = {
  path: string
  status?: 'A' | 'M'
  added: number
  removed: number
  isTouched: boolean
}

export type TreeDir = {
  name: string
  path: string
  dirs: TreeDir[]
  files: (TreeFile & { name: string })[]
  hasTouched: boolean
}

export type TreeRow =
  | { kind: 'dir'; depth: number; name: string; path: string; isOpen: boolean; hasTouched: boolean }
  | ({ kind: 'file'; depth: number; name: string } & TreeFile)

function segmentsOf(path: string): string[] {
  const parts = normalizePath(path).split('/')
  if (parts[0] === '' && parts.length > 1) return ['/' + parts[1], ...parts.slice(2)].filter(p => p !== '')
  return parts.filter(p => p !== '')
}

function byName(a: { name: string }, b: { name: string }): number {
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** A tree of folders and files, folders first, single-child folder chains collapsed. */
export function buildTree(files: readonly TreeFile[]): TreeDir {
  const root: TreeDir = { name: '', path: '', dirs: [], files: [], hasTouched: false }
  const seen = new Set<string>()
  for (const file of files) {
    const parts = segmentsOf(file.path)
    if (parts.length === 0 || seen.has(parts.join('/'))) continue
    seen.add(parts.join('/'))
    let dir = root
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!
      let next = dir.dirs.find(one => one.name === name)
      if (next === undefined) {
        next = { name, path: parts.slice(0, i + 1).join('/'), dirs: [], files: [], hasTouched: false }
        dir.dirs.push(next)
      }
      if (file.isTouched) next.hasTouched = true
      dir = next
    }
    dir.files.push({ ...file, name: parts[parts.length - 1]! })
    if (file.isTouched) root.hasTouched = true
  }
  const finish = (dir: TreeDir): TreeDir => {
    let node = dir
    while (node !== root && node.files.length === 0 && node.dirs.length === 1) {
      const only = node.dirs[0]!
      node = { ...only, name: `${node.name}/${only.name}`, hasTouched: node.hasTouched || only.hasTouched }
    }
    return {
      ...node,
      dirs: node.dirs.map(finish).sort(byName),
      files: [...node.files].sort(byName),
    }
  }
  return finish(root)
}

/** The tree as rows, opening every folder (`'all'`) or only those in `open`. */
export function treeRows(root: TreeDir, open: 'all' | ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: TreeDir, depth: number) => {
    for (const sub of dir.dirs) {
      const isOpen = open === 'all' || open.has(sub.path)
      rows.push({ kind: 'dir', depth, name: sub.name, path: sub.path, isOpen, hasTouched: sub.hasTouched })
      if (isOpen) walk(sub, depth + 1)
    }
    for (const file of dir.files) {
      rows.push({ kind: 'file', depth, ...file })
    }
  }
  walk(root, 0)
  return rows
}

/** Each touched file once, with its status and line counts summed over its edits. */
export function touchedFiles(entries: readonly ChangeDeckEntry[]): TreeFile[] {
  const byPath = new Map<string, TreeFile>()
  for (const entry of entries) {
    const known = byPath.get(entry.relPath)
    if (known === undefined) {
      byPath.set(entry.relPath, {
        path: entry.relPath,
        status: entry.isNew ? 'A' : 'M',
        added: entry.added,
        removed: entry.removed,
        isTouched: true,
      })
    } else {
      known.added += entry.added
      known.removed += entry.removed
    }
  }
  return [...byPath.values()]
}

/** The project's files and the touched ones together, touched marked. */
export function projectFiles(paths: readonly string[], touched: readonly TreeFile[]): TreeFile[] {
  const byPath = new Map<string, TreeFile>()
  for (const path of paths) {
    const clean = normalizePath(path)
    if (clean !== '') byPath.set(clean, { path: clean, added: 0, removed: 0, isTouched: false })
  }
  for (const file of touched) byPath.set(normalizePath(file.path), file)
  return [...byPath.values()]
}

/**
 * Paths from `git ls-files -z` output (NUL between names, none quoted), or
 * one per line, at most `cap`, cleaned for drawing as recorded paths are.
 */
export function parseFileList(stdout: string, cap: number): { paths: string[]; isCapped: boolean } {
  const isNul = stdout.includes('\u0000')
  const all = stdout
    .split(isNul ? '\u0000' : '\n')
    .map(line => (isNul ? line : line.trim()))
    .filter(line => line !== '')
    .map(cleanText)
  return { paths: all.slice(0, cap), isCapped: all.length > cap }
}

/** Folders the project listing skips. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build'])

/** `+12 −3` */
export function counts(added: number, removed: number): string {
  return `+${added} −${removed}`
}

// ── Moving through the replay ────────────────────────────────────────────────

/** The entries the replay walks: all of them, or one file's. */
export function visible(entries: readonly ChangeDeckEntry[], filter: string | null): ChangeDeckEntry[] {
  return filter === null ? [...entries] : entries.filter(entry => entry.relPath === filter)
}

/** Where the cursor stands in `list`: its entry, else the last; -1 when empty. */
export function cursorIndex(list: readonly ChangeDeckEntry[], cursor: string | null): number {
  if (list.length === 0) return -1
  if (cursor === null) return list.length - 1
  const at = list.findIndex(entry => entry.id === cursor)
  return at < 0 ? list.length - 1 : at
}

/** The cursor after Prev, Next or Latest. Latest follows new edits (null). */
export function move(
  entries: readonly ChangeDeckEntry[],
  filter: string | null,
  cursor: string | null,
  action: 'prev' | 'next' | 'latest',
): string | null {
  if (action === 'latest') return null
  const list = visible(entries, filter)
  const at = cursorIndex(list, cursor)
  if (at < 0) return null
  const to = action === 'prev' ? Math.max(0, at - 1) : Math.min(list.length - 1, at + 1)
  return list[to]!.id
}

/** The view after pressing a file in the tree: filter to it, or clear the filter. */
export function toggleFilter(view: ChangeDeckView, path: string): ChangeDeckView {
  const filter = view.filter === path ? null : path
  return { ...view, filter, cursor: null, showAll: false, armed: null, message: null }
}

/** The view after pressing a folder in Project mode: open it, or close it. */
export function toggleFolder(view: ChangeDeckView, path: string): ChangeDeckView {
  const open = view.open.includes(path) ? view.open.filter(one => one !== path) : [...view.open, path]
  return { ...view, open }
}

export const EMPTY_VIEW: ChangeDeckView = {
  cursor: null,
  filter: null,
  mode: 'touched',
  open: [],
  showAll: false,
  treeAll: false,
  armed: null,
  message: null,
}

// ── Reverting ────────────────────────────────────────────────────────────────

export type RevertStep =
  | { kind: 'too-large' }
  | { kind: 'no-body' }
  | { kind: 'not-text' }
  | { kind: 'changed' }
  | { kind: 'created' }
  | { kind: 'arm' }
  | { kind: 'confirm' }

/**
 * What a press of Revert does. Allowed only while the file's text now equals
 * the entry's `after`; the first press arms, a second within the window writes.
 */
export function revertStep(o: {
  id: string
  isTooLarge: boolean
  hasBody: boolean
  /** The kept texts or the file now are not exact UTF-8 text: writing back would not restore its bytes. */
  isLossy: boolean
  before: string | null
  after: string | null
  current: string | null
  armed: { id: string; until: number } | null
  now: number
}): RevertStep {
  if (o.isTooLarge) return { kind: 'too-large' }
  if (!o.hasBody) return { kind: 'no-body' }
  if (o.isLossy) return { kind: 'not-text' }
  if (o.current !== o.after) return { kind: 'changed' }
  if (o.before === null) return { kind: 'created' }
  if (o.armed !== null && o.armed.id === o.id && o.now <= o.armed.until) return { kind: 'confirm' }
  return { kind: 'arm' }
}

/** How long a armed revert waits for its second press. */
export const ARM_MS = 10_000

export function revertWords(step: RevertStep['kind'], relPath: string, number: number): string {
  switch (step) {
    case 'too-large':
      return `${relPath} was over 1 MB, so this edit can't be reverted here.`
    case 'no-body':
      return `The saved copy of edit ${number} is missing, so it can't be reverted.`
    case 'not-text':
      return `${relPath} isn't UTF-8 text, so it can't be put back exactly here. Nothing was changed.`
    case 'changed':
      return `${relPath} changed after this edit, so it can't be reverted cleanly.`
    case 'created':
      return 'This edit created the file. Delete it yourself if you want it gone.'
    case 'arm':
      return `Press again to revert ${relPath} to before edit ${number}`
    case 'confirm':
      return `Reverted ${relPath} to before edit ${number}.`
  }
}

// ── Words ────────────────────────────────────────────────────────────────────

/** "just now", "2m ago", "3h ago", "2d ago" */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** "14 edits · 6 files" */
export function summary(entries: readonly ChangeDeckEntry[]): string {
  const files = new Set(entries.map(entry => entry.relPath)).size
  const edits = entries.length
  return `${edits} ${edits === 1 ? 'edit' : 'edits'} · ${files} ${files === 1 ? 'file' : 'files'}`
}

/** Totals for the tiles. */
export function totals(entries: readonly ChangeDeckEntry[]): { edits: number; files: number; added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const entry of entries) {
    added += entry.added
    removed += entry.removed
  }
  return { edits: entries.length, files: new Set(entries.map(entry => entry.relPath)).size, added, removed }
}

/** `Edit 7 of 14 · Edit · src/app.js`, within `width` cells, the path cut in its middle. */
export function headerLine(number: number, total: number, entry: ChangeDeckEntry, width = Infinity): string {
  const lead = `Edit ${number} of ${total} · ${entry.tool} · `
  const room = width - cells(lead)
  if (room >= 8) return lead + fitPath(entry.relPath, room)
  return fit(lead + entry.relPath, width)
}

/** `2m ago · by helper "Fix tests" · turn 3` */
export function byLine(entry: ChangeDeckEntry, now: number): string {
  return byParts(entry, now).join(' \u00b7 ')
}

/** The parts of the by-line, kept whole when it is broken across lines. */
export function byParts(entry: ChangeDeckEntry, now: number): string[] {
  // An older record kept `helper` for a helper no list named.
  const named = entry.agentLabel !== undefined && entry.agentLabel !== 'helper' ? entry.agentLabel : undefined
  const who =
    named === 'you'
      ? 'by you'
      : named !== undefined
        ? `by helper "${named}"`
        : entry.agentId !== undefined || entry.agentLabel !== undefined
          ? 'by a helper'
          : 'by Claude'
  return [ago(now - entry.at), who, `turn ${entry.turn}`]
}

/** Packs parts into lines of at most `width` cells, `sep` between parts on a line. */
export function packParts(parts: readonly string[], width: number, sep = ' · '): string[] {
  const room = Math.max(1, Math.floor(width))
  const cut = (text: string) => {
    const chars = Array.from(text)
    return chars.length <= room ? text : chars.slice(0, Math.max(0, room - 1)).join('') + '…'
  }
  const out: string[] = []
  let current = ''
  for (const part of parts) {
    const candidate = current === '' ? part : `${current}${sep}${part}`
    if (Array.from(candidate).length <= room) {
      current = candidate
    } else {
      if (current !== '') out.push(current)
      current = cut(part)
    }
  }
  if (current !== '') out.push(current)
  return out
}

/**
 * The prompt text "Ask Claude about this" puts in the box: the diff (up to 60
 * lines) in a fence longer than any run of backticks inside it, or why there
 * is none (`hunks` null: the texts were not kept).
 */
export function askText(
  relPath: string,
  number: number,
  total: number,
  hunks: readonly Hunk[] | null,
  isTooLarge = false,
): string {
  const lead = `About your edit to ${relPath} (edit ${number} of ${total})`
  if (isTooLarge) return `${lead}: the file was over 1 MB, so this edit's texts were not kept.\n`
  if (hunks === null) return `${lead}: the saved copy of this edit could not be read.\n`
  const shown = limitHunks(hunks, 60)
  const body = shown.source === '' ? '(no line changes)' : shown.source
  const longest = (body.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${lead}:\n${fence}diff\n${body}\n${fence}\n`
}

/** Packs chips of `widths` into rows no wider than `columns`, `gap` cells apart. */
export function packRows(widths: readonly number[], columns: number, gap = 1): number[][] {
  const rows: number[][] = []
  let row: number[] = []
  let used = 0
  widths.forEach((width, index) => {
    const need = row.length === 0 ? width : used + gap + width
    if (row.length > 0 && need > columns) {
      rows.push(row)
      row = [index]
      used = width
    } else {
      row.push(index)
      used = need
    }
  })
  if (row.length > 0) rows.push(row)
  return rows
}

/** Parses a body file's text; null when it is not one. */
export function parseBody(text: string): { before: string | null; after: string | null } | null {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return null
    const body = value as { before?: unknown; after?: unknown }
    const before = typeof body.before === 'string' ? body.before : null
    const after = typeof body.after === 'string' ? body.after : null
    return { before, after }
  } catch {
    return null
  }
}

/** The arguments of `/changes`. */
export function parseArgs(args: string): 'open' | 'clear' | 'off' | 'on' | 'unknown' {
  const word = args.trim().toLowerCase()
  if (word === '') return 'open'
  if (word === 'clear' || word === 'off' || word === 'on') return word
  return 'unknown'
}

/** The index keeps this many entries. */
export const MAX_ENTRIES = 1000
/** A session's saved bodies are kept under this many characters in all. */
export const MAX_SESSION_BYTES = 200_000_000

/**
 * The index after `entry` joins it: the last `cap` entries, and, while their
 * saved bodies pass `maxBytes`, the oldest bodies let go (`isDropped`). The
 * newest is always kept. `drop` names the body files nothing points at any more.
 */
export function admit(
  entries: readonly ChangeDeckEntry[],
  entry: ChangeDeckEntry,
  cap = MAX_ENTRIES,
  maxBytes = MAX_SESSION_BYTES,
): { entries: ChangeDeckEntry[]; drop: string[] } {
  const all = [...entries, entry]
  const cut = Math.max(0, all.length - cap)
  const drop = all
    .slice(0, cut)
    .map(one => one.file)
    .filter(file => file !== '')
  const kept = all.slice(cut)
  let total = kept.reduce((sum, one) => sum + (one.file !== '' ? (one.bytes ?? 0) : 0), 0)
  for (let i = 0; i < kept.length - 1 && total > maxBytes; i++) {
    const one = kept[i]!
    if (one.file === '') continue
    total -= one.bytes ?? 0
    drop.push(one.file)
    kept[i] = { ...one, file: '', isDropped: true }
  }
  return { entries: kept, drop }
}

/** A Project listing older than this is taken as finished: its press was lost (a reload). */
export const LOAD_STALE_MS = 60_000

/** Whether the Project listing is running now. */
export function isLoadingNow(project: ChangeDeckProject, now: number): boolean {
  const since: unknown = project.loadingSince
  return typeof since === 'number' && now - since < LOAD_STALE_MS
}

/** Whether entry `id` waits for its second Revert press now (a lost timer leaves `armed` past its time). */
export function isArmedNow(view: ChangeDeckView, id: string, now: number): boolean {
  return view.armed !== null && view.armed.id === id && now <= view.armed.until
}

/** The message to show now: none once an armed revert's window has passed. */
export function messageNow(view: ChangeDeckView, now: number): ChangeDeckView['message'] {
  return view.armed !== null && now > view.armed.until ? null : view.message
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_INDEX: ReadonlyMap<string, number> = new Map(Array.from(BASE64, (ch, i) => [ch, i] as const))

/** The bytes of standard base64 text (padding and other characters skipped). */
export function base64Bytes(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3)
  let value = 0
  let bits = 0
  let at = 0
  for (const ch of text) {
    const digit = BASE64_INDEX.get(ch)
    if (digit === undefined) continue
    value = ((value << 6) | digit) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (value >> bits) & 0xff
    }
  }
  return out.subarray(0, at)
}

/** Whether `bytes` are well-formed UTF-8, so text read from them is exact. */
export function isUtf8(bytes: Uint8Array): boolean {
  let i = 0
  while (i < bytes.length) {
    const lead = bytes[i]!
    if (lead < 0x80) {
      i++
      continue
    }
    const need = lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : 0
    if (need === 0) return false
    let point = lead & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07)
    for (let k = 1; k <= need; k++) {
      const next = bytes[i + k]
      if (next === undefined || (next & 0xc0) !== 0x80) return false
      point = (point << 6) | (next & 0x3f)
    }
    const least = need === 1 ? 0x80 : need === 2 ? 0x800 : 0x10000
    if (point < least || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return false
    i += need + 1
  }
  return true
}

/** Breaks text into lines of at most `width` cells at spaces; a word too long is cut. */
export function wrapWords(text: string, width: number, maxLines = 4): string[] {
  const room = Math.max(1, Math.floor(width))
  const out: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(one => one !== '')) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (Array.from(candidate).length <= room) {
      current = candidate
      continue
    }
    if (current !== '') out.push(current)
    current =
      Array.from(word).length <= room
        ? word
        : word.includes('/')
          ? fitPath(word, room)
          : Array.from(word).slice(0, Math.max(1, room - 1)).join('') + '…'
  }
  if (current !== '') out.push(current)
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines)
    const last = Array.from(kept[maxLines - 1]!)
    kept[maxLines - 1] = (last.length >= room ? last.slice(0, room - 1).join('') : last.join('')) + '…'
    return kept
  }
  return out
}
