// safety-net: measuring what a command would destroy, with read-only dry runs through `$`.
// Each run is argv form (never a shell over the person's text), capped at 2 s, 4 s in all.

import type { FsStat, ProcessRunResult } from 'claude-code'

import type { Io } from './io'

import {
  baseName,
  cleanEntries,
  dirName,
  emptyImpact,
  isInside,
  isSameOrAncestor,
  joinPath,
  nonEmptyLines,
  porcelainChanges,
} from './logic'
import type { DeleteOp, GitOp, Impact, Op, OverwriteOp, PathRef } from './logic'

/** Where the session stands: what "inside the project" and "home" mean for this call. */
export type Env = {
  cwd: string
  root: string
  rootReal: string
  home: string | null
  homeReal: string | null
  binRoot: string | null
  binReal: string | null
  temps: string[]
}

const RUN_MS = 2000
/** The whole measuring budget of one Bash call: blast radius and the Bin's size checks share it. */
export const TOTAL_MS = 4000
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
const SYSTEM_DIRS = new Set(['/', '/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/var', '/opt', '/boot', '/dev', '/proc', '/sys', '/System', '/Library', '/Applications', '/private', '/Users', '/home', '/root'])

export type RawEnv = { cwd: string; root: string; home: string | undefined; tmpdir: string | undefined }

/** The session's cwd, root and home, each resolved to where it really lands. */
export async function loadEnv(io: Io, raw: RawEnv): Promise<Env> {
  const { cwd, root, tmpdir } = raw
  const homeRaw = raw.home
  const home = homeRaw === undefined || homeRaw === '' ? null : homeRaw.replace(/\/+$/, '') || '/'
  const binRoot = home === null ? null : `${home}/.claude/mod-data/safety-net/bin`
  const [rootStat, homeStat, binStat] = await Promise.all([
    io.stat(root),
    home === null ? Promise.resolve(null) : io.stat(home),
    binRoot === null ? Promise.resolve(null) : io.stat(binRoot),
  ])
  const candidates = ['/tmp', '/private/tmp', '/var/tmp', ...(tmpdir !== undefined && tmpdir !== '' ? [tmpdir.replace(/\/+$/, '')] : [])]
  const reals = await Promise.all(candidates.map(async c => (await io.stat(c))?.realPath ?? null))
  const temps = [...new Set(reals.filter((r): r is string => r !== null && r !== '/'))]
  return {
    cwd,
    root,
    rootReal: rootStat?.realPath ?? root,
    home,
    homeReal: home === null ? null : (homeStat?.realPath ?? home),
    binRoot,
    binReal: binRoot === null ? null : (binStat?.realPath ?? binRoot),
    temps,
  }
}

type Place = { isOutside: boolean; whole: string | null }

/** A root folder of the system (`/`, `/usr`, `/home`, ...). */
export function isSystemDir(real: string): boolean {
  return real === '/' || SYSTEM_DIRS.has(real)
}

/** Whether a real path is inside the project, in a temp folder, or a root it must never touch. */
export function placeOf(real: string, env: Env): Place {
  if (isSystemDir(real)) return { isOutside: true, whole: 'system' }
  if (env.homeReal !== null && isSameOrAncestor(real, env.homeReal)) return { isOutside: true, whole: 'home' }
  if (env.binReal !== null && isSameOrAncestor(real, env.binReal)) return { isOutside: true, whole: 'bin' }
  if (isSameOrAncestor(real, env.rootReal)) return { isOutside: false, whole: 'project' }
  if (env.temps.some(t => isSameOrAncestor(real, t))) return { isOutside: false, whole: 'temp' }
  if (isInside(real, env.rootReal)) return { isOutside: false, whole: null }
  if (env.temps.some(t => isInside(real, t))) return { isOutside: false, whole: null }
  return { isOutside: true, whole: null }
}

type Runner = (argv: readonly string[], cwd: string | null, env?: Record<string, string>) => Promise<ProcessRunResult | null>

function makeRunner(io: Io, deadline: number): Runner {
  return async (argv, cwd, env) => {
    const left = deadline - (await io.now())
    if (left < 150) return null
    return io.run(argv, {
      ...(cwd === null ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      timeoutMs: Math.max(100, Math.min(RUN_MS, Math.floor(left))),
    })
  }
}

function duBytes(out: ProcessRunResult | null): number | null {
  if (out === null || out.exitCode !== 0) return null
  const lines = nonEmptyLines(out.stdout)
  const last = lines[lines.length - 1] ?? ''
  const kb = Number.parseInt(last, 10)
  return Number.isFinite(kb) ? kb * 1024 : null
}

/** Drops listed entries that sit inside another listed entry, so sizes are not counted twice. */
function outermost(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort()
  const out: string[] = []
  for (const p of sorted) if (!out.some(o => isInside(p, o))) out.push(p)
  return out
}

async function locate(io: Io, ref: PathRef): Promise<{ st: FsStat; real: string; isLinkOnly: boolean } | null> {
  if (ref.abs === null) return null
  const st = await io.stat(ref.abs)
  if (st === null) return null
  const isLinkOnly = st.isLink && !ref.hasTrailingSlash
  if (isLinkOnly) {
    const parent = await io.stat(dirName(ref.abs))
    return { st, real: joinPath(parent?.realPath ?? dirName(ref.abs), baseName(ref.abs)), isLinkOnly }
  }
  return { st, real: st.realPath ?? ref.abs, isLinkOnly }
}

/** Unmeasurable paths: a variable in a recursive delete, or a glob reaching outside, still needs the person. */
async function expansionImpact(io: Io, op: DeleteOp, ref: PathRef, env: Env, impact: Impact): Promise<void> {
  const isCatchAll = /(^|\/)\.?\*\/?$/.test(ref.word)
  if (ref.why === 'cwd') {
    impact.unmeasured = impact.unmeasured ?? 'cwd'
    return
  }
  impact.unmeasured = impact.unmeasured ?? 'expansion'
  if (ref.isVariable && op.recursive) {
    impact.risky = impact.risky ?? ref.word
    return
  }
  if (ref.globBase === null && isCatchAll && op.recursive && !ref.word.startsWith('/')) {
    impact.risky = impact.risky ?? `${ref.word} in a folder it can't tell`
    return
  }
  if (ref.globBase !== null) {
    const real = (await io.stat(ref.globBase))?.realPath ?? ref.globBase
    const place = placeOf(real, env)
    if (place.isOutside) {
      if (place.whole !== null && isCatchAll && op.recursive) impact.whole = impact.whole ?? place.whole
      impact.outside.push(real)
      impact.targets.push(real)
    } else if (place.whole === 'project' && real === env.rootReal && isCatchAll && op.recursive) {
      impact.whole = impact.whole ?? 'project'
      impact.targets.push(real)
    }
  }
}

async function measureDelete(io: Io, op: DeleteOp, env: Env, run: Runner): Promise<Impact> {
  const impact = emptyImpact(op)
  if (op.tool === 'find' || op.tool === 'xargs') {
    for (const ref of op.paths) {
      if (ref.abs === null) {
        await expansionImpact(io, op, ref, env, impact)
        continue
      }
      const where = await locate(io, ref)
      if (where === null) continue
      const place = placeOf(where.real, env)
      impact.targets.push(where.real)
      if (where.st.kind === 'dir' && !where.isLinkOnly) impact.folders.push(where.real)
      if (place.isOutside) impact.outside.push(where.real)
    }
    if (op.listing === null) {
      impact.unmeasured = impact.unmeasured ?? (op.tool === 'xargs' ? 'input' : 'failed')
      impact.bytes = null
      return impact
    }
    const listed = await run(op.listing, op.cwd)
    if (listed === null || listed.exitCode !== 0) {
      impact.unmeasured = 'failed'
      impact.bytes = null
      return impact
    }
    const entries = nonEmptyLines(listed.stdout)
    impact.count = entries.length
    impact.isLowerBound = listed.isStdoutTruncated
    impact.examples = entries.slice(0, 8)
    if (entries.length > 0 && entries.length <= 200) {
      const du = await run(['du', '-skc', '--', ...outermost(entries)], op.cwd)
      impact.bytes = duBytes(du)
    } else {
      impact.bytes = entries.length === 0 ? 0 : null
    }
    return impact
  }
  let bytes = 0
  let isBytesKnown = true
  for (const ref of op.paths) {
    if (ref.abs === null) {
      await expansionImpact(io, op, ref, env, impact)
      continue
    }
    const where = await locate(io, ref)
    if (where === null) continue
    const place = placeOf(where.real, env)
    if (place.whole !== null) {
      impact.whole = impact.whole ?? place.whole
    }
    if (place.isOutside) impact.outside.push(where.real)
    impact.targets.push(where.real)
    if (where.isLinkOnly || where.st.kind !== 'dir') {
      const size = where.isLinkOnly ? 0 : where.st.size
      impact.count += 1
      bytes += size
      impact.perTarget.push({ real: where.real, bytes: size, files: 1 })
      if (impact.examples.length < 8) impact.examples.push(ref.word)
      continue
    }
    if (!op.recursive) continue
    impact.folders.push(where.real)
    const [du, found] = await Promise.all([run(['du', '-sk', '--', ref.abs], null), run(['find', ref.abs, '-type', 'f'], null)])
    const size = duBytes(du)
    if (size === null) isBytesKnown = false
    else bytes += size
    const files = found === null ? [] : nonEmptyLines(found.stdout)
    const isCounted = found !== null && found.exitCode === 0 && !found.isStdoutTruncated
    impact.perTarget.push({ real: where.real, bytes: size, files: isCounted ? files.length : null })
    if (found === null || (found.exitCode !== 0 && files.length === 0)) {
      impact.unmeasured = 'failed'
      continue
    }
    impact.count += files.length
    if (found.isStdoutTruncated || found.exitCode !== 0) impact.isLowerBound = true
    for (const f of files) {
      if (impact.examples.length >= 8) break
      impact.examples.push(f)
    }
  }
  impact.bytes = isBytesKnown ? bytes : null
  if (!isBytesKnown && impact.unmeasured === null) impact.unmeasured = 'failed'
  return impact
}

async function measureOverwrite(io: Io, op: OverwriteOp, env: Env): Promise<Impact> {
  const impact = emptyImpact(op)
  for (const ref of op.paths) {
    if (ref.abs === null) {
      impact.unmeasured = impact.unmeasured ?? (ref.why === 'cwd' ? 'cwd' : 'expansion')
      continue
    }
    const where = await locate(io, ref)
    if (where === null) continue
    const hits: { real: string; size: number; shown: string }[] = []
    if (where.st.kind === 'dir' && !where.isLinkOnly) {
      if (op.tool !== 'mv' && op.tool !== 'cp') continue
      for (const name of op.srcNames) {
        const inner = await io.stat(joinPath(ref.abs, name))
        if (inner !== null && inner.kind === 'file' && inner.size > 0) hits.push({ real: inner.realPath ?? joinPath(where.real, name), size: inner.size, shown: joinPath(ref.word, name) })
      }
    } else if (where.st.kind === 'file' && where.st.size > 0) {
      hits.push({ real: where.real, size: where.st.size, shown: ref.word })
    }
    for (const hit of hits) {
      const place = placeOf(hit.real, env)
      if (place.isOutside) impact.outside.push(hit.real)
      impact.targets.push(hit.real)
      impact.count += 1
      impact.bytes = (impact.bytes ?? 0) + hit.size
      if (impact.examples.length < 8) impact.examples.push(hit.shown)
    }
  }
  return impact
}

async function measureGit(op: GitOp, run: Runner): Promise<Impact[]> {
  const impact = emptyImpact(op)
  if (op.cwd === null) {
    impact.unmeasured = 'cwd'
    return [impact]
  }
  const cwd = op.cwd
  const git = (args: readonly string[]) => run(['git', ...args], cwd, GIT_ENV)
  const failed = () => {
    impact.unmeasured = 'failed'
    impact.bytes = null
    return [impact]
  }
  const status = async (paths: readonly string[]) => git(['status', '--porcelain=v1', '--untracked-files=no', ...(paths.length > 0 ? ['--', ...paths] : [])])
  switch (op.action) {
    case 'clean': {
      const out = await git(['clean', ...op.flags, ...(op.paths.length > 0 ? ['--', ...op.paths] : [])])
      if (out === null || out.exitCode !== 0) return failed()
      const entries = cleanEntries(out.stdout)
      impact.count = entries.length
      impact.examples = entries.slice(0, 8)
      if (op.ignoredOnly) {
        if (entries.length > 0 && entries.length <= 200) impact.bytes = duBytes(await run(['du', '-skc', '--', ...entries], cwd))
        else impact.bytes = entries.length === 0 ? 0 : null
      } else if (entries.length > 0) {
        impact.lost = { kind: 'untracked', count: entries.length, items: entries.slice(0, 8) }
      }
      return [impact]
    }
    case 'reset-hard': {
      const [st, ahead] = await Promise.all([
        status([]),
        op.ref === null ? Promise.resolve(null) : git(['log', '--oneline', '-n', '50', 'HEAD', '--not', op.ref, '--remotes']),
      ])
      if (st === null || st.exitCode !== 0) return failed()
      const changes = porcelainChanges(st.stdout, 'any')
      if (changes.length > 0) impact.lost = { kind: 'changes', count: changes.length, items: changes.slice(0, 8) }
      impact.examples = changes.slice(0, 8)
      const out = [impact]
      if (ahead !== null && ahead.exitCode === 0) {
        const commits = nonEmptyLines(ahead.stdout)
        if (commits.length > 0) {
          out.push({ ...emptyImpact(op), lost: { kind: 'unpushed', count: commits.length, items: commits.slice(0, 4) }, isLowerBound: commits.length >= 50 })
        }
      }
      return out
    }
    case 'checkout':
    case 'restore': {
      let paths = op.paths
      if (op.action === 'checkout' && op.ambiguous.length > 0) {
        const checks = await Promise.all(op.ambiguous.map(w => git(['rev-parse', '--verify', '--quiet', `${w}^{commit}`])))
        if (checks.some(c => c === null)) return failed()
        const notRefs = op.ambiguous.filter((_, k) => checks[k]?.exitCode !== 0)
        if (notRefs.length === 0 && !op.force) return [impact]
        paths = notRefs
      }
      const st = await status(paths)
      if (st === null || st.exitCode !== 0) return failed()
      const changes = porcelainChanges(st.stdout, op.ref !== null || op.force ? 'any' : 'worktree')
      if (changes.length > 0) impact.lost = { kind: 'changes', count: changes.length, items: changes.slice(0, 8) }
      impact.examples = changes.slice(0, 8)
      return [impact]
    }
    case 'stash-drop':
    case 'stash-clear': {
      const out = await git(['stash', 'list'])
      if (out === null || out.exitCode !== 0) return failed()
      const lines = nonEmptyLines(out.stdout)
      if (op.action === 'stash-clear') {
        if (lines.length > 0) impact.lost = { kind: 'stash', count: lines.length, items: lines.slice(0, 4) }
        return [impact]
      }
      const ref = /^\d+$/.test(op.ref ?? '') ? `stash@{${op.ref}}` : (op.ref ?? 'stash@{0}')
      const line = lines.find(l => l.startsWith(`${ref}:`))
      if (line !== undefined) impact.lost = { kind: 'stash', count: 1, items: [line] }
      return [impact]
    }
    case 'branch-delete': {
      const outs = await Promise.all(op.names.map(name => git(['log', '--oneline', '-n', '50', name, '--not', '--remotes'])))
      const impacts: Impact[] = []
      for (let k = 0; k < op.names.length; k++) {
        const out = outs[k]
        if (out === null || out === undefined) return failed()
        if (out.exitCode !== 0) continue
        const commits = nonEmptyLines(out.stdout)
        if (commits.length === 0) continue
        impacts.push({ ...emptyImpact(op), lost: { kind: 'unpushed', count: commits.length, items: commits.slice(0, 4), name: op.names[k] ?? '' }, isLowerBound: commits.length >= 50 })
      }
      return impacts.length > 0 ? impacts : [impact]
    }
    case 'force-push': {
      const [remote = '', branch = ''] = op.flags
      const upstream = remote !== '' && branch !== '' ? `${remote}/${branch}` : '@{u}'
      const [count, log] = await Promise.all([git(['rev-list', '--count', `HEAD..${upstream}`]), git(['log', '--oneline', '-n', '4', `HEAD..${upstream}`])])
      if (count === null || count.exitCode !== 0) return failed()
      const n = Number.parseInt(count.stdout.trim(), 10)
      if (Number.isFinite(n) && n > 0) impact.lost = { kind: 'remote', count: n, items: log === null ? [] : nonEmptyLines(log.stdout).slice(0, 4) }
      return [impact]
    }
  }
}

/** Measures every operation in parallel, all within `deadline` (a clock time). */
export async function measureAll(io: Io, ops: readonly Op[], env: Env, deadline: number): Promise<Impact[]> {
  const run = makeRunner(io, deadline)
  const lists = await Promise.all(
    ops.map(async (op): Promise<Impact[]> => {
      try {
        if (op.kind === 'device') return [emptyImpact(op)]
        if (op.kind === 'delete') return [await measureDelete(io, op, env, run)]
        if (op.kind === 'overwrite') return [await measureOverwrite(io, op, env)]
        return await measureGit(op, run)
      } catch {
        return [{ ...emptyImpact(op), unmeasured: 'failed', bytes: null }]
      }
    }),
  )
  return lists.flat()
}

/** One folder's bytes and file count for the Bin's caps, each null when it can't be told by `deadline`. */
export async function measureFolder(io: Io, abs: string, deadline: number): Promise<{ bytes: number | null; files: number | null }> {
  const run = makeRunner(io, deadline)
  const [du, found] = await Promise.all([run(['du', '-sk', '--', abs], null), run(['find', abs, '-type', 'f'], null)])
  const isCounted = found !== null && found.exitCode === 0 && !found.isStdoutTruncated
  return { bytes: duBytes(du), files: isCounted ? nonEmptyLines(found.stdout).length : null }
}
