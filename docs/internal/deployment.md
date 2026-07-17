# Deployment

How veyyon reaches users. Two independent things ship: the **website** (Cloudflare
Pages) and the **CLI binaries** (GitHub Releases, pulled by the install scripts).
Neither depends on the other — you can redeploy the site without cutting a release,
and a release publishes binaries without touching the site.

## Domains and what serves them

| Domain | Serves | Backed by |
| --- | --- | --- |
| `veyyon.dev`, `www.veyyon.dev` | The marketing site + handbook + changelog + install page | Cloudflare Pages project `veyyon` |
| `get.veyyon.dev` | The `install.sh` script at its root, so `curl -fsSL https://get.veyyon.dev \| sh` works | Cloudflare Pages project `veyyon-get` |
| `github.com/santhreal/veyyon/releases` | The platform binaries + checksums | GitHub Releases (published by CI) |

## Website

The site is a static tree under `website/`, deployed to Cloudflare Pages. There is no
build framework — the HTML pages are authored directly; only the changelog and the
install scripts are generated.

### Build

```
bun run site:build      # = node website/build.mjs
```

`build.mjs` does three things:

1. Regenerates `website/changelog.html` from `packages/coding-agent/CHANGELOG.md`
   (the single source of truth) via `website/tools/gen-changelog.mjs`. The generator
   is fork-aware: veyyon's own releases render normally, inherited oh-my-pi entries go
   under an "Inherited from oh-my-pi" divider and never as "latest".
2. Stages `scripts/install.sh` and `scripts/install.ps1` at the site root so
   `veyyon.dev/install.sh` resolves. **The staged copies are build artifacts** — edit
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

Use mdbook **v0.5.2** — the `docs.yml` book-freshness gate rebuilds with that pinned
version and fails CI if the committed `docs/handbook/book/` doesn't match the sources.

### Deploy

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

- **`website/_headers`** — sets `Content-Type: text/x-shellscript` and
  `Cache-Control: no-cache` on `install.sh`/`install.ps1` (a stale cached installer is
  a real hazard), and long-lived immutable caching on `/fonts/*`.
- **`website/_redirects`** — clean-URL routing. `/install` serves the install *page*;
  the raw script lives at `/install.sh` and at `get.veyyon.dev`.

## CLI binaries

Users install with `curl -fsSL https://get.veyyon.dev | sh` (or the PowerShell
installer on Windows). The scripts resolve the platform, read
`github.com/santhreal/veyyon`'s **`releases/latest`**, download the matching asset,
and verify it before running it.

### Asset names

The build (`scripts/ci-release-build-binaries.ts`) and both installers agree on these
names — keep them in sync if you touch any of the three:

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

`install.sh` **fails closed** on a checksum mismatch — it downloads `<asset>.sha256`,
compares, and refuses to install on any mismatch (override only with `--no-verify`).
macOS binaries are additionally Developer-ID signed and notarized in CI when the
`APPLE_*` secrets are present. A release that ships only some platforms will 404 for
the rest, so keep the asset set complete.

### How binaries get published

Cutting a release (see [releasing.md](./releasing.md)) tags the commit; the tagged
push triggers `ci.yml`, which builds every platform binary and publishes the GitHub
release with all assets + checksums. The install scripts then pick it up through
`releases/latest` with no further action.

> Release-shaped runs route every `ci.yml` job to GitHub-hosted runners, so a
> release never depends on the self-hosted fleet — see
> [releasing.md](./releasing.md) §Release runners.

## Checklist for a normal site update

1. Edit the page(s) under `website/` (or the changelog source, or `scripts/install.*`).
2. `bun run site:build` — confirm the brand check passes and the changelog looks right.
3. `export CLOUDFLARE_API_TOKEN="$CF_PAGES_API_TOKEN"`.
4. `bun run site:deploy`.
5. If `install.sh`/`install.ps1` changed, also deploy `veyyon-get`.

*Verified against `a49ff74` on 2026-07-17.*
