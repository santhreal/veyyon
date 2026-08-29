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
	compareSemver,
	errorMessage,
	isCompiledBinary,
	isEnoent,
	isValidSemver,
	logger,
	readPipeText,
	removeTempPath,
	stripWindowsExtendedLengthPathPrefix,
	withFileLock,
} from "@veyyon/utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";
import { AUTO_UPDATE_LOCK_STALE_MS } from "./auto-update-state";
import {
	type CompletionGenerator,
	type CompletionRefreshResult,
	type CompletionTarget,
	completionEnvFrom,
	powershellCompletionPath,
	refreshInstalledCompletions,
} from "./completion-refresh";

export const REPO = "santhreal/veyyon";
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
export const GITHUB_LATEST_RELEASE_URL = `https://github.com/${REPO}/releases/latest`;
export const GITHUB_USER_AGENT = `${APP_NAME}-updater`;
export const RELEASE_METADATA_TIMEOUT_MS = 30_000;
export const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
export const BINARY_UPDATE_LOCK_RETRY_MS = 100;
export const CHECKSUM_TIMEOUT_MS = 30_000;

export const SOURCE_LAUNCHER_TAIL = ["packages", "coding-agent", "scripts", APP_NAME].join("/");

export interface ReleaseInfo {
	tag: string;
	version: string;
}

export interface InstallReleaseResult {
	warnings: string[];
}

export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
	reason?: string;
}

export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

export type UpdateMethod = "binary" | "source";

export type UpdateTarget = { method: "binary"; path: string } | { method: "source"; path: string };

function endsWithSourceLauncher(p: string): boolean {
	const normalized = p.replace(/\\/g, "/");
	return normalized.endsWith(SOURCE_LAUNCHER_TAIL) || normalized.endsWith(`${SOURCE_LAUNCHER_TAIL}.cmd`);
}

export const SHIM_READ_LIMIT = 4096;

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
			} catch {}
		}
	}
}

function shimForwardTargets(shimBody: string): string[] {
	const targets: string[] = [];
	for (const match of shimBody.matchAll(/"([^"\r\n]+)"/g)) targets.push(match[1] as string);
	for (const match of shimBody.matchAll(/'([^'\r\n]+)'/g)) targets.push(match[1] as string);
	for (const match of shimBody.matchAll(/^\s*exec\s+([^\s"'\r\n]+)/gm)) targets.push(match[1] as string);
	return targets;
}

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
	const body = readShim(resolved);
	if (looksLikeShim(resolved, body)) {
		for (const forwarded of shimForwardTargets(body)) {
			const forwardedResolved = tryRealpath(forwarded) ?? forwarded;
			if (endsWithSourceLauncher(forwardedResolved)) return "source";
		}
	}
	return "binary";
}

export async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const veyyonPath = resolveVeyyonPath();
	if (!veyyonPath) throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
	return { method: resolveUpdateMethod(veyyonPath), path: veyyonPath };
}

export function defaultInstalledMethod(): UpdateMethod | undefined {
	const veyyonPath = resolveVeyyonPath();
	return veyyonPath ? resolveUpdateMethod(veyyonPath) : undefined;
}

export async function getLatestRelease(timeoutMs: number = RELEASE_METADATA_TIMEOUT_MS): Promise<ReleaseInfo> {
	const url = `${GITHUB_LATEST_RELEASE_URL}`;
	let response: Response;
	try {
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
	const location = response.headers.get("location") ?? "";
	if (!location) {
		const hint =
			response.status === 404
				? ` — ${REPO} has no published GitHub release yet (a draft or untagged release does not count)`
				: "";
		const status = response.statusText ? `${response.status} ${response.statusText}` : `${response.status}`;
		throw new Error(`Could not read the latest release from ${url}: HTTP ${status}${hint}`);
	}
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

export interface ReleaseListing extends ReleaseInfo {
	publishedAt?: string;
}

export const RELEASES_PAGE_SIZE = 100;

export const RELEASES_MAX_PAGES = 10;

export async function getAllReleases(timeoutMs: number = RELEASE_METADATA_TIMEOUT_MS): Promise<ReleaseListing[]> {
	const releases: ReleaseListing[] = [];
	const seen = new Set<string>();
	for (let page = 1; page <= RELEASES_MAX_PAGES; page++) {
		const url = `${GITHUB_RELEASES_API}?per_page=${RELEASES_PAGE_SIZE}&page=${page}`;
		const batch = await fetchReleasePage(url, timeoutMs);
		if (batch.rawCount === 0) break;
		for (const entry of batch.releases) {
			if (seen.has(entry.version)) continue;
			seen.add(entry.version);
			releases.push(entry);
		}
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

export interface InstallLocation {
	compiled: boolean;
	execPath: string;
	onPath: string | undefined;
}

export function readInstallLocation(): InstallLocation {
	return { compiled: isCompiledBinary(), execPath: process.execPath, onPath: $which(APP_NAME) ?? undefined };
}

export function chooseUpdateTargetPath(
	where: InstallLocation,
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

export async function verifyBinaryVersion(
	binPath: string,
	expectedVersion: string,
): Promise<InstalledVersionVerification> {
	try {
		const result = await $`${binPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) {
			return {
				ok: false,
				path: binPath,
				reason: describeUnrunnableBinary(binPath, result.exitCode, result.stderr.toString()),
			};
		}
		const output = result.text().trim();
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		if (actual === undefined) {
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
		return { ok: false, path: binPath, reason: describeUnrunnableBinary(binPath, undefined, errorMessage(err)) };
	}
}

function describeUnrunnableBinary(binPath: string, exitCode: number | undefined, stderr: string): string {
	const said = stderr.trim();
	const what = exitCode === undefined ? "could not be started" : `exited ${exitCode}`;
	const because = said === "" ? "It printed nothing." : `It said: ${said.slice(0, 400)}`;
	return `${binPath} ${what} when asked for its version. ${because}`;
}

export type SearchProbe = (binPath: string, label: string) => Promise<string | undefined>;

export async function probeSearchWorks(binPath: string, label: string): Promise<string | undefined> {
	try {
		await fs.promises.access(binPath, fs.constants.X_OK);
	} catch {
		return `${label} is missing or not executable at ${binPath}.`;
	}
	const help = await $`${binPath} grep --help`.quiet().nothrow();
	if (help.exitCode !== 0) {
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

export type UpdateReporter = (line: string) => void;

export const CONSOLE_UPDATE_REPORTER: UpdateReporter = line => {
	console.log(line);
};

export const SILENT_UPDATE_REPORTER: UpdateReporter = () => {};

function printVerifiedVersion(expectedVersion: string, report: UpdateReporter): void {
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

async function removeFileBestEffort(filePath: string): Promise<boolean> {
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

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
		const middle = entry.slice(base.length + 1, entry.length - ".bak".length);
		const isNumericAttempt = /^\d+(\.\d+)*$/.test(middle);
		const isUuidAttempt = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(middle);
		if (middle.length > 0 && !isNumericAttempt && !isUuidAttempt) continue;
		await removeFileBestEffort(path.join(dir, entry));
	}
}

function ownerReceiptPathFor(artifactPath: string): string {
	return path.join(path.dirname(artifactPath), `.${path.basename(artifactPath)}.veyyon-owner`);
}

async function sha256OfFile(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

export async function restampOwnerReceipt(artifactPath: string, knownIdentity?: string): Promise<boolean> {
	const receiptPath = ownerReceiptPathFor(artifactPath);
	const staging = `${receiptPath}.${process.pid}`;
	try {
		const identity = knownIdentity ?? `file sha256:${await sha256OfFile(artifactPath)}`;
		await Bun.write(staging, `veyyon-installer-v2\n${identity}\n`);
		await fs.promises.rename(staging, receiptPath);
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

export function pendingOwnerReceiptPathFor(artifactPath: string): string {
	return `${ownerReceiptPathFor(artifactPath)}.pending`;
}

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

export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	let replacementInstalled = false;
	let pendingReceiptWritten = false;
	try {
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

		const incoming = `file sha256:${await sha256OfFile(options.tempPath)}`;

		try {
			await fs.promises.link(options.targetPath, options.backupPath);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (!["EACCES", "EPERM", "ENOTSUP", "EXDEV"].includes(code ?? "")) throw err;
			await fs.promises.copyFile(options.targetPath, options.backupPath, fs.constants.COPYFILE_EXCL);
		}
		backupReady = true;

		await markOwnerReceiptPending(options.targetPath, incoming);
		pendingReceiptWritten = true;

		await fs.promises.rename(options.tempPath, options.targetPath);
		replacementInstalled = true;

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		await restampOwnerReceipt(options.targetPath, incoming);

		backupReady = false;
		await removeFileBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady && replacementInstalled) {
			try {
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
			await restampOwnerReceipt(options.targetPath);
			pendingReceiptWritten = false;
		} else if (backupReady) {
			await removeFileBestEffort(options.backupPath);
		}
		if (pendingReceiptWritten) await removeFileBestEffort(pendingOwnerReceiptPathFor(options.targetPath));
		await removeFileBestEffort(options.tempPath);
		throw err;
	}
}

export async function updateViaBinaryAt(
	targetPath: string,
	expectedVersion: string,
	report: UpdateReporter,
): Promise<InstallReleaseResult> {
	const binaryName = getBinaryName();
	const tag = `v${expectedVersion}`;
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;

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
		await removeFileBestEffort(tempPath);
		throw err;
	}

	report(chalk.dim("Verifying checksum…"));
	try {
		await verifyDownloadChecksum(tempPath, `${url}.sha256`);
	} catch (err) {
		await removeFileBestEffort(tempPath);
		throw err;
	}
	report(chalk.dim("Checksum verified"));

	try {
		return await withFileLock(
			targetPath,
			async () => {
				await sweepStaleBackups(targetPath);
				report(chalk.dim("Installing update..."));
				await replaceBinaryForUpdate({
					targetPath,
					tempPath,
					backupPath,
					expectedVersion,
					verifyInstalledVersion: version => verifyBinaryUsable(targetPath, version),
				});
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
		await removeFileBestEffort(tempPath);
		throw err;
	}
}

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

export function sourceInstallUpdateGuidance(launcherPath: string): string {
	return (
		`${APP_NAME} is installed from source (its launcher is ${launcherPath}). ` +
		`Update the checkout manually: cd into it and run \`git pull && bun install\`.`
	);
}

export const SOURCE_VERSION_FILE = "packages/coding-agent/package.json";

export type CheckoutVersionReader = (checkoutRoot: string) => Promise<string | undefined>;

export const defaultReadCheckoutVersion: CheckoutVersionReader = async checkoutRoot => {
	try {
		const raw = await Bun.file(path.join(checkoutRoot, SOURCE_VERSION_FILE)).text();
		const version = (JSON.parse(raw) as { version?: unknown }).version;
		return typeof version === "string" && version.length > 0 ? version : undefined;
	} catch {
		return undefined;
	}
};

export interface SourceUpdateStep {
	label: string;
	command: string[];
	cwd: string;
}

export interface SourceUpdateStepResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type SourceUpdateExec = (step: SourceUpdateStep) => Promise<SourceUpdateStepResult>;

export const defaultSourceUpdateExec: SourceUpdateExec = async step => {
	const proc = Bun.spawn(step.command, { cwd: step.cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		readPipeText(proc.stdout),
		readPipeText(proc.stderr),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
};

export async function updateViaSourceAt(
	launcherPath: string,
	version: string,
	report: UpdateReporter = CONSOLE_UPDATE_REPORTER,
	exec: SourceUpdateExec = defaultSourceUpdateExec,
	readCheckoutVersion: CheckoutVersionReader = defaultReadCheckoutVersion,
	probe: SearchProbe = probeSearchWorks,
): Promise<InstallReleaseResult> {
	const resolvedLauncher = tryRealpath(launcherPath) ?? launcherPath;
	const checkoutRoot = path.join(path.dirname(resolvedLauncher), "..", "..", "..");
	const stepError = (step: SourceUpdateStep, result: SourceUpdateStepResult): Error => {
		const detail = result.stderr.trim().length > 0 ? `: ${result.stderr.trim()}` : "";
		return new Error(
			`${step.label} failed (\`${step.command.join(" ")}\` exited ${result.exitCode})${detail}. ` +
				sourceInstallUpdateGuidance(launcherPath),
		);
	};

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
