# Operational runbooks

What to do when release, CI, or install machinery breaks. Every step here is
grounded in the real scripts and workflows — if a step and the code disagree,
the code won. For the happy path, read
[releasing.md](../internal/releasing.md) (cutting a release) and
[deployment.md](../internal/deployment.md) (website + binary distribution);
this file is recovery only.

## Release failed mid-way

A release is one atomic push: `bun scripts/release.ts <version|major|minor|patch>`
bumps versions, rewrites changelogs, commits `chore: bump version to vX.Y.Z`,
and pushes main HEAD + the `v*` tag atomically. That single main push triggers
the one authoritative CI run ([ci.yml](../../.github/workflows/ci.yml)):
`release_metadata` detects the tag at HEAD and downstream jobs switch on
`is-release`. Release runs get a per-sha concurrency group with no
cancellation, so a later main push cannot kill an in-flight release.

Recovery by failure point:

1. **Find where it died.** `bun scripts/release.ts watch` polls the CI run for
   the current commit and fails fast on the first failed job, printing job log
   URLs.
2. **Any job failed, tag already pushed.** Re-run the release from the tag:
   `gh workflow run ci.yml --ref vX.Y.Z`. A `workflow_dispatch` from a `v*`
   tag ref is treated as a full release run (see the comment atop the `jobs:`
   block in ci.yml). Do NOT re-run `release.ts` — the version bump is already
   on main.
3. **npm already published, later jobs failed.** npm refuses to republish an
   existing version, so re-dispatch with the `skip_npm` input:
   `gh workflow run ci.yml --ref vX.Y.Z -f skip_npm=true`. The remaining jobs
   (GitHub Release, brew tap, macOS verify) are independent and re-runnable.
4. **GitHub Release exists but is wrong/partial.** `publish_github_release`
   regenerates notes from package CHANGELOGs (`scripts/ci-release-notes.ts`)
   and uploads binaries + sha256 checksums; deleting the bad release and
   re-dispatching from the tag rebuilds it from scratch.
5. **Homebrew tap stale.** The `update_homebrew_tap` job regenerates the
   formula via `scripts/ci-update-brew-formula.ts` and pushes with
   `HOMEBREW_TAP_DEPLOY_KEY`. It only needs the GitHub Release assets to
   exist, so a tag-ref re-dispatch (with `skip_npm=true` if npm already went
   out) refreshes it.
6. **Never fix a bad release by moving the tag.** Cut the next patch version
   with `release.ts` instead; tags are immutable history.

## Self-hosted runner (omp-kata) outage

Pull requests run on GitHub-hosted `ubuntu-22.04` and are unaffected, and
release-shaped runs route every job to GitHub-hosted runners (see
`docs/internal/releasing.md` §Release runners), so releases never wait on the
fleet. Ordinary `main` pushes run on the self-hosted `omp-kata` scale set —
when it is down they queue indefinitely (GitHub holds queued jobs, nothing is
lost).

1. Diagnosis and architecture live in [infra/docs/](../../infra/docs/README.md)
   (host + k3s cluster, Kata runtime, runner image, ARC + caching — read in
   order). The ARC listener long-polls GitHub; if jobs queue but no runner pod
   appears, start there.
2. To rebuild and roll the runner image onto the CI host:
   `CI_HOST=<ssh-target> ./infra/reload-runner.sh` (the host is deliberately
   not hardcoded; see the script header for backends and tags).
3. Releases are unaffected by a fleet outage: release-shaped runs (the
   `chore: bump version to vX.Y.Z` push, a `v*` tag-ref dispatch, or any
   manual dispatch) route **every** `ci.yml` job to GitHub-hosted runners.
   For an urgent ordinary-push CI run while the fleet is down, use a manual
   dispatch (which takes the GitHub-hosted routing) rather than editing
   `runs-on` ad hoc.

## Secret rotation

Secrets consumed by [ci.yml](../../.github/workflows/ci.yml):

- **macOS signing/notarization** (`APPLE_CERTIFICATE_P12`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`,
  `APPLE_API_KEY`): rotate with
  `scripts/ci-macos-upload-secrets.sh [dir]` — it reads every value from files
  on disk and pipes to `gh secret set` over stdin so no secret ever hits argv,
  history, or the transcript. The script header documents the exact files to
  prepare. If these are absent, `MACOS_SIGNING` evaluates false and CI ships
  ad-hoc-signed binaries; the `verify` job asserts a Developer ID signature
  only when signing is configured. Signing background:
  [macos-signing-notarization.md](../internal/macos-signing-notarization.md).
- **`NPM_TOKEN`**: npm automation token for `@veyyon/*` publishes. Rotate on
  npmjs.com, then `gh secret set NPM_TOKEN` (paste via stdin, never argv).
- **`HOMEBREW_TAP_DEPLOY_KEY`**: SSH deploy key with write access on the tap
  repo. Generate a new keypair, add the public half as a deploy key on the tap,
  `gh secret set HOMEBREW_TAP_DEPLOY_KEY < key`, then delete the old deploy
  key. If unset, the tap job self-skips (`HAS_TAP_KEY`).
- **`GITHUB_TOKEN`** is workflow-provided per run; nothing to rotate.

After any rotation, prove it: re-dispatch CI from the latest `v*` tag with
`skip_npm=true` and watch the job that consumes the rotated secret.

## Roll back or remove an install

The installer ([scripts/install.sh](../../scripts/install.sh), served from
`https://get.veyyon.dev`) is also the uninstaller and supports pinning:

1. **Remove**: `curl -fsSL https://get.veyyon.dev | sh -s -- --uninstall` —
   removes the `veyyon` binary and `vey` alias from the install dirs, the
   global bun package, and all shell completions.
2. **Roll back to a known-good version**: uninstall, then reinstall pinned:
   `curl -fsSL https://get.veyyon.dev | sh -s -- --binary --ref vX.Y.Z`
   downloads that tag's release asset (sha256-verified, fail-closed;
   `--no-verify` exists but is not recommended). A bare `--ref` implies
   `--source` — it clones and builds that ref with bun instead of downloading
   a release asset.
3. The post-install `doctor` self-check must pass (`veyyon --version` runs,
   `vey` on PATH). If it dies, the install did not land — nothing to roll
   back, retry or fall back to `--source`.
4. Windows: [scripts/install.ps1](../../scripts/install.ps1) mirrors the flow —
   `-Uninstall` to remove (binary, `vey` shim, global bun package, PATH entry),
   `-Binary -Ref vX.Y.Z` / `-Source -Ref <ref>` to reinstall pinned.
