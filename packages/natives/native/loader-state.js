import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import packageJson from "../package.json" with { type: "json" };
import { embeddedAddon } from "./embedded-addon.js";

/**
 * Native addon loader for `@veyyon/natives`.
 *
 * Owns every step between "Node imports `native/index.js`" and "the right
 * `veyyon_natives.<platform>-<arch>*.node` is required, validated, and returned":
 * platform/variant detection, candidate-path resolution, on-disk staging from
 * `node_modules` (Windows update safety), embedded-addon extraction (Bun
 * standalone binaries), version-sentinel validation, and the aggregated error
 * surface for diagnostic-friendly failures.
 *
 * `native/index.js` is reduced to one `loadNative()` call plus the generated
 * surface-area exports between `MARKER_START`/`MARKER_END` (rewritten by
 * `scripts/gen-enums.ts`); everything else lives here so the pure helpers stay
 * unit-testable without triggering the side-effectful module-load path.
 *
 * Background (issue #823): `bun build --compile --define VEYYON_COMPILED=true`
 * substitutes the bare identifier `VEYYON_COMPILED`, NOT `process.env.VEYYON_COMPILED`,
 * so a runtime read of the env var returns `undefined`. Older CommonJS loader
 * code also saw the original build-host absolute path in `__filename`; ESM
 * `import.meta.url` is rewritten to the bunfs URL. The embedded-addon
 * presence (true iff the build pipeline ran `embed:native`, false in the
 * post-build `--reset` stub) is the authoritative compiled-mode signal.
 */

const SUPPORTED_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];

/**
 * Streaming startup marker, enabled by `VEYYON_DEBUG_STARTUP`. Local copy of the
 * pi-utils helper (this loader cannot depend on pi-utils). Synchronous on
 * purpose: extraction/dlopen hangs must still leave the `:start` marker.
 * @param {string} text
 */
function startupMarker(text) {
	if (!process.env.VEYYON_DEBUG_STARTUP) return;
	try {
		fs.writeSync(2, `[startup] ${text}\n`);
	} catch {
		// stderr unavailable; markers are best-effort
	}
}

function getNativesDir() {
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && fs.existsSync(path.join(xdgDataHome, "veyyon"))) {
		return path.join(xdgDataHome, "veyyon", "natives");
	}
	return path.join(os.homedir(), ".veyyon", "natives");
}

function resolveLeafPackageDir(platformTag) {
	try {
		const require_ = createRequire(import.meta.url);
		return path.dirname(require_.resolve(`@veyyon/natives-${platformTag}/package.json`));
	} catch {
		return null;
	}
}

// =========================================================================
// Pure helpers — re-exported for unit tests in `packages/natives/test/`.
// =========================================================================

/**
 * @param {{
 *   embeddedAddon: { platformTag: string; version: string; files: unknown[] } | null | undefined;
 *   env: Record<string, string | undefined>;
 *   importMetaUrl: string | null | undefined;
 * }} input
 * @returns {boolean}
 */
export function detectCompiledBinary({ embeddedAddon, env, importMetaUrl }) {
	if (embeddedAddon) return true;
	if (env && env.VEYYON_COMPILED) return true;
	if (typeof importMetaUrl === "string") {
		if (importMetaUrl.includes("$bunfs")) return true;
		if (importMetaUrl.includes("~BUN")) return true;
		if (importMetaUrl.includes("%7EBUN")) return true;
	}
	return false;
}

/**
 * @param {{ tag: string; arch: string; variant: "modern" | "baseline" | null | undefined }} input
 * @returns {string[]}
 */
export function getAddonFilenames({ tag, arch, variant }) {
	const defaultFilename = `veyyon_natives.${tag}.node`;
	if (arch !== "x64" || !variant) return [defaultFilename];
	const baselineFilename = `veyyon_natives.${tag}-baseline.node`;
	const modernFilename = `veyyon_natives.${tag}-modern.node`;
	if (variant === "modern") {
		return [modernFilename, baselineFilename, defaultFilename];
	}
	return [baselineFilename, defaultFilename];
}

/**
 * Decide whether the loader should mirror the package's `native/<filename>.node`
 * into the per-version cache directory (`~/.veyyon/natives/<version>/`) before loading.
 *
 * Windows-only safety net for `bun install -g` updates: when a previous `veyyon`
 * process is running, bun cannot overwrite the locked `.node` inside
 * `node_modules/@veyyon/natives/native/`, leaving an old binary next to a
 * newer `index.js` and producing `<sym> is not a function` crashes on the next
 * launch. Staging into the version-pinned cache:
 *   1. Gives every package version its own filesystem path, so concurrent veyyon
 *      processes never collide on the same file.
 *   2. Makes the running process keep its handle on the cache copy, freeing bun
 *      to overwrite the `node_modules` copy on subsequent updates.
 * Disabled on non-Windows (no file-lock problem), in workspace dev (`nativeDir`
 * is not inside a `node_modules` segment), and for compiled binaries (handled
 * by `maybeExtractEmbeddedAddon`).
 *
 * @param {{ platform: NodeJS.Platform | string; isCompiledBinary: boolean; nativeDir: string }} input
 * @returns {boolean}
 */
export function shouldStageNodeModulesAddon({ platform, isCompiledBinary, nativeDir }) {
	if (platform !== "win32") return false;
	if (isCompiledBinary) return false;
	// Check both separators independently of the host's `path.sep`: this helper
	// is shared by the loader (running on Windows with `\`) and the test suite
	// (typically running on POSIX hosts when CI executes the regression test).
	return nativeDir.includes("\\node_modules\\") || nativeDir.includes("/node_modules/");
}

/**
 * @param {{
 *   addonFilenames: string[];
 *   isCompiledBinary: boolean;
 *   stageFromNodeModules?: boolean;
 *   nativeDir: string;
 *   leafPackageDir?: string | null;
 *   execDir: string;
 *   versionedDir: string;
 *   userDataDir: string;
 * }} input
 * @returns {string[]}
 */
export function resolveLoaderCandidates({
	addonFilenames,
	isCompiledBinary,
	stageFromNodeModules = false,
	nativeDir,
	leafPackageDir = null,
	execDir,
	versionedDir,
	userDataDir,
}) {
	const baseReleaseCandidates = addonFilenames.flatMap(filename => [
		path.join(nativeDir, filename),
		path.join(execDir, filename),
	]);
	const leafCandidates = leafPackageDir ? addonFilenames.map(filename => path.join(leafPackageDir, filename)) : [];
	const compiledCandidates = addonFilenames.flatMap(filename => [
		path.join(versionedDir, filename),
		path.join(userDataDir, filename),
	]);
	const stagedCandidates = stageFromNodeModules ? addonFilenames.map(filename => path.join(versionedDir, filename)) : [];
	let releaseCandidates;
	if (isCompiledBinary) {
		releaseCandidates = [...compiledCandidates, ...baseReleaseCandidates];
	} else if (stageFromNodeModules) {
		releaseCandidates = [...stagedCandidates, ...leafCandidates, ...baseReleaseCandidates];
	} else {
		releaseCandidates = [...leafCandidates, ...baseReleaseCandidates];
	}
	return [...new Set(releaseCandidates)];
}

// =========================================================================

/**
 * Remove version-pinned native cache directories older than the loaded package.
 * Best-effort by design: permission errors and concurrent processes must not
 * abort startup after the native addon has already loaded successfully.
 *
 * @param {{ nativesDir: string; currentVersion: string }} input
 * @returns {string[]}
 */
export function cleanupStaleNativeVersions({ nativesDir, currentVersion }) {
	const removed = [];
	let entries;
	try {
		entries = fs.readdirSync(nativesDir, { withFileTypes: true });
	} catch {
		return removed;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === currentVersion) continue;
		const targetPath = path.join(nativesDir, entry.name);
		try {
			fs.rmSync(targetPath, { recursive: true, force: true });
			removed.push(targetPath);
		} catch {
			// Stale caches are opportunistic cleanup only.
		}
	}
	return removed;
}

// Side-effectful loader. Everything below runs only when `loadNative()` is
// called from `native/index.js` — tests that only import the pure helpers
// above pay nothing for variant detection, subprocess spawns, or fs probes.
// =========================================================================

/**
 * Hidden env key for the resolved x64 variant. Once any context (main thread,
 * worker, subprocess) finishes variant detection, the result is written here
 * so every Bun worker and child process spawned afterwards inherits the same
 * verdict and skips re-detection. See `selectCpuVariant` for the lookup order.
 */
const VARIANT_CACHE_ENV_KEY = "__PI_NATIVE_VARIANT_CACHE";

/**
 * Spawn `command` with `args` and capture stdout. Prefers `Bun.spawnSync`
 * because Bun's `child_process.spawnSync` shim has been observed to return
 * non-zero / null in worker threads on macOS even when the same binary works
 * fine from the parent — the failure mode behind issue #3238, where the worker
 * silently falls back to the "baseline" variant. Falls back to the Node shim
 * for non-Bun embeds.
 */
function runCommand(command, args) {
	if (typeof Bun !== "undefined" && typeof Bun.spawnSync === "function") {
		try {
			const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
			if (result.exitCode === 0) {
				return result.stdout.toString("utf-8").trim();
			}
		} catch {
			// fall through to childProcess
		}
	}
	try {
		const result = childProcess.spawnSync(command, args, { encoding: "utf-8" });
		if (result.error) return null;
		if (result.status !== 0) return null;
		return (result.stdout || "").trim();
	} catch {
		return null;
	}
}

function getVariantOverride() {
	const value = process.env.VEYYON_NATIVE_VARIANT;
	if (!value) return null;
	if (value === "modern" || value === "baseline") return value;
	return null;
}

/**
 * Detect AVX2 support as a TRI-STATE, never a bare boolean:
 *   - `"supported"`   — the probe ran and the CPU has AVX2 → the `modern` variant.
 *   - `"unsupported"` — the probe ran and the CPU lacks AVX2 → `baseline` is correct.
 *   - `"unknown"`     — the probe could not run at all (unreadable `/proc/cpuinfo`,
 *                       every `sysctl` spawn failed, powershell unavailable).
 *
 * The distinction is the whole point (Law 10: no silent fallback, and its speed
 * bound). The old detector returned `false` for BOTH "no AVX2" and "couldn't
 * detect", so a genuine AVX2 machine whose probe merely failed to spawn (issue
 * #3238's worker context) was silently and permanently downgraded to the slower
 * `baseline` binary — a correct-but-materially-slower fallback, which is exactly
 * the banned case. Reporting `"unknown"` lets `selectCpuVariant` still pick the
 * ABI-safe `baseline` (never SIGILL a non-AVX2 CPU) WITHOUT caching that guessed
 * verdict for every child process, and lets the caller surface it loudly.
 *
 * @returns {"supported" | "unsupported" | "unknown"}
 */
function detectAvx2Support() {
	if (process.arch !== "x64") {
		return "unsupported";
	}

	if (process.platform === "linux") {
		try {
			const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
			return /\bavx2\b/i.test(cpuInfo) ? "supported" : "unsupported";
		} catch {
			// Could not read /proc/cpuinfo (unusual mount, sandbox) — do NOT claim
			// the CPU lacks AVX2; we simply do not know.
			return "unknown";
		}
	}

	if (process.platform === "darwin") {
		// Try the absolute path before bare `sysctl`: PATH may not include
		// `/usr/sbin` in worker/embedded spawn contexts (issue #3238).
		let anyProbeRan = false;
		for (const sysctlBin of ["/usr/sbin/sysctl", "sysctl"]) {
			const leaf7 = runCommand(sysctlBin, ["-n", "machdep.cpu.leaf7_features"]);
			if (leaf7 !== null) anyProbeRan = true;
			if (leaf7 && /\bAVX2\b/i.test(leaf7)) return "supported";
			const features = runCommand(sysctlBin, ["-n", "machdep.cpu.features"]);
			if (features !== null) anyProbeRan = true;
			if (features && /\bAVX2\b/i.test(features)) return "supported";
		}
		// A probe ran and reported no AVX2 → genuinely unsupported. No probe ran at
		// all (every sysctl spawn failed) → unknown, not a false "unsupported".
		return anyProbeRan ? "unsupported" : "unknown";
	}

	if (process.platform === "win32") {
		const output = runCommand("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"[System.Runtime.Intrinsics.X86.Avx2]::IsSupported",
		]);
		if (output === null) return "unknown"; // powershell could not run
		return output.toLowerCase() === "true" ? "supported" : "unsupported";
	}

	return "unknown";
}

/**
 * Pure variant-selection helper, exposed for unit tests. Resolution order:
 *
 *   1. `override` (user-facing `VEYYON_NATIVE_VARIANT` env var). Always wins.
 *   2. The private `__PI_NATIVE_VARIANT_CACHE` env var, populated by the first
 *      context that detected at runtime. Lets child workers / subprocesses
 *      inherit the main thread's verdict instead of re-spawning `sysctl` etc.
 *      from a worker context where the spawn may fail (issue #3238).
 *   3. `detectAvx2()` — the slow path, called at most once per process. It
 *      returns a TRI-STATE (`"supported" | "unsupported" | "unknown"`), not a
 *      boolean: `"unknown"` means the probe could not run, which is NOT the same
 *      as "no AVX2". A genuine `"unsupported"` verdict caches `baseline` (the CPU
 *      really lacks AVX2, so re-detecting is wasted); an `"unknown"` verdict
 *      falls back to the ABI-safe `baseline` but is reported as
 *      `source: "detect-unknown"` with `detectionFailed: true` and is NOT
 *      cached — caching a guessed downgrade would poison every child process
 *      that inherits `process.env`, permanently pinning the slower binary on
 *      hardware that may well support the faster one (Law 10 speed bound).
 *
 * Non-x64 architectures return `{ variant: null }` and never set the cache.
 * When a genuine detection runs, the result is surfaced as
 * `cacheEnvKey`/`cacheEnvValue` so the caller can write `process.env` (the pure
 * helper itself stays side-effect-free, which keeps it easy to test).
 *
 * @param {{
 *   arch: string;
 *   override: "modern" | "baseline" | null | undefined;
 *   env: Record<string, string | undefined>;
 *   detectAvx2: () => "supported" | "unsupported" | "unknown";
 * }} input
 * @returns {{
 *   variant: "modern" | "baseline" | null;
 *   source: "non-x64" | "override" | "cache" | "detect" | "detect-unknown";
 *   cacheEnvKey?: string;
 *   cacheEnvValue?: string;
 *   detectionFailed?: boolean;
 * }}
 */
export function selectCpuVariant({ arch, override, env, detectAvx2 }) {
	if (arch !== "x64") return { variant: null, source: "non-x64" };
	if (override === "modern" || override === "baseline") {
		return { variant: override, source: "override" };
	}
	const cached = env[VARIANT_CACHE_ENV_KEY];
	if (cached === "modern" || cached === "baseline") {
		return { variant: cached, source: "cache" };
	}
	const support = detectAvx2();
	if (support === "supported" || support === "unsupported") {
		const variant = support === "supported" ? "modern" : "baseline";
		return {
			variant,
			source: "detect",
			cacheEnvKey: VARIANT_CACHE_ENV_KEY,
			cacheEnvValue: variant,
		};
	}
	// support === "unknown": the probe could not run. Choose the ABI-safe
	// baseline (modern would SIGILL on a real non-AVX2 CPU), but do NOT cache
	// this guess and flag it so the loader can warn the operator loudly instead
	// of silently shipping a possibly-slower binary.
	return { variant: "baseline", source: "detect-unknown", detectionFailed: true };
}

let warnedAvx2DetectionFailed = false;

function resolveCpuVariant(override) {
	const result = selectCpuVariant({
		arch: process.arch,
		override,
		env: process.env,
		detectAvx2: detectAvx2Support,
	});
	if (result.cacheEnvKey) {
		process.env[result.cacheEnvKey] = result.cacheEnvValue;
	}
	if (result.detectionFailed && !warnedAvx2DetectionFailed) {
		warnedAvx2DetectionFailed = true;
		try {
			fs.writeSync(
				2,
				"[veyyon] warning: could not detect CPU AVX2 support; defaulting to the slower `baseline` " +
					"native variant. If your CPU supports AVX2, set VEYYON_NATIVE_VARIANT=modern to use the " +
					"faster build.\n",
			);
		} catch {
			// stderr unavailable; the warning is best-effort but must never crash the load.
		}
	}
	return result.variant;
}

function selectEmbeddedAddonFile(selectedVariant) {
	if (!embeddedAddon) return null;
	const defaultFile = embeddedAddon.files.find(file => file.variant === "default") || null;
	if (process.arch !== "x64") return defaultFile || embeddedAddon.files[0] || null;
	if (selectedVariant === "modern") {
		return (
			embeddedAddon.files.find(file => file.variant === "modern") ||
			embeddedAddon.files.find(file => file.variant === "baseline") ||
			null
		);
	}
	return embeddedAddon.files.find(file => file.variant === "baseline") || null;
}

function readTarString(buffer, offset, length) {
	const end = Math.min(offset + length, buffer.length);
	let stringEnd = offset;
	while (stringEnd < end && buffer[stringEnd] !== 0) stringEnd++;
	return buffer.toString("utf8", offset, stringEnd);
}

function readTarOctal(buffer, offset, length) {
	const value = readTarString(buffer, offset, length).trim();
	if (!value) return 0;
	const parsed = Number.parseInt(value, 8);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid tar octal value: ${value}`);
	}
	return parsed;
}

function isZeroTarBlock(buffer, offset) {
	for (let index = 0; index < 512; index++) {
		if (buffer[offset + index] !== 0) return false;
	}
	return true;
}

function getTarEntryName(header) {
	const name = readTarString(header, 0, 100);
	const prefix = readTarString(header, 345, 155);
	return prefix ? `${prefix}/${name}` : name;
}

function isSafeEmbeddedAddonFilename(filename) {
	return filename.length > 0 && path.basename(filename) === filename && !filename.includes("/") && !filename.includes("\\");
}

function isEmbeddedAddonFileCurrent(targetPath, file) {
	try {
		const stat = fs.statSync(targetPath);
		if (!stat.isFile()) return false;
		return typeof file.size !== "number" || stat.size === file.size;
	} catch (err) {
		if (err && err.code === "ENOENT") return false;
		throw err;
	}
}

function writeEmbeddedAddonFile(targetPath, content) {
	const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
	try {
		fs.writeFileSync(tempPath, content, { mode: 0o755 });
		fs.renameSync(tempPath, targetPath);
	} catch (err) {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// Best-effort cleanup only.
		}
		throw err;
	}
}

export function extractEmbeddedAddonArchive({ archivePath, files, targetDir }) {
	const pending = new Map();
	for (const file of files) {
		if (!isSafeEmbeddedAddonFilename(file.filename)) {
			throw new Error(`Unsafe embedded addon filename: ${file.filename}`);
		}
		const targetPath = path.join(targetDir, file.filename);
		if (!isEmbeddedAddonFileCurrent(targetPath, file)) {
			pending.set(file.filename, file);
		}
	}
	if (pending.size === 0) return [];

	const archive = zlib.gunzipSync(fs.readFileSync(archivePath));
	const writtenPaths = [];
	let offset = 0;

	while (offset + 512 <= archive.length) {
		if (isZeroTarBlock(archive, offset)) break;
		const header = archive.subarray(offset, offset + 512);
		const filename = getTarEntryName(header);
		const size = readTarOctal(header, 124, 12);
		const typeflag = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
		offset += 512;

		if (offset + size > archive.length) {
			throw new Error(`Truncated embedded addon archive entry: ${filename}`);
		}

		if (!isSafeEmbeddedAddonFilename(filename)) {
			throw new Error(`Unsafe embedded addon archive entry: ${filename}`);
		}
		if (typeflag !== "0") {
			throw new Error(`Unsupported embedded addon archive entry type ${typeflag}: ${filename}`);
		}

		const file = pending.get(filename);
		if (file) {
			if (typeof file.size === "number" && file.size !== size) {
				throw new Error(`Embedded addon size mismatch for ${filename}: expected ${file.size}, got ${size}`);
			}
			const targetPath = path.join(targetDir, filename);
			writeEmbeddedAddonFile(targetPath, archive.subarray(offset, offset + size));
			pending.delete(filename);
			writtenPaths.push(targetPath);
		}

		offset += Math.ceil(size / 512) * 512;
	}

	if (pending.size > 0) {
		throw new Error(`Embedded addon archive missing: ${[...pending.keys()].join(", ")}`);
	}

	return writtenPaths;
}

function maybeExtractEmbeddedAddon(ctx, errors) {
	if (!ctx.isCompiledBinary || !embeddedAddon) return null;
	if (embeddedAddon.platformTag !== ctx.platformTag || embeddedAddon.version !== ctx.packageVersion) return null;

	const selectedEmbeddedFile = selectEmbeddedAddonFile(ctx.selectedVariant);
	if (!selectedEmbeddedFile) return null;
	const targetPath = path.join(ctx.versionedDir, selectedEmbeddedFile.filename);

	startupMarker("native:extractEmbeddedAddon:start");
	try {
		fs.mkdirSync(ctx.versionedDir, { recursive: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push(`embedded addon dir: ${message}`);
		return null;
	}

	if (embeddedAddon.archive) {
		try {
			extractEmbeddedAddonArchive({
				archivePath: embeddedAddon.archive.filePath,
				files: embeddedAddon.files,
				targetDir: ctx.versionedDir,
			});
			if (isEmbeddedAddonFileCurrent(targetPath, selectedEmbeddedFile)) {
				return targetPath;
			}
			errors.push(`embedded addon archive (${embeddedAddon.archive.filename}): missing ${selectedEmbeddedFile.filename}`);
			return null;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`embedded addon archive (${embeddedAddon.archive.filename}): ${message}`);
			return null;
		}
	}

	if (isEmbeddedAddonFileCurrent(targetPath, selectedEmbeddedFile)) {
		return targetPath;
	}
	if (!selectedEmbeddedFile.filePath) {
		errors.push(`embedded addon metadata missing file path for ${selectedEmbeddedFile.filename}`);
		return null;
	}

	try {
		const buffer = fs.readFileSync(selectedEmbeddedFile.filePath);
		fs.writeFileSync(targetPath, buffer);
		return targetPath;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push(`embedded addon write (${selectedEmbeddedFile.filename}): ${message}`);
		return null;
	}
}

/**
 * Mirror `leafPackageDir ?? nativeDir` addon binaries to
 * `versionedDir/<filename>.node` on Windows installs so the running process
 * cache path, never on the `node_modules` copy that bun must overwrite on
 * update. No-op on non-Windows, in workspace dev, and for compiled binaries —
 * see `shouldStageNodeModulesAddon` for the gating rules.
 */
function maybeStageNodeModulesAddon(ctx, errors) {
	if (!ctx.stageFromNodeModules) return null;

	let stagedPath = null;
	for (const filename of ctx.addonFilenames) {
		const sourcePath = path.join(ctx.leafPackageDir ?? ctx.nativeDir, filename);
		const targetPath = path.join(ctx.versionedDir, filename);

		if (fs.existsSync(targetPath)) {
			stagedPath = stagedPath || targetPath;
			continue;
		}
		if (!fs.existsSync(sourcePath)) continue;

		try {
			fs.mkdirSync(ctx.versionedDir, { recursive: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`staged addon dir: ${message}`);
			continue;
		}

		try {
			// `copyFileSync` is atomic on Windows (CopyFileW) and avoids holding
			// two large buffers in JS for the read/write dance.
			fs.copyFileSync(sourcePath, targetPath);
			stagedPath = stagedPath || targetPath;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`staged addon copy (${filename}): ${message}`);
		}
	}
	return stagedPath;
}

/** One-shot guard so the stale-native warning fires once per process, not per candidate. */
let warnedStaleWorkspaceNative = false;

/**
 * The export name the Rust addon emits for `version`, e.g. `1.0.14` ->
 * `__veyyonNativesV1_0_21`. `scripts/release.ts` bumps this name in lock-step
 * with the package version, so a `.node` from another release physically cannot
 * expose the symbol this loader looks for. Exported so the version<->sentinel
 * contract can be pinned by a test (the workspace/test env skips the runtime
 * check, so nothing else guards against the two drifting apart).
 */
export function versionSentinelExportFor(version) {
	return `__veyyonNativesV${String(version).replace(/[^A-Za-z0-9]/g, "_")}`;
}

/** The version a loaded addon was actually built for, read back from its own sentinel export. */
export function detectBuiltNativeVersion(bindings) {
	for (const key of Object.keys(bindings)) {
		const m = key.match(/^__veyyonNativesV(\d+)_(\d+)_(\d+)$/);
		if (m) return `${m[1]}.${m[2]}.${m[3]}`;
	}
	return "unknown";
}

/**
 * Every `__veyyonNativesV<major>_<minor>_<patch>` sentinel physically present in
 * a built `.node`'s bytes, deduplicated. The sentinel is an exported symbol name,
 * so it appears verbatim as an ASCII string in the compiled binary — which lets
 * the embed step (`scripts/embed-native.ts`) verify a `.node` was built for the
 * package version WITHOUT `dlopen`, and refuse to ship a stale/mislabeled addon
 * that would brick the loader at runtime. Reads the buffer as latin1 so every
 * byte maps to one char and the symbol is never split by a decoder.
 * @param {Buffer | Uint8Array} buffer
 * @returns {string[]}
 */
export function nativeSentinelsInBuffer(buffer) {
	const text = Buffer.from(buffer).toString("latin1");
	const found = new Set();
	for (const match of text.matchAll(/__veyyonNativesV\d+_\d+_\d+/g)) found.add(match[0]);
	return [...found];
}

/**
 * The single owner of the "does this built `.node` match this package version"
 * contract that the ship path fails closed on. Given the variant buffers about
 * to be embedded/published and the version they must carry, return the FIRST
 * variant whose bytes do not expose `__veyyonNativesV<version>` (i.e. it was
 * built for a different release), or `null` when every variant is fresh.
 *
 * This is the exact brick the loader hits at runtime — a `.node` left stale by a
 * version bump, or one variant rebuilt at a different version than its sibling
 * (modern at 1.0.14 while baseline is 1.0.15) — caught at build time instead of
 * in a user's terminal. `embed-native.ts` (compiled-binary path) is the caller;
 * keeping the check here means the embed guard and any future CI/loader guard
 * read the sentinel the one same way, so they can never disagree on "stale".
 *
 * @param {Array<{ filename: string; bytes: Buffer | Uint8Array }>} addons
 * @param {string} version
 * @returns {{ filename: string; expected: string; builtFor: string[] } | null}
 */
export function findStaleAddon(addons, version) {
	const expected = versionSentinelExportFor(version);
	for (const addon of addons) {
		const sentinels = nativeSentinelsInBuffer(addon.bytes);
		if (!sentinels.includes(expected)) {
			return { filename: addon.filename, expected, builtFor: sentinels };
		}
	}
	return null;
}

/**
 * The loud, actionable refusal message for a stale variant found by
 * `findStaleAddon`. One owner so the thrown text (and the version it names) is
 * asserted by a test rather than pasted at the throw site.
 *
 * @param {{ filename: string; expected: string; builtFor: string[] }} stale
 * @param {string} version
 * @returns {string}
 */
export function staleAddonMessage(stale, version) {
	const builtFor = stale.builtFor.length > 0 ? stale.builtFor.join(", ") : "no version sentinel";
	return (
		"Refusing to embed a stale native addon.\n" +
		`  ${stale.filename} carries ${builtFor}, but this package is ${version} ` +
		`(expects ${stale.expected}).\n` +
		"  Rebuild every variant for this version first: bun --cwd=packages/natives run build"
	);
}

/**
 * `owner/repo` for a `package.json` `repository.url`, e.g.
 * `git+https://github.com/santhreal/veyyon.git` -> `santhreal/veyyon`. Fails
 * closed to veyyon's own slug (never a fork/upstream) when the URL is missing or
 * unparseable, so the release-download help can't point users at another repo.
 */
export function repoSlugFromRepositoryUrl(raw) {
	const match = typeof raw === "string" ? raw.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/i) : null;
	return match ? `${match[1]}/${match[2]}` : "santhreal/veyyon";
}

/**
 * Pure decision for a loaded native addon, keyed on whether it exposes the
 * version sentinel this loader expects (`ctx.versionSentinelExport`). No side
 * effects: it returns WHAT to do so the caller can perform the effect and so
 * the decision — the exact gate a user's "native failed to load" crash hits —
 * is testable without a real `dlopen`.
 *
 * Returns a discriminated result:
 *  - `{ action: "accept" }` — sentinel present, addon matches this release.
 *  - `{ action: "warn", builtVersion, message }` — sentinel missing in a
 *    workspace/dev load: boot anyway (a post-pull tree keeps working until the
 *    next `bun run build`) but surface it loudly, once (Law 10: no silent
 *    fallback). This branch is exactly why the workspace/test env never tripped
 *    a hard failure and the stale-native bug shipped uncaught.
 *  - `{ action: "throw", builtVersion, message }` — sentinel missing in an
 *    installed/compiled load: the `.node` on disk is from a different release,
 *    so fail closed with an actionable message naming BOTH the version the
 *    binary was built for and the version this loader expects.
 *
 * @param {{ versionSentinelExport: string, isWorkspaceLoad: boolean, packageVersion: string }} ctx
 * @param {Record<string, unknown>} bindings
 * @param {string} candidate
 */
export function evaluateLoadedBindings(ctx, bindings, candidate) {
	if (typeof bindings[ctx.versionSentinelExport] === "function") {
		return { action: "accept" };
	}
	// The .node on disk was built for a different package version than this
	// loader expects (its `__veyyonNativesV*` sentinel does not match).
	const builtVersion = detectBuiltNativeVersion(bindings);
	if (ctx.isWorkspaceLoad) {
		// Workspace dev (running out of `packages/natives/native/` rather than a
		// `node_modules` install or compiled bundle): the local `.node` only gains
		// the renamed sentinel after `bun --cwd=packages/natives run build`, so a
		// version bump leaves it stale until the next rebuild.
		return {
			action: "warn",
			builtVersion,
			message:
				`[veyyon] warning: loaded a stale native addon built for @veyyon/natives@${builtVersion}, ` +
				`but this tree is at ${ctx.packageVersion}. It may drift from the current sources. ` +
				"Rebuild with: bun --cwd=packages/natives run build\n" +
				`  (${candidate})\n`,
		};
	}
	return {
		action: "throw",
		builtVersion,
		message:
			`Loaded ${candidate} but it was built for @veyyon/natives@${builtVersion}, not the ` +
			`@veyyon/natives@${ctx.packageVersion} this loader expects ` +
			`(missing version sentinel \`${ctx.versionSentinelExport}\`). The .node file on disk is from a ` +
			"different release than this loader — reinstall to re-sync.",
	};
}

function validateLoadedBindings(ctx, bindings, candidate) {
	const decision = evaluateLoadedBindings(ctx, bindings, candidate);
	if (decision.action === "accept") return;
	if (decision.action === "warn") {
		// Boot anyway, but NEVER silently: loading a wrong-version native risks
		// ABI/behavior drift, so surface it loudly, once, with the exact fix.
		if (!warnedStaleWorkspaceNative) {
			warnedStaleWorkspaceNative = true;
			try {
				fs.writeSync(2, decision.message);
			} catch {
				// stderr unavailable; the warning is best-effort but must never crash the load.
			}
		}
		return;
	}
	throw new Error(decision.message);
}

/**
 * Install the addon's bounded Tokio runtime now that `dlopen` has returned and
 * the dynamic-loader lock is released. The Rust `#[module_init]` deliberately
 * does NOT build the runtime — spawning worker threads under the loader lock
 * deadlocks on some hosts — so it exposes `__veyyonInstallTokioRuntime` for the
 * loader to call once, before any async native runs. Best-effort: older addons
 * predating this export simply fall back to napi-rs's default runtime.
 */
function installNativeTokioRuntime(bindings) {
	const install = bindings.__veyyonInstallTokioRuntime;
	if (typeof install !== "function") return;
	try {
		install();
		startupMarker("native:tokioRuntime:installed");
	} catch (err) {
		startupMarker(`native:tokioRuntime:failed:${err instanceof Error ? err.message : String(err)}`);
	}
}


/**
 * GitHub releases "latest download" base for this package's OWN repository,
 * derived from `package.json`'s `repository.url` so the owner/repo lives in
 * exactly one place (the package manifest) and can never drift to a fork's repo.
 * veyyon's native `.node` assets are published to `santhreal/veyyon` releases,
 * NOT to any upstream — a hardcoded upstream URL here sent users to download a
 * different project's binaries. Fail closed to the correct repo, never upstream,
 * if the manifest URL is ever missing or unparseable.
 */
function releasesDownloadBase() {
	const raw = typeof packageJson.repository === "string" ? packageJson.repository : packageJson.repository?.url;
	return `https://github.com/${repoSlugFromRepositoryUrl(raw)}/releases/latest/download`;
}

function buildHelpMessage(ctx) {
	if (ctx.isCompiledBinary) {
		const expectedPaths = ctx.addonFilenames.map(filename => `  ${path.join(ctx.versionedDir, filename)}`).join("\n");
		const downloadBase = releasesDownloadBase();
		const downloadHints = ctx.addonFilenames
			.map(filename => {
				const downloadUrl = `${downloadBase}/${filename}`;
				const targetPath = path.join(ctx.versionedDir, filename);
				return `  curl -fsSL "${downloadUrl}" -o "${targetPath}"`;
			})
			.join("\n");
		return (
			`The compiled binary should extract one of:\n${expectedPaths}\n\n` +
			`If missing, delete ${ctx.versionedDir} and re-run, or download manually:\n${downloadHints}`
		);
	}
	return (
		"If installed via npm/bun, try reinstalling: bun install @veyyon/natives\n" +
		"If developing locally, build with: bun --cwd=packages/natives run build\n" +
		"Optional x64 variants: TARGET_VARIANT=baseline|modern bun --cwd=packages/natives run build"
	);
}

/**
 * Initialize the loader context: resolves every path, variant, and policy
 * decision once so the inner load loop stays a pure require/validate pipeline.
 * Called from `loadNative()` rather than at module scope so importing pure
 * helpers from this file doesn't trigger AVX2 detection or filesystem probes.
 */
function initLoaderContext() {
	const platformTag = `${process.platform}-${process.arch}`;
	const packageVersion = packageJson.version;
	const nativeDir = path.join(import.meta.dir, "..", "native");
	const execDir = path.dirname(process.execPath);
	const nativesDir = getNativesDir();
	const versionedDir = path.join(nativesDir, packageVersion);
	const userDataDir =
		process.platform === "win32"
			? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "veyyon")
			: path.join(os.homedir(), ".local", "bin");

	const isCompiledBinary = detectCompiledBinary({
		embeddedAddon,
		env: process.env,
		importMetaUrl: import.meta.url,
	});
	const leafPackageDir = isCompiledBinary ? null : resolveLeafPackageDir(platformTag);
	const stageFromNodeModules = shouldStageNodeModulesAddon({
		platform: process.platform,
		isCompiledBinary,
		nativeDir,
	});

	const selectedVariant = resolveCpuVariant(getVariantOverride());
	const addonFilenames = getAddonFilenames({ tag: platformTag, arch: process.arch, variant: selectedVariant });
	const addonLabel = selectedVariant ? `${platformTag} (${selectedVariant})` : platformTag;

	const candidates = resolveLoaderCandidates({
		addonFilenames,
		isCompiledBinary,
		stageFromNodeModules,
		nativeDir,
		leafPackageDir,
		execDir,
		versionedDir,
		userDataDir,
	});

	// Version sentinel emitted by the Rust addon under a `js_name` that encodes
	// the package version (`__veyyonNativesV{major}_{minor}_{patch}`).
	// `scripts/release.ts` bumps the name in `crates/veyyon-natives/src/lib.rs` in
	// lock-step with the version, so a `.node` from a different release
	// physically cannot expose the symbol this loader is looking for. That
	// turns the silent `<sym> is not a function` crash from a Windows
	// locked-file update into an actionable load-time error.
	const versionSentinelExport = versionSentinelExportFor(packageVersion);
	const isWorkspaceLoad =
		!isCompiledBinary && !nativeDir.includes("\\node_modules\\") && !nativeDir.includes("/node_modules/");

	return {
		platformTag,
		packageVersion,
		nativeDir,
		leafPackageDir,
		versionedDir,
		isCompiledBinary,
		stageFromNodeModules,
		selectedVariant,
		addonFilenames,
		addonLabel,
		candidates,
		versionSentinelExport,
		isWorkspaceLoad,
		nativesDir,
	};
}

/**
 * Memoized native bindings. The first `native()` call runs the full
 * `loadNative()` pipeline (variant detection, extraction, dlopen, validation);
 * every later call returns the same cached object. This is the single load
 * point every lazy export routes through.
 * @type {Record<string, unknown> | undefined}
 */
let loadedNativeBindings;

/** Load the native addon once (memoized), or throw loudly if it cannot load. */
export function native() {
	if (loadedNativeBindings === undefined) {
		loadedNativeBindings = loadNative();
	}
	return loadedNativeBindings;
}

/**
 * Lazy function export. Returns a wrapper that resolves its native binding on
 * FIRST CALL, so importing `native/index.js` for its types, enum values, or a
 * bare function reference never triggers `loadNative()`. Pure registry / schema
 * / doc-truth imports whose transitive graph merely mentions `@veyyon/natives`
 * therefore need no built `.node` (DOCS-NATIVES-1). The first ACTUAL call still
 * loads-or-throws loudly — this is deferral, never a silent fallback (Law 10).
 *
 * The resolved function is cached in the closure after the first call, so the
 * steady-state cost of a hot native call (countTokens, highlightCode, grep) is
 * just the argument spread — no per-call `native()` check or property lookup.
 * @param {string} name
 * @returns {(...args: unknown[]) => unknown}
 */
export function lazyNativeFn(name) {
	/** @type {((...args: unknown[]) => unknown) | undefined} */
	let fn;
	return (...args) => {
		if (fn === undefined) {
			const resolved = native()[name];
			if (typeof resolved !== "function") {
				throw new TypeError(`@veyyon/natives export "${name}" is not a native function`);
			}
			fn = /** @type {(...args: unknown[]) => unknown} */ (resolved);
		}
		return fn(...args);
	};
}

/**
 * Lazy class export. A Proxy that defers `loadNative()` to the first `new`,
 * static-member access, or `instanceof` check, then forwards to the real native
 * class. Preserves `new X(...)` (instances carry the real prototype, so
 * `instanceof` and every method work), `X.staticMember`, and `"m" in X`.
 * @param {string} name
 * @returns {new (...args: unknown[]) => unknown}
 */
export function lazyNativeClass(name) {
	return /** @type {new (...args: unknown[]) => unknown} */ (
		new Proxy(function () {}, {
			construct(_target, args) {
				return Reflect.construct(/** @type {new (...a: unknown[]) => object} */ (native()[name]), args);
			},
			get(_target, prop, receiver) {
				return Reflect.get(/** @type {object} */ (native()[name]), prop, receiver);
			},
			has(_target, prop) {
				return Reflect.has(/** @type {object} */ (native()[name]), prop);
			},
		})
	);
}

export function loadNative() {
	startupMarker("native:loadNative:start");
	const ctx = initLoaderContext();
	const require_ = createRequire(import.meta.url);

	const errors = [];
	const embeddedCandidate = maybeExtractEmbeddedAddon(ctx, errors);
	const stagedCandidate = embeddedCandidate ? null : maybeStageNodeModulesAddon(ctx, errors);
	const prepended = [embeddedCandidate, stagedCandidate].filter(c => typeof c === "string");
	const runtimeCandidates = prepended.length > 0 ? [...prepended, ...ctx.candidates] : ctx.candidates;

	for (const candidate of runtimeCandidates) {
		try {
			startupMarker(`native:require:${path.basename(candidate)}`);
			const bindings = require_(candidate);
			validateLoadedBindings(ctx, bindings, candidate);
			installNativeTokioRuntime(bindings);
	        cleanupStaleNativeVersions({ nativesDir: ctx.nativesDir, currentVersion: ctx.packageVersion });
			startupMarker("native:loadNative:done");
			return bindings;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${candidate}: ${message}`);
		}
	}

	if (!SUPPORTED_PLATFORMS.includes(ctx.platformTag)) {
		throw new Error(
			`Unsupported platform: ${ctx.platformTag}\n` +
				`Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}\n` +
				"If you need support for this platform, please open an issue.",
		);
	}
	const details = errors.map(error => `- ${error}`).join("\n");
	throw new Error(
		`Failed to load veyyon_natives native addon for ${ctx.addonLabel}.\n\nTried:\n${details}\n\n${buildHelpMessage(ctx)}`,
	);
}
