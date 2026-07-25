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
	getAddonFilenames,
	nativeSentinelsInBuffer,
	selectCpuVariant,
	versionedNativeCacheDir,
	versionSentinelExportFor,
} from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const nativesRoot = path.join(import.meta.dir, "..");
const nativeDir = path.join(nativesRoot, "native");
const version: string = packageJson.version;
const repoSlug = "santhreal/veyyon";

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
 * Pure plan for mirroring provisioned addons into the per-version cache. Returns
 * one `{ src, dest }` per filename whose in-tree copy IS current but whose cache
 * copy is NOT yet — the exact set that must be copied so the loader's cache
 * fallback (`resolveLoaderCandidates`) is populated for a user who only ever
 * source-installs and never runs the standalone binary. Kept pure (predicates
 * injected) so the decision is unit-testable without touching the real cache.
 */
export function cacheMirrorPlan(input: {
	filenames: string[];
	nativeDir: string;
	cacheDir: string;
	srcIsCurrent: (file: string) => boolean;
	destIsCurrent: (file: string) => boolean;
}): Array<{ src: string; dest: string }> {
	const plan: Array<{ src: string; dest: string }> = [];
	for (const name of input.filenames) {
		const src = path.join(input.nativeDir, name);
		const dest = path.join(input.cacheDir, name);
		if (input.srcIsCurrent(src) && !input.destIsCurrent(dest)) {
			plan.push({ src, dest });
		}
	}
	return plan;
}

/**
 * Copy every current in-tree addon into the per-version cache so a later source
 * sync that drops the gitignored `native/*.node` still boots from the cache. A
 * failed mirror is surfaced LOUDLY (never swallowed) but does not fail the
 * install: the primary `native/` copy the loader tries first already works, so a
 * cache mirror is a resilience net, not a load-bearing step.
 */
function mirrorCurrentAddonsToCache(filenames: string[]): void {
	const cacheDir = versionedNativeCacheDir(version);
	const plan = cacheMirrorPlan({
		filenames,
		nativeDir,
		cacheDir,
		srcIsCurrent: addonIsCurrent,
		destIsCurrent: addonIsCurrent,
	});
	if (plan.length === 0) return;
	try {
		fs.mkdirSync(cacheDir, { recursive: true });
	} catch (err) {
		console.error(
			`veyyon natives: could not create the addon cache ${cacheDir}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}
	for (const { src, dest } of plan) {
		const tmp = `${dest}.tmp.${process.pid}`;
		try {
			fs.copyFileSync(src, tmp);
			fs.renameSync(tmp, dest);
		} catch (err) {
			console.error(
				`veyyon natives: could not mirror ${path.basename(src)} into the cache: ${err instanceof Error ? err.message : String(err)}`,
			);
			try {
				fs.unlinkSync(tmp);
			} catch {
				// The temp file may not exist if the copy itself failed.
			}
		}
	}
}

async function downloadAsset(filename: string): Promise<boolean> {
	const base = `https://github.com/${repoSlug}/releases/download/v${version}`;
	try {
		const [assetRes, shaRes] = await Promise.all([fetch(`${base}/${filename}`), fetch(`${base}/${filename}.sha256`)]);
		if (!assetRes.ok || !shaRes.ok) return false;
		const bytes = new Uint8Array(await assetRes.arrayBuffer());
		const expected = (await shaRes.text()).trim().split(/\s+/)[0]?.toLowerCase();
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(bytes);
		const actual = hasher.digest("hex");
		if (!expected || actual !== expected) {
			console.error(
				`veyyon natives: checksum mismatch for ${filename} (expected ${expected}, got ${actual}); refusing it.`,
			);
			return false;
		}
		const target = path.join(nativeDir, filename);
		const tmp = `${target}.download`;
		fs.writeFileSync(tmp, bytes);
		fs.renameSync(tmp, target);
		return true;
	} catch {
		return false;
	}
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

async function main(): Promise<void> {
	const filenames = hostAddonFilenames();
	if (filenames.some(name => addonIsCurrent(path.join(nativeDir, name)))) {
		mirrorCurrentAddonsToCache(filenames);
		return;
	}

	console.error(
		`veyyon natives: no ${version} addon for this host; fetching the prebuilt from the v${version} release...`,
	);
	for (const name of filenames) {
		if (await downloadAsset(name)) {
			console.error(`veyyon natives: installed prebuilt ${name}.`);
			mirrorCurrentAddonsToCache(filenames);
			return;
		}
	}

	if ((await cargoBuild()) && filenames.some(name => addonIsCurrent(path.join(nativeDir, name)))) {
		mirrorCurrentAddonsToCache(filenames);
		return;
	}

	console.error(
		`veyyon: the native addon for this host is missing and could not be provisioned. ` +
			`The v${version} release has no prebuilt asset for ${process.platform}-${process.arch} ` +
			`(or the network is unreachable), and no Rust toolchain is available for a local build. ` +
			`Fix: install Rust (https://rustup.rs) and run \`bun --cwd=packages/natives run build\` in the checkout, ` +
			`or reinstall the standalone binary: curl -fsSL https://get.veyyon.dev | sh`,
	);
	process.exit(1);
}

if (import.meta.main) {
	await main();
}
