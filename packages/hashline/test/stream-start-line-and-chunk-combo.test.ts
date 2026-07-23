/**
 * streamHashLines startLine + maxChunkLines combination matrix.
 */
import { describe, expect, it } from "bun:test";
import { streamHashLines } from "../src/stream";

async function collect(text: string, opts: { startLine: number; maxChunkLines: number }): Promise<string[]> {
	async function* bytes() {
		yield new TextEncoder().encode(text);
	}
	const out: string[] = [];
	for await (const c of streamHashLines(bytes(), opts)) out.push(c);
	return out;
}

describe("streamHashLines startLine×maxChunkLines", () => {
	const body = "a\nb\nc\nd";
	for (const start of [1, 10, 100]) {
		for (const k of [1, 2, 3]) {
			it(`start=${start} k=${k}`, async () => {
				const chunks = await collect(body, { startLine: start, maxChunkLines: k });
				const joined = chunks.join("\n");
				const want = ["a", "b", "c", "d"].map((line, i) => `${start + i}:${line}`).join("\n");
				expect(joined).toBe(want);
				for (const c of chunks) {
					expect(c.split("\n").length).toBeLessThanOrEqual(k);
				}
			});
		}
	}
});
