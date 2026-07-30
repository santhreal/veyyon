# Runbook: release recovery

A release is a tagged commit **and** a published GitHub release the install script reads from
(`releases/latest`). The Release workflow cuts the tag remotely, gates the exact bump SHA through
Checks, then dispatches `ci.yml` at the immutable tag. Recovery depends on where it stopped.

## 1. It failed before the tag was pushed

Symptom: the Release workflow failed during preparation, checks, commit, or the atomic push. No
remote tag exists.

- Open the failed Release run. Its failing step is authoritative.
- Fix the underlying failure on `main` and push. The newer SHA gets its own CI and Checks evidence,
  then the automatic gate cuts again.
- Do not hand-push a local bump or tag. For an explicit retry, dispatch the Release workflow from
  Actions with the intended version.

## 2. The tag pushed but CI never published

Symptom: the tag is on `origin/main` but there is no matching GitHub release, or the release has no
binaries.

1. Open the tagged CI run from the Actions tab.
2. If the run never started, inspect the Release run's exact-tag Checks gate and publish-dispatch
   step. Release jobs use GitHub-hosted runners, so a missing runner is never the cause.
3. If the run failed on the macOS signing step, the `APPLE_*` secrets are missing or invalid: see
   [secret-rotation.md](secret-rotation.md) and [macOS signing](../macos-signing-notarization.md).
4. After fixing the cause, re-trigger the release jobs by re-running the failed CI workflow for that
   tag (Actions → the failed run → **Re-run failed jobs**). Do not cut a second tag for the same
   version.

## 3. The release published but binaries are incomplete or corrupt

Symptom: `curl -fsSL https://get.veyyon.dev | sh` fails, or fails a checksum.

- `install.sh` **fails closed** on a checksum mismatch: that is correct behavior, not a bug to work
  around. A mismatch means the uploaded `veyyon-<target>` binary and its `.sha256` sidecar disagree.
  It also fails closed when the sidecar is **missing or empty** (the `release_github` job generates
  one per binary); `--no-verify` / `-NoVerify` is the explicit override for old pre-sidecar releases.
  A missing sidecar on a current release means the "Generate SHA-256 sidecars" step was skipped or
  its uploads failed, re-run the publish job.
- Confirm every expected asset is attached to the release: `veyyon-linux-x64`, `veyyon-linux-arm64`,
  `veyyon-darwin-x64`, `veyyon-darwin-arm64`, `veyyon-windows-x64.exe`.
- If assets are missing or wrong, re-run the release build/publish jobs for the tag (step 2.4). CI
  regenerates and re-uploads the assets and checksums.
- If the release itself is bad and users are already hitting it, follow
  [install-rollback.md](install-rollback.md).

## 4. The release published but production deployment failed

Symptom: the GitHub release and assets exist, but `release_site` is red or either
Cloudflare Pages project is stale.

1. Open `release_site` in the tagged CI run. It requires both
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and deliberately fails when
   `SITE_AUTODEPLOY=off`.
2. Repair the credential or policy failure, then re-run the failed job. It rebuilds
   and deploys both `veyyon.dev` and `get.veyyon.dev`; do not cut another tag.
3. Run `bun scripts/verify-deployed-installers.ts` to prove the served installer
   bytes match `scripts/install.sh` and `scripts/install.ps1`. See
   [deployment.md](../deployment.md) for the Pages projects and manual override.

## Verify

1. On a clean machine (or container), run the real install: `curl -fsSL https://get.veyyon.dev | sh`.
2. `veyyon --version` reports the new version.
3. `veyyon plugin doctor` is green.

*Verified against `d3e3db30` on 2026-07-23.*
