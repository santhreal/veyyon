import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { truncateForLog } from "../src/util/log-format";

describe("truncateForLog", () => {
	it("returns a string shorter than the cap unchanged", () => {
		expect(truncateForLog("short", 80)).toBe("short");
		expect(truncateForLog("", 80)).toBe("");
	});

	it("returns a string exactly at the cap unchanged (cut only when strictly longer)", () => {
		const exact = "a".repeat(10);
		expect(truncateForLog(exact, 10)).toBe(exact);
	});

	it("keeps the first maxLen characters and appends the marker when longer", () => {
		expect(truncateForLog("abcdef", 3)).toBe("abc...[truncated]");
	});

	it("cuts a string one character over the cap", () => {
		expect(truncateForLog("a".repeat(11), 10)).toBe(`${"a".repeat(10)}...[truncated]`);
	});

	it("matches the 200-char diagnostics cap behavior", () => {
		expect(truncateForLog("y".repeat(300), 200)).toBe(`${"y".repeat(200)}...[truncated]`);
	});
});

describe("truncateForLog is the one owner of the [truncated] marker", () => {
	// The slice-and-mark idiom `${x.slice(0, N)}...[truncated]` was pasted in
	// diagnostics.ts and veracity-consolidation.ts. Any src file that rebuilds it
	// has re-created this owner and must import truncateForLog instead.
	const MARKER_IDIOM = /\.slice\([^)]*\)\}\.\.\.\[truncated\]/;
	const SRC_DIR = path.join(import.meta.dir, "..", "src");

	it("detects the idiom but not the owner's own literal", () => {
		expect(MARKER_IDIOM.test("`${msg.slice(0, CAP)}...[truncated]`")).toBe(true);
		expect(MARKER_IDIOM.test('`${value.slice(0, maxLen)}${"...[truncated]"}`')).toBe(false);
	});

	it("no source file outside the owner rebuilds the slice-and-mark idiom", async () => {
		const offenders: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					await walk(full);
					continue;
				}
				if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
				if (entry.name === "log-format.ts") continue;
				if (MARKER_IDIOM.test(await readFile(full, "utf8"))) {
					offenders.push(path.relative(SRC_DIR, full));
				}
			}
		};
		await walk(SRC_DIR);
		expect(offenders, "call truncateForLog instead of rebuilding the marker idiom").toEqual([]);
	});
});
