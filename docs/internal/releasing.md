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

### Versions 1.0.28 through 1.0.35 were never released

The version line is continuous, but the tags are not: `v1.0.27` is followed by
`v1.0.36`. Each of the eight versions in between has its own `chore: bump version
to <v>` commit, all landed on 2026-07-24, so they exist in the version history.
None of them was released. There is no tag and no GitHub release for any of them,
and the nine published releases are `v1.0.21` through `v1.0.27`, then `v1.0.36`
and `v1.0.37`.

Do not create those tags. A tag asserts that an artifact shipped under that name,
and nothing did: the bumps landed without a release being cut. The changelog
sections for 1.0.28 to 1.0.35 are correct as version history and should stay,
because they record what changed while those numbers were current.

What this costs you: anything that reads tags rather than the changelog is wrong
by eight versions. `git describe` skips them, a bisect over a reported version
cannot resolve them, and "what changed between X and Y" resolves the wrong range
if either end falls in the gap. Read the changelog for what shipped, and the tags
only for what you can check out.

Note also that no veyyon package has been published to npm. `@veyyon/coding-agent`
is not marked private and carries a version, but the registry has never seen it,
so npm is not a place to look for release history either. The GitHub releases and
their install assets are the record.

## Cutting a release

Prep is the same for both paths below: every change since the last release is
written under each affected package's `## [Unreleased]` section (see the changelog
format in the repo `AGENTS.md`). That section is the primary signal the automatic
path keys off, so keeping it current is what keeps releases flowing.

**Automatic (the default, and how most releases happen).** Every push to `main`
runs the **Release** workflow's gate once its CI run completes, and only a green
run may cut. When any publishable package has an
`## [Unreleased]` bullet waiting, it cuts a `patch` release with no human action,
so shipped changes reach users the same day instead of piling up. The gate is
`scripts/release-gate-decision.ts`, and it is self-limiting:

- `release.ts` moves `## [Unreleased]` into the new version section when it cuts
  the release, so the `chore: bump version to X` commit it pushes has nothing
  unreleased and never triggers a second release. No loop.
- A docs-, test-, or chore-only merge adds no bullet, so it does not release.
- To land a user-facing change without shipping it yet, put `[skip release]` in
  the commit message; the gate skips that push.

That last property has a cost when a cut fails. The changelog section is already
consumed by the time CI runs, so a failed publish leaves a tag with no release and
nothing left to ask for: `v1.0.33` and `v1.0.34` were both tagged, both failed the
same test, and the installable version stayed at `v1.0.27`. The gate therefore has
a second signal. When nothing is unreleased, it looks for a tag newer than the
latest published release, and cuts again when that tag's CI definitively failed and
`main` has moved on since.

Two bounds keep that from inventing versions:

- A re-cut needs `main` to have moved past the failed tag. Cutting the same tree
  again would fail the same way.
- Two unpublished tags stop the gate. A second stranded cut in a row is not a
  flake, so it prints what needs attention and waits for you to fix the failing
  publish and run the workflow by hand.

A tag whose CI is still running is left alone, and a tag whose CI SUCCEEDED without
producing a release is reported rather than cut over: that is a publish step that
claimed success, and a new version would bury it.

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
   regenerated by `renderRootChangelog`, which aggregates every package changelog
   (`coding-agent` first, the same omp→veyyon rebrand and fork split the website
   uses), so GitHub's repo page shows the same changelog as `veyyon.dev/changelog`. That file is generated,
   never hand-edited: run `bun run changelog:root` after any source-changelog edit,
   and the `changelog:root:check` PR guard fails if it drifts. If you did write an
   entry into the root by mistake, the regeneration refuses rather than deleting
   it, and lists every entry no package claims so you can move each one to its
   package. `--force` discards them deliberately.
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
- the **install endpoint** (`get.veyyon.dev`), a separate built tree (`website-get/`,
  the install scripts plus a root rewrite) deployed to a second Cloudflare Pages
  project, so `curl | sh` and the auto-updater always serve the current install
  script for the release that just shipped.

### Every published release needs a changelog entry

The website build fails if a version exists on GitHub Releases that
`packages/coding-agent/CHANGELOG.md` does not describe. Users can install that
version, so the changelog has to say what is in it.

The gate is unconditional: `UNDOCUMENTED_RELEASE_BASELINE` in
`website/tools/gen-changelog.mjs` is empty, so no version is exempt.

It was a warning once, and the build exited 0 anyway, so eight releases went
undocumented before anyone noticed. Those eight were grandfathered in that list
while anything outside it failed, and the list emptied when the backfill landed:
`## [1.0.0]` through `## [1.0.36]` were reconstructed from git history, one
section per version, each dated by the `chore: bump version` commit that cut it.

When you see the failure, write the entry. Do not add the version to the
baseline: it is a shrinking record of old debt, not somewhere to park a new gap,
the error message says so, and `website/tools/undocumented-release-ratchet.test.ts`
pins it empty so growing it fails the suite.

Binaries compile with Bun bytecode by default (`VEYYON_BUILD_BYTECODE=0` opts out),
~70ms warm startup instead of ~650ms of JS parse per launch, at the cost of a
larger binary. `packages/coding-agent/scripts/compile-binary.ts` owns the build
and fails closed if the bundle contains any `import.meta.resolve`/`import.meta.env`
(they crash Bun bytecode, upstream oven-sh/bun#21097).

The binary build embeds mupdf's runtime files before compiling. `packages/coding-agent/scripts/embed-mupdf-wasm.ts --generate` copies `mupdf-wasm.wasm`, `mupdf.js` and `mupdf-wasm.js` next to `packages/coding-agent/src/utils/mupdf-wasm-embed.ts` and rewrites that module to import them as file assets; `--reset` restores the committed placeholder and deletes the copies. A build that dies in between leaves your tree in the generated state, where `mupdf-wasm-embed.ts` shows as modified and two `mupdf-*embedded.js` files appear beside it. Run `bun packages/coding-agent/scripts/embed-mupdf-wasm.ts --reset` to get back to the checked-in state. All three copies are gitignored and the assets are declared in `types/assets/index.d.ts`, so the generated state still typechecks and cannot be committed by accident.

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
later `main` push cannot kill an in-flight release. Ordinary `main` pushes also
never cancel each other: they share the branch-wide group with
`cancel-in-progress` off, so the running run always completes (release.yml
needs a completed green CI run to cut from) and GitHub keeps only the newest
pending run for the group. Before this, bot pushes landing every few minutes
cancelled every CI run in flight and the release train starved with no
completed run to gate on (observed 2026-07-24: six consecutive cancellations).
Pushes to other branches keep cancel-on-newer-push for fast feedback.
`scripts/ci-concurrency.test.ts` locks the group and cancel expressions
against regressions.

*Verified against `ad7ede4a` on 2026-07-28.*
