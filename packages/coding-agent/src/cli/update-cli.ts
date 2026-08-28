/** Update CLI command handler. */
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
	isCompiledBinary,
	isEnoent,
	isNewerVersion,
	isValidSemver,
	logger,
	readPipeText,
	removeTempPath,
	stripWindowsExtendedLengthPathPrefix,
	tryWithFileLock,
	VERSION,
	withFileLock,
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
/** GitHub REST base for {@link REPO}. */
const GITHUB_RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
/** Web endpoint redirecting to the latest release tag page. */
const GITHUB_LATEST_RELEASE_URL = `https://github.com/${REPO}/releases/latest`;
/** User-Agent header for GitHub requests. */
const GITHUB_USER_AGENT = `${APP_NAME}-updater`;
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const BINARY_UPDATE_LOCK_RETRY_MS = 100;
/** Timeout for checksum sidecar fetch. */
const CHECKSUM_TIMEOUT_MS = 30_000;

/** In-checkout launcher tail path indicating a source install. */
const SOURCE_LAUNCHER_TAIL = ["packages", "coding-agent", "scripts", APP_NAME].join("/");

export interface ReleaseInfo {
	tag: string;
	version: string;
}

/** Non-fatal follow-up work that needs operator attention after an install. */
export interface InstallReleaseResult {
	warnings: string[];
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
	/** Why verification failed if not due to version mismatch. */
	reason?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	/** Verifies that the installed binary reports the expected version. */
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

/** Returns the canonical realpath behind `p`, or undefined on error. */
function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

/** How veyyon on PATH was installed, determining update strategy. */
export type UpdateMethod = "binary" | "source";

type UpdateTarget = { method: "binary"; path: string } | { method: "source"; path: string };

/** Classify an on-PATH executable path as a binary or source install. */
/** Check if the given path ends with the source launcher tail. */
function endsWithSourceLauncher(p: string): boolean {
	const normalized = p.replace(/\\/g, "/");
	return normalized.endsWith(SOURCE_LAUNCHER_TAIL) || normalized.endsWith(`${SOURCE_LAUNCHER_TAIL}.cmd`);
}

/** Max bytes to inspect from a potential forwarding shim. */
const SHIM_READ_LIMIT = 4096;

/** Read prefix bytes of a shim file. */
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

/** Find referenced script paths within a candidate shim. */
function shimForwardTargets(shimBody: string): string[] {
	const targets: string[] = [];
	for (const match of shimBody.matchAll(/"([^"\r\n]+)"/g)) targets.push(match[1] as string);
	for (const match of shimBody.matchAll(/'([^'\r\n]+)'/g)) targets.push(match[1] as string);
	for (const match of shimBody.matchAll(/^\s*exec\s+([^\s"'\r\n]+)/gm)) targets.push(match[1] as string);
	return targets;
}

/** Check if a file path may be a script/batch forwarding shim. */
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
	// On Windows that shim is what `bun run setup` itself writes; on POSIX
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

/** Resolve how the veyyon executable on PATH was installed. */
function defaultInstalledMethod(): UpdateMethod | undefined {
	const veyyonPath = resolveVeyyonPath();
	return veyyonPath ? resolveUpdateMethod(veyyonPath) : undefined;
}

/** Look up the latest published release from GitHub Releases. */
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
			// The deadline the caller asked for. This was `new AbortController().signal`: a
			// signal nothing ever aborts, so `timeoutMs` reached the error message and nothing
			// else, and a connection that accepts and then stalls hung this call forever. That
			// is the one thing this function documents it must never do, and it is on the
			// startup path, so a captive portal or a black-holed route froze the launch rather
			// than falling back to "could not check".
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

/** One published release metadata entry. */
export interface ReleaseListing extends ReleaseInfo {
	publishedAt?: string;
}

/** Page size for GitHub release listings. */
const RELEASES_PAGE_SIZE = 100;

/** Max pages to walk when fetching releases. */
const RELEASES_MAX_PAGES = 10;

/** Fetch all published releases, newest first. */
export async function getAllReleases(timeoutMs: number = RELEASE_METADATA_TIMEOUT_MS): Promise<ReleaseListing[]> {
	const releases: ReleaseListing[] = [];
	const seen = new Set<string>();
	for (let page = 1; page <= RELEASES_MAX_PAGES; page++) {
		const url = `${GITHUB_RELEASES_API}?per_page=${RELEASES_PAGE_SIZE}&page=${page}`;
		const batch = await fetchReleasePage(url, timeoutMs);
		if (batch.rawCount === 0) break;
		for (const entry of batch.releases) {
			// A tag can legitimately repeat across pages when a release is published
			// mid-walk and shifts the pagination window; keeping the first sighting
			// keeps the list a set of versions rather than a list of sightings.
			if (seen.has(entry.version)) continue;
			seen.add(entry.version);
			releases.push(entry);
		}
		// Pagination is governed by the GitHub page size, not by the number left
		// after drafts, prereleases and malformed tags are filtered out.
		if (batch.rawCount < RELEASES_PAGE_SIZE) break;
	}

	if (releases.length === 0) {
		throw new Error(
			`No published releases found for ${REPO} — a draft or prerelease does not count, and an empty list here means there is nothing to roll back to`,
		);
	}

	releases.sort((a, b) => compareSemver(b.version, a.version));
	return releases;
}

/** One raw GitHub page plus its filtered installable releases. */
async function fetchReleasePage(
	url: string,
	timeoutMs: number,
): Promise<{ releases: ReleaseListing[]; rawCount: number }> {
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
	const releases = data.flatMap(entry => {
		const record = entry as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown };
		if (record.draft === true || record.prerelease === true) return [];
		const tag = typeof record.tag_name === "string" ? record.tag_name : "";
		const version = bareVersion(tag);
		if (!isValidSemver(version)) return [];
		const publishedAt = typeof record.published_at === "string" ? record.published_at : undefined;
		return [{ tag: tag.startsWith("v") ? tag : `v${version}`, version, publishedAt }];
	});
	return { releases, rawCount: data.length };
}

/** Get the binary name for the current platform. */
export function getBinaryName(
	platform: NodeJS.Platform = process.platform,
	arch: NodeJS.Architecture = process.arch,
): string {
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

	if (platform === "win32" && arch === "arm64") {
		throw new Error(
			"Unsupported platform: Windows arm64 releases are not published. Install the Windows x64 build under emulation.",
		);
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

/** Format binary download failure details into a user-facing message. */
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

export { parseSha256Sidecar };

/** Verify a downloaded release binary against its published `.sha256` sidecar. */
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

/** Information about the current executable and installation location. */
export interface InstallLocation {
	/** Whether this process IS the shipped binary rather than bun running sources. */
	compiled: boolean;
	/** The executable this process is running, meaningful only when `compiled`. */
	execPath: string;
	/** What the command name resolves to in PATH, if anything. */
	onPath: string | undefined;
}

export function readInstallLocation(): InstallLocation {
	return { compiled: isCompiledBinary(), execPath: process.execPath, onPath: $which(APP_NAME) ?? undefined };
}

/** Determine the target file path to be replaced during binary update. */
export function chooseUpdateTargetPath(
	where: InstallLocation,
	// Taken as an argument for the same reason `stripWindowsExtendedLengthPathPrefix`
	// takes one: the prefix it removes only ever appears on Windows, and a contract that
	// can only be checked on Windows is checked by nobody.
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (where.compiled) {
		const running = stripWindowsExtendedLengthPathPrefix(where.execPath, platform).trim();
		if (running.length > 0) return running;
	}
	return where.onPath;
}

function resolveVeyyonPath(): string | undefined {
	return chooseUpdateTargetPath(readInstallLocation());
}

/** Run the binary at `binPath` and verify it reports `expectedVersion`. */
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
		return { ok: false, path: binPath, reason: describeUnrunnableBinary(binPath, undefined, errorMessage(err)) };
	}
}

/** Describe why an installed binary failed to execute. */
function describeUnrunnableBinary(binPath: string, exitCode: number | undefined, stderr: string): string {
	const said = stderr.trim();
	const what = exitCode === undefined ? "could not be started" : `exited ${exitCode}`;
	const because = said === "" ? "It printed nothing." : `It said: ${said.slice(0, 400)}`;
	return `${binPath} ${what} when asked for its version. ${because}`;
}

/** Probe function to test if installed search functionality works. */
export type SearchProbe = (binPath: string, label: string) => Promise<string | undefined>;

/** Test search functionality on an installed binary. */
export async function probeSearchWorks(binPath: string, label: string): Promise<string | undefined> {
	try {
		await fs.promises.access(binPath, fs.constants.X_OK);
	} catch {
		return `${label} is missing or not executable at ${binPath}.`;
	}
	const help = await $`${binPath} grep --help`.quiet().nothrow();
	if (help.exitCode !== 0) {
		// "This build has no `grep`" was assumed from the exit code alone, which is
		// also what a binary whose native addon fails to load on any real subcommand
		// produces — the exact failure this probe exists to catch, silently reported
		// as a working install (Law 10). Ask the binary a question every build can
		// answer. If its own top-level help fails too, nothing is wrong with the
		// SUBCOMMAND and the install is broken; only when top-level help works is
		// "an older release that predates `grep`" the honest reading.
		const topLevel = await $`${binPath} --help`.quiet().nothrow();
		if (topLevel.exitCode !== 0) {
			const said = `${help.stdout.toString()}${help.stderr.toString()}`.trim();
			return (
				`${label} could not run \`grep --help\` (exit ${help.exitCode}) and could not run ` +
				`\`--help\` either (exit ${topLevel.exitCode}), so the install is broken rather than ` +
				`older than the \`grep\` subcommand. Output was: ${said === "" ? "nothing" : said}`
			);
		}
		return undefined;
	}

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

/** Verify that the installed binary is fully functional. */
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

/** Callback for reporting update progress. */
export type UpdateReporter = (line: string) => void;

export const CONSOLE_UPDATE_REPORTER: UpdateReporter = line => {
	console.log(line);
};

export const SILENT_UPDATE_REPORTER: UpdateReporter = () => {};

function printVerifiedVersion(expectedVersion: string, report: UpdateReporter): void {
	// `theme` is `export var theme: Theme` and holds `undefined` until `initTheme()`
	// assigns it, so reading `.status` throws when nothing has loaded a theme. The
	// shipped CLI always has one; an SDK embedder driving this flow directly does
	// not, and this line runs AFTER the binary was replaced and verified — a
	// TypeError here would report a finished update as a failed one and invite a
	// caller to retry a swap that already happened. Plain `✓` is what every
	// built-in theme resolves `status.success` to anyway.
	const mark = typeof theme === "undefined" ? "✓" : theme.status.success;
	report(chalk.green(`\n${mark} Updated to ${expectedVersion}`));
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

/** Return symlink target if `filePath` is a symlink, else null. */
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

/** Best-effort file removal that ignores missing files or deletion errors. */
async function removeFileBestEffort(filePath: string): Promise<boolean> {
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

/** Best-effort removal of stale binary-update backup files. */
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
		// Legacy "<base>.bak" → empty middle; older
		// "<base>.<timestamp>.<pid>.bak" → dot-separated numeric run; current
		// "<base>.<attempt UUID>.bak" → one UUID. Anything else is unrelated.
		const middle = entry.slice(base.length + 1, entry.length - ".bak".length);
		const isNumericAttempt = /^\d+(\.\d+)*$/.test(middle);
		const isUuidAttempt = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(middle);
		if (middle.length > 0 && !isNumericAttempt && !isUuidAttempt) continue;
		await removeFileBestEffort(path.join(dir, entry));
	}
}

/** Return path to the owner receipt sidecar. */
function ownerReceiptPathFor(artifactPath: string): string {
	return path.join(path.dirname(artifactPath), `.${path.basename(artifactPath)}.veyyon-owner`);
}

/** Streamed so a ~100 MB executable is hashed without being held in memory. */
async function sha256OfFile(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

/** Update ownership receipt sidecar with current binary details. */
export async function restampOwnerReceipt(artifactPath: string, knownIdentity?: string): Promise<boolean> {
	const receiptPath = ownerReceiptPathFor(artifactPath);
	// Staged then renamed under the same `.<name>.veyyon-owner.<pid>` name the
	// installers use, so an interrupted write leaves a temp the install suites
	// already fail on rather than a new shape nothing watches.
	const staging = `${receiptPath}.${process.pid}`;
	try {
		// The caller usually already hashed these exact bytes while they were
		// staged. Re-hashing here would read ~150MB a second time to learn what it
		// was told, and would do it in the one window where the file has just been
		// renamed and an antivirus scanner is most likely to hold it open.
		const identity = knownIdentity ?? `file sha256:${await sha256OfFile(artifactPath)}`;
		await Bun.write(staging, `veyyon-installer-v2\n${identity}\n`);
		await fs.promises.rename(staging, receiptPath);
		// The real receipt now describes the file, so the provisional one has
		// nothing left to vouch for.
		await removeFileBestEffort(pendingOwnerReceiptPathFor(artifactPath));
		return true;
	} catch (err) {
		await removeFileBestEffort(staging);
		logger.warn(
			`Could not update the installer ownership receipt at ${receiptPath}: ${errorMessage(err)}. ` +
				`It still describes the previous binary, so the installer will refuse to replace or remove ` +
				`${artifactPath} until you re-run the installer.`,
		);
		return false;
	}
}

/** Return path to the pending owner receipt sidecar. */
function pendingOwnerReceiptPathFor(artifactPath: string): string {
	return `${ownerReceiptPathFor(artifactPath)}.pending`;
}

/** Record pending installation receipt before replacing binary. */
async function markOwnerReceiptPending(artifactPath: string, identity: string): Promise<void> {
	const pendingPath = pendingOwnerReceiptPathFor(artifactPath);
	const staging = `${pendingPath}.${process.pid}`;
	try {
		await Bun.write(staging, `veyyon-installer-v2\n${identity}\n`);
		await fs.promises.rename(staging, pendingPath);
	} catch (err) {
		await removeFileBestEffort(staging);
		throw new Error(
			`Could not record the pending ownership of ${artifactPath} at ${pendingPath} (${errorMessage(err)}), ` +
				`so an interrupted update could leave a binary the installer cannot account for. Not replacing it.`,
			{ cause: err },
		);
	}
}

/** Atomically replace installed binary, rolling back on failure. */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	let replacementInstalled = false;
	let pendingReceiptWritten = false;
	try {
		// Refuse an empty or missing download BEFORE disturbing the live binary.
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
		const linkTarget = await readLinkIfSymlink(options.targetPath);
		if (linkTarget !== null) {
			throw new Error(
				`${options.targetPath} is a symlink to ${linkTarget}, so updating would replace your link with a ` +
					`downloaded binary and leave nothing pointing at ${linkTarget}. Update that install directly, or ` +
					`replace the symlink with a real binary first (rm ${options.targetPath}) and re-run the update.`,
			);
		}

		// Hashed while it is still staged, which is the only moment the bytes are
		// certainly readable at a pathname nothing else is competing for. The same
		// identity serves the pending receipt below and the real one after the swap.
		const incoming = `file sha256:${await sha256OfFile(options.tempPath)}`;

		// Preserve the old inode before the atomic replacement. A hard link is
		// constant-time and keeps the exact executable bytes without ever removing
		// the PATH entry. Filesystems that reject hard links fall back to an
		// exclusive copy, which is still completed before the live path changes.
		try {
			await fs.promises.link(options.targetPath, options.backupPath);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (!["EACCES", "EPERM", "ENOTSUP", "EXDEV"].includes(code ?? "")) throw err;
			await fs.promises.copyFile(options.targetPath, options.backupPath, fs.constants.COPYFILE_EXCL);
		}
		backupReady = true;

		// Last thing before the binary moves: from here until the real receipt is
		// written, this sidecar is the only record that the file at the target path
		// is one of ours.
		await markOwnerReceiptPending(options.targetPath, incoming);
		pendingReceiptWritten = true;

		// rename(temp, target) replaces the directory entry atomically. A hard
		// kill can leave the old target or the new target, but never no target.
		await fs.promises.rename(options.tempPath, options.targetPath);
		replacementInstalled = true;

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		// Before the backup goes: the receipt beside the target still describes the
		// binary that was just replaced, and every ownership decision the installer
		// makes about this path reads it. Clears the pending receipt on success.
		await restampOwnerReceipt(options.targetPath, incoming);

		backupReady = false;
		await removeFileBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady && replacementInstalled) {
			try {
				// The backup replaces the rejected binary atomically too. Never
				// unlink the live path first, even on a rollback failure.
				await fs.promises.rename(options.backupPath, options.targetPath);
			} catch (rollbackErr) {
				await removeFileBestEffort(options.tempPath);
				throw new Error(
					`${APP_NAME} update failed and the automatic rollback could not restore the previous binary ` +
						`(${errorMessage(rollbackErr)}). Your previous ${APP_NAME} is intact at ${options.backupPath} — ` +
						`move it back to ${options.targetPath} to recover.`,
					{ cause: err },
				);
			}
			// The rename succeeded, so the path holds the PREVIOUS binary again and
			// the receipt has to say so. A rollback that restored the old binary and
			// left a receipt describing the new one would be the same defect with the
			// arrow reversed, on the path nobody exercises by hand. No known identity
			// here: these are the retired binary's bytes, which were never hashed.
			await restampOwnerReceipt(options.targetPath);
			pendingReceiptWritten = false;
		} else if (backupReady) {
			// The atomic replacement itself failed, so the original target is
			// still live and this extra recovery link/copy is no longer needed.
			await removeFileBestEffort(options.backupPath);
		}
		// A pending receipt describing bytes that never arrived is harmless — it
		// matches no file, so it grants nothing — but it is litter, and a later
		// install reporting a "pending" record for a binary it is not about would
		// only confuse whoever is reading the directory.
		if (pendingReceiptWritten) await removeFileBestEffort(pendingOwnerReceiptPathFor(options.targetPath));
		await removeFileBestEffort(options.tempPath);
		throw err;
	}
}

/** Download release binary and atomically replace executable at `targetPath`. */
export async function updateViaBinaryAt(
	targetPath: string,
	expectedVersion: string,
	report: UpdateReporter,
): Promise<InstallReleaseResult> {
	const binaryName = getBinaryName();
	const tag = `v${expectedVersion}`;
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;

	// Every download gets its own same-directory pathname. Besides preserving
	// same-filesystem atomic rename, this prevents one forced update from
	// truncating or cleaning up another update's live download.
	const attemptId = crypto.randomUUID();
	const tempPath = `${targetPath}.${attemptId}.new`;
	const backupPath = `${targetPath}.${attemptId}.bak`;
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
		// A mid-download failure (network drop) leaves a partial attempt file
		// behind before reaching replaceBinaryForUpdate, whose catch
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
		// security finding and must reach the terminal verbatim, never be displaced
		// by a failure to delete the file it is about.
		await removeFileBestEffort(tempPath);
		throw err;
	}
	// Confirm the integrity check passed, matching install.sh's "verified sha256".
	// A security control that only speaks up on failure leaves the user unsure it
	// ran at all; say so on success too. Silent under the auto-update reporter.
	report(chalk.dim("Checksum verified"));

	// Only the mutation phase needs serialization: downloads remain concurrent
	// and isolated at their unique paths, while backup, atomic replacement,
	// rollback, stale-backup sweeping, and completion refresh observe one
	// installed version at a time. The lock path is derived from targetPath, so
	// independent installs do not block one another.
	try {
		return await withFileLock(
			targetPath,
			async () => {
				// Reclaim backups from earlier updates whose owning process has since
				// exited. Holding the replacement lock means this can never sweep
				// another live attempt's rollback copy.
				//
				await sweepStaleBackups(targetPath);
				report(chalk.dim("Installing update..."));
				await replaceBinaryForUpdate({
					targetPath,
					tempPath,
					backupPath,
					expectedVersion,
					// Verify the file this update just wrote, not whatever PATH resolves now.
					verifyInstalledVersion: version => verifyBinaryUsable(targetPath, version),
				});
				// The completion scripts on disk describe the version we just replaced, so
				// every subcommand and flag this release adds would be missing from tab
				// completion until the user re-ran the installer. Regenerate from the binary
				// that was just installed.
				const completionResult = await refreshCompletionsForInstalledBinary(targetPath, report);
				printVerifiedVersion(expectedVersion, report);
				report(chalk.dim(`Restart ${APP_NAME} to use the new version`));
				return { warnings: completionResult.failed.map(formatCompletionRefreshWarning) };
			},
			{
				staleMs: AUTO_UPDATE_LOCK_STALE_MS,
				retries: Math.ceil(BINARY_DOWNLOAD_TIMEOUT_MS / BINARY_UPDATE_LOCK_RETRY_MS),
				retryDelayMs: BINARY_UPDATE_LOCK_RETRY_MS,
			},
		);
	} catch (err) {
		// Lock acquisition can fail before replaceBinaryForUpdate owns cleanup.
		// Removing only this attempt's unique staging cannot disturb a contender.
		await removeFileBestEffort(tempPath);
		throw err;
	}
}

/** Return PowerShell completion file targets on Windows. */
export async function windowsCompletionTargets(): Promise<CompletionTarget[]> {
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

/** Format completion refresh failure into an operator warning. */
function formatCompletionRefreshWarning(failure: CompletionRefreshResult["failed"][number]): string {
	return (
		`Could not refresh the shell completion at ${failure.filePath}: ${failure.reason}\n` +
		"It still describes the previous version. Re-run the installer to rewrite it."
	);
}

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
		report(chalk.yellow(`Warning: ${formatCompletionRefreshWarning(failure)}`));
	}
	return result;
}

/** Guidance shown when a source checkout cannot be updated automatically. */
export function sourceInstallUpdateGuidance(launcherPath: string): string {
	return (
		`${APP_NAME} is installed from source (its launcher is ${launcherPath}). ` +
		`Update the checkout manually: cd into it and run \`git pull && bun install\`.`
	);
}

/** Path to the version authority file in a source checkout. */
export const SOURCE_VERSION_FILE = "packages/coding-agent/package.json";

/** Reads the version of a source checkout. */
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

/** Result of executing a source update step. */
export interface SourceUpdateStepResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type SourceUpdateExec = (step: SourceUpdateStep) => Promise<SourceUpdateStepResult>;

const defaultSourceUpdateExec: SourceUpdateExec = async step => {
	const proc = Bun.spawn(step.command, { cwd: step.cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		readPipeText(proc.stdout),
		readPipeText(proc.stderr),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
};

/** Update a source install in place via git pull and dependency reinstall. */
export async function updateViaSourceAt(
	launcherPath: string,
	version: string,
	report: UpdateReporter = CONSOLE_UPDATE_REPORTER,
	exec: SourceUpdateExec = defaultSourceUpdateExec,
	readCheckoutVersion: CheckoutVersionReader = defaultReadCheckoutVersion,
	probe: SearchProbe = probeSearchWorks,
): Promise<InstallReleaseResult> {
	// launcher = <checkout>/packages/coding-agent/scripts/veyyon
	const resolvedLauncher = tryRealpath(launcherPath) ?? launcherPath;
	const checkoutRoot = path.join(path.dirname(resolvedLauncher), "..", "..", "..");
	const stepError = (step: SourceUpdateStep, result: SourceUpdateStepResult): Error => {
		const detail = result.stderr.trim().length > 0 ? `: ${result.stderr.trim()}` : "";
		return new Error(
			`${step.label} failed (\`${step.command.join(" ")}\` exited ${result.exitCode})${detail}. ` +
				sourceInstallUpdateGuidance(launcherPath),
		);
	};

	// A hard reset is safe only after proving the tracked tree and index are
	// clean. Untracked files are deliberately ignored: Git refuses a merge that
	// would overwrite one, and reset --hard does not delete them.
	const cleanlinessStep: SourceUpdateStep = {
		label: "Checking source checkout",
		command: ["git", "status", "--porcelain", "--untracked-files=no"],
		cwd: checkoutRoot,
	};
	report(`Updating source checkout at ${checkoutRoot} to ${version}`);
	report(`${cleanlinessStep.label}...`);
	const cleanliness = await exec(cleanlinessStep);
	if (cleanliness.exitCode !== 0) throw stepError(cleanlinessStep, cleanliness);
	if (cleanliness.stdout.trim().length > 0) {
		throw new Error(
			`The source checkout at ${checkoutRoot} has tracked or staged changes, so it cannot be updated safely. ` +
				`Commit or move those changes, then retry. ${sourceInstallUpdateGuidance(launcherPath)}`,
		);
	}

	const revisionStep: SourceUpdateStep = {
		label: "Recording current revision",
		command: ["git", "rev-parse", "--verify", "HEAD"],
		cwd: checkoutRoot,
	};
	report(`${revisionStep.label}...`);
	const revision = await exec(revisionStep);
	if (revision.exitCode !== 0) throw stepError(revisionStep, revision);
	const previousRevision = revision.stdout.trim();
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(previousRevision)) {
		throw new Error(
			`Could not record the current Git revision in ${checkoutRoot}; got ${JSON.stringify(previousRevision)}. ` +
				`Nothing was changed. ${sourceInstallUpdateGuidance(launcherPath)}`,
		);
	}

	const updateSteps: SourceUpdateStep[] = [
		{ label: "Fetching", command: ["git", "fetch", "--tags", "origin"], cwd: checkoutRoot },
		{ label: "Fast-forwarding checkout", command: ["git", "merge", "--ff-only", "@{u}"], cwd: checkoutRoot },
		{ label: "Installing dependencies", command: ["bun", "install"], cwd: checkoutRoot },
		{
			label: "Regenerating build artifacts",
			command: ["bun", "--cwd=packages/collab-web", "run", "gen:tool-views"],
			cwd: checkoutRoot,
		},
		{
			label: "Ensuring native addon",
			command: ["bun", "--cwd=packages/natives", "run", "ensure"],
			cwd: checkoutRoot,
		},
	];
	const recoverySteps: SourceUpdateStep[] = [
		{
			label: "Restoring previous revision",
			command: ["git", "reset", "--hard", previousRevision],
			cwd: checkoutRoot,
		},
		{ label: "Restoring dependencies", command: ["bun", "install"], cwd: checkoutRoot },
		{
			label: "Restoring build artifacts",
			command: ["bun", "--cwd=packages/collab-web", "run", "gen:tool-views"],
			cwd: checkoutRoot,
		},
		{
			label: "Restoring native addon",
			command: ["bun", "--cwd=packages/natives", "run", "ensure"],
			cwd: checkoutRoot,
		},
	];

	const recoverPreviousRevision = async (original: Error): Promise<never> => {
		report(`Update failed; restoring ${previousRevision.slice(0, 12)}...`);
		for (const step of recoverySteps) {
			report(`${step.label}...`);
			const result = await exec(step);
			if (result.exitCode !== 0) {
				const recoveryError = stepError(step, result);
				throw new Error(
					`${original.message} Automatic recovery also failed: ${recoveryError.message} ` +
						`Your previous revision is ${previousRevision}; restore it with ` +
						`\`git -C ${checkoutRoot} reset --hard ${previousRevision}\`, then run \`bun install\`.`,
					{ cause: original },
				);
			}
		}
		const restoredBrokenReason = await probe(
			launcherPath,
			`The restored checkout at ${checkoutRoot}, revision ${previousRevision.slice(0, 12)},`,
		);
		if (restoredBrokenReason !== undefined) {
			throw new Error(
				`${original.message} The updater reset to ${previousRevision}, but recovery verification failed: ` +
					`${restoredBrokenReason} Run \`bun install\` in ${checkoutRoot} and retry.`,
				{ cause: original },
			);
		}
		throw new Error(
			`${original.message} Restored the previous source revision ${previousRevision.slice(0, 12)}; ` +
				`the existing installation remains usable.`,
			{ cause: original },
		);
	};

	let checkoutAdvanced = false;
	for (const step of updateSteps) {
		report(`${step.label}...`);
		const result = await exec(step);
		if (result.exitCode !== 0) {
			const error = stepError(step, result);
			if (checkoutAdvanced) return recoverPreviousRevision(error);
			throw error;
		}
		if (step.label === "Fast-forwarding checkout") checkoutAdvanced = true;
	}

	try {
		const actual = await readCheckoutVersion(checkoutRoot);
		if (actual === undefined) {
			throw new Error(
				`Could not read ${SOURCE_VERSION_FILE} in ${checkoutRoot} after updating, ` +
					`so the checkout's version is unverified. ${sourceInstallUpdateGuidance(launcherPath)}`,
			);
		}
		if (actual !== version) {
			throw new Error(
				`The checkout at ${checkoutRoot} is at ${actual}, not ${version}, after fast-forwarding. ` +
					`Its branch probably does not track the branch the ${version} release was cut from. ` +
					sourceInstallUpdateGuidance(launcherPath),
			);
		}
		report("Verifying the updated checkout runs...");
		const brokenReason = await probe(launcherPath, `The checkout at ${checkoutRoot}, now at ${version},`);
		if (brokenReason !== undefined) {
			throw new Error(`${brokenReason} ${sourceInstallUpdateGuidance(launcherPath)}`);
		}
	} catch (err) {
		const error = err instanceof Error ? err : new Error(errorMessage(err));
		return recoverPreviousRevision(error);
	}

	const completionResult = await refreshCompletionsForInstalledBinary(launcherPath, report);
	report(`Updated source checkout to ${version}. Restart ${APP_NAME} to run it.`);
	return { warnings: completionResult.failed.map(formatCompletionRefreshWarning) };
}

/** Install a specific release version for the active veyyon installation. */
export async function installRelease(
	version: string,
	force: boolean,
	report: UpdateReporter = CONSOLE_UPDATE_REPORTER,
	currentVersion: string = VERSION,
	historyPath: string = getUpdateHistoryPath(),
): Promise<InstallReleaseResult> {
	void force;
	const target = await resolveUpdateTarget();
	const result =
		target.method === "source"
			? await updateViaSourceAt(target.path, version, report)
			: await updateViaBinaryAt(target.path, version, report);
	if (version !== currentVersion) {
		await recordVersionMove({ from: currentVersion, to: version, at: new Date().toISOString() }, historyPath);
	}
	return result;
}

/** Reason why rollback is unsupported for the given install method. */
export function rollbackUnsupportedReason(method: UpdateMethod): string | undefined {
	if (method !== "source") return undefined;
	return (
		`This is a source install (its launcher points into a git checkout), which updates by fast-forwarding ` +
		`that checkout. Fast-forward only moves forward, so there is no supported way to roll it back to an ` +
		`older release. To run an older version, check that version out yourself in the checkout, or install the ` +
		`prebuilt binary build with the install script and roll back from there.`
	);
}

/** Check if rollback is supported for the current installation. */
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

/** Record a version change in update history. */
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

/** Roll back or switch installation to a specific version. */
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

/** Outcome of an automatic update attempt. */
export type AutoUpdateOutcome =
	| { status: "up-to-date" }
	| { status: "updated"; version: string; warnings: string[] }
	| { status: "failed"; version?: string; error: string }
	| { status: "skipped"; version: string; reason: AutoUpdateSkipReason };

/** Reason why background auto-update was skipped. */
export type AutoUpdateSkipReason = "another-process" | "recent-failure" | "source-install";

/** Attempt background auto-update to latest release without terminal output. */
export async function runAutoUpdate(
	currentVersion: string = VERSION,
	knownRelease?: ReleaseInfo,
	statePath: string = getAutoUpdateStatePath(),
	resolveInstalledMethod: () => UpdateMethod | undefined = defaultInstalledMethod,
	// Injectable for the same reason `runUpdateCommand` takes one: the lock this
	// function holds is only meaningful if two callers can be raced against it,
	// and a race test cannot download a release twice.
	install: (
		version: string,
		reporter: typeof SILENT_UPDATE_REPORTER,
	) => Promise<void> | Promise<InstallReleaseResult> = (version, reporter) => installRelease(version, false, reporter),
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

	try {
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
				let installResult: InstallReleaseResult | undefined;
				try {
					// Silent: this runs under a live TUI, where any console write corrupts the frame.
					installResult = (await install(release.version, SILENT_UPDATE_REPORTER)) as
						| InstallReleaseResult
						| undefined;
				} catch (err) {
					const error = errorMessage(err);
					try {
						await recordAutoUpdateFailure(release.version, error, statePath);
					} catch (stateErr) {
						logger.warn("Could not record automatic update failure", {
							version: release.version,
							error: errorMessage(stateErr),
						});
					}
					return { status: "failed", version: release.version, error };
				}
				await clearAutoUpdateFailure(statePath);
				return { status: "updated", version: release.version, warnings: installResult?.warnings ?? [] };
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
	} catch (err) {
		return { status: "failed", version: release.version, error: errorMessage(err) };
	}
}

/** Installer function signature for update command execution. */
export type ReleaseInstaller = (version: string, force: boolean) => Promise<void> | Promise<InstallReleaseResult>;

/** Run the interactive update command. */
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
		console.log(chalk.green(`${typeof theme === "undefined" ? "✓" : theme.status.success} Already up to date`));
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

/** Print update command help. */
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
