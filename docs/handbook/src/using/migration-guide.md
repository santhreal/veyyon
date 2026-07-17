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

Veyyon reads your settings from `config.yml` under the config home and validates them against the versioned config schema. If a new release requires a new key or renames an existing one, the binary tells you exactly which file and line are affected.

### Common schema changes

- **New required keys** are added when a new feature is on by default. The error message names the missing key and the section it belongs in. Add it to `config.yml` or disable the related feature if you do not need it.
- **Renamed fields** are reported as unknown keys. The old name is usually accepted during a short migration window, but you should rename it to the current spelling.
- **Removed fields** are ignored unless you run with `--strict-config`, in which case unknown keys are treated as errors. Use `--strict-config` in CI to keep your config clean; leave it off during normal use so upgrades do not immediately break.

### Updating your config

1. Open `~/.veyyon/config.yml` in an editor.
2. Run the new binary once to see any validation errors:

   ```shell
   veyyon --version
   veyyon plugin doctor
   ```

3. Fix each reported line. If you are unsure what a key does, see the sample configuration that ships with Veyyon or read [Configuration](./configuration.md).
4. After editing, run `veyyon plugin doctor` again to confirm the file loads cleanly.

You do not need to rewrite the whole file. Most upgrades only add or rename a few keys, and the rest of your settings stay the same.

## Session and state data

Veyyon keeps your session data in two places under the config home:

- `sessions/` contains the append-only rollout files, one per session, in JSONL format. These are the source of truth for conversation history, branching, and undo.
- A local SQLite state database mirrors key events for fast lookups and diagnostics. It is rebuilt from the rollout files if it is missing or out of sync.

This means you usually do not need a manual database migration. When you start the new binary, it reads the rollout files and updates the state database as needed. If you see a warning about a stale state database, the binary repairs it automatically on startup.

### If you need to force a state rebuild

1. Close Veyyon.
2. Remove the state database file (see [File locations](../reference/file-locations.md) for the exact path on your platform).
3. Restart Veyyon. The state database is rebuilt from `sessions/` and `archived_sessions/`.

Never delete `sessions/` or `archived_sessions/` to fix a state problem. Those are the durable history; the state database is only a cache.

## Rolling back a binary

If the new binary does not work for you, you can go back to the previous version without losing data.

1. Close all Veyyon processes.
2. Restore the previous binary from your system package manager, the release archive, or your own backup.
3. Restore your `config.yml` from the backup you made before upgrading, if the new version modified it in ways the old version cannot read.
4. Leave `sessions/`, `archived_sessions/`, and the state database in place. Rollout files are forward-compatible for recent releases, and the old binary will rebuild the state database if needed.
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
[Diagnostics and health](../features/doctor.md) for the full diagnostics surface.

> **Spec — not shipped:** a top-level `veyyon doctor` install-health command with `--summary` /
> `--json` reports. Use `veyyon plugin doctor` and the TUI `/debug` today.

## Where to go next

- [Configuration](./configuration.md) explains the settings that change between releases.
- [File locations](../reference/file-locations.md) lists every path under the config home.
- [Troubleshooting](./troubleshooting.md) walks through common upgrade failures.
- [Diagnostics and health](../features/doctor.md) covers the diagnostics surface in detail.
