/**
 * streamHashLines startLine offsets: first line number is startLine for many starts.
 */
import { describe, expect, it } from "bun:test";
import { streamHashLines } from "../src/stream";

async function firstLine(startLine: number): Promise<string> {
	async function* bytes() {
		yield new TextEncoder().encode("alpha\nbeta");
	}
	for await (const chunk of streamHashLines(bytes(), { startLine })) {
		return chunk.split("\n")[0]!;
	}
	return "";
}

describe("streamHashLines startLine matrix", () => {
	for (const start of [1, 2, 10, 50, 100, 999, 10000]) {
		it(`startLine=${start} first line is ${start}:alpha`, async () => {
			expect(await firstLine(start)).toBe(`${start}:alpha`);
		});
	}
});
