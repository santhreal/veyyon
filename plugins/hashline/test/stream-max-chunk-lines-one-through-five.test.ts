/**
 * streamHashLines maxChunkLines 1..5 on 12-line body.
 */
import { describe, expect, it } from "bun:test";
import { streamHashLines } from "../src/stream";

async function collect(maxChunkLines: number): Promise<string[]> {
	const body = Array.from({ length: 12 }, (_, i) => `L${i}`).join("\n");
	async function* bytes() {
		yield new TextEncoder().encode(body);
	}
	const out: string[] = [];
	for await (const c of streamHashLines(bytes(), { maxChunkLines })) out.push(c);
	return out;
}

describe("streamHashLines maxChunkLines 1..5", () => {
	for (const k of [1, 2, 3, 4, 5]) {
		it(`k=${k}`, async () => {
			const chunks = await collect(k);
			const joined = chunks.join("\n");
			const want = Array.from({ length: 12 }, (_, i) => `${i + 1}:L${i}`).join("\n");
			expect(joined).toBe(want);
			expect(chunks.length).toBe(Math.ceil(12 / k));
			for (const c of chunks) {
				expect(c.split("\n").length).toBeLessThanOrEqual(k);
			}
		});
	}
});
