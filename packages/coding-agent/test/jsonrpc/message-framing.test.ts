import { describe, expect, it } from "bun:test";
import { MessageFramer } from "@veyyon/coding-agent/jsonrpc/message-framing";

/**
 * MessageFramer is the shared Content-Length decoder for the LSP and DAP stdio
 * byte streams. Framing bugs (a terminator split across reads, a byte-vs-char
 * length mismatch, a message spanning many chunks) corrupt every downstream
 * message, so this hot path deserves direct coverage it lacked. These tests feed
 * bytes the way a real pipe does — arbitrary chunk boundaries — and assert the
 * exact decoded payloads, the resync callback, and the remainder handoff.
 */

const noop = (): void => {};

/** Build a single Content-Length frame; the length is the UTF-8 byte count. */
function frame(json: string): Buffer {
	return Buffer.from(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`, "utf8");
}

function drainAll(framer: MessageFramer, onResync: (h: string) => void = noop): string[] {
	return [...framer.drain(onResync)];
}

describe("MessageFramer whole-message framing", () => {
	it("decodes a single complete message pushed at once", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(frame('{"a":1}'));
		expect(drainAll(framer)).toEqual(['{"a":1}']);
	});

	it("decodes two back-to-back messages in one push", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.concat([frame('{"a":1}'), frame('{"b":2}')]));
		expect(drainAll(framer)).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("decodes a zero-length body", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.from("Content-Length: 0\r\n\r\n", "utf8"));
		expect(drainAll(framer)).toEqual([""]);
	});

	it("matches the Content-Length header case-insensitively", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.from("content-length: 5\r\n\r\nhello", "utf8"));
		expect(drainAll(framer)).toEqual(["hello"]);
	});

	it("ignores extra headers preceding Content-Length", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.from("Content-Type: application/vscode-jsonrpc\r\nContent-Length: 5\r\n\r\nhello", "utf8"));
		expect(drainAll(framer)).toEqual(["hello"]);
	});
});

describe("MessageFramer partial reads", () => {
	it("waits for the full body before yielding when a read splits mid-message", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		const full = frame('{"a":1}');
		framer.push(full.subarray(0, 5));
		expect(drainAll(framer)).toEqual([]);
		framer.push(full.subarray(5));
		expect(drainAll(framer)).toEqual(['{"a":1}']);
	});

	it("reassembles a header terminator split across two chunks", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		const full = frame("hi");
		// Split inside the \r\n\r\n terminator so the header scan must span chunks.
		const cut = full.indexOf("\r\n\r\n") + 2;
		framer.push(full.subarray(0, cut));
		expect(drainAll(framer)).toEqual([]);
		framer.push(full.subarray(cut));
		expect(drainAll(framer)).toEqual(["hi"]);
	});

	it("reassembles a body delivered byte by byte across many chunks", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		const full = frame('{"big":"payload"}');
		for (const byte of full) framer.push(Buffer.from([byte]));
		expect(drainAll(framer)).toEqual(['{"big":"payload"}']);
	});
});

describe("MessageFramer byte-accurate lengths", () => {
	it("frames a multibyte UTF-8 body by byte count, not character count", () => {
		const json = '{"m":"café ☕ 中"}';
		expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(json.length);
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(frame(json));
		expect(drainAll(framer)).toEqual([json]);
	});
});

describe("MessageFramer resync", () => {
	it("drops a header block with no Content-Length and recovers the next message", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(Buffer.concat([Buffer.from("Some server log line\r\n\r\n", "utf8"), frame('{"ok":1}')]));
		const resyncs: string[] = [];
		const out = drainAll(framer, h => resyncs.push(h));
		expect(resyncs).toEqual(["Some server log line"]);
		expect(out).toEqual(['{"ok":1}']);
	});
});

describe("MessageFramer remainder handoff", () => {
	it("persists an unparsed partial and a reseeded framer resumes it", () => {
		const full = frame('{"a":1}');
		const first = new MessageFramer(Buffer.alloc(0));
		first.push(full.subarray(0, 10));
		expect(drainAll(first)).toEqual([]);
		const remainder = first.remainder();
		expect(remainder.length).toBe(10);

		const second = new MessageFramer(remainder);
		second.push(full.subarray(10));
		expect(drainAll(second)).toEqual(['{"a":1}']);
	});

	it("reports an empty remainder once every buffered message is drained", () => {
		const framer = new MessageFramer(Buffer.alloc(0));
		framer.push(frame('{"a":1}'));
		drainAll(framer);
		expect(framer.remainder().length).toBe(0);
	});
});
