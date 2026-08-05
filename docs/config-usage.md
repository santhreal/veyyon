# Configuration Discovery and Resolution

How the coding agent resolves configuration: roots scanned, precedence, and consumption by settings, skills, hooks, tools, and extensions.

## Scope

Primary implementation:

- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/config/config-file.ts` (re-exported from `config.ts`)
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/src/discovery/builtin.ts`
- `packages/coding-agent/src/discovery/helpers.ts`

Key integration points:

- `packages/coding-agent/src/capability/index.ts`
- `packages/coding-agent/src/discovery/index.ts`
- `packages/coding-agent/src/extensibility/skills.ts`
- `packages/coding-agent/src/extensibility/hooks/loader.ts`
- `packages/coding-agent/src/extensibility/custom-tools/loader.ts`
- `packages/coding-agent/src/extensibility/extensions/loader.ts`

---

## Resolution flow (visual)

```text
         Generic helper order (`config.ts`)
┌───────────────────────────────────────┐
│ 1) ~/.veyyon/profiles/default/agent, ~/.claude, ...       │
│ 2) <cwd>/.veyyon, <cwd>/.claude, ...     │
└───────────────────────────────────────┘
                    │
                    ▼
        capability providers enumerate items
 (capability discovery reads HOME only: a working tree is
  untrusted input and contributes nothing but context files;
  the project bases above survive only in the generic helper
  for the callers that still use it, such as TITLE_SYSTEM.md)
                    │
                    ▼
      provider priority sort + capability dedup
                    │
                    ▼
          subsystem-specific consumption
   (settings, skills, hooks, tools, extensions)
```

## 1) Config roots and source order

## Canonical roots

`src/config.ts` defines a fixed source priority list:

1. `.veyyon` (native)
2. `.claude`
3. `.codex`
4. `.gemini`

User-level bases:

- `~/.veyyon/profiles/default/agent`
- `~/.claude`
- `~/.codex`
- `~/.gemini`

Project-level bases:

- `<cwd>/.veyyon`
- `<cwd>/.claude`
- `<cwd>/.codex`
- `<cwd>/.gemini`

The project bases exist in the generic helper, but capability discovery no longer uses them: a checked-out working tree is untrusted input, so a repository contributes context files (`AGENTS.md` / `CLAUDE.md`) and nothing else. The remaining caller of the project bases is `TITLE_SYSTEM.md` discovery (see [Session title prompt override](#session-title-prompt-override)).

`CONFIG_DIR_NAME` is `.veyyon` (`packages/utils/src/dirs.ts`).

## Profiles

A named profile (`veyyon --profile <name>`, `/profile <name>` in the TUI, or `VEYYON_PROFILE`) selects which profile agent dir is active. The default profile is `~/.veyyon/profiles/default/agent/`; profile `<name>` is `~/.veyyon/profiles/<name>/agent/`. Paths written in this document as `~/.veyyon/profiles/default/agent/...` mean the **active** profile's agent directory.

The relocation is uniform across the native provider (`builtin.ts`) and the generic `config.ts` helpers. It covers slash commands, sticky rules, prompts, instructions, hooks, tools, extensions, settings, skills, MCP, the top-level `RULES.md` and `AGENTS.md` files, `PROMPT_SECTIONS/`, and runtime state (sessions, blobs, `agent.db`). A profile sees only its own Veyyon config, never the default profile's `~/.veyyon/profiles/default/agent`.

Keybindings get a one-time seed rather than a live merge: a new named profile copies the default profile's `~/.veyyon/profiles/default/agent/keybindings.*` once (at `profile new`, or on first launch of an older profile that has no keybindings file). After that the profile's own file is the only one read, later edits to the default profile's keybindings do not flow into other profiles.

The other source bases are not profile-scoped and load identically under every profile: the external-tool bases (`~/.claude`, `~/.codex`, `~/.gemini`) belong to those tools. Throughout this document, read `~/.veyyon/profiles/default/agent` as shorthand for the active profile's agent directory.

## Important constraint

The generic helpers in `src/config.ts` do **not** include `.pi` in source discovery order.

---

## 2) Core discovery helpers (`src/config.ts`)

## `getConfigDirs(subpath, options)`

Returns ordered entries:

- User-level entries first (by source priority)
- Then project-level entries (by same source priority)

Options:

- `user` (default `true`)
- `project` (default `true`)
- `cwd` (default `getProjectDir()`)
- `existingOnly` (default `false`)

This API is used for directory-based config lookups (commands, hooks, tools, agents, etc.).

## `findConfigFile(subpath, options)` / `findConfigFileWithMeta(...)`

Searches for the first existing file across ordered bases, returns first match (path-only or path+metadata).

## `findAllNearestProjectConfigDirs(subpath, cwd)`

Walks parent directories upward and returns the **nearest existing directory per source base** (`.veyyon`, `.claude`, `.codex`, `.gemini`), then sorts results by source priority.

This helper predates the untrusted-working-tree rule and survives for the callers that legitimately key on the working directory (plugin install scopes). It is not a path for a repository to configure the agent.

---

## 3) File config wrapper (`ConfigFile<T>` in `src/config/config-file.ts`, re-exported from `src/config.ts`)

`ConfigFile<T>` is the schema-validated loader for single config files.

Supported formats:

- `.yml` / `.yaml`
- `.json` / `.jsonc`

Behavior:

- Validates parsed data against a provided Zod schema.
- Caches load result until `invalidate()`.
- Returns tri-state result via `tryLoad()`:
  - `ok`
  - `not-found`
  - `error` (`ConfigError` with schema/parse context)

Legacy migration still supported:

- If target path is `.yml`/`.yaml`, a sibling `.json` is auto-migrated once (`migrateJsonToYml`).

---

## 4) Settings resolution model (`src/config/settings.ts`)

The runtime settings model is layered:

1. Profile settings: `~/.veyyon/profiles/<name>/agent/config.yml`
2. CLI config overlays: `veyyon --config <path>` / repeated `--config` files, loaded as `config.yml`-style YAML for this process only
3. Runtime overrides: in-memory, non-persistent
4. Schema defaults: from `SETTINGS_SCHEMA`

There is no project layer. A `.veyyon/config.yml` or `.veyyon/settings.json` inside a working tree is never read, because a checked-in file would let any cloned repository configure the agent (the measured escalation was `tools.approvalMode: yolo` shipped in a repo's `settings.json`).

Effective precedence:

`defaults <- profile <- CLI config overlays <- overrides`

Write behavior:

- `settings.set(...)` writes to the **profile** layer (`config.yml`) and queues background save.

## Migration behavior still active

On startup, if `config.yml` is missing:

1. Migrate from `~/.veyyon/profiles/default/agent/settings.json` (renamed to `.bak` on success)
2. Merge with legacy DB settings from `agent.db`
3. Write merged result to `config.yml`

Field-level migrations in `#migrateRawSettings`:

- `queueMode` -> `steeringMode`
- `ask.timeout` milliseconds -> seconds when the old value looks like ms (`> 1000`). The threshold is a guess, because nothing on disk says which format a file uses, so the rewrite is logged with both values. Every other migration here is a fixed point; this one is not, which is why `packages/coding-agent/test/settings-migration-idempotence.test.ts` pins the property.
- Legacy flat `theme: "..."` -> `theme.dark/theme.light` structure

---

## 5) Capability/discovery integration

Most non-core config loading flows through the capability registry (`src/capability/index.ts` + `src/discovery/index.ts`).

## Provider ordering

Providers are sorted by numeric priority (higher first). Example priorities:

- Native Veyyon (`builtin.ts`): `100`
- Claude: `80`
- Codex / agents / Claude marketplace: `70`
- Gemini: `60`

```text
Provider precedence (higher wins)

native (.veyyon)          priority 100
claude                 priority  80
codex / agents / ...   priority  70
gemini                 priority  60
```

## Dedup semantics

Capabilities define a `key(item)`:

- same key => first item wins (higher-priority/earlier-loaded item)
- no key (`undefined`) => no dedup, all items retained

Relevant keys:

- skills: `name`
- tools: `name`
- hooks: `${type}:${tool}:${name}`
- extension modules: `name`
- extensions: `name`
- settings: no dedup (all items preserved)

---

## 6) Native `.veyyon` provider behavior (`packages/coding-agent/src/discovery/builtin.ts`)

Native provider (`id: native`) reads native config from one place: the active profile's agent directory, `~/.veyyon/profiles/<name>/agent/...`. The provider's config-dir helper resolves HOME only. `<cwd>/.veyyon` used to be pushed at level `"project"`, and six capabilities read it through that one helper (slash commands, rules, prompts, instructions, hooks, tools) plus extension modules and settings; that is gone, because one line in a cloned repo configured the agent. The only thing a repository still contributes is the context-file walk.

### Directory admission rules

- The profile agent directory is used only when it exists and is non-empty.
- Skills are loaded only from the active profile's agent dir (`~/.veyyon/profiles/<name>/agent/skills`). Project-local `.veyyon/skills` directories are deliberately not scanned, so no repository can inject skills into a session by ambient autodiscovery.
- `AGENTS.md` has three scopes: the global cross-profile `~/.veyyon/AGENTS.md`, the active profile's first matching instruction file, and the project walk from the working directory to the repository root (one file per directory level: `.veyyon/AGENTS.md` at the nearest non-empty `.veyyon/` claims its level, bare `AGENTS.md` next, bare `CLAUDE.md` last). `RULES.md` is the active profile's file only; a repository's `.veyyon/RULES.md` is not read. Persistent system-prompt changes use `PROMPT_SECTIONS/` under the active profile's agent dir. See [`docs/system-prompt-customization.md`](./system-prompt-customization.md).

### Scope-specific loading

All under the active profile's agent dir:

- Skills: `skills/*/SKILL.md`
- Slash commands: `commands/*.md`
- Rules: `rules/*.{md,mdc}`
- Prompts: `prompts/*.md`
- Instructions: `instructions/*.md`
- Hooks: `hooks/pre/*`, `hooks/post/*` are scanned in full, but only `.ts` and `.js` entries load; anything else is reported as skipped
- Tools: `tools/*.{json,md,ts,js,sh,bash,py}` and `tools/<name>/index.ts`
- Extension modules: discovered under `extensions/` (+ legacy `settings.json.extensions` string array)
- Extensions: `extensions/<name>/gemini-extension.json`
- Settings: `config.yml` (plus the one-time `settings.json` migration)

### Project context-file walk

The native provider's only project-scope read is the context-file walk: the nearest non-empty `.veyyon/` directory's `AGENTS.md` claims its own directory level, and every level from the repository root down to the cwd contributes at most one file (`.veyyon/AGENTS.md`, else bare `AGENTS.md`, else bare `CLAUDE.md`).

## 7) How major subsystems consume config

## Settings subsystem

- `Settings.init()` loads the profile `config.yml`, the machine-global bindings, CLI `--config` overlays, and runtime overrides. Nothing is read from the working tree.

### Session title prompt override

Create `TITLE_SYSTEM.md` in a supported config base:

```text
# ~/.veyyon/profiles/default/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
```

- Missing `TITLE_SYSTEM.md` keeps the bundled title prompts.
- Discovery checks project config bases first, including `.veyyon/TITLE_SYSTEM.md`, then the active profile's `agent/TITLE_SYSTEM.md` and the supported external-tool config bases.
- The file replaces only the automatic session-title generation system prompt. The agent's own base prompt is assembled. Use `--system-prompt` or `--append-system-prompt` for a one-run override, or `PROMPT_SECTIONS/` for persistent section changes.
- The online path asks the title model to wrap the title in `<title>...</title>` and parses it leniently from text (a plain sentence, a truncated/unclosed tag, or a stray `{"title": "..."}` JSON echo all still work). A `TITLE_SYSTEM.md` override gets the wrap-in-`<title>` instruction appended after it. The local tiny-title path keeps the `<title>...</title>` prefill/stop wrapper and uses this file as its system turn.

## Skills subsystem

- `extensibility/skills.ts` loads via `loadCapability(skillCapability.id, { cwd, providers: profileSkillProviderIds() })`.
- The allowlist (`native`, `veyyon-managed`, `veyyon-plugins`) scopes discovery to the active profile; foreign-tool skill providers are never scanned ambiently (they feed the import scan only).
- Applies name-based filters only: `disabledExtensions`, `ignoredSkills`, `includeSkills`. There are no per-source toggles and no custom directories.

## Hooks subsystem

- `discoverAndLoadHooks()` resolves hook paths from hook capability + explicit configured paths.
- Then loads modules via Bun import.

## Tools subsystem

- `discoverAndLoadCustomTools()` resolves tool paths from tool capability + plugin tool paths + explicit configured paths.
- Declarative `.md/.json` tool files are metadata only; executable loading expects code modules.

## Extensions subsystem

- `discoverAndLoadExtensions()` resolves extension modules from extension-module capability plus explicit paths.
- Current implementation intentionally keeps only capability items with `_source.provider === "native"` before loading.

---

## 8) Precedence rules to rely on

Use this mental model:

1. Source directory ordering from `config.ts` determines candidate path order.
2. Capability provider priority determines cross-provider precedence.
3. Capability key dedup determines collision behavior (first wins for keyed capabilities).
4. Subsystem-specific merge logic can further change effective precedence (especially settings).

### Settings-specific caveat

The settings layers deep-merge in a fixed order (profile, then `--config` overlays, then runtime overrides). Because merge applies later layer values over earlier values, an overlay's array replaces the profile array rather than appending to it.

---

## 9) Legacy/compatibility behaviors still present

- `ConfigFile` JSON -> YAML migration for YAML-targeted files.
- Settings migration from `settings.json` and `agent.db` to `config.yml`.
- Settings key migrations include `queueMode`, `ask.timeout`, flat `theme`, `task.isolation.enabled`, legacy `task.isolation.mode` values, the whole `task.*` group plus `modelRoles.task` moving to `subagent.*`, removed edit modes, `statusLine.plan_mode`, `memories.enabled`, and hindsight scoping/name fields.
- The removed per-source skill toggles (`skills.enableCodexUser`, `skills.enableClaudeUser`, `skills.enableClaudeProject`, `skills.enablePiUser`, `skills.enablePiProject`, `skills.enableAgentsUser`, `skills.enableAgentsProject`) and `skills.customDirectories` are no longer read. Skills load only from the active profile. A stale key in an old `config.yml` is ignored, not an error.

If these compatibility paths are removed in code, update this document immediately; several runtime behaviors still depend on them today.
