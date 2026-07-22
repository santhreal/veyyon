import { describe, expect, it } from "bun:test";
import { readFilesystemTargets } from "@veyyon/coding-agent/tools/read";
import { writeFilesystemTargets } from "@veyyon/coding-agent/tools/write";

/**
 * read/write filesystemTargets extraction: path lists, hashline unwrap, multi.
 */

describe("readFilesystemTargets / writeFilesystemTargets", () => {
	it("read extracts bare path", () => {
		expect(readFilesystemTargets({ path: "src/a.ts" })).toEqual(["src/a.ts"]);
	});

	it("write extracts bare path", () => {
		expect(writeFilesystemTargets({ path: "src/a.ts", content: "x" })).toEqual(["src/a.ts"]);
	});

	it("write unwraps hashline header", () => {
		expect(writeFilesystemTargets({ path: "[src/a.ts#ab12]", content: "x" })).toEqual(["src/a.ts"]);
	});

	it("empty or missing path yields empty or single empty depending on product", () => {
		const r = readFilesystemTargets({});
		expect(Array.isArray(r)).toBe(true);
		const w = writeFilesystemTargets({ content: "x" });
		expect(Array.isArray(w)).toBe(true);
	});

	it("absolute path is returned as-is for read", () => {
		expect(readFilesystemTargets({ path: "/etc/hosts" })).toEqual(["/etc/hosts"]);
	});

	it("ssh paths are still reported as targets for write", () => {
		const t = writeFilesystemTargets({ path: "ssh://host/tmp/x", content: "x" });
		expect(t.some(p => p.includes("ssh://") || p.includes("host"))).toBe(true);
	});
});
