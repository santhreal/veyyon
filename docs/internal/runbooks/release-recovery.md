# Runbook: release recovery

A release is a tagged commit **and** a published GitHub release the install script reads from
(`releases/latest`). `bun run release` cuts the tag locally and pushes; `ci.yml` builds the binaries
and publishes on the tagged push. Recovery depends on where it stopped.

## 1. It failed before the tag was pushed

Symptom: `scripts/release.ts` aborted during `bun run check`, changelog finalize, or the commit step.
Nothing was pushed.

- The working tree has a local release commit and possibly a local tag. Inspect: `git log -1`,
  `git tag --points-at HEAD`.
- Fix the underlying failure (usually a failing `bun run check`).
- If a local tag was created but not pushed, delete it (`git tag -d <tag>`) and re-run
  `bun run release <version>`, do not hand-push a half-made tag.

## 2. The tag pushed but CI never published

Symptom: the tag is on `origin/main` but there is no matching GitHub release, or the release has no
binaries.

1. Check CI: `bun run release watch` re-attaches to the release run, or open the Actions tab.
2. If the run never started, open the Actions tab and check for a queued job or a workflow
   syntax error. Release jobs use GitHub-hosted runners, so a missing runner is never the cause.
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

## Verify

1. On a clean machine (or container), run the real install: `curl -fsSL https://get.veyyon.dev | sh`.
2. `veyyon --version` reports the new version.
3. `veyyon plugin doctor` is green.

*Verified against `7ca44d3` on 2026-07-17.*
