/**
 * findHeaderEndInChunks walks a 4-byte window across the pending chunk list
 * without concatenating. The terminator is CR LF CR LF. A read that ends on
 * any proper prefix of that sequence (CR, CR LF, CR LF CR) must not frame, and
 * the next push that completes the four bytes must. If the window reset on
 * chunk boundaries, a header split as [...,13] then [10,13,10,...] would
 * stall forever — the same hang DAP #startMessageReader used to have when an
 * adapter flushed the header and body on separate writes.
 *
 * Two Content-Length headers in one block: headerText.match(/Content-Length: (\d+)/i)
 * takes the FIRST. LSP allows duplicates and last-wins; a proxy that prepends
 * Content-Length: 0 and then the real length would yield an empty body and
 * leave the JSON in the remainder as the next "header". That is the defect
 * this file keeps red.
 *
 * Number.parseInt of a leading-zero decimal (0005) is 5, and that path is
 * required for adapters that pad the length.
 */
import { describe, expect, it } from "bun:test";
import { MessageFramer } from "@veyyon/coding-agent/jsonrpc/message-framing";

function drain(framer: MessageFramer, onResync: (h: string) => void = () => {}): string[] {
	return [...framer.drain(onResync)];
}

describe("the CR LF CR LF terminator may be split across pushes", () => {
	it("frames only when the fourth terminator byte arrives", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.from("Content-Length: 2\r\n\r", "utf8"));
		expect(drain(framer)).toEqual([]);
		framer.push(Buffer.from("\n{}", "utf8"));
		expect(drain(framer)).toEqual(["{}"]);
		expect(framer.remainder().length).toBe(0);
	});

	it("frames when each of the four terminator bytes is its own chunk", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.from("Content-Length: 2", "utf8"));
		for (const byte of [0x0d, 0x0a, 0x0d, 0x0a]) {
			framer.push(Buffer.from([byte]));
			expect(drain(framer)).toEqual([]);
		}
		framer.push(Buffer.from("{}", "utf8"));
		expect(drain(framer)).toEqual(["{}"]);
	});
});

describe("Content-Length 0005 is five bytes, not zero", () => {
	it("parses a zero-padded decimal length as decimal, not as a leading-zero empty body", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.from("Content-Length: 0005\r\n\r\nhello", "utf8"));
		expect(drain(framer)).toEqual(["hello"]);
	});
});

describe("duplicate Content-Length headers last-win, they do not first-win", () => {
	it("uses the second length when a proxy prepended Content-Length: 0", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.from("Content-Length: 0\r\nContent-Length: 2\r\n\r\n{}", "utf8"));
		expect(drain(framer)).toEqual(["{}"]);
		expect(framer.remainder().length).toBe(0);
	});
});
