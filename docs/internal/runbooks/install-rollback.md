# Runbook: roll back a bad release

`curl -fsSL https://get.veyyon.dev | sh` installs whatever is at the GitHub **`releases/latest`**. If a
published release is broken, new installs get the broken build until `latest` no longer points at it.

## Stop the bleeding

The fastest mitigation is to make `latest` resolve to the previous good release again:

1. In the GitHub releases UI, open the bad release and **uncheck "Set as the latest release"** (or mark
   it a pre-release). GitHub recomputes `latest` to the most recent stable release below it.
2. Confirm `latest` now points at the previous good tag:
   `gh release view --json tagName -q .tagName` (or the releases page).
3. Re-test the install: on a clean machine, `curl -fsSL https://get.veyyon.dev | sh` should now fetch
   the previous good version. `install.sh` fails closed on a checksum **mismatch** and on a
   **missing/empty `.sha256` sidecar** (CI publishes one per binary). Rolling back to an old
   pre-sidecar release therefore requires `--no-verify`.

Do **not** delete the bad release's tag while investigating, deleting a tag can orphan the release and
confuses `release.ts`'s "latest tag" baseline. Demote it; delete only after a fixed release ships.

## For a user already on the bad version

Veyyon keeps configuration and profiles under `~/.veyyon` by default. `VEYYON_CONFIG_DIR` selects a
relative config directory name under your home directory. Existing `XDG_DATA_HOME`,
`XDG_STATE_HOME`, and `XDG_CACHE_HOME` roots relocate data, state (including sessions), and cache.
Rolling the binary back does not remove any of these paths:

1. Reinstall the previous version (now `latest` again) with the same `curl … | sh`,
   or restore a copy of the prior binary from a kept archive.
   To pin an exact version regardless of `latest`:
   `curl -fsSL https://get.veyyon.dev | sh -s -- --binary --ref vX.Y.Z` (release asset download; note
   a bare `--ref` without `--binary` implies `--source`, it clones and builds that ref).
2. If the bad version wrote config keys the old binary rejects, remove or rename those keys: the error
   names the file and line. Leave agent-dir `sessions/` and SQLite stores in place.
3. `veyyon plugin doctor` to confirm health.

## Ship the fix

1. Land the fix on `main`. Green CI, Checks, and Security runs for that SHA trigger the next automatic patch release:
   see [releasing](../releasing.md).
2. Once the new release publishes and verifies, it becomes `latest` automatically.
3. Only then delete the bad release + tag if you want it gone.

*Verified against `0eb8d74a3ecf60e1b2ec37c15e9255f2dbe310dc` on 2026-07-30.*
