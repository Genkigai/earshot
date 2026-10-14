# studio

Four small things that make a coding session easier to watch and nicer to look at:

1. **Progress band**: a live line above the prompt while Claude works: what you asked for, how long it has been going, the step it is on, and Claude's to-do list as a checklist.
2. **Skins**: pick a Claude Code theme from a pane, plus an optional "Gold & Slate" theme that matches your other mods, and the accent colour studio itself uses.
3. **Image preview**: when you paste an image into a prompt, see it (fullscreen terminal) or its size and pixel dimensions (everywhere else).
4. **Browse**: read a web page as Markdown in a pane, follow its links, and send it to Claude.

Tool rows in the transcript stay as they are: studio adds a band, it hides nothing.

## Install

Once the mod's folder is published as a repository with a marketplace file, install it with one line typed at the prompt of a terminal session (answer `y` to add the marketplace, then pick a scope):

```
claude plugin marketplace add ~/claude-mods-src/claude-mods
claude plugin install studio@genkigai-coding-mods
```

The marketplace folder is `claude-mods/` in this repository; its README says how to get it onto your computer.

## Commands

| Command | What it does |
| --- | --- |
| `/studio` | Shows studio's settings. `/studio off` turns the band and image previews off; `/studio on` turns them back on. |
| `/progress` | Says whether the band is on. `/progress on` and `/progress off` switch it. |
| `/skin` | Opens the **SKINS** pane: themes, the Gold & Slate theme, and the mods accent. |
| `/preview` | Shows the last pasted image: the **IMAGE** pane on the terminal, or its details as a reply. `/preview on` and `/preview off` switch automatic previews. |
| `/browse <url>` | Opens the page in the **BROWSE** pane. `example.com/x` works; `https://` is added for you. |

Every command answers at once. Panes open in the background.

## The progress band

A job starts when a prompt of yours starts a turn: one you type, or one another mod sends for you as your own words (prompt-upgrade's **Run**, workbench's **Send**). Slash commands don't count, but a prompt that starts with a path, like `/tmp is full`, does. The job starts when the prompt's turn starts, so a prompt another mod holds back or drops never starts one or flashes on the band, and the band you had stays as it was. Prompts a mod sends in its own name, task notifications and messages from other sessions don't start a job either. A prompt you type while Claude works starts its own job when it gets a turn of its own; if Claude reads it inside the running turn instead, it belongs to the job already on the band. The band shows:

- `◆ Fix the login bug · 1m 12s` with the current step on the right: `Edit app.js`, `Bash npm test`, `Thinking`.
- The checklist from Claude's to-do tools (both `TodoWrite` and the `TaskCreate`/`TaskUpdate`/`TaskList` tools are read):
  - `✓ name  ━━━━━━━━━━  Done` (green)
  - `▶ name  ━━━━━━────  Working` (accent; the meter shows the share of steps finished)
  - `○ name  ──────────  Next` / `Up next` (dim)
  - At most 6 rows, then `+N more`. With no to-do list, just the header.
- `‖ Needs you · permission to use Bash` (amber) while a permission prompt or a question is up, including one raised by a helper agent. It clears on the next tool call or prompt. Other notifications (a mod's own, "Claude is waiting for your input") don't change the band.
- `⚠ The last 3 tool calls failed · Bash npm test` (amber) after three failed tool calls in a row. A success clears it. A call that a guard or you refused counts neither way.
- `■ Stopped · <job> · you pressed Esc` when you interrupt a turn. It stays until your next prompt.
- `✓ All done · <job> · took 2m 14s`, which hides after 5 seconds.

The elapsed time redraws once a second only while a job is running or waiting. When nothing is running, no timer runs. The band sizes every row to its width and never takes more rows than it is given. When another mod draws a band in the same place (workbench's assumptions, say), both show: studio's takes only the rows the other leaves, and steps aside if the other already fills the room. It also steps aside while a survey is showing. Colour codes pasted in with terminal output are left out of the band. `/clear` clears the band and the last image.

## Skins

`/skin` lists the themes your build offers in `/config`. Each has a swatch and a **Use** chip, and the chip for the theme in use is in your accent colour. **Use** changes the theme right away. If the change is refused, the reason shows in amber in the pane.

- **Swatches**: the `/config` theme setting gives each theme's name but not its colours. So the swatches for built-in themes are drawn with theme colour names (`claude`, `success`, `warning`, ...) and show the colours of the theme *in use*. The Gold & Slate swatch shows its real colours.
- **Gold & Slate (matches your mods)**: this build supports custom themes. When you press **Use** on this entry (and only then), studio writes `~/.claude/themes/gold-and-slate.json` (or `$CLAUDE_CONFIG_DIR/themes/` when that is set to a full path; a relative one, or one starting with `~`, writes nothing and the pane says why). The file uses the shape this build reads: `{ "name", "base": "dark", "overrides": { ... } }`, with gold `#F2C46D` accents, muted `#7D8590`, text `#E6EDF3`, green `#3DD68C`, amber `#E3B341`, and slate `#262B33` behind your own prompts in the transcript. If that file is already there, studio uses it as it is and never overwrites it, so your edits stay (delete it to get studio's version back). studio then asks the theme setting to switch to `custom:gold-and-slate`. This build's `/config` theme setting only takes the preset themes, and says "For custom themes, use /theme". If it refuses, the pane says so and offers **Open /theme** so you can pick Gold & Slate there. If `/theme` cannot be opened from there, a toast tells you to type it.
- **Mods accent**: Gold (default), Teal `#4FD1C5`, Violet `#B392F0` or Coral `#F78C6C`. It recolours studio's band, title rules and main buttons. It is saved between sessions.

## Image preview

When a prompt carries an image, studio keeps the latest one: its name, type, size, and the pixel size it reads from the PNG, JPEG, GIF or WebP header.

- **Fullscreen terminal**: the **IMAGE** pane opens as a sidebar. It shows the picture at the pane's width, with `image.png · 1280×720 · 240 KB` as its alt text and the details below. If the terminal is too narrow for a sidebar right then, no pane is left waiting to pop up later: you get the status line below instead.
- **Everywhere else**: the status line reads `image attached · 1280×720 · 240 KB` for 10 seconds. The desktop and mobile apps already show the image in the conversation.
- `/preview` opens the pane again on the terminal (any layout, because you asked), or replies with the details.

## Browse

`/browse docs.python.org` replies `Opening docs.python.org…` and opens the **BROWSE** pane:

- **Title bar**: the page title on the left, the host on the right. A page with no `<title>` uses its first heading as plain text (link markup left out), or else the host.
- **Buttons**: `‹ Back` (when there is history), **Send to Claude** (puts `From <title> (<url>):` and the first ~6,000 characters of the page at the end of your prompt box, after a blank line when you had already typed something, then closes the pane), **Copy** (copies the page as Markdown), **Open link** (opens the address in your browser) and **Close**.
- **Links**: click a link to load it in the same pane. Back returns to the previous page.
- **Pages**: HTML is turned into Markdown with no browser. Scripts, styles, the page's head (its title goes in the title bar), navigation, footers and sidebars are dropped; a page or article `<header>` is kept, since it often holds the heading. Headings, paragraphs, lists, code blocks, links (made absolute), images (as `[image: alt]`) and tables are kept, entities are decoded, and pages are cut at about 60,000 characters. Plain text and Markdown pass through as they are. JSON is pretty-printed.
- **Errors**: a failed load shows `Couldn't load <host>: <reason>.` with **Try again** and **Close**.

## Where data lives

- studio's own store (Claude Code keeps it per plugin): your switches and accent (`settings`).
- Session state (`$.state`, gone when the session ends): the current job, the last image, the skins list and the open page.
- One file, and only if you press **Use** on Gold & Slate and it is not there yet: `~/.claude/themes/gold-and-slate.json`. studio writes nothing inside its own folder.

## Turning it off

- `/studio off` stops the band and image previews. `/skin`, `/preview` and `/browse` still answer when you ask, because asking is explicit.
- `/progress off` or `/preview off` turns off one part.
- To remove the mod, disable or uninstall the `studio` plugin.

## Also worth turning on

Anthropic ships a built-in mod, **You Should Know**, that points out things worth knowing as you work. studio does not rebuild it. Turn it on with:

```
/plugin enable cc-plugin-you-should-know@builtin
```

## Limits of this build (honest notes)

- **Image bytes**: the `prompt.attachment` event carries only text here, and `prompt.submit` gives an attachment's kind, type and file name but not its bytes. studio reads the pasted bytes from the prompt row as the conversation stores it (the `session.append` event, image blocks in base64). It only reads them and never changes them.
- **Which images can be drawn**: the terminal's `Image` element draws PNG bytes up to 2 MB. JPEG, GIF and WebP images, and larger PNGs, get the details and alt text but no picture. studio keeps the pixels only when the terminal can draw them, so it never holds 4 MB of bytes it cannot use.
- **Knowing the layout**: a hook only learns whether the terminal is in the fullscreen layout while drawing (which may not change anything) or from a slash command's `presentation`. So studio reads it from any slash command you run at the terminal (`/model`, `/compact`, a studio command; it only reads it and passes the command on). The layout is fixed for a session, and studio does not carry it to the next one, where you may be in tmux instead. Until it knows, a pasted image goes to the status line, and `/preview` still opens the pane on request.
- **Fetching**: `$.http.fetch` has no timeout or redirect options and returns the body whole. studio stops waiting after 15 seconds and keeps the first 3 MB of the body. Redirects are whatever the host does. The final address is not reported, so relative links resolve against the address you asked for (or the page's `<base href>`).
- **Custom theme location**: the API types don't document where custom themes go. The folder and file shape above come from reading this build (2.1.296). If a later build moves them, the Gold & Slate entry will save a file the theme picker does not read.
