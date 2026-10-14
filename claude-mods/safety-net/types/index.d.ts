// What safety-net keeps in $.state for its drawings.

/** The two switches. Persisted in $.store under "settings". */
export type SafetySettings = { blastRadius: boolean; safeDelete: boolean }

/** One time safety-net stepped in: asked first, stopped a command, or sent files to the Bin. */
export type SafetyCatch = { at: number; summary: string; outcome: string }

/** One Bin batch as the panes draw it. */
export type BinBatchView = {
  id: string
  at: number
  names: string[]
  count: number
  bytes: number
}

/** The Bin as last read from disk. `asOf` is when, for "2h ago". */
export type BinView = { asOf: number; batches: BinBatchView[]; note: string }

/** One capability row of a Mod Check. */
export type ModCheckCap = { cap: string; label: string; count: number; sample: string }

/** One finding worth a closer look, with where it is. */
export type ModCheckRow = { where: string; text: string }

/** The Mod Check pane's whole state. */
export type ModCheckView = {
  status: 'idle' | 'working' | 'done' | 'failed'
  name: string
  version: string
  source: string
  step: string
  verdict: 'safe' | 'closer' | 'dont' | null
  verdictBy: 'model' | 'rules'
  explanation: string
  reasons: string[]
  can: ModCheckCap[]
  closer: ModCheckRow[]
  validator: string[]
  validatorOk: boolean
  error: string
  filesRead: number
  /** Files that could run or steer Claude and were not read in full: the scan was partial. */
  unread: string[]
  report: string
}

declare module 'claude-code' {
  interface PluginState {
    'safety-net': {
      settings: SafetySettings
      catches: SafetyCatch[]
      bin: BinView
      modcheck: ModCheckView
      mode: string
    }
  }
}
