/**
 * File search results are ranked deterministically: mtime descending (newest first),
 * with ties broken by displayed path ascending.
 *
 * WHY THIS SUITE EXISTS. Multi-target file searches (e.g. `zulu/*.ts;alpha/*.ts`)
 * collected per-target results and merged them with `b.mtime - a.mtime`. When
 * modification times were identical, the subtraction yielded 0 and preserved the
 * arbitrary target input order: `zulu/*.ts;alpha/*.ts` returned zulu before alpha,
 * while `alpha/*.ts;zulu/*.ts` returned alpha before zulu. Native glob sorts ties
 * by path ascending; multi-target search must preserve that exact contract.
 *
 * WHAT CLASS THIS CLOSES. Multi-target file searches produce an identical,
 * deterministic order regardless of input scope order or concurrency scheduling.
 *
 * WHAT IT DOES NOT CATCH. Single-target searches that bypass multi-target merge
 * rely directly on native glob's internal comparator. Timeout partial results share
 * the module-local comparator with multi-target merge, but triggering the 5s walk
 * timeout deterministically without sleeps is not exercised by this suite and remains
 * an honest gap.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SearchTool } from "@veyyon/coding-agent/tools/search";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

describe("SearchTool multi-scope file ordering", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-order-"));
		await fs.mkdir(path.join(tmpDir, "alpha"), { recursive: true });
		await fs.mkdir(path.join(tmpDir, "zulu"), { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function session() {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		});
	}

	it("returns path ascending when mtimes are identical regardless of target input order", async () => {
		const alphaFile = path.join(tmpDir, "alpha", "a.ts");
		const zuluFile = path.join(tmpDir, "zulu", "z.ts");
		await fs.writeFile(alphaFile, "alpha\n", "utf8");
		await fs.writeFile(zuluFile, "zulu\n", "utf8");

		const fixedMtime = new Date(1700000000000);
		await fs.utimes(alphaFile, fixedMtime, fixedMtime);
		await fs.utimes(zuluFile, fixedMtime, fixedMtime);

		const tool = new SearchTool(session());

		// Target order: zulu first, then alpha
		const result1 = await tool.execute("s1", {
			type: "files",
			input: "zulu/*.ts;alpha/*.ts",
		});
		const files1 = result1.details?.type === "files" ? result1.details.result.files : [];
		expect(files1).toEqual(["alpha/a.ts", "zulu/z.ts"]);

		// Reversed target order: alpha first, then zulu
		const result2 = await tool.execute("s2", {
			type: "files",
			input: "alpha/*.ts;zulu/*.ts",
		});
		const files2 = result2.details?.type === "files" ? result2.details.result.files : [];
		expect(files2).toEqual(["alpha/a.ts", "zulu/z.ts"]);
	});

	it("orders by newest mtime first when mtimes differ regardless of target order", async () => {
		const alphaFile = path.join(tmpDir, "alpha", "a.ts");
		const zuluFile = path.join(tmpDir, "zulu", "z.ts");
		await fs.writeFile(alphaFile, "alpha\n", "utf8");
		await fs.writeFile(zuluFile, "zulu\n", "utf8");

		// Make zulu newer than alpha
		const olderMtime = new Date(1600000000000);
		const newerMtime = new Date(1700000000000);
		await fs.utimes(alphaFile, olderMtime, olderMtime);
		await fs.utimes(zuluFile, newerMtime, newerMtime);

		const tool = new SearchTool(session());

		const result1 = await tool.execute("s1", {
			type: "files",
			input: "alpha/*.ts;zulu/*.ts",
		});
		const files1 = result1.details?.type === "files" ? result1.details.result.files : [];
		expect(files1).toEqual(["zulu/z.ts", "alpha/a.ts"]);

		const result2 = await tool.execute("s2", {
			type: "files",
			input: "zulu/*.ts;alpha/*.ts",
		});
		const files2 = result2.details?.type === "files" ? result2.details.result.files : [];
		expect(files2).toEqual(["zulu/z.ts", "alpha/a.ts"]);
	});

	it("sorts multiple equal-mtime files across scopes stably and deduplicates", async () => {
		const a1 = path.join(tmpDir, "alpha", "1.ts");
		const a2 = path.join(tmpDir, "alpha", "2.ts");
		const z1 = path.join(tmpDir, "zulu", "1.ts");
		const z2 = path.join(tmpDir, "zulu", "2.ts");

		await fs.writeFile(a1, "1\n", "utf8");
		await fs.writeFile(a2, "2\n", "utf8");
		await fs.writeFile(z1, "1\n", "utf8");
		await fs.writeFile(z2, "2\n", "utf8");

		const fixedMtime = new Date(1700000000000);
		await fs.utimes(a1, fixedMtime, fixedMtime);
		await fs.utimes(a2, fixedMtime, fixedMtime);
		await fs.utimes(z1, fixedMtime, fixedMtime);
		await fs.utimes(z2, fixedMtime, fixedMtime);

		const tool = new SearchTool(session());

		const result = await tool.execute("s-multi", {
			type: "files",
			input: "zulu/*.ts;alpha/*.ts;alpha/*.ts",
		});
		const files = result.details?.type === "files" ? result.details.result.files : [];
		expect(files).toEqual(["alpha/1.ts", "alpha/2.ts", "zulu/1.ts", "zulu/2.ts"]);
	});

	it("respects limit after deterministic ordering", async () => {
		const a1 = path.join(tmpDir, "alpha", "1.ts");
		const a2 = path.join(tmpDir, "alpha", "2.ts");
		const z1 = path.join(tmpDir, "zulu", "1.ts");
		const z2 = path.join(tmpDir, "zulu", "2.ts");

		await fs.writeFile(a1, "1\n", "utf8");
		await fs.writeFile(a2, "2\n", "utf8");
		await fs.writeFile(z1, "1\n", "utf8");
		await fs.writeFile(z2, "2\n", "utf8");

		const fixedMtime = new Date(1700000000000);
		await fs.utimes(a1, fixedMtime, fixedMtime);
		await fs.utimes(a2, fixedMtime, fixedMtime);
		await fs.utimes(z1, fixedMtime, fixedMtime);
		await fs.utimes(z2, fixedMtime, fixedMtime);

		const tool = new SearchTool(session());

		const result = await tool.execute("s-limit", {
			type: "files",
			input: "zulu/*.ts;alpha/*.ts",
			limit: 2,
		});
		const files = result.details?.type === "files" ? result.details.result.files : [];
		expect(files).toEqual(["alpha/1.ts", "alpha/2.ts"]);
	});
});
