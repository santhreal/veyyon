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

Prep: make sure every change since the last release is written under each affected
package's `## [Unreleased]` section (see the changelog format in the repo `AGENTS.md`).

Then, from a clean `main`:

```
bun run release <version|major|minor|patch>
```

`scripts/release.ts` runs, in order:

1. Preflight: assert clean `main` and that the new version is greater than the latest
   tag (or the `0.0.0` baseline).
2. Bump every public `package.json`, the root `@veyyon/*` catalog entries, the Rust
   workspace version, and the `veyyon-natives` version sentinel; regenerate lockfiles.
3. Normalize + finalize changelogs: `## [Unreleased]` becomes the new version, a fresh
   empty `## [Unreleased]` is added on top.
4. Run `bun run check`.
5. Commit `chore: bump version to X.Y.Z` (bare version, no `v`): CI keys the
   never-cancel release concurrency group off the `chore: bump version to ` subject
   prefix, so the subject **must** stay exactly that shape. Reword the body, never
   the subject, on a retry.
6. Tag and atomically push `main` + the tag (pushed by commit sha so background tag
   pruning can't lose it).
7. Watch CI until the release jobs finish. `bun run release watch` re-attaches to CI
   for the current commit.

## What CI does with the tag

The tagged push triggers `ci.yml`. Seeing a release tag at `HEAD`, it builds every
platform binary and then publishes:

- the **GitHub release**: all `veyyon-*` binaries + `.sha256` checksums (this is
  the channel the `curl | sh` installer uses);
- the **npm** packages (`@veyyon/*`), only when the `NPM_PUBLISH=on` repo var opts
  in (off by default, see [deployment.md](./deployment.md));
- the **Homebrew** formula.

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

*Verified against `31acb69` on 2026-07-17.*
