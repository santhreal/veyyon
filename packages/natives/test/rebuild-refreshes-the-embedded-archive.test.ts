/**
 * A rebuild has to be a rebuild, and the startup marker has to say which binary loaded.
 *
 * WHY THIS SUITE EXISTS. `bun --cwd=packages/natives run build` rebuilt the addon into
 * `native/veyyon_natives.<tag>.node` correctly, and a probe kept returning the OLD behaviour, for
 * hours. Two separate causes stacked, and each hid the other.
 *
 * (1) `build` did not regenerate `native/embedded-addons.<tag>.tar.gz`; only `gen:native` did. A
 * compiled binary loads what it extracted from that archive into `~/.veyyon/natives/<version>/`, so
 * the corrected addon sat in the tree while every load came from a four-hour-old copy.
 *
 * (2) The startup marker printed `path.basename(candidate)`. The cache copy and the in-tree build
 * have the SAME file name, so the one line a developer reads to answer "which binary am I running"
 * read identically for both, and the version sentinel did not separate them either because both are
 * the same release.
 *
 * That is a Law 10 silent fallback pointed at developers rather than operators: the loader silently
 * preferred a stale binary and reported something consistent with either. It also invalidated an
 * earlier worktree-isolation check on a different row, because a worktree cannot isolate an addon
 * loaded from `~/.veyyon`.
 *
 * WHAT THESE CASES DO AND DO NOT PROVE. They read the two sources, because both defects are a line
 * of code that was written one way and had to be written another, and neither is observable without
 * a real napi build (minutes of cargo, a toolchain, and a host whose glibc matches the portability
 * floor). An end-to-end case that writes a sentinel into the in-tree `.node`, runs the documented
 * rebuild, and asserts the loaded addon is the new one is the right test and is not written here;
 * see the row in `BACKLOG.md`.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const PACKAGE_ROOT = path.join(import.meta.dir, "..");

function read(relative: string): string {
	return fs.readFileSync(path.join(PACKAGE_ROOT, relative), "utf-8");
}

describe("the build refreshes the embedded archive", () => {
	/**
	 * The fix for (1). `build-native.ts` runs `embed-native.ts` as its last step, so the addon and the
	 * archive are written by the same command and cannot drift.
	 */
	it("runs the embed script as part of a build", () => {
		const source = read("scripts/build-native.ts");

		expect(source).toContain("refreshEmbeddedArchive");
		expect(source).toContain("embed-native.ts");
		// After the addon is installed and the bindings are generated, not before: the archive is built
		// from the addon, so refreshing it first would package the previous one.
		expect(source.indexOf("await refreshEmbeddedArchive()")).toBeGreaterThan(
			source.indexOf("await installGeneratedBindings(buildOutputDir)"),
		);
	});

	/**
	 * And it fails the build rather than warning. A refresh that failed quietly would leave exactly
	 * the mismatched pair this change exists to prevent, with a build that reported success.
	 */
	it("fails the build when the refresh fails", () => {
		const source = read("scripts/build-native.ts");
		const body = source.slice(
			source.indexOf("async function refreshEmbeddedArchive"),
			source.indexOf("async function installGeneratedBindings"),
		);

		expect(body).toContain("throw new Error(");
		expect(body).toContain("gen:native");
		// `.nothrow()` so the real stderr can be attached to the thrown message instead of a shell trace.
		expect(body).toContain(".nothrow()");
	});
});

describe("the startup marker names the binary", () => {
	/**
	 * The fix for (2). The marker prints the resolved absolute path, so the extracted cache copy and
	 * an in-tree build are distinguishable in the one line a developer reads.
	 */
	it("prints a resolved absolute path rather than a file name", () => {
		const source = read("native/loader-state.js");

		// biome-ignore lint/suspicious/noTemplateCurlyInString: quotes the generated loader JS; the ${...} is its bytes, not this file's.
		expect(source).toContain("startupMarker(`native:require:${path.resolve(candidate)}`)");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: quotes the generated loader JS; the ${...} is its bytes, not this file's.
		expect(source).not.toContain("startupMarker(`native:require:${path.basename(candidate)}`)");
	});

	/**
	 * `path.resolve` and not the raw candidate, because a candidate can be relative depending on how
	 * the loader was reached, and a relative path answers the question no better than a basename.
	 */
	it("resolves the candidate rather than printing it as given", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: quotes the generated loader JS; the ${...} is its bytes, not this file's.
		expect(read("native/loader-state.js")).not.toContain("startupMarker(`native:require:${candidate}`)");
	});
});
