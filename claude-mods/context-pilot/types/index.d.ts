// The context-pilot contract: what this mod keeps in `$.state` under
// `context-pilot`, so other mods can list it under `dependencies` and read it.

/** What the person can change with `/pilot set <name> <value>`. */
export type PilotSettings = {
  /** Auto-handoff: threshold notes to Claude and its helpers. `/pilot on|off`. */
  isAuto: boolean
  /** Main context threshold, percent of the window, that asks for a handoff. */
  mainThreshold: number
  /** A helper running longer than this many minutes is asked to hand off. */
  helperMinutes: number
  /** A helper whose context passes this percent of its window is asked to hand off. */
  helperContext: number
  /** Whether the status line under the prompt is shown. */
  showStatus: boolean
}

/** One rise of the main context between two requests, and what came in between. */
export type PilotBump = {
  /** Tokens added. */
  delta: number
  /** What arrived: `Read app.js`, `Bash npm test`, `Agent "Fix tests"`, `your prompt`. */
  label: string
  /** The main turn it happened in. */
  turn: number
}

/** The last main-loop request, as the API reported its usage. */
export type PilotRequestStat = {
  /** Input side: uncached + cache read + cache written. */
  context: number
  /** Cache hit rate, 0 to 1. */
  hit: number
  /** Tokens read from the prompt cache. */
  read: number
  /** Tokens written to the prompt cache. */
  written: number
  /** Of what was written, tokens that were already in the previous request (a miss). */
  tax: number
  /** Tokens the reply generated. */
  output: number
}

/** Cache totals over the whole session, main loop and helpers together. */
export type PilotTotals = {
  requests: number
  /** Every input token sent: uncached + read + written. */
  input: number
  read: number
  written: number
  /** Cache tax: tokens re-written after a miss, expiry or changed prefix. */
  tax: number
}

/** The measured picture of the session. */
export type PilotSnapshot = {
  /** When the session's figures count from, in `$.clock.now()` milliseconds. */
  sessionStart: number
  /** The main loop's model, as the last request named it. */
  model: string
  /** The main loop's context window in tokens. */
  window: number
  /** Measured main context after the last request, in tokens. */
  context: number
  /** `context` over `window`, 0 to 100 (may pass 100 on a wrong window). */
  percent: number
  /** What the status line's own figure says, when the engine has one. */
  statusPercent: number | null
  /** The session's cost in US dollars, as /cost has it, when known. */
  costUsd: number | null
  /** Main-loop requests measured. */
  requests: number
  /** Main turns seen. */
  turn: number
  /** The last main turn's id. */
  turnId: string | null
  /** Main context per request, oldest first (the last 240). */
  history: number[]
  /** The tool calls the last main response asked for (the next bump's label). */
  pending: string
  /** A prompt or delivery that came in since the last main request: `your prompt`, `task notification`. */
  arrival: string | null
  /** The five biggest rises, biggest first. */
  bumps: PilotBump[]
  /** The last main request. */
  last: PilotRequestStat | null
  /** Session totals over every loop. */
  totals: PilotTotals
  /** Whether the main threshold note may fire again. */
  isArmed: boolean
  /**
   * `measuring`; `handing-off` once Claude was asked; `handed-off` once it
   * saved. `handed-off` lasts until the next main turn; `handing-off` falls
   * back to `measuring` when a second main turn starts with no handoff saved.
   */
  phase: 'measuring' | 'handing-off' | 'handed-off'
  /** The main turn `phase` was last set in. */
  phaseTurn: number
  /** Threshold notes sent this session. */
  notes: number
  /** A handoff from an earlier session waits and no turn has run yet. */
  isWaiting: boolean
  /** When the snapshot last changed. */
  updatedAt: number
}

/** One helper (subagent) loop. */
export type PilotHelper = {
  /** The agent id its steps carry. */
  id: string
  /** The Agent call's short description. */
  description: string
  startedAt: number
  lastAt: number
  /** When its run ended; null while running. */
  endedAt: number | null
  /** Its context after its last request, in tokens. */
  context: number
  window: number
  percent: number
  requests: number
  /** What its last request left in the prompt cache (read + written). */
  cached: number
  /** The Agent call returned at once and the helper runs in the background. */
  isBackground: boolean
  /** The loop whose Agent call started it in the background; null for main. */
  parentId: string | null
  /**
   * It was asked to hand off (once per run). Set when its note is queued, and
   * cleared again if the note never reached it (its run ended first, or the
   * note was refused).
   */
  isWarned: boolean
  /** Why it was asked: `time`, `context` or both. */
  warnedFor: string | null
  /** Where its handoff was saved, once it saved one. */
  handoffPath: string | null
  /** The main loop has been told about its handoff. */
  isReported: boolean
}

/** The latest handoff for this project. */
export type PilotHandoff = {
  path: string
  /** The path with HOME written as `~`, for showing. */
  shownPath: string
  savedAt: number
  title: string
  summary: string
  scope: 'session' | 'helper'
  /** Written before this session started (found at start, not saved now). */
  isFromEarlier: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'context-pilot': {
      snapshot: PilotSnapshot
      settings: PilotSettings
      helpers: PilotHelper[]
      handoff: PilotHandoff | null
      /** The running main turn's id; null while the main loop is idle. */
      busy: string | null
    }
  }
}
