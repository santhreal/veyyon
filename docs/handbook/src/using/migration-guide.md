# Migration guide

This guide walks through upgrading Veyyon and recovering when an upgrade does not go as planned. Veyyon stores all user data under the config home (`~/.veyyon` on Unix by default, the Veyyon application directory on Windows; relocatable with `VEYYON_CONFIG_DIR`), so most upgrades are safe if you back up that directory first.

## Before you upgrade

1. Close all running Veyyon sessions and TUI instances. Writes may still happen while the binary is running, and a backup taken during activity can be inconsistent.
2. Back up the config home:

   ```shell
   cp -R ~/.veyyon ~/.veyyon-backup-$(date +%Y%m%d)
   ```

   Keep this backup until you have verified the new version with `veyyon plugin doctor` and completed one normal session.

3. Read the release notes for the version you are installing. They list required config changes, renamed fields, and any new dependencies.

## Config schema updates

Profile settings live in `~/.veyyon/profiles/<name>/agent/config.yml` (default profile: `profiles/default/agent/config.yml`). Global cross-profile keys (for example `defaultProfile`) live in `~/.veyyon/config.yml`. The binary validates settings against the schema and reports file, key, and line on failure.

### Common schema changes

- **New required keys** are added when a new feature is on by default. The error message names the missing key and the section it belongs in. Add it to the profile `config.yml` or disable the related feature if you do not need it.
- **Renamed fields** are reported as unknown keys. The old name is usually accepted during a short migration window, but you should rename it to the current spelling.
- **Removed fields** are reported as unknown keys but do not stop Veyyon from starting, so an upgrade does not immediately break an old config. Delete the key once you see it reported to keep the file clean.

### Updating your config

1. Edit `~/.veyyon/profiles/default/agent/config.yml` (or the active profile agent dir). Use `~/.veyyon/config.yml` only for global keys such as `defaultProfile`.
2. Run the new binary once to see any validation errors:

   ```shell
   veyyon --version
   veyyon plugin doctor
   ```

3. Fix each reported line. If you are unsure what a key does, see [Configuration](./configuration.md) and [File locations](../reference/file-locations.md).
4. After editing, run `veyyon plugin doctor` again to confirm the file loads cleanly.

You do not need to rewrite the whole file. Most upgrades only add or rename a few keys, and the rest of your settings stay the same.

## Session and state data

Session data lives under the **profile agent dir** (`~/.veyyon/profiles/default/agent/` by default):

- `sessions/`: append-only JSONL rollouts (conversation history, branching).
- SQLite stores under the agent dir (for example `history.db`, `agent.db`) mirror lookups; they can be rebuilt from rollouts when missing.

This means you usually do not need a manual database migration. When you start the new binary, it reads the rollout files and updates the state database as needed. If you see a warning about a stale state database, the binary repairs it automatically on startup.

### If you need to force a state rebuild

1. Close Veyyon.
2. Remove the state database file (see [File locations](../reference/file-locations.md) for the exact path on your platform).
3. Restart Veyyon. Indexes rebuild from agent-dir `sessions/` rollouts.

Never delete `sessions/` to fix a state problem. Rollouts are the durable history; SQLite stores under the agent dir are caches/indexes.

## Rolling back a binary

If the new binary does not work for you, you can go back to the previous version without losing data.

1. Close all Veyyon processes.
2. Restore the previous binary. Run `veyyon rollback` to pick an earlier version, or re-run the `curl` installer with `--ref v<version>` to pin one from veyyon.dev; a source checkout goes back with `git checkout` and a rebuild.
3. Restore profile `config.yml` (and global `~/.veyyon/config.yml` if you changed it) from the backup you made before upgrading, if the new version modified settings the old version cannot read.
4. Leave agent-dir `sessions/`, archives, and SQLite stores in place. Rollout files are forward-compatible for recent releases; the old binary can rebuild indexes when needed.
5. Start Veyyon and run `veyyon plugin doctor` to confirm the environment is healthy.

If you used a new feature that wrote settings the old binary does not recognize, remove or rename those keys before starting the old binary. The error message will point you to the right lines.

## Checking health after an upgrade

After every upgrade, confirm the install is healthy:

```shell
veyyon --version
veyyon plugin doctor
```

`veyyon plugin doctor` checks extension health and warns about missing optional binaries or provider
keys; it exits non-zero when a check reports an error. Start a normal interactive session and run
`/debug` and `/memory diagnose` to confirm the runtime and memory backend are working.

Treat every failed check as actionable. Fix the reported line, then re-run. If a check fails after a
rollback, compare your `config.yml` against the backup from before the upgrade. See
[Troubleshooting](./troubleshooting.md) for the common failure modes and
[Diagnostics and health](../features/doctor.md) for the full diagnostics surface (`veyyon plugin doctor`, TUI `/debug`).

## Where to go next

- [Configuration](./configuration.md) explains the settings that change between releases.
- [File locations](../reference/file-locations.md) lists every path under the config home.
- [Troubleshooting](./troubleshooting.md) walks through common upgrade failures.
- [Diagnostics and health](../features/doctor.md) covers the diagnostics surface in detail.
