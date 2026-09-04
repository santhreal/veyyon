/**
 * streamHashLines CRLF split across chunk boundary at every CR position.
 */
import { describe, expect, it } from "bun:test";
import { streamHashLines } from "../src/stream";

describe("streamHashLines CRLF boundary splits", () => {
	it("CR then LF in separate chunks", async () => {
		async function* bytes() {
			yield new TextEncoder().encode("a\r");
			yield new TextEncoder().encode("\nb");
		}
		const out: string[] = [];
		for await (const c of streamHashLines(bytes())) out.push(c);
		expect(out).toEqual(["1:a\n2:b"]);
	});

	it("full CRLF mid-stream", async () => {
		async function* bytes() {
			yield new TextEncoder().encode("a\r\nb\r\nc");
		}
		const out: string[] = [];
		for await (const c of streamHashLines(bytes())) out.push(c);
		expect(out).toEqual(["1:a\n2:b\n3:c"]);
	});

	it("CRLF at end of each chunk", async () => {
		async function* bytes() {
			yield new TextEncoder().encode("a\r\n");
			yield new TextEncoder().encode("b\r\n");
			yield new TextEncoder().encode("c");
		}
		const out: string[] = [];
		for await (const c of streamHashLines(bytes())) out.push(c);
		expect(out).toEqual(["1:a\n2:b\n3:c"]);
	});
});
