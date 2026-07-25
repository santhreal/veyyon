#!/usr/bin/env bun
/**
 * Ensure a loadable veyyon_natives addon exists for THIS host in
 * `packages/natives/native/`. The single owner of source-install addon
 * provisioning: the source launcher's self-heal, `install.sh --source`, and
 * `veyyon update` (source method) all run this instead of hand-rolling their
 * own copies.
 *
 * Why it exists: the addon is a gitignored BUILT artifact. A fresh clone or a
 * bare `git pull` has none, and veyyon died at boot with a raw resolve-error
 * dump (user-hit 2026-07-24) because nothing on the shipped source path ever
 * produced one. Bun runs no root lifecycle scripts on workspace installs, so
 * an install hook cannot do it either.
 *
 * Strategy, in order:
 *  1. A present addon whose version sentinel matches this checkout: done.
 *  2. Download the prebuilt addon asset from this checkout's own release tag
 *     (v<package version>), verified against its .sha256 sidecar. Same-tag
 *     download guarantees the embedded version sentinel matches.
 *  3. Local cargo build (`bun scripts/build-native.ts`) when a Rust toolchain
 *     is available.
 *  4. Fail closed with ONE actionable paragraph, never a resolve-spam dump.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	cleanupStaleNativeVersions,
	getAddonFilenames,
	nativeSentinelsInBuffer,
	nativesRootDir,
	selectCpuVariant,
	versionedNativeCacheDir,
	versionSentinelExportFor,
} from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const nativesRoot = path.join(import.meta.dir, "..");
const nativeDir = path.join(nativesRoot, "native");
const version: string = packageJson.version;
const repoSlug = "santhreal/veyyon";
/**
 * The addon is tens of megabytes, so this is generous; the point is that it is
 * BOUNDED. Both fetches ran with no signal at all, so a captive portal or a
 * black-holed connection hung the source launcher forever at boot, with the
 * last thing on screen being "fetching the prebuilt..." and no way to tell
 * whether it was working. install.sh and the self-updater both bound their
 * equivalents; this was the one that did not.
 */
const ASSET_TIMEOUT_MS = 10 * 60_000;
/** The .sha256 sidecar is a few dozen bytes: slow here means broken, not busy. */
const SIDECAR_TIMEOUT_MS = 30_000;

export function hostAddonFilenames(): string[] {
	const tag = `${process.platform}-${process.arch}`;
	const override = process.env.VEYYON_CPU_VARIANT;
	const { variant } = selectCpuVariant({
		arch: process.arch,
		override: override === "modern" || override === "baseline" ? override : undefined,
		env: process.env,
		detectAvx2: () => "unknown",
	});
	// detectAvx2 "unknown" yields baseline-first on x64; prepend the modern
	// filename too so an already-built modern addon satisfies the check and a
	// download attempt covers both variants.
	const names = getAddonFilenames({ tag, arch: process.arch, variant });
	if (process.arch === "x64") {
		const modern = `veyyon_natives.${tag}-modern.node`;
		if (!names.includes(modern)) names.unshift(modern);
	}
	return names;
}

/** True when `file` exists and embeds this checkout's version sentinel. */
export function addonIsCurrent(file: string): boolean {
	try {
		const buffer = fs.readFileSync(file);
		return nativeSentinelsInBuffer(buffer).includes(versionSentinelExportFor(version));
	} catch {
		return false;
	}
}

/**
 * Pure, direction-agnostic plan for copying addons between `native/` and the
 * per-version cache. Returns one `{ src, dest }` per filename whose source copy
 * IS current but whose destination copy is NOT yet — the exact set worth copying.
 * The ONE owner of that decision, used in BOTH directions: mirror (native → cache)
 * populates the loader's fallback, and restore (cache → native) seeds a fresh
 * source tree offline. Kept pure (predicates injected) so both directions are
 * unit-testable without touching the real filesystem.
 */
export function addonCopyPlan(input: {
	filenames: string[];
	fromDir: string;
	toDir: string;
	fromIsCurrent: (file: string) => boolean;
	toIsCurrent: (file: string) => boolean;
}): Array<{ src: string; dest: string }> {
	const plan: Array<{ src: string; dest: string }> = [];
	for (const name of input.filenames) {
		const src = path.join(input.fromDir, name);
		const dest = path.join(input.toDir, name);
		if (input.fromIsCurrent(src) && !input.toIsCurrent(dest)) {
			plan.push({ src, dest });
		}
	}
	return plan;
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Execute an addon copy plan with atomic per-file writes. A failed copy is
 * surfaced LOUDLY (never swallowed) but does not throw: both callers treat a copy
 * as a resilience step, and the loader's own candidate list plus sentinel check
 * are the real guard, so one failed copy must not abort provisioning.
 */
function executeCopyPlan(plan: Array<{ src: string; dest: string }>): void {
	if (plan.length === 0) return;
	for (const dir of new Set(plan.map(item => path.dirname(item.dest)))) {
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch (err) {
			console.error(`veyyon natives: could not create ${dir}: ${describeError(err)}`);
		}
	}
	for (const { src, dest } of plan) {
		const tmp = `${dest}.tmp.${process.pid}`;
		try {
			fs.copyFileSync(src, tmp);
			fs.renameSync(tmp, dest);
		} catch (err) {
			console.error(
				`veyyon natives: could not copy ${path.basename(src)} into ${path.dirname(dest)}: ${describeError(err)}`,
			);
			try {
				fs.unlinkSync(tmp);
			} catch {
				// The temp file may not exist if the copy itself failed.
			}
		}
	}
}

/**
 * Copy every current in-tree addon into the per-version cache so a later source
 * sync that drops the gitignored `native/*.node` still boots from the cache. The
 * primary `native/` copy the loader tries first already works, so this is a
 * resilience net, not a load-bearing step.
 */
function mirrorCurrentAddonsToCache(filenames: string[]): void {
	executeCopyPlan(
		addonCopyPlan({
			filenames,
			fromDir: nativeDir,
			toDir: versionedNativeCacheDir(version),
			fromIsCurrent: addonIsCurrent,
			toIsCurrent: addonIsCurrent,
		}),
	);
	// Now that this version's cache is warm, no older one can ever be loaded
	// again: the loader looks only under its own version, and the addon carries a
	// version sentinel a different release cannot expose. Each of those
	// directories is around 150MB and nothing removed them, so a machine that had
	// been through three updates carried three full copies until uninstall.
	const pruned = cleanupStaleNativeVersions({ nativesDir: nativesRootDir(), currentVersion: version });
	for (const dir of pruned.removed) {
		console.error(`veyyon natives: reclaimed the stale addon cache at ${dir}.`);
	}
	for (const failure of pruned.failed) {
		console.error(`veyyon natives: could not remove the stale addon cache at ${failure.dir}: ${failure.reason}`);
	}
}

/**
 * Seed `native/` from a warm per-version cache. This is the OFFLINE fast path: a
 * fresh source tree whose cache was populated by a prior standalone install (or a
 * previous ensure) boots with no network request and no Rust toolchain, and the
 * launcher's self-heal no longer fails closed just because the machine is offline.
 */
function restoreNativeFromCache(filenames: string[]): void {
	executeCopyPlan(
		addonCopyPlan({
			filenames,
			fromDir: versionedNativeCacheDir(version),
			toDir: nativeDir,
			fromIsCurrent: addonIsCurrent,
			toIsCurrent: addonIsCurrent,
		}),
	);
}

/**
 * Why a prebuilt download did not produce an addon.
 *
 * Every one of these used to collapse into `return false`, and the closing
 * failure paragraph then GUESSED at the cause ("no prebuilt asset for this
 * platform, or the network is unreachable"). A 404 for an unbuilt platform, a
 * 500 from GitHub, a missing checksum sidecar, a corrupted body, and a full
 * disk are five different problems with five different fixes, and the operator
 * was shown a sentence that covered two of them and named neither (Law 10).
 */
export interface AssetFailure {
	filename: string;
	reason: string;
}

export type AssetResult = { ok: true } | { ok: false; failure: AssetFailure };

function assetFailed(filename: string, reason: string): AssetResult {
	return { ok: false, failure: { filename, reason } };
}

async function downloadAsset(filename: string): Promise<AssetResult> {
	const base = `https://github.com/${repoSlug}/releases/download/v${version}`;
	let assetRes: Response;
	let shaRes: Response;
	try {
		[assetRes, shaRes] = await Promise.all([
			fetch(`${base}/${filename}`, { signal: AbortSignal.timeout(ASSET_TIMEOUT_MS) }),
			fetch(`${base}/${filename}.sha256`, { signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS) }),
		]);
	} catch (err) {
		// A timeout is an AbortError; naming it keeps "the network hung" from
		// reading as "the release has no asset for you".
		const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
		return assetFailed(
			filename,
			timedOut
				? `timed out fetching it from ${base}`
				: `could not reach ${base} (${errorText(err)})`,
		);
	}
	// 404 on the asset is the ordinary "this platform has no prebuilt" case and
	// reads differently from a server error, which is worth retrying later.
	if (!assetRes.ok) {
		return assetFailed(
			filename,
			assetRes.status === 404
				? `the v${version} release publishes no such asset (HTTP 404)`
				: `HTTP ${assetRes.status} ${assetRes.statusText} fetching the asset`,
		);
	}
	// A missing sidecar is NOT the same as a missing asset: the addon is there
	// and the integrity gate cannot run, which is exactly when refusing matters.
	if (!shaRes.ok) {
		return assetFailed(
			filename,
			`the asset exists but its .sha256 sidecar returned HTTP ${shaRes.status}, so it cannot be verified`,
		);
	}
	let bytes: Uint8Array;
	let expected: string | undefined;
	try {
		bytes = new Uint8Array(await assetRes.arrayBuffer());
		expected = (await shaRes.text()).trim().split(/\s+/)[0]?.toLowerCase();
	} catch (err) {
		return assetFailed(filename, `the download was interrupted (${errorText(err)})`);
	}
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	const actual = hasher.digest("hex");
	if (!expected) {
		return assetFailed(filename, "the published .sha256 sidecar is empty or unparseable");
	}
	if (actual !== expected) {
		return assetFailed(filename, `checksum mismatch (expected ${expected}, got ${actual}); refusing it`);
	}
	const target = path.join(nativeDir, filename);
	const tmp = `${target}.download`;
	try {
		fs.mkdirSync(nativeDir, { recursive: true });
		fs.writeFileSync(tmp, bytes);
		fs.renameSync(tmp, target);
	} catch (err) {
		// Never leave a partial file where the loader might find it.
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// The cleanup failing does not change the diagnosis below.
		}
		return assetFailed(filename, `verified download could not be written to ${nativeDir} (${errorText(err)})`);
	}
	return { ok: true };
}

/** The message from an unknown thrown value, without an `[object Object]`. */
function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function cargoBuild(): Promise<boolean> {
	if (!Bun.which("cargo")) return false;
	console.error("veyyon natives: building the native addon locally (cargo)...");
	const proc = Bun.spawn(["bun", "scripts/build-native.ts"], {
		cwd: nativesRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	return (await proc.exited) === 0;
}

/**
 * The one paragraph shown when provisioning fails, built from the real reasons
 * rather than a guess at them.
 *
 * Exported for direct testing: the failure path is the hardest one to reach
 * naturally and the easiest to let rot into a sentence that no longer matches
 * the code that prints it.
 */
export function formatProvisioningFailure(failures: AssetFailure[], cargoMissing: boolean): string {
	const host = `${process.platform}-${process.arch}`;
	const attempted =
		failures.length > 0
			? failures.map(f => `  - ${f.filename}: ${f.reason}`).join("\n")
			: "  - (no candidate asset names for this host)";
	const buildLine = cargoMissing
		? "No Rust toolchain is available for a local build."
		: "A local Rust build was attempted and did not produce a loadable addon; its output is above.";
	return (
		`veyyon: the native addon for this host (${host}) is missing and could not be provisioned.\n` +
		`Tried the v${version} release:\n${attempted}\n` +
		`${buildLine}\n` +
		"Fix: install Rust (https://rustup.rs) and run `bun --cwd=packages/natives run build` in the checkout, " +
		"or reinstall the standalone binary: curl -fsSL https://get.veyyon.dev | sh"
	);
}

async function main(): Promise<void> {
	const filenames = hostAddonFilenames();
	const nativeIsCurrent = () => filenames.some(name => addonIsCurrent(path.join(nativeDir, name)));

	if (nativeIsCurrent()) {
		mirrorCurrentAddonsToCache(filenames);
		return;
	}

	// Offline fast path: a warm per-version cache (from a prior standalone install
	// or an earlier ensure) seeds native/ with no network and no toolchain, so a
	// source tree that lost its gitignored native/*.node self-heals even offline.
	restoreNativeFromCache(filenames);
	if (nativeIsCurrent()) return;

	console.error(
		`veyyon natives: no ${version} addon for this host; fetching the prebuilt from the v${version} release...`,
	);
	const failures: AssetFailure[] = [];
	for (const name of filenames) {
		const result = await downloadAsset(name);
		if (result.ok) {
			console.error(`veyyon natives: installed prebuilt ${name}.`);
			mirrorCurrentAddonsToCache(filenames);
			return;
		}
		failures.push(result.failure);
	}

	const cargoMissing = !Bun.which("cargo");
	if ((await cargoBuild()) && nativeIsCurrent()) {
		mirrorCurrentAddonsToCache(filenames);
		return;
	}

	console.error(formatProvisioningFailure(failures, cargoMissing));
	process.exit(1);
}

if (import.meta.main) {
	await main();
}
