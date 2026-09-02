import { describe, expect, it } from "bun:test";
import { MessageFramer } from "@veyyon/coding-agent/utils/jsonrpc-framing";

/**
 * WHY: `drain` selected the frame length with an unanchored `/Content-Length:
 * (\d+)/i` over the whole decoded header block. That matches three things that
 * are not the header: a longer field ending in the same word
 * (`X-Content-Length`), a stdout line that merely mentions it, and the first of
 * two headers that disagree. Each makes the framer wait for a byte count the
 * stream never reaches, so the connection goes silent — and silence is the one
 * failure mode the resync callback exists to prevent. The stdout case is the
 * live one: `drain`'s own contract calls a header block without a length
 * "non-protocol noise (e.g. a server printing to stdout)", and a server that
 * logs the string it is about to write produces exactly that.
 *
 * CLASS CLOSED: the length is read from a line whose field NAME is
 * `content-length`, its value must be all digits and a safe integer, and two
 * disagreeing values resync rather than picking one.
 *
 * NOT CAUGHT: this says nothing about header ordering against the body, about
 * `Content-Type`, or about a server that emits a correct header with a wrong
 * length — that is indistinguishable from a truncated body at this layer.
 */

const noop = (): void => {};

function drainAll(framer: MessageFramer, onResync: (h: string) => void = noop): string[] {
	return [...framer.drain(onResync)];
}

function push(bytes: string): MessageFramer {
	const framer = new MessageFramer(Buffer.alloc(0));
	framer.push(Buffer.from(bytes, "utf8"));
	return framer;
}

describe("a header field that merely mentions Content-Length is not a frame", () => {
	it("frames on the real header when a longer field name precedes it", () => {
		const framer = push("X-Content-Length: 99999\r\nContent-Length: 5\r\n\r\nhello");
		expect(drainAll(framer)).toEqual(["hello"]);
	});

	it("frames on the real header when the longer field name follows it", () => {
		const framer = push("Content-Length: 5\r\nX-Content-Length: 99999\r\n\r\nhello");
		expect(drainAll(framer)).toEqual(["hello"]);
	});

	it("treats a stdout line that mentions the header as noise and resyncs past it", () => {
		// The whole block up to the first blank line decodes as one header text,
		// so the log line and the real header arrive together.
		const framer = push("[debug] writing Content-Length: 4096 to client\r\n\r\nContent-Length: 5\r\n\r\nhello");
		const resyncs: string[] = [];
		expect(drainAll(framer, h => resyncs.push(h))).toEqual(["hello"]);
		expect(resyncs).toEqual(["[debug] writing Content-Length: 4096 to client"]);
	});

	it("resyncs instead of choosing between two lengths that disagree", () => {
		const framer = push("Content-Length: 5\r\nContent-Length: 10\r\n\r\nhelloworld");
		const resyncs: string[] = [];
		// The ambiguous block is dropped; the bytes behind it are not a header
		// block of their own, so nothing is yielded rather than something wrong.
		expect(drainAll(framer, h => resyncs.push(h))).toEqual([]);
		expect(resyncs).toEqual(["Content-Length: 5\r\nContent-Length: 10"]);
	});

	it("accepts a length repeated with the same value", () => {
		const framer = push("Content-Length: 5\r\nContent-Length: 5\r\n\r\nhello");
		expect(drainAll(framer)).toEqual(["hello"]);
	});

	it("resyncs on a non-numeric length rather than parsing a prefix of it", () => {
		const framer = push("Content-Length: 5x\r\n\r\nhello");
		const resyncs: string[] = [];
		expect(drainAll(framer, h => resyncs.push(h))).toEqual([]);
		expect(resyncs).toEqual(["Content-Length: 5x"]);
	});

	it("resyncs on a length beyond the safe integer range", () => {
		const framer = push("Content-Length: 99999999999999999999\r\n\r\nhello");
		const resyncs: string[] = [];
		expect(drainAll(framer, h => resyncs.push(h))).toEqual([]);
		expect(resyncs.length).toBe(1);
	});

	it("still reads a header whose name differs only in case and spacing", () => {
		const framer = push("content-length:   5\r\n\r\nhello");
		expect(drainAll(framer)).toEqual(["hello"]);
	});

	it("keeps framing subsequent messages after resyncing past noise", () => {
		const framer = push(
			"[debug] Content-Length: 4096\r\n\r\nContent-Length: 5\r\n\r\nhelloContent-Length: 5\r\n\r\nworld",
		);
		expect(drainAll(framer)).toEqual(["hello", "world"]);
	});
});
