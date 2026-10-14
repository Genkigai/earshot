# Prompt Upgrade

Turns a rough prompt into a clear coding request before it is sent. A pane asks up to three quick
multiple-choice questions, rewrites the prompt, and shows your original and the upgrade side by side.
Nothing is sent until you press **Run it**.

## Install

Once this folder is published as a GitHub repository with a marketplace file, install it by typing
this at the prompt of a terminal session (answer `y` to add the marketplace, then pick a scope):

```
claude plugin marketplace add ~/claude-mods-src/claude-mods
claude plugin install prompt-upgrade@genkigai-coding-mods
```

The marketplace folder is `claude-mods/` in this repository; its README says how to get it onto your computer.

## Commands

| Command | What it does |
| --- | --- |
| `/better <rough prompt>` | Upgrades that prompt in the pane. While another upgrade is under way it is refused and your new prompt goes back in the prompt box (see "One upgrade at a time"). |
| `/better` | Opens the pane with a field to type a rough prompt (on mobile it says to use `/better <prompt>`). If an upgrade is already under way, it shows that one. |
| `/better on` | Automatic mode on: prompts you type in the prompt box go to the pane first. |
| `/better off` | Automatic mode off (the default). |
| `/better history` | Your last 20 upgrades, each marked ✓ sent or ○ not sent. Press one to reopen its review (Run, Edit, Copy and Cancel all work there); one saved before its rewrite arrived starts a fresh upgrade of its original. |

The command runs at once even while Claude is working; a prompt you Run then waits its turn.

## The four steps

A tracker across the top shows **Your prompt › Questions › Rewrite › Review**: finished steps get a
green check, the current one is gold, the rest are muted.

1. **Your prompt.** Your words in a framed card while the fast model picks the questions.
2. **Questions.** Up to three, each with two to four short options as chips, an **Other (type it)**
   chip and a quiet **Skip**. Each question's gold number turns into a green check when answered.
   Once every question is answered or skipped the rewrite starts; **Skip the rest, upgrade now** starts
   it straight away. If no question would help, this step is skipped.
3. **Rewrite.** The fast model writes the upgrade and a short list of what it added.
4. **Review.** One line of numbers (`42 words → 118 words · 6 details added`), then **Run it**, **Edit**,
   **Copy**, **Cancel**, then "What I added", then the two cards: your prompt on the left, the upgrade on
   the right with a gold outline (stacked when the pane is narrower than 90 columns). The buttons stay
   above the cards so a long rewrite never pushes them away.

- **Cancel** (or closing the pane with its close mark) puts your original prompt back in the prompt box;
  on the "type a rough prompt" screen it puts back what you typed in the field. If the box already
  holds your prompt, it is not added a second time. A review reopened from history just closes.
- **Esc** never closes the pane: it hands the keys back to the prompt and the pane stays, so text typed
  in one of its fields is never thrown away.
- **Edit** swaps the upgrade card for a one-line field holding the upgrade; Enter runs what is in it
  (left unchanged, it runs the upgrade itself with its line breaks). **Stop editing** keeps what you
  typed as the upgrade. Cancelling or closing while editing keeps your edit on the history entry.
  On mobile, Edit puts the upgrade in the prompt box instead.
- **Copy** puts the upgrade (or your edit) on the clipboard. It only speaks up if the copy failed.
- If a model call fails you get a calm card saying your prompt is safe, with **Try again**,
  **Send my original** and **Cancel**.
- Pressing **Run it** twice quickly sends once. Cancel, Run and closing the pane stop a model call
  still in flight.

### One upgrade at a time

The pane holds one prompt. While it is under way, nothing replaces it:

- a second prompt you type (automatic mode), a second `/better <prompt>`, or a press in the history
  is refused. The new prompt goes back in the prompt box, and a line at the top of the pane says
  "Finish or cancel this upgrade first".
- the prompt under way is saved to history at that moment, marked ○ not sent, so it is never only in
  the pane. When it reaches Review the same entry is updated; Run marks it ✓ sent.
- a review reopened from history counts as under way once you type in its Edit field: the edit
  stays in the pane until you Run it, press Stop editing or Cancel (both keep it on its entry).
  A reopened review with nothing typed just gives way to the new prompt.
- sending the same prompt again just says it is already in the pane.

### What the rewrite does

It keeps exactly what you meant and adds a clear goal, who or what it is for, the scope (only files or
areas you named; it never invents paths), constraints, the format, and how to verify it (tests or
checks to run, what "done" looks like). It uses what you answered and leaves out what you skipped.
Unknown facts, names, numbers and prices become `[placeholders]`. It reads as one request you could
have typed yourself.

## Automatic mode

When it is on, a prompt you type goes to the pane instead of being sent. These go straight through
untouched:

- slash commands (`/name` or `/name args`; a prompt that starts with a path such as `/src/app.ts`
  is not a command and is upgraded)
- prompts with images or files attached, including `@path` mentions (any `@word` counts, so
  `@property` passes too: a real mention sent through the mod would not be expanded, while letting a
  non-mention pass loses nothing)
- very long prompts (over 2,000 characters), which are taken to hold pasted logs or diffs
- anything sent while Claude is working
- short replies: three words or fewer, or replies like yes, ok, keep going, continue, do it,
  sounds good, lgtm (case and punctuation ignored)
- prompts from anywhere but your prompt box (notifications, other sessions, other plugins)
- ready-made prompts the sibling mods put in your box: a `/pickup` handoff from context-pilot
  ("Continue from this handoff…"), change-deck's "Ask Claude about this" ("About your edit to…"),
  and anything carrying a ```` ```diff ```` block
- anything starting with `>`: the `>` is removed and the rest is sent as is

The upgraded prompt is sent by the mod as your own words. Before sending, the mod marks that exact
text "let through once", and it also recognizes its own sends by their origin, so an upgrade can never
loop back into the pane.

When the mod holds a typed prompt back, Claude Code 2.1.296 hands that prompt back to the prompt box
on its own, so while the pane works your words may be in both places. The mod works either way: after
**Run it** or **Send my original** the copy in the box is cleared (only when the box still holds
exactly that prompt), so Enter cannot send it a second time; after **Cancel** the box holds it once.

If the pane cannot be placed (a window too narrow for it), your words go back in the prompt box and
one line says so. The mod looks at the box a quarter of a second after holding the prompt and only
fills it when Claude Code has not already put the prompt back.

## Where things live

- `$.store` (the mod's own store): `isOn` (automatic mode) and `history` (the last 20 upgrades:
  original, upgrade, what was added, when, and `sent`: true once run, false while not sent).
- `$.state` (for the panes, this session): the upgrade in progress, the switch, the history, the
  short let-through-once list, and what you typed in the pane's fields (so Run, Copy and Cancel use
  your edit even after a reload).
- No files are written.

The model is the fast model (`haiku`). The questions call has a 30 second limit. The rewrite gets
1,600 tokens and 30 seconds for a prompt of ordinary length, and more for a long one (pasted code),
up to 16,000 tokens and 3 minutes, so a long upgrade is not cut off. If the mod is reloaded while it
waits for the model, it asks again when it comes back instead of leaving the pane stuck; if the pane
went away during the reload, your prompt goes back in the prompt box.

## Turning it off

`/better off` stops automatic mode; `/better` still works when you ask for it. To remove the mod
entirely, disable or uninstall the `prompt-upgrade` plugin with `/plugin`.

## Limits of this build

- The Edit field is one line: line breaks in the upgrade become spaces there. Enter on an unchanged
  field still runs the upgrade with its line breaks; once you change it, what you typed is sent as one
  line. For a multi-line edit, use Copy (or Cancel and edit your original).
- The engine does not expand `@file` mentions or pasted images in a prompt a plugin sends, so an
  upgrade that keeps an `@path` reaches Claude as plain text (Claude can still open that path).
  Prompts with mentions or images skip automatic mode for this reason.
- Desktop and phone sessions may submit prompts under another origin than the terminal's prompt box;
  automatic mode only takes prompts typed in the prompt box (`composer`), so elsewhere use `/better`.
- The pane's close mark is treated as Cancel through the engine's `ui.close` event. The test kit
  cannot raise a person's close, so the tests reach the same code through Cancel; the close mark itself
  is checked only in a live session, as is Claude Code handing a held prompt back to the box.
- An upgraded prompt reaches Claude as the person's words but under this plugin's origin
  (`asUser`). Other mods that only count prompts typed in the prompt box (for example a job tracker
  or a session-title mod) may not treat an upgraded prompt as yours; that is for those mods to allow.
