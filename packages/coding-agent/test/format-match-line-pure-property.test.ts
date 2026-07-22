/**
 * formatMatchLine property grid: plain vs hashline × match vs context × lines.
 */
import { describe, expect, it } from "bun:test";
import { formatMatchLine } from "../src/tools/match-line-format";

describe("formatMatchLine pure property grid", () => {
	for (const line of [1, 2, 9, 10, 42, 100, 1000]) {
		for (const isMatch of [true, false]) {
			for (const useHashLines of [true, false]) {
				it(`line=${line} match=${isMatch} hash=${useHashLines}`, () => {
					const body = "content";
					const out = formatMatchLine(line, body, isMatch, { useHashLines });
					if (useHashLines) {
						const mark = isMatch ? "*" : " ";
						expect(out).toBe(`${mark}${line}:${body}`);
					} else {
						const mark = isMatch ? "*" : " ";
						expect(out).toBe(`${mark}${line}|${body}`);
					}
				});
			}
		}
	}

	it("empty body", () => {
		expect(formatMatchLine(5, "", true, { useHashLines: false })).toBe("*5|");
		expect(formatMatchLine(5, "", false, { useHashLines: true })).toBe(" 5:");
	});
});
