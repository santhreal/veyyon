/**
 * Property: SWAP expand/shrink always preserves the exact prefix before start
 * and exact suffix after end. Mid length equals body row count. Locks the
 * core applyEdits addressing contract used by every edit tool path.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

const N = 24;
const baseLines = Array.from({ length: N }, (_, i) => `L${i + 1}`);
const base = baseLines.join("\n");

describe("applyEdits SWAP expand/shrink preserves prefix and suffix", () => {
	for (let start = 1; start <= 8; start++) {
		for (let end = start; end <= Math.min(start + 5, N); end++) {
			for (const bodyLen of [0, 1, end - start + 1, end - start + 3, 7]) {
				// empty SWAP body is pure delete (not EMPTY_REPLACE) when using + rows only —
				// bodyLen 0 means DEL semantics via empty replace path is not allowed through
				// parse of SWAP with zero + rows; skip zero when it would fail parse.
				if (bodyLen === 0) {
					it(`DEL ${start}.=${end} prefix/suffix`, () => {
						const patch =
							start === end ? `DEL ${start}` : `DEL ${start}.=${end}`;
						const { text } = applyEdits(base, parsePatch(patch).edits);
						const out = text.split("\n");
						const want = [...baseLines.slice(0, start - 1), ...baseLines.slice(end)];
						expect(out).toEqual(want);
					});
					continue;
				}
				it(`SWAP ${start}.=${end} bodyLen=${bodyLen}`, () => {
					const body = Array.from({ length: bodyLen }, (_, i) => `B${i}`);
					const bodyRows = body.map(l => `+${l}`).join("\n");
					const { text } = applyEdits(
						base,
						parsePatch(`SWAP ${start}.=${end}:\n${bodyRows}`).edits,
					);
					const out = text.split("\n");
					const prefix = baseLines.slice(0, start - 1);
					const suffix = baseLines.slice(end);
					expect(out.slice(0, prefix.length)).toEqual(prefix);
					expect(out.slice(out.length - suffix.length)).toEqual(suffix);
					expect(out.slice(prefix.length, out.length - suffix.length)).toEqual(body);
					expect(out.length).toBe(prefix.length + bodyLen + suffix.length);
				});
			}
		}
	}
});
