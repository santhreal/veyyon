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

**Automatic (the default, and how most releases happen).** Completed CI and Checks
runs on `main` each trigger the **Release** workflow. The gate waits until both
workflows are green for the same exact SHA. When any publishable package has an
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
latest published release, reads the CI workflow conclusion for that tag, and cuts
again when CI definitively failed and `main` has moved on since.

Two bounds keep that from inventing versions:

- A re-cut needs `main` to have moved past the failed tag. Cutting the same tree
  again would fail the same way.
- Two unpublished tags stop the gate. A second stranded cut in a row is not a
  flake, so it prints what needs attention and waits for you to fix the failing
  publish and run the workflow by hand.

A tag whose CI is still running is left alone, and a tag whose CI SUCCEEDED without
producing a release is reported rather than cut over: that is a publish step that
claimed success, and a new version would bury it.

**Manual (an explicit version).** Run the repository release command with
`major`, `minor`, `patch`, or an explicit `x.y.z`. With no argument, it requests
a patch release:

```sh
bun run release
bun run release minor
bun run release 2.0.0
```

The command requires a clean `main` checkout synchronized with `origin/main` and
the `santhsecurity` GitHub account active in `gh`. It only dispatches the remote
Release workflow. The workflow proves CI and Checks are green for that exact main
SHA before it changes a version, creates a commit, tags, or publishes. The gate
exports that proved SHA. The cutter checks out the immutable commit and
materializes it as its local `main` branch, so a later `main` update cannot enter
the release after the evidence was collected. The workflow uses the
repository-scoped `GITHUB_TOKEN`; no workstation credential performs the release
itself.

`scripts/release.ts` runs, in order:

1. Preflight: assert clean `main` and that the new version is greater than the latest
   tag (or the `0.0.0` baseline).
2. Bump every public `package.json`, the root `@veyyon/*` catalog entries, the Rust
   workspace version, and the `veyyon-natives` version sentinel; regenerate lockfiles.
3. Normalize + finalize changelogs: `## [Unreleased]` becomes the new version, a fresh
   empty `## [Unreleased]` is added on top. The repo-root `CHANGELOG.md` is then
   regenerated by `renderRootChangelog`, which aggregates every package changelog
   with `coding-agent` first. The website uses the same omp-to-Veyyon rebrand and fork
   split, but its release cards come only from `packages/coding-agent/CHANGELOG.md`.
   The root file is generated, never hand-edited: run `bun run changelog:root` after
   any source-changelog edit,
   and the `changelog:root:check` PR guard fails if it drifts. If you did write an
   entry into the root by mistake, the regeneration refuses rather than deleting
   it, and lists every entry no package claims so you can move each one to its
   package. `--force` discards them deliberately.
4. Run `bun run check`.
5. Commit `chore: bump version to X.Y.Z` (bare version, no `v`): CI keys the
   never-cancel release concurrency group off the `chore: bump version to ` subject
   prefix, so the subject stays exactly that shape.
6. Tag and atomically push `main` plus the tag (pushed by commit SHA so background
   tag pruning cannot lose it). If main advanced, the push fails without rebasing.
   The newer main SHA gets a fresh cut only after its own CI and Checks runs pass.
7. Dispatch `checks.yml` at the immutable tag with a unique correlation token.
   Verify the newly created run carries that token, targets the bump SHA, and
   passes. Only then dispatch `ci.yml` at the same tag.

## What CI does with the tag

The dispatched `ci.yml` run checks out the immutable release tag and builds every
platform binary. There is no npm or Homebrew publish step. Publication is one
ordered transaction:

1. Create or resume a **draft** GitHub release. Upload every `veyyon-*` binary,
   native addon, and `.sha256` sidecar. Record their exact digest manifest.
2. Download and launch the draft macOS, Linux, and Windows binaries. Verify their
   checksums, embedded version, signatures where configured, smoke tests, and
   native addon load.
3. Deploy both Cloudflare Pages projects while the release is still hidden.
   Verify `get.veyyon.dev` serves the installer bytes from this tag.
4. Re-download every draft asset and compare its digest to the preserved
   manifest. Resolve the Git tag ref to the bump SHA, then publish that exact
   draft.
5. Rebuild and redeploy `veyyon.dev` after publication. The changelog generator
   can now replace the draft's pending card with its immutable GitHub release
   link. Verify that link on the deployed page.
6. Drive the POSIX and Windows installers against the newly published
   `releases/latest` on Linux, Intel and Apple Silicon macOS, and Windows.

The release train is green only after all six steps pass. Any failed, cancelled,
or skipped required job updates the pinned `release-train` issue.

The resulting surfaces are:

- the **GitHub release**: all platform binaries, native addons, and `.sha256`
  checksums. The `curl | sh` installer, source installs that fetch a prebuilt
  native addon, and the binary self-updater resolve these assets;
- the **website** (`veyyon.dev`): `website/changelog.html`, regenerated from
  `packages/coding-agent/CHANGELOG.md` and reconciled against the published
  GitHub Releases for real dates and permalinks;
- the **install endpoint** (`get.veyyon.dev`): a separate built tree
  (`website-get/`, the install scripts plus a root rewrite) deployed to the
  `veyyon-get` Pages project.

On ordinary `main` pushes, CI also drives the POSIX and Windows installers
against the release that is already in production. Those jobs remain advisory:
a broken old release must not block the source-built release that repairs it.
The tagged publication run has its own required post-publication installer
round trips for the new release.

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

The release matrix enables Bun bytecode for the four Linux and macOS targets and
disables it for Windows x64. The matrix's explicit option takes precedence over
`VEYYON_BUILD_BYTECODE`. Bytecode cuts warm startup from roughly 650 ms to 70 ms at
the cost of a larger binary. `packages/coding-agent/scripts/compile-binary.ts` owns
the build. Its fail-closed `import.meta.resolve` and `import.meta.env` guard covers
the patched yargs `apply-extends.js` call site that is incompatible with Bun bytecode.

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

*Verified against `7815b71a84f7d4dffe5572f8cfc1e3172b8b8072` on 2026-07-30.*
