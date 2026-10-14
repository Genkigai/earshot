// safety-net: Mod Check. Clones or reads a mod, runs the validator, scans its files, and asks
// one fast model call for a plain verdict; the scan alone decides when the model can't answer.

import type { ModCheckView } from '../types'
import type { Io } from './io'
import {
  baseName,
  closerRows,
  dirName,
  filePriority,
  finalVerdict,
  groupCaps,
  isInside,
  modelPrompt,
  nonEmptyLines,
  normalizePath,
  parseModelReply,
  partialReason,
  relativeImports,
  reportText,
  rulesVerdict,
  scanFile,
} from './logic'
import type { Finding, ModTarget } from './logic'

export const READ_BUDGET = 300 * 1024
/** A module hooks.json names, or a file it imports, is read past the budget, up to this much each... */
const MODULE_CAP = 1024 * 1024
/** ...and up to this much and this many files in all. */
const MODULES_TOTAL = 4 * 1024 * 1024
const MODULES_MAX = 300
const IMPORT_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.d.ts']
/** Files of this rank or better can run or steer Claude: one left unread makes the scan partial. */
const MATTERS_RANK = 5
const SAMPLE_BUDGET = 24 * 1024
const MAX_FILES = 1500
const MAX_DIRS = 400

export function blankCheck(): ModCheckView {
  return {
    status: 'idle',
    name: '',
    version: '',
    source: '',
    step: '',
    verdict: null,
    verdictBy: 'rules',
    explanation: '',
    reasons: [],
    can: [],
    closer: [],
    validator: [],
    validatorOk: true,
    error: '',
    filesRead: 0,
    unread: [],
    report: '',
  }
}

type Patch = (change: Partial<ModCheckView>) => Promise<void>

async function clone(io: Io, url: string, slug: string, home: string): Promise<{ dir: string } | { error: string }> {
  const root = `${home}/.claude/mod-data/safety-net/modcheck`
  const dir = `${root}/${slug}`
  await io.run(['mkdir', '-p', root], { timeoutMs: 10_000 })
  const rootReal = (await io.stat(root))?.realPath ?? root
  if (await io.exists(dir)) {
    const real = (await io.stat(dir))?.realPath
    if (real === undefined || !isInside(real, rootReal)) return { error: `The old copy at ${dir} is not inside safety-net's folder, so it was left alone.` }
    await io.run(['rm', '-rf', real], { timeoutMs: 60_000 })
  }
  const out = await io.run(['git', 'clone', '--depth', '1', '--', url, dir], {
    timeoutMs: 120_000,
    env: { GIT_TERMINAL_PROMPT: '0' },
  })
  if (out === null) return { error: `Could not clone ${url}: git did not start or did not finish in time.` }
  if (out.exitCode !== 0) {
    const why = nonEmptyLines(out.stderr).find(l => /fatal|error/i.test(l)) ?? nonEmptyLines(out.stderr)[0] ?? 'git clone failed'
    return { error: `Could not clone ${url}: ${why.replace(/^fatal:\s*/i, '')}` }
  }
  return { dir }
}

async function walk(io: Io, root: string): Promise<{ files: { rel: string; size: number }[]; isCut: boolean }> {
  const files: { rel: string; size: number }[] = []
  const queue: string[] = ['']
  let dirs = 0
  let isDeep = false
  while (queue.length > 0 && dirs < MAX_DIRS && files.length < MAX_FILES) {
    const rel = queue.shift() ?? ''
    dirs++
    const entries = (await io.list(rel === '' ? root : `${root}/${rel}`)) ?? []
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.kind === 'dir') {
        if (e.name === 'node_modules' || e.name === '.git') continue
        if (child.split('/').length <= 10) queue.push(child)
        else isDeep = true
      } else if (e.kind === 'file') {
        files.push({ rel: child, size: e.size })
      }
    }
  }
  return { files, isCut: isDeep || queue.length > 0 }
}

/** `spec` against the folder of `from`, inside the mod's folder; null when it leaves the folder. */
function within(from: string, spec: string): string | null {
  const base = dirName(from)
  const joined = normalizePath(base === '.' ? spec : `${base}/${spec}`)
  return joined.startsWith('/') || joined === '..' || joined.startsWith('../') ? null : joined
}

/** The modules a hooks.json names, as paths relative to the mod's folder; null for one outside it. */
function namedModules(rel: string, text: string): (string | null)[] {
  try {
    const parsed = JSON.parse(text) as { modules?: unknown }
    if (!Array.isArray(parsed.modules)) return []
    return parsed.modules.filter((m): m is string => typeof m === 'string').map(m => within(rel, m))
  } catch {
    return []
  }
}

type ReadOut = { files: { rel: string; text: string }[]; unread: string[] }

/**
 * Reads what matters first: every hooks.json, then every module they name and every file those
 * import, relatively (in full, past the budget, wherever it sits in the folder), then the rest
 * by rank up to 300 KB in all. `unread` lists each file that could run or steer Claude and was
 * not read in full.
 */
async function readFiles(io: Io, root: string, files: readonly { rel: string; size: number }[]): Promise<ReadOut> {
  const out: { rel: string; text: string }[] = []
  const unread: string[] = []
  const done = new Set<string>()
  const read = async (rel: string, cap: number): Promise<{ text: string; isCut: boolean } | null> => {
    const text = await io.read(`${root}/${rel}`)
    if (text === null || text.includes('\u0000')) return null
    return text.length > cap ? { text: text.slice(0, cap), isCut: true } : { text, isCut: false }
  }
  let budget = READ_BUDGET
  const hooksFiles = files.filter(f => baseName(f.rel).toLowerCase() === 'hooks.json').sort((a, b) => a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : 1))
  const modules: string[] = []
  for (const f of hooksFiles) {
    done.add(f.rel)
    const got = await read(f.rel, 64 * 1024)
    if (got === null || got.isCut) unread.push(f.rel)
    if (got === null) continue
    budget -= got.text.length
    out.push({ rel: f.rel, text: got.text })
    for (const m of namedModules(f.rel, got.text)) {
      if (m === null) unread.push(`${f.rel} names a module outside the folder`)
      else if (!modules.includes(m)) modules.push(m)
    }
  }
  const known = new Set(files.map(f => f.rel))
  let moduleBytes = 0
  let moduleCount = 0
  for (let k = 0; k < modules.length; k++) {
    const rel = modules[k]!
    if (done.has(rel)) continue
    done.add(rel)
    if (moduleCount >= MODULES_MAX || moduleBytes >= MODULES_TOTAL) {
      unread.push(rel)
      continue
    }
    const got = await read(rel, MODULE_CAP)
    if (got === null || got.isCut) unread.push(rel)
    if (got === null) continue
    moduleCount++
    moduleBytes += got.text.length
    budget -= got.text.length
    out.push({ rel, text: got.text })
    for (const spec of relativeImports(got.text)) {
      const target = within(rel, spec)
      if (target === null) continue // the engine loads no file from outside the mod's folder
      // a file the walk listed, else one it skipped (node_modules, too deep) that reads; an import
      // of nothing (a comment, a typo) can load nothing, so it is passed over
      let found = IMPORT_EXTS.map(ext => target + ext).find(c => known.has(c))
      for (const ext of found === undefined ? IMPORT_EXTS : []) {
        if ((await io.read(`${root}/${target}${ext}`)) !== null) {
          found = target + ext
          break
        }
      }
      if (found !== undefined && !modules.includes(found)) modules.push(found)
    }
  }
  const pending = files.filter(f => !done.has(f.rel) && filePriority(f.rel) !== null)
  pending.sort((a, b) => (filePriority(a.rel) ?? 99) - (filePriority(b.rel) ?? 99) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const file of pending) {
    const rank = filePriority(file.rel) ?? 99
    const matters = rank <= MATTERS_RANK
    if (budget <= 0 || (file.size > 200 * 1024 && rank > 3)) {
      if (matters) unread.push(file.rel)
      continue
    }
    const got = await read(file.rel, budget)
    if (got === null) {
      if (matters) unread.push(file.rel)
      continue
    }
    if (matters && got.isCut) unread.push(file.rel)
    budget -= got.text.length
    out.push({ rel: file.rel, text: got.text })
  }
  return { files: out, unread }
}

function nameAndVersion(files: readonly { rel: string; text: string }[], fallback: string): { name: string; version: string } {
  const manifests = files.filter(f => f.rel.toLowerCase().endsWith('plugin.json')).sort((a, b) => a.rel.length - b.rel.length)
  for (const m of manifests) {
    try {
      const raw = JSON.parse(m.text) as { name?: unknown; version?: unknown }
      if (typeof raw.name === 'string' && raw.name !== '') return { name: raw.name, version: typeof raw.version === 'string' ? raw.version : '' }
    } catch {
      continue
    }
  }
  return { name: fallback, version: '' }
}

function sampleOf(files: readonly { rel: string; text: string }[]): string {
  let left = SAMPLE_BUDGET
  const parts: string[] = []
  for (const f of files) {
    if (left <= 0) break
    const body = f.text.slice(0, Math.min(6 * 1024, left))
    parts.push(`=== ${f.rel} ===\n${body}`)
    left -= body.length
  }
  return parts.join('\n\n')
}

/** Runs one whole check, reporting each step through `patch`. */
export async function runModCheck(io: Io, target: ModTarget, home: string | null, patch: Patch): Promise<ModCheckView> {
  const source = target.kind === 'git' ? target.url : target.path
  const start: ModCheckView = { ...blankCheck(), status: 'working', name: target.name, source, step: target.kind === 'git' ? 'Cloning a shallow copy…' : 'Reading the folder…' }
  await patch(start)
  let dir: string
  if (target.kind === 'git') {
    if (home === null) {
      const failed = { ...start, status: 'failed' as const, error: 'HOME is not set, so there is nowhere to keep the copy.' }
      await patch(failed)
      return failed
    }
    const cloned = await clone(io, target.url, target.slug, home)
    if ('error' in cloned) {
      const failed = { ...start, status: 'failed' as const, error: cloned.error }
      await patch(failed)
      return failed
    }
    dir = cloned.dir
  } else {
    const st = await io.stat(target.path)
    if (st === null || st.kind !== 'dir') {
      const failed = { ...start, status: 'failed' as const, error: `There is no folder at ${target.path}.` }
      await patch(failed)
      return failed
    }
    dir = target.path
  }

  await patch({ step: 'Running claude plugin validate…' })
  let validatorText = ''
  let validatorOk = false
  const checked = await io.run(['claude', 'plugin', 'validate', dir], { timeoutMs: 90_000 })
  if (checked === null) {
    validatorText = 'The validator did not run (claude was not found or took too long).'
  } else {
    validatorText = `${checked.stdout}\n${checked.stderr}`.trim()
    validatorOk = checked.exitCode === 0
  }
  const validator = nonEmptyLines(validatorText).slice(0, 8)

  await patch({ step: 'Reading the files…', validator, validatorOk })
  const walked = await walk(io, dir)
  const { files, unread } = await readFiles(io, dir, walked.files)
  const { name, version } = nameAndVersion(files, target.name)
  const findings: Finding[] = files.flatMap(f => scanFile(f.rel, f.text))
  const rules = rulesVerdict(findings)
  const partial = partialReason(unread, walked.isCut)

  await patch({ step: `Scanned ${files.length} files. Asking the model for a plain verdict…`, name, version, filesRead: files.length })
  const reply = await io.complete({
    model: 'haiku',
    system: 'You review Claude Code mods for safety and answer with JSON only.',
    prompt: modelPrompt(name, validatorText, findings, sampleOf(files)),
    maxTokens: 900,
    timeoutMs: 60_000,
  })
  const answer = reply !== null && reply.isAnswered ? parseModelReply(reply.text) : null
  const final = finalVerdict(answer, rules, findings, partial)
  const can = groupCaps(findings).map(c => ({ cap: c.cap, label: c.label, count: c.count, sample: c.sample }))
  const closer = closerRows(findings, 40)
  const done: ModCheckView = {
    ...start,
    status: 'done',
    name,
    version,
    step: '',
    verdict: final.verdict,
    verdictBy: final.by,
    explanation: final.explanation,
    reasons: final.reasons,
    can,
    closer,
    validator,
    validatorOk,
    filesRead: files.length,
    unread: walked.isCut ? [...unread, 'files past the walk limit'] : unread,
    report: '',
  }
  done.report = reportText(done)
  await patch(done)
  return done
}
