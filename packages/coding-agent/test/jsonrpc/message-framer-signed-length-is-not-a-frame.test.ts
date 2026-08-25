/**
 * MessageFramer is the Content-Length decoder LSP and DAP share. The existing
 * suite already pins a terminator split across reads, UTF-8 byte counts, and a
 * junk header with no Content-Length.
 *
 * Two boundaries that suite never names:
 *
 * 1. LF-ONLY HEADERS. The LSP/DAP base protocol writes CR LF CR LF. Some
 *    adapters (and every hand-rolled test double that uses LF LF) do not.
 *    findHeaderEndInChunks looks for the four-byte CR LF CR LF sequence and
 *    nothing else. An LF-only header therefore never frames: drain yields
 *    nothing and remainder is the whole buffer, so the DAP reader waits until
 *    the adapter's timeout and then reports a hung initialize, not a framing
 *    error. That is a stall, not a parse. The contract the operator needs is
 *    that a Content-Length header terminated the way a Unix tool writes it
 *    still yields the body.
 *
 * 2. A HEADER WHOSE LENGTH IS NOT digits. The matcher is
 *    /Content-Length: (\\d+)/i. Content-Length: -1 therefore has no capture,
 *    so the block is treated as junk, the terminator is dropped, and the bytes
 *    that were the "body" become the start of the next scan. A following
 *    well-formed message is then parsed against leftover payload bytes. Signed
 *    and hex lengths must not resync-away a real frame that follows.
 *
 * Both stay red until the scanner frames LF-only headers and treats a
 * non-decimal length as a hard error rather than a skip.
 */
import { describe, expect, it } from "bun:test";
import { MessageFramer } from "@veyyon/coding-agent/jsonrpc/message-framing";

const noop = (): void => {};

function frame(json: string): Buffer {
	return Buffer.from(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`, "utf8");
}

function drain(framer: MessageFramer, onResync: (h: string) => void = noop): string[] {
	return [...framer.drain(onResync)];
}

describe("an LF-only Content-Length header still yields the body", () => {
	it("decodes Content-Length: 5 LF LF hello as the five-byte body hello", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.from("Content-Length: 5\n\nhello", "utf8"));
		expect(drain(framer)).toEqual(["hello"]);
		expect(framer.remainder().length).toBe(0);
	});

	it("decodes a mixed CR-less header that a Unix logger would print", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.from("Content-Type: application/vscode-jsonrpc\nContent-Length: 2\n\n{}", "utf8"));
		expect(drain(framer)).toEqual(["{}"]);
	});
});

describe("a non-decimal Content-Length does not eat the next real frame", () => {
	it("does not yield the following message as if -1 were junk-and-skip", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.concat([Buffer.from("Content-Length: -1\r\n\r\nxxxx", "utf8"), frame('{"ok":1}')]));
		const resyncs: string[] = [];
		const out = drain(framer, h => resyncs.push(h));
		expect(out).toEqual(['{"ok":1}']);
		expect(resyncs.length).toBe(0);
	});

	it("does not treat Content-Length: 0x5 as a zero-length body because \\d+ matches the leading 0", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.from("Content-Length: 0x5\r\n\r\nhello", "utf8"));
		const resyncs: string[] = [];
		expect(drain(framer, h => resyncs.push(h))).toEqual([]);
		expect(resyncs.length).toBe(0);
		expect(framer.remainder().toString("utf8")).toBe("Content-Length: 0x5\r\n\r\nhello");
	});
});

describe("the documented CRLF path is unchanged", () => {
	it("still yields a spec frame so this file is not only the red arms", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(frame('{"a":1}'));
		expect(drain(framer)).toEqual(['{"a":1}']);
	});
});
