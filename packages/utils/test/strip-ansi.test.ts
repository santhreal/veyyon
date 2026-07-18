/**
 * SPEC-ONE-PLACE-AUDIT F6: single canonical `stripAnsi` (CSI+OSC superset)
 * imported by `tiny/message-preproc.ts` and the coding-agent
 * `export/html/tool-render/util.ts`, replacing two divergent copies (one
 * SGR-only, two byte-identical CSI+OSC forks).
 */
import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";

describe("stripAnsi", () => {
	it("strips SGR color/style sequences", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("strips non-SGR CSI sequences (cursor movement, erase)", () => {
		expect(stripAnsi("\x1b[2K\x1b[1Ahello")).toBe("hello");
	});

	it("strips OSC sequences terminated by BEL", () => {
		expect(stripAnsi("\x1b]0;window title\x07visible")).toBe("visible");
	});

	it("strips OSC sequences terminated by ST (ESC \\\\)", () => {
		expect(stripAnsi("\x1b]8;;https://example.com\x1b\\link text\x1b]8;;\x1b\\")).toBe("link text");
	});

	it("leaves plain text untouched", () => {
		expect(stripAnsi("plain text, no escapes")).toBe("plain text, no escapes");
	});
});
