# Skills

Skills are file-backed capability packs discovered at startup and exposed to the model as:

- lightweight metadata in the system prompt (name + description)
- on-demand content via the `read` tool against `skill://...`
- optional interactive `/skill:<name>` commands

Implementation: `src/extensibility/skills.ts`, `src/discovery/builtin.ts`, `src/internal-urls/skill-protocol.ts`, `src/discovery/agents-md.ts`.

## What a skill is in this codebase

A discovered skill is represented as:

- `name`
- `description`
- `filePath` (the `SKILL.md` path)
- `baseDir` (skill directory)
- source metadata (`provider`, `level`, path)

The runtime only requires `name` and `path` for validity. In practice, matching quality depends on `description` being meaningful.

## Required layout and SKILL.md expectations

### Directory layout

Skills are discovered as **one level under `skills/`**:

- `<skills-root>/<skill-name>/SKILL.md`

Nested patterns like `<skills-root>/group/<skill>/SKILL.md` are not discovered.

```text
Discovered layout (non-recursive under skills/):

<root>/skills/
  ├─ postgres/
  │   └─ SKILL.md      ✅ discovered
  ├─ pdf/
  │   └─ SKILL.md      ✅ discovered
  └─ team/
      └─ internal/
          └─ SKILL.md  ❌ not discovered (nested)
```

### `SKILL.md` frontmatter

Supported frontmatter fields on the skill type:

- `name?: string`
- `description?: string`
- `globs?: string[]`
- `alwaysApply?: boolean`
- `hide?: boolean`
- `disableModelInvocation?: boolean` (Agent Skills equivalent of `hide`; normalized from kebab-case `disable-model-invocation`)
- additional keys are preserved as unknown metadata

Current runtime behavior:

- `name` defaults to the skill directory name
- `description` is required for both providers that load skills ambiently:
  - native `.veyyon` provider (`requireDescription: true`), the profile's `skills/` dir
  - `veyyon-plugins` extension-package skills (`requireDescription: true`)
- the managed (auto-learn) provider also requires a description

## Discovery pipeline

Skills load only from the active profile. `loadSkills()` passes an explicit
provider allowlist to `loadCapability("skills")`, so only the profile-native
providers run and no foreign-tool directory is ever scanned:

- `native` (priority 100): the profile's `.../agent/skills` dir, user level only, via `src/discovery/builtin.ts`. Project-local `.veyyon/skills` is deliberately not scanned.
- `veyyon-plugins` (priority 90): `skills/` bundled with plugins installed into the active profile
- `veyyon-managed` (priority 5): auto-learn skills under `.../agent/managed-skills`, discovered unconditionally (only writing/nudging is gated by `autolearn.enabled`); always defers to a same-named authored skill

The allowlist is defined by `profileSkillProviderIds()` in `src/extensibility/skills.ts`. If `skills.enabled` is `false`, discovery returns no skills.

Dedup key is skill name; the first item with a given name wins, and a same-named authored (`native` or `veyyon-plugins`) skill always beats the managed one.

### Foreign providers are import-only

The `claude`, `codex`, `agents`, `opencode`, `claude-plugins`, and `github`
skill providers are still registered, but they are **not** in the ambient
allowlist, so they never contribute skills to a session. They exist to feed the
onboarding import scan (`scanForeignConfig` in `src/discovery/import-scan.ts`),
which enumerates user-level foreign skills so you can copy the ones you want into
the active profile. An imported skill becomes a profile-native `native` skill.

### Filtering

Beyond the allowlist, `loadSkills()` applies these name-based controls:

- `disabledExtensions` entries with `skill:<name>`
- `ignoredSkills` (exclude; glob patterns)
- `includeSkills` (include allowlist; glob patterns; empty means include all)

Filter order is: not disabled by `disabledExtensions`, then not ignored, then included (if an include list is present). There are no per-source toggles.

### Collision and duplicate handling

- Capability dedup already keeps the first skill per name (highest-precedence provider)
- `extensibility/skills.ts` additionally:
  - de-duplicates identical files by `realpath` (symlink-safe)
  - emits collision warnings when a later skill name conflicts
  - keeps the convenience `loadSkillsFromDir({ dir, source })` API as a thin adapter over `scanSkillsFromDir`

## Runtime usage behavior

### System prompt exposure

System prompt construction (`src/system-prompt.ts`) uses discovered skills as follows:

- if `read` tool is available:
  - include discovered skills list in prompt, excluding skills with `hide: true`
- otherwise:
  - omit discovered list

`hide: true` does not disable the skill. Hidden skills are still loaded and remain reachable through `skill://<name>` and `/skill:<name>` when skill commands are enabled.

Task tool subagents receive the session's discovered/provided skills list via normal session creation; there is no per-task skill pinning override.

### Interactive `/skill:<name>` commands

If `skills.enableSkillCommands` is true, interactive mode registers one slash command per discovered skill.

`/skill:<name> [args]` behavior:

- reads the skill file directly from `filePath`
- strips frontmatter
- injects skill body as a custom message
- delivery mode follows the **submission keybinding**:
  - **Enter** → invokes the skill on the `steer` queue while streaming (matches free-text Enter, which also steers), or as a normal idle prompt when the agent is not streaming
  - **Ctrl+Enter** (`app.message.followUp`) → invokes the skill on the `followUp` queue while streaming, or as a normal idle prompt when the agent is not streaming
- appends metadata (`Skill: <path>`, optional `User: <args>`)

There is no flag, mode-selector, or frontmatter knob to override this, the keybinding _is_ the choice, identical to how free text is routed during streaming (`input-controller.ts:562-568` for Enter, `input-controller.ts:961-966` for Ctrl+Enter; both dispatch through `#invokeSkillCommand`).

## `skill://` URL behavior

`src/internal-urls/skill-protocol.ts` supports:

- `skill://<name>` → resolves to that skill's `SKILL.md`
- `skill://<name>/<relative-path>` → resolves inside that skill directory

```text
skill:// URL resolution

skill://pdf
  -> <pdf-base>/SKILL.md

skill://pdf/references/tables.md
  -> <pdf-base>/references/tables.md

Guards:
- reject absolute paths
- reject `..` traversal
- reject any resolved path escaping <pdf-base>
```

Resolution details:

- skill name must match exactly
- relative paths are URL-decoded
- absolute paths are rejected
- path traversal (`..`) is rejected
- resolved path must remain within `baseDir`
- missing files return an explicit `File not found` error

Content type:

- `.md` => `text/markdown`
- everything else => `text/plain`

No fallback search is performed for missing assets.

## Skills vs AGENTS.md, commands, tools, hooks

### Skills vs AGENTS.md

- **Skills**: named, optional capability packs selected by task context or explicitly requested
- **AGENTS.md/context files**: persistent instruction files loaded as context-file capability and merged by level/depth rules

`src/discovery/agents-md.ts` specifically walks ancestor directories from `cwd` to discover standalone `AGENTS.md` files (stopping at the repo root, or home when no repo root is known), skipping files whose containing directory name starts with a dot.

### Skills vs slash commands

- **Skills**: model-readable knowledge/workflow content
- **Slash commands**: user-invoked command entry points
- `/skill:<name>` is a convenience wrapper that injects skill text; it does not change skill discovery semantics

### Skills vs custom tools

- **Skills**: documentation/workflow content loaded through prompt context and `read`
- **Custom tools**: executable tool APIs callable by the model with schemas and runtime side effects

### Skills vs hooks

- **Skills**: passive content
- **Hooks**: event-driven runtime interceptors that can block/modify behavior during execution

## Practical authoring guidance tied to discovery logic

- Put each skill in its own directory: `<skills-root>/<skill-name>/SKILL.md`
- Always include explicit `name` and `description` frontmatter
- Keep referenced assets under the same skill directory and access with `skill://<name>/...`
- Put every skill in the active profile's `skills/` dir; there is no nested-taxonomy or custom-directory scanning
- Avoid duplicate skill names; the first match wins by provider precedence (authored beats managed)
