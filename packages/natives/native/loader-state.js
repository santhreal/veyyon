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

/**
 * The per-version native cache directory, `<natives root>/<version>/` (e.g.
 * `~/.veyyon/natives/1.0.37/`). The SINGLE owner of that path shape: the loader
 * probes it (see {@link resolveLoaderCandidates}) and `scripts/ensure-native.ts`
 * mirrors provisioned addons into it, so the writer and the reader must derive
 * the location the same way or they would disagree on where the cache lives.
 * Honors `XDG_DATA_HOME` exactly as {@link getNativesDir} does.
 * @param {string} version
 * @returns {string}
 */
export function versionedNativeCacheDir(version) {
	return path.join(getNativesDir(), version);
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
 * Every path the loader will try to `require` as the native addon, in priority
 * order and de-duplicated. Reconciles the three install methods, which stage the
 * `.node` in DIFFERENT places, into one probe list so the loader (the single
 * reader) finds a valid binary no matter which writer produced it:
 *   - compiled / standalone binary → extracts into the per-version cache
 *     (`versionedDir`), so that wins first.
 *   - Windows node_modules update → stages into the same cache to dodge the
 *     locked-file overwrite, so the cache wins there too.
 *   - source / node_modules install → loads the in-tree (or node_modules) build
 *     first, then falls back to the per-version cache. That trailing fallback is
 *     what keeps a source-tree sync that dropped the gitignored `native/*.node`
 *     from bricking when a prior standalone install already cached a good addon.
 * The version-sentinel check downstream still refuses any stale/mismatched copy,
 * so a wider candidate list never loads the wrong release.
 *
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
	// The per-version native cache (`~/.veyyon/natives/<version>/`). The compiled /
	// standalone installer extracts the addon here, and the Windows update-safety
	// path stages into it too, so it is the ONE location every non-source install
	// method shares. Deriving both cache lists from this single owner keeps the
	// compiled, staged, and source branches from re-hand-rolling the same join.
	const versionedCandidates = addonFilenames.map(filename => path.join(versionedDir, filename));
	const userDataCandidates = addonFilenames.map(filename => path.join(userDataDir, filename));
	let releaseCandidates;
	if (isCompiledBinary) {
		releaseCandidates = [...versionedCandidates, ...userDataCandidates, ...baseReleaseCandidates];
	} else if (stageFromNodeModules) {
		releaseCandidates = [...versionedCandidates, ...leafCandidates, ...baseReleaseCandidates];
	} else {
		// Source / node_modules install: prefer the in-tree (or node_modules) build,
		// then fall back to any version-pinned binary the standalone installer staged
		// into the per-version cache. Without this trailing fallback a source-tree
		// sync that omits the gitignored `native/*.node` bricks at boot even though
		// the cache holds a loadable, sentinel-matched addon.
		// The sentinel check in `evaluateLoadedBindings` still rejects a stale copy,
		// and the in-tree path is tried first so a fresh local build always wins.
		releaseCandidates = [...leafCandidates, ...baseReleaseCandidates, ...versionedCandidates];
	}
	return [...new Set(releaseCandidates)];
}

// =========================================================================

/**
 * A per-version cache directory name, e.g. `1.0.37` or `1.1.0-rc.2` — the exact
 * shape {@link versionedNativeCacheDir} writes.
 *
 * Deliberately strict, because the function below DELETES DIRECTORIES under a
 * root the user can move with `$XDG_DATA_HOME`. It used to remove every
 * subdirectory that was not the current version, whatever it was; now it removes
 * only names it can positively identify as its own.
 */
const VERSION_CACHE_DIR_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Every per-version cache under `nativesDir` that is not the loaded package's own.
 *
 * The single owner of the question "which directory is dead", so the synchronous
 * install-time prune and the deferred runtime one cannot disagree about what they
 * are allowed to delete. A root that does not exist yet (first install, or
 * `$XDG_DATA_HOME` pointing elsewhere) is "nothing to prune", not a failure.
 *
 * @param {{ nativesDir: string; currentVersion: string }} input
 * @returns {string[]}
 */
export function staleNativeVersionDirs({ nativesDir, currentVersion }) {
	let entries;
	try {
		entries = fs.readdirSync(nativesDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const stale = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === currentVersion) continue;
		if (!VERSION_CACHE_DIR_RE.test(entry.name)) continue;
		stale.push(path.join(nativesDir, entry.name));
	}
	return stale;
}

/**
 * Remove every per-version native cache except the loaded package's own.
 *
 * Each cache holds the platform's addon variants, on the order of 150MB, and an
 * older one can never be loaded again: the loader probes only its own version's
 * directory, and the addon carries a version sentinel a different release
 * physically cannot expose. It is dead weight from the moment the new one is
 * staged.
 *
 * SYNCHRONOUS, and therefore for install time only -- `scripts/ensure-native.ts`
 * has just written the new cache and is the natural owner of retiring the old
 * one. A launch uses {@link scheduleStaleNativeCleanup} instead: measured on this
 * host, deleting one 150MiB cache costs 7ms, three cost 24ms, three that also
 * hold 5000 small files cost 105ms, and all of it landed between `dlopen` and the
 * first native call, which is before the first frame.
 *
 * Never throws: reclaiming disk must not abort a startup that has otherwise
 * worked. Failures are RETURNED rather than swallowed, so the caller can say
 * which directory is stuck instead of leaving the user with disk that quietly
 * never comes back.
 *
 * @param {{ nativesDir: string; currentVersion: string }} input
 * @returns {{ removed: string[], failed: { dir: string, reason: string }[] }}
 */
export function cleanupStaleNativeVersions({ nativesDir, currentVersion }) {
	/** @type {{ removed: string[], failed: { dir: string, reason: string }[] }} */
	const result = { removed: [], failed: [] };
	for (const targetPath of staleNativeVersionDirs({ nativesDir, currentVersion })) {
		try {
			fs.rmSync(targetPath, { recursive: true, force: true });
			result.removed.push(targetPath);
		} catch (err) {
			result.failed.push({ dir: targetPath, reason: err instanceof Error ? err.message : String(err) });
		}
	}
	return result;
}

/**
 * The same prune, with the unlink work on libuv's threadpool instead of the
 * thread that is trying to draw a frame. Same selection, same report shape.
 *
 * @param {{ nativesDir: string; currentVersion: string }} input
 * @returns {Promise<{ removed: string[], failed: { dir: string, reason: string }[] }>}
 */
export async function reclaimStaleNativeVersions({ nativesDir, currentVersion }) {
	/** @type {{ removed: string[], failed: { dir: string, reason: string }[] }} */
	const result = { removed: [], failed: [] };
	for (const targetPath of staleNativeVersionDirs({ nativesDir, currentVersion })) {
		try {
			await fs.promises.rm(targetPath, { recursive: true, force: true });
			result.removed.push(targetPath);
		} catch (err) {
			result.failed.push({ dir: targetPath, reason: err instanceof Error ? err.message : String(err) });
		}
	}
	return result;
}

/**
 * Hand the prune to the event loop and return immediately.
 *
 * A launch reaches this the moment the addon has loaded, which is before the
 * first frame, so the deletion is not allowed to happen there: 150MiB of dead
 * cache is not a reason for a session to open later. The timer is unref'd, so a
 * process that is already finishing does not stay alive to reclaim disk -- the
 * next launch, and every install, prunes again.
 *
 * `schedule`, `reclaim` and `report` are injectable so the deferral itself can be
 * asserted without waiting on a clock, and `settled` resolves once the prune has
 * reported, so a caller that needs to observe the outcome awaits a real signal
 * rather than a sleep.
 *
 * @param {{
 *   nativesDir: string;
 *   currentVersion: string;
 *   schedule?: (callback: () => void, delayMs: number) => unknown;
 *   reclaim?: (input: { nativesDir: string; currentVersion: string }) => Promise<{ removed: string[], failed: { dir: string, reason: string }[] }>;
 *   report?: (message: string) => void;
 * }} input
 * @returns {{ handle: unknown, settled: Promise<{ removed: string[], failed: { dir: string, reason: string }[] }> }}
 */
export function scheduleStaleNativeCleanup({
	nativesDir,
	currentVersion,
	schedule = setTimeout,
	reclaim = reclaimStaleNativeVersions,
	report = message => console.error(message),
}) {
	/** @type {PromiseWithResolvers<{ removed: string[], failed: { dir: string, reason: string }[] }>} */
	const settled = Promise.withResolvers();
	const handle = schedule(() => {
		void reclaim({ nativesDir, currentVersion }).then(pruned => {
			if (pruned.removed.length > 0) startupMarker(`native:cleanupStaleVersions:removed:${pruned.removed.length}`);
			// A cache that cannot be removed never comes back on its own, and the user is the only one
			// who can fix it. Saying nothing is how ~150MB per past version went missing without a word.
			for (const failure of pruned.failed) {
				report(`veyyon natives: could not remove the stale addon cache at ${failure.dir}: ${failure.reason}`);
			}
			settled.resolve(pruned);
		});
	}, 0);
	if (handle !== null && typeof handle === "object" && "unref" in handle && typeof handle.unref === "function") {
		handle.unref();
	}
	return { handle, settled: settled.promise };
}

/** The natives cache root, `<data home>/veyyon/natives`. */
export function nativesRootDir() {
	return getNativesDir();
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
 * This mirrors the build-time detector `classifyHostAvx2Support`
 * (scripts/host-detect.ts) branch-for-branch; the two live on opposite sides of
 * the build/runtime boundary and cannot share code, so their semantics MUST stay
 * in lock-step. `native-avx2-classify.test.ts` exercises the same probe matrix
 * against both to catch any drift.
 *
 * @param {{
 *   platform: NodeJS.Platform;
 *   arch: string;
 *   readCpuInfo: () => string | null;
 *   runCommand: (command: string, args: string[]) => string | null;
 *   trialLoad?: () => "supported" | "unsupported" | "unknown";
 * }} probes
 * @returns {"supported" | "unsupported" | "unknown"}
 */
export function classifyAvx2Support(probes) {
	if (probes.arch !== "x64") {
		return "unsupported";
	}

	if (probes.platform === "linux") {
		const cpuInfo = probes.readCpuInfo();
		// A null read means we could not inspect the CPU (unusual mount, sandbox) —
		// do NOT claim the CPU lacks AVX2; we simply do not know.
		if (cpuInfo === null) return "unknown";
		return /\bavx2\b/i.test(cpuInfo) ? "supported" : "unsupported";
	}

	if (probes.platform === "darwin") {
		// Try the absolute path before bare `sysctl`: PATH may not include
		// `/usr/sbin` in worker/embedded spawn contexts (issue #3238).
		let anyProbeRan = false;
		for (const sysctlBin of ["/usr/sbin/sysctl", "sysctl"]) {
			const leaf7 = probes.runCommand(sysctlBin, ["-n", "machdep.cpu.leaf7_features"]);
			if (leaf7 !== null) anyProbeRan = true;
			if (leaf7 && /\bAVX2\b/i.test(leaf7)) return "supported";
			const features = probes.runCommand(sysctlBin, ["-n", "machdep.cpu.features"]);
			if (features !== null) anyProbeRan = true;
			if (features && /\bAVX2\b/i.test(features)) return "supported";
		}
		// A probe ran and reported no AVX2 → genuinely unsupported. No probe ran at
		// all (every sysctl spawn failed) → unknown, not a false "unsupported".
		return anyProbeRan ? "unsupported" : "unknown";
	}

	if (probes.platform === "win32") {
		// Stock Windows ships PowerShell 5.1 (`powershell.exe`), which runs
		// .NET Framework — and .NET Framework has NO
		// System.Runtime.Intrinsics.X86.Avx2 type, so the old single probe
		// threw TypeNotFound on EVERY stock Windows box and the loader fell
		// back to "unknown" → baseline forever. PowerShell 7 installs as
		// `pwsh` on a newer .NET and does carry the type, so try it first;
		// backed by a newer runtime. Anything but an explicit True/False leaves
		// the tri-state at "unknown" — never a guessed downgrade.
		for (const shell of ["pwsh.exe", "powershell.exe"]) {
			const output = probes.runCommand(shell, [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"[System.Runtime.Intrinsics.X86.Avx2]::IsSupported",
			]);
			if (output === null) continue; // shell could not run at all
			const normalized = output.toLowerCase();
			if (normalized === "true") return "supported";
			if (normalized === "false") return "unsupported";
		}
		// Last resort, ground truth: trial-load the modern addon in a child
		// process. If the CPU lacks AVX2 the child dies on an illegal
		// instruction — a crash the parent survives and reads as a genuine
		// "unsupported", not a guess. A JS-level failure (file missing,
		// antivirus block) is catchable inside the child, which reports it as
		// inconclusive instead.
		return probes.trialLoad ? probes.trialLoad() : "unknown";
	}

	return "unknown";
}

/** The persisted AVX2 verdict file: one JSON object, hardware-keyed. */
const HOST_VARIANT_FILE = "host-variant.json";

/**
 * Parse a persisted verdict. Returns null for anything that is not a genuine
 * verdict for THIS platform/arch — a stale copy from other hardware, a
 * corrupted file, or a recorded "unknown" (which must never be treated as an
 * answer; Law 10) all read as "no verdict".
 */
export function parseHostVariantVerdict(text, { platform, arch }) {
	if (typeof text !== "string") return null;
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (data === null || typeof data !== "object") return null;
	if (data.platform !== platform || data.arch !== arch) return null;
	if (data.verdict !== "supported" && data.verdict !== "unsupported") return null;
	return data.verdict;
}

/**
 * Persist a GENUINE verdict next to the versioned addon caches. Only
 * "supported"/"unsupported" ever reach disk: the probes ran and answered, so
 * the answer is a fact about the machine, not a guess.
 */
export function writeHostVariantVerdict(nativesDir, verdict, { platform, arch }) {
	try {
		fs.mkdirSync(nativesDir, { recursive: true });
		const file = path.join(nativesDir, HOST_VARIANT_FILE);
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify({ platform, arch, verdict })}\n`);
		fs.renameSync(tmp, file);
	} catch {
		// An unwritable cache costs one re-probe on the next launch; it must
		// never break loading.
	}
}

/**
 * Detect AVX2 support on the real host, as a tri-state.
 *
 * A genuine verdict from an earlier run is read back from
 * `<nativesDir>/host-variant.json` so later launches skip the probe entirely —
 * on Windows that probe is a PowerShell spawn worth hundreds of milliseconds,
 * paid inside boot before the first native call can proceed. "unknown" is
 * NEVER persisted, per Law 10: an unanswerable probe must be asked again, not
 * remembered as a downgrade.
 *
 * Thin wrapper over {@link classifyAvx2Support} that supplies the real
 * filesystem/spawn probes.
 * @returns {"supported" | "unsupported" | "unknown"}
 */
function detectAvx2Support() {
	const cacheFile = path.join(getNativesDir(), HOST_VARIANT_FILE);
	let cached;
	try {
		cached = parseHostVariantVerdict(fs.readFileSync(cacheFile, "utf8"), {
			platform: process.platform,
			arch: process.arch,
		});
	} catch {
		cached = null;
	}
	if (cached !== null) {
		startupMarker(`native:avx2:persisted:${cached}`);
		return cached;
	}

	startupMarker("native:avx2:probe:start");
	const verdict = classifyAvx2Support({
		platform: process.platform,
		arch: process.arch,
		readCpuInfo: () => {
			try {
				return fs.readFileSync("/proc/cpuinfo", "utf8");
			} catch {
				return null;
			}
		},
		runCommand,
		trialLoad: process.platform === "win32" ? trialLoadModernAddon : undefined,
	});
	startupMarker("native:avx2:probe:done");
	if (verdict === "supported" || verdict === "unsupported") {
		writeHostVariantVerdict(getNativesDir(), verdict, { platform: process.platform, arch: process.arch });
	}
	return verdict;
}

/**
 * Trial-load the `modern` addon in a child process — the ground-truth probe
 * for machines where no shell-level CPU-feature query exists (stock Windows
 * has only PowerShell 5.1 on .NET Framework, which carries neither
 * `System.Runtime.Intrinsics` nor any SIMD type). If the CPU lacks AVX2 the
 * child dies executing an illegal instruction; the parent survives and reads
 * that as a GENUINE "unsupported", so it may be persisted. A load failure the
 * child could catch (file absent, antivirus block, ABI mismatch) reports as
 * "unknown" instead: a broken file says nothing about the CPU.
 *
 * The addon path travels by environment variable, not argv: `-e` argv
 * indexing differs between Node and Bun eval modes.
 *
 * @returns {"supported" | "unsupported" | "unknown"}
 */
function trialLoadModernAddon() {
	const tag = `${process.platform}-${process.arch}`;
	const modernFilename = `veyyon_natives.${tag}-modern.node`;
	// ONLY the modern file: the loader's candidate lists fall back to
	// baseline/default, and a trial that loaded a baseline binary would answer
	// "supported" on any x64 CPU — a persisted lie. No modern file present is
	// "unknown": nothing here can speak for the CPU.
	const dirs = [path.join(import.meta.dir, "..", "native"), versionedNativeCacheDir(packageJson.version)];
	const addonPath = dirs.map((dir) => path.join(dir, modernFilename)).find((candidate) => fs.existsSync(candidate));
	if (!addonPath) return "unknown";
	startupMarker(`native:avx2:trial:${addonPath}`);
	let result;
	try {
		result = childProcess.spawnSync(process.execPath, ["-e", TRIAL_LOAD_SCRIPT], {
			env: { ...process.env, VEYYON_TRIAL_ADDON_PATH: addonPath },
			encoding: "utf-8",
			timeout: 30_000,
		});
	} catch {
		return "unknown";
	}
	if (result.error) return "unknown"; // could not run ourselves at all
	const out = String(result.stdout || "");
	if (out.includes("TRIAL_OK")) return "supported";
	if (out.includes("TRIAL_INCOMPATIBLE")) return "unknown";
	// Clean exit without the OK line, or death by signal (SIGILL / access
	// violation): the binary executed but the CPU could not run it.
	return "unsupported";
}

const TRIAL_LOAD_SCRIPT = [
	"const path = process.env.VEYYON_TRIAL_ADDON_PATH;",
	"try {",
	"	const m = require(path);",
	'	if (m && typeof m === "object") { console.log("TRIAL_OK"); process.exit(0); }',
	'	console.log("TRIAL_INCOMPATIBLE");',
	"	process.exit(0);",
	"} catch {",
	'	console.log("TRIAL_INCOMPATIBLE");',
	"	process.exit(0);",
	"}",
].join("\n");

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
 * `__veyyonNativesV1_2_0`. `scripts/release.ts` bumps this name in lock-step
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

export function buildHelpMessage(ctx) {
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
	// veyyon's native addon is a gitignored BUILT artifact, never a registry
	// package: there is no `@veyyon/natives` to `bun install`, so pointing users
	// at one is a dead end. The real remediations, cheapest first, mirror
	// `scripts/ensure-native.ts` (the one owner of source-install provisioning):
	// re-provision from this checkout's own release, build locally with Rust, or
	// reinstall the standalone binary. Keep these in lock-step with that script.
	return (
		"Provision it from the matching release: bun --cwd=packages/natives run ensure\n" +
		"If developing locally, build with: bun --cwd=packages/natives run build\n" +
		"  (optional x64 variants: TARGET_VARIANT=baseline|modern)\n" +
		"Or reinstall the standalone binary: curl -fsSL https://get.veyyon.dev | sh"
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
	const versionedDir = versionedNativeCacheDir(packageVersion);
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

/**
 * Why a candidate `.node` did not load, which decides whether trying the next one is honest.
 *
 * The distinction is the whole point. A path that does not exist is EXPECTED on most candidates: the
 * loader probes several locations on purpose, and `resolveLoaderCandidates` documents the source-tree
 * cache path as a deliberate trailing fallback for a synced tree whose gitignored `native/*.node` is
 * missing. A file that EXISTS and fails to load is a different thing entirely: something is wrong with
 * the binary in front of us, and quietly loading a different one is how "my rebuild had no effect"
 * happens with nothing in the log to explain it.
 *
 * @param {unknown} error
 * @returns {"absent" | "broken"}
 */
export function classifyCandidateFailure(error) {
	const code = /** @type {{ code?: unknown }} */ (error)?.code;
	if (code === "MODULE_NOT_FOUND" || code === "ENOENT") return "absent";
	return "broken";
}

/**
 * The message printed when a present addon is skipped, kept next to the classification so the text and
 * the rule cannot drift.
 *
 * @param {{ candidate: string; reason: string }} skipped
 */
export function brokenAddonSkippedMessage({ candidate, reason }) {
	return (
		`[veyyon] warning: the native addon at ${candidate} exists but could not be loaded, ` +
		`so the loader is trying another copy. This is how a stale binary silently wins: ` +
		`if you just rebuilt, that rebuild is NOT what is running.\n  reason: ${reason}\n`
	);
}

/**
 * Load the first candidate that both loads AND validates, or report why none did.
 *
 * FAIL CLOSED ON A REJECTED ADDON, which is the rule this function exists to state. `validate` runs
 * OUTSIDE the try on purpose: it is what refuses an addon built for a different release, and its throw
 * must reach the caller rather than being caught and turned into "try the next path". It used to sit
 * inside the loop's single catch, so a sentinel mismatch on the in-tree build silently fell through to
 * whatever the per-version cache happened to hold. The check was written to fail closed and the loop
 * quietly converted it into a fallback, which is the Law 10 shape aimed at developers: the addon that
 * loaded was not the addon that was built, and the only clue was a startup marker naming a path
 * nobody reads.
 *
 * Effects are injected so the decision is testable without a real `dlopen`: this is the exact gate a
 * "my native change did nothing" investigation lands on.
 *
 * @param {{
 *   candidates: string[];
 *   requireAddon: (candidate: string) => Record<string, unknown>;
 *   validate: (bindings: Record<string, unknown>, candidate: string) => void;
 *   onBrokenAddon?: (skipped: { candidate: string; reason: string }) => void;
 *   initialErrors?: string[];
 * }} input
 * @returns {{ bindings?: Record<string, unknown>; candidate?: string; errors: string[] }}
 */
export function loadFirstUsableAddon({ candidates, requireAddon, validate, onBrokenAddon, initialErrors = [] }) {
	const errors = [...initialErrors];
	for (const candidate of candidates) {
		/** @type {Record<string, unknown>} */
		let bindings;
		try {
			bindings = requireAddon(candidate);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			errors.push(`${candidate}: ${reason}`);
			// A present-but-unloadable addon is announced. Continuing is still right (a corrupt file
			// must not brick a boot when a good copy exists) but it can never be silent.
			if (classifyCandidateFailure(err) === "broken") onBrokenAddon?.({ candidate, reason });
			continue;
		}
		validate(bindings, candidate);
		return { bindings, candidate, errors };
	}
	return { errors };
}

export function loadNative() {
	startupMarker("native:loadNative:start");
	const ctx = initLoaderContext();
	const require_ = createRequire(import.meta.url);

	const setupErrors = [];
	const embeddedCandidate = maybeExtractEmbeddedAddon(ctx, setupErrors);
	const stagedCandidate = embeddedCandidate ? null : maybeStageNodeModulesAddon(ctx, setupErrors);
	const prepended = [embeddedCandidate, stagedCandidate].filter(c => typeof c === "string");
	const runtimeCandidates = prepended.length > 0 ? [...prepended, ...ctx.candidates] : ctx.candidates;

	const { bindings, errors } = loadFirstUsableAddon({
		candidates: runtimeCandidates,
		initialErrors: setupErrors,
		requireAddon: candidate => {
			// The RESOLVED path, not the basename. The extracted cache copy under
			// ~/.veyyon/natives/<version>/ and a fresh in-tree build have the same file name, so a
			// basename marker read identically for both and a developer chasing "my rebuild had no
			// effect" had nothing to go on. Answering "which binary am I actually running" has to
			// take one line.
			startupMarker(`native:require:${path.resolve(candidate)}`);
			return require_(candidate);
		},
		validate: (loaded, candidate) => validateLoadedBindings(ctx, loaded, candidate),
		onBrokenAddon: skipped => {
			startupMarker(`native:skippedBrokenAddon:${path.resolve(skipped.candidate)}`);
			try {
				fs.writeSync(2, brokenAddonSkippedMessage(skipped));
			} catch {
				// stderr unavailable; the warning is best-effort but must never break the load.
			}
		},
	});
	if (bindings !== undefined) {
		installNativeTokioRuntime(bindings);
		// Disk housekeeping is not a reason for a launch to wait. The prune is handed to the event
		// loop and the caller gets its bindings now; see scheduleStaleNativeCleanup.
		scheduleStaleNativeCleanup({ nativesDir: ctx.nativesDir, currentVersion: ctx.packageVersion });
		startupMarker("native:loadNative:done");
		return bindings;
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
