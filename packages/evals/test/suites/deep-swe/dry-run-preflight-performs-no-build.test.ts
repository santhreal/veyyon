/**
 * WHY THIS SUITE EXISTS:
 *
 * Running `evals --dry-run` is documented as inspecting the matrix plan and
 * running preflight checks without executing trials or building artifacts.
 * In DeepSWE, preflight previously called `ensureBinaryUpToDate()` and
 * `ensureAuthDbSeeded()` without gating on `dryRun`, triggering a full product
 * build (embedding native addons, generating tool views, building client
 * bundles) and copying the auth database to assets/ during what was supposed to
 * be a side-effect-free dry run.
 *
 * This suite defends the invariant at the preflight choke point:
 * 1. DeepSWE dry-run preflight never spawns binary builds or mutates files on disk.
 * 2. When the required binary artifact is missing or stale, preflight returns a
 *    refusal verdict naming the exact missing/stale artifact and the build command.
 * 3. Every registered built-in suite preserves dry-run purity (fails by default
 *    if any new suite performs side effects during dry-run preflight).
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * External daemon health failures (e.g., Docker daemon offline or remote auth
 * quota exhaustion) which are runtime environment conditions rather than
 * build-on-preflight defects.
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage, type CredentialHealthResult } from "@veyyon/ai";
import { internalScratchDir } from "../../../src/paths";
import { builtinSuites } from "../../../src/suites";
import { checkBinaryBuildNeeded } from "../../../src/suites/deep-swe/src/runner/preflight";
import { deepSweSuite } from "../../../src/suites/deep-swe/suite";

function createScratchDir(prefix: string): string {
	const base = internalScratchDir();
	fs.mkdirSync(base, { recursive: true });
	return fs.mkdtempSync(path.join(base, prefix));
}

describe("dry-run preflight purity and artifact reporting", () => {
	let reloadSpy: Mock<() => Promise<void>> | undefined;
	let checkSpy: Mock<() => Promise<CredentialHealthResult[]>> | undefined;

	beforeEach(() => {
		// The staged credential store is a live SQLite file with real tokens, and probing
		// it reaches the network. Preflight's verdict is the subject here, not the
		// operator's credentials, so both reads are answered locally.
		reloadSpy = spyOn(AuthStorage.prototype, "reload").mockResolvedValue();
		checkSpy = spyOn(AuthStorage.prototype, "checkCredentials").mockResolvedValue([
			{ id: 1, type: "oauth", provider: "anthropic", ok: true },
			{ id: 2, type: "oauth", provider: "google-antigravity", ok: true },
		]);
	});

	afterEach(() => {
		reloadSpy?.mockRestore();
		checkSpy?.mockRestore();
	});

	it("reports missing binary and build command during dry-run preflight without building", async () => {
		const tempDir = createScratchDir("evals-dryrun-test-");
		try {
			const fakeBinaryPath = path.join(tempDir, "nonexistent-vey");
			expect(fs.existsSync(fakeBinaryPath)).toBe(false);

			const verdict = await deepSweSuite.preflight({
				workDir: tempDir,
				options: {
					dryRun: true,
					binary: fakeBinaryPath,
					model: "anthropic/claude-sonnet-4-5",
				},
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toBeDefined();
			expect(verdict.reason).toContain("pinned vey binary at");
			expect(verdict.reason).toContain(fakeBinaryPath);
			expect(verdict.missingRequirements).toBeDefined();
			expect(verdict.missingRequirements?.length).toBeGreaterThan(0);

			// Assert absence of side-effect: binary was not built and remains absent
			expect(fs.existsSync(fakeBinaryPath)).toBe(false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("checkBinaryBuildNeeded names the artifact and the build command for both reasons", () => {
		const tempDir = createScratchDir("evals-check-bin-");
		try {
			const missingPath = path.join(tempDir, "missing-vey");
			const missingCheck = checkBinaryBuildNeeded(missingPath);

			expect(missingCheck.needsBuild).toBe(true);
			expect(missingCheck.reason).toBe("missing");
			expect(missingCheck.binaryPath).toBe(missingPath);
			expect(missingCheck.buildCommand).toContain("scripts/build-binary.ts");

			// A binary that predates its sources is the other half of the branch, and the
			// one an operator hits most: the file is there, so an existence check passes it.
			const stalePath = path.join(tempDir, "stale-vey");
			fs.writeFileSync(stalePath, "not a real binary");
			fs.utimesSync(stalePath, new Date(0), new Date(0));
			const staleCheck = checkBinaryBuildNeeded(stalePath);

			expect(staleCheck.needsBuild).toBe(true);
			expect(staleCheck.reason).toBe("stale");
			expect(staleCheck.binaryPath).toBe(stalePath);
			expect(staleCheck.newerFile).toBeDefined();
			expect(staleCheck.buildCommand).toBe(missingCheck.buildCommand);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("agrees with the binary check about the default binary, whichever way it reads", async () => {
		const status = checkBinaryBuildNeeded();

		const verdict = await deepSweSuite.preflight({
			options: {
				dryRun: true,
				model: "anthropic/claude-sonnet-4-5",
			},
		});

		// Both branches are asserted, so a build that happens to be fresh cannot make this
		// test pass by asserting nothing: a needed build must be named with its command,
		// and a fresh one must not be reported as missing at all.
		const binaryRequirements = (verdict.missingRequirements ?? []).filter(req => req.includes("vey binary"));
		if (status.needsBuild) {
			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toContain(status.buildCommand);
			expect(binaryRequirements.some(req => req.includes(status.binaryPath))).toBe(true);
		} else {
			expect(binaryRequirements).toEqual([]);
		}
	});

	it("maintains dry-run preflight purity across all builtin suites", async () => {
		const tempDir = createScratchDir("evals-suite-sweep-");
		const optedOutSuites: readonly string[] = [];

		try {
			// Fail by default on any new suite: sweep builtinSuites at runtime
			expect(builtinSuites.length).toBeGreaterThan(0);
			expect(optedOutSuites).toEqual([]);

			for (const suite of builtinSuites) {
				if (optedOutSuites.includes(suite.name)) continue;

				const filesBefore = fs.readdirSync(tempDir);
				const verdict = await suite.preflight({
					workDir: tempDir,
					options: {
						dryRun: true,
						model: "anthropic/claude-sonnet-4-5",
					},
				});

				const filesAfter = fs.readdirSync(tempDir);
				// Assert preflight wrote no files into workDir
				expect(filesAfter).toEqual(filesBefore);
				expect(typeof verdict.ok).toBe("boolean");
			}
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
