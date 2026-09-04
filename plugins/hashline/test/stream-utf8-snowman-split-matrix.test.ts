/**
 * streamHashLines UTF-8 multi-byte character split at every offset.
 */
import { describe, expect, it } from "bun:test";
import { streamHashLines } from "../src/stream";

describe("streamHashLines UTF-8 cut matrix", () => {
	const s = "café ☃ 日本語";
	const enc = new TextEncoder().encode(`${s}\nok`);

	for (let cut = 1; cut < enc.length; cut++) {
		it(`cut=${cut}`, async () => {
			async function* split() {
				yield enc.subarray(0, cut);
				yield enc.subarray(cut);
			}
			const out: string[] = [];
			for await (const c of streamHashLines(split())) out.push(c);
			expect(out).toEqual([`1:${s}\n2:ok`]);
		});
	}
});
