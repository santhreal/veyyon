import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";

const repoRoot = path.join(import.meta.dir, "..");

describe("Windows release binary target", () => {
	/** Locks the MODERN (AVX2) Windows target. Baseline Windows standalones
	 * segfault in Bun's JIT codegen at startup (oven-sh/bun#32684, #32586):
	 * the shipped v1.0.36 exe died on `--version` with exit 3, caught by
	 * release_github_verify_windows. A regression back to `-baseline` would
	 * ship a binary that cannot start on ANY machine; modern only drops
	 * pre-2013 (pre-AVX2) CPUs. Revisit when the Bun issue is fixed. */
	it("builds the generic Windows release asset with the modern (non-baseline) runtime", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		expect(output).toContain("Building packages/coding-agent/binaries/veyyon-windows-x64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-x64 outfile=packages/coding-agent/binaries/veyyon-windows-x64.exe",
		);
		expect(output).toContain("external=fastembed,onnxruntime-node");
		expect(output).not.toContain("bun-windows-x64-baseline");
	});

	/** The local cross-build aliases must stay in lockstep with the release
	 * target above — two definitions of the Windows target exist (build-binary.ts
	 * and ci-release-build-binaries.ts) and a baseline copy sneaking back into
	 * either ships the startup crash again. */
	it("uses the modern runtime for local Windows cross-build aliases", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64",
		});
	});
});
