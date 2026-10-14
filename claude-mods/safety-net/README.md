# safety-net

Protects you from destructive shell commands and risky mods without slowing normal work.

## What it does

**Blast radius.** Before Claude runs a Bash command, safety-net reads it (it never runs your text in a shell) and looks for anything that destroys work: `rm`, `rmdir`, `unlink`, `shred`, `find … -delete`, `find … -exec rm`, `xargs rm`, `git clean -f`, `git reset --hard`, `git checkout -- <paths>` / `git checkout .`, `git restore <paths>`, `git stash drop|clear`, `git branch -D`, `git push --force` / `-f` / `--force-with-lease` / `+refspec`, `>` onto a file that has content, `truncate`, `tee` without `-a`, `mv`/`cp` over an existing file, and `dd of=`. It looks inside `sh -c "…"`, `eval`, `$(…)` and scripts handed to a shell on stdin (`bash <<'EOF' … EOF`, `bash <<< '…'`, `echo '…' | sh`, `cat <<EOF | sh`) too, strips `sudo`, `env`, `timeout`, `nice` and variable assignments, and follows `cd dir && …` so later relative paths resolve correctly.

It then measures with quick read-only dry runs (`du -sk`, `find <path> -type f`, `git clean -n`, `git status --porcelain`, `git stash list`, `git log <branch> --not --remotes`, `git rev-list --count HEAD..@{u}`), each capped at 2 seconds and 4 seconds in all.

- **Small** (25 files or fewer, 50 MB or less, all inside the project, and no uncommitted work or unpushed commits lost): it runs. You see a status line such as `blast radius: 3 files, 12 KB`, which clears after 30 seconds.
- **Anything bigger**: safety-net wants your OK, with a plain summary such as "This deletes 1,204 files (48 MB) in node_modules." or "This throws away uncommitted changes in 6 files: app.js, …". A delete that reaches the Bin's own folder (`rm -rf ~/.claude/mod-data`) says that what is in the Bin goes for good too, and a plain `rm` too big for the Bin says it is deleted for good.
  - In the default, accept-edits and plan modes, the engine's own permission prompt opens with that summary as its reason.
  - In bypass and auto modes the engine wouldn't put that prompt to you, so safety-net asks its own question ("Run it" / "Don't run"). If you choose not to run it, Claude is told "… The person chose not to run it."
  - In don't-ask mode nothing can ask you, so the command is refused with the summary.
  - In a headless bypass session with nobody to ask, the command runs and a line goes to the transcript.
- **If measuring fails or takes too long**, the command runs anyway and the status line says `blast radius: couldn't measure`.

**Safe delete (the Bin).** When the whole command is a single plain `rm` on one line (only `-r -R -f -v -d --` and literal paths), safety-net rewrites it as `mkdir -p` plus `mv --` into a new batch folder in the Bin. You still see and approve the real command, and Claude sees its real output plus a note that the files went to the Bin. Each batch's `manifest.json` (`id, at, cwd, command, items[{from, stored, kind, bytes}]`) is written before anything moves. If a name appears twice, the second copy gets `-2`, the third `-3`. With `-f`, missing targets are skipped, as `rm -f` would.

Plain `rm` still runs as written when:
- a path uses shell expansion, or `..` after a folder name (`link/../x`; a leading `../` is fine);
- it uses `-i`;
- it's part of a compound command, or more commands follow on later lines;
- it runs in the background (`run_in_background`);
- a target is over 1 GB, its size can't be told in time, or it is already in the Bin;
- a target is outside your home folder, the project and the temp folders, and you didn't OK it.

**Mod Check.** `/modcheck <folder | owner/repo | git URL>` answers at once, then works in the background:
1. Makes a shallow clone if you gave it a repo.
2. Runs `claude plugin validate`.
3. Reads every `hooks.json` first, then every module they name and every file those modules import, wherever it sits in the folder (up to 1 MB each). Then it reads the rest (manifests, `.mcp.json`, agents, commands, skills, other code) up to 300 KB in all. Only the type files the engine lays in `.claude-plugin/types/` are skipped, unless a module imports one.
4. Scans them for running programs, network calls, file writes, access to your prompts or the conversation, tool-call rewrites, telemetry, changes to settings or environment variables, MCP servers (in `.mcp.json` or inline in `plugin.json`), access to credentials, shell hooks (in `hooks.json` or inline in `plugin.json`), and hidden code. Each finding comes with `file:line`.
5. Asks one fast model call for a plain explanation and a verdict.

If a file that could run or steer Claude was not read in full, the pane says "Partial scan" and names the files in the copied report.

## Install

Once this folder is published as a GitHub repository with a `.claude-plugin/marketplace.json` that lists it, anyone installs it by typing this at the prompt of a terminal session (answer `y` to add the marketplace, then pick a scope):

```
claude plugin marketplace add ~/claude-mods-src/claude-mods
claude plugin install safety-net@genkigai-coding-mods
```

## Commands

| Command | What it does |
|---|---|
| `/safety` | Opens the switches pane: Blast radius and Safe delete (On/Off each), your last 5 catches, and how much is in the Bin. |
| `/safety on` / `/safety off` | Turns both on or off. |
| `/bin` | Opens the Bin, newest first. Each batch has a Restore button. "Empty items older than 14 days" clears old batches. |
| `/undo-delete` | Puts back the newest batch. If something now sits at the old path, the item is restored beside it as `<name>.restored`. |
| `/modcheck <folder \| owner/repo \| git URL>` | Checks a mod before you install it. The result opens in the Mod Check pane, where "Copy report" copies a text version. Where the surface has no clipboard, the report goes to the transcript instead. |

## Settings and data

- The switches and your recent catches are kept in safety-net's own store, and both start on.
- The Bin is `~/.claude/mod-data/safety-net/bin/<YYYYMMDD-HHMMSS-xxxx>/`. Batches older than 14 days are removed when a session starts, but only folders whose real path is inside the Bin. A batch whose move never ran is tidied away too, but only once it is an hour old, since its move may still be waiting on a permission dialog in some session.
- Clones for Mod Check go to `~/.claude/mod-data/safety-net/modcheck/<slug>/`. A new check of the same repo replaces the old clone.
- Nothing is written inside the mod's own folder.

## Turning it off

Run `/safety off` (both checks) or use the On/Off chips in `/safety`. To remove the mod completely, delete its folder. The Bin stays at `~/.claude/mod-data/safety-net/bin/` until you delete it.

## Choices made for you

- **Temp folders count as scratch space, and their deletes are undoable too.** `/tmp`, `/private/tmp`, `/var/tmp` and `$TMPDIR` are treated like the project, so routine temp work doesn't prompt.
  - A plain `rm` of up to 25 files and 50 MB there goes to the Bin with no question. Moving files out of a temp folder may copy them to another disk, which is fine for small ones.
  - Anything bigger asks first with the blast-radius summary, and after your OK it goes to the Bin too (up to 1 GB per item).
  - Deleting a whole temp folder still asks, and runs as `rm`: a temp root is never moved into the Bin.
- **No shell expansion.** safety-net never expands anything the way a shell would (variables, `$(…)`, globs, `~user`).
  - A plain glob inside the project, such as `rm *.log`, runs with the status `blast radius: can't measure: uses shell expansion`.
  - It asks first in three cases: a recursive delete through a variable this command line never set (`rm -rf "$OUT/"`), `rm -rf *` after a `cd` to a folder it can't tell, and a glob that reaches outside the project.
  - `tmp=$(mktemp -d) && rm -rf "$tmp"` does not ask. `${VAR:?}` counts as safe.
- **Untracked files count as work.** `git clean` that would remove untracked files you never committed asks first. `git clean -X` (ignored files only) is measured like any other delete.
- **The scan caps the model's verdict.** Mod Check uses the model's verdict, but it never shows "Looks safe" when the scan alone says "Look closer". That happens when the scan finds hidden code, programs plus network, credentials plus network, or a partial scan. This guards against a mod whose text talks the model into it. If the model can't be reached, the verdict comes from the scan alone.
- **The Bin move must pass both checks.** The rewritten move is checked twice: against your rules for the original `rm`, and by the engine itself (its rules, mode and any PreToolUse hooks you have). The stricter of the two wins. A rule that blocks `rm` still blocks the move, and so does a hook that blocks the move. The cost: where the engine would ask about the move (for example in accept-edits mode, since the Bin is outside the project), you get that prompt even if your rules allow `rm`.
- **Large undos run in the background.** Undoing a batch over 50 MB happens in the background, and a short note appears when it's done.

## Limits of this build (closest honest versions)

- safety-net reads the permission mode from the session's own events: your prompts, the start of a session, and the end of each tool call and turn. If you switch modes in the middle of a turn, it notices when the next tool call finishes. Until the first such event after it loads, it leaves the question to the engine's own prompt.
- The engine's prompt is reached through the `tool.check` verdict. What the dialog draws comes from the engine and was not seen in tests.
- Bash calls sent to an attached remote machine (`_host`) are not measured.
