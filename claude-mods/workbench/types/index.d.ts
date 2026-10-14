// What workbench keeps in $.state for its drawings.

/** One parked idea. Persisted in $.store under `shelf:<project root>`, newest first. */
export type WorkbenchIdea = { id: string; text: string; at: number }

/** The shelf the pane shows: the project it belongs to and its ideas. */
export type WorkbenchShelf = { root: string; ideas: WorkbenchIdea[] }

/** How a line of feedback in a pane is coloured. */
export type WorkbenchTone = 'good' | 'warn' | 'muted'

/** A one-line note a pane shows after an action. */
export type WorkbenchNotice = { text: string; tone: WorkbenchTone }

/** What the shelf pane is in the middle of: an inline edit, a delete waiting for its second press. */
export type WorkbenchShelfUi = {
  editingId: string | null
  armedId: string | null
  notice: WorkbenchNotice | null
}

/** How the person judged one guess; null while unchecked. */
export type WorkbenchMark = 'right' | 'wrong' | 'skip' | null

/** One small guess Claude noted with note_assumption. */
export type WorkbenchGuess = {
  id: string
  text: string
  why: string
  /** How many prompts the person had sent when it was noted. */
  turn: number
  /** The main turn it was noted in ('' when none was running). */
  turnId: string
  at: number
  /** The subagent that noted it; null for the main loop. */
  agentId: string | null
  mark: WorkbenchMark
  correction: string
  /** True once a main turn ended after it was noted: the band has announced it. */
  isAnnounced: boolean
}

/** Where a reflection stands. */
export type WorkbenchReflectStep = 'idle' | 'loading' | 'ready' | 'empty' | 'nothing' | 'error'

/** One suggested CLAUDE.md line. */
export type WorkbenchReflectItem = {
  text: string
  why: string
  keep: boolean
  /** Already in CLAUDE.md (so it starts as Skip). */
  isPresent: boolean
}

/** The reflect pane's whole state. */
export type WorkbenchReflect = {
  step: WorkbenchReflectStep
  /** The CLAUDE.md the lines go into. */
  target: string
  /** True when that file does not exist yet. */
  isNew: boolean
  items: WorkbenchReflectItem[]
  notice: WorkbenchNotice | null
  /** True once the lines were written. */
  isAdded: boolean
  /** Bumped at every new reflection: a late answer applies only while it is current. */
  seq: number
}

declare module 'claude-code' {
  interface PluginState {
    workbench: {
      /** True while a main-loop turn runs (turn.start until turn.complete). */
      isWorking: boolean
      /** The running main turn's id; '' between turns. */
      turnId: string
      shelf: WorkbenchShelf
      shelfUi: WorkbenchShelfUi
      /** Ideas put in the prompt box while Claude worked: removed from the shelf once sent. */
      filled: string[]
      /** Guesses whose corrections were put in the prompt box while Claude worked: cleared once sent. */
      fixFilled: string[]
      /** Assumption Check's switch. Persisted in $.store under "assumeOn". */
      assumeOn: boolean
      guesses: WorkbenchGuess[]
      /** The guesses the band announces (noted before a main turn ended), until it is dismissed. */
      announced: string[]
      assumeNotice: WorkbenchNotice | null
      reflect: WorkbenchReflect
    }
  }
}
