/**
 * streamHashLines edge: empty, single byte, single newline.
 */
import { describe, expect, it } from "bun:test";
import { streamHashLines } from "../src/stream";

async function collect(parts: string[], opts = {}): Promise<string[]> {
	async function* bytes() {
		const enc = new TextEncoder();
		for (const p of parts) yield enc.encode(p);
	}
	const out: string[] = [];
	for await (const c of streamHashLines(bytes(), opts)) out.push(c);
	return out;
}

describe("streamHashLines empty and single-byte", () => {
	it("empty yields 1:", async () => {
		expect(await collect([])).toEqual(["1:"]);
	});

	it("single char no newline", async () => {
		expect(await collect(["x"])).toEqual(["1:x"]);
	});

	it("only newline", async () => {
		// trailing newline alone: no content line
		expect(await collect(["\n"])).toEqual(["1:"]);
	});

	it("single byte chunks of multi-line", async () => {
		const text = "ab\ncd";
		const parts = text.split("").map(c => c);
		expect(await collect(parts)).toEqual(["1:ab\n2:cd"]);
	});
});
