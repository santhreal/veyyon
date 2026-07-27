# Export and import

## Session export

`/export [path]` writes the current session transcript as a standalone offline HTML file. With no
argument it writes `veyyon-session-<session>.html` in the working directory.

The path is used as given (relative paths resolve against the process working directory). There is no
`~` expansion or directory fallback, so pass a full file path ending in `.html`.

## Migration from Claude Code

`/import` is **not** in the builtin slash registry; Claude migration runs through the setup wizard's
import scene. It offers user-level foreign skills and `CLAUDE.md`/`AGENTS.md` instruction files and
copies the selected ones into the active profile.

Typical migrated items:

- Skills → the active profile's `skills` directory (`~/.veyyon/profiles/<profile>/agent/skills`)
- `CLAUDE.md`/`AGENTS.md` content → appended to the profile `AGENTS.md` under an `<!-- imported from … -->` marker

Ambient loading of foreign `.claude` configuration is a separate opt-in (`discovery.importForeignConfig`,
default off).

See [Migration guide](../using/migration-guide.md).
