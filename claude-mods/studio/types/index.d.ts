// The values studio keeps in `$.state` for its drawings. Self-contained: no imports.

/** One step of Claude's to-do list, as the to-do tools last described it. */
export type StudioTodo = { id: string; name: string; status: 'pending' | 'in_progress' | 'completed' }

/** Where a job stands: running, waiting on the person, failing, ended by Esc or an error, finished, or put away. */
export type StudioPhase = 'working' | 'needs' | 'stuck' | 'stopped' | 'done' | 'hidden'

/** One job: what the person asked for in one prompt, from that prompt to the end of its turn. */
export type StudioJob = {
  name: string
  startedAt: number
  endedAt: number | null
  phase: StudioPhase
  /** The current step in plain words: `Edit app.js`, `Bash npm test`, `Thinking`. */
  step: string
  /** Why it waits (needs) or what went wrong (stuck, stopped). */
  reason: string
  /** Failed tool calls in a row. */
  failures: number
  todos: StudioTodo[]
}

export type StudioAccent = 'gold' | 'teal' | 'violet' | 'coral'

export type StudioSettings = {
  /** The mod's own switch: off, studio draws nothing and leaves every event alone. */
  isOn: boolean
  progress: boolean
  preview: boolean
  accent: StudioAccent
}

/** The latest image the person attached to a prompt. `png` holds the bytes only when the terminal can draw them. */
export type StudioImage = {
  name: string
  mediaType: string
  bytes: number
  width: number | null
  height: number | null
  png: string | null
  at: number
}

export type StudioTone = 'good' | 'warn' | 'muted'

export type StudioTheme = { value: string; label: string; isCustom: boolean }

export type StudioSkins = {
  themes: StudioTheme[]
  current: string
  note: string
  tone: StudioTone
  /** True after a custom theme was saved but the theme row would not take it: offer /theme. */
  canOpenTheme: boolean
}

export type StudioBrowse = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  url: string
  host: string
  title: string
  markdown: string
  error: string
  history: string[]
  note: string
  tone: StudioTone
}

declare module 'claude-code' {
  interface PluginState {
    studio: {
      job: StudioJob | null
      tick: number
      settings: StudioSettings
      image: StudioImage | null
      skins: StudioSkins
      browse: StudioBrowse
    }
  }
}
