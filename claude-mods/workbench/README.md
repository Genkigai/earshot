# workbench

Three helpers for a coding day, in one mod:

- **Idea Shelf** — park a side-thought while Claude works, without pulling it off the task. Each project has its own shelf, kept after you close Claude Code. Send ideas to Claude later, one at a time or all as one prompt.
- **Assumption Check** — Claude notes the small guesses it makes during a task (a name, a file location, a default, a library, what's in scope). After the turn a band above the prompt says how many; mark each one right or wrong, and the wrong ones go back to Claude to fix.
- **Reflect** — look back over the session and turn what was learned (your corrections, stated preferences, commands that worked, gotchas) into lines for the project's `CLAUDE.md`, under a `## Learned` heading.

## Install

Once this folder is published as a GitHub repository with a `.claude-plugin/marketplace.json` that lists it, install it by typing this at the prompt of a terminal session (answer `y` to add the marketplace, then pick a scope):

```
claude plugin marketplace add ~/claude-mods-src/claude-mods
claude plugin install workbench@genkigai-coding-mods
```

The marketplace folder is `claude-mods/` in this repository; its README says how to get it onto your computer.

## Commands

| Command | What it does |
| --- | --- |
| `/idea <text>` | Parks the idea on this project's shelf and answers at once: "Parked on the shelf (4 ideas for earshot)." Works while Claude is busy; never starts or interrupts a turn. An idea can be up to 4,000 characters. |
| `/ideas` | Opens the **Idea shelf** pane: each idea with **Send**, **Edit** and **Delete** (press Delete twice), plus **Send all as one prompt**. |
| `/assumptions` | Opens the **Assumptions** pane: mark each guess **Right**, **Wrong** or **Skip**, add what's right to a wrong one, then **Send corrections**. **Mark all right** clears the list. |
| `/assumptions on` / `/assumptions off` | Turns Assumption Check on or off (remembered between sessions). On by default. |
| `/reflect` | Asks Claude, over this session's own transcript, for up to 6 lasting `CLAUDE.md` lines. They open in the **Reflect** pane: **Keep** or **Skip** each, then **Add N lines to CLAUDE.md** or **Copy**. |

All four run at once, even while a turn is in flight.

## How it behaves

- **Send** from the shelf: when Claude is idle the idea is sent as your prompt and leaves the shelf. While Claude is working it goes into your prompt box instead ("In your prompt box — press Enter when Claude is free."); it stays on the shelf until you actually send that text (on its own lines, as it was put there), then it leaves on its own. If you clear the box and send something else first, the idea stays parked. Pressing Send again while it is still in the box does not add it twice. If another mod holds your prompt and sends it on later (prompt-upgrade's automatic mode), the idea leaves when that mod sends it.
- **Send all** numbers the ideas oldest first: "Here are some ideas I parked, handle them one at a time:". While Claude is working that prompt goes into your prompt box the same way, and every idea in it leaves the shelf once you send it (with that opening line and each idea on its own numbered line, as they were put there).
- **Edit** opens a field in place on the terminal, desktop and VS Code. On the phone app (no text fields there) it puts `/idea <text>` in your prompt box; the old idea stays until you delete it.
- The shelf keeps the newest 100 ideas per project.
- **Assumption Check** gives Claude a tool, `note_assumption`, and one short instruction in its system prompt telling it to note small unspecified guesses and keep working. When a turn ends with new guesses, the band says how many are waiting to be checked (guesses a background helper noted between turns are counted at the next turn's end). It sits on top of anything else drawn there (another mod's band stays visible under it), and takes a row only when the space above the prompt has one left over what is beneath; when that is full, the count waits for room. **Dismiss** hides it until new guesses come in; it also hides once every guess is marked. After **Send corrections**, every guess you marked is cleared; unchecked ones stay. Closing the pane (**Close**, Esc or the close mark) clears the ones marked right or skipped.
- Corrections read: "Some of your guesses were wrong. Please fix these:" then "1. You assumed <guess>. That's wrong: <your correction>." When Claude is working they go into your prompt box instead of being sent. Your marks and typed corrections stay until you send that text.
- `/clear` drops the guesses: they belong to a conversation Claude no longer has.
- **Reflect** never writes anything until you press **Add**. Lines already in `CLAUDE.md` (ignoring case, bullets and a closing full stop) start as Skip and are never added twice. New lines go at the end of the `## Learned` section; every line already in the file is kept exactly as it was, and a `#` line inside a code block is not taken for a heading. A missing `CLAUDE.md` is created, and the pane says so first. Suggestions that look like keys, tokens, passwords or email addresses are dropped (long names made of words, like `regenerate_fixtures_for_parser_v3.sh`, are kept). While it reads the session, **Start over** asks again.

## Where data lives

- Idea shelves and the Assumption Check switch: the mod's own store (`$.store`), one key per project (`shelf:<project root>`) plus `assumeOn`.
- Guesses and what the panes show: session state only; gone when the session ends.
- Reflect writes only the project's `CLAUDE.md` (`<project root>/CLAUDE.md`), and only when you press **Add**. Nothing else is written to disk.

## Turning it off

- `/assumptions off` stops everything automatic: no instruction in Claude's prompt, the tool tucked away, no band. The shelf and Reflect only act when you type their commands.
- To remove the mod entirely, disable or uninstall the `workbench` plugin.

## Limits in this build (honest notes)

- **Turning the tool off**: this build has no way to unregister a tool mid-session. With Assumption Check off, `note_assumption` is moved behind tool search with a description saying not to call it, and a call answers that nothing was noted. Starting a new session with it off registers no tool at all.
- **"Is Claude working?"** is tracked from the main turn's start and end, in session state that survives a reload of the mod. If the mod is turned on in the middle of a turn, it does not know that turn is running, so the first Send queues the idea as your next prompt instead of filling the prompt box; it is still sent, once Claude is free.
- **Reflect and reloads**: if the mod reloads while Reflect is reading the session, that answer is lost and the pane keeps saying "Reading the session…"; press **Start over**.
- **`/idea` in the transcript**: Claude Code records slash commands and their one-line output in the conversation, so Claude can see that `/idea` ran. Claude Code frames local command output as not addressed to the model, and the mod never starts a turn, but it cannot hide the record.
- **Reflect** uses `$.model.fork`, which reuses the session's prompt cache; the quality of the suggestions is the model's.
