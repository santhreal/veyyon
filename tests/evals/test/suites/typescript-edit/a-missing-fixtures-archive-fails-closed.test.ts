/**
 * WHY:
 * Multiple independent extraction sites (`suite.ts`, `adapter/cli.ts`, `argot-bench.ts`, `provenance.ts`)
 * each previously had their own error handling and inconsistent fallback behaviors.
 *
 * This suite proves that all callers reach the archive through the single `extract.ts` module,
 * that a missing or unreadable archive fails closed by default with an actionable Error naming the path
 * across EVERY caller entry point, and that soft fallback returning `{ sha: null }` is only permitted
 * when `allowMissingArchive: true` is explicitly passed.
 */

import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ensureFixturesExtracted,
	extractBenchmarkFixtures,
	extractFixtures,
	readFixturesArchive,
} from "../../../suites/typescript-edit/extract";
import { TypescriptEditSuite } from "../../../suites/typescript-edit/main";
import { computeTypescriptEditProvenance } from "../../../suites/typescript-edit/provenance";

describe("a missing fixtures archive fails closed across all callers", () => {
	let tempDir: string | null = null;
	let statSpy: Mock<typeof fs.stat> | null = null;

	afterEach(async () => {
		statSpy?.mockRestore();
		statSpy = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	const NONEXISTENT_ARCHIVE = "/nonexistent/path/datasets/typescript-edit/fixtures.tar.gz";

	it("readFixturesArchive fails closed by default naming the archive path", async () => {
		await expect(readFixturesArchive({ archivePath: NONEXISTENT_ARCHIVE })).rejects.toThrow(
			/fixtures archive not found or unreadable at "\/nonexistent\/path\/datasets\/typescript-edit\/fixtures\.tar\.gz"/,
		);
	});

	it("readFixturesArchive returns ok: false with error only when allowMissingArchive is true", async () => {
		const result = await readFixturesArchive({
			archivePath: NONEXISTENT_ARCHIVE,
			allowMissingArchive: true,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.path).toBe(NONEXISTENT_ARCHIVE);
			expect(typeof result.error).toBe("string");
			expect(result.error.length).toBeGreaterThan(0);
		}
	});

	it("extractFixtures fails closed by default naming the archive path", async () => {
		await expect(extractFixtures({ archivePath: NONEXISTENT_ARCHIVE })).rejects.toThrow(
			/fixtures archive not found or unreadable at "\/nonexistent\/path\/datasets\/typescript-edit\/fixtures\.tar\.gz"/,
		);
	});

	it("ensureFixturesExtracted fails closed by default naming the archive path", async () => {
		await expect(ensureFixturesExtracted(NONEXISTENT_ARCHIVE)).rejects.toThrow(
			/fixtures archive not found or unreadable at "\/nonexistent\/path\/datasets\/typescript-edit\/fixtures\.tar\.gz"/,
		);
	});

	it("extractBenchmarkFixtures fails closed by default naming the archive path", async () => {
		await expect(extractBenchmarkFixtures({ archivePath: NONEXISTENT_ARCHIVE })).rejects.toThrow(
			/fixtures archive not found or unreadable at "\/nonexistent\/path\/datasets\/typescript-edit\/fixtures\.tar\.gz"/,
		);
	});

	it("computeTypescriptEditProvenance fails closed by default naming the archive path", async () => {
		await expect(computeTypescriptEditProvenance({ archivePath: NONEXISTENT_ARCHIVE })).rejects.toThrow(
			/fixtures archive not found or unreadable at "\/nonexistent\/path\/datasets\/typescript-edit\/fixtures\.tar\.gz"/,
		);
	});

	it("computeTypescriptEditProvenance allows soft fallback only when allowMissingArchive is explicitly enabled", async () => {
		const provenance = await computeTypescriptEditProvenance({
			archivePath: NONEXISTENT_ARCHIVE,
			allowMissingArchive: true,
		});

		expect(provenance.suite).toBe("typescript-edit");
		expect(provenance.version).toBe("1.0.0");
		expect(provenance.sha).toBeNull();
		expect(provenance.metadata?.archivePath).toBe(NONEXISTENT_ARCHIVE);
		expect(provenance.metadata?.error).toBeDefined();
	});

	it("TypescriptEditSuite discoverTasks fails closed when archive is missing", async () => {
		const suite = new TypescriptEditSuite({
			defaultArchive: NONEXISTENT_ARCHIVE,
		});
		await expect(suite.discoverTasks()).rejects.toThrow(/fixtures archive not found or unreadable/);
	});

	it("TypescriptEditSuite preflight refuses with actionable message and missing requirement when archive is missing", async () => {
		const suite = new TypescriptEditSuite({
			defaultArchive: NONEXISTENT_ARCHIVE,
		});
		const verdict = await suite.preflight();
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain("fixtures archive not found or unreadable");
		expect(verdict.missingRequirements).toContain("fixture-archive");
	});

	it("sweeps the entire caller suite under simulated ENOENT default archive", async () => {
		statSpy = spyOn(fs, "stat").mockRejectedValue(new Error("ENOENT: no such file or directory"));

		// 1. readFixturesArchive
		await expect(readFixturesArchive()).rejects.toThrow(/fixtures archive not found or unreadable/i);

		// 2. extractFixtures
		await expect(extractFixtures()).rejects.toThrow(/fixtures archive not found or unreadable/i);

		// 3. ensureFixturesExtracted
		await expect(ensureFixturesExtracted()).rejects.toThrow(/fixtures archive not found or unreadable/i);

		// 4. extractBenchmarkFixtures
		await expect(extractBenchmarkFixtures()).rejects.toThrow(/fixtures archive not found or unreadable/i);

		// 5. computeTypescriptEditProvenance
		await expect(computeTypescriptEditProvenance()).rejects.toThrow(/fixtures archive not found or unreadable/i);

		// 6. TypescriptEditSuite discoverTasks
		const suite = new TypescriptEditSuite();
		await expect(suite.discoverTasks()).rejects.toThrow(/fixtures archive not found or unreadable/i);

		// 7. TypescriptEditSuite preflight
		const verdict = await suite.preflight();
		expect(verdict.ok).toBe(false);
		expect(verdict.missingRequirements).toContain("fixture-archive");
	});

	it("computes deterministic SHA when fixtures directory exists", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ts-edit-prov-fixtures-"));
		await fs.writeFile(path.join(tempDir, "sample.ts"), "export const a = 1;\n");
		await fs.writeFile(path.join(tempDir, "tsconfig.json"), "{}\n");

		const provenance = await computeTypescriptEditProvenance({
			fixturesDir: tempDir,
		});

		expect(provenance.suite).toBe("typescript-edit");
		expect(provenance.sha).not.toBeNull();
		expect(typeof provenance.sha).toBe("string");
		expect(provenance.sha?.length).toBe(64);
		expect(provenance.metadata?.fileCount).toBe(2);
	});
});
