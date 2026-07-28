# Plugins

A plugin bundles several extensions into one installable package: skills, MCP servers,
hooks, and related assets that ship and update together. Reach for a plugin when you want to
share a whole capability at once instead of wiring each piece by hand. See
[Connectors](./connectors.md) for the current integration surface (MCP, plugins, hooks, and skills).

## Plugin Structure

Every plugin is a directory with a `.claude-plugin/plugin.json` manifest file (the Claude
Code-compatible path). The manifest describes the plugin's metadata and lists its integration points.

### Plugin Manifest (`plugin.json`)

Veyyon reads these fields from `plugin.json`:

| Field | Type | Description |
| --- | --- | --- |
| `name` | String | The unique name of the plugin. Lowercase ASCII alphanumerics with interior dots and hyphens (no leading/trailing separator, no underscores), at most 64 characters. |
| `version` | String | The version of the plugin (optional). When omitted, the installed version resolves in this order: marketplace catalog entry version, then this manifest or `package.json`, then the source git SHA truncated to 7 characters, then `"0.0.0"`. |
| `description` | String | A description of the plugin (optional). |
| `skills` | String or Array of Strings | Path or paths to directories containing skill definitions (optional). |
| `commands` / `slash-commands` | String or Array of Strings | Path or paths to command definitions (optional). |

Other plugin content loads from conventional locations rather than manifest fields: MCP servers from
a `.mcp.json` file at the plugin root, and hooks from executable files under the plugin's
`hooks/pre/` and `hooks/post/` directories.

## Marketplaces

Marketplaces are collections of plugins. A marketplace is a directory or Git repository containing a `marketplace.json` catalog manifest.

Veyyon checks the following relative paths under a marketplace root to locate its catalog manifest:
1. `.veyyon-plugin/marketplace.json` (preferred)
2. `.claude-plugin/marketplace.json` (Claude Code-compatible fallback)

The marketplace catalog requires a `name`, an `owner.name`, and a `plugins` list. Each plugin entry
requires only a `name` and a `source`; optional entry metadata includes `description`, `version`,
`author`, `homepage`, `repository`, `license`, `keywords`, `category`, `tags`, `strict`, and embedded
capability fields (`commands`, `agents`, `hooks`, `mcpServers`, `lspServers`, `dapAdapters`). A source
can point to a local directory, a Git repository (with optional branch, tag, commit ref, or
subdirectory path), a URL, or an npm package.

## File Locations

Plugin install state is **profile-scoped** under `~/.veyyon/profiles/<profile>/plugins/` (default profile: `profiles/default/plugins/`). Config root is relocatable with `VEYYON_CONFIG_DIR`.

| Path | Description |
| --- | --- |
| `~/.veyyon/profiles/<profile>/plugins/installed_plugins.json` | User-scope marketplace install registry |
| `~/.veyyon/profiles/<profile>/plugins/node_modules/` | npm/git/link plugin packages |
| `~/.veyyon/profiles/<profile>/plugins/cache/` | Cached marketplace catalogs and plugin trees |
| `~/.veyyon/profiles/<profile>/plugins/veyyon-plugins.lock.json` | Lockfile for npm plugin installs |
| Project `.veyyon/plugins/installed_plugins.json` | Project-scope marketplace installs |

## Command Line Interface

You can manage plugins and marketplaces using the `veyyon plugin` and `veyyon plugin marketplace` command groups.

### Managing Plugins

#### Install a Plugin

Install a plugin from a configured marketplace. Specify the plugin as `plugin_name@marketplace_name`.

```console
$ veyyon plugin install sample@debug
$ veyyon plugin install --force --scope project sample@debug
```

Use `--force` to reinstall over an existing install and `--scope user|project` to choose the install
scope. `--json` prints the installation result as JSON for npm and link installs; marketplace
installs ignore it.

#### List Plugins

List installed plugins and their statuses.

```console
$ veyyon plugin list
```

Options:
* `--json`: Print the output as JSON.

#### Uninstall a Plugin

Uninstall a plugin from local cache and config.

```console
$ veyyon plugin uninstall sample@debug
```

Use the `--json` flag to return the removal result as JSON for npm plugins; marketplace uninstalls
ignore it.

#### Check Plugin Health

Report what is wrong with your plugin installation, and optionally repair it.

```console
$ veyyon plugin doctor
$ veyyon plugin doctor --fix
$ veyyon plugin doctor --json
```

Each check reports `ok`, a warning, or an error. `doctor` exits 1 when any error is left unrepaired
and 0 otherwise, so you can gate a script on it. Warnings never affect the exit code, and an error
that `--fix` repaired does not either. `--json` prints the checks as an array instead of the
human-readable report.

On a machine with no plugins installed every check is `ok`: nothing is missing, because nothing was
ever installed. That is the state a fresh install is in, and `doctor` is quiet about it on purpose.

The checks are:

* `plugins_directory`, `package_manifest`, `node_modules`: the three things a plugin install needs.
  Each one distinguishes "not created yet" from "there but unreadable". The first is normal and
  reports `ok`; the second is an error naming the path, because a plugins directory whose permissions
  have been mangled looks identical to an empty one from the outside and the fix is `chmod`, not a
  reinstall.
* `plugin:<name>`: one per installed plugin. An error means the package is missing from
  `node_modules` or has no `package.json`. A warning means it loaded but carries no plugin manifest,
  so veyyon can see the package and cannot use it.
* `plugin:<name>:tools`, `:hooks`, `:extension:<path>`: an entry point the manifest names and the
  package does not contain.
* `plugin:<name>:feature:<feature>`: a feature you enabled that the plugin's manifest does not
  define, usually because the plugin dropped it in an update. A warning, since the plugin still
  works.
* `orphan:<name>`: a plugin your config enables that is not installed. A warning, since your config
  is intact and only the package is gone.
* `plugin_config`, `installed_registry`: reported only when one of those files cannot be read.
  `doctor` continues and reports the rest, so one unreadable file does not cost you the whole
  report.

`--fix` repairs what can be repaired without a decision: it runs an install for a missing package,
drops an orphaned config entry, and removes an enabled feature the manifest does not define. A check
that was repaired says so. Everything else is left for you, because the remedy depends on what you
meant.

### Managing Marketplaces

#### Add a Marketplace

Add a local path or Git repository to your configured marketplace sources.

```console
$ veyyon plugin marketplace add ./path/to/marketplace
$ veyyon plugin marketplace add owner/repo
$ veyyon plugin marketplace add https://github.com/owner/repo
```

#### List Marketplaces

List all configured marketplaces and their sources.

```console
$ veyyon plugin marketplace list
```

#### Update Marketplaces

Fetch the latest revisions for configured Git marketplaces. Omit the marketplace name to update all configured Git marketplaces.

```console
$ veyyon plugin marketplace update
$ veyyon plugin marketplace update debug
```

#### Remove a Marketplace

Remove a configured marketplace by name.

```console
$ veyyon plugin marketplace remove debug
```

The `plugin marketplace` subcommands print human-readable output only; `--json` has no effect on them.

## TUI Integration

### Slash Commands

* `/plugins`: Lists installed npm and link plugins.
* `/extensions`: Opens the Extension Control Center dashboard, which shows plugin-provided skills, tools, and hooks alongside everything else that is loaded.

The Plugins tab of `/settings` lists installed npm and marketplace plugins and toggles each one on or
off. Browsing and installing happen through the `veyyon plugin` CLI.

## Registry Files

Marketplace and plugin state is not kept in `config.yml`. Two JSON registries, managed
by the `veyyon plugin` CLI (and the `/settings` Plugins tab for the enabled toggle; edit through
those, not by hand):

- **`marketplaces.json`** (`~/.veyyon/profiles/<profile>/marketplaces.json`, the profile root beside
  `agent/` and `plugins/`): which catalogs you have added. Each entry records the marketplace `name`,
  `sourceType`, `sourceUri`, `catalogPath`, and added/updated timestamps.
- **`installed_plugins.json`** (under the plugins dir): which plugins are installed. Each
  entry is keyed `<plugin_name>@<marketplace_name>` and records the install `scope`
  (user or project), `installPath`, `version`, install/update timestamps, the source git
  commit, and an `enabled` toggle.

The one plugin-related key that does live in `config.yml` is `marketplace.autoUpdate`, which
controls the startup update check. It runs in the background, so it never delays the first
paint, and it takes one of three values:

- `notify` (the default) refreshes any marketplace catalog older than a day, compares your
  installed versions against it, and prints one line naming how many updates are available.
  Install them with `veyyon plugin upgrade` (all) or `veyyon plugin upgrade <name>@<marketplace>`.
- `auto` does the same check and installs the updates itself, then prints one line naming how
  many landed. The running session keeps the versions it loaded at startup, so restart to use
  the new ones.
- `off` skips the check entirely and contacts no marketplace.

A check that fails, usually because you are offline, is written to the log and does not
interrupt the session.

## Related recipes

Plugins are installed through the `veyyon plugin` CLI above, there is
no model-facing plugin-install tool. For task-shaped recipes that combine plugins with MCP and
skills, see [Task guides](../using/task-guides.md).
