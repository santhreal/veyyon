#!/usr/bin/env bash
#
# release.sh — one owner for "is this release complete?", and one doer that
# cannot claim success it did not prove.
#
# WHY THIS EXISTS
# ---------------
# The release path was six handoffs long (`bun run release` -> trigger-release
# -> Release workflow -> release.ts -> checks.yml dispatch -> ci.yml dispatch ->
# binaries -> GitHub release -> site deploy). Every hop could stop; none owned
# the whole. v1.0.38 is what that costs: the tag reached origin, the branch push
# did not, ci.yml failed against a commit reachable from nothing, no release was
# ever published, and `install.sh` kept resolving v1.0.37 for a full day. It was
# found by a human running `gh run view`. A process whose failure mode is "an
# expert eventually notices" is the defect.
#
# THE ONE IDEA
# ------------
# `released` is defined ONCE below, as a list of observable postconditions
# (`POSTCONDITIONS`). `verify` evaluates that list. `run` drives the release and
# gates every stage on the SAME list. There is deliberately no second notion of
# done anywhere in this file: two independently written notions of done are
# exactly how a half-release becomes invisible.
#
# A subprocess exiting 0 is never evidence. Every stage acts, then re-evaluates
# its own postconditions against origin, GitHub and the live endpoints; a stage
# that cannot prove its effect happened has FAILED.
#
# MODES
#   release.sh verify [vX.Y.Z]              evaluate every postcondition
#   release.sh run [major|minor|patch|X.Y.Z] drive (or repair) a release
#   release.sh postconditions               print the definition of `released`
#   release.sh help
#
# DEPENDENCIES
# ------------
# bash, plus four non-trivial external programs: `git`, `gh`, `curl`,
# `sha256sum` — no jq, no node, no bun. (It also uses the POSIX toolbox any
# shell already has: mktemp, mkdir, cat, grep, tr, sleep, rm.) The one
# exception is `repo_tooling` below, the single, clearly marked seam where this
# script shells out to the repo's existing TypeScript/Node tooling. When that
# tooling moves to Rust/Cargo, `repo_tooling` is the only function that changes.
#
# NOTE ON COST: the checksum postcondition downloads every published binary and
# hashes the bytes. That is the point — a `.sha256` that is merely present, or
# merely equal to a digest the API reports, proves nothing about the bytes a
# user will download. Expect a few hundred MB of transfer per verify.

set -euo pipefail

# Safe from any cwd inside the repo: the root is derived from this file's own
# location, not from `git rev-parse` (which would make the checker depend on the
# very tool it is inspecting) and not from $PWD.
REPO_ROOT="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
cd "$REPO_ROOT"

# =============================================================================
# THE ONLY TYPESCRIPT / NODE / BUN SURFACE IN THIS FILE
# =============================================================================
# Every call into the repo's existing JS tooling lives here and nowhere else, so
# the Cargo migration has exactly one function to replace. Nothing in this
# function decides anything: callers act through it, then prove the effect with
# a postcondition. Do not add a second call site elsewhere in this file.
#
#   cut-release <x.y.z>   scripts/trigger-release.ts  (dispatches the Release
#                         workflow, which runs scripts/release.ts: version bump,
#                         catalog, Rust workspace, native sentinel, lockfiles,
#                         changelogs, `chore: bump version to …`, push main+tag)
#   site-build            website/build.mjs   (regenerates changelog.html and
#                         stages website-get/ for the install endpoint)
#   site-deploy <project> website/deploy.mjs  (Cloudflare Pages; `veyyon` serves
#                         veyyon.dev, `veyyon-get` serves get.veyyon.dev)
#
# The site scripts are plain `node` programs (`package.json` spells them
# `node website/build.mjs` / `node website/deploy.mjs`); they are invoked
# directly rather than through `bun run`, which adds nothing but a runtime.
repo_tooling() {
	local action="$1"
	shift
	case "$action" in
	cut-release)
		bun run release "$1"
		;;
	site-build)
		node website/build.mjs
		;;
	site-deploy)
		# --skip-build: site-build already ran and its gates (brand check,
		# changelog regeneration) already passed for this tree.
		VEYYON_PAGES_PROJECT="$1" node website/deploy.mjs --skip-build
		;;
	*)
		printf 'release.sh: repo_tooling: unknown action %s\n' "$action" >&2
		return 2
		;;
	esac
}

# =============================================================================
# Constants
# =============================================================================

readonly REPO="santhreal/veyyon"
readonly RELEASE_BRANCH="main"
readonly REQUIRED_GH_LOGIN="santhsecurity"
# The shipped binary's version authority: what `veyyon --version` reports and
# what install.sh checks a staged download against.
readonly VERSION_AUTHORITY="packages/coding-agent/package.json"
readonly INSTALLER_SOURCE="scripts/install.sh"
readonly SITE_CHANGELOG_URL="https://veyyon.dev/changelog.html"
readonly INSTALL_ENDPOINT_URL="https://get.veyyon.dev"
readonly CLOUDFLARE_TOKEN_HOME="/credentials/.env (CF_PAGES_API_TOKEN)"

# install.sh covers linux (x64/arm64) and darwin (x64/arm64); a release missing
# one of these 404s for that platform. The Windows artifact is served by
# install.ps1 and is checked when the release set includes it.
readonly REQUIRED_BINARIES=(
	veyyon-linux-x64
	veyyon-linux-arm64
	veyyon-darwin-x64
	veyyon-darwin-arm64
)
readonly OPTIONAL_BINARIES=(veyyon-windows-x64.exe)
readonly PAGES_PROJECTS=(veyyon veyyon-get)

# Poll budgets. Overridable so the test suite can evaluate once with no sleeping.
POLL_SECONDS="${VEYYON_RELEASE_POLL_SECONDS:-20}"
TIMEOUT_TAG="${VEYYON_RELEASE_TIMEOUT_TAG:-900}"
TIMEOUT_PUBLISH="${VEYYON_RELEASE_TIMEOUT_PUBLISH:-3600}"
TIMEOUT_SITE="${VEYYON_RELEASE_TIMEOUT_SITE:-900}"

CURL_OPTS=(--retry 3 --retry-delay 1 --connect-timeout 10 --max-time 900)

# Created eagerly, in THIS shell. Every caller below reaches it from inside a
# `$( )`, and a subshell that created it would take the path away with it.
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/veyyon-release.XXXXXX")"
readonly WORKDIR
cleanup() { rm -rf -- "$WORKDIR"; }
trap cleanup EXIT

workdir() { printf '%s' "$WORKDIR"; }

# =============================================================================
# Output
# =============================================================================

say() { printf '%s\n' "$*"; }
note() { printf '      %s\n' "$*"; }
die() {
	printf '\nrelease.sh: %s\n' "$*" >&2
	exit 1
}

report_line() { # verdict, id, evidence
	printf '  %-4s  %-19s %s\n' "$1" "$2" "$3"
}

# =============================================================================
# Versions and tags
# =============================================================================

# `1.0.38` or `v1.0.38` -> `1.0.38`; anything else is refused.
normalize_version() {
	local v="${1#v}"
	[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a version: '$1' (want X.Y.Z or vX.Y.Z)"
	printf '%s' "$v"
}

# 0 when $1 > $2, else 1. Pure bash: `sort -V` is not portable enough to be the
# thing a release depends on.
version_gt() {
	local -a a b
	IFS=. read -r -a a <<<"$1"
	IFS=. read -r -a b <<<"$2"
	local i
	for i in 0 1 2; do
		if ((10#${a[i]:-0} > 10#${b[i]:-0})); then return 0; fi
		if ((10#${a[i]:-0} < 10#${b[i]:-0})); then return 1; fi
	done
	return 1
}

bump_version() { # current, major|minor|patch
	local -a p
	IFS=. read -r -a p <<<"$1"
	case "$2" in
	major) printf '%d.0.0' $((10#${p[0]} + 1)) ;;
	minor) printf '%d.%d.0' "$((10#${p[0]}))" $((10#${p[1]} + 1)) ;;
	patch) printf '%d.%d.%d' "$((10#${p[0]}))" "$((10#${p[1]}))" $((10#${p[2]} + 1)) ;;
	*) die "unknown bump '$2'" ;;
	esac
}

# The newest vX.Y.Z on origin, bare (no `v`). Empty when the remote has none.
newest_origin_version() {
	local out ref best="" candidate
	out="$(git ls-remote --tags origin 'refs/tags/v*' 2>/dev/null)" || return 0
	while IFS=$'\t' read -r _ ref; do
		[ -n "$ref" ] || continue
		case "$ref" in
		*'^{}') continue ;;
		esac
		candidate="${ref#refs/tags/v}"
		[[ "$candidate" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
		if [ -z "$best" ] || version_gt "$candidate" "$best"; then best="$candidate"; fi
	done <<<"$out"
	printf '%s' "$best"
}

# The commit a tag resolves to on origin, or non-zero when there is no such tag.
# An annotated tag reports both the tag object and a peeled `^{}` line; the
# peeled line is the commit and wins. release.ts pushes `<sha>:refs/tags/<tag>`,
# a lightweight tag, so usually only the plain line exists.
origin_tag_sha() {
	local tag="$1" out obj ref sha=""
	out="$(git ls-remote --tags origin "refs/tags/$tag" 2>/dev/null)" || return 1
	[ -n "$out" ] || return 1
	while IFS=$'\t' read -r obj ref; do
		case "$ref" in
		"refs/tags/$tag") [ -n "$sha" ] || sha="$obj" ;;
		"refs/tags/$tag^{}") sha="$obj" ;;
		esac
	done <<<"$out"
	[ -n "$sha" ] || return 1
	printf '%s' "$sha"
}

short_sha() { printf '%s' "${1:0:8}"; }

# =============================================================================
# Remote probes (gh / curl)
# =============================================================================

# `gh api` with its stderr captured, so "no such release" can be told apart from
# "the token expired". Reading a transport failure as "not released" is the
# silent-skip bug this whole script exists to remove.
#
# The error text lives in a FILE, not a variable: every caller invokes gh_api
# inside a `$( )` to capture stdout, and a variable set in that subshell is gone
# by the time the caller reads it. The file is written by the subshell and is
# still there afterwards.
gh_api() {
	local out rc=0
	out="$(gh api "$@" 2>"$WORKDIR/gh.err")" || rc=$?
	if [ "$rc" -ne 0 ]; then return "$rc"; fi
	printf '%s' "$out"
}

# The last gh error, or a stand-in when gh said nothing.
gh_err() {
	local text
	text="$(cat "$WORKDIR/gh.err" 2>/dev/null || true)"
	printf '%s' "${text:-gh api failed}"
}

gh_err_is_404() {
	case "$(gh_err)" in
	*"HTTP 404"* | *"Not Found"*) return 0 ;;
	esac
	return 1
}

# One line per asset: "<name>\t<browser_download_url>".
RELEASE_ASSETS_CACHE_TAG=""
RELEASE_ASSETS_CACHE=""
release_assets() {
	local tag="$1"
	if [ "$RELEASE_ASSETS_CACHE_TAG" = "$tag" ]; then
		printf '%s' "$RELEASE_ASSETS_CACHE"
		return 0
	fi
	local out
	out="$(gh_api "repos/$REPO/releases/tags/$tag" --jq '.assets[] | [.name, .browser_download_url] | @tsv')" || return 1
	RELEASE_ASSETS_CACHE_TAG="$tag"
	RELEASE_ASSETS_CACHE="$out"
	printf '%s' "$out"
}

curl_get() { # url, destination file
	curl -fsSL "${CURL_OPTS[@]}" -o "$2" -- "$1"
}

curl_body() { # url
	curl -fsSL "${CURL_OPTS[@]}" -- "$1"
}

# The URL curl ends up at, following redirects, headers only — exactly how
# install.sh resolves "latest" (it deliberately avoids the rate-limited API).
curl_effective_url() {
	curl -fsSIL "${CURL_OPTS[@]}" -o /dev/null -w '%{url_effective}' -- "$1"
}

# A file's content at any ref, including a commit reachable only from a tag.
remote_file_at_ref() { # ref, path
	curl_body "https://raw.githubusercontent.com/$REPO/$1/$2"
}

# The top-level "version" of a package.json body. Pure bash so this adds no
# dependency; the authority manifest is 2-space indented, and the top-level key
# is the first `"version":` in the file.
package_version_from() {
	local line
	while IFS= read -r line; do
		if [[ "$line" =~ ^[[:space:]]*\"version\"[[:space:]]*:[[:space:]]*\"([0-9][^\"]*)\" ]]; then
			printf '%s' "${BASH_REMATCH[1]}"
			return 0
		fi
	done <<<"$1"
	return 1
}

# The digest out of a `<64-hex>  <name>` sidecar, lowercased. Anything that is
# not exactly 64 hex characters is not a checksum (an HTML error page, a
# truncated body) and is refused rather than compared.
sidecar_digest() {
	local token
	read -r token _ <"$1" || return 1
	token="${token,,}"
	[[ "$token" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s' "$token"
}

file_digest() {
	local out
	out="$(sha256sum -- "$1")" || return 1
	printf '%s' "${out%% *}"
}

# =============================================================================
# THE DEFINITION OF `released`
# =============================================================================
# This list is the contract. `verify` evaluates all of it; `run` gates each
# stage on the slice named in STAGE_POSTCONDITIONS. Adding a postcondition here
# tightens both, at once, by construction.
#
# Each postcondition_<id> takes the bare version, sets REASON to the evidence
# (used verbatim in both the pass and fail report), and returns 0 or 1.

readonly POSTCONDITIONS=(
	tag_on_origin
	tag_ancestry
	bump_commit
	version_agreement
	release_published
	assets_present
	asset_checksums
	installer_latest
	install_endpoint
	changelog_page
)

describe_postcondition() {
	case "$1" in
	tag_on_origin) printf 'the tag exists on origin and resolves to a commit' ;;
	tag_ancestry) printf 'that commit is reachable from origin/%s (not an orphan)' "$RELEASE_BRANCH" ;;
	bump_commit) printf 'the tagged commit is the release bump commit, subject "chore: bump version to vX.Y.Z"' ;;
	version_agreement) printf 'the tagged tree and the release branch both carry X.Y.Z' ;;
	release_published) printf 'a non-draft, non-prerelease GitHub release exists for the tag' ;;
	assets_present) printf 'every expected platform binary is attached' ;;
	asset_checksums) printf 'every binary has a .sha256 that verifies against the downloaded bytes' ;;
	installer_latest) printf 'GitHub "latest" — what install.sh and the updater resolve — is this tag' ;;
	install_endpoint) printf 'get.veyyon.dev serves this release'"'"'s installer' ;;
	changelog_page) printf 'the published changelog page contains this version' ;;
	esac
}

REASON=""

postcondition_tag_on_origin() {
	local tag="v$1" sha
	if ! sha="$(origin_tag_sha "$tag")"; then
		REASON="no $tag on origin (git ls-remote --tags origin refs/tags/$tag matched nothing)"
		return 1
	fi
	REASON="$tag -> $(short_sha "$sha") on origin"
}

postcondition_tag_ancestry() {
	local tag="v$1" sha status ahead behind cmp
	if ! sha="$(origin_tag_sha "$tag")"; then
		REASON="no $tag on origin, so ancestry is undecidable"
		return 1
	fi
	# Asked of GitHub rather than `git merge-base --is-ancestor`: an orphan
	# commit may not be in this checkout at all, and local origin/main may be
	# stale. The API answers about origin, from any cwd, with nothing fetched.
	if ! cmp="$(gh_api "repos/$REPO/compare/$sha...$RELEASE_BRANCH" --jq '[.status, .ahead_by, .behind_by] | @tsv')"; then
		REASON="could not compare $(short_sha "$sha") with $RELEASE_BRANCH: $(gh_err)"
		return 1
	fi
	IFS=$'\t' read -r status ahead behind <<<"$cmp"
	case "$status" in
	identical | ahead)
		REASON="$(short_sha "$sha") is on origin/$RELEASE_BRANCH (compare: $status, branch ahead by ${ahead:-0})"
		return 0
		;;
	esac
	REASON="ORPHAN TAG — $tag points at $(short_sha "$sha"), which is NOT reachable from origin/$RELEASE_BRANCH"
	REASON="$REASON (compare status '$status', ahead ${ahead:-?} / behind ${behind:-?})."
	REASON="$REASON The bump commit never landed on the release branch, so anything built from this tag"
	REASON="$REASON was built from a tree that no branch has. This needs a different repair than a failed build:"
	REASON="$REASON run \`release.sh run\`, which reclaims an unreleased orphan tag and re-cuts it from $RELEASE_BRANCH."
	return 1
}

# Set by postcondition_bump_commit so the `run` stages can tell a defect that
# re-cutting fixes from one that it cannot: "" ok, notag, unreadable,
# legacy (the producer's missing `v`), wrong (some other commit entirely).
BUMP_DEVIATION=""

postcondition_bump_commit() {
	local tag="v$1" sha subject expected="chore: bump version to v$1"
	BUMP_DEVIATION=""
	if ! sha="$(origin_tag_sha "$tag")"; then
		BUMP_DEVIATION="notag"
		REASON="no $tag on origin, so there is no bump commit to check"
		return 1
	fi
	if ! subject="$(gh_api "repos/$REPO/commits/$sha" --jq '.commit.message | split("\n")[0]')"; then
		BUMP_DEVIATION="unreadable"
		REASON="could not read the subject of $(short_sha "$sha"): $(gh_err)"
		return 1
	fi
	if [ "$subject" = "$expected" ]; then
		REASON="$(short_sha "$sha") subject is exactly '$expected'"
		return 0
	fi
	# The one deviation worth naming precisely, because it is the producer's and
	# not the operator's: scripts/release.ts commits `chore: bump version to
	# ${version}` (no `v`), while AGENTS.md mandates the `v` form as the release
	# commit contract. Every tag in this repo carries the wrong spelling.
	if [ "$subject" = "chore: bump version to $1" ]; then
		BUMP_DEVIATION="legacy"
		REASON="release commit subject is '$subject' — the mandated form is '$expected'."
		REASON="$REASON The tag does point at the bump commit for $1, but the subject violates the documented"
		REASON="$REASON contract (AGENTS.md: 'must be exactly chore: bump version to vX.Y.Z')."
		REASON="$REASON Producer: scripts/release.ts, the \`git commit -m\` that spells \${version} without the v."
		REASON="$REASON Fix it there — \`chore: bump version to v\${version}\` — or every release keeps failing this."
		return 1
	fi
	BUMP_DEVIATION="wrong"
	REASON="$tag points at $(short_sha "$sha"), whose subject is '$subject' — not the bump commit for $1"
	return 1
}

postcondition_version_agreement() {
	local tag="v$1" sha at_tag at_branch body newest
	if ! sha="$(origin_tag_sha "$tag")"; then
		REASON="no $tag on origin, so there is no tagged tree to compare"
		return 1
	fi
	if ! body="$(remote_file_at_ref "$sha" "$VERSION_AUTHORITY")"; then
		REASON="could not read $VERSION_AUTHORITY at $(short_sha "$sha")"
		return 1
	fi
	if ! at_tag="$(package_version_from "$body")"; then
		REASON="no top-level version in $VERSION_AUTHORITY at $(short_sha "$sha")"
		return 1
	fi
	if [ "$at_tag" != "$1" ]; then
		REASON="$tag claims $1 but $VERSION_AUTHORITY at $(short_sha "$sha") says $at_tag"
		return 1
	fi
	if ! body="$(remote_file_at_ref "$RELEASE_BRANCH" "$VERSION_AUTHORITY")"; then
		REASON="could not read $VERSION_AUTHORITY on $RELEASE_BRANCH"
		return 1
	fi
	if ! at_branch="$(package_version_from "$body")"; then
		REASON="no top-level version in $VERSION_AUTHORITY on $RELEASE_BRANCH"
		return 1
	fi
	# For the newest tag the branch must carry exactly this version. For a
	# superseded tag the branch must have moved past it. Either way a tag that
	# claims a version the branch never adopted is a detectable contradiction.
	newest="$(newest_origin_version)"
	if [ "$newest" = "$1" ]; then
		if [ "$at_branch" != "$1" ]; then
			REASON="$tag is the newest tag and claims $1, but origin/$RELEASE_BRANCH still says $at_branch."
			REASON="$REASON The version bump never reached the branch."
			return 1
		fi
		REASON="$VERSION_AUTHORITY is $1 at the tag and on origin/$RELEASE_BRANCH"
		return 0
	fi
	if version_gt "$at_branch" "$1"; then
		REASON="$VERSION_AUTHORITY is $1 at the tag; origin/$RELEASE_BRANCH has moved on to $at_branch"
		return 0
	fi
	REASON="$tag claims $1 but origin/$RELEASE_BRANCH says $at_branch, which is not newer"
	return 1
}

postcondition_release_published() {
	local tag="v$1" flags draft prerelease
	if ! flags="$(gh_api "repos/$REPO/releases/tags/$tag" --jq '[.draft, .prerelease] | @tsv')"; then
		if gh_err_is_404; then
			if origin_tag_sha "$tag" >/dev/null 2>&1; then
				REASON="HALF-RELEASE — $tag is on origin but no GitHub release exists for it."
				REASON="$REASON install.sh and the auto-updater resolve versions from GitHub Releases, so every"
				REASON="$REASON user and every machine is still pinned to the previous release while this tag sits"
				REASON="$REASON on origin. This is a hard failure, not 'not released yet'."
			else
				REASON="no GitHub release for $tag (and no such tag on origin)"
			fi
			return 1
		fi
		REASON="could not read the release for $tag: $(gh_err) (status unknown, treated as failure)"
		return 1
	fi
	IFS=$'\t' read -r draft prerelease <<<"$flags"
	if [ "$draft" = "true" ]; then
		REASON="a release for $tag exists but is still a DRAFT — nothing resolves a draft, so it is unpublished"
		return 1
	fi
	if [ "$prerelease" = "true" ]; then
		REASON="the release for $tag is marked prerelease — GitHub 'latest' skips prereleases, so install.sh will not see it"
		return 1
	fi
	REASON="published release for $tag (draft=false, prerelease=false)"
}

# Names of the binaries this release is expected to carry: the four install.sh
# platforms always, plus the Windows artifact when the set includes it.
expected_binaries() {
	local assets="$1" name
	printf '%s\n' "${REQUIRED_BINARIES[@]}"
	for name in "${OPTIONAL_BINARIES[@]}"; do
		case $'\n'"$assets"$'\n' in
		*$'\n'"$name"$'\t'*) printf '%s\n' "$name" ;;
		esac
	done
}

asset_url() { # assets, name
	local n u
	while IFS=$'\t' read -r n u; do
		[ "$n" = "$2" ] || continue
		printf '%s' "$u"
		return 0
	done <<<"$1"
	return 1
}

postcondition_assets_present() {
	local tag="v$1" assets name missing="" found=0 windows="absent"
	if ! assets="$(release_assets "$tag")"; then
		REASON="no release assets to inspect for $tag ($(gh_err))"
		return 1
	fi
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		if asset_url "$assets" "$name" >/dev/null; then
			found=$((found + 1))
			case "$name" in *windows*) windows="present" ;; esac
			if ! asset_url "$assets" "$name.sha256" >/dev/null; then
				missing="$missing $name.sha256"
			fi
		else
			missing="$missing $name"
		fi
	done < <(expected_binaries "$assets")
	if [ -n "$missing" ]; then
		REASON="missing from the release:$missing (install.sh 404s for every platform whose asset or sidecar is absent)"
		return 1
	fi
	REASON="$found platform binaries + sidecars attached (windows artifact: $windows)"
}

postcondition_asset_checksums() {
	local tag="v$1" assets name url dir published actual checked=0
	if ! assets="$(release_assets "$tag")"; then
		REASON="no release assets to verify for $tag ($(gh_err))"
		return 1
	fi
	dir="$(workdir)/assets-$1"
	mkdir -p "$dir"
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		if ! url="$(asset_url "$assets" "$name")"; then
			REASON="$name is not attached, so its checksum cannot be verified"
			return 1
		fi
		if ! curl_get "$url" "$dir/$name"; then
			REASON="could not download $name from $url"
			return 1
		fi
		if ! url="$(asset_url "$assets" "$name.sha256")"; then
			REASON="$name has no .sha256 sidecar; install.sh fails closed without one"
			return 1
		fi
		if ! curl_get "$url" "$dir/$name.sha256"; then
			REASON="could not download $name.sha256 from $url"
			return 1
		fi
		if ! published="$(sidecar_digest "$dir/$name.sha256")"; then
			REASON="$name.sha256 does not hold a 64-hex digest — it is not a checksum"
			return 1
		fi
		actual="$(file_digest "$dir/$name")"
		if [ "$actual" != "$published" ]; then
			REASON="CHECKSUM MISMATCH on $name: the published sidecar says $published, the downloaded bytes hash to $actual."
			REASON="$REASON install.sh fails closed on this, so every user of this platform is refused the install."
			return 1
		fi
		checked=$((checked + 1))
	done < <(expected_binaries "$assets")
	REASON="$checked binaries downloaded and hashed; every .sha256 matches its own bytes"
}

postcondition_installer_latest() {
	local tag="v$1" url resolved
	if ! url="$(curl_effective_url "https://github.com/$REPO/releases/latest")"; then
		REASON="could not resolve https://github.com/$REPO/releases/latest (the redirect install.sh follows)"
		return 1
	fi
	case "$url" in
	*"/releases/tag/"*) resolved="${url##*/releases/tag/}" ;;
	*)
		REASON="'latest' redirected to $url, which is not a release tag page"
		return 1
		;;
	esac
	if [ "$resolved" != "$tag" ]; then
		REASON="'latest' resolves to $resolved, not $tag — install.sh and the auto-updater will keep serving $resolved"
		return 1
	fi
	REASON="github.com/$REPO/releases/latest -> $tag"
}

postcondition_install_endpoint() {
	local tag="v$1" dir served expected branch_copy newest
	dir="$(workdir)/endpoint-$1"
	mkdir -p "$dir"
	if ! curl_get "$INSTALL_ENDPOINT_URL" "$dir/served.sh"; then
		REASON="$INSTALL_ENDPOINT_URL did not serve anything (the curl | sh install path is down)"
		return 1
	fi
	if ! grep -q "REPO=\"$REPO\"" "$dir/served.sh" 2>/dev/null; then
		REASON="$INSTALL_ENDPOINT_URL served something that is not the veyyon installer"
		return 1
	fi
	if ! curl_get "https://raw.githubusercontent.com/$REPO/$tag/$INSTALLER_SOURCE" "$dir/tagged.sh"; then
		REASON="could not read $INSTALLER_SOURCE at $tag to compare against the endpoint"
		return 1
	fi
	served="$(file_digest "$dir/served.sh")"
	expected="$(file_digest "$dir/tagged.sh")"
	if [ "$served" = "$expected" ]; then
		REASON="$INSTALL_ENDPOINT_URL serves $INSTALLER_SOURCE from $tag (sha256 ${served:0:12})"
		return 0
	fi
	# The endpoint serves ONE installer: the current one. For the newest tag
	# that must be the tag's own copy — main and the tag are the same commit at
	# release time, so anything else means the deploy did not run. A superseded
	# tag is different: the endpoint has legitimately moved on, and what it must
	# prove is that it is live and current, i.e. serving origin/main's copy.
	# Same split as version_agreement, for the same reason.
	branch_copy=""
	if curl_get "https://raw.githubusercontent.com/$REPO/$RELEASE_BRANCH/$INSTALLER_SOURCE" "$dir/branch.sh"; then
		branch_copy="$(file_digest "$dir/branch.sh")"
	fi
	newest="$(newest_origin_version)"
	if [ "$newest" != "$1" ] && [ -n "$branch_copy" ] && [ "$served" = "$branch_copy" ]; then
		REASON="v$1 is superseded by v$newest; $INSTALL_ENDPOINT_URL serves origin/$RELEASE_BRANCH's installer"
		REASON="$REASON (sha256 ${served:0:12}), which is the current one it must serve"
		return 0
	fi
	REASON="$INSTALL_ENDPOINT_URL serves an installer that is not $tag's (endpoint ${served:0:12}, tag ${expected:0:12})."
	if [ -z "$branch_copy" ]; then
		REASON="$REASON origin/$RELEASE_BRANCH's copy could not be read for comparison."
	elif [ "$served" = "$branch_copy" ]; then
		REASON="$REASON It matches origin/$RELEASE_BRANCH's copy, so the deploy ran from the branch rather than the tag."
	else
		REASON="$REASON It matches neither the tag nor origin/$RELEASE_BRANCH, so the Pages deploy is stale."
	fi
	return 1
}

postcondition_changelog_page() {
	local body anchor="v${1//./-}"
	if ! body="$(curl_body "$SITE_CHANGELOG_URL")"; then
		REASON="could not fetch $SITE_CHANGELOG_URL"
		return 1
	fi
	if [[ "$body" == *"id=\"$anchor\""* ]]; then
		REASON="$SITE_CHANGELOG_URL carries the $1 section (anchor id=\"$anchor\")"
		return 0
	fi
	REASON="$SITE_CHANGELOG_URL has no section for $1 (no anchor id=\"$anchor\") — the site was never redeployed for this release"
	return 1
}

# =============================================================================
# Evaluating the definition
# =============================================================================
# Both `verify` and every stage of `run` come through here. FAILED_IDS carries
# the ids that failed so the summary can classify the shape of the failure.

FAILED_IDS=""

# evaluate <version> <report|quiet> [id...]   -> 0 when every id holds
evaluate() {
	local version="$1" mode="$2"
	shift 2
	local -a ids=("$@")
	[ "${#ids[@]}" -gt 0 ] || ids=("${POSTCONDITIONS[@]}")
	local id failures=0
	FAILED_IDS=""
	# The asset-list memo spans ONE evaluation pass and no further. `run` polls
	# this same function while CI is publishing, so a memo that outlived a pass
	# would pin the stage to the state it saw before the release completed.
	RELEASE_ASSETS_CACHE_TAG=""
	for id in "${ids[@]}"; do
		REASON=""
		if "postcondition_$id" "$version"; then
			[ "$mode" = quiet ] || report_line "PASS" "$id" "$REASON"
		else
			failures=$((failures + 1))
			FAILED_IDS="$FAILED_IDS $id"
			[ "$mode" = quiet ] || report_line "FAIL" "$id" "$REASON"
		fi
	done
	[ "$failures" -eq 0 ]
}

failed_contains() {
	case " $FAILED_IDS " in *" $1 "*) return 0 ;; esac
	return 1
}

# The single sentence a human reads first. An orphan tag and an unpublished tag
# are different defects with different repairs and must never print the same.
classify_state() {
	if [ -z "${FAILED_IDS// /}" ]; then
		printf 'COMPLETE'
		return 0
	fi
	if failed_contains tag_on_origin; then
		printf 'NOT CUT — the tag is not on origin'
		return 0
	fi
	if failed_contains tag_ancestry; then
		printf 'ORPHAN TAG — the tag is on origin but its commit is not on the release branch'
		return 0
	fi
	if failed_contains release_published; then
		printf 'HALF-RELEASE — the tag is on origin and nothing is published for it'
		return 0
	fi
	printf 'INCOMPLETE RELEASE — the tag is published but the release is not finished'
}

# =============================================================================
# Stages
# =============================================================================
# Each stage owns a slice of the ONE definition. A stage is skipped when its
# slice already holds, which is what makes `run` the repair path.

stage_postconditions() {
	case "$1" in
	tag) printf '%s\n' tag_on_origin tag_ancestry bump_commit version_agreement ;;
	publish) printf '%s\n' release_published assets_present asset_checksums installer_latest ;;
	site) printf '%s\n' install_endpoint changelog_page ;;
	esac
}

stage_holds() { # stage, version
	local -a ids
	mapfile -t ids < <(stage_postconditions "$1")
	evaluate "$2" quiet "${ids[@]}"
}

stage_report() { # stage, version
	local -a ids
	mapfile -t ids < <(stage_postconditions "$1")
	evaluate "$2" report "${ids[@]}" || true
}

LAST_STATUS=0
# Run a command for effect. Its exit status is recorded for the diagnostic and
# is NEVER the verdict: the verdict is the postcondition, evaluated afterwards.
attempt() {
	LAST_STATUS=0
	"$@" || LAST_STATUS=$?
	return 0
}

stage_fail() { # stage, version, reason
	printf '\n' >&2
	printf 'RELEASE FAILED at stage: %s\n' "$1" >&2
	printf '  version: v%s\n' "$2" >&2
	printf '  reason:  %s\n' "$3" >&2
	if [ "$LAST_STATUS" -ne 0 ]; then
		printf '  (the last command in this stage also exited %s)\n' "$LAST_STATUS" >&2
	fi
	printf '\n  unmet postconditions:\n' >&2
	stage_report "$1" "$2" >&2
	printf '\n  resume with (it skips everything already proven):\n' >&2
	printf '    cd %s && ./scripts/release.sh run\n\n' "$REPO_ROOT" >&2
	exit 1
}

# Poll a stage's postconditions until they hold or the budget runs out.
await_stage() { # stage, version, timeout
	local deadline=$((SECONDS + $3))
	while :; do
		if stage_holds "$1" "$2"; then return 0; fi
		if [ "$SECONDS" -ge "$deadline" ]; then return 1; fi
		[ "$POLL_SECONDS" -le 0 ] || sleep "$POLL_SECONDS"
	done
}

# --- preflight ---------------------------------------------------------------
# Everything that must be true before a single outward action. The Cloudflare
# token is checked here, before any GitHub call, because a release that cuts and
# publishes and then cannot deploy the site is precisely the half-state this
# script exists to eliminate.
stage_preflight() {
	local tool login status head origin_head
	for tool in git gh curl sha256sum; do
		command -v "$tool" >/dev/null 2>&1 || die "$tool is required and is not on PATH"
	done

	if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
		die "CLOUDFLARE_API_TOKEN is not set.

  Website deployment is part of a release, not an optional extra: both Pages
  projects (${PAGES_PROJECTS[0]} -> veyyon.dev, ${PAGES_PROJECTS[1]} -> get.veyyon.dev) are
  redeployed by the site stage, and a release that does not update the site is
  the same half-state as one that never published.

  The token lives in $CLOUDFLARE_TOKEN_HOME. Export it and run this again:

    export CLOUDFLARE_API_TOKEN=\"\$CF_PAGES_API_TOKEN\"

  Nothing has been cut, tagged, published or deployed."
	fi

	if ! login="$(gh_api user --jq '.login')"; then
		die "gh is not authenticated ($(gh_err)); run 'gh auth login' as $REQUIRED_GH_LOGIN"
	fi
	[ "$login" = "$REQUIRED_GH_LOGIN" ] ||
		die "the active gh account is '$login'; release operations must run as '$REQUIRED_GH_LOGIN' (gh auth switch)"

	status="$(git status --porcelain)"
	[ -z "$status" ] || die "the working tree is dirty; a release must be cut from a clean checkout:
$status"

	local branch
	branch="$(git rev-parse --abbrev-ref HEAD)"
	[ "$branch" = "$RELEASE_BRANCH" ] || die "on branch '$branch'; releases are cut from '$RELEASE_BRANCH'"

	git fetch --quiet origin "$RELEASE_BRANCH" 2>/dev/null || true
	head="$(git rev-parse HEAD)"
	origin_head="$(git ls-remote origin "refs/heads/$RELEASE_BRANCH" 2>/dev/null)"
	origin_head="${origin_head%%$'\t'*}"
	if [ -n "$origin_head" ] && [ "$head" != "$origin_head" ]; then
		die "local $RELEASE_BRANCH ($(short_sha "$head")) is not origin/$RELEASE_BRANCH ($(short_sha "$origin_head"));
  the site stage builds from this checkout, so it must be the commit being released"
	fi

	say "  PASS  preflight            tools, CLOUDFLARE_API_TOKEN, gh=$login, clean $RELEASE_BRANCH at $(short_sha "$head")"
}

# --- tag ---------------------------------------------------------------------
stage_tag() {
	local version="$1" tag="v$1" ancestry=0 agreement=0
	if stage_holds tag "$version"; then
		say "  SKIP  tag                 $tag is already cut correctly on origin"
		return 0
	fi

	if origin_tag_sha "$tag" >/dev/null 2>&1; then
		# The tag exists but the stage does not hold. Establish WHICH defect it
		# is before touching anything, because the only repair available for a
		# tag is to delete it and cut it again: git clients do not update an
		# existing tag on fetch, so re-pointing one would leave machines
		# permanently disagreeing about what this version is.
		postcondition_tag_ancestry "$version" || ancestry=$?
		postcondition_version_agreement "$version" || agreement=$?
		postcondition_bump_commit "$version" || true

		# A subject the PRODUCER gets wrong is not repaired by re-cutting: the
		# cutter would emit the same subject and this stage would fail again,
		# having deleted a perfectly good tag on the way. Destructive actions
		# are taken only where they demonstrably converge.
		if [ "$BUMP_DEVIATION" = "legacy" ]; then
			stage_fail tag "$version" \
				"$tag's commit subject is the legacy form without the 'v'. Re-cutting cannot fix this: scripts/release.ts would produce the same subject, so the tag would be deleted and the stage would fail again. Fix the producer first (scripts/release.ts: \`chore: bump version to v\${version}\`), then re-run. Nothing has been deleted."
		fi

		if [ "$ancestry" -eq 0 ] && [ "$agreement" -eq 0 ]; then
			stage_fail tag "$version" \
				"$tag is on origin, on $RELEASE_BRANCH and carries $version, yet the tag stage does not hold. Re-cutting would not change any of that, so this is not repaired automatically."
		fi

		# Reclaimable: the commit is not on the branch, or the tagged tree does
		# not carry this version. Cutting again from the branch fixes both — but
		# only when nothing can have consumed the tag.
		if gh_api "repos/$REPO/releases/tags/$tag" --jq '.id' >/dev/null 2>&1; then
			stage_fail tag "$version" \
				"$tag is broken (see below) but a GitHub release already exists for it. Deleting a tag with a published release breaks 'install.sh --ref $tag' for anyone who has it. This needs a human decision: either delete the release and its assets first and re-run, or cut the next version instead."
		fi
		say "  RUN   tag                 reclaiming $tag: on origin, nothing published for it, not usable as-is"
		attempt git push origin ":refs/tags/$tag"
		if origin_tag_sha "$tag" >/dev/null 2>&1; then
			stage_fail tag "$version" "the orphan tag $tag is still on origin after the delete push"
		fi
		say "        deleted $tag from origin; re-cutting $version from $RELEASE_BRANCH"
	fi

	say "  RUN   tag                 cutting v$version"
	attempt repo_tooling cut-release "$version"
	if ! await_stage tag "$version" "$TIMEOUT_TAG"; then
		stage_fail tag "$version" "the cutter ran, but the tag stage's postconditions still do not hold ${TIMEOUT_TAG}s later (see below for which)"
	fi
	say "  PASS  tag                 $tag is on origin, on $RELEASE_BRANCH, bumping to $version"
}

# --- publish -----------------------------------------------------------------
stage_publish() {
	local version="$1" tag="v$1"
	if stage_holds publish "$version"; then
		say "  SKIP  publish             $tag is published with verified assets"
		return 0
	fi
	say "  RUN   publish             dispatching ci.yml at $tag (binaries, GitHub release, sidecars)"
	attempt gh workflow run ci.yml --repo "$REPO" --ref "$tag"
	if ! await_stage publish "$version" "$TIMEOUT_PUBLISH"; then
		stage_fail publish "$version" "ci.yml was dispatched at $tag but the release was not complete within ${TIMEOUT_PUBLISH}s (check: gh run list --repo $REPO --branch $tag)"
	fi
	say "  PASS  publish             $tag published, every asset downloaded and its .sha256 verified"
}

# --- site --------------------------------------------------------------------
stage_site() {
	local version="$1" project
	if stage_holds site "$version"; then
		say "  SKIP  site                both Pages projects already serve this release"
		return 0
	fi
	say "  RUN   site                building the site and deploying ${PAGES_PROJECTS[*]}"
	attempt repo_tooling site-build
	for project in "${PAGES_PROJECTS[@]}"; do
		attempt repo_tooling site-deploy "$project"
	done
	if ! await_stage site "$version" "$TIMEOUT_SITE"; then
		stage_fail site "$version" "the deploys ran but the live endpoints do not serve this release within ${TIMEOUT_SITE}s"
	fi
	say "  PASS  site                veyyon.dev/changelog.html and get.veyyon.dev serve v$version"
}

# =============================================================================
# Modes
# =============================================================================

cmd_verify() {
	local version
	if [ "$#" -ge 1 ] && [ -n "$1" ]; then
		version="$(normalize_version "$1")"
	else
		version="$(newest_origin_version)"
		[ -n "$version" ] || die "no vX.Y.Z tags on origin, and no version was given"
	fi

	say ""
	say "release v$version  ($REPO)"
	say ""
	local ok=0
	evaluate "$version" report || ok=1
	say ""
	say "  STATE: $(classify_state)"
	if [ "$ok" -ne 0 ]; then
		say ""
		say "  repair with: cd $REPO_ROOT && ./scripts/release.sh run"
		say ""
		return 1
	fi
	say ""
	return 0
}

cmd_run() {
	local request="${1:-patch}" newest target repair=0
	case "$request" in
	major | minor | patch) ;;
	*) request="$(normalize_version "$request")" ;;
	esac

	say ""
	say "release run  ($REPO)"
	say ""
	stage_preflight

	newest="$(newest_origin_version)"
	if [ -n "$newest" ] && ! evaluate "$newest" quiet; then
		# The repair path. A broken newest release is repaired before any new
		# version is cut: cutting on top of a half-release buries it.
		repair=1
		target="$newest"
		say "  NOTE  repair              v$newest is on origin and incomplete ($(classify_state))"
		say "                            repairing it before anything new is cut"
		if [ "$request" != "patch" ] && [ "$request" != "$newest" ]; then
			say "                            the requested '$request' is deferred until v$newest is complete"
		fi
	else
		case "$request" in
		major | minor | patch) target="$(bump_version "${newest:-0.0.0}" "$request")" ;;
		*) target="$request" ;;
		esac
		if [ -n "$newest" ] && ! version_gt "$target" "$newest"; then
			die "requested v$target is not newer than the newest tag v$newest"
		fi
		say "  NOTE  target              cutting v$target (newest on origin: ${newest:-none})"
	fi

	say ""
	stage_tag "$target"
	stage_publish "$target"
	stage_site "$target"

	# Never conclude from stage bookkeeping. Re-evaluate the whole definition.
	say ""
	say "final verification of v$target:"
	say ""
	if ! evaluate "$target" report; then
		say ""
		say "  STATE: $(classify_state)"
		stage_fail final "$target" "every stage reported done, but the full definition of released does not hold"
	fi
	say ""
	say "  RELEASED v$target — every postcondition holds."
	if [ "$repair" -eq 1 ]; then
		say ""
		say "  v$target was a repair. To cut the next version now:"
		say "    cd $REPO_ROOT && ./scripts/release.sh run ${1:-patch}"
	fi
	say ""
}

cmd_postconditions() {
	local id
	say ""
	say "A release vX.Y.Z is complete only when all of these hold."
	say "verify evaluates this list; every stage of run is gated on a slice of it."
	say ""
	for id in "${POSTCONDITIONS[@]}"; do
		printf '  %-19s %s\n' "$id" "$(describe_postcondition "$id")"
	done
	say ""
	say "stages:"
	printf '  %-19s %s\n' "tag" "$(stage_postconditions tag | tr '\n' ' ')"
	printf '  %-19s %s\n' "publish" "$(stage_postconditions publish | tr '\n' ' ')"
	printf '  %-19s %s\n' "site" "$(stage_postconditions site | tr '\n' ' ')"
	say ""
}

usage() {
	cat <<EOF

release.sh — own a release end to end, and prove whether one is complete.

  release.sh verify [vX.Y.Z]
      Evaluate every postcondition and report each as PASS or FAIL with the
      evidence. Defaults to the newest tag on origin. Exits non-zero if any
      fails. A tag on origin with no complete release is a hard failure, and an
      orphan tag is reported as its own state, not as "not released yet".

  release.sh run [major|minor|patch|X.Y.Z]
      Drive the release. Each stage asserts its own postconditions after acting;
      a stage that cannot prove its effect exits non-zero naming the stage, the
      reason and the resume command. Re-running is the repair path: stages whose
      postconditions already hold are skipped. If the newest tag on origin is
      incomplete, it is repaired first.

  release.sh postconditions
      Print the definition of "released".

Website deployment (both Pages projects) is part of a release and is on by
default; CLOUDFLARE_API_TOKEN must be set before anything is cut.

EOF
}

main() {
	local mode="${1:-help}"
	shift || true
	case "$mode" in
	verify) cmd_verify "$@" ;;
	run) cmd_run "$@" ;;
	postconditions) cmd_postconditions ;;
	help | -h | --help) usage ;;
	*)
		usage >&2
		die "unknown mode '$mode'"
		;;
	esac
}

main "$@"
