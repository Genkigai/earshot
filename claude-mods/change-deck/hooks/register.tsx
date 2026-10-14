// change-deck: records every file edit Claude makes (before and after), and
// the /changes pane steps through them file by file, with a safe one-edit undo.
//
// Every `$` call lives in this file: the engine follows `$` only into
// functions declared here. Drawing is in ./view, pure logic in ./logic.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChangeDeckBody, ChangeDeckEntry, ChangeDeckMessage, ChangeDeckProject } from '../types'
import {
  ARM_MS,
  EMPTY_VIEW,
  MAX_BYTES,
  SKIPPED_DIRS,
  absoluteFrom,
  admit,
  askText,
  base64Bytes,
  cleanText,
  cursorIndex,
  diffTexts,
  isBodyPath,
  isLoadingNow,
  isStaleFolder,
  isUtf8,
  move,
  normalizePath,
  parseArgs,
  parseBody,
  parseFileList,
  relativeTo,
  revertStep,
  revertWords,
  safeSegment,
  sessionFolder,
  summary,
  toggleFilter,
  toggleFolder,
  visible,
} from './logic'
import type { PaneHandlers } from './view'
import { drawFailure, drawPane } from './view'

type Engine = EngineInterface

const PANE = 'change-deck'

// The values the pane draws from, held by the host for the session.
const entriesAtom = atom({ plugin: 'change-deck', key: 'entries' } as const, [] as ChangeDeckEntry[])
const viewAtom = atom({ plugin: 'change-deck', key: 'view' } as const, EMPTY_VIEW)
const isOnAtom = atom({ plugin: 'change-deck', key: 'isOn' } as const, true)
const seqAtom = atom({ plugin: 'change-deck', key: 'seq' } as const, 0)
const NO_PROJECT: ChangeDeckProject = { paths: [], source: 'none', isCapped: false, loadingSince: null }
const projectAtom = atom({ plugin: 'change-deck', key: 'project' } as const, NO_PROJECT)

const FAILED = 'The changes command failed. Nothing was changed.'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'changes',
        description: 'Step through every edit Claude made this session, and undo one safely',
        argumentHint: '[clear|off|on]',
      })
    } catch {
      // Recording still works; the command shows up after a reload.
    }
    await loadRecording($)
    void removeOldFolders($)
    return next(e)
  })

  // Every file edit, before and after. Fails open: a problem here never
  // stops the edit, it only leaves that edit out of the record.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const rawPath = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    // `_host` (an attached machine) is in this build's tool table only while one is attached.
    const host: unknown = e.tool === 'NotebookEdit' || !('_host' in e) ? undefined : e._host
    if (typeof rawPath !== 'string' || rawPath === '' || (typeof host === 'string' && host !== '')) return next(e)
    if (!(await read($, isOnAtom))) return next(e)
    const path = absoluteFrom(rawPath, await $.session.cwd())
    const before = await readText($, path)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    try {
      const after = await readText($, path)
      if (isUnreadable(before) || isUnreadable(after) || !after.exists) return ran
      const isTooLarge = before.isTooLarge || after.isTooLarge
      if (!isTooLarge && before.text === after.text) return ran
      const label = e.agentId !== undefined ? await agentLabel($, e.agentId) : undefined
      await recordEdit($, {
        tool: String(e.tool),
        path,
        before: before.text,
        after: after.text,
        isNew: !before.exists,
        isTooLarge,
        isLossy: !before.isExact || !after.isExact,
        ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
        ...(label !== undefined ? { agentLabel: label } : {}),
      })
    } catch {
      // Not recorded; the edit itself went through.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'changes' }, async ($, e) => {
    try {
      const action = parseArgs(e.args)
      if (action === 'open') {
        void (async () => {
          try {
            const opened = await $.ui.open({ id: PANE, title: 'Changes' })
            if (!opened.isPlaced) {
              const entries = await read($, entriesAtom)
              $.ui.toast(`The changes pane is waiting for room: ${opened.reason}. So far ${summary(entries)}.`)
            }
          } catch {
            $.ui.toast('The changes pane could not open.')
          }
        })()
        return { text: 'Opening the changes pane.' }
      }
      if (action === 'clear') {
        await clearRecord($)
        return { text: 'Cleared the change record for this session.' }
      }
      if (action === 'off') {
        await setRecording($, false)
        return { text: 'Stopped recording edits. /changes on starts again.' }
      }
      if (action === 'on') {
        await setRecording($, true)
        return { text: 'Recording edits again.' }
      }
      return { text: 'Use /changes to open the pane, or /changes clear, /changes off or /changes on.' }
    } catch {
      return { text: FAILED }
    }
  }).catch(() => ({ text: FAILED }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const rows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30
    const handlers: PaneHandlers = {
      move: action => pressMove($, action),
      revert: id => pressRevert($, id),
      ask: id => pressAsk($, id),
      close: () => $.ui.close({ id: PANE }),
      mode: mode => pressMode($, mode),
      file: path => update($, viewAtom, view => toggleFilter(view, path)),
      folder: path => update($, viewAtom, view => toggleFolder(view, path)),
      showAll: () => update($, viewAtom, view => ({ ...view, showAll: !view.showAll })),
      treeAll: () => update($, viewAtom, view => ({ ...view, treeAll: !view.treeAll })),
    }
    try {
      const entries = await read($, entriesAtom)
      const view = await read($, viewAtom)
      const list = visible(entries, view.filter)
      const shown = list[cursorIndex(list, view.cursor)]
      return drawPane(kit, handlers, {
        columns,
        rows,
        entries,
        view,
        isOn: await read($, isOnAtom),
        project: await read($, projectAtom),
        now: await $.clock.now(),
        body: shown === undefined ? null : await readBody($, shown),
      })
    } catch {
      return drawFailure(kit, handlers, columns)
    }
  })
}

// ── Reading and keeping files ────────────────────────────────────────────────

/**
 * A file's text as it stands: missing, too large to keep, or its text.
 * `isExact` is false when the text was decoded from bytes that are not UTF-8
 * (U+FFFD stands for them), so writing it back would not restore the file.
 */
type FileText = { exists: boolean; isTooLarge: boolean; text: string | null; isExact: boolean }

/** Present but neither read nor too large: an edit around it can't be shown. */
function isUnreadable(side: FileText): boolean {
  return side.exists && !side.isTooLarge && side.text === null
}

/** Reads a file's text; never throws. Over 1 MB is "too large", not read. */
async function readText($: Engine, path: string): Promise<FileText> {
  let size = 0
  try {
    const stat = await $.fs.stat(path)
    if (stat.kind === 'dir') return { exists: false, isTooLarge: false, text: null, isExact: true }
    size = stat.size
  } catch {
    return { exists: false, isTooLarge: false, text: null, isExact: true }
  }
  if (size > MAX_BYTES) return { exists: true, isTooLarge: true, text: null, isExact: true }
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    return { exists: true, isTooLarge: false, text: null, isExact: true }
  }
  // The text read is UTF-8 decoded, a bad byte becoming U+FFFD: only then are the bytes checked.
  if (!text.includes('\uFFFD')) return { exists: true, isTooLarge: false, text, isExact: true }
  let isExact = false
  try {
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    isExact = isUtf8(base64Bytes(base64))
  } catch {
    isExact = false
  }
  return { exists: true, isTooLarge: false, text, isExact }
}

/** The person's home folder, or undefined where none is set. */
async function homeDir($: Engine): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  if (home !== undefined && home !== '') return home
  const profile = await $.env.get('USERPROFILE')
  return profile !== undefined && profile !== '' ? profile : undefined
}

/** This session's data folder, or undefined without a home folder. */
async function currentFolder($: Engine): Promise<string | undefined> {
  const home = await homeDir($)
  if (home === undefined) return undefined
  return sessionFolder(home, await $.session.id())
}

/**
 * A helper's label for an agent id: its task description, else its name;
 * undefined for one the list does not name (a workflow's agents, a finished one).
 */
async function agentLabel($: Engine, agentId: string): Promise<string | undefined> {
  try {
    const agents = await $.agent.list()
    const found = agents.find(agent => agent.id === agentId)
    if (found !== undefined) {
      const label = cleanText((found.description.trim() || found.name || '').trim())
      if (label !== '') return label
    }
  } catch {
    // An agent the list no longer names: still a helper, unnamed.
  }
  return undefined
}

type EditRecord = {
  tool: string
  path: string
  before: string | null
  after: string | null
  isNew: boolean
  isTooLarge: boolean
  isLossy: boolean
  agentId?: string
  agentLabel?: string
}

/** Keeps one edit: its texts in a file of their own, a light row in the index. */
async function recordEdit($: Engine, edit: EditRecord): Promise<ChangeDeckEntry> {
  // Drawn as text, so no control characters; `path` stays as it is for the file system.
  const relPath = cleanText(relativeTo(edit.path, await $.session.root()))
  const at = await $.clock.now()
  let turn = 0
  try {
    turn = await $.session.turns()
  } catch {
    turn = 0
  }
  const seq = await update($, seqAtom, n => n + 1)
  const id = String(seq)
  const diff = edit.isTooLarge ? { added: 0, removed: 0 } : diffTexts(edit.before, edit.after)
  const body: ChangeDeckBody = {
    id,
    seq,
    at,
    tool: edit.tool,
    path: edit.path,
    relPath,
    before: edit.isTooLarge ? null : edit.before,
    after: edit.isTooLarge ? null : edit.after,
    turn,
    isTooLarge: edit.isTooLarge,
    ...(edit.agentId !== undefined ? { agentId: edit.agentId } : {}),
    ...(edit.agentLabel !== undefined ? { agentLabel: edit.agentLabel } : {}),
  }
  let file = ''
  let bytes = 0
  try {
    const folder = await currentFolder($)
    if (folder !== undefined) {
      const text = JSON.stringify(body)
      file = `${folder}/${seq}.json`
      bytes = text.length
      await $.fs.write(file, text)
    }
  } catch {
    file = ''
    bytes = 0
  }
  const entry: ChangeDeckEntry = {
    id,
    seq,
    at,
    tool: edit.tool,
    path: edit.path,
    relPath,
    added: diff.added,
    removed: diff.removed,
    isNew: edit.isNew,
    isTooLarge: edit.isTooLarge,
    turn,
    file,
    ...(file !== '' ? { bytes } : {}),
    ...(edit.isLossy ? { isLossy: true } : {}),
    ...(edit.agentId !== undefined ? { agentId: edit.agentId } : {}),
    ...(edit.agentLabel !== undefined ? { agentLabel: edit.agentLabel } : {}),
  }
  let drop: string[] = []
  await update($, entriesAtom, list => {
    const next = admit(list, entry)
    drop = next.drop
    return next.entries
  })
  // Bodies past the index's cap or the session's size cap: removed in the background.
  if (drop.length > 0) void removeBodies($, drop)
  return entry
}

/** An entry's kept texts; null when the file is gone or unreadable. */
async function readBody($: Engine, entry: ChangeDeckEntry): Promise<{ before: string | null; after: string | null } | null> {
  if (entry.file === '' || entry.isTooLarge) return null
  try {
    return parseBody(await $.fs.read(entry.file))
  } catch {
    return null
  }
}

/** Empties a saved body in place: where there is no `rm`, that still frees its space. Never throws. */
async function emptyBody($: Engine, file: string): Promise<void> {
  try {
    await $.fs.write(file, '')
  } catch {
    // Gone already, or unwritable: leave it.
  }
}

/** Removes saved bodies by name (only this mod's), with `rm`, else by emptying each. Never throws. */
async function removeBodies($: Engine, files: readonly string[]): Promise<void> {
  const safe = files.map(normalizePath).filter(isBodyPath)
  for (let i = 0; i < safe.length; i += 200) {
    const chunk = safe.slice(i, i + 200)
    try {
      const run = await $.process.run(['rm', '-f', '--', ...chunk], { timeoutMs: 20_000 })
      if (run.exitCode === 0) continue
    } catch {
      // No `rm` here (Windows): empty them instead.
    }
    for (const file of chunk) await emptyBody($, file)
  }
}

/** Removes a session folder under the data root with `rm`, else empties its bodies. Never throws. */
async function removeFolder($: Engine, folder: string): Promise<void> {
  const clean = normalizePath(folder)
  if (!/\/\.claude\/mod-data\/change-deck\/[A-Za-z0-9_-]+$/.test(clean)) return
  try {
    const run = await $.process.run(['rm', '-rf', '--', clean], { timeoutMs: 20_000 })
    if (run.exitCode === 0) return
  } catch {
    // No `rm` here (Windows): empty what it holds instead.
  }
  try {
    for (const item of await $.fs.list(clean)) {
      const file = `${clean}/${item.name}`
      if (item.kind === 'file' && item.size > 0 && isBodyPath(file)) await emptyBody($, file)
    }
  } catch {
    // Unlistable: it stays until removed by hand.
  }
}

/** Removes this mod's session folders older than seven days. Never throws. */
async function removeOldFolders($: Engine): Promise<void> {
  try {
    const home = await homeDir($)
    if (home === undefined) return
    const base = `${normalizePath(home)}/.claude/mod-data/change-deck`
    const current = safeSegment(await $.session.id())
    const listed = await $.fs.list(base)
    const now = await $.clock.now()
    for (const item of listed) {
      if (item.kind !== 'dir') continue
      const folder = `${base}/${item.name}`
      try {
        const stat = await $.fs.stat(folder)
        if (isStaleFolder(item.name, stat.mtimeMs, now, current)) await removeFolder($, folder)
      } catch {
        // Gone already, or unreadable: leave it.
      }
    }
  } catch {
    // No data folder yet.
  }
}

/**
 * Forgets this session's record: the index, the place in it, and the saved
 * bodies it named. Only those files go, so an edit landing meanwhile keeps its
 * own (sequence numbers never repeat).
 */
async function clearRecord($: Engine): Promise<void> {
  let files: string[] = []
  await update($, entriesAtom, list => {
    files = list.map(one => one.file).filter(file => file !== '')
    return []
  })
  await update($, viewAtom, view => ({ ...view, cursor: null, filter: null, showAll: false, armed: null, message: null }))
  // In the background, so the command answers at once.
  if (files.length > 0) void removeBodies($, files)
}

/** Turns recording on or off, kept across sessions. */
async function setRecording($: Engine, isOn: boolean): Promise<void> {
  await update($, isOnAtom, () => isOn)
  try {
    await $.store.set('isOn', isOn)
  } catch {
    // The switch still holds for this session.
  }
}

/** Reads the kept switch into the session's state. */
async function loadRecording($: Engine): Promise<void> {
  try {
    const stored = await $.store.get('isOn')
    await update($, isOnAtom, () => stored !== false)
  } catch {
    // Keep recording on.
  }
}

/** The project's files: `git ls-files` (cap 3,000), else a walk (cap 2,000 entries). */
async function listProject($: Engine, root: string): Promise<Omit<ChangeDeckProject, 'loadingSince'>> {
  try {
    // -z: names NUL-separated and never quoted, so non-ASCII names match the recorded ones.
    const run = await $.process.run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      timeoutMs: 15_000,
    })
    if (run.exitCode === 0) {
      const { paths, isCapped } = parseFileList(run.stdout, 3000)
      return { paths, source: 'git', isCapped: isCapped || run.isStdoutTruncated }
    }
  } catch {
    // Not a git repository, or no git: walk the folders instead.
  }
  const paths: string[] = []
  const queue: string[] = ['']
  const base = normalizePath(root)
  let seen = 0
  let isCapped = false
  while (queue.length > 0 && !isCapped) {
    const rel = queue.shift()!
    let listed
    try {
      listed = await $.fs.list(rel === '' ? base : `${base}/${rel}`)
    } catch {
      continue
    }
    const sorted = [...listed].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const item of sorted) {
      if (seen >= 2000) {
        isCapped = true
        break
      }
      const path = rel === '' ? item.name : `${rel}/${item.name}`
      if (item.kind === 'dir') {
        if (SKIPPED_DIRS.has(item.name)) continue
        seen++
        queue.push(path)
      } else if (item.kind === 'file') {
        seen++
        paths.push(cleanText(path))
      }
    }
  }
  return { paths, source: 'list', isCapped }
}

// ── What the pane's buttons do ───────────────────────────────────────────────
// Each runs from a press, reads what it needs at that moment, and writes state.

async function say($: Engine, message: ChangeDeckMessage, isDisarmed = true): Promise<void> {
  await update($, viewAtom, view => ({ ...view, message, ...(isDisarmed ? { armed: null } : {}) }))
}

/** ‹ Prev, Next ›, Latest. */
async function pressMove($: Engine, action: 'prev' | 'next' | 'latest'): Promise<void> {
  const entries = await read($, entriesAtom)
  await update($, viewAtom, view => ({
    ...view,
    cursor: move(entries, view.filter, view.cursor, action),
    showAll: false,
    armed: null,
    message: null,
  }))
}

/** Revert this edit: checked at press time, armed, then `before` written back. */
async function pressRevert($: Engine, id: string): Promise<void> {
  try {
    const entries = await read($, entriesAtom)
    const entry = entries.find(one => one.id === id)
    if (entry === undefined) return
    const number = entries.indexOf(entry) + 1
    const view = await read($, viewAtom)
    const now = await $.clock.now()
    const body = await readBody($, entry)
    const current = await readText($, entry.path)
    const step = revertStep({
      id,
      isTooLarge: entry.isTooLarge,
      hasBody: body !== null,
      isLossy: entry.isLossy === true || !current.isExact,
      before: body?.before ?? null,
      after: body?.after ?? null,
      current: current.isTooLarge ? '\u0000over 1 MB\u0000' : current.text,
      armed: view.armed,
      now,
    })
    const words = revertWords(step.kind, entry.relPath, number)
    if (step.kind === 'arm') {
      const until = now + ARM_MS
      const message: ChangeDeckMessage = { text: words, tone: 'warn' }
      await update($, viewAtom, held => ({ ...held, armed: { id, until }, message }))
      $.clock.after(ARM_MS + 50, () => {
        void update($, viewAtom, held =>
          held.armed !== null && held.armed.id === id && held.armed.until === until
            ? { ...held, armed: null, message: null }
            : held,
        )
      })
      return
    }
    if (step.kind !== 'confirm' || body === null || body.before === null) {
      await say($, { text: words, tone: 'warn' })
      return
    }
    try {
      await $.fs.write(entry.path, body.before)
    } catch {
      await say($, { text: `Couldn't write ${entry.relPath}, so nothing was reverted.`, tone: 'warn' })
      return
    }
    await recordEdit($, {
      tool: 'Revert',
      path: entry.path,
      before: current.text,
      after: body.before,
      isNew: false,
      isTooLarge: false,
      isLossy: false,
      agentLabel: 'you',
    })
    await say($, { text: words, tone: 'good' })
  } catch {
    await say($, { text: 'The revert could not finish. Check the file before trying again.', tone: 'warn' })
  }
}

/** Ask Claude about this: the edit's diff into the prompt box, then close the pane. */
async function pressAsk($: Engine, id: string): Promise<void> {
  try {
    const entries = await read($, entriesAtom)
    const entry = entries.find(one => one.id === id)
    if (entry === undefined) return
    const number = entries.indexOf(entry) + 1
    const body = await readBody($, entry)
    const hunks = body === null ? null : diffTexts(body.before, body.after).hunks
    const text = askText(entry.relPath, number, entries.length, hunks, entry.isTooLarge)
    const box = await $.prompt.read()
    const filled =
      box.text.trim() === ''
        ? await $.prompt.fill({ text, mode: 'replace' })
        : await $.prompt.fill({ text: `\n\n${text}`, mode: 'append' })
    if (filled.isFilled) {
      await update($, viewAtom, held => ({ ...held, armed: null, message: null }))
      await $.ui.close({ id: PANE })
      return
    }
    await say($, { text: "Couldn't put the question in the prompt box. Close any open dialog and try again.", tone: 'warn' })
  } catch {
    await say($, { text: "Couldn't put the question in the prompt box.", tone: 'warn' })
  }
}

/**
 * The Touched and Project chips. Project reads the file list each time it is
 * chosen; a listing a reload cut off (its start long past) does not block it.
 */
async function pressMode($: Engine, mode: 'touched' | 'project'): Promise<void> {
  const view = await read($, viewAtom)
  if (view.mode === mode) return
  await update($, viewAtom, held => ({ ...held, mode, treeAll: false }))
  if (mode !== 'project') return
  const now = await $.clock.now()
  if (isLoadingNow(await read($, projectAtom), now)) return
  await update($, projectAtom, held => ({ ...held, loadingSince: now }))
  try {
    const listed = await listProject($, await $.session.root())
    await update($, projectAtom, () => ({ ...listed, loadingSince: null }))
  } catch {
    await update($, projectAtom, held => ({ ...held, loadingSince: null }))
  }
}
