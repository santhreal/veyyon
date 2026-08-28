#!/usr/bin/env bun
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
import { parseSha256Sidecar } from "../src/sha256-sidecar";

const nativesRoot = path.join(import.meta.dir, "..");
const nativeDir = path.join(nativesRoot, "native");
const version: string = packageJson.version;
const repoSlug = "santhreal/veyyon";
const ASSET_TIMEOUT_MS = 10 * 60_000;
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
	const names = getAddonFilenames({ tag, arch: process.arch, variant });
	if (process.arch === "x64") {
		const modern = `veyyon_natives.${tag}-modern.node`;
		if (!names.includes(modern)) names.unshift(modern);
	}
	return names;
}

export function addonIsCurrent(file: string): boolean {
	try {
		const buffer = fs.readFileSync(file);
		return nativeSentinelsInBuffer(buffer).includes(versionSentinelExportFor(version));
	} catch {
		return false;
	}
}

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
			} catch {}
		}
	}
}

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
	const pruned = cleanupStaleNativeVersions({ nativesDir: nativesRootDir(), currentVersion: version });
	for (const dir of pruned.removed) {
		console.error(`veyyon natives: reclaimed the stale addon cache at ${dir}.`);
	}
	for (const failure of pruned.failed) {
		console.error(`veyyon natives: could not remove the stale addon cache at ${failure.dir}: ${failure.reason}`);
	}
}

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
		const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
		return assetFailed(
			filename,
			timedOut ? `timed out fetching it from ${base}` : `could not reach ${base} (${errorText(err)})`,
		);
	}
	if (!assetRes.ok) {
		return assetFailed(
			filename,
			assetRes.status === 404
				? `the v${version} release publishes no such asset (HTTP 404)`
				: `HTTP ${assetRes.status} ${assetRes.statusText} fetching the asset`,
		);
	}
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
		expected = parseSha256Sidecar(await shaRes.text()) ?? undefined;
	} catch (err) {
		return assetFailed(filename, `the download was interrupted (${errorText(err)})`);
	}
	if (!expected) {
		return assetFailed(filename, "the published .sha256 sidecar is empty or unparseable");
	}
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	const actual = hasher.digest("hex");
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
		try {
			fs.rmSync(tmp, { force: true });
		} catch {}
		return assetFailed(filename, `verified download could not be written to ${nativeDir} (${errorText(err)})`);
	}
	return { ok: true };
}

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
