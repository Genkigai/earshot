// safety-net: the few outside calls the Bin, the measuring and Mod Check need.
// register.tsx implements this with `$` (the engine follows `$` only within the hooks module);
// every method answers null or false instead of throwing.

import type { FsEntry, FsStat, ModelCompleteRequest, ModelCompleteResult, ProcessRunInit, ProcessRunResult } from 'claude-code'

export type Io = {
  /** Stat with the real path resolved; null when missing. */
  stat: (path: string) => Promise<FsStat | null>
  /** A folder's entries; null when it can't be listed. */
  list: (path: string) => Promise<FsEntry[] | null>
  read: (path: string) => Promise<string | null>
  /** Writes the whole file, making folders; false when it failed. */
  write: (path: string, text: string) => Promise<boolean>
  exists: (path: string) => Promise<boolean>
  /** Runs argv with no shell; null when it could not start or ran past its time. */
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult | null>
  now: () => Promise<number>
  complete: (request: ModelCompleteRequest) => Promise<ModelCompleteResult | null>
}
