import { describe, expect, it } from "bun:test";
import { isOsc5522Packet, parseOsc5522Packet } from "../../src/utils/enhanced-paste";

/**
 * isOsc5522Packet / parseOsc5522Packet decode the terminal's OSC 5522 enhanced-paste
 * frames (Kitty-style clipboard reads) before the controller acts on them. Neither had
 * a test, yet they draw the boundary between "this is a paste packet" and raw keystrokes,
 * and mis-slicing the terminator or the metadata would corrupt every pasted payload.
 * Pinned:
 *   - a frame is recognized only with the `ESC ] 5522 ;` prefix AND either terminator,
 *     the 2-char ST (`ESC \`) or the 1-char BEL (`\x07`);
 *   - the body is the text between prefix and terminator; metadata is everything before
 *     the FIRST `;`, and the payload is everything after it (so a `;` inside the payload
 *     is preserved);
 *   - metadata is `:`-separated `key=value`; a part with no `=`, or with `=` at index 0,
 *     is dropped, and a duplicate key takes the LAST value;
 *   - a frame with no `;` has empty payload; a non-frame yields undefined.
 */

const PREFIX = "\x1b]5522;";
const ST = "\x1b\\";
const BEL = "\x07";

describe("isOsc5522Packet", () => {
	it("accepts a framed packet with either the ST or BEL terminator", () => {
		expect(isOsc5522Packet(`${PREFIX}x${ST}`)).toBe(true);
		expect(isOsc5522Packet(`${PREFIX}x${BEL}`)).toBe(true);
	});

	it("rejects a packet missing its terminator or its prefix", () => {
		expect(isOsc5522Packet(`${PREFIX}x`)).toBe(false);
		expect(isOsc5522Packet(`hello${BEL}`)).toBe(false);
	});
});

describe("parseOsc5522Packet", () => {
	it("splits metadata before the first ; from the payload after it", () => {
		const packet = parseOsc5522Packet(`${PREFIX}type=read:status=OK;PAYLOAD${BEL}`);
		expect([...(packet?.metadata ?? [])]).toEqual([
			["type", "read"],
			["status", "OK"],
		]);
		expect(packet?.payload).toBe("PAYLOAD");
	});

	it("strips the 2-char ST terminator and yields an empty payload when there is no ;", () => {
		const packet = parseOsc5522Packet(`${PREFIX}type=read${ST}`);
		expect([...(packet?.metadata ?? [])]).toEqual([["type", "read"]]);
		expect(packet?.payload).toBe("");
	});

	it("drops malformed metadata parts and preserves a ; inside the payload", () => {
		// `novalue` has no `=`; `=orphan` has `=` at index 0 — both dropped. Only the
		// FIRST `;` splits, so `pay;load` survives whole.
		const packet = parseOsc5522Packet(`${PREFIX}a=1:novalue:=orphan:b=2;pay;load${BEL}`);
		expect([...(packet?.metadata ?? [])]).toEqual([
			["a", "1"],
			["b", "2"],
		]);
		expect(packet?.payload).toBe("pay;load");
	});

	it("takes the last value for a duplicated metadata key", () => {
		const packet = parseOsc5522Packet(`${PREFIX}a=1:a=2;p${BEL}`);
		expect([...(packet?.metadata ?? [])]).toEqual([["a", "2"]]);
	});

	it("returns undefined for input that is not a 5522 frame", () => {
		expect(parseOsc5522Packet("nope")).toBeUndefined();
		expect(parseOsc5522Packet(`${PREFIX}x`)).toBeUndefined();
	});
});
