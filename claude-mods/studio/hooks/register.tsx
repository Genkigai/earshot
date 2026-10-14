// studio: a live progress band above the prompt, theme skins, a preview of
// the image you just pasted, and a small web reader. Every `$` call lives
// here; logic.ts is pure and the views only draw what they are handed.

import { atom, read, update } from 'claude-code'
import type {
  CommandRunInput,
  EngineInterface,
  PromptSubmitAttachment,
  PromptSubmitInput,
  PromptSubmitResult,
  Register,
  RenderSurface,
  Timer,
} from 'claude-code'

import type { StudioBrowse, StudioImage, StudioSettings, StudioSkins, StudioTone } from '../types'
import { drawBand } from './band'
import {
  CUSTOM_SLUG,
  CUSTOM_VALUE,
  DEFAULT_SETTINGS,
  FETCH_TIMEOUT_MS,
  PENDING_CAP,
  accentHex,
  addTask,
  afterDeny,
  afterTool,
  bandModel,
  beforeTool,
  claimIndex,
  draftSeparator,
  endJob,
  hostOf,
  imageAction,
  imageFromAttachment,
  imageFromBlock,
  imageLine,
  isActive,
  isPersonsOrigin,
  isRealPrompt,
  jobName,
  needsReason,
  needsYou,
  normalizeUrl,
  pageFrom,
  parseSwitch,
  questionReason,
  readSettings,
  resolveHref,
  samePage,
  sendText,
  shortReason,
  slashName,
  startJob,
  stepLabel,
  themeLabel,
  themesFolderFrom,
  themesFrom,
  treeRows,
  todosFromTaskList,
  todosFromTodoWrite,
  updateTask,
  customThemeJson,
  ACCENTS,
  formatBytes,
} from './logic'
import type { Page, PendingPrompt } from './logic'
import { fit } from './look-text'
import { drawBrowse, drawImagePane, drawSkins } from './panes'

type Dollar = EngineInterface

const PANE_SKINS = 'skins'
const PANE_IMAGE = 'image'
const PANE_BROWSE = 'browse'

const EMPTY_SKINS: StudioSkins = { themes: [], current: '', note: '', tone: 'muted', canOpenTheme: false }
const EMPTY_BROWSE: StudioBrowse = {
  phase: 'idle',
  url: '',
  host: '',
  title: '',
  markdown: '',
  error: '',
  history: [],
  note: '',
  tone: 'muted',
}

const jobAtom = atom({ plugin: 'studio', key: 'job' } as const, null)
const tickAtom = atom({ plugin: 'studio', key: 'tick' } as const, 0)
const settingsAtom = atom({ plugin: 'studio', key: 'settings' } as const, DEFAULT_SETTINGS)
const imageAtom = atom({ plugin: 'studio', key: 'image' } as const, null)
const skinsAtom = atom({ plugin: 'studio', key: 'skins' } as const, EMPTY_SKINS)
const browseAtom = atom({ plugin: 'studio', key: 'browse' } as const, EMPTY_BROWSE)


class TimeoutError extends Error {}

// Timers and per-turn notes. Lost on a reload, which is fine: state lives in $.state.
let ticker: Timer | null = null
let hideTimer: Timer | null = null
let statusTimer: Timer | null = null
let statusGeneration = 0
let fetchGeneration = 0
let pendingImages: PromptSubmitAttachment[] = []
/** The person's prompts on their way to the turn each starts; a job starts at that turn.start, never before. */
let pending: PendingPrompt[] = []
/** The text of the last main-loop turn that started while a noted prompt was in flight and claimed none. */
let unclaimedTurn: string | null = null
/** Whether the terminal runs the fullscreen layout, learned this session from any slash command the person runs. */
let isFullscreen: boolean | undefined

// -------------------------------------------------------------------------
// Settings

async function saveSettings($: Dollar, change: (settings: StudioSettings) => StudioSettings): Promise<StudioSettings> {
  const next = await update($, settingsAtom, change)
  await $.store.set('settings', next)
  return next
}

/** The terminal's layout is fixed for a session, and every command the person runs at it carries it. */
function noteScreen(e: CommandRunInput) {
  if (e.origin.kind !== 'composer') return
  isFullscreen = e.presentation.isFullscreen
}

// -------------------------------------------------------------------------
// The job clock: one tick a second while a job works or waits, none otherwise

function stopTicker() {
  ticker?.cancel()
  ticker = null
}

async function tickOnce($: Dollar) {
  try {
    const settings = await read($, settingsAtom)
    const job = await read($, jobAtom)
    if (!settings.isOn || !settings.progress || !isActive(job)) {
      stopTicker()
      return
    }
    const now = await $.clock.now()
    await update($, tickAtom, () => now)
  } catch {
    stopTicker()
  }
}

function ensureTicker($: Dollar) {
  if (ticker !== null) return
  ticker = $.clock.every(1000, () => {
    void tickOnce($)
  })
}

async function beginJob($: Dollar, text: string) {
  const now = await $.clock.now()
  hideTimer?.cancel()
  hideTimer = null
  await update($, jobAtom, previous => startJob(jobName(text), now, previous))
  await update($, tickAtom, () => now)
  ensureTicker($)
}

async function hideDone($: Dollar) {
  hideTimer = null
  await update($, jobAtom, job => (job !== null && job.phase === 'done' ? { ...job, phase: 'hidden' as const } : job))
}

async function isTracking($: Dollar): Promise<boolean> {
  const settings = await read($, settingsAtom)
  return settings.isOn && settings.progress
}

/** Whether a submitted prompt is one that starts a job: the person's own words, not a slash command. */
async function startsJob($: Dollar, e: PromptSubmitInput): Promise<boolean> {
  if (!isPersonsOrigin(e.origin)) return false
  if (slashName(e.text) === null) return isRealPrompt(e.text, e.origin)
  let names: Set<string> | null = null
  try {
    names = new Set((await $.command.list()).map(command => command.name))
  } catch {
    // Unknown: a leading /word counts as a command.
  }
  return isRealPrompt(e.text, e.origin, names === null ? undefined : name => names.has(name))
}

function forget(note: PendingPrompt) {
  pending = pending.filter(one => one !== note)
}

/** Back to a blank band: a /clear started a fresh conversation. */
async function resetSession($: Dollar) {
  stopTicker()
  hideTimer?.cancel()
  hideTimer = null
  pending = []
  unclaimedTurn = null
  pendingImages = []
  await update($, jobAtom, () => null)
  await update($, imageAtom, () => null)
}

// -------------------------------------------------------------------------
// The status line, cleared after a while (only while a line is showing)

function showStatus($: Dollar, text: string, ms: number) {
  statusGeneration++
  const generation = statusGeneration
  $.ui.status(text)
  statusTimer?.cancel()
  statusTimer = $.clock.after(ms, () => {
    statusTimer = null
    if (generation === statusGeneration) $.ui.status(undefined)
  })
}

// -------------------------------------------------------------------------
// Images

async function takeImages($: Dollar, content: readonly unknown[]) {
  const names = pendingImages
  pendingImages = []
  const settings = await read($, settingsAtom)
  if (!settings.isOn || !settings.preview) return
  const now = await $.clock.now()
  let image: StudioImage | null = null
  let index = 0
  for (const block of content) {
    const found = imageFromBlock(block, names[index]?.filename, now)
    if (found !== null) {
      image = found
      index++
    }
  }
  if (image === null) {
    const last = names.at(-1)
    if (last === undefined) return
    image = imageFromAttachment(last.filename, last.mediaType, now)
  }
  await update($, imageAtom, () => image)
  const surfaces = await $.session.surfaces()
  const action = imageAction({
    isOn: true,
    hasTerminal: surfaces.includes('terminal'),
    isFullscreen,
    canDraw: image.png !== null,
  })
  const line = statusLine(image)
  if (action === 'pane') {
    const opened = await $.ui.open({ id: PANE_IMAGE, title: 'Image' })
    if (!opened.isPlaced) {
      // No room for a sidebar now: no pane waiting to pop up later, the status line says it, /preview shows it.
      await $.ui.close({ id: PANE_IMAGE }).catch(() => undefined)
      showStatus($, line, 10_000)
    }
  } else if (action === 'status') {
    showStatus($, line, 10_000)
  }
}

function statusLine(image: StudioImage): string {
  const parts = ['image attached']
  if (image.width !== null && image.height !== null) parts.push(`${image.width}×${image.height}`)
  if (image.bytes > 0) parts.push(formatBytes(image.bytes))
  else parts.push(image.name)
  return parts.join(' · ')
}

// -------------------------------------------------------------------------
// Skins

function setSkinsNote($: Dollar, note: string, tone: StudioTone, canOpenTheme = false): Promise<StudioSkins> {
  return update($, skinsAtom, skins => ({ ...skins, note, tone, canOpenTheme }))
}

async function loadSkins($: Dollar, note: string, tone: StudioTone, canOpenTheme = false) {
  const rows = await $.config.list()
  const found = themesFrom(rows)
  const skins: StudioSkins =
    found === null
      ? { ...EMPTY_SKINS, note: note || 'This build has no theme setting to change.', tone: note ? tone : 'warn' }
      : { themes: found.themes, current: found.current, note, tone, canOpenTheme }
  await update($, skinsAtom, () => skins)
}

/** Where this build reads custom themes: `<config dir>/themes`, with `~` for the home folder when shown. */
async function themesFolder($: Dollar): Promise<{ path: string; shown: string }> {
  const folder = themesFolderFrom((await $.env.get('HOME')) ?? '', (await $.env.get('CLAUDE_CONFIG_DIR')) ?? '')
  if ('error' in folder) throw new Error(folder.error)
  return folder
}

async function useTheme($: Dollar, value: string) {
  try {
    if (value === CUSTOM_VALUE) {
      const folder = await themesFolder($)
      const file = `${folder.path}/${CUSTOM_SLUG}.json`
      // A Gold & Slate file already there may hold the person's own edits: it is used as it is.
      const isKept = await $.fs.exists(file)
      if (!isKept) await $.fs.write(file, customThemeJson())
      const saved = isKept ? `Gold & Slate is already in ${folder.shown} (kept as it is).` : `Saved Gold & Slate to ${folder.shown}.`
      let deny: string | undefined
      try {
        deny = (await $.config.set({ key: 'theme', value })).deny
      } catch (error) {
        deny = shortReason(error)
      }
      if (deny !== undefined) {
        await loadSkins($, `${saved} Pick it in /theme.\nThe theme setting said: ${fit(deny, 200)}`, 'warn', true)
        return
      }
      await loadSkins($, isKept ? 'Theme set to Gold & Slate (your saved file).' : 'Theme set to Gold & Slate.', 'good')
      return
    }
    const answer = await $.config.set({ key: 'theme', value })
    if (answer.deny !== undefined) {
      await setSkinsNote($, `${themeLabel(value)} was refused: ${answer.deny}`, 'warn')
      return
    }
    await loadSkins($, `Theme set to ${themeLabel(value)}.`, 'good')
  } catch (error) {
    await setSkinsNote($, `Couldn't change the theme: ${shortReason(error)}`, 'warn').catch(() => undefined)
  }
}

async function openThemePicker($: Dollar) {
  try {
    await $.ui.close({ id: PANE_SKINS })
    await $.command.run({ command: 'theme' })
  } catch {
    // The pane may be closed already, so the person hears it where they are.
    $.ui.toast('/theme did not open. Type /theme to pick Gold & Slate.')
    await setSkinsNote($, 'Type /theme to pick Gold & Slate.', 'warn').catch(() => undefined)
  }
}

// -------------------------------------------------------------------------
// Browse

function withTimeout<T>($: Dollar, work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = $.clock.after(ms, () => reject(new TimeoutError('timed out')))
    work.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      (error: unknown) => {
        timer.cancel()
        reject(error)
      },
    )
  })
}

async function loadPage($: Dollar, url: string, history: string[]) {
  fetchGeneration++
  const generation = fetchGeneration
  const host = hostOf(url)
  await update($, browseAtom, browse => ({
    ...browse,
    phase: 'loading' as const,
    url,
    host,
    title: host,
    markdown: '',
    error: '',
    history,
    note: '',
    tone: 'muted' as const,
  }))
  let page: Page
  try {
    const response = await withTimeout(
      $,
      $.http.fetch(url, {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml,text/markdown;q=0.9,text/plain;q=0.8,*/*;q=0.5' },
      }),
      FETCH_TIMEOUT_MS,
    )
    page = pageFrom(url, response)
  } catch (error) {
    page = { ok: false, reason: error instanceof TimeoutError ? 'it took longer than 15 seconds' : shortReason(error) }
  }
  if (generation !== fetchGeneration) return
  await update($, browseAtom, browse =>
    page.ok
      ? { ...browse, phase: 'ready' as const, title: page.title, markdown: page.markdown, error: '' }
      : { ...browse, phase: 'error' as const, error: page.reason, markdown: '' },
  )
}

function setBrowseNote($: Dollar, note: string, tone: StudioTone): Promise<StudioBrowse> {
  return update($, browseAtom, browse => ({ ...browse, note, tone }))
}

async function followLink($: Dollar, href: string) {
  try {
    const browse = await read($, browseAtom)
    const target = resolveHref(href, browse.url)
    if (target === null) {
      await setBrowseNote($, 'That link is not a web page, so it stays here.', 'warn')
      return
    }
    if (samePage(target, browse.url)) return
    await loadPage($, target, [...browse.history, browse.url].slice(-50))
  } catch (error) {
    await setBrowseNote($, `Couldn't follow that link: ${shortReason(error)}`, 'warn').catch(() => undefined)
  }
}

async function goBack($: Dollar) {
  try {
    const browse = await read($, browseAtom)
    const previous = browse.history.at(-1)
    if (previous === undefined) return
    await loadPage($, previous, browse.history.slice(0, -1))
  } catch (error) {
    await setBrowseNote($, `Couldn't go back: ${shortReason(error)}`, 'warn').catch(() => undefined)
  }
}

async function retry($: Dollar) {
  try {
    const browse = await read($, browseAtom)
    if (browse.url !== '') await loadPage($, browse.url, browse.history)
  } catch (error) {
    await setBrowseNote($, `Couldn't try again: ${shortReason(error)}`, 'warn').catch(() => undefined)
  }
}

async function sendToClaude($: Dollar) {
  try {
    const browse = await read($, browseAtom)
    if (browse.phase !== 'ready') return
    let draft = ''
    try {
      draft = (await $.prompt.read()).text
    } catch {
      draft = ''
    }
    const text = sendText(browse.title, browse.url, browse.markdown)
    const filled = await $.prompt.fill({ text: `${draftSeparator(draft)}${text}`, mode: 'append' })
    if (!filled.isFilled) {
      await setBrowseNote($, 'The prompt box could not take the page (a dialog may be open). Try again.', 'warn')
      return
    }
    await $.ui.close({ id: PANE_BROWSE })
  } catch (error) {
    await setBrowseNote($, `Couldn't send the page: ${shortReason(error)}`, 'warn').catch(() => undefined)
  }
}

async function copyPage($: Dollar, surface: RenderSurface) {
  try {
    const browse = await read($, browseAtom)
    const copied = await $.ui.copy({ text: browse.markdown, surface })
    await setBrowseNote($, copied.isCopied ? 'Copied the page as Markdown.' : `Couldn't copy: ${copied.reason}.`, copied.isCopied ? 'good' : 'warn')
  } catch (error) {
    await setBrowseNote($, `Couldn't copy: ${shortReason(error)}`, 'warn').catch(() => undefined)
  }
}

function closePane($: Dollar, id: string) {
  void $.ui.close({ id }).catch(() => undefined)
}

export const register: Register = on => {
  // -------------------------------------------------------------------------
  // Session start: settings back from the store, the commands, a clock left running

  on('session.start', async ($, e, next) => {
    try {
      const settings = readSettings(await $.store.get('settings'))
      await update($, settingsAtom, () => settings)
      const job = await read($, jobAtom)
      if (job !== null && job.phase === 'done') await update($, jobAtom, () => ({ ...job, phase: 'hidden' as const }))
      if (isActive(job) && settings.isOn && settings.progress) ensureTicker($)
    } catch {
      // Defaults stand; the mod still works.
    }
    // Each name is written out so the engine can see which commands this module answers.
    const registrations = [
      $.command.register({ name: 'studio', description: 'studio: show its settings, or turn the whole mod on or off', argumentHint: '[on|off]' }),
      $.command.register({ name: 'progress', description: 'studio: the live progress band above the prompt', argumentHint: '[on|off]' }),
      $.command.register({ name: 'skin', description: 'studio: pick a theme and the accent colour of your mods' }),
      $.command.register({ name: 'preview', description: 'studio: show the last image you pasted', argumentHint: '[on|off]' }),
      $.command.register({ name: 'browse', description: 'studio: read a web page in a pane', argumentHint: '<url>' }),
    ]
    // One refused name leaves the others.
    await Promise.allSettled(registrations)
    return next(e)
  })

  // -------------------------------------------------------------------------
  // The job: prompts, turns, tool calls, notifications

  // A prompt of the person's (typed, or a plugin's sent as theirs) is only noted here. Its job starts at
  // the turn.start it raises, so a prompt another hook drops (no turn) never starts or flashes one.
  on('prompt.submit', async ($, e, next) => {
    let note: PendingPrompt | null = null
    try {
      // Submitted while idle: no turn runs and none waits, so a noted prompt that entered and was never
      // claimed went into the turn it was typed over. A later turn with its words is not the person's.
      if (e.turnId === undefined) pending = pending.filter(one => one.inFlight || one.entered === null)
      pendingImages = (e.attachments ?? []).filter(item => item.type === 'image')
      if (await isTracking($)) {
        if (e.turnId !== undefined) {
          // Typed over the turn: a wait it was showing is answered.
          await update($, jobAtom, current => (current !== null && current.phase === 'needs' ? { ...current, phase: 'working' as const, reason: '' } : current))
        }
        if (await startsJob($, e)) {
          note = { typed: e.text, entered: null, inFlight: true }
          pending = [...pending.slice(-(PENDING_CAP - 1)), note]
        }
      }
    } catch {
      // The prompt goes through whatever happened here.
    }
    let entered: PromptSubmitResult
    try {
      entered = await next(e)
    } catch (error) {
      if (note !== null) forget(note)
      throw error
    }
    if (note !== null && pending.includes(note)) {
      note.inFlight = false
      if (entered.drop !== undefined) {
        forget(note)
      } else {
        note.entered = entered.text
        if (unclaimedTurn !== null && unclaimedTurn.trim() === entered.text.trim()) {
          // Its turn already started under the text a hook beneath rewrote it to.
          unclaimedTurn = null
          forget(note)
          await beginJob($, note.typed).catch(() => undefined)
        }
      }
    }
    return entered
  }).catch(($, e, next) => next(e))

  // Main-loop turns only: a subagent's run raises no turn.start.
  on('turn.start', async ($, e, next) => {
    try {
      if (await isTracking($)) {
        const index = claimIndex(pending, e.text)
        const note = pending[index]
        if (note !== undefined) {
          forget(note)
          unclaimedTurn = null
          await beginJob($, note.typed)
        } else {
          unclaimedTurn = pending.some(one => one.inFlight) ? e.text : null
          if (isActive(await read($, jobAtom))) ensureTicker($)
        }
      }
    } catch {
      // Observing only.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (!(await isTracking($))) return next(e)
    const job = await read($, jobAtom)
    if (!isActive(job)) return next(e)
    if (e.agentId !== undefined) {
      // A helper's call: not the job's step, but once it ran, a wait it raised has been answered.
      const ran = await next(e)
      await update($, jobAtom, current =>
        current !== null && current.phase === 'needs' ? { ...current, phase: 'working' as const, reason: '' } : current,
      ).catch(() => undefined)
      return ran
    }
    const tool = String(e.tool)
    const input = e as unknown as Readonly<Record<string, unknown>>
    const step = stepLabel(tool, input)
    const isQuestion = tool === 'AskUserQuestion'
    await update($, jobAtom, current => {
      if (current === null) return current
      const moved = beforeTool(current, step)
      return isQuestion ? needsYou(moved, questionReason(input)) : moved
    })
    ensureTicker($)
    const ran = await next(e)
    try {
      const isFailure = ran.isError === true
      const isDenied = ran.deny !== undefined
      const result: unknown = ran.result
      await update($, jobAtom, current => {
        if (current === null) return current
        // A refused call is neither a failure nor a success: the Stuck count stands.
        if (isDenied) return afterDeny(current, step)
        let todos = current.todos
        if (!isFailure) {
          if (tool === 'TodoWrite') todos = todosFromTodoWrite(input.todos) ?? todos
          else if (tool === 'TaskCreate') todos = addTask(todos, typeof input.subject === 'string' ? input.subject : '', result)
          else if (tool === 'TaskUpdate') todos = updateTask(todos, input)
          else if (tool === 'TaskList') todos = todosFromTaskList(result) ?? todos
        }
        return afterTool({ ...current, todos }, isFailure, step)
      })
    } catch {
      // The tool's answer stands whatever happened here.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    try {
      // A helper's permission prompt holds the job up too, so it counts.
      if (await isTracking($)) {
        const reason = needsReason(e.message, e.notification_type)
        if (reason !== null) await update($, jobAtom, job => (job !== null ? needsYou(job, reason) : job))
      }
    } catch {
      // Observing only.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)
    try {
      if (e.agentId === undefined) {
        unclaimedTurn = null
        const job = await read($, jobAtom)
        if (isActive(job)) {
          const now = await $.clock.now()
          const ended = endJob(job, e.reason, now)
          await update($, jobAtom, current => (current !== null ? endJob(current, e.reason, now) : current))
          await update($, tickAtom, () => now)
          stopTicker()
          if (ended.phase === 'done') {
            hideTimer?.cancel()
            hideTimer = $.clock.after(5000, () => {
              void hideDone($).catch(() => undefined)
            })
          }
        }
      }
    } catch {
      // The answer stands.
    }
    return answer
  }).catch(($, e, next) => next(e))

  // A /clear ends the conversation without a new session.start: its band and image go with it.
  on('session.end', async ($, e, next) => {
    try {
      await resetSession($)
    } catch {
      // Ending goes on.
    }
    return next(e)
  })

  // -------------------------------------------------------------------------
  // Images: the person's prompt row carries the pasted bytes

  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined) {
      const content = e.message.content
      void (async () => {
        try {
          await takeImages($, content)
        } catch {
          // A preview that fails costs nothing else.
        }
      })()
    }
    return stored
  }).catch(($, e, next) => next(e))

  // -------------------------------------------------------------------------
  // Commands: each answers at once; panes open in the background

  // Any slash command the person runs says whether the terminal docks panes (fixed for the session);
  // the image preview opens a pane unasked only then. It reads and passes every command on.
  on('command.run', ($, e, next) => {
    noteScreen(e)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'studio' }, async ($, e) => {
    try {
      noteScreen(e)
      const word = parseSwitch(e.args)
      if (word === null) return { text: 'Use /studio, /studio on or /studio off.' }
      if (word === 'on' || word === 'off') {
        const isOn = word === 'on'
        void (async () => {
          try {
            await saveSettings($, settings => ({ ...settings, isOn }))
            if (!isOn) {
              stopTicker()
              statusTimer?.cancel()
              statusTimer = null
              $.ui.status(undefined)
            } else if (isActive(await read($, jobAtom))) {
              ensureTicker($)
            }
          } catch {
            $.ui.toast('studio could not save that switch.')
          }
        })()
        return { text: isOn ? 'studio is on.' : 'studio is off: no band, no previews. /studio on brings it back.' }
      }
      const settings = await read($, settingsAtom)
      const state = (flag: boolean) => (flag ? 'on' : 'off')
      return {
        text:
          `studio is ${state(settings.isOn)} · progress band ${state(settings.progress)} · ` +
          `image preview ${state(settings.preview)} · accent ${ACCENTS[settings.accent].label}. ` +
          'Commands: /progress, /skin, /preview, /browse <url>.',
      }
    } catch {
      return { text: 'The studio command failed. Nothing was changed.' }
    }
  }).catch(() => ({ text: 'The studio command failed. Nothing was changed.' }))

  on('command.run', { command: 'progress' }, async ($, e) => {
    try {
      noteScreen(e)
      const word = parseSwitch(e.args)
      if (word === null) return { text: 'Use /progress on or /progress off.' }
      if (word === '') {
        const settings = await read($, settingsAtom)
        return { text: `The progress band is ${settings.progress ? 'on' : 'off'}. /progress ${settings.progress ? 'off' : 'on'} changes it.` }
      }
      const progress = word === 'on'
      void (async () => {
        try {
          await saveSettings($, settings => ({ ...settings, progress }))
          if (!progress) stopTicker()
          else if (isActive(await read($, jobAtom))) ensureTicker($)
        } catch {
          $.ui.toast('studio could not save the progress switch.')
        }
      })()
      return { text: progress ? 'The progress band is on.' : 'The progress band is off.' }
    } catch {
      return { text: 'The progress command failed. Nothing was changed.' }
    }
  }).catch(() => ({ text: 'The progress command failed. Nothing was changed.' }))

  on('command.run', { command: 'skin' }, ($, e) => {
    try {
      noteScreen(e)
      void (async () => {
        try {
          await loadSkins($, '', 'muted')
          const opened = await $.ui.open({ id: PANE_SKINS, title: 'Skins' })
          if (!opened.isPlaced) $.ui.toast(`The skins pane is waiting: ${opened.reason}`)
        } catch (error) {
          $.ui.toast(`The skins pane could not open: ${shortReason(error)}`)
        }
      })()
      return { text: 'Opening skins.' }
    } catch {
      return { text: 'The skin command failed. Nothing was changed.' }
    }
  }).catch(() => ({ text: 'The skin command failed. Nothing was changed.' }))

  on('command.run', { command: 'preview' }, async ($, e) => {
    try {
      noteScreen(e)
      const word = parseSwitch(e.args)
      if (word === null) return { text: 'Use /preview, /preview on or /preview off.' }
      if (word === 'on' || word === 'off') {
        const preview = word === 'on'
        void saveSettings($, settings => ({ ...settings, preview })).catch(() => {
          $.ui.toast('studio could not save the preview switch.')
        })
        return { text: preview ? 'Image preview is on.' : 'Image preview is off.' }
      }
      const image = await read($, imageAtom)
      if (image === null) return { text: 'No image yet. Paste one into a prompt, then /preview shows it.' }
      const isTerminal = e.origin.kind === 'composer'
      if (isTerminal && image.png !== null) {
        void (async () => {
          try {
            const opened = await $.ui.open({ id: PANE_IMAGE, title: 'Image' })
            if (!opened.isPlaced) $.ui.toast(`The image pane is waiting: ${opened.reason}`)
          } catch (error) {
            $.ui.toast(`The image pane could not open: ${shortReason(error)}`)
          }
        })()
        return { text: `Showing ${imageLine(image)}.` }
      }
      const why = !isTerminal
        ? ''
        : image.mediaType === 'image/png'
          ? ' (too large for the terminal to draw)'
          : ' (the terminal draws PNG pictures only)'
      return { text: `Last image: ${imageLine(image)}${why}.` }
    } catch {
      return { text: 'The preview command failed. Nothing was changed.' }
    }
  }).catch(() => ({ text: 'The preview command failed. Nothing was changed.' }))

  on('command.run', { command: 'browse' }, ($, e) => {
    try {
      noteScreen(e)
      const url = normalizeUrl(e.args)
      if (url === null) return { text: 'Type a full web address, like /browse docs.python.org.' }
      const host = hostOf(url)
      void (async () => {
        try {
          const loading = loadPage($, url, []).catch(() => undefined)
          const opened = await $.ui.open({ id: PANE_BROWSE, title: host })
          if (!opened.isPlaced) $.ui.toast(`The browser pane is waiting: ${opened.reason}`)
          await loading
        } catch (error) {
          $.ui.toast(`Couldn't open ${host}: ${shortReason(error)}`)
        }
      })()
      return { text: `Opening ${host}…` }
    } catch {
      return { text: 'The browse command failed. Nothing was changed.' }
    }
  }).catch(() => ({ text: 'The browse command failed. Nothing was changed.' }))

  // -------------------------------------------------------------------------
  // Drawing: reads only

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const settings = await read($, settingsAtom)
    if (!settings.isOn || !settings.progress) return next(e)
    const job = await read($, jobAtom)
    const tick = await read($, tickAtom)
    const columns = Math.max(1, e.props.bodyColumns)
    if (bandModel(job, tick, columns, e.props.maxRows) === null) return next(e)
    // The band beneath (another plugin's) keeps its rows; studio's takes what is left of maxRows.
    const below = await next(e)
    const room = e.props.maxRows - treeRows(below)
    const model = room >= 1 ? bandModel(job, tick, columns, room) : null
    if (model === null) return below
    const { Box } = $.ui.resolve(e)
    // `below` is often core's own node, which the engine refuses under a Box with a size, position,
    // display or overflow prop: this wrapper has none, and the band keeps its width on its own Box.
    return (
      <Box flexDirection="column">
        {drawBand($.ui.resolve(e), model, columns, accentHex(settings))}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_SKINS }, async ($, e) => {
    const skins = await read($, skinsAtom)
    const settings = await read($, settingsAtom)
    const columns = Math.max(1, e.props.bodyColumns)
    return drawSkins($.ui.resolve(e), skins, settings, columns, {
      use: value => void useTheme($, value),
      accent: accent => void saveSettings($, current => ({ ...current, accent })).catch(() => undefined),
      openTheme: () => void openThemePicker($),
      close: () => closePane($, PANE_SKINS),
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE_IMAGE }, async ($, e) => {
    const image = await read($, imageAtom)
    const settings = await read($, settingsAtom)
    const columns = Math.max(1, e.props.bodyColumns)
    const bodyRows = e.props.scroll?.bodyRows ?? 24
    const close = () => closePane($, PANE_IMAGE)
    if (e.surface === 'terminal') {
      const kit = $.ui.resolve(e)
      return drawImagePane(kit, kit.Image, image, columns, bodyRows, accentHex(settings), close)
    }
    return drawImagePane($.ui.resolve(e), null, image, columns, bodyRows, accentHex(settings), close)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_BROWSE }, async ($, e) => {
    const browse = await read($, browseAtom)
    const settings = await read($, settingsAtom)
    const columns = Math.max(1, e.props.bodyColumns)
    return drawBrowse($.ui.resolve(e), browse, columns, accentHex(settings), {
      back: () => void goBack($),
      send: () => void sendToClaude($),
      copy: press => void copyPage($, press.surface),
      retry: () => void retry($),
      close: () => closePane($, PANE_BROWSE),
      link: href => void followLink($, href),
    })
  })
}
