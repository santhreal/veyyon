# Deployment

How veyyon reaches users. Three coordinated surfaces ship: the **website** and
**install scripts** on Cloudflare Pages, and the **CLI binaries** on GitHub Releases.
The site can deploy without cutting a release. A release stages its binaries in a
hidden GitHub draft, deploys and verifies both Pages projects, publishes the verified
draft, then rebuilds `veyyon.dev` so the changelog records the now-public release.

## Domains and what serves them

| Domain | Serves | Backed by |
| --- | --- | --- |
| `veyyon.dev`, `www.veyyon.dev` | The marketing site + handbook + changelog + install page | Cloudflare Pages project `veyyon` |
| `get.veyyon.dev` | The `install.sh` script at its root, so `curl -fsSL https://get.veyyon.dev \| sh` works | Cloudflare Pages project `veyyon-get` |
| `github.com/santhreal/veyyon/releases` | The platform binaries + checksums | GitHub Releases (published by CI) |

## Website

The site is a static tree under `apps/site/`, deployed to Cloudflare Pages. There is no
build framework. Most marketing HTML is authored directly, while the build rewrites
shared navigation and generates the changelog, the models catalog, and the installer
trees.

### Build

```
bun run site:build      # = node apps/site/build.mjs
```

`build.mjs` runs this sequence:

1. Rewrites the three shared navigation regions in each of six hand-authored HTML
   pages from `apps/site/tools/nav.mjs`. Missing markers fail the build.
2. Regenerates `apps/site/changelog.html` from
   `packages/coding-agent/CHANGELOG.md` via
   `apps/site/tools/gen-changelog.mjs`, reconciled against published GitHub
   Releases. The generator renders veyyon's release cards plus `[Unreleased]`
   and collapses inherited oh-my-pi history to one credit note. A normal build
   fails closed if GitHub publication state is unavailable; `--no-github` is the
   explicit offline mode. A published release with no changelog entry also
   fails the build.
3. Stages `scripts/install.sh` and `scripts/install.ps1` at the main site root.
   These copies are build artifacts; edit the originals in `scripts/`, never
   `apps/site/install.*`.
4. Regenerates `apps/site/models-data.json` from `packages/catalog/src/models.json`
   and the provider descriptors via `apps/site/tools/gen-models.mjs`. `models.html`
   fetches that file, and the live page reads it from jsDelivr's `@main` mirror, so
   a committed catalog regen reaches veyyon.dev without a deploy.
5. Stages `assets/demo-hd.webp`, and `assets/agents-cockpit.webp` when it exists,
   into the site tree, so the site cannot serve a clip the repository does not have.
6. Generates `website-get/` at the repository root for the separate `veyyon-get`
   Pages project, including the two installer scripts, root rewrite, and response
   headers.
7. Rebuilds the handbook (`docs/handbook/book`) via `mdbook build docs/handbook`,
   failing if mdbook is not on PATH (requiring pinned mdbook v0.5.2) or if
   `docs/handbook/book/index.html` was not generated.
8. Scans the hard-coded page list in `apps/site/build.mjs` for leaked old product
   names, allowing the MIT oh-my-pi attribution and marked `OMP_` legacy aliases,
   then writes `apps/site/.buildinfo`. This scan does not cover arbitrary handbook
   pages.

The handbook at `apps/site/docs` is a **symlink** to `docs/handbook/book` (mdBook's
build output). `docs/handbook/book` is gitignored build output and is not committed.
`bun run site:build` builds the handbook on demand; a standalone rebuild is:

```
mdbook build docs/handbook
```

Use mdbook **v0.5.2**, the pinned version enforced across `docs.yml` and `site.yml`.

In CI:
- `.github/workflows/docs.yml` installs mdbook **v0.5.2**, builds `docs/handbook`,
  verifies that every content-hashed asset and search index exists, and runs
  `scripts/handbook-built-pages-contain-source-contracts.test.ts` against the
  generated output to verify that rendered HTML contains all source Markdown text
  runs and link targets.
- `.github/workflows/site.yml` installs mdbook **v0.5.2**, builds the handbook, and
  deploys the dereferenced site tree to Cloudflare Pages.

### Automatic sync: merge a site change, it publishes itself

`.github/workflows/site.yml` is what makes the repository and the site one thing.
It builds the site on pull requests targeting `main` that touch `apps/site/**`
or `docs/handbook/**` (so a malformed page fails review, never production), and
on a matching push to `main` it builds again and deploys both the `veyyon` and
`veyyon-get` Pages projects. Merging a page or installer change to `main`
publishes it; there is no manual deploy step and no waiting for a release.

Its path filters are `apps/site/**`, `docs/handbook/**`,
`packages/coding-agent/CHANGELOG.md`, `scripts/install.sh`,
`scripts/install.ps1`, and its own workflow file. It uses
the same `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` values as the release
deploy below. If the token is missing, the job fails loudly rather than reporting
a green publish that never happened.

### Required deploy on release

The site redeploys whenever a release publishes. `ci.yml`'s `release_site` job
runs after `release_github`, while the candidate is still a hidden draft: it
regenerates the changelog, builds the site with the brand check gating, deploys
both the `veyyon` and `veyyon-get` Pages projects, then runs
`scripts/verify-deployed-installers.ts` so a stale `get.veyyon.dev` blocks the
release instead of shipping behind it. Deploying before publication means a
failed deployment leaves `releases/latest` on the prior version rather than
exposing a release whose install channels are stale.

`release_github_publish` publishes the draft only after `release_site` and the
three per-platform verify jobs succeed. `release_site_finalize` then rebuilds
and redeploys `veyyon.dev` (the main site), so the changelog replaces the pending card with the
published release.

Both site jobs require the same two GitHub **repository secrets**:

- **`CLOUDFLARE_API_TOKEN`**: a Cloudflare Pages:Edit token (the same value as
  `CF_PAGES_API_TOKEN` in `/credentials/.env`).
- **`CLOUDFLARE_ACCOUNT_ID`**: the account that owns both Pages projects.

If either secret is absent, or the repository variable `SITE_AUTODEPLOY` is
`off`, the job fails loudly. A `release_site` failure keeps the release a draft;
a `release_site_finalize` failure leaves the release published with a stale
changelog on the site. Either way the release train stays red until production
deployment is repaired.

### Manual deploy (override / out-of-band site edits)

Use this to ship a site change without cutting a release, or if the auto-deploy is off:

```
export CLOUDFLARE_API_TOKEN="$CF_PAGES_API_TOKEN"   # token lives in /credentials/.env
bun run site:deploy                                 # = node apps/site/deploy.mjs
```

`deploy.mjs` runs `build.mjs` (so a failing brand check aborts the deploy), copies the selected site
into a temporary tree with symlinks dereferenced, then publishes that snapshot with
`wrangler pages deploy --skip-caching`. Dereferencing makes `apps/site/docs` contain the rebuilt
handbook files. Skipping Wrangler's local asset cache prevents it from reusing the symlink's old
manifest and reporting success without creating a new deployment. `--dry-run` builds and prints the
staging plan and exact Wrangler command without publishing. The account is resolved from the token;
set `CLOUDFLARE_ACCOUNT_ID` if the token spans more than one account.

To deploy the install endpoint instead of the main site, target the other project:

```
VEYYON_PAGES_PROJECT=veyyon-get bun run site:deploy
```

### Cloudflare Pages config files

Cloudflare reads these from the deployed root:

- **`apps/site/_headers`**: serves `install.sh` as
  `application/x-sh; charset=utf-8` and `install.ps1` as
  `text/plain; charset=utf-8`, with `Cache-Control: no-cache, must-revalidate`
  on both. `/fonts/*` uses long-lived immutable caching.
- **`apps/site/_redirects`**: deliberately rule-free. Pages' own clean-URL routing
  already serves `install.html` at `/install`, and rewriting `/install` to
  `/install.html` makes Pages redirect the target back to `/install`, so the file
  carries only the comment recording that. The raw script stays at `/install.sh`
  and at `get.veyyon.dev`.

### Grievance collector

`POST https://veyyon.dev/api/grievances` is a Pages Function at
`apps/site/functions/api/grievances.ts`. It validates bounded Auto QA batches and writes them to the
`veyyon-grievances` D1 database through the `GRIEVANCES_DB` binding in
`apps/site/wrangler.jsonc`. The database stores the validated, bounded report payload
verbatim with a server timestamp; the Function does not sanitize it. Automatic
session uploads can apply the provider sanitizer, while manual
`veyyon grievances push` uploads the stored report strings unchanged. The Function
does not store request headers or client IP addresses. `(install_id, local_id)` is
unique, so a retry cannot create a duplicate row.

Apply committed schema migrations before deploying a function that needs them:

```bash
env -u CF_ACCOUNT_ID -u CLOUDFLARE_ACCOUNT_ID -u CLOUDFLARE_API_TOKEN \
  bunx wrangler@latest d1 migrations apply veyyon-grievances \
  --remote --config apps/site/wrangler.jsonc
```

This command deliberately uses Wrangler's cached OAuth login. The Pages API token can deploy the
existing D1 binding, but it does not have D1 migration permission. A stale `CF_ACCOUNT_ID` can force
the OAuth token against another account and produce Cloudflare error 10000, so the command removes
both account overrides.

The client records grievances locally whenever `dev.autoqa` is on. Network upload remains a
per-profile opt-in through `dev.autoqaPush.enabled`, which defaults to `false`. An operator can also
run `veyyon grievances push` for a one-time upload without changing that toggle.

## CLI binaries

Users install with `curl -fsSL https://get.veyyon.dev | sh` (or the PowerShell
installer on Windows). The scripts resolve the platform, read
`github.com/santhreal/veyyon`'s **`releases/latest`**, download the matching asset,
and verify it before running it.

### Asset names

The asset names come from one table,
[`packages/coding-agent/scripts/binary-targets.ts`](../../packages/coding-agent/scripts/binary-targets.ts),
which both binary builders read. Both installers have to agree with it, so if you
change a name, change it in the table and in both installers together:

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

Both installers **fail closed** when SHA-256 verification fails. They download the
matching `<asset>.sha256`, recompute the binary's digest, and refuse to install a
missing, empty, malformed, or mismatched sidecar (with `--no-verify` / `-NoVerify`
as the explicit override).

### How binaries get published

[releasing.md](./releasing.md) is the only page about that. It covers the one
command you run, the publication transaction the tagged CI run performs, what the
release produces, how to verify it, and how to recover a failed step.

## Repository secrets and variables

GitHub binary publication needs no repository secret. `bun run release <bump>`
prepares the version bump, pushes it to `main` and tags the green commit from
the operator's machine, and the tag's `ci.yml` run uses the built-in
`GITHUB_TOKEN` to publish the release and verify it. The Cloudflare credentials
are required by the production deployment inside that same tagged run.

| Name | Kind | Gates |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | Required by `site.yml`, `release_site` and `release_site_finalize` to deploy both `veyyon.dev` and `get.veyyon.dev` (Pages:Edit token; same value as `CF_PAGES_API_TOKEN` in `/credentials/.env`) |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Required by `release_site` and `release_site_finalize` to select the Cloudflare account |
| `SITE_AUTODEPLOY` | repo var | Must not be `off` for a release; `off` deliberately fails both release site jobs |

## Rollback and hotfix

Rolling back a bad release and shipping the hotfix are release work, so they live
with the rest of it in [releasing.md](./releasing.md) under "Recover from a
failure". One detail belongs here because it is about the site rather than the
release: the next site deploy reconciles the changelog against non-draft releases,
so deleting a bad release drops that version to `pending release`, while merely
marking it a pre-release does not. The generator still renders non-draft
pre-releases as published.

## Checklist for a normal site update

Merging to `main` ships the site (see *Automatic sync*), and a release ships it again
with the changelog reconciled. So the normal path is: edit under `apps/site/`, run
`bun run site:build`, open the pull request, merge. Nothing else.

Deploy by hand only when the automation is off or you need the site live before the
merge lands:

1. Edit the page(s) under `apps/site/`, the changelog source, or
   `scripts/install.sh` / `scripts/install.ps1`.
2. `bun run site:build`: confirm the brand check passes and the changelog looks right.
3. `export CLOUDFLARE_API_TOKEN="$CF_PAGES_API_TOKEN"`.
4. `bun run site:deploy`.
5. If `install.sh` or `install.ps1` changed, also run `bun run site:deploy:get`.

*Verified against `9c904aa2db` on 2026-09-05.*
