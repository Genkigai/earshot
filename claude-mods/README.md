# Coding mods for Claude Code

Seven Claude Code mods (function-hook plugins) built from the best features of mods people are sharing, tuned for a coding workflow. Each mod is its own folder with its own tests and README, and each has an on/off switch.

Built and tested on Claude Code 2.1.296. The mod API is early access and can change between releases.

| Mod | What it does | Commands |
| --- | --- | --- |
| **context-pilot** | A context meter measured from real token counts (not the status line's estimate), cache hit rate and "cache tax", the biggest context jumps and what caused them, and automatic handoffs: the main agent wraps up and saves a handoff near the limit; a helper that runs too long or fills too much context hands back only its remaining work. | `/pilot`, `/pilot on\|off`, `/pilot settings`, `/pilot set <name> <value>`, `/handoff`, `/pickup` |
| **safety-net** | Blast radius before destructive shell commands (what `rm`, `git clean`, `git reset --hard`, force pushes and overwrites would hit), lone `rm` deletes go to a Bin you can undo, and Mod Check reviews a mod before you install it. | `/safety`, `/safety on\|off`, `/bin`, `/undo-delete`, `/modcheck <folder\|owner/repo\|git URL>` |
| **change-deck** | Step through every edit Claude made (including helpers), as diffs, with a file tree of touched files, and revert a single edit safely. | `/changes`, `/changes clear`, `/changes on\|off` |
| **prompt-upgrade** | `/better` turns a rough prompt into a precise one: up to three quick questions, a rewrite, and a side-by-side review. Nothing is sent until you press Run. Optional automatic mode. | `/better <prompt>`, `/better`, `/better on\|off`, `/better history` |
| **session-board** | Every Claude Code session on this computer, which ones are waiting on you, working or done, with timers, plus this session's helpers. When two sessions work in the same project, each one is told what the other is editing. | `/sessions`, `/sessions on\|off` |
| **workbench** | Idea Shelf (park ideas per project without interrupting Claude), Assumption Check (Claude logs its small guesses; you mark them right or wrong and the wrong ones go back to fix), and Reflect (turns the session's lessons into CLAUDE.md lines you approve). | `/idea <text>`, `/ideas`, `/assumptions`, `/assumptions on\|off`, `/reflect` |
| **studio** | A progress checklist above the prompt while Claude works, theme skins (including a Gold & Slate theme), a preview pane for pasted images (terminal), and a web reader pane. | `/progress on\|off`, `/skin`, `/preview`, `/preview on\|off`, `/browse <url>`, `/studio` |

"You Should Know" is Anthropic's built-in mod; turn it on with `/plugin enable cc-plugin-you-should-know@builtin`.

## Install on your computer

1. Get this folder onto your computer, for example by checking out the branch that holds it:

   ```bash
   git clone -b claude/exciting-cray-tcm677 https://github.com/genkigai/earshot.git ~/claude-mods-src
   ```

2. Add the folder as a marketplace and install the mods you want (in a terminal):

   ```bash
   claude plugin marketplace add ~/claude-mods-src/claude-mods
   claude plugin install context-pilot@genkigai-coding-mods
   claude plugin install safety-net@genkigai-coding-mods
   claude plugin install change-deck@genkigai-coding-mods
   claude plugin install prompt-upgrade@genkigai-coding-mods
   claude plugin install session-board@genkigai-coding-mods
   claude plugin install workbench@genkigai-coding-mods
   claude plugin install studio@genkigai-coding-mods
   ```

   Or inside Claude Code: `/plugin marketplace add ~/claude-mods-src/claude-mods`, then `/plugin install <mod>@genkigai-coding-mods`.

3. Start a new Claude Code session (or type `/reload-plugins`). A marketplace that is a folder is read from that folder, so after you edit a mod, `/reload-plugins` picks up the change.

To try one without installing: `claude --plugin-dir ~/claude-mods-src/claude-mods/<mod>`.

## Turning things off

Each mod has its own switch (`/pilot off`, `/safety off`, `/changes off`, `/better off`, `/sessions off`, `/assumptions off`, `/progress off`). To remove a mod entirely: `claude plugin uninstall <mod>@genkigai-coding-mods`, or `claude plugin disable <mod>@genkigai-coding-mods`.

## Where the mods keep data

Settings live in each mod's own store. Files only go under `~/.claude/mod-data/<mod>/` (handoffs, the Bin, edit replays, session heartbeats). Two mods write elsewhere, and only when you press a button: workbench's Reflect appends the lines you keep to your project's `CLAUDE.md`, and studio's Gold & Slate skin writes a theme file where Claude Code keeps custom themes. No mod writes inside its own folder.

## Checking a mod

```bash
claude plugin validate claude-mods/<mod>
claude plugin test claude-mods/<mod>
```
