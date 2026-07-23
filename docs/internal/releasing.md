# Releasing

A veyyon release is a tagged commit **and** a published GitHub release the install
scripts can resolve. Everything else, a version bump, a green CI run, is a step
toward that, not the release itself.

## Versioning and the fork

veyyon is a source fork of oh-my-pi. The per-package `CHANGELOG.md` files carry
oh-my-pi's release history, and each opens with a fork notice marking the boundary:
every entry at or below `16.5.2` is inherited upstream history, not a veyyon release.

veyyon's own release line **starts at 1.0.0** (tag `v1.0.0`). The fork carried
over none of oh-my-pi's git tags, so `release.ts` treats a repo with no `v*` tags
as a `0.0.0` baseline instead of aborting on `git describe`, that is how the
first release cut cleanly, and it stays true if the tag set is ever rebuilt.

## Cutting a release

Prep is the same for both paths below: every change since the last release is
written under each affected package's `## [Unreleased]` section (see the changelog
format in the repo `AGENTS.md`). That section is the single signal the automatic
path keys off, so keeping it current is what keeps releases flowing.

**Automatic (the default, and how most releases happen).** Every push to `main`
runs the **Release** workflow's gate. When any publishable package has an
`## [Unreleased]` bullet waiting, it cuts a `patch` release with no human action,
so shipped changes reach users the same day instead of piling up. The gate is
`scripts/has-releasable-changes.ts`, and it is self-limiting:

- `release.ts` moves `## [Unreleased]` into the new version section when it cuts
  the release, so the `chore: bump version to X` commit it pushes has nothing
  unreleased and never triggers a second release. No loop.
- A docs-, test-, or chore-only merge adds no bullet, so it does not release.
- To land a user-facing change without shipping it yet, put `[skip release]` in
  the commit message; the gate skips that push.

**Manual (an explicit version).** Run the **Release** workflow from the Actions
tab and give it a version: `major`, `minor`, `patch`, or an explicit `x.y.z`.
This bypasses the releasable gate and releases exactly what you asked for.
Nothing about a release depends on your machine.

The workflow needs a `RELEASE_PAT` secret: a fine-grained personal access token
with Contents read/write on this repository. GitHub does not start workflow runs
for pushes made with the built-in `GITHUB_TOKEN`, so a release pushed with it
would be tagged and never published. The workflow checks for the token first and
refuses to start without it, rather than producing a half-release.

You can still run the same script locally when you need to (`bun run release
<version|major|minor|patch>` from a clean `main`); the workflow runs exactly this
script, and the only difference is that a local run also watches CI afterwards.

`scripts/release.ts` runs, in order:

1. Preflight: assert clean `main` and that the new version is greater than the latest
   tag (or the `0.0.0` baseline).
2. Bump every public `package.json`, the root `@veyyon/*` catalog entries, the Rust
   workspace version, and the `veyyon-natives` version sentinel; regenerate lockfiles.
3. Normalize + finalize changelogs: `## [Unreleased]` becomes the new version, a fresh
   empty `## [Unreleased]` is added on top. The repo-root `CHANGELOG.md` is then
   regenerated from `packages/coding-agent/CHANGELOG.md` with `renderRootChangelog`
   (the same omp→veyyon rebrand and fork split the website uses), so GitHub's repo
   page shows the same changelog as `veyyon.dev/changelog`. That file is generated,
   never hand-edited: run `bun run changelog:root` after any source-changelog edit,
   and the `changelog:root:check` PR guard fails if it drifts.
4. Run `bun run check`.
5. Commit `chore: bump version to X.Y.Z` (bare version, no `v`): CI keys the
   never-cancel release concurrency group off the `chore: bump version to ` subject
   prefix, so the subject **must** stay exactly that shape. Reword the body, never
   the subject, on a retry.
6. Tag and atomically push `main` + the tag (pushed by commit sha so background tag
   pruning can't lose it).
7. Watch CI until the release jobs finish. Skipped when the script is running as the
   Release workflow (`VEYYON_RELEASE_IN_CI=1`), since the push is what starts the
   release run and the workflow reports its own outcome. `bun run release watch`
   re-attaches to CI for the current commit from a workstation.

## What CI does with the tag

The tagged push triggers `ci.yml`. Seeing a release tag at `HEAD`, it builds every
platform binary and then publishes to GitHub only. There is no npm or Homebrew
step; the GitHub release is the one publish target (see the Distribution section
in the repo `AGENTS.md`):

- the **GitHub release**: all `veyyon-*` binaries + `.sha256` checksums (this is
  what the `curl | sh` installer and the binary self-updater resolve);
- the **website** (`veyyon.dev`), which regenerates `website/changelog.html` from
  `packages/coding-agent/CHANGELOG.md` (reconciled against the live GitHub Releases
  for real dates and permalinks) and deploys it to Cloudflare Pages. This is what
  keeps `veyyon.dev/changelog` current, and it is why the agent never prints release
  notes into the terminal: after an update it shows one line and points at
  `/changelog`, which opens that page;
- the **install endpoint** (`get.veyyon.dev`), the same built tree deployed to the
  second Cloudflare Pages project, so `curl | sh` and the auto-updater always serve
  the current install script for the release that just shipped.

Binaries compile with Bun bytecode by default (`VEYYON_BUILD_BYTECODE=0` opts out),
~70ms warm startup instead of ~650ms of JS parse per launch, at the cost of a
larger binary. `packages/coding-agent/scripts/compile-binary.ts` owns the build
and fails closed if the bundle contains any `import.meta.resolve`/`import.meta.env`
(they crash Bun bytecode, upstream oven-sh/bun#21097).

Once the release is published, `curl -fsSL https://get.veyyon.dev | sh` installs it
through `releases/latest` with no further action. Verify with a real install on a
clean machine, not just a local `bun`/`cargo` build. See [deployment.md](./deployment.md)
for the install path and asset names.

## Runners and concurrency

Every `ci.yml` job runs on **GitHub-hosted runners** (`ubuntu-22.04`,
`ubuntu-24.04-arm`, and the OS matrix); there is no self-hosted dependency, so a
release can never sit queued waiting for a runner that isn't registered (that is
exactly how the first `v1.0.0` tag run stalled before the self-hosted routing was
removed). Release-shaped runs, the `chore: bump version to ` push, a `v*` tag
ref, or any manual dispatch, get a per-sha, never-cancel concurrency group so a
later `main` push cannot kill an in-flight release; `scripts/ci-concurrency.test.ts`
locks that group expression against regressions.

*Verified against `d3e3db30` on 2026-07-23.*
