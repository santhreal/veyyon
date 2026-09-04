/**
 * streamHashLines: for N lines and maxChunkLines=k, chunk count and contents are exact.
 */
import { describe, expect, it } from "bun:test";
import { streamHashLines } from "../src/stream";

async function collect(text: string, maxChunkLines: number): Promise<string[]> {
	async function* bytes(): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(text);
	}
	const out: string[] = [];
	for await (const c of streamHashLines(bytes(), { maxChunkLines })) out.push(c);
	return out;
}

describe("streamHashLines maxChunkLines property", () => {
	for (const n of [1, 5, 10, 17]) {
		for (const k of [1, 2, 3, 5, 10]) {
			it(`n=${n} k=${k}: reconstructs numbered body`, async () => {
				const body = Array.from({ length: n }, (_, i) => `L${i}`).join("\n");
				const chunks = await collect(body, k);
				const joined = chunks.join("\n");
				const want = Array.from({ length: n }, (_, i) => `${i + 1}:L${i}`).join("\n");
				expect(joined).toBe(want);
				// each chunk has at most k lines
				for (const c of chunks) {
					expect(c.split("\n").length).toBeLessThanOrEqual(k);
				}
				// expected number of chunks
				expect(chunks.length).toBe(Math.ceil(n / k));
			});
		}
	}
});
