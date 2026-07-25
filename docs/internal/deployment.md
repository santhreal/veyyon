# Deployment

How veyyon reaches users. Two independent things ship: the **website** (Cloudflare
Pages) and the **CLI binaries** (GitHub Releases, pulled by the install scripts).
Neither depends on the other, you can redeploy the site without cutting a release,
and a release publishes binaries without touching the site.

## Domains and what serves them

| Domain | Serves | Backed by |
| --- | --- | --- |
| `veyyon.dev`, `www.veyyon.dev` | The marketing site + handbook + changelog + install page | Cloudflare Pages project `veyyon` |
| `get.veyyon.dev` | The `install.sh` script at its root, so `curl -fsSL https://get.veyyon.dev \| sh` works | Cloudflare Pages project `veyyon-get` |
| `github.com/santhreal/veyyon/releases` | The platform binaries + checksums | GitHub Releases (published by CI) |

## Website

The site is a static tree under `website/`, deployed to Cloudflare Pages. There is no
build framework, the HTML pages are authored directly; only the changelog and the
install scripts are generated.

### Build

```
bun run site:build      # = node website/build.mjs
```

`build.mjs` does three things:

1. Regenerates `website/changelog.html` from `packages/coding-agent/CHANGELOG.md`
   (the curated source of truth) via `website/tools/gen-changelog.mjs`, reconciled
   against the **published GitHub Releases** so the page can't drift from what actually
   shipped. The generator:
   - is fork-aware: it renders **only veyyon's own release cards** plus the
     `[Unreleased]` block (as an "Unreleased / next release" card at the top). The
     pre-fork oh-my-pi history is never replayed as release cards, it collapses to a
     single credit note linking upstream;
   - marks each veyyon version `published` only when GitHub has a non-draft release for
     it, using GitHub's publish date and a `View on GitHub ↗` permalink, and marks a
     finalized-but-unpublished version as `pending release`;
   - fails **loud** (never silently): if the GitHub API is unreachable it warns and
     builds from the CHANGELOG alone (`--no-github` forces this offline mode), and if a
     published release has no CHANGELOG entry it prints a coherence warning rather than
     dropping it. Repo resolves from `--repo` / `VEYYON_SITE_REPO` / `GITHUB_REPOSITORY`
     / the git remote, defaulting to `santhreal/veyyon`.
2. Stages `scripts/install.sh` and `scripts/install.ps1` at the site root so
   `veyyon.dev/install.sh` resolves. **The staged copies are build artifacts**, edit
   the originals in `scripts/`, never `website/install.*`.
3. Runs a brand check that fails the build if a page leaks the old product name
   (only the MIT oh-my-pi attribution and clearly-marked `OMP_` legacy env aliases are
   allowed).

The handbook at `website/docs` is a **symlink** to `docs/handbook/book` (mdBook's
build output). If handbook sources under `docs/handbook/src/` changed, rebuild the
book first:

```
cd docs/handbook && mdbook build
```

Use mdbook **v0.5.2**, the `docs.yml` book-freshness gate rebuilds with that pinned
version and fails CI if the committed `docs/handbook/book/` doesn't match the sources.

### Technical reports and the blog

A technical report is a Markdown file in `website/blog/`, and that file is the only
copy of it. GitHub renders it as-is for anyone reading the repository, and the site
build renders the same source into a styled page at `veyyon.dev/blog/<slug>`. There
is no separate CMS, no pasted duplicate, and nothing to keep in sync by hand.

Write one like this:

```
website/blog/hashline-anchors.md
```

```markdown
---
title: "Hashline: content-addressed edits"
slug: hashline-anchors
date: 2026-07-20
summary: "Anchors from a prior read, verified before the write."
draft: false
---

Edits carry an anchor.
```

The frontmatter rules are enforced, not advisory. `website/tools/gen-blog.mjs`
throws (and so fails the build) when a slug is not URL-safe, when two reports
resolve to the same slug, or when a published post has no ISO `date` or no
`summary`. `draft: true` still renders the page so a direct link works for review,
but the post is served `noindex`, stays off the blog index, and stays out of the
sitemap. Flipping `draft` to `false` is what publishes it.

Build and gate it locally:

```
bun run site:build        # renders every post, folds published ones into sitemap.xml
bun run site:check-blog   # asserts the rendered tree matches the sources
```

`site:check-blog` is the coherence gate: every published post has a rendered page,
a sitemap entry, an index card, its frontmatter title and date on the page, and no
`noindex`; every draft has the mirror image of that; and every sitemap blog URL
still has a source file. `website/tools/gen-blog.test.ts` pins the generator's rules.

### Automatic sync: merge a report, it publishes itself

`.github/workflows/site.yml` is what makes the repository and the site one thing.
It builds the site on any pull request touching `website/**` (so a malformed report
fails review, never production), and on push to `main` it builds again and deploys
the `veyyon` Pages project. Merging a report to `main` publishes it; there is no
manual deploy step and no waiting for a release.

It runs on `website/**`, `docs/handbook/book/**`,
`packages/coding-agent/CHANGELOG.md`, `scripts/install.*`, and its own file. It uses
the same `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets as the release
deploy below, and if the token is missing the job **fails loudly** rather than
reporting a green publish that never happened.

### Automatic deploy on release (secondary path)

The site redeploys itself whenever a release publishes. `ci.yml`'s `release_site` job
runs after `release_github`: it regenerates the changelog (now reconciled against the
just-published release), builds the site with the brand check gating, and deploys the
`veyyon` Pages project with `wrangler pages deploy`. This is what keeps the changelog
current, no human has to remember to redeploy after a release.

It needs two GitHub **repository secrets**:

- **`CLOUDFLARE_API_TOKEN`**: a Cloudflare Pages:Edit token (the same value as
  `CF_PAGES_API_TOKEN` in `/credentials/.env`).
- **`CLOUDFLARE_ACCOUNT_ID`**: optional; set it only if the token spans more than one
  account.

If `CLOUDFLARE_API_TOKEN` is absent the job **skips loudly** with a CI `::warning::`
(it never silently no-ops), and you fall back to the manual deploy below. Set repo
variable `SITE_AUTODEPLOY=off` to disable the job entirely.

### Manual deploy (override / out-of-band site edits)

Use this to ship a site change without cutting a release, or if the auto-deploy is off:

```
export CLOUDFLARE_API_TOKEN="$CF_PAGES_API_TOKEN"   # token lives in /credentials/.env
bun run site:deploy                                 # = node website/deploy.mjs
```

`deploy.mjs` runs `build.mjs` (so a failing brand check aborts the deploy), then
publishes the `website/` tree with `wrangler pages deploy`. `--dry-run` builds and
prints the exact command without publishing. The account is resolved from the token;
set `CLOUDFLARE_ACCOUNT_ID` if the token spans more than one account.

To deploy the install endpoint instead of the main site, target the other project:

```
VEYYON_PAGES_PROJECT=veyyon-get bun run site:deploy
```

### Cloudflare Pages config files

Cloudflare reads these from the deployed root:

- **`website/_headers`**: sets `Content-Type: text/x-shellscript` and
  `Cache-Control: no-cache` on `install.sh`/`install.ps1` (a stale cached installer is
  a real hazard), and long-lived immutable caching on `/fonts/*`.
- **`website/_redirects`**: clean-URL routing. `/install` serves the install *page*;
  the raw script lives at `/install.sh` and at `get.veyyon.dev`.

## CLI binaries

Users install with `curl -fsSL https://get.veyyon.dev | sh` (or the PowerShell
installer on Windows). The scripts resolve the platform, read
`github.com/santhreal/veyyon`'s **`releases/latest`**, download the matching asset,
and verify it before running it.

### Asset names

The build (`scripts/ci-release-build-binaries.ts`) and both installers agree on these
names, keep them in sync if you touch any of the three:

| Platform / arch | Asset |
| --- | --- |
| linux x64 | `veyyon-linux-x64` |
| linux arm64 | `veyyon-linux-arm64` |
| macOS x64 | `veyyon-darwin-x64` |
| macOS arm64 | `veyyon-darwin-arm64` |
| Windows x64 | `veyyon-windows-x64.exe` |

Each ships alongside a `<asset>.sha256`. `install.sh` covers linux and darwin;
`install.ps1` handles `veyyon-windows-x64.exe`.

### Integrity

`install.sh` **fails closed** on a checksum mismatch, it downloads `<asset>.sha256`,
compares, and refuses to install on any mismatch (override only with `--no-verify`).
macOS binaries are additionally Developer-ID signed and notarized in CI when the
`APPLE_*` secrets are present. A release that ships only some platforms will 404 for
the rest, so keep the asset set complete.

### How binaries get published

Cutting a release (see [releasing.md](./releasing.md)) tags the commit; the tagged
push triggers `ci.yml`, which builds every platform binary and publishes the GitHub
release with all assets + checksums. The install scripts then pick it up through
`releases/latest` with no further action.

> Every `ci.yml` job runs on GitHub-hosted runners, so a release never depends
> on a self-hosted fleet: see [releasing.md](./releasing.md) §Runners and
> concurrency.

## Repository secrets and variables

Everything CI needs to publish, in one place. veyyon publishes to GitHub only, so
the one credential a release genuinely needs is `RELEASE_PAT` (to trigger the
release run). The rest are optional-with-a-loud-skip: a missing secret emits a CI
`::warning::` and skips that leg (signing, or the site deploys), and the release
still ships the GitHub binaries.

| Name | Kind | Gates |
| --- | --- | --- |
| `RELEASE_PAT` | secret | **required.** Fine-grained PAT with Contents: read/write. The Release workflow pushes the version-bump commit and tag with it, because GitHub does not start workflow runs for pushes made with the built-in `GITHUB_TOKEN` — so without it a release would be tagged but never published. The workflow refuses to start when it is missing. Drives both the automatic (push) and manual release paths. |
| `CLOUDFLARE_API_TOKEN` | secret | `site.yml`'s deploy of `veyyon.dev` on every push to `main`, and `release_site`'s deploy of both `veyyon.dev` and `get.veyyon.dev` (Pages:Edit token; same value as `CF_PAGES_API_TOKEN` in `/credentials/.env`) |
| `CLOUDFLARE_ACCOUNT_ID` | secret | only if the token spans multiple Cloudflare accounts |
| `APPLE_CERTIFICATE_P12` + `APPLE_CERTIFICATE_PASSWORD` + `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID` | secrets | macOS Developer-ID signing + notarization (all five or signing is skipped) |
| `SITE_AUTODEPLOY` | repo var | set `off` to disable the release site auto-deploy |

## Rollback and hotfix

The installers resolve **`releases/latest`**, so what "latest" points at *is* the
rollback lever:

- **Bad release, binaries broken**: mark the bad GitHub release as a **pre-release**
  (or delete it). `releases/latest` immediately falls back to the previous good
  release and every new `curl | sh` install gets the old binaries. The installed
  binary's auto-updater resolves the same `releases/latest`, so it stops offering the
  bad version too. This is the fastest path and needs no new build.
- **Website/changelog**: the next `site:deploy` (manual or the fixed release's
  auto-deploy) reconciles the changelog against the *published* releases, so an
  unpublished/rolled-back version automatically drops back to `pending release`.

**Hotfix flow**: fix on `main` → `bun run release patch`. There are no release
branches, a hotfix is just the next patch release. If the bad version must stop
being installed *right now*, do the pre-release flip above first, then take the time
to fix properly.

## Checklist for a normal site update

Merging to `main` ships the site (see *Automatic sync*), and a release ships it again
with the changelog reconciled. So the normal path is: edit under `website/`, run
`bun run site:build` (plus `bun run site:check-blog` if you touched a post), open the
pull request, merge. Nothing else.

Deploy by hand only when the automation is off or you need the site live before the
merge lands:

1. Edit the page(s) under `website/` (or the changelog source, or `scripts/install.*`).
2. `bun run site:build`: confirm the brand check passes and the changelog looks right.
3. `export CLOUDFLARE_API_TOKEN="$CF_PAGES_API_TOKEN"`.
4. `bun run site:deploy`.
5. If `install.sh`/`install.ps1` changed, also deploy `veyyon-get`.

*Verified against `d3e3db30` on 2026-07-23.*
