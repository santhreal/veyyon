# Slash commands

Slash commands run inside an interactive Veyyon session. Type `/` in the composer to open the
picker. Commands below are the **builtin** set; extensions may add more.

## Session and navigation

| Command | Purpose |
| --- | --- |
| `/new`, `/fresh` | New session (fresh may reset provider stream state) |
| `/resume` | Resume another saved session |
| `/fork`, `/branch`, `/tree` | Branching and session tree UI |
| `/rename <title>` | Rename session |
| `/move <dir>` | Relocate the session (including its saved session file) to another working directory and re-root project settings, plugins, commands, and capabilities there |
| `/cwd [path]` | Bare prints the current session cwd; with a path, re-roots the live session at that directory after validating it exists. Reloads the same project-scoped state as `/move` (project settings, plugins, slash commands, capabilities, ssh tool, system-prompt framing) but does not relocate the session file. Session-scoped only; does not write profile `session.workdir` |
| `/export [path]` | Export the session as a standalone HTML file |
| `/dump` | Dump debug artifacts |
| `/session info`, `/session delete` | Session metadata or delete |
| `/profile [name]`, `/profiles` | Bare opens the profile picker (switch, rename, create, delete); `/profile <name>` switches (relaunches as a fresh session); `/profile new <name>` opens the copy picker; `/profile <name> rename to <new>` sets a display name; `/profile rm <name>` deletes after a confirmation |
| `/welcome` | Show the full welcome screen (actions, recent sessions) |
| `/exit`, `/quit`, `/pause` | Leave or pause |

## Model, modes, and behavior

| Command | Purpose |
| --- | --- |
| `/model [id]` | Select the **interactive** model only (no role cycle; roles live in settings) |
| `/switch` | Try a model for this session only, without saving it as default (same as alt+p) |
| `/fast on\|off\|status` | Fast mode |
| `/thinking [level]` (`/effort`) | Set reasoning effort; no argument opens the picker |
| `/yolo on\|off\|status` | Remove ALL permission prompts for this session (explicit deny and plan mode still block; needs confirmation) |
| `/plan` | Toggle plan mode |
| `/plan-review` | Re-open plan review |
| `/goal …` | Goal set/show/pause/resume/drop/budget |
| `/guided-goal` | Guided goal wizard |
| `/loop` | Loop mode controls |
| `/prewalk` | Prewalk edit path |
| `/settings`, `/setup` | Settings UI; `/setup` / `/providers` opens provider sign-in |
| `/statusline` | Settings UI, jumped to Status Line (preset/segments/separator) |
| `/reload-plugins` | Reload extensions |
| `/force <tool> [prompt]` | Force the next turn to use a specific tool |

## Tools, context, and jobs

| Command | Purpose |
| --- | --- |
| `/compact [summary\|handoff] [focus]` | Compact context now (`compaction.model` + type); optional type override and focus string |
| `/shake [elide\|images]` | Shake tool-result bulk |
| `/handoff` | Compaction handoff helper |
| `/context` | Context usage report |
| `/tools` | Tools visible to the model |
| `/jobs` | Background async jobs |
| `/todo …` | Todo list CRUD |
| `/browser …` | Browser tool mode |
| `/memory …` | Memory backend view/stats/clear/enqueue |
| `/copy` | Pick text or code from the conversation to copy |
| `/lsp` | Show language server status |
| `/cockpit` | Live multi-agent cockpit (status, model per agent, drill-in) |

## Auth and usage

| Command | Purpose |
| --- | --- |
| `/login [provider\|url]` | OAuth / API key login |
| `/logout [provider]` | Log out |
| `/usage show\|reset` | Provider rate limits |
| `/changelog` | Open the release notes on the web |

## Extensions

| Command | Purpose |
| --- | --- |
| `/mcp …` | MCP server management |
| `/mcp notifications` | Show notification capabilities and subscriptions |
| `/plugins …` | Plugin browser |
| `/extensions` | Extension dashboard |
| `/agents` | Open the Agent Control Center (subagent definitions) |
| `/ssh …` | SSH host setup |
| `/hotkeys` | Active keybinding chords |
| `/collab …`, `/join`, `/leave` | Live collab sessions |
| `/share` | Share the session via an encrypted link (share server or secret gist) |

## Side agents and misc

| Command | Purpose |
| --- | --- |
| `/btw` | Ephemeral side question |
| `/tan` | Run a full background agent on tangential work |
| `/omfg` | Forge a TTSR rule from a complaint to stop a recurring behavior |
| `/vibe` | Toggle vibe mode (director + `vibe_*` worker tools) |
| `/retry` | Retry failed turn |
| `/debug` | Debug overlays |
| `/queue` | Queue follow-up message |
| `/drop` | Delete the current session and start a new one (dequeuing a queued message is the `alt+up` chord, not a slash command) |

Extension packages (for example swarm) register additional commands when installed. The live set is whatever the session registers; use `/help` or the command palette in the TUI. Status line: `/statusline` opens the Status Line settings group (see [Multi-agent monitoring](../features/cockpit.md)). Keybindings: `/hotkeys`. Memory: `/memory` and settings under the active memory backend.
