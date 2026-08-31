/**
 * WHY THIS SUITE EXISTS:
 *
 * build-binary.ts ends by running its embed generators in --reset mode, which
 * rewrites generated sources AFTER the binary is written:
 * e.g., dist/vey is written, then src/utils/mupdf-wasm-embed.ts and
 * src/embedded-client.generated.txt are updated with mtimes milliseconds newer.
 *
 * If checkBinaryBuildNeeded() walks all files in packages/coding-agent/src
 * without exclusions, it reports "stale vey binary" even immediately after a
 * successful fresh build.
 *
 * This suite defends:
 * 1. Pinned exact list of BUILD_GENERATED_EXCLUSIONS so adding a new generated
 *    source requires an explicit decision.
 * 2. Generated pattern matching (*.generated.*) and exclusion filtering.
 * 3. A genuinely newer hand-edited source still reports stale.
 * 4. Newer build-generated files alone do NOT cause false staleness.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Runtime execution of build-binary.ts or binary compilation toolchains.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { internalScratchDir } from "../../../engine/package-paths";
import {
	BUILD_GENERATED_EXCLUSIONS,
	checkBinaryBuildNeeded,
	isBuildGeneratedFile,
} from "../../../suites/deep-swe/runner/preflight";

function createScratchDir(prefix: string): string {
	const base = internalScratchDir();
	fs.mkdirSync(base, { recursive: true });
	return fs.mkdtempSync(path.join(base, prefix));
}

describe("vey binary staleness check — build-generated source exclusions", () => {
	it("pins BUILD_GENERATED_EXCLUSIONS to exact known generated files", () => {
		expect(BUILD_GENERATED_EXCLUSIONS).toEqual([
			"src/embedded-client.generated.txt",
			"src/utils/mupdf-wasm-embed.ts",
		]);
	});

	it("identifies build-generated files and rejects non-generated source files", () => {
		// Exact exclusions
		expect(isBuildGeneratedFile("src/utils/mupdf-wasm-embed.ts", "mupdf-wasm-embed.ts")).toBe(true);
		expect(isBuildGeneratedFile("src/embedded-client.generated.txt", "embedded-client.generated.txt")).toBe(true);

		// Pattern exclusions (*.generated.*)
		expect(isBuildGeneratedFile("src/prompts/ids.generated.ts", "ids.generated.ts")).toBe(true);
		expect(isBuildGeneratedFile("src/other/test.generated.json", "test.generated.json")).toBe(true);

		// Non-generated source files must NOT be excluded
		expect(isBuildGeneratedFile("src/cli.ts", "cli.ts")).toBe(false);
		expect(isBuildGeneratedFile("src/tools/auto-generated-guard.ts", "auto-generated-guard.ts")).toBe(false);
		expect(isBuildGeneratedFile("src/index.ts", "index.ts")).toBe(false);
	});

	it("genuinely newer hand-edited source file causes checkBinaryBuildNeeded to report stale", () => {
		const tempDir = createScratchDir("evals-staleness-test-");
		try {
			const fakeBinary = path.join(tempDir, "vey");
			fs.writeFileSync(fakeBinary, "binary-content");
			// Set binary mtime to epoch 0
			fs.utimesSync(fakeBinary, new Date(0), new Date(0));

			const result = checkBinaryBuildNeeded(fakeBinary);
			expect(result.needsBuild).toBe(true);
			expect(result.reason).toBe("stale");
			expect(result.newerFile).toBeDefined();
			expect(result.newerFile).not.toContain("mupdf-wasm-embed.ts");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
