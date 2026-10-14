// safety-net: the Bin. A plain rm becomes a move into a dated batch folder with a manifest,
// and /undo-delete or a Restore press moves it back.


import type { BinBatchView } from '../types'
import { isSystemDir, measureFolder } from './blast'
import type { Io } from './io'
import type { Env } from './blast'
import {
  LIMITS,
  baseName,
  batchId,
  dirName,
  isInside,
  isSameOrAncestor,
  joinPath,
  moveCommand,
  olderThan,
  parseManifest,
  restoreCandidates,
  storedNames,
} from './logic'
import type { BinItem, BinManifest, Impact, RmPlan } from './logic'

export const KEEP_DAYS = 14

export type BinPlan = { dir: string; command: string; manifest: BinManifest }

export type StoredBatch = BinManifest & { dir: string }

function hex4(): string {
  const bytes = new Uint8Array(2)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** The Bin's folder for this person, or null without a HOME. */
export function binRootOf(home: string | null): string | null {
  return home === null ? null : `${home}/.claude/mod-data/safety-net/bin`
}

/** A batch younger than this may still be waiting on its move (a permission dialog, a slow mv). */
export const SETTLE_MS = 3_600_000

/**
 * Plans the move for a plain rm. Null means "let rm run as written": a target is missing
 * without -f, a folder without -r, a link with a trailing slash, in the Bin, a root folder,
 * over 1 GB or unmeasurable in time, or outside home and the project without the person's OK.
 * A temp folder needs no OK while its items stay small (25 files, 50 MB in all): moving them
 * may copy across disks, and blast radius asks first about anything bigger.
 */
export async function planBin(
  io: Io,
  plan: RmPlan,
  env: Env,
  impacts: readonly Impact[],
  isOked: boolean,
  original: string,
  deadline: number,
): Promise<BinPlan | null> {
  if (env.binRoot === null || env.binReal === null) return null
  const items: (Omit<BinItem, 'stored'> & { name: string })[] = []
  const measured = impacts.flatMap(i => (i.op.kind === 'delete' ? i.perTarget : []))
  let tempFiles = 0
  let tempBytes = 0
  for (const target of plan.targets) {
    const abs = joinPath(env.cwd, target)
    const st = await io.stat(abs)
    if (st === null) {
      if (plan.force) continue
      return null
    }
    const hasSlash = target.endsWith('/')
    if (st.isLink && hasSlash) return null
    const isLinkOnly = st.isLink
    let real: string
    if (isLinkOnly) {
      const parent = await io.stat(dirName(abs))
      real = joinPath(parent?.realPath ?? dirName(abs), baseName(abs))
    } else {
      real = st.realPath ?? abs
    }
    const kind: BinItem['kind'] = isLinkOnly ? 'link' : st.kind
    if (kind === 'dir' && !plan.recursive) {
      if (!plan.dir) return null
      const inside = await io.list(abs)
      if (inside === null || inside.length > 0) return null
    }
    if (isSameOrAncestor(real, env.binReal) || isInside(real, env.binReal)) return null
    if (isSameOrAncestor(real, env.rootReal) || isSystemDir(real)) return null
    if (env.homeReal !== null && isSameOrAncestor(real, env.homeReal)) return null
    if (env.temps.some(t => isSameOrAncestor(real, t))) return null
    const isHomeOrProject = isInside(real, env.rootReal) || (env.homeReal !== null && isInside(real, env.homeReal))
    const isTemp = !isHomeOrProject && env.temps.some(t => isInside(real, t))
    if (!isHomeOrProject && !isTemp && !isOked) return null
    let bytes = 0
    let files = 1
    if (kind === 'file') bytes = st.size
    else if (kind === 'dir') {
      const known = measured.find(m => m.real === real)
      let size = known?.bytes ?? null
      let count = known?.files ?? null
      if (size === null || (isTemp && !isOked && count === null)) {
        const fresh = await measureFolder(io, abs, deadline)
        size = size ?? fresh.bytes
        count = count ?? fresh.files
      }
      if (size === null) return null
      bytes = size
      files = count ?? Number.POSITIVE_INFINITY
    }
    if (bytes > LIMITS.binItemBytes) return null
    if (isTemp && !isOked) {
      tempFiles += files
      tempBytes += bytes
      if (tempFiles > LIMITS.files || tempBytes > LIMITS.bytes) return null
    }
    items.push({ from: abs, kind, bytes, name: baseName(abs) })
  }
  if (items.length === 0) return null
  const names = storedNames(items.map(i => i.name))
  const at = await io.now()
  const id = batchId(at, hex4())
  const dir = `${env.binRoot}/${id}`
  const manifest: BinManifest = {
    id,
    at,
    cwd: env.cwd,
    command: original,
    items: items.map((i, k) => ({ from: i.from, stored: names[k] ?? i.name, kind: i.kind, bytes: i.bytes })),
  }
  const command = moveCommand(dir, manifest.items, plan.verbose)
  return { dir, command, manifest }
}

/** Writes the manifest before anything moves. False when it could not be written. */
export async function writeManifest(io: Io, plan: BinPlan): Promise<boolean> {
  return io.write(`${plan.dir}/manifest.json`, JSON.stringify(plan.manifest, null, 2))
}

/** Removes one batch folder, only when its real path is inside the Bin. */
export async function removeBatch(io: Io, dir: string, binRoot: string): Promise<boolean> {
  const [own, root] = await Promise.all([io.stat(dir), io.stat(binRoot)])
  const real = own?.realPath
  const rootReal = root?.realPath ?? binRoot
  if (real === undefined || !isInside(real, rootReal)) return false
  const out = await io.run(['rm', '-rf', real], { timeoutMs: 60_000 })
  return out !== null && out.exitCode === 0
}

/**
 * After the move ran: keeps only what landed in the batch; drops an empty batch. Writes the
 * manifest again when it is gone (another session tidied the batch while the move waited).
 */
export async function settleBatch(io: Io, plan: BinPlan, binRoot: string): Promise<BinItem[]> {
  const listed = (await io.list(plan.dir)) ?? []
  const present = new Set(listed.map(e => e.name))
  const kept = plan.manifest.items.filter(i => present.has(i.stored))
  if (kept.length === 0) {
    await removeBatch(io, plan.dir, binRoot)
    return []
  }
  if (kept.length !== plan.manifest.items.length || !present.has('manifest.json')) {
    await io.write(`${plan.dir}/manifest.json`, JSON.stringify({ ...plan.manifest, items: kept }, null, 2))
  }
  return kept
}

/** Every batch in the Bin, newest first. */
export async function listBatches(io: Io, binRoot: string): Promise<StoredBatch[]> {
  const entries = (await io.list(binRoot)) ?? []
  const out: StoredBatch[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const dir = `${binRoot}/${entry.name}`
    const text = await io.read(`${dir}/manifest.json`)
    if (text === null) continue
    const manifest = parseManifest(text)
    if (manifest === null) continue
    out.push({ ...manifest, dir })
  }
  return out.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
}

export function batchViews(batches: readonly StoredBatch[]): BinBatchView[] {
  return batches.map(b => ({
    id: b.id,
    at: b.at,
    names: b.items.map(i => baseName(i.from) + (i.kind === 'dir' ? '/' : '')),
    count: b.items.length,
    bytes: b.items.reduce((s, i) => s + i.bytes, 0),
  }))
}

export type RestoreResult = { restored: { name: string; to: string }[]; failed: string[]; total: number }

/** Moves a batch's items back; an item whose old place is taken goes beside it as `.restored`. */
export async function restoreBatch(io: Io, batch: StoredBatch, binRoot: string): Promise<RestoreResult> {
  const restored: { name: string; to: string }[] = []
  const failed: string[] = []
  const left: BinItem[] = []
  for (const item of batch.items) {
    const src = `${batch.dir}/${item.stored}`
    const name = baseName(item.from)
    const here = await io.exists(src)
    if (!here) {
      failed.push(name)
      continue
    }
    let dest: string | null = null
    for (const candidate of restoreCandidates(item.from)) {
      const isTaken = (await io.exists(candidate)) || (await io.stat(candidate)) !== null
      if (!isTaken) {
        dest = candidate
        break
      }
    }
    if (dest === null) {
      failed.push(name)
      left.push(item)
      continue
    }
    await io.run(['mkdir', '-p', dirName(dest)], { timeoutMs: 10_000 })
    const out = await io.run(['mv', '--', src, dest], { timeoutMs: 120_000 })
    if (out !== null && out.exitCode === 0) restored.push({ name, to: dest })
    else {
      failed.push(name)
      left.push(item)
    }
  }
  if (left.length === 0) await removeBatch(io, batch.dir, binRoot)
  else await io.write(`${batch.dir}/manifest.json`, JSON.stringify({ ...batch, dir: undefined, items: left }, null, 2))
  return { restored, failed, total: batch.items.length }
}

/** Removes batches older than 14 days; returns how many went. */
export async function purgeOld(io: Io, binRoot: string): Promise<number> {
  const now = await io.now()
  const old = olderThan(await listBatches(io, binRoot), now, KEEP_DAYS)
  let removed = 0
  for (const batch of old) if (await removeBatch(io, batch.dir, binRoot)) removed++
  return removed
}

/**
 * Removes batches whose items are all gone (a move that never ran), keeping the rest. A batch
 * under an hour old is left alone: its move may still be waiting on a dialog in some session.
 */
export async function dropEmpty(io: Io, binRoot: string): Promise<number> {
  let removed = 0
  const now = await io.now()
  for (const batch of await listBatches(io, binRoot)) {
    if (now - batch.at < SETTLE_MS) continue
    const names = new Set(((await io.list(batch.dir)) ?? []).map(e => e.name))
    if (batch.items.some(i => names.has(i.stored))) continue
    if (await removeBatch(io, batch.dir, binRoot)) removed++
  }
  return removed
}

/** The view of one batch, for adding it to the drawn list without reading the Bin again. */
export function batchView(manifest: BinManifest, items: readonly BinItem[]): BinBatchView {
  return batchViews([{ ...manifest, items: [...items], dir: '' }])[0]!
}
