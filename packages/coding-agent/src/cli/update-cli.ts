/**
 * Update CLI command handler.
 *
 * Handles `veyyon update` to check for and install updates.
 * Uses the installer that owns the active veyyon executable when it can be detected.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseSha256Sidecar } from "@veyyon/natives/sha256-sidecar";
import {
	$which,
	APP_ALIAS,
	APP_NAME,
	bareVersion,
	changelogUrlForVersion,
	compareSemver,
	errorMessage,
	getAutoUpdateStatePath,
	getUpdateHistoryPath,
	isEnoent,
	isNewerVersion,
	isValidSemver,
	logger,
	readPipeText,
	removeTempPath,
	tryWithFileLock,
	VERSION,
} from "@veyyon/utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";
import {
	AUTO_UPDATE_FAILURE_COOLDOWN_MS,
	AUTO_UPDATE_LOCK_STALE_MS,
	clearAutoUpdateFailure,
	readAutoUpdateState,
	recordAutoUpdateFailure,
	shouldAttemptAutoUpdate,
} from "./auto-update-state";
import {
	type CompletionGenerator,
	type CompletionRefreshResult,
	type CompletionTarget,
	completionEnvFrom,
	powershellCompletionPath,
	refreshInstalledCompletions,
} from "./completion-refresh";

const REPO = "santhreal/veyyon";
/**
 * GitHub REST base for {@link REPO}. Veyyon ships only through GitHub Releases
 * (see the Distribution section in the root `AGENTS.md`): the `curl` installer
 * and this self-updater both resolve versions here, never from a package
 * registry, so the running binary and a fresh install always agree on what
 * "latest" means. `releases/latest` already excludes drafts and prereleases, so
 * an unpublished draft never triggers an update.
 */
const GITHUB_RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
/**
 * The web endpoint that redirects to the newest published release's tag page.
 *
 * Not part of the `api.github.com` rate budget, which is why the startup check
 * resolves here instead. See {@link getLatestRelease}.
 */
const GITHUB_LATEST_RELEASE_URL = `https://github.com/${REPO}/releases/latest`;
/**
 * GitHub requires a User-Agent and rejects requests without one, on the API and
 * on `github.com` alike. Identify the updater so the traffic is attributable —
 * both requests in this file send it, which is why it is not named for the API.
 */
const GITHUB_USER_AGENT = `${APP_NAME}-updater`;
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/**
 * The `.sha256` sidecar is a few dozen bytes, so it should arrive fast; a slow
 * fetch here is a signal something is wrong, not patience worth spending. Matches
 * install.sh's `--max-time 30` on the same sidecar request.
 */
const CHECKSUM_TIMEOUT_MS = 30_000;

/**
 * The in-checkout launcher a source install links onto PATH.
 *
 * `install.sh --source` clones the repo under `~/.veyyon/src` and symlinks
 * `~/.local/bin/veyyon` at `<checkout>/packages/coding-agent/scripts/veyyon`.
 * That launcher runs veyyon straight from TypeScript, so a source install
 * updates by advancing the checkout ({@link updateViaSourceAt}), never by
 * swapping in a downloaded release binary. The resolved (realpath) veyyon path
 * ending in this suffix is how we tell the two apart; see
 * {@link resolveUpdateMethod}.
 */
const SOURCE_LAUNCHER_TAIL = ["packages", "coding-agent", "scripts", APP_NAME].join("/");

export interface ReleaseInfo {
	tag: string;
	version: string;
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
	/**
	 * Why the check failed, when the reason is not "wrong version". Reported in
	 * place of the version wording, which would be misleading for a binary that
	 * IS the right version and still cannot run.
	 */
	reason?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	/**
	 * Proves the swapped-in file really is `expectedVersion`. Production passes a
	 * verifier bound to `targetPath`; it must never re-resolve the command name
	 * through PATH, which asks a different question than "is the file I just
	 * wrote correct?" (see {@link verifyBinaryVersion}).
	 */
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

/**
 * The canonical path behind `p`, or undefined when there is nothing there to canonicalize.
 *
 * Undefined is the ordinary answer: this asks about paths that may not exist yet, which is the whole
 * point of an installer probing where a binary would go. The callers compare paths for identity, and
 * comparing against undefined answers "not the same file", which is the conservative direction for an
 * update that must not overwrite a target it cannot identify.
 */
function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

/**
 * How the veyyon on PATH was installed, which decides how it updates.
 *
 * `binary` is the `curl | sh` standalone binary: update by downloading the new
 * release binary and swapping it in place. `source` is `install.sh --source`,
 * whose PATH entry is a symlink to the in-checkout launcher: it updates by
 * advancing the checkout (fetch, ff-only merge, reinstall, regen — see
 * {@link updateViaSourceAt}), never by a binary swap that would overwrite the
 * launcher. Veyyon ships GitHub-only, so there is no package-manager
 * (bun/npm/Homebrew/mise) install path to detect.
 */
export type UpdateMethod = "binary" | "source";

type UpdateTarget = { method: "binary"; path: string } | { method: "source"; path: string };

/**
 * Classify an on-PATH veyyon path as a binary or source install.
 *
 * A source install links PATH's veyyon to `<checkout>/<SOURCE_LAUNCHER_TAIL>`,
 * so following the symlink (realpath) and matching that suffix is what tells the
 * two apart. Everything else is a standalone binary the updater can swap.
 * Exported for direct unit testing without a real install on disk.
 */
/**
 * Does this path end at the in-checkout launcher, on either platform?
 *
 * Separators are normalized because the Windows shim stores a `\`-separated
 * target while the tail is written `/`-separated, and `.cmd` is accepted because
 * the Windows launcher is `scripts\veyyon.cmd` while POSIX is `scripts/veyyon`.
 */
function endsWithSourceLauncher(p: string): boolean {
	const normalized = p.replace(/\\/g, "/");
	return normalized.endsWith(SOURCE_LAUNCHER_TAIL) || normalized.endsWith(`${SOURCE_LAUNCHER_TAIL}.cmd`);
}

/**
 * How much of a candidate shim we are willing to read.
 *
 * A shim is two or three lines. The path on PATH may instead be the standalone
 * release binary, which is over a hundred megabytes, and this classification runs
 * on every update check — so read a bounded prefix rather than the whole file. A
 * forwarding line that does not fit in the first four kilobytes is not a shim any
 * installer or any person writes.
 */
const SHIM_READ_LIMIT = 4096;

/**
 * Read the first {@link SHIM_READ_LIMIT} bytes of a shim file. Fails closed: an
 * unreadable shim yields "", which classifies as `binary` only after the launcher
 * checks below have already missed, so a misread can never silently upgrade a
 * path to `source`.
 */
function defaultReadShim(p: string): string {
	let fd: number | undefined;
	try {
		fd = fs.openSync(p, "r");
		const buffer = Buffer.alloc(SHIM_READ_LIMIT);
		const read = fs.readSync(fd, buffer, 0, SHIM_READ_LIMIT, 0);
		return buffer.subarray(0, read).toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// The classification is already decided; a close failure changes nothing.
			}
		}
	}
}

/**
 * Every path a shim could be forwarding execution to.
 *
 * Both shapes are covered because both exist in the wild. The generated Windows
 * shim quotes its target (`@echo off` then `"C:\...\veyyon" %*`), and a POSIX
 * wrapper someone writes by hand execs it, quoted or not
 * (`exec /home/u/src/.../veyyon "$@"`). Every candidate is checked against the
 * launcher tail, so an extra non-target token costs nothing and a missed one
 * would misclassify a source install as a binary.
 */
function shimForwardTargets(shimBody: string): string[] {
	const targets: string[] = [];
	for (const match of shimBody.matchAll(/"([^"\r\n]+)"/g)) targets.push(match[1] as string);
	for (const match of shimBody.matchAll(/^\s*exec\s+([^\s"'\r\n]+)/gm)) targets.push(match[1] as string);
	return targets;
}

/**
 * Could this path hold a forwarding shim rather than the binary itself?
 *
 * Only a `.cmd`/`.bat` (the generated Windows shim) or a file whose first two
 * bytes are `#!` (any POSIX script). The shebang check is what keeps the
 * standalone release binary out: its bytes are never scanned for a path that
 * happens to look like the launcher, so no ELF or Mach-O image can talk its way
 * into being classified `source`.
 */
function looksLikeShim(resolvedPath: string, body: string): boolean {
	const lower = resolvedPath.toLowerCase();
	if (lower.endsWith(".cmd") || lower.endsWith(".bat")) return true;
	return body.startsWith("#!");
}

export function resolveUpdateMethod(
	veyyonPath: string,
	readShim: (p: string) => string = defaultReadShim,
): UpdateMethod {
	const resolved = tryRealpath(veyyonPath) ?? veyyonPath;
	if (endsWithSourceLauncher(resolved)) return "source";
	// A source install can reach the checkout through a FORWARDING SHIM rather
	// than a symlink, and realpath stops at the shim, so the tail never matches.
	// On Windows that shim is what `install.sh --source` itself writes; on POSIX
	// it is what a person writes when they want their own wrapper (extra env, a
	// different interpreter) in front of the checkout. Either way the install used
	// to be classified `binary`, and `veyyon update` would then overwrite the shim
	// with a downloaded release binary — silently converting a source install into
	// a binary one and orphaning the checkout. Read the shim and classify by what
	// it forwards to.
	const body = readShim(resolved);
	if (looksLikeShim(resolved, body)) {
		for (const forwarded of shimForwardTargets(body)) {
			const forwardedResolved = tryRealpath(forwarded) ?? forwarded;
			if (endsWithSourceLauncher(forwardedResolved)) return "source";
		}
	}
	return "binary";
}

async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const veyyonPath = resolveVeyyonPath();
	if (!veyyonPath) throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
	return { method: resolveUpdateMethod(veyyonPath), path: veyyonPath };
}

/**
 * How the veyyon on PATH is installed, or `undefined` when no veyyon resolves in
 * PATH. The default the background updater uses to decide whether to skip a
 * source install; injectable into {@link runAutoUpdate} so tests do not depend on
 * what happens to be installed on the machine running them.
 */
function defaultInstalledMethod(): UpdateMethod | undefined {
	const veyyonPath = resolveVeyyonPath();
	return veyyonPath ? resolveUpdateMethod(veyyonPath) : undefined;
}

/**
 * Look up the latest published release from GitHub Releases.
 *
 * The one place the release source is asked what the newest version is. Startup
 * and `veyyon update` both come through here, so they can never disagree about
 * where to ask or how to read the answer, and it is the same source
 * `install.sh` uses so a self-update and a fresh `curl` install always resolve
 * the same version. Veyyon has no npm package; the GitHub release is the only
 * catalog (see {@link GITHUB_RELEASES_API}).
 *
 * `releases/latest` returns the newest non-draft, non-prerelease release, so a
 * draft that has been uploaded but not published never triggers an update.
 *
 * `timeoutMs` exists because the two callers want different patience: a
 * startup check runs while you are waiting to type and gives up quickly, while
 * an explicit `veyyon update` is worth waiting on.
 *
 * It does NOT call the GitHub API, and that is the point. `api.github.com`
 * allows 60 requests an hour per IP without a token, and that budget is shared
 * by everyone behind the same address — so an office, a CI fleet or a container
 * host running several agents spent it on startup checks and then could not
 * update at all, on machines where nothing was wrong. `github.com` itself is not
 * part of that budget, and `/releases/latest` redirects to the tag page of the
 * newest non-prerelease release, which is the only thing the API response was
 * ever read for. `install.sh` resolves the same way, so a self-update and a
 * fresh install still agree on what "latest" means.
 *
 * {@link getAllReleases} still uses the API, deliberately: a full version list
 * has no equivalent redirect, and unlike this function it runs only when someone
 * opens the rollback picker, not on every launch.
 */
export async function getLatestRelease(timeoutMs: number = RELEASE_METADATA_TIMEOUT_MS): Promise<ReleaseInfo> {
	const url = `${GITHUB_LATEST_RELEASE_URL}`;
	let response: Response;
	try {
		// `redirect: "manual"` so the 302 itself is the answer. Following it would
		// download the release page, which is a few hundred kilobytes of HTML this
		// function does not read, on every startup check.
		response = await fetch(url, {
			method: "HEAD",
			redirect: "manual",
			headers: { "User-Agent": GITHUB_USER_AGENT },
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching release info after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
		}
		throw err;
	}
	// A redirect is the expected answer, so `response.ok` is false on the happy
	// path and cannot be the check. 404 means the repository has no published
	// release; anything else is a transport problem worth naming.
	const location = response.headers.get("location") ?? "";
	if (!location) {
		const hint =
			response.status === 404
				? ` — ${REPO} has no published GitHub release yet (a draft or untagged release does not count)`
				: "";
		const status = response.statusText ? `${response.status} ${response.statusText}` : `${response.status}`;
		throw new Error(`Could not read the latest release from ${url}: HTTP ${status}${hint}`);
	}
	// Only a tag page is an answer. A redirect anywhere else means GitHub replied
	// with something other than a release — an interstitial, a moved repository, a
	// captive portal — and taking the last path segment anyway is how an updater
	// ends up trying to install the version "latest".
	const match = /\/releases\/tag\/(.+)$/.exec(location);
	const tag = match?.[1] ?? "";
	const version = bareVersion(tag);
	if (!isValidSemver(version)) {
		throw new Error(`GitHub redirected ${url} to ${JSON.stringify(location)}, which names no release tag`);
	}

	return {
		tag: tag.startsWith("v") ? tag : `v${version}`,
		version,
	};
}

/**
 * One published release, with enough to render a row a person can choose from.
 *
 * `publishedAt` is optional because it is presentation, not identity: a release
 * whose timestamp GitHub omits or returns unparseably is still a version you can
 * install, and dropping it from the list to keep the shape tidy would hide a
 * real option (Law 10). The rows render without a date instead.
 */
export interface ReleaseListing extends ReleaseInfo {
	publishedAt?: string;
}

/**
 * GitHub's page size for `/releases`. 100 is its documented maximum; asking for
 * fewer would silently truncate the version list, which for a rollback picker
 * means older versions simply are not offered and nothing says why.
 */
const RELEASES_PAGE_SIZE = 100;

/**
 * How many pages to walk. Bounded so a paging bug cannot loop forever, and so
 * one picker cannot spend the whole hourly API budget in a single open. At 100
 * releases a page this stops at 1000 versions, roughly two orders of magnitude
 * past this repository's history; a project that reaches it would truncate the
 * OLDEST versions silently, so raise this bound rather than let the picker
 * quietly stop offering them.
 */
const RELEASES_MAX_PAGES = 10;

/**
 * Every published release, newest first.
 *
 * Rollback needs the catalog, not just its newest entry, and this is the only
 * place that asks for it. It is also the only thing left in this file that calls
 * `api.github.com`, which is capped at 60 requests an hour per address: a full
 * version list has no redirect to read it from the way {@link getLatestRelease}
 * does, so the cost is paid here, where it is spent by someone who opened the
 * rollback picker rather than by every launch. It applies the same exclusions
 * GitHub's `releases/latest` applies implicitly:
 * drafts are unpublished and prereleases are not what `veyyon update` installs,
 * so offering either would let you roll INTO a version the update path would
 * immediately roll you back out of.
 *
 * A release with an unusable tag is SKIPPED rather than fatal — one malformed
 * tag in a long history should not deny you the other fifty versions — but an
 * empty result is an ERROR, because "no versions exist" and "the request
 * failed in a way we did not classify" look identical to a caller, and the
 * quiet reading of that is an empty picker that looks like a working one.
 */
export async function getAllReleases(timeoutMs: number = RELEASE_METADATA_TIMEOUT_MS): Promise<ReleaseListing[]> {
	const releases: ReleaseListing[] = [];
	const seen = new Set<string>();
	for (let page = 1; page <= RELEASES_MAX_PAGES; page++) {
		const url = `${GITHUB_RELEASES_API}?per_page=${RELEASES_PAGE_SIZE}&page=${page}`;
		const batch = await fetchReleasePage(url, timeoutMs);
		if (batch.length === 0) break;
		for (const entry of batch) {
			// A tag can legitimately repeat across pages when a release is published
			// mid-walk and shifts the pagination window; keeping the first sighting
			// keeps the list a set of versions rather than a list of sightings.
			if (seen.has(entry.version)) continue;
			seen.add(entry.version);
			releases.push(entry);
		}
		if (batch.length < RELEASES_PAGE_SIZE) break;
	}

	if (releases.length === 0) {
		throw new Error(
			`No published releases found for ${REPO} — a draft or prerelease does not count, and an empty list here means there is nothing to roll back to`,
		);
	}

	releases.sort((a, b) => compareSemver(b.version, a.version));
	return releases;
}

/** One page of the releases list, already filtered to installable releases. */
async function fetchReleasePage(url: string, timeoutMs: number): Promise<ReleaseListing[]> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { "User-Agent": GITHUB_USER_AGENT, Accept: "application/vnd.github+json" },
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching the release list after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
		}
		throw err;
	}
	if (!response.ok) {
		// The version LIST is the only thing left that spends the API budget, and
		// that budget belongs to the address rather than to this machine, so a
		// rate limit here is usually somebody else's traffic. Updating forward
		// does not go through the API at all, which is worth saying: otherwise
		// this reads as "veyyon cannot reach GitHub" and the user stops trying.
		const hint =
			response.status === 403 || response.status === 429
				? " — GitHub is rate-limiting this address (the limit is per address and shared, so another machine behind it may have spent it); retry in a few minutes, or run `veyyon update`, which does not use the API. `veyyon rollback <version>` needs this list to confirm the version exists."
				: "";
		throw new Error(
			`Failed to fetch the release list from ${url}: HTTP ${response.status} ${response.statusText}${hint}`,
		);
	}

	const data: unknown = await response.json();
	if (!Array.isArray(data)) {
		throw new Error(`Expected a list of releases from ${url}, got ${typeof data}`);
	}
	return data.flatMap(entry => {
		const record = entry as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown };
		if (record.draft === true || record.prerelease === true) return [];
		const tag = typeof record.tag_name === "string" ? record.tag_name : "";
		const version = bareVersion(tag);
		if (!isValidSemver(version)) return [];
		const publishedAt = typeof record.published_at === "string" ? record.published_at : undefined;
		return [{ tag: tag.startsWith("v") ? tag : `v${version}`, version, publishedAt }];
	});
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	let os: string;
	switch (platform) {
		case "linux":
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	if (os === "windows") {
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

/**
 * The reason a release-binary download failed, with the URL, the HTTP status,
 * and — for a 404 — the specific "this version or this platform's asset does not
 * exist" hint.
 *
 * {@link updateViaBinaryAt} downloads a per-version, per-platform asset
 * (`veyyon-<os>-<arch>[.exe]`), so a bare "Download failed: Not Found" hid both
 * which version was requested (the rollback path installs arbitrary old
 * versions, where a mistyped or unpublished version is the likeliest cause) and
 * which platform asset was missing (a release whose build for one OS/arch did
 * not upload). An error message carries context and the fix (Engineering
 * Standards), so name the URL, the status, the version, and the asset.
 *
 * `binaryName` is passed in rather than read from {@link getBinaryName} so the
 * message is deterministic under test instead of depending on the host's
 * platform and architecture.
 */
export function formatBinaryDownloadFailure(
	status: number,
	statusText: string,
	url: string,
	version: string,
	binaryName: string,
): string {
	const suffix = statusText ? ` ${statusText}` : "";
	const head = `Failed to download release binary from ${url}: HTTP ${status}${suffix}`;
	if (status === 404) {
		return (
			`${head} — release v${version} has no ${binaryName} asset. The version may not ` +
			`exist, or its build for your platform and architecture was not published. ` +
			`Run \`${APP_NAME} update --check\` to see the latest available version.`
		);
	}
	if (status === 403 || status === 429) {
		return `${head} — GitHub is rate-limiting this address; retry in a few minutes.`;
	}
	return head;
}

/**
 * Re-exported so the self-updater's callers and tests have one import site.
 * The definition lives in `@veyyon/natives`, the lowest layer shared with the
 * native-addon provisioning that reads the same sidecar format.
 */
export { parseSha256Sidecar };

/**
 * Verify a downloaded release binary against its published `.sha256` sidecar,
 * failing closed on any problem.
 *
 * `install.sh` and `install.ps1` both refuse to install a binary whose checksum
 * is missing, unparseable, or mismatched. The self-updater downloaded and swapped
 * the binary with only a post-install `--version` check, which catches a
 * wrong-version binary but not a corrupted or tampered same-version one. This
 * closes that parity gap so every install path — fresh `curl`, PowerShell, and
 * self-update — enforces the same integrity gate.
 *
 * There is no silent fallback (Law 10): a sidecar that is absent (HTTP error),
 * empty, unparseable, or whose digest does not match the file on disk throws, and
 * the caller removes the partial download instead of installing something
 * unverified. Rolling back to a pre-sidecar release therefore fails loudly rather
 * than installing without verification, which is the correct refusal.
 */
export async function verifyDownloadChecksum(filePath: string, sidecarUrl: string): Promise<void> {
	let response: Response;
	try {
		response = await fetch(sidecarUrl, { redirect: "follow", signal: withTimeoutSignal(CHECKSUM_TIMEOUT_MS) });
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching the published checksum from ${sidecarUrl}`, { cause: err });
		}
		throw err;
	}
	if (!response.ok) {
		throw new Error(
			`No published checksum at ${sidecarUrl} (HTTP ${response.status}) — refusing to install an unverified binary`,
		);
	}
	const expected = parseSha256Sidecar(await response.text());
	if (!expected) {
		throw new Error(
			`Published checksum at ${sidecarUrl} is empty or unparseable — refusing to install an unverified binary`,
		);
	}
	const hasher = new Bun.CryptoHasher("sha256");
	const stream = fs.createReadStream(filePath);
	for await (const chunk of stream) {
		hasher.update(chunk as Buffer);
	}
	const actual = hasher.digest("hex").toLowerCase();
	if (actual !== expected) {
		throw new Error(
			`Checksum mismatch for the downloaded binary (expected ${expected}, got ${actual}) — refusing to install a tampered binary`,
		);
	}
}

/**
 * Resolve the path that `veyyon` maps to in the user's PATH.
 */
function resolveVeyyonPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

/**
 * Run the binary at `binPath` and check that it reports `expectedVersion`.
 *
 * The path is passed in, never re-resolved through PATH. An update writes one
 * specific file, and that file is what has to be verified: resolving the name
 * again asks a different question ("what does PATH pick right now?"), and its
 * answer can differ from the file just written. An older copy earlier on PATH
 * makes the check report the OLD version and the updater roll back a perfectly
 * good binary; an already-current copy earlier on PATH makes it report the NEW
 * version and pass a swap that never happened. Neither failure is visible.
 */
export async function verifyBinaryVersion(
	binPath: string,
	expectedVersion: string,
): Promise<InstalledVersionVerification> {
	try {
		const result = await $`${binPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) {
			// The binary's own words, not "could not verify updated version". A file
			// that will not start and a file that starts and reports the wrong version
			// are different failures with different remedies, and the first one used to
			// be reported with the second one's wording. An install directory mounted
			// `noexec` is the case that made this matter: the downloaded binary is
			// byte-perfect and the mount refuses to execute it, and the only thing that
			// says so is the message the kernel handed back.
			return {
				ok: false,
				path: binPath,
				reason: describeUnrunnableBinary(binPath, result.exitCode, result.stderr.toString()),
			};
		}
		const output = result.text().trim();
		// Output format: "veyyon/X.Y.Z"
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		if (actual === undefined) {
			// It ran and said something we cannot read a version out of. Quoting it is
			// the only way the operator can tell a truncated download from a wrapper
			// script that printed its own banner.
			return {
				ok: false,
				path: binPath,
				reason:
					`${binPath} ran but did not report a version. It printed: ` +
					`${output === "" ? "nothing" : JSON.stringify(output.slice(0, 400))}`,
			};
		}
		return { ok: actual === expectedVersion, actual, path: binPath };
	} catch (err) {
		// The spawn itself failed, which is where ENOEXEC (wrong architecture) and
		// EACCES (no execute bit, or a `noexec` mount) land. There is no exit code
		// because no process ever started.
		return { ok: false, path: binPath, reason: describeUnrunnableBinary(binPath, undefined, String(err)) };
	}
}

/**
 * Why a binary we just installed would not run, in one line the operator can act on.
 *
 * One owner so the two failure routes above word it identically; they differ only
 * in whether a process started at all, which is exactly what the message says.
 */
function describeUnrunnableBinary(binPath: string, exitCode: number | undefined, stderr: string): string {
	const said = stderr.trim();
	const what = exitCode === undefined ? "could not be started" : `exited ${exitCode}`;
	const because = said === "" ? "It printed nothing." : `It said: ${said.slice(0, 400)}`;
	return `${binPath} ${what} when asked for its version. ${because}`;
}

/**
 * Proves an install actually functions. Returns the reason it does not, or
 * `undefined` when it works. Injectable so step-sequencing tests can drive the
 * update without a real checkout on disk; {@link probeSearchWorks} is the one
 * implementation shipped.
 */
export type SearchProbe = (binPath: string, label: string) => Promise<string | undefined>;

/**
 * Run a real search through an installed veyyon and say why it did not work.
 *
 * The one owner of the "does this install actually function?" probe, shared by
 * the binary swap ({@link verifyBinaryUsable}) and the source update
 * ({@link updateViaSourceAt}). Both need the same evidence for the same reason
 * and would drift if each grew its own copy. `grep` is the cheapest command
 * that goes through the native walker and returns a checkable result, against a
 * file this function writes itself.
 *
 * Returns `undefined` when the install works, or when this build has no `grep`
 * subcommand at all: a downgrade to a release predating it is not a broken
 * update, and treating it as one would roll back forever.
 *
 * That excuse must not swallow an install that is missing or not executable,
 * which is the failure this exists to catch. Exit codes cannot tell the two
 * apart here: Bun's shell reports a missing command as exit 1, the same code an
 * unknown subcommand produces. So executability is checked directly, before
 * anything is spawned.
 */
export async function probeSearchWorks(binPath: string, label: string): Promise<string | undefined> {
	try {
		await fs.promises.access(binPath, fs.constants.X_OK);
	} catch {
		return `${label} is missing or not executable at ${binPath}.`;
	}
	const help = await $`${binPath} grep --help`.quiet().nothrow();
	if (help.exitCode !== 0) return undefined;

	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "veyyon-update-check-"));
	try {
		await fs.promises.writeFile(path.join(dir, "probe.txt"), "veyyon-native-self-test\n");
		const probe = await $`${binPath} grep veyyon-native-self-test ${dir}`.quiet().nothrow();
		const output = `${probe.stdout.toString()}${probe.stderr.toString()}`;
		if (probe.exitCode !== 0) {
			return (
				`${label} cannot run a search (\`grep\` exited ${probe.exitCode}), so its native ` +
				`addon did not load. This usually means the release has no build for this ` +
				`platform. Output was: ${output.trim()}`
			);
		}
		// Exit 0 is not enough on its own: a walker that returns nothing exits 0.
		if (!output.includes("probe.txt")) {
			return (
				`${label} ran a search but did not find a file it was pointed at, so the ` +
				`install is not usable. Output was: ${output.trim()}`
			);
		}
		return undefined;
	} catch (err) {
		return errorMessage(err);
	} finally {
		await removeTempPath(dir, "update-staging-dir");
	}
}

/**
 * Prove the swapped-in binary can actually work, not just that it reports the
 * right version.
 *
 * `--version` is answered by the JS entry point alone, so a release built for
 * the wrong architecture, or one whose native addon failed to stage, passes the
 * version check and fails on the user's first real command — with the previous
 * working binary already deleted. `grep` is the cheapest command that goes
 * through the native walker and returns a checkable result, against a file this
 * function writes itself.
 *
 * Returning `ok: false` is what makes this worth doing here rather than in
 * doctor: the caller rolls the previous binary back. install.sh's doctor can
 * only report the same failure after the fact.
 */
export async function verifyBinaryUsable(
	binPath: string,
	expectedVersion: string,
): Promise<InstalledVersionVerification> {
	const version = await verifyBinaryVersion(binPath, expectedVersion);
	if (!version.ok) return version;

	const reason = await probeSearchWorks(binPath, `${APP_NAME} ${expectedVersion}, just installed,`);
	if (reason !== undefined) return { ok: false, path: binPath, actual: version.actual, reason };
	return version;
}

/**
 * Where an in-progress update reports what it is doing.
 *
 * `veyyon update` is a plain CLI run and prints to the console. An automatic
 * update runs underneath a live TUI, where any stray write lands in the middle
 * of the rendered frame and corrupts it, so that caller passes
 * {@link SILENT_UPDATE_REPORTER} and reports the outcome through its own UI.
 */
export type UpdateReporter = (line: string) => void;

export const CONSOLE_UPDATE_REPORTER: UpdateReporter = line => {
	console.log(line);
};

export const SILENT_UPDATE_REPORTER: UpdateReporter = () => {};

function printVerifiedVersion(expectedVersion: string, report: UpdateReporter): void {
	report(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.reason) {
		return result.reason;
	}
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

/**
 * The target of `filePath` if it is a symlink, else null.
 *
 * `lstat` rather than `stat`, deliberately: the question is whether this PATH is a
 * link, not what sits at the end of it. A missing path is not a symlink.
 */
async function readLinkIfSymlink(filePath: string): Promise<string | null> {
	try {
		const stats = await fs.promises.lstat(filePath);
		if (!stats.isSymbolicLink()) return null;
		return await fs.promises.readlink(filePath);
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/**
 * Delete a file, tolerating only its absence.
 *
 * The THROW is the point, and there is exactly one place that wants it: clearing
 * the swapped-in binary so the backup can be renamed back. If that delete fails
 * the rollback cannot proceed, and the caller turns the throw into the
 * recovery-instructions error. Everywhere else — cleaning a temp download, a
 * partial file, a backup — use {@link removeFileBestEffort}: those cleanups run
 * inside a catch, and a failure there REPLACES the failure being reported, which
 * is how "cannot write into this directory" became "cannot unlink vey.new".
 */
async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Remove a file without letting the removal abort or mask what is being reported.
 *
 * On Windows the executable that was just moved aside is still mapped as the
 * running process image, so unlinking it fails with EPERM/EACCES until this
 * process exits (issue #845). The replacement and verification already
 * succeeded by the time we get here, so every error is swallowed; the leftover
 * is reclaimed by {@link sweepStaleBackups} on the next update once it is no
 * longer in use. Returns whether the file is gone.
 */
async function removeFileBestEffort(filePath: string): Promise<boolean> {
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

/**
 * Best-effort removal of binary-update backups left by earlier runs.
 *
 * Each self-update moves the previous executable to `<binary>.<timestamp>.<pid>.bak`
 * before swapping the new one in. On Windows that backup cannot be deleted
 * while the updating process is alive, so it is left for a later run to reclaim
 * once its owning process has exited. Also matches the legacy fixed
 * `<binary>.bak` name produced before backups were timestamped, so users
 * upgrading from a buggy release get the orphaned file cleaned up.
 */
export async function sweepStaleBackups(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`) || !entry.endsWith(".bak")) continue;
		// Legacy "<base>.bak" → empty middle; new "<base>.<timestamp>.<pid>.bak"
		// → dot-separated numeric run. Anything else is an unrelated *.bak file.
		const middle = entry.slice(base.length + 1, entry.length - ".bak".length);
		if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
		await removeFileBestEffort(path.join(dir, entry));
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		// Refuse an empty or missing download BEFORE disturbing the live binary.
		// A truncated-but-HTTP-200 body would otherwise be renamed over the running
		// binary and only caught afterwards by the `--version` check, leaving the
		// user with a broken binary for the duration of the rollback. This mirrors
		// install.sh's `finalize_binary` guard (`[ -s "$tmp" ]`), which fails
		// before ever touching the destination. `backupReady` is still false, so
		// the catch cleans the junk temp and never runs a needless restore.
		let tempSize: number;
		try {
			tempSize = (await fs.promises.stat(options.tempPath)).size;
		} catch (err) {
			if (isEnoent(err)) throw new Error("Downloaded update is missing; not replacing the installed binary");
			throw err;
		}
		if (tempSize === 0) {
			throw new Error("Downloaded update is empty; not replacing the installed binary");
		}
		// A symlinked binary is somebody's deliberate setup — `~/.local/bin/vey`
		// pointing at a checkout's build is how you develop on veyyon — and renaming
		// over it REPLACES THE LINK with a regular file. The checkout survives, but
		// nothing points at it any more, and the swap said nothing: you keep editing
		// a build that no longer runs. Writing through the link instead would be
		// worse, since it would clobber the build artifact at the other end. So
		// refuse, and say which link, where it goes, and what to do (Law 10: fail
		// closed rather than degrade silently).
		const linkTarget = await readLinkIfSymlink(options.targetPath);
		if (linkTarget !== null) {
			throw new Error(
				`${options.targetPath} is a symlink to ${linkTarget}, so updating would replace your link with a ` +
					`downloaded binary and leave nothing pointing at ${linkTarget}. Update that install directly, or ` +
					`replace the symlink with a real binary first (rm ${options.targetPath}) and re-run the update.`,
			);
		}
		// `backupPath` is unique per attempt (see updateViaBinaryAt), so this rename
		// never has to overwrite — or unlink — a possibly-locked leftover from an
		// earlier run. Renaming the running executable itself is permitted on
		// Windows; only deleting its still-mapped image is not.
		await fs.promises.rename(options.targetPath, options.backupPath);
		backupReady = true;
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		// Swap done and verified. On Windows the backup is still the running
		// process image and cannot be unlinked until this process exits, so a
		// failure here must NOT fail an otherwise-successful update.
		await removeFileBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			try {
				await unlinkIfExists(options.targetPath);
				await fs.promises.rename(options.backupPath, options.targetPath);
			} catch (rollbackErr) {
				// The worst case: the update failed AND the automatic restore failed
				// too (permissions, a locked destination, the backup vanished). Left
				// alone, the rollback error would replace the original failure, the
				// temp would leak, and the user would be staring at a missing binary
				// with no idea their previous one is intact one path over. Clean the
				// temp, then fail loud with the exact recovery move and the original
				// cause preserved. Best-effort: whatever stopped the rollback (a
				// read-only directory, a locked file) usually stops this unlink too,
				// and losing the recovery instructions to an unlink error is the worst
				// possible trade.
				await removeFileBestEffort(options.tempPath);
				throw new Error(
					`${APP_NAME} update failed and the automatic rollback could not restore the previous binary ` +
						`(${errorMessage(rollbackErr)}). Your previous ${APP_NAME} is intact at ${options.backupPath} — ` +
						`move it back to ${options.targetPath} to recover.`,
					{ cause: err },
				);
			}
		}
		// Best-effort, deliberately not `unlinkIfExists`: in a read-only or
		// noexec bin directory the unlink ALSO fails, and that EACCES used to
		// propagate in place of the real cause, so the operator was told veyyon
		// could not delete `vey.new` when what actually happened is that it could
		// not write into the directory at all. A cleanup that cannot run is a
		// leaked temp file; the failure being reported is the one that matters.
		await removeFileBestEffort(options.tempPath);
		throw err;
	}
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
/**
 * Download release `expectedVersion` and swap it in at `targetPath`.
 *
 * Exported for the integrity tests rather than for callers: production code
 * reaches this only through {@link installRelease}, which owns the binary vs
 * source dispatch. The seam exists because the property that matters here is not
 * "does the checksum function reject a bad digest" but "when anything in this
 * sequence fails, is the binary the user already has still on disk and still
 * runnable". That can only be observed by driving the whole download, verify and
 * swap sequence against a real file, and `installRelease` resolves its target
 * from PATH, which a test must not depend on or point at a real install.
 */
export async function updateViaBinaryAt(
	targetPath: string,
	expectedVersion: string,
	report: UpdateReporter,
): Promise<void> {
	const binaryName = getBinaryName();
	const tag = `v${expectedVersion}`;
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;

	const tempPath = `${targetPath}.new`;
	// Unique per attempt: a stale backup from an earlier update may still be
	// locked (it is the previous process image on Windows), and a fixed name
	// would force the move-aside rename to overwrite it. pid + timestamp keeps
	// two forced updates in the same millisecond from colliding.
	const backupPath = `${targetPath}.${Date.now()}.${process.pid}.bak`;
	report(chalk.dim(`Downloading ${binaryName}…`));

	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "follow",
			signal: withTimeoutSignal(BINARY_DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		throw err;
	}
	if (!response.ok) {
		throw new Error(
			formatBinaryDownloadFailure(response.status, response.statusText, url, expectedVersion, binaryName),
		);
	}
	if (!response.body) {
		throw new Error(`Release binary download from ${url} returned HTTP ${response.status} with an empty body`);
	}
	const fileStream = fs.createWriteStream(tempPath, { mode: 0o755 });
	try {
		await pipeline(response.body, fileStream);
	} catch (err) {
		// A mid-download failure (network drop) leaves a partial `<binary>.new`
		// behind: we throw here before reaching replaceBinaryForUpdate, whose catch
		// would otherwise clean it up. Remove it so a failed update never litters
		// the install dir, matching install.sh's EXIT/INT/TERM trap on its tmpbin.
		// Best-effort: a directory this process cannot write is the likeliest reason
		// the download failed in the first place, and it would fail the cleanup too.
		// The download error is the one worth reporting.
		await removeFileBestEffort(tempPath);
		throw err;
	}

	// Fail-closed integrity gate, matching install.sh / install.ps1: verify the
	// download against its published .sha256 sidecar BEFORE swapping it in. A
	// corrupted or tampered same-version binary would otherwise pass the
	// post-install --version check unnoticed. No silent fallback (Law 10) — a
	// missing, unparseable, or mismatched checksum aborts and removes the partial
	// download rather than installing something unverified.
	report(chalk.dim("Verifying checksum…"));
	try {
		await verifyDownloadChecksum(tempPath, `${url}.sha256`);
	} catch (err) {
		// Best-effort, for the same reason as above: a checksum mismatch is a
		// security finding and must reach the operator verbatim, never be displaced
		// by a failure to delete the file it is about.
		await removeFileBestEffort(tempPath);
		throw err;
	}
	// Confirm the integrity check passed, matching install.sh's "verified sha256".
	// A security control that only speaks up on failure leaves the user unsure it
	// ran at all; say so on success too. Silent under the auto-update reporter.
	report(chalk.dim("Checksum verified"));

	report(chalk.dim("Installing update..."));
	await replaceBinaryForUpdate({
		targetPath,
		tempPath,
		backupPath,
		expectedVersion,
		// Verify the file this update just wrote, not whatever PATH resolves now.
		verifyInstalledVersion: version => verifyBinaryUsable(targetPath, version),
	});
	// Reclaim backups from earlier updates whose owning process has since exited.
	await sweepStaleBackups(targetPath);
	// The completion scripts on disk describe the version we just replaced, so
	// every subcommand and flag this release adds would be missing from tab
	// completion until the user re-ran the installer. Regenerate from the binary
	// that was just installed.
	await refreshCompletionsForInstalledBinary(targetPath, report);
	printVerifiedVersion(expectedVersion, report);
	report(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/**
 * The PowerShell completion script `install.ps1` wrote, if this is Windows.
 *
 * PowerShell has no directory it autoloads completions from, so the installer
 * writes a script beside the user's profile and adds a line that dot-sources it.
 * Where that profile lives cannot be derived reliably from TypeScript: Documents
 * can be redirected (OneDrive), and Windows PowerShell 5.1 and PowerShell 7 use
 * different folders. Guessing would leave this refresh rewriting a path the
 * installer never used, so PowerShell is asked directly — the same authority
 * install.ps1 consulted when it chose the location.
 *
 * Returns nothing off Windows, and nothing when PowerShell cannot be reached:
 * the file is only rewritten when it already exists, so a wrong or missing
 * answer costs a stale completion, never a stray file.
 */
async function windowsCompletionTargets(): Promise<CompletionTarget[]> {
	if (process.platform !== "win32") return [];
	const proc = await $`powershell -NoProfile -Command "$PROFILE.CurrentUserAllHosts"`.quiet().nothrow();
	const profilePath = proc.stdout.toString().trim();
	if (proc.exitCode !== 0 || !profilePath) return [];
	return [
		{
			shell: "powershell",
			commandName: APP_NAME,
			filePath: powershellCompletionPath(profilePath, APP_NAME),
		},
	];
}

/**
 * Regenerate the already-installed completion scripts from a freshly installed
 * binary.
 *
 * Best effort by design: the update itself has already succeeded and been
 * verified, so a shell whose completion cannot be rewritten is reported rather
 * than allowed to fail the update. Reported to stderr rather than through the
 * reporter, because the auto-update reporter is deliberately silent about
 * progress and a failure that nobody sees is exactly the silent degrade this
 * codebase does not allow.
 */
export async function refreshCompletionsForInstalledBinary(
	binaryPath: string,
	report: UpdateReporter,
	generate?: CompletionGenerator,
): Promise<CompletionRefreshResult> {
	const result = await refreshInstalledCompletions({
		env: completionEnvFrom(process.env),
		binName: APP_NAME,
		aliasName: APP_ALIAS,
		extraTargets: await windowsCompletionTargets(),
		generate:
			generate ??
			(async (shell, noAlias) => {
				// `--no-alias` is carried forward from what the installer wrote, not
				// chosen here: on a machine where `vey` is the user's own command the
				// installer never bound it, and an update that bound it anyway would
				// hand our subcommands to their tool.
				const args = noAlias ? ["completions", shell, "--no-alias"] : ["completions", shell];
				const proc = await $`${binaryPath} ${args}`.quiet().nothrow();
				if (proc.exitCode !== 0) {
					throw new Error(
						`\`${binaryPath} ${args.join(" ")}\` exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`,
					);
				}
				return proc.stdout.toString();
			}),
	});
	if (result.refreshed.length > 0) {
		report(chalk.dim(`Refreshed ${result.refreshed.length} shell completion file(s)`));
	}
	for (const failure of result.failed) {
		process.stderr.write(
			chalk.yellow(
				`Warning: could not refresh the shell completion at ${failure.filePath}: ${failure.reason}\n` +
					`It still describes the previous version. Re-run the installer to rewrite it.\n`,
			),
		);
	}
	return result;
}

/**
 * Human-facing guidance shown when a source checkout cannot be updated
 * automatically (dirty tree, diverged branch, missing git). Shared by every
 * source-update failure so they all name the same manual recovery.
 */
export function sourceInstallUpdateGuidance(launcherPath: string): string {
	return (
		`${APP_NAME} is installed from source (its launcher is ${launcherPath}). ` +
		`Update the checkout manually: cd into it and run \`git pull && bun install\`, ` +
		`or re-run the installer with \`--source\`.`
	);
}

/**
 * The file whose `version` field IS the version a source checkout reports.
 *
 * Single owner: the post-update verification reads this and nothing else, so it
 * can never check a different manifest than the one the running CLI is built
 * from.
 */
export const SOURCE_VERSION_FILE = "packages/coding-agent/package.json";

/**
 * Reads a source checkout's own version. Injectable so the verification can be
 * tested without a real checkout on disk.
 *
 * Returns `undefined` when the file is missing, unreadable, unparseable, or has
 * no string `version` — every one of those means the version is UNKNOWN, and the
 * caller must treat unknown as a failure rather than as agreement (Law 10).
 */
export type CheckoutVersionReader = (checkoutRoot: string) => Promise<string | undefined>;

const defaultReadCheckoutVersion: CheckoutVersionReader = async checkoutRoot => {
	try {
		const raw = await Bun.file(path.join(checkoutRoot, SOURCE_VERSION_FILE)).text();
		const version = (JSON.parse(raw) as { version?: unknown }).version;
		return typeof version === "string" && version.length > 0 ? version : undefined;
	} catch {
		// Missing, unreadable or unparseable all mean the checkout version is UNKNOWN, which is the
		// contract on `CheckoutVersionReader` above: the caller must treat unknown as a verification
		// failure, never as agreement, so nothing is lost by collapsing the three cases here.
		return undefined;
	}
};

/** A command the source updater runs, with a human label for reporting. */
interface SourceUpdateStep {
	label: string;
	command: string[];
	cwd: string;
}

/**
 * Run one source-update step; injectable so tests exercise the sequencing and
 * failure surfaces without a real git checkout or network.
 */
export type SourceUpdateExec = (step: SourceUpdateStep) => Promise<{ exitCode: number; stderr: string }>;

const defaultSourceUpdateExec: SourceUpdateExec = async step => {
	const proc = Bun.spawn(step.command, { cwd: step.cwd, stdout: "ignore", stderr: "pipe" });
	const stderr = await readPipeText(proc.stderr);
	const exitCode = await proc.exited;
	return { exitCode, stderr };
};

/**
 * Update a source install in place: fast-forward the checkout, then reinstall
 * workspace dependencies (whose postinstall regenerates gitignored build
 * artifacts like tool-views.generated.js — a pulled checkout without that
 * regen step does not even boot, which is why this owns BOTH steps instead of
 * telling the user to run them).
 *
 * Fails closed with the manual guidance on anything unexpected: a dirty tree
 * or diverged branch must never be force-resolved by an updater (the checkout
 * is the user's working tree; see the git safety rules).
 */
export async function updateViaSourceAt(
	launcherPath: string,
	version: string,
	report: UpdateReporter = CONSOLE_UPDATE_REPORTER,
	exec: SourceUpdateExec = defaultSourceUpdateExec,
	readCheckoutVersion: CheckoutVersionReader = defaultReadCheckoutVersion,
	probe: SearchProbe = probeSearchWorks,
): Promise<void> {
	// launcher = <checkout>/packages/coding-agent/scripts/veyyon
	const resolvedLauncher = tryRealpath(launcherPath) ?? launcherPath;
	const checkoutRoot = path.join(path.dirname(resolvedLauncher), "..", "..", "..");
	const steps: SourceUpdateStep[] = [
		{ label: "Fetching", command: ["git", "fetch", "--tags", "origin"], cwd: checkoutRoot },
		{ label: "Fast-forwarding checkout", command: ["git", "merge", "--ff-only", "@{u}"], cwd: checkoutRoot },
		{ label: "Installing dependencies", command: ["bun", "install"], cwd: checkoutRoot },
		// Bun runs NO root lifecycle scripts on workspace installs (verified
		// empirically 2026-07-24: neither prepare nor postinstall fire), so the
		// gitignored build artifacts must be regenerated explicitly — a pulled
		// checkout keeps a STALE tool-views bundle otherwise, and a fresh one
		// has none and cannot boot.
		{
			label: "Regenerating build artifacts",
			command: ["bun", "--cwd=packages/collab-web", "run", "gen:tool-views"],
			cwd: checkoutRoot,
		},
		// The native addon is version-sentinel-checked at boot, so an advanced
		// checkout with the previous release's addon dies just like a missing
		// one. `ensure` is the single owner of provisioning (skip if current,
		// else prebuilt release download, else cargo build, else fail closed).
		{
			label: "Ensuring native addon",
			command: ["bun", "--cwd=packages/natives", "run", "ensure"],
			cwd: checkoutRoot,
		},
	];
	report(`Updating source checkout at ${checkoutRoot} to ${version}`);
	for (const step of steps) {
		report(`${step.label}...`);
		const { exitCode, stderr } = await exec(step);
		if (exitCode !== 0) {
			const detail = stderr.trim().length > 0 ? `: ${stderr.trim()}` : "";
			throw new Error(
				`${step.label} failed (\`${step.command.join(" ")}\` exited ${exitCode})${detail}. ` +
					sourceInstallUpdateGuidance(launcherPath),
			);
		}
	}
	// Every step exiting 0 proves the commands RAN, not that the checkout reached
	// the release. `git merge --ff-only @{u}` fast-forwards to whatever the branch
	// tracks, which is not necessarily the tag `update` went looking for: a user
	// on a feature branch, or on a fork whose upstream lags, ends up advanced but
	// still behind. Reporting "Updated to 1.0.38" there is exactly the silent
	// wrong-version success the installers' doctor gate closes, so read the
	// checkout back and refuse to claim a version it does not have.
	const actual = await readCheckoutVersion(checkoutRoot);
	if (actual === undefined) {
		throw new Error(
			`Could not read ${SOURCE_VERSION_FILE} in ${checkoutRoot} after updating, ` +
				`so the checkout's version is unverified. ` +
				sourceInstallUpdateGuidance(launcherPath),
		);
	}
	if (actual !== version) {
		throw new Error(
			`The checkout at ${checkoutRoot} is at ${actual}, not ${version}, after fast-forwarding. ` +
				`Its branch probably does not track the branch the ${version} release was cut from. ` +
				sourceInstallUpdateGuidance(launcherPath),
		);
	}
	// A version file says what the checkout claims, not that it runs. Every step
	// above can exit 0 and still leave a checkout that does not boot: `bun
	// install` can land a partial tree, the regen step writes an artifact nobody
	// loaded yet, and `natives ensure` stages an addon it never dlopens. The
	// binary path proves the same thing the same way; a source install is a
	// first-class consumer path and gets the same proof.
	report("Verifying the updated checkout runs...");
	const brokenReason = await probe(launcherPath, `The checkout at ${checkoutRoot}, now at ${version},`);
	if (brokenReason !== undefined) {
		throw new Error(`${brokenReason} ${sourceInstallUpdateGuidance(launcherPath)}`);
	}
	// Same reason as the binary path: the completion scripts on disk describe the
	// version the checkout just left. The launcher is what the installer put on
	// PATH, so it is what regenerates them.
	await refreshCompletionsForInstalledBinary(launcherPath, report);
	report(`Updated source checkout to ${version}. Restart ${APP_NAME} to run it.`);
}

/**
 * Install a specific release for the veyyon currently first in PATH.
 *
 * A binary install is updated by downloading the release binary and swapping it
 * in place. A source install (`install.sh --source`) is updated in its own
 * terms — fast-forward the checkout and reinstall dependencies — NEVER by a
 * binary swap, which would overwrite the in-checkout launcher (Law 10). This is
 * the single owner of that dispatch: both `veyyon update` and the automatic
 * startup update go through it, so they can never drift into updating by
 * different rules.
 *
 * `force` is accepted for API symmetry with callers (the rollback path passes
 * it); a binary swap is unconditional, so it does not change binary behavior.
 *
 * A successful move is recorded here, which is the only place that sees every
 * one of them. It used to be recorded by `rollbackToVersion` alone, so the
 * history held rollbacks and nothing else: an update that took you from 1.0.30
 * to 1.0.37 left no trace, and the picker offering to send you back had no way
 * to say where you came from. Update, the background auto-update and rollback
 * all move a version through this function, so recording here is what makes the
 * history mean "every version this install has been on" rather than "the times
 * you went backwards".
 *
 * A forced reinstall of the version already running is not a move and is not
 * recorded: a history of `1.0.37 -> 1.0.37` rows describes nothing and would
 * push the real moves out of view.
 */
export async function installRelease(
	version: string,
	force: boolean,
	report: UpdateReporter = CONSOLE_UPDATE_REPORTER,
	currentVersion: string = VERSION,
	historyPath: string = getUpdateHistoryPath(),
): Promise<void> {
	void force;
	const target = await resolveUpdateTarget();
	if (target.method === "source") {
		await updateViaSourceAt(target.path, version, report);
	} else {
		await updateViaBinaryAt(target.path, version, report);
	}
	if (version !== currentVersion) {
		await recordVersionMove({ from: currentVersion, to: version, at: new Date().toISOString() }, historyPath);
	}
}

/**
 * Why an install method cannot move to an arbitrary version.
 *
 * A binary install downloads the asset for the exact tag you name, so it moves
 * in both directions. A source install advances a git checkout with
 * `git merge --ff-only`, which by construction only goes FORWARD to whatever
 * the branch tracks: there is no ff-only path back to an older release, and
 * anything that could get there (a checkout of an old tag, a reset) would be
 * rewriting the user's own working tree, which an updater must never do.
 *
 * Returning the reason rather than a bare boolean is deliberate: the picker and
 * the CLI both have to TELL the user why, and a boolean forces each of them to
 * invent its own wording for the same fact.
 */
export function rollbackUnsupportedReason(method: UpdateMethod): string | undefined {
	if (method !== "source") return undefined;
	return (
		`This is a source install (\`install.sh --source\`), which updates by fast-forwarding its git checkout. ` +
		`Fast-forward only moves forward, so there is no supported way to roll it back to an older release. ` +
		`To run an older version, check it out yourself in the checkout, or reinstall the binary build with the ` +
		`install script and roll back from there.`
	);
}

/**
 * Whether this install can be rolled back at all.
 *
 * The `/settings` row exists only when the answer is yes: a row that opens a
 * picker and then refuses to install anything reads as a feature that is broken
 * rather than one that does not apply here, which is worse than no row.
 *
 * A FAILURE to resolve the install method answers yes, deliberately. The
 * alternative is hiding a working feature because a lookup went wrong, and a
 * silently missing row gives the operator nothing to act on; attempting the
 * rollback instead surfaces the real reason loudly (Law 10).
 */
export async function isRollbackSupported(installedMethod?: () => Promise<UpdateMethod>): Promise<boolean> {
	try {
		const method = installedMethod ? await installedMethod() : (await resolveUpdateTarget()).method;
		return rollbackUnsupportedReason(method) === undefined;
	} catch {
		return true;
	}
}

/** One recorded move between versions. */
export interface UpdateHistoryEntry {
	from: string;
	to: string;
	/** ISO 8601, so the record is readable without knowing the writer's locale. */
	at: string;
}

/**
 * Append a version move to the history file.
 *
 * Best-effort by design and the ONE place that is true of: history is an
 * annotation on the picker, so failing the whole rollback because a note could
 * not be filed would trade a working install for a tidy log. The failure is
 * logged rather than swallowed, so it is visible in `--debug` rather than
 * silent (Law 10 draws the line at hiding it, not at continuing).
 */
export async function recordVersionMove(
	entry: UpdateHistoryEntry,
	historyPath: string = getUpdateHistoryPath(),
): Promise<void> {
	try {
		let entries: UpdateHistoryEntry[] = [];
		try {
			const parsed: unknown = JSON.parse(await Bun.file(historyPath).text());
			if (Array.isArray(parsed)) entries = parsed as UpdateHistoryEntry[];
		} catch (err) {
			// A missing file is the normal first move. A CORRUPT one is not, and
			// starting over silently would erase a record somebody may be reading;
			// say so, then start a fresh list rather than refusing to record forever.
			if (!isEnoent(err))
				logger.warn(`update history at ${historyPath} was unreadable, starting a new one: ${errorMessage(err)}`);
		}
		entries.push(entry);
		await fs.promises.mkdir(path.dirname(historyPath), { recursive: true });
		await Bun.write(historyPath, `${JSON.stringify(entries, null, 2)}\n`);
	} catch (err) {
		logger.warn(`could not record the version move to ${historyPath}: ${errorMessage(err)}`);
	}
}

/** Every recorded version move, oldest first; empty when nothing is recorded yet. */
export async function readVersionMoves(historyPath: string = getUpdateHistoryPath()): Promise<UpdateHistoryEntry[]> {
	try {
		const parsed: unknown = JSON.parse(await Bun.file(historyPath).text());
		return Array.isArray(parsed) ? (parsed as UpdateHistoryEntry[]) : [];
	} catch (err) {
		if (!isEnoent(err)) logger.warn(`update history at ${historyPath} was unreadable: ${errorMessage(err)}`);
		return [];
	}
}

/**
 * Move this install to a specific published version, forward or back.
 *
 * Rollback is the same install as an update, aimed at a version you name, so it
 * goes through {@link installRelease} rather than repeating the method dispatch
 * — one owner for "how does this install change version", whichever direction it
 * moves.
 *
 * Two things are refused rather than performed. A method that cannot pin a
 * version fails with {@link rollbackUnsupportedReason}, never by installing
 * latest and reporting success, which is the exact silent-wrong-version outcome
 * the updater's verification exists to prevent. And rolling back to the version
 * already running is refused as a no-op instead of re-downloading, because a
 * reinstall that changes nothing but prints "done" reads as a rollback that
 * worked when the user asked for the wrong version.
 */
export async function rollbackToVersion(
	version: string,
	report: UpdateReporter = CONSOLE_UPDATE_REPORTER,
	currentVersion: string = VERSION,
	historyPath: string = getUpdateHistoryPath(),
): Promise<void> {
	if (!isValidSemver(version)) {
		throw new Error(`${JSON.stringify(version)} is not a version number — expected something like 1.2.3`);
	}
	if (version === currentVersion) {
		throw new Error(
			`Already running ${currentVersion}. Pick a different version, or run \`${APP_NAME} rollback --list\` to see what is published.`,
		);
	}
	const target = await resolveUpdateTarget();
	const unsupported = rollbackUnsupportedReason(target.method);
	if (unsupported) throw new Error(unsupported);

	report(`Moving from ${currentVersion} to ${version}...`);
	// installRelease records the move: it is the one function every version change
	// goes through, so recording here as well would file each rollback twice.
	await installRelease(version, true, report, currentVersion, historyPath);
	report(`Now on ${version}. Restart ${APP_NAME} to run it.`);
}

/**
 * Outcome of an automatic update attempt.
 *
 * `updated` means the new version is on disk and takes effect on the next
 * launch, not in the running process. `failed` carries the reason so the caller
 * can show it: an update that quietly does nothing would leave you pinned to an
 * old version with no way to notice (Law 10).
 */
export type AutoUpdateOutcome =
	| { status: "up-to-date" }
	| { status: "updated"; version: string }
	| { status: "failed"; version?: string; error: string }
	| { status: "skipped"; version: string; reason: AutoUpdateSkipReason };

/**
 * Why a background update did not attempt an install.
 *
 * `another-process` means a concurrently launched session is already installing
 * that version. `recent-failure` means installing this same version failed
 * recently enough that retrying now would only reproduce it; see
 * {@link AUTO_UPDATE_FAILURE_COOLDOWN_MS}. `source-install` means veyyon runs
 * from a source checkout (`install.sh --source`), which updates with `git pull`,
 * not a binary swap — attempting one would overwrite its launcher, so the
 * background updater leaves it alone instead of fail-looping.
 */
export type AutoUpdateSkipReason = "another-process" | "recent-failure" | "source-install";

/**
 * Update to the latest release without printing anything or exiting.
 *
 * {@link runUpdateCommand} is the interactive front end for the same work; this
 * is the form a running session can call, where `console.log` would corrupt the
 * TUI and `process.exit` would kill the user's session.
 *
 * Two things make this safe to run on every launch rather than only on demand.
 * The install runs under a cross-process lock, so opening several terminals at
 * once installs once instead of racing several package-manager writes at the
 * same binary. And a failure is recorded, so a machine that cannot install at
 * all reports the reason and then backs off instead of failing loudly on every
 * launch forever.
 *
 * `statePath` names the file holding that failure record and acting as the lock
 * target. It defaults to the per-user state file and exists as a parameter so a
 * test can point the whole mechanism at a temporary directory instead of the
 * real one.
 */
export async function runAutoUpdate(
	currentVersion: string = VERSION,
	knownRelease?: ReleaseInfo,
	statePath: string = getAutoUpdateStatePath(),
	resolveInstalledMethod: () => UpdateMethod | undefined = defaultInstalledMethod,
	// Injectable for the same reason `runUpdateCommand` takes one: the lock this
	// function holds is only meaningful if two callers can be raced against it,
	// and a race test cannot download a release twice.
	install: (version: string, reporter: typeof SILENT_UPDATE_REPORTER) => Promise<void> = (version, reporter) =>
		installRelease(version, false, reporter),
): Promise<AutoUpdateOutcome> {
	let release: ReleaseInfo;
	if (knownRelease) {
		// The startup check already asked the registry. Reusing its answer keeps a
		// launch to one round trip instead of two.
		release = knownRelease;
	} else {
		try {
			release = await getLatestRelease();
		} catch (err) {
			return { status: "failed", error: errorMessage(err) };
		}
	}
	if (!isNewerVersion(release.version, currentVersion)) {
		return { status: "up-to-date" };
	}

	// A source install updates via `git pull`, not a binary swap: a background
	// self-update would overwrite its launcher, so skip it loudly instead of
	// fail-looping on every launch. Only a confirmed source launcher skips; every
	// other install (including an unresolved path) takes the normal binary path.
	if (resolveInstalledMethod() === "source") {
		logger.info("Skipping automatic update: veyyon is installed from source (update with git pull)", {
			version: release.version,
		});
		return { status: "skipped", version: release.version, reason: "source-install" };
	}

	const state = await readAutoUpdateState(statePath);
	if (!shouldAttemptAutoUpdate(state, release.version, Date.now())) {
		logger.warn("Skipping automatic update: installing this version failed recently", {
			version: release.version,
			error: state.failedError,
			retryAfterMs: AUTO_UPDATE_FAILURE_COOLDOWN_MS,
		});
		return { status: "skipped", version: release.version, reason: "recent-failure" };
	}

	const attempt = await tryWithFileLock(
		statePath,
		async (): Promise<AutoUpdateOutcome> => {
			try {
				// Silent: this runs under a live TUI, where any console write corrupts the frame.
				await install(release.version, SILENT_UPDATE_REPORTER);
			} catch (err) {
				const error = errorMessage(err);
				await recordAutoUpdateFailure(release.version, error, statePath);
				return { status: "failed", version: release.version, error };
			}
			await clearAutoUpdateFailure(statePath);
			return { status: "updated", version: release.version };
		},
		{ staleMs: AUTO_UPDATE_LOCK_STALE_MS },
	);
	if (!attempt.acquired) {
		logger.info("Skipping automatic update: another session is already installing it", {
			version: release.version,
		});
		return { status: "skipped", version: release.version, reason: "another-process" };
	}
	return attempt.value;
}

/**
 * Performs the install once `runUpdateCommand` has decided one should happen.
 * Injectable so the dispatch can be tested without downloading a release or
 * running git against a real checkout; production always uses
 * {@link installRelease}, which owns the binary-vs-source decision.
 */
export type ReleaseInstaller = (version: string, force: boolean) => Promise<void>;

/**
 * Run the update command.
 */
export async function runUpdateCommand(
	opts: { force: boolean; check: boolean },
	install: ReleaseInstaller = installRelease,
): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));

	// Check for updates
	let release: ReleaseInfo;
	try {
		release = await getLatestRelease();
	} catch (err) {
		// err.message, not `${err}`: the latter stringifies as "Error: …" and
		// produces a doubled "Failed to check for updates: Error: Failed to …".
		console.error(chalk.red(`Failed to check for updates: ${errorMessage(err)}`));
		process.exit(1);
	}

	const comparison = compareSemver(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else if (opts.check) {
		// Up to date, but --force was passed alongside --check. Check mode installs
		// nothing, so report what --force WOULD do rather than announce a reinstall
		// that is not going to happen ("Forcing reinstall of X" then a silent exit
		// read as a broken command).
		console.log(chalk.yellow(`Up to date at ${release.version}; --force would reinstall it`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		// Just check, don't install
		return;
	}

	// installRelease is the single owner of the install-method dispatch: a binary
	// install gets a binary swap, a source checkout gets updateViaSourceAt.
	//
	// This used to return early with the manual "cd in and run git pull" advice
	// whenever the install was a source one. That advice is what stranded a user
	// on a stale checkout in the first place (following it skips the dependency
	// reinstall and the build-artifact regen, so the checkout does not even
	// boot), and updateViaSourceAt exists precisely to do all of it. Returning
	// here made that code unreachable from the only command a user runs, so the
	// fix shipped and nobody could get at it.
	try {
		await install(release.version, opts.force);
	} catch (err) {
		// errorMessage(err), not `${err}`: the latter stringifies as "Error: …"
		// and doubles the prefix into "Update failed: Error: …".
		console.error(chalk.red(`Update failed: ${errorMessage(err)}`));
		// A failed update can leave the install on a version the user did not
		// choose, and the way back shipped in the same release as the way forward
		// without either command ever naming the other. Said only where it applies:
		// a source install cannot be rolled back, and offering it there would send
		// the user to a command that refuses.
		if (await isRollbackSupported()) {
			console.error(
				chalk.dim(`To return to a version that worked, run \`${APP_NAME} rollback\` and pick it from the list.`),
			);
		}
		process.exit(1);
	}
	// `rollback` ends by printing the changelog for the version it moved you to,
	// and `update` — the command that moves almost everybody — printed nothing at
	// all about what changed. Same fact, same single URL owner, so the two now
	// close the same way.
	console.log(chalk.dim(`Changelog for ${release.version}: ${changelogUrlForVersion(release.version)}`));
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check     Check for updates without installing
  -f, --force     Force reinstall even if up to date
  -l, --plugins   Update installed plugins

${chalk.bold("Examples:")}
  ${APP_NAME} update              Update to latest version
  ${APP_NAME} update --check      Check if updates are available
  ${APP_NAME} update --force      Force reinstall
  ${APP_NAME} update -l           Update installed plugins

${chalk.bold("Going back:")}
  ${APP_NAME} rollback            Pick any published version, forward or back
  ${APP_NAME} rollback --list     Print every published version and dates
`);
}
