// safety-net: wires the events. Blast radius and safe delete sit on the Bash tool; /safety, /bin,
// /undo-delete and /modcheck are the commands; three panes draw from $.state.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallResult, ToolCheckResult } from 'claude-code'

import type { BinView, ModCheckView, SafetyCatch, SafetySettings } from '../types'
import { TOTAL_MS, loadEnv, measureAll } from './blast'
import { batchView, batchViews, binRootOf, dropEmpty, listBatches, planBin, purgeOld, removeBatch, restoreBatch, settleBatch, writeManifest } from './bin'
import type { BinPlan } from './bin'
import {
  DEFAULT_SETTINGS,
  LIMITS,
  analyze,
  baseName,
  binListing,
  classifyTarget,
  decide,
  folderOf,
  formatBytes,
  isGitUrl,
  parseSafetyArgs,
  plainRm,
  plural,
  readCatches,
  readSettings,
  restoreSentence,
  settingsSentence,
} from './logic'
import type { Decision, Impact } from './logic'
import type { Io } from './io'
import { blankCheck, runModCheck } from './modcheck'
import { binView, checkView, safetyView } from './views'

const PANE_SAFETY = 'safety-net'
const PANE_BIN = 'safety-net-bin'
const PANE_CHECK = 'safety-net-check'

const SETTINGS = { plugin: 'safety-net', key: 'settings' } as const
const CATCHES = { plugin: 'safety-net', key: 'catches' } as const
const BIN = { plugin: 'safety-net', key: 'bin' } as const
const CHECK = { plugin: 'safety-net', key: 'modcheck' } as const
const MODE = { plugin: 'safety-net', key: 'mode' } as const

const settingsAtom = atom(SETTINGS, DEFAULT_SETTINGS as SafetySettings)
const catchesAtom = atom(CATCHES, [] as SafetyCatch[])
const binAtom = atom(BIN, { asOf: 0, batches: [], note: '' } as BinView)
const checkAtom = atom(CHECK, blankCheck() as ModCheckView)
const modeAtom = atom(MODE, '')

const BIN_NOTE = 'safety-net moved these to the Bin instead of deleting them. /undo-delete puts them back.'
const FOR_GOOD = " safety-net can't move this to the Bin, so it is deleted for good."
const CHECK_RANK = { allow: 0, ask: 1, deny: 2 } as const
const BIN_PARTIAL = 'safety-net tried to move these to the Bin instead of deleting them; the move stopped partway, so nothing was deleted. Whatever moved is in the Bin, and /undo-delete puts it back.'
const STATUS_MS = 30_000

/**
 * Calls waiting on the engine's own permission check, by tool_use_id and by the command as run:
 * `reason` when blast radius asks, `original` (the rm as written) when safe delete rewrote it.
 */
type Pending = { reason: string | null; original: string | null; note: string }
const pending = new Map<string, Pending>()

let statusTimer: Timer | null = null
let checkRun = 0

/** The outside calls the Bin, the measuring and Mod Check make, spelled out on `$` here. */
function ioOf($: EngineInterface): Io {
  return {
    stat: path => $.fs.stat(path, { resolve: true }).then(
      st => st,
      () => null,
    ),
    list: path => $.fs.list(path).then(
      entries => entries,
      () => null,
    ),
    read: path => $.fs.read(path).then(
      text => text,
      () => null,
    ),
    write: (path, text) => $.fs.write(path, text).then(
      () => true,
      () => false,
    ),
    exists: path => $.fs.exists(path).then(
      isThere => isThere,
      () => false,
    ),
    run: (argv, init) => $.process.run(argv, init).then(
      out => out,
      () => null,
    ),
    now: () => $.clock.now(),
    complete: request => $.model.complete(request).then(
      reply => reply,
      () => null,
    ),
  }
}

function showStatus($: EngineInterface, text: string): void {
  statusTimer?.cancel()
  $.ui.status(text)
  statusTimer = $.clock.after(STATUS_MS, () => {
    statusTimer = null
    $.ui.status(undefined)
  })
}

/** The switches: from $.state, loaded from $.store the first time. */
async function loadSettings($: EngineInterface): Promise<SafetySettings> {
  const held = await $.state.get(SETTINGS)
  if (held.version > 0 && held.value !== undefined) return held.value
  const stored = readSettings(await $.store.get('settings'))
  await $.state.set(SETTINGS, stored)
  return stored
}

/** Saves the switches to $.store first, so a failed save changes nothing, then shows them. */
async function setSwitches($: EngineInterface, change: Partial<SafetySettings>): Promise<SafetySettings> {
  const next = { ...(await loadSettings($)), ...change }
  await $.store.set('settings', next)
  await update($, settingsAtom, s => ({ ...s, ...change }))
  return next
}

/** Logs a catch for the /safety pane. Best effort: a full disk never skips the ask that follows. */
async function addCatch($: EngineInterface, summary: string, outcome: string): Promise<number | null> {
  try {
    const at = await $.clock.now()
    const list = await update($, catchesAtom, l => [...l, { at, summary, outcome }].slice(-20))
    await $.store.set('catches', list)
    return at
  } catch {
    return null
  }
}

async function setOutcome($: EngineInterface, at: number | null, outcome: string): Promise<void> {
  if (at === null) return
  try {
    const list = await update($, catchesAtom, l => l.map(c => (c.at === at ? { ...c, outcome } : c)))
    await $.store.set('catches', list)
  } catch {
    // the catch keeps its first outcome
  }
}

/** Keeps the permission mode current from any main-loop classic event that carries it. */
async function noteMode($: EngineInterface, e: { permission_mode?: string; agent_id?: string }): Promise<void> {
  try {
    if (e.agent_id !== undefined) return
    const mode = typeof e.permission_mode === 'string' ? e.permission_mode : ''
    if (mode !== '' && mode !== (await read($, modeAtom))) await $.state.set(MODE, mode)
  } catch {
    // the mode is only a hint for where to ask
  }
}

/** The stricter of two permission verdicts; on a tie, the first (the rm's own). */
function stricterCheck(a: ToolCheckResult, b: ToolCheckResult): ToolCheckResult {
  return CHECK_RANK[b.decision] > CHECK_RANK[a.decision] ? b : a
}

async function refreshBin($: EngineInterface, note = ''): Promise<void> {
  const root = binRootOf((await $.env.get('HOME')) ?? null)
  const now = await $.clock.now()
  const batches = root === null ? [] : await listBatches(ioOf($), root)
  await $.state.set(BIN, { asOf: now, batches: batchViews(batches), note })
}

/** Where the person can OK an ask: the engine's prompt (`check`), safety-net's own question, or nobody. */
async function askRoute($: EngineInterface): Promise<'check' | 'ask' | 'run' | 'deny'> {
  const mode = await read($, modeAtom)
  const surfaces = await $.session.surfaces().catch(() => [] as const)
  const hasPerson = surfaces.length > 0
  if (mode === 'bypassPermissions') return hasPerson ? 'ask' : 'run'
  if (mode === 'auto') return hasPerson ? 'ask' : 'check'
  if (mode === 'dontAsk') return 'deny'
  return 'check'
}

function withNote(result: ToolCallResult, note: string): ToolCallResult {
  if (result.deny !== undefined) return result
  return { ...result, context: [...(result.context ?? []), note] } as ToolCallResult
}

function commandOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const command = (input as { command?: unknown }).command
  return typeof command === 'string' ? command : null
}

/** Opens a pane from a command or a press; says so in one line when it can't be shown. */
async function openPane($: EngineInterface, id: string, title: string, fallback: () => Promise<void>): Promise<void> {
  try {
    const opened = await $.ui.open({ id, title })
    if (!opened.isPlaced) {
      $.ui.toast(`${title}: no pane can be shown here, so it went to the transcript.`)
      await fallback()
    }
  } catch {
    $.ui.toast(`The ${title} pane could not open.`)
    await fallback().catch(() => undefined)
  }
}

async function binFallback($: EngineInterface): Promise<void> {
  const bin = await read($, binAtom)
  $.ui.log(binListing(bin.batches, bin.asOf))
}

async function restoreById($: EngineInterface, id: string): Promise<void> {
  const root = binRootOf((await $.env.get('HOME')) ?? null)
  if (root === null) return
  const batch = (await listBatches(ioOf($), root)).find(b => b.id === id)
  if (batch === undefined) {
    await refreshBin($, 'That batch is no longer in the Bin.')
    return
  }
  const result = await restoreBatch(ioOf($), batch, root)
  await refreshBin($, restoreSentence(result))
  if (result.failed.length > 0) $.ui.toast(restoreSentence(result))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await Promise.all([
        $.command.register({ name: 'safety', description: 'Safety net: switches and recent catches', argumentHint: '[on|off]' }),
        $.command.register({ name: 'bin', description: 'Open the Bin: files Claude removed with rm, ready to restore' }),
        $.command.register({ name: 'undo-delete', description: 'Put back the files from the newest Bin batch' }),
        $.command.register({ name: 'modcheck', description: 'Check a mod before you install it', argumentHint: '<folder | owner/repo | git URL>' }),
      ])
    } catch {
      // a command that did not register still answers through its hook
    }
    try {
      await $.state.set(SETTINGS, readSettings(await $.store.get('settings')))
      await $.state.set(CATCHES, readCatches(await $.store.get('catches')))
    } catch {
      // the panes fall back to the defaults
    }
    try {
      // a check this module never started was left running by the module before a reload
      if (checkRun === 0 && (await read($, checkAtom)).status === 'working') {
        await update($, checkAtom, v => ({ ...v, status: 'failed' as const, error: 'The check stopped when safety-net reloaded. Run /modcheck again.' }))
      }
    } catch {
      // the pane shows what it last knew
    }
    void (async () => {
      try {
        const root = binRootOf((await $.env.get('HOME')) ?? null)
        if (root !== null) {
          await purgeOld(ioOf($), root)
          await dropEmpty(ioOf($), root)
        }
        await refreshBin($)
      } catch {
        // the Bin is tidied next session
      }
    })()
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await noteMode($, e)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.SessionStart', async ($, e, next) => {
    await noteMode($, e)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.PostToolUse', async ($, e, next) => {
    await noteMode($, e)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.PostToolUseFailure', async ($, e, next) => {
    await noteMode($, e)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.Stop', async ($, e, next) => {
    await noteMode($, e)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const host = (e as { _host?: unknown })._host
    if (typeof host === 'string' && host !== '') return next(e)
    if (analyze(e.command, { cwd: null, home: null }).ops.length === 0 && plainRm(e.command) === null) return next(e)
    const settings = await loadSettings($)
    if (!settings.blastRadius && !settings.safeDelete) return next(e)
    const deadline = (await $.clock.now()) + TOTAL_MS
    const [cwd, root, home, tmpdir] = await Promise.all([$.session.cwd(), $.session.root(), $.env.get('HOME'), $.env.get('TMPDIR')])
    const env = await loadEnv(ioOf($), { cwd, root, home, tmpdir })
    const analysis = analyze(e.command, { cwd: env.cwd, home: env.home })
    // a background run returns before its mv does, so the batch could not be settled: rm runs as written
    const rm = settings.safeDelete && e.run_in_background !== true ? plainRm(e.command) : null
    let decision: Decision = { verdict: 'none', status: '', summary: '', files: 0, bytes: 0 }
    let impacts: Impact[] = []
    if (settings.blastRadius && analysis.ops.length > 0) {
      impacts = await measureAll(ioOf($), analysis.ops, env, deadline)
      decision = decide(impacts, { root: env.rootReal, home: env.homeReal, bin: env.binReal })
    }
    const isAsk = decision.verdict === 'ask'
    const route = isAsk ? await askRoute($) : 'check'
    if (isAsk && route === 'deny') {
      await addCatch($, decision.summary, 'stopped')
      showStatus($, 'blast radius: stopped · needs your OK')
      return {
        deny: `${decision.summary} safety-net needs the person's OK before this runs, and this permission mode never asks. The person can run it themselves, or turn the check off with /safety off.`,
      }
    }

    let plan: BinPlan | null = null
    if (rm !== null && env.binRoot !== null) {
      plan = await planBin(ioOf($), rm, env, impacts, isAsk && route !== 'run', e.command, deadline)
      if (plan !== null && !(await writeManifest(ioOf($), plan))) plan = null
    }
    const call = plan === null ? e : { ...e, command: plan.command }
    const binNote = plan !== null ? ' safety-net will move these to the Bin instead of deleting them; /undo-delete puts them back.' : rm !== null && isAsk ? FOR_GOOD : ''

    let caughtAt: number | null = null
    if (isAsk) {
      caughtAt = await addCatch($, decision.summary, 'asked')
      if (route === 'ask') {
        let answer: string | null = null
        try {
          answer = await $.ui.ask(`${decision.summary}${binNote} Run it?`, { options: ['Run it', "Don't run"], header: 'Blast radius' })
        } catch {
          answer = null
        }
        if (answer !== 'Run it') {
          if (plan !== null && env.binRoot !== null) await removeBatch(ioOf($), plan.dir, env.binRoot)
          await setOutcome($, caughtAt, 'stopped')
          showStatus($, 'blast radius: stopped · you chose not to run it')
          return { deny: `${decision.summary} The person chose not to run it.` }
        }
      } else if (route === 'run') {
        $.ui.log(`safety-net: ${decision.summary} Nobody can be asked in this bypass-mode session, so it ran.`)
      }
    }

    const viaPrompt = isAsk && route === 'check'
    const isWatched = viaPrompt || plan !== null
    const keys = [e.tool_use_id, `cmd:${call.command}`]
    if (isWatched) {
      const entry: Pending = { reason: viaPrompt ? `${decision.summary}${binNote}` : null, original: plan === null ? null : e.command, note: binNote.trim() }
      for (const k of keys) pending.set(k, entry)
    }
    let result: ToolCallResult
    try {
      result = await next(call)
    } finally {
      if (isWatched) for (const k of keys) pending.delete(k)
    }
    const hasRun = result.deny === undefined && result.isError !== true
    await setOutcome($, caughtAt, hasRun ? 'ran after OK' : 'not run')

    let status = decision.verdict === 'none' ? '' : decision.status
    if (plan !== null && env.binRoot !== null) {
      const kept = await settleBatch(ioOf($), plan, env.binRoot)
      if (kept.length > 0) {
        result = withNote(result, hasRun ? BIN_NOTE : BIN_PARTIAL)
        const size = formatBytes(kept.reduce((s, i) => s + i.bytes, 0))
        status = status === '' ? `safe delete: ${plural(kept.length, 'item')} (${size}) moved to the Bin` : `${status} · moved to the Bin`
        try {
          const added = batchView(plan.manifest, kept)
          const now = await $.clock.now()
          await update($, binAtom, b => ({ asOf: now, note: '', batches: [added, ...b.batches.filter(x => x.id !== added.id)] }))
        } catch {
          // the Bin pane reads the folder again when it opens
        }
        const names = kept.map(i => baseName(i.from))
        await addCatch($, `Moved ${plural(kept.length, 'item')} to the Bin: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}`, 'moved to the Bin')
      }
    }
    if (status !== '') showStatus($, status)
    return result
  }).catch(($, e, next) => next(e))

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const command = commandOf(e.input)
    const entry = (e.tool_use_id === undefined ? undefined : pending.get(e.tool_use_id)) ?? (command === null ? undefined : pending.get(`cmd:${command}`))
    if (entry === undefined) return next(e)
    // the engine's verdict on the call as it runs (rules, mode, PreToolUse hooks) always counts
    const verdict = await next(e)
    let combined = verdict
    if (entry.original !== null) {
      // and so do the person's rules for the rm as written: the stricter of the two wins
      const input = typeof e.input === 'object' && e.input !== null ? (e.input as Record<string, unknown>) : {}
      const asRm = await $.tool.check({ tool: 'Bash', input: { ...input, command: entry.original } }).catch(() => null)
      if (asRm !== null) combined = stricterCheck(asRm, verdict)
    }
    if (combined.decision === 'deny') return combined
    if (entry.reason !== null) return { decision: 'ask', reason: entry.reason }
    if (combined.decision === 'ask' && entry.note !== '') return { ...combined, reason: `${combined.reason === undefined ? '' : `${combined.reason} `}${entry.note}` }
    return combined
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'safety' }, async ($, e) => {
    try {
      const args = parseSafetyArgs(e.args)
      if (args.kind === 'set') {
        const next = await setSwitches($, { blastRadius: args.isOn, safeDelete: args.isOn })
        return { text: settingsSentence(next) }
      }
      if (args.kind === 'unknown') return { text: `"${args.text}" is not a choice here. Use /safety to see the switches, or /safety on or /safety off.` }
      void (async () => {
        try {
          await loadSettings($)
          await refreshBin($)
        } catch {
          // the pane draws the defaults
        }
        await openPane($, PANE_SAFETY, 'Safety net', async () => {
          const s = await read($, settingsAtom)
          $.ui.log(settingsSentence(s))
        })
      })()
      return { text: 'Opening the safety net switches.' }
    } catch {
      return { text: 'The safety command failed. Nothing was changed.' }
    }
  }).catch(() => ({ text: 'The safety command failed. Nothing was changed.' }))

  on('command.run', { command: 'bin' }, $ => {
    try {
      void (async () => {
        try {
          await refreshBin($)
        } catch {
          // the pane shows what it last knew
        }
        await openPane($, PANE_BIN, 'Bin', () => binFallback($))
      })()
      return { text: 'Opening the Bin.' }
    } catch {
      return { text: 'The Bin could not open. Nothing was changed.' }
    }
  }).catch(() => ({ text: 'The Bin could not open. Nothing was changed.' }))

  on('command.run', { command: 'undo-delete' }, async $ => {
    try {
      const root = binRootOf((await $.env.get('HOME')) ?? null)
      if (root === null) return { text: 'There is no Bin, because HOME is not set.' }
      const newest = (await listBatches(ioOf($), root))[0]
      if (newest === undefined) return { text: 'The Bin is empty, so there is nothing to put back.' }
      const bytes = newest.items.reduce((s, i) => s + i.bytes, 0)
      if (bytes > LIMITS.bytes) {
        void (async () => {
          try {
            const result = await restoreBatch(ioOf($), newest, root)
            await refreshBin($)
            $.ui.toast(restoreSentence(result))
          } catch {
            $.ui.toast('Undo delete stopped partway. What was not put back is still in the Bin.')
          }
        })()
        return { text: `Putting back ${plural(newest.items.length, 'item')} (${formatBytes(bytes)}) from the Bin. A note appears when it is done.` }
      }
      const result = await restoreBatch(ioOf($), newest, root)
      await refreshBin($)
      return { text: restoreSentence(result) }
    } catch {
      return { text: 'Undo delete failed. Anything not put back is still in the Bin.' }
    }
  }).catch(() => ({ text: 'Undo delete failed. Anything not put back is still in the Bin.' }))

  on('command.run', { command: 'modcheck' }, async ($, e) => {
    try {
      const arg = e.args.trim()
      if (arg === '') return { text: 'Give /modcheck a folder, an owner/repo or a git URL, for example /modcheck ./my-mod.' }
      const [cwd, home] = await Promise.all([$.session.cwd(), $.env.get('HOME')])
      const local = isGitUrl(arg) ? null : folderOf(arg, cwd, home ?? null)
      const isFolder = local !== null && (await $.fs.stat(local).then(st => st.kind === 'dir', () => false))
      const target = classifyTarget(arg, cwd, home ?? null, isFolder)
      if (target === null) return { text: `"${arg}" is not a folder, an owner/repo or a git URL.` }
      checkRun += 1
      const run = checkRun
      void (async () => {
        const patch = async (change: Partial<ModCheckView>) => {
          if (run !== checkRun) return
          await update($, checkAtom, v => ({ ...v, ...change }))
        }
        try {
          await patch({ ...blankCheck(), status: 'working', name: target.name, step: 'Starting…' })
          let isPlaced = true
          try {
            isPlaced = (await $.ui.open({ id: PANE_CHECK, title: 'Mod Check' })).isPlaced
          } catch {
            isPlaced = false
          }
          if (!isPlaced) $.ui.toast('Mod Check: no pane can be shown here, so the report goes to the transcript.')
          const done = await runModCheck(ioOf($), target, home ?? null, patch)
          if (!isPlaced && run === checkRun) $.ui.log(done.status === 'done' ? done.report : `Mod Check could not finish: ${done.error}`)
        } catch {
          await patch({ status: 'failed', error: 'Mod Check stopped on an unexpected error.' }).catch(() => undefined)
        }
      })()
      return { text: `Checking ${target.name}… the result opens in a pane.` }
    } catch {
      return { text: 'Mod Check could not start. Nothing was changed.' }
    }
  }).catch(() => ({ text: 'Mod Check could not start. Nothing was changed.' }))

  on('ui.render', { component: 'Pane', requestId: PANE_SAFETY }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const columns = Math.max(1, e.props.bodyColumns)
    const [settings, catches, bin] = await Promise.all([read($, settingsAtom), read($, catchesAtom), read($, binAtom)])
    return safetyView(kit, columns, settings, catches, bin, {
      setBlast: isOn =>
        setSwitches($, { blastRadius: isOn }).catch(() => {
          $.ui.toast('The blast radius switch could not be saved, so it stays as it was.')
        }),
      setDelete: isOn =>
        setSwitches($, { safeDelete: isOn }).catch(() => {
          $.ui.toast('The safe delete switch could not be saved, so it stays as it was.')
        }),
      openBin: async () => {
        await refreshBin($).catch(() => undefined)
        await openPane($, PANE_BIN, 'Bin', () => binFallback($))
      },
      close: () => $.ui.close({ id: PANE_SAFETY }),
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE_BIN }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const columns = Math.max(1, e.props.bodyColumns)
    const bin = await read($, binAtom)
    return binView(kit, columns, bin, {
      restore: id =>
        restoreById($, id).catch(() => {
          $.ui.toast('That batch could not be put back. It is still in the Bin.')
        }),
      purge: async () => {
        try {
          const root = binRootOf((await $.env.get('HOME')) ?? null)
          const removed = root === null ? 0 : await purgeOld(ioOf($), root)
          await refreshBin($, removed === 0 ? 'Nothing in the Bin is older than 14 days.' : `Emptied ${plural(removed, 'batch', 'batches')} older than 14 days.`)
        } catch {
          $.ui.toast('The Bin could not be emptied. Nothing was removed.')
        }
      },
      close: () => $.ui.close({ id: PANE_BIN }),
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE_CHECK }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const columns = Math.max(1, e.props.bodyColumns)
    const view = await read($, checkAtom)
    const surface = e.surface
    return checkView(kit, columns, view, {
      copy: async () => {
        const fresh = await read($, checkAtom)
        const copied = await $.ui.copy({ text: fresh.report, surface }).catch(() => ({ isCopied: false as const }))
        if (!copied.isCopied) {
          $.ui.log(fresh.report)
          $.ui.toast('The report could not be copied here, so it went to the transcript.')
        }
      },
      close: () => $.ui.close({ id: PANE_CHECK }),
    })
  })
}
