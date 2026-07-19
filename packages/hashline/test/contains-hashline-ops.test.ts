import { describe, expect, it } from "bun:test";
import { containsRecognizableHashlineOperations } from "../src/input";

// containsRecognizableHashlineOperations is the predicate the streaming edit
// preview uses to decide whether partial model output is worth treating as a
// hashline patch yet (see coding-agent/src/edit/streaming.ts). It returns true
// when ANY line parses as a hunk-header op (SWAP/INS/...), and must NOT be
// fooled by a file header, a payload line, or prose — those would route
// non-patch text into the patch path.

describe("containsRecognizableHashlineOperations — recognizes op headers", () => {
	it("recognizes the canonical SWAP hunk header", () => {
		expect(containsRecognizableHashlineOperations("SWAP 2.=2:")).toBe(true);
	});

	it("recognizes an op buried among prose lines", () => {
		expect(containsRecognizableHashlineOperations("some intro\nSWAP 5.=10:\ntrailing note")).toBe(true);
	});

	it("finds the op across CRLF line separators", () => {
		expect(containsRecognizableHashlineOperations("prose\r\nSWAP 1.=1:")).toBe(true);
	});

	it("recognizes the lenient SWAP forms", () => {
		expect(containsRecognizableHashlineOperations("SWAP 2:")).toBe(true);
		expect(containsRecognizableHashlineOperations("SWAP 2-3:")).toBe(true);
		expect(containsRecognizableHashlineOperations("SWAP 2..3:")).toBe(true);
	});

	it("recognizes an INS tail-insert op", () => {
		expect(containsRecognizableHashlineOperations("INS.TAIL:")).toBe(true);
	});
});

describe("containsRecognizableHashlineOperations — rejects non-ops", () => {
	it("returns false for empty input", () => {
		expect(containsRecognizableHashlineOperations("")).toBe(false);
	});

	it("returns false for plain prose", () => {
		expect(containsRecognizableHashlineOperations("this is not a patch\njust some words")).toBe(false);
	});

	it("does not treat a bare file header as an op", () => {
		// A [PATH#hash] header opens a section but is not itself a hunk op.
		expect(containsRecognizableHashlineOperations("[src/foo.ts#AB12CD]")).toBe(false);
	});

	it("does not treat a payload line as an op", () => {
		expect(containsRecognizableHashlineOperations("+an added content line")).toBe(false);
		expect(containsRecognizableHashlineOperations("-a removed content line")).toBe(false);
	});
});
