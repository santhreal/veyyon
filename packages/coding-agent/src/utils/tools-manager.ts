import { createHash, type Hash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isCancellation } from "@veyyon/utils/abortable";
import { APP_NAME, getToolsDir } from "@veyyon/utils/dirs";
import * as logger from "@veyyon/utils/logger";
import * as ptree from "@veyyon/utils/ptree";
import { bareVersion } from "@veyyon/utils/semver";
import { TempDir } from "@veyyon/utils/temp";
import { errorMessage } from "@veyyon/utils/type-guards";
import { $which } from "@veyyon/utils/which";
import { primarySessionCpuAdoption } from "../session/cpu-limit";
import { throwIfAborted } from "../tools/tool-errors";
import { scopedTimeoutSignal } from "./fetch-timeout";
import { extractArchive } from "./zip";

const TOOLS_DIR = getToolsDir();
const TOOL_DOWNLOAD_TIMEOUT_MS = 120_000;
const TOOL_METADATA_TIMEOUT_MS = 5000;

type BodyReadResult = Bun.ReadableStreamDefaultReadResult<Uint8Array>;
type BodyReader = {
	read(): Promise<BodyReadResult>;
	cancel(reason?: unknown): Promise<void>;
};

function isAbortLikeError(error: unknown): boolean {
	return isCancellation(error);
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function readBodyChunk(reader: BodyReader, signal: AbortSignal | undefined): Promise<BodyReadResult> {
	if (!signal) return await reader.read();
	if (signal.aborted) throw abortReason(signal);

	const abort = Promise.withResolvers<BodyReadResult>();
	const onAbort = () => abort.reject(abortReason(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([reader.read(), abort.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function writeResponseBody(
	dest: string,
	body: NonNullable<Response["body"]>,
	signal?: AbortSignal,
	hash?: Hash,
): Promise<void> {
	const reader = body.getReader();
	const sink = Bun.file(dest).writer();
	let completed = false;

	try {
		while (true) {
			const { done, value } = await readBodyChunk(reader, signal);
			if (done) break;
			if (value) {
				hash?.update(value);
				await sink.write(value);
			}
		}
		await sink.end();
		completed = true;
	} finally {
		if (!completed) {
			await reader.cancel().catch(() => {});
			await Promise.resolve(sink.end()).catch(() => {});
			await fs.promises.rm(dest, { force: true }).catch(() => {});
		}
	}
}

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	isDirectBinary?: boolean; // If true, asset is a direct binary (not an archive)
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

export function ffmpegAssetName(_version: string, plat: string, architecture: string): string | null {
	if (architecture !== "arm64" && architecture !== "x64") return null;
	if (plat === "darwin") return `ffmpeg-darwin-${architecture}`;
	if (plat === "linux") return `ffmpeg-linux-${architecture}`;
	if (plat === "win32") return architecture === "x64" ? "ffmpeg-win32-x64" : null;
	return null;
}

const TOOLS: Record<string, ToolConfig> = {
	sd: {
		name: "sd",
		repo: "chmln/sd",
		binaryName: "sd",
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `sd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `sd-v${version}-${archStr}-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `sd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	sg: {
		name: "ast-grep",
		repo: "ast-grep/ast-grep",
		binaryName: "sg",
		tagPrefix: "",
		getAssetName: (_version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ast-grep-${archStr}-apple-darwin.zip`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ast-grep-${archStr}-unknown-linux-gnu.zip`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ast-grep-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	"yt-dlp": {
		name: "yt-dlp",
		repo: "yt-dlp/yt-dlp",
		binaryName: "yt-dlp",
		tagPrefix: "",
		isDirectBinary: true,
		getAssetName: (_version, plat, architecture) => {
			if (plat === "darwin") {
				return "yt-dlp_macos"; // Universal binary
			} else if (plat === "linux") {
				return architecture === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
			} else if (plat === "win32") {
				return architecture === "arm64" ? "yt-dlp_arm64.exe" : "yt-dlp.exe";
			}
			return null;
		},
	},
	ffmpeg: {
		name: "ffmpeg",
		repo: "eugeneware/ffmpeg-static",
		binaryName: "ffmpeg",
		tagPrefix: "",
		isDirectBinary: true,
		getAssetName: ffmpegAssetName,
	},
};

interface PythonPackageToolConfig {
	name: string;
	package: string; // PyPI package name
	binaryName: string; // CLI command name after install
}

const PYTHON_TOOLS: Record<string, PythonPackageToolConfig> = {
	trafilatura: {
		name: "trafilatura",
		package: "trafilatura",
		binaryName: "trafilatura",
	},
};

export type ToolName = "sd" | "sg" | "yt-dlp" | "trafilatura" | "ffmpeg";

export function getToolPath(tool: ToolName): string | null {
	const pythonConfig = PYTHON_TOOLS[tool];
	if (pythonConfig) {
		return $which(pythonConfig.binaryName);
	}

	const config = TOOLS[tool];
	if (!config) return null;

	const localPath = path.join(TOOLS_DIR, config.binaryName + (os.platform() === "win32" ? ".exe" : ""));
	if (fs.existsSync(localPath)) {
		return localPath;
	}

	return $which(config.binaryName);
}

const ASSET_DIGEST_RE = /^sha256:([0-9a-f]{64})$/;

interface LatestRelease {
	version: string;
	digests: Record<string, string>;
}

async function getLatestRelease(repo: string, signal?: AbortSignal): Promise<LatestRelease> {
	const requestTimeout = scopedTimeoutSignal(TOOL_METADATA_TIMEOUT_MS, signal);
	try {
		let response: Response;
		try {
			response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
				headers: { "User-Agent": `${APP_NAME}-coding-agent` },
				signal: requestTimeout.signal,
			});
		} catch (err) {
			if (isCancellation(err)) {
				throwIfAborted(signal, "tool metadata");
				throw new Error("GitHub API request timed out");
			}
			throw err;
		}

		if (!response.ok) {
			throw new Error(`GitHub API error: ${response.status}`);
		}

		const data = (await response.json()) as {
			tag_name: string;
			assets?: { name?: unknown; digest?: unknown }[];
		};
		const digests: Record<string, string> = {};
		for (const asset of data.assets ?? []) {
			if (typeof asset?.name !== "string" || typeof asset.digest !== "string") continue;
			const match = ASSET_DIGEST_RE.exec(asset.digest);
			if (match) digests[asset.name] = match[1]!;
		}
		return { version: bareVersion(data.tag_name), digests };
	} finally {
		requestTimeout.cancel();
	}
}

export async function downloadFile(
	url: string,
	dest: string,
	signal?: AbortSignal,
	expectedSha256?: string,
): Promise<void> {
	const downloadTimeout = scopedTimeoutSignal(TOOL_DOWNLOAD_TIMEOUT_MS, signal);
	const downloadSignal = downloadTimeout.signal;
	const hash = expectedSha256 ? createHash("sha256") : undefined;
	let response: Response;
	try {
		response = await fetch(url, {
			signal: downloadSignal,
		});
		if (!response.ok) {
			throw new Error(`Failed to download: ${response.status}`);
		} else if (!response.body) {
			throw new Error("No response body");
		}
		await writeResponseBody(dest, response.body, downloadSignal, hash);
	} catch (err) {
		if (isAbortLikeError(err)) {
			throw new Error(`Download timed out: ${url}`);
		}
		throw err;
	} finally {
		downloadTimeout.cancel();
	}

	if (!hash || !expectedSha256) return;
	const actual = hash.digest("hex");
	if (actual === expectedSha256) return;
	await fs.promises.rm(dest, { force: true }).catch(() => {});
	throw new Error(`Checksum mismatch for ${url}: expected sha256 ${expectedSha256}, got ${actual}`);
}

export async function downloadTool(tool: ToolName, signal?: AbortSignal): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = os.platform();
	const architecture = os.arch();

	const { version, digests } = await getLatestRelease(config.repo, signal);

	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	const expectedSha256 = digests[assetName];
	if (!expectedSha256) {
		throw new Error(
			`Refusing to install ${config.name}: ${config.repo} release ${version} publishes no sha256 digest for ${assetName}`,
		);
	}

	await fs.promises.mkdir(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = path.join(TOOLS_DIR, config.binaryName + binaryExt);

	if (config.isDirectBinary) {
		await downloadFile(downloadUrl, binaryPath, signal, expectedSha256);
		if (plat !== "win32") {
			await fs.promises.chmod(binaryPath, 0o755);
		}
		return binaryPath;
	}

	const archivePath = path.join(TOOLS_DIR, assetName);
	await downloadFile(downloadUrl, archivePath, signal, expectedSha256);

	const tmp = await TempDir.create("@veyyon-tools-extract-");

	try {
		if (!assetName.endsWith(".tar.gz") && !assetName.endsWith(".zip")) {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		try {
			await extractArchive(archivePath, tmp.path());
		} catch (err) {
			throw new Error(`Failed to extract ${assetName}: ${errorMessage(err)}`);
		}

		let extractedBinary: string;
		if (tool === "sg") {
			extractedBinary = path.join(tmp.path(), config.binaryName + binaryExt);
		} else {
			const extractedDir = path.join(tmp.path(), assetName.replace(/\.(tar\.gz|zip)$/, ""));
			extractedBinary = path.join(extractedDir, config.binaryName + binaryExt);
		}

		if (fs.existsSync(extractedBinary)) {
			await fs.promises.rename(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: ${extractedBinary}`);
		}

		if (plat !== "win32") {
			await fs.promises.chmod(binaryPath, 0o755);
		}
	} finally {
		await tmp.remove();
		await fs.promises.rm(archivePath, { force: true });
	}

	return binaryPath;
}

async function installPythonPackage(pkg: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const uv = $which("uv");
		if (uv) {
			const result = await ptree.exec([uv, "tool", "install", pkg], {
				signal,
				allowNonZero: true,
				allowAbort: true,
				stderr: "full",
				onSpawnPid: primarySessionCpuAdoption(),
			});
			if (result.exitCode === 0) return true;
		}

		const pip = $which("pip3") || $which("pip");
		if (pip) {
			const result = await ptree.exec([pip, "install", "--user", pkg], {
				signal,
				allowNonZero: true,
				allowAbort: true,
				stderr: "full",
				onSpawnPid: primarySessionCpuAdoption(),
			});
			return result.exitCode === 0;
		}

		return false;
	} catch (error) {
		logger.warn(`Failed to install Python package ${pkg}`, {
			error: errorMessage(error),
		});
		return false;
	}
}

const TERMUX_PACKAGES: Partial<Record<ToolName, string>> = {
	sd: "sd",
	sg: "ast-grep",
};

type EnsureToolOptions = {
	signal?: AbortSignal;
	silent?: boolean;
	notify?: (message: string) => void;
};

export async function ensureTool(tool: ToolName, silentOrOptions?: EnsureToolOptions): Promise<string | undefined> {
	const { signal, silent = false, notify } = silentOrOptions ?? {};
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	if (os.platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			logger.warn(`${TOOLS[tool]?.name ?? tool} not found. Install with: pkg install ${pkgName}`);
		}
		return undefined;
	}

	const pythonConfig = PYTHON_TOOLS[tool];
	if (pythonConfig) {
		if (!silent) {
			logger.debug(`${pythonConfig.name} not found. Installing via uv/pip...`);
		}
		notify?.(`Installing ${pythonConfig.name}…`);
		const success = await installPythonPackage(pythonConfig.package, signal);
		if (success) {
			const path = $which(pythonConfig.binaryName);
			if (path) {
				if (!silent) {
					logger.debug(`${pythonConfig.name} installed successfully`);
				}
				return path;
			}
		}
		if (!silent) {
			logger.warn(`Failed to install ${pythonConfig.name}`);
		}
		return undefined;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (!silent) {
		logger.debug(`${config.name} not found. Downloading...`);
	}
	notify?.(`Downloading ${config.name}…`);

	try {
		const path = await downloadTool(tool, signal);
		if (!silent) {
			logger.debug(`${config.name} installed to ${path}`);
		}
		return path;
	} catch (e) {
		if (!silent) {
			logger.warn(`Failed to download ${config.name}`, {
				error: errorMessage(e),
			});
		}
		return undefined;
	}
}
