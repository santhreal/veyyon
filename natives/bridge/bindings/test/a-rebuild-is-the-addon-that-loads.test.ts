/**
 * A rebuild has to be the addon that loads, and the marker has to say which one did.
 *
 * WHY THIS SUITE EXISTS. `bun --cwd=natives/bridge/bindings run build` rebuilt the addon into
 * `native/veyyon_natives.<tag>.node` correctly, a direct `require` of that file returned the
 * corrected value, and every probe through the package kept returning the OLD behaviour, for hours.
 * Three things stacked, and each hid the next.
 *
 * (1) `build` did not regenerate `native/embedded-addons.<tag>.tar.gz`; only `gen:native` did. A
 * compiled binary loads what it extracted from that archive into `<data home>/veyyon/natives/<version>/`,
 * so the corrected addon sat in the tree while every load came from a four-hour-old copy.
 *
 * (2) The candidate loop caught the version-sentinel rejection along with the `require`, so a
 * rejected in-tree build fell through to the cache copy that always ends the candidate list.
 *
 * (3) The startup marker printed `path.basename(candidate)`. The cache copy and the in-tree build
 * have the SAME file name, so the one line a developer reads to answer "which binary am I running"
 * read identically for both, and the version sentinel did not separate them either because both are
 * the same release.
 *
 * WHAT THESE CASES DO. They drive the real loader in a real subprocess against a real addon, with a
 * cache copy planted in a redirected data home and marked by trailing bytes, and they compare the
 * bytes of the archive against the bytes of the addon in the tree. The sentinel is what makes the
 * answer observable: the file the loader actually opened either carries it or does not.
 *
 * WHAT THEY DO NOT PROVE. Nothing here runs `napi build`, so a build that writes a WRONG addon and a
 * correct archive of it is out of scope; the archive case sees drift between the pair, not a bad
 * pair. Nothing here is a compiled binary either: the compiled-shape case forces the candidate order
 * a binary gets, but `maybeExtractEmbeddedAddon` needs a real embedded bundle, so extraction from the
 * archive at boot is exercised only through `extractEmbeddedAddonArchive` directly. Both cases need
 * an addon built for this host; with none in the tree there is no pair that can drift and no load to
 * observe, and the suite says so rather than passing quietly.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractEmbeddedAddonArchive, getAddonFilenames } from "../native/loader-state.js";

const PACKAGE_ROOT = path.join(import.meta.dir, "..");
const NATIVE_DIR = path.join(PACKAGE_ROOT, "native");
const PLATFORM_TAG = `${process.platform}-${process.arch}`;
const archivePathFor = (filename: string): string =>
	path.join(NATIVE_DIR, `embedded-addons.${PLATFORM_TAG}-${variantOf(filename)}.tar.gz`);
const PACKAGE_VERSION = (
	JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8")) as { version: string }
).version;
const SENTINEL = Buffer.from("\nveyyon-cache-copy-sentinel\n", "utf-8");

/** The variant this host's addon files carry, read off the tree rather than assumed. */
function builtVariant(): "modern" | "baseline" | null {
	for (const variant of ["modern", "baseline"] as const) {
		if (fs.existsSync(path.join(NATIVE_DIR, `veyyon_natives.${PLATFORM_TAG}-${variant}.node`))) return variant;
	}
	return null;
}

const VARIANT = builtVariant();
const ADDON_FILENAME = getAddonFilenames({ tag: PLATFORM_TAG, arch: process.arch, variant: VARIANT })[0];
const ADDON_PATH = path.join(NATIVE_DIR, ADDON_FILENAME);
const HAS_ADDON = fs.existsSync(ADDON_PATH);

/**
 * The marker's path, made comparable. `path.resolve` in the loader answers against the subprocess's
 * working directory, and a temp root is a symlink on macOS, so two spellings of one file are
 * expected; a file that does not exist keeps its spelling so a wrong path still reads as itself.
 */
function realPath(target: string): string {
	try {
		return fs.realpathSync(path.resolve(target));
	} catch {
		return target;
	}
}

/** Every addon file in the tree for this platform, so a new variant is covered without an edit. */
function addonsInTree(): string[] {
	return fs
		.readdirSync(NATIVE_DIR)
		.filter(name => name.startsWith(`veyyon_natives.${PLATFORM_TAG}`) && name.endsWith(".node"))
		.sort();
}

/** The variant an addon filename names, read off the name the build wrote. */
function variantOf(filename: string): "modern" | "baseline" | "default" {
	if (filename.endsWith("-modern.node")) return "modern";
	if (filename.endsWith("-baseline.node")) return "baseline";
	return "default";
}

interface LoadObservation {
	requiredPaths: string[];
	stdout: string;
	stderr: string;
}

/**
 * Load the package in a subprocess with the startup marker on, and report which files the loader
 * opened. `compiled` forces the candidate order a compiled binary gets (cache before tree).
 */
function observeLoad({ dataHome, compiled }: { dataHome: string; compiled: boolean }): LoadObservation {
	const scriptPath = path.join(dataHome, `load-probe-${compiled ? "compiled" : "source"}.mjs`);
	// The entry specifier is the absolute path of the package under test, chosen by this harness at
	// run time; a static import would load the addon in the test process instead of the subprocess
	// whose environment is the thing being varied.
	fs.writeFileSync(
		scriptPath,
		[
			`const native = await import(${JSON.stringify(path.join(NATIVE_DIR, "index.js"))});`,
			`process.stdout.write(String(native.visibleWidth("abc", 4)));`,
			"",
		].join("\n"),
	);
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		XDG_DATA_HOME: dataHome,
		VEYYON_DEBUG_STARTUP: "1",
	};
	if (VARIANT) env.VEYYON_NATIVE_VARIANT = VARIANT;
	if (compiled) env.VEYYON_COMPILED = "true";
	else delete env.VEYYON_COMPILED;
	const stderrPath = path.join(dataHome, "probe.stderr");
	const stderrFd = fs.openSync(stderrPath, "w");
	let stdout: string;
	try {
		stdout = execFileSync(process.execPath, [scriptPath], {
			encoding: "utf-8",
			env,
			stdio: ["ignore", "pipe", stderrFd],
		});
	} finally {
		fs.closeSync(stderrFd);
	}
	const stderr = fs.readFileSync(stderrPath, "utf-8");
	const requiredPaths = [...stderr.matchAll(/^\[startup] native:require:(.+)$/gm)].map(match =>
		realPath(match[1] ?? ""),
	);
	return { requiredPaths, stdout, stderr };
}

/** A data home holding a loadable copy of the addon, marked so the loaded file is identifiable. */
function dataHomeWithMarkedCacheCopy(): { dataHome: string; cachePath: string } {
	const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-addon-load-"));
	const versionedDir = path.join(dataHome, "veyyon", "natives", PACKAGE_VERSION);
	fs.mkdirSync(versionedDir, { recursive: true });
	const cachePath = path.join(versionedDir, ADDON_FILENAME);
	// Trailing bytes past the ELF/Mach-O images the dynamic loader maps: the copy stays loadable, and
	// the two files are no longer the same bytes or the same size.
	fs.writeFileSync(cachePath, Buffer.concat([fs.readFileSync(ADDON_PATH), SENTINEL]), { mode: 0o755 });
	return { dataHome, cachePath };
}

describe("the addon in the tree is the one that loads", () => {
	it("requires an addon built for this host", () => {
		// Not a skip: with no addon there is nothing to load and nothing that can drift, and a quiet
		// pass here is what let a stale copy answer for four hours.
		expect(HAS_ADDON, `no addon at ${ADDON_PATH}; run: bun --cwd=natives/bridge/bindings run build`).toBe(true);
	});

	it.if(HAS_ADDON)("prefers the in-tree build over a cache copy of the same version", () => {
		const { dataHome, cachePath } = dataHomeWithMarkedCacheCopy();
		try {
			const observed = observeLoad({ dataHome, compiled: false });

			expect(observed.stdout).toBe("3");
			expect(observed.requiredPaths).toEqual([realPath(ADDON_PATH)]);
			const loaded = fs.readFileSync(observed.requiredPaths[0] ?? "");
			expect(loaded.subarray(-SENTINEL.length).equals(SENTINEL)).toBe(false);
			expect(loaded.equals(fs.readFileSync(ADDON_PATH))).toBe(true);
			expect(observed.requiredPaths).not.toContain(realPath(cachePath));
		} finally {
			fs.rmSync(dataHome, { recursive: true, force: true });
		}
	});

	it.if(HAS_ADDON)("names the resolved path of the copy it opened, not a file name", () => {
		// The control for the case above: with a binary's candidate order the SAME planted copy is the
		// one that loads, so the marker discriminates between two files of one name, and the sentinel
		// copy is proven loadable rather than merely unopened.
		const { dataHome, cachePath } = dataHomeWithMarkedCacheCopy();
		try {
			const observed = observeLoad({ dataHome, compiled: true });

			expect(observed.stdout).toBe("3");
			expect(observed.requiredPaths).toEqual([realPath(cachePath)]);
			expect(path.isAbsolute(realPath(cachePath))).toBe(true);
			expect(path.basename(cachePath)).toBe(path.basename(ADDON_PATH));
			const loaded = fs.readFileSync(cachePath);
			expect(loaded.subarray(-SENTINEL.length).equals(SENTINEL)).toBe(true);
		} finally {
			fs.rmSync(dataHome, { recursive: true, force: true });
		}
	});
});

describe("the embedded archives carry what the tree carries", () => {
	it.if(HAS_ADDON && fs.existsSync(archivePathFor(ADDON_FILENAME)))(
		"extracts to the bytes of every addon in the tree",
		() => {
			// One archive per variant now, so each is checked against its own addon. A variant whose
			// archive is missing is drift too: the build writes one for every addon it found.
			const filenames = addonsInTree();
			expect(filenames).toContain(ADDON_FILENAME);
			const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-archive-"));
			try {
				for (const filename of filenames) {
					const archivePath = archivePathFor(filename);
					expect(
						fs.existsSync(archivePath),
						`${path.basename(archivePath)} is missing; a rebuild must write one archive per variant ` +
							"(bun --cwd=natives/bridge/bindings run build)",
					).toBe(true);

					const written = extractEmbeddedAddonArchive({
						archivePath,
						files: [{ filename, variant: variantOf(filename) }],
						targetDir,
					});

					expect(written.map(target => path.basename(target))).toEqual([filename]);
					const fromArchive = fs.readFileSync(path.join(targetDir, filename));
					const fromTree = fs.readFileSync(path.join(NATIVE_DIR, filename));
					expect(
						fromArchive.equals(fromTree),
						`${filename} in ${path.basename(archivePath)} is not the build in the tree; ` +
							"a rebuild must refresh the archive (bun --cwd=natives/bridge/bindings run build)",
					).toBe(true);
				}
			} finally {
				fs.rmSync(targetDir, { recursive: true, force: true });
			}
		},
	);

	it("refuses to write an archive it cannot fill, and writes nothing on the way out", () => {
		// The refresh runs as the last step of the build and a quiet failure there leaves exactly the
		// mismatched pair above with a build that reported success. Asked for a platform this tree has
		// no addon for, it must fail and must not have half-written the two files it owns.
		const metadataPath = path.join(NATIVE_DIR, "embedded-addon.js");
		const metadataBefore = fs.readFileSync(metadataPath);
		const archivesBefore = addonsInTree().map(filename => ({
			archivePath: archivePathFor(filename),
			bytes: fs.existsSync(archivePathFor(filename)) ? fs.readFileSync(archivePathFor(filename)) : null,
		}));
		let failure: { status: number | null; stderr: string } | null = null;
		try {
			execFileSync(process.execPath, [path.join(PACKAGE_ROOT, "scripts", "embed-native.ts")], {
				encoding: "utf-8",
				env: { ...(process.env as Record<string, string>), TARGET_PLATFORM: "aix", TARGET_ARCH: "ppc64" },
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			const spawned = err as { status?: number | null; stderr?: Buffer | string };
			failure = { status: spawned.status ?? null, stderr: String(spawned.stderr ?? "") };
		}

		expect(failure).not.toBeNull();
		expect(failure?.status).not.toBe(0);
		expect(failure?.stderr).toContain("No native addons found for aix-ppc64");
		expect(failure?.stderr).toContain("veyyon_natives.aix-ppc64.node");
		expect(fs.readFileSync(metadataPath).equals(metadataBefore)).toBe(true);
		expect(fs.readdirSync(NATIVE_DIR).filter(name => name.startsWith("embedded-addons.aix-ppc64"))).toEqual([]);
		for (const before of archivesBefore) {
			if (before.bytes) expect(fs.readFileSync(before.archivePath).equals(before.bytes)).toBe(true);
		}
	});
});
