# Releasing

This is the only page about cutting a release. It covers the command you run,
what runs after it, what a release produces, how you check that it worked, and
what to do when a step fails.

A release is a tagged commit **and** a published GitHub release the install
scripts can resolve. A version bump is not a release. A green CI run is not a
release. Both are steps toward one.

## Cut a release

Two commands. There are no flags to remember.

```sh
bun run release:dry patch      # say what a cut would do. Writes nothing.
bun run release patch          # do it.
```

Both take `major`, `minor`, `patch`, or an explicit `x.y.z`.

`bun run release` bumps every version authority, rolls the changelogs, commits,
shows you the commit and the tag it is about to publish, and asks once. Say yes
and it pushes `main`, waits for that exact commit's checks, and cuts the tag the
moment they are green.

`bun run release:dry` resolves the same version and runs the same refusals
without touching the tree, so it is safe from a branch, a dirty tree, or a
machine you are not going to release from.

There is no way to answer the prompt in advance. A release that publishes with
nobody at the keyboard is the CI release controller this design removed, and the
dry run already answers every question you can ask without one.

### If it stops partway

Every exit that does not publish leaves the bump commit on `main` locally and
prints the same two moves:

```sh
git push origin main && gh run watch --exit-status   # let main's CI test the exact commit
git tag v1.2.3 && git push origin v1.2.3             # the tag push publishes
```

That is all `bun run release` does after the prompt. The only judgement it
automates is "are the checks green yet", and it is stricter about that than a
human watching a run list: it waits for every workflow that fires on a main push
to appear and finish, and it refuses to tag on anything but `success` or a
legitimate `skipped`.

**Pushing to `main` while a cut is waiting is safe.** Every push to `main` gets
its own per-SHA concurrency group, so the bump commit's runs cannot be cancelled
or queued by a later push. This was not always true: `main` shared one
branch-wide group, GitHub keeps at most one *pending* run per group, and the
result was four of six consecutive `CI` runs cancelled and two more stuck queued
for over an hour with no completed run to gate on. If a run is cancelled anyway,
the cut says so and names the `gh run rerun` for it rather than sending you to
look for a defect that does not exist.

Nothing on `main` cuts a release on its own: not a push, not a green CI run, not
a waiting `## [Unreleased]` bullet. Only a `v*` tag push publishes. If the
changelog says a version shipped and no release exists for it, nobody pushed its
tag.

Pushing the tag needs the `santhsecurity` account active in `git`/`gh`. Everything
after the tag push runs on GitHub-hosted runners with the repository-scoped
`GITHUB_TOKEN`, so no workstation credential performs a publication and no release
waits on a self-hosted runner.

### Why the commit goes to main first

The tag must name a commit `main`'s CI has already tested, and the only way to be
sure of that is to let `main` test it. Step 2 is not a formality: it is the entire
safety argument, and it is the same one that protects every other commit.

This matters because the alternative failed. `v1.0.28` through `v1.0.35` were each
tagged by a controller that created the bump commit *inside* CI, so the tag landed
on a SHA no CI run had ever seen. Two red `packages/utils` tests killed every
publish downstream, and `releases/latest` sat at `v1.0.27` while the tags marched
on. Preparing locally and pushing to `main` first makes that failure impossible by
construction rather than by gate.

`ci.yml` still checks the one fact that could go wrong: `release.ts verify-tag`
refuses unless the tagged commit is on `main` (`identical` or `behind`), and
refuses when the comparison cannot be established at all. Tagging a local branch,
a rewritten commit, or a fork is rejected before anything is built.

You may tag an older `main` commit. `behind` is accepted precisely because `main`
often advances between preparation and the tag push, and that older commit is
still a commit `main` tested.

## What runs

### Locally: preparation

`scripts/release-cut.ts` prepares the tree and commits. With `--dry-run`
(`bun run release:dry`) it decides the same things and writes none of them.

1. **Preflight.** Require the `main` branch and a clean tree, so the bump commit
   contains the bump and nothing else. Require the new version to be greater than
   the latest tag; a repository with no `v*` tags reads as a `0.0.0` baseline.
2. **Documented.** Assert every publishable package whose shipped source changed
   has a bullet under its `## [Unreleased]` section.
3. **Bump.** Write the new version to every public `package.json`, the root
   `@veyyon/*` catalog entries, the Rust workspace version, and the
   `veyyon-natives` version sentinel. Regenerate the lockfiles. Then require every
   one of those authorities to agree on one version tuple.
4. **Changelogs.** Roll each package's `## [Unreleased]` into a dated
   `## [version]` section and open a fresh empty `## [Unreleased]` above it.
   Regenerate the repo-root `CHANGELOG.md` from every package changelog.
5. **Commit.** Stage exactly the paths the preparation touched and commit
   `chore: bump version to vX.Y.Z`. The subject is a contract, not a message:
   `checks.yml` keys its changelog exemption off the `chore: bump version to `
   prefix, because the bump commit drains `## [Unreleased]` by design.
6. **Print.** Print the push and tag commands for the version it produced.

Run `bun run check` yourself before pushing if you want the answer sooner; `main`
CI runs it either way.

### Locally: publishing, with `bun run release`

`scripts/release-ship.ts` is the half that leaves your machine, and it only runs
when preparation succeeded in the same invocation. It prints the commit and the
tag, asks once, then:

1. **Push `main`.** The bump goes through main's ordinary CI like any other
   commit.
2. **Wait for that SHA.** Poll `gh run list --commit <sha>` until every workflow
   that fires on a main push has appeared and finished. A workflow that has not
   registered yet reads as pending, never as passing, because the run list takes
   a moment to fill in and "everything I can see passed" would tag on a partial
   view.
3. **Judge the newest run of each workflow.** One commit carries several runs of
   one workflow: a re-run, a `workflow_dispatch`, a run someone stopped. Only the
   latest of each decides, ordered by creation time with the run id as the
   tie-break, so re-running a cancelled gate to green clears the cut. A newer red
   still outvotes an older green. Within that set only `success` and `skipped` are
   passes: `cancelled` proves nothing about the SHA, and reading "not a failure"
   as "a pass" is how `v1.0.36` published with its Checks run killed by branch
   churn. A run that ran and failed blocks the tag whether or not it was required.
4. **Tag.** `git tag vX.Y.Z && git push origin vX.Y.Z`.

Every way this can stop leaves the bump commit on `main` and prints the tag
command to finish by hand, because a half-finished cut must never need archaeology
to complete. That covers a red gate, a wait that exceeds ninety minutes, and
answering no at the prompt (which stops before the push, with the bump still
local).

### On the tag push: `ci.yml`

The tag push starts one `ci.yml` run at the tagged commit.

1. **Verify the tag.** `release.ts verify-tag` proves the tag is strict `vX.Y.Z`,
   that the checkout is the commit being published, that the commit is on `main`,
   and that the tree's version authorities all agree with the tag.
2. **Build and test.** The full matrix, then every platform binary.
3. **Publish.** The ordered transaction below.

There is no controller run, no dispatch, no correlation token, and no second or
third CI round. One tag push, one run.

### The publication transaction

The tag's `ci.yml` run checks out the immutable tag, builds every platform
binary, and then runs six steps in order. Each one has to pass before the next
starts.

1. Create or resume a **draft** release. Upload every binary, every native addon,
   and a `.sha256` sidecar for each. Record the exact digest manifest.
2. Download the draft macOS, Linux, and Windows binaries on native runners.
   Verify each sidecar, the embedded version against the tag, `--smoke-test`, and
   the native addon load.
3. Deploy both Cloudflare Pages projects while the release is still hidden.
   Verify that `get.veyyon.dev` serves this tag's installer bytes.
4. Re-download every draft asset, compare each digest to the preserved manifest,
   resolve the tag ref to the bump SHA, and publish that exact draft. Then poll
   the public `releases/latest` redirect until it names the new tag.
5. Rebuild and redeploy `veyyon.dev` so the changelog card carries the immutable
   release link. Verify that link on the deployed page.
6. Drive the POSIX and Windows installers against the published
   `releases/latest` on Linux x64, Linux arm64, macOS x64, macOS arm64, and
   Windows x64. Each run requires the installed binary to report the new tag.

Nothing is code-signed, notarized, or attested, and no workflow claims
provenance. The checksum sidecar is the whole integrity story.

Any failed, cancelled, or skipped required job files or updates one pinned
`release-train` issue. Only a run where every required artifact succeeded closes
it.

### Who owns each concern

One owner per concern, so a change lands in one place.

| Concern | Owner |
| --- | --- |
| Release trigger | a `v*` tag push (`push: tags` in `.github/workflows/ci.yml`) |
| Local preparation | `scripts/release-cut.ts` (`bun run release`, `bun run release:dry`) |
| Push, wait, tag | `scripts/release-ship.ts` (`bun run release`) |
| Tree preparation shared by both | `prepareReleaseTree` in `scripts/release.ts` |
| Tag and asset policy | `scripts/release-policy.ts` |
| Version authorities | `validateReleaseVersionAuthorities` in `scripts/release.ts` |
| Changelog normalization | `scripts/fix-changelogs.ts` |
| Root changelog | `renderRootChangelog` in `website/tools/gen-changelog.mjs`, written by `scripts/sync-root-changelog.ts` |
| Release notes body | `scripts/ci-release-notes.ts` |
| Binary target table | `packages/coding-agent/scripts/binary-targets.ts` |
| Binary build | `scripts/ci-release-build-binaries.ts` |
| Publication | `release_github_publish` in `.github/workflows/ci.yml` |
| Site and install endpoint | `website/build.mjs` and `website/deploy.mjs`, see [deployment.md](./deployment.md) |

Two things that look like release steps and are not. `bun run gen:changelog`
(`scripts/rewrite-changelog.ts`) asks a model to rewrite an `## [Unreleased]`
section into shipped-behavior prose; it is an authoring aid you run by hand before
a release, and no release invokes it. `bun run check-spoofed-versions` compares the
external tool versions veyyon impersonates against their upstream releases; it is
maintenance, unrelated to cutting one.

## What a release produces

Three surfaces, and all three are required.

**The GitHub release.** Five platform binaries, six native addons, and a
`.sha256` sidecar for every one of them. `scripts/release-policy.ts` holds the
exact manifest, and a release with a missing or an extra distribution asset stays
red.

| Platform and arch | Binary |
| --- | --- |
| linux x64 | `veyyon-linux-x64` |
| linux arm64 | `veyyon-linux-arm64` |
| macOS x64 | `veyyon-darwin-x64` |
| macOS arm64 | `veyyon-darwin-arm64` |
| Windows x64 | `veyyon-windows-x64.exe` |

The native addons ship as `veyyon_natives.<platform>-<arch>[-variant].node` so a
source install stays toolchain-free: `ensure-native.ts` fetches the addon for its
own checkout's tag instead of requiring cargo.

**The website** (`veyyon.dev`). `website/changelog.html`, regenerated from
`packages/coding-agent/CHANGELOG.md` and reconciled against the published GitHub
releases for real dates and permalinks.

**The install endpoint** (`get.veyyon.dev`). A separate built tree, the two
install scripts plus a root rewrite, deployed to the `veyyon-get` Pages project.

Keep the asset set complete. A release that ships only some platforms returns 404
for the rest.

### Every published release needs a changelog entry

The website build fails when a version exists on GitHub Releases that
`packages/coding-agent/CHANGELOG.md` does not describe. Users can install that
version, so the changelog has to say what is in it.

The gate is unconditional. `UNDOCUMENTED_RELEASE_BASELINE` in
`website/tools/gen-changelog.mjs` is empty, so no version is exempt. Write the
entry when you see the failure. Do not add the version to the baseline: it is a
shrinking record of old debt, and
`website/tools/undocumented-release-ratchet.test.ts` pins it empty.

## Verify it worked

Do this on a clean machine or a container, not on the workstation that built it.

```sh
curl -fsSL https://get.veyyon.dev | sh
veyyon --version
veyyon plugin doctor
```

`--version` must report the version you released, and `plugin doctor` must be
green. Ask `gh release list` what shipped rather than reading the tag list: tags
and releases have diverged before, and the changelog is the record of what
changed while a version was current.

## Recover from a failure

Recovery depends on where the release stopped. Find that first, then take the one
matching section.

### It failed before the tag was pushed

The cut refused, or `main`'s CI went red on the bump commit. No remote
tag exists, so nothing was published and nothing needs undoing remotely.

If it refused before it wrote anything, it named the reason: a
dirty tree, the wrong branch, a version that is not ahead of the latest tag, or
an undocumented package. Fix it and run it again — the tree is untouched.

If it failed part-way — an unreconcilable natives sentinel, a changelog the
prepared-release assertion rejects, or `bun run check` going red — it had
already rewritten every package version, both lockfiles and every changelog. It
rolls those back before exiting and reports how many paths it restored, so the
tree is clean and the retry is not blocked by its own leftovers. Only files it
*created* are left behind, listed by name, because it does not delete files;
remove them yourself before re-running. Either way the reported cause is the
thing to fix, not the rollback.

If it committed and `main`'s CI then went red, the bump commit is on `main` like
any other commit. Fix the cause, push the fix, and tag the commit that goes green.
The tag does not have to be `main`'s tip. Never tag a red commit to "get the
release out": that is exactly the failure this model exists to prevent.

### The tag pushed but nothing published

The tag is on `origin/main`, and there is no matching GitHub release or the
release has no binaries.

Open the tagged CI run from the Actions tab.

- **A tagged run exists.** Fix the cause and **re-run failed jobs only**. Do not
  re-run all jobs. `release_metadata` re-verifies the tag against `main` and the
  run proceeds, because the tag is immutable and the facts it checks have not
  changed.
- **No tagged run exists.** The tag push did not start one. Delete the remote tag
  and push it again at the same commit, which schedules a fresh run in the same
  per-SHA group. Do not cut a second tag for the same version.

### The release published but the binaries are wrong

`curl -fsSL https://get.veyyon.dev | sh` fails, or it fails a checksum.

A checksum failure is correct behavior. Both installers fail closed when the
sidecar is missing, empty, malformed, or mismatched, and `--no-verify` on POSIX
or `-NoVerify` on Windows is the explicit override for old pre-sidecar releases.
A missing sidecar on a current release means the sidecar step was skipped or its
upload failed.

Confirm the exact manifest check passed in `release_github`, then re-run the
release build and publish jobs for the tag as above. CI regenerates and
re-uploads the assets and their checksums. If users are already hitting the bad
release, stop the bleeding first with the next section.

### The release is bad and users are installing it

`curl -fsSL https://get.veyyon.dev | sh` installs whatever `releases/latest`
resolves to, and the binary's self-updater resolves the same selector. So what
`latest` points at is the rollback lever, and moving it needs no new build.

Stop the bleeding first:

1. Open the bad release in the GitHub releases UI and **uncheck "Set as the
   latest release"**, or mark it a pre-release. GitHub recomputes `latest` as the
   most recent stable release below it.
2. Confirm what `latest` now names.

   ```sh
   gh release view --json tagName -q .tagName
   ```

3. Re-test the install on a clean machine. It should fetch the previous good
   version.

Do **not** delete the bad release's tag while you investigate. Deleting a tag can
orphan the release and it confuses `release.ts`'s latest-tag baseline. Demote the
release now, and delete it only after a fixed release ships.

One caveat on rolling back far. Both installers fail closed on a missing or empty
`.sha256` sidecar, and releases before the sidecar step did not publish one, so
rolling back to a pre-sidecar release needs `--no-verify` on POSIX or `-NoVerify`
on Windows.

The website reconciles on its next deploy. Deleting the bad release drops that
version to `pending release`; marking it a pre-release does not, because the
generator still renders non-draft pre-releases as published.

#### For a user already on the bad version

Configuration, profiles, sessions, and caches all live outside the binary, and
rolling the binary back removes none of them. Reinstalling replaces the binary in
place.

```sh
curl -fsSL https://get.veyyon.dev | sh
```

To pin an exact version regardless of what `latest` says, name the release tag.
`--ref` names a published release tag and nothing else: the installer downloads
that release's asset and never clones or builds.

```sh
curl -fsSL https://get.veyyon.dev | sh -s -- --ref vX.Y.Z
```

On Windows the same pin is:

```powershell
& ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Ref vX.Y.Z
```

If the bad version wrote config keys the older binary rejects, remove or rename
those keys. The error names the file and the line. Leave the agent directory's
`sessions/` and its SQLite stores alone.

Then run `veyyon plugin doctor` to confirm health.

#### Then ship the fix

Ship it as an ordinary release. Land the fix on `main` and run `bun run release`. `verify-tag` refuses any
commit that is not on `main`. Nothing cuts the fix for you and there are no
release branches.

A green release train is already proof that `latest` moved, because the
publication transaction polls the public redirect until it names the new tag. Only
after that, delete the bad release and its tag if you want them gone.

### The release published but a deployment failed

The release and its assets exist, but a Cloudflare Pages job is red or a Pages
project is stale. Two jobs deploy. `release_site` runs before publication and
deploys both `veyyon.dev` and `get.veyyon.dev`. `release_site_finalize` runs
after publication and redeploys `veyyon.dev` so the changelog card carries the
immutable release link.

Open the red job. Both need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`,
and both deliberately fail when the `SITE_AUTODEPLOY` repository variable is
`off`. Repair the credential or the policy, then re-run the failed job. Do not
cut another tag.

You can confirm a repair locally with the same two checks the jobs run:

```sh
bun scripts/verify-deployed-installers.ts
bun scripts/verify-deployed-changelog.ts v1.2.3
```

See [deployment.md](./deployment.md) for the Pages projects and the manual
deploy.

## Versioning and the fork

veyyon is a source fork of oh-my-pi. The per-package `CHANGELOG.md` files carry
oh-my-pi's release history, and each opens with a fork notice marking the
boundary: every entry at or below `16.5.2` is inherited upstream history, not a
veyyon release.

veyyon's own release line starts at `1.0.0`. The fork carried over none of
oh-my-pi's git tags, so `release.ts` treats a repository with no `v*` tags as a
`0.0.0` baseline instead of aborting on `git describe`. That is how the first
release cut cleanly, and it stays true if the tag set is ever rebuilt.

No veyyon package has been published to npm. `@veyyon/coding-agent` is not marked
private and carries a version, but the registry has never seen it, so npm is not
a place to look for release history either. The GitHub releases and their install
assets are the record.

### Versions 1.0.28 through 1.0.35 were never released

The version line is continuous. The tags are not: `v1.0.27` is followed by
`v1.0.36`. Each of the eight versions in between has its own `chore: bump version
to <v>` commit, all landed on 2026-07-24, so they exist in the version history.
None of them was released. There is no tag and no GitHub release for any of them.

That gap is not the only place tags and releases diverge. At the last
verification the tags ran `v1.0.0` through `v1.0.27`, then `v1.0.36` through
`v1.0.46`, while the published releases were `v1.0.21` through `v1.0.27`,
`v1.0.36`, `v1.0.37`, and `v1.0.46`. Everything else is either tagged with no
release (`v1.0.0` to `v1.0.20`, `v1.0.38`, `v1.0.39`) or stalled as an
unpublished draft (`v1.0.40` through `v1.0.45`).

Do not create the missing tags. A tag asserts that an artifact shipped under that
name, and nothing did. The changelog sections for 1.0.28 to 1.0.35 are correct as
version history and stay, because they record what changed while those numbers
were current.

What the gap costs you: anything that reads tags rather than the changelog is
wrong by eight versions. `git describe` skips them, a bisect over a reported
version cannot resolve them, and "what changed between X and Y" resolves the
wrong range if either end falls in the gap.

### The trigger has changed twice

Read older runs with this in mind.

**First it was automatic.** Completed CI and Checks runs on `main` triggered a
release workflow that cut a `patch` whenever any publishable package had an
`## [Unreleased]` bullet waiting. Because the cut consumes that section, a cut
whose CI then failed left a tag with no release and nothing left to ask for, so
the gate carried a second signal that re-cut from an unpublished tag, bounded so
that two stranded tags stopped it and asked for a person.

**Then it was a dispatched controller.** `release.yml` took a `version` and an
`expected_sha`, gated on both source workflows being green for that SHA, then
created the bump commit *inside* CI, pushed `main` and the tag atomically, and
dispatched `checks.yml` and `ci.yml` at the tag — correlating each by a nonce,
because `workflow_dispatch` returns no run id. Three CI rounds per release. All of
that existed to compensate for one thing: the bump commit was born in CI, so the
tag necessarily landed on a SHA no CI run had tested.

**Now the bump is prepared locally and pushed to `main` first**, so the tag lands
on a commit `main` already tested and the compensation is unnecessary. The
controller workflow, the nonce correlation, the source gate, and the release-train
recovery signals are all gone. Recovering a failed release is the same act as any
other: fix what failed, and tag the commit that goes green.

## Runners and concurrency

Every `ci.yml` job runs on GitHub-hosted runners, so a release can never sit
queued waiting for a runner that is not registered. That is exactly how the first
`v1.0.0` tag run stalled before the self-hosted routing was removed.

A `v*` tag run gets a per-SHA, never-cancel concurrency group, because it is the
run that publishes. Every push to `main` gets a per-SHA group too, under a
different prefix so a tag and the bump commit it points at never share one: runs
at different commits are different questions and are answered in parallel, and
what they wait for is a runner rather than each other. Manual dispatches are
never cancelled either. Pushes to other branches keep cancel-on-newer-push for
fast feedback.

The installer end-to-end jobs (`install_methods`, `install_ps1_e2e`) prove a
release artifact and cost two of the account's five concurrent macOS slots, so
they run on pull requests and on the release tag and are skipped on an ordinary
`main` push. The monitors of the release already published
(`install_binary_posix`, `install_ps1_binary`) run once a day from
`published-release-monitor.yml`, which no push can reach.

GitHub cannot share a concurrency expression across workflow files, so `ci.yml`,
`checks.yml`, and `docs.yml` each carry a copy. `scripts/ci-concurrency.test.ts`
resolves all three against real event shapes and fails when a copy drifts from
`ci.yml`.

## Build details worth knowing

`packages/coding-agent/scripts/binary-targets.ts` is the one table of shipped
targets. It names the platform, the arch, the Bun compile triple, the release
asset name, and whether the bundle is precompiled to bytecode. Both builders read
it: the release build walks it, and a local `CROSS_TARGET` resolves against it.
It is one table because two tables cost two releases, the Windows binary
segfaulting at launch for `v1.0.36` and again for `v1.0.37` while each correction
landed in one copy at a time.

Bytecode is on for the four Linux and macOS targets and off for Windows x64,
which is the only target built on a foreign runner. A cross-compiled bytecode
executable segfaults in JSC bytecode decoding at launch. The table's explicit
value takes precedence over `VEYYON_BUILD_BYTECODE`. Bytecode cuts warm startup
from roughly 650 ms to 70 ms at the cost of a larger binary.
`packages/coding-agent/scripts/compile-binary.ts` owns the build itself, and its
fail-closed `import.meta.resolve` guard covers the patched yargs
`apply-extends.js` call site that bytecode cannot handle.

The build embeds mupdf's runtime files before compiling.
`packages/coding-agent/scripts/embed-mupdf-wasm.ts --generate` copies
`mupdf-wasm.wasm`, `mupdf.js`, and `mupdf-wasm.js` next to
`packages/coding-agent/src/utils/mupdf-wasm-embed.ts` and rewrites that module to
import them as file assets. `--reset` restores the committed placeholder and
deletes the copies. A build that dies in between leaves your tree in the
generated state, where `mupdf-wasm-embed.ts` shows as modified and two
`mupdf-*embedded.js` files appear beside it. Run the `--reset` form to get back to
the checked-in state. All three copies are gitignored and the assets are declared
in `types/assets/index.d.ts`, so the generated state still type checks and cannot
be committed by accident.

*Verified against `b85848b0` on 2026-08-06.*
