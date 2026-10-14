/** One recorded edit, as the light index in `$.state` keeps it. The texts live in `file`. */
export type ChangeDeckEntry = {
  /** Unique within the session: the entry's sequence number as text. */
  id: string
  /** 1, 2, 3 ... in the order the edits landed. */
  seq: number
  /** When the edit landed, milliseconds since the epoch. */
  at: number
  /** `Edit`, `Write`, `NotebookEdit`, or `Revert` for one this mod made. */
  tool: string
  /** The file's absolute path. */
  path: string
  /** The file's path relative to the project root (absolute when outside it). */
  relPath: string
  added: number
  removed: number
  /** True when the edit created the file. */
  isNew: boolean
  /** True when the file was over 1 MB, so its texts were not kept. */
  isTooLarge: boolean
  /** Who made it: a helper's description, or `you` for a revert; absent for Claude or an unnamed helper. */
  agentLabel?: string
  /** The helper that made it, when one did (named or not). */
  agentId?: string
  /** True when the file was not UTF-8 text, so the kept texts are not exact and it cannot be reverted. */
  isLossy?: boolean
  /** Size of the saved body, in characters. */
  bytes?: number
  /** True when the saved body was let go to keep the session's record under its size cap. */
  isDropped?: boolean
  /** The person's prompt count when the edit landed. */
  turn: number
  /** The JSON file holding `before` and `after`; empty when it could not be kept. */
  file: string
}

/** What the saved body file of an entry holds. */
export type ChangeDeckBody = {
  id: string
  seq: number
  at: number
  tool: string
  path: string
  relPath: string
  before: string | null
  after: string | null
  agentId?: string
  agentLabel?: string
  turn: number
  isTooLarge: boolean
}

export type ChangeDeckMessage = { text: string; tone: 'warn' | 'good' | 'muted' }

/** What the pane shows: the person's place in the replay and the tree. */
export type ChangeDeckView = {
  /** The entry shown; null follows the latest one. */
  cursor: string | null
  /** A file's relPath limiting the replay to its edits; null for all. */
  filter: string | null
  mode: 'touched' | 'project'
  /** Folders opened in Project mode, by path. */
  open: string[]
  /** True shows the whole diff, not just what fits. */
  showAll: boolean
  /** True shows the whole tree, not just its first rows. */
  treeAll: boolean
  /** A revert waiting for its second press, until `until`. */
  armed: { id: string; until: number } | null
  message: ChangeDeckMessage | null
}

/** The project's file list for Project mode. */
export type ChangeDeckProject = {
  paths: string[]
  source: 'git' | 'list' | 'none'
  isCapped: boolean
  /** When the listing started; null when none is running. One older than a minute counts as finished. */
  loadingSince: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'change-deck': {
      entries: ChangeDeckEntry[]
      view: ChangeDeckView
      isOn: boolean
      project: ChangeDeckProject
      seq: number
    }
  }
}
