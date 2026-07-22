# Plugins

A plugin bundles several extensions into one installable package: skills, MCP servers,
hooks, and related assets that ship and update together. Reach for a plugin when you want to
share a whole capability at once instead of wiring each piece by hand. Some manifests also
carry a `apps` field for packaged connectors; see [Connectors](./connectors.md) for the
current integration surface (MCP, plugins, hooks, and skills).

## Plugin Structure

Every plugin is a directory with a `.veyyon-plugin/plugin.json` manifest file. The manifest describes the plugin's metadata and lists its integration points.

### Plugin Manifest (`plugin.json`)

The following fields are defined in the `plugin.json` schema:

| Field | Type | Description |
| --- | --- | --- |
| `name` | String | The unique name of the plugin. Only ASCII alphanumeric characters, hyphens, and underscores are allowed. |
| `version` | String | The version of the plugin (optional). Defaults to `"local"`. |
| `description` | String | A description of the plugin (optional). |
| `keywords` | Array of Strings | Keywords used to index and search for the plugin (optional). |
| `skills` | String or Array of Strings | Path or paths to directories containing skill definitions (optional). |
| `mcpServers` | String or Object | Path to a file or an inline object defining the plugin's MCP servers (optional). |
| `apps` | String | Path to a file defining the plugin's custom applications and connectors (optional). |
| `hooks` | String or Array of Strings or Object | Path or paths to hook definition files, or inline hook objects (optional). |
| `interface` | Object | Presentation metadata for the TUI (optional). Details like display name, descriptions, default prompt, developer name, category, website, privacy policy, and logo files. |

## Marketplaces

Marketplaces are collections of plugins. A marketplace is a directory or Git repository containing a `marketplace.json` catalog manifest.

Veyyon checks the following relative paths under a marketplace root to locate its catalog manifest:
1. `.agents/plugins/marketplace.json` (canonical path)
2. `.agents/plugins/api_marketplace.json`
3. `.claude-plugin/marketplace.json`

The marketplace catalog defines:
* A `name` and optional presentation metadata.
* A `plugins` list. Each entry contains the plugin name, installation policy, authentication policy, supported products, and its source. The source can point to a local directory or a Git repository (with optional branch, tag, commit ref, or subdirectory path).

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

#### Add a Plugin

Install a plugin from a configured marketplace. Specify the plugin as `plugin_name@marketplace_name`, or use the `--marketplace` option.

```console
$ veyyon plugin add sample@debug
$ veyyon plugin add sample --marketplace debug
```

Use the `--json` flag to print the installation result as JSON.

#### List Plugins

List installed plugins and their statuses.

```console
$ veyyon plugin list
```

Options:
* `-m, --marketplace <name>`: Filter listing to a specific marketplace.
* `--json`: Print the output as JSON.
* `--available`: Include uninstalled but available plugins from the marketplaces (requires `--json`).

#### Remove a Plugin

Uninstall a plugin from local cache and config.

```console
$ veyyon plugin remove sample@debug
```

Use the `--json` flag to return the removal result as JSON.

### Managing Marketplaces

#### Add a Marketplace

Add a local path or Git repository to your configured marketplace sources.

```console
$ veyyon plugin marketplace add ./path/to/marketplace
$ veyyon plugin marketplace add owner/repo --ref main
$ veyyon plugin marketplace add https://github.com/owner/repo --sparse plugins/foo
```

Options:
* `--ref <ref>`: Git branch, tag, or commit SHA to fetch.
* `--sparse <path>`: Limits the Git clone to a specific subdirectory. Can be repeated.
* `--json`: Print the result as JSON.

#### List Marketplaces

List all configured marketplaces and their filesystem root directories.

```console
$ veyyon plugin marketplace list
```

Use the `--json` flag to output the list as JSON.

#### Upgrade Marketplaces

Fetch the latest revisions for configured Git marketplaces. Omit the marketplace name to upgrade all configured Git marketplaces.

```console
$ veyyon plugin marketplace upgrade
$ veyyon plugin marketplace upgrade debug
```

Use the `--json` flag to output the upgrade result as JSON.

#### Remove a Marketplace

Remove a configured marketplace by name.

```console
$ veyyon plugin marketplace remove debug
```

Use the `--json` flag to output the result as JSON.

## TUI Integration

Veyyon TUI integrates plugin management directly.

### Slash Commands

* `/plugins`: Opens the interactive plugins catalog popup. You can browse all available plugins, install or uninstall them, and toggle plugins on or off.
* `/extensions`: Opens the Extension Control Center dashboard, which shows plugin-provided skills, tools, and hooks alongside everything else that is loaded.

### TUI Keybindings

When the `/plugins` popup is open, you can use the following keyboard shortcuts on the selected marketplace tab:
* `Ctrl+R`: Remove the selected configured marketplace.
* `Ctrl+U`: Upgrade the selected configured Git marketplace.

## Registry Files

Marketplace and plugin state is not kept in `config.yml`. Two JSON registries, both managed
by the `/plugins` UI and the `veyyon plugin` CLI (edit through those, not by hand):

- **`marketplaces.json`** (under the config root, next to `config.yml`): which catalogs you
  have added. Each entry records the marketplace `name`, `sourceType`, `sourceUri`,
  `catalogPath`, and added/updated timestamps.
- **`installed_plugins.json`** (under the plugins dir): which plugins are installed. Each
  entry is keyed `<plugin_name>@<marketplace_name>` and records the install `scope`
  (user or project), `installPath`, `version`, install/update timestamps, the source git
  commit, and an `enabled` toggle.

The one plugin-related key that does live in `config.yml` is `marketplace.autoUpdate`, which
controls the startup update check. It runs in the background, so it never delays the first
paint, and it takes one of three values:

- `notify` (the default) refreshes any marketplace catalog older than a day, compares your
  installed versions against it, and prints one line naming how many updates are available.
  Run `/plugins` to install them.
- `auto` does the same check and installs the updates itself, then prints one line naming how
  many landed. The running session keeps the versions it loaded at startup, so restart to use
  the new ones.
- `off` skips the check entirely and contacts no marketplace.

A check that fails, usually because you are offline, is written to the log and does not
interrupt the session.

## Related recipes

Plugins are installed through the `/plugins` popup or the `veyyon plugin` CLI above, there is
no model-facing plugin-install tool. For task-shaped recipes that combine plugins with MCP and
skills, see [Task guides](../using/task-guides.md).
