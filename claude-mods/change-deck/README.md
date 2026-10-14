# change-deck

See exactly what Claude changed, in order, file by file, and undo a single edit safely.

Every time Claude (or one of its helpers) edits a file with the Edit, Write or
NotebookEdit tool, change-deck reads the file just before and just after the
edit and keeps both. `/changes` opens a pane that replays those edits one at a
time as a diff, beside a tree of the files they touched.

## Install

```
claude plugin marketplace add ~/claude-mods-src/claude-mods
claude plugin install change-deck@genkigai-coding-mods
```

The marketplace folder is `claude-mods/` in this repository; its README says how to get it onto your computer.

## Commands

| Command | What it does |
| --- | --- |
| `/changes` | Opens the changes pane. |
| `/changes clear` | Forgets this session's record (asks nothing) and removes the saved copies it named. |
| `/changes off` | Stops recording edits. Kept across sessions. |
| `/changes on` | Starts recording again. |

## The pane

- **Title**: `CHANGES`, with `14 edits · 6 files` on the right.
- **Tiles**: Edits, Files, and Lines (`+120` in green; the removed count sits
  beside it in muted grey when both fit big, else in the label line).
- **Files**: a tree of the files, folders first, single-child folder chains
  collapsed (`src/components/`). Each file shows `A` (created this session,
  green) or `M` (edited, gold) and `+12 −3`.
  - The two modes are slate chips, the chosen one marked `●` (`● Touched`,
    `○ Project`), so `Next ›` stays the one gold chip.
  - `Touched` (default): only the files changed this session.
  - `Project`: every file from `git ls-files` (tracked and untracked but not
    ignored, first 3,000), or, outside git, a walk of the folders (first 2,000
    entries, skipping `node_modules`, `.git`, `dist`, `build`). Folders start
    closed; press one to open it. Touched files keep their letter and counts.
  - Press a file to replay only its edits; press it again to see all.
- **Replay**: `Edit 7 of 14 · Edit · src/app.js`, then
  `2m ago · by helper "Fix tests" · turn 3`, then the buttons, then the diff.
  A helper whose task has no name the session can still see (a workflow's
  agents, one that finished long ago) shows as `by a helper`. A long path is
  cut in the middle so the file name stays (`/root/…/hooks/logic.ts`).
  The buttons sit above the diff so a long diff never pushes them away:
  - `‹ Prev`, `Next ›`, `Latest` move through the edits (Latest follows new ones).
  - `Revert this edit` puts the file back to how it was before that edit.
  - `Ask Claude about this` puts the edit's diff (up to 60 lines) in the prompt
    box and closes the pane, so you can ask about it. For a file over 1 MB it
    says the edit's texts were not kept instead. If prompt-upgrade's automatic
    mode is on, it may take the prompt into its own pane when you send it;
    start the prompt with `>` to send it straight.
  - `Close`.
- Long diffs show the hunks that fit and a `Show all N lines` chip (N counts
  the diff's lines, not its `@@` headers).
- Wide panes (100 columns or more) put the tree on the left and the replay on
  the right; narrow ones stack them, the tree showing at most 8 rows and `+N more`.
  Below 24 columns the pane only asks to be widened.

### Reverting safely

Revert only works while the file still holds exactly what that edit left. It
reads the file when you press:

1. First press arms it: `Press again to revert src/app.js to before edit 7`.
2. A second press within 10 seconds writes the old text back, and the revert
   is recorded as its own entry (`Revert`, by you), so it can be undone too.

If the file changed after that edit, it says so and changes nothing. An edit
that created a file is never undone by deleting it: it tells you to delete the
file yourself if you want it gone. A file that is not UTF-8 text (Latin-1,
UTF-16, binary) is shown as read but never reverted, since writing it back
would not restore its bytes.

## What is not recorded

- Changes made by shell commands (`sed -i`, `git checkout`, formatters,
  code generators): only the Edit, Write and NotebookEdit tools are watched.
  This build has no MultiEdit tool, so none is watched.
- Edits Claude makes on an attached remote machine.
- Edits whose file could not be read at all. Files over 1 MB are listed, but
  marked too large to replay, and cannot be reverted here.
- Anything while recording is off.

## Where the data lives

- The texts of each edit: `~/.claude/mod-data/change-deck/<session-id>/<n>.json`.
- The light index the pane draws from: the session's own state. It survives a
  reload of the mod; a new or resumed session starts its own record.
- The on/off switch: the mod's own store.
- At each session start, session folders older than 7 days are removed with
  the system's `rm`; where there is no `rm` (Windows) their saved copies are
  emptied instead, so they take no space.
- The index keeps the last 1,000 edits; the saved copy of an older one is
  removed as it falls off.
- A session's saved copies are kept under about 200 MB: past that, the oldest
  are let go first (their edits stay listed, but can no longer be shown or
  reverted).

## Limits

- The lines a file shares at its start and end are set aside first, so a small
  edit to a long file shows as a small diff. A changed stretch over 5,000 lines
  on either side is shown as replaced whole.
- A change whose middle differs by more than 1,500 lines is shown as that
  middle replaced whole.
- A diff line over 1,000 characters (minified code, one-line JSON) is cut with
  `…`.

## Turning it off

- `/changes off` stops recording; `/changes on` starts it again.
- To remove the mod entirely, disable or delete the `change-deck` plugin folder.
