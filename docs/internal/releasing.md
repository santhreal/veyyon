# Releasing

A veyyon release is a tagged commit **and** a published GitHub release the install
scripts can resolve. Everything else — a version bump, a green CI run — is a step
toward that, not the release itself.

## Versioning and the fork

veyyon is a source fork of oh-my-pi. The per-package `CHANGELOG.md` files carry
oh-my-pi's release history, and each opens with a fork notice marking the boundary:
every entry at or below `16.5.2` is inherited upstream history, not a veyyon release.

veyyon's own release line **starts at 1.0.0**. The repo has no `v*` tags yet, so
`release.ts` treats "no tags" as a `0.0.0` baseline — `bun run release 1.0.0` (or
`bun run release major`) cuts the first release cleanly instead of aborting on
`git describe`. Package `version` fields sit at the `16.5.2` fork point until the
first release flips them.

## Cutting a release

Prep: make sure every change since the last release is written under each affected
package's `## [Unreleased]` section (see the changelog format in the repo `AGENTS.md`).
For the first release, add a short "First veyyon release" summary there so the
generated `## [1.0.0]` entry isn't empty.

Then, from a clean `main`:

```
bun run release <version|major|minor|patch>
```

`scripts/release.ts` runs, in order:

1. Preflight — assert clean `main` and that the new version is greater than the latest
   tag (or the `0.0.0` baseline).
2. Bump every public `package.json`, the root `@veyyon/*` catalog entries, the Rust
   workspace version, and the `pi-natives` version sentinel; regenerate lockfiles.
3. Normalize + finalize changelogs: `## [Unreleased]` becomes the new version, a fresh
   empty `## [Unreleased]` is added on top.
4. Run `bun run check`.
5. Commit `chore: bump version to vX.Y.Z` — the subject **must** stay exactly that;
   CI keys the never-cancel release concurrency group off it. Reword the body, never
   the subject, on a retry.
6. Tag and atomically push `main` + the tag (pushed by commit sha so background tag
   pruning can't lose it).
7. Watch CI until the release jobs finish. `bun run release watch` re-attaches to CI
   for the current commit.

## What CI does with the tag

The tagged push triggers `ci.yml`. Seeing a release tag at `HEAD`, it builds every
platform binary and then publishes:

- the **GitHub release** — all `veyyon-*` binaries + `.sha256` checksums;
- the **npm** packages (`@veyyon/*`);
- the **Homebrew** formula.

Once the release is published, `curl -fsSL https://get.veyyon.dev | sh` installs it
through `releases/latest` with no further action. Verify with a real install on a
clean machine, not just a local `bun`/`cargo` build. See [deployment.md](./deployment.md)
for the install path and asset names.

## Release runners

Release-shaped runs (the `chore: bump version to vX.Y.Z` push, a `v*` tag-ref
dispatch, or any manual dispatch) route **every** job to GitHub-hosted runners, so a
release never depends on the self-hosted `omp-kata` fleet being up. Ordinary main
pushes keep the self-hosted fleet for speed and cache warmth. The routing predicate
is the same scheduling-time signal set as the concurrency group in `ci.yml`, and
`scripts/ci-concurrency.test.ts` locks both: a bare `omp-kata` literal or a ternary
missing the release clause fails the suite.

*Verified against `11c84f4` on 2026-07-16.*
