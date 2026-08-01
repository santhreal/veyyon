#!/usr/bin/env bash
# Behavior tests for scripts/release.sh, run against a fixture world with
# `git`, `gh`, `curl`, `bun` and `node` stubbed on PATH. Nothing here reaches
# the network and nothing performs an outward action: the stubs record every
# invocation to $FIXTURE/actions.log, and several tests assert that log is free
# of pushes, dispatches and deploys.
#
#   Run: bash scripts/release-tests/release-sh.test.sh
#
# Bash-native rather than a `bun:test` file on purpose. release.sh exists to
# take a load-bearing path OFF Bun; testing it through bun:test would put the
# proof back on the runtime the script was written to avoid, and the test's
# central mechanism — shadowing `gh`/`git`/`curl` on PATH — is native to a shell
# and awkward from a JS runner. scripts/install-tests/functions.test.sh is the
# same pattern for the same reason, so this follows an existing convention
# rather than inventing a second one.
set -uo pipefail

ROOT="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASE_SH="$ROOT/scripts/release.sh"
STUBS="$ROOT/scripts/release-tests/stubs"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/release-sh-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

PASSED=0
FAILED=0

fail() {
	FAILED=$((FAILED + 1))
	printf 'FAIL: %s\n' "$1"
	shift
	while [ "$#" -gt 0 ]; do
		printf '      %s\n' "$1"
		shift
	done
}
pass() { PASSED=$((PASSED + 1)); }

check_status() { # desc, actual, expected
	if [ "$2" = "$3" ]; then pass; else fail "$1" "expected exit $3, got $2"; fi
}
check_contains() { # desc, haystack, needle
	case "$2" in
	*"$3"*) pass ;;
	*) fail "$1" "output does not contain: $3" "--- output ---" "$2" ;;
	esac
}
check_absent() { # desc, haystack, needle
	case "$2" in
	*"$3"*) fail "$1" "output unexpectedly contains: $3" "--- output ---" "$2" ;;
	*) pass ;;
	esac
}

# ---------------------------------------------------------------------------
# Fixture world
# ---------------------------------------------------------------------------
# A complete, healthy release of v1.0.40, from which each test breaks exactly
# one thing. A synthetic version keeps the fixtures independent of whatever the
# real repo's tags happen to be.

TAB=$'\t'
BINARIES=(veyyon-linux-x64 veyyon-linux-arm64 veyyon-darwin-x64 veyyon-darwin-arm64 veyyon-windows-x64.exe)

# world <name> -> exports FIXTURE pointing at a fresh, complete v1.0.40 world
world() {
	FIXTURE="$SANDBOX/$1"
	export FIXTURE
	mkdir -p "$FIXTURE/assets"
	: >"$FIXTURE/actions.log"
	: >"$FIXTURE/git-status"
	printf 'main\n' >"$FIXTURE/branch"
	printf 'santhsecurity\n' >"$FIXTURE/gh-login"
	printf 'v1.0.39 sha39aaaa\nv1.0.40 sha40bbbb\n' >"$FIXTURE/origin-tags"
	printf 'mainsha00\n' >"$FIXTURE/main-sha"
	printf 'chore: bump version to v1.0.40\n' >"$FIXTURE/commit-sha40bbbb"
	printf 'chore: bump version to v1.0.39\n' >"$FIXTURE/commit-sha39aaaa"
	printf 'ahead%s2%s0\n' "$TAB" "$TAB" >"$FIXTURE/compare-sha40bbbb"
	printf 'ahead%s9%s0\n' "$TAB" "$TAB" >"$FIXTURE/compare-sha39aaaa"
	printf '{\n  "name": "@veyyon/coding-agent",\n  "version": "1.0.40"\n}\n' >"$FIXTURE/raw-sha40bbbb-pkg"
	printf '{\n  "name": "@veyyon/coding-agent",\n  "version": "1.0.40"\n}\n' >"$FIXTURE/raw-main-pkg"
	printf 'https://github.com/santhreal/veyyon/releases/tag/v1.0.40' >"$FIXTURE/latest-url"
	printf '#!/bin/sh\nREPO="santhreal/veyyon"\n# installer for 1.0.40\n' >"$FIXTURE/endpoint-install"
	cp "$FIXTURE/endpoint-install" "$FIXTURE/raw-v1.0.40-install"
	cp "$FIXTURE/endpoint-install" "$FIXTURE/raw-main-install"
	printf '<h2 id="v1-0-40">1.0.40</h2>\n<h2 id="v1-0-39">1.0.39</h2>\n' >"$FIXTURE/changelog"
	write_release "$FIXTURE/release-v1.0.40" false false
}

# Attach every binary + a correct sidecar, and write the release document the
# gh stub answers from.
write_release() { # path, draft, prerelease
	local doc="$1" name digest
	printf 'flags %s%s%s\n' "$2" "$TAB" "$3" >"$doc"
	printf 'id 987654\n' >>"$doc"
	for name in "${BINARIES[@]}"; do
		printf 'binary bytes for %s of v1.0.40\n' "$name" >"$FIXTURE/assets/$name"
		digest="$(sha256sum "$FIXTURE/assets/$name")"
		printf '%s  %s\n' "${digest%% *}" "$name" >"$FIXTURE/assets/$name.sha256"
		printf 'asset %s%shttps://assets.test/%s\n' "$name" "$TAB" "$name" >>"$doc"
		printf 'asset %s.sha256%shttps://assets.test/%s.sha256\n' "$name" "$TAB" "$name" >>"$doc"
	done
}

# Run release.sh with the stubs in front of PATH and no real credentials.
run_release() { # args...
	OUT="$(
		PATH="$STUBS:$PATH" \
			FIXTURE="$FIXTURE" \
			CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN-fixture-token}" \
			VEYYON_RELEASE_POLL_SECONDS=0 \
			VEYYON_RELEASE_TIMEOUT_TAG=1 \
			VEYYON_RELEASE_TIMEOUT_PUBLISH=1 \
			VEYYON_RELEASE_TIMEOUT_SITE=1 \
			bash "$RELEASE_SH" "$@" 2>&1
	)"
	STATUS=$?
}

# ===========================================================================
# verify
# ===========================================================================

# --- the real v1.0.38 shape: tag on origin, orphan commit, nothing published --
world orphan
{
	printf 'v1.0.37 sha37cccc\nv1.0.38 7bf21d4e\n' >"$FIXTURE/origin-tags"
	printf 'chore: bump version to 1.0.38\n' >"$FIXTURE/commit-7bf21d4e"
	printf 'diverged%s8%s1\n' "$TAB" "$TAB" >"$FIXTURE/compare-7bf21d4e"
	printf '{\n  "version": "1.0.38"\n}\n' >"$FIXTURE/raw-7bf21d4e-pkg"
	printf '{\n  "version": "1.0.37"\n}\n' >"$FIXTURE/raw-main-pkg"
	printf 'https://github.com/santhreal/veyyon/releases/tag/v1.0.37' >"$FIXTURE/latest-url"
	rm -f "$FIXTURE/release-v1.0.40"
}
run_release verify
check_status "verify fails on the v1.0.38 shape" "$STATUS" "1"
check_contains "orphan tag is named as such" "$OUT" "ORPHAN TAG"
check_contains "orphan evidence names the branch" "$OUT" "NOT reachable from origin/main"
check_contains "state line distinguishes orphan from unpublished" "$OUT" \
	"STATE: ORPHAN TAG — the tag is on origin but its commit is not on the release branch"
check_contains "the missing release is a hard failure, not 'not released yet'" "$OUT" "HALF-RELEASE"
check_contains "the version contradiction is reported" "$OUT" "origin/main still says 1.0.37"
check_contains "the wrong commit subject names its producer" "$OUT" "Producer: scripts/release.ts"
check_contains "latest still resolves the previous release" "$OUT" "'latest' resolves to v1.0.37, not v1.0.38"

# --- a tag that is on main but was never published: HALF-RELEASE, not orphan --
world halfrelease
{
	rm -f "$FIXTURE/release-v1.0.40"
	printf 'https://github.com/santhreal/veyyon/releases/tag/v1.0.39' >"$FIXTURE/latest-url"
}
run_release verify v1.0.40
check_status "verify fails when the tag is healthy but nothing is published" "$STATUS" "1"
check_contains "half-release state" "$OUT" "STATE: HALF-RELEASE"
check_absent "a healthy tag is not called an orphan" "$OUT" "ORPHAN TAG"
check_contains "half-release explains the user impact" "$OUT" "pinned to the previous release"
check_contains "ancestry passes for a tag on main" "$OUT" "PASS  tag_ancestry"

# --- an asset is missing from an otherwise published release -----------------
world missingasset
{
	grep -v 'veyyon-darwin-arm64' "$FIXTURE/release-v1.0.40" >"$FIXTURE/tmp"
	mv "$FIXTURE/tmp" "$FIXTURE/release-v1.0.40"
}
run_release verify v1.0.40
check_status "verify fails when a platform binary is missing" "$STATUS" "1"
check_contains "the missing asset is named" "$OUT" "missing from the release: veyyon-darwin-arm64"
check_contains "the consequence is stated" "$OUT" "install.sh 404s"
check_contains "the release itself is still reported published" "$OUT" "PASS  release_published"

# --- a .sha256 that does not match its asset's bytes -------------------------
# The check a naive implementation fakes by trusting the sidecar's presence.
world badchecksum
{
	printf '%s  veyyon-linux-arm64\n' \
		"0000000000000000000000000000000000000000000000000000000000000000" \
		>"$FIXTURE/assets/veyyon-linux-arm64.sha256"
}
run_release verify v1.0.40
check_status "verify fails on a sidecar that does not match its bytes" "$STATUS" "1"
check_contains "the mismatch is named" "$OUT" "CHECKSUM MISMATCH on veyyon-linux-arm64"
check_contains "the published digest is shown" "$OUT" "0000000000000000000000000000000000000000000000000000000000000000"
check_contains "the mismatch explains the user impact" "$OUT" "install.sh fails closed"
check_contains "presence alone still passes, so the digest is what failed" "$OUT" "PASS  assets_present"

# --- a sidecar whose body is not a digest at all -----------------------------
world htmlsidecar
{
	printf '<!doctype html><title>429</title>\n' >"$FIXTURE/assets/veyyon-linux-x64.sha256"
}
run_release verify v1.0.40
check_status "verify fails on a sidecar that is not a checksum" "$STATUS" "1"
check_contains "a non-digest sidecar is refused, not compared" "$OUT" "does not hold a 64-hex digest"

# --- a draft release is not a release ----------------------------------------
world draft
{
	write_release "$FIXTURE/release-v1.0.40" true false
}
run_release verify v1.0.40
check_status "verify fails on a draft release" "$STATUS" "1"
check_contains "draft is named" "$OUT" "still a DRAFT"

# --- latest resolves an older tag --------------------------------------------
world staleLatest
{
	printf 'https://github.com/santhreal/veyyon/releases/tag/v1.0.39' >"$FIXTURE/latest-url"
}
run_release verify v1.0.40
check_status "verify fails when 'latest' has not moved" "$STATUS" "1"
check_contains "the resolved tag is named" "$OUT" "'latest' resolves to v1.0.39, not v1.0.40"

# --- the site was never redeployed -------------------------------------------
world stalesite
{
	printf '<h2 id="v1-0-39">1.0.39</h2>\n' >"$FIXTURE/changelog"
	printf '#!/bin/sh\nREPO="santhreal/veyyon"\n# installer for 1.0.39\n' >"$FIXTURE/endpoint-install"
}
run_release verify v1.0.40
check_status "verify fails when the site is stale" "$STATUS" "1"
check_contains "the changelog page gap is named" "$OUT" "has no section for 1.0.40"
check_contains "the install endpoint gap is named" "$OUT" "serves an installer that is not v1.0.40's"
check_contains "the stale endpoint is diagnosed against the branch copy" "$OUT" "It matches neither the tag nor origin/main"

# --- a superseded tag: the endpoint has legitimately moved on -----------------
# get.veyyon.dev serves ONE installer, the current one. Once v1.0.41 exists,
# v1.0.40's postcondition is that the endpoint is live and serving origin/main's
# copy — not that it still serves v1.0.40's. Without this the check could never
# pass for any release but the newest, which is how a real verify of v1.0.37
# reported a failure that was not one.
world superseded
{
	printf 'v1.0.39 sha39aaaa\nv1.0.40 sha40bbbb\nv1.0.41 sha41cccc\n' >"$FIXTURE/origin-tags"
	printf 'chore: bump version to v1.0.41\n' >"$FIXTURE/commit-sha41cccc"
	printf 'ahead%s0%s0\n' "$TAB" "$TAB" >"$FIXTURE/compare-sha41cccc"
	printf '{\n  "version": "1.0.41"\n}\n' >"$FIXTURE/raw-main-pkg"
	printf '#!/bin/sh\nREPO="santhreal/veyyon"\n# installer for 1.0.41\n' >"$FIXTURE/raw-main-install"
	cp "$FIXTURE/raw-main-install" "$FIXTURE/endpoint-install"
	printf 'https://github.com/santhreal/veyyon/releases/tag/v1.0.41' >"$FIXTURE/latest-url"
}
run_release verify v1.0.40
check_contains "a superseded tag's endpoint check passes on the branch copy" "$OUT" "PASS  install_endpoint"
check_contains "and says why" "$OUT" "v1.0.40 is superseded by v1.0.41"
check_contains "the branch having moved on is not a version contradiction" "$OUT" "PASS  version_agreement"
check_contains "but 'latest' having moved on IS reported for this tag" "$OUT" "'latest' resolves to v1.0.41, not v1.0.40"

# --- a superseded tag whose endpoint matches nothing still fails --------------
world superseded_dead
{
	printf 'v1.0.39 sha39aaaa\nv1.0.40 sha40bbbb\nv1.0.41 sha41cccc\n' >"$FIXTURE/origin-tags"
	printf 'chore: bump version to v1.0.41\n' >"$FIXTURE/commit-sha41cccc"
	printf 'ahead%s0%s0\n' "$TAB" "$TAB" >"$FIXTURE/compare-sha41cccc"
	printf '{\n  "version": "1.0.41"\n}\n' >"$FIXTURE/raw-main-pkg"
	printf '#!/bin/sh\nREPO="santhreal/veyyon"\n# installer for 1.0.41\n' >"$FIXTURE/raw-main-install"
	printf '#!/bin/sh\nREPO="santhreal/veyyon"\n# ancient installer\n' >"$FIXTURE/endpoint-install"
}
run_release verify v1.0.40
check_status "a stale endpoint is still a failure for a superseded tag" "$STATUS" "1"
check_contains "the stale endpoint is diagnosed" "$OUT" "It matches neither the tag nor origin/main"

# --- everything holds ---------------------------------------------------------
world complete
run_release verify v1.0.40
check_status "verify passes only when every postcondition holds" "$STATUS" "0"
check_contains "complete state" "$OUT" "STATE: COMPLETE"
check_absent "no postcondition failed" "$OUT" "FAIL"
check_contains "the checksums were actually verified against downloaded bytes" "$OUT" \
	"5 binaries downloaded and hashed"

# --- the Windows artifact is conditional, the four POSIX ones are not ---------
world nowindows
{
	grep -v 'veyyon-windows-x64.exe' "$FIXTURE/release-v1.0.40" >"$FIXTURE/tmp"
	mv "$FIXTURE/tmp" "$FIXTURE/release-v1.0.40"
}
run_release verify v1.0.40
check_status "a release set without the Windows artifact still verifies" "$STATUS" "0"
check_contains "its absence is reported, not hidden" "$OUT" "windows artifact: absent"

# --- defaulting to the newest tag ---------------------------------------------
world newest
run_release verify
check_status "verify with no argument checks the newest tag on origin" "$STATUS" "0"
check_contains "the newest tag was chosen" "$OUT" "release v1.0.40"

# ===========================================================================
# run
# ===========================================================================

# --- a missing CLOUDFLARE_API_TOKEN stops everything before anything happens --
world notoken
(
	unset CLOUDFLARE_API_TOKEN
	CLOUDFLARE_API_TOKEN="" run_release run patch
	printf '%s' "$STATUS" >"$FIXTURE/status"
	printf '%s' "$OUT" >"$FIXTURE/out"
)
STATUS="$(cat "$FIXTURE/status")"
OUT="$(cat "$FIXTURE/out")"
check_status "run refuses without CLOUDFLARE_API_TOKEN" "$STATUS" "1"
check_contains "the variable is named" "$OUT" "CLOUDFLARE_API_TOKEN is not set"
check_contains "where the token lives is named" "$OUT" "/credentials/.env"
check_contains "both Pages projects are named" "$OUT" "get.veyyon.dev"
check_contains "it says nothing happened" "$OUT" "Nothing has been cut, tagged, published or deployed"
ACTIONS="$(cat "$FIXTURE/actions.log")"
check_absent "no workflow was dispatched" "$ACTIONS" "workflow run"
check_absent "nothing was pushed" "$ACTIONS" "git push"
check_absent "the cutter never ran" "$ACTIONS" "bun run release"
check_absent "nothing was deployed" "$ACTIONS" "deploy.mjs"
check_absent "not even a GitHub read happened first" "$ACTIONS" "gh api"

# --- resume: interrupted after tagging, re-run skips the tag stage ------------
# The half-release shape: v1.0.40's tag is cut and healthy, nothing published,
# site stale. Re-running `run` must skip `tag` and resume at `publish`.
world resume
{
	rm -f "$FIXTURE/release-v1.0.40"
	printf 'https://github.com/santhreal/veyyon/releases/tag/v1.0.39' >"$FIXTURE/latest-url"
	printf '<h2 id="v1-0-39">1.0.39</h2>\n' >"$FIXTURE/changelog"
	printf '#!/bin/sh\nREPO="santhreal/veyyon"\n# installer for 1.0.39\n' >"$FIXTURE/endpoint-install"
	# What CI produces once ci.yml is dispatched at the tag: the published
	# release, and GitHub's "latest" moving onto it.
	write_release "$FIXTURE/release-v1.0.40.after" false false
	cat >"$FIXTURE/publish-effect" <<'EOF'
printf 'https://github.com/santhreal/veyyon/releases/tag/v1.0.40' > "$FIXTURE/latest-url"
EOF
	# What the Pages deploys produce.
	cat >"$FIXTURE/site-deploy-effect" <<'EOF'
printf '<h2 id="v1-0-40">1.0.40</h2>\n' > "$FIXTURE/changelog"
cp "$FIXTURE/raw-v1.0.40-install" "$FIXTURE/endpoint-install"
EOF
}
run_release run patch
check_status "a resumed run completes" "$STATUS" "0"
check_contains "it recognises the incomplete newest tag" "$OUT" "repairing it before anything new is cut"
check_contains "the already-cut tag stage is skipped" "$OUT" "SKIP  tag"
check_contains "it resumes at publish" "$OUT" "RUN   publish"
check_contains "the site stage runs too" "$OUT" "RUN   site"
check_contains "success is only claimed after re-evaluating the whole definition" "$OUT" "RELEASED v1.0.40"
check_contains "it says what to do next" "$OUT" "To cut the next version now"
ACTIONS="$(cat "$FIXTURE/actions.log")"
check_absent "a resumed run never re-cuts the tag" "$ACTIONS" "bun run release"
check_absent "a resumed run never deletes the tag" "$ACTIONS" "git push origin :refs/tags"
check_contains "it did dispatch the publish pipeline" "$ACTIONS" "workflow run ci.yml"
check_contains "it did deploy the main Pages project" "$ACTIONS" "node website/deploy.mjs"

# --- idempotence: a stage whose postconditions hold performs no action --------
# Tag and publish are complete; only the site is stale. `run` must act on the
# site alone.
world idempotent
{
	printf '<h2 id="v1-0-39">1.0.39</h2>\n' >"$FIXTURE/changelog"
	printf '#!/bin/sh\nREPO="santhreal/veyyon"\n# installer for 1.0.39\n' >"$FIXTURE/endpoint-install"
	cat >"$FIXTURE/site-deploy-effect" <<'EOF'
printf '<h2 id="v1-0-40">1.0.40</h2>\n' > "$FIXTURE/changelog"
cp "$FIXTURE/raw-v1.0.40-install" "$FIXTURE/endpoint-install"
EOF
}
run_release run patch
check_status "run completes when only the site was missing" "$STATUS" "0"
check_contains "the tag stage is skipped" "$OUT" "SKIP  tag"
check_contains "the publish stage is skipped" "$OUT" "SKIP  publish"
check_contains "only the site stage acts" "$OUT" "RUN   site"
ACTIONS="$(cat "$FIXTURE/actions.log")"
check_absent "no workflow dispatch for an already-published release" "$ACTIONS" "workflow run"
check_absent "no re-cut for an already-correct tag" "$ACTIONS" "bun run release"

# --- a stage that cannot prove its effect fails, naming stage and resume ------
world unprovable
{
	# Nothing published, and the dispatch produces nothing: CI failed.
	rm -f "$FIXTURE/release-v1.0.40"
	printf 'https://github.com/santhreal/veyyon/releases/tag/v1.0.39' >"$FIXTURE/latest-url"
}
run_release run patch
check_status "a stage that cannot prove its effect fails the run" "$STATUS" "1"
check_contains "the failing stage is named" "$OUT" "RELEASE FAILED at stage: publish"
check_contains "the reason is specific" "$OUT" "ci.yml was dispatched at v1.0.40"
check_contains "the unmet postconditions are shown" "$OUT" "FAIL  release_published"
check_contains "the resume command is exact" "$OUT" "./scripts/release.sh run"
ACTIONS="$(cat "$FIXTURE/actions.log")"
check_absent "a failed publish never proceeds to deploy the site" "$ACTIONS" "deploy.mjs"

# --- an orphan tag, driven all the way back to a complete release -------------
# Tag on origin whose commit is not on the branch, nothing published, branch one
# version behind, site stale. The subject is the mandated v-form, so re-cutting
# converges and the reclaim is allowed to run.
world reclaim
{
	printf 'v1.0.39 sha39aaaa\nv1.0.40 orphan40\n' >"$FIXTURE/origin-tags"
	printf 'chore: bump version to v1.0.40\n' >"$FIXTURE/commit-orphan40"
	printf 'diverged%s4%s1\n' "$TAB" "$TAB" >"$FIXTURE/compare-orphan40"
	printf '{\n  "version": "1.0.40"\n}\n' >"$FIXTURE/raw-orphan40-pkg"
	printf '{\n  "version": "1.0.39"\n}\n' >"$FIXTURE/raw-main-pkg"
	rm -f "$FIXTURE/release-v1.0.40"
	printf 'https://github.com/santhreal/veyyon/releases/tag/v1.0.39' >"$FIXTURE/latest-url"
	printf '<h2 id="v1-0-39">1.0.39</h2>\n' >"$FIXTURE/changelog"
	printf '#!/bin/sh\nREPO="santhreal/veyyon"\n# installer for 1.0.39\n' >"$FIXTURE/endpoint-install"
	# `bun run release 1.0.40` lands the bump on main and re-tags it there.
	cat >"$FIXTURE/cut-effect" <<'EOF'
printf 'v1.0.39 sha39aaaa\nv1.0.40 sha40bbbb\n' > "$FIXTURE/origin-tags"
printf 'chore: bump version to v1.0.40\n' > "$FIXTURE/commit-sha40bbbb"
printf 'ahead\t0\t0\n' > "$FIXTURE/compare-sha40bbbb"
printf '{\n  "version": "1.0.40"\n}\n' > "$FIXTURE/raw-sha40bbbb-pkg"
printf '{\n  "version": "1.0.40"\n}\n' > "$FIXTURE/raw-main-pkg"
EOF
	write_release "$FIXTURE/release-v1.0.40.after" false false
	cat >"$FIXTURE/publish-effect" <<'EOF'
printf 'https://github.com/santhreal/veyyon/releases/tag/v1.0.40' > "$FIXTURE/latest-url"
EOF
	cat >"$FIXTURE/site-deploy-effect" <<'EOF'
printf '<h2 id="v1-0-40">1.0.40</h2>\n' > "$FIXTURE/changelog"
cp "$FIXTURE/raw-v1.0.40-install" "$FIXTURE/endpoint-install"
EOF
}
run_release run patch
check_status "the orphan-tag shape is repaired end to end" "$STATUS" "0"
check_contains "the orphan tag is reclaimed, not re-pointed" "$OUT" "RUN   tag                 reclaiming v1.0.40"
check_contains "the reclaim states why it is safe" "$OUT" "nothing published for it"
check_contains "it re-cuts from the branch" "$OUT" "re-cutting 1.0.40 from main"
check_contains "the repaired release is proven, not assumed" "$OUT" "RELEASED v1.0.40"
ACTIONS="$(cat "$FIXTURE/actions.log")"
check_contains "the tag was deleted from origin" "$ACTIONS" "git push origin :refs/tags/v1.0.40"
check_contains "the existing cutter was reused" "$ACTIONS" "bun run release 1.0.40"
check_contains "both Pages projects were deployed" "$ACTIONS" "VEYYON_PAGES_PROJECT=veyyon-get"

# --- an orphan tag WITH a published release is never deleted automatically ----
world reclaim_refuses
{
	printf 'v1.0.39 sha39aaaa\nv1.0.40 orphan40\n' >"$FIXTURE/origin-tags"
	printf 'chore: bump version to v1.0.40\n' >"$FIXTURE/commit-orphan40"
	printf 'diverged%s4%s1\n' "$TAB" "$TAB" >"$FIXTURE/compare-orphan40"
	printf '{\n  "version": "1.0.40"\n}\n' >"$FIXTURE/raw-orphan40-pkg"
	printf '{\n  "version": "1.0.39"\n}\n' >"$FIXTURE/raw-main-pkg"
}
run_release run patch
check_status "run refuses to delete a tag that has a published release" "$STATUS" "1"
check_contains "the refusal names the hazard" "$OUT" "install.sh --ref v1.0.40"
check_contains "the refusal asks for a human decision" "$OUT" "This needs a human decision"
ACTIONS="$(cat "$FIXTURE/actions.log")"
check_absent "the tag was not deleted" "$ACTIONS" "git push origin :refs/tags"

# --- a defect re-cutting cannot fix must not destroy the tag ------------------
# The producer (scripts/release.ts) writes the subject without the `v`. Deleting
# the tag and cutting again would reproduce exactly the same subject, so the
# reclaim would be a destructive no-op. It must refuse, and must not delete.
world nonconvergent
{
	printf 'v1.0.39 sha39aaaa\nv1.0.40 orphan40\n' >"$FIXTURE/origin-tags"
	printf 'chore: bump version to 1.0.40\n' >"$FIXTURE/commit-orphan40"
	printf 'diverged%s4%s1\n' "$TAB" "$TAB" >"$FIXTURE/compare-orphan40"
	printf '{\n  "version": "1.0.40"\n}\n' >"$FIXTURE/raw-orphan40-pkg"
	printf '{\n  "version": "1.0.39"\n}\n' >"$FIXTURE/raw-main-pkg"
	rm -f "$FIXTURE/release-v1.0.40"
}
run_release run patch
check_status "run refuses a repair that cannot converge" "$STATUS" "1"
check_contains "it names the non-convergence" "$OUT" "Re-cutting cannot fix this"
check_contains "it names the producer to fix" "$OUT" "scripts/release.ts"
check_contains "it states that nothing was destroyed" "$OUT" "Nothing has been deleted"
ACTIONS="$(cat "$FIXTURE/actions.log")"
check_absent "the tag survives a non-convergent repair" "$ACTIONS" "git push origin :refs/tags"
check_absent "and the cutter was never invoked" "$ACTIONS" "bun run release"

# --- the same guard on a healthy tag whose only defect is the subject ---------
# The v1.0.37 / v1.0.38 shape: tag on main, right tree, wrong subject. Nothing
# about that is repaired by deleting anything.
world subject_only
{
	printf 'chore: bump version to 1.0.40\n' >"$FIXTURE/commit-sha40bbbb"
	rm -f "$FIXTURE/release-v1.0.40"
}
run_release run patch
check_status "a subject-only defect fails the run" "$STATUS" "1"
check_contains "the tag stage is what fails" "$OUT" "RELEASE FAILED at stage: tag"
ACTIONS="$(cat "$FIXTURE/actions.log")"
check_absent "a sound tag is never deleted over a subject" "$ACTIONS" "git push origin :refs/tags"
check_absent "and publish is never attempted on top of it" "$ACTIONS" "workflow run"

# ===========================================================================
printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
