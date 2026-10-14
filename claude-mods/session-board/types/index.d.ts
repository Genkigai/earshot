// The values session-board keeps in $.state, and the heartbeat file's shape.

/** Where a session stands: answering, held up on the person, or done for now. */
export type SessionBoardState = 'working' | 'waiting' | 'idle' | 'ended'

/** One file this session edited, relative to its project root. */
export type SessionBoardEdit = { path: string; at: number }

/** One helper (subagent or teammate) of a session. */
export type SessionBoardHelper = {
  id: string
  description: string
  startedAt: number
  status: string
  endedAt?: number
  /** A workflow's agent: `$.agent.list()` never names it, so it ends at its own turn.complete. */
  isUnlisted?: boolean
}

/** One session's heartbeat, as written to `<session-id>.json`. */
export type SessionBoardBeat = {
  v: 1
  id: string
  root: string
  project: string
  branch: string
  title: string
  state: SessionBoardState
  waitingReason?: string
  startedAt: number
  stateSince: number
  lastBeat: number
  currentStep?: string
  /** When the current turn started working; the Working timer counts from here. */
  workingSince?: number
  edits: SessionBoardEdit[]
  helpers: SessionBoardHelper[]
  model: string
}

/** What the pane draws: every session's beat (this one's included) as of `now`. */
export type SessionBoardSnapshot = {
  now: number
  selfId: string
  selfRoot: string
  beats: SessionBoardBeat[]
  helpers: SessionBoardHelper[]
  /** False when no absolute home folder was found, so nothing can be shared. */
  hasHome: boolean
}

/** The one line the pane shows after a press (a copy). */
export type SessionBoardNote = { text: string; at: number; isGood: boolean }

declare module 'claude-code' {
  interface PluginState {
    'session-board': {
      self: SessionBoardBeat | null
      snapshot: SessionBoardSnapshot | null
      note: SessionBoardNote | null
      isOn: boolean
      toasted: string[]
    }
  }
}
