# Runbook: release recovery

A release is a tagged commit **and** a published GitHub release the install script reads from
(`releases/latest`). The Release workflow waits for CI and Checks on the exact `main` SHA, cuts the
tag remotely, dispatches Checks for the exact bump SHA, and dispatches `ci.yml` at that immutable
tag only after `checks.yml` passes. Recovery depends on where it stopped.

## 1. It failed before the tag was pushed

Symptom: the Release workflow failed during preparation, checks, commit, or the atomic push. No
remote tag exists.

- Open the failed Release run. Its failing step is authoritative.
- Fix the underlying failure on `main` and push. Nothing re-cuts on its own: the newer SHA gets
  its own CI and Checks runs, and then you dispatch the Release workflow again. Both inputs are
  required, the version and the exact SHA you validated:
  `gh workflow run release.yml -f version=patch -f expected_sha="$(git rev-parse origin/main)"`.
- Do not hand-push a local bump or tag.

## 2. The tag pushed but CI never published

Symptom: the tag is on `origin/main` but there is no matching GitHub release, or the release has no
binaries.

1. Open the tagged CI run from the Actions tab.
2. If the run never started, inspect the `Run release train` job in the Release run: it dispatches
   exact-tag Checks first and dispatches `ci.yml` only after Checks passes. Release jobs use
   GitHub-hosted runners, so a missing runner is never the cause.
3. When a tagged CI run exists, fix the cause and **re-run failed jobs only**. Do not re-run all
   jobs: that re-runs `release_metadata`, whose `verify-tag` gate demands a controller-issued nonce
   correlated to a Release run that is still in progress, and it will refuse a second time.
4. If no tagged CI run exists, re-run the Release workflow's `Run release train` job. Only the
   controller can dispatch a publishing CI run: `release_metadata` refuses any tag dispatch whose
   actor is not `github-actions[bot]` and whose nonce does not correlate to the live Release run, so
   dispatching `ci.yml` at the tag by hand fails the gate and publishes nothing. Do not cut a second
   tag for the same version.

## 3. The release published but binaries are incomplete or corrupt

Symptom: `curl -fsSL https://get.veyyon.dev | sh` fails, or fails a checksum.

- `install.sh` **fails closed** on a checksum mismatch: that is correct behavior, not a bug to work
  around. A mismatch means the uploaded `veyyon-<platform>-<arch>` binary and its `.sha256` sidecar
  disagree. It also fails closed when the sidecar is **missing or empty** (the `release_github` job
  generates one per binary and addon); `--no-verify` / `-NoVerify` is the explicit override for old
  pre-sidecar releases.
  A missing sidecar on a current release means the "Generate SHA-256 sidecars" step was skipped or
  its uploads failed, re-run the publish job.
- Confirm the `release_github` job's exact manifest check passed. The release contains five installer
  binaries, every required `veyyon_natives.*` addon, and a `.sha256` sidecar for each binary and addon.
- If assets are missing or wrong, re-run the release build/publish jobs for the tag (step 2). CI
  regenerates and re-uploads the assets and checksums.
- If the release itself is bad and users are already hitting it, follow
  [install-rollback.md](install-rollback.md).

## 4. The release published but production deployment failed

Symptom: the GitHub release and assets exist, but a Cloudflare Pages job is red or either
Pages project is stale. Two jobs deploy: `release_site` runs before publication and deploys both
`veyyon.dev` and `get.veyyon.dev`, and `release_site_finalize` runs after publication and
redeploys `veyyon.dev` so the changelog card carries the immutable release link.

1. Open the red job in the tagged CI run. Both require `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`, and both deliberately fail when the `SITE_AUTODEPLOY` repository
   variable is `off`.
2. Repair the credential or policy failure, then re-run the failed job; do not cut another tag.
3. `release_site` proves the served installer bytes match `scripts/install.sh` and
   `scripts/install.ps1` with `bun scripts/verify-deployed-installers.ts`, and
   `release_site_finalize` proves the deployed page links the published release with
   `bun scripts/verify-deployed-changelog.ts <tag>`. Run either locally to confirm a repair. See
   [deployment.md](../deployment.md) for the Pages projects and manual override.

## Verify

1. On a clean machine (or container), run the real install: `curl -fsSL https://get.veyyon.dev | sh`.
2. `veyyon --version` reports the new version.
3. `veyyon plugin doctor` is green.

*Verified against `77074dee` on 2026-08-02.*
