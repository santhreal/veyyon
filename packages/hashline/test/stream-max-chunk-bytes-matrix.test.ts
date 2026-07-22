/**
 * streamHashLines maxChunkBytes forces single-line chunks for tiny budgets.
 */
import { describe, expect, it } from "bun:test";
import { streamHashLines } from "../src/stream";

async function collect(text: string, maxChunkBytes: number): Promise<string[]> {
	async function* bytes() {
		yield new TextEncoder().encode(text);
	}
	const out: string[] = [];
	for await (const c of streamHashLines(bytes(), { maxChunkBytes })) out.push(c);
	return out;
}

describe("streamHashLines maxChunkBytes matrix", () => {
	it("tiny budget yields one line per chunk", async () => {
		const chunks = await collect("aaaa\nbbbb\ncccc", 8);
		const flat = chunks.join("\n").split("\n");
		expect(flat).toEqual(["1:aaaa", "2:bbbb", "3:cccc"]);
		expect(chunks.length).toBeGreaterThanOrEqual(3);
	});

	it("large budget yields single chunk", async () => {
		const chunks = await collect("a\nb\nc", 64 * 1024);
		expect(chunks).toEqual(["1:a\n2:b\n3:c"]);
	});

	it("reconstructs full numbered text for various budgets", async () => {
		const body = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n");
		const want = Array.from({ length: 20 }, (_, i) => `${i + 1}:L${i}`).join("\n");
		for (const budget of [16, 32, 64, 128, 256, 1024]) {
			const chunks = await collect(body, budget);
			expect(chunks.join("\n")).toBe(want);
		}
	});
});
