/**
 * WHY: `computeTypescriptEditProvenance` previously caught any missing or unreadable
 * default archive error and returned `{ sha: null }` with an error stuffed in metadata.
 * This allowed evaluation runs to persist with no dataset identity / SHA, silently hiding
 * broken dataset staging.
 *
 * This suite proves that provenance computation fails closed with a named Error naming
 * the archive path by default, requiring callers to explicitly pass `allowMissingArchive: true`
 * if they legitimately require soft fallback.
 */

import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeTypescriptEditProvenance } from "../../../src/suites/typescript-edit/provenance";

describe("a missing fixtures archive fails closed", () => {
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

	it("fails closed and throws when default fixtures archive does not exist and no opt-in is provided", async () => {
		statSpy = spyOn(fs, "stat").mockRejectedValue(new Error("ENOENT: no such file or directory"));

		await expect(computeTypescriptEditProvenance()).rejects.toThrow(/fixtures archive not found or unreadable/i);
	});

	it("allows soft fallback returning sha: null only when allowMissingArchive is explicitly enabled", async () => {
		statSpy = spyOn(fs, "stat").mockRejectedValue(new Error("ENOENT: no such file or directory"));

		const provenance = await computeTypescriptEditProvenance({
			allowMissingArchive: true,
		});

		expect(provenance.suite).toBe("typescript-edit");
		expect(provenance.version).toBe("1.0.0");
		expect(provenance.sha).toBeNull();
		expect(provenance.metadata?.error).toBe("ENOENT: no such file or directory");
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
