# Slash commands

Slash commands run inside an interactive Veyyon session. Type `/` in the composer to open the
picker. Commands below are the **builtin** set; extensions may add more.

A command nothing can handle is refused, not sent to the model. If you mistype a name, or type a
command your installed build does not have, you get:

```text
Unknown command "/secrt". Nothing handled it, so it was not sent to the model. Type / to see the
commands this build has, or drop the leading slash to send it as a message.
```

The refusal names the command and never repeats what followed it, because the tail of a mistyped
`/secret` is a credential. The rule reaches further than one mistyped word: in a terminal the whole
argument line of `/secret` is the credential, whatever it happens to spell, so there is no tail
there that is safe to echo back.

A message that merely begins with a filesystem path is prose, not a command, and is sent as usual:

```text
/etc/hosts is broken
```

The separator decides. A command name is one segment of letters, digits, underscores and hyphens
starting with a letter, so anything holding a slash is a path.

## A bare command that has subcommands

Some commands take a subcommand: `/account status`, `/account manager`, `/usage reset`. Typing the
command on its own opens a picker listing every subcommand it has, with what each one does. Move
with the up and down arrows, click a row, press enter to run it, or press escape to close and run
nothing. Choosing a row runs exactly what typing that subcommand runs.

A subcommand that takes an argument, such as `/account name <text>`, does not run straight away.
The picker writes `/account name ` into the composer and leaves the cursor after it, so you type
the argument and press enter.

Outside a terminal, in ACP and `--print` mode, there is no picker to open. A bare command prints
the same list instead.

A few commands mean something on their own rather than standing for a subcommand, and those still
act on a bare invocation: `/yolo`, `/fast`, and `/browser` flip a switch, `/goal` enters goal mode,
`/todo` shows the list, `/secret` opens the masked value field, `/setup` opens the wizard,
`/plugins` lists plugins, and `/compact` compacts.

## Session and navigation

| Command | Purpose |
| --- | --- |
| `/new`, `/fresh` | New session (fresh may reset provider stream state) |
| `/resume` | Resume another saved session |
| `/fork`, `/branch`, `/tree` | Branching and session tree UI |
| `/rename <title>` | Rename session |
| `/move <dir>` | Relocate the session (including its saved session file) to another working directory and re-root path-scoped settings, secrets, capabilities, and the system-prompt project framing there |
| `/cwd [path]` | Bare prints the current session cwd; with a path, re-roots the live session at that directory after validating it exists. Reloads the same cwd-scoped state as `/move` (path-scoped settings, secrets, capabilities, the ssh tool, system-prompt framing) but does not relocate the session file. Session-scoped only; does not write profile `session.workdir` |
| `/export [path]` | Export the session as a standalone HTML file |
| `/dump` | Dump debug artifacts |
| `/session info`, `/session delete` | Session metadata or delete |
| `/profile [name]`, `/profiles` | Bare opens the profile picker (switch, rename, create, delete); `/profile <name>` switches (relaunches as a fresh session); `/profile new <name>` opens the copy picker; `/profile <name> rename to <new>` sets a display name; `/profile rm <name>` deletes after a confirmation |
| `/welcome` | Show the full welcome screen (actions, recent sessions) |
| `/exit`, `/quit`, `/pause` | Leave or pause |

## Model, modes, and behavior

| Command | Purpose |
| --- | --- |
| `/model [id]`, `/models` | Select the **interactive** model only (no role cycle; roles live in settings) |
| `/switch` | Try a model for this session only, without saving it as default (same as alt+p) |
| `/fast on\|off\|status` | Fast mode |
| `/effort [level]` (`/thinking`) | Set reasoning effort; no argument opens the picker |
| `/cpu-limit [cores]` (`/cpu`) | Set this session's CPU budget for spawned commands |
| `/permissions [rung]` (`/approval`) | Set how much the agent does unasked, for this session only: `ask`, `ask-command`, `auto`, `yolo`, or `plan`. `/permissions status` reports the rung in force and where it came from; `reset` drops the session override and returns to the saved default from Settings. A bare `/permissions` opens the picker |
| `/yolo on\|off\|status` | Remove this session's permission prompts (a blatantly destructive command, an explicit deny, and plan mode still block; needs confirmation) |
| `/plan` | Toggle plan mode |
| `/plan-review` | Re-open plan review |
| `/goal …` | Goal set/show/pause/resume/drop/budget |
| `/guided-goal` | Guided goal wizard |
| `/loop` | Loop mode controls |
| `/prewalk` | Prewalk edit path |
| `/secret` | Store a credential the agent uses by placeholder and never sees. In a terminal the argument line is the credential and a bare `/secret` opens a hidden field; the name is asked afterwards and Enter accepts the generated one. Every surface runs the verbs `add`, `list`, `rm`, `rename`, `value`, `scope`, `copy`, `extend`, `log`, `discard`, `help`; `/secret -- <value>` stores a credential that starts with one of them. See [Secrets](../features/secrets.md) |
| `/settings`, `/setup` | Settings UI; `/setup` opens first-run provider sign-in |
| `/providers`, `/account manager` | Open the account manager: every stored account per provider, with its email, plan, health, and usage. See [Authentication](../using/authentication.md) |
| `/account status` | Show which account each provider is serving this session with. A bare `/account` opens the picker |
| `/account name <text>` | Name the account this session is using, so rows read `work` instead of an email |
| `/account switch <provider>` | Open the manager focused on one provider, to move that provider to another of your accounts |
| `/statusline` | Settings UI, jumped to Status Line (preset/segments/separator) |
| `/reload-plugins` | Reload extensions |
| `/force <tool> [prompt]` (`/force:`) | Force the next turn to use a specific tool |

## Tools, context, and jobs

| Command | Purpose |
| --- | --- |
| `/compact [summary] [focus]` | Summarize older context in place; optional focus string |
| `/shake elide\|images` | Shake tool-result bulk. A bare `/shake` opens the picker |
| `/handoff [focus]` | Explicitly transfer context into a new session |
| `/context` | Context usage report |
| `/tools` | Tools visible to the model |
| `/jobs` | Background async jobs |
| `/todo …` | Todo list CRUD |
| `/browser …` | Browser tool mode |
| `/memory …` | Memory backend view/stats/clear/enqueue |
| `/copy` | Pick text or code from the conversation to copy |
| `/lsp` | Show language server status |

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
| `/extensions`, `/status` | Extension Control Center dashboard. `/status` is an alias for it, not a session-status view |
| `/agents` (aliases `/cockpit`, `/hub`) | Open the Agent Control Center: live agent roster and the agent-to-agent comms stream |
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

## Every subcommand

The tables above write `…` where a command takes a subcommand. This is the full set, so a name is
findable without opening the picker. What each one does is on the picker row and in that feature's
own page; typing the bare command lists them with their descriptions.

| Command | Subcommands |
| --- | --- |
| `/setup` | `providers` |
| `/account` | `status`, `manager`, `switch`, `use`, `name`, `refresh`, `usage`, `login`, `logout` |
| `/goal` | `set`, `show`, `pause`, `resume`, `drop` |
| `/fast` | `on`, `off`, `status` |
| `/permissions` | `status`, `ask`, `ask-command`, `auto`, `yolo`, `plan`, `reset` |
| `/yolo` | `on`, `off`, `status` |
| `/cpu-limit` | `status`, `remove`, `reset`, `kill` |
| `/secret` | `add`, `list`, `rm`, `rename`, `value`, `scope`, `copy`, `extend`, `log`, `discard`, `help` |
| `/collab` | `start`, `view`, `status`, `stop` |
| `/browser` | `headless`, `visible` |
| `/todo` | `edit`, `copy`, `export`, `import`, `append`, `start`, `done`, `drop`, `rm` |
| `/session` | `info`, `delete` |
| `/usage` | `show`, `reset` |
| `/mcp` | `add`, `list`, `remove`, `test`, `reauth`, `unauth`, `enable`, `disable`, `smithery-search`, `smithery-login`, `smithery-logout`, `reconnect`, `reload`, `resources`, `prompts`, `notifications`, `help` |
| `/ssh` | `add`, `list`, `remove`, `help` |
| `/compact` | `summary` |
| `/shake` | `elide`, `images` |
| `/memory` | `view`, `stats`, `diagnose`, `clear`, `reset`, `enqueue`, `rebuild`, `mm list`, `mm show`, `mm refresh`, `mm history`, `mm seed`, `mm delete`, `mm reload` |
| `/plugins` | `list` |

Extension packages (for example swarm) register additional commands when installed. The live set is whatever the session registers; use `/help` or the command palette in the TUI. Status line: `/statusline` opens the Status Line settings group (see [Multi-agent monitoring](../features/cockpit.md)). Keybindings: `/hotkeys`. Memory: `/memory` and settings under the active memory backend.
