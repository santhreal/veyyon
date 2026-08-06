import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";
import { RELEASE_TARGETS } from "../packages/coding-agent/scripts/binary-targets";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";

const repoRoot = path.join(import.meta.dir, "..");

/**
 * The release build and a local cross-build must compile the same platform the
 * same way.
 *
 * They used to hold two target tables and stay aligned by hand, and the drift
 * that mattered shipped twice: `veyyon-windows-x64.exe` segfaulted at launch for
 * v1.0.36 and again for v1.0.37, each fix landing in one table at a time. The
 * table is now one module both read, so these tests assert the derivation for
 * EVERY target rather than for the one that happened to break. A per-target loop
 * is the point: pinning only Windows is how the first copy stayed wrong.
 */
describe("local cross-builds derive from the release target table", () => {
	it("resolves every release target id to that row's exact triple", () => {
		expect(RELEASE_TARGETS.length).toBeGreaterThan(0);
		for (const target of RELEASE_TARGETS) {
			expect(resolveCrossBuild(target.id)).toEqual({
				id: target.id,
				platform: target.platform,
				arch: target.arch,
				target: target.target,
			});
		}
	});

	it("resolves the windows-x64 alias to the win32-x64 row while keeping the requested id", () => {
		// The id names the local output file (`dist/vey-<id>`), so an alias keeps
		// what you typed; only the triple comes from the table.
		const win32 = RELEASE_TARGETS.find(target => target.id === "win32-x64");
		// Narrowing, not just an assertion: the expectation below reads four
		// fields off this row, and an optional chain would type them all as
		// possibly-undefined and no longer match a CrossBuild.
		if (!win32) throw new Error("RELEASE_TARGETS has no win32-x64 row");
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: win32.platform,
			arch: win32.arch,
			target: win32.target,
		});
	});

	it("treats an unset CROSS_TARGET as a native build and an unknown one as an error", () => {
		expect(resolveCrossBuild(undefined)).toBeNull();
		expect(resolveCrossBuild("")).toBeNull();
		expect(() => resolveCrossBuild("linux-riscv64")).toThrow("Unsupported CROSS_TARGET: linux-riscv64");
	});

	/**
	 * Bytecode is per target and not per builder: a cross-compiled bytecode
	 * executable segfaults in JSC bytecode decoding at launch (oven-sh/bun#18416),
	 * which is what killed the published Windows exe. Windows is the only target
	 * built on a foreign runner today, so it is the only one that must stay off.
	 */
	it("keeps bytecode off for the cross-compiled Windows target and on for the natively built ones", () => {
		for (const target of RELEASE_TARGETS) {
			expect(target.bytecode, `${target.id} bytecode`).toBe(target.platform !== "win32");
		}
	});
});

describe("the release build walks the shared table", () => {
	/** Locks the MODERN (AVX2) Windows target through the real script. Baseline
	 * Windows standalones segfault in Bun's JIT codegen at startup
	 * (oven-sh/bun#32684, #32586): the shipped v1.0.36 exe died on `--version`
	 * with exit 3, caught by release_github_verify_windows. A regression back to
	 * `-baseline` would ship a binary that cannot start on ANY machine; modern
	 * only drops pre-2013 (pre-AVX2) CPUs. Revisit when the Bun issue is fixed. */
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

	it("rejects a target the shared table does not name", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets linux-riscv64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).not.toBe(0);
		expect(result.text() + result.stderr.toString()).toContain("Unknown release target(s): linux-riscv64");
	});
});
