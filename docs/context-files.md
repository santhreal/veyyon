# Context files

Context files are Markdown instruction files that `veyyon` discovers automatically before a session starts and injects into the agent's project context. Use them for repository conventions, architecture notes, test and review expectations, and instructions that should travel with a user account or a project.

Matching files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and related) are discovered and injected into the opening session context when discovery is enabled.

## How context files relate to other concepts

Four similarly named things behave differently. Keep them straight:

- **Context files** are read as plain Markdown and shown to the agent inside a `<context>` block. They are advisory background that stays in the session's opening context.
- **Sticky rules** come from a top-level `RULES.md`. They are converted into an always-apply rule that is re-attached near the current turn, so they keep their hold even after the visible conversation grows. See "Sticky rules vs normal context" below.
- **Discovery providers** are the config-source adapters (`native`, `claude`, `codex`, `gemini`, `opencode`, `github`, `agents`, `agents-md`) that know where each tool keeps its files. The same provider that contributes context files may also contribute MCP servers, slash commands, skills, hooks, tools, prompts, and settings.
- **Model providers** are inference backends such as `anthropic`, `openai`, `google`, `groq`, `ollama`, and `openrouter`. They have nothing to do with context files except that both kinds of id share the one `disabledProviders` list: see "Disabling discovery providers" below and [Providers](./providers.md).

Authoring **skills** and **rule** files (as opposed to the sticky `RULES.md`) is covered in [Skills](./skills.md). Use `AGENTS.md` for additive instructions, `PROMPT_SECTIONS/` for persistent section changes, and the two CLI flags for one-run prompt replacement or appending. See [System prompt customization](./system-prompt-customization.md).

## Native `.veyyon` files

The native provider is the recommended format for new projects. It reads from your user agent directory and from `.veyyon/` directories inside a project, and it has the highest discovery priority, so its files win over every other convention at the same scope.

| File | Scope | Behavior |
|---|---|---|
| `~/.veyyon/AGENTS.md` | Global User | Global cross-profile context for every session across all profiles. |
| `~/.veyyon/profiles/<profile>/...` | Profile User | Active profile context. Scanned in descending priority order (first match wins; exactly 1 file loaded per profile):<br>1. `~/.veyyon/profiles/<profile>/agent/AGENTS.md` (Highest)<br>2. `~/.veyyon/profiles/<profile>/AGENTS.md`<br>3. `~/.veyyon/profiles/<profile>/agent/agent.md`<br>4. `~/.veyyon/profiles/<profile>/agent.md` (Lowest) |
| `<ancestor>/.veyyon/AGENTS.md` | Project | Project context. `veyyon` walks upward from the current directory to the repository root and every ancestor contributes at most **one** file. The nearest non-empty `.veyyon/` directory supplies that ancestor's file from its `AGENTS.md`; other ancestors fall back to a bare `AGENTS.md`, then a bare `CLAUDE.md`. See [Load order and shadowing](#load-order-and-shadowing) for the full per-directory order. |
| `~/.veyyon/profiles/<profile>/agent/RULES.md` | User | User-level sticky rule content. Loaded as an always-apply rule, not as a context file. |

Two details matter:

- **Walk-up to the repository root.** Discovery starts in the current working directory and climbs through each ancestor up to the repository root. The nearest non-empty `.veyyon/` directory claims its own level with its `AGENTS.md`; every other level contributes a bare `AGENTS.md`, falling back to a bare `CLAUDE.md` when no `AGENTS.md` has content there.
- **The `.veyyon/` directory must be non-empty.** An empty `.veyyon/` directory is skipped during the walk-up, so the search continues to the next ancestor. An empty `AGENTS.md` file contributes nothing and shadows nothing.

`~/.veyyon/profiles/default/agent` is the user base, and it is **profile-aware**: under a named profile (`--profile <name>` / `VEYYON_PROFILE`) the base becomes `~/.veyyon/profiles/<name>/agent`, so each profile carries its own `AGENTS.md` and `RULES.md`. Non-native user files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, …) are profile-independent and still discovered under every profile. If `VEYYON_CODING_AGENT_DIR` is set under the **default** profile, it relocates the base outright, so the user files become `$VEYYON_CODING_AGENT_DIR/AGENTS.md` and `$VEYYON_CODING_AGENT_DIR/RULES.md`; under a named profile the override is ignored.

### Monorepo example

```text
repo/
  .veyyon/
    AGENTS.md
  packages/api/
    .veyyon/
      AGENTS.md
```

Starting a session in `repo/packages/api`:

- The `.veyyon/` context file is `repo/packages/api/.veyyon/AGENTS.md` (the nearest non-empty `.veyyon/` directory). `repo/.veyyon/AGENTS.md` is **not** also included, though a bare `repo/AGENTS.md` beside it would be, at its own depth.

Put broad, durable project background in `AGENTS.md`. Reserve `RULES.md` for short, hard requirements that must stay visible across long conversations; it is a user-level file, so a repository cannot ship one.

## Other supported context conventions

`veyyon` also discovers the context and rule files of other agent tools so existing projects keep working without migration.

| Provider id | Convention path | Scope | Notes |
|---|---|---|---|
| `native` | `.veyyon/AGENTS.md` | User + project | Recommended `veyyon` format. User file at `~/.veyyon/profiles/<profile>/agent/AGENTS.md`; project files are one per ancestor directory from the repo root down to the cwd, resolved per directory as described in [Load order and shadowing](#load-order-and-shadowing). |
| `claude` | `.claude/CLAUDE.md` | User + project | User file `~/.claude/CLAUDE.md`; project file `<cwd>/.claude/CLAUDE.md` only (no ancestor walk-up). |
| `codex` | `.codex/AGENTS.md` | User | User file `~/.codex/AGENTS.md` only. Project-level standalone `AGENTS.md` files load through the `native` provider's ancestor walk-up, not from `<cwd>/.codex/AGENTS.md`. |
| `gemini` | `.gemini/GEMINI.md` | User | User file `~/.gemini/GEMINI.md` only. |
| `opencode` | `.config/opencode/AGENTS.md` | User | User file `~/.config/opencode/AGENTS.md` only. |
| `github` | `.github/copilot-instructions.md` | User | User-global `~/.copilot/copilot-instructions.md` (relocate with `COPILOT_HOME`) and an `AGENTS.md` from each `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` entry. A repository's own `.github/copilot-instructions.md` is not read. |
| `agents` | `.agent/AGENTS.md`, `.agents/AGENTS.md` | User | User files from `~/.agent/` and `~/.agents/` only; there is no project scope. |
| `agents-md` | `AGENTS.md` | Project | Standalone (non-config-directory) `AGENTS.md` files, discovered by walking up from the current directory to the repository root (or home when no repo root is known). Files whose parent directory name starts with `.` are ignored, those belong to a config-directory provider instead. |
| `github` | `<dir>/.github/instructions/**/*.instructions.md` | User rules | GitHub Copilot / VS Code instruction files under each `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` entry become rules. `applyTo: '*'` or `applyTo: '**'` is injected as always-apply context; other `applyTo` globs are listed in the rulebook with `description` and are readable as `rule://<name>`. A repository's own `.github/instructions/` is not read. |

Providers marked "(no ancestor walk-up)" only look in the current working directory's config directory. If you need ancestor walk-up behavior, prefer the native `.veyyon/AGENTS.md` format or a standalone `AGENTS.md` (the `agents-md` provider), or launch `veyyon` from the directory that holds the config directory.

## Load order and shadowing

When two providers describe the *same* scope, the higher-priority provider wins. Provider priorities:

| Priority | Provider id |
|---:|---|
| 100 | `native` |
| 80 | `claude` |
| 70 | `agents`, `codex` |
| 60 | `gemini` |
| 55 | `opencode` |
| 30 | `github` |
| 10 | `agents-md` |

Discovered files are then deduplicated by scope:

- **One user context file** is kept across all providers. Because `native` has the highest priority, `~/.veyyon/profiles/<profile>/agent/AGENTS.md` shadows every other user-level context file.
- **One project context file per directory depth.** Depth is measured from the current directory: the cwd is depth 0, its parent depth 1, and so on. Config subdirectories of an ancestor (`.claude/`, `.github/`, `.gemini/`, …) count as the same depth as that ancestor.
- **Within one directory, `native` picks a single file before any shadowing happens.** The order is `.veyyon/AGENTS.md` (only from the nearest non-empty `.veyyon/` directory), then a bare `AGENTS.md`, then a bare `CLAUDE.md`. The first one that has content wins and the rest of that directory's candidates are never read, so a `CLAUDE.md` beside an `AGENTS.md` is not loaded, not appended, and not deduplicated later. `CLAUDE.md` is last because `AGENTS.md` is the tool-neutral convention: a project carrying both is nearly always stating the same rules twice, and a stale `CLAUDE.md` must not contradict a maintained `AGENTS.md`. A candidate that is empty or unreadable contributes nothing and therefore shadows nothing, so the next one down gets its turn.
- **The pick is per directory, not per project.** A repo root with only `AGENTS.md` and a package directory with only `CLAUDE.md` both load, each at its own depth.
- **At the same depth, the higher-priority provider shadows the rest.**
- **Across depths, multiple files survive.** In a monorepo, an ancestor `AGENTS.md` and a package-level one are different depths and both load.
- **Contained files are collapsed.** If one surviving file's whole content already appears inside another's, only one copy is kept, and the copy that survives is the one from the *more authoritative scope* (see below). Two files from the same scope fall back to position, so between a repo-root file and a package file with identical text the package one is kept.

After deduplication, project files are sorted so **farther ancestors appear first** and files **closer to the cwd appear last**. Both are project scope, so this is one project directory refining another, not a project file outranking a broader scope.

### Scope authority: your own configuration is last and wins

Provider priority and depth decide which files *survive*. A separate axis decides where each survivor is *rendered*, and therefore which one wins an outright conflict. These are two different orders and it is easy to read one as the other:

- **Resolution order** is the order the three scopes are read: global, then profile, then project.
- **Authority order** is the order they are rendered, least authoritative first: the project group (farther ancestors first, closest to the cwd last), then the profile file, then the cross-profile global `~/.veyyon/AGENTS.md` **last of all**.

Your live instruction in the conversation beats all of them. Below that, the ladder runs broadest to narrowest: your own `~/.veyyon/AGENTS.md`, then the active profile's file, then the project's files lowest. A narrower file may add detail the broader ones do not cover, and the agent follows it there, but it may not contradict, loosen, or forbid what a broader file allows.

That direction is a safety boundary, not a style choice. A project file is content checked into a repository you may not have written, so letting one outrank your own configuration would let any repository you clone rewrite the rules you set for yourself. Within the project group the file closest to your working directory is still the most specific one, because both files are project scope and neither outranks the other on the ladder.

### Worked shadowing example

```text
repo/
  AGENTS.md
  packages/api/
    AGENTS.md
    .claude/CLAUDE.md
```

Starting in `repo/packages/api`:

- Both bare `AGENTS.md` files load through `native` (priority 100): `repo/AGENTS.md` at depth 2 and `repo/packages/api/AGENTS.md` at depth 0.
- `repo/packages/api/.claude/CLAUDE.md` (`claude`, priority 80) also resolves to depth 0 and is shadowed there by the higher-priority native file.
- The kept files are ordered root-first, package-last, so `packages/api`'s file is the more specific one within the project group.
- If you add `repo/packages/api/.veyyon/AGENTS.md`, it is the nearest non-empty `.veyyon/AGENTS.md` and loads as the project context file at its depth; `repo/.veyyon/AGENTS.md` is not also included.

## Injection behavior

Discovered context files are injected into the opening project prompt as a single `<context>` block, one `<file>` element per surviving file, least authoritative first, so the project files come before the profile file and the global file comes last:

```xml
The user's instructions in this conversation have ABSOLUTE authority. ...

<context>
The user-authored context files below rank from BROADEST to NARROWEST, and a narrower file NEVER overrides a broader one:

1. The user's OWN configuration, from their home config directory. ...
2. The active profile's configuration.
3. The PROJECT's files, from the repository you are working in. LOWEST authority of the three.
...
<file path="/abs/path/to/repo/AGENTS.md">
...root content...
</file>
<file path="/abs/path/to/repo/packages/api/AGENTS.md">
...package content...
</file>
<file path="/home/you/.veyyon/AGENTS.md">
...your own standing rules...
</file>

Precedence again, because you have just read these files in ascending order of authority and the
one you read FIRST is the narrowest, not the strongest: ...
</context>
```

The agent sees each file's absolute path and its fully expanded Markdown content (with `@` imports already resolved, see below). When discovery is enabled, matching context files are injected at session start.

A sentence stating that your live instruction in the conversation has absolute authority renders in every session, whether or not any context file loaded, because a rule or a memory can tell the agent to refuse just as a file can. The scope ladder above renders only when at least one context file loaded, since there is nothing to rank otherwise. Below your live instruction, the surviving context files win over conflicting generic Veyyon workflow defaults, retrieved material, and historical summaries; among themselves they rank by the scope ladder, and a project file never overrides your own configuration.

Deeper-directory `AGENTS.md` files that were *not* auto-loaded (for example, ones below the current directory) are surfaced separately in a `<dir-context>` block that lists their paths and tells the agent to read them before editing those directories. Those files are pointers, not full injected content.

## `@` imports

Inside any context file, an `@path` token expands inline to the referenced file's content before injection:

```markdown
# Project notes

Read @docs/architecture.md before changing storage code.
Shared release steps live in @../RELEASE.md and personal aliases in @~/.notes/aliases.md.
```

The exact rules:

- **Relative paths resolve from the importing file's own directory**, not the session's working directory.
- **`~/` and `~`** resolve from the user's home directory; absolute paths are used as-is.
- **Tokens inside fenced code blocks and inline code spans are left untouched**: useful when you want to *write about* an `@token` without expanding it.
- **`git@github.com:org/repo.git` and `user@example.com`-style tokens are not treated as imports.** A token only counts when the `@` sits at the start of a line or after a space or tab.
- **Trailing sentence punctuation is trimmed** off the path (`. , ; : ! ? ) ] } " '`), so `@notes/setup.md.` imports `notes/setup.md`.
- **Imports recurse up to five hops.** An imported file may itself contain `@` imports, up to a total depth of five.
- **Cycles are skipped.** A file already pulled into the current expansion tree is not re-expanded, so mutual imports terminate cleanly.
- **A missing or unreadable target leaves the original `@token` text in place** rather than erroring.

## Sticky rules vs normal context

Use a normal context file (`AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, …) for the bulk of your guidance: repository overview, code style, build and test commands, review expectations, and local conventions. These load into the opening `<context>` block.

Use a top-level **`RULES.md`** for the handful of hard requirements that must stay active even after a long conversation has pushed the opening context far up the transcript:

```markdown
# ~/.veyyon/profiles/<profile>/agent/RULES.md

Never commit or push unless the user explicitly asks.
Do not edit generated files.
```

`RULES.md` is special:

- It is read **only** at the user location `~/.veyyon/profiles/<profile>/agent/RULES.md`. A `RULES.md` anywhere else, including inside a repository, is not a context-file convention and is ignored.
- It is loaded as an **always-apply rule**, not as a context file, so it is re-attached near the current turn and keeps its hold across long sessions.
- It is **always sticky**: frontmatter cannot make it non-sticky. If you want conditional or opt-in behavior, write a normal rule file instead (see [Skills](./skills.md)).

Keep `RULES.md` short. Long background belongs in `AGENTS.md`, where it costs context budget only once.

## Disabling discovery providers

Turn a provider off with the `disabledProviders` setting in `~/.veyyon/profiles/<profile>/agent/config.yml` or a `--config` overlay:

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
disabledProviders:
  - claude
  - github
```

`disabledProviders` is a **whole-provider switch with one shared id namespace**, used by two unrelated subsystems:

| Id kind | Examples | Effect when listed |
|---|---|---|
| Discovery provider ids | `native`, `claude`, `codex`, `gemini`, `opencode`, `github`, `agents`, `agents-md` | The entire config source is removed, not just its context files, but also any MCP servers, slash commands, skills, hooks, tools, prompts, and settings it would have contributed. |
| Model provider ids | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter` | The model backend is removed from selection even when its credentials are present. See [Providers](./providers.md). |

Ids are exact and the two namespaces do not collide by accident: `google` disables the Google model backend, while `gemini` disables the Gemini CLI discovery files. Disabling a discovery provider is heavier than it looks, disabling `claude`, for instance, also drops Claude-discovered MCP servers, commands, skills, hooks, tools, and settings, not only `CLAUDE.md`.

Only `enabledModels` and `disabledProviders` support **path-scoped** entries, so you can vary provider availability per subtree:

```yaml
disabledProviders:
  - github            # disabled everywhere
  - path: ~/work/legacy-claude
    providers:
      - claude         # disabled only under this directory
```

A scoped entry applies when the cwd equals the configured path or sits beneath it; `~` expands to home. Bare string entries apply everywhere.

Remember that higher-precedence settings layers **replace** array settings rather than appending to them. If your profile config disables `claude` but a `--config` overlay sets `disabledProviders: [github]`, then in that process Claude discovery is re-enabled and only GitHub is disabled. See [Settings](./settings.md) for the full layer precedence, merge rules, and path-scoped array details.

## Troubleshooting

### A file is not loaded

- Native project context must live at `.veyyon/AGENTS.md`, and the `.veyyon/` directory must be non-empty; an empty `.veyyon/` is skipped and the walk-up continues to the next ancestor.
- A standalone `AGENTS.md` or `CLAUDE.md` at any ancestor is loaded by `native` itself; `agents-md` contributes only when `native` is disabled. A `CLAUDE.md` is skipped when the same directory has a usable `AGENTS.md` or `.veyyon/AGENTS.md`; that is deliberate, see [Load order and shadowing](#load-order-and-shadowing).
- `.claude/CLAUDE.md` is read only from the current working directory, not from every ancestor. `.gemini/GEMINI.md` and `.github/copilot-instructions.md` are user-level only; a repository's copies are not read.
- `~/.codex/AGENTS.md` and `~/.config/opencode/AGENTS.md` are user-level only and have no project equivalent.
- Empty files contribute nothing for the native and standalone providers.
- A disabled discovery provider contributes nothing: check `disabledProviders` across your profile and `--config` layers.

### The wrong file wins

At one user scope or project depth, the higher-priority provider shadows the others (native > claude > agents/codex > gemini > opencode > github > agents-md). To force deterministic behavior, move your guidance into `.veyyon/AGENTS.md` (native always wins) or disable the competing discovery provider.

### User context disappeared

Only one user-level context file survives, and `~/.veyyon/profiles/<profile>/agent/AGENTS.md` has the highest priority. If it exists, it shadows user-level `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.config/opencode/AGENTS.md`, `~/.copilot/copilot-instructions.md`, and `~/.agent`/`~/.agents` files. Consolidate user guidance into the native file or remove the native one if you prefer another tool's file. A profile without one falls through to the next-priority user file (typically `~/.claude/CLAUDE.md`).

### A `RULES.md` file is ignored

Only one native `RULES.md` location is sticky: `~/.veyyon/profiles/<profile>/agent/RULES.md`. A `RULES.md` in any other directory, including a repository's `.veyyon/`, is not a recognized convention and will not be loaded.

### An `@` import did not expand

Confirm the target exists relative to the importing file (not the cwd). Imports inside fenced code blocks or inline code spans are intentionally left literal, `git@`/email-looking tokens are never imported, cycles are skipped, expansion stops after five hops, and a missing target leaves the original `@path` text unchanged.
