// What prompt-upgrade keeps in $.state for its drawings.

/** Where an upgrade stands. `idle` and `compose` draw the "type a prompt" screen. */
export type UpgradeStep =
  | 'idle'
  | 'compose'
  | 'questions-loading'
  | 'questions'
  | 'rewrite-loading'
  | 'review'
  | 'error'

/** One multiple-choice question from the fast model. */
export type UpgradeQuestion = { question: string; options: string[] }

/** The person's answer to one question; null while unanswered. */
export type UpgradeAnswer = { kind: 'option'; text: string } | { kind: 'other'; text: string } | { kind: 'skip' } | null

/** Which model call failed, and a calm sentence about why. */
export type UpgradeError = { stage: 'questions' | 'rewrite'; message: string }

/** The one upgrade in progress, drawn by the pane. */
export type UpgradeFlow = {
  step: UpgradeStep
  original: string
  questions: UpgradeQuestion[]
  answers: UpgradeAnswer[]
  /** The question whose "Other (type it)" field is open. */
  otherOpen: number | null
  upgrade: string
  added: string[]
  error: UpgradeError | null
  startedAt: number
  /** Bumped at every new model call and every reset: a result applies only while it is current. */
  requestSeq: number
  editing: boolean
  /** The history entry this upgrade was saved as, once it reached Review. */
  historyId: string | null
  /** True when the review was reopened from history (Cancel then leaves the prompt box alone). */
  fromHistory: boolean
  /** A one-line note drawn at the top of the pane (a refused second prompt); cleared at the next step. */
  notice: string | null
}

/**
 * One upgrade in the history (newest first, at most 20). Persisted in $.store under "history".
 * `upgrade` is empty for an original saved before its rewrite arrived. `sent` is true once
 * Run sent it, false while it was not sent, absent on entries saved by an older version.
 */
export type UpgradeEntry = { id: string; at: number; original: string; upgrade: string; added: string[]; sent?: boolean }

/** What the person has typed in the pane's fields, so a reload or a close never loses it. */
export type UpgradeDrafts = {
  /** The `/better` field's text. */
  compose: string
  /** The Edit field's text, for the flow whose requestSeq is `seq`. */
  edit: { seq: number; text: string } | null
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': {
      flow: UpgradeFlow
      /** Automatic mode. Persisted in $.store under "isOn". */
      isOn: boolean
      history: UpgradeEntry[]
      /** Texts the mod itself is sending: let through once, never intercepted. */
      passOnce: string[]
      /** Typed in the pane's fields; read by handlers only, never by a drawing. */
      drafts: UpgradeDrafts
    }
  }
}
