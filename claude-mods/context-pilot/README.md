# context-pilot

A context meter measured from the real token counts of each model request,
cache-tax tracking, a record of what made the context grow, and automatic
handoffs so long work continues cleanly in fresh helpers and fresh sessions.

## What it does

- **Measures context per request.** After every model request the mod reads
  the usage the API reported and counts the context as
  `input + cache read + cache write`. It does this for the main loop and for
  each helper (subagent) separately. The window comes from the session (the
  status line's own window figure). If the session gives none, the model id
  decides: 1M when the id carries `[1m]`, otherwise 200k.
- **Shows both figures.** The pane shows what the status line says next to
  what was measured, so you can see the gap.
- **Tracks cache tax.** For each request, the hit rate is
  `cache read / (input + cache read + cache write)`. Cache tax is the part of
  a request's cache write that the previous request of the same loop had
  already cached: tokens written again after a cache miss, an expiry or a
  changed prefix (a compaction, a model switch). A loop's first request never
  counts as tax, and neither does the normal write of the new tail. The pane
  shows session totals (main and helpers) and the last request. For money, it
  shows the session cost as `/cost` has it. It never uses prices of its own.
- **Records growth bumps.** For each main-loop request it puts the rise in
  context down to what came in between: the tool calls (`Read app.js`,
  `Bash npm test`, `Agent "Fix tests"`, `+2` when several ran together), your
  prompt, a task notification, or Claude's own reply. A drop is a compaction.
  It keeps the five biggest rises with their turn numbers.
- **Hands off automatically** (see below), and saves handoffs with the
  `save_handoff` tool it gives Claude.

## Install

Once this folder is published as a GitHub repository that holds a
marketplace file, install it by typing this at a Claude Code prompt:

```
claude plugin marketplace add ~/claude-mods-src/claude-mods
claude plugin install context-pilot@genkigai-coding-mods
```

The marketplace folder is `claude-mods/` in this repository; its README says how to get it onto your computer.

## Commands

| Command | What it does |
| --- | --- |
| `/pilot` | Opens the Context pilot pane. |
| `/pilot on` / `/pilot off` | Turns auto-handoff on or off. |
| `/pilot settings` | Lists the settings. |
| `/pilot set <name> <value>` | Changes one setting. |
| `/handoff` | Asks Claude to write a session handoff now. It queues a prompt that runs once Claude is idle. If another mod holds that prompt back, the status line goes back to what it said and a toast says why. |
| `/pickup` | Puts this project's latest session handoff in the prompt box. Press Enter to continue from it. |

All of them answer at once, even while Claude is working.

## Settings

| Name | Default | Meaning |
| --- | --- | --- |
| `auto` | on | Auto-handoff notes to Claude and its helpers. |
| `main` | 70 | Main context threshold, in percent of the window. |
| `helper-minutes` | 20 | A helper running longer than this is asked to hand off. |
| `helper-context` | 30 | A helper whose context passes this percent is asked to hand off. |
| `status` | on | The status line under the prompt. |

Settings are kept in the mod's own store and survive restarts.

## The status line

After each main-loop request: `ctx 42% · cache 91% · tax 12k`. The cache
figure is the session's hit rate and the tax is the session's total.
`· handing off…` is added once Claude has been asked for a handoff. If no
handoff is saved by the time a second new turn starts, the ask counts as
unanswered and the tag goes away. `· handoff saved` is added once Claude saved
one, and stays until the next turn starts. At the start of a session where a
handoff is waiting, and before any turn has run: `handoff waiting · /pickup`.

## Auto-handoff

- **Main loop.** When the measured main context reaches the threshold, the mod
  adds a note to the main conversation. The note asks Claude to stop starting
  helpers, let running helpers finish, leave files in a consistent state, then
  call `save_handoff` (scope `session`) and tell you to start a fresh session
  and type `/pickup`. The note fires once. It fires again only after the
  context drops below threshold − 10, for example after `/compact`.
- **Helpers.** When a running helper passes `helper-minutes` or
  `helper-context`, the mod adds a note to that helper's own conversation,
  once per helper. The note asks it to save only its remaining work with
  `save_handoff` (scope `helper`) and end with a summary that starts
  `HANDOFF SAVED`. Context is checked after each helper request. Time is
  checked every 30 seconds while a helper runs.
- **When a note goes in.** A note is never put between a tool call and its
  result. It waits until every result of the loop's current step has come
  in, then goes in before the next request. Results the engine stores while
  the step is still streaming count too. A note for the main loop that comes
  due on the turn's last reply goes in when the turn ends.
- **A helper counts as asked only once its note went in.** If a helper
  passes a limit on its final reply, its run ends before the note can go in.
  The helper then counts as never asked, and the main loop is not told that
  it stopped early.
- **Back in the main loop.** When a helper that stopped early returns, the
  main loop is told where its handoff is and asked to start a fresh helper
  with that text. A foreground helper's Agent result carries this note. A
  background helper (the Agent tool's default) has returned already, so the
  note goes into the conversation that started it when the helper's run ends.
- **A fresh session.** At start, if this project's `latest.md` is less than
  7 days old and was written before this session began, the status line says
  `handoff waiting · /pickup`. Once you `/pickup` a handoff, the mod stops
  offering that same handoff.

## Where data lives

- **Handoffs** are files under
  `~/.claude/mod-data/context-pilot/handoffs/<project-slug>/`, named
  `<YYYYMMDD-HHMMSS>-<scope>.md` (`-2`, `-3` on a clash), plus `latest.md`
  for session handoffs. The project slug is the project root made safe for a
  file name, for example `Users-leland-Coding-earshot`. These are the only
  files the mod writes, and it writes them only when a handoff is saved.
- **Settings** and the record of picked-up handoffs are kept in the mod's own
  store.
- **Live figures** are kept in memory as `$.state` under `context-pilot`:
  `snapshot` (measured context, window, history, bumps, cache totals, phase),
  `settings`, `helpers`, `handoff`, and `busy` (the running main turn's id,
  or null while idle). Nothing is written to disk per request.
  Other mods can read these values. To get them typed, list `context-pilot`
  under `dependencies` in your `plugin.json`. The contract is
  `types/index.d.ts`.

## Turning it off

- `/pilot off` stops the handoff notes. Measuring and the pane keep working.
- `/pilot set status off` hides the status line.
- To stop the mod entirely, disable or uninstall the plugin.

## Limits

- **Background helpers.** The Agent tool returns at once for a background
  helper, so its result cannot carry the handoff note. The note is added to
  the conversation that started the helper when the helper's run ends, and
  goes to the main loop if that conversation has ended.
- **Helpers without the tool.** A helper whose agent type does not include
  the `save_handoff` tool (some agent types have a fixed tool list) cannot
  save a handoff. Its final summary then carries the remaining work, and the
  main loop is told that no handoff was saved.
- **A helper's window can be a guess.** A helper on the main loop's model
  uses the window the session reports. For any other model, the mod uses 1M
  when the model id carries `[1m]`, otherwise 200k.
- **Which loops count as helpers.** Only loops the engine lists as agents get
  helper limits. Teammates and the engine's own loops (compaction, memory, a
  workflow's agents) are never asked to hand off, but their cache use still
  counts in the session totals.
- **"Waiting" means written before this session.** The spec asked for a
  handoff "newer than this session's start". Read literally, no handoff would
  ever be waiting when a session starts, so the mod uses "written before this
  session started, and less than 7 days old".
- **No color on the status line.** A status line cannot be colored amber, so
  it stays short instead.
- **A silent helper drops off.** A helper that goes 30 minutes without a
  request and never reported an end is treated as gone.
- **A reload in the middle of a turn drops waiting notes.** Notes waiting
  for a tool result are held in the mod's memory, so a reload of the mod's
  code while Claude works loses them. Whether a main turn is running is kept
  in `$.state`, so later notes still wait their turn.
- **No `save_handoff` tool.** If Claude Code refuses to register the tool,
  a toast says so. Handoff notes still go out; without the tool, Claude
  can only write the handoff in its reply.
- **A narrow pane.** Below 20 columns the pane shows only its title, one line
  of figures and Close.
- **A pane that cannot be drawn yet.** If Claude Code opens the pane but
  cannot draw it yet, a toast says so. The mod then checks every 2 seconds
  while the pane stays open. Once the pane is drawn, its figures update every
  second. The checks stop when you close the pane.
