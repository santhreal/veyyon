import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { processFileArguments } from "../src/cli/file-processor";

/**
 * WHY THIS SUITE EXISTS:
 * File processing for CLI `@file` arguments must use portable `node:fs` / `fs.promises`
 * APIs rather than runtime-specific Bun APIs (`Bun.file().bytes()`), and correctly
 * read text and convertible file content into structured prompt blocks.
 */

const TEST_DIR = path.join(path.resolve(import.meta.dir, ".."), ".file-proc-test-tmp");

describe("File processor with portable node:fs", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(TEST_DIR, { recursive: true, force: true });
		} catch {}
	});

	it("processes text file arguments into XML file blocks", async () => {
		const filePath = path.join(TEST_DIR, "sample.txt");
		writeFileSync(filePath, "Hello from test file");

		const result = await processFileArguments([filePath]);
		expect(result.text).toContain(`<file name="${filePath}">\nHello from test file\n</file>`);
		expect(result.images.length).toBe(0);
	});

	it("handles empty files without adding content blocks", async () => {
		const filePath = path.join(TEST_DIR, "empty.txt");
		writeFileSync(filePath, "");

		const result = await processFileArguments([filePath]);
		expect(result.text).toBe("");
		expect(result.images.length).toBe(0);
	});
});
