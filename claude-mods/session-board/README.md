# session-board

Every Claude Code session on this computer, with a timer on each. You can see which sessions are waiting on you, which are working, and which are done. When two sessions work in the same project, each one knows which files the other changed, so they don't undo each other's work.

## What it does

- **Heartbeats.** Each session writes one small file about itself: project, branch, title, state, what it is doing now, the files inside its project that it edited in the last 30 minutes, and its helpers. Files outside the project folder are never recorded. The file is written when the state changes (at most once every 3 seconds), every 30 seconds while the session works or waits, and every 2 minutes while it is idle. The file is removed when the session ends.
- **States.** A turn starts: *working*. A permission prompt or a question to you: *waiting* ("needs your OK to run a command", "asked you a question"). The session stays *waiting* until the call that is held up finishes. Another call that was already running beside it can finish without ending the waiting, and so can a main-loop call that starts while the prompt is still up. With no held-up call to follow, the next tool call ends the waiting. When more than one is up at once (a question to you and a helper's permission prompt, say), answering one leaves the session *waiting* with the reason of the one still open. The turn ends: *idle*, shown as done.
- **Title.** The first real prompt of the session, cut to about 40 characters at a word boundary. Slash commands are skipped. Until then the title is "New session". A resumed session takes its title from its first prompt. A prompt that another mod sends as your own words (prompt-upgrade's Run, for example) counts as yours.
- **Alive or quiet.** A session is alive if its last heartbeat is under 5 minutes old. Older than that, it is listed dim under "Went quiet" for up to 24 hours. Files older than 24 hours are removed when a session starts.
- **Status line.** `◆ 1 waiting · 2 working` counts the *other* live sessions. Each session counts once, under the same heading as on the board: a waiting session counts as waiting even while its helpers work, and an idle one with helpers at work counts as working. It is cleared when no other session is working or waiting.
- **Same-folder notes.** When another live session in the same project root edited files in the last 30 minutes, your prompt carries a short note for the model: that session's title, its state and branch, and those files, with a request to leave them alone or re-read them first. A session that edited nothing gets no note. The same note is not sent again while nothing changes, until 10 minutes have passed. Prompts that another mod sends as your own words get the note too. Claude reads the note; you never see it.
- **Edit conflicts.** If this session is about to edit a file that the other session edited in the last 10 minutes, the edit still runs. The model gets a note ("session "Fix login bug" edited this file 3 minutes ago"), and you get one toast per file per session: "Heads up: the other session in earshot edited src/app.ts 3m ago." After a `/clear`, the new session gets its own toasts.

## Install

Once this folder is published as a GitHub repository with a `.claude-plugin/marketplace.json` that lists it, install it by typing this at the prompt of a terminal session (answer `y` to add the marketplace, then pick a scope):

```
claude plugin marketplace add ~/claude-mods-src/claude-mods
claude plugin install session-board@genkigai-coding-mods
```

Pick the user scope so every session runs it: a session only shows up on the board once it writes its own heartbeat. The marketplace folder is `claude-mods/` in this repository; its README says how to get it onto your computer.

## Commands

- `/sessions` opens the board. It runs even while a turn is working.
- `/sessions off` stops this session's heartbeat, status line and same-folder notes, and removes its file. It also stops the branch read (`git branch`) at each turn. The choice is saved, so new sessions also start off until you turn it back on.
- `/sessions on` turns everything back on.

## The board

- The title row shows `S E S S I O N S` and, on the right, `3 running · 1 waiting`. On a narrow pane only the waiting count is shown.
- Three tiles: **Waiting on you** (amber), **Working** (green), **Done** (muted).
- **Waiting on you** comes first: `‖ project · title · reason · 1:12`. The timer counts from when the waiting began.
- **Working**: `▶ project · branch · title · current step · 4:05`. The timer counts from the start of the turn. It does not restart after you approve a permission prompt.
- A session whose main loop is done but whose helpers still work (a workflow's agents, for example) is listed under Working as `▶ project · branch · title · 2 helpers working`.
- **Done**: `✓ project · title · finished 4m ago`. A session that has not run a turn yet shows `○ … · opened 4m ago`.
- **Went quiet**: sessions whose heartbeat stopped, shown dim.
- This session is marked `(this one)`. Press any other session's row to copy `claude --resume <id>` (an unusual id is quoted), and the board shows "Copied the resume command for <project>.". If that session is in a different folder, the copied command starts with `cd <folder> &&`, because `--resume` only finds a session from its own folder. If copying is not possible, the board shows the command so you can copy it yourself.
- **This session's helpers**: one card per subagent, teammate or workflow agent, two or three per row: `● Fix tests 1:12`, `✓ Read docs 0:41`, `■ Lint failed`. A queued helper is dim. If there are none: "No helpers running."
- The board updates every 2 seconds while it is open, and stops updating when you close it. While the pane waits for room to be drawn, it only checks every 15 seconds whether it has been placed.
- If no absolute home folder is set (`HOME`), nothing is written or read, and the board says "No home folder, so sessions cannot be shared." in place of the empty-state line.

## Where data lives

- Heartbeats: `~/.claude/mod-data/session-board/sessions/<session-id>.json`, one file per running session. They hold your first prompt and the start of the current command, so the `sessions` folder is set to `chmod 700` (only you can open it) after the first write.
- The on/off switch: this mod's own `$.store` (key `isOn`).
- Nothing is written inside the mod's folder.

## Turning it off

- `/sessions off` (this session now, and new sessions after it).
- Or remove or disable the `session-board` plugin.

## Limits of this build

- `$.session.repo()` does not report a branch, so the branch comes from `git branch --show-current`, read when the session starts and at each turn start.
- There is no file-delete call, so heartbeat files are removed with `rm -f`. Where `rm` is missing (plain Windows), the file is marked `ended` instead, and the other sessions ignore it.
- `$.agent.list()` does not say when a helper started. Helper timers count from the Agent call or spawn this session saw, or from when the board first listed the helper. A helper that was already finished when the board first saw it reads `done`.
- `$.agent.list()` never lists a workflow's agents. The board adds them when they start and marks them done when they answer. If one goes 15 minutes with no answer and no tool call, it is taken as finished.
- A failed or stopped helper is marked `■` rather than the spec's `✕`, which is not in the board's glyph set.
- "Waiting" relies on the classic Notification event (`permission_prompt`, `elicitation_dialog`) and on AskUserQuestion calls. A permission prompt that raises no notification shows as working. This build raises no event when you approve a prompt, so the session stays waiting until the approved call finishes. For a long command, that means it shows waiting while the command runs.
- Liveness comes only from heartbeats. A session that was killed shows as "went quiet" after 5 minutes.
